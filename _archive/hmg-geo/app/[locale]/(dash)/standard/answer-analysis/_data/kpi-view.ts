// 4-KPI 탭(노출률·점유율)의 view-model — 순수 함수만.
//
// 왜 순수 모듈로 빼는가: 탭 두 개가 **같은 컴포넌트에 metric prop 만 바꿔** 재사용
// 되므로(스펙 SHALL), 분기의 정본이 컴포넌트 JSX 안에 흩어지면 두 탭이 조용히
// 갈라진다. 분기를 여기 한 곳에 모으고 테스트로 고정한다
// (lib/scope/type-breakdown-legend.ts 와 같은 방침).
//
// 값의 출처 규약 (proposal 2026-08-28 "모집단 일치"):
//   - **히어로 스칼라·경쟁사 테이블 값 = 스냅샷**(Sub KPI / MentionsLive) —
//     기존 요약 카드와 같은 창이라 한 화면에서 숫자가 어긋나지 않는다.
//   - **추이·스파크라인 = 회차 집계**(allRuns 창). 마지막 버킷은 재측정 진행 중이면
//     반토막일 수 있어 스칼라로 쓰지 않는다.
// 두 계열을 섞지 않는 것이 이 모듈의 존재 이유다.

import type {
  AnswerStanceDistribution,
  BrandTrendResult,
  BucketUnit,
  EngineKpiTrend,
  FirstPositionResult,
  MentionTypeKey,
  StandardSubKpis,
  TypeKpi,
  TypeSentimentRow,
} from "@/lib/db/repositories/scope-aggregates";
import type { MentionsBrandLive, MentionTypesByBrand } from "@/lib/scope/result-adapter";
import type { MentionSentimentBreakdown } from "@/lib/scope/types";
import type { TrendGap, TrendGapRow } from "@/lib/viz/trend-gap";
import { COLLECTION_ERROR_GAP, TREND_GAP_FIELD, trendGapKeysToMark } from "@/lib/viz/trend-gap";

/** 이 PR 이 지면을 낸 두 KPI. 공용 컴포넌트가 받는 prop 이기도 하다. */
export type KpiMetric = "exposure" | "sov";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 분모 0 → null (0% 와 "측정 없음"을 구분한다 — 스펙 전반의 null 전파 규약). */
export function pctOrNull(num: number, den: number): number | null {
  return den > 0 ? round1((100 * num) / den) : null;
}

// ── 히어로 스칼라 ─────────────────────────────────────────────────────────

export interface KpiHeroValue {
  pct: number | null;
  /** 노출률 = 당사 등장 답변 수 / 점유율 = 당사 브랜드 언급 수 */
  numerator: number;
  /** 노출률 = 모니터링 답변 수 / 점유율 = 전체 브랜드 언급 수 */
  denominator: number;
}

/**
 * 히어로 값 — Sub KPI 엔진 분해행의 합. 요약 카드가 쓰는 것과 같은 스냅샷이라
 * 분모(전체 답변 수 / 전체 언급 수)가 화면 안에서 일치한다.
 *
 * 노출률은 **답변 단위 DISTINCT**(engine 행의 tracked = 당사 1회 이상 등장 답변)라
 * 브랜드별 언급률을 더하는 것과 달리 복수 브랜드 동시 언급을 중복 계상하지 않는다.
 *
 * ⚠️ **여기서 읽는 필드를 늘리면 `KPI_TAB_SUB_KPI_PARTS`(lib/scope/kpi-tab-budget.ts)
 * 도 같이 늘려야 한다.** 서버는 그 표에 적힌 파트의 SQL 문장만 발행하므로
 * (2026-09-02 히어로 31.0s → 부분 계산), 표에 없는 파트의 필드는 0/null 로
 * 내려온다 = 화면이 **조용히 빈다**. kpi-view.test.ts 의 "파트 좁히기 동치성"
 * 테스트가 이 규약을 고정한다.
 */
export function kpiHero(sub: StandardSubKpis | null, metric: KpiMetric): KpiHeroValue {
  const rows = sub?.rows ?? [];
  const sum = (f: (r: StandardSubKpis["rows"][number]) => number) =>
    rows.reduce((s, r) => s + f(r), 0);
  const numerator = metric === "exposure" ? sum((r) => r.tracked) : sum((r) => r.trackedMentions);
  const denominator = metric === "exposure" ? sum((r) => r.answers) : sum((r) => r.totalMentions);
  return { pct: pctOrNull(numerator, denominator), numerator, denominator };
}

/** Δpp — 한쪽이라도 없으면 null(배지 숨김). 퍼센트포인트라 나눗셈이 아니다. */
export function deltaPp(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  return round1(current - previous);
}

/** WoW 증감률(%) — 직전 값이 0이거나 없으면 null. Δpp 와 단위가 다르다. */
export function wowPct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return round1((100 * (current - previous)) / previous);
}

// ── 추이 (히어로 우측 차트) ───────────────────────────────────────────────

export interface KpiTrendPoint {
  bucketStart: string;
  /** null = 그 회차에 측정이 없음. 직전값으로 잇지 않는다(스펙 SHALL). */
  pct: number | null;
  numerator: number | null;
  denominator: number | null;
  /**
   * 툴팁의 WoW — **축에서 바로 앞 버킷** 대비. 앞이 결측이면 null 이다:
   * 갭을 건너뛰고 그 앞 측정과 비교하면 2주 변화를 "WoW"로 이름 붙이게 되고,
   * 결측이 숫자 뒤로 숨는다(보간 금지와 같은 이유).
   */
  numeratorWow: number | null;
  denominatorWow: number | null;
  /** 커버리지 — 측정 없는 버킷은 0/null 로 남아 라벨이 결측을 드러낸다. */
  measuredDays: number;
  firstAt: string | null;
  lastAt: string | null;
  /**
   * 수집 오류 회차(2026-09-10). 값이 있으면 이 슬롯은 **측정값 전부 null** 이고
   * 화면은 음영 + 안내 문구를 낸다. 계약 정본: lib/viz/trend-gap.ts.
   */
  gap?: TrendGap;
}

const DAY_MS = 86_400_000;

/** 버킷 시작일(YYYY-MM-DD)에 unit 만큼 더한 다음 버킷 키. */
export function nextBucketKey(key: string, unit: BucketUnit): string {
  const t = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(t)) return key;
  return new Date(t + (unit === "week" ? 7 : 1) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 측정이 없는 회차를 **명시적 null 점**으로 채운다.
 *
 * 집계는 측정이 있었던 버킷만 내려준다 — 그대로 그리면 결측 구간이 그냥 짧아져
 * 보이고 선은 매끈하게 이어진다(= 보간과 같은 거짓말). 축을 균등하게 채우고
 * 값을 null 로 두면 recharts 가 `connectNulls={false}` 로 선을 끊는다.
 *
 * 폭주 방지 상한은 **갭 하나당** 건다(2026-09-01 verifier 지적 F9). 전역 카운터로
 * 두면 앞쪽의 큰 갭이 예산을 다 쓰고 **뒤쪽 갭이 조용히 안 채워진다** — 그러면
 * 결측이 다시 사라져 이 함수의 목적 자체가 무너진다. 출력 총량은 별도 상한으로 막는다.
 */
const MAX_GAP_FILL_PER_HOLE = 200;
const MAX_TREND_POINTS = 600;

export function fillTrendGaps<T extends { bucketStart: string }>(
  points: T[],
  unit: BucketUnit,
  makeGap: (bucketStart: string) => T,
): T[] {
  if (points.length < 2) return points;
  const out: T[] = [];
  for (let i = 0; i < points.length; i++) {
    out.push(points[i]);
    const next = points[i + 1];
    if (!next) break;
    let k = nextBucketKey(points[i].bucketStart, unit);
    // 갭마다 예산을 새로 준다 — 앞 갭이 뒤 갭의 예산을 빼앗지 않는다.
    let holeGuard = 0;
    while (k < next.bucketStart && holeGuard < MAX_GAP_FILL_PER_HOLE && out.length < MAX_TREND_POINTS) {
      out.push(makeGap(k));
      k = nextBucketKey(k, unit);
      holeGuard++;
    }
  }
  return out;
}

/**
 * 회차 축 — 측정된 버킷 + 채워진 갭. 스파크라인·커버리지가 히어로 추이와 **같은
 * 축**을 쓰게 하는 정본(2026-09-01 verifier 지적 F1: 표만 갭을 삭제해 한 화면에
 * 두 규약이 공존했다).
 */
export interface TrendAxisEntry {
  bucketStart: string;
  /** false = 그 회차에 측정 자체가 없었다(갭). */
  measured: boolean;
}

/**
 * 축을 **창 경계까지** 넓힌다.
 *
 * `fillTrendGaps` 만 쓰면 측정된 버킷 **사이만** 채우므로 축이 첫/마지막 측정에
 * 갇힌다 — 창 앞뒤의 결측이 통째로 사라지고 커버리지가 "미측정 0"이라고 거짓을
 * 말한다(2026-09-01 재검증 C3). 특히 **최신 회차 결측 = 측정이 멈춤**은 운영
 * 지면이 반드시 드러내야 하는 신호다.
 *
 * 경계는 집계가 DB 에서 잘라 온 값(`windowStartBucket`/`windowEndBucket`)이다 —
 * JS 로 `now()` 를 계산하면 서버·DB 타임존이 갈리는 순간 축이 한 칸 밀린다.
 * 경계가 없으면(구 캐시 엔트리 등) 종전처럼 측정 구간만 채운다.
 */
export function trendAxis(
  buckets: Array<{ bucketStart: string }>,
  unit: BucketUnit,
  bounds?: { windowStartBucket?: string | null; windowEndBucket?: string | null },
): TrendAxisEntry[] {
  const measured: TrendAxisEntry[] = buckets.map((b) => ({
    bucketStart: b.bucketStart,
    measured: true,
  }));

  // 창 경계를 "측정된 것처럼" 넣으면 안 된다 — 앵커로만 세우고 measured=false 로
  // 시작한 뒤, 실제 측정이 같은 버킷이면 그것으로 덮는다.
  const anchors: TrendAxisEntry[] = [];
  const start = bounds?.windowStartBucket ?? null;
  const end = bounds?.windowEndBucket ?? null;
  if (start && (measured.length === 0 || start < measured[0].bucketStart)) {
    anchors.push({ bucketStart: start, measured: false });
  }
  if (end && (measured.length === 0 || end > measured[measured.length - 1].bucketStart)) {
    anchors.push({ bucketStart: end, measured: false });
  }
  const seeded = [...anchors, ...measured].sort((a, b) =>
    a.bucketStart.localeCompare(b.bucketStart),
  );
  // 앵커 두 개가 같은 버킷이면(창이 1회차) 중복 제거.
  const deduped = seeded.filter(
    (e, i) => i === 0 || e.bucketStart !== seeded[i - 1].bucketStart,
  );
  return fillTrendGaps<TrendAxisEntry>(deduped, unit, (bucketStart) => ({
    bucketStart,
    measured: false,
  }));
}

export interface TrendCoverage {
  /** 축의 회차 수(갭 포함). */
  cycles: number;
  measuredCycles: number;
  missingCycles: number;
}

export function trendCoverage(axis: TrendAxisEntry[]): TrendCoverage {
  const measuredCycles = axis.filter((a) => a.measured).length;
  return { cycles: axis.length, measuredCycles, missingCycles: axis.length - measuredCycles };
}

/**
 * 숨긴 회차(0070)의 갭 마커를 **축 위에서** 판정한다.
 *
 * 서버는 후보 키 목록만 준다(`TrendGapBucketKeys.gapBuckets`) — 축은 여기서
 * `trendAxis` 가 만들기 때문이다. 판정 규칙 두 개는 `trendGapKeysToMark` 한 벌이 쥔다:
 *   ① 축 **안쪽**만(첫/마지막 점 밖의 갭은 이을 이웃이 없다)
 *   ② 그 슬롯에 측정이 **남아 있지 않을 때만**(다른 회차 측정이 남았으면 구멍이 아니다)
 *
 * 여기서 ②의 입력은 `axis.measured` 다 — 숨긴 회차의 run 이 리더 술어에서 이미 빠졌으므로,
 * 그 주에 버킷이 **남아 있다** = 다른 회차의 측정이 남아 있다는 뜻이다.
 */
export function trendGapMarkSet(
  axis: TrendAxisEntry[],
  gapBuckets: string[] | undefined,
): ReadonlySet<string> {
  if (!gapBuckets?.length) return EMPTY_GAP_MARKS;
  const measured = new Set(axis.filter((a) => a.measured).map((a) => a.bucketStart));
  return trendGapKeysToMark(
    axis.map((a) => a.bucketStart),
    gapBuckets,
    (k) => measured.has(k),
  );
}

const EMPTY_GAP_MARKS: ReadonlySet<string> = new Set<string>();

/**
 * 히어로 추이 — 엔진별 집계를 버킷마다 전 엔진 합산해 당사 노출률/점유율로 접는다.
 * (엔진별 섹션과 같은 집계를 쓰므로 두 차트가 서로 어긋날 수 없다.)
 */
export function kpiTrendPoints(
  trend: EngineKpiTrend | null,
  metric: KpiMetric,
): KpiTrendPoint[] {
  if (!trend) return [];
  const byBucket = new Map(trend.buckets.map((b) => [b.bucketStart, b]));
  // 축은 **창 경계까지**(trendAxis) — 창 앞뒤의 결측이 사라지면 커버리지가
  // "미측정 0"이라고 거짓을 말한다(재검증 C3).
  const axis = trendAxis(trend.buckets, trend.unit, trend);
  const gapMarks = trendGapMarkSet(axis, trend.gapBuckets);
  const points: KpiTrendPoint[] = axis.map((a) => {
    const b = a.measured ? byBucket.get(a.bucketStart) : undefined;
    if (!b) {
      return {
        bucketStart: a.bucketStart,
        pct: null, numerator: null, denominator: null,
        numeratorWow: null, denominatorWow: null,
        measuredDays: 0, firstAt: null, lastAt: null,
        // 갭 슬롯은 이미 값이 전부 null 인 자리다 — 마커만 얹는다(0070).
        ...(gapMarks.has(a.bucketStart) ? { gap: COLLECTION_ERROR_GAP } : {}),
      };
    }
    const numerator = b.engines.reduce(
      (s, e) => s + (metric === "exposure" ? e.trackedAnswers : e.trackedMentions),
      0,
    );
    const denominator = b.engines.reduce(
      (s, e) => s + (metric === "exposure" ? e.answers : e.totalMentions),
      0,
    );
    return {
      bucketStart: b.bucketStart,
      pct: pctOrNull(numerator, denominator),
      numerator,
      denominator,
      numeratorWow: null,
      denominatorWow: null,
      measuredDays: b.measuredDays,
      firstAt: b.firstAt,
      lastAt: b.lastAt,
    };
  });
  // WoW 는 축이 완성된 뒤 계산한다 — 축에서 바로 앞이 결측이면 비교 대상이 없다는
  // 뜻이고, 그 앞의 측정과 비교하면 2주 변화가 "WoW"로 위장된다.
  for (let i = 1; i < points.length; i++) {
    points[i].numeratorWow = wowPct(points[i].numerator, points[i - 1].numerator);
    points[i].denominatorWow = wowPct(points[i].denominator, points[i - 1].denominator);
  }
  return points;
}

/** 커버리지 라벨 — 측정이 실제로 있었던 버킷만(결측은 애초에 항목이 없다). */
export interface CoverageEntry {
  bucketStart: string;
  measuredDays: number;
}
export function coverageEntries(points: KpiTrendPoint[]): CoverageEntry[] {
  return points
    .filter((p) => p.measuredDays > 0)
    .map((p) => ({ bucketStart: p.bucketStart, measuredDays: p.measuredDays }));
}

// ── 경쟁사 KPI 테이블 ─────────────────────────────────────────────────────

export interface CompetitorKpiRow {
  brand: string;
  isTracked: boolean;
  /** 스냅샷 값(%). 언급이 없으면 null — 0% 와 구분. */
  pct: number | null;
  mentions: number;
  /**
   * 직전 N 회차 스파크라인 — **히어로 추이와 같은 축**(갭 포함).
   * 측정 없는 회차는 null 로 남아 선이 끊긴다(스펙 SHALL).
   * 그 브랜드가 추이 시리즈 밖이면 빈 배열 — `inTrendSeries` 로 구분한다.
   */
  spark: (number | null)[];
  /**
   * **축에서 바로 앞 버킷** 대비 pp 차. 앞이 결측이면 null —
   * "직전 회차 대비"라고 이름 붙인 값이 실제로는 2주 변화인 위장을 막는다
   * (kpiTrendPoints 의 WoW 규약과 동일. 2026-09-01 verifier 지적 F1).
   */
  wowPp: number | null;
  /** 당사 합산 대비 pp 차(음수 = 당사보다 낮음). 한쪽이라도 없으면 null. */
  gapPp: number | null;
  /**
   * 추이 시리즈(상위 N + 당사) 안에 있는가. false = **추이를 계산하지 않은 것**이지
   * 측정이 없는 것이 아니다 — 값 열에는 수치가 있는데 추이만 비는 상태를
   * "측정 없음"으로 읽히게 두면 안 된다(2026-09-01 verifier 지적 F5).
   */
  inTrendSeries: boolean;
}

/**
 * 경쟁사 테이블 행 — 값은 스냅샷(MentionsLive.brands), 추이는 회차 집계.
 * 두 소스를 한 행에 놓지만 **열이 다르다**: 값 열은 스냅샷, 추이/증감 열은 회차.
 * (같은 열에 섞으면 재측정 중인 마지막 버킷이 값 열을 흔든다.)
 */
/**
 * 경쟁사 표의 기본 표시 행 상한(**당사 행 포함**).
 *
 * 색 인덱스가 곧 이 배열의 행 인덱스이므로, 시리즈 팔레트는 이 값 이상이어야
 * 한 화면 안에서 순환이 되돌아오지 않는다(검증자 B5 — 팔레트 8색일 때 idx 3·11 이
 * 같은 색을 받아 한 도넛에 같은 녹색 두 조각이 나왔다). `series-colors.test.ts` 가
 * 이 상수와 `SERIES_COLORS.length` 를 묶어 지킨다.
 */
export const COMPETITOR_ROW_LIMIT = 12;

export function competitorKpiRows(input: {
  brands: MentionsBrandLive[];
  trend: BrandTrendResult | null;
  metric: KpiMetric;
  /** 히어로와 같은 당사 합산 값 — Gap 의 기준. */
  ownPct: number | null;
  /** 표시 행 수 상한(당사 행 포함). */
  limit?: number;
}): CompetitorKpiRow[] {
  const { brands, trend, metric, ownPct } = input;
  const limit = Math.max(1, input.limit ?? COMPETITOR_ROW_LIMIT);
  // 히어로 추이와 **같은 축**을 쓴다 — 측정된 버킷만 매핑하면 결측 회차가 통째로
  // 사라져 스파크라인이 매끈해진다(= 직전값 연결과 같은 거짓말).
  const axis = trend ? trendAxis(trend.buckets, trend.unit, trend) : [];
  const byBucket = new Map(trend?.buckets.map((b) => [b.bucketStart, b]) ?? []);
  const seriesBrands = new Set(trend?.brands.map((b) => b.brand) ?? []);
  // 시리즈가 통째로 비었으면 그것은 "cap 밖"이 아니라 **측정이 없는 것**이다 —
  // 모든 행을 "추이 미산출"로 찍으면 원인을 반대로 말하게 된다(재검증 C3).
  const seriesUnknown = seriesBrands.size === 0;

  const sparkOf = (brand: string): (number | null)[] =>
    axis.map((a) => {
      if (!a.measured) return null; // 갭 — 측정 자체가 없었다
      const hit = byBucket.get(a.bucketStart)?.brands.find((x) => x.brand === brand);
      // 시리즈 브랜드는 집계가 버킷마다 점을 주고, 언급이 없으면 0 이다(갭 아님).
      return hit ? (metric === "exposure" ? hit.exposurePct : hit.sharePct) : null;
    });

  const rows = brands.map((b) => {
    const inTrendSeries = seriesUnknown || seriesBrands.has(b.brand);
    const spark = inTrendSeries ? sparkOf(b.brand) : [];
    const pct = b.mentions > 0 ? (metric === "exposure" ? b.mentionRate : b.share) : null;
    return {
      brand: b.brand,
      isTracked: b.isTracked,
      pct,
      mentions: b.mentions,
      spark,
      // 축의 **마지막 두 칸**만 본다. 앞이 갭이면 deltaPp 가 null 을 낸다.
      wowPp: spark.length >= 2 ? deltaPp(spark[spark.length - 1], spark[spark.length - 2]) : null,
      // 당사 행의 Gap 은 자기 자신과의 차라 의미가 없다 → null(표에 "—").
      // 값이 없는(언급 0) 브랜드도 null — 0% 로 계산해 -60.0pp 를 찍으면
      // "측정 없음"이 "당사보다 60pp 낮음"으로 위장된다(verifier 지적 F8).
      gapPp: b.isTracked ? null : deltaPp(pct, ownPct),
      inTrendSeries,
    } satisfies CompetitorKpiRow;
  });

  // 당사 먼저, 그 다음 값 내림차순. 당사는 cap 밖이어도 항상 남긴다 —
  // 비교 기준선이 사라지면 표가 의미를 잃는다(집계의 capBrandSeries 와 같은 규칙).
  const tracked = rows.filter((r) => r.isTracked);
  const others = rows
    .filter((r) => !r.isTracked)
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.brand.localeCompare(b.brand));
  return [...tracked, ...others].slice(0, limit);
}

// ── 히어로 우측 다중 브랜드 추이 (점유율 탭) ─────────────────────────────
//
// 피그마 점유율 화면(327:550)의 히어로 우측은 **브랜드별 점유율(%) 라인**이다.
// 하단의 "주별 상위 브랜드"와 겹쳐 보이지만 지표가 다르다 — 저쪽은 **언급 수
// (절대값)**, 여기는 **점유율(%)**. 캡션이 그 차이를 말한다.
//
// 시리즈 선정·색 배정은 **경쟁사 KPI 테이블과 같은 규칙**을 재사용한다:
// 입력이 `competitorKpiRows` 의 출력(당사 우선 → 값 내림차순)이고, 색 인덱스도
// 그 배열의 위치다. 한 화면에서 같은 브랜드가 다른 색으로 그려지면 안 된다.

export interface BrandTrendSeries {
  brand: string;
  isTracked: boolean;
  /** `brandColor(brand, isTracked, colorIndex)` 에 그대로 넘길 인덱스. */
  colorIndex: number;
}

export interface BrandTrendChartData {
  series: BrandTrendSeries[];
  /**
   * 축 1칸 = 1행. 결측 회차는 브랜드 값이 전부 null 이라 선이 끊긴다.
   * 수집 오류 회차는 거기에 `gap` 마커가 더 붙는다(lib/viz/trend-gap.ts).
   */
  points: Array<TrendGapRow>;
  coverage: CoverageEntry[];
}

/** 한 화면에 겹쳐 읽을 수 있는 라인 수 상한(당사 포함). */
const MAX_BRAND_SERIES = 8;

export function brandTrendChart(
  rows: CompetitorKpiRow[],
  trend: BrandTrendResult | null,
  metric: KpiMetric,
  opts: { maxSeries?: number } = {},
): BrandTrendChartData {
  const empty: BrandTrendChartData = { series: [], points: [], coverage: [] };
  if (!trend || trend.buckets.length === 0) return empty;
  const max = Math.max(1, opts.maxSeries ?? MAX_BRAND_SERIES);
  const inSeries = new Set(trend.brands.map((b) => b.brand));

  // 색 인덱스는 **표의 행 순서**로 고정한다 — 시리즈에서 잘려 나간 브랜드가
  // 뒤 브랜드의 색을 당겨 쓰면 표와 차트가 어긋난다.
  const series: BrandTrendSeries[] = rows
    .map((r, colorIndex) => ({ brand: r.brand, isTracked: r.isTracked, colorIndex }))
    .filter((s) => inSeries.has(s.brand))
    .slice(0, max);
  if (series.length === 0) return empty;

  const byBucket = new Map(trend.buckets.map((b) => [b.bucketStart, b]));
  const axis = trendAxis(trend.buckets, trend.unit, trend);
  const gapMarks = trendGapMarkSet(axis, trend.gapBuckets);
  const points: TrendGapRow[] = axis.map((a) => {
    const bucket = a.measured ? byBucket.get(a.bucketStart) : undefined;
    const row: TrendGapRow = { bucketStart: a.bucketStart };
    for (const s of series) {
      const hit = bucket?.brands.find((x) => x.brand === s.brand);
      // 갭(측정 없음)과 "측정은 있었으나 이 브랜드 언급 0"은 다르다 — 전자만 null.
      row[s.brand] = hit ? (metric === "exposure" ? hit.exposurePct : hit.sharePct) : null;
    }
    // 수집 오류 회차(0070) — 값은 위에서 이미 전부 null 이다(측정 버킷이 없으므로).
    if (gapMarks.has(a.bucketStart)) row[TREND_GAP_FIELD] = COLLECTION_ERROR_GAP;
    return row;
  });

  const coverage = axis
    .filter((a) => a.measured)
    .map((a) => ({
      bucketStart: a.bucketStart,
      measuredDays: byBucket.get(a.bucketStart)?.measuredDays ?? 0,
    }))
    .filter((c) => c.measuredDays > 0);

  return { series, points, coverage };
}

/** 도넛 — 당사 vs 그 외. 합이 100 이 되도록 나머지를 채운다(값이 없으면 빈 배열). */
export function ownShareDonut(ownPct: number | null): { own: number; rest: number } | null {
  if (ownPct == null) return null;
  const own = Math.max(0, Math.min(100, ownPct));
  return { own, rest: round1(100 - own) };
}

// ── AI 엔진별 섹션 ────────────────────────────────────────────────────────

export interface EngineKpiBar {
  engine: string;
  pct: number | null;
  numerator: number;
  denominator: number;
}

/** 좌측 바 — 최신 스칼라(스냅샷 창). 마지막 버킷이 아니다. */
export function engineKpiBars(trend: EngineKpiTrend | null, metric: KpiMetric): EngineKpiBar[] {
  return (trend?.latest ?? []).map((e) => ({
    engine: e.engine,
    pct: metric === "exposure" ? e.exposurePct : e.sovPct,
    numerator: metric === "exposure" ? e.trackedAnswers : e.trackedMentions,
    denominator: metric === "exposure" ? e.answers : e.totalMentions,
  }));
}

/**
 * 우측 시계열 — 엔진마다 한 줄. 측정 없는 회차는 null(선 끊김).
 *
 * 수집 오류 회차(0070)는 거기에 `gap` 마커가 더 붙는다 — 마커가 없으면 화면의
 * `planTrendGaps` 가 `hasGap:false` 를 돌려주고 음영·툴팁·이웃 연결이 **전부**
 * 안 그려진다(2026-09-11 QA: 8/24 자리가 그냥 끊긴 선으로 보이던 원인).
 */
export function engineKpiSeries(
  trend: EngineKpiTrend | null,
  metric: KpiMetric,
): { engines: string[]; points: Array<TrendGapRow> } {
  if (!trend) return { engines: [], points: [] };
  const byBucket = new Map(trend.buckets.map((b) => [b.bucketStart, b]));
  const axis = trendAxis(trend.buckets, trend.unit, trend);
  const gapMarks = trendGapMarkSet(axis, trend.gapBuckets);
  const points = axis.map((a) => {
    const bucket = a.measured ? byBucket.get(a.bucketStart) : undefined;
    const row: TrendGapRow = { bucketStart: a.bucketStart };
    for (const engine of trend.engines) {
      const hit = bucket?.engines.find((e) => e.engine === engine);
      row[engine] = hit ? (metric === "exposure" ? hit.exposurePct : hit.sovPct) : null;
    }
    // 갭 슬롯은 이미 전 엔진이 null 인 자리다 — 마커만 얹는다(값 조작 없음).
    if (gapMarks.has(a.bucketStart)) row[TREND_GAP_FIELD] = COLLECTION_ERROR_GAP;
    return row;
  });
  return { engines: trend.engines, points };
}

// ── 멘션 유형별 섹션 ──────────────────────────────────────────────────────

/** 자사만 / 타사 포함 토글 — 스택바 분모가 바뀐다(스펙 시나리오 "유형별 토글"). */
export type TypeScope = "own" | "all";

export interface TypeKpiBar {
  type: MentionTypeKey;
  /** 당사 값(%). 분모는 scope 에 따라 다르다 — 라벨을 함께 갈아끼울 것. */
  ownPct: number | null;
  /**
   * 선택된 경쟁사 1곳의 구성비(%). 타사 포함 + 경쟁사 선택 시에만 채워진다.
   * 디자인(327:369)의 BMW 세그먼트가 이것이다.
   */
  competitorPct: number | null;
  /** 나머지("기타") 구성비. 자사만 모드에서는 null. */
  otherPct: number | null;
  /**
   * ⚠️ 유형 신호 합이다. mention_count 합("총 언급 수")이 아니라 유형 5종 신호의
   * 합이라, 한 언급이 유형 신호를 여러 개 가지면 중복 계상된다.
   * 화면에서 "언급 수" 라벨로 쓰지 말 것 (집계 jsdoc 제약).
   */
  ownSignals: number;
  competitorSignals: number;
  otherSignals: number;
}

/**
 * 유형별 막대 — 자사만 = 단일 값, **타사 포함 = 100% 구성비 스택**.
 *
 * 디자인 확대본(327:369)의 막대는 `당사 · BMW · 기타` 3분할, 즉 합이 100%인
 * 구성비다. 종전 구현은 "타사 포함"을 *당사 노출률 vs 타사 노출률* 두 값으로
 * 읽어 독립 막대 2줄을 그렸는데, 그 둘은 분모가 **둘 다 전체 답변 수**라 합이
 * 125% 까지 나왔다(2026-09-01 verifier 지적 F4). 의도는 비교가 아니라 분해였다.
 *
 * 그래서 타사 포함의 분모를 **그 유형의 전 브랜드 신호 합**으로 바꾼다. 구성비의
 * 기준량은 **유형 신호 수**뿐이다 — 브랜드별 "그 유형이 있는 답변 수"는 미러에
 * 없고(집계는 당사/비교 두 그룹의 DISTINCT 답변 수만 낸다), 그 둘은 한 답변에
 * 여러 브랜드가 등장하면 서로 겹쳐 더해도 전체가 되지 않는다. 따라서 **노출률
 * 탭에서도 타사 포함 막대는 언급 신호 구성비**이며, 캡션이 그 사실을 말한다.
 *
 * 세그먼트 값은 `typesByBrand`(브랜드별 유형 신호 합, 스냅샷 창 — 경쟁사 표가
 * 쓰는 것과 같은 소스)에서 낸다. `totals` 는 캡 이전 전량이라
 * `기타 = totals − 당사 − 선택 경쟁사` 가 정확하다.
 */
export function typeKpiBars(input: {
  kpi: TypeKpi | null;
  /** 브랜드별 유형 신호 — 없으면 당사/기타 2분할로 폴백(합은 그대로 100%). */
  typesByBrand?: MentionTypesByBrand | null;
  metric: KpiMetric;
  scope: TypeScope;
  /** 상단 "경쟁사 선택" 드롭다운의 값. 전체 선택이면 null. */
  competitor?: string | null;
}): TypeKpiBar[] {
  const { kpi, metric, scope } = input;
  const typesByBrand = input.typesByBrand ?? null;
  const competitor = input.competitor ?? null;
  if (!kpi) return [];

  const empty = { ownPct: null, competitorPct: null, otherPct: null };
  return kpi.rows.map((r) => {
    if (scope === "own") {
      // 자사만 — 종전 그대로. 노출률은 전체 답변 수 분모, 점유율은 당사 신호 합 분모.
      const ownPct =
        metric === "exposure" ? r.ownExposurePct : pctOrNull(r.ownMentions, kpi.ownMentions);
      return {
        type: r.type,
        ...empty,
        ownPct,
        ownSignals: r.ownMentions,
        competitorSignals: 0,
        otherSignals: r.otherMentions,
      };
    }

    // 타사 포함 — 그 유형의 전 브랜드 신호 합을 분모로 하는 100% 구성비.
    const total = typesByBrand ? typesByBrand.totals[r.type] : r.totalMentions;
    const own = typesByBrand
      ? typesByBrand.brands
          .filter((b) => b.isTracked)
          .reduce((s, b) => s + b.types[r.type], 0)
      : r.ownMentions;
    const compHit =
      competitor && typesByBrand
        ? typesByBrand.brands.find((b) => b.brand === competitor && !b.isTracked)
        : undefined;
    const comp = compHit ? compHit.types[r.type] : 0;
    const rest = Math.max(0, total - own - comp);

    if (total <= 0) {
      return {
        type: r.type,
        ...empty,
        ownSignals: own,
        competitorSignals: comp,
        otherSignals: rest,
      };
    }
    const ownPct = pctOrNull(own, total);
    const competitorPct = compHit ? pctOrNull(comp, total) : null;
    // 잔여는 뺄셈으로 낸다 — 각 세그먼트를 따로 반올림하면 합이 100.1 이 된다.
    const otherPct = round1(100 - (ownPct ?? 0) - (competitorPct ?? 0));
    return {
      type: r.type,
      ownPct,
      competitorPct,
      otherPct: Math.max(0, otherPct),
      ownSignals: own,
      competitorSignals: comp,
      otherSignals: rest,
    };
  });
}

/**
 * 유형 섹션 우측 콤보 차트 — 막대=모니터링 답변 수, 선=당사 노출률·점유율.
 * 유형별 시계열은 원자료에 없다(유형 집계는 스냅샷 단일 창) — 여기 선은 **전체**
 * KPI 추이이며 유형 분해가 아니다. 캡션이 그 사실을 말해야 한다.
 */
/**
 * 유형 5종 키 — 클라이언트 번들용 사본. 정본(`MENTION_TYPE_KEYS`)은 server-only 리포지토리에
 * 있어 클라이언트 컴포넌트가 값을 import 하면 빌드가 깨진다(2026-09-02 실증). 타입은
 * 리포지토리의 `MentionTypeKey` 를 그대로 쓰므로 키가 갈리면 여기서 컴파일 에러가 난다.
 */
export const MENTION_TYPE_KEYS_UI: readonly MentionTypeKey[] = [
  "mention",
  "recommendation",
  "comparison",
  "definition",
  "final_choice",
];

export interface TypeComboPoint {
  bucketStart: string;
  answers: number | null;
  exposurePct: number | null;
  sovPct: number | null;
  /** 유형별 노출률(그 유형 신호가 있는 당사 노출 답변 ÷ 답변) — 2026-09-02 D29 유형 칩. */
  byType: Record<MentionTypeKey, number | null>;
  /** 우호도(긍정 ÷ 감정 신호 합) — 피그마 콤보의 우호도 선(운영 결정 Q21). */
  favorabilityPct: number | null;
  /** 당사 평균 등장 순위 — firstPosition 이 주어질 때만(같은 주 버킷 축으로 정렬). */
  avgPosition: number | null;
  /** 수집 오류 회차(0070) — 히어로 추이(`kpiTrendPoints`)가 얹은 마커를 그대로 옮긴다. */
  gap?: TrendGap;
}
export function typeComboPoints(
  trend: EngineKpiTrend | null,
  firstPosition?: FirstPositionResult | null,
): TypeComboPoint[] {
  const exposure = kpiTrendPoints(trend, "exposure");
  const sov = kpiTrendPoints(trend, "sov");
  const typeBy = new Map((trend?.typeTrend ?? []).map((b) => [b.bucketStart, b]));
  const favBy = new Map(
    (trend?.buckets ?? []).map((b) => {
      const sent = b.engines.reduce((s, e) => s + e.sentSignals, 0);
      const pos = b.engines.reduce((s, e) => s + e.positiveSignals, 0);
      return [b.bucketStart, pctOrNull(pos, sent)] as const;
    }),
  );
  const rankBy = new Map<string, number | null>();
  if (firstPosition) {
    for (const b of firstPosition.buckets) {
      rankBy.set(b.bucketStart, ownWeightedPosition(b.brands).pos);
    }
  }
  return exposure.map((p, i) => {
    const tb = p.measuredDays > 0 ? typeBy.get(p.bucketStart) : undefined;
    const byType = Object.fromEntries(
      MENTION_TYPE_KEYS_UI.map((k) => [k, tb ? pctOrNull(tb.byType[k], tb.answers) : null]),
    ) as Record<MentionTypeKey, number | null>;
    return {
      bucketStart: p.bucketStart,
      answers: p.denominator,
      exposurePct: p.pct,
      sovPct: sov[i]?.pct ?? null,
      byType,
      favorabilityPct: p.measuredDays > 0 ? favBy.get(p.bucketStart) ?? null : null,
      avgPosition: p.measuredDays > 0 ? rankBy.get(p.bucketStart) ?? null : null,
      // 마커를 **옮긴다** — 여기서 다시 판정하면 두 차트가 같은 축에서 갈릴 수 있다.
      ...(p.gap ? { gap: p.gap } : {}),
    };
  });
}

/**
 * 엔진별 경쟁사 비교(2026-09-02 D24) — 당사 · 경쟁사 평균 **둘뿐**이다.
 *
 * QA 2차 #6(2026-09-10, 고객): "AI 엔진별 노출 또한 타 영역의 경쟁사 선택과는
 * 별개이며, 당사·경쟁사 평균만 데이터 제공." 종전에는 경쟁사 표의 선택이 여기까지
 * 흘러와 세 번째 막대(`pickedPct`)를 그렸다 — 그 인자·필드를 통째로 걷어냈다.
 * 남기면 다음 사람이 다시 배선한다.
 */
export interface EngineCompetitorBar {
  engine: string;
  ownPct: number | null;
  /** 그 엔진에서 언급이 있는 경쟁 브랜드들의 지표 단순 평균. 경쟁사가 없으면 null. */
  competitorAvgPct: number | null;
  /**
   * 그 평균이 **실제로 더한 브랜드 수**. 정의상 "그 엔진에서 언급>0 인 비추적 브랜드"
   * 지만, 상류(`scope-aggregates` ENGINE_BRAND_TOP_N)가 엔진당 상위 30 으로 자르므로
   * 그 안에서 센 값이다 — 즉 **경쟁사 모수가 아니라 상위 N** 이다.
   *
   * 검증자 B4(2026-09-10): 라이브 경쟁 브랜드는 chatgpt 850 · gemini 1,115 인데
   * 라벨이 `(30개사)` 로 나가 "경쟁사가 30개사"라는 거짓 주장을 만들었다. 라벨은
   * `engine.competitorAvgWithCount` = "경쟁사 평균 (상위 {n}개사)" 로 고정하고,
   * n 은 절단 상수를 복붙하지 않고 **이 필드**(= 평균이 실제로 센 집합의 크기)를 쓴다.
   */
  competitorCount: number;
}
export function engineCompetitorBars(
  trend: EngineKpiTrend | null,
  metric: KpiMetric,
): EngineCompetitorBar[] {
  if (!trend) return [];
  const latestBy = new Map(trend.latest.map((e) => [e.engine, e]));
  const byEngine = new Map<string, typeof trend.latestBrands>();
  for (const b of trend.latestBrands ?? []) {
    const arr = byEngine.get(b.engine) ?? [];
    arr.push(b);
    byEngine.set(b.engine, arr);
  }
  return trend.latest.map((e) => {
    const rows = byEngine.get(e.engine) ?? [];
    const denom = metric === "exposure" ? e.answers : e.totalMentions;
    const pctOf = (r: (typeof rows)[number]) =>
      pctOrNull(metric === "exposure" ? r.answersWithBrand : r.mentions, denom);
    const comps = rows.filter((r) => !r.isTracked && r.mentions > 0);
    const compPcts = comps.map(pctOf).filter((v): v is number => v != null);
    const own = latestBy.get(e.engine);
    return {
      engine: e.engine,
      ownPct: own ? (metric === "exposure" ? own.exposurePct : own.sovPct) : null,
      competitorAvgPct:
        compPcts.length > 0 ? Math.round((compPcts.reduce((s, v) => s + v, 0) / compPcts.length) * 10) / 10 : null,
      competitorCount: compPcts.length,
    };
  });
}

// ── 측정 개요 카드 ────────────────────────────────────────────────────────

/**
 * 답변에만 걸리는 축(지역·엔진·기간). 카탈로그 프롬프트 집합("적용")은 이 축들로
 * 좁혀지지 않고 **측정 유무만** 바뀐다 — 그래서 이 축이 걸린 상태에서 두 수를 빼면
 * "미측정"이 아니라 "이 조건에서는 안 잡힌 것"이 나온다. 카드는 그때 뺄셈을
 * 멈추고 문구를 바꾼다(2026-09-01 verifier 지적 F2).
 */
export function hasAnswerOnlyAxes(f: {
  region?: string[];
  engine?: string[];
  dateFrom?: string;
  dateTo?: string;
}): boolean {
  return Boolean(f.region?.length || f.engine?.length || f.dateFrom || f.dateTo);
}

export interface PromptCoverage {
  /** 프롬프트 축 필터에 걸린 카탈로그 프롬프트 수. */
  applied: number | null;
  /** 그중 실제로 측정된(답변이 있는) 프롬프트 수. */
  measured: number | null;
  /**
   * applied − measured. 한쪽이라도 없거나 **답변 축이 걸려 있으면 null** —
   * 0 으로도, 부풀린 수로도 위장하지 않는다.
   */
  unmeasured: number | null;
  /** true 면 "측정" 칸을 "이 조건에서 측정된 프롬프트"로 읽어야 한다. */
  conditional: boolean;
}

export function promptCoverage(
  applied: number | null | undefined,
  measured: number | null | undefined,
  opts: { conditional?: boolean } = {},
): PromptCoverage {
  const a = typeof applied === "number" ? applied : null;
  const m = typeof measured === "number" ? measured : null;
  const conditional = opts.conditional === true;
  return {
    applied: a,
    measured: m,
    // 카탈로그(적용)와 미러(측정)는 다른 테이블이라 동기화 지연으로 측정 > 적용이
    // 될 수 있다 — 음수 미측정을 내지 않도록 0 으로 클램프한다.
    unmeasured: !conditional && a != null && m != null ? Math.max(0, a - m) : null,
    conditional,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PR ③ — 우호도 · 우선 노출도 탭 (2026-09-02)
//
// 두 탭은 노출률·점유율과 **지표 성질이 다르다**(비율 2종 / 순위). 그래서 metric
// prop 공유가 아니라 자기 뷰모델을 갖되, 값 출처 규약(스칼라 = 스냅샷, 추이 =
// 회차 집계)·갭 규약(직전값 연결 금지)·null 규약(0 과 "측정 없음" 구분)은 위와
// 같다. 축 계산은 `trendAxis` 를 그대로 재사용한다.
// ═══════════════════════════════════════════════════════════════════════════

// ── 우호도 히어로 ────────────────────────────────────────────────────────────

export interface FavorabilityHeroValue {
  /** 긍정 신호 ÷ 전체 감정 신호(P+NE+NG+MX). 분모 0 → null. */
  positivePct: number | null;
  /** 부정 신호 ÷ 전체 감정 신호. */
  negativePct: number | null;
  positive: number;
  negative: number;
  /** 전체 감정 신호 합 — 답변 수가 아니라 **언급 단위 신호 수**다. */
  total: number;
}

/**
 * 우호도 히어로 — Sub KPI `sentiment` 파트(Q3)의 엔진 분해행 합. 대시보드
 * "AI 우호도" 카드와 같은 스냅샷·같은 산식이라 두 화면이 어긋나지 않는다.
 * ⚠️ 서버는 `KPI_TAB_SUB_KPI_PARTS.favorability` 에 적힌 파트만 계산한다 —
 * 여기서 읽는 필드가 늘면 그 표도 같이 늘려야 한다(kpiHero 와 같은 규약).
 */
export function favorabilityHero(sub: StandardSubKpis | null): FavorabilityHeroValue {
  const rows = sub?.rows ?? [];
  const sum = (f: (r: StandardSubKpis["rows"][number]) => number) =>
    rows.reduce((s, r) => s + f(r), 0);
  const total = sum((r) => r.sentMentions);
  const positive = sum((r) => r.positiveMentions);
  const negative = sum((r) => r.negativeMentions);
  return {
    positivePct: pctOrNull(positive, total),
    negativePct: pctOrNull(negative, total),
    positive,
    negative,
    total,
  };
}

// ── 우호도 추이 (히어로 우측) ────────────────────────────────────────────────

export interface FavorabilityTrendPoint {
  bucketStart: string;
  /** null = 그 회차에 측정 없음(갭) 또는 감정 신호 0. */
  positivePct: number | null;
  negativePct: number | null;
  positive: number | null;
  negative: number | null;
  total: number | null;
  /** 툴팁 WoW — 축에서 바로 앞 버킷 대비. 앞이 결측이면 null(kpiTrendPoints 규약). */
  positiveWow: number | null;
  totalWow: number | null;
  measuredDays: number;
  firstAt: string | null;
  lastAt: string | null;
  /** 수집 오류 회차(0070). 붙으면 값은 전부 null 이고 화면이 음영 + 사유를 낸다. */
  gap?: TrendGap;
}

/**
 * 우호도 추이 — 엔진 추이 집계의 버킷을 전 엔진 합산해 긍정·부정 비율로 접는다.
 * 별도 쿼리가 아니라 노출률·점유율 히어로가 쓰는 **같은 집계**(per_job 스캔에 감정
 * 합 3열을 더한 것)라 왕복이 늘지 않고, 결측 회차 축도 그 차트와 같다.
 */
export function favorabilityTrendPoints(trend: EngineKpiTrend | null): FavorabilityTrendPoint[] {
  if (!trend) return [];
  const byBucket = new Map(trend.buckets.map((b) => [b.bucketStart, b]));
  const axis = trendAxis(trend.buckets, trend.unit, trend);
  const gapMarks = trendGapMarkSet(axis, trend.gapBuckets);
  const points: FavorabilityTrendPoint[] = axis.map((a) => {
    const b = a.measured ? byBucket.get(a.bucketStart) : undefined;
    if (!b) {
      return {
        bucketStart: a.bucketStart,
        positivePct: null, negativePct: null, positive: null, negative: null, total: null,
        positiveWow: null, totalWow: null, measuredDays: 0, firstAt: null, lastAt: null,
        // 갭 슬롯은 이미 값이 전부 null 인 자리다 — 마커만 얹는다(kpiTrendPoints 와 동일).
        ...(gapMarks.has(a.bucketStart) ? { gap: COLLECTION_ERROR_GAP } : {}),
      };
    }
    // 구 캐시 셀(감정 열 이전)에는 필드가 없다 — undefined 를 0 으로 세지 않도록 num 폴백.
    const total = b.engines.reduce((s, e) => s + (e.sentSignals ?? 0), 0);
    const positive = b.engines.reduce((s, e) => s + (e.positiveSignals ?? 0), 0);
    const negative = b.engines.reduce((s, e) => s + (e.negativeSignals ?? 0), 0);
    return {
      bucketStart: b.bucketStart,
      positivePct: pctOrNull(positive, total),
      negativePct: pctOrNull(negative, total),
      positive,
      negative,
      total,
      positiveWow: null,
      totalWow: null,
      measuredDays: b.measuredDays,
      firstAt: b.firstAt,
      lastAt: b.lastAt,
    };
  });
  for (let i = 1; i < points.length; i++) {
    points[i].positiveWow = wowPct(points[i].positive, points[i - 1].positive);
    points[i].totalWow = wowPct(points[i].total, points[i - 1].total);
  }
  return points;
}

/** 우호도 추이의 커버리지 라벨 항목 — kpiTrendPoints 용 coverageEntries 와 같은 규칙. */
export function favorabilityCoverage(points: FavorabilityTrendPoint[]): CoverageEntry[] {
  return points
    .filter((p) => p.measuredDays > 0)
    .map((p) => ({ bucketStart: p.bucketStart, measuredDays: p.measuredDays }));
}

// ── 감정 분포 (4분류 스택바) ─────────────────────────────────────────────────

/** 디자인(327:1097) 순서: 긍정 · 중립 · 혼합 · 부정. 신호 드릴다운 키와 동일 문자열. */
export const SENTIMENT_KEYS = ["positive", "neutral", "mixed", "negative"] as const;
export type SentimentKey = (typeof SENTIMENT_KEYS)[number];

export interface SentimentSegment {
  key: SentimentKey;
  count: number;
  /** 전체 신호 합 대비 구성비. 합 0 → null(막대는 비어 있고 값은 "—"). */
  pct: number | null;
}

export function sentimentSegments(totals: MentionSentimentBreakdown | null): SentimentSegment[] {
  if (!totals) return [];
  const sum = SENTIMENT_KEYS.reduce((s, k) => s + totals[k], 0);
  return SENTIMENT_KEYS.map((key) => ({ key, count: totals[key], pct: pctOrNull(totals[key], sum) }));
}

// ── 브랜드 스탠스 분포 (답변 축, 0072) ──────────────────────────────────────
//
// 위 `sentimentSegments` 와 **모양은 같고 단위가 다르다**: 발생 축은 언급 발생마다
// 1 신호(한 답변이 브랜드를 5번 언급하면 5), 답변 축은 (답변 × 브랜드) 1행이다.
// 그래서 두 카드를 **병치**하고 각각 축을 라벨로 말한다 — 한 숫자로 합치지 않는다.
//
// null(집계가 축 자체를 못 낸 상태 = 테이블 미적용·코어 미배포)과 `pairs: 0`(축은
// 있는데 이 필터에 행이 없음)을 **구분한다**. 전자는 "수집 대기", 후자는 "0건"이고
// 화면 문구가 다르다. 발생 감성으로 조용히 대체하는 경로는 어디에도 없다(FR10).
export function stanceSegments(dist: AnswerStanceDistribution | null): SentimentSegment[] {
  if (!dist) return [];
  const sum = SENTIMENT_KEYS.reduce((s, k) => s + dist[k], 0);
  return SENTIMENT_KEYS.map((key) => ({ key, count: dist[key], pct: pctOrNull(dist[key], sum) }));
}

/** 4계열 합 = (답변 × 브랜드) 쌍 수. 집계가 낸 `pairs` 와 일치해야 한다(WU8 AC3). */
export function stancePairs(dist: AnswerStanceDistribution | null): number | null {
  if (!dist) return null;
  return dist.pairs;
}

// ── 멘션 유형별 감정 분포 (유형 × 감정 매트릭스) ───────────────────────────────

export type TypeSentimentScope = "own" | "all";

export interface TypeSentimentRowVM {
  /** "all" = 전체 행(5 유형 합). 디자인(327:1070) 첫 행. */
  type: MentionTypeKey | "all";
  positive: number;
  neutral: number;
  mixed: number;
  negative: number;
  total: number;
  /** 우측 숫자 — 디자이너 주석 "%는 긍정 비율에 대한 지표". */
  positivePct: number | null;
  /** 스택 세그먼트 구성비(합 100). total 0 이면 전부 null. */
  segments: Array<{ key: SentimentKey; pct: number | null; count: number }>;
}

/**
 * 유형 × 감정 — `TypeKpi.sentimentMatrix` 를 화면 행으로. scope=own 이 기본(당사
 * 언급의 감정), all 은 전 브랜드. "전체" 행은 5 유형의 합인데 **유형 신호 합**이므로
 * 한 언급이 여러 유형 신호를 가지면 중복 계상된다 — 감정 분포 카드의 총량과
 * 다를 수 있고, 캡션이 그 사실을 말한다.
 */
export function typeSentimentRows(
  kpi: TypeKpi | null,
  scope: TypeSentimentScope = "own",
): TypeSentimentRowVM[] {
  if (!kpi) return [];
  const rows: TypeSentimentRow[] = kpi.sentimentMatrix[scope] ?? [];
  if (rows.length === 0) return [];
  const toVM = (type: MentionTypeKey | "all", r: Omit<TypeSentimentRow, "type" | "rows">): TypeSentimentRowVM => {
    const total = r.positive + r.neutral + r.mixed + r.negative;
    return {
      type,
      positive: r.positive,
      neutral: r.neutral,
      mixed: r.mixed,
      negative: r.negative,
      total,
      positivePct: pctOrNull(r.positive, total),
      segments: SENTIMENT_KEYS.map((key) => ({ key, count: r[key], pct: pctOrNull(r[key], total) })),
    };
  };
  const all = rows.reduce(
    (acc, r) => ({
      positive: acc.positive + r.positive,
      neutral: acc.neutral + r.neutral,
      mixed: acc.mixed + r.mixed,
      negative: acc.negative + r.negative,
    }),
    { positive: 0, neutral: 0, mixed: 0, negative: 0 },
  );
  return [toVM("all", all), ...rows.map((r) => toVM(r.type, r))];
}

// ── 우선 노출도 히어로 ───────────────────────────────────────────────────────

export interface FirstRankHeroValue {
  /** 당사(추적 브랜드) 가중 평균 등장 순위 — 순위가 매겨진 답변 수로 가중. null = 측정 없음. */
  avgPosition: number | null;
  /** 최신 순위 테이블에서 당사 최상위 브랜드의 경쟁 순위. */
  rank: number | null;
  rankedAnswers: number;
  /**
   * 직전 회차 대비 변화(위). **음수 = 개선**(순위가 앞으로). 축에서 바로 앞 버킷이
   * 결측이면 null — WoW 규약과 동일. 스냅샷(prev Sub KPI)에는 순위 모수가 없어
   * 이 지표만 회차 집계로 Δ 를 낸다(캡션이 "직전 회차 대비"라고 말한다).
   */
  delta: number | null;
  brands: string[];
}

/** 버킷 하나의 당사 가중 평균 순위. 가중치 = rankedAnswers. */
function ownWeightedPosition(
  points: Array<{ isTracked: boolean; avgPosition: number | null; rankedAnswers: number }>,
): { pos: number | null; ranked: number } {
  let wsum = 0;
  let w = 0;
  for (const p of points) {
    if (!p.isTracked || p.avgPosition == null || p.rankedAnswers <= 0) continue;
    wsum += p.avgPosition * p.rankedAnswers;
    w += p.rankedAnswers;
  }
  return { pos: w > 0 ? round1(wsum / w) : null, ranked: w };
}

export function firstRankHero(fp: FirstPositionResult | null): FirstRankHeroValue {
  if (!fp) return { avgPosition: null, rank: null, rankedAnswers: 0, delta: null, brands: [] };
  const own = fp.latest.filter((r) => r.isTracked);
  const { pos, ranked } = ownWeightedPosition(own);
  const rank = own.reduce<number | null>(
    (acc, r) => (r.rank != null && (acc == null || r.rank < acc) ? r.rank : acc),
    null,
  );
  // Δ — 회차 축의 마지막 두 칸. 마지막이 결측이면 비교 대상이 없다(null).
  const series = ownPositionSeries(fp);
  const n = series.length;
  const delta = n >= 2 ? deltaPosition(series[n - 1], series[n - 2]) : null;
  return { avgPosition: pos, rank, rankedAnswers: ranked, delta, brands: own.map((r) => r.brand) };
}

/** 회차 축 위의 당사 가중 평균 순위(갭 = null). */
export function ownPositionSeries(fp: FirstPositionResult): (number | null)[] {
  const axis = trendAxis(fp.buckets, fp.unit);
  const byBucket = new Map(fp.buckets.map((b) => [b.bucketStart, b]));
  return axis.map((a) => {
    const b = a.measured ? byBucket.get(a.bucketStart) : undefined;
    return b ? ownWeightedPosition(b.brands).pos : null;
  });
}

/** 순위 차(위). 한쪽이라도 없으면 null. 반올림 1자리. */
export function deltaPosition(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  return round1(current - previous);
}

// ── 우선 노출도 테이블 · 미니 카드 · 차트 ──────────────────────────────────────

export interface RankTableRow {
  brand: string;
  isTracked: boolean;
  /** 경쟁 순위(동률 공동). null = 이 창에 순위 데이터 없음 → "측정 없음". */
  rank: number | null;
  avgPosition: number | null;
  rankedAnswers: number;
  mentions: number;
  /** 직전 N 회차 평균 순위(갭 = null). 낮을수록 좋다. */
  spark: (number | null)[];
  /** 축의 마지막 두 칸 차(위). 음수 = 개선. */
  wow: number | null;
  /** 시리즈 색 인덱스 — 표·차트·래더가 같은 배열 순서를 쓴다. */
  colorIndex: number;
}

/**
 * 순위 테이블 행 — 값 열은 스냅샷(latest), 추이·WoW 열은 회차 집계. 정렬은 집계가
 * 이미 낸 순서(당사 우선이 아니라 **순위 순** — 순위표의 본질). 색 인덱스는 이
 * 배열 위치로 고정한다.
 */
export function rankTableRows(
  fp: FirstPositionResult | null,
  opts: { sparkCycles?: number } = {},
): RankTableRow[] {
  if (!fp) return [];
  const cycles = Math.max(1, opts.sparkCycles ?? 4);
  const axis = trendAxis(fp.buckets, fp.unit);
  const byBucket = new Map(fp.buckets.map((b) => [b.bucketStart, b]));
  const tail = axis.slice(-cycles);
  return fp.latest.map((r, colorIndex) => {
    const spark = tail.map((a) => {
      const b = a.measured ? byBucket.get(a.bucketStart) : undefined;
      const hit = b?.brands.find((x) => x.brand === r.brand);
      return hit?.avgPosition ?? null;
    });
    return {
      brand: r.brand,
      isTracked: r.isTracked,
      rank: r.rank,
      avgPosition: r.avgPosition,
      rankedAnswers: r.rankedAnswers,
      mentions: r.mentions,
      spark,
      wow: spark.length >= 2 ? deltaPosition(spark[spark.length - 1], spark[spark.length - 2]) : null,
      colorIndex,
    };
  });
}

export interface FirstRankCompetitorCard {
  brand: string;
  rank: number | null;
  avgPosition: number | null;
  wow: number | null;
  colorIndex: number;
}

/** 히어로 좌하단 경쟁사 미니 카드 4장 — 순위 순 상위 경쟁사(당사 제외). */
export function firstRankCompetitorCards(
  rows: RankTableRow[],
  limit = 4,
): FirstRankCompetitorCard[] {
  return rows
    .filter((r) => !r.isTracked && r.rank != null)
    .slice(0, limit)
    .map((r) => ({ brand: r.brand, rank: r.rank, avgPosition: r.avgPosition, wow: r.wow, colorIndex: r.colorIndex }));
}

/** rankTrendChart 포인트의 예약 키 — 당사 순위 답변 수(툴팁). */
export const RANK_TOOLTIP_OWN_RANKED = "__ownRankedAnswers";

export interface RankTrendChartData {
  series: BrandTrendSeries[];
  /** 축 1칸 = 1행. 값 = 평균 순위(낮을수록 좋음). 결측 회차는 전부 null(+`gap`). */
  points: Array<TrendGapRow>;
  coverage: CoverageEntry[];
  /** y축 상한(관측 최대 순위, 최소 5). 디자이너 주석: 구간은 구현이 정한다. */
  yMax: number;
}

const MAX_RANK_SERIES = 8;

/**
 * 순위 시계열 — 표의 행 순서(순위 순)에서 당사 + 상위 경쟁사를 뽑아 라인으로.
 * y축은 화면이 반전한다(1위가 위). 색 인덱스는 표와 같은 배열 위치.
 */
export function rankTrendChart(
  fp: FirstPositionResult | null,
  rows: RankTableRow[],
  opts: { maxSeries?: number } = {},
): RankTrendChartData {
  const empty: RankTrendChartData = { series: [], points: [], coverage: [], yMax: 5 };
  if (!fp || fp.buckets.length === 0) return empty;
  const max = Math.max(1, opts.maxSeries ?? MAX_RANK_SERIES);
  const inSeries = new Set(fp.brands);
  // 당사는 항상 남긴다 — 비교 기준선. 그 다음 순위 순.
  const own = rows.filter((r) => r.isTracked && inSeries.has(r.brand));
  const others = rows.filter((r) => !r.isTracked && inSeries.has(r.brand));
  const picked = [...own, ...others].slice(0, max);
  const series: BrandTrendSeries[] = picked.map((r) => ({
    brand: r.brand,
    isTracked: r.isTracked,
    colorIndex: r.colorIndex,
  }));
  if (series.length === 0) return empty;

  const byBucket = new Map(fp.buckets.map((b) => [b.bucketStart, b]));
  const axis = trendAxis(fp.buckets, fp.unit);
  const gapMarks = trendGapMarkSet(axis, fp.gapBuckets);
  let observedMax = 0;
  const points: TrendGapRow[] = axis.map((a) => {
    const bucket = a.measured ? byBucket.get(a.bucketStart) : undefined;
    const row: TrendGapRow = { bucketStart: a.bucketStart };
    for (const s of series) {
      const hit = bucket?.brands.find((x) => x.brand === s.brand);
      const v = hit?.avgPosition ?? null;
      if (v != null && v > observedMax) observedMax = v;
      row[s.brand] = v;
    }
    // 툴팁용 — 그 회차 당사 순위 답변 수(피그마 327:1140 툴팁 "순위 답변 N개"). 브랜드명과
    // 충돌하지 않는 예약 키. 결측 회차는 null.
    row[RANK_TOOLTIP_OWN_RANKED] = bucket
      ? bucket.brands.filter((b) => b.isTracked).reduce((s, b) => s + (b.rankedAnswers ?? 0), 0)
      : null;
    // 수집 오류 회차(0070) — 값은 위에서 이미 전부 null 이다.
    if (gapMarks.has(a.bucketStart)) row[TREND_GAP_FIELD] = COLLECTION_ERROR_GAP;
    return row;
  });
  const coverage = axis
    .filter((a) => a.measured)
    .map((a) => ({ bucketStart: a.bucketStart, measuredDays: byBucket.get(a.bucketStart)?.measuredDays ?? 0 }))
    .filter((c) => c.measuredDays > 0);
  return { series, points, coverage, yMax: Math.max(5, Math.ceil(observedMax)) };
}

export interface RankLadderMark {
  brand: string;
  isTracked: boolean;
  rank: number | null;
  avgPosition: number;
  /** 트랙 위 위치 0(맨 위=1위)~100. */
  offsetPct: number;
  colorIndex: number;
}

/**
 * 순위별 보기(래더) — 평균 순위를 세로 트랙 위 위치로. **관측 최선(가장 앞 순위)이
 * 맨 위(0%), 관측 최악이 맨 아래(100%)**. 절대 눈금(1위=맨 위)이 아니라 관측 범위로
 * 정규화하는 이유: 실제 평균 순위는 10~20위대에 몰려 있어 절대 눈금이면 마커가
 * 전부 아래쪽 한 뼘에 겹친다. 트랙 양 끝 라벨이 그 두 값을 말한다.
 * 순위 없는 브랜드는 그리지 않는다(위치를 지어낼 수 없다).
 */
export function rankLadder(rows: RankTableRow[]): RankLadderMark[] {
  const ranked = rows.filter((r): r is RankTableRow & { avgPosition: number } => r.avgPosition != null);
  if (ranked.length === 0) return [];
  const min = Math.min(...ranked.map((r) => r.avgPosition));
  const max = Math.max(...ranked.map((r) => r.avgPosition));
  return ranked.map((r) => ({
    brand: r.brand,
    isTracked: r.isTracked,
    rank: r.rank,
    avgPosition: r.avgPosition,
    offsetPct: max > min ? round1((100 * (r.avgPosition - min)) / (max - min)) : 0,
    colorIndex: r.colorIndex,
  }));
}

/** "12.2위" 표기. null → em dash. */
export function positionText(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(1);
}
