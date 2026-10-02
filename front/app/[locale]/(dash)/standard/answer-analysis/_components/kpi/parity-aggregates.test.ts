import { describe, expect, it } from "vitest";
import type { EngineKpiTrend } from "@/lib/db/repositories/scope-aggregates";
import { engineCompetitorBars, typeComboPoints } from "../../_data/kpi-view";
import { competitorBrandOfDomain } from "@/lib/citation-categorizer/competitor-brand";

// 2026-09-02 피그마 1:1 신규 집계의 화면 파생 — 엔진별 경쟁사 비교·유형 시계열.
function trend(over: Partial<EngineKpiTrend> = {}): EngineKpiTrend {
  const pt = (engine: string, answers: number, tracked: number, total: number, tm: number) => ({
    engine, answers, trackedAnswers: tracked, exposurePct: (100 * tracked) / answers,
    totalMentions: total, trackedMentions: tm, sovPct: (100 * tm) / total,
    sentSignals: 10, positiveSignals: 6, negativeSignals: 2,
  });
  return {
    unit: "week", engines: ["chatgpt", "gemini"], trendDegraded: false,
    windowStartBucket: "2026-08-03", windowEndBucket: "2026-08-17",
    latest: [pt("chatgpt", 100, 40, 200, 80), pt("gemini", 50, 10, 100, 20)],
    latestMeasuredAt: "2026-08-17",
    latestBrands: [
      { engine: "chatgpt", brand: "Hyundai", isTracked: true, answersWithBrand: 40, mentions: 80 },
      { engine: "chatgpt", brand: "Toyota", isTracked: false, answersWithBrand: 30, mentions: 60 },
      { engine: "chatgpt", brand: "BMW", isTracked: false, answersWithBrand: 10, mentions: 20 },
      { engine: "chatgpt", brand: "Ghost", isTracked: false, answersWithBrand: 0, mentions: 0 },
      { engine: "gemini", brand: "Hyundai", isTracked: true, answersWithBrand: 10, mentions: 20 },
    ],
    buckets: [
      { bucketStart: "2026-08-03", measuredDays: 3, firstAt: null, lastAt: null, engines: [pt("chatgpt", 50, 20, 100, 40)] },
      { bucketStart: "2026-08-10", measuredDays: 0, firstAt: null, lastAt: null, engines: [] },
      { bucketStart: "2026-08-17", measuredDays: 2, firstAt: null, lastAt: null, engines: [pt("chatgpt", 40, 20, 80, 40)] },
    ],
    typeTrend: [
      { bucketStart: "2026-08-03", answers: 50, byType: { mention: 20, recommendation: 10, comparison: 5, definition: 0, final_choice: 1 } },
      { bucketStart: "2026-08-17", answers: 40, byType: { mention: 10, recommendation: 8, comparison: 4, definition: 0, final_choice: 0 } },
    ],
    ...over,
  };
}

describe("engineCompetitorBars — 당사 · 경쟁사 평균", () => {
  it("averages competitor exposure per engine, ignoring brands with no mentions", () => {
    const bars = engineCompetitorBars(trend(), "exposure");
    const gpt = bars.find((b) => b.engine === "chatgpt")!;
    expect(gpt.ownPct).toBe(40);
    // Toyota 30% · BMW 10% → 평균 20% (Ghost 는 언급 0 → 제외)
    expect(gpt.competitorAvgPct).toBe(20);
    expect(gpt.competitorCount).toBe(2);
  });
  it("uses mention share for the sov metric", () => {
    const bars = engineCompetitorBars(trend(), "sov");
    const gpt = bars.find((b) => b.engine === "chatgpt")!;
    expect(gpt.ownPct).toBe(40); // 80/200
    expect(gpt.competitorAvgPct).toBe(20); // (30 + 10) / 2
  });
  it("leaves competitor values null for an engine with no competitor rows", () => {
    const gem = engineCompetitorBars(trend(), "exposure").find((b) => b.engine === "gemini")!;
    expect(gem.competitorAvgPct).toBeNull();
    expect(gem.competitorCount).toBe(0);
  });
  // QA 2차 #6 — 선택 경쟁사 막대는 계약에서 사라졌다(죽은 코드로 남기지 않는다).
  it("exposes no per-pick field at all", () => {
    const gpt = engineCompetitorBars(trend(), "exposure").find((b) => b.engine === "chatgpt")!;
    expect(Object.keys(gpt).sort()).toEqual([
      "competitorAvgPct",
      "competitorCount",
      "engine",
      "ownPct",
    ]);
  });
  it("returns [] when the aggregate degraded", () => {
    expect(engineCompetitorBars(null, "exposure")).toEqual([]);
  });
});

describe("typeComboPoints — 유형별·우호도 선", () => {
  it("derives per-type exposure and favorability per bucket, gap stays null", () => {
    const pts = typeComboPoints(trend());
    expect(pts.map((p) => p.bucketStart)).toEqual(["2026-08-03", "2026-08-10", "2026-08-17"]);
    expect(pts[0].byType.mention).toBe(40); // 20/50
    expect(pts[0].favorabilityPct).toBe(60); // 6/10
    expect(pts[1].byType.mention).toBeNull(); // 결측 회차
    expect(pts[1].favorabilityPct).toBeNull();
    expect(pts[2].byType.recommendation).toBe(20); // 8/40
    expect(pts[0].avgPosition).toBeNull(); // firstPosition 미제공
  });
});

describe("competitorBrandOfDomain", () => {
  it.each([
    ["www.bmw.co.kr", "BMW"],
    ["bmwusa.com", "BMW"],
    ["mbusa.com", "Mercedes-Benz"],
    ["toyotabharat.com", "Toyota"],
    ["mg.co.uk", "MG"],
    ["mgmresorts.com", null], // 3자 토큰은 접두 매칭 안 함
    ["reddit.com", null],
  ])("%s → %s", (domain, brand) => {
    expect(competitorBrandOfDomain(domain)).toBe(brand);
  });
});
