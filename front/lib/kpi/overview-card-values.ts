import type {
  BucketUnit,
  StandardTrendBucket,
} from "@/lib/db/repositories/scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { DELTA_TREND_WINDOW_DAYS } from "@/lib/scope/kpi-tab-budget";
import { trendGapApplies } from "@/lib/viz/trend-gap";

// ════════════════════════════════════════════════════════════════════════════
// Overview 카드 5종의 **값 정의와 증감 규칙** — 한 곳 (제품 책임자 2026-09-20 후속)
// ════════════════════════════════════════════════════════════════════════════
//
// 제품 책임자 질문 "나머지 카드들도 원천 일치인지?" 의 답을 코드로 만드는 모듈이다.
//
// ── 왜 중립 모듈인가 ────────────────────────────────────────────────────────
//
// 종전에는 이 산식이 `app/[locale]/(dash)/dashboard/_data/live.ts` 의
// `getLiveTrendImpl` 안에 인라인으로만 있었다. 언급 화면이 같은 값을 내려면 그것을
// **옮겨 적어야** 했고, 옮겨 적은 순간 두 벌이 된다(이 트랙이 계속 고쳐 온 형태).
// 그래서 산식을 여기로 올리고 **두 화면이 이 함수를 부른다**.
//
// `server-only` 를 붙이지 않는다 — 언급 화면의 뷰모델(순수 모듈)도 부른다.
//
// ── 증감의 정의 ────────────────────────────────────────────────────────────
//
// Overview 카드의 Δ 는 다섯 지표 **전부** 추이 배열에서 나온다
// (`live.ts::applyTrendDeltas`): 값이 있는 마지막 두 자리의 차, 1자리 반올림.
// 별도 prev 조회가 아니다. 그래서 같은 배열(`fetchStandardTrend` 의 반환)에 같은
// 규칙을 걸면 두 화면의 Δ 가 같은 수가 된다.
//
// ⚠️ **순위(`position`)의 Δ 는 부호 해석이 반대**다(낮을수록 좋음). 이 모듈은 차이만
//    내고 방향 해석은 화면이 한다 — `live.ts::applyTrendDeltas` 도 같은 자세다.

/** Overview 카드 다섯 개의 키. `live.ts::TrendKpiKey` 와 같은 어휘다. */
export type OverviewKpiKey =
  | "visibility"
  | "shareOfVoice"
  | "sentiment"
  | "position"
  | "citationShare";

/**
 * ⑤ 분자 — **⑤ 를 계산하는 소비자는 이 함수로만 읽는다**(제품 책임자 2026-09-29).
 *
 * 글로벌 리더는 `officialHmgCitations`(출처 카테고리 `Official (HMG)` 인용 수 — 인용 탭의
 * 카테고리 차트와 같은 분류)를 싣고, website·project 리더는 싣지 않는다. 그래서:
 *   · 필드가 있으면 → 카테고리 정의(글로벌)
 *   · 없으면        → 종전 base URL 정의(`ownedCitations`, website·project)
 * 정의·판정 근거는 `lib/kpi/official-hmg-citations.ts` 머리 주석.
 *
 * 여기에 두는 이유: 이 모듈은 클라이언트 뷰모델도 부르므로 분류기(public-suffix 스냅샷)를
 * import 하면 안 된다. 분자 **선택**만 여기 있고 **분류**는 서버 리더가 끝내 온다.
 */
export function citationShareNumerator(c: {
  ownedCitations: number;
  officialHmgCitations?: number;
}): number {
  return typeof c.officialHmgCitations === "number" ? c.officialHmgCitations : c.ownedCitations;
}

/** 1자리 반올림 — `live.ts::round1` 과 같은 식. */
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** 1자리 퍼센트 — `live.ts::pct` 와 **같은 식**(분모 0 이면 0). */
const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * 자리 하나의 카드 값들. **값이 없는 지표는 키 자체를 안 만든다**(0 과 결측을 가른다).
 *
 * 이 함수가 `live.ts` 의 `values` 블록 정본이다. 규칙 셋이 그대로 들어 있다:
 *   · 언급 계열 갭(`scope:'all'`)이거나 모수가 0 이면 **아무 값도 없다**.
 *   · 분모가 0 인 지표는 그 지표만 없다(선이 끊긴다, 0% 가 아니다).
 *   · 인용 계열 갭(`scope:'citations'`)이면 값이 남아 있어도 `citationShare` 를
 *     만들지 않는다 — 음영 위에 점이 찍히면 안 된다.
 */
export function overviewTrendValues(
  b: StandardTrendBucket,
): Partial<Record<OverviewKpiKey, number>> {
  if (trendGapApplies(b.gap, "mention") || b.answers === 0) return {};
  const values: Partial<Record<OverviewKpiKey, number>> = {};
  // ① 노출률 — 버킷엔 항상 answers>=1 이므로 분모 안전.
  values.visibility = pct(b.trackedAnswers, b.answers);
  // ② 점유율 — 언급이 없는 버킷은 null (선 끊김).
  if (b.totalMentions > 0) values.shareOfVoice = pct(b.trackedMentions, b.totalMentions);
  // ③ 우호도 — 언급 단위 긍정률. 감정 신호가 있는 버킷만.
  if (b.sentMentions > 0) {
    values.sentiment = round1((100 * b.positiveMentions) / b.sentMentions);
  }
  // ④ 우선 노출도 — 평균 순위 (낮을수록 좋음).
  if (b.avgPosition != null) values.position = b.avgPosition;
  // ⑤ 인용 점유율 — 인용이 있는 버킷만. 인용 계열이 갭이면 값이 남아 있어도 만들지 않는다.
  // 분자는 표면별로 다르다(글로벌 = 공식(HMG) 카테고리) — `citationShareNumerator`.
  if (!trendGapApplies(b.gap, "citation") && b.totalCitations > 0) {
    values.citationShare = pct(citationShareNumerator(b), b.totalCitations);
  }
  return values;
}

/** 자리의 라벨 키 — 축 on 이면 귀속 날짜다(`toStandardTrendBuckets` 가 둘을 같게 만든다). */
const slotKey = (b: StandardTrendBucket): string => b.roundDate ?? b.bucketStart;

export interface OverviewCardDelta {
  /** 마지막 자리 − 직전 자리. 퍼센트포인트(순위는 '위'). */
  delta: number;
  /** 비교 대상 자리의 날짜 — 각주가 "직전 회차({date}) 대비" 로 쓴다. */
  basisDate: string;
}

/**
 * 지표 하나의 **직전 회차 대비 Δ**. 값이 있는 마지막 두 자리를 쓴다
 * (`live.ts::applyTrendDeltas` 와 같은 규칙: `vals.length < 2` 면 `null`).
 *
 * 입력은 `fetchStandardTrend` 가 낸 배열 그대로여야 한다 — 다른 배열을 주면 두 화면의
 * Δ 가 갈린다. 그 계약은 호출부(`server.ts::withOverviewSlots`)가 지킨다.
 */
export function overviewCardDelta(
  slots: readonly StandardTrendBucket[] | undefined,
  key: OverviewKpiKey,
): OverviewCardDelta | null {
  if (!slots?.length) return null;
  const valued: Array<{ v: number; at: string }> = [];
  for (const b of slots) {
    const v = overviewTrendValues(b)[key];
    if (typeof v === "number") valued.push({ v, at: slotKey(b) });
  }
  if (valued.length < 2) return null;
  const last = valued[valued.length - 1];
  const prev = valued[valued.length - 2];
  return { delta: round1(last.v - prev.v), basisDate: prev.at };
}

// ── Δ **입력**의 정본 (2026-09-20 독립 검증 N2) ────────────────────────────
//
// Overview 카드의 Δ 는 화면 추이가 아니라 **Δ 전용 롤업**에서 나온다: `day` 버킷 ·
// 최근 30일(`dashboard/page.tsx` 의 `getLiveTrend(deltaTrendFilters(filters), "day")`).
// 언급 화면이 13자리 주 배열로 Δ 를 내면 **입력이 다르다** — 오늘 같은 수가 나오는 것은
// 집계층이 `unit` 을 무시해 `day` 롤업도 회차 축이 되기 때문이고, 미러로 떨어지면 갈린다.
//
// 그래서 두 화면이 **같은 인자로 같은 함수**를 부르게 한다. 맞추는 방향은 **언급 → Overview**다:
//   · 반대 방향(Overview 를 주 배열로)은 **Overview 카드의 Δ 숫자를 바꾸는 산식 변경**이고,
//     `live.ts` 의 Δ 출처 주석이 그것을 "제품 결정 사항" 으로 명시해 두었다
//     (`live.trend-delta-source.test.ts` 가 현 규칙을 고정한다).
//   · 이쪽 방향은 언급 화면의 Δ 를 Overview 가 이미 쓰는 입력에 맞추는 것이라
//     고객이 보는 Overview 숫자가 움직이지 않는다.
//
// 두 상수·함수를 여기 두는 이유는 산식과 같다: 화면 모듈에 두면 서버가 옮겨 적게 된다.

/** Δ 전용 롤업의 버킷 단위. 정본은 여기다(`live.ts` 가 재수출한다). */
export const DELTA_TREND_BUCKET: BucketUnit = "day";

/**
 * Δ 전용 추이 롤업의 필터. 사용자가 기간을 지정했으면 **그 범위를 그대로** 쓰고
 * (객체도 그대로 — `requestDeduped` 키가 화면 추이와 겹칠 여지를 남긴다),
 * 지정하지 않았으면 최근 30일로 바운드해 전 이력 스캔을 상수화한다.
 * 측정은 주 단위 cadence 라 30일이면 측정 버킷 2개가 안전하게 들어온다.
 */
export function deltaTrendFilters(
  filters: StandardFilters,
  now: number = Date.now(),
): StandardFilters {
  if (filters.dateFrom || filters.dateTo) return filters;
  return {
    ...filters,
    dateFrom: new Date(now - DELTA_TREND_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10),
  };
}
