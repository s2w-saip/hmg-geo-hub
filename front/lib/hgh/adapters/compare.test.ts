import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import {
  computeCompare,
  suppressionOf,
  COMPARE_METRIC_UNITS,
  type CompareMetricKey,
  type ComparePeriod,
  type CompareResult,
  type CompareUnit,
} from "@/lib/kpi/period-compare";
import { periodChip } from "@/lib/kpi/period-compare-view";

// Period comparison adapter (K-2): unit mapping with hand-computed values, the call rule
// (no call without a closed period) and legacy/api parity. Parity method: the legacy pure core
// computeCompare (lib/kpi/period-compare.ts, what fetchPeriodCompare returns after its reads)
// runs on two periods; a backend model turns the SAME periods into CompareItems with the
// documented backend arithmetic (Ratio/RankAvg integer pairs, delta = round1(...), the same
// six-reason precedence); the adapter converts them back. Field-by-field diff must equal
// KNOWN_DIFF.

const { bindHghAuth } = await import("../auth");
const C = await import("./compare");

type Item = components["schemas"]["CompareItem"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";

const item = (i: Partial<Item> & Pick<Item, "metric" | "unit" | "cur" | "prev">): Item => ({
  cycles_cur: 2,
  cycles_prev: 2,
  delta: null,
  family: "mention",
  missing_share_cur: 0,
  missing_share_prev: 0,
  planned_cur: 10,
  planned_prev: 10,
  reason: null,
  suppressed: false,
  ...i,
});

describe("toCompareResult: API item -> legacy CompareResult", () => {
  it("WU-9 unsupported (backend compare_suppress) = legacy emptyCompare result, chip '―'", () => {
    const blank = { key: "b", lo: "2026-09-01", hi: "2026-09-14", measures: {}, ledger: { plannedUnits: 0, missingUnits: 0, publishedCycles: 0, dataCycles: 0, firstPublishedAnchor: null } };
    const legacy = computeCompare(blank, blank, { kind: "window", days: 14, metrics: ["visibility", "position"], unsupported: true });
    const api = C.toCompareResults(
      [
        item({ metric: "visibility", unit: "pp", prev: { num: 0, den: 0 }, cur: { num: 0, den: 0 }, suppressed: true, reason: "unsupported", cycles_prev: 0, cycles_cur: 0, planned_prev: 0, planned_cur: 0 }),
        item({ metric: "position", unit: "rank", prev: { sum: 0, count: 0 }, cur: { sum: 0, count: 0 }, suppressed: true, reason: "unsupported", cycles_prev: 0, cycles_cur: 0, planned_prev: 0, planned_cur: 0 }),
      ],
      ["visibility", "position"],
    );
    expect(api).toEqual(legacy);
  });

  it("delta: legacy deltaOf on the pairs (raw), null when suppressed", () => {
    expect(C.legacyCompareDelta("pp", 0.25, 0.3)).toBeCloseTo(5, 12);
    expect(C.legacyCompareDelta("rank", 2.5, 2)).toBe(-0.5);
    expect(C.legacyCompareDelta("pct", 0, 1)).toBeNull();
    expect(C.legacyCompareDelta("pct", 2, 3)).toBe(50);
    expect(C.legacyCompareDelta("pp", null, 0.3)).toBeNull();
    const sup = C.toCompareResult(item({ metric: "visibility", unit: "pp", prev: { num: 1, den: 4 }, cur: { num: 1, den: 2 }, delta: 25, suppressed: true, reason: "missing_share" }));
    expect(sup?.delta).toBeNull();
  });

  it("ratio metric: fraction num/den (no x100), keys camelCase, share_of_voice -> share", () => {
    const r = C.toCompareResult(
      item({
        metric: "share_of_voice",
        unit: "pp",
        prev: { num: 1, den: 4 },
        cur: { num: 3, den: 10 },
        delta: 5,
        cycles_prev: 1,
        cycles_cur: 3,
        planned_prev: 7,
        planned_cur: 9,
        missing_share_prev: 0.25,
        missing_share_cur: 0,
      }),
    );
    // prev 1/4 = 0.25, cur 3/10 = 0.3, delta (0.3 - 0.25) x 100 = 4.999999999999999 (legacy raw float,
    // recomputed from the pairs; the backend round1 5 is not used, WU-9). The chip rounds to 5.0
    expect(r).toEqual({
      metric: "share",
      unit: "pp",
      prev: 0.25,
      cur: 0.3,
      delta: (0.3 - 0.25) * 100,
      suppressed: false,
      reason: null,
      cyclesPrev: 1,
      cyclesCur: 3,
      plannedPrev: 7,
      plannedCur: 9,
      missingSharePrev: 0.25,
      missingShareCur: 0,
    });
  });

  it("rank metric: sum/count; empty denominators -> null", () => {
    const r = C.toCompareResult(item({ metric: "position", unit: "rank", prev: { sum: 9, count: 4 }, cur: { sum: 0, count: 0 } }));
    expect(r?.prev).toBe(2.25); // 9 / 4
    expect(r?.cur).toBeNull();
    const z = C.toCompareResult(item({ metric: "visibility", unit: "pp", prev: { num: 0, den: 0 }, cur: { num: 1, den: 2 } }));
    expect(z?.prev).toBeNull();
    expect(z?.cur).toBe(0.5);
  });

  it("sentiment -> favorability, per-answer metrics renamed, citation_share has no legacy key", () => {
    expect(C.toCompareResult(item({ metric: "sentiment", unit: "pp", prev: { num: 1, den: 2 }, cur: { num: 1, den: 2 } }))?.metric).toBe("favorability");
    expect(C.toCompareResult(item({ metric: "mentions_per_answer", unit: "pct", prev: { num: 3, den: 2 }, cur: { num: 3, den: 2 } }))?.metric).toBe(
      "mentionsPerAnswer",
    );
    expect(C.toCompareResult(item({ metric: "citation_share", unit: "pp", prev: { num: 1, den: 2 }, cur: { num: 1, den: 2 } }))).toBeNull();
  });

  it("results follow the requested order; a metric the answer lacks is skipped", () => {
    const items = [
      item({ metric: "position", unit: "rank", prev: { sum: 2, count: 1 }, cur: { sum: 2, count: 1 } }),
      item({ metric: "visibility", unit: "pp", prev: { num: 1, den: 2 }, cur: { num: 1, den: 2 } }),
    ];
    expect(C.toCompareResults(items, ["visibility", "share", "position"]).map((r) => r.metric)).toEqual(["visibility", "position"]);
  });
});

describe("fetchPeriodCompareApi: call rule (legacy selectedWindow)", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        calls.push(String(u));
        return new Response(
          JSON.stringify({
            data: [item({ metric: "visibility", unit: "pp", prev: { num: 1, den: 4 }, cur: { num: 1, den: 2 }, delta: 25 })],
            meta: { mode: "cumulative", compare: { kind: "window", first_published: "2026-07-06", windows: null } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["no period", {}],
    ["only from", { dateFrom: "2026-09-01" }],
    ["only to", { dateTo: "2026-09-14" }],
    ["reversed", { dateFrom: "2026-09-14", dateTo: "2026-09-01" }],
  ])("%s -> null without a backend call (previous Δ)", async (_n, f) => {
    await expect(C.fetchPeriodCompareApi(f, { surface: "global", scope: null, kind: "window", metrics: ["visibility"] })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("WU-9 epoch gate: meta.suppressed[*] before_epoch -> null (previous Δ) after one call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        calls.push(String(u));
        return new Response(
          JSON.stringify({
            data: [],
            meta: { mode: "cumulative", suppressed: { "*": "before_epoch" }, compare: { kind: "window", first_published: null, windows: null } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await expect(
      C.fetchPeriodCompareApi({ dateFrom: "2026-09-01", dateTo: "2026-09-07" }, { surface: "global", scope: null, kind: "window", metrics: ["visibility"] }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("closed period -> one call, results in the legacy shape", async () => {
    const r = await C.fetchPeriodCompareApi(
      { dateFrom: "2026-09-01", dateTo: "2026-09-14" },
      { surface: "website", scope: null, kind: "calendarWeek", metrics: ["visibility", "favorability"] },
    );
    expect(calls).toHaveLength(1);
    const q = new URL(calls[0]).searchParams;
    expect(q.getAll("kind")).toEqual(["calendarWeek"]);
    expect(q.getAll("metrics")).toEqual(["visibility", "sentiment"]);
    expect(q.get("surface")).toBe("website");
    expect(r).toEqual([
      expect.objectContaining({ metric: "visibility", prev: 0.25, cur: 0.5, delta: 25, suppressed: false }),
    ]);
  });
});

// ── legacy / api parity ─────────────────────────────────────────────────────

/** Backend model: CompareItem[] from the two periods (documented K-2 arithmetic). */
const API_NAME: Record<CompareMetricKey, Item["metric"]> = {
  visibility: "visibility",
  share: "share_of_voice",
  favorability: "sentiment",
  position: "position",
  mentionsPerAnswer: "mentions_per_answer",
  citationsPerAnswer: "citations_per_answer",
};
const round1 = (x: number) => Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * 10) / 10; // back core.measure.round1
function modelDelta(unit: CompareUnit, p: number | null, c: number | null): number | null {
  if (p == null || c == null) return null;
  if (unit === "pp") return round1((c - p) * 100);
  if (unit === "rank") return round1(c - p);
  return p === 0 ? null : round1(((c - p) / p) * 100);
}
function backendModel(prev: ComparePeriod, cur: ComparePeriod, kind: "window" | "calendarMonth" | "calendarWeek", metrics: CompareMetricKey[], days: number): Item[] {
  // Suppression precedence is a port of the legacy rule set (back kpi/compare/logic.py).
  const reason = suppressionOf(prev, cur, { kind, days, metrics });
  const missing = (l: ComparePeriod["ledger"]) => (l.plannedUnits > 0 ? l.missingUnits / l.plannedUnits : 0);
  return metrics.map((m) => {
    const unit = COMPARE_METRIC_UNITS[m];
    const pm = prev.measures[m];
    const cm = cur.measures[m];
    const pair = (x: { numerator: number; denominator: number } | undefined) =>
      m === "position"
        ? { sum: x?.numerator ?? 0, count: x?.denominator ?? 0 }
        : { num: x?.numerator ?? 0, den: x?.denominator ?? 0 };
    const val = (x: { numerator: number; denominator: number } | undefined) => (x && x.denominator > 0 ? x.numerator / x.denominator : null);
    return item({
      metric: API_NAME[m],
      unit,
      prev: pair(pm),
      cur: pair(cm),
      delta: reason ? null : modelDelta(unit, val(pm), val(cm)),
      suppressed: reason !== null,
      reason,
      cycles_prev: prev.ledger.publishedCycles,
      cycles_cur: cur.ledger.publishedCycles,
      planned_prev: prev.ledger.plannedUnits,
      planned_cur: cur.ledger.plannedUnits,
      missing_share_prev: missing(prev.ledger),
      missing_share_cur: missing(cur.ledger),
    });
  });
}

const ledger = (l: Partial<ComparePeriod["ledger"]> = {}): ComparePeriod["ledger"] => ({
  plannedUnits: 100,
  missingUnits: 0,
  publishedCycles: 2,
  dataCycles: 2,
  firstPublishedAnchor: "2026-06-01",
  ...l,
});
const METRICS: CompareMetricKey[] = ["visibility", "share", "favorability", "position", "mentionsPerAnswer"];
const measures = (v: number, s: number, f: number, pos: [number, number], mpa: [number, number]) => ({
  visibility: { numerator: v, denominator: 300 },
  share: { numerator: s, denominator: 900 },
  favorability: { numerator: f, denominator: 400 },
  position: { numerator: pos[0], denominator: pos[1] },
  mentionsPerAnswer: { numerator: mpa[0], denominator: mpa[1] },
});

const CASES: { name: string; kind: "window" | "calendarMonth" | "calendarWeek"; days: number; prev: ComparePeriod; cur: ComparePeriod }[] = [
  {
    name: "14-day window, all metrics comparable",
    kind: "window",
    days: 14,
    prev: { key: "p", lo: "2026-08-18", hi: "2026-08-31", measures: measures(201, 333, 250, [505, 200], [700, 300]), ledger: ledger() },
    cur: { key: "c", lo: "2026-09-01", hi: "2026-09-14", measures: measures(222, 301, 263, [488, 210], [690, 310]), ledger: ledger() },
  },
  {
    name: "30-day window, missing share 40% -> suppressed missing_share",
    kind: "window",
    days: 30,
    prev: { key: "p", lo: "2026-07-17", hi: "2026-08-15", measures: measures(100, 200, 150, [300, 100], [400, 200]), ledger: ledger({ missingUnits: 40 }) },
    cur: { key: "c", lo: "2026-08-16", hi: "2026-09-14", measures: measures(120, 210, 160, [290, 110], [410, 205]), ledger: ledger() },
  },
  {
    name: "no published round before -> no_prev",
    kind: "calendarWeek",
    days: 7,
    prev: { key: "p", lo: "2026-09-01", hi: "2026-09-07", measures: {}, ledger: ledger({ publishedCycles: 0, dataCycles: 0 }) },
    cur: { key: "c", lo: "2026-09-08", hi: "2026-09-14", measures: measures(10, 20, 30, [40, 20], [50, 25]), ledger: ledger() },
  },
];

/** Differing fields per case with their reason. An unexpected one fails, and so does a declared one that disappears. */
const KNOWN_DIFF: Record<string, { path: RegExp; reason: string }[]> = {
  // WU-9 (decisions 19/24/25): the adapter recomputes delta with the legacy deltaOf from the integer
  // pairs, so the former U4-N2 differences (pre-rounded delta, favorability 250/400 -> 263/400 =
  // +3.25pp chip 3.3 vs legacy 3.2) are gone. The declared-disappears check would catch a regression.
  "14-day window, all metrics comparable": [],
  "30-day window, missing share 40% -> suppressed missing_share": [],
  "no published round before -> no_prev": [],
};

function diffPaths(a: CompareResult[], b: CompareResult[]): string[] {
  const out: string[] = [];
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => {
    for (const k of Object.keys(x) as (keyof CompareResult)[]) {
      if (!Object.is(x[k], b[i][k]) && JSON.stringify(x[k]) !== JSON.stringify(b[i][k])) out.push(`${i}.${k}`);
    }
  });
  return out;
}

describe("legacy/api parity: computeCompare vs adapter(backend model)", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (name, c) => {
    const legacy = computeCompare(c.prev, c.cur, { kind: c.kind, days: c.days, metrics: METRICS });
    const api = C.toCompareResults(backendModel(c.prev, c.cur, c.kind, METRICS, c.days), METRICS);
    // What the screen draws (chip value, direction, suppression) is diffed too.
    const chips = (rs: CompareResult[]) => rs.map((r) => periodChip({ metric: r.metric, delta: r.delta }));
    const legacyChips = chips(legacy);
    const apiChips = chips(api);
    const chipDiff: string[] = [];
    legacyChips.forEach((ch, i) => {
      for (const k of Object.keys(ch) as (keyof typeof ch)[]) if (ch[k] !== apiChips[i][k]) chipDiff.push(`chip.${i}.${k}`);
    });
    const diff = [...diffPaths(legacy, api), ...chipDiff];
    const declared = KNOWN_DIFF[name];
    for (const p of diff) expect(declared.some((d) => d.path.test(p)), `undeclared difference ${p}`).toBe(true);
    for (const d of declared) expect(diff.some((p) => d.path.test(p)), `declared difference ${d.path} disappeared`).toBe(true);
  });

  it("WU-9: exact .x5 boundary keeps the legacy chip (250/400 -> 263/400 = 3.2, backend round1 would be 3.3)", () => {
    const api = C.toCompareResults(backendModel(CASES[0].prev, CASES[0].cur, "window", METRICS, 14), METRICS);
    const fav = api.find((r) => r.metric === "favorability")!;
    expect(fav.delta).toBe((263 / 400 - 250 / 400) * 100); // raw legacy float, 3.2499999999999973
    expect(periodChip({ metric: fav.metric, delta: fav.delta }).value).toBe(
      periodChip({ metric: "favorability", delta: computeCompare(CASES[0].prev, CASES[0].cur, { kind: "window", days: 14, metrics: METRICS })[2].delta }).value,
    );
  });

  it("hand check of case 1: visibility 201/300 -> 222/300 = +7.0pp", () => {
    const api = C.toCompareResults(backendModel(CASES[0].prev, CASES[0].cur, "window", METRICS, 14), METRICS);
    expect(api[0]).toMatchObject({ metric: "visibility", prev: 0.67, cur: 0.74, delta: (222 / 300 - 201 / 300) * 100 }); // 6.999999999999995
    expect(periodChip({ metric: "visibility", delta: api[0].delta }).value).toBe(periodChip({ metric: "visibility", delta: 7 }).value);
    expect(api[3]).toMatchObject({ metric: "position", prev: 2.525, unit: "rank" }); // 505 / 200
  });
});
