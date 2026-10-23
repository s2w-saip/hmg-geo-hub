import { describe, expect, it } from "vitest";
import type { BrandTrendResult, EngineKpiTrend, StandardSubKpis } from "@/lib/db/repositories/scope-aggregates";
import type { MentionsBrandLive, MentionTypesByBrand } from "@/lib/scope/result-adapter";
import type { CompareResult } from "@/lib/kpi/period-compare";
import { kpiHero } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view";
import { NON_AUTO_GROUP, brandFoldKey, isMappedBrand, parentGroupOf } from "./brand-groups";
import {
  OWN_KEY,
  TREEMAP_FOLD,
  board,
  bumpData,
  findings,
  rateHero,
  resolveDelta,
  shareDeltas,
  squarify,
  treemapGroups,
  typeCompareRows,
  type TreemapBrand,
} from "./mention-model";

// ── fixtures (kpi-view.test.ts shapes) ─────────────────────────────────────────────────────

const row = (over: Partial<StandardSubKpis["rows"][number]>) => ({
  engine: "chatgpt",
  answers: 0,
  tracked: 0,
  multi: 0,
  top1: 0,
  top3: 0,
  avgPosition: null,
  totalMentions: 0,
  trackedMentions: 0,
  sentMentions: 0,
  positiveMentions: 0,
  negativeMentions: 0,
  citTotal: 0,
  citOwned: 0,
  ...over,
});
const SUB: StandardSubKpis = {
  rows: [row({ engine: "chatgpt", answers: 100, tracked: 60, totalMentions: 400, trackedMentions: 100 }), row({ engine: "gemini", answers: 100, tracked: 40, totalMentions: 600, trackedMentions: 50 })],
  promptsWithoutBrand: null,
  measuredPrompts: null,
};
const point = (engine: string, over: Partial<EngineKpiTrend["latest"][number]> = {}) => ({ engine, answers: 0, trackedAnswers: 0, exposurePct: null, totalMentions: 0, trackedMentions: 0, sovPct: null, ...over });
const ENGINE: EngineKpiTrend = {
  unit: "week",
  trendDegraded: false,
  windowStartBucket: "2026-10-05",
  windowEndBucket: "2026-10-19",
  engines: ["chatgpt", "gemini"],
  buckets: (["2026-10-05", "2026-10-12", "2026-10-19"] as const).map((b, i) => ({
    bucketStart: b,
    measuredDays: 2,
    firstAt: null,
    lastAt: null,
    engines: [point("chatgpt", { answers: 100, trackedAnswers: 50 + 5 * i, totalMentions: 400, trackedMentions: 90 + 5 * i }), point("gemini", { answers: 100, trackedAnswers: 40, totalMentions: 600, trackedMentions: 50 })],
  })),
  latest: [point("chatgpt", { answers: 100, trackedAnswers: 60, exposurePct: 60, totalMentions: 400, trackedMentions: 100, sovPct: 25 }), point("gemini", { answers: 100, trackedAnswers: 40, exposurePct: 40, totalMentions: 600, trackedMentions: 50, sovPct: 8.3 })],
  latestBrands: [],
  typeTrend: [],
  latestMeasuredAt: null,
} as unknown as EngineKpiTrend;

// Kia + Hyundai = 당사 (admin), Toyota / Tesla / BMW competitors; BMW leaves the series cap.
const bt = (brand: string, isTracked: boolean, mentions: number, sharePct: number, exposurePct: number) => ({ brand, isTracked, mentions, answers: mentions, exposurePct, sharePct });
const TREND: BrandTrendResult = {
  unit: "week",
  windowStartBucket: "2026-10-05",
  windowEndBucket: "2026-10-19",
  brands: [
    { brand: "Kia", isTracked: true, mentions: 300 },
    { brand: "Hyundai", isTracked: true, mentions: 290 },
    { brand: "Toyota", isTracked: false, mentions: 120 },
    { brand: "Tesla", isTracked: false, mentions: 110 },
  ],
  buckets: [
    { bucketStart: "2026-10-05", answers: 100, totalMentions: 1000, measuredDays: 2, firstAt: null, lastAt: null, brands: [bt("Kia", true, 100, 10, 40), bt("Hyundai", true, 90, 9, 45), bt("Toyota", false, 30, 3, 20), bt("Tesla", false, 50, 5, 25)] },
    { bucketStart: "2026-10-12", answers: 100, totalMentions: 1000, measuredDays: 2, firstAt: null, lastAt: null, brands: [bt("Kia", true, 100, 10, 41), bt("Hyundai", true, 100, 10, 46), bt("Toyota", false, 40, 4, 22), bt("Tesla", false, 30, 3, 24)] },
    { bucketStart: "2026-10-19", answers: 100, totalMentions: 1000, measuredDays: 2, firstAt: null, lastAt: null, brands: [bt("Kia", true, 100, 10, 42), bt("Hyundai", true, 100, 10, 47), bt("Toyota", false, 50, 5, 23), bt("Tesla", false, 30, 3, 21)] },
  ],
};
const brand = (b: string, mentions: number, share: number, mentionRate: number, isTracked = false): MentionsBrandLive => ({ brand: b, mentions, prompts: 10, share, mentionRate, avgPosition: 3, isTracked });
const BRANDS: MentionsBrandLive[] = [brand("Kia", 300, 30, 40, true), brand("Hyundai", 290, 29, 45, true), brand("Toyota", 120, 12, 23), brand("Tesla", 110, 11, 21), brand("BMW", 90, 9, 18)];

// ── brand groups ──────────────────────────────────────────────────────────────────────────

// production top-100 (admin, no filter, round 2026-10-19) — every name has a group in the table
const REAL_TOP_100 =
  "Kia,Hyundai,Toyota,Genesis,Tesla,BMW,Mercedes-Benz,Porsche,Honda,Volkswagen,Lexus,Volvo,BYD,Mazda,Audi,Ford,Renault,Polestar,Ferrari,Škoda,Lucid,Subaru,Rivian,Rolls-Royce,Geely,Suzuki,Nissan,Chevrolet,Bentley,XPeng,Peugeot,Aston Martin,Dacia,General Motors,Lamborghini,NIO,MG,Xiaomi,Zeekr,Stellantis,Fiat,MINI,Jeep,Chery,Cadillac,Citroën,Mitsubishi,Alfa Romeo,Land Rover,Maserati,Tata,Bugatti,Lotus,GWM,Jaguar,Wuling,Range Rover,CUPRA,McLaren,Mahindra,SAIC,Opel,Acura,GAC,Rimac,GMC,Li Auto,SEAT,Buick,Huawei,Changan,Denza,Haval,VinFast,Formula 1,Daimler,Maybach,Apollo,Isuzu,Daihatsu,Alexa,Chrysler,Waze,Alphabet,Proton,Leapmotor,DS Automobiles,Togg,Alpine,Lincoln,Dodge,Giorgio Armani,Ram,Mobis,Maruti,G2,Great Wall Motor,Aito,Ora,BrightDrop".split(",");

describe("brand groups (static table, product decision 2026-10-21)", () => {
  it("maps every production top-100 name", () => {
    expect(REAL_TOP_100).toHaveLength(100);
    expect(REAL_TOP_100.filter((b) => !isMappedBrand(b))).toEqual([]);
  });
  it("folds case, accents and punctuation", () => {
    expect(brandFoldKey("Škoda")).toBe("skoda");
    expect(parentGroupOf("Škoda")).toBe("VW");
    expect(parentGroupOf("MINI")).toBe("BMW");
    expect(parentGroupOf("Citroën")).toBe("Stellantis");
  });
  it("follows the ownership rules", () => {
    expect(parentGroupOf("Maybach")).toBe("Mercedes-Benz");
    expect(parentGroupOf("Range Rover")).toBe("Tata");
    expect(parentGroupOf("Wuling")).toBe("SAIC");
    expect(parentGroupOf("Aston Martin")).toBe("Aston Martin"); // minority stake → independent
    expect(parentGroupOf("Leapmotor")).toBe("Leapmotor");
    expect(parentGroupOf("Alexa")).toBe(NON_AUTO_GROUP);
    expect(parentGroupOf("Brand New Motors")).toBe("Brand New Motors"); // unknown → own group
  });
});

// ── Δ precedence ──────────────────────────────────────────────────────────────────────────

describe("resolveDelta — the original's precedence", () => {
  const compare = (metric: CompareResult["metric"], delta: number | null, reason: CompareResult["reason"] = null) =>
    ({ metric, unit: "pp", prev: 1, cur: 2, delta, suppressed: delta == null, reason, cyclesPrev: 4, cyclesCur: 4, plannedPrev: 4, plannedCur: 4, missingSharePrev: 0, missingShareCur: 0 }) as unknown as CompareResult;
  const cycle = { pp: 1.2, basisDate: "2026-10-12" };
  const prev = { cur: 50, prev: 47.5, asOf: "2026-09-07" };
  it("period compare wins, then the cycle Δ, then the previous snapshot", () => {
    const period = { compare: [compare("visibility", -0.04)], days: 30, kind: "window" as const };
    expect(resolveDelta({ period, compareKey: "visibility", cycle, prev })).toMatchObject({ value: 0, basis: { kind: "period" } });
    expect(resolveDelta({ period, compareKey: "share", cycle, prev })).toEqual({ value: 1.2, basis: { kind: "cycle", date: "2026-10-12" } });
    expect(resolveDelta({ period: null, compareKey: "share", cycle: null, prev })).toEqual({ value: 2.5, basis: { kind: "prev", date: "2026-09-07" } });
    expect(resolveDelta({ period: null, compareKey: null, cycle: null, prev: null })).toEqual({ value: null, basis: null });
  });
  it("a suppressed period result shows no value and keeps the reason", () => {
    const period = { compare: [compare("share", null, "no_prev")], days: 7, kind: "window" as const };
    const d = resolveDelta({ period, compareKey: "share", cycle, prev });
    expect(d.value).toBeNull();
    expect(d.basis).toMatchObject({ kind: "period", caption: { key: "reason.noPrevWindow", params: { days: 7 } } });
  });
});

// ── hero + board ──────────────────────────────────────────────────────────────────────────

describe("rateHero / board", () => {
  const hero = rateHero("exposure", SUB, null, ENGINE, null);
  it("hero value = the original kpiHero (answer-level DISTINCT, not a sum of brand rates)", () => {
    expect(hero.pct).toBe(kpiHero(SUB, "exposure").pct);
    expect(hero.pct).toBe(50);
    expect(hero.points.map((p) => p.pct)).toEqual([45, 47.5, 50]);
  });
  it("one 당사 row, competitors from the original competitor rows, ranked by value", () => {
    const b = board({ metric: "exposure", brands: BRANDS, trend: TREND, values: null, hero });
    expect(b.rows.map((r) => r.key)).toEqual([OWN_KEY, "Toyota", "Tesla", "BMW"]);
    expect(b.ownRank).toBe(1);
    const toyota = b.rows.find((r) => r.key === "Toyota")!;
    expect(toyota).toMatchObject({ pct: 23, gap: -27, delta: 1, covered: true });
    expect(toyota.spark).toEqual([20, 22, 23]);
    // BMW is outside the trend series: value yes, trend no, cannot be compared
    expect(b.rows.find((r) => r.key === "BMW")).toMatchObject({ pct: 18, spark: [], delta: null, covered: false });
    // the 당사 spark is the hero trend on the brand axis
    expect(b.rows[0].spark).toEqual([45, 47.5, 50]);
  });
});

// ── brand detail ──────────────────────────────────────────────────────────────────────────

describe("bump / share Δ", () => {
  it("ranks 당사 (tracked brands summed) and the competitor series by mentions each week", () => {
    const d = bumpData(TREND)!;
    expect(d.x).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    const own = d.series.find((s) => s.own)!;
    expect(own.mentions).toEqual([190, 200, 200]);
    expect(own.shares).toEqual([19, 20, 20]);
    expect(d.series.find((s) => s.key === "Toyota")!.ranks).toEqual([3, 2, 2]);
    expect(d.series.find((s) => s.key === "Tesla")!.ranks).toEqual([2, 3, 3]);
  });
  it("share Δ = last two slots (pp); 당사 = sum of tracked shares", () => {
    const d = shareDeltas(TREND);
    expect(d.get("Toyota")).toBe(1);
    expect(d.get("Tesla")).toBe(0);
    expect(d.get(OWN_KEY)).toBe(0);
    expect(d.has("BMW")).toBe(false);
  });
});

describe("treemap groups", () => {
  const tb = (b: string, value: number, own = false): TreemapBrand => ({ brand: b, value, share: 0, delta: own ? 0.5 : null, own, sibling: false });
  it("groups by parent, keeps 당사, folds small groups and non-automakers", () => {
    const groups = treemapGroups([tb("Hyundai", 300, true), tb("Kia", 280, true), tb("Toyota", 200), tb("Lexus", 60), tb("Tesla", 150), tb("Alexa", 30), tb("Togg", 2)]);
    expect(groups.map((g) => g.key)).toEqual(["HMG", "Toyota", "Tesla", TREEMAP_FOLD]);
    const hmg = groups[0];
    expect(hmg).toMatchObject({ own: true, value: 580, delta: 1, partial: false });
    expect(groups[3].members.map((m) => m.brand)).toEqual(["Alexa", "Togg"]);
  });
  it("squarify keeps every area", () => {
    const rects = squarify([{ value: 6 }, { value: 6 }, { value: 4 }, { value: 3 }, { value: 2 }, { value: 2 }, { value: 1 }], 0, 0, 600, 400);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(240000, 3);
    expect(rects.every((r) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-6 && r.y + r.h <= 400 + 1e-6)).toBe(true);
  });
});

describe("type comparison", () => {
  const zero = { mention: 0, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 };
  const TB: MentionTypesByBrand = {
    totals: { mention: 1000, recommendation: 200, comparison: 100, definition: 50, final_choice: 40 },
    brands: [
      { brand: "Kia", isTracked: true, types: { ...zero, mention: 300, recommendation: 40, final_choice: 6 } },
      { brand: "Hyundai", isTracked: true, types: { ...zero, mention: 200, recommendation: 30, final_choice: 4 } },
      { brand: "Toyota", isTracked: false, types: { ...zero, mention: 150, recommendation: 50, final_choice: 12 } },
      { brand: "Tesla", isTracked: false, types: { ...zero, mention: 100, recommendation: 20, final_choice: 8 } },
    ],
  };
  it("own = all tracked brands' share of the type; ref = the leading compare brand", () => {
    const rows = typeCompareRows({ typesByBrand: TB, brands: BRANDS, compare: ["Toyota"] });
    expect(rows.map((r) => r.type)).toEqual(["final_choice", "recommendation", "comparison", "definition", "mention"]);
    expect(rows[0]).toMatchObject({ own: 25, avg: 25, ref: { brand: "Toyota", value: 30 }, gap: -5 });
    expect(rows[1]).toMatchObject({ own: 35, ref: { brand: "Toyota", value: 25 }, gap: 10 });
  });
  it("without compare brands the reference is the competitor average", () => {
    const rows = typeCompareRows({ typesByBrand: TB, brands: BRANDS, compare: [] });
    expect(rows[0].ref).toEqual({ brand: null, value: 25 });
  });
});

describe("findings", () => {
  it("picks at most four, highest priority first", () => {
    const hero = rateHero("exposure", SUB, null, ENGINE, null);
    const ex = board({ metric: "exposure", brands: BRANDS, trend: TREND, values: null, hero });
    const sovHero = rateHero("sov", SUB, null, ENGINE, null);
    const sov = board({ metric: "sov", brands: BRANDS, trend: TREND, values: null, hero: sovHero });
    const list = findings({ exposure: ex, sov, bump: bumpData(TREND), engines: [{ engine: "gemini", own: 40, avg: 38, avgCount: 30, gap: 2, series: [], delta: null }] });
    expect(list.length).toBeLessThanOrEqual(4);
    expect(list.map((f) => f.pri)).toEqual([...list.map((f) => f.pri)].sort((a, b) => b - a));
    expect(list.find((f) => f.kind === "engine")).toMatchObject({ tone: "warn", params: { engine: "gemini", gap: 2 } });
    expect(list.find((f) => f.kind === "mover")).toMatchObject({ brand: "Toyota", params: { delta: 1 } });
  });
});
