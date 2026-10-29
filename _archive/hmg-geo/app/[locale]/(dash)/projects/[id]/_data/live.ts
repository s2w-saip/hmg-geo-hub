import "server-only";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { BucketUnit } from "@/lib/db/repositories/scope-aggregates";
import type { AllowedScope } from "@/lib/auth/types";
import type { KpiSummary } from "../../../dashboard/_data/sample";
import { SAMPLE_KPI_SUMMARY } from "../../../dashboard/_data/sample";
import {
  buildMirrorKpis,
  applyTrendDeltas,
  applyEngineConsistency,
  getLiveSubKpis,
  applyCompetitorSov,
  getLiveTrend,
  getLiveComposition,
  type LiveTrend,
  type LiveComposition,
  type LiveTrendPoint,
} from "../../../dashboard/_data/live";
import {
  fetchProjectStandardAggregates,
  fetchProjectCitationAccuracy,
  fetchProjectCitationAccuracyTrend,
  wasDegraded,
} from "@/lib/scope/server";
import { resolveProperty } from "@/lib/ga4/property-map";
import { getAiTrafficConversionKpi } from "@/lib/ga4/conversion";
// Aliased — a legacy env-gated isDemoProject() lives in this file (line ~65).
import { isDemoProject as isCaptureDemoProject } from "@/lib/demo";
import { demoConversionKpi } from "@/lib/ga4/demo-conversion";
import { listProjectTrackedUrls } from "@/lib/db/repositories/project-tracked-urls";
import { listProjectOwnedBases } from "@/lib/db/repositories/project-owned-bases";
import { projectRepository } from "@/lib/db/repositories/projects";
import { trackedCompetitorRepository } from "@/lib/db/repositories/tracked-entities";

// Per-project 현황 KPI summary — structured for a real scope-data connection,
// NOT a client demo (except for the demo-id list below). The page reads the
// DimensionFilterPanel's URL params → StandardFilters and passes them here;
// the values come from the same filter-aware scope aggregation the 통합
// 대시보드 uses (SQL mirror via fetchStandardAggregates → answerWhere IN-lists),
// so changing a filter genuinely re-narrows the numbers server-side.
//
// LIVE-ONLY (default): returns null when there is no measurement data (mock /
// no mirror) → the caller renders a "측정 대기" pending card, never a
// fabricated number.
//
// ⚠ TEMP — DEMO_PROJECT_IDS env (2026-06-23). Specific projects (today: Kia
// Italy) whose scope project ID lives in a different workspace than our
// SCOPE_API_KEY → mirror always empty → all KPIs blank. For client-facing
// demos we serve SAMPLE_KPI_SUMMARY for those project IDs ONLY. Recover by
// emptying DEMO_PROJECT_IDS env once the workspace mapping lands.
//
// KPI ⑥ AI 타겟 URL 인용률 (2026-06-23 measurement wiring): 표준
// 대시보드에서 폐기, 프로젝트는 유지. 프로젝트의 추적 URL 라벨링
// (project_tracked_urls, /projects/[id]/setting > 추적 URL) 에 기반해
// 'scope_citations.url IN (라벨된 URL)'(분자) / '자사 도메인 인용 답변'(분모)
// 비율로 측정. 분모의 '자사 도메인'은 프로젝트 도메인(projects.domain) 프리픽스를
// 따른다 — 미설정 시 글로벌 geo-catalog 호스트 패턴으로 fallback.
// 라벨 0개면 rate=null → 카드는 '측정 대기' 칩 유지(라벨링 유도).
//
// FOLLOW-UP (per-project scope): this reuses the ROOT/표준 aggregates as a
// stand-in because `assertProjectInScope` is still pass-through and no
// per-project measurement mirror exists yet (scope-gateway spec). When a
// project→scope-project mapping lands, swap getLiveDashboard for a
// project-scoped fetch keyed on the project's scope id — the filter wiring,
// Suspense boundary, and tile rendering all stay exactly the same.

const DEMO_PROJECT_IDS_ENV = "DEMO_PROJECT_IDS";
function isDemoProject(projectId: string): boolean {
  const raw = process.env[DEMO_PROJECT_IDS_ENV];
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(projectId);
}

export interface ProjectDashboard {
  kpis: KpiSummary[];
  trend: LiveTrend | null;
  trendDegraded: boolean;
  composition: LiveComposition;
  citationAccuracyNotice: "hiddenMultipleOwnedBases" | "legacyDomainFallback" | null;
}

function mergeProjectTrendAccuracy(
  base: LiveTrend | null,
  accuracy: Awaited<ReturnType<typeof fetchProjectCitationAccuracyTrend>>,
  unit: BucketUnit,
): LiveTrend | null {
  if (!base && accuracy.length === 0) return null;
  const byBucket = new Map<string, LiveTrendPoint>();
  for (const point of base?.points ?? []) {
    byBucket.set(point.bucketStart, { ...point, values: { ...point.values } });
  }
  for (const bucket of accuracy) {
    const current = byBucket.get(bucket.bucketStart);
    if (current) {
      current.values.citationAccuracy = bucket.rate ?? undefined;
      continue;
    }
    byBucket.set(bucket.bucketStart, {
      bucketStart: bucket.bucketStart,
      firstAt: bucket.firstAt,
      values: bucket.rate != null ? { citationAccuracy: bucket.rate } : {},
      measuredDays: bucket.measuredDays,
      answers: 0,
      lastAt: bucket.lastAt,
    });
  }
  const points = [...byBucket.values()].sort((a, b) =>
    a.bucketStart.localeCompare(b.bucketStart),
  );
  return {
    unit,
    points,
    lastMeasuredAt:
      points.reduce<string | null>(
        (latest, point) =>
          point.lastAt && (!latest || point.lastAt > latest) ? point.lastAt : latest,
        null,
      ) ?? null,
    totalAnswers: points.reduce((sum, point) => sum + point.answers, 0),
  };
}

// 프로젝트 현황 대시보드 — 표준과 동일 산식/컴포넌트, 단 모집단이 그 프로젝트의
// 프롬프트/답변(scopeProjectId)으로 제한된다. ①~⑤+subKPI·추이·구성·랭킹은 미러
// 집계(fetchProject*), ⑥은 추적URL, ⑦은 프로젝트 (brand,country)→GA4 property.
// 측정 답변 0(미연결/미측정) → null → 페이지가 "측정 대기" 렌더. GEO는 1차 제외.
export async function getProjectDashboard(
  projectId: string,
  filters: StandardFilters,
  bucket: BucketUnit = "week",
): Promise<ProjectDashboard | null> {
  if (isDemoProject(projectId)) {
    // 데모 모드 — 워크스페이스 미연결 프로젝트의 빌드 시연용(가짜 데이터).
    return {
      kpis: SAMPLE_KPI_SUMMARY,
      trend: null,
      trendDegraded: false,
      composition: { topics: [], sources: [] },
      citationAccuracyNotice: null,
    };
  }

  const [agg, subKpis, baseTrend, baseDeltaDaily, composition, trackedUrls, project, ownedBases, targetBrand] = await Promise.all([
    fetchProjectStandardAggregates(projectId, filters),
    // 엔진 간 일관성 배지 전용 — 엔진(target)별 Core 값 분해.
    getLiveSubKpis(filters, projectId),
    getLiveTrend(filters, bucket, projectId),
    getLiveTrend(filters, "day", projectId), // KPI 카드 delta 전용 — 직전 날 vs 오늘
    getLiveComposition(filters, projectId),
    listProjectTrackedUrls(projectId),
    projectRepository.getById(projectId),
    listProjectOwnedBases(projectId),
    // KPI #16 — 비교 기준 브랜드. is_target 지정이 있으면 그 브랜드를 쓰고,
    // 없으면 외부 브랜드 SOV 1위로 자동 폴백한다.
    trackedCompetitorRepository.getTargetBrand(projectId),
  ]);
  if (!agg || agg.totalAnswers === 0) return null; // 미측정 → 측정 대기

  // ⑥ AI 타겟 URL 인용률 — owned base 가 정확히 1개이고 **추적 URL 이 1개 이상**
  // 등록돼 있을 때만 KPI로 노출한다.
  //  - owned base 2개 이상: target URL 은 drilldown/annotation 전용으로 유지하고 KPI는 숨긴다.
  //  - 추적 URL 0개: 분자(타겟 URL 인용 답변)를 셀 대상 자체가 없어 값이 영원히 null 이다.
  //    "측정 대기" 칩을 상시 띄우는 대신 카드를 숨긴다 (2026-09-01 운영 요청).
  const configuredOwnedBases = ownedBases.map((b) => b.baseUrl);
  const effectiveOwnedBases =
    configuredOwnedBases.length > 0
      ? configuredOwnedBases
      : project?.domain
        ? [project.domain]
        : [];
  const urls = trackedUrls.map((u) => u.url);
  // 카드 노출 조건 — owned base ≤1 AND 추적 URL ≥1.
  const showCitationAccuracy = effectiveOwnedBases.length <= 1 && urls.length > 0;
  // 안내 배너는 카드의 상태를 설명하는 것이므로 카드가 사라지는 경우와 짝을 맞춘다.
  //  - hiddenMultipleOwnedBases: "왜 카드가 없는지"를 알리는 배너라 그대로 유지.
  //  - legacyDomainFallback: 표시 중인 카드가 project.domain 으로 계산됐음을 알리는
  //    배너라, 카드가 숨겨지면 함께 숨긴다.
  const citationAccuracyNotice =
    configuredOwnedBases.length >= 2
      ? "hiddenMultipleOwnedBases"
      : showCitationAccuracy && configuredOwnedBases.length === 0 && project?.domain
        ? "legacyDomainFallback"
        : null;
  const accuracy =
    effectiveOwnedBases.length === 1
      ? await fetchProjectCitationAccuracy(
          projectId,
          filters,
          urls,
          effectiveOwnedBases[0],
        )
      : { ownedAnswers: 0, targetAnswers: 0, rate: null };
  const [accuracyTrend, accuracyDeltaDaily] =
    effectiveOwnedBases.length === 1
      ? await Promise.all([
          fetchProjectCitationAccuracyTrend(
            projectId,
            filters,
            urls,
            bucket,
            effectiveOwnedBases[0],
          ),
          fetchProjectCitationAccuracyTrend(
            projectId,
            filters,
            urls,
            "day",
            effectiveOwnedBases[0],
          ),
        ])
      : [[], []];
  const trend = mergeProjectTrendAccuracy(baseTrend, accuracyTrend, bucket);
  const deltaDaily = mergeProjectTrendAccuracy(baseDeltaDaily, accuracyDeltaDaily, "day");

  // ⑦ AI 유입 전환율 — 프로젝트 (brand,country) → 단일 GA4 property. 매핑 없으면 null.
  const projScope: AllowedScope = {
    all: false,
    brands: project?.brand ? [project.brand] : undefined,
    countries: project?.country ? [project.country] : undefined,
  };
  const propertyId = await resolveProperty(projScope, filters);
  // Demo capture project has no GA4 property → fabricate the ⑦ tile so it
  // renders alongside the other (mirror-fed) KPIs instead of "GA4 미연동".
  const ai = isCaptureDemoProject(projectId)
    ? demoConversionKpi()
    : propertyId
      ? await getAiTrafficConversionKpi(propertyId)
      : null;

  const kpiItems = [
    ...buildMirrorKpis(agg), // ①~⑤ — delta: 직전 날 vs 오늘 (deltaDaily)
    ...(showCitationAccuracy
      ? [{
          key: "citationAccuracy" as const,
          value: accuracy.rate,
          delta: null,
          direction: "flat" as const,
          ratio:
            accuracy.rate != null
              ? { numerator: accuracy.targetAnswers, denominator: accuracy.ownedAnswers }
              : undefined,
        }]
      : []),
    // ⑦ AI 유입 전환율 — GA4 property 매핑이 없으면 항목 자체를 넣지 않는다.
    // SummaryTiles 는 items 에 없는 KPI 를 렌더하지 않고, 그 카테고리에 남는
    // KPI 가 하나도 없으면 "답변의 전환" 섹션째로 숨긴다(summary-tiles.tsx 의
    // "live mode omits unsupported KPIs" 계약). GA 미연동 프로젝트에서 "측정
    // 대기" 칩만 상시 떠 있던 것을 이 계약을 지켜 해소한다 (2026-09-01 운영 요청).
    ...(ai
      ? [{
          key: "trafficConversion" as const,
          value: ai.aiConvRate,
          delta: null,
          direction: "flat" as const,
          ratio: { numerator: ai.aiKeyEvents, denominator: ai.aiUsers },
        }]
      : []),
  ];

  // 카드에 얹는 Sub 는 엔진 간 일관성 배지 하나뿐이다. 나머지 Sub KPI(미언급/
  // 복수언급/Top3/감정 3종)의 지면은 답변분석 > 언급 화면이다 (2026-07-29 결정).
  const kpis = applyCompetitorSov(
    applyEngineConsistency(applyTrendDeltas(kpiItems, deltaDaily), subKpis.rows),
    agg,
    targetBrand,
  );

  return {
    kpis,
    trend,
    // `trend === null` 의 두 뜻("측정 버킷 2개 미만" vs "예산 초과")을 화면이 가를 수
    // 있게 요청 스코프 표식을 함께 싣는다. 라벨은 **차트가 쓰는 버킷**만 본다 —
    // KPI Δ 칩용 `day` 호출은 `projectTrend:day` 라 여기 섞이지 않는다.
    trendDegraded: wasDegraded(`projectTrend:${bucket}`),
    composition,
    citationAccuracyNotice,
  };
}
