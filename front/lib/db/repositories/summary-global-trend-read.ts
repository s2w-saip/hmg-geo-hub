import "server-only";
import {
  readTrendAggregates,
  type TrendAggregates,
  type TrendAxes,
  type TrendLimits,
  type TrendReadScope,
  type TrendStatementKey,
} from "@/lib/db/repositories/summary-trend-aggregates";
import type {
  BrandTrendResult,
  FirstPositionResult,
  FirstPositionRow,
  StandardTrendBucket,
  BucketUnit,
} from "@/lib/db/repositories/scope-aggregates";
import type { SummaryTrendRead } from "@/lib/db/repositories/summary-global-aggregates";
import { cycleDayOf, type CycleSet } from "@/lib/summary/read/cycle-set";
import { ensureTrendGrid, preCatalogCycleIdsKnown } from "@/lib/period/trend-grid-flag";
import type { TrendGap } from "@/lib/viz/trend-gap";

// ════════════════════════════════════════════════════════════════════════════
// 글로벌 **추이 3종**을 집계층에서 — PR③
// ════════════════════════════════════════════════════════════════════════════
//
// 대상: `fetchStandardTrend`(카드 ①~⑤ 시계열·스파크라인·Δ) ·
//       `fetchStandardKpiBrandTrend`(브랜드 라인/스파크) ·
//       `fetchStandardKpiFirstPosition`(우선노출도 버킷 + 최신 순위표).
// 셋 다 오늘은 **미러 전용**이고, 프로덕션 실측에서 카드·GEO 가 1.30 s 에 도착한 뒤
// 이 셋(extras)이 **37~38 s** 를 더 썼다. 그것이 이 파일이 존재하는 이유다.
//
// ── x축 계약이 바뀐다 (D-4 해제, 제품 책임자 2026-09-11) ──────────────────────────
//
// 미러 추이의 x축은 `date_trunc(unit, measured_at)`(주/일 버킷)이고, 집계층의 유일한
// 시간축은 **회차 anchor**(`cycle_anchor_at`)다. 그래서:
//   · 회차가 없는 주는 **점이 없다**(미러는 빈 주도 버킷을 만들었다).
//     화면의 `fillTrendGaps` 가 그 자리를 값 없는 placeholder 로 채우므로
//     선이 끊겨 "측정 없음" 이 그대로 보인다 — 없던 값을 만들지 않는다.
//   · 한 주에 회차가 둘이면 **대표 회차(`fleet_visible`) 하나만 점이 된다**
//     (2026-09-18 제품 확정 — 종전엔 점이 둘이었고, 906유닛짜리 결손 회차가 단독 점으로
//     서서 Mention 탭 추이와 갈렸다). 거르는 자리는 이 리더가 아니라 회차 집합이다:
//     `lib/summary/read/cycle-set.ts::restrictToFleetVisible`(추이 경로 전용).
//   · `unit = "day"` 는 **집계층 그레인상 불가능하다**. `day` 를 요구하는 자리는
//     대시보드 KPI 카드의 Δ 칩 하나뿐이고(`_data/live.ts::DELTA_TREND_BUCKET`),
//     그 정의는 이제 **"직전 회차 대비"** 다. 이 리더는 `unit` 을 받아 **그대로 되돌려
//     주기만** 한다(반환 타입 호환) — 버킷은 어느 값이든 회차 그레인이다.
//
// ── 켜지는 조건: **회차 ≥ 2** ─────────────────────────────────────────────
//
// 시계열은 점이 둘 이상일 때만 시계열이다. 회차가 하나뿐인 동안 이 경로를 켜면 차트가
// 점 하나가 되고 Δ 는 통째로 사라진다(`applyTrendDeltas` 는 값 2개 미만이면 null).
// 판정은 **호출부**(`lib/scope/server.ts::viaGlobalSeries`)가 한다.
//
// 2026-09-11 실측(F3 정정 — 초판 주석의 "8/31 하나" 는 백필 전 값이라 낡았다):
// `summary_cycles` surface='global' 은 **published 13**행이고, 13주 창(91일) 안에서
// 노출 가능(`view_anchor_at <= now()` + active generation)한 것이 **12회차 · 9주**다.
// 즉 회차 하한은 이미 충족돼 있고, 점화를 막고 있던 것은 회차 수가 아니라 기간 게이트의
// **구멍 판정**이었다(F1) — 같은 창 안 `active_generation_id IS NULL` 5회차가 전부
// `closed` + 분석 갭 > 5% 라 생성기가 영원히 안 뽑는 회차인데 구멍으로 세고 있었다.
//
// ── 읽기는 **2단**이다 (PR③ 플랜 §3-4) ────────────────────────────────────
//
//   [코어]  own `axes.cycle` + domains `axes.cycleDomain`   — 2문장
//           회차별 모수·①②③④ 분자/분모 + ⑤ 분모·분자. `fetchStandardTrend` 는 이것만
//           쓴다. own 회차 축은 같은 문장의 GROUPING SETS 확장이라 **추가 스캔 0**이고,
//           13회차 39k행 ≈40~60 ms 다(플랜 §6-1).
//
//   [브랜드] ① 스냅샷(최신 회차, 축 없음)에서 **시리즈 top-N 을 고르고**
//            ② 그 이름으로만 회차 축(`axes.cycleBrand` + `brandNames`)을 읽는다 — 2문장
//
// 왜 브랜드만 2단인가: 글로벌 `trend_brands` 의 회차 축을 그대로 읽으면 13회차
// **500k~800k행 = 500~800 ms** 다(플랜 §3-4 외삽). 화면이 그리는 것은 시리즈 10개뿐이라
// 먼저 고르고 좁히면 ≈200 ms 로 떨어진다. PR② E2(도메인 top-80 2단)와 같은 패턴이다.
//
// ⚠️ **회차 1개에서는 2단이 손해다**(검증자 GG-6). 실측(2026-09-11, 글로벌 8/31 단일 회차):
//    1단 236.8 ms + 2단 97.2 ms = **334 ms** > 단발(제한 없는 회차축) **277.7 ms**.
//    1단이 회차 수와 무관한 고정비이기 때문이다 — 이득은 **회차 수에 비례**해서 커지고,
//    손익분기는 2회차 부근이다. 지금 라이브가 1회차라 이 경로는 어차피 게이트에서
//    미러로 돌아가므로(회차 <2) 실서빙에 손해가 나가지는 않는다.
//
// ⚠️ 아래 소요 수치는 전부 **회차 1개** 기준이다. `domains`(176.8 ms)·`brands`(236.8 ms)는
//    스캔 행이 회차 수에 **선형**으로 는다 — 13회차 외삽은 그만큼 곱해서 읽어라.
//    "미러 57.2 s → 집계층 0.50 s(113.5배)" 도 같은 조건(1회차)의 A/B 다.
//
// ⚠️ **좁힌 read 의 잔여 행을 분모로 쓰지 마라.** 좁히면 `is_rest` 가 "절단된 꼬리" 가
//    아니라 "고르지 않은 브랜드" 다. 점유율 분모는 코어의 `trend_own.comp_mentions`
//    (회차 축이 있고 브랜드로 좁혀지지 않는다)에서 온다.
//
// 세 화면이 **같은 창**(13주)을 읽고 JS 에서 잘라 쓴다. 창을 화면마다 다르게 잡으면
// 회차 집합이 갈려 read 가 여러 벌이 된다 — extras 가 37~38 s 였던 구조가 그것이다.

/** [코어] 발행 표 — 2개. `answers` 는 안 쓴다(모수가 `trend_own` 에 있다). */
export const G_CORE_STATEMENT_KEYS: readonly TrendStatementKey[] = ["own", "domains"];
/** [코어] 회차 축 2종. */
export const G_CORE_AXES: TrendAxes = { cycle: true, cycleDomain: true };

/** [브랜드] 발행 표 — 1개(두 단 모두). */
export const G_BRAND_STATEMENT_KEYS: readonly TrendStatementKey[] = ["brands"];
/** [브랜드 2단] 회차 축. 1단(스냅샷 top-N 선정)에서는 축을 켜지 않는다. */
export const G_BRAND_AXES: TrendAxes = { cycleBrand: true };

/**
 * **값 상한이 아니라 페이로드 절단**이다 — 리더 코어는 grouping set 을 한 문장에서 함께
 * 내므로 안 쓰는 축의 행도 실려 온다(무필터 글로벌 실측: 도메인 `group` 축 **10,523행**·
 * 브랜드 `country` 축 924행). 잘린 몫은 `is_rest` 한 행으로 합쳐지므로 **총합은 보존**된다.
 *
 *   · `group: 1` · `domain: 1` — 코어가 안 쓰는 두 축을 1행 + 잔여로 접는다.
 *   · `geoBrandPerCountry: 0`  — 국가 축을 **전부** 잔여로(= 이름 행 0개). `null` 이
 *     "절단 없음" 이고 `0` 이 "전부 접기" 다. 헷갈리기 쉬우니 여기 적어 둔다.
 *   · `brand` — 스냅샷 1단은 top-N 선정용이라 넉넉히(200), 2단은 이미 이름으로
 *     좁혀져 있으므로 절단하지 않는다(`null`).
 */
export const G_CORE_LIMITS: TrendLimits = { domain: 1, group: 1, brand: 1, geoBrandPerCountry: 0 };
/** [브랜드 1단] 스냅샷 — 브랜드 축만 쓰고 나머지는 접는다. */
export const G_BRAND_SNAPSHOT_LIMITS: TrendLimits = {
  brand: 200, geoBrandPerCountry: 0, domain: 1, group: 1,
};
/** [브랜드 2단] 이미 이름으로 좁혔으므로 브랜드 축은 자르지 않는다. */
export const G_BRAND_SERIES_LIMITS: TrendLimits = {
  brand: null, geoBrandPerCountry: 0, domain: 1, group: 1,
};

// ── 중간 표현 ───────────────────────────────────────────────────────────────

export interface GlobalTrendBrandPoint {
  /** `null` = 절단 잔여 합계(이름 없음). 시리즈에 그리지 말고 분모에만 쓴다. */
  brand: string | null;
  isTracked: boolean;
  mentions: number;
  /** 그 브랜드가 등장한 답변 수 — 노출률 분자. 브랜드 축을 가로질러 SUM 금지. */
  answers: number;
  /**
   * **본문 텍스트 내 서수**(`first_rank`) 합·개수 — `TrendBrandRow.rankSum` 그대로다.
   * ⚠️ 아래 `compRankSum` 과 **다른 양**이다(0069 / `fold.ts` 머리 주석 3열 표).
   */
  rankSum: number;
  rankedAnswers: number;
  /** 버킷 단위 갭이 정본이다 — 브랜드 포인트에는 같은 값이 그대로 복사된다. */
  gap?: TrendGap;
  /**
   * **답변 안 경쟁 순위** 합·개수(0069) — 카드 ④(`trend_own.rank_sum`)·경쟁사 행
   * (`toCompetitorBrands`)과 **같은 축**. 평균 = `compRankSum / compRankedAnswers`.
   *
   * ⚠️ 0069 미적용(또는 refold 전) DB 에서는 회차 축 문장이 **상수 0** 을 내므로 둘 다 0 이다
   *    (`SYNC_PROBED_COLUMNS` 규약 · `summary-trend-aggregates.ts::compRankColumns`).
   *    그때 평균은 **`null`**(= 빈칸)이어야 한다 — 0 으로 나누지 마라.
   */
  compRankSum: number;
  compRankedAnswers: number;
}

/** 자리 × 엔진 — 사실표 `own` 의 `cycle-engine` 축 행 하나. */
export interface GlobalTrendEnginePoint {
  engine: string;
  monitored: number;
  trackedAnswers: number;
  ownMentions: number;
  compMentions: number;
  ownPositive: number;
  ownSignals: number;
  rankSum: number;
  rankedAnswers: number;
}

export interface GlobalTrendBucket {
  /** 회차 anchor(ISO). 버킷의 정체성이다. */
  anchor: string;
  /** `YYYY-MM-DD` — 화면 버킷 키(`StandardTrendBucket.bucketStart` 와 같은 형식). */
  bucketStart: string;
  monitored: number;
  trackedAnswers: number;
  ownMentions: number;
  compMentions: number;
  ownPositive: number;
  ownSignals: number;
  rankSum: number;
  rankedAnswers: number;
  allCitations: number;
  ownedCitations: number;
  /**
   * 글로벌 ⑤ 분자 — 공식(HMG) 카테고리 인용 수(제품 책임자 2026-09-29). 코어 read 에
   * `officialGroupKeys` 가 실렸을 때만 값이 있다(`undefined` = 계산 안 함 ≠ 0).
   */
  officialHmgCitations?: number;
  /**
   * **수집 오류 회차 표시자**(2026-09-10). 값이 있으면 이 버킷은 수집이 깨진 회차라
   * 화면이 측정값 대신 음영 + 안내 문구를 낸다. 측정값 필드는 전부 `null` 이어야 한다
   * (계약 정본: lib/viz/trend-gap.ts).
   */
  gap?: TrendGap;
  brands: GlobalTrendBrandPoint[];
  /**
   * **엔진 분해**(2026-09-20). `axes.cycle` 이 이미 내는 `(cycle_anchor_at, engine)`
   * grouping set 을 매핑한 것이다 — 문장도 스캔도 늘지 않는다.
   *
   * 자리 합치기(`byDay`)에서는 엔진 이름으로 합산한다(브랜드 점과 같은 규칙).
   */
  engines: GlobalTrendEnginePoint[];
}

export interface GlobalTrendSeries {
  buckets: GlobalTrendBucket[];
  /** 창 전체 브랜드 합계 — 시리즈 cap 선정의 모집단(회차 축과 별개인 `brand` 축). */
  brandTotals: GlobalTrendBrandPoint[];
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const pct1 = (n: number, d: number): number | null => (d > 0 ? round1((100 * n) / d) : null);
const dayOf = (iso: string): string => iso.slice(0, 10);

/** ISO 정규형. 파싱 불가면 원문 그대로 — 여기서 던지지 않는다(종전 `dayOf` 와 같은 자세). */
const isoKey = (v: string): string => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : v;
};

/**
 * 앵커 ISO → **버킷 키이자 x축 라벨 날짜**.
 *
 * ⚠️ 축 on 에서는 **귀속 날짜(`round_date`)** 다(스펙 §9 · 계약 §3). 종전에는 앵커의
 *    **UTC 일**(`dayOf`)이었고, 그래서 카드와 추이가 서로 다른 날을 말했다 —
 *    2026-09-20 제품 책임자 실측: 글로벌 회차 `round_date` 09-14 의 앵커는 `2026-09-13T15:48Z`
 *    라 추이 마지막 점이 **9/13**, 카드 기준일은 **9/14** 였다. merged 자리(같은
 *    `round_date` 에 회차 둘)에서는 두 점이 같은 라벨로 찍히기도 한다.
 *    축 on 에서 키를 귀속 날짜로 두면 그 자리는 **한 점으로 합산**된다(계약 §3).
 *
 * 축은 인자로 받지 않는다 — 회차에 `roundDate` 가 실려 있으면 그것이 곧 앵커 축이다
 * (`cycle-set.ts::cycleSetAsOf` 와 같은 관례). 집합에 없는 앵커(정상 경로 아님)는
 * 종전 키로 떨어진다.
 */
export function trendDayKeyOf(set?: CycleSet): (anchorIso: string) => string {
  const cycles = set?.cycles ?? [];
  if (!cycles.some((c) => Boolean(c.roundDate))) return dayOf;
  // ⚠️ **축이 섞이면 x 격자가 깨진다.** 축 on 집합인데 어떤 회차에만 `roundDate` 가
  //    없으면 그 점만 앵커 날짜로 서서 정규 요일 격자를 벗어나고(글로벌은 월요일,
  //    website 는 금요일), 같은 귀속 자리의 회차와 합산되지도 않는다.
  //    2026-09-20 관찰의 글로벌 `8. 25.`(화) 한 점이 이 모양이다. 값이 틀리는 것이
  //    아니라 **점이 하나 더 서는** 형태라 화면만 봐서는 원인을 못 짚는다 — 그래서
  //    로그로 이름을 남긴다(확인 SQL: `axis-on-sql/23-diag-cycle-round-missing.sql`).
  const missing = cycles.filter((c) => !c.roundDate);
  if (missing.length > 0) {
    console.warn(
      `[trend-axis] round_date-missing-in-anchor-set surface=${set?.surface ?? "?"} ` +
        `cycles=${missing.length}/${cycles.length} ` +
        `ids=${missing.slice(0, 5).map((c) => c.cycleId).join(",")}`,
    );
  }
  const byAnchor = new Map(
    cycles.map((c) => [isoKey(c.cycleAnchorAt), cycleDayOf(c, true)] as const),
  );
  return (iso: string): string => byAnchor.get(isoKey(iso)) ?? dayOf(iso);
}

// ── 읽기 ────────────────────────────────────────────────────────────────────

/**
 * 추이 격자(`X.trendGrid`)가 켜져 있으면 스코프에 `trendGrid: true` 를 얹는다 —
 * 그 한 칸이 `trendWhere` 에서 `in_full_cycle` 게이트를 뺀다(설계 §4-A).
 *
 * **이 파일의 세 read 가 유일한 호출부다.** 카드(`summary-global-aggregates.ts`)·
 * 인용(`summary-citation-read.ts`)·웹사이트(`summary-website-aggregates.ts`)는
 * 이 함수를 부르지 않으므로 스냅샷 모수가 그대로다(설계 §4-2 의 경계).
 *
 * 꺼져 있으면 **입력 객체를 그대로** 돌려준다 — 새 객체를 만들면 참조가 달라져
 * 호출부의 "변한 것이 없다" 판정이 흔들린다(이 리포의 관례).
 */
async function withTrendGrid(scope: TrendReadScope): Promise<TrendReadScope> {
  if (!(await ensureTrendGrid())) return scope;
  return withTrendGridKnown(scope);
}

/**
 * 같은 규칙의 **동기 판본** — 격자 판정이 이미 확정된 자리에서만 쓴다.
 *
 * 왜 노출하는가: 기간 모드의 S1 카드가 추이와 **같은 게이트**를 써야 한다(제품 책임자
 * 2026-09-20 "카드 값 == 상세 값 == 추이의 해당 자리 값"). 카드 리더
 * (`summary-global-aggregates.ts`)는 플래그 모듈을 import 하지 않는 것이 경계이므로
 * (`trend-grid-wiring.test.ts`), 얹는 자리는 게이트(`server.ts::globalS1ScopeOf`)다.
 * 규칙 본문은 여기 한 벌뿐이고 그쪽은 **부르기만** 한다.
 *
 * 호출 전에 `ensureTrendGrid()` 가 await 돼 있어야 한다 — 아니면 `preCatalogCycleIdsKnown()`
 * 이 빈 목록으로 경고를 남긴다(그 계약은 `trend-grid-flag.ts`).
 */
export function withTrendGridKnown(scope: TrendReadScope): TrendReadScope {
  // 카탈로그 도입 전 회차 목록(제품 책임자 2026-09-20 ①)을 같이 싣는다. `ensureTrendGrid()`
  // 가 같은 확정 단위에서 세워 두므로 여기서는 읽기만이고 왕복이 없다.
  const preCatalogCycleIds = preCatalogCycleIdsKnown();
  return preCatalogCycleIds.length
    ? { ...scope, trendGrid: true, preCatalogCycleIds }
    : { ...scope, trendGrid: true };
}

/**
 * [코어] 회차 집합 → 회차별 카드 값. **문장 2개**(own · domains).
 * `fetchStandardTrend` 는 이것만으로 끝난다 — 브랜드 표를 읽지 않는다.
 *
 * `empty` 는 리더 판정(`keyRows`)에 더해 **회차 축 버킷 0개**도 폴백으로 본다 — 축이
 * 안 섰다는 뜻이고, 그때 0 으로 그리면 고객이 "그 기간에 성과가 없었다" 로 읽는다.
 */
export async function readGlobalTrendCore(
  scope: TrendReadScope,
): Promise<SummaryTrendRead<GlobalTrendSeries>> {
  const agg = await readTrendAggregates(
    { ...(await withTrendGrid(scope)), axes: G_CORE_AXES, limits: G_CORE_LIMITS },
    { only: G_CORE_STATEMENT_KEYS },
  );
  if (agg.empty) return { empty: true };
  const series = toSeries(agg, scope.set);
  if (series.buckets.length === 0) return { empty: true };
  return { empty: false, value: series };
}

/**
 * **한 자리(회차)의 group_key 단위 인용 수** — 인용 탭 카테고리 Δ 의 직전 회차 기준점
 * (제품 책임자 2026-09-29: 카테고리 막대 Δ 가 카드 Δ 와 방향이 반대였다 — 기준점이 측정일이었다).
 *
 * 코어 read(`readGlobalTrendCore`)와 **같은 게이트**(`withTrendGrid`)·같은 도메인 문장
 * (인용 계열 회차 스코프)을 탄다. 그래서 여기 합계는 그 자리 추이 버킷의
 * `totalCitations` 와 같다. 카테고리 매핑은 조회 시각 JS 파생이라 `group` 축을 절단 없이
 * 받는다(나머지 축은 1행으로 접는다). 반환은 튜플 배열이다(캐시 셀 직렬화 규약).
 */
export async function readGlobalSlotGroupCitations(
  scope: TrendReadScope,
): Promise<SummaryTrendRead<{ total: number; groups: Array<[string, number]> }>> {
  const agg = await readTrendAggregates(
    {
      ...(await withTrendGrid(scope)),
      limits: { group: null, domain: 1, brand: 1, geoBrandPerCountry: 0 },
    },
    { only: ["domains"] },
  );
  const total = agg.domains.find((r) => r.axis === "total");
  if (!total) return { empty: true };
  const groups: Array<[string, number]> = agg.domains
    .filter((r) => r.axis === "group" && !r.isRest && r.groupKey !== null)
    .map((r) => [r.groupKey as string, r.citations]);
  return { empty: false, value: { total: total.citations, groups } };
}

/**
 * [브랜드 1단] 스냅샷(회차 1개)에서 시리즈 브랜드를 고른다. **문장 1개**.
 *
 * ⚠️ 미러는 cap 정렬 기준을 **창 전체 언급 합**으로 삼는다. 여기는 **최신 회차**다 —
 *    창 전체로 고르려면 13회차 브랜드 축을 통째로 읽어야 하고(500~800 ms) 그것이
 *    바로 2단이 피하려는 비용이다. 실무 효과는 "지금 상위인 브랜드를 그린다" 로,
 *    스파크라인(직전 4회차)의 의도에 오히려 맞는다. **차이는 보고 대상이다.**
 */
export async function readGlobalBrandSnapshot(
  scope: TrendReadScope,
): Promise<SummaryTrendRead<GlobalTrendBrandPoint[]>> {
  // 1단도 같은 게이트로 읽는다 — 여기서 고른 이름으로 2단이 시계열을 읽으므로,
  // 두 단의 모수가 다르면 "시리즈에 없는 브랜드" 나 "빈 라인" 이 생긴다.
  const agg = await readTrendAggregates(
    { ...(await withTrendGrid(scope)), axes: undefined, limits: G_BRAND_SNAPSHOT_LIMITS },
    { only: G_BRAND_STATEMENT_KEYS },
  );
  if (agg.empty) return { empty: true };
  return { empty: false, value: brandPointsOf(agg.brands.filter((r) => r.axis === "brand")) };
}

/**
 * [브랜드 2단] 고른 이름으로만 회차 축을 읽는다. **문장 1개**.
 * 이름이 비면 문장을 발행하지 않는다(빈 시리즈 = 그릴 것이 없다).
 */
export async function readGlobalBrandSeries(
  scope: TrendReadScope,
  brandNames: readonly string[],
): Promise<SummaryTrendRead<Map<string, GlobalTrendBrandPoint[]>>> {
  if (brandNames.length === 0) return { empty: false, value: new Map() };
  const agg = await readTrendAggregates(
    { ...(await withTrendGrid(scope)), axes: G_BRAND_AXES, limits: G_BRAND_SERIES_LIMITS, brandNames },
    { only: G_BRAND_STATEMENT_KEYS },
  );
  if (agg.empty) return { empty: true };
  const byAnchor = new Map<string, GlobalTrendBrandPoint[]>();
  for (const r of agg.brands) {
    if (r.axis !== "cycle-brand" || !r.cycleAnchorAt || r.isRest) continue;
    const list = byAnchor.get(r.cycleAnchorAt) ?? [];
    list.push(brandPointOf(r));
    byAnchor.set(r.cycleAnchorAt, list);
  }
  return { empty: false, value: byAnchor };
}

const brandPointOf = (r: {
  brandName: string | null; isRest: boolean; isTracked: boolean;
  mentions: number; answers: number; rankSum: number; rankedAnswers: number;
  compRankSum: number; compRankedAnswers: number;
}): GlobalTrendBrandPoint => ({
  brand: r.isRest ? null : r.brandName,
  isTracked: r.isTracked,
  mentions: r.mentions,
  answers: r.answers,
  rankSum: r.rankSum,
  rankedAnswers: r.rankedAnswers,
  // 0069 — 회차 축 문장이 함께 싣는다(컬럼 부재면 상수 0). 여기서 나누지 않는다.
  compRankSum: r.compRankSum,
  compRankedAnswers: r.compRankedAnswers,
});

const brandPointsOf = (rows: Parameters<typeof brandPointOf>[0][]): GlobalTrendBrandPoint[] =>
  rows.map(brandPointOf);

/**
 * 같은 UTC 일의 회차 둘을 합칠 때 브랜드 점도 이름으로 합산한다(GG-5).
 * 잔여 행(`brand === null`)은 하나로 합친다 — 이름이 없어 구분할 수 없다.
 */
function mergeBrandPoints(
  a: GlobalTrendBrandPoint[],
  b: GlobalTrendBrandPoint[],
): GlobalTrendBrandPoint[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Map<string, GlobalTrendBrandPoint>();
  for (const p of [...a, ...b]) {
    const k = p.brand ?? "\u0000rest";
    const cur = out.get(k);
    out.set(k, cur
      ? {
          brand: cur.brand,
          isTracked: cur.isTracked || p.isTracked,
          mentions: cur.mentions + p.mentions,
          answers: cur.answers + p.answers,
          rankSum: cur.rankSum + p.rankSum,
          rankedAnswers: cur.rankedAnswers + p.rankedAnswers,
          // 두 축 모두 **분자·분모를 각각 더한 뒤 나눈다**(평균의 평균 금지 — `toSeries` 주석).
          compRankSum: cur.compRankSum + p.compRankSum,
          compRankedAnswers: cur.compRankedAnswers + p.compRankedAnswers,
        }
      : p);
  }
  return [...out.values()];
}

/** 같은 자리의 엔진 점을 이름으로 합산한다(`mergeBrandPoints` 와 같은 규칙). */
function mergeEnginePoints(
  a: GlobalTrendEnginePoint[],
  b: GlobalTrendEnginePoint[],
): GlobalTrendEnginePoint[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Map<string, GlobalTrendEnginePoint>();
  for (const p of [...a, ...b]) {
    const cur = out.get(p.engine);
    out.set(p.engine, cur
      ? {
          engine: cur.engine,
          monitored: cur.monitored + p.monitored,
          trackedAnswers: cur.trackedAnswers + p.trackedAnswers,
          ownMentions: cur.ownMentions + p.ownMentions,
          compMentions: cur.compMentions + p.compMentions,
          ownPositive: cur.ownPositive + p.ownPositive,
          ownSignals: cur.ownSignals + p.ownSignals,
          // 평균은 소비자가 분자·분모를 각각 더한 뒤 나눈다(평균의 평균 금지).
          rankSum: cur.rankSum + p.rankSum,
          rankedAnswers: cur.rankedAnswers + p.rankedAnswers,
        }
      : p);
  }
  return [...out.values()];
}

/**
 * 리더 행 → 버킷 배열(anchor 오름차순). 순수 함수 — 테스트가 여기부터 본다.
 *
 * 브랜드 행은 **선택**이다: 코어 read 는 브랜드 표를 읽지 않으므로 `agg.brands` 가 비어
 * 있고, 그때 버킷의 `brands` 도 빈 배열이다. 브랜드 시계열은 2단 read 가 따로 채운다
 * (`attachBrandSeries`).
 */
export function toSeries(agg: TrendAggregates, set?: CycleSet): GlobalTrendSeries {
  // 버킷 키·라벨의 정본. 축 on = 귀속 날짜, 축 off = 앵커의 UTC 일(종전).
  const dayKey = trendDayKeyOf(set);
  const domByAnchor = new Map(
    agg.domains
      .filter((r) => r.axis === "cycle" && r.cycleAnchorAt)
      .map((r) => [r.cycleAnchorAt as string, r]),
  );
  const brandsByAnchor = new Map<string, GlobalTrendBrandPoint[]>();
  for (const r of agg.brands) {
    if (r.axis !== "cycle-brand" || !r.cycleAnchorAt) continue;
    const list = brandsByAnchor.get(r.cycleAnchorAt) ?? [];
    list.push(brandPointOf(r));
    brandsByAnchor.set(r.cycleAnchorAt, list);
  }
  // 엔진 축 — `axes.cycle` 이 이미 내는 grouping set 이라 **추가 스캔이 없다**.
  // `bucket` 이 그 그룹의 엔진 이름이다(`TrendOwnRow.bucket` 주석).
  //
  // ⚠️ 거르기는 `== null` 이다(2026-09-20 수리). 종전 `!r.bucket` 은 **빈 문자열 엔진**을
  //    같이 버렸다 — 미러에 `engine=''` 인 행이 있으면(엔진 라벨이 안 실린 run) 그 자리의
  //    엔진 분해가 조용히 한 줄 빠지고, 엔진별 라인의 합이 히어로 값과 안 맞는다.
  //    빈 문자열은 "엔진 없음" 이 아니라 **이름이 빈 엔진**이고, 그 구분은 값이 아니라
  //    NULL 이 한다.
  const enginesByAnchor = new Map<string, GlobalTrendEnginePoint[]>();
  for (const r of agg.own) {
    if (r.axis !== "cycle-engine" || !r.cycleAnchorAt || r.bucket == null) continue;
    const list = enginesByAnchor.get(r.cycleAnchorAt) ?? [];
    list.push({
      engine: r.bucket,
      monitored: r.monitored,
      trackedAnswers: r.trackedAnswers,
      ownMentions: r.ownMentions,
      compMentions: r.compMentions,
      ownPositive: r.ownPositive,
      ownSignals: r.ownSignals,
      rankSum: r.rankSum,
      rankedAnswers: r.rankedAnswers,
    });
    enginesByAnchor.set(r.cycleAnchorAt, list);
  }

  // ⚠️ **버킷 키는 anchor 가 아니라 그 anchor 의 UTC 일**이다(검증자 GG-5).
  //    글로벌 게이트에는 `duplicate-cycle-in-week` 규칙이 **의도적으로 없다** — 한 주에
  //    서로 다른 측정 회차가 둘이면 **누적 합산이 정당하기** 때문이다(`cycle-set.ts`).
  //    다만 **추이 점**은 다르다(2026-09-18 제품 확정): 그 둘 중 결손·부분 회차가 단독
  //    점으로 서면 같은 주가 두 값으로 갈린다 — 그래서 추이 경로는 회차 집합 단계에서
  //    대표(`fleet_visible`)만 남긴다(`cycle-set.ts::restrictToFleetVisible`). 이 fold 는
  //    그 **뒤**에 남는 경우를 다룬다: 같은 **UTC 일**에 anchor 가 둘이면(같은 회차의
  //    앵커 보정·패자만 남은 주) 화면 키가 같은 점이 둘 생겨 recharts 가 같은 x 에 두
  //    값을 그린다. 그래서 여기서 **일 단위로 접어 합산**한다 — 비율은 분자·분모를 각각
  //    더한 뒤 나눈다(평균의 평균 금지).
  //    `anchor` 필드는 그 일의 **최소 anchor**(대표값)로 남긴다: 브랜드 2단 결과와
  //    합칠 때(`attachBrandSeries`)의 조인 키가 아니라 표시·coverage 용이다.
  // ⑤ 분자(공식(HMG))가 이 read 에 실렸는가 — 도메인 행 하나라도 값을 가지면 문장이 그
  // 열을 냈다는 뜻이다(`TrendReadScope.officialGroupKeys`). 안 실렸으면 버킷에 필드를 안
  // 만든다(소비자가 종전 정의로 읽는다 — `citationShareNumerator`).
  const hasOfficial = agg.domains.some((r) => typeof r.officialCitations === "number");
  const byDay = new Map<string, GlobalTrendBucket>();
  for (const r of agg.own) {
    if (r.axis !== "cycle" || !r.cycleAnchorAt) continue;
    const anchor = r.cycleAnchorAt;
    const day = dayKey(anchor);
    const dom = domByAnchor.get(anchor);
    const cur = byDay.get(day);
    const add: GlobalTrendBucket = {
      anchor: cur && cur.anchor < anchor ? cur.anchor : anchor,
      bucketStart: day,
      monitored: (cur?.monitored ?? 0) + r.monitored,
      trackedAnswers: (cur?.trackedAnswers ?? 0) + r.trackedAnswers,
      ownMentions: (cur?.ownMentions ?? 0) + r.ownMentions,
      compMentions: (cur?.compMentions ?? 0) + r.compMentions,
      ownPositive: (cur?.ownPositive ?? 0) + r.ownPositive,
      ownSignals: (cur?.ownSignals ?? 0) + r.ownSignals,
      rankSum: (cur?.rankSum ?? 0) + r.rankSum,
      rankedAnswers: (cur?.rankedAnswers ?? 0) + r.rankedAnswers,
      // ⑤ 분모·분자는 **도메인 표**가 정본이다(리더 `ownedCitationsAgg` 주석).
      // 도메인 회차 행이 없으면(그 회차에 인용 0) 0 — 화면이 "인용 없는 버킷" 으로 그린다.
      allCitations: (cur?.allCitations ?? 0) + (dom?.citations ?? 0),
      ownedCitations: (cur?.ownedCitations ?? 0) + (dom?.ownedCitations ?? 0),
      // 같은 자리 합산 규칙(분자·분모를 각각 더한다)을 그대로 따른다.
      ...(hasOfficial
        ? { officialHmgCitations: (cur?.officialHmgCitations ?? 0) + (dom?.officialCitations ?? 0) }
        : {}),
      brands: mergeBrandPoints(cur?.brands ?? [], brandsByAnchor.get(anchor) ?? []),
      // 같은 자리에 anchor 가 둘이면 엔진 점도 이름으로 합산한다(브랜드와 같은 규칙).
      engines: mergeEnginePoints(cur?.engines ?? [], enginesByAnchor.get(anchor) ?? []),
    };
    byDay.set(day, add);
  }
  const buckets = [...byDay.values()].sort((a, b) =>
    a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0);

  return { buckets, brandTotals: brandPointsOf(agg.brands.filter((r) => r.axis === "brand")) };
}

/**
 * 2단 read 결과를 코어 버킷에 얹는다 — 두 read 를 하나의 시계열로 합치는 유일한 지점.
 * `totals`(스냅샷 1단)는 시리즈 선정의 모집단이 된다.
 */
export function attachBrandSeries(
  core: GlobalTrendSeries,
  byAnchor: Map<string, GlobalTrendBrandPoint[]>,
  totals: GlobalTrendBrandPoint[],
  /** 코어 버킷과 **같은 키 함수**를 써야 한다 — 축 on 이면 귀속 날짜다. */
  set?: CycleSet,
): GlobalTrendSeries {
  const dayKey = trendDayKeyOf(set);
  // ⚠️ 조인 키는 **UTC 일**이다(GG-5) — 코어 버킷이 같은 날 anchor 둘을 이미 한 점으로
  //    접었으므로, anchor 로 조인하면 둘 중 하나의 브랜드 행이 통째로 빠진다.
  const byDay = new Map<string, GlobalTrendBrandPoint[]>();
  for (const [anchor, rows] of byAnchor) {
    const day = dayKey(anchor);
    byDay.set(day, mergeBrandPoints(byDay.get(day) ?? [], rows));
  }
  return {
    buckets: core.buckets.map((b) => ({ ...b, brands: byDay.get(b.bucketStart) ?? [] })),
    brandTotals: totals,
  };
}

/** 창 자르기 — 한 read 를 세 화면이 서로 다른 `trendDays` 로 나눠 쓴다. */
export function bucketsSince(
  buckets: GlobalTrendBucket[],
  trendDays: number | undefined,
  now: number = Date.now(),
): GlobalTrendBucket[] {
  if (!trendDays || trendDays <= 0) return buckets;
  const from = new Date(now - trendDays * 86_400_000).toISOString().slice(0, 10);
  return buckets.filter((b) => b.bucketStart >= from);
}

// ── ① `StandardTrendBucket[]` (카드 ①~⑤ 시계열·스파크라인·Δ) ────────────────

/**
 * 미러 `aggregateStandardTrendFromMirror` 와 **같은 반환 타입**. 화면은 경로를 모른다.
 *
 * coverage 3필드의 회차 그레인 대응:
 *   · `measuredDays` — 회차 하나는 "한 번의 측정 회차" 이므로 **1**이다. 미러에서는
 *     그 주에 측정이 일어난 distinct 일수였다. 집계층에 `measured_at` 이 없어 그 수를
 *     복원할 수 없다 — 0 으로 두면 화면이 "측정 없음" 으로 읽으므로 1이 옳다.
 *   · `firstAt`/`lastAt` — 회차 anchor. 미러에서는 그 버킷의 min/max `measured_at`
 *     이었다. 화면은 `lastAt` 을 "마지막 측정 시각" 으로 쓰는데(`LiveTrend.lastMeasuredAt`),
 *     회차 표면에서 그 의미는 **회차 기준일**이다(카드의 `asOf` 와 같은 축).
 */
export function toStandardTrendBuckets(series: GlobalTrendSeries): StandardTrendBucket[] {
  return series.buckets.map((b) => ({
    bucketStart: b.bucketStart,
    // 집계층 경로는 버킷 키가 곧 귀속 날짜다(`trendDayKeyOf`) — 라벨도 그것이다.
    roundDate: b.bucketStart,
    answers: b.monitored,
    trackedAnswers: b.trackedAnswers,
    totalMentions: b.compMentions,
    trackedMentions: b.ownMentions,
    sentMentions: b.ownSignals,
    positiveMentions: b.ownPositive,
    avgPosition: b.rankedAnswers > 0 ? round1(b.rankSum / b.rankedAnswers) : null,
    totalCitations: b.allCitations,
    ownedCitations: b.ownedCitations,
    ...(typeof b.officialHmgCitations === "number"
      ? { officialHmgCitations: b.officialHmgCitations }
      : {}),
    measuredDays: 1,
    firstAt: b.anchor,
    lastAt: b.anchor,
    // 회차 축 신호 — 화면이 `fillTrendGaps` 를 건너뛰게 한다(웹사이트 추이와 같은 계약).
    cycleAnchorAt: b.anchor,
    // 엔진 분해 — 엔진별 라인이 히어로 주 계열과 **같은 배열**을 쓰게 한다.
    // 비면 필드를 싣지 않는다(미러 경로와 바이트 동일).
    ...(b.engines.length
      ? {
          engines: b.engines.map((e) => ({
            engine: e.engine,
            answers: e.monitored,
            trackedAnswers: e.trackedAnswers,
            totalMentions: e.compMentions,
            trackedMentions: e.ownMentions,
            sentMentions: e.ownSignals,
            positiveMentions: e.ownPositive,
            rankSum: e.rankSum,
            rankedAnswers: e.rankedAnswers,
          })),
        }
      : {}),
  }));
}

// ── ② `BrandTrendResult` (브랜드 라인차트·경쟁사 스파크라인) ─────────────────

/** 시리즈 하드 상한 — 미러 `KPI_TAB_MAX_SERIES`(scope-aggregates.ts) 와 같은 값. */
export const G_TREND_MAX_SERIES = 50;

/**
 * 시리즈 브랜드 선정 — 미러 `capBrandSeries` 와 **같은 루프**다(순서까지).
 *
 *   창 전체 언급 내림차순(동률은 이름 오름차순)으로 훑으며
 *   `isTracked || picked.length < cap` 이면 담고, 50개에서 끊는다.
 *
 * 두 가지가 계약이다:
 *   · **당사 우선 보존** — 추적 브랜드는 cap 밖이어도 항상 들어간다("cap 은 비교 대상
 *     상한이지 당사 제외 조건이 아니다").
 *   · **cap 슬롯을 당사도 소비한다** — `picked.length` 가 추적 포함 개수다. "추적을 먼저
 *     다 넣고 나머지를 cap-추적수 만큼" 으로 바꾸면 경쟁사 개수가 달라진다.
 *
 * 잔여 합계 행(`brand === null`)은 시리즈가 될 수 없다 — 이름이 없다(분모에만 쓰인다).
 */
export function pickSeriesBrands(
  totals: GlobalTrendBrandPoint[],
  cap: number,
): Array<{ brand: string; isTracked: boolean; mentions: number }> {
  const ranked = totals
    .filter((b): b is GlobalTrendBrandPoint & { brand: string } => b.brand !== null)
    .sort((a, b) => b.mentions - a.mentions || a.brand.localeCompare(b.brand));
  const picked: Array<{ brand: string; isTracked: boolean; mentions: number }> = [];
  for (const b of ranked) {
    if (b.isTracked || picked.length < cap) {
      picked.push({ brand: b.brand, isTracked: b.isTracked, mentions: b.mentions });
    }
    if (picked.length >= G_TREND_MAX_SERIES) break;
  }
  return picked;
}

/**
 * 창 경계 — 미러 `readWindowBounds` 와 **같은 자세**다: 측정된 버킷의 min/max 가 아니라
 * **요청한 창**이다. 측정 min/max 로 축을 만들면 창 앞뒤의 결측이 통째로 사라져
 * 커버리지 라벨이 "미측정 0" 이라고 거짓 주장한다(미러 주석).
 *
 * ⚠️ 미러는 `date_trunc(unit, …)` 로 주 월요일에 스냅한다. 회차 축에는 스냅할 격자가
 *    없다 — 버킷 키가 회차 anchor 의 UTC 일이므로 경계도 **UTC 일** 그대로 둔다.
 *    그래서 `windowStartBucket` 이 어느 버킷과도 정확히 일치하지 않을 수 있다(정상).
 */
export function windowBounds(
  filters: { dateFrom?: string | null; dateTo?: string | null },
  trendDays: number | undefined,
  now: number = Date.now(),
): { windowStartBucket: string | null; windowEndBucket: string | null } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const floor = trendDays && trendDays > 0 ? day(now - trendDays * 86_400_000) : null;
  const start = filters.dateFrom && floor
    ? (filters.dateFrom > floor ? filters.dateFrom : floor)
    : (filters.dateFrom ?? floor);
  const today = day(now);
  const end = filters.dateTo && filters.dateTo < today ? filters.dateTo : today;
  return { windowStartBucket: start ?? null, windowEndBucket: end };
}

export function toBrandTrend(
  series: GlobalTrendSeries,
  opts: {
    unit: BucketUnit;
    cap: number;
    trendDays?: number;
    now?: number;
    filters?: { dateFrom?: string | null; dateTo?: string | null };
  },
): BrandTrendResult {
  const buckets = bucketsSince(series.buckets, opts.trendDays, opts.now);
  const brands = pickSeriesBrands(series.brandTotals, opts.cap);
  const wanted = new Set(brands.map((b) => b.brand));
  return {
    unit: opts.unit,
    brands,
    ...windowBounds(opts.filters ?? {}, opts.trendDays, opts.now),
    buckets: buckets.map((b) => {
      const byBrand = new Map(
        b.brands.filter((x) => x.brand !== null).map((x) => [x.brand as string, x]),
      );
      return {
        bucketStart: b.bucketStart,
        answers: b.monitored,
        // cap 과 무관한 전 브랜드 언급 합 = 점유율 분모. 절단 잔여를 포함해야 해서
        // 브랜드 행을 더하지 않고 `trend_own.comp_mentions`(② 분모)를 그대로 쓴다.
        totalMentions: b.compMentions,
        measuredDays: 1,
        firstAt: b.anchor,
        lastAt: b.anchor,
        // 시리즈 브랜드마다 1점. 그 회차에 언급이 없으면 0(갭이 아니다 — 미러와 같은 계약).
        brands: [...wanted].map((name) => {
          const hit = byBrand.get(name);
          const mentions = hit?.mentions ?? 0;
          const answers = hit?.answers ?? 0;
          return {
            brand: name,
            isTracked: brands.find((x) => x.brand === name)?.isTracked ?? false,
            mentions,
            answers,
            exposurePct: pct1(answers, b.monitored),
            sharePct: pct1(mentions, b.compMentions),
          };
        }),
      };
    }),
  };
}

// ── ③ `FirstPositionResult` (우선노출도 버킷 + 최신 순위표) ──────────────────

/**
 * `avgPosition` 오름차순 경쟁 순위 — **동률 공동, 다음 순위 건너뜀**(미러 계약).
 * `null`(그 창에 순위 데이터 없음)은 순위도 `null` 이고 정렬 뒤로 간다.
 */
export function rankByPosition(rows: FirstPositionRow[]): FirstPositionRow[] {
  const ranked = rows
    .filter((r) => r.avgPosition !== null)
    .sort((a, b) => (a.avgPosition as number) - (b.avgPosition as number)
      || a.brand.localeCompare(b.brand));
  let lastVal: number | null = null;
  let lastRank = 0;
  ranked.forEach((r, i) => {
    if (lastVal !== null && r.avgPosition === lastVal) r.rank = lastRank;
    else {
      r.rank = i + 1;
      lastRank = i + 1;
      lastVal = r.avgPosition;
    }
  });
  const unranked = rows
    .filter((r) => r.avgPosition === null)
    .sort((a, b) => b.mentions - a.mentions || a.brand.localeCompare(b.brand));
  return [...ranked, ...unranked];
}

/**
 * 우선노출도 축. `"comp"` = 답변 안 경쟁 순위(0069, 카드 ④·미러와 같은 축) ·
 * `"ordinal"` = 본문 텍스트 내 서수(`first_rank`). 정의 대조는 `toFirstPosition` 머리 주석.
 */
export type FirstPositionAxis = "comp" | "ordinal";

/** 그 축의 (합, 개수). 축이 늘면 여기 한 곳만 고친다. */
const positionOf = (
  p: GlobalTrendBrandPoint,
  axis: FirstPositionAxis,
): { sum: number; ranked: number } =>
  axis === "comp"
    ? { sum: p.compRankSum, ranked: p.compRankedAnswers }
    : { sum: p.rankSum, ranked: p.rankedAnswers };

/**
 * 브랜드 점 하나의 평균 순위 + 표본 수. **분모가 0 이면 `null`** 이다 — 0 이 아니다
 * ("0 이면 1위보다 좋은 순위라는 없는 사실이 그려진다", 미러 주석). 0069 미적용·refold
 * 전이면 `"comp"` 축의 분모가 0 이라 이 경로로 빈칸이 된다(0 나눗셈 없음).
 */
function avgPositionOf(
  p: GlobalTrendBrandPoint | undefined,
  axis: FirstPositionAxis,
): { avgPosition: number | null; rankedAnswers: number } {
  if (!p) return { avgPosition: null, rankedAnswers: 0 };
  const { sum, ranked } = positionOf(p, axis);
  return { avgPosition: ranked > 0 ? round1(sum / ranked) : null, rankedAnswers: ranked };
}

/**
 * ── `latest` 의 모집단이 미러와 **구조적으로 다르다** (보고 대상) ─────────────
 *
 * 미러 `latest` 의 모수는 **스냅샷 창**이다 — `detailAnswerWhere`(비-allRuns) =
 * 셀(prompt×target×region)당 최신 답변 1건 + 루트는 `r.started_at >= now()-7d` +
 * full-cycle 게이트. 즉 "지금 열려 있는 최신 측정" 이고, 회차 원장과 무관하다.
 * 집계층에는 그 창이 없다 — 있는 것은 **회차**뿐이다. 그래서 여기서는 `latest` 를
 * **집합의 마지막 회차**로 정의한다. 카드(`fetchStandardAggregates`)가 보는 것이
 * 정확히 그 회차이므로, 순위표와 카드가 같은 모집단을 보게 되는 쪽이 옳다.
 * (미러에서는 둘이 갈릴 수 있었다: 오늘 실측으로 스냅샷 창은 9/8 열린 회차를,
 *  카드는 8/31 published 회차를 본다.)
 *
 * ── `avgPosition` 은 **축을 골라야 한다**(`opts.positionAxis`) ───────────────
 *
 * 두 축이 같은 표에 나란히 있다(0069). 부르는 쪽이 **반드시 고른다** — 기본값을 두면
 * 새 소비자가 조용히 한쪽을 물려받아 같은 화면에서 축이 갈린다(그 결함이 PR④-b F1 이다).
 *
 *   · `"comp"`    — `compRankSum / compRankedAnswers` = **답변 안 경쟁 순위**.
 *     `(job, 표시명)` 의 `min(first_rank)` 위에 `rank()`(동률 공동·다음 건너뜀).
 *     카드 ④(`trend_own.rank_sum`)·경쟁사 행(`toCompetitorBrands`)과 **같은 축**이고,
 *     미러(`scope-aggregates.ts:3326-3331` 의 `pos`→`rk`)도 같은 규칙이다.
 *   · `"ordinal"` — `rankSum / rankedAnswers` = 본문 **텍스트 내 서수**(`first_rank`)의
 *     평균. 그레인이 `(job, brand_id)` 라 같은 표시명에 `brand_id` 가 둘이면(실측 0.29%)
 *     이름으로 먼저 접는 미러와 갈린다. 미러에 이 축은 **없다**.
 *
 * ⚠️ 종전 이 자리에는 "미러는 `(name, job)` 별 `avg(avg_position)` 의 답변 가중 평균"
 *    이라고 적혀 있었다 — **낡았다.** 미러는 2026-09-06 부터 그 min 위에 `rank()` 를
 *    매긴다(같은 파일 3326-3331 주석). 즉 미러와 같은 축은 `"comp"` 쪽이다.
 */
export function toFirstPosition(
  series: GlobalTrendSeries,
  opts: {
    unit: BucketUnit;
    cap: number;
    /** 축 선택: **생략 불가**(위 머리 주석). 경쟁사 행·S1.firstPosition 모두 `"comp"`(2026-09-28). */
    positionAxis: FirstPositionAxis;
    trendDays?: number;
    now?: number;
  },
): FirstPositionResult {
  const { positionAxis: axis } = opts;
  const buckets = bucketsSince(series.buckets, opts.trendDays, opts.now);
  const last = buckets[buckets.length - 1];
  const latestByBrand = new Map(
    (last?.brands ?? [])
      .filter((b): b is GlobalTrendBrandPoint & { brand: string } => b.brand !== null)
      .map((b) => [b.brand, b]),
  );

  // 시리즈 모집단 = **창 전체 합 ∪ 최신 회차 브랜드**(미러와 같은 자세). 최신 회차에만
  // 있는 브랜드도 행을 남겨야 "0위 0%" 가 아니라 "측정 없음(null)" 으로 표기된다.
  const totals = new Map<string, GlobalTrendBrandPoint>();
  for (const b of series.brandTotals) {
    if (b.brand !== null) totals.set(b.brand, b);
  }
  for (const [name, b] of latestByBrand) {
    // 창 밖 브랜드는 **언급 0 으로 등록**한다 — cap 정렬 기준은 창 전체 언급이다(미러).
    if (!totals.has(name)) totals.set(name, { ...b, mentions: 0 });
  }
  const seriesBrands = pickSeriesBrands([...totals.values()], opts.cap);
  const wanted = seriesBrands.map((b) => b.brand);
  const trackedOf = new Map(seriesBrands.map((b) => [b.brand, b.isTracked]));

  const latest = rankByPosition(
    wanted.map((name) => {
      const hit = latestByBrand.get(name);
      const pos = avgPositionOf(hit, axis);
      return {
        brand: name,
        isTracked: trackedOf.get(name) === true,
        avgPosition: pos.avgPosition,
        rank: null,
        // 표본 수도 **그 축의 분모**다 — 값과 n 이 다른 축이면 화면이 못 읽는다.
        rankedAnswers: pos.rankedAnswers,
        mentions: hit?.mentions ?? 0,
      };
    }),
  );

  return {
    unit: opts.unit,
    brands: wanted,
    latest,
    buckets: buckets.map((b) => {
      const byBrand = new Map(
        b.brands.filter((x) => x.brand !== null).map((x) => [x.brand as string, x]),
      );
      return {
        bucketStart: b.bucketStart,
        measuredDays: 1,
        firstAt: b.anchor,
        lastAt: b.anchor,
        brands: wanted.map((name) => {
          // ⚠️ `latest` 와 **같은 축**이어야 한다 — Δ(`competitorDeltas(…, "position")`)는
          //    이 시계열의 마지막 두 점을 빼고, 값은 위 `latest` 에서 온다. 축이 갈리면
          //    같은 행에 "값 4.2 · Δ +4.5"(경쟁 순위 옆 서수 차)가 선다(PR④-b F1).
          const pos = avgPositionOf(byBrand.get(name), axis);
          return {
            brand: name,
            isTracked: trackedOf.get(name) === true,
            avgPosition: pos.avgPosition,
            rankedAnswers: pos.rankedAnswers,
          };
        }),
      };
    }),
  };
}
