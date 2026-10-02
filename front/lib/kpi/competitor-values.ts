import type { CompetitorBrandValue } from "@/lib/scope/result-adapter";
import type {
  BrandTrendResult,
  FirstPositionResult,
} from "@/lib/db/repositories/scope-aggregates";

// ════════════════════════════════════════════════════════════════════════════
// 경쟁사 **브랜드별 값과 증감 규칙** — 한 곳 (제품 책임자 2026-09-20 후속)
// ════════════════════════════════════════════════════════════════════════════
//
// `lib/kpi/overview-card-values.ts` 가 **당사 합** 카드에 한 일을 경쟁사 행에 한다.
// 두 지면이 같은 함수를 부른다:
//   · Overview 카드 하단 경쟁사 줄 — `dashboard/_components/overview-kpi-cards.tsx`
//   · 글로벌 답변분석 > 언급 탭 — 히어로 옆 미니 카드 · 경쟁사 분석 표
//     (`standard/answer-analysis/_data/kpi-view.ts::competitorKpiRows`)
//
// 종전에는 값 산식이 `lib/scope/competitor-row.ts` 에, Δ 산식이 화면 컴포넌트
// (`overview-kpi-cards.tsx` 의 `lastTwoDelta`·`competitorDeltas`)에 인라인으로 있었고,
// 언급 화면은 **자기 식을 따로** 갖고 있었다(`competitorKpiRows` 의 삼항식). 같은 지표를
// 세 곳에 적은 상태이고, 실제로 프리뷰에서 값이 갈렸다(2026-09-20 실측: 점유율
// Overview Toyota 6.6 vs 언급 6.1).
//
// `server-only` 를 붙이지 않는다 — 클라이언트 컴포넌트의 뷰모델도 부른다.
//
// ⚠️ 이 모듈은 **직렬화 가능한 값만** 다룬다. `Map` 을 만드는 함수가 하나 있지만
//    (`competitorValueIndex`) 그것은 렌더 시점 파생이고 `unstable_cache` 셀에 들어가지
//    않는다 — 셀 반환값에 `Map` 을 넣으면 첫 로드만 정상이고 HIT 부터 죽는다
//    (2026-09-18 실증).

/**
 * 카드 5종의 키. `lib/kpi/overview-card-values.ts::OverviewKpiKey` 와 **같은 어휘**여야
 * 하고, `competitor-row.test.ts` 가 그것을 단언한다(둘이 갈리면 Δ 가 조용히 빈다).
 */
export type CompetitorMetricKey =
  | "visibility"
  | "shareOfVoice"
  | "sentiment"
  | "position"
  | "citationShare";

/**
 * Δ 를 그리는 지표 — 셋. `citationShare` 는 경쟁사 값이 인용 도메인에서 오고
 * (`competitorCitationShares`), `sentiment` 는 Δ 원천이 없다
 * (`overview-kpi-cards.tsx::competitorDeltas` 가 이 셋만 처리한다).
 *
 * ⚠️ 경쟁사 **우호도 Δ 를 새로 만들지 않는다**(제품 책임자 2026-09-20 지시 ⑤). 값을 더하는 것은
 *    결정 사항이고, 원천은 존재한다 — 회차 축 브랜드 시리즈에 감정 4열이 실려 있다
 *    (`summary_trend_brands.positive/neutral/negative/mixed`). 다만 오늘 `BrandTrendResult`
 *    의 버킷 행(`exposurePct`·`sharePct`)에는 그 열이 안 실려 있어, 켜려면 `toBrandTrend`
 *    가 감정 4열을 버킷에 싣는 변경이 선행돼야 한다.
 */
export const COMPETITOR_DELTA_KEYS: readonly CompetitorMetricKey[] = [
  "visibility",
  "shareOfVoice",
  "position",
];

/** 표기 흔들림(대소문자·앞뒤 공백)까지 접는 브랜드 키 — 중복 행·값 대조의 정본. */
export const brandKey = (b: string): string => b.trim().toLowerCase();

/** 1자리 반올림 — `overview-card-values.ts::round1` 과 같은 식. */
const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * 지표별 경쟁사 값. `null` = 이 지표로는 그릴 수 없는 행(후보에서 빠진다).
 *
 * 입력은 **구조적 상위 타입도 받는다** — `MentionsBrandLive` 는 `CompetitorBrandValue` 의
 * 상위 타입이라 그대로 들어온다. 그래서 미러 행과 사실표 행에 **같은 식**이 걸린다:
 * 언급 화면의 종전 삼항식(`b.mentions > 0 ? (exposure ? b.mentionRate : b.share) : null`)과
 * `visibility`·`shareOfVoice` 가지가 바이트 동일이다(`competitor-values.test.ts` 가 단언).
 */
export function competitorValueOf(
  b: CompetitorBrandValue,
  key: CompetitorMetricKey,
): number | null {
  switch (key) {
    case "visibility":
      return b.mentions > 0 ? b.mentionRate : null;
    case "shareOfVoice":
      return b.mentions > 0 ? b.share : null;
    case "position":
      return b.avgPosition;
    case "sentiment": {
      const s = b.sentiment;
      if (!s) return null;
      const total = s.positive + s.neutral + s.negative + s.mixed;
      return total > 0 ? Math.round((1000 * s.positive) / total) / 10 : null;
    }
    case "citationShare":
      return null;
  }
}

/**
 * 브랜드 이름 → 값 행. 키는 `brandKey` 라 표기 흔들림이 접힌다.
 *
 * 같은 브랜드가 두 행이면 **언급 수가 큰 쪽**이 남는다(`dedupeBrandRows` 와 같은 규칙) —
 * 미러 집계의 브랜드 GROUP BY 가 표시명 문자열 그대로라 `Tesla`/`TESLA` 가 갈릴 수 있다.
 */
export function competitorValueIndex(
  values: readonly CompetitorBrandValue[] | null | undefined,
): ReadonlyMap<string, CompetitorBrandValue> {
  const out = new Map<string, CompetitorBrandValue>();
  if (!values) return out;
  for (const v of values) {
    const k = brandKey(v.brand);
    const cur = out.get(k);
    if (!cur || v.mentions > cur.mentions) out.set(k, v);
  }
  return out;
}

/**
 * 오버레이를 **써도 되는가** — 순수 판정(로그·렌더와 분리해 테스트가 여기부터 본다).
 *
 * ── 규칙 둘 ────────────────────────────────────────────────────────────────
 *
 * ① **한 건도 못 맞추면 포기한다.** 이름 체계가 갈리는 사고(alias·접기 규칙 변경)에서
 *    표가 전부 "—" 로 비는 것을 막는다. 값이 옛것인 편이 표가 사라지는 것보다 낫다.
 *
 * ② **표에 있는 당사 브랜드는 전부 맞아야 한다**(2026-09-20 검증자 N-b). ①만으로는
 *    "경쟁사는 맞고 당사 3사만 빠진" 상태를 못 잡는데, 그때 같은 화면에서
 *    히어로는 사실표 값(53.3)을 그리고 표의 당사 행은 "—" 가 된다 — 한 화면 안에서
 *    같은 지표가 있고 없고가 갈린다. 당사 행은 상한과 무관하게 항상 남으므로
 *    (`competitorKpiRows` 의 `tracked` 우선 규칙) 이 모순은 반드시 보인다.
 *    어기면 오버레이를 **통째로** 포기한다 — 부분 적용은 그 모순을 남긴다.
 *
 * 포기는 조용하면 안 된다. 호출부가 `unmatchedTracked` 를 로그로 남긴다.
 */
export interface CompetitorOverlayDecision {
  /** 오버레이를 적용해도 되는가. `false` 면 호출부는 종전(미러) 값을 그대로 쓴다. */
  usable: boolean;
  /** 리더에서 못 찾은 **당사** 브랜드 이름(표기 그대로). ②를 어긴 목록이다. */
  unmatchedTracked: string[];
  /** 리더와 맞은 행이 하나라도 있는가(①). */
  anyMatched: boolean;
}

export function resolveCompetitorOverlay(
  rows: ReadonlyArray<{ brand: string; isTracked: boolean }>,
  index: ReadonlyMap<string, CompetitorBrandValue>,
): CompetitorOverlayDecision {
  if (index.size === 0) {
    return { usable: false, unmatchedTracked: [], anyMatched: false };
  }
  const anyMatched = rows.some((r) => index.has(brandKey(r.brand)));
  const unmatchedTracked = rows
    .filter((r) => r.isTracked && !index.has(brandKey(r.brand)))
    .map((r) => r.brand);
  return {
    usable: anyMatched && unmatchedTracked.length === 0,
    unmatchedTracked,
    anyMatched,
  };
}

/**
 * 마지막 두 **측정값**의 차(버킷 순서). 값이 둘 미만이면 `null`.
 *
 * `overview-kpi-cards.tsx` 안에 있던 `lastTwoDelta` 를 그대로 옮긴 것이다 — 식도 반올림도
 * 같다(`overview-kpi-cards.delta-parity.test.ts` 가 옛 식과 나란히 돌려 단언한다).
 *
 * ⚠️ 이 규칙은 **null 을 건너뛴다**(값이 있는 마지막 두 점). 언급 화면 경쟁사 표의
 *    `wowPp` 는 **축의 마지막 두 칸**을 보는 다른 규칙이고, 둘을 뭉개지 않는다 —
 *    이유는 `kpi-view.ts::competitorKpiRows` 의 `wowPp` 주석.
 */
export function lastTwoDelta(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return null;
  return round1(v[v.length - 1] - v[v.length - 2]);
}

/**
 * 경쟁사 Δ — **노출률·점유율**은 브랜드 추이 버킷의 마지막 두 값 차.
 * 반환 키는 시리즈에 실제로 있는 브랜드 이름(표기 그대로)이다.
 */
export function competitorTrendDeltas(
  brandTrend: BrandTrendResult | null | undefined,
  key: "visibility" | "shareOfVoice",
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!brandTrend) return out;
  for (const b of brandTrend.brands) {
    const series = brandTrend.buckets.map((bk) => {
      const hit = bk.brands.find((x) => x.brand === b.brand);
      return hit ? (key === "visibility" ? hit.exposurePct : hit.sharePct) : null;
    });
    out.set(b.brand, lastTwoDelta(series));
  }
  return out;
}

/** 경쟁사 Δ — **우선 노출도**는 순위 시계열의 마지막 두 값 차(낮을수록 좋음은 화면 해석). */
export function competitorPositionDeltas(
  firstPosition: FirstPositionResult | null | undefined,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!firstPosition) return out;
  for (const brand of firstPosition.brands) {
    const series = firstPosition.buckets.map(
      (bk) => bk.brands.find((x) => x.brand === brand)?.avgPosition ?? null,
    );
    out.set(brand, lastTwoDelta(series));
  }
  return out;
}
