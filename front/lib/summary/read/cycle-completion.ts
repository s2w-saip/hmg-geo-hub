// ════════════════════════════════════════════════════════════════════════════
// 회차 완결성 임계 — 추이 자리를 **값으로 낼 것인가 갭으로 낼 것인가** (설계 §4-A)
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: `internal-kb/hmg-geo-trend-single-source-design-2026-09-20.md` §4.
//
// D2 = A 는 두 문장이다. "추이 축에서 `in_full_cycle` 을 미적용" 이 앞이고,
// **"대신 회차 단위 완결성이 임계 미만이면 그 자리를 갭으로"** 가 뒤다. 뒤 문장이
// 없으면 게이트를 뺀 자리가 "부분 측정된 회차의 낮은 값" 을 실값처럼 낸다 —
// 게이트가 하던 일(불완전한 회차를 모수에서 빼기)을 **자리 단위**로 옮기는 것이
// 이 모듈이고, 옮기는 이유는 게이트가 그것을 **프롬프트 단위**로 해서 과거 자리의
// 분모를 깎았기 때문이다(메인 실측 2026-09-20: 08-17 332 → 1,539 = 4.6배 · 08-10 1.7배 ·
// 08-03 1.015배. 초판이 적었던 "1/20" 은 분모가 아니라 셀 수를 인용한 것이다).
//
// 이 파일에 의존성이 없는 것은 의도다 — `cycle-set.ts` 가 이 상수를 import 하므로
// 반대 방향 import 가 생기면 순환이 된다(`analysis-gap.ts` 와 같은 자세).

/**
 * 자리를 값으로 낼 최소 완결성. **0.9**.
 *
 * ── 왜 0.9 인가 (W0 실측, 설계 문서 "확정과 W0 실측") ──────────────────────
 *
 * 글로벌 발행 회차의 `summary_cycles.completion_ratio` 분포는 한 곳에서만 끊긴다:
 *
 *   06-08 **0.499** · 06-15 0.927 · 06-22 0.957 · 06-29 이후 전부 0.9999~1.0
 *
 * 즉 관측된 값은 "절반만 돈 회차 하나" 와 "0.927 이상" 으로 갈린다. 0.9 는 그 틈
 * 가운데이고, 이 임계에서 갭이 되는 자리는 **06-08 하나뿐**이다(0.927·0.957 은 점으로
 * 남는다). 설계가 숫자를 못 박지 않았으므로 여기가 그 값의 정본이다.
 *
 * ⚠️ 이것은 **분석 갭**(`ANALYSIS_GAP_MAX`)과 다른 양이다. 저쪽은 "측정은 됐는데
 *    분석이 안 붙은 비율"(생성기가 그 회차를 뽑느냐)이고, 여기는 "측정 자체가 다
 *    돌았느냐"(`completed_units / expected_units`)다. 둘을 한 상수로 묶지 마라.
 */
export const TREND_COMPLETION_MIN = 0.9;

/**
 * 원장 `summary_cycles.completion_ratio` 를 **유닛 카운터에서 되계산**한다.
 *
 * 왜 컬럼을 안 읽고 되계산하는가: 회차 범위 조회(`pickCyclesInRange`)가 이미
 * `expected_units`·`completed_units` 를 싣고 온다. 원장 정의가
 * `CASE WHEN expected > 0 THEN round(completed::numeric / expected, 5) END`
 * (`summary-cycles.ts::cycleCountersSql`)이고 세 값이 **한 UPDATE 에서 함께** 쓰이므로,
 * 되계산은 컬럼과 같은 값이다(반올림 5자리 차이뿐). 컬럼을 새로 SELECT 하면 축 on
 * 경로에 문장이 하나 바뀌는데, 얻는 것이 반올림 자리뿐이라 그 값을 치르지 않는다.
 *
 * `null` = **모른다**(카운터 미계산 = 유령 회차·집계 전). 모르는 것은 갭이 아니다 —
 * 아래 `slotIsIncomplete` 주석의 손실 비대칭 참고.
 */
export function completionRatioFromUnits(
  expectedUnits: number | null | undefined,
  completedUnits: number | null | undefined,
): number | null {
  if (expectedUnits == null || completedUnits == null) return null;
  if (!(expectedUnits > 0)) return null;
  // **5자리 반올림**은 정밀도가 아니라 **캐시 키** 때문이다(검증 N5). 이 값은
  // `SummaryCyclePick` 에 실려 `mirrorCache` 인자가 되므로, 반올림 없이 실으면
  // `completed_units` 가 하나만 늘어도 **판정이 안 바뀌는 회차의 셀까지** 미스가 된다.
  // 자리는 원장 정의(`summary-cycles.ts::cycleCountersSql` 의 `round(…, 5)`)와 맞춘다 —
  // 임계 0.9 판정은 5자리에서 뒤집히지 않는다.
  return Math.round((completedUnits / expectedUnits) * 1e5) / 1e5;
}

/**
 * 이 **자리**(round_date)를 갭으로 낼 것인가. 입력은 그 자리에 귀속된 회차들의 비율.
 *
 * ── 자리 안에 회차가 여럿이면 **최대값**이다 ────────────────────────────────
 *
 * ⚠️ **호출 시점에 자리는 이미 회차 하나다**(2026-09-20). 추이 경로는 이 함수를 부르기
 *    전에 `cycle-set.ts::restrictToSlotRepresentative` 로 자리마다 대표 하나를 고르고,
 *    그 대표 선택이 **완결성 통과를 첫 키**로 쓴다. 그래서 "최대" 는 사실상 "대표의
 *    비율" 이고 두 판정이 같은 회차를 본다. 아래 "합" 근거는 대표 선택이 없던 시절의
 *    것이라 **더는 이 함수의 전제가 아니다** — 최대값 규칙 자체는 그대로 둔다(대표가
 *    통과한 자리는 최대도 통과, 미달이면 최대도 미달이라 결과가 같고, 대표 선택이
 *    없는 호출부에서는 종전 의미가 유지된다).
 *
 * 자리의 값은 그 자리 회차들의 **합**이었다(대표 선택 전 `toSeries` 의 `byDay` 합산). 그러므로
 * "한 회차라도 기대 유닛을 다 돌았으면 그 자리는 덮였다" 가 맞다. 가중 평균이나
 * 최소값을 쓰면 정반대가 된다: 완주 회차(100%) 옆에 작은 재측정 회차(50%)가 붙은
 * 자리가 **데이터가 더 많은데도** 갭이 된다(08-17 대표 9,068유닛 + 패자 906유닛이
 * 정확히 그 모양이다). 최대값은 단일 회차 자리에서 그 회차의 비율과 같다.
 *
 * ── 모르면(전부 `null`) **갭이 아니다** ────────────────────────────────────
 *
 * 이 리포의 기본 자세는 "모르면 보수적으로" 이지만, 보수의 방향이 여기서는 반대다.
 * 갭은 **고객이 보던 과거 점을 지운다** — 설계 §4-2 가 옵션 B 를 기각한 이유가
 * 그것이다("고객이 보던 과거가 사라진다" > "과거 값이 바뀐다"). 카운터를 못 잰
 * 회차 때문에 점을 지우는 쪽이 값을 내는 쪽보다 나쁘다.
 */
export function slotIsIncomplete(
  ratios: readonly (number | null | undefined)[],
  min: number = TREND_COMPLETION_MIN,
): boolean {
  const known = ratios.filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  if (known.length === 0) return false;
  return Math.max(...known) < min;
}
