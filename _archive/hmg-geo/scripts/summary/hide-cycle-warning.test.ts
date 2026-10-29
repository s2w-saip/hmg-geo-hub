import { describe, expect, it } from "vitest";
import { hideCycleWarnings } from "./hide-cycle-warning";

describe("hideCycleWarnings — 최신 회차의 축 안내", () => {
  it("반례 ① rest=0/latest=true: 갭 생성 여부를 모순되게 말하지 않는다", () => {
    const text = hideCycleWarnings({
      cycleWeek: "2026-08-24",
      remainingVisibleCyclesInWeek: 0,
      newerVisibleCycles: 0,
      reason: "collection_error",
    }).join("\n");

    expect(text).toContain("갭 슬롯이 생기지 않는다");
    expect(text).not.toContain("갭 슬롯이 생겨");
  });

  it("반례 ② rest=1/latest=true: 같은 주 측정이 남으면 주 축은 유지된다", () => {
    const text = hideCycleWarnings({
      cycleWeek: "2026-08-24",
      remainingVisibleCyclesInWeek: 1,
      newerVisibleCycles: 0,
      reason: "collection_error",
    }).join("\n");

    expect(text).toContain("주 축은 유지된다");
    expect(text).not.toContain("각각 한 칸 짧아지고");
  });
});
