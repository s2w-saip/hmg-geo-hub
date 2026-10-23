import { describe, expect, it } from "vitest";
import type { StandardAcr } from "@/lib/db/repositories/scope-aggregates";
import { acrView, ownFromCounts, sortBrandRows } from "./acr-model";

const brand = (b: string, isOurs: boolean, choiceShare: number, coverage: number, choiceCount = 10) => ({ brand: b, isOurs, choiceCount, appearanceCount: choiceCount * 2, choiceShare, coverage });

// HMG admin: three own brands + rivals; round buckets (API) with the 5 series brands (own first)
const DATA: StandardAcr = {
  measured: true,
  brands: [
    brand("Toyota", false, 14.0, 62.0),
    brand("Hyundai", true, 13.0, 60.0),
    brand("Tesla", false, 12.0, 58.0),
    brand("Kia", true, 9.0, 55.0),
    brand("BMW", false, 8.0, 50.0),
    brand("Genesis", true, 3.0, 20.0),
    brand("Ford", false, 2.0, 30.0),
  ],
  trend: [
    { date: "2026-10-05", series: { Hyundai: 12.0, Kia: 9.5, Genesis: 3.0, Toyota: 13.0, Tesla: 12.5 } },
    { date: "2026-10-12", series: { Hyundai: 12.5, Kia: 9.0, Genesis: 3.2, Toyota: 13.6, Tesla: 12.2 } },
    { date: "2026-10-19", series: { Hyundai: 13.0, Kia: 9.0, Toyota: 14.0, Tesla: 12.0 } },
  ],
  battle: [
    { promptId: "p1", promptText: "a", cells: [{ engine: "chatgpt", winner: "Toyota", winnerIsOurs: false, choiceCount: 9 }, { engine: "gemini", winner: "Toyota", winnerIsOurs: false, choiceCount: 8 }] },
    { promptId: "p2", promptText: "b", cells: [{ engine: "chatgpt", winner: "Toyota", winnerIsOurs: false, choiceCount: 7 }, { engine: "gemini", winner: "Toyota", winnerIsOurs: false, choiceCount: 7 }] },
    { promptId: "p3", promptText: "c", cells: [{ engine: "chatgpt", winner: "Toyota", winnerIsOurs: false, choiceCount: 6 }, { engine: "gemini", winner: "Toyota", winnerIsOurs: false, choiceCount: 6 }] },
    { promptId: "p4", promptText: "d", cells: [{ engine: "chatgpt", winner: "Hyundai", winnerIsOurs: true, choiceCount: 6 }, { engine: "gemini", winner: "Kia", winnerIsOurs: true, choiceCount: 5 }] },
    { promptId: "p5", promptText: "e", cells: [{ engine: "chatgpt", winner: null, winnerIsOurs: false, choiceCount: 0 }, { engine: "gemini", winner: "Hyundai", winnerIsOurs: true, choiceCount: 4 }] },
  ],
  modelConversion: [
    { brand: "Hyundai", model: "IONIQ 5", isOurs: true, conversionRate: 40, shortlistCount: 10, top1Count: 30 },
    { brand: "Toyota", model: "RAV4", isOurs: false, conversionRate: 35, shortlistCount: 10, top1Count: 30 },
    { brand: "Kia", model: "EV6", isOurs: true, conversionRate: 20, shortlistCount: 10, top1Count: 15 },
  ],
  territory: [
    {
      region: "US",
      engine: "chatgpt",
      rows: [
        { promptId: "p1", promptText: "a", validAcr: 10, entries: [{ brand: "Toyota", choice: 6, isOurs: false }] },
        { promptId: "p2", promptText: "b", validAcr: 10, entries: [{ brand: "Toyota", choice: 5, isOurs: false }] },
        { promptId: "p3", promptText: "c", validAcr: 10, entries: [{ brand: "Tesla", choice: 5, isOurs: false }] },
        { promptId: "p4", promptText: "d", validAcr: 10, entries: [{ brand: "Hyundai", choice: 5, isOurs: true }] },
      ],
    },
  ],
  totals: { promptRuns: 40, prompts: 5, iterations: 390, engines: ["chatgpt", "gemini"] },
};
const OWN = { choiceCount: 98, appearanceCount: 200, choiceShare: 25.1, coverage: 92.5 };

describe("renewal ACR view model", () => {
  it("legacy own counts → the API own shape (round1 of 100 n / d, null on an empty denominator)", () => {
    expect(ownFromCounts({ choiceCount: 15, appearanceCount: 24, cells: 4 }, { promptRuns: 5, prompts: 2, iterations: 34, engines: [] })).toEqual({
      choiceCount: 15,
      appearanceCount: 24,
      choiceShare: 44.1,
      coverage: 80,
    });
    expect(ownFromCounts({ choiceCount: 0, appearanceCount: 0, cells: 0 }, { promptRuns: 0, prompts: 0, iterations: 0, engines: [] }).choiceShare).toBeNull();
  });

  it("당사 trend = own series added up (a missing own key counts 0); rivals = the other series brands", () => {
    const v = acrView(DATA, OWN, { roundBuckets: true, period: false });
    expect(v.ownTrend).toEqual([24.5, 24.7, 22]);
    expect(v.rivals).toEqual(["Toyota", "Tesla"]);
    expect(v.ownDelta).toBe(-2.7);
    expect(v.brands.find((b) => b.brand === "Toyota")?.d).toBe(0.4);
    expect(v.brands.find((b) => b.brand === "BMW")?.trend).toBeNull();
  });

  it("Δ only on round buckets with a snapshot read (legacy day buckets and periods have none)", () => {
    expect(acrView(DATA, OWN, { roundBuckets: false, period: false }).ownDelta).toBeNull();
    expect(acrView(DATA, OWN, { roundBuckets: true, period: true }).brands.every((b) => b.d == null)).toBe(true);
  });

  it("rank of 당사 among rivals, leader, map average slope", () => {
    const v = acrView(DATA, OWN, { roundBuckets: true, period: false });
    expect(v.rank).toBe(1);
    expect(v.leader?.brand).toBe("Toyota");
    expect(v.k).toBeCloseTo(61 / 335, 6);
    // 12.5 % sits between Toyota (14) and Tesla (12)
    expect(acrView(DATA, { ...OWN, choiceShare: 12.5 }, { roundBuckets: true, period: false }).rank).toBe(2);
  });

  it("engine wins and sweeps (a rival on top in every engine)", () => {
    const v = acrView(DATA, OWN, { roundBuckets: true, period: false });
    expect(v.engineWins.map((e) => [e.engine, e.ownWins])).toEqual([
      ["chatgpt", 1],
      ["gemini", 2],
    ]);
    expect(v.engineWins[0].byBrand.get(null)).toBe(1);
    expect(v.sweeps).toEqual([{ brand: "Toyota", count: 3 }]);
  });

  it("findings: four at most, most important first, each with a target", () => {
    const f = acrView(DATA, OWN, { roundBuckets: true, period: false }).findings;
    // hand check: leak (Kia 55 % ≈ Tesla 58 % in the shortlist, 3pp fewer picks) 8 · sweep 7 · model 5 ·
    // dist 5 · mover (Hyundai +0.5) 4 · standing (1위) 3 — the engine gap (1 prompt) is too small
    expect(f.map((x) => x.kind)).toEqual(["leak", "sweep", "model", "dist"]);
    expect(f[0]).toMatchObject({ brand: "Tesla", params: { own: "Kia", rival: "Tesla", gap: 3 } });
    expect(f.find((x) => x.kind === "sweep")).toMatchObject({ brand: "Toyota", act: { battle: "notown" }, params: { count: 3 } });
    expect(f.find((x) => x.kind === "dist")?.params).toMatchObject({ zero: 3, rows: 4 });
    // 당사 behind the leader: standing turns into a warning with top priority
    const behind = acrView(DATA, { ...OWN, choiceShare: 12.5 }, { roundBuckets: true, period: false }).findings;
    expect(behind[0]).toMatchObject({ kind: "standing", tone: "warn", params: { rival: "Toyota", gap: 1.5, first: 0 } });
  });

  it("board sort keeps nulls last and ties in server order", () => {
    const v = acrView(DATA, OWN, { roundBuckets: true, period: false });
    expect(sortBrandRows(v.brands, "coverage").map((b) => b.brand)).toEqual(["Toyota", "Hyundai", "Tesla", "Kia", "BMW", "Ford", "Genesis"]);
    expect(sortBrandRows(v.brands, "d")[0].d).not.toBeNull();
    expect(sortBrandRows(v.brands, "d").at(-1)?.d).toBeNull();
  });
});
