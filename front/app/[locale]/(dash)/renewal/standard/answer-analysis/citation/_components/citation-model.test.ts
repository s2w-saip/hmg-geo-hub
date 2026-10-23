import { describe, expect, it } from "vitest";
import type { CitationDomainLive, CitationsLive, CitationTrend } from "@/lib/scope/result-adapter";
import {
  categoryDelta,
  categoryRows,
  categoryShareSeries,
  deltaAxis,
  domainBump,
  engineMatrix,
  findings,
  lens,
  matrix,
  officialDelta,
  rankedDomains,
  strongestSkew,
  typeMatrix,
  type PrevCategories,
} from "./citation-model";

const HMG = "Official (HMG)";
const COMP = "Official (Competitor)";
const DEALER = "Dealer & Marketplace";
const AUTO = "Automotive Media";
const NEWS = "News & Media";

const dom = (domain: string, category: string, citations: number, isOurs = false): CitationDomainLive => ({
  domain,
  category,
  citations,
  share: 0,
  prompts: 1,
  coverageRate: 0,
  urls: [],
  promptList: [],
  isOurs,
  subcategory: null,
});

const live = (over: Partial<CitationsLive> = {}): CitationsLive => ({
  summary: { total: 1000, uniqueDomains: 9 },
  asOf: "2026-10-19",
  domains: [dom("hyundai.com", HMG, 150, true), dom("caranddriver.com", AUTO, 200), dom("motortrend.com", AUTO, 100), dom("toyota.com", COMP, 80), dom("tesla.com", COMP, 40), dom("cars.com", DEALER, 90), dom("reuters.com", NEWS, 60), dom("kia.com", HMG, 50, true), dom("edmunds.com", AUTO, 50)],
  categories: [
    { name: AUTO, value: 400 },
    { name: HMG, value: 250 },
    { name: COMP, value: 150 },
    { name: DEALER, value: 120 },
    { name: NEWS, value: 80 },
  ],
  trend: null,
  categoryTrend: null,
  engineCategories: null,
  ...over,
});

const prev: PrevCategories = { totals: { total: 1000, byCategory: { [AUTO]: 380, [HMG]: 270, [COMP]: 150, [DEALER]: 120, [NEWS]: 80 } }, asOf: "2026-10-12" };

describe("Δ rules (the original's CategoryDelta / OfficialDelta)", () => {
  it("compares the card value with the previous round; the api's current round wins when present", () => {
    expect(categoryDelta(prev, AUTO, 40)).toBe(2);
    expect(categoryDelta({ ...prev!, current: { total: 500, byCategory: { [AUTO]: 205 } } }, AUTO, 40)).toBe(3);
    expect(categoryDelta(null, AUTO, 40)).toBeNull();
  });
  it("official Δ: the Overview card Δ first, then the category Δ", () => {
    expect(officialDelta({ delta: -1.4, basisDate: "2026-10-12" }, prev, 25)).toEqual({ value: -1.4, basis: "card", date: "2026-10-12" });
    expect(officialDelta(null, prev, 25)).toEqual({ value: -2, basis: "category", date: "2026-10-12" });
    expect(officialDelta(null, null, 25).basis).toBeNull();
  });
});

describe("weekly category shares", () => {
  it("divides by the week's total and leaves gap weeks empty", () => {
    const trend: CitationTrend = {
      series: [AUTO, HMG],
      points: [
        { week: "2026-10-05", [AUTO]: 30, [HMG]: 10 },
        { week: "2026-10-12", [AUTO]: null, [HMG]: null, gap: { reason: "collection" } as never },
        { week: "2026-10-19", [AUTO]: 25, [HMG]: 25 },
      ],
    };
    const s = categoryShareSeries(trend)!;
    expect(s.weeks).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(s.byCategory.get(AUTO)).toEqual([75, null, 50]);
    expect(s.byCategory.get(HMG)).toEqual([25, null, 50]);
  });
});

describe("출처 구성 rows", () => {
  it("ranks by citations with shares of all citations, Δ per category and top domains", () => {
    const rows = categoryRows({ live: live(), prev, card: null, picked: new Set() });
    expect(rows.map((r) => r.name)).toEqual([AUTO, HMG, COMP, DEALER, NEWS]);
    expect(rows[0]).toMatchObject({ value: 400, pct: 40, prevPct: 38, delta: 2 });
    expect(rows[0].top).toEqual([
      { domain: "caranddriver.com", pct: 50 },
      { domain: "motortrend.com", pct: 25 },
      { domain: "edmunds.com", pct: 12.5 },
    ]);
  });
  it("Δ bars share one axis: the largest change, at least ±0.5pp", () => {
    expect(deltaAxis([{ delta: 0.1 }, { delta: -1.43 }, { delta: null }])).toBe(1.5);
    expect(deltaAxis([{ delta: 0.2 }, { delta: -0.1 }])).toBe(0.5);
  });
  it("the 공식(HMG) row carries the tile's Δ (card first)", () => {
    const rows = categoryRows({ live: live(), prev, card: { delta: -1.4, basisDate: "2026-10-12" }, picked: new Set() });
    expect(rows.find((r) => r.name === HMG)?.delta).toBe(-1.4);
  });
  it("a competitor pick narrows 공식(경쟁사) to the picks, keeps the denominator and hides that Δ", () => {
    const rows = categoryRows({ live: live(), prev, card: null, picked: new Set(["toyota.com"]) });
    const comp = rows.find((r) => r.name === COMP)!;
    expect(comp).toMatchObject({ value: 80, pct: 8, delta: null, deltaHidden: true, prevPct: null });
    expect(rows.find((r) => r.name === HMG)?.pct).toBe(25);
  });
});

describe("개요 tiles", () => {
  const base = { prev, card: null, sections: null };
  it("split states: ok / 공식(HMG) excluded / not computed (legacy + 출처 filter) / none owned / degraded", () => {
    const split = { owned: [], uncited: [], ownedCount: 57, uncitedCount: 39 };
    expect(lens({ ...base, live: live({ promptSplit: split }), active: [] }).split).toEqual({ kind: "ok", owned: 57, uncited: 39 });
    expect(lens({ ...base, live: live({ promptSplit: split }), active: [AUTO] }).split.kind).toBe("noOwnCategory");
    expect(lens({ ...base, live: live({ promptSplit: undefined }), active: [HMG] }).split.kind).toBe("notComputed");
    expect(lens({ ...base, live: live({ promptSplit: null }), active: [] }).split.kind).toBe("noOwned");
    expect(lens({ ...base, sections: { split: true }, live: live({ promptSplit: null }), active: [] }).split.kind).toBe("degraded");
  });
  it("shares = the composition shares; dealer Δ vs the previous round", () => {
    const l = lens({ ...base, live: live(), active: [] });
    expect(l.hmg.value).toBe(25);
    expect(l.hmg.delta.value).toBe(-2);
    expect(l.dealer).toMatchObject({ value: 12, delta: { value: 0, basis: "category" } });
  });
  it("a category the 출처 filter leaves out has no share (not 0.0%)", () => {
    const l = lens({ ...base, live: live({ categories: [{ name: AUTO, value: 400 }] }), active: [AUTO] });
    expect([l.hmg.value, l.dealer.value]).toEqual([null, null]);
  });
});

describe("source preference matrix", () => {
  const order = [AUTO, HMG, NEWS];
  it("전체 = the columns' citation-weighted share; colour only for 2+ columns with ≥ 30 citations", () => {
    const m = matrix(
      [
        { key: "chatgpt", total: 100, byCategory: { [AUTO]: 50, [HMG]: 30, [NEWS]: 20 } },
        { key: "gemini", total: 300, byCategory: { [AUTO]: 90, [HMG]: 120, [NEWS]: 90 } },
        { key: "thin", total: 20, byCategory: { [AUTO]: 20 } },
      ],
      order,
    );
    expect(m.rows).toEqual(order);
    expect(m.base[AUTO]).toBeCloseTo((100 * 160) / 420);
    expect(m.cols[0].shares[AUTO]).toBe(50);
    expect(m.live).toEqual(["chatgpt", "gemini"]);
    expect(m.cap).toBeGreaterThanOrEqual(3);
    expect(matrix([{ key: "chatgpt", total: 100, byCategory: { [AUTO]: 100 } }], order).live).toEqual([]);
  });
  it("types run strongest endorsement first; the skew skips 공식(HMG)", () => {
    const t = typeMatrix(
      [
        { type: "mention", total: 200, byCategory: { [HMG]: 100, [AUTO]: 100 } },
        { type: "final_choice", total: 50, byCategory: { [HMG]: 5, [AUTO]: 45 } },
        { type: "recommendation", total: 100, byCategory: { [HMG]: 20, [NEWS]: 80 } },
      ],
      order,
    )!;
    expect(t.cols.map((c) => c.key)).toEqual(["final_choice", "recommendation", "mention"]);
    const sk = strongestSkew(null, t)!;
    expect(sk.category).not.toBe(HMG);
    expect(sk).toMatchObject({ axis: "type", col: "recommendation", category: NEWS });
    expect(engineMatrix(null, order)).toBeNull();
  });
});

describe("domain rank bump", () => {
  const trend: CitationTrend = {
    series: ["hyundai.com", "a.com", "b.com", "c.com"],
    points: [
      { week: "2026-09-28", "hyundai.com": 50, "a.com": 40, "b.com": 30, "c.com": 10 },
      { week: "2026-10-05", "hyundai.com": null, "a.com": null, "b.com": null, "c.com": null, gap: { reason: "x" } as never },
      { week: "2026-10-12", "hyundai.com": 20, "a.com": 40, "b.com": 10, "c.com": 30 },
    ],
  };
  it("ranks per week, skips gap weeks, movers exclude 공식(HMG)", () => {
    const b = domainBump(trend, [dom("hyundai.com", HMG, 1, true)])!;
    expect(b.series[0]).toMatchObject({ own: true, ranks: [1, null, 3] });
    expect(b.series[3].ranks).toEqual([4, null, 2]);
    expect([b.first, b.last]).toEqual([0, 2]);
    expect(b.movers).toEqual([
      { key: "c.com", move: 2 },
      { key: "a.com", move: 1 },
      { key: "b.com", move: -1 },
    ]);
  });
});

describe("findings", () => {
  it("keeps the 4 most important, the 공식(HMG) standing first when it trails", () => {
    const rows = categoryRows({ live: live(), prev, card: null, picked: new Set() });
    const l = lens({ live: live({ promptSplit: { owned: [], uncited: [], ownedCount: 50, uncitedCount: 50 } }), prev, card: null, active: [], sections: null });
    const engine = matrix(
      [
        { key: "chatgpt", total: 200, byCategory: { [HMG]: 20, [AUTO]: 180 } },
        { key: "gemini", total: 200, byCategory: { [HMG]: 60, [AUTO]: 140 } },
      ],
      [AUTO, HMG],
    );
    const out = findings({ rows, hmgDelta: -2, picked: new Set(), engine, type: null, split: l.split, bump: null });
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ kind: "standingTrail", params: { rank: 2, leader: AUTO } });
    expect(out.map((f) => f.kind)).toContain("engineGap");
    expect(out.find((f) => f.kind === "opportunity")).toMatchObject({ href: "uncited", params: { n: 50, share: 50 } });
  });
  it("domain rows are numbered after the competitor pick", () => {
    const rows = rankedDomains(live().domains, new Set(["tesla.com"]));
    expect(rows.find((r) => r.domain === "toyota.com")).toBeUndefined();
    expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
  });
});
