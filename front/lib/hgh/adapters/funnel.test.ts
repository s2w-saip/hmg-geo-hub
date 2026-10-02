import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// AI funnel adapter (unit U8): hand-computed conversions (ACR A1..A7, GA4 conversion C1..C7,
// conversion events), the page branches, the query each call sends (filters through
// analysisQuery, feature parameters apart) and the documented known differences.
// Legacy <-> api parity of the conversion values runs the UNCHANGED legacy GA4 functions in
// funnel.parity.test.ts.

vi.mock("@/lib/scope/server", () => ({}));
const { bindHghAuth } = await import("../auth");
const F = await import("./funnel");

type S = components["schemas"];
type Conv = S["ConversionData"];
type Meta = S["Meta"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const meta = (m: Partial<Meta> = {}): Meta => ({ mode: "snapshot", as_of: "2026-09-14", cycles: ["2026-09-14"], ...m });

// ── ACR ──────────────────────────────────────────────────────────────────────

function acr(o: Partial<S["AcrData"]> = {}): S["AcrData"] {
  return {
    totals: { prompt_runs: 8, prompts: 3, iterations: 20, engines: ["chatgpt", "gemini"], catalog_acr_prompts: 67 },
    brands: [
      { brand: "Hyundai", is_ours: true, choice: 7, appearance: 11, cells: 3, choice_share: { num: 7, den: 20 }, coverage: { num: 3, den: 8 } },
      { brand: "Toyota", is_ours: false, choice: 1, appearance: 2, cells: 1, choice_share: { num: 1, den: 20 }, coverage: { num: 1, den: 8 } },
    ],
    trend: {
      series_brands: ["Hyundai", "Toyota"],
      buckets: [
        { round_date: "2026-09-10", gap: false, den: 3, series: [{ brand: "Hyundai", num: 1 }, { brand: "Toyota", num: 2 }] },
        { round_date: "2026-09-03", gap: false, den: 16, series: [{ brand: "Hyundai", num: 1 }] },
        { round_date: "2026-09-17", gap: true, den: 0, series: [] },
      ],
    },
    battle: [{ prompt_id: "p1", prompt_text: "best suv", cells: [{ engine: "chatgpt", winner_brand: "Hyundai", winner_is_ours: true, choice: 4 }, { engine: "gemini", winner_brand: null, winner_is_ours: false, choice: 0 }] }],
    model_conversion: [{ brand: null, model: "Tucson", is_ours: true, conversion: { num: 2, den: 3 }, cells: 2, top1: 2 }],
    territory: [{ country: "US", engine: "chatgpt", rows: [{ prompt_id: "p1", prompt_text: null, valid_acr: 5, entries: [{ brand: "Hyundai", choice: 4, is_ours: true }] }] }],
    options: { langs: ["de", "en"], countries: ["DE", "US"] },
    ...o,
  };
}

describe("toStandardAcr: A1..A7, hand-computed", () => {
  it("brands, trend, battle, models, territory, totals", () => {
    const a = F.toStandardAcr(acr(), meta());
    expect(a.measured).toBe(true);
    // 7/20 = 35 ; 3/8 = 37.5 ; 1/20 = 5 ; 1/8 = 12.5
    expect(a.brands).toEqual([
      { brand: "Hyundai", isOurs: true, choiceCount: 7, appearanceCount: 11, choiceShare: 35, coverage: 37.5 },
      { brand: "Toyota", isOurs: false, choiceCount: 1, appearanceCount: 2, choiceShare: 5, coverage: 12.5 },
    ]);
    // ascending by round; 1/16 = 6.25 -> 6.3 ; 1/3 = 33.33 -> 33.3 ; 2/3 -> 66.7 ; gap round dropped (U8-N1)
    expect(a.trend).toEqual([
      { date: "2026-09-03", series: { Hyundai: 6.3 } },
      { date: "2026-09-10", series: { Hyundai: 33.3, Toyota: 66.7 } },
    ]);
    expect(a.battle).toEqual([
      {
        promptId: "p1",
        promptText: "best suv",
        cells: [
          { engine: "chatgpt", winner: "Hyundai", winnerIsOurs: true, choiceCount: 4 },
          { engine: "gemini", winner: null, winnerIsOurs: false, choiceCount: 0 },
        ],
      },
    ]);
    // 2/3 -> 66.7
    expect(a.modelConversion).toEqual([{ brand: null, model: "Tucson", isOurs: true, conversionRate: 66.7, shortlistCount: 2, top1Count: 2 }]);
    expect(a.territory).toEqual([
      { region: "US", engine: "chatgpt", rows: [{ promptId: "p1", promptText: null, validAcr: 5, entries: [{ brand: "Hyundai", choice: 4, isOurs: true }] }] },
    ]);
    expect(a.totals).toEqual({ promptRuns: 8, prompts: 3, iterations: 20, engines: ["chatgpt", "gemini"] });
  });

  it("A1: no cell, or the whole answer suppressed -> the waiting state (measured false, empty)", () => {
    const empty = { measured: false, brands: [], trend: [], battle: [], modelConversion: [], territory: [], totals: { promptRuns: 0, prompts: 0, iterations: 0, engines: [] } };
    expect(F.toStandardAcr(acr({ totals: { prompt_runs: 0, prompts: 0, iterations: 0, engines: [], catalog_acr_prompts: 67 } }), meta())).toEqual(empty);
    for (const reason of ["no_active_snapshot", "hidden", "source_pending"]) {
      expect(F.toStandardAcr(acr(), meta({ suppressed: { "*": reason } }))).toEqual(empty);
    }
  });

  it("a ratio with den 0 is null (legacy pct), not 0", () => {
    const a = F.toStandardAcr(
      acr({ brands: [{ brand: "X", is_ours: false, choice: 0, appearance: 0, cells: 0, choice_share: { num: 0, den: 0 }, coverage: { num: 0, den: 0 } }] }),
      meta(),
    );
    expect(a.brands[0]).toMatchObject({ choiceShare: null, coverage: null });
  });
});

// ── conversion ───────────────────────────────────────────────────────────────

function conv(o: Partial<Conv> = {}): Conv {
  return {
    period: { from: "2026-06-18", to: "2026-09-15" },
    summary: {
      ai: { sessions: 200, conversions: 7, page_views: 640, conv: { num: 7, den: 200 } },
      human: { sessions: 1000, conversions: 12, conv: { num: 12, den: 1000 } },
    },
    trend: [
      { date: "2026-09-02", ai_sessions: 3, ai_conversions: 1, human_sessions: 0, human_conversions: 0 },
      { date: "2026-09-01", ai_sessions: 400, ai_conversions: 201, human_sessions: 16, human_conversions: 1 },
    ],
    by_engine: [{ engine: "chatgpt", sessions: 150, conversions: 6, conv: { num: 6, den: 150 } }],
    by_engine_all: [
      { engine: "chatgpt", sessions: 150, conversions: 6, conv: { num: 6, den: 150 } },
      { engine: "perplexity", sessions: 9, conversions: 1, conv: { num: 1, den: 9 } },
      { engine: "other", sessions: 5, conversions: 0, conv: { num: 0, den: 5 } },
    ],
    pages: Array.from({ length: 15 }, (_, i) => ({
      url: `/p${i}`,
      ai_sessions: i === 14 ? 0 : 100 - i,
      ai_conversions: i === 0 ? 3 : 0,
      human_sessions: 10,
      human_conversions: i === 0 ? 1 : 0,
    })),
    by_country: null,
    coverage: { measured_markets: 1, total_markets: 1, markets: [{ brand: "Kia", country: "IT", status: "active", as_of: "2026-09-15", property_id: "123" }] },
    ...o,
  };
}

describe("toConversionLive: C1..C4, hand-computed", () => {
  it("summary, trend (ascending), pages (12, AI sessions > 0), engines (two panel engines)", () => {
    const live = F.toConversionLive(conv(), "123")!;
    // 7/200 = 3.5 ; 12/1000 = 1.2 ; lift 2.3
    expect(live.summary).toEqual({ aiConvRate: 3.5, humanConvRate: 1.2, lift: 2.3, aiUsersTotal: 200, humanUsersTotal: 1000, aiKeyEvents: 7, humanKeyEvents: 12 });
    expect(live.propertyId).toBe("123");
    // 201/400 -> legacy pct Math.round(502.49..)/10 = 50.2 ; 1/16 -> 6.3 ; 1/3 -> 33.3 ; 0/0 -> 0
    expect(live.trend).toEqual([
      { date: "2026-09-01", ai: 50.2, human: 6.3 },
      { date: "2026-09-02", ai: 33.3, human: 0 },
    ]);
    expect(live.pages).toHaveLength(12);
    // 3/100 = 3 ; 1/10 = 10 ; lift -7
    expect(live.pages[0]).toEqual({ url: "/p0", aiUsers: 100, humanUsers: 10, aiConvRate: 3, humanConvRate: 10, lift: -7 });
    expect(live.pages.map((p) => p.url)).toEqual(Array.from({ length: 12 }, (_, i) => `/p${i}`));
    // engine filter not applied (by_engine_all, BG-31); gemini missing -> 0 row; perplexity/other dropped
    expect(live.byEngine).toEqual([
      { engine: "chatgpt", users: 150, keyEvents: 6, convRate: 4 },
      { engine: "gemini", users: 0, keyEvents: 0, convRate: 0 },
    ]);
  });

  it("no session in either cohort -> null (legacy 'no data' -> pending notice)", () => {
    const zero = conv({ summary: { ai: { sessions: 0, conversions: 0, page_views: 0, conv: { num: 0, den: 0 } }, human: { sessions: 0, conversions: 0, conv: { num: 0, den: 0 } } } });
    expect(F.toConversionLive(zero, "123")).toBeNull();
    expect(F.toVisits(zero, "123")).toBeNull();
  });
});

describe("toVisits: C6", () => {
  it("sessions, page views, 14 pages with AI sessions (of 15), trend; no user counts (U8-N4)", () => {
    const v = F.toVisits(conv(), "123")!;
    expect(v.totalSessions).toBe(200);
    expect(v.pageViews).toBe(640);
    expect(v.totalUsers).toBeNull();
    expect(v.pages).toHaveLength(14);
    expect(v.pages[0]).toEqual({ url: "/p0", sessions: 100, users: null });
    expect(v.trend).toEqual([
      { date: "2026-09-01", sessions: 400 },
      { date: "2026-09-02", sessions: 3 },
    ]);
    // a day without AI sessions is not a point (legacy GA4 report had no such row)
    const withZero = conv({ trend: [...conv().trend, { date: "2026-09-03", ai_sessions: 0, ai_conversions: 0, human_sessions: 5, human_conversions: 0 }] });
    expect(F.toVisits(withZero, "123")!.trend.map((p) => p.date)).toEqual(["2026-09-01", "2026-09-02"]);
  });
});

describe("toConversionScreen: the legacy page branches", () => {
  const market = (status: "active" | "pending_grant" | "unmapped", country = "IT", brand = "Kia", property_id: string | null = "123") => ({
    brand,
    country,
    status,
    as_of: status === "active" ? "2026-09-15" : null,
    property_id,
  });
  const cov = (markets: ReturnType<typeof market>[]) => ({
    measured_markets: markets.filter((m) => m.status === "active").length,
    total_markets: markets.length,
    markets,
  });

  it("one active market: country leaf with live and visits", () => {
    const s = F.toConversionScreen(conv(), meta());
    expect([s.isCountryLeaf, s.singlePropertyId, s.liveData !== null, s.visitsData !== null, s.rollupData]).toEqual([true, "123", true, true, null]);
  });

  it("one pending_grant market: property kept (dialog), no data (pending notice)", () => {
    const s = F.toConversionScreen(conv({ coverage: cov([market("pending_grant")]) }), meta());
    expect([s.isCountryLeaf, s.singlePropertyId, s.liveData, s.visitsData, s.rollupData]).toEqual([true, "123", null, null, null]);
  });

  it("one unmapped market: no property (unmapped notice), even if the backend sent an id", () => {
    const s = F.toConversionScreen(conv({ coverage: cov([market("unmapped", "IT", "Kia", "999")]) }), meta({ suppressed: { "*": "source_pending" } }));
    expect([s.isCountryLeaf, s.singlePropertyId, s.liveData]).toEqual([true, null, null]);
  });

  it("several markets: rollup from by_country, zero-session rows out, measured = rows kept, total = markets", () => {
    const d = conv({
      coverage: cov([market("active", "IT"), market("active", "DE", "Kia", "124"), market("unmapped", "FR", "Kia", null), market("active", "ES", "Kia", "125")]),
      by_country: [
        { brand: "Kia", country: "IT", ai: { sessions: 150, conversions: 6 }, human: { sessions: 800, conversions: 8 } },
        { brand: "Kia", country: "DE", ai: { sessions: 50, conversions: 1 }, human: { sessions: 200, conversions: 4 } },
        { brand: "Kia", country: "ES", ai: { sessions: 0, conversions: 0 }, human: { sessions: 0, conversions: 0 } },
      ],
    });
    const s = F.toConversionScreen(d, meta());
    expect([s.isCountryLeaf, s.singlePropertyId, s.liveData, s.visitsData]).toEqual([false, null, null, null]);
    // totals from the summary: 7/200 = 3.5, 12/1000 = 1.2 ; IT 6/150 = 4, 8/800 = 1 ; DE 1/50 = 2, 4/200 = 2
    expect(s.rollupData).toEqual({
      aiConvRate: 3.5,
      humanConvRate: 1.2,
      lift: 2.3,
      measuredMarkets: 2,
      totalMarkets: 4,
      totalAiUsers: 200,
      totalHumanUsers: 1000,
      totalAiKeyEvents: 7,
      totalHumanKeyEvents: 12,
      byCountry: [
        { brand: "Kia", country: "IT", aiConvRate: 4, humanConvRate: 1, lift: 3, aiUsers: 150, humanUsers: 800 },
        { brand: "Kia", country: "DE", aiConvRate: 2, humanConvRate: 2, lift: 0, aiUsers: 50, humanUsers: 200 },
      ],
    });
  });

  it("several markets with one active: its row comes from the summary (by_country is null)", () => {
    const d = conv({ coverage: cov([market("active", "IT"), market("pending_grant", "DE", "Kia", "124")]), by_country: null });
    const r = F.toConversionScreen(d, meta()).rollupData!;
    expect(r.byCountry).toEqual([{ brand: "Kia", country: "IT", aiConvRate: 3.5, humanConvRate: 1.2, lift: 2.3, aiUsers: 200, humanUsers: 1000 }]);
    expect([r.measuredMarkets, r.totalMarkets]).toEqual([1, 2]);
  });

  it("several markets, none active: zero rollup (legacy mapped.length 0 shape)", () => {
    const zero = conv({
      summary: { ai: { sessions: 0, conversions: 0, page_views: 0, conv: { num: 0, den: 0 } }, human: { sessions: 0, conversions: 0, conv: { num: 0, den: 0 } } },
      coverage: cov([market("unmapped", "IT", "Kia", null), market("unmapped", "DE", "Kia", null)]),
    });
    expect(F.toConversionScreen(zero, meta({ suppressed: { "*": "source_pending" } })).rollupData).toEqual({
      aiConvRate: 0, humanConvRate: 0, lift: 0, measuredMarkets: 0, totalMarkets: 2,
      totalAiUsers: 0, totalHumanUsers: 0, totalAiKeyEvents: 0, totalHumanKeyEvents: 0, byCountry: [],
    });
  });

  it("no market in scope: nothing (the view shows its sample, as legacy)", () => {
    const s = F.toConversionScreen(conv({ coverage: cov([]) }), meta({ suppressed: { "*": "source_pending" } }));
    expect([s.isCountryLeaf, s.singlePropertyId, s.liveData, s.rollupData, s.visitsData]).toEqual([false, null, null, null, null]);
  });
});

// ── queries sent ─────────────────────────────────────────────────────────────

describe("queries: one serializer (analysisQuery) + feature parameters", () => {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const answer: { json: unknown; status: number } = { json: null, status: 200 };
  beforeEach(() => {
    urls.length = 0;
    bodies.length = 0;
    answer.status = 200;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: RequestInit) => {
        urls.push(String(u));
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const q = (i = 0) => new URL(urls[i]).searchParams;

  it("ACR: scope-injected brand/country stripped, URL choices sorted, period both ends; count and languages from the answer", async () => {
    answer.json = { data: acr(), meta: meta() };
    const scope = { all: false, brands: ["Kia"], countries: ["DE", "US"] };
    const res = await F.loadAcrScreen(
      { brand: ["Kia"], region: ["US", "DE"], engine: ["Gemini", "chatgpt"], lang: ["EN"], dateFrom: "2026-09-01", dateTo: "2026-09-10", cumulative: true },
      { surface: "global", scope },
    );
    expect(new URL(urls[0]).pathname).toBe("/v1/funnel/acr");
    // brand = the lock (not a choice), country = the whole allowed set (the injection) -> not sent
    expect(q().getAll("brand")).toEqual([]);
    expect(q().getAll("country")).toEqual([]);
    expect(q().getAll("engine")).toEqual(["chatgpt", "gemini"]);
    expect(q().getAll("lang")).toEqual(["en"]);
    expect([q().get("from"), q().get("to"), q().get("surface")]).toEqual(["2026-09-01", "2026-09-10", "global"]);
    expect(q().has("cumulative")).toBe(false);
    expect(q().has("trend_cycles")).toBe(false);
    expect(res.acrPromptCount).toBe(67);
    expect(res.languageOptions).toEqual(["de", "en"]);
    expect(res.data.measured).toBe(true);
  });

  it("ACR: a one-sided period is sent as that end alone (the backend closes it)", async () => {
    answer.json = { data: acr(), meta: meta() };
    await F.loadAcrScreen({ dateFrom: "2026-09-01" }, { surface: "global", scope: { all: true } });
    expect([q().get("from"), q().has("to")]).toEqual(["2026-09-01", false]);
  });

  it("conversion global: country from geography, engine/device/visitor_type, days and page_limit", async () => {
    answer.json = { data: conv(), meta: meta() };
    await F.loadConversionScreen({
      surface: "global",
      geography: ["IT", "DE"],
      filters: { engine: ["gemini"], device: ["mobile", "desktop"], visitorType: ["new"] },
      days: 28,
    });
    expect(new URL(urls[0]).pathname).toBe("/v1/funnel/conversion");
    expect(q().getAll("country")).toEqual(["DE", "IT"]);
    expect(q().getAll("engine")).toEqual(["gemini"]);
    expect(q().getAll("device")).toEqual(["desktop", "mobile"]);
    expect(q().getAll("visitor_type")).toEqual(["new"]);
    expect([q().get("days"), q().get("page_limit"), q().get("surface")]).toEqual(["28", "15", "global"]);
    expect(q().has("from") || q().has("to")).toBe(false);
  });

  it("conversion website keeps virtual site codes; project sends project_id and no country", async () => {
    answer.json = { data: conv(), meta: meta() };
    await F.loadConversionScreen({ surface: "website", geography: ["HYUNDAI-N"], filters: {}, days: 90 });
    expect([q(0).getAll("country"), q(0).get("surface")]).toEqual([["HYUNDAI-N"], "website"]);
    await F.loadConversionScreen({ surface: "project", projectId: PROJECT, geography: ["US"], filters: {}, days: 7 });
    expect([q(1).get("surface"), q(1).get("project_id"), q(1).has("country"), q(1).get("days")]).toEqual(["project", PROJECT, false, "7"]);
  });

  it("events: GET and PUT with property_id (and project_id in the project context)", async () => {
    answer.json = {
      data: { property_id: "123", window_from: "2026-06-18", window_to: "2026-09-15", loaded: true, registered: true, can_edit: true, items: [{ event_name: "purchase", count: 5, tracked: true }, { event_name: "view", count: 90, tracked: false }] },
      meta: meta({ mode: "admin" }),
    };
    const ev = await F.fetchConversionEvents("123", PROJECT);
    expect(F.toEventRows(ev)).toEqual([
      { eventName: "purchase", count: 5, tracked: true },
      { eventName: "view", count: 90, tracked: false },
    ]);
    expect([new URL(urls[0]).pathname, q(0).get("property_id"), q(0).get("project_id"), q(0).has("surface")]).toEqual([
      "/v1/funnel/conversion/events",
      "123",
      PROJECT,
      false,
    ]);
    answer.json = { data: { property_id: "123", event_names: ["purchase"], propagation: "pending", change_id: 9 }, meta: meta({ mode: "crud" }) };
    await F.putConversionEvents("123", ["purchase"]);
    expect([q(1).get("property_id"), q(1).has("project_id")]).toEqual(["123", false]);
    expect(bodies[1]).toEqual({ event_names: ["purchase"] });
  });

  it("errors keep status and code (HghApiError) for the pages and actions to map", async () => {
    answer.status = 403;
    answer.json = { error: { code: "menu_forbidden", message: "x" } };
    await expect(F.loadAcrScreen({}, { surface: "global", scope: null })).rejects.toMatchObject({ status: 403, code: "menu_forbidden" });
    answer.status = 404;
    answer.json = { error: { code: "not_found", message: "x" } };
    await expect(F.loadConversionScreen({ surface: "project", projectId: PROJECT, filters: {}, days: 90 })).rejects.toMatchObject({ status: 404 });
  });
});

// ── known differences (A4 notice list) ──────────────────────────────────────

export const KNOWN_DIFF = ["DC-01", "DC-03", "DC-09", "U8-N1", "U8-N2", "U8-N3", "U8-N4", "U8-N5", "U8-N6", "U8-N7", "U8-N8", "U8-N9", "U8-N15", "U8-N16", "U8-N17", "U8-N20", "U8-N22"] as const;

describe("known_diff: every documented item is in the module header", () => {
  it("the header lists exactly these codes", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./funnel.ts", import.meta.url), "utf8");
    const header = src.split("\nimport ")[0];
    const codes = [...header.matchAll(/^\/\/\s+((?:DC|U8-N)[-\dN]+)\s/gm)].map((m) => m[1]);
    expect(codes).toEqual([...KNOWN_DIFF]);
  });
});
