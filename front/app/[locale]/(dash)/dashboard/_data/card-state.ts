import type { KpiSummary } from "./sample";

/**
 * 카드 하나의 표시 상태 — 값이 "측정 대기"인지, Δ 를 그릴지 (QA #23·#3). 순수 함수.
 * Overview 카드(overview-kpi-cards)와 웹사이트·프로젝트 타일(summary-tiles)이 같이 쓴다.
 *
 * 두 규칙:
 *  1. `value == null` = 측정 대기 → Δ·스파크라인·경쟁사 행을 전부 숨긴다. 종전에는
 *     값만 "측정 대기"인데 그 아래에 `↘44.4pp`·`↘1.0위` 가 함께 찍혔다.
 *  2. 값이 0 이라도 **모수(ratio.denominator)가 0** 이면 측정된 0 이 아니라 분모
 *     부재다 — live.ts 의 `pct(n, 0) = 0` 이 그대로 카드로 샌 것. ratio 자체가 없는
 *     0 도 같은 취급(buildMirrorKpis 는 분모 0 일 때 ratio 를 안 만든다).
 *     QA 이미지의 `0.0% ↘100.0pp` 는 이 규칙이 잡는다(분모 0 → 측정 대기).
 *
 * 모수가 있는 진짜 0 의 Δ 는 **그대로 둔다** — 답변 120건 중 당사 언급 0 이면 -100pp 는
 * 참값이다. (verifier 2026-09-08: "값 0 & Δ<0 → 숨김" 규칙은 실제 하락을 가리는 데다
 * 카드 창과 추이 창이 정합하면 도달 불가한 죽은 코드라 삭제.)
 */
export function overviewCardState(
  k?: Pick<KpiSummary, "value" | "delta" | "ratio"> | null,
): { value: number | null; pending: boolean; delta: number | null } {
  const value = k?.value ?? null;
  const rawDelta = k?.delta ?? null;
  const denom = k?.ratio?.denominator ?? null;
  if (value == null || (value === 0 && (denom == null || denom === 0))) {
    return { value: null, pending: true, delta: null };
  }
  return { value, pending: false, delta: rawDelta };
}
