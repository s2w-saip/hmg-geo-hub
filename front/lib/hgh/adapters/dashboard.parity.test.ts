import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { StandardAggregates } from "@/lib/scope/result-adapter";
import type { GeoKpiResult, StandardTrendBucket, SubKpiEngineRow } from "@/lib/db/repositories/scope-aggregates";

// Legacy / api parity for the three dashboards (U5). Each case builds ONE world and runs:
//   legacy: the UNCHANGED legacy view-model functions (dashboard, website and project live.ts,
//           buildGeo, applyEngineConsistency, the card's competitorCitationShares), readers mocked
//           at lib/scope/server and the repositories with the world's rows (U4 precedent);
//   api:    the same world as backend answers through lib/hgh/adapters/dashboard.ts (and the
//           D8 facades with HGH_SOURCE_<group>=api).
// Differences must equal KNOWN_DIFF of the case (with the reason); an undeclared difference
// fails, and so does a declared one that disappears.
//
// Layer (U5 verification D4): the legacy readers here are mocks fed with hand-built aggregates
// (legacyAgg, trend buckets, GeoKpiResult), so this file checks the VIEW-MODEL layer only: the
// same aggregates give the same cards, trend, GEO tree and composition on both sources. The SQL
// definitions of the legacy aggregate layer are not run here. dashboard.pglite.parity.test.ts
// runs the legacy mirror reader (aggregateStandardFromMirror) on PGlite for the global cards
// ①~⑤ + KPI #16 and asserts DC-01 there; the day roll-up of the trend readers stays declared,
// not SQL-verified (no PGlite world for the trend readers). DC-21 (KPI tab position) is resolved
// upstream (hmg-geo 6bc5c54, competition rank); its value check on data is BE-11.

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
vi.mock("@/lib/scope/server", () => ({
  fetchStandardAggregates: vi.fn(),
  fetchStandardGeoKpi: vi.fn(),
  fetchStandardTrend: vi.fn(),
  fetchStandardSubKpis: vi.fn(),
  fetchStandardPromptTopics: vi.fn(),
  fetchStandardSourceComposition: vi.fn(),
  fetchProjectTrend: vi.fn(),
  fetchProjectSubKpis: vi.fn(),
  fetchProjectPromptTopics: vi.fn(),
  fetchProjectSourceComposition: vi.fn(),
  fetchProjectStandardAggregates: vi.fn(),
  fetchProjectCitationAccuracy: vi.fn(),
  fetchProjectCitationAccuracyTrend: vi.fn(),
  fetchWebsiteAggregates: vi.fn(),
  fetchWebsiteGeoCompetition: vi.fn(),
  fetchWebsiteTrend: vi.fn(),
  fetchWebsiteSubKpis: vi.fn(),
  fetchWebsitePromptTopics: vi.fn(),
  fetchWebsiteSourceComposition: vi.fn(),
  fetchWebsiteCitationAccuracy: vi.fn(),
  fetchWebsiteCitationAccuracyTrend: vi.fn(),
  fetchWebsiteTargetHitRate: vi.fn(),
  wasDegraded: vi.fn(() => false),
}));
vi.mock("@/lib/ga4/property-map", () => ({ resolveProperty: vi.fn(), resolveProperties: vi.fn() }));
vi.mock("@/lib/ga4/conversion", () => ({
  getAiTrafficConversionKpi: vi.fn(),
  getAiTrafficConversionRollup: vi.fn(),
  getAiVisitsKpi: vi.fn(),
}));
vi.mock("@/lib/db/repositories/project-tracked-urls", () => ({ listProjectTrackedUrls: vi.fn() }));
vi.mock("@/lib/db/repositories/project-owned-bases", () => ({ listProjectOwnedBases: vi.fn() }));
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: { getById: vi.fn() } }));
vi.mock("@/lib/db/repositories/tracked-entities", () => ({ trackedCompetitorRepository: { getTargetBrand: vi.fn() } }));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => session.current) }));

const { withRequestScope } = await import("@/test/request-scope");
const { loadPanelOptions } = await import("./filters");
const { degradedLabels } = await import("@/lib/scope/degrade-registry");
const { bindHghAuth } = await import("../auth");
const D = await import("./dashboard");
const server = await import("@/lib/scope/server");
const ga4Map = await import("@/lib/ga4/property-map");
const ga4 = await import("@/lib/ga4/conversion");
const trackedUrls = await import("@/lib/db/repositories/project-tracked-urls");
const ownedBases = await import("@/lib/db/repositories/project-owned-bases");
const projects = await import("@/lib/db/repositories/projects");
const tracked = await import("@/lib/db/repositories/tracked-entities");
const dashLive = await import("@/app/[locale]/(dash)/dashboard/_data/live");
const webLive = await import("@/app/[locale]/(dash)/website/_data/live");
const projLive = await import("@/app/[locale]/(dash)/projects/[id]/_data/live");
const { competitorCitationShares, sparkPoints } = await import("@/app/[locale]/(dash)/dashboard/_components/overview-kpi-cards");
const { rhqForCountry, rhqRegionIdsForBrand } = await import("@/lib/rhq");
const T = await import("./trend");
const { competitorPositionDeltas, competitorTrendDeltas } = await import("@/lib/kpi/competitor-values");

type S = components["schemas"];
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln"; // {"alg":"ES256"}.{"sub":"u"}.sig
const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ADMIN = { user: { id: "u", email: "", role: "admin", operator: "none", menuGroups: null, scope: { all: true } } };

const meta = (m: Partial<S["Meta"]> = {}): S["Meta"] => ({ mode: "snapshot", as_of: "2026-09-14", cycles: ["2026-09-14"], ...m });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

let routes: Record<string, (u: URL) => Response>;
beforeEach(() => {
  vi.clearAllMocks();
  routes = {};
  session.current = ADMIN;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(String(input));
      const r = routes[u.pathname];
      if (!r) return new Response(JSON.stringify({ error: { code: "not_found", message: "", details: null } }), { status: 404 });
      return r(u);
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── backend answers that honour the opt-in params the dashboards send (P2 / P3 / P11) ──────────
// The routes below apply the documented effect of each "skip unused work" parameter to a full
// answer, so the parity cases run the lighter requests and still have to equal the legacy values.

const ZERO_SENTIMENT = { positive: 0, neutral: 0, negative: 0, mixed: 0 };

/** GET /v1/mentions/brands: include_sentiment=false zeroes every row's sentiment; q keeps the own rows
 *  and the competitor rows whose name contains q (case-insensitive, BG-19). */
function honourBrands(data: S["BrandsData"], u: URL): S["BrandsData"] {
  const noSentiment = u.searchParams.get("include_sentiment") === "false";
  const needle = u.searchParams.get("q")?.toLowerCase() ?? null;
  return {
    ...data,
    brands: data.brands
      .filter((b) => b.is_own || needle === null || b.name.toLowerCase().includes(needle))
      .map((b) => (noSentiment ? { ...b, sentiment: ZERO_SENTIMENT } : b)),
  };
}

/** GET /v1/citations/domains: include_den=false -> answers_den 0 and row coverage.den 0;
 *  include_competitor_totals=false -> competitor_totals []. own_share is not affected (B011). */
function honourDomains(data: S["DomainsData"], u: URL): S["DomainsData"] {
  const noDen = u.searchParams.get("include_den") === "false";
  const noTotals = u.searchParams.get("include_competitor_totals") === "false";
  return {
    ...data,
    ...(noDen
      ? { summary: { ...data.summary, answers_den: 0 }, items: data.items.map((r) => ({ ...r, coverage: { num: r.coverage.num, den: 0 } })) }
      : {}),
    ...(noTotals ? { competitor_totals: [] } : {}),
  };
}

/** GET /v1/kpi/engines: parts without a rank_detail part (exposure / position / all) -> multi, top1, top3 null. */
function honourEngines(data: S["EnginesData"], u: URL): S["EnginesData"] {
  const parts = u.searchParams.getAll("parts");
  const rankDetail = parts.length === 0 || parts.some((p) => p === "all" || p === "exposure" || p === "position");
  return rankDetail ? data : { ...data, rows: data.rows.map((r) => ({ ...r, multi: null, top1: null, top3: null })) };
}

/** GET /v1/funnel/conversion: summary_only=true -> trend / by_engine / pages [] and by_country null. */
function honourConversion(data: S["ConversionData"], u: URL): S["ConversionData"] {
  if (u.searchParams.get("summary_only") !== "true") return data;
  return { ...data, trend: [], by_engine: [], pages: [], by_country: null };
}

/** The B011 flags every dashboard domains call sends (fetchDashboardDomains). */
const LIGHT_DOMAINS = new URL("https://api.hgh.test/v1/citations/domains?include_den=false&include_competitor_totals=false");

/** Paths where a and b differ (undefined on both sides is equal). */
function diff(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? [] : [path];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    return av === undefined && bv === undefined ? [] : diff(av, bv, path ? `${path}.${k}` : k);
  });
}

interface Known {
  path: RegExp;
  reason: string;
}
function expectOnlyKnown(legacy: unknown, api: unknown, known: Known[]) {
  const d = diff(legacy, api);
  for (const p of d) expect(known.some((k) => k.path.test(p)), `undeclared difference at ${p}`).toBe(true);
  for (const k of known) expect(d.some((p) => k.path.test(p)), `declared difference ${k.path} (${k.reason}) disappeared`).toBe(true);
}

// ── WORLD: one global round, admin (HMG = Hyundai + Kia tracked) ─────────────
const W = {
  answers: 400,
  tracked: 240,
  totalMentions: 900,
  brands: [
    { name: "Hyundai", mentions: 200, answers: 150, pos: [300, 120], sent: [60, 10, 5, 5] },
    { name: "Kia", mentions: 133, answers: 100, pos: [180, 90], sent: [40, 10, 0, 0] },
    { name: "Toyota", mentions: 120, answers: 90, pos: [200, 80], sent: [30, 20, 10, 0] },
    { name: "Honda", mentions: 90, answers: 70, pos: [150, 60], sent: [20, 5, 5, 0] },
  ],
  sentiment: [250, 400], // positive, sampled (own)
  position: [150, 60], // own rank sum, ranked answers (avg 2.5 exact)
  citations: [45, 300], // owned, total
};
const TRACKED = new Set(["Hyundai", "Kia"]);
const ownMentions = W.brands.filter((b) => TRACKED.has(b.name)).reduce((s, b) => s + b.mentions, 0);

function legacyAgg(): StandardAggregates {
  return {
    rootProjectId: "r",
    asOf: "2026-09-14",
    totalAnswers: W.answers,
    totalMentions: W.totalMentions,
    trackedAnswerCount: W.tracked,
    brands: W.brands.map((b) => ({ name: b.name, mentionCount: b.mentions, answerCount: b.answers, isTracked: TRACKED.has(b.name) })),
    regions: [],
    citations: { sampledAnswers: 400, answersWithCitation: 200, totalCitations: W.citations[1], ownedCitations: W.citations[0], domains: [] },
    position: { avgPosition: W.position[0] / W.position[1], sampledAnswers: W.position[1] },
    sentiment: { positiveRate: pct(W.sentiment[0], W.sentiment[1]), positiveMentions: W.sentiment[0], sampledMentions: W.sentiment[1] },
  } as StandardAggregates;
}

function apiSummary(o: Partial<S["SummaryData"]> = {}): S["SummaryData"] {
  return {
    visibility: { num: W.tracked, den: W.answers },
    share_of_voice: { num: ownMentions, den: W.totalMentions },
    sentiment: { num: W.sentiment[0], den: W.sentiment[1] },
    position: { sum: W.position[0], count: W.position[1] },
    citation_share: { num: W.citations[0], den: W.citations[1] },
    target_url_rate: null,
    owned_url_rate: null,
    citation_accuracy: null,
    params: { answers: W.answers, applied_prompts: 50, measured_prompts: 40, prompts_without_brand: 5, measured_by_funnel: null },
    analysis_gap: { gap_answers: 0, base_answers: W.answers },
    ...o,
  };
}

function apiBrands(): S["BrandsData"] {
  const items: S["BrandItem"][] = W.brands.map((b, i) => ({
    name: b.name,
    rank: i + 1,
    mentions: b.mentions,
    exposure: { num: b.answers, den: W.answers },
    share: { num: b.mentions, den: W.totalMentions },
    avg_rank: { sum: b.pos[0], count: b.pos[1] },
    is_own: TRACKED.has(b.name),
    is_hmg_own: TRACKED.has(b.name),
    brand_key: i + 10,
    sentiment: { positive: b.sent[0], neutral: b.sent[1], negative: b.sent[2], mixed: b.sent[3] },
  }));
  return {
    brands: items,
    own: { brands: ["Hyundai", "Kia"], vp_label: "HMG", mentions: ownMentions, rank: 1, exposure: { num: W.tracked, den: W.answers }, share: { num: ownMentions, den: W.totalMentions }, avg_rank: null },
    totals: { answers: W.answers, brand_count: items.length, mentions_total: W.totalMentions },
  };
}

function conversion(total: number, measured: number, conv: number, sessions: number, trend: number[]): S["ConversionData"] {
  return {
    coverage: { total_markets: total, measured_markets: measured, markets: [] },
    summary: {
      ai: { conversions: conv, sessions, page_views: 0, conv: { num: conv, den: sessions } },
      human: { conversions: 0, sessions: 0, conv: { num: 0, den: 0 } },
    },
    trend: trend.map((s, i) => ({ date: `2026-09-0${i + 1}`, ai_sessions: s, ai_conversions: 0, human_sessions: 0, human_conversions: 0 })),
    by_engine: [],
    by_country: null,
    pages: [],
    period: { from: null, to: null },
  };
}

// ── global cards ─────────────────────────────────────────────────────────────

describe("global cards: getLiveDashboard legacy vs HGH_SOURCE_G1=api", () => {
  it("①~⑤, KPI #16 equal; neither path reads or returns ⑦ (Overview renders OVERVIEW_KPI_KEYS only)", async () => {
    vi.mocked(server.fetchStandardAggregates).mockResolvedValue(legacyAgg());
    const legacy = await withRequestScope(() => dashLive.getLiveDashboard({}));

    vi.stubEnv("HGH_SOURCE_G1", "api");
    routes["/v1/kpi/summary"] = () => json({ data: apiSummary(), meta: meta() });
    routes["/v1/mentions/brands"] = () => json({ data: apiBrands(), meta: meta() });
    const api = await withRequestScope(() => dashLive.getLiveDashboard({}));

    expect(legacy).not.toBeNull();
    expectOnlyKnown(legacy, api, []);
    // KPI #16 by hand: own mentions 333 / Toyota 120 x 100 = 277.5
    expect(api?.kpis.find((k) => k.key === "shareOfVoice")?.competitorSov).toEqual({ brand: "Toyota", value: 277.5 });
    // ⑦ was fetched on every render but never shown (2026-10-14): no GA4 property lookup or
    // Data API call on the legacy path, no /v1/funnel/conversion on the api path.
    for (const r of [legacy, api]) expect(r?.kpis.map((k) => k.key)).not.toContain("trafficConversion");
    expect(ga4Map.resolveProperties).not.toHaveBeenCalled();
    expect(ga4Map.resolveProperty).not.toHaveBeenCalled();
    expect(ga4.getAiTrafficConversionKpi).not.toHaveBeenCalled();
    expect(ga4.getAiTrafficConversionRollup).not.toHaveBeenCalled();
    expect(ga4.getAiVisitsKpi).not.toHaveBeenCalled();
    const paths = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).not.toContain("/v1/funnel/conversion");
  });
});

// ── competitor row sources ────────────────────────────────────────────────────

describe("competitor rows: brand values and the citation minis", () => {
  it("brand values feed the same card candidates; citation minis equal on the same domain world", () => {
    // legacy MentionsBrandLive subset from the same world (the mirror's own rounding)
    const legacyBrands = W.brands.map((b) => ({
      brand: b.name,
      mentions: b.mentions,
      share: pct(b.mentions, W.totalMentions),
      mentionRate: pct(b.answers, W.answers),
      avgPosition: Math.round((b.pos[0] / b.pos[1]) * 10) / 10,
      isTracked: TRACKED.has(b.name),
      sentiment: { positive: b.sent[0], neutral: b.sent[1], negative: b.sent[2], mixed: b.sent[3] },
    }));
    const apiBrandsV = D.toCompetitorBrandValues(apiBrands().brands);
    expectOnlyKnown(legacyBrands, apiBrandsV, [
      { path: /^\d+\.brandKey$/, reason: "api only: brand_key for the BG-11 trend (legacy rows have none)" },
    ]);

    const total = 300;
    const legacyDomains = [
      { domain: "toyota.com", citations: 9, category: "Official (Competitor)" },
      { domain: "toyota.de", citations: 1, category: "Official (Competitor)" },
      { domain: "honda.com", citations: 4, category: "Official (Competitor)" },
      { domain: "cars.com", citations: 30, category: "Media" },
    ].map((d) => ({ ...d, share: pct(d.citations, total), prompts: 0, coverageRate: 0, urls: [], promptList: [], isOurs: false, subcategory: null }));
    // the card request sends include_den=false and include_competitor_totals=false (B011): own_share stays
    const api = D.toCompetitorCitationDomains(
      honourDomains(
        {
          items: [],
          competitor_totals: [{ brand: "Toyota", citations: 10, sources: 2 }],
          summary: { answers_den: 100, own_share: { num: 45, den: total }, unique_sources: 4 },
          competitor_sources: legacyDomains
            .filter((d) => d.category === "Official (Competitor)")
            .map((d) => ({ domain: d.domain, skey: d.domain, citations: d.citations, brand: null })),
        },
        LIGHT_DOMAINS,
      ),
    );
    // toyota 3.0 + 0.3 = 3.3, honda 1.3
    expect(competitorCitationShares(api)).toEqual(competitorCitationShares(legacyDomains));
    expect(competitorCitationShares(api).map((m) => [m.brand, m.value])).toEqual([
      ["Toyota", 3.3],
      ["Honda", 1.3],
    ]);
  });
});

// ── GEO ──────────────────────────────────────────────────────────────────────

describe("GEO: buildGeo legacy vs toLiveGeo", () => {
  // one country (DE) for Kia; our brand Kia 20 mentions / 15 answers, Toyota 25 / 12, BMW 15 / 9
  const code = "DE";
  const region = rhqForCountry("Kia", code)!;
  const rows = [
    { brand: "Kia", mentions: 20, answers: 15, pos: [30, 15], sent: [8, 10], tracked: true },
    { brand: "Toyota", mentions: 25, answers: 12, pos: [24, 12], sent: [5, 10], tracked: false },
    { brand: "BMW", mentions: 15, answers: 9, pos: [27, 9], sent: [3, 6], tracked: false },
  ];
  const totals = { answers: 40, ownAnswers: 15, citTotal: 50, citOwned: 10 };
  const legacyKpi: GeoKpiResult = {
    brands: rows.map((r) => ({ code, brand: r.brand, mentions: r.mentions, isTracked: r.tracked, answers: r.answers, posSum: r.pos[0], posCnt: r.pos[1], sentPositive: r.sent[0], sentTotal: r.sent[1] })),
    codes: [{ code, ...totals }],
  };
  const all = rows.reduce((s, r) => s + r.mentions, 0);
  const metricsOf = (r: (typeof rows)[number]): S["GeoMetrics"] => ({
    visibility: { num: r.answers, den: totals.answers },
    share_of_voice: { num: r.mentions, den: all },
    sentiment: { num: r.sent[0], den: r.sent[1] },
    position: { sum: r.pos[0], count: r.pos[1] },
    citation_share: null,
  });
  // the backend answer for the same world: own = Kia, rival = Toyota, rank 2 of 3
  const apiRow = {
    answers: totals.answers,
    own: { ...metricsOf(rows[0]), visibility: { num: totals.ownAnswers, den: totals.answers }, citation_share: { num: totals.citOwned, den: totals.citTotal } },
    rank: { our: 2, field_size: 3 },
    top_own_brand: { brand: "Kia", share_of_voice: { num: 20, den: all } },
    top_rival: { brand: "Toyota", metrics: metricsOf(rows[1]) },
  };
  const apiGeo = (ownLabel: string, withMarkets: boolean): S["GeoData"] => ({
    active_brand: withMarkets ? "Kia" : null,
    own_label: ownLabel,
    pending: withMarkets ? rhqRegionIdsForBrand("Kia").filter((r) => r !== region) : [],
    markets: withMarkets ? [{ ...apiRow, region_id: region, region_label: region, country_count: 1, countries: [{ ...apiRow, code }] }] : [],
  });

  it("single-brand account (Kia): identical tree, values and label", () => {
    const legacy = dashLive.buildGeo(legacyKpi, new Set(["Kia"]), "Kia");
    expectOnlyKnown(legacy, D.toLiveGeo(apiGeo("Kia", true)), []);
  });

  it("account scoped to two brands: no region tree either way; the label is own_label (U5-N1)", () => {
    const legacy = dashLive.buildGeo(legacyKpi, new Set(["Hyundai", "Kia"]), null);
    expectOnlyKnown(legacy, D.toLiveGeo(apiGeo("HMG", false)), [
      { path: /^ourLabel$/, reason: "U5-N1: backend own_label 'HMG' for several perspective brands (legacy 'Hyundai, Kia')" },
    ]);
  });
});

// ── engine badge ─────────────────────────────────────────────────────────────

describe("engine consistency badge: legacy rows vs converted API rows", () => {
  it("same badges on the cards", () => {
    const legacyRows: SubKpiEngineRow[] = [
      { engine: "chatgpt", answers: 100, tracked: 60, multi: 5, top1: 20, top3: 40, avgPosition: 1.5, totalMentions: 200, trackedMentions: 50, sentMentions: 40, positiveMentions: 30, negativeMentions: 4, citTotal: 50, citOwned: 10 },
      { engine: "gemini", answers: 80, tracked: 40, multi: 2, top1: 10, top3: 25, avgPosition: 3, totalMentions: 100, trackedMentions: 50, sentMentions: 20, positiveMentions: 10, negativeMentions: 2, citTotal: 40, citOwned: 4 },
    ];
    const api = D.toSubKpis({
      rows: legacyRows.map((r) => ({
        engine: r.engine,
        answers: r.answers,
        tracked: r.tracked,
        multi: r.multi,
        top1: r.top1,
        top3: r.top3,
        rank_sum: Math.round((r.avgPosition ?? 0) * r.tracked),
        ranked: r.tracked,
        total_mentions: r.totalMentions,
        tracked_mentions: r.trackedMentions,
        sent_mentions: r.sentMentions,
        positive_mentions: r.positiveMentions,
        negative_mentions: r.negativeMentions,
        cit_total: r.citTotal,
        cit_owned: r.citOwned,
      })),
      engine_consistency: { visibility: null, share_of_voice: null, sentiment: null, position: null, citation_share: null },
    });
    expectOnlyKnown(legacyRows, api.rows, []);
    const cards = dashLive.buildMirrorKpis(legacyAgg());
    expect(dashLive.applyEngineConsistency(cards, api.rows)).toEqual(dashLive.applyEngineConsistency(cards, legacyRows));
  });

  it("B090 parts=sov+citation (no rank_detail): multi / top1 / top3 come back null, the badges are the same", () => {
    const row = (engine: string, answers: number, tracked: number, rankSum: number, total: number, own: number, sent: number, pos: number, cit: number, citOwn: number): S["EngineItem"] => ({
      engine, answers, tracked, multi: 3, top1: 9, top3: 12, rank_sum: rankSum, ranked: tracked,
      total_mentions: total, tracked_mentions: own, sent_mentions: sent, positive_mentions: pos, negative_mentions: 1, cit_total: cit, cit_owned: citOwn,
    });
    const full: S["EnginesData"] = {
      rows: [row("chatgpt", 100, 60, 90, 200, 50, 40, 30, 50, 10), row("gemini", 80, 40, 120, 100, 50, 20, 10, 40, 4)],
      engine_consistency: { visibility: null, share_of_voice: null, sentiment: null, position: null, citation_share: null },
    };
    const lighter = honourEngines(full, new URL("https://x/v1/kpi/engines?parts=citation&parts=sov"));
    expect(lighter.rows.every((r) => r.multi === null && r.top1 === null && r.top3 === null)).toBe(true);
    const cards = dashLive.buildMirrorKpis(legacyAgg());
    const badges = (d: S["EnginesData"]) => dashLive.applyEngineConsistency(cards, D.toSubKpis(d).rows).map((k) => k.engineConsistency);
    expect(badges(lighter)).toEqual(badges(full));
    expect(badges(full).filter((b) => b !== undefined)).toHaveLength(5);
  });
});

// ── website cards ─────────────────────────────────────────────────────────────

describe("website cards: getLiveWebsiteDashboard legacy vs HGH_SOURCE_G3=api", () => {
  it("①~⑤, accuracy, #16 and the URL-rate cards equal (DC-02 decision 6: url_prompts, legacy prompt unit and wording)", async () => {
    vi.mocked(server.fetchWebsiteAggregates).mockResolvedValue(legacyAgg());
    vi.mocked(server.fetchWebsiteCitationAccuracy).mockResolvedValue({ ownedAnswers: 10, targetAnswers: 4, rate: 40 });
    // legacy prompt unit (GGMD-61): 5 owned / 3 target of 20 measured prompts
    vi.mocked(server.fetchWebsiteTargetHitRate).mockResolvedValue({ hitPrompts: 3, ownedPrompts: 5, measuredPrompts: 20, rate: 15, ownedRate: 25, source: "live" } as never);
    const legacy = await withRequestScope(() => webLive.getLiveWebsiteDashboard({}));

    vi.stubEnv("HGH_SOURCE_G3", "api");
    // the measurement Ratios (12 / 5 of 40) must not reach the cards: url_prompts carries the prompt unit
    routes["/v1/kpi/summary"] = () =>
      json({
        data: apiSummary({
          owned_url_rate: { num: 12, den: 40 },
          target_url_rate: { num: 5, den: 40 },
          citation_accuracy: { num: 4, den: 10 },
          url_prompts: { measured_prompts: 20, target_prompts: 3, owned_prompts: 5 },
        }),
        meta: meta({ surface: "website", source: { url_rates: "live" } }),
      });
    routes["/v1/mentions/brands"] = (u) => json({ data: honourBrands(apiBrands(), u), meta: meta() });
    const api = await withRequestScope(() => webLive.getLiveWebsiteDashboard({}));

    expectOnlyKnown(legacy, api, []);
    expect(api?.kpis.map((k) => k.key)).toEqual(["visibility", "shareOfVoice", "sentiment", "position", "citationShare", "ownedUrlRate", "targetUrlRate", "citationAccuracy"]);
    // B028: KPI #16 reads the competitor mentions only, so the sentiment-free rows give the same card
    const calls = vi.mocked(fetch).mock.calls.map(([i]) => new URL(String(i)));
    expect(calls.find((u) => u.pathname === "/v1/mentions/brands")?.searchParams.get("include_sentiment")).toBe("false");
    expect(calls.find((u) => u.pathname === "/v1/kpi/summary")?.searchParams.getAll("parts")).toEqual(["urls"]);
  });
});

// ── composition ──────────────────────────────────────────────────────────────

describe("composition: getLiveComposition (project) legacy vs toSourceSlices / toTopicSlices", () => {
  it("top 7 and topics equal; 기타 share differs by rounding only (U5-N2)", async () => {
    const total = 300;
    const doms = [60, 50, 40, 30, 20, 10, 5, 1, 1, 1, 82].map((c, i) => ({ domain: `d${i}.com`, citations: c, isOurs: i === 0 }));
    expect(doms.reduce((s, d) => s + d.citations, 0)).toBe(total);
    vi.mocked(server.fetchProjectSourceComposition).mockResolvedValue(
      doms.map((d) => ({ ...d, share: pct(d.citations, total) })).sort((a, b) => b.citations - a.citations),
    );
    vi.mocked(server.fetchProjectPromptTopics).mockResolvedValue([
      { topic: "구매", prompts: 7 },
      { topic: "탐색", prompts: 2 },
      { topic: null, prompts: 1 },
    ]);
    const legacy = await withRequestScope(() => dashLive.getLiveComposition({}, PID));

    const sorted = [...doms].sort((a, b) => b.citations - a.citations);
    const apiDomains: S["DomainsData"] = {
      items: sorted.slice(0, 7).map((d) => ({
        domain: d.domain,
        skey: d.domain,
        citations: d.citations,
        citing_answers: 1,
        coverage: { num: 1, den: 1 },
        share: { num: d.citations, den: total },
        is_own: d.isOurs,
        is_social: false,
        is_target: false,
        own_citations: 0,
        category: null,
      })),
      competitor_totals: [],
      summary: { answers_den: 1, own_share: { num: 60, den: total }, unique_sources: doms.length },
    };
    const api = {
      topics: D.toTopicSlices({
        data: apiSummary({
          params: {
            answers: 1,
            applied_prompts: 10,
            measured_prompts: 10,
            prompts_without_brand: 0,
            measured_by_funnel: [
              { funnel: "구매", measured_prompts: 7 },
              { funnel: "탐색", measured_prompts: 2 },
              { funnel: null, measured_prompts: 1 },
            ],
          },
        }),
        meta: meta(),
      }),
      // the composition request sends include_den=false and include_competitor_totals=false (B011)
      sources: D.toSourceSlices(honourDomains(apiDomains, LIGHT_DOMAINS)),
    };
    // rest = 1+1+1 (sorted after 82,60,50,40,30,20,10: the last 7 are 82..10; rest 5,1,1,1)
    expectOnlyKnown(legacy, api, [
      { path: /^sources\.7\.share$/, reason: "U5-N2: 기타 = pct(8, 300) = 2.7; legacy summed rounded shares 1.7+0.3+0.3+0.3 = 2.6" },
    ]);
  });
});

// ── project dashboard ────────────────────────────────────────────────────────

describe("project dashboard: getProjectDashboard legacy vs HGH_SOURCE_G6=api", () => {
  // two daily rounds; the project has one owned base and one tracked URL; target = Toyota
  const rounds = ["2026-09-07", "2026-09-14"];
  const byRound = [
    { answers: 50, tracked: 20, total: 100, own: 30, sentP: 12, sentT: 20, rank: [40, 20], cit: [6, 40], acc: [2, 5] },
    { answers: 60, tracked: 30, total: 120, own: 48, sentP: 18, sentT: 30, rank: [45, 30], cit: [12, 48], acc: [3, 6] },
  ];
  const legacyBucket = (i: number, unit: "day" | "week"): StandardTrendBucket => {
    const r = byRound[i];
    return {
      bucketStart: rounds[i],
      answers: r.answers,
      trackedAnswers: r.tracked,
      totalMentions: r.total,
      trackedMentions: r.own,
      sentMentions: r.sentT,
      positiveMentions: r.sentP,
      avgPosition: Math.round((r.rank[0] / r.rank[1]) * 10) / 10,
      totalCitations: r.cit[1],
      ownedCitations: r.cit[0],
      measuredDays: 1,
      firstAt: `${rounds[i]}T01:00:00.000Z`,
      lastAt: `${rounds[i]}T02:00:00.000Z`,
      ...(unit === "week" ? {} : {}),
    } as StandardTrendBucket;
  };
  const apiTrend = (bucket: "cycle" | "week"): S["TrendData"] => {
    const pts = (f: (r: (typeof byRound)[number]) => { ratio?: S["Ratio"]; rank?: S["RankAvg"] }) =>
      rounds.map((b, i) => ({ bucket: b, ...f(byRound[i]) }));
    const ratio = (metric: string, f: (r: (typeof byRound)[number]) => S["Ratio"]): S["TrendSeries"] => ({ metric, kind: "ratio", points: pts((r) => ({ ratio: f(r) })) });
    return {
      bucket,
      dimension: "none",
      own_label: "Kia",
      buckets: rounds.map((k) => ({ key: k, round_dates: [k], measured_days: 1 })),
      series: [
        ratio("visibility", (r) => ({ num: r.tracked, den: r.answers })),
        ratio("share_of_voice", (r) => ({ num: r.own, den: r.total })),
        ratio("sentiment", (r) => ({ num: r.sentP, den: r.sentT })),
        { metric: "position", kind: "rank", points: pts((r) => ({ rank: { sum: r.rank[0], count: r.rank[1] } })) },
        ratio("citation_share", (r) => ({ num: r.cit[0], den: r.cit[1] })),
        ratio("owned_url_rate", (r) => ({ num: r.acc[1], den: r.answers })),
        ratio("target_url_rate", (r) => ({ num: r.acc[0], den: r.answers })),
        // ⑥ = target ∧ owned / owned answers (legacy aggregateCitationAccuracyTrend), the requested series (#13)
        ratio("citation_accuracy", (r) => ({ num: r.acc[0], den: r.acc[1] })),
      ],
    };
  };
  const last = byRound[1];

  it("cards (Δ, ⑥, #16 target, engine badge), trend values and composition equal; no GA4 market = no ⑦ tile", async () => {
    // legacy readers of the world
    const agg = {
      ...legacyAgg(),
      totalAnswers: last.answers,
      trackedAnswerCount: last.tracked,
      totalMentions: last.total,
      brands: [
        { name: "Kia", mentionCount: last.own, answerCount: last.tracked, isTracked: true },
        { name: "Toyota", mentionCount: 36, answerCount: 20, isTracked: false },
        { name: "Honda", mentionCount: 36, answerCount: 18, isTracked: false },
      ],
      position: { avgPosition: 1.5, sampledAnswers: 30 },
      sentiment: { positiveRate: pct(last.sentP, last.sentT), positiveMentions: last.sentP, sampledMentions: last.sentT },
      citations: { sampledAnswers: 60, answersWithCitation: 40, totalCitations: last.cit[1], ownedCitations: last.cit[0], domains: [] },
    } as StandardAggregates;
    vi.mocked(server.fetchProjectStandardAggregates).mockResolvedValue(agg);
    vi.mocked(server.fetchProjectTrend).mockImplementation(async (_p, _f, unit) => [legacyBucket(0, unit as "day"), legacyBucket(1, unit as "day")]);
    vi.mocked(server.fetchProjectCitationAccuracyTrend).mockImplementation(async () =>
      rounds.map((b, i) => ({ bucketStart: b, ownedAnswers: byRound[i].acc[1], targetAnswers: byRound[i].acc[0], rate: pct(byRound[i].acc[0], byRound[i].acc[1]), measuredDays: 1, firstAt: null, lastAt: null })),
    );
    vi.mocked(server.fetchProjectCitationAccuracy).mockResolvedValue({ ownedAnswers: last.acc[1], targetAnswers: last.acc[0], rate: pct(last.acc[0], last.acc[1]) });
    const engineRows: SubKpiEngineRow[] = [
      { engine: "chatgpt", answers: 30, tracked: 18, multi: 0, top1: 0, top3: 0, avgPosition: 1.5, totalMentions: 60, trackedMentions: 24, sentMentions: 15, positiveMentions: 9, negativeMentions: 0, citTotal: 24, citOwned: 6 },
      { engine: "gemini", answers: 30, tracked: 12, multi: 0, top1: 0, top3: 0, avgPosition: 2, totalMentions: 60, trackedMentions: 24, sentMentions: 15, positiveMentions: 9, negativeMentions: 0, citTotal: 24, citOwned: 6 },
    ];
    vi.mocked(server.fetchProjectSubKpis).mockResolvedValue({ rows: engineRows, promptsWithoutBrand: null, measuredPrompts: null });
    vi.mocked(server.fetchProjectPromptTopics).mockResolvedValue([{ topic: "구매", prompts: 4 }]);
    vi.mocked(server.fetchProjectSourceComposition).mockResolvedValue([{ domain: "kia.com", citations: 12, share: 25, isOurs: true }, { domain: "x.com", citations: 36, share: 75, isOurs: false }]);
    vi.mocked(trackedUrls.listProjectTrackedUrls).mockResolvedValue([{ url: "https://kia.com/de/ev9" }] as never);
    vi.mocked(ownedBases.listProjectOwnedBases).mockResolvedValue([{ baseUrl: "kia.com/de" }] as never);
    vi.mocked(projects.projectRepository.getById).mockResolvedValue({ id: PID, brand: "Kia", country: "DE", domain: "kia.com/de" } as never);
    vi.mocked(tracked.trackedCompetitorRepository.getTargetBrand).mockResolvedValue("Toyota");
    vi.mocked(ga4Map.resolveProperty).mockResolvedValue(null);
    const legacy = await withRequestScope(() => projLive.getProjectDashboard(PID, {}));

    vi.stubEnv("HGH_SOURCE_G6", "api");
    routes[`/v1/projects/${PID}`] = () =>
      json({ data: { project_id: PID, name: "p", country_code: "DE", brand_code: "Kia", created_at: "2026-09-01T00:00:00Z", created_by: PID, updated_at: "2026-09-01T00:00:00Z", effective_engines: [], scope_linked: true, target_brand: "Toyota" }, meta: meta({ mode: "crud" }) });
    routes[`/v1/projects/${PID}/prompt-candidates`] = () => json({ data: { items: [] }, meta: meta({ mode: "crud" }) });
    routes["/v1/filters/dates"] = () => json({ data: { dates: rounds, dates_truncated: false, first_measured_date: rounds[0], latest_round_date: rounds[1], presets: [] }, meta: meta() });
    routes["/v1/filters/options"] = () => json({ data: { catalog: null, custom_fields: [], engines: [], geo_matrix: [], languages: [], regions: [] }, meta: meta() });
    routes["/v1/kpi/summary"] = () =>
      json({
        data: {
          visibility: { num: last.tracked, den: last.answers },
          share_of_voice: { num: last.own, den: last.total },
          sentiment: { num: last.sentP, den: last.sentT },
          position: { sum: 45, count: 30 },
          citation_share: { num: last.cit[0], den: last.cit[1] },
          owned_url_rate: { num: last.acc[1], den: last.answers },
          target_url_rate: { num: last.acc[0], den: last.answers },
          citation_accuracy: { num: last.acc[0], den: last.acc[1] },
          params: { answers: last.answers, applied_prompts: 4, measured_prompts: 4, prompts_without_brand: 0, measured_by_funnel: [{ funnel: "구매", measured_prompts: 4 }] },
          analysis_gap: { gap_answers: 0, base_answers: last.answers },
        },
        meta: meta({ surface: "project" }),
      });
    routes["/v1/trend"] = (u) => json({ data: apiTrend(u.searchParams.get("bucket") as "cycle" | "week"), meta: meta() });
    routes["/v1/kpi/engines"] = (u) =>
      json({
        data: honourEngines({
          rows: engineRows.map((r) => ({ engine: r.engine, answers: r.answers, tracked: r.tracked, multi: 0, top1: 0, top3: 0, rank_sum: Math.round((r.avgPosition ?? 0) * r.tracked), ranked: r.tracked, total_mentions: r.totalMentions, tracked_mentions: r.trackedMentions, sent_mentions: r.sentMentions, positive_mentions: r.positiveMentions, negative_mentions: 0, cit_total: r.citTotal, cit_owned: r.citOwned })),
          engine_consistency: { visibility: null, share_of_voice: null, sentiment: null, position: null, citation_share: null },
        }, u),
        meta: meta(),
      });
    routes["/v1/citations/domains"] = (u) =>
      json({
        data: honourDomains({
          items: [
            { domain: "x.com", skey: "x.com", citations: 36, citing_answers: 1, coverage: { num: 1, den: 1 }, share: { num: 36, den: 48 }, is_own: false, is_social: false, is_target: false, own_citations: 0, category: null },
            { domain: "kia.com", skey: "kia.com", citations: 12, citing_answers: 1, coverage: { num: 1, den: 1 }, share: { num: 12, den: 48 }, is_own: true, is_social: false, is_target: false, own_citations: 12, category: null },
          ],
          competitor_totals: [{ brand: "Toyota", citations: 36, sources: 1 }],
          summary: { answers_den: 60, own_share: { num: 12, den: 48 }, unique_sources: 2 },
        }, u),
        meta: meta(),
      });
    routes["/v1/mentions/brands"] = (u) =>
      json({
        data: honourBrands({
          brands: [
            { name: "Kia", rank: 1, mentions: last.own, exposure: { num: 30, den: 60 }, share: { num: last.own, den: last.total }, avg_rank: null, is_own: true, is_hmg_own: true, brand_key: 1, sentiment: { positive: 5, neutral: 1, negative: 0, mixed: 0 } },
            { name: "Toyota", rank: 2, mentions: 36, exposure: { num: 20, den: 60 }, share: { num: 36, den: last.total }, avg_rank: null, is_own: false, is_hmg_own: false, brand_key: 2, sentiment: { positive: 3, neutral: 0, negative: 1, mixed: 0 } },
            { name: "Honda", rank: 3, mentions: 36, exposure: { num: 18, den: 60 }, share: { num: 36, den: last.total }, avg_rank: null, is_own: false, is_hmg_own: false, brand_key: 3, sentiment: { positive: 1, neutral: 0, negative: 0, mixed: 0 } },
          ],
          own: { brands: ["Kia"], vp_label: "Kia", mentions: last.own, rank: 1, exposure: { num: 30, den: 60 }, share: { num: last.own, den: last.total }, avg_rank: null },
          totals: { answers: 60, brand_count: 3, mentions_total: last.total },
        }, u),
        meta: meta(),
      });
    routes[`/v1/projects/${PID}/settings`] = (u) => {
      const full = {
        project_id: PID,
        can_edit: false,
        domain: "kia.com/de",
        owned_bases: [{ base_url: "kia.com/de", base_norm: "kia.com/de", created_at: "2026-09-01T00:00:00Z", created_by: PID }],
        tracked_url_count: 1,
        competitors: [
          { brand_name: "Honda", is_target: false, created_at: "2026-09-01T00:00:00Z" },
          { brand_name: "Toyota", is_target: true, created_at: "2026-09-01T00:00:00Z" },
        ],
        brand_aliases: {},
        engines: { allowed: [], effective: [] },
        vehicles: [],
      };
      // view=card (P3): engines / aliases / vehicles null, competitors = the designated row only
      const card = { ...full, competitors: full.competitors.filter((c) => c.is_target), brand_aliases: null, engines: null, vehicles: null };
      return json({ data: u.searchParams.get("view") === "card" ? card : full, meta: meta({ mode: "crud" }) });
    };
    // the project's GA4 market has no property (legacy resolveProperty null): unmapped
    routes["/v1/funnel/conversion"] = (u) => json({ data: honourConversion(conversion(1, 0, 0, 0, []), u), meta: meta() });
    const legacyReads = vi.mocked(server.fetchProjectStandardAggregates).mock.calls.length;
    const api = await withRequestScope(() => projLive.getProjectDashboard(PID, {}));

    expect(legacy).not.toBeNull();
    expect(api).not.toBeNull();
    // the api run really went to the backend and never to the legacy readers
    expect(vi.mocked(server.fetchProjectStandardAggregates).mock.calls.length).toBe(legacyReads);
    const hit = vi.mocked(fetch).mock.calls.map((c) => new URL(String(c[0])).pathname);
    for (const p of ["/v1/kpi/summary", "/v1/trend", "/v1/kpi/engines", "/v1/citations/domains", "/v1/mentions/brands", `/v1/projects/${PID}/settings`, "/v1/funnel/conversion"]) {
      expect(hit, p).toContain(p);
    }
    // #16 reads the rows matching the designated target (BG-19 full + q, B028) without the sentiment
    const hitUrls = vi.mocked(fetch).mock.calls.map((c) => new URL(String(c[0])));
    const brandsCall = hitUrls.find((u) => u.pathname === "/v1/mentions/brands")!;
    expect([brandsCall.searchParams.get("full"), brandsCall.searchParams.get("q"), brandsCall.searchParams.get("include_sentiment")]).toEqual(["true", "Toyota", "false"]);
    // the lighter reads of the other calls (B029, B030, B033): the routes above apply their effect
    expect(hitUrls.find((u) => u.pathname === `/v1/projects/${PID}/settings`)?.searchParams.get("view")).toBe("card");
    expect(hitUrls.find((u) => u.pathname === "/v1/funnel/conversion")?.searchParams.get("summary_only")).toBe("true");
    expect(hitUrls.find((u) => u.pathname === "/v1/kpi/engines")?.searchParams.getAll("parts")).toEqual(["citation", "sov"]);
    expect(hitUrls.filter((u) => u.pathname === "/v1/citations/domains").every((u) => u.searchParams.get("include_den") === "false")).toBe(true);
    expect(hitUrls.find((u) => u.pathname === `/v1/projects/${PID}/prompt-candidates`)?.searchParams.get("include_total")).toBe("false");
    expect(hitUrls.find((u) => u.pathname === "/v1/kpi/summary")?.searchParams.getAll("parts")).toEqual(["urls"]);
    // #13: both trend calls (chart and Δ) request the ⑥ series; ⑥ is never derived from the M06/M07 numerators
    const trendCalls = hitUrls.filter((u) => u.pathname === "/v1/trend");
    expect(trendCalls.length).toBe(2);
    expect(trendCalls.every((u) => u.searchParams.getAll("metrics").includes("citation_accuracy"))).toBe(true);
    expectOnlyKnown(legacy!.kpis, api!.kpis, []);
    expect(api!.kpis.map((k) => k.key)).toEqual(["visibility", "shareOfVoice", "sentiment", "position", "citationShare", "citationAccuracy"]);
    expectOnlyKnown(
      legacy!.trend?.points.map((p) => p.values),
      api!.trend?.points.map((p) => p.values),
      [],
    );
    expectOnlyKnown(legacy!.composition, api!.composition, []);
    expect([api!.citationAccuracyNotice, api!.trendDegraded]).toEqual([legacy!.citationAccuracyNotice, legacy!.trendDegraded]);
  });
});

// ── failure paths (legacy semantics kept) ────────────────────────────────────

describe("failure paths on the api sources", () => {
  const ok = (data: unknown) => () => json({ data, meta: meta() });
  function projectRoutes() {
    routes[`/v1/projects/${PID}`] = ok({ project_id: PID, name: "p", country_code: "DE", created_at: "2026-09-01T00:00:00Z", created_by: PID, updated_at: "2026-09-01T00:00:00Z", effective_engines: [], scope_linked: true, target_brand: null });
    routes[`/v1/projects/${PID}/prompt-candidates`] = ok({ items: [] });
    routes["/v1/filters/dates"] = ok({ dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] });
    routes["/v1/filters/options"] = ok({ catalog: null, custom_fields: [], engines: [], geo_matrix: [], languages: [], regions: [] });
    routes["/v1/kpi/summary"] = ok(apiSummary());
    routes["/v1/kpi/engines"] = ok({ rows: [], engine_consistency: { visibility: null, share_of_voice: null, sentiment: null, position: null, citation_share: null } });
    routes["/v1/citations/domains"] = ok({ items: [], competitor_totals: [], summary: { answers_den: 0, own_share: { num: 0, den: 0 }, unique_sources: 0 } });
    routes["/v1/mentions/brands"] = ok(apiBrands());
    routes[`/v1/projects/${PID}/settings`] = ok({ project_id: PID, can_edit: false, domain: null, owned_bases: [], tracked_url_count: 0, competitors: [], brand_aliases: {}, engines: { allowed: [], effective: [] }, vehicles: [] });
    routes["/v1/funnel/conversion"] = ok(conversion(0, 0, 0, 0, []));
    routes["/v1/trend"] = ok({ bucket: "week", dimension: "none", own_label: "HMG", buckets: [], series: [] });
  }
  function websiteEssentials() {
    routes["/v1/kpi/summary"] = ok(apiSummary());
    routes["/v1/mentions/brands"] = ok(apiBrands());
    routes["/v1/filters/dates"] = ok({ dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] });
    routes["/v1/filters/options"] = ok({ catalog: null, custom_fields: null, engines: [], geo_matrix: [], languages: [], regions: [] });
  }
  const fail = (status: number, code: string) => () =>
    new Response(JSON.stringify({ error: { code, message: "", details: null } }), { status, headers: { "content-type": "application/json" } });

  it("project: summary 5xx fails the section (legacy aggregate read had no degrade)", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    projectRoutes();
    routes["/v1/kpi/summary"] = fail(503, "upstream");
    await expect(withRequestScope(() => projLive.getProjectDashboard(PID, {}))).rejects.toMatchObject({ status: 503 });
  });

  it("project: week trend 5xx -> trendDegraded (legacy label projectTrend:week), cards stay", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    projectRoutes();
    routes["/v1/trend"] = (u) => (u.searchParams.get("bucket") === "week" ? fail(504, "timeout")() : ok({ bucket: "cycle", dimension: "none", own_label: "HMG", buckets: [], series: [] })());
    const d = await withRequestScope(() => projLive.getProjectDashboard(PID, {}));
    expect([d?.trend, d?.trendDegraded, d?.kpis.length]).toEqual([null, true, 5]);
  });

  it("project: secondary reads failing transiently empty only their part (U5-N6); a 403 still fails", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    projectRoutes();
    routes["/v1/kpi/engines"] = fail(502, "upstream");
    routes["/v1/citations/domains"] = fail(503, "upstream");
    routes["/v1/mentions/brands"] = fail(504, "timeout");
    const [d, labels] = await withRequestScope(async () => [await projLive.getProjectDashboard(PID, {}), degradedLabels()] as const);
    expect(d?.composition).toEqual({ topics: [], sources: [] });
    expect(d?.kpis.some((k) => k.engineConsistency !== undefined || k.competitorSov !== undefined)).toBe(false);
    // B027: the composition panel would vanish -> its label is recorded for the in-place notice;
    // the inline parts (badge, KPI #16) stay silent (UC-16)
    expect(labels).toEqual([D.PROJECT_COMPOSITION_LABEL]);
    routes["/v1/kpi/engines"] = fail(403, "menu_forbidden");
    await expect(withRequestScope(() => projLive.getProjectDashboard(PID, {}))).rejects.toMatchObject({ status: 403 });
  });

  it("project: a transient ⑦ GA4 failure drops the tile and records projectTrafficConversion (B027); a 4xx still fails", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    projectRoutes();
    // a reachable GA4 market with sessions: the tile is drawn on the ok path
    routes["/v1/funnel/conversion"] = ok(conversion(1, 1, 7, 160, []));
    const okRun = await withRequestScope(async () => [await projLive.getProjectDashboard(PID, {}), degradedLabels()] as const);
    expect(okRun[0]?.kpis.find((k) => k.key === "trafficConversion")).toMatchObject({ value: 4.4, ratio: { numerator: 7, denominator: 160 } });
    expect(okRun[1]).toEqual([]);
    routes["/v1/funnel/conversion"] = fail(503, "upstream");
    const [d, labels] = await withRequestScope(async () => [await projLive.getProjectDashboard(PID, {}), degradedLabels()] as const);
    expect(d?.kpis.map((k) => k.key)).toEqual(["visibility", "shareOfVoice", "sentiment", "position", "citationShare"]);
    expect(labels).toEqual([D.PROJECT_CONVERSION_LABEL]);
    routes["/v1/funnel/conversion"] = fail(403, "menu_forbidden");
    await expect(withRequestScope(() => projLive.getProjectDashboard(PID, {}))).rejects.toMatchObject({ status: 403 });
  });

  it("project: ⑦ summary_only (B096) gives the same tile as the full answer (the tile has no sparkline)", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    projectRoutes();
    const run = async (honour: boolean) => {
      routes["/v1/funnel/conversion"] = (u) => {
        const full = conversion(1, 1, 7, 160, [3, 5, 8]);
        return json({ data: honour ? honourConversion(full, u) : full, meta: meta() });
      };
      return withRequestScope(() => projLive.getProjectDashboard(PID, {}));
    };
    const lighter = await run(true);
    const full = await run(false);
    expect(lighter?.kpis).toEqual(full?.kpis);
    expect(lighter?.kpis.some((k) => k.key === "trafficConversion")).toBe(true);
  });

  it("project: a failed essential dates call is sent once per request, not again by later sections or the shell (D3)", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    projectRoutes();
    const DELAY = 150;
    // /v1/filters/dates answers 504 after DELAY (the routes table is synchronous, so wrap fetch)
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname === "/v1/filters/dates") {
        await new Promise((r) => setTimeout(r, DELAY));
        return fail(504, "timeout")();
      }
      return base(input, init);
    });
    const dateCalls = () => fetchMock.mock.calls.filter(([i]) => new URL(String(i)).pathname === "/v1/filters/dates").length;
    const f = { cumulative: false };
    const t0 = Date.now();
    const [dash, dates] = await withRequestScope(async () => {
      // page.tsx order: tiles after the essentials, options awaited alongside
      const ctx = { surface: "project" as const, projectId: PID, scope: null };
      await Promise.all([
        D.afterFirstRender(f, ctx, () => D.loadProjectOverview(PID)),
        loadPanelOptions({ surface: "project", projectId: PID, scope: null, filters: f }),
      ]);
      // then the shell: the KPI section (its own gate with the custom fields ctx) and the calendar
      return Promise.all([
        projLive.getProjectDashboard(PID, { ...f, customFieldFilters: {} }),
        D.loadEssentialFilterDates({ surface: "project", projectId: PID, scope: null }),
      ]);
    });
    const elapsed = Date.now() - t0;
    expect(dash).not.toBeNull();
    expect(dates).toBeNull(); // a transient calendar failure keeps the filter bar (legacy .catch(null))
    expect(dateCalls()).toBe(1);
    expect(elapsed).toBeLessThan(2 * DELAY);
  });

  /** Wraps the routed fetch: `path` answers 504 after `delay` ms. Returns the call counter of `path`. */
  function slowTimeout(path: string, delay: number): () => number {
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === path) {
        await new Promise((r) => setTimeout(r, delay));
        return fail(504, "timeout")();
      }
      return base(input, init);
    });
    return () => fetchMock.mock.calls.filter(([i]) => new URL(String(i)).pathname === path).length;
  }

  it("project: a failed essential candidates call is not sent again by the tiles (U5 N2, page.tsx order)", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    projectRoutes();
    const DELAY = 150;
    const candidateCalls = slowTimeout(`/v1/projects/${PID}/prompt-candidates`, DELAY);
    const detailCalls = () => vi.mocked(fetch).mock.calls.filter(([i]) => new URL(String(i)).pathname === `/v1/projects/${PID}`).length;
    const f = { cumulative: false };
    const ctx = { surface: "project" as const, projectId: PID, scope: null };
    const t0 = Date.now();
    const [overview, options] = await withRequestScope(() =>
      Promise.allSettled([
        D.afterFirstRender(f, ctx, () => D.loadProjectOverview(PID)),
        loadPanelOptions({ surface: "project", projectId: PID, scope: null, filters: f }),
      ]),
    );
    const elapsed = Date.now() - t0;
    expect(overview).toMatchObject({ status: "rejected", reason: { status: 504 } });
    expect(options.status).toBe("fulfilled");
    expect(candidateCalls()).toBe(1);
    expect(detailCalls()).toBe(1);
    expect(elapsed).toBeLessThan(2 * DELAY);
  });

  it("global: a failed essential brands call is not sent again by the competitor rows (U5 N2)", async () => {
    vi.stubEnv("HGH_SOURCE_G1", "api");
    routes["/v1/kpi/summary"] = ok(apiSummary());
    routes["/v1/funnel/conversion"] = ok(conversion(0, 0, 0, 0, []));
    routes["/v1/filters/dates"] = ok({ dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] });
    routes["/v1/trend"] = ok({ bucket: "cycle", dimension: "brand", own_label: "HMG", buckets: [], series: [] });
    routes["/v1/citations/domains"] = ok({ items: [], competitor_totals: [], summary: { answers_den: 0, own_share: { num: 0, den: 0 }, unique_sources: 0 }, competitor_sources: [] });
    const DELAY = 150;
    const brandCalls = slowTimeout("/v1/mentions/brands", DELAY);
    const ctx = { surface: "global" as const, scope: ADMIN.user.scope };
    const failed: string[] = [];
    const t0 = Date.now();
    // page.tsx order: the cards (getLiveDashboard) and the competitor rows after the essentials
    const [cards, sources] = await withRequestScope(() =>
      Promise.all([
        dashLive.getLiveDashboard({}),
        D.afterFirstRender({}, ctx, () => D.loadCompetitorSources({}, ctx, { onFailure: (label) => failed.push(label) })),
      ]),
    );
    const elapsed = Date.now() - t0;
    expect(cards?.kpis.some((k) => k.competitorSov !== undefined)).toBe(false); // KPI #16 dropped, cards kept
    expect(sources.brands).toEqual([]);
    expect(failed).toEqual(["standardMentions"]);
    expect(brandCalls()).toBe(1);
    expect(elapsed).toBeLessThan(2 * DELAY);
  });

  it("website: engine badge, composition and GEO 5xx degrade to the legacy empty shapes with the legacy labels (D1)", async () => {
    // admin with one brand chosen (Kia): the GEO tree has an active brand, so /v1/geo is requested
    const f = { brand: ["Kia"] };
    // legacy: the three readers degraded (degradeAware returns their empty value and records the label)
    vi.mocked(server.fetchWebsiteSubKpis).mockResolvedValue({ rows: [], promptsWithoutBrand: null, measuredPrompts: null });
    vi.mocked(server.fetchWebsitePromptTopics).mockResolvedValue([]);
    vi.mocked(server.fetchWebsiteSourceComposition).mockResolvedValue([]);
    vi.mocked(server.fetchWebsiteGeoCompetition).mockResolvedValue([]);
    const legacy = await withRequestScope(async () => [
      await webLive.getLiveWebsiteSubKpis(f),
      await webLive.getLiveWebsiteComposition(f),
      await webLive.getLiveWebsiteGeo(f),
    ]);

    vi.stubEnv("HGH_SOURCE_G3", "api");
    websiteEssentials();
    routes["/v1/kpi/engines"] = fail(503, "upstream");
    routes["/v1/citations/domains"] = fail(503, "upstream");
    routes["/v1/geo"] = fail(504, "timeout");
    const [api, labels] = await withRequestScope(async () => {
      const out = [
        await webLive.getLiveWebsiteSubKpis(f),
        await webLive.getLiveWebsiteComposition(f),
        await webLive.getLiveWebsiteGeo(f),
      ];
      return [out, degradedLabels()] as const;
    });
    expectOnlyKnown(legacy, api, []);
    expect([...labels].sort()).toEqual(["websiteGeoCompetition", "websiteSourceComposition", "websiteSubKpis"]);

    expect((api[2] as { pending: string[] }).pending).toEqual(rhqRegionIdsForBrand("Kia"));

    // a 4xx is not a delay: it is raised (permission or filter bug)
    routes["/v1/kpi/engines"] = fail(403, "menu_forbidden");
    await expect(withRequestScope(() => webLive.getLiveWebsiteSubKpis({}))).rejects.toMatchObject({ status: 403 });
  });

  it("website: no single active brand -> /v1/geo is not requested and the legacy empty tree comes back (B033)", async () => {
    const geoCalls = () => vi.mocked(fetch).mock.calls.filter(([i]) => new URL(String(i)).pathname === "/v1/geo").length;
    const cases: { scope: Record<string, unknown>; role: string; filters: Record<string, unknown> }[] = [
      { scope: { all: true }, role: "admin", filters: {} }, // admin without a brand: every HMG brand is the perspective
      { scope: { all: true }, role: "admin", filters: { brand: ["Hyundai", "Kia"] } }, // two brands chosen in the URL
      { scope: { all: false, brands: ["Hyundai", "Kia"] }, role: "hq", filters: { brand: ["Hyundai", "Kia", "HMG"] } }, // two-brand lock
    ];
    for (const c of cases) {
      session.current = { user: { ...ADMIN.user, role: c.role, scope: c.scope } };
      vi.unstubAllEnvs();
      vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
      vi.mocked(server.fetchWebsiteGeoCompetition).mockResolvedValue([
        { code: "DE", brand: "Kia", mentions: 20, isTracked: true },
        { code: "DE", brand: "Toyota", mentions: 25, isTracked: false },
      ] as never);
      const legacy = await withRequestScope(() => webLive.getLiveWebsiteGeo(c.filters));

      vi.stubEnv("HGH_SOURCE_G3", "api");
      websiteEssentials();
      routes["/v1/geo"] = fail(500, "should_not_be_called");
      const before = geoCalls();
      const [api, labels] = await withRequestScope(async () => [await webLive.getLiveWebsiteGeo(c.filters), degradedLabels()] as const);
      expect(geoCalls(), JSON.stringify(c)).toBe(before);
      expect(api.markets).toEqual([]);
      expect(labels).toEqual([]);
      expectOnlyKnown(legacy, api, []);
    }
  });

  it("global: GEO 5xx -> the section is empty with the legacy label standardGeoCompetition (B027), a 4xx is raised", async () => {
    vi.stubEnv("HGH_SOURCE_G1", "api");
    routes["/v1/kpi/summary"] = ok(apiSummary());
    routes["/v1/mentions/brands"] = ok(apiBrands());
    routes["/v1/filters/dates"] = ok({ dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] });
    routes["/v1/geo"] = fail(503, "upstream");
    const [geo, labels] = await withRequestScope(async () => [await dashLive.getLiveGeo({}), degradedLabels()] as const);
    expect(geo).toBeNull();
    expect(labels).toEqual(["standardGeoCompetition"]);
    routes["/v1/geo"] = fail(403, "role_forbidden");
    await expect(withRequestScope(() => dashLive.getLiveGeo({}))).rejects.toMatchObject({ status: 403 });
  });

  it("website: GEO 5xx on a single-brand account (Kia) keeps the legacy pending regions (D1, U5 N1)", async () => {
    session.current = { user: { ...ADMIN.user, role: "country", scope: { all: false, brands: ["Kia"] } } };
    vi.mocked(server.fetchWebsiteGeoCompetition).mockResolvedValue([]);
    const legacy = await withRequestScope(() => webLive.getLiveWebsiteGeo({}));

    vi.stubEnv("HGH_SOURCE_G3", "api");
    websiteEssentials();
    routes["/v1/geo"] = fail(504, "timeout");
    const api = await withRequestScope(() => webLive.getLiveWebsiteGeo({}));
    expect(legacy.pending).toEqual(rhqRegionIdsForBrand("Kia"));
    expectOnlyKnown(legacy, api, []);
  });

  it("website: trend 5xx is raised as before (no degrade label on the website trend)", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    routes["/v1/kpi/summary"] = ok(apiSummary());
    routes["/v1/mentions/brands"] = ok(apiBrands());
    routes["/v1/filters/dates"] = ok({ dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] });
    routes["/v1/filters/options"] = ok({ catalog: null, custom_fields: null, engines: [], geo_matrix: [], languages: [], regions: [] });
    routes["/v1/trend"] = fail(503, "upstream");
    await expect(withRequestScope(() => webLive.getLiveWebsiteTrend({}, "week"))).rejects.toMatchObject({ status: 503 });
  });
});

// ── project tiles ────────────────────────────────────────────────────────────

describe("project tiles: buildProjectOverview (legacy rows) vs toProjectOverview (BG-38)", () => {
  it("same counts, last run, recent five (U5-N5: same definitions)", () => {
    const t = (d: number) => new Date(Date.UTC(2026, 8, d));
    const prompts = [
      { id: "p1", text: "a", status: "done" as const, updatedAt: t(3) },
      { id: "p2", text: "b", status: "draft" as const, updatedAt: t(9) },
      { id: "p3", text: "c", status: "running" as const, updatedAt: t(5) },
      { id: "p4", text: "d", status: "failed" as const, updatedAt: t(8) },
      { id: "p5", text: "e", status: "done" as const, updatedAt: t(1) },
      { id: "p6", text: "f", status: "paused" as const, updatedAt: t(7) },
    ];
    const candidates = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      text: `t${i}`,
      sourceKeyword: i % 2 ? `k${i}` : null,
      source: (["google_keyword", "social_scraping", "manual"] as const)[i % 3],
      createdAt: t(i + 1),
    }));
    const members = [{ status: "active" as const }, { status: "pending" as const }, { status: "active" as const }];
    const legacy = projLive.buildProjectOverview(prompts, candidates, members);

    const byUpdated = [...prompts].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const api = D.toProjectOverview(
      {
        project_id: PID,
        name: "p",
        country_code: "DE",
        created_at: "2026-09-01T00:00:00Z",
        created_by: PID,
        updated_at: "2026-09-01T00:00:00Z",
        effective_engines: [],
        scope_linked: true,
        prompt_counts: { done: 2, draft: 1, running: 1, failed: 1, paused: 1, queued: 0 },
        candidate_count: candidates.length,
        active_member_count: 2,
        last_run_at: t(5).toISOString(), // running p3 (5th) is later than done p1 (3rd)
        recent_prompts: byUpdated.slice(0, 5).map((p) => ({ prompt_id: p.id, text: p.text, status: p.status, updated_at: p.updatedAt.toISOString() })),
      },
      [...candidates]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 5)
        .map((c) => ({ candidate_id: c.id, text: c.text, source: c.source, source_keyword: c.sourceKeyword, created_at: c.createdAt.toISOString() })),
    );
    expectOnlyKnown(legacy, api, []);
  });
});

// ── lighter card reads: the values the screens draw do not move (B031, B032) ─────────────────

describe("lighter card reads give the same drawn values", () => {
  const B = ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07"];
  type Pt = S["app__features__analytics__trend__series__schemas__TrendPoint"];
  const ratio = (num: number, den: number): S["Ratio"] => ({ num, den });

  it("B031 competitor Δ: top=1 + the candidate keys gives the candidates the same Δ as top=20", () => {
    // own + five competitors over four rounds. A..E by mentions; the candidates are B and D (brand_key).
    // C alone has a rank on round 3 (the other rows are null there), round 4 is a collection-error gap.
    const gap = (bucket: string): Pt => ({ bucket, gap: true, gap_reason: "collection_error", ratio: null, rank: null });
    const series = (key: string, own: boolean, bk: number | null, vis: (number | null)[], sov: (number | null)[], pos: ([number, number] | null)[]): S["TrendSeries"][] => {
      const base = { key, is_own: own, ...(own ? { own_brand_code: key } : { label: key }), brand_key: bk };
      const pts = (vals: (number | null)[], den: number): Pt[] =>
        vals.map((v, i) => (i === 3 ? gap(B[i]) : { bucket: B[i], ratio: v === null ? null : ratio(v, den) }));
      return [
        { metric: "visibility", kind: "ratio", ...base, points: pts(vis, 100) },
        { metric: "share_of_voice", kind: "ratio", ...base, points: pts(sov, 300) },
        { metric: "position", kind: "rank", ...base, points: pos.map((r, i): Pt => (i === 3 ? gap(B[i]) : { bucket: B[i], rank: r ? { sum: r[0], count: r[1] } : null })) },
      ] as S["TrendSeries"][];
    };
    const own = series("Kia", true, 1, [60, 62, 64, null], [90, 95, 99, null], [[150, 60], [140, 62], null, null]);
    const comp = {
      A: series("A", false, 10, [50, 49, 51, null], [80, 78, 82, null], [[100, 50], [98, 49], null, null]),
      B: series("B", false, 11, [40, 44, 39, null], [70, 72, 69, null], [[90, 40], null, null, null]),
      C: series("C", false, 12, [30, 31, 35, null], [60, 61, 66, null], [[70, 30], [64, 31], [60, 35], null]),
      D: series("D", false, 13, [20, null, 26, null], [50, 52, 58, null], [[44, 20], [40, 21], null, null]),
      E: series("E", false, 14, [10, 12, 9, null], [30, 33, 29, null], [null, null, null, null]),
    };
    const answer = (picked: (keyof typeof comp)[]): S["TrendData"] => ({
      bucket: "cycle",
      dimension: "brand",
      own_label: "Kia",
      buckets: B.map((k) => ({ key: k, round_dates: [k], measured_days: null })),
      series: [...own, ...picked.flatMap((k) => comp[k])],
    });
    const top20 = answer(["A", "B", "C", "D", "E"]);
    const lighter = answer(["A", "B", "D"]); // top=1 (A) + brand_key B, D
    const candidates = ["B", "D"];
    for (const key of ["visibility", "shareOfVoice"] as const) {
      const full = competitorTrendDeltas(T.toBrandTrendResult(top20), key);
      const light = competitorTrendDeltas(T.toBrandTrendResult(lighter), key);
      for (const c of candidates) expect(light.get(c), `${key} ${c}`).toBe(full.get(c));
    }
    const fullPos = competitorPositionDeltas(T.toFirstPositionResult(top20));
    const lightPos = competitorPositionDeltas(T.toFirstPositionResult(lighter));
    for (const c of candidates) expect(lightPos.get(c), `position ${c}`).toBe(fullPos.get(c));
    // the case is not vacuous: B and D have Δ values, and C's round-3 rank drops a bucket from the lighter answer
    expect([...candidates].map((c) => competitorTrendDeltas(T.toBrandTrendResult(top20), "shareOfVoice").get(c))).toEqual([-1, 2]);
    expect(T.toFirstPositionResult(top20).buckets.length).toBe(T.toFirstPositionResult(lighter).buckets.length + 1);
  });

  it("B032 website trend: without M06/M07 the LiveTrend values, gaps and ⑥ are the same (only urlRateOrigin goes)", () => {
    const hidden = (bucket: string): Pt => ({ bucket, gap: true, gap_reason: "hidden", ratio: null, rank: null });
    const r = (metric: string, vals: ([number, number] | "hidden")[], origin?: ("report" | "live")[]): S["TrendSeries"] => ({
      metric,
      kind: "ratio",
      key: null,
      points: vals.map((v, i): Pt => (v === "hidden" ? hidden(B[i]) : { bucket: B[i], ratio: ratio(v[0], v[1]), ...(origin ? { origin: origin[i] } : {}) })),
    });
    // round 3 hides the citation family (M05, M06, M07 and ACC alike: one family gap per slot)
    const mention = (metric: string, vals: [number, number][]) => r(metric, vals);
    const base: S["TrendSeries"][] = [
      mention("visibility", [[40, 80], [45, 90], [44, 88], [50, 100]]),
      mention("share_of_voice", [[50, 200], [60, 240], [58, 230], [70, 260]]),
      mention("sentiment", [[20, 30], [21, 30], [22, 33], [25, 35]]),
      { metric: "position", kind: "rank", key: null, points: B.map((b, i): Pt => ({ bucket: b, rank: { sum: 60 + i, count: 40 } })) },
      r("citation_share", [[9, 60], [8, 64], "hidden", [10, 70]]),
      r("citation_accuracy", [[6, 12], [7, 13], "hidden", [5, 10]]),
    ];
    const url: S["TrendSeries"][] = [
      // published round 0 carries report prompt counts (their numerators would give another ⑥)
      r("target_url_rate", [[10, 15], [7, 90], "hidden", [6, 100]], ["report", "live", "live", "live"]),
      r("owned_url_rate", [[12, 15], [13, 90], "hidden", [11, 100]], ["report", "live", "live", "live"]),
    ];
    const data = (series: S["TrendSeries"][]): S["TrendData"] => ({
      bucket: "cycle",
      dimension: "none",
      own_label: "HMG",
      buckets: B.map((k) => ({ key: k, round_dates: [k], measured_days: null })),
      series,
    });
    const withUrl = T.toLiveTrend(data([...base.slice(0, 5), ...url, base[5]]), { unit: "week" });
    const without = T.toLiveTrend(data(base), { unit: "week" });
    expectOnlyKnown(withUrl, without, [
      { path: /^points\.\d+\.urlRateOrigin$/, reason: "M06/M07 value source flag: not requested any more, no reader (B032)" },
    ]);
    expect(without.points.map((p) => p.values.citationAccuracy)).toEqual([50, 53.8, undefined, 50]);
    expect(without.points[2].gap).toEqual({ reason: "not_published", scope: "citations" });
    // and the card Δ read from it (applyTrendDeltas) is the same
    const cards = dashLive.buildMirrorKpis(legacyAgg());
    expect(dashLive.applyTrendDeltas(cards, without)).toEqual(dashLive.applyTrendDeltas(cards, withUrl));
  });

  it("B031 sparkline: the card draws the same points from the trimmed trend (SPARKLINE_POINTS = the card's SPARK_POINTS)", () => {
    const points = Array.from({ length: 12 }, (_, i) => ({
      bucketStart: `2026-07-${String(i + 1).padStart(2, "0")}`,
      cycleAnchorAt: `2026-07-${String(i + 1).padStart(2, "0")}T03:00:00.000Z`,
      firstAt: null,
      values: i === 9 ? {} : { visibility: 40 + i, shareOfVoice: 30 + i / 2, sentiment: 60 - i, position: 2 + i / 10, citationShare: 10 + i },
      measuredDays: 1,
      answers: i === 9 ? 0 : 100,
      lastAt: null,
      ...(i === 9 ? { gap: { reason: "collection_error" as const } } : {}),
      ...(i === 10 ? { gap: { reason: "not_published" as const, scope: "citations" as const } } : {}),
    }));
    const trend = { unit: "day" as const, axis: "anchor" as const, points, lastMeasuredAt: null, totalAnswers: 1100 };
    const trimmed = dashLive.sparklineTrend(trend)!;
    expect(trimmed.points).toHaveLength(dashLive.SPARKLINE_POINTS);
    for (const key of ["visibility", "shareOfVoice", "sentiment", "position", "citationShare"] as const) {
      expect(sparkPoints(trimmed, key), key).toEqual(sparkPoints(trend, key));
    }
    expect(dashLive.sparklineTrend(null)).toBeNull();
    const short = { ...trend, points: points.slice(0, 3) };
    expect(dashLive.sparklineTrend(short)).toBe(short);
  });
});
