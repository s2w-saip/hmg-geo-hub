import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// Dashboard adapter (U5): hand-computed conversions, the query each call sends (filter
// consistency, scope values never sent), the D6 first-render order with the real in-request
// dedupe, error mapping (transient -> degrade, 4xx -> raised) and the D8 facades in the dashboard
// and website view-models. Legacy parity lives in dashboard.parity.test.ts.

// react-server build so cache() (in-request dedupe, degrade registry) really memoizes.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
// The legacy readers must not run on the api source: every one of them throws if called.
const legacyCalled = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/scope/server", () => {
  const boom = () => {
    legacyCalled.n += 1;
    throw new Error("legacy reader called on the api source");
  };
  const names = [
    "fetchStandardAggregates", "fetchStandardGeoKpi", "fetchStandardTrend", "fetchStandardSubKpis",
    "fetchStandardPromptTopics", "fetchStandardSourceComposition", "fetchProjectTrend", "fetchProjectSubKpis",
    "fetchProjectPromptTopics", "fetchProjectSourceComposition", "fetchWebsiteAggregates", "fetchWebsiteGeoCompetition",
    "fetchWebsiteTrend", "fetchWebsiteSubKpis", "fetchWebsitePromptTopics", "fetchWebsiteSourceComposition",
    "fetchWebsiteCitationAccuracy", "fetchWebsiteCitationAccuracyTrend", "fetchWebsiteTargetHitRate",
  ];
  return Object.fromEntries(names.map((n) => [n, boom]));
});
vi.mock("@/lib/ga4/property-map", () => ({ resolveProperty: vi.fn(), resolveProperties: vi.fn() }));
vi.mock("@/lib/ga4/conversion", () => ({
  getAiTrafficConversionKpi: vi.fn(),
  getAiTrafficConversionRollup: vi.fn(),
  getAiVisitsKpi: vi.fn(),
}));
const session = vi.hoisted(() => ({
  user: { id: "u", email: "", role: "hq", operator: "none", menuGroups: null, scope: { all: false, brands: ["Kia"], countries: ["DE", "FR"] } },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => session) }));

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("../auth");
const D = await import("./dashboard");
const { wasDegraded } = await import("@/lib/scope/degrade-registry");
const { applyEngineConsistency } = await import("@/app/[locale]/(dash)/dashboard/_data/live");

type S = components["schemas"];
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln"; // {"alg":"ES256"}.{"sub":"u"}.sig
const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CF = "0f8fad5b-d9cb-469f-a165-70867728950e";

const meta = (m: Partial<S["Meta"]> = {}): S["Meta"] => ({ mode: "snapshot", as_of: "2026-09-14", cycles: ["2026-09-14"], ...m });

function summary(o: Partial<S["SummaryData"]> = {}): S["SummaryData"] {
  return {
    visibility: { num: 60, den: 100 },
    share_of_voice: { num: 90, den: 300 },
    sentiment: { num: 40, den: 50 },
    position: { sum: 150, count: 60 },
    citation_share: { num: 12, den: 80 },
    target_url_rate: null,
    owned_url_rate: null,
    citation_accuracy: null,
    params: { answers: 100, applied_prompts: 50, measured_prompts: 40, prompts_without_brand: 5, measured_by_funnel: null },
    analysis_gap: { gap_answers: 0, base_answers: 100 },
    ...o,
  };
}

function brandItem(o: Partial<S["BrandItem"]> & { name: string }): S["BrandItem"] {
  return {
    rank: 1,
    mentions: 0,
    exposure: { num: 0, den: 100 },
    share: { num: 0, den: 300 },
    avg_rank: null,
    is_own: false,
    is_hmg_own: false,
    brand_key: null,
    sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0 },
    ...o,
  };
}

function brands(items: S["BrandItem"][]): S["BrandsData"] {
  return {
    brands: items,
    own: { brands: ["Kia"], vp_label: "Kia", mentions: 90, rank: 1, exposure: { num: 60, den: 100 }, share: { num: 90, den: 300 }, avg_rank: null },
    totals: { answers: 100, brand_count: items.length, mentions_total: 300 },
  };
}

function conversion(o: { total: number; measured: number; conv: number; sessions: number; trend?: number[] }): S["ConversionData"] {
  return {
    coverage: { total_markets: o.total, measured_markets: o.measured, markets: [] },
    summary: {
      ai: { conversions: o.conv, sessions: o.sessions, page_views: 0, conv: { num: o.conv, den: o.sessions } },
      human: { conversions: 0, sessions: 0, conv: { num: 0, den: 0 } },
    },
    trend: (o.trend ?? []).map((s, i) => ({ date: `2026-09-0${i + 1}`, ai_sessions: s, ai_conversions: 0, human_sessions: 0, human_conversions: 0 })),
    by_engine: [],
    by_country: null,
    pages: [],
    period: { from: "2026-08-18", to: "2026-09-14" },
  };
}

function domains(o: Partial<S["DomainsData"]> = {}): S["DomainsData"] {
  return {
    items: [],
    competitor_totals: [],
    summary: { answers_den: 100, own_share: { num: 20, den: 200 }, unique_sources: 9 },
    ...o,
  };
}

function domainRow(domain: string, citations: number, total: number, isOwn = false): S["DomainRow"] {
  return {
    domain,
    skey: domain,
    citations,
    citing_answers: 1,
    coverage: { num: 1, den: 100 },
    share: { num: citations, den: total },
    is_own: isOwn,
    is_social: false,
    is_target: false,
    own_citations: isOwn ? citations : 0,
    category: null,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const errorBody = (status: number, code: string) => json({ error: { code, message: "x", details: null } }, status);

type Route = (u: URL) => Response | Promise<Response>;
let routes: Record<string, Route>;
let calls: URL[];

beforeEach(() => {
  calls = [];
  routes = {};
  legacyCalled.n = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(String(input));
      calls.push(u);
      const r = routes[u.pathname];
      if (!r) return errorBody(404, "not_found");
      return r(u);
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const q = (u: URL) => Object.fromEntries([...new Set(u.searchParams.keys())].map((k) => [k, u.searchParams.getAll(k)]));

// ── conversions (hand-computed) ──────────────────────────────────────────────

describe("⑦ toTrafficConversionKpi (project home tile)", () => {
  it("one market: pct(conversions, sessions), ratio, sparkline of AI sessions", () => {
    // 7 / 160 = 0.04375 -> Math.round(43.75) / 10 = 4.4
    expect(D.toTrafficConversionKpi(conversion({ total: 1, measured: 1, conv: 7, sessions: 160, trend: [3, 5, 8] }))).toEqual({
      key: "trafficConversion",
      value: 4.4,
      delta: null,
      direction: "flat",
      ratio: { numerator: 7, denominator: 160 },
      sparkline: [3, 5, 8],
      copyVariant: "api",
    });
  });
  it("one market without AI sessions or without a mapped property: 측정 대기 (value null)", () => {
    expect(D.toTrafficConversionKpi(conversion({ total: 1, measured: 1, conv: 0, sessions: 0 }))?.value).toBeNull();
    expect(D.toTrafficConversionKpi(conversion({ total: 1, measured: 0, conv: 0, sessions: 0 }))).toEqual({
      key: "trafficConversion",
      value: null,
      delta: null,
      direction: "flat",
      copyVariant: "api",
    });
  });
  it("several markets: legacy rollup = pct with 0 on no sessions, ratio and coverage, no sparkline", () => {
    // 3 / 8 = 0.375 -> 37.5
    expect(D.toTrafficConversionKpi(conversion({ total: 4, measured: 2, conv: 3, sessions: 8, trend: [1] }))).toEqual({
      key: "trafficConversion",
      value: 37.5,
      delta: null,
      direction: "flat",
      ratio: { numerator: 3, denominator: 8 },
      coverage: { measured: 2, total: 4 },
      copyVariant: "api",
    });
    expect(D.toTrafficConversionKpi(conversion({ total: 3, measured: 0, conv: 0, sessions: 0 }))?.value).toBe(0);
  });
  it("no market reached: null (the tile is left out)", () => {
    expect(D.toTrafficConversionKpi(conversion({ total: 0, measured: 0, conv: 0, sessions: 0 }))).toBeNull();
  });
});

describe("competitor rows", () => {
  it("BrandItem -> CompetitorBrandValue: pct share/exposure, rank average, HMG sibling is tracked", () => {
    const v = D.toCompetitorBrandValue(
      brandItem({
        name: "Toyota",
        mentions: 45,
        share: { num: 45, den: 300 }, // 15
        exposure: { num: 33, den: 100 }, // 33
        avg_rank: { sum: 25, count: 10 }, // 2.5
        brand_key: 7,
        sentiment: { positive: 3, neutral: 1, negative: 1, mixed: 0 },
      }),
    );
    expect(v).toEqual({
      brand: "Toyota",
      mentions: 45,
      share: 15,
      mentionRate: 33,
      avgPosition: 2.5,
      isTracked: false,
      sentiment: { positive: 3, neutral: 1, negative: 1, mixed: 0 },
      brandKey: 7,
    });
    expect(D.toCompetitorBrandValue(brandItem({ name: "Hyundai", is_hmg_own: true })).isTracked).toBe(true);
    expect(D.toCompetitorBrandValue(brandItem({ name: "Kia", is_own: true })).isTracked).toBe(true);
  });

  it("candidate brand keys = the three Δ cards' top 4 (mentions desc), HMG and own rows excluded", () => {
    const vals = D.toCompetitorBrandValues([
      brandItem({ name: "Kia", is_own: true, mentions: 90, brand_key: 1 }),
      brandItem({ name: "Hyundai", is_hmg_own: true, mentions: 80, brand_key: 2 }),
      brandItem({ name: "Toyota", mentions: 50, brand_key: 3, avg_rank: { sum: 3, count: 1 } }),
      brandItem({ name: "Ford", mentions: 40, brand_key: 4 }),
      brandItem({ name: "BMW", mentions: 30, brand_key: 5 }),
      brandItem({ name: "Audi", mentions: 20, brand_key: 6 }),
      brandItem({ name: "VW", mentions: 10, brand_key: 8 }),
    ]);
    expect(D.candidateBrandKeys(vals)).toEqual([3, 4, 5, 6]);
  });

  it("competitor_sources -> official competitor domain rows (share of all citations)", () => {
    const rows = D.toCompetitorCitationDomains(
      domains({
        summary: { answers_den: 10, own_share: { num: 5, den: 80 }, unique_sources: 3 },
        competitor_sources: [
          { domain: "toyota.com", skey: "toyota.com", citations: 6, brand: "Toyota" },
          { domain: "toyota.de", skey: "toyota.de", citations: 1, brand: "Toyota" },
        ],
      }),
    );
    // 6/80 = 7.5 ; 1/80 = 1.25 -> Math.round(12.5) = 13 -> 1.3
    expect(rows?.map((r) => [r.domain, r.citations, r.share, r.category, r.isOurs])).toEqual([
      ["toyota.com", 6, 7.5, "Official (Competitor)", false],
      ["toyota.de", 1, 1.3, "Official (Competitor)", false],
    ]);
    expect(D.toCompetitorCitationDomains(domains())).toBeNull();
  });
});

describe("GEO toLiveGeo", () => {
  it("region and country rows with pct / mirror pct / rank average, display name from the catalog", () => {
    const own: S["GeoMetrics"] = {
      visibility: { num: 30, den: 40 }, // 75
      share_of_voice: { num: 20, den: 60 }, // 33.3
      sentiment: { num: 0, den: 0 }, // null
      position: { sum: 7, count: 2 }, // 3.5
      citation_share: null, // null
    };
    const rival = { brand: "Toyota", metrics: { visibility: { num: 10, den: 40 }, share_of_voice: { num: 25, den: 60 }, sentiment: null, position: null, citation_share: null } };
    const row = {
      answers: 40,
      own,
      rank: { our: 2, field_size: 5 },
      top_own_brand: { brand: "Kia", share_of_voice: { num: 20, den: 60 } },
      top_rival: rival,
    };
    const g = D.toLiveGeo({
      active_brand: "Kia",
      own_label: "Kia",
      pending: ["kia-africa"],
      markets: [{ ...row, region_id: "kia-europe", region_label: "Europe", country_count: 1, countries: [{ ...row, code: "DE" }] }],
    });
    const metrics = {
      visibility: { ours: 75, rival: { name: "Toyota", value: 25 } },
      shareOfVoice: { ours: 33.3, rival: { name: "Toyota", value: 41.7 } },
      sentiment: { ours: null, rival: { name: "Toyota", value: null } },
      position: { ours: 3.5, rival: { name: "Toyota", value: null } },
      citationShare: { ours: null, rival: null },
    };
    const base = {
      hmgSov: 33.3,
      hmgRank: 2,
      fieldSize: 5,
      topBrand: { name: "Kia", sov: 33.3 },
      topRival: { name: "Toyota", sov: 41.7 },
      metrics,
    };
    expect(g).toEqual({
      markets: [{ region: "kia-europe", ...base, countries: [{ code: "DE", country: "Germany", ...base }] }],
      pending: ["kia-africa"],
      ourLabel: "Kia",
    });
  });

  it("a market with answers but no brand mention is marked noMentions (its SOV 0/0 is not a measured 0)", () => {
    const zero: S["GeoMetrics"] = {
      visibility: { num: 0, den: 12 },
      share_of_voice: { num: 0, den: 0 },
      sentiment: null,
      position: null,
      citation_share: null,
    };
    const row = { answers: 12, own: zero, rank: { our: 1, field_size: 1 }, top_own_brand: null, top_rival: null };
    const g = D.toLiveGeo({
      active_brand: "Kia",
      own_label: "Kia",
      pending: [],
      markets: [{ ...row, region_id: "kia-europe", region_label: "Europe", country_count: 1, countries: [{ ...row, code: "DE" }] }],
    });
    expect(g.markets[0].noMentions).toBe(true);
    expect(g.markets[0].countries[0].noMentions).toBe(true);
  });
});

describe("engines, composition, project overview", () => {
  const item = (engine: string, o: Partial<S["EngineItem"]>): S["EngineItem"] => ({
    engine,
    answers: null,
    tracked: null,
    multi: null,
    top1: null,
    top3: null,
    rank_sum: null,
    ranked: null,
    total_mentions: null,
    tracked_mentions: null,
    sent_mentions: null,
    positive_mentions: null,
    negative_mentions: null,
    cit_total: null,
    cit_owned: null,
    ...o,
  });

  it("EngineItem -> SubKpiEngineRow; the legacy badge on these rows equals the API engine_consistency", () => {
    const data: S["EnginesData"] = {
      rows: [
        item("chatgpt", { answers: 100, tracked: 60, total_mentions: 200, tracked_mentions: 50, sent_mentions: 40, positive_mentions: 30, rank_sum: 90, ranked: 60, cit_total: 50, cit_owned: 10 }),
        item("gemini", { answers: 80, tracked: 40, total_mentions: 100, tracked_mentions: 50, sent_mentions: 20, positive_mentions: 10, rank_sum: 120, ranked: 40, cit_total: 0, cit_owned: 0 }),
      ],
      // min/max x 100: vis 0.5/0.6 = 83.3, sov 0.25/0.5 = 50, sent 0.5/0.75 = 66.7, pos 1.5/3 = 50, cit one engine -> null
      engine_consistency: { visibility: 83.3, share_of_voice: 50, sentiment: 66.7, position: 50, citation_share: null },
    };
    const sub = D.toSubKpis(data);
    expect(sub.rows[1]).toMatchObject({ engine: "gemini", answers: 80, tracked: 40, avgPosition: 3, citTotal: 0 });
    expect(sub.rows[0].avgPosition).toBe(1.5);
    const cards = [
      { key: "visibility" as const, value: 1, delta: null, direction: "flat" as const },
      { key: "shareOfVoice" as const, value: 1, delta: null, direction: "flat" as const },
      { key: "sentiment" as const, value: 1, delta: null, direction: "flat" as const },
      { key: "position" as const, value: 1, delta: null, direction: "flat" as const },
      { key: "citationShare" as const, value: 1, delta: null, direction: "flat" as const },
    ];
    const badges = applyEngineConsistency(cards, sub.rows).map((k) => k.engineConsistency);
    const api = data.engine_consistency;
    expect(badges).toEqual([api.visibility, api.share_of_voice, api.sentiment, api.position, undefined]);
  });

  it("sources: top 7 + 기타 = all citations minus the top (U5-N2), no 기타 when nothing is left", () => {
    const items = Array.from({ length: 8 }, (_, i) => domainRow(`d${i}.com`, 20 - i, 200, i === 0));
    const slices = D.toSourceSlices(domains({ items }));
    expect(slices).toHaveLength(8);
    // top 7 citations 20+19+...+14 = 119; rest 200 - 119 = 81 -> 40.5
    expect(slices[7]).toEqual({ domain: "", citations: 81, share: 40.5, isOurs: false });
    expect(slices[0]).toEqual({ domain: "d0.com", citations: 20, share: 10, isOurs: true });
    const exact = D.toSourceSlices(domains({ items: [domainRow("a.com", 150, 200), domainRow("b.com", 50, 200)] }));
    expect(exact.map((s) => s.domain)).toEqual(["a.com", "b.com"]);
  });

  it("topics from measured_by_funnel: share = round1(100 * prompts / all)", () => {
    const t = D.toTopicSlices({
      data: summary({
        params: {
          answers: 1,
          applied_prompts: 1,
          measured_prompts: 3,
          prompts_without_brand: 0,
          measured_by_funnel: [
            { funnel: "구매", measured_prompts: 2 },
            { funnel: null, measured_prompts: 1 },
          ],
        },
      }),
      meta: meta(),
    });
    expect(t).toEqual([
      { topic: "구매", prompts: 2, share: 66.7 },
      { topic: null, prompts: 1, share: 33.3 },
    ]);
    expect(D.toTopicSlices(null)).toEqual([]);
  });

  it("ProjectDetail counts + first candidate page -> ProjectOverview", () => {
    const o = D.toProjectOverview(
      {
        project_id: PID,
        name: "p",
        country_code: "DE",
        created_at: "2026-09-01T00:00:00Z",
        created_by: PID,
        updated_at: "2026-09-02T00:00:00Z",
        effective_engines: [],
        scope_linked: false,
        prompt_counts: { draft: 2, done: 3, running: 1 },
        candidate_count: 9,
        active_member_count: 4,
        last_run_at: "2026-09-10T01:02:03Z",
        recent_prompts: [{ prompt_id: "p1", text: "t1", status: "done", updated_at: "2026-09-10T01:02:03Z" }],
      },
      [{ candidate_id: "c1", text: "ct", source: "google_keyword", source_keyword: "kw", created_at: "2026-09-09T00:00:00Z" }],
    );
    expect(o.promptCount).toBe(6);
    expect(o.statusCounts).toEqual([
      { status: "draft", count: 2 },
      { status: "queued", count: 0 },
      { status: "running", count: 1 },
      { status: "done", count: 3 },
      { status: "failed", count: 0 },
      { status: "paused", count: 0 },
    ]);
    expect([o.candidateCount, o.activeMemberCount, o.hasMeasuredPrompts, o.lastAi?.toISOString()]).toEqual([9, 4, true, "2026-09-10T01:02:03.000Z"]);
    expect(o.recentCandidates[0]).toEqual({ id: "c1", text: "ct", sourceKeyword: "kw", source: "google_keyword", createdAt: new Date("2026-09-09T00:00:00Z") });
    expect(o.recentPrompts[0]).toMatchObject({ id: "p1", status: "done" });
  });
});

// ── queries: filter consistency and scope values ──────────────────────────────

describe("queries: one filter serializer, feature params apart, scope values never sent", () => {
  const filters = {
    region: ["DE", "FR"], // = the account's allowed countries: injected by readStandardFilters -> not sent
    engine: ["ChatGPT"],
    brand: ["Kia", "HMG"], // brand lock of a brand-scoped account -> not sent
    lang: ["DE"],
    funnelStage: ["구매"],
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
  };
  const scope = session.user.scope;

  it("every analysis call of a screen carries the same common axes", async () => {
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    routes["/v1/mentions/brands"] = () => json({ data: brands([]), meta: meta() });
    routes["/v1/citations/domains"] = () => json({ data: domains(), meta: meta() });
    routes["/v1/kpi/engines"] = () => json({ data: { rows: [], engine_consistency: { visibility: null, share_of_voice: null, sentiment: null, position: null, citation_share: null } }, meta: meta() });
    routes["/v1/geo"] = () => json({ data: { active_brand: null, own_label: "Kia", pending: [], markets: [] }, meta: meta() });
    const ctx = { surface: "global" as const, scope };
    await D.fetchDashboardSummary(filters, ctx);
    await D.fetchCardBrands(filters, ctx);
    await D.fetchDashboardDomains(filters, ctx, { limit: 0, competitorSources: true });
    await D.fetchEngineRows(filters, ctx);
    await D.fetchGeo(filters, ctx);
    const common = { surface: ["global"], engine: ["chatgpt"], lang: ["de"], funnel: ["구매"], from: ["2026-08-01"], to: ["2026-08-31"] };
    for (const u of calls) {
      const got = q(u);
      for (const k of ["surface", "engine", "lang", "funnel", "from", "to"]) expect(got[k], `${u.pathname} ${k}`).toEqual(common[k as keyof typeof common]);
      expect(got.country, u.pathname).toBeUndefined();
      expect(got.brand, u.pathname).toBeUndefined();
    }
    expect(q(calls[0])).toMatchObject({ parts: ["urls"] });
    expect(q(calls[1])).toMatchObject({ top_n: ["20"], sort: ["mentions"], include: ["hmg"] });
    // global: the ③ competitor minis read the sentiment of these rows, so it is not switched off
    expect(q(calls[1]).include_sentiment).toBeUndefined();
    expect(q(calls[2])).toMatchObject({ limit: ["0"], competitor_sources: ["true"], include_den: ["false"], include_competitor_totals: ["false"] });
    // B090: the badge columns only (sov + citation, no rank_detail); part is not sent (parts wins)
    expect(q(calls[3])).toMatchObject({ parts: ["citation", "sov"] });
    expect(q(calls[3]).part).toBeUndefined();
  });

  it("B011 / B092 / P3: what each card read leaves out (the values it reads are not affected)", async () => {
    routes["/v1/mentions/brands"] = () => json({ data: brands([]), meta: meta() });
    routes["/v1/citations/domains"] = () => json({ data: domains(), meta: meta() });
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    routes[`/v1/projects/${PID}/settings`] = () =>
      json({ data: { project_id: PID, can_edit: false, domain: null, owned_bases: [], tracked_url_count: 0, competitors: [] }, meta: meta({ mode: "crud" }) });
    const website = { surface: "website" as const, scope: null };
    const project = { surface: "project" as const, projectId: PID, scope: null };
    // KPI #16 on website / project reads the competitor mentions only -> no sentiment statement
    await D.fetchCardBrands({}, website);
    await D.fetchCardBrands({}, project);
    expect(q(calls[0])).toMatchObject({ top_n: ["20"], card: ["true"], include_sentiment: ["false"] });
    expect(q(calls[1])).toMatchObject({ top_n: ["20"], include_sentiment: ["false"] });
    // the composition (top 7, website and project) reads neither the coverage denominator nor the competitor sums
    calls.length = 0;
    await D.loadComposition({}, website);
    await D.loadComposition({}, project);
    for (const u of calls.filter((x) => x.pathname === "/v1/citations/domains")) {
      expect(q(u)).toMatchObject({ limit: ["7"], include_den: ["false"], include_competitor_totals: ["false"] });
    }
    // the project KPI section reads the card view of the settings bundle
    calls.length = 0;
    await D.fetchProjectSettings(PID);
    expect(q(calls[0])).toEqual({ view: ["card"] });
  });

  it("a URL country subset IS sent; deny markers (ZZ) are never sent as values", async () => {
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    await D.fetchDashboardSummary({ region: ["DE"] }, { surface: "global", scope });
    await D.fetchDashboardSummary({ region: ["ZZ"] }, { surface: "global", scope: { all: false, countries: ["ZZ"] } });
    expect(q(calls[0]).country).toEqual(["DE"]);
    expect(q(calls[1]).country).toBeUndefined();
  });

  it("⑦ sends market axes only (no period, no engine), days=28; project: property_source=market; no page table", async () => {
    routes["/v1/funnel/conversion"] = () => json({ data: conversion({ total: 1, measured: 1, conv: 1, sessions: 2 }), meta: meta() });
    await D.fetchTrafficConversion(filters, { surface: "global", scope: { all: true } });
    await D.fetchTrafficConversion({ ...filters, region: ["DE"] }, { surface: "project", projectId: PID, scope: null });
    // include_pages=false: the tile never reads data.pages, so the backend skips that aggregation.
    const g = q(calls[0]);
    expect(g).toEqual({ surface: ["global"], brand: ["HMG", "Kia"], country: ["DE", "FR"], days: ["28"], include_pages: ["false"] });
    const p = q(calls[1]);
    // B096 summary_only: the home tile reads the rate and its numerator / denominator only (no sparkline)
    expect(p).toEqual({
      surface: ["project"], project_id: [PID], country: ["DE"], days: ["28"], property_source: ["market"], include_pages: ["false"], summary_only: ["true"],
    });
  });

  it("project: custom fields travel as cf.<uuid>; a designated target reads the rows matching its name (full + q, BG-19)", async () => {
    routes["/v1/mentions/brands"] = () => json({ data: brands([]), meta: meta() });
    await D.fetchCardBrands({}, { surface: "project", projectId: PID, scope: null, customFields: { [CF]: ["b", "a"] } }, "Toyota");
    const got = q(calls[0]);
    expect(got[`cf.${CF}`]).toEqual(["a", "b"]);
    expect(got).toMatchObject({ full: ["true"], q: ["Toyota"], include: ["hmg"], include_sentiment: ["false"], project_id: [PID] });
    expect(got.top_n).toBeUndefined();
    // a name the q bounds refuse (over 100 characters) falls back to every row (the old read), never a 422
    calls.length = 0;
    await D.fetchCardBrands({}, { surface: "project", projectId: PID, scope: null }, "x".repeat(101));
    expect(q(calls[0]).q).toBeUndefined();
    expect(q(calls[0]).full).toEqual(["true"]);
  });

  it("composition: website asks the domains only (topics [] U5-N7), project adds the by_funnel summary", async () => {
    routes["/v1/citations/domains"] = () => json({ data: domains({ items: [domainRow("a.com", 200, 200)] }), meta: meta() });
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    const w = await D.loadComposition({}, { surface: "website", scope: null });
    expect(w).toEqual({ topics: [], sources: [{ domain: "a.com", citations: 200, share: 100, isOurs: false }] });
    expect(calls.map((u) => u.pathname)).toEqual(["/v1/citations/domains"]);
    expect(q(calls[0]).limit).toEqual(["7"]);
    calls.length = 0;
    await D.loadComposition({}, { surface: "project", projectId: PID, scope: null });
    expect(calls.map((u) => u.pathname).sort()).toEqual(["/v1/citations/domains", "/v1/kpi/summary"]);
    expect(q(calls.find((u) => u.pathname === "/v1/kpi/summary")!).by_funnel).toEqual(["true"]);
  });

  it("recent candidates: one page of 5 from the created_at desc list, no total (the tile reads candidate_count)", async () => {
    routes[`/v1/projects/${PID}/prompt-candidates`] = () => json({ data: { items: [] }, meta: meta({ mode: "crud" }) });
    await D.fetchRecentCandidates(PID);
    expect(q(calls[0])).toEqual({ limit: ["5"], include_total: ["false"] });
  });

  it("competitor Δ trend: the candidate brand keys with the minimum top (B031), the three Δ metrics", async () => {
    routes["/v1/mentions/brands"] = () =>
      json({
        data: brands([
          brandItem({ name: "Kia", is_own: true, mentions: 90, brand_key: 1 }),
          brandItem({ name: "Toyota", mentions: 50, brand_key: 3, avg_rank: { sum: 3, count: 1 } }),
          brandItem({ name: "Ford", mentions: 40, brand_key: 4 }),
        ]),
        meta: meta(),
      });
    routes["/v1/trend"] = () => json({ data: { bucket: "cycle", dimension: "brand", own_label: "Kia", buckets: [], series: [] }, meta: meta() });
    routes["/v1/citations/domains"] = () => json({ data: domains({ competitor_sources: [] }), meta: meta() });
    await D.loadCompetitorSources({}, { surface: "global", scope: null });
    const t = q(calls.find((u) => u.pathname === "/v1/trend")!);
    expect(t).toMatchObject({ dimension: ["brand"], bucket: ["cycle"], top: ["1"], brand_key: ["3", "4"], card: ["true"], measured_days: ["false"] });
    expect(t.metrics?.sort()).toEqual(["position", "share_of_voice", "visibility"]);
  });
});

// ── WU-3 card path ───────────────────────────────────────────────────────────

describe("WU-3 card=true: the calls whose legacy reader was the summary tables (header 'WU-3 card path')", () => {
  const period = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
  const trendData = { bucket: "cycle", dimension: "none", buckets: [], series: [] };
  const card = (path: string) => calls.filter((u) => u.pathname === path).map((u) => u.searchParams.getAll("card"));

  beforeEach(() => {
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    routes["/v1/mentions/brands"] = () => json({ data: brands([brandItem({ name: "Toyota", mentions: 5, brand_key: 3 })]), meta: meta() });
    routes["/v1/citations/domains"] = () => json({ data: domains(), meta: meta() });
    routes["/v1/kpi/engines"] = () => json({ data: { rows: [], engine_consistency: { visibility: null, share_of_voice: null, sentiment: null, position: null, citation_share: null } }, meta: meta() });
    routes["/v1/geo"] = () => json({ data: { active_brand: null, own_label: "Kia", pending: [], markets: [] }, meta: meta() });
    routes["/v1/trend"] = () => json({ data: trendData, meta: meta() });
  });

  async function screen(filters: Record<string, unknown>, ctx: Parameters<typeof D.fetchDashboardSummary>[1]) {
    await D.fetchDashboardSummary(filters, ctx);
    await D.fetchCardBrands(filters, ctx);
    await D.fetchGeo(filters, ctx);
    await D.fetchEngineRows(filters, ctx);
    await D.loadLiveTrend(filters, ctx, "cycle");
    await D.loadCompetitorSources(filters, ctx, { onFailure: () => undefined });
    await D.loadComposition(filters, ctx);
  }

  it("global: summary, brands, geo, trend, competitor Δ trend and (no period) domains; not the engine badge (S2.mention)", async () => {
    await screen({}, { surface: "global", scope: null });
    for (const p of ["/v1/kpi/summary", "/v1/mentions/brands", "/v1/geo", "/v1/trend", "/v1/citations/domains"]) {
      expect(card(p).length, p).toBeGreaterThan(0);
      for (const c of card(p)) expect(c, p).toEqual(["true"]);
    }
    expect(card("/v1/kpi/engines")).toEqual([[]]);
    expect(calls.some((u) => u.pathname === "/v1/trend" && u.searchParams.get("dimension") === "brand")).toBe(true);
  });

  it("website: the S4 card reads, the S4.subkpi engine badge and (no period) the S6 composition", async () => {
    await screen({}, { surface: "website", scope: null });
    for (const p of ["/v1/kpi/summary", "/v1/mentions/brands", "/v1/geo", "/v1/kpi/engines", "/v1/trend", "/v1/citations/domains"]) {
      expect(card(p).length, p).toBeGreaterThan(0);
      for (const c of card(p)) expect(c, p).toEqual(["true"]);
    }
  });

  it("with a period the domains calls leave card out (S3/S6.citation took no period route); the rest keep it", async () => {
    await screen(period, { surface: "global", scope: null });
    expect(card("/v1/citations/domains")).toEqual([[], []]);
    // the dashboard domain list stays per host with a period too (legacy axis 'domain' / mirror GROUP BY domain, WU-12)
    expect(calls.filter((u) => u.pathname === "/v1/citations/domains").map((u) => u.searchParams.get("host_fold"))).toEqual(["true", "true"]);
    expect(card("/v1/kpi/summary")).toEqual([["true"]]);
    expect(card("/v1/geo")).toEqual([["true"]]);
    calls.length = 0;
    await D.loadComposition(period, { surface: "website", scope: null });
    expect(card("/v1/citations/domains")).toEqual([[]]);
  });

  it("project never sends card; the shared adapters send it only when asked (answer-analysis tabs do not)", async () => {
    await screen({}, { surface: "project", projectId: PID, scope: null });
    expect(calls.filter((u) => u.pathname === "/v1/citations/domains").every((u) => !u.searchParams.has("host_fold"))).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    for (const u of calls) expect(u.searchParams.has("card"), u.pathname).toBe(false);
    calls.length = 0;
    const { fetchKpiSummary } = await import("./summary");
    const { fetchTrend } = await import("./trend");
    await fetchKpiSummary({}, { surface: "global", scope: null });
    await fetchTrend({}, { surface: "global", scope: null, bucket: "cycle" });
    for (const u of calls) expect(u.searchParams.has("card"), u.pathname).toBe(false);
  });

  it("period compare sends card on global and website, not on project", async () => {
    routes["/v1/kpi/compare"] = () => json({ data: { items: [] }, meta: meta({ mode: "period" }) });
    const { fetchPeriodCompareView } = await import("./compare");
    const req = { kind: "window" as const, metrics: ["visibility" as const] };
    for (const ctx of [
      { surface: "global" as const, scope: null },
      { surface: "website" as const, scope: null },
      { surface: "project" as const, projectId: PID, scope: null },
    ]) {
      await fetchPeriodCompareView(period, { ...ctx, ...req }).catch(() => null);
    }
    expect(card("/v1/kpi/compare")).toEqual([["true"], ["true"], []]);
  });
});

// ── D6 first render ──────────────────────────────────────────────────────────

describe("D6: sections wait for the essential calls, which are requested once", () => {
  function gate() {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  }

  it("global: summary, brands, dates first (no ⑦ conversion); GEO only after all settled; no duplicate requests", async () => {
    const hold = gate();
    const slow = (body: unknown): Route => async () => {
      await hold.p;
      return json(body);
    };
    routes["/v1/kpi/summary"] = slow({ data: summary(), meta: meta() });
    routes["/v1/mentions/brands"] = slow({ data: brands([]), meta: meta() });
    routes["/v1/filters/dates"] = slow({ data: { dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] }, meta: meta() });
    routes["/v1/geo"] = () => json({ data: { active_brand: null, own_label: "HMG", pending: [], markets: [] }, meta: meta() });
    const ctx = { surface: "global" as const, scope: null };
    await withRequestScope(async () => {
      const geo = D.afterFirstRender({}, ctx, () => D.loadLiveGeo({}, ctx));
      const cards = D.loadLiveDashboard({}, ctx); // the card section joins the same essential calls
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.map((u) => u.pathname).sort()).toEqual(
        ["/v1/filters/dates", "/v1/kpi/summary", "/v1/mentions/brands"].sort(),
      );
      hold.open();
      await Promise.all([geo, cards]);
    });
    expect(calls.map((u) => u.pathname).filter((p) => p === "/v1/geo")).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it("an essential call failing does not block the deferred sections", async () => {
    routes["/v1/kpi/summary"] = () => errorBody(503, "upstream");
    routes["/v1/mentions/brands"] = () => json({ data: brands([]), meta: meta() });
    routes["/v1/filters/dates"] = () => json({ data: { dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] }, meta: meta() });
    routes["/v1/geo"] = () => json({ data: { active_brand: null, own_label: "HMG", pending: [], markets: [] }, meta: meta() });
    const ctx = { surface: "global" as const, scope: null };
    const g = await withRequestScope(() => D.afterFirstRender({}, ctx, () => D.loadLiveGeo({}, ctx)));
    expect(g.markets).toEqual([]);
  });

  it("global, website and project essentials", () => {
    const names = (s: "global" | "website" | "project") =>
      D.essentialCalls({}, s === "project" ? { surface: s, projectId: PID, scope: null } : { surface: s, scope: null }).length;
    expect([names("global"), names("website"), names("project")]).toEqual([3, 4, 4]);
  });
});

// ── errors ───────────────────────────────────────────────────────────────────

describe("error mapping", () => {
  it("transient = 5xx, timeout, network, abort; 4xx is raised", async () => {
    const { HghApiError } = await import("../errors");
    expect(D.isTransientApiFailure(new HghApiError(503, "upstream", "x"))).toBe(true);
    expect(D.isTransientApiFailure(new HghApiError(504, "timeout", "x"))).toBe(true);
    expect(D.isTransientApiFailure(Object.assign(new Error("a"), { name: "AbortError" }))).toBe(true);
    for (const [s, c] of [[401, "token_expired"], [403, "menu_forbidden"], [404, "not_found"], [422, "invalid_value"], [409, "cursor_stale"]] as const) {
      expect(D.isTransientApiFailure(new HghApiError(s, c, "x")), `${s}`).toBe(false);
    }
    await expect(D.orNullOnTransient(Promise.reject(new HghApiError(502, "network_error", "x")))).resolves.toBeNull();
    await expect(D.orNullOnTransient(Promise.reject(new HghApiError(403, "role_forbidden", "x")))).rejects.toMatchObject({ status: 403 });
  });

  it("cards: brand rows failing drops KPI #16 only (⑦ is not read); summary 403 is raised", async () => {
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    routes["/v1/mentions/brands"] = () => errorBody(503, "upstream");
    const live = await D.loadLiveDashboard({}, { surface: "global", scope: null });
    expect(live?.kpis.map((k) => k.key)).toEqual(["visibility", "shareOfVoice", "sentiment", "position", "citationShare"]);
    expect(live?.kpis.find((k) => k.key === "shareOfVoice")?.competitorSov).toBeUndefined();
    expect(calls.map((u) => u.pathname)).not.toContain("/v1/funnel/conversion");
    routes["/v1/kpi/summary"] = () => errorBody(403, "menu_forbidden");
    await expect(D.loadLiveDashboard({}, { surface: "global", scope: null })).rejects.toMatchObject({ status: 403, code: "menu_forbidden" });
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    routes["/v1/mentions/brands"] = () => errorBody(401, "token_expired");
    await expect(D.loadLiveDashboard({}, { surface: "global", scope: null })).rejects.toMatchObject({ status: 401 });
  });

  it("empty state: no answers or a whole-answer suppression -> null (legacy agg null / totalAnswers 0)", async () => {
    routes["/v1/mentions/brands"] = () => json({ data: brands([]), meta: meta() });
    routes["/v1/kpi/summary"] = () => json({ data: summary({ params: { answers: 0, applied_prompts: 1, measured_prompts: 0, prompts_without_brand: null, measured_by_funnel: null } }), meta: meta() });
    expect(await D.loadLiveDashboard({}, { surface: "global", scope: null })).toBeNull();
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta({ suppressed: { "*": "no_active_snapshot" } }) });
    expect(await D.loadLiveDashboard({}, { surface: "global", scope: null })).toBeNull();
  });
});

// ── D8 facades (dashboard / website view-models) ──────────────────────────────

describe("D8 facades: api source never touches the legacy readers; legacy is the default", () => {
  it("G1=api: getLiveDashboard from the API; a 5xx summary marks the legacy degrade label", async () => {
    vi.stubEnv("HGH_SOURCE_G1", "api");
    const { getLiveDashboard } = await import("@/app/[locale]/(dash)/dashboard/_data/live");
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    routes["/v1/mentions/brands"] = () =>
      json({ data: brands([brandItem({ name: "Kia", is_own: true, mentions: 90 }), brandItem({ name: "Toyota", mentions: 45 })]), meta: meta() });
    routes["/v1/funnel/conversion"] = () => json({ data: conversion({ total: 0, measured: 0, conv: 0, sessions: 0 }), meta: meta() });
    const live = await withRequestScope(() => getLiveDashboard({}));
    // KPI #16: own mentions 90 (share_of_voice numerator) / Toyota 45 x 100 = 200
    expect(live?.kpis.find((k) => k.key === "shareOfVoice")?.competitorSov).toEqual({ brand: "Toyota", value: 200 });
    // brand-scoped session: the injected brand lock and countries are not sent (card: WU-3 card path;
    // parts: DASHBOARD_SUMMARY_PARTS, the cards read neither the measured / applied prompts nor the gap)
    expect(q(calls.find((u) => u.pathname === "/v1/kpi/summary")!)).toEqual({ surface: ["global"], card: ["true"], parts: ["urls"] });
    routes["/v1/kpi/summary"] = () => errorBody(503, "upstream");
    const [empty, degraded] = await withRequestScope(async () => [await getLiveDashboard({}), wasDegraded("standardAggregates")] as const);
    expect(empty).toBeNull();
    expect(degraded).toBe(true);
    expect(legacyCalled.n).toBe(0);
  });

  it("G1 unset: legacy reader runs (and here throws), no API call", async () => {
    const { getLiveTrend } = await import("@/app/[locale]/(dash)/dashboard/_data/live");
    await expect(withRequestScope(() => getLiveTrend({}, "week"))).rejects.toThrow(/legacy reader/);
    expect(calls).toHaveLength(0);
  });

  it("G3=api: website trend is the cycle-slot trend of M01..M05 + the live ⑥ accuracy series (WU-9, no M06/M07: B032); week and day -> cycle (WU-6)", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    routes["/v1/kpi/summary"] = () => json({ data: summary(), meta: meta() });
    routes["/v1/mentions/brands"] = () => json({ data: brands([]), meta: meta() });
    routes["/v1/filters/dates"] = () => json({ data: { dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] }, meta: meta() });
    routes["/v1/filters/options"] = () => json({ data: { catalog: null, custom_fields: null, engines: [], geo_matrix: [], languages: [], regions: [] }, meta: meta() });
    routes["/v1/trend"] = () => json({ data: { bucket: "cycle", dimension: "none", own_label: "Kia", buckets: [], series: [] }, meta: meta() });
    const { getLiveWebsiteTrend } = await import("@/app/[locale]/(dash)/website/_data/live");
    expect(await withRequestScope(() => getLiveWebsiteTrend({}, "week"))).toBeNull();
    const t = q(calls.find((u) => u.pathname === "/v1/trend")!);
    expect(t.bucket).toEqual(["cycle"]);
    expect(t.metrics?.sort()).toEqual(["citation_accuracy", "citation_share", "position", "sentiment", "share_of_voice", "visibility"]);
    expect(t.surface).toEqual(["website"]);
    // performance A1: LiveTrend readers never use measuredDays
    expect(t.measured_days).toEqual(["false"]);
    expect(legacyCalled.n).toBe(0);
  });
});

describe("URL-rate cards (DC-02 decision 6)", () => {
  const web = summary({
    target_url_rate: { num: 30, den: 120 },
    owned_url_rate: { num: 50, den: 120 },
    citation_accuracy: { num: 30, den: 50 },
    url_prompts: { measured_prompts: 40, target_prompts: 7, owned_prompts: 11 },
  });
  it("website: per prompt, legacy wording (no copyVariant)", () => {
    const k = D.toDashboardKpis({ data: web, meta: meta({ surface: "website" }) }, null, { urlRates: true })!;
    expect(k.slice(5)).toEqual([
      { key: "ownedUrlRate", value: 27.5, delta: null, direction: "flat", ratio: { numerator: 11, denominator: 40 } },
      { key: "targetUrlRate", value: 17.5, delta: null, direction: "flat", ratio: { numerator: 7, denominator: 40 } },
      { key: "citationAccuracy", value: 60, delta: null, direction: "flat", ratio: { numerator: 30, denominator: 50 } },
    ]);
  });
  it("a measurement-unit answer keeps the api wording", () => {
    const k = D.toDashboardKpis({ data: web, meta: meta({ surface: "project" }) }, null, { urlRates: true })!;
    expect(k.slice(5, 7).map((c) => [c.key, c.value, c.copyVariant])).toEqual([
      ["ownedUrlRate", 41.7, "api"],
      ["targetUrlRate", 25, "api"],
    ]);
  });
});
