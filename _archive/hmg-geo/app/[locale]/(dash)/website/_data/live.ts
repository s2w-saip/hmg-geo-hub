import "server-only";
import {
  fetchWebsiteAggregates,
  fetchWebsiteGeoCompetition,
  fetchWebsiteTrend,
  fetchWebsiteSubKpis,
  fetchWebsitePromptTopics,
  fetchWebsiteSourceComposition,
  fetchWebsiteCitationAccuracy,
  fetchWebsiteCitationAccuracyTrend,
} from "@/lib/scope/server";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type {
  BucketUnit,
  StandardTrendBucket,
  StandardSubKpis,
} from "@/lib/db/repositories/scope-aggregates";
import { getSession } from "@/lib/auth/session";
import {
  buildMirrorKpis,
  applyCompetitorSov,
  buildGeo,
  type LiveDashboard,
  type LiveGeo,
  type LiveTrend,
  type LiveTrendPoint,
  type LiveComposition,
  type LiveTopicSlice,
  type LiveSourceSlice,
} from "../../dashboard/_data/live";
import type { AllowedScope } from "@/lib/auth/types";
import type { GeoBrandKpiRow } from "@/lib/db/repositories/scope-aggregates";
import { requestDeduped } from "@/lib/request-dedupe";
import { trendGapApplies } from "@/lib/viz/trend-gap";
import type { KpiSummary } from "../../dashboard/_data/sample";

// Website (공식 사이트 인용 현황) 대시보드 view-model.
// Standard와 동일한 KPI 산식을 쓰되 집계 소스가 다르다:
//   Standard → 루트 scope 프로젝트 (batch-date 스냅샷)
//   Website  → website_sites의 (brand×country) scope 프로젝트들
//              (DISTINCT ON per project_id → 각 시장의 최신 런 합산)
//
// website_sites.scope_project_id가 미채워지거나 측정 런이 없으면 null →
// page에서 "측정 대기" EmptyState.

const SOURCE_TOP_N = 7;
const round1 = (v: number) => Math.round(v * 10) / 10;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const DAY_MS = 86_400_000;

// GEO 는 2026-09-10(PR② T5)부터 **실제 집계**다. 그래서 표준 경로와 같은 이유로
// `LiveDashboard` 에서 떼어냈다 — 종전엔 빈 객체라 같이 실어도 공짜였지만, 이제
// 같은 Promise 에 묶으면 ① SUMMARY 가 자기가 안 쓰는 GEO 집계를 기다린다
// (표준 경로가 2026-08-28 에 겪은 것과 같은 문제). GEO 는 `getLiveWebsiteGeo` 로
// 따로 나가고, 화면은 `showsGeoMap` 이 true 일 때만 그것을 부른다.
export type LiveWebsiteDashboard = LiveDashboard;

export async function getLiveWebsiteDashboard(
  filters?: StandardFilters,
): Promise<LiveWebsiteDashboard | null> {
  const [agg, accuracy] = await Promise.all([
    fetchWebsiteAggregates(filters),
    fetchWebsiteCitationAccuracy(filters),
  ]);
  if (!agg || agg.totalAnswers === 0) return null;

  // ⑥ AI 타겟 URL 인용률 — website_prompts.target_url 기준(flat). owned base 개수로
  // 숨기는 프로젝트 규칙은 적용 안 함 — website는 다도메인이 정상이라 항상 노출한다.
  const citationAccuracy: KpiSummary = {
    key: "citationAccuracy",
    value: accuracy.rate,
    delta: null,
    direction: "flat",
    ratio:
      accuracy.rate != null
        ? { numerator: accuracy.targetAnswers, denominator: accuracy.ownedAnswers }
        : undefined,
  };
  // KPI #16 — 웹사이트도 타겟 지정 개념이 없어 자동(SOV 1위) 분모.
  const kpis = applyCompetitorSov([...buildMirrorKpis(agg), citationAccuracy], agg);
  return { kpis };
}

// ── GEO 경쟁 포지션 (PR② T5, 2026-09-10) ────────────────────────────────────
//
// 종전에는 `{ markets: [], pending: [], ourLabel: "HMG" }` **정적 빈 객체**였다 —
// 집계가 배선돼 있지 않아 지도·스냅샷이 항상 아무것도 안 그렸다(플랜 §6-1 "S4 GEO").
// 이제 `fetchWebsiteGeoCompetition`(집계층 `trend_brands` 의 country 축)을 실제로 부른다.
//
// 롤업은 표준과 **같은 함수**(`buildGeo`)를 쓴다 — 권역 귀속·순위·최대경쟁 산식을
// 두 벌 만들지 않기 위해서다. 웹사이트가 표준과 다른 것 둘:
//   ① 국가 코드가 `website_sites.country_code` **verbatim** 이라 가상 코드
//      (`worldwide`·`middleeast`·`HYUNDAI-N`)가 섞인다 → `rhqForCountry` 가 null 을
//      돌려주고 `buildGeo` 가 그 코드를 건너뛴다(표준과 같은 처리).
//   ② 언급 외 지표(노출률·우호도·순위·인용점유율)의 국가별 원천이 없다. 집계층
//      `trend_domains` 에 country 축이 없고(GROUPING SETS 가 group/domain/total),
//      `GeoBrandMention` 계약에도 그 열이 없다 → 0 으로 채워 `marketMetrics` 가
//      **null**(측정 대기)을 내게 한다. **지어내지 않는다.** SoV·순위·최대경쟁·선두
//      브랜드는 언급 수만으로 정의되므로 전부 실값이다.
//
// `ourBrandsOf`·`activeBrandFor` 는 `dashboard/_data/live.ts` 의 비공개 헬퍼와 같은
// 규칙이다(그 파일은 T6 가 같은 헤드에서 만지고 있어 export 를 늘리지 않았다).
// 규칙이 바뀌면 두 곳을 함께 고쳐야 한다.
function ourBrandsOf(scope: AllowedScope | undefined): Set<string> | null {
  if (!scope || scope.all) return null;
  if (!scope.brands || scope.brands.length === 0) return null;
  return new Set(scope.brands);
}
function activeBrandFor(
  scope: AllowedScope | undefined,
  filters?: StandardFilters,
): string | null {
  if (filters?.brand?.length === 1) return filters.brand[0];
  if (scope && !scope.all && scope.brands?.length === 1) return scope.brands[0];
  return null;
}

async function getLiveWebsiteGeoImpl(filters?: StandardFilters): Promise<LiveGeo> {
  const [mentions, session] = await Promise.all([
    fetchWebsiteGeoCompetition(filters),
    getSession(),
  ]);
  const brands: GeoBrandKpiRow[] = mentions.map((m) => ({
    ...m,
    answers: 0,
    posSum: 0,
    posCnt: 0,
    sentPositive: 0,
    sentTotal: 0,
  }));
  return buildGeo(
    { brands, codes: [] },
    ourBrandsOf(session?.user.scope),
    activeBrandFor(session?.user.scope, filters),
  );
}

// 요청단위 dedup — GEO 섹션과 (앞으로) 다른 섹션이 같은 집계를 부를 수 있다.
export const getLiveWebsiteGeo = requestDeduped("getLiveWebsiteGeo", getLiveWebsiteGeoImpl);

export async function getLiveWebsiteTrend(
  filters: StandardFilters | undefined,
  unit: BucketUnit,
): Promise<LiveTrend | null> {
  const [buckets, accuracy] = await Promise.all([
    fetchWebsiteTrend(filters, unit),
    // ⑥ 는 **추이 차트를 깨뜨리지 않는다**(PR③ B4 수용 기준 ②). 회차 버킷 전환으로
    // 둘이 같은 회차 집합을 보게 됐지만 원천은 여전히 다르다(① 집계층 / ⑥ 세부층) —
    // 세부층은 13주 파티션이라 창 밖 회차·DROP 된 주에서 점이 없거나 죽을 수 있다.
    // 그때 잃는 것은 ⑥ 선 하나이고, 나머지 5계열과 Δ 는 그대로 그린다.
    fetchWebsiteCitationAccuracyTrend(filters, unit).catch(() => []),
  ]);
  if (buckets.length === 0) return null;
  const trend = buildTrendFromBuckets(buckets, unit);
  // ⑥ 타겟 인용률 추이선을 버킷 시작일 기준으로 병합(project mergeTrendAccuracy와 동일).
  // 회차 버킷에서는 두 배열의 `bucketStart` 가 **같은 회차 anchor UTC 일**이라 그대로 붙고,
  // ⑥ 점이 없는 회차(세부층 파티션 밖)는 그 회차만 선이 끊긴다.
  if (accuracy.length > 0) {
    const rateByBucket = new Map(accuracy.map((b) => [b.bucketStart, b.rate]));
    for (const p of trend.points) {
      const rate = rateByBucket.get(p.bucketStart);
      if (rate != null) p.values.citationAccuracy = rate;
    }
  }
  return trend;
}

export async function getLiveWebsiteComposition(
  filters?: StandardFilters,
): Promise<LiveComposition> {
  const [topics, sourceDomains] = await Promise.all([
    fetchWebsitePromptTopics(filters),
    fetchWebsiteSourceComposition(filters),
  ]);

  const topicTotal = topics.reduce((s, t) => s + t.prompts, 0);
  const topicSlices: LiveTopicSlice[] = topics.map((t) => ({
    topic: t.topic,
    prompts: t.prompts,
    share: topicTotal > 0 ? round1((100 * t.prompts) / topicTotal) : 0,
  }));

  const sorted = [...sourceDomains].sort((a, b) => b.citations - a.citations);
  const head: LiveSourceSlice[] = sorted.slice(0, SOURCE_TOP_N).map((d) => ({
    domain: d.domain,
    citations: d.citations,
    share: d.share,
    isOurs: d.isOurs,
  }));
  const rest = sorted.slice(SOURCE_TOP_N);
  const restCitations = rest.reduce((s, d) => s + d.citations, 0);
  const sourceSlices: LiveSourceSlice[] =
    restCitations > 0
      ? [...head, { domain: "", citations: restCitations, share: round1(rest.reduce((s, d) => s + d.share, 0)), isOurs: false }]
      : head;

  return { topics: topicSlices, sources: sourceSlices };
}

export async function getLiveWebsiteSubKpis(
  filters?: StandardFilters,
): Promise<StandardSubKpis> {
  // S4 대시보드 배지 전용 화면 키 — S5 언급 화면(미러 누적 의미론)과 갈라 둔다(B6).
  // 이 키가 `read_screens` 에 들어오면 배지가 카드와 같은 회차 스냅샷으로 바뀐다.
  return fetchWebsiteSubKpis(filters, { screen: "S4.subkpi" });
}

// ── bucket → LiveTrend 변환 (dashboard/_data/live.ts 변환 로직 재현) ──────────
// getLiveTrend는 standard/project 분기를 내장하고 있어 website 경로를 주입할 수
// 없다. bucket 배열을 받아 LiveTrend를 만드는 순수 변환만 여기서 재현한다.

function fillGaps(points: LiveTrendPoint[], unit: BucketUnit): LiveTrendPoint[] {
  if (points.length < 2) return points;
  const stepMs = (unit === "week" ? 7 : 1) * DAY_MS;
  const out: LiveTrendPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    out.push(points[i]);
    const next = points[i + 1];
    if (!next) break;
    const end = Date.parse(next.bucketStart);
    for (
      let t = Date.parse(points[i].bucketStart) + stepMs;
      t < end - DAY_MS / 2;
      t += stepMs
    ) {
      out.push({ bucketStart: new Date(t).toISOString().slice(0, 10), firstAt: null, values: {}, measuredDays: 0, answers: 0, lastAt: null });
    }
  }
  return out;
}

/**
 * 회차 버킷인가 — 집계층 경로(`summaryWebsiteTrend`)만 `cycleAnchorAt` 을 채운다(PR③).
 *
 * 회차 버킷에서는 **빈 주를 채우지 않는다**: `fillGaps` 는 점 사이 간격이 주(또는 일)의
 * 배수라고 가정하고 그 격자를 빈 점으로 메우는데, 회차 간격은 그 격자가 아니다.
 * 회차가 없는 주는 **점이 없는 것이 화면 계약**이다(회차 x축).
 * `every` 로 보는 이유: 두 경로가 한 배열에 섞이는 일은 없어야 하고, 섞였다면
 * 격자 가정이 이미 깨진 것이라 채우지 않는 쪽이 안전하다.
 */
const isCycleBucketed = (buckets: StandardTrendBucket[]): boolean =>
  buckets.length > 0 && buckets.every((b) => !!b.cycleAnchorAt);

function buildTrendFromBuckets(buckets: StandardTrendBucket[], unit: BucketUnit): LiveTrend {
  const measured: LiveTrendPoint[] = buckets.map((b) => {
    // 숨긴 회차의 갭 슬롯(0070) — 그 계열의 값 계산을 건너뛴다(대시보드 live.ts 와 같은
    // 계약: 갭 계열의 측정값은 전부 null · lib/viz/trend-gap.ts).
    //
    // 0071 범위 판정도 대시보드와 **같은 규칙**이다. 웹사이트 회차는 오늘 하나도
    // `citations` 로 내려가 있지 않아 실질 무변화지만(숨긴 416 run 은 전부 surface
    // `global`), 두 경로가 갈라지면 다음에 웹사이트 회차가 그렇게 내려갈 때 조용히
    // 다르게 그린다.
    const mentionGap = trendGapApplies(b.gap, "mention");
    const citationGap = trendGapApplies(b.gap, "citation");
    if (mentionGap || b.answers === 0) {
      return { bucketStart: b.bucketStart, firstAt: null, values: {}, measuredDays: 0, answers: 0, lastAt: null, ...(b.gap ? { gap: b.gap } : {}) };
    }
    const values: LiveTrendPoint["values"] = {};
    values.visibility = pct(b.trackedAnswers, b.answers);
    if (b.totalMentions > 0) values.shareOfVoice = pct(b.trackedMentions, b.totalMentions);
    if (b.sentMentions > 0) values.sentiment = round1((100 * b.positiveMentions) / b.sentMentions);
    if (b.avgPosition != null) values.position = b.avgPosition;
    if (!citationGap && b.totalCitations > 0) values.citationShare = pct(b.ownedCitations, b.totalCitations);
    // 값이 살아난 버킷에도 마커는 그대로 나른다(대시보드 live.ts 와 같은 계약).
    return { bucketStart: b.bucketStart, firstAt: b.firstAt, values, measuredDays: b.measuredDays, answers: b.answers, lastAt: b.lastAt, ...(b.gap ? { gap: b.gap } : {}) };
  });
  return {
    unit,
    points: isCycleBucketed(buckets) ? measured : fillGaps(measured, unit),
    lastMeasuredAt: measured[measured.length - 1]?.lastAt ?? null,
    totalAnswers: measured.reduce((s, p) => s + p.answers, 0),
  };
}
