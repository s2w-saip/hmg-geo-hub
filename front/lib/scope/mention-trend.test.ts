import { describe, it, expect } from "vitest";
import { buildMentionTrend, buildWeeklyTrend } from "./result-adapter";

// Generic weekly trend (used by citation domains too).
describe("buildWeeklyTrend (generic keys, e.g. domains)", () => {
  it("buckets domain entries by week and sums per key", () => {
    const t = buildWeeklyTrend(
      [
        { date: "2026-06-15T09:00:00Z", key: "hyundai.com", count: 2 },
        { date: "2026-06-22T09:00:00Z", key: "hyundai.com", count: 3 },
        { date: "2026-06-22T09:00:00Z", key: "kia.com", count: 1 },
      ],
      ["hyundai.com", "kia.com"],
    );
    expect(t).not.toBeNull();
    expect(t!.points.map((p) => p.week)).toEqual(["2026-06-15", "2026-06-22"]);
    expect(t!.points[1]).toEqual({ week: "2026-06-22", "hyundai.com": 3, "kia.com": 1 });
  });
});

// Weekly Top-N brand mention trend bucketing (shared by mirror + public paths).
describe("buildMentionTrend", () => {
  it("buckets entries by ISO week-start (Mon) and sums per brand", () => {
    const t = buildMentionTrend(
      [
        { date: "2026-06-15T09:00:00Z", brand: "Hyundai", count: 2 }, // wk of 06-15
        { date: "2026-06-17T10:00:00Z", brand: "Hyundai", count: 1 }, // same wk
        { date: "2026-06-22T08:00:00Z", brand: "Hyundai", count: 3 }, // wk of 06-22
        { date: "2026-06-22T08:00:00Z", brand: "Kia", count: 1 },
      ],
      ["Hyundai", "Kia"],
    );
    expect(t).not.toBeNull();
    expect(t!.series).toEqual(["Hyundai", "Kia"]);
    expect(t!.points.map((p) => p.week)).toEqual(["2026-06-15", "2026-06-22"]);
    expect(t!.points[0]).toEqual({ week: "2026-06-15", Hyundai: 3, Kia: 0 });
    expect(t!.points[1]).toEqual({ week: "2026-06-22", Hyundai: 3, Kia: 1 });
  });

  it("returns null with fewer than 2 weeks (a single point isn't a trend)", () => {
    const t = buildMentionTrend(
      [
        { date: "2026-06-15T09:00:00Z", brand: "Hyundai", count: 2 },
        { date: "2026-06-16T09:00:00Z", brand: "Hyundai", count: 2 },
      ],
      ["Hyundai"],
    );
    expect(t).toBeNull();
  });

  it("ignores brands outside the series and unparseable dates", () => {
    const t = buildMentionTrend(
      [
        { date: "2026-06-15T09:00:00Z", brand: "Hyundai", count: 1 },
        { date: "2026-06-22T09:00:00Z", brand: "Hyundai", count: 1 },
        { date: "2026-06-22T09:00:00Z", brand: "Toyota", count: 5 }, // not in series
        { date: "not-a-date", brand: "Hyundai", count: 9 }, // dropped
        { date: null, brand: "Hyundai", count: 9 }, // dropped
      ],
      ["Hyundai"],
    );
    expect(t).not.toBeNull();
    expect(t!.points).toHaveLength(2);
    expect(t!.points.every((p) => !("Toyota" in p))).toBe(true);
    expect(t!.points[0].Hyundai).toBe(1);
  });

  it("returns null for empty series", () => {
    expect(
      buildMentionTrend([{ date: "2026-06-15T09:00:00Z", brand: "X", count: 1 }], []),
    ).toBeNull();
  });
});
