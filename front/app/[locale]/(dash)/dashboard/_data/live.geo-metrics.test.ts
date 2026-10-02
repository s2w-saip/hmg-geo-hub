import { describe, expect, it } from "vitest";

import type { GeoBrandKpiRow } from "@/lib/db/repositories/scope-aggregates";
import { marketMetrics, metricValue } from "./overview-metrics";

const row = (brand: string, isTracked: boolean, over: Partial<GeoBrandKpiRow> = {}): GeoBrandKpiRow => ({
  code: "KR", brand, isTracked, mentions: 0, answers: 0, posSum: 0, posCnt: 0, sentPositive: 0, sentTotal: 0, ...over,
});

describe("marketMetrics — Overview 국가별 KPI 5종", () => {
  const brands = [
    row("Hyundai", true, { mentions: 60, answers: 30, posSum: 90, posCnt: 30, sentPositive: 40, sentTotal: 50 }),
    row("Kia", true, { mentions: 40, answers: 20, posSum: 100, posCnt: 20, sentPositive: 10, sentTotal: 50 }),
    row("Tesla", false, { mentions: 50, answers: 25, posSum: 50, posCnt: 25, sentPositive: 30, sentTotal: 40 }),
    row("BMW", false, { mentions: 10, answers: 5, posSum: 30, posCnt: 5, sentPositive: 0, sentTotal: 0 }),
  ];
  const totals = { answers: 100, ownAnswers: 45, citTotal: 200, citOwned: 20 };

  it("computes ours with the card formulas and the rival from the top competitor by mentions", () => {
    const m = marketMetrics(brands, totals, null);
    expect(m.visibility).toEqual({ ours: 45, rival: { name: "Tesla", value: 25 } });
    expect(m.shareOfVoice).toEqual({ ours: 62.5, rival: { name: "Tesla", value: 31.3 } });
    expect(m.sentiment).toEqual({ ours: 50, rival: { name: "Tesla", value: 75 } });
    expect(m.position).toEqual({ ours: 3.8, rival: { name: "Tesla", value: 2 } });
    expect(m.citationShare).toEqual({ ours: 10, rival: null });
  });
  it("narrows 'ours' to the scoped brands and clamps summed answers to the total", () => {
    const m = marketMetrics(brands, totals, new Set(["Kia"]));
    expect(m.shareOfVoice.ours).toBe(25);
    expect(m.visibility.ours).toBe(20); // Kia 20/100
    expect(m.position.ours).toBe(5);
  });
  it("returns nulls (not zeros) when there is nothing to divide by", () => {
    const m = marketMetrics([], { answers: 0, ownAnswers: 0, citTotal: 0, citOwned: 0 }, null);
    expect(m.visibility.ours).toBeNull();
    expect(m.sentiment.ours).toBeNull();
    expect(m.position.ours).toBeNull();
    expect(m.citationShare.ours).toBeNull();
    expect(m.shareOfVoice.rival).toBeNull();
  });
  it("metricValue falls back to hmgSov for share when metrics are missing (legacy cells)", () => {
    expect(metricValue({ hmgSov: 12.3, hmgRank: 1, fieldSize: 3, topBrand: null, topRival: null }, "shareOfVoice")).toBe(12.3);
    expect(metricValue({ hmgSov: 12.3, hmgRank: 1, fieldSize: 3, topBrand: null, topRival: null }, "visibility")).toBeNull();
  });
});
