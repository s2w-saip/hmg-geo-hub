// 추이 KPI 키 → **갭 계열**(0071) — 중립 모듈("server-only"/"use client" 없음).
//
// live.ts 는 `server-only` 라 클라이언트 차트가 런타임 import 를 할 수 없다
// (overview-metrics.ts 머리 주석의 실측: `You're importing a component that needs
// "server-only"`). 그래서 서버(값 계산)와 클라이언트(음영·툴팁)가 **같은 매핑**을
// 봐야 하는 이 표를 별도 중립 모듈로 둔다.
//
// 계열이 왜 필요한가: 숨긴 회차는 계열별 범위를 갖는다(`summary_cycles.hidden_scope`).
// 8/25 글로벌 회차는 **인용만** 깨졌으므로(chatgpt 인용률 3.8% vs 언급 83.8%)
// 인용 KPI 에서만 갭이고, 언급 KPI 에서는 값이 살아 있다. 계약 정본은
// `lib/viz/trend-gap.ts`(`TrendGapScope`·`trendGapApplies`).

import type { TrendGapFamily } from "@/lib/viz/trend-gap";

/**
 * 인용 계열 KPI 키. 나머지(노출률·점유율·우호도·우선 노출도)는 전부 언급 계열이다.
 *
 * 키를 **열거로 좁히지 않고 문자열로 받는** 이유: 이 매핑을 쓰는 곳이
 * `TrendKpiKey`(대시보드 추이)·`OverviewKpiKey`(카드) 두 열거라 어느 한쪽으로
 * 좁히면 다른 쪽 콜사이트가 캐스팅을 하게 된다. 모르는 키는 언급 계열로 접는다 —
 * 인용으로 접으면 새 언급 KPI 가 조용히 음영에 덮인다.
 */
const CITATION_KPI_KEYS: ReadonlySet<string> = new Set([
  "citationShare",
  "citationAccuracy",
]);

export function trendKpiFamily(key: string): TrendGapFamily {
  return CITATION_KPI_KEYS.has(key) ? "citation" : "mention";
}

/**
 * 혼합 차트(한 플롯에 두 계열을 함께 그리는 `LiveTrendChart`)의 계열.
 *
 * 음영(`ReferenceArea`)은 플롯 전체 높이를 덮으므로 "이 슬롯엔 값이 없다"는 주장이다.
 * 언급 라인이 그 슬롯을 **관통해 그려지는데** 음영이 덮이면 화면이 스스로 모순된다.
 * 그래서 **그리는 시리즈가 전부 인용 계열일 때만** 인용으로 본다. 하나라도 언급이
 * 섞이면 언급 계열 — `scope:"citations"` 갭은 음영 없이 값이 그려지고, 인용 라인은
 * 그 슬롯에서 그냥 끊긴다(보간 금지 규약 그대로).
 *
 * 빈 목록은 언급 — 넓게 숨기지 않는 쪽이 기본값이다.
 */
export function mixedTrendGapFamily(keys: Iterable<string>): TrendGapFamily {
  let any = false;
  for (const k of keys) {
    any = true;
    if (trendKpiFamily(k) === "mention") return "mention";
  }
  return any ? "citation" : "mention";
}
