import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { StandardAggregates } from "@/lib/scope/result-adapter";

// Summary card adapter (K-1): hand-computed conversions, the empty state (R-supp), website URL
// rate cards with the published-value provenance (BG-26), and legacy/api parity by running the
// UNCHANGED legacy card builders (buildMirrorKpis, applyCompetitorSov in dashboard/_data/live.ts)
// on the legacy aggregate shape of the same WORLD. Differences must equal KNOWN_DIFF.

vi.mock("@/lib/scope/server", () => ({}));
const { bindHghAuth } = await import("../auth");
const Sm = await import("./summary");
const { buildMirrorKpis, applyCompetitorSov } = await import("@/app/[locale]/(dash)/dashboard/_data/live");

type S = components["schemas"];
type Summary = S["SummaryData"];
type Meta = S["Meta"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";

function summary(o: Partial<Summary> = {}): Summary {
  return {
    visibility: { num: 201, den: 400 },
    share_of_voice: { num: 333, den: 900 },
    sentiment: { num: 250, den: 400 },
    position: { sum: 105, count: 20 },
    citation_share: { num: 45, den: 300 },
    target_url_rate: null,
    owned_url_rate: null,
    citation_accuracy: null,
    params: { answers: 400, applied_prompts: 120, measured_prompts: 100, prompts_without_brand: 12, measured_by_funnel: null },
    analysis_gap: { gap_answers: 3, base_answers: 420 },
    ...o,
  };
}
const meta = (m: Partial<Meta> = {}): Meta => ({ mode: "snapshot", as_of: "2026-09-14", cycles: ["2026-09-14"], ...m });

// ── conversions ──────────────────────────────────────────────────────────────

describe("toMirrorKpis: buildMirrorKpis shape, hand-computed", () => {
  it("①~⑤ values and ratios", () => {
    const k = Sm.toMirrorKpis(summary(), meta());
    // 201/400 = 0.5025 -> (201/400)*1000 is 502.49999999999994 in floating point -> 50.2
    //   (the legacy dashboard pct() rule, kept bit for bit by pct1OrZero) ; 333/900 = 0.37 -> 37 ;
    // 250/400 -> round1(62.5) = 62.5 ; 105/20 = 5.25 -> 5.3 ; 45/300 = 15
    expect(k).toEqual([
      { key: "visibility", value: 50.2, delta: null, direction: "flat", ratio: { numerator: 201, denominator: 400 } },
      { key: "shareOfVoice", value: 37, delta: null, direction: "flat", ratio: { numerator: 333, denominator: 900 } },
      { key: "sentiment", value: 62.5, delta: null, direction: "flat", ratio: { numerator: 250, denominator: 400 } },
      { key: "position", value: 5.3, delta: null, direction: "flat", ratio: { numerator: 105, denominator: 20 } },
      { key: "citationShare", value: 15, delta: null, direction: "flat", ratio: { numerator: 45, denominator: 300 } },
    ]);
  });

  it("rounding boundaries: half up at .x5 (1/16 = 6.25%), not floor or truncation", () => {
    // pct rule Math.round(n/d*1000)/10: 1/16 -> 62.5 -> 63 -> 6.3 (floor would give 6.2);
    // 2/3 -> 666.67 -> 667 -> 66.7 (floor 66.6); 1/8 -> 125 -> 12.5 (exact).
    // sentiment rule round1(100n/d): 1/16 -> 6.25 -> 6.3 ; rank round1(sum/count): 1/16 -> 0.0625 -> 0.1.
    const k = Sm.toMirrorKpis(
      summary({
        visibility: { num: 1, den: 16 },
        share_of_voice: { num: 2, den: 3 },
        sentiment: { num: 1, den: 16 },
        position: { sum: 1, count: 16 },
        citation_share: { num: 1, den: 8 },
      }),
      meta(),
    );
    expect(k.map((x) => [x.key, x.value])).toEqual([
      ["visibility", 6.3],
      ["shareOfVoice", 66.7],
      ["sentiment", 6.3],
      ["position", 0.1],
      ["citationShare", 12.5],
    ]);
    const k2 = Sm.toMirrorKpis(summary({ visibility: { num: 2, den: 3 }, citation_share: { num: 1, den: 16 } }), meta());
    expect([k2[0].value, k2[4].value]).toEqual([66.7, 6.3]);
    const u = Sm.toUrlRateKpis(
      summary({ owned_url_rate: { num: 1, den: 16 }, target_url_rate: { num: 2, den: 3 }, citation_accuracy: { num: 1, den: 16 } }),
      meta({ surface: "project" }),
    )!;
    expect([u.ownedUrlRate.value, u.targetUrlRate.value, u.citationAccuracy.value]).toEqual([6.3, 66.7, 6.3]);
  });

  it("no data (den 0 -> null + no_data): legacy fallbacks (visibility 0, SOV 0 without ratio, others null)", () => {
    const k = Sm.toMirrorKpis(
      summary({ visibility: null, share_of_voice: null, sentiment: null, position: null, citation_share: null, params: { answers: 0, applied_prompts: 1, measured_prompts: 0 } }),
      meta({ suppressed: { visibility: "no_data", share_of_voice: "no_data", sentiment: "no_data", position: "no_data", citation_share: "no_data" } }),
    );
    expect(k.map((x) => [x.key, x.value, x.ratio])).toEqual([
      ["visibility", 0, { numerator: 0, denominator: 0 }],
      ["shareOfVoice", 0, undefined],
      ["sentiment", null, undefined],
      ["position", null, undefined],
      ["citationShare", null, undefined],
    ]);
  });

  it("hidden (or any reason other than no_data) -> null card without ratio", () => {
    const k = Sm.toMirrorKpis(
      summary({ visibility: null, share_of_voice: null, sentiment: null, position: null }),
      meta({ suppressed: { visibility: "hidden", share_of_voice: "hidden", sentiment: "hidden", position: "hidden" } }),
    );
    expect(k.slice(0, 4).map((x) => [x.key, x.value, x.ratio])).toEqual([
      ["visibility", null, undefined],
      ["shareOfVoice", null, undefined],
      ["sentiment", null, undefined],
      ["position", null, undefined],
    ]);
    expect(k[4].value).toBe(15); // citations not hidden
  });
});

describe("empty state (R-supp) and view", () => {
  it("'*' suppression or answers 0 -> empty", () => {
    expect(Sm.summaryIsEmpty(summary(), meta())).toBe(false);
    expect(Sm.summaryIsEmpty(summary(), meta({ suppressed: { "*": "no_active_snapshot" } }))).toBe(true);
    expect(Sm.summaryIsEmpty(summary({ params: { answers: 0, applied_prompts: 1, measured_prompts: 0 } }), meta())).toBe(true);
  });

  it("view: asOf, params, analysis gap rate, notices", () => {
    const v = Sm.toKpiSummaryView({ data: summary(), meta: meta({ surface: "global", ignored_filters: ["lang"], dropped_filters: { country: ["XX"] } }) });
    expect(v.asOf).toBe("2026-09-14");
    expect(v.empty).toBe(false);
    expect(v.emptyReason).toBeNull();
    expect(v.params).toEqual({ answers: 400, appliedPrompts: 120, measuredPrompts: 100, promptsWithoutBrand: 12, measuredByFunnel: null });
    // 3 / 420 = 0.714% -> round1 = 0.7
    expect(v.analysisGap).toEqual({ gapAnswers: 3, baseAnswers: 420, rate: 0.7 });
    expect(v.notices).toEqual({ ignored: ["lang"], dropped: { country: ["XX"] }, hasAny: true });
    expect(v.urlRates).toBeNull(); // global surface: no URL-rate cards
    const g = Sm.toKpiSummaryView({ data: summary(), meta: meta({ suppressed: { "*": "no_active_snapshot" } }) });
    expect([g.empty, g.emptyReason]).toEqual([true, "no_active_snapshot"]);
  });
});

describe("website/project URL-rate cards and provenance (BG-26)", () => {
  const web = summary({
    target_url_rate: { num: 30, den: 120 },
    owned_url_rate: { num: 50, den: 120 },
    citation_accuracy: { num: 30, den: 50 },
  });
  it("values (round1(100n/d)) and ratios; published provenance with round label", () => {
    const m = meta({
      source: {
        url_rates: "report",
        reason: null,
        publications: ["kr-2026-09-11"],
        round_date: "2026-09-11",
        site_count: 42,
        publication_details: [{ slug: "kr-2026-09-11", cycle_label: "9월 2주차", cycle_label_en: "Sep W2", round_date: "2026-09-11" }],
      },
    });
    const u = Sm.toUrlRateKpis(web, m)!;
    const prov = { source: "published", cycleLabel: "9월 2주차", cycleLabelEn: "Sep W2", roundDate: "2026-09-11", siteCount: 42 };
    // 50/120 = 41.67 -> 41.7 ; 30/120 = 25 ; 30/50 = 60
    expect(u.ownedUrlRate).toEqual({ key: "ownedUrlRate", value: 41.7, delta: null, direction: "flat", ratio: { numerator: 50, denominator: 120 }, provenance: prov });
    expect(u.targetUrlRate).toMatchObject({ value: 25, ratio: { numerator: 30, denominator: 120 }, provenance: prov });
    expect(u.citationAccuracy).toEqual({ key: "citationAccuracy", value: 60, delta: null, direction: "flat", ratio: { numerator: 30, denominator: 50 } });
  });
  it("live provenance; global -> null", () => {
    expect(Sm.provenanceOf(meta({ source: { url_rates: "live", reason: "no_publication", publications: [] } }))).toEqual({ source: "live", cycleLabel: null, cycleLabelEn: null });
    expect(Sm.provenanceOf(meta())).toBeUndefined();
    expect(Sm.toUrlRateKpis(summary(), meta({ suppressed: { owned_url_rate: "not_website_surface" } }))).toBeNull();
  });
  it("den 0 -> null value, no ratio", () => {
    const u = Sm.toUrlRateKpis(summary({ owned_url_rate: null, target_url_rate: null, citation_accuracy: null }), meta({ suppressed: { owned_url_rate: "no_data" } }))!;
    expect([u.ownedUrlRate.value, u.ownedUrlRate.ratio, u.citationAccuracy.value]).toEqual([null, undefined, null]);
  });
  it("project: owned / target per measurement (unit measurement)", () => {
    const u = Sm.toUrlRateKpis(web, meta({ surface: "project" }))!;
    expect([u.unit, u.ownedUrlRate.ratio, u.targetUrlRate.ratio]).toEqual([
      "measurement",
      { numerator: 50, denominator: 120 },
      { numerator: 30, denominator: 120 },
    ]);
  });
});

describe("website URL-rate cards per prompt (DC-02 decision 6: url_prompts, legacy wording)", () => {
  // measurement ratios differ on purpose: the website cards must not read them
  const web = summary({
    target_url_rate: { num: 30, den: 120 },
    owned_url_rate: { num: 50, den: 120 },
    citation_accuracy: { num: 30, den: 50 },
    url_prompts: { measured_prompts: 16, target_prompts: 1, owned_prompts: 7 },
  });
  const live = { url_rates: "live", reason: "no_publication", publications: [] };
  it("value = prompts / measured prompts, ratio = that pair, accuracy unchanged, unit prompt", () => {
    const u = Sm.toUrlRateKpis(web, meta({ surface: "website", source: live }))!;
    const prov = { source: "live", cycleLabel: null, cycleLabelEn: null };
    // live rule round1(100n/d): 7/16 = 43.75 -> 43.8 ; 1/16 = 6.25 -> 6.3
    expect(u.ownedUrlRate).toEqual({ key: "ownedUrlRate", value: 43.8, delta: null, direction: "flat", ratio: { numerator: 7, denominator: 16 }, provenance: prov });
    expect(u.targetUrlRate).toEqual({ key: "targetUrlRate", value: 6.3, delta: null, direction: "flat", ratio: { numerator: 1, denominator: 16 }, provenance: prov });
    expect(u.citationAccuracy).toEqual({ key: "citationAccuracy", value: 60, delta: null, direction: "flat", ratio: { numerator: 30, denominator: 50 } });
    expect(u.unit).toBe("prompt");
  });
  it("rounding follows the legacy source: published = Math.round(n/d*1000)/10, live = round1(100n/d)", () => {
    const odd = summary({ url_prompts: { measured_prompts: 400, target_prompts: 201, owned_prompts: 201 } });
    expect(Sm.urlPromptRates(odd, meta({ surface: "website", source: { ...live, url_rates: "report" } })).rate).toBe(50.2);
    expect(Sm.urlPromptRates(odd, meta({ surface: "website", source: live })).rate).toBe(50.3);
  });
  it("url_prompts null (meta.suppressed url_prompts) -> null values without ratio (legacy 측정 대기)", () => {
    const u = Sm.toUrlRateKpis(
      summary({ target_url_rate: { num: 1, den: 2 }, owned_url_rate: { num: 1, den: 2 }, url_prompts: null }),
      meta({ surface: "website", suppressed: { url_prompts: "no_data" } }),
    )!;
    expect([u.ownedUrlRate.value, u.ownedUrlRate.ratio, u.targetUrlRate.value, u.targetUrlRate.ratio]).toEqual([null, undefined, null, undefined]);
    expect(Sm.urlPromptRates(summary(), meta({ surface: "website" }))).toEqual({ hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null });
  });
});

describe("applyCompetitorSovFromBrands (KPI #16)", () => {
  const base = Sm.toMirrorKpis(summary(), meta());
  const brand = (name: string, mentions: number, is_own = false, is_hmg_own: boolean | null = false) => ({ name, mentions, is_own, is_hmg_own });
  it("auto: top competitor excluding own and HMG siblings (is_hmg_own)", () => {
    const out = Sm.applyCompetitorSovFromBrands(base, 333, [brand("Kia", 333, true, true), brand("Hyundai", 400, false, true), brand("Toyota", 120), brand("Honda", 90)]);
    // 1000 * 333 / 120 = 2775 -> round -> 2775 / 10 = 277.5
    expect(out.find((k) => k.key === "shareOfVoice")?.competitorSov).toEqual({ brand: "Toyota", value: 277.5 });
  });
  it("designated target: matched ignoring case; absent -> value null with the name kept", () => {
    expect(Sm.applyCompetitorSovFromBrands(base, 333, [brand("Toyota", 120)], "toyota").find((k) => k.key === "shareOfVoice")?.competitorSov).toEqual({ brand: "Toyota", value: 277.5 });
    expect(Sm.applyCompetitorSovFromBrands(base, 333, [brand("Toyota", 120)], "BYD").find((k) => k.key === "shareOfVoice")?.competitorSov).toEqual({ brand: "BYD", value: null });
  });
  it("no competitor -> unchanged", () => {
    expect(Sm.applyCompetitorSovFromBrands(base, 333, [brand("Kia", 333, true)])).toBe(base);
  });
});

describe("fetchKpiSummary: cycle_offset / by_funnel only when asked", () => {
  const urls: string[] = [];
  beforeEach(() => {
    urls.length = 0;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(String(u));
        return new Response(JSON.stringify({ data: summary(), meta: meta() }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("default: surface + the analysis parts; previous round and funnel on request", async () => {
    await Sm.fetchKpiSummary({}, { surface: "global", scope: null });
    await Sm.fetchKpiSummary({}, { surface: "project", projectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", scope: null, cycleOffset: 1, byFunnel: true });
    expect(new URL(urls[0]).search).toBe("?parts=gap&parts=measured&parts=urls&surface=global");
    const q = new URL(urls[1]).searchParams;
    expect([q.get("cycle_offset"), q.get("by_funnel"), q.get("surface")]).toEqual(["1", "true", "project"]);
    expect(q.getAll("parts")).toEqual(["gap", "measured", "urls"]);
  });

  it("B089 parts: the analysis tabs drop applied; card calls and loadKpiSummary ask for every part; explicit parts", async () => {
    await Sm.fetchKpiSummary({}, { surface: "global", scope: null, card: true });
    await Sm.fetchKpiSummary({}, { surface: "project", projectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", scope: null, card: true, byFunnel: true });
    await Sm.fetchKpiSummary({}, { surface: "website", scope: null, parts: ["urls", "measured", "urls"] });
    await Sm.loadKpiSummary({}, { surface: "global", scope: null });
    await Sm.fetchKpiSummary({}, { surface: "global", scope: null, parts: Sm.ALL_SUMMARY_PARTS });
    await Sm.fetchKpiSummary({}, { surface: "global", scope: null, card: true, parts: Sm.DASHBOARD_SUMMARY_PARTS });
    const q = urls.map((u) => new URL(u).searchParams);
    expect(new URL(urls[0]).search).toBe("?card=true&surface=global"); // card default = the query as before
    expect([q[1].has("parts"), q[1].get("card"), q[1].get("by_funnel")]).toEqual([false, null, "true"]); // project: no card param
    expect(q[2].getAll("parts")).toEqual(["measured", "urls"]); // explicit, deduped and sorted
    expect(q[3].has("parts")).toBe(false); // every part = the backend default (parameter omitted)
    expect(q[4].has("parts")).toBe(false);
    expect([q[5].getAll("parts"), q[5].get("card")]).toEqual([["urls"], "true"]); // what the dashboards read
  });
});

describe("toKpiSummaryView: parts left out come back null", () => {
  it("applied / measured / gap null -> null view fields, the rest unchanged", () => {
    const full = Sm.toKpiSummaryView({ data: summary(), meta: meta() });
    const lite = Sm.toKpiSummaryView({
      data: {
        ...summary(),
        params: { ...summary().params, applied_prompts: null, measured_prompts: null, prompts_without_brand: null },
        analysis_gap: null,
      },
      meta: meta(),
    });
    expect(lite.params).toEqual({ ...full.params, appliedPrompts: null, measuredPrompts: null, promptsWithoutBrand: null });
    expect(lite.analysisGap).toBeNull();
    expect({ ...lite, params: full.params, analysisGap: full.analysisGap }).toEqual(full);
  });
});

// ── legacy / api parity ─────────────────────────────────────────────────────

/** The legacy mirror aggregate of the same WORLD (fetchStandardAggregates shape, admin = HMG all tracked). */
function legacyAgg(s: Summary): StandardAggregates {
  const avg = s.position && s.position.count > 0 ? Math.round((s.position.sum / s.position.count) * 10) / 10 : null;
  const sent = s.sentiment!;
  return {
    rootProjectId: "r",
    asOf: "2026-09-14",
    totalAnswers: s.visibility!.den,
    totalMentions: s.share_of_voice!.den,
    trackedAnswerCount: s.visibility!.num,
    brands: [
      { name: "Hyundai", mentionCount: 200, answerCount: 150, isTracked: true },
      { name: "Toyota", mentionCount: 120, answerCount: 90, isTracked: false },
      { name: "Kia", mentionCount: 133, answerCount: 100, isTracked: true },
      { name: "Honda", mentionCount: 90, answerCount: 70, isTracked: false },
    ] as StandardAggregates["brands"],
    regions: [],
    citations: { sampledAnswers: 400, answersWithCitation: 200, totalCitations: s.citation_share!.den, ownedCitations: s.citation_share!.num, domains: [] },
    position: { avgPosition: avg, sampledAnswers: s.position?.count ?? 0 },
    sentiment: {
      positiveRate: sent.den > 0 ? Math.round(((100 * sent.num) / sent.den) * 10) / 10 : null,
      positiveMentions: sent.num,
      sampledMentions: sent.den,
    },
  };
}

const CASES: { name: string; data: Summary; known: { path: RegExp; reason: string }[] }[] = [
  {
    name: "rank sum above 10 answers (5.25 -> 5.3)",
    data: summary(),
    known: [
      {
        path: /^3\.ratio\.numerator$/,
        reason: "position ratio numerator: API true rank sum 105; the legacy re-derived round(5.3 x 20) = 106",
      },
    ],
  },
  {
    name: "exact rank average (no rounding)",
    data: summary({ position: { sum: 150, count: 60 } }),
    known: [],
  },
  {
    name: "no citations: citation card null, others unchanged",
    data: summary({ citation_share: { num: 0, den: 0 }, position: { sum: 150, count: 60 } }),
    known: [],
  },
];

function diff(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    return av === undefined && bv === undefined ? [] : diff(av, bv, path ? `${path}.${k}` : k);
  });
}

describe("legacy/api parity: buildMirrorKpis + applyCompetitorSov vs toMirrorKpis + applyCompetitorSovFromBrands", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const legacy = applyCompetitorSov(buildMirrorKpis(legacyAgg(c.data)), legacyAgg(c.data));
    // The API sends citation_share null + no_data when there is no citation (den 0).
    const apiData = c.data.citation_share?.den === 0 ? { ...c.data, citation_share: null } : c.data;
    const apiMeta = c.data.citation_share?.den === 0 ? meta({ suppressed: { citation_share: "no_data" } }) : meta();
    const brands = [
      { name: "Hyundai", mentions: 200, is_own: true, is_hmg_own: true },
      { name: "Kia", mentions: 133, is_own: true, is_hmg_own: true },
      { name: "Toyota", mentions: 120, is_own: false, is_hmg_own: false },
      { name: "Honda", mentions: 90, is_own: false, is_hmg_own: false },
    ];
    const api = Sm.applyCompetitorSovFromBrands(Sm.toMirrorKpis(apiData, apiMeta), apiData.share_of_voice?.num ?? null, brands);
    const d = diff(legacy, api);
    for (const p of d) expect(c.known.some((k) => k.path.test(p)), `undeclared difference ${p}`).toBe(true);
    for (const k of c.known) expect(d.some((p) => k.path.test(p)), `declared difference ${k.path} disappeared`).toBe(true);
  });
});
