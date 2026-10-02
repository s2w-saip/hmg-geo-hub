import { afterEach, describe, expect, it, vi } from "vitest";

// resolveRequestComparePeriodShape (U4): on the api source the shape is the anchor-axis-on shape
// with NO database lookup (ensureAnchorAxis never runs); on the legacy source (or without a
// source) the behaviour is unchanged: the axis state decides.

const axis = vi.hoisted(() => ({ calls: 0, value: false }));
vi.mock("@/lib/period/anchor-axis-state", () => ({
  ensureAnchorAxis: async () => {
    axis.calls += 1;
    return axis.value;
  },
}));

const { resolveRequestComparePeriodShape } = await import("./compare-shape");
const { resolveComparePeriodShape } = await import("@/lib/kpi/period-compare-week");
const { resolvePeriodCompareShape } = await import("@/lib/kpi/calendar-month-window");

// Monday..Sunday: a calendar week only when the axis is on (compare-shape.ts header).
const WEEK = ["2026-09-07", "2026-09-13"] as const;
const MONTH = ["2026-08-01", "2026-08-31"] as const;
const WINDOW = ["2026-09-02", "2026-09-15"] as const;

afterEach(() => {
  axis.calls = 0;
  axis.value = false;
  vi.unstubAllEnvs();
});

describe("legacy source: unchanged (axis state from the DB decides)", () => {
  it("no source argument: axis off -> month/window only (a Mon-Sun range is a window)", async () => {
    await expect(resolveRequestComparePeriodShape(...WEEK)).resolves.toEqual(resolvePeriodCompareShape(...WEEK));
    expect((await resolveRequestComparePeriodShape(...WEEK)).kind).toBe("window");
    expect(axis.calls).toBe(2);
  });

  it("legacy flag with a source: same as before; axis on -> calendar week", async () => {
    vi.stubEnv("HGH_SOURCE_G1", "legacy");
    axis.value = true;
    const shape = await resolveRequestComparePeriodShape(...WEEK, { area: "dashboard", surface: "global" });
    expect(shape).toEqual(resolveComparePeriodShape(...WEEK));
    expect(shape.kind).toBe("calendarWeek");
    expect(axis.calls).toBe(1);
  });

  it("another group's api flag does not switch this screen", async () => {
    vi.stubEnv("HGH_SOURCE_G2", "api");
    await resolveRequestComparePeriodShape(...WEEK, { area: "dashboard", surface: "global" });
    expect(axis.calls).toBe(1);
  });
});

describe("api source: anchor-axis shape, no DB lookup", () => {
  it.each([
    ["dashboard", "global", "HGH_SOURCE_G1"],
    ["analysis", "global", "HGH_SOURCE_G2"],
    ["dashboard", "website", "HGH_SOURCE_G3"],
    ["analysis", "project", "HGH_SOURCE_G6"],
  ] as const)("%s/%s with %s=api", async (area, surface, flag) => {
    vi.stubEnv(flag, "api");
    axis.value = false; // even if the legacy axis state says off
    for (const [from, to] of [WEEK, MONTH, WINDOW]) {
      await expect(resolveRequestComparePeriodShape(from, to, { area, surface })).resolves.toEqual(resolveComparePeriodShape(from, to));
    }
    expect((await resolveRequestComparePeriodShape(...WEEK, { area, surface })).kind).toBe("calendarWeek");
    expect((await resolveRequestComparePeriodShape(...MONTH, { area, surface })).kind).toBe("calendarMonth");
    expect(axis.calls).toBe(0);
  });
});
