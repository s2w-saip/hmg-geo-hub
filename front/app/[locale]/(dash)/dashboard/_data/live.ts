import "server-only";
import { trendGapApplies, type TrendGap } from "@/lib/viz/trend-gap";
import {
  DELTA_TREND_BUCKET,
  citationShareNumerator,
  deltaTrendFilters,
  overviewTrendValues,
} from "@/lib/kpi/overview-card-values";
import { anchorAxisKnownEnabled } from "@/lib/period/anchor-axis-state";
import { isTrendGridApplied } from "@/lib/period/trend-grid-axis";
import {
  regularRoundDateOf,
  type RegularRoundSurface,
} from "@/lib/kpi/period-compare-week";
import {
  fetchStandardAggregates,
  fetchStandardGeoKpi,
  fetchStandardTrend,
  fetchStandardSubKpis,
  fetchStandardPromptTopics,
  fetchStandardSourceComposition,
  fetchProjectTrend,
  fetchProjectSubKpis,
  fetchProjectPromptTopics,
  fetchProjectSourceComposition,
} from "@/lib/scope/server";
import type { StandardFilters, StandardAggregates } from "@/lib/scope/result-adapter";
import type {
  GeoBrandKpiRow,
  GeoCodeTotals,
  GeoKpiResult,
  BucketUnit,
  SubKpiEngineRow,
  StandardSubKpis,
} from "@/lib/db/repositories/scope-aggregates";
import type { KpiKey } from "./sample";
import { marketMetrics, type GeoMetrics } from "./overview-metrics";
export { OVERVIEW_KPI_KEYS, metricValue, marketMetrics } from "./overview-metrics";
export type { OverviewKpiKey, GeoMetric, GeoMetrics } from "./overview-metrics";
import { geoLocateByCode } from "@/lib/geo-catalog";
import { rhqForCountry, rhqRegionIdsForBrand } from "@/lib/rhq";
import { getSession } from "@/lib/auth/session";
import { requestDeduped } from "@/lib/request-dedupe";
import type { AllowedScope } from "@/lib/auth/types";
import { DELTA_TREND_WINDOW_DAYS } from "@/lib/scope/kpi-tab-budget";
import type { StandardTrendBucket } from "@/lib/db/repositories/scope-aggregates";
import type { KpiSummary } from "./sample";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { degradeOnApiFailure } from "@/lib/scope/degrade-registry";
import { OVERVIEW_TREND_METRICS } from "@/lib/hgh/adapters/trend";
import {
  afterFirstRender,
  fetchDashboardSummary,
  loadComposition,
  loadLiveDashboard,
  loadLiveGeo,
  loadLiveTrend,
  loadSubKpis,
  orNullOnTransient,
  type DashboardCtx,
} from "@/lib/hgh/adapters/dashboard";
import { summaryIsEmpty } from "@/lib/hgh/adapters/summary";

// Live dashboard view-model — maps the scope result adapter's generic
// aggregates (lib/scope/result-adapter) onto the dashboard component shapes.
// Returns null when there is no live data (mock mode, root unset, or no
// measurements yet) → page.tsx falls back to the sample fixtures.
//
// Honest mapping: only KPIs the measurement data supports are emitted
// (visibility, share-of-voice, and citation-share when citations exist).
// sentiment / position / citation-accuracy / traffic-conversion have no source
// in scope's surface, so they are OMITTED — SummaryTiles skips missing keys
// rather than showing a fabricated number. Trend + detail need a time series we
// don't have from a single measurement snapshot, so page.tsx hides those
// sections in live mode.

// 원천 스위치(D8, 단위 U5): HGH_SOURCE_G1(글로벌)·HGH_SOURCE_G6(프로젝트, localProjectId) 가
// api 면 아래 get* 가 새 백엔드(lib/hgh/adapters/dashboard.ts)에서 **같은 반환 타입**을 만든다.
// legacy(기본)는 종전 본문 그대로다(롤백 경로). 차이는 그 어댑터 머리말의 known_diff 목록.
// api 쪽 본문 판정(빈 상태·degrade 라벨)은 legacy 와 같은 지면을 쓴다: 카드가 비면
// `standardAggregates`, 추이가 실패하면 `standardTrend:<unit>`/`projectTrend:<unit>`.

// GEO 스냅샷 view-model — "시장별 경쟁 위치". The mirror tags each answer with an
// ISO country code (scope_answers.region); we roll the per-(market, brand)
// mention totals into the geo-catalog's 권역 → 국가 hierarchy and, per market,
// compute OUR share of voice + rank vs competitors.
//
// 브랜드 격리(boundary): "우리"의 정의는 호출 계정의 브랜드 권한(ourBrands)에 따라
// 좁혀진다 — 무제한 스코프(admin)는 추적 HMG 3사 COMBINED("HMG"), 브랜드 스코프
// 계정은 자기 브랜드만(예: Genesis). 권한 밖 형제 HMG 브랜드(추적 대상이지만 ourBrands
// 아님)는 SoV 분자에서 빠지고, 경쟁사 목록/순위에도 등장하지 않아 브랜드명이 새지 않는다
// (경쟁사 = 외부 브랜드만). 분모는 시장 전체 언급 수 그대로라 "브랜드 점유율 = 자기 브랜드
// 언급 ÷ 시장 전체 언급"(② AI 점유율 KPI 정의와 동일). topBrand = ourBrands 중 그 시장
// 최강 단일 브랜드(admin은 "독일은 Kia, 한국은 Hyundai"가 드릴다운에 드러남).
export interface BrandStat {
  name: string;
  sov: number; // share of voice (% of the market's brand mentions)
}
export interface MarketCompetition {
  hmgSov: number; // OUR (scoped-brand) combined share of voice (%)
  hmgRank: number; // OUR rank among entities (us vs each external competitor), 1-based
  fieldSize: number; // number of ranked entities (us + external competitors)
  topBrand: BrandStat | null; // OUR strongest single in-scope brand here
  topRival: BrandStat | null; // strongest external (non-HMG) brand here
  /** KPI 5종(Overview). 구 캐시/테스트 픽스처엔 없을 수 있어 optional. */
  metrics?: GeoMetrics;
}
export interface GeoCountryRow extends MarketCompetition {
  code: string; // ISO alpha-2 (scope region)
  country: string; // catalog display name (e.g. "United States")
}
export interface GeoRegionRow extends MarketCompetition {
  region: string; // RHQ 권역 id (brand-specific, e.g. "hyundai-europe")
  countries: GeoCountryRow[]; // desc by HMG SoV
}
// markets = 측정된 권역 (desc by HMG SoV); pending = 아직 측정 안 된 권역 키들.
// ourLabel = 점유율 주체 라벨 — admin(무제한)은 "HMG", 브랜드 스코프 계정은 자기
// 브랜드명. 지도/표가 "{ourLabel} 점유율"로 헤더·툴팁을 렌더.
export interface LiveGeo {
  markets: GeoRegionRow[];
  pending: string[];
  ourLabel: string;
}

// 2026-08-28: `geo` 를 이 타입에서 분리했다. ① SUMMARY 는 `kpis` 만, ④ GEO 는
// `geo` 만 쓰는데 한 Promise.all 에 묶여 있어 **SUMMARY 가 자기가 안 쓰는 GEO
// 집계를 기다렸다**. 그 집계 자체는 프로덕션 EXPLAIN ANALYZE 로 콜드 2.14s
// (캐시 미적중 시 게이트웨이 왕복까지 포함한 체감은 이보다 크다).
// 게다가 GEO 섹션은 showsGeoMap(lib/auth/scope-policy.ts)이 admin/hq/region 에만
// true 라, country·website·vendor 역할에서는 집계를 돌리고 결과를 그대로 버렸다.
// → getLiveGeo 참조.
export interface LiveDashboard {
  kpis: KpiSummary[];
}

// Per-market competitive position from a brand→mentions tally, scoped to the
// caller's brand authority (ourBrands: null = 무제한 → 추적 HMG 전체).
//   - "우리" = 추적 HMG 브랜드 ∩ ourBrands → 합산해 한 엔티티로 경쟁사와 순위 비교.
//   - 경쟁사 = 외부(비추적) 브랜드만. 권한 밖 형제 HMG 브랜드는 우리도 경쟁사도
//     아니므로 순위/최대경쟁에 이름이 노출되지 않는다(브랜드 격리).
//   - 분모(total)는 시장 전체 언급 — "브랜드 점유율 = 우리 언급 ÷ 시장 전체".
function marketStats(
  brands: { brand: string; mentions: number; isTracked: boolean; excluded?: boolean }[],
  ourBrands: Set<string> | null,
): MarketCompetition {
  const isOurs = (b: { brand: string; isTracked: boolean }) =>
    b.isTracked && (ourBrands === null || ourBrands.has(b.brand));
  const total = brands.reduce((s, b) => s + b.mentions, 0);
  const oursMentions = brands
    .filter(isOurs)
    .reduce((s, b) => s + b.mentions, 0);
  // 명부 제외 엔티티(`excluded`)는 경쟁사 순위·최대 경쟁사·순위 모수(fieldSize)에서만 뺀다.
  // SOV 분모(`total`)는 제외 행을 포함한 전 브랜드 합 그대로다(KPI 값 무변경).
  const competitors = brands
    .filter((b) => !b.isTracked && !b.excluded)
    .sort((a, b) => b.mentions - a.mentions);
  // Rank US (combined in-scope brands) against each external competitor brand.
  const OURS = "\0ours"; // sentinel — never a real brand name
  const entities = [
    { name: OURS, mentions: oursMentions },
    ...competitors.map((c) => ({ name: c.brand, mentions: c.mentions })),
  ].sort((a, b) => b.mentions - a.mentions);
  const ourRank = entities.findIndex((e) => e.name === OURS) + 1;
  const ourTop = brands
    .filter(isOurs)
    .sort((a, b) => b.mentions - a.mentions)[0];
  return {
    hmgSov: pct(oursMentions, total),
    hmgRank: ourRank,
    fieldSize: entities.length,
    topBrand: ourTop ? { name: ourTop.brand, sov: pct(ourTop.mentions, total) } : null,
    topRival: competitors[0]
      ? { name: competitors[0].brand, sov: pct(competitors[0].mentions, total) }
      : null,
  };
}

// 호출 계정의 브랜드 권한 → "우리"로 칠 브랜드 집합. 무제한(admin) 또는 브랜드 제한이
// 없으면 null(추적 HMG 전체). 그 외엔 scope.brands 집합.
function ourBrandsOf(scope: AllowedScope | undefined): Set<string> | null {
  if (!scope || scope.all) return null;
  if (!scope.brands || scope.brands.length === 0) return null;
  return new Set(scope.brands);
}

// 점유율 주체 라벨 — 무제한/미지정은 "HMG", 브랜드 스코프는 브랜드명(들).
function ourLabelOf(ourBrands: Set<string> | null): string {
  if (!ourBrands || ourBrands.size === 0) return "HMG";
  return [...ourBrands].join(", ");
}

// 권역 그룹핑 기준 단일 브랜드: 명시 brand 필터(단일) 우선, 없으면 스코프가 단일
// 브랜드일 때 그 브랜드, 아니면 null(admin 전체-브랜드 → 권역 뷰는 브랜드 선택 필수).
function activeBrandFor(
  scope: AllowedScope | undefined,
  filters?: StandardFilters,
): string | null {
  if (filters?.brand?.length === 1) return filters.brand[0];
  if (scope && !scope.all && scope.brands?.length === 1) return scope.brands[0];
  return null;
}

// Roll the per-(ISO code, brand) competition rows into the catalog's 권역 → 국가
// hierarchy and compute HMG's standing at both levels. Region stats are computed
// from the region's SUMMED brand mentions (not an average of country ranks) so
// big markets weigh correctly. Returns measured regions (desc by HMG SoV) plus
// the keys of display regions with no measured answers (the 측정 예정 list).
// 권역(RHQ)은 brand 의존이라(같은 국가가 브랜드마다 다른 권역) 그룹핑엔 단일 활성
// 브랜드가 필요하다. activeBrand 없으면(admin 전체-브랜드, 미선택) 권역 귀속이 모호 →
// 빈 markets 반환(권역 뷰는 브랜드 선택 필수, 결정 C5). 측정국은 활성 브랜드의 RHQ 권역으로
// 버킷팅하고, 그 브랜드의 미측정 권역은 "측정 예정"(pending)으로 남긴다.
export function buildGeo(
  kpi: GeoKpiResult,
  ourBrands: Set<string> | null,
  activeBrand: string | null,
): LiveGeo {
  const ourLabel = ourLabelOf(ourBrands);
  if (!activeBrand) return { markets: [], pending: [], ourLabel };

  const byCode = new Map<string, GeoBrandKpiRow[]>();
  for (const r of kpi.brands) {
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }
  const totalsBy = new Map(kpi.codes.map((c) => [c.code, c]));
  const zero = (): Omit<GeoCodeTotals, "code"> => ({ answers: 0, ownAnswers: 0, citTotal: 0, citOwned: 0 });

  const regionBrands = new Map<string, Map<string, GeoBrandKpiRow>>();
  const regionTotals = new Map<string, Omit<GeoCodeTotals, "code">>();
  const regionCountries = new Map<string, GeoCountryRow[]>();
  for (const [code, brands] of byCode) {
    const regionId = rhqForCountry(activeBrand, code);
    if (!regionId) continue; // 활성 브랜드의 권역에 없는 코드 → 표시 안 함
    const country = geoLocateByCode(code)?.country ?? code; // 표시명(지리 불변)
    const totals = totalsBy.get(code) ?? { code, ...zero() };
    (regionCountries.get(regionId) ?? regionCountries.set(regionId, []).get(regionId)!).push({
      code,
      country,
      ...marketStats(brands, ourBrands),
      metrics: marketMetrics(brands, totals, ourBrands),
    });
    const bm = regionBrands.get(regionId) ?? regionBrands.set(regionId, new Map()).get(regionId)!;
    for (const b of brands) {
      const e = bm.get(b.brand) ?? {
        code: regionId, brand: b.brand, mentions: 0, isTracked: b.isTracked,
        ...(b.excluded ? { excluded: true } : {}),
        answers: 0, posSum: 0, posCnt: 0, sentPositive: 0, sentTotal: 0,
      };
      e.mentions += b.mentions;
      e.answers += b.answers;
      e.posSum += b.posSum;
      e.posCnt += b.posCnt;
      e.sentPositive += b.sentPositive;
      e.sentTotal += b.sentTotal;
      bm.set(b.brand, e);
    }
    const rt = regionTotals.get(regionId) ?? zero();
    rt.answers += totals.answers;
    rt.ownAnswers += totals.ownAnswers;
    rt.citTotal += totals.citTotal;
    rt.citOwned += totals.citOwned;
    // 공식(HMG) 분자는 국가 행이 실어 왔을 때만 권역에 합산한다(없으면 종전 분자로 읽힌다).
    if (typeof totals.citOfficialHmg === "number") {
      rt.citOfficialHmg = (rt.citOfficialHmg ?? 0) + totals.citOfficialHmg;
    }
    regionTotals.set(regionId, rt);
  }

  const markets: GeoRegionRow[] = [];
  const pending: string[] = [];
  for (const regionId of rhqRegionIdsForBrand(activeBrand)) {
    const bm = regionBrands.get(regionId);
    if (!bm) {
      pending.push(regionId);
      continue;
    }
    const brands = [...bm.values()];
    const countries = (regionCountries.get(regionId) ?? []).sort(
      (a, b) => b.hmgSov - a.hmgSov,
    );
    markets.push({
      region: regionId,
      ...marketStats(brands, ourBrands),
      metrics: marketMetrics(brands, regionTotals.get(regionId) ?? zero(), ourBrands),
      countries,
    });
  }
  markets.sort((a, b) => b.hmgSov - a.hmgSov);
  return { markets, pending, ourLabel };
}

// one-decimal percent
function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

// 미러 집계 → ①~⑤ KPI 카드(정의·산식 그대로). ⑥(citationAccuracy)·⑦(GA4 전환)은
// 데이터 출처가 달라 호출부에서 덧붙인다. 표준·프로젝트 대시보드가 공유 —
// 프로젝트는 project-scoped agg를 넘겨 같은 산식을 그 프로젝트 답변에 적용.
export function buildMirrorKpis(agg: StandardAggregates): KpiSummary[] {
  const trackedMentions = agg.brands
    .filter((b) => b.isTracked)
    .reduce((s, b) => s + b.mentionCount, 0);
  return [
    // ① AI 노출률 (Visibility) — 당사 브랜드 언급 답변 ÷ 모니터링 답변
    {
      key: "visibility",
      value: pct(agg.trackedAnswerCount, agg.totalAnswers),
      delta: null,
      direction: "flat",
      ratio: { numerator: agg.trackedAnswerCount, denominator: agg.totalAnswers },
    },
    // ② AI 점유율 (SOV) — 당사 언급 횟수 ÷ 전체 언급 횟수
    {
      key: "shareOfVoice",
      value: pct(trackedMentions, agg.totalMentions),
      delta: null,
      direction: "flat",
      ratio:
        agg.totalMentions > 0
          ? { numerator: trackedMentions, denominator: agg.totalMentions }
          : undefined,
    },
    // ③ AI 우호도 (Sentiment) — 긍정 감정 신호 ÷ 전체 감정 신호 (언급 단위)
    {
      key: "sentiment",
      value: agg.sentiment.positiveRate,
      delta: null,
      direction: "flat",
      ratio:
        agg.sentiment.sampledMentions > 0
          ? {
              numerator: agg.sentiment.positiveMentions,
              denominator: agg.sentiment.sampledMentions,
            }
          : undefined,
    },
    // ④ AI 우선 노출도 (Average Position) — 순위의 합 ÷ 언급된 답변 수
    {
      key: "position",
      value: agg.position.avgPosition,
      delta: null,
      direction: "flat",
      ratio:
        agg.position.avgPosition != null && agg.position.sampledAnswers > 0
          ? {
              numerator: Math.round(agg.position.avgPosition * agg.position.sampledAnswers),
              denominator: agg.position.sampledAnswers,
            }
          : undefined,
    },
    // ⑤ AI 인용 점유율 (Citation Share) — 분자는 표면별이다(`citationShareNumerator`):
    //    글로벌 = 출처 카테고리 Official (HMG) 인용(제품 책임자 2026-09-29, 인용 탭 카테고리 차트와
    //    같은 분류) · website·project = 종전 당사 base URL 인용. 분모는 전체 인용.
    {
      key: "citationShare",
      value:
        agg.citations.totalCitations > 0
          ? pct(citationShareNumerator(agg.citations), agg.citations.totalCitations)
          : null,
      delta: null,
      direction: "flat",
      ratio:
        agg.citations.totalCitations > 0
          ? {
              numerator: citationShareNumerator(agg.citations),
              denominator: agg.citations.totalCitations,
            }
          : undefined,
    },
  ];
}

// KPI #16 — SOV 비교 비율 = 당사 SOV ÷ 비교 기준 브랜드 SOV × 100. 분모(전체
// 언급 수)가 약분되므로 당사 언급 ÷ 기준 브랜드 언급으로 계산한다. 기준 브랜드는
// 프로젝트에서 is_target 으로 지정한 브랜드를 우선 쓰고, 미지정이면 이 집계
// 창의 SOV 1위 외부 브랜드를 자동 선택한다. 자동 분모는 회기마다 바뀔 수 있어
// 카드에 분모 브랜드명을 함께 노출한다. 외부 브랜드가 아예 없으면(경쟁 언급 0)
// 행 자체 생략. 표준·웹사이트(자동)·프로젝트(지정/자동) 공유.
export function applyCompetitorSov(
  kpis: KpiSummary[],
  agg: StandardAggregates,
  designatedTarget?: string | null,
): KpiSummary[] {
  const ourMentions = agg.brands
    .filter((b) => b.isTracked)
    .reduce((s, b) => s + b.mentionCount, 0);
  const target = designatedTarget
    ? (agg.brands.find(
        (b) => !b.isTracked && b.name.toLowerCase() === designatedTarget.toLowerCase(),
      ) ?? { name: designatedTarget, mentionCount: 0 })
    : agg.brands
        .filter((b) => !b.isTracked)
        .sort((a, b) => b.mentionCount - a.mentionCount)[0];
  if (!target) return kpis; // 자동 모드인데 외부 브랜드 언급이 전혀 없음
  const competitorSov = {
    brand: target.name,
    // 지정 타겟이 이 창에 언급 0이면 비율 정의 불가 → null (측정 대기 칩,
    // 분모 브랜드명은 유지해 "왜 대기인지"가 보이게).
    value:
      target.mentionCount > 0
        ? Math.round((1000 * ourMentions) / target.mentionCount) / 10
        : null,
  };
  return kpis.map((k) =>
    k.key === "shareOfVoice" ? { ...k, competitorSov } : k,
  );
}


/** api 원천의 읽기 문맥: 표면·(프로젝트)·세션 스코프(주입값 판별용, 전송 안 함). */
async function apiCtx(localProjectId?: string, filters?: StandardFilters): Promise<DashboardCtx> {
  // 프로젝트 커스텀 필드 값 필터는 cf.<uuid> 로 실린다(프로젝트 표면만).
  if (localProjectId) {
    return { surface: "project", projectId: localProjectId, scope: null, customFields: filters?.customFieldFilters };
  }
  const session = await getSession();
  return { surface: "global", scope: session?.user.scope ?? null };
}

const isApiFor = (localProjectId?: string): boolean =>
  isAnalysisApi("dashboard", localProjectId ? "project" : "global");

async function getLiveDashboardImpl(
  filters?: StandardFilters,
): Promise<LiveDashboard | null> {
  if (isApiFor()) {
    const ctx = await apiCtx();
    return degradeOnApiFailure("standardAggregates", () => loadLiveDashboard(filters ?? {}, ctx));
  }
  // GEO 경쟁 집계는 여기서 부르지 않는다 — ④ GEO 전용 페처(getLiveGeo)로 분리.
  // ⑦ AI 유입 전환율(GA4)도 부르지 않는다(2026-10-14): Overview 개편(2026-09-02) 이후
  // 이 화면은 OVERVIEW_KPI_KEYS 5종만 그려 ⑦ 을 표시하지 않는데, 종전에는 ga4_properties
  // 조회와 GA4 Data API 호출이 카드·GEO 와 같은 Promise.all 에서 매 렌더 기다려졌다.
  // ⑦ 카드는 프로젝트 홈(projects/[id]/_data/live.ts)에 남아 있다.
  const agg = await fetchStandardAggregates(filters);
  if (!agg || agg.totalAnswers === 0) return null;

  // ①~⑤ 미러 KPI (표준·프로젝트 공유 산식).
  // ⑥ AI 타겟 URL 인용률 — 2026-06-22: 표준 대시보드에서 삭제 (프로젝트
  //    대시보드에서는 유지). 표준은 프롬프트별 target URL 라벨링 부재로
  //    의미 있는 측정 불가. 프로젝트 KPI(getProjectKpis)는 별도로 emit.
  const kpis: KpiSummary[] = buildMirrorKpis(agg);

  // 표준 대시보드는 타겟 지정 개념이 없어 항상 자동(SOV 1위) 분모.
  return { kpis: applyCompetitorSov(kpis, agg) };
}

// ④ GEO 전용 페처 — SUMMARY 와 분리(2026-08-28).
//
// 빈 상태 의미 보존: 종전에는 `agg` 가 없으면(측정 0) LiveDashboard 자체가 null 이라
// GEO 도 안 그려졌다. 여기서도 같은 판정을 쓰려고 getLiveDashboard 를 참조한다 —
// **추가 DB 호출은 0**이다. ① SUMMARY 가 같은 filters 로 이미 부르고 있고,
// requestDeduped 의 키는 인자를 정렬 직렬화한 문자열(stableKey)이라 객체
// 아이덴티티가 달라도 같은 키로 접힌다. GEO 만 렌더되는 경우(SUMMARY 보다 먼저
// 도착)에도 반대 방향으로 접혀 역시 1회다.
//
// GEO 집계와 그 판정은 **병렬**로 돈다 — 직렬화하면 GEO 섹션이 종전보다 느려진다
// (종전 = 한 Promise.all 안에서 동시 실행). 측정 0 인 드문 경우에 GEO 집계가 헛도는
// 것도 종전과 동일한 동작이다.
async function getLiveGeoImpl(filters?: StandardFilters): Promise<LiveGeo | null> {
  if (isApiFor()) {
    // 빈 상태 판정은 카드와 같은 요약 호출(요청 안 합치기로 1회)이다. D6: 첫 렌더 필수 호출 뒤.
    const ctx = await apiCtx();
    const f = filters ?? {};
    return afterFirstRender(f, ctx, async () => {
      const summary = await orNullOnTransient(fetchDashboardSummary(f, ctx));
      if (!summary || summaryIsEmpty(summary.data, summary.meta)) return null;
      // GEO 일시 실패는 섹션 생략(카드는 그대로), 권한·필터 오류는 던진다.
      return orNullOnTransient(loadLiveGeo(f, ctx));
    });
  }
  const session = await getSession();
  const [live, geoComp] = await Promise.all([
    getLiveDashboard(filters),
    fetchStandardGeoKpi(filters),
  ]);
  if (!live) return null; // 빈 상태 문구의 지면은 ① SUMMARY 가 소유한다
  return buildGeo(
    geoComp,
    ourBrandsOf(session?.user.scope),
    activeBrandFor(session?.user.scope, filters),
  );
}

// ─── 시계열 view-model (PROTOTYPE) ──────────────────────────────────────────
// measured_at 을 주/일 버킷으로 normalize 한 KPI 추이. 각 버킷은 스냅샷과 동일한
// 산식으로 KPI 를 계산하고, 불규칙 cadence 를 숨기지 않도록 coverage(측정일수 ·
// 답변수 · 마지막측정)를 함께 싣는다. 버킷에 데이터가 없으면 그 KPI 는 null →
// 차트에서 connectNulls=false 로 선이 끊겨 "측정 없음"이 그대로 보인다.
// 미러에 없는 ⑥ 타깃URL인용률 / ⑦ 유입전환율(GA4)은 시계열에서 제외(정직성).
export type TrendKpiKey = Extract<
  KpiKey,
  | "visibility"
  | "shareOfVoice"
  | "sentiment"
  | "position"
  | "citationShare"
  | "citationAccuracy"
>;

export interface LiveTrendPoint {
  bucketStart: string; // ISO date (week = 그 주 월요일 / day = 그 날)
  /**
   * 축 on 의 **x축 라벨 날짜**(귀속 날짜). 버킷 키는 주 격자라 website(금요일 귀속)
   * 에서 둘이 다르다. 축 off 면 `undefined` = 종전 라벨 규칙(`firstAt`).
   */
  roundDate?: string;
  firstAt: string | null; // 버킷 내 실제 첫 측정 시각 (주 라벨에 실측일 표기용)
  values: Partial<Record<TrendKpiKey, number>>;
  measuredDays: number; // 버킷 안 실제 측정 일수 (coverage 배지)
  answers: number;
  lastAt: string | null;
  /**
   * 회차 버킷의 대표 앵커(ISO) — **x축 라벨 전용**(`trendBucketDisplays`). 키(`bucketStart`)는
   * 앵커의 UTC 일이라 그대로 그리면 KST 자정 직후 앵커가 하루 앞서 보인다(2026-09-28).
   * 미러 격자 버킷은 없다(`StandardTrendBucket.cycleAnchorAt` 을 그대로 나른다).
   */
  cycleAnchorAt?: string;
  /**
   * 수집 오류 회차(2026-09-10). 값이 있으면 이 슬롯은 **측정값 전부 null** 이고
   * 화면은 음영 + 안내 문구를 낸다. 계약 정본: lib/viz/trend-gap.ts.
   */
  gap?: TrendGap;
}

export interface LiveTrend {
  unit: BucketUnit;
  /**
   * **x축 라벨의 시계**(2026-09-20). 생략·`"measured"` = 종전(주 라벨은 그 주 첫
   * 측정일 `firstAt`), `"anchor"` = 앵커 축이라 라벨이 **버킷 키 그 자체**다.
   *
   * 왜 필요한가: 축 on 에서 버킷 키는 귀속 날짜(`round_date`/`anchor_week`)인데
   * 라벨만 `firstAt` 에 머물러 있었다(`trendBucketLabel`). 그래서 website 추이의
   * x축이 목·월·화가 섞인 **측정 시작일**로 찍혔고, 두 버킷의 첫 측정일이 같은 날이면
   * 같은 라벨이 두 번 나왔다(2026-09-20 관찰 `7. 27.` × 2). 마지막 점 라벨도
   * 카드 기준일과 어긋났다(09-17 vs 09-11).
   *
   * 데이터로는 못 가른다 — 축 off 의 주 버킷도 월요일이라 값 모양이 같다. 그래서
   * 서버가 판정을 실어 보낸다(`cycleAnchorAt` 이 집계층 경로에만 있는 것과 달리
   * 이 값은 미러 경로에도 실린다).
   */
  axis?: "anchor" | "measured";
  points: LiveTrendPoint[];
  lastMeasuredAt: string | null; // 전체에서 가장 최근 측정 시각
  totalAnswers: number;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

const DAY_MS = 86_400_000;

// 빈 버킷(측정 없는 주/일)을 placeholder 로 채운다. 미러 SQL 은 데이터가 있는 버킷만
// 돌려주므로, 그 사이 측정이 없던 버킷은 행 자체가 빠진다 → recharts 는 인접한 두 점을
// 곧장 직선으로 이어버려(누락 ≠ null) "측정 없는 구간"이 오히려 끊기지 않는다.
// connectNulls=false 가 선을 끊으려면 그 버킷이 점으로 "존재하되 값이 null" 이어야
// 하므로, 캘린더 축을 연속으로 채우고 빈 버킷은 values={} (모든 KPI null) 로 넣는다.
/**
 * 회차 버킷인가 — 집계층 경로만 `cycleAnchorAt` 을 채운다(PR③). 미러 경로는 안 채운다.
 * 웹사이트 쪽(`website/_data/live.ts::isCycleBucketed`)과 **같은 계약**이다.
 */
export const isCycleBucketed = (buckets: StandardTrendBucket[]): boolean =>
  buckets.length > 0 && buckets.every((b) => !!b.cycleAnchorAt);

/**
 * ⚠️ `roundSurface` 는 **축 on 에서만** 온다 — 채운 버킷은 회차가 없어 `round_date` 도
 *    없는데, 라벨이 버킷 키(주 월요일)로 폴백하면 정규 요일 격자에 구멍이 생긴다
 *    (website 추이에 월요일 하나가 섞인 2026-09-20 관찰의 `7. 27.`).
 *    요일 상수 정본은 `REGULAR_ROUND_DOW` 한 곳이고 여기서는 경유만 한다.
 *    글로벌은 월요일이라 값이 버킷 키와 같고(무변화), 프로젝트 표면은 정규 요일이
 *    없어 호출부가 넘기지 않는다.
 */
function fillTrendGaps(
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
    // bucketStart 는 주/일 경계에 정렬돼 있으므로 stepMs 간격으로 빈 칸을 메운다.
    for (
      let t = Date.parse(points[i].bucketStart) + stepMs;
      t < end - DAY_MS / 2;
      t += stepMs
    ) {
      const filledStart = new Date(t).toISOString().slice(0, 10);
      out.push({
        bucketStart: filledStart,
        ...(roundSurface && unit === "week"
          ? { roundDate: regularRoundDateOf(roundSurface, filledStart) }
          : {}),
        firstAt: null,
        values: {},
        measuredDays: 0,
        answers: 0,
        lastAt: null,
      });
    }
  }
  return out;
}

async function getLiveTrendImpl(
  filters: StandardFilters | undefined,
  unit: BucketUnit,
  localProjectId?: string,
): Promise<LiveTrend | null> {
  if (isApiFor(localProjectId)) {
    // API 에 일 버킷이 없다: Δ 용 day 롤업은 회차 버킷(DC-05), 차트는 주 버킷 그대로.
    const ctx = await apiCtx(localProjectId, filters);
    const f = filters ?? {};
    const label = `${localProjectId ? "projectTrend" : "standardTrend"}:${unit}`;
    return afterFirstRender(f, ctx, () =>
      degradeOnApiFailure(label, () =>
        loadLiveTrend(f, ctx, unit === "day" ? "cycle" : "week", OVERVIEW_TREND_METRICS),
      ),
    );
  }
  const buckets = localProjectId
    ? await fetchProjectTrend(localProjectId, filters, unit)
    : await fetchStandardTrend(filters, unit);
  if (!buckets || buckets.length === 0) return null;

  const measured: LiveTrendPoint[] = buckets.map((b) => {
    // 숨긴 회차의 갭 슬롯(0070) — 그 계열의 **값 계산을 아예 하지 않는다**. `pct(0, 0)`
    // 은 분모 0 이라 이 함수의 전제("버킷엔 항상 answers>=1")를 깨고, 계약상 갭 슬롯의
    // 측정값은 전부 null 이어야 한다(lib/viz/trend-gap.ts).
    //
    // 0071 — 갭에는 **범위**가 있다. `scope:"citations"` 는 인용 계열만 내려간 회차이고
    // (8/25 글로벌: chatgpt 인용률 3.8% vs 언급 83.8%), 미러 리더의 언급 술어가 완화돼
    // **값을 실은 채** 여기까지 온다. 계열별로 따로 판정한다 — 뭉치면 "멘션을 살려라"가
    // 이 한 줄에서 도로 죽는다.
    // 값 산식의 정본은 **중립 모듈** `lib/kpi/overview-card-values.ts` 다(2026-09-20).
    // 언급 화면의 카드·Δ 가 같은 함수를 불러야 두 화면이 안 갈린다 — 여기 인라인으로
    // 두면 그쪽이 옮겨 적게 되고, 옮겨 적는 순간 두 벌이 된다.
    // 갭·분모 0 판정도 그 함수 안에 있다(빈 객체를 돌려준다).
    const values = overviewTrendValues(b);
    // 언급 계열이 갭이거나(= 종전 `all` 갭) 모수가 없으면 오늘과 **같은 빈 점**이다.
    // `answers === 0` 을 함께 보는 이유: 사실표 회차 축에 삽입되는 `citations` 슬롯은
    // 값이 하나도 없이 온다(D-4 A) — 그걸 계산하면 `pct(0,0)` 이 된다.
    if (trendGapApplies(b.gap, "mention") || b.answers === 0) {
      return {
        bucketStart: b.bucketStart,
        firstAt: null,
        values: {},
        measuredDays: 0,
        answers: 0,
        lastAt: null,
        ...(b.cycleAnchorAt ? { cycleAnchorAt: b.cycleAnchorAt } : {}),
        ...(b.gap ? { gap: b.gap } : {}),
      };
    }
    return {
      bucketStart: b.bucketStart,
      ...(b.roundDate ? { roundDate: b.roundDate } : {}),
      firstAt: b.firstAt,
      values,
      measuredDays: b.measuredDays,
      answers: b.answers,
      lastAt: b.lastAt,
      ...(b.cycleAnchorAt ? { cycleAnchorAt: b.cycleAnchorAt } : {}),
      // 값이 살아난 버킷에도 마커는 그대로 나른다 — 인용 카드·인용 시리즈가 이걸로
      // 음영을 그린다. 언급 소비자는 `trendGapApplies` 로 스스로 떨어뜨린다.
      ...(b.gap ? { gap: b.gap } : {}),
    };
  });

  // 측정된 버킷만 lastMeasuredAt / totalAnswers 의 근거로 쓰고, 차트용 points 는
  // 빈 버킷을 채워 끊김이 보이게 한다 (placeholder 는 answers=0 이라 합계 영향 없음).
  //
  // ⚠️ **회차 축이면 채우지 않는다**(PR③). `cycleAnchorAt` 이 있으면 x 는 주/일 격자가
  //    아니라 회차 anchor 다 — 주 격자로 채우면 **회차가 없던 주에 없던 점을 만든다**.
  //    회차 없는 주는 점이 없는 것이 맞고, 한 주에 회차가 둘이면 점도 둘이다.
  //    Δ 는 그대로 `applyTrendDeltas`(값 있는 마지막 두 점) = "직전 회차 대비" 가 된다.
  //    판정은 **`every`** 다(웹사이트 `live.ts::isCycleBucketed` 와 같은 형태) — 일부만
  //    표시자를 가진 배열은 경로가 섞였다는 뜻이므로 보수적으로 종전 격자를 쓴다.
  // 축 on 이면 채운 버킷의 라벨도 정규 요일로 맞춘다. 프로젝트 표면은 정규 요일이
  // 없어(§9.2) 넘기지 않는다 = 버킷 키 그대로.
  //
  // 격자(D5)가 이 배열을 만들었으면 **채우지 않는다** — 자리 목록은 이미 원장이 냈고
  // (`fetchStandardTrend`/`fetchProjectTrend` → `applyTrendGridToBuckets`), 여기서 또
  // 채우면 원장에 없는 주가 다시 생긴다. `isCycleBucketed` 만으로는 부족하다: 미러
  // 폴백 경로의 버킷에는 `cycleAnchorAt` 이 없어 판정이 false 가 된다.
  //
  // ⚠️ 판정은 **데이터에 실린 표식**(`gridSlot`)이지 스위치가 아니다(검증 B2). 스위치
  //    (`trendGridKnownEnabled`)로 물으면 키가 켜져 있으나 격자를 **안 얹은** 두 경로에서
  //    종전 채움이 통째로 사라진다: ① 일 버킷(Δ 칩 30일·프로젝트 일 추이 — `unit !== "week"`
  //    라 자리를 안 만든다) ② 자리를 못 세운 경우(`buildTrendGrid` 가 null).
  const fillSurface =
    anchorAxisKnownEnabled() && !localProjectId ? ("global" as const) : undefined;
  const points =
    isTrendGridApplied(buckets) || isCycleBucketed(buckets)
      ? measured
      : fillTrendGaps(measured, unit, fillSurface);
  return {
    unit,
    // 라벨 시계 — 축 on 이면 버킷 키가 곧 라벨이다(`LiveTrend.axis` 주석).
    // 여기서 읽어도 안전하다: 위 `fetchStandardTrend`/`fetchProjectTrend` 가 이미
    // `ensureAnchorAxis()` 를 지나온 뒤다(게이트·`withAnswerSet` 진입 계약).
    axis: anchorAxisKnownEnabled() ? "anchor" : "measured",
    points,
    lastMeasuredAt: measured[measured.length - 1]?.lastAt ?? null,
    totalAnswers: measured.reduce((s, p) => s + p.answers, 0),
  };
}

// ── KPI 카드 Δ 의 출처 (2026-09-03 명문화) ──────────────────────────────────
// 대시보드는 추이 롤업을 **두 번** 부른다: TREND 구획이 화면 버킷(week)으로,
// SUMMARY 구획이 Δ 전용으로 day 버킷·최근 30일. 감사 로그 7일 실측
// `standardTrend` 1,289 vs `standardAggregates` 652 ≈ 1.98배가 이것이다.
//
// 왜 두 번인가(경위): 원래 Δ 는 화면 버킷과 같은 롤업에서 나왔고 —
// applyTrendDeltas 머리 주석의 "측정 기준(주/일)과 동일한 버킷을 쓰므로 카드
// 변화량과 추이 차트가 정합한다" 가 그 계약이다 — 2026-08-27 콜드 로드 수정에서
// SUMMARY 가 전 이력 스캔(실측 26s)을 피하려고 **day·30일 창**으로 갈라졌다.
// 그 결과 지금은 카드 Δ 와 차트가 서로 다른 버킷을 본다.
//
// ⚠️ 이 두 상수를 바꾸면 **고객이 보는 Δ 숫자가 바뀐다**. 표면마다 이미 갈려 있다:
//   · /website  → 화면에 그리는 그 추이(week)에서 Δ 를 뽑는다(1회 호출).
//   · /dashboard·/projects → 아래 규칙으로 별도 day 롤업(2회 호출).
// 통합(2회→1회)은 산식 변경이라 제품 결정 사항이다. 그 전까지 현 규칙을
// live.trend-delta-source.test.ts 가 고정한다.
// 정본은 **중립 모듈** `lib/kpi/overview-card-values.ts` 다(2026-09-20 N2) — 언급 화면의
// Δ 가 **같은 입력**을 써야 두 화면이 안 갈린다. 여기서는 재수출만 한다(기존 import 경로 유지).
export { DELTA_TREND_BUCKET, deltaTrendFilters };
// 창(일) 정본은 `lib/scope/kpi-tab-budget.ts` — 집계층 추이 경로도 같은 값을 봐야 해서
// 중립 모듈로 올렸다(PR③ GG-4). 여기서는 재수출만 한다(기존 import 경로 유지).
export { DELTA_TREND_WINDOW_DAYS };

// KPI 카드 변화량 — 정규화된 시계열의 "마지막 측정 버킷 vs 직전 측정 버킷" 차이.
// 이제 시계열(getLiveTrend)이 있으므로 단일 스냅샷이라 null 이던 delta 를 채운다.
// 측정 기준(주/일)과 동일한 버킷을 쓰므로 카드 변화량과 추이 차트가 정합한다.
// null 값(측정 없는 버킷)은 건너뛰고 값이 있는 마지막 두 버킷만 비교 — 2개 미만이면
// delta=null(칩 숨김). 미러에 없는 ⑥⑦은 trend 에 없으니 그대로 null 유지.
export function applyTrendDeltas(
  kpis: KpiSummary[],
  trend: LiveTrend | null,
): KpiSummary[] {
  if (!trend) return kpis;
  const deltaFor = (key: TrendKpiKey): Pick<KpiSummary, "delta" | "direction"> | null => {
    const vals = trend.points
      .map((p) => p.values[key])
      .filter((v): v is number => typeof v === "number");
    if (vals.length < 2) return null;
    const delta = round1(vals[vals.length - 1] - vals[vals.length - 2]);
    // 반올림 후 ±0.05 미만은 flat (방향 칩이 미세 노이즈로 흔들리지 않게).
    const direction = delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat";
    return { delta, direction };
  };
  return kpis.map((k) => {
    const d = deltaFor(k.key as TrendKpiKey);
    return d ? { ...k, ...d } : k;
  });
}

// ─── Sub KPI 엔진별 집계행 ──────────────────────────────────────────────────
// 두 소비처가 같은 집계를 나눠 쓴다:
//   - Core 카드   → applyEngineConsistency (엔진 간 일관성 배지만)
//   - 답변분석>언급 → buildMentionSubKpis (미언급/복수언급/Top3 + 감정 3종)
// 측정 엔진이 2개 미만이면 일관성은 비교 불가라 생략된다.
async function getLiveSubKpisImpl(
  filters?: StandardFilters,
  localProjectId?: string,
): Promise<StandardSubKpis> {
  if (isApiFor(localProjectId)) {
    const ctx = await apiCtx(localProjectId, filters);
    const f = filters ?? {};
    return afterFirstRender(f, ctx, () => loadSubKpis(f, ctx));
  }
  return localProjectId
    ? fetchProjectSubKpis(localProjectId, filters)
    : fetchStandardSubKpis(filters);
}

// ─── 구성 분석 (#21 주제별 / #22 출처별 구성비) view-model ──────────────────
// 둘 다 다범주 분포라 Core 카드 칩이 아닌 별도 미니 도넛 섹션으로 노출(요약).
// 상세는 #21 답변분석·#22 인용분석 화면. 여기선 share(%)까지 계산해 내려준다.
export interface LiveTopicSlice {
  topic: string | null; // funnel_stage (null = 미분류)
  prompts: number;
  share: number; // % of monitored prompts
}
export interface LiveSourceSlice {
  domain: string; // "" = 기타(top-N 밖 합산 버킷)
  citations: number;
  share: number; // % of total citations
  isOurs: boolean;
}
export interface LiveComposition {
  topics: LiveTopicSlice[];
  sources: LiveSourceSlice[];
}

const SOURCE_TOP_N = 7;

// #21 — 주제(funnel_stage)별 프롬프트 구성비. 답변분석 상세 화면도 이 단일 분포를
// 재사용한다(주제 카테고리가 3종뿐이라 도넛이 곧 전체 분포).
async function getLiveTopicCompositionImpl(
  filters?: StandardFilters,
  localProjectId?: string,
): Promise<LiveTopicSlice[]> {
  const topics = localProjectId
    ? await fetchProjectPromptTopics(localProjectId, filters)
    : await fetchStandardPromptTopics(filters);
  const topicTotal = topics.reduce((s, t) => s + t.prompts, 0);
  return topics.map((t) => ({
    topic: t.topic,
    prompts: t.prompts,
    share: topicTotal > 0 ? round1((100 * t.prompts) / topicTotal) : 0,
  }));
}

async function getLiveCompositionImpl(
  filters?: StandardFilters,
  localProjectId?: string,
): Promise<LiveComposition> {
  if (isApiFor(localProjectId)) {
    const ctx = await apiCtx(localProjectId, filters);
    const f = filters ?? {};
    return afterFirstRender(f, ctx, () => loadComposition(f, ctx));
  }
  const [topicSlices, sourceDomains] = await Promise.all([
    getLiveTopicComposition(filters, localProjectId),
    // SLIM 출처 롤업. 전체 CitationsLive 드릴다운은 캐시 한도(2MB)를 넘겨
    // 매 요청 재집계됐다 → 도메인 단위만 가져온다(#20MB 캐시 오류 수정).
    localProjectId
      ? fetchProjectSourceComposition(localProjectId, filters)
      : fetchStandardSourceComposition(filters),
  ]);

  // #22 — 출처(도메인)별 인용 구성비. 상위 N개 + 나머지는 '기타' 버킷으로 접는다
  // (카테고리 분류는 scope backfill 대기라 도메인 기준으로 라이브 산출).
  const domains = [...sourceDomains].sort((a, b) => b.citations - a.citations);
  const head: LiveSourceSlice[] = domains.slice(0, SOURCE_TOP_N).map((d) => ({
    domain: d.domain,
    citations: d.citations,
    share: d.share,
    isOurs: d.isOurs,
  }));
  const rest = domains.slice(SOURCE_TOP_N);
  const restCitations = rest.reduce((s, d) => s + d.citations, 0);
  const sourceSlices =
    restCitations > 0
      ? [
          ...head,
          {
            domain: "",
            citations: restCitations,
            share: round1(rest.reduce((s, d) => s + d.share, 0)),
            isOurs: false,
          },
        ]
      : head;

  return { topics: topicSlices, sources: sourceSlices };
}

// 엔진 간 일관성 = 해당 Core 의 엔진별 값 중 min ÷ max × 100. 유효 엔진(분모>0)이
// 2개 미만이면 null(생략). position 은 평균순위라 그대로 min/max 비율(낮을수록 좋아도
// 비율 자체는 일관성으로 유효).
function consistency(values: number[]): number | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max > 0 ? round1((100 * min) / max) : null;
}

export function applyEngineConsistency(
  kpis: KpiSummary[],
  rows: SubKpiEngineRow[],
): KpiSummary[] {
  // 미러가 비었거나 호출부가 빈 배열을 넘기면 배지 없이 원본 그대로.
  if (!rows || rows.length === 0) return kpis;

  // 엔진(target)별 Core 값 배열 — 분모가 0인 엔진은 값이 없으므로 제외한다.
  const valsOf = (f: (r: SubKpiEngineRow) => number | null): number[] =>
    rows.map(f).filter((v): v is number => v != null);

  const cons: Partial<Record<TrendKpiKey, number | null>> = {
    visibility: consistency(valsOf((r) => (r.answers > 0 ? r.tracked / r.answers : null))),
    shareOfVoice: consistency(
      valsOf((r) => (r.totalMentions > 0 ? r.trackedMentions / r.totalMentions : null)),
    ),
    // ③ 엔진별 값도 카드와 같은 언급 단위 긍정률 (Core ③ 동일 정의).
    sentiment: consistency(
      valsOf((r) => (r.sentMentions > 0 ? r.positiveMentions / r.sentMentions : null)),
    ),
    // 평균순위는 낮을수록 좋지만 min ÷ max 자체는 "엔진끼리 얼마나 붙어 있나"로
    // 그대로 유효하다. 분자는 순위 미진입 답변을 제외한 평균(④ Core 동일 정의).
    position: consistency(valsOf((r) => r.avgPosition)),
    citationShare: consistency(
      valsOf((r) => (r.citTotal > 0 ? r.citOwned / r.citTotal : null)),
    ),
  };

  return kpis.map((k) => {
    const v = cons[k.key as TrendKpiKey];
    // 값이 없는(측정 대기) 카드에는 붙이지 않는다 — 일관성만 덩그러니 남는 걸 방지.
    return v != null && k.value !== null ? { ...k, engineConsistency: v } : k;
  });
}


// ─── 요청단위 dedup 경계 ────────────────────────────────────────────────────
// 대시보드 본문이 섹션별 <Suspense> 로 쪼개지면서 한 렌더 안에서 같은 read 를
// 여러 섹션이 부른다 — ① SUMMARY 는 getLiveDashboard 를, ④ GEO 는 getLiveGeo 를
// 부르고 **getLiveGeo 가 다시 getLiveDashboard 를 참조**한다(빈 상태 판정).
// ② 추이는 getLiveTrend 를 자기 버킷으로 부른다. requestDeduped 는 인자를 정렬
// 직렬화한 문자열 키로 접으므로, 섹션마다 서로 다른 filters 객체 리터럴을
// 넘겨도(참조가 달라도) 값이 같으면 DB 는 한 번만 맞는다.
// 상세 근거: lib/request-dedupe.ts 헤더.
export const getLiveDashboard = requestDeduped("getLiveDashboard", getLiveDashboardImpl);
export const getLiveGeo = requestDeduped("getLiveGeo", getLiveGeoImpl);
export const getLiveTrend = requestDeduped("getLiveTrend", getLiveTrendImpl);
export const getLiveSubKpis = requestDeduped("getLiveSubKpis", getLiveSubKpisImpl);
export const getLiveTopicComposition = requestDeduped(
  "getLiveTopicComposition",
  getLiveTopicCompositionImpl,
);
export const getLiveComposition = requestDeduped("getLiveComposition", getLiveCompositionImpl);
