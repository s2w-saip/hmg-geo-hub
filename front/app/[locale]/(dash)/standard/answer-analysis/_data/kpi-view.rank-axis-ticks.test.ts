import { describe, expect, it } from "vitest";
import { rankAxisTicks } from "./kpi-view";

// 우선 노출도 추이 y축 눈금. recharts 자동 눈금은 경쟁 순위 축(1~6)에서 `3, 5, 6` 만
// 찍어 1위가 빠졌다. 정수 순위 눈금을 고정한다.
describe("rankAxisTicks", () => {
  it.each([
    [5, [1, 2, 3, 4, 5]],
    [6, [1, 2, 3, 4, 5, 6]],
    [10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    [11, [1, 5, 10]],
    [34, [1, 5, 10, 15, 20, 25, 30]],
  ])("yMax %i", (yMax, expected) => {
    expect(rankAxisTicks(yMax)).toEqual(expected);
  });

  it("간격이 커져도 1 을 포함하고 8개 이하, yMax 를 넘지 않는다", () => {
    for (const yMax of [36, 40, 41, 99, 150, 1234]) {
      const ticks = rankAxisTicks(yMax);
      expect(ticks[0]).toBe(1);
      expect(ticks.length).toBeLessThanOrEqual(8);
      expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(yMax);
    }
    expect(rankAxisTicks(36)).toEqual([1, 5, 10, 15, 20, 25, 30, 35]);
    expect(rankAxisTicks(40)).toEqual([1, 10, 20, 30, 40]);
  });

  it("비정상 입력은 1 만", () => {
    expect(rankAxisTicks(1)).toEqual([1]);
    expect(rankAxisTicks(Number.NaN)).toEqual([1]);
  });
});
