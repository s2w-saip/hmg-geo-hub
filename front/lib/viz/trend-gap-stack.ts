/**
 * 100% 누적(스택) 영역 차트의 **갭 브릿지 입력** — 누적 경계 행을 만드는 순수 계산부.
 *
 * 라인 차트에서 한 시리즈는 곡선 **하나**지만, 누적 영역 차트에서 한 카테고리는
 * **연속한 두 누적 경계 사이의 띠**다. 그래서 갭 창을 이으려면 값이 아니라 **경계**를
 * 이어야 한다. 여기서는 각 행을 `[바닥, 시리즈1까지의 누적, 시리즈2까지의 누적, …]` 로
 * 바꿔, 나머지 계획(`planTrendGaps`)·곡선(`trend-gap-curve.ts`)을 라인 차트와 **똑같이**
 * 재사용할 수 있게 한다.
 *
 * 경계 값은 recharts 가 실제로 쓰는 식과 한 글자도 다르지 않아야 한다. 안 그러면
 * 브릿지 끝점이 본선 경계와 어긋나 이음매에 틈이 생긴다. 근거(실측 대조,
 * `node_modules/recharts` 3.8):
 *   · `util/ChartUtils.js` `getStackedData` — 값은 `Number(getValueByDataKey(d, key, 0))`,
 *     즉 **null·누락은 0**이고 순서는 `<Area>` 선언 순(`stackOrderNone`).
 *   · d3 `stackOffsetExpand` — **원값을 행 합으로 나눈 뒤** `stackOffsetNone` 으로 누적한다.
 *     행 합이 0 이면 나누지 않는다(전 경계 0).
 *   · `stackOffset="none"`(absolute 모드)이면 나누기 없이 원값을 누적한다.
 *
 * 갭 행만 예외다 — 계약상 측정값이 전부 null 이므로 경계도 전부 null 로 둔다.
 * 그래야 `planTrendGaps` 가 그 자리에서 런을 끊고 양옆 이웃만 근거로 삼는다.
 * (recharts 는 갭 행을 `isBreakPoint` 로 판정해 영역을 끊는다 — `cartesian/Area.js`
 *  `computeArea`: `hasStack && !connectNulls && 원값 == null` → `y: null`.)
 */

import { rowTrendGap, TREND_GAP_FIELD, type TrendGapRow } from "./trend-gap";

/** 스택 바닥(항상 0) 경계의 예약 키. 시리즈 키와 겹치지 않는다. */
export const TREND_STACK_BASE_KEY = "__stackBase";

/** 시리즈 하나까지의 누적 상단 경계 키. */
export const TREND_STACK_BOUNDARY_PREFIX = "__stackTop:";

export function trendStackBoundaryKey(seriesKey: string): string {
  return `${TREND_STACK_BOUNDARY_PREFIX}${seriesKey}`;
}

export interface TrendStackBoundaries {
  /**
   * 아래→위 순서의 경계 키. `boundaryKeys[0]` 은 바닥이고,
   * `boundaryKeys[i + 1]` 이 `seriesKeys[i]` 의 **상단** 경계다
   * → 카테고리 `i` 의 띠 = `boundaryKeys[i]` ~ `boundaryKeys[i + 1]`.
   */
  boundaryKeys: string[];
  /** x 축 값·갭 마커는 그대로 두고 측정값 자리만 경계로 바꾼 행. */
  rows: TrendGapRow[];
}

/** recharts 의 `Number(getValueByDataKey(d, key, 0))` 재현 — null·누락·비수치는 0. */
function stackValue(row: object, key: string): number {
  const v = (row as Record<string, unknown>)[key];
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function trendStackBoundaryRows<T extends object>(
  rows: readonly T[],
  opts: { xKey: string; seriesKeys: readonly string[]; normalize: boolean },
): TrendStackBoundaries {
  const boundaryKeys = [TREND_STACK_BASE_KEY, ...opts.seriesKeys.map(trendStackBoundaryKey)];
  const out = rows.map((row) => {
    const gap = rowTrendGap(row);
    const next: TrendGapRow = {
      [opts.xKey]: (row as Record<string, unknown>)[opts.xKey] as TrendGapRow[string],
    };
    if (gap) next[TREND_GAP_FIELD] = gap;
    if (gap) {
      for (const k of boundaryKeys) next[k] = null;
      return next;
    }
    const values = opts.seriesKeys.map((s) => stackValue(row, s));
    let total = 0;
    for (const v of values) total += v;
    // d3 `stackOffsetExpand` 와 같은 순서·같은 연산(`v / total` 후 누적).
    const divide = opts.normalize && total !== 0;
    let acc = 0;
    next[boundaryKeys[0]] = 0;
    for (let i = 0; i < values.length; i += 1) {
      acc += divide ? values[i] / total : values[i];
      next[boundaryKeys[i + 1]] = acc;
    }
    return next;
  });
  return { boundaryKeys, rows: out };
}
