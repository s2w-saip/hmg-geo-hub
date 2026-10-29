import { describe, expect, it } from "vitest";
import {
  isTrendGap,
  planTrendGaps,
  rowTrendGap,
  trendGapBridgeKey,
  type TrendGap,
  type TrendGapRow,
} from "./trend-gap";

const GAP: TrendGap = { reason: "collection_error" };

// 8/24 주 하나가 수집 오류인 픽스처 — 운영 2026-09-10 요청의 실제 형태
// (글로벌 8/25 앵커 회차가 정원의 1/4 만 수집돼 골짜기로 찍힌 그 주).
const WEEKS: TrendGapRow[] = [
  { week: "2026-08-10", "hyundai.com": 40, "kia.com": 22 },
  { week: "2026-08-17", "hyundai.com": 44, "kia.com": 25 },
  { week: "2026-08-24", "hyundai.com": null, "kia.com": null, gap: GAP },
  { week: "2026-08-31", "hyundai.com": 46, "kia.com": 24 },
];
const SERIES = ["hyundai.com", "kia.com"];

describe("rowTrendGap", () => {
  it("reads the marker only when the reason matches the contract", () => {
    expect(rowTrendGap({ gap: GAP })).toEqual(GAP);
    expect(rowTrendGap({ gap: { reason: "something-else" } })).toBeUndefined();
    expect(rowTrendGap({ gap: "collection_error" })).toBeUndefined();
    expect(rowTrendGap({})).toBeUndefined();
    expect(rowTrendGap(null)).toBeUndefined();
    expect(isTrendGap(GAP)).toBe(true);
  });
});

describe("planTrendGaps", () => {
  it("is a no-op on data without a gap — same rows, nothing to draw", () => {
    const clean = WEEKS.filter((r) => rowTrendGap(r) == null);
    const plan = planTrendGaps(clean, { xKey: "week", seriesKeys: SERIES });
    expect(plan.hasGap).toBe(false);
    expect(plan.areas).toEqual([]);
    expect(plan.bridges).toEqual([]);
    // 참조까지 그대로 — 갭이 없는 차트는 종전 데이터를 그대로 그린다.
    expect(plan.rows).toBe(clean);
  });

  it("shades the gap slot from neighbour centre to neighbour centre", () => {
    const plan = planTrendGaps(WEEKS, { xKey: "week", seriesKeys: SERIES });
    expect(plan.hasGap).toBe(true);
    expect(plan.areas).toHaveLength(1);
    expect(plan.areas[0].x1).toBe("2026-08-17");
    expect(plan.areas[0].x2).toBe("2026-08-31");
  });

  it("bridges each series across the gap using only the neighbours' own values", () => {
    const plan = planTrendGaps(WEEKS, { xKey: "week", seriesKeys: SERIES });
    expect(plan.bridges.map((b) => b.seriesKey)).toEqual(SERIES);

    // dataKey 는 이제 React key 로만 쓴다(합성 시리즈가 아니다 — 아래 케이스 참고).
    expect(plan.bridges[0].dataKey).toBe(trendGapBridgeKey(0, "hyundai.com"));
    // 이웃 실측 좌표를 그대로 싣는다: 왼쪽 꼬리의 마지막 = 8/17, 오른쪽 머리의 첫째 = 8/31.
    expect(plan.bridges[0].left.at(-1)).toEqual({ x: "2026-08-17", y: 44 });
    expect(plan.bridges[0].right[0]).toEqual({ x: "2026-08-31", y: 46 });
  });

  // 2026-09-11 — 보조선을 합성 시리즈(<Line>) 에서 **곡선 path** 로 바꾸면서,
  // 행에 `__gapBridge:` 값을 심을 이유가 사라졌다. 그래서 갭이 있어도 차트가 받는
  // 데이터는 호출부 배열 **그대로**다(참조 동일) — 회귀 표면이 한 겹 줄었다.
  it("갭이 있어도 행에는 손을 대지 않는다 — 합성 값이 데이터에 안 남는다", () => {
    const plan = planTrendGaps(WEEKS, { xKey: "week", seriesKeys: SERIES });
    expect(plan.rows).toBe(WEEKS);
    const key = trendGapBridgeKey(0, "hyundai.com");
    expect((plan.rows as TrendGapRow[])[1][key]).toBeUndefined();
    expect((plan.rows as TrendGapRow[])[2]["hyundai.com"]).toBeNull();
  });

  it("접선 계산용 이웃을 양쪽 최대 3점까지 싣는다 — 본선 런 안에서만", () => {
    const rows: TrendGapRow[] = [
      { week: "w0", a: 1 },
      { week: "w1", a: 2 },
      { week: "w2", a: 3 },
      { week: "w3", a: 4 },
      { week: "w4", a: null, gap: GAP },
      { week: "w5", a: 6 },
      { week: "w6", a: 7 },
    ];
    const plan = planTrendGaps(rows, { xKey: "week", seriesKeys: ["a"] });
    // 왼쪽 꼬리는 3점(w1..w3) — d3 의 끝 접선이 마지막 3점만 보기 때문.
    expect(plan.bridges[0].left).toEqual([
      { x: "w1", y: 2 },
      { x: "w2", y: 3 },
      { x: "w3", y: 4 },
    ]);
    expect(plan.bridges[0].right).toEqual([
      { x: "w5", y: 6 },
      { x: "w6", y: 7 },
    ]);
  });

  it("이웃 꼬리는 결측에서 끊긴다 — 본선이 끊긴 자리를 넘어가지 않는다", () => {
    // w2 는 갭이 아니라 그냥 미측정 → 본선은 거기서 끊긴다. 접선도 w3 부터만 본다.
    const rows: TrendGapRow[] = [
      { week: "w1", a: 2 },
      { week: "w2", a: null },
      { week: "w3", a: 4 },
      { week: "w4", a: null, gap: GAP },
      { week: "w5", a: 6 },
    ];
    const plan = planTrendGaps(rows, { xKey: "week", seriesKeys: ["a"] });
    expect(plan.bridges[0].left).toEqual([{ x: "w3", y: 4 }]);
    expect(plan.bridges[0].right).toEqual([{ x: "w5", y: 6 }]);
  });

  it("never mutates the caller's rows", () => {
    const rows: TrendGapRow[] = WEEKS.map((r) => ({ ...r }));
    planTrendGaps(rows, { xKey: "week", seriesKeys: SERIES });
    expect(Object.keys(rows[1])).toEqual(["week", "hyundai.com", "kia.com"]);
  });

  it("merges consecutive gap weeks into one band so the shade never doubles", () => {
    const rows: TrendGapRow[] = [
      { week: "2026-08-10", a: 1 },
      { week: "2026-08-17", a: null, gap: GAP },
      { week: "2026-08-24", a: null, gap: GAP },
      { week: "2026-08-31", a: 2 },
    ];
    const plan = planTrendGaps(rows, { xKey: "week", seriesKeys: ["a"] });
    expect(plan.areas).toHaveLength(1);
    expect(plan.areas[0].x1).toBe("2026-08-10");
    expect(plan.areas[0].x2).toBe("2026-08-31");
    expect(plan.bridges).toHaveLength(1);
  });

  it("leaves an axis-edge gap unbridged — there is no neighbour on one side", () => {
    const rows: TrendGapRow[] = [
      { week: "2026-08-10", a: null, gap: GAP },
      { week: "2026-08-17", a: 5 },
    ];
    const plan = planTrendGaps(rows, { xKey: "week", seriesKeys: ["a"] });
    expect(plan.areas).toHaveLength(1);
    expect(plan.bridges).toEqual([]);
  });

  it("does not bridge to a genuinely unmeasured neighbour", () => {
    // 8/17 은 갭이 아니라 '측정 없음' — 없는 측정에 선을 이어 붙이지 않는다.
    const rows: TrendGapRow[] = [
      { week: "2026-08-10", a: 1 },
      { week: "2026-08-17", a: null },
      { week: "2026-08-24", a: null, gap: GAP },
      { week: "2026-08-31", a: 2 },
    ];
    const plan = planTrendGaps(rows, { xKey: "week", seriesKeys: ["a"] });
    expect(plan.areas).toHaveLength(1);
    expect(plan.bridges).toEqual([]);
  });

  it("bridges per series — a series missing on one side stays broken", () => {
    const rows: TrendGapRow[] = [
      { week: "2026-08-17", a: 3, b: null },
      { week: "2026-08-24", a: null, b: null, gap: GAP },
      { week: "2026-08-31", a: 4, b: 9 },
    ];
    const plan = planTrendGaps(rows, { xKey: "week", seriesKeys: ["a", "b"] });
    expect(plan.bridges.map((x) => x.seriesKey)).toEqual(["a"]);
  });
});
