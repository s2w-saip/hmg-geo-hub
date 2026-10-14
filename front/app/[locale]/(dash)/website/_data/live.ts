import "server-only";
import { anchorAxisKnownEnabled } from "@/lib/period/anchor-axis-state";
import { isTrendGridApplied } from "@/lib/period/trend-grid-axis";
import {
  regularRoundDateOf,
  type RegularRoundSurface,
} from "@/lib/kpi/period-compare-week";
import {
  fetchWebsiteAggregates,
  fetchWebsiteGeoCompetition,
  fetchWebsiteTrend,
  fetchWebsiteSubKpis,
  fetchWebsitePromptTopics,
  fetchWebsiteSourceComposition,
  fetchWebsiteCitationAccuracy,
  fetchWebsiteCitationAccuracyTrend,
  fetchWebsiteTargetHitRate,
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
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { degradeOnApiFailure } from "@/lib/scope/degrade-registry";
import {
  WEBSITE_OVERVIEW_TREND_METRICS,
  afterFirstRender,
  loadComposition,
  loadLiveGeo,
  loadLiveTrend,
  loadSubKpis,
  loadWebsiteDashboard,
  type DashboardCtx,
} from "@/lib/hgh/adapters/dashboard";

// Website (공식 사이트 인용 현황) 대시보드 view-model.
// Standard와 동일한 KPI 산식을 쓰되 집계 소스가 다르다:
//   Standard → 루트 scope 프로젝트 (batch-date 스냅샷)
//   Website  → website_sites의 (brand×country) scope 프로젝트들
//              (DISTINCT ON per project_id → 각 시장의 최신 런 합산)
//
// website_sites.scope_project_id가 미채워지거나 측정 런이 없으면 null →
// page에서 "측정 대기" EmptyState.
//
// 원천 스위치(D8, 단위 U5): HGH_SOURCE_G3=api 면 아래 get* 가 새 백엔드
// (lib/hgh/adapters/dashboard.ts, surface=website)에서 같은 반환 타입을 만든다. legacy(기본)는
// 종전 본문 그대로다. api 의 카드·추이·구성·GEO 규칙과 known_diff 는 그 어댑터 머리말에 있다
// (DC-02 URL 인용률 측정 단위, U5-N1 GEO 라벨, U5-N2 기타 비중). 추이는 종전처럼 주 버킷이다
// (발행값 선은 bucket=cycle 에서만 오므로 주 버킷은 라이브값 = 종전 라이브 추이와 같은 원천, U4-N13).

/** api 원천(G3)의 읽기 문맥. 스코프는 page 의 readStandardFilters 와 같은 세션 스코프(전송 안 함). */
async function websiteApiCtx(): Promise<DashboardCtx | null> {
  if (!isAnalysisApi("dashboard", "website")) return null;
  const session = await getSession();
  return { surface: "website", scope: session?.user.scope ?? null };
}

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
  const ctx = await websiteApiCtx();
  if (ctx) return degradeOnApiFailure("websiteAggregates", () => loadWebsiteDashboard(filters ?? {}, ctx));
  const [agg, accuracy, promptRates] = await Promise.all([
    fetchWebsiteAggregates(filters),
    fetchWebsiteCitationAccuracy(filters),
    fetchWebsiteTargetHitRate(filters),
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
  // GGMD-54 목업 / GGMD-61 재배선(2026-09-17) — 자사 URL·타겟 URL 카드 2종은
  // **프롬프트 기준 비율**이다. 값 = 분자 ÷ 분모 × 100, 하단 두 줄 = 그 분자·분모.
  //   자사 URL 인용률 = 자사 URL 인용 프롬프트 ÷ 측정 프롬프트
  //   타겟 URL 인용률 = 타겟 URL 인용 프롬프트 ÷ 측정 프롬프트
  // 두 카드의 "측정 프롬프트"는 **같은 SQL 문장의 같은 열**이다(수용 기준 A1) —
  // 집계는 `fetchWebsiteTargetHitRate` 한 번이고, 분자만 술어가 다르다. 타겟 술어가
  // 자사 술어에 포함되므로 타겟 ≤ 자사도 구조적으로 성립한다(A2).
  // 분모 0 이면 값은 null → 타일이 "측정 대기" 칩을 낸다(0% 와 구분, 결정 5).
  // ⑤⑥ 카드의 값·동작은 건드리지 않는다. Δ 칩은 새 카드에 달지 않는다(결정 5 = 추후).
  const ratioOrUndefined = (numerator: number) =>
    promptRates.measuredPrompts > 0
      ? { numerator, denominator: promptRates.measuredPrompts }
      : undefined;
  // 발행 리포트 정본 경로(`X.reportTruth`)의 출처 표식을 **버리지 않고 타일까지** 나른다.
  // 이 카드 2종은 답변분석 인용 화면의 같은 카드와 **같은 집계**를 쓰므로, 한쪽만
  // 표식을 달면 같은 수가 화면에 따라 출처 없이 보인다(2026-09-20 검증 차단 3).
  // 키가 꺼져 있으면 `promptRates.source` 가 undefined 라 이 필드도 undefined 다.
  const provenance = promptRates.source
    ? {
        source: promptRates.source,
        cycleLabel: promptRates.publication?.cycleLabel ?? null,
        cycleLabelEn: promptRates.publication?.cycleLabelEn ?? null,
        roundDate: promptRates.publication?.roundDate,
        siteCount: promptRates.publication?.siteCount,
      }
    : undefined;
  const ownedUrlRate: KpiSummary = {
    key: "ownedUrlRate",
    value: promptRates.ownedRate,
    delta: null,
    direction: "flat",
    ratio: ratioOrUndefined(promptRates.ownedPrompts),
    provenance,
  };
  const targetUrlRate: KpiSummary = {
    key: "targetUrlRate",
    value: promptRates.rate,
    delta: null,
    direction: "flat",
    ratio: ratioOrUndefined(promptRates.hitPrompts),
    provenance,
  };
  // KPI #16 — 웹사이트도 타겟 지정 개념이 없어 자동(SOV 1위) 분모.
  const kpis = applyCompetitorSov(
    [...buildMirrorKpis(agg), ownedUrlRate, targetUrlRate, citationAccuracy],
    agg,
  );
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
  const ctx = await websiteApiCtx();
  if (ctx) {
    const f = filters ?? {};
    const scope = ctx.scope ?? undefined;
    const active = activeBrandFor(scope, f);
    // B033: 권역 트리는 활성 브랜드가 하나일 때만 그린다(종전 buildGeo 의 activeBrand, 백엔드 Q8 도 관점
    // 브랜드가 여럿이면 markets=[]). 활성 브랜드가 없으면(관점 브랜드 여럿: admin 무필터·다중 브랜드 스코프·URL
    // 다중 선택) 종전 결과는 데이터와 무관하게 빈 트리 + 종전 라벨이므로 /v1/geo 를 부르지 않고 그 모양을 낸다.
    if (!active) return buildGeo({ brands: [], codes: [] }, ourBrandsOf(scope), null);
    // 종전 fetchWebsiteGeoCompetition 의 degradeAware("websiteGeoCompetition") 와 같은 자리:
    // 일시 실패(5xx·시간 초과)는 라벨을 남기고 종전 빈 모양(buildGeo 에 빈 행)을 돌려준다.
    // 4xx 는 그대로 던진다(degradeOnApiFailure 규칙). 활성 브랜드도 종전과 같게 넘긴다. 단일
    // 브랜드 스코프(Kia)면 종전은 그 브랜드의 권역을 "측정 예정"으로 냈다(U5 N1).
    // 페이지(WebsiteGeoSection)는 이 라벨을 읽어 빈 지도 대신 기존 지연 고지를 낸다(B027).
    const geo = await degradeOnApiFailure("websiteGeoCompetition", () =>
      afterFirstRender(f, ctx, () => loadLiveGeo(f, ctx)),
    );
    return geo ?? buildGeo({ brands: [], codes: [] }, ourBrandsOf(scope), active);
  }
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
  const ctx = await websiteApiCtx();
  if (ctx) {
    const f = filters ?? {};
    // 실패는 종전 fetchWebsiteTrend 처럼 그대로 올린다(웹사이트 추이에는 degrade 라벨이 없다).
    // 축 = 회차 자리(bucket=cycle): 현행 주 추이는 X.trendGrid 원장 금요일 자리이고(fetchWebsiteTrend → trendSlotsFor),
    // API 의 그 격자는 bucket=cycle 이다(백엔드 프로필 trend_grid, WU-6). 월요일 키 주 버킷은 현행에 없는 축.
    // LiveTrend.unit 은 종전 호출 단위 그대로(라벨은 앵커 축이라 round_date).
    // 지표 = ①~⑤ + 라이브 ⑥(ACC). 화면이 안 그리는 M06·M07 은 요청하지 않는다(B032, 상수 머리 주석).
    return afterFirstRender(f, ctx, () => loadLiveTrend(f, ctx, "cycle", WEBSITE_OVERVIEW_TREND_METRICS, unit));
  }
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
  //
  // GGMD-61(2026-09-17) — 종전에 여기서 함께 싣던 ⑥ 의 분모·분자(답변 건수,
  // `ownedUrlAnswers`·`targetUrlAnswers`)는 건수 카드 2종의 Δ 원천이었다. 카드가
  // 프롬프트 기준 **비율**로 바뀌고 Δ 칩을 달지 않기로 해(제품 결정 5) 실을 곳이
  // 사라졌으므로 제거한다. ⑥ 비율 병합은 종전 그대로다(갭 가드를 얹지 않는다 —
  // /projects 의 같은 병합과 갈라지지 않게, 검증자 F-3).
  if (accuracy.length > 0) {
    const byBucket = new Map(accuracy.map((b) => [b.bucketStart, b]));
    for (const p of trend.points) {
      const b = byBucket.get(p.bucketStart);
      if (!b) continue;
      if (b.rate != null) p.values.citationAccuracy = b.rate;
    }
  }
  return trend;
}

export async function getLiveWebsiteComposition(
  filters?: StandardFilters,
): Promise<LiveComposition> {
  const ctx = await websiteApiCtx();
  if (ctx) {
    const f = filters ?? {};
    // 종전 fetchWebsiteSourceComposition 의 degradeAware("websiteSourceComposition") 자리.
    // 주제는 웹사이트 패널이 그리지 않으므로(U5-N7) 빈 모양은 topics·sources 둘 다 [].
    const comp = await degradeOnApiFailure("websiteSourceComposition", () =>
      afterFirstRender(f, ctx, () => loadComposition(f, ctx)),
    );
    return comp ?? { topics: [], sources: [] };
  }
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
  const ctx = await websiteApiCtx();
  if (ctx) {
    const f = filters ?? {};
    // 종전 fetchWebsiteSubKpis 의 degradeAware("websiteSubKpis") 자리: 빈 모양 + 라벨.
    const sub = await degradeOnApiFailure("websiteSubKpis", () =>
      afterFirstRender(f, ctx, () => loadSubKpis(f, ctx)),
    );
    return sub ?? { rows: [], promptsWithoutBrand: null, measuredPrompts: null };
  }
  // S4 대시보드 배지 전용 화면 키 — S5 언급 화면(미러 누적 의미론)과 갈라 둔다(B6).
  // 이 키가 `read_screens` 에 들어오면 배지가 카드와 같은 회차 스냅샷으로 바뀐다.
  return fetchWebsiteSubKpis(filters, { screen: "S4.subkpi" });
}

// ── bucket → LiveTrend 변환 (dashboard/_data/live.ts 변환 로직 재현) ──────────
// getLiveTrend는 standard/project 분기를 내장하고 있어 website 경로를 주입할 수
// 없다. bucket 배열을 받아 LiveTrend를 만드는 순수 변환만 여기서 재현한다.

/**
 * 빈 주를 placeholder 로 채운다.
 *
 * ⚠️ `roundSurface` 는 **축 on 에서만** 온다. 채운 버킷은 회차가 없어 `round_date` 도
 *    없는데, 라벨이 버킷 키(주 월요일)로 폴백하면 website 추이에 **월요일 하나**가
 *    섞인다(2026-09-20 관찰의 `7. 27.` 빈 슬롯 — 07-31 금요일 회차가 없던 주다).
 *    그래서 채운 버킷의 라벨도 그 표면의 정규 요일로 맞춘다. 요일 상수의 정본은
 *    `lib/kpi/period-compare-week.ts::REGULAR_ROUND_DOW`(DB `hmg_round_canonical_dow`
 *    와 같은 값) 한 곳이고, 여기서는 `regularRoundDateOf` 를 경유만 한다.
 *    프로젝트 표면은 정규 요일이 없어 호출부가 넘기지 않는다 = 버킷 키 그대로.
 */
function fillGaps(
  points: LiveTrendPoint[],
  unit: BucketUnit,
  roundSurface?: RegularRoundSurface,
): LiveTrendPoint[] {
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
      const bucketStart = new Date(t).toISOString().slice(0, 10);
      out.push({
        bucketStart,
        ...(roundSurface && unit === "week"
          ? { roundDate: regularRoundDateOf(roundSurface, bucketStart) }
          : {}),
        firstAt: null, values: {}, measuredDays: 0, answers: 0, lastAt: null,
      });
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
      return { bucketStart: b.bucketStart, ...(b.roundDate ? { roundDate: b.roundDate } : {}), firstAt: null, values: {}, measuredDays: 0, answers: 0, lastAt: null, ...(b.cycleAnchorAt ? { cycleAnchorAt: b.cycleAnchorAt } : {}), ...(b.gap ? { gap: b.gap } : {}) };
    }
    const values: LiveTrendPoint["values"] = {};
    values.visibility = pct(b.trackedAnswers, b.answers);
    if (b.totalMentions > 0) values.shareOfVoice = pct(b.trackedMentions, b.totalMentions);
    if (b.sentMentions > 0) values.sentiment = round1((100 * b.positiveMentions) / b.sentMentions);
    if (b.avgPosition != null) values.position = b.avgPosition;
    if (!citationGap && b.totalCitations > 0) values.citationShare = pct(b.ownedCitations, b.totalCitations);
    // 값이 살아난 버킷에도 마커는 그대로 나른다(대시보드 live.ts 와 같은 계약).
    // `cycleAnchorAt` 은 x축 라벨 전용(앵커의 KST 일 — 대시보드 live.ts 와 같은 계약).
    return { bucketStart: b.bucketStart, ...(b.roundDate ? { roundDate: b.roundDate } : {}), firstAt: b.firstAt, values, measuredDays: b.measuredDays, answers: b.answers, lastAt: b.lastAt, ...(b.cycleAnchorAt ? { cycleAnchorAt: b.cycleAnchorAt } : {}), ...(b.gap ? { gap: b.gap } : {}) };
  });
  return {
    unit,
    // 라벨 시계 — 대시보드 builder 와 **같은 판정**이다(`LiveTrend.axis` 주석).
    axis: anchorAxisKnownEnabled() ? "anchor" : "measured",
    // 격자(D5)가 이 배열을 만들었으면 **채우지 않는다** — 자리 목록은 이미 원장이 냈고
    // (`fetchWebsiteTrend` → `applyTrendGridToBuckets`), 여기서 또 채우면 원장에 없는
    // 주가 다시 생긴다(website 07-31 이 그 자리다). `isCycleBucketed` 만으로는 부족한
    // 이유: 미러 폴백 경로의 버킷에는 `cycleAnchorAt` 이 없어 판정이 false 가 된다.
    //
    // ⚠️ 판정은 **데이터 표식**(`gridSlot`)이다 — 스위치로 물으면 격자를 안 얹은 경로
    //    (일 버킷·자리 null)에서 종전 채움이 사라진다(검증 B2).
    points:
      isTrendGridApplied(buckets) || isCycleBucketed(buckets)
        ? measured
        // 축 on 이면 채운 버킷의 라벨도 금요일(website 정규 요일)로 맞춘다.
        : fillGaps(measured, unit, anchorAxisKnownEnabled() ? "website" : undefined),
    lastMeasuredAt: measured[measured.length - 1]?.lastAt ?? null,
    totalAnswers: measured.reduce((s, p) => s + p.answers, 0),
  };
}
