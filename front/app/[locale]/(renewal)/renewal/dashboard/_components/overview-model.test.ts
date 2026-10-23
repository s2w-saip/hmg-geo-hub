import { describe, expect, it } from "vitest";
import type { GeoCountryRow, GeoRegionRow } from "@/app/[locale]/(dash)/dashboard/_data/live";
import type { GeoMetrics, OverviewKpiKey } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import { barWidth, brandMatrix, gapOf, heatBinner, marketColumns, marketRival, rivalValue, sortCountries, standing } from "./overview-model";

const KEYS: OverviewKpiKey[] = ["visibility", "shareOfVoice", "sentiment", "position", "citationShare"];
const byKey = <T>(f: (k: OverviewKpiKey) => T) => Object.fromEntries(KEYS.map((k) => [k, f(k)])) as Record<OverviewKpiKey, T>;

const metrics = (v: Partial<Record<OverviewKpiKey, number | null>>, rival = "Toyota", rv: Partial<Record<OverviewKpiKey, number | null>> = {}): GeoMetrics =>
  byKey((k) => ({ ours: v[k] ?? null, rival: k === "citationShare" ? null : { name: rival, value: rv[k] ?? null } }));

const country = (code: string, v: Partial<Record<OverviewKpiKey, number | null>>): GeoCountryRow => ({
  code,
  country: code,
  hmgSov: v.shareOfVoice ?? 0,
  hmgRank: 1,
  fieldSize: 2,
  topBrand: null,
  topRival: null,
  metrics: metrics(v),
});

describe("standing — 당사 place among the card's competitors", () => {
  it("rates: higher is ahead, a tie keeps 당사 ahead", () => {
    expect(standing("visibility", 40, [{ value: 50 }, { value: 40 }, { value: 10 }])).toEqual({ rank: 2, count: 4 });
  });
  it("rank: lower is ahead", () => {
    expect(standing("position", 2.1, [{ value: 1.5 }, { value: 3 }, { value: 4 }])).toEqual({ rank: 2, count: 4 });
  });
  it("no own value or no competitor value → null", () => {
    expect(standing("visibility", null, [{ value: 1 }])).toBeNull();
    expect(standing("visibility", 10, [{ value: null }])).toBeNull();
  });
});

describe("brandMatrix — brands × 5 KPIs", () => {
  const own = {
    label: "HMG",
    values: byKey((k) => (k === "position" ? 2 : 30)),
    deltas: byKey((k) => (k === "sentiment" ? null : 0.5)),
  };
  const rivals = byKey<Array<{ brand: string; value: number | null; delta?: number | null }>>(() => []);
  rivals.visibility = [{ brand: "Toyota", value: 40, delta: 1 }, { brand: "BMW", value: 20, delta: -0.4 }];
  rivals.shareOfVoice = [{ brand: "toyota", value: 25, delta: null }, { brand: "Tesla", value: 10 }];
  rivals.position = [{ brand: "BMW", value: 1.5, delta: 0.2 }];
  rivals.citationShare = [{ brand: "Mercedes-Benz", value: 4 }];

  const { rows, cols } = brandMatrix(own, rivals);

  it("rows: 당사 first, then the union in KPI order, names folded by brandKey", () => {
    expect(rows.map((r) => r.name)).toEqual(["HMG", "Toyota", "BMW", "Tesla", "Mercedes-Benz"]);
    expect(rows[0].own).toBe(true);
  });
  it("a brand outside a KPI's 4 has no cell there; a folded name still finds its cell", () => {
    const toyota = rows[1];
    expect(toyota.cells.visibility).toEqual({ value: 40, delta: 1 });
    expect(toyota.cells.shareOfVoice).toEqual({ value: 25, delta: null });
    expect(toyota.cells.position).toBeNull();
    expect(rows[3].cells.shareOfVoice).toEqual({ value: 10, delta: null });
  });
  it("own row carries the trend Δ of every KPI", () => {
    expect(rows[0].cells.sentiment).toEqual({ value: 30, delta: null });
    expect(rows[0].cells.visibility).toEqual({ value: 30, delta: 0.5 });
  });
  it("columns: best (rank → lowest), max and the KPI standing", () => {
    const pos = cols.find((c) => c.key === "position")!;
    expect(pos.best).toBe(1.5);
    expect(pos.max).toBe(2);
    expect(pos.standing).toEqual({ rank: 2, count: 2 });
    const vis = cols.find((c) => c.key === "visibility")!;
    expect(vis.best).toBe(40);
    expect(vis.standing).toEqual({ rank: 2, count: 3 });
    expect(cols.find((c) => c.key === "sentiment")!.standing).toBeNull();
  });
});

describe("barWidth", () => {
  it("rates scale to the column max with a 2% floor", () => {
    expect(barWidth("visibility", 20, 40)).toBe(50);
    expect(barWidth("visibility", 0, 40)).toBe(2);
  });
  it("rank grows toward 1위 with a 6% floor", () => {
    expect(barWidth("position", 1, 4)).toBe(100);
    expect(barWidth("position", 9, 9)).toBeCloseTo(11.1, 1);
    expect(barWidth("position", null, 4)).toBe(0);
  });
});

describe("market helpers", () => {
  it("rival: the biggest competitor (one name), its per-KPI value, none for citation share", () => {
    const m = { ...country("DE", { visibility: 30 }), metrics: metrics({ visibility: 30 }, "VW", { visibility: 45, position: 2 }) };
    expect(marketRival(m)).toBe("VW");
    expect(rivalValue(m, "visibility")).toBe(45);
    expect(rivalValue(m, "citationShare")).toBeNull();
  });
  it("legacy market without metrics falls back to topRival for share of voice", () => {
    const m = { hmgSov: 12, hmgRank: 2, fieldSize: 3, topBrand: null, topRival: { name: "Kia", sov: 20 } } as unknown as GeoCountryRow;
    expect(marketRival(m)).toBe("Kia");
    expect(rivalValue(m, "shareOfVoice")).toBe(20);
    expect(rivalValue(m, "visibility")).toBeNull();
  });
  it("gap: + = ahead (rank flips)", () => {
    expect(gapOf("visibility", 30, 45)).toBe(-15);
    expect(gapOf("position", 2.5, 3.1)).toBe(0.6);
    expect(gapOf("visibility", 30, null)).toBeNull();
  });
  it("heat bins: 5 quantile steps, rank darker when lower", () => {
    const vals = [10, 20, 30, 40, 50];
    const rate = heatBinner("visibility", vals);
    expect(vals.map(rate)).toEqual([0, 1, 2, 3, 4]);
    const rank = heatBinner("position", vals);
    expect(vals.map(rank)).toEqual([4, 3, 2, 1, 0]);
    expect(rate(null)).toBeNull();
  });
  it("sortCountries: best first or worst first, missing values last", () => {
    const cs = [country("A", { position: 3 }), country("B", { position: null }), country("C", { position: 1.2 })];
    expect(sortCountries(cs, { key: "position", worst: false }).map((c) => c.code)).toEqual(["C", "A", "B"]);
    expect(sortCountries(cs, { key: "position", worst: true }).map((c) => c.code)).toEqual(["A", "C", "B"]);
  });
  it("marketColumns: places over every region's countries", () => {
    const regions = [
      { region: "r1", countries: [country("A", { visibility: 10 }), country("B", { visibility: 30 })] },
      { region: "r2", countries: [country("C", { visibility: 20 }), country("D", { visibility: null })] },
    ] as unknown as GeoRegionRow[];
    const col = marketColumns(regions).visibility;
    expect(col.count).toBe(3);
    expect(["A", "B", "C", "D"].map(col.nth)).toEqual([3, 1, 2, null]);
    expect(col.bin(30)).toBe(3);
  });
});
