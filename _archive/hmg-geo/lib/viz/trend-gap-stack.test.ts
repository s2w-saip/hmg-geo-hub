/**
 * 누적(스택) 추이의 **경계 행** 계산 — 100% 스택 영역 차트의 갭 브릿지 기하 입력.
 *
 * 기준은 recharts 가 실제로 쓰는 식이다(`node_modules/recharts/lib/util/ChartUtils.js`
 * `getStackedData` → d3 `stackOffsetExpand` → `stackOffsetNone`):
 *   · 값은 `Number(getValueByDataKey(d, key, 0))` — null/누락은 **0**.
 *   · expand 는 **원값을 행 합으로 나눈 뒤** 누적한다. 행 합이 0 이면 나누지 않는다.
 */
import { describe, expect, it } from "vitest";
import { COLLECTION_ERROR_GAP, planTrendGaps, type TrendGapRow } from "./trend-gap";
import {
  TREND_STACK_BASE_KEY,
  trendStackBoundaryKey,
  trendStackBoundaryRows,
} from "./trend-gap-stack";

const SERIES = ["A", "B", "C"];
const ROWS: TrendGapRow[] = [
  { week: "w1", A: 1, B: 1, C: 2 },
  { week: "w2", A: 2, B: 2, C: 0 },
  { week: "w3", A: null, B: null, C: null, gap: COLLECTION_ERROR_GAP },
  { week: "w4", A: 1, B: 1, C: 2 },
  { week: "w5", A: 3, B: 1, C: 0 },
];

function boundaries(row: TrendGapRow, keys: readonly string[]) {
  return keys.map((k) => row[k]);
}

describe("trendStackBoundaryRows — 누적 경계", () => {
  it("경계 키는 바닥 + 시리즈마다 하나 (아래에서 위로)", () => {
    const out = trendStackBoundaryRows(ROWS, { xKey: "week", seriesKeys: SERIES, normalize: true });
    expect(out.boundaryKeys).toEqual([
      TREND_STACK_BASE_KEY,
      trendStackBoundaryKey("A"),
      trendStackBoundaryKey("B"),
      trendStackBoundaryKey("C"),
    ]);
  });

  it("100% 정규화(expand): 바닥 0, 상단 1, 단조 증가", () => {
    const out = trendStackBoundaryRows(ROWS, { xKey: "week", seriesKeys: SERIES, normalize: true });
    expect(boundaries(out.rows[0], out.boundaryKeys)).toEqual([0, 0.25, 0.5, 1]);
    // C 가 0 인 주 — 상단 두 경계가 겹친다(밴드 높이 0).
    expect(boundaries(out.rows[1], out.boundaryKeys)).toEqual([0, 0.5, 1, 1]);
    for (const r of out.rows) {
      const b = boundaries(r, out.boundaryKeys);
      if (b[0] === null) continue;
      for (let i = 1; i < b.length; i += 1) {
        expect(Number(b[i])).toBeGreaterThanOrEqual(Number(b[i - 1]));
      }
      expect(Number(b[b.length - 1])).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("absolute(stackOffset=none): 나누지 않고 원값을 누적한다", () => {
    const out = trendStackBoundaryRows(ROWS, { xKey: "week", seriesKeys: SERIES, normalize: false });
    expect(boundaries(out.rows[0], out.boundaryKeys)).toEqual([0, 1, 2, 4]);
    expect(boundaries(out.rows[4], out.boundaryKeys)).toEqual([0, 3, 4, 4]);
  });

  it("갭 행은 경계가 전부 null 이고 갭 마커를 그대로 들고 있다", () => {
    const out = trendStackBoundaryRows(ROWS, { xKey: "week", seriesKeys: SERIES, normalize: true });
    expect(boundaries(out.rows[2], out.boundaryKeys)).toEqual([null, null, null, null]);
    expect(out.rows[2].gap).toBe(COLLECTION_ERROR_GAP);
    expect(out.rows[2].week).toBe("w3");
  });

  it("행 합이 0 이면 d3 처럼 나누지 않는다 (전 경계 0)", () => {
    const zero: TrendGapRow[] = [{ week: "w1", A: 0, B: 0, C: 0 }];
    const out = trendStackBoundaryRows(zero, { xKey: "week", seriesKeys: SERIES, normalize: true });
    expect(boundaries(out.rows[0], out.boundaryKeys)).toEqual([0, 0, 0, 0]);
  });

  it("planTrendGaps 가 경계마다 브릿지를 내고, 같은 갭 런은 runIndex 로 묶인다", () => {
    const out = trendStackBoundaryRows(ROWS, { xKey: "week", seriesKeys: SERIES, normalize: true });
    const plan = planTrendGaps(out.rows, { xKey: "week", seriesKeys: out.boundaryKeys });
    expect(plan.hasGap).toBe(true);
    expect(plan.areas).toHaveLength(1);
    expect(plan.bridges).toHaveLength(out.boundaryKeys.length);
    expect(new Set(plan.bridges.map((b) => b.runIndex))).toEqual(new Set([0]));
    // 바닥 경계는 양옆 0 — 이어도 수평선이다.
    const base = plan.bridges.find((b) => b.seriesKey === TREND_STACK_BASE_KEY)!;
    expect(base.left.at(-1)).toEqual({ x: "w2", y: 0 });
    expect(base.right[0]).toEqual({ x: "w4", y: 0 });
    const top = plan.bridges.find((b) => b.seriesKey === trendStackBoundaryKey("C"))!;
    expect(top.left.at(-1)).toEqual({ x: "w2", y: 1 });
  });

  it("갭이 없으면 브릿지도 없다 — 회귀 0", () => {
    const clean = ROWS.filter((r) => !r.gap);
    const out = trendStackBoundaryRows(clean, { xKey: "week", seriesKeys: SERIES, normalize: true });
    const plan = planTrendGaps(out.rows, { xKey: "week", seriesKeys: out.boundaryKeys });
    expect(plan.hasGap).toBe(false);
    expect(plan.bridges).toEqual([]);
    expect(plan.areas).toEqual([]);
  });
});
