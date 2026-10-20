import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// Citations adapter (unit U7): hand-computed conversions, the loaders' calls (which endpoints,
// which parameters, D6 order), empty / degrade / error mapping, the cursor sub pages (D5), the
// website cards (DC-02, BG-26), and the route helpers (gate, filters = the page's filters, skey
// path segment). Legacy parity on PGlite is in citations.parity.test.ts.

vi.mock("@/lib/scope/server", () => ({}));
const { bindHghAuth } = await import("../auth");
const { HghApiError } = await import("../errors");
const { wasDegraded } = await import("@/lib/scope/degrade-registry");
const { analysisQuery } = await import("./filters");
const { readStandardFilters } = await import("@/components/dash/standard-filters");
const C = await import("./citations");

type S = components["schemas"];
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const FIELD = "0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";
const G = { surface: "global" as const, scope: null };

const cat = (key: number, name: string, slug: string): S["CategoryRef"] => ({ category_key: key, name, slug });
const HMG = cat(1, "Official (HMG)", "officialHmg");
const COMP = cat(2, "Official (Competitor)", "officialCompetitor");
const MEDIA = cat(4, "Automotive Media", "automotiveMedia");

function row(o: Partial<S["DomainRow"]> & { skey: string; citations: number }): S["DomainRow"] {
  return {
    domain: o.skey,
    is_social: false,
    category: MEDIA,
    share: { num: o.citations, den: 16 },
    citing_answers: 1,
    citing_prompts: 1,
    coverage: { num: 1, den: 8 },
    is_own: false,
    is_target: false,
    own_citations: 0,
    competitor_brand: null,
    ...o,
  };
}
const DOMAINS: S["DomainsData"] = {
  summary: { total_citations: 16, unique_sources: 3, own_share: { num: 3, den: 16 }, answers_den: 8 },
  items: [
    row({ skey: "hyundai.com", citations: 5, category: HMG, is_own: true, own_citations: 3, citing_prompts: 3, citing_answers: 4, coverage: { num: 4, den: 8 }, rank: 1, match_rank: 1 }),
    row({ skey: "caranddriver.com", citations: 4, rank: 2, match_rank: 2 }),
    row({ skey: "toyota.com", citations: 3, category: COMP, competitor_brand: "Toyota", citing_prompts: null, rank: 3, match_rank: 3 }),
  ],
  competitor_totals: [],
  competitor_sources: [
    { skey: "lexus.com", domain: "lexus.com", citations: 1, brand: "Lexus" },
    { skey: "toyota.com", domain: "toyota.com", citations: 3, brand: "Toyota" },
    { skey: "honda.com", domain: "honda.com", citations: 1, brand: "Honda" },
  ],
};
const SOURCES: S["SourcesData"] = {
  total_citations: 16,
  categories: [
    { category: HMG, citations: 7, share: { num: 7, den: 16 } },
    { category: MEDIA, citations: 6, share: { num: 6, den: 16 } },
    { category: COMP, citations: 3, share: { num: 3, den: 16 } },
  ],
  by_engine: [
    { engine: "gemini", total: 4, categories: [{ category_key: 4, citations: 4 }] },
    { engine: "claude-web", total: 3, categories: [{ category_key: 1, citations: 3 }] },
    { engine: "claude-sonnet", total: 2, categories: [{ category_key: 1, citations: 1 }, { category_key: 12, citations: 1 }] },
    { engine: "chatgpt", total: 7, categories: [{ category_key: 1, citations: 3 }, { category_key: 2, citations: 3 }, { category_key: 4, citations: 1 }] },
  ],
  tone: { positive: { urls: 4, citations: 6, answers: 3 }, negative: { urls: 1, citations: 1, answers: 1 } },
  types: [
    { type: "recommendation", total: 5, categories: [{ category_key: 1, citations: 4 }, { category_key: 4, citations: 1 }, { category_key: 2, citations: 0 }] },
    { type: "mention", total: 2, categories: [{ category_key: 13, citations: 2 }] },
  ],
};
const PROMPT_ROW: S["PromptRow"] = {
  prompt_id: "00000000-0000-4000-8000-000000000030",
  text: "best EV",
  funnel: "인지",
  citations: 8,
  providers: ["chatgpt", "gemini"],
  answers: [{ job_id: "00000000-0000-4000-8000-000000000010", provider: "chatgpt", region: "US", citations_in_answer: 3 }],
};
const PROMPTS: S["CitationPromptsData"] = { counts: { owned: 2, uncited: 5 }, items: [PROMPT_ROW] };
const bucket = (key: string) => ({ key, round_dates: [key] });
const pt = (bucket: string, num: number | null, den = 10, gap?: string): S["app__features__analytics__trend__series__schemas__TrendPoint"] => ({
  bucket,
  ratio: num === null ? null : { num, den },
  rank: null,
  gap: Boolean(gap),
  gap_reason: (gap ?? null) as never,
});
const series = (o: Partial<S["TrendSeries"]> & { points: S["TrendSeries"]["points"] }): S["TrendSeries"] => ({ kind: "ratio", metric: "source_share", ...o });
const TREND_SOURCE: S["TrendData"] = {
  bucket: "cycle",
  dimension: "source",
  own_label: "HMG",
  buckets: [bucket("2026-09-07"), bucket("2026-09-14"), bucket("2026-09-21")],
  series: [
    series({ key: "hyundai.com", label: "hyundai.com", points: [pt("2026-09-07", 2), pt("2026-09-14", 3), pt("2026-09-21", 5)] }),
    series({ key: "toyota.com", label: "toyota.com", points: [pt("2026-09-07", 1), pt("2026-09-14", null, 0, "collection_error"), pt("2026-09-21", 3)] }),
  ],
};
const TREND_CATEGORY: S["TrendData"] = {
  bucket: "cycle",
  dimension: "category",
  own_label: "HMG",
  buckets: [bucket("2026-09-14"), bucket("2026-09-21")],
  series: [
    series({ metric: "category_share", key: "automotiveMedia", label: "Automotive Media", points: [pt("2026-09-14", 4, 9), pt("2026-09-21", 6, 16)] }),
    series({ metric: "category_share", key: "officialHmg", label: "Official (HMG)", points: [pt("2026-09-14", 5, 9), pt("2026-09-21", 7, 16)] }),
    series({ metric: "category_share", key: "wikiReference", label: "Wiki & Reference", points: [pt("2026-09-14", 0, 9), pt("2026-09-21", 0, 16)] }),
  ],
};
const TREND_SHARE: S["TrendData"] = {
  bucket: "cycle",
  dimension: "none",
  own_label: "HMG",
  buckets: [bucket("2026-09-07"), bucket("2026-09-14"), bucket("2026-09-21")],
  series: [
    series({ metric: "visibility", key: null, points: [pt("2026-09-07", 4, 8), pt("2026-09-14", 5, 8), pt("2026-09-21", 6, 8)] }),
    series({ metric: "citation_share", key: null, points: [pt("2026-09-07", 1, 10), pt("2026-09-14", 2, 16), pt("2026-09-21", 3, 16)] }),
  ],
};
const META: S["Meta"] = { mode: "cumulative", as_of: "2026-09-21", cycles: ["2026-09-21"], page: { limit: 200, next_cursor: "c2", total: 480 } };
const env = <T>(data: T, meta: S["Meta"] = META) => ({ data, meta });

// ── conversions ─────────────────────────────────────────────────────────────

describe("conversions (hand-computed)", () => {
  it("mirror percent: Math.round(num/den*1000)/10, den 0 -> 0 or null", () => {
    // 1/16 -> 62.5 -> 63 -> 6.3 ; 2/3 -> 666.67 -> 667 -> 66.7 ; 5/16 -> 312.5 -> 313 -> 31.3
    expect([C.mirrorPctOrZero({ num: 1, den: 16 }), C.mirrorPctOrZero({ num: 2, den: 3 }), C.mirrorPctOrZero({ num: 5, den: 16 })]).toEqual([6.3, 66.7, 31.3]);
    expect([C.mirrorPctOrZero({ num: 0, den: 0 }), C.mirrorPctOrNull({ num: 0, den: 0 }), C.mirrorPctOrNull(null)]).toEqual([0, null, null]);
  });

  it("domain row: skey is the legacy domain, prompts = citing_prompts (BG-24), ranks kept, no inline drilldown", () => {
    const r = C.toCitationDomain(DOMAINS.items[0]);
    // share 5/16 = 31.3 ; coverage 4/8 = 50
    expect(r).toEqual({
      domain: "hyundai.com",
      citations: 5,
      share: 31.3,
      prompts: 3,
      coverageRate: 50,
      urls: [],
      promptList: [],
      isOurs: true,
      category: "Official (HMG)",
      subcategory: null,
      skey: "hyundai.com",
      rank: 1,
      matchRank: 1,
    });
    // citing_prompts null (older backend) -> 0 ; no ranks -> no keys
    const t = C.toCitationDomain({ ...DOMAINS.items[2], rank: null, match_rank: null });
    expect([t.prompts, "rank" in t, "matchRank" in t, t.category]).toEqual([0, false, false, "Official (Competitor)"]);
  });

  it("category label: slug -> legacy vocabulary, unknown slug -> the API name, key -> seed order fallback", () => {
    expect(C.categoryLabelOf({ slug: "communityForums", name: "Forums (renamed)" })).toBe("Community & Forums");
    expect(C.categoryLabelOf({ slug: "newThing", name: "New Thing" })).toBe("New Thing");
    expect(C.categoryLabelOf(null)).toBeNull();
    const label = C.categoryKeyLabels(SOURCES);
    // 12 is not in the answer's categories -> seed table (1-based order) = Academic & Research
    expect([label(1), label(4), label(12), label(99)]).toEqual(["Official (HMG)", "Automotive Media", "Academic & Research", "99"]);
  });

  it("categories: API order, null without citations", () => {
    expect(C.toCategorySlices(SOURCES)).toEqual([
      { name: "Official (HMG)", value: 7 },
      { name: "Automotive Media", value: 6 },
      { name: "Official (Competitor)", value: 3 },
    ]);
    expect(C.toCategorySlices({ ...SOURCES, total_citations: 0 })).toBeNull();
  });

  it("engines: merged per display label (claude-web + claude-sonnet = Claude), total desc", () => {
    expect(C.toEngineCategories(SOURCES)).toEqual([
      { engine: "ChatGPT", total: 7, byCategory: { "Official (HMG)": 3, "Official (Competitor)": 3, "Automotive Media": 1 } },
      // 3 + 1 + 1 = 5
      { engine: "Claude", total: 5, byCategory: { "Official (HMG)": 4, "Academic & Research": 1 } },
      { engine: "Gemini", total: 4, byCategory: { "Automotive Media": 4 } },
    ]);
    expect(C.toEngineCategories({ ...SOURCES, by_engine: [] })).toBeNull();
  });

  it("types: the five legacy types in order, zero-filled, zero categories dropped", () => {
    expect(C.toTypeCategoryRows(SOURCES)).toEqual([
      { type: "mention", total: 2, byCategory: { Other: 2 } },
      { type: "recommendation", total: 5, byCategory: { "Official (HMG)": 4, "Automotive Media": 1 } },
      { type: "comparison", total: 0, byCategory: {} },
      { type: "definition", total: 0, byCategory: {} },
      { type: "final_choice", total: 0, byCategory: {} },
    ]);
  });

  it("tone tiles: same fields", () => {
    expect(C.toToneSummary(SOURCES)).toEqual({ positive: { urls: 4, citations: 6, answers: 3 }, negative: { urls: 1, citations: 1, answers: 1 } });
  });

  it("source trend: rows in bucket order, value = ratio.num, a gapped bucket is a gap row with null values", () => {
    expect(C.toCitationTrend(TREND_SOURCE)).toEqual({
      series: ["hyundai.com", "toyota.com"],
      points: [
        { week: "2026-09-07", "hyundai.com": 2, "toyota.com": 1 },
        { week: "2026-09-14", "hyundai.com": null, "toyota.com": null, gap: { reason: "collection_error" } },
        { week: "2026-09-21", "hyundai.com": 5, "toyota.com": 3 },
      ],
    });
  });

  it("trend gap reasons: hidden -> not_published, no_answer / analysis_pending -> no_value; fewer than two valued buckets -> null", () => {
    expect(C.citationPointGap({ gap: true, gap_reason: "hidden" })).toEqual({ reason: "not_published" });
    expect(C.citationPointGap({ gap: true, gap_reason: "no_answer" })).toEqual({ reason: "no_value" });
    expect(C.citationPointGap({ gap: true, gap_reason: "analysis_pending" })).toEqual({ reason: "no_value" });
    expect(C.citationPointGap({ gap: false, gap_reason: null })).toBeUndefined();
    const one = { ...TREND_SOURCE, buckets: TREND_SOURCE.buckets.slice(0, 2) };
    expect(C.toCitationTrend(one)).toBeNull(); // 09-07 valued, 09-14 gap -> 1 valued bucket
    expect(C.toCitationTrend({ ...TREND_SOURCE, series: [] })).toBeNull();
  });

  it("category trend: series = the snapshot categories in their order (label from the slug), others dropped", () => {
    const t = C.toCitationTrend(TREND_CATEGORY, { seriesOrder: ["Official (HMG)", "Automotive Media", "Official (Competitor)"] });
    expect(t).toEqual({
      series: ["Official (HMG)", "Automotive Media"],
      points: [
        { week: "2026-09-14", "Official (HMG)": 5, "Automotive Media": 4 },
        { week: "2026-09-21", "Official (HMG)": 7, "Automotive Media": 6 },
      ],
    });
  });

  it("category trend keeps a category that is missing from the latest snapshot but valued earlier (appended after the snapshot order)", () => {
    // 최신 회차 스냅샷에 없는 카테고리를 버리면 과거 버킷이 그 카테고리 없이 100% 로 다시 맞춰진다(r1 50/30/20 → 62.5/37.5)
    const lost: S["TrendData"] = {
      ...TREND_CATEGORY,
      series: [
        ...TREND_CATEGORY.series,
        series({ metric: "category_share", key: "zzLegacyOnly", label: "Forums", points: [pt("2026-09-14", 3, 12), pt("2026-09-21", 0, 16)] }),
      ],
    };
    const t = C.toCitationTrend(lost, { seriesOrder: ["Official (HMG)", "Automotive Media"] });
    expect(t?.series).toEqual(["Official (HMG)", "Automotive Media", "Forums"]);
    expect(t?.points[0]).toEqual({ week: "2026-09-14", "Official (HMG)": 5, "Automotive Media": 4, Forums: 3 });
  });

  it("prompt split: rows + counts, owned 0 -> null (legacy section hidden)", () => {
    const s = C.toPromptSplit(PROMPTS, { counts: PROMPTS.counts, items: [] })!;
    expect(s.ownedCount).toBe(2);
    expect(s.uncitedCount).toBe(5);
    expect(s.owned).toEqual([
      {
        id: PROMPT_ROW.prompt_id,
        promptText: "best EV",
        funnelStage: "인지",
        citations: 8,
        providers: ["ChatGPT", "Gemini"],
        answers: [
          { jobId: PROMPT_ROW.answers[0].job_id, provider: "ChatGPT", region: "US", mentionCount: 3, position: null, highlights: { brand: [], model: [] }, measuredAt: null, runs: 1 },
        ],
      },
    ]);
    expect(C.toPromptSplit({ counts: { owned: 0, uncited: 4 }, items: [] })).toBeNull();
  });

  it("CitationsLive: '*' suppression -> null, no citation -> the legacy empty shape, asOf = meta.as_of", () => {
    const parts = { domains: env(DOMAINS), sources: env(SOURCES), sourceTrend: env(TREND_SOURCE), categoryTrend: env(TREND_CATEGORY), owned: env(PROMPTS) };
    const live = C.toCitationsLive(parts)!;
    // own_share 3/16 = 187.5 -> 188 -> 18.8
    expect(live.summary).toEqual({ total: 16, uniqueDomains: 3, officialOwnShare: 18.8 });
    expect(live.asOf).toBe("2026-09-21");
    expect(live.domains.map((d) => d.domain)).toEqual(["hyundai.com", "caranddriver.com", "toyota.com"]);
    expect(live.categoryTrend?.series).toEqual(["Official (HMG)", "Automotive Media"]);
    expect(live.promptSplit?.uncited).toEqual([]);
    expect(C.toCitationsLive({ ...parts, domains: env(DOMAINS, { ...META, suppressed: { "*": "no_active_snapshot" } }) })).toBeNull();
    expect(C.toCitationsLive({ ...parts, domains: env({ ...DOMAINS, summary: { ...DOMAINS.summary, total_citations: 0 }, items: [] }) })).toEqual(C.emptyCitationsLive());
    // a failed split call (null) -> promptSplit null ; failed trends -> null
    const partial = C.toCitationsLive({ ...parts, owned: null, sourceTrend: null, categoryTrend: null })!;
    expect([partial.promptSplit, partial.trend, partial.categoryTrend]).toEqual([null, null, null]);
  });

  it("competitor options (BG-20): group keys, citations desc then key", () => {
    expect(C.competitorOptionsOf(DOMAINS)).toEqual(["toyota.com", "honda.com", "lexus.com"]);
    expect(C.competitorOptionsOf({ ...DOMAINS, competitor_sources: null })).toEqual([]);
  });

  it("Δ: official share = last two valued rounds (Overview card rule)", () => {
    const d = C.shareDeltas(env(TREND_SHARE));
    // 3/16 = 18.75 ; 2/16 = 12.5 -> 6.25 -> round1 = 6.3 ; basis = the previous round
    expect(d).toEqual({ officialDelta: { delta: 6.3, basisDate: "2026-09-14" } });
    expect(C.shareDeltas(null)).toEqual({ officialDelta: null });
    // a bucket without answers (visibility den 0) is skipped (Overview card rule): 09-21 and 09-07 remain
    const noAnswers = {
      ...TREND_SHARE,
      series: [
        series({ metric: "visibility", key: null, points: [pt("2026-09-07", 4, 8), pt("2026-09-14", 0, 0), pt("2026-09-21", 6, 8)] }),
        TREND_SHARE.series[1],
      ],
    };
    // 3/16 = 18.75 ; 1/10 = 10 -> 8.75 -> 8.8, basis 09-07
    expect(C.shareDeltas(env(noAnswers)).officialDelta).toEqual({ delta: 8.8, basisDate: "2026-09-07" });
  });

  it("category Δ base: the previous valued bucket of the category trend (legacy since d175da4, DC-11 resolved)", () => {
    // current = 마지막 값 있는 회차(Δ 의 현재 쪽: 기간이면 카드는 누적이라 회차 − 회차로 낸다)
    expect(C.prevCategoriesOf(env(TREND_CATEGORY))).toEqual({
      totals: { total: 9, byCategory: { "Automotive Media": 4, "Official (HMG)": 5, "Wiki & Reference": 0 } },
      asOf: "2026-09-14",
      current: { total: 16, byCategory: { "Automotive Media": 6, "Official (HMG)": 7, "Wiki & Reference": 0 } },
    });
    expect(C.prevCategoriesOf(env({ ...TREND_CATEGORY, buckets: TREND_CATEGORY.buckets.slice(1) }))).toBeNull();
  });

  it("detail -> legacy row drilldown: title fallback, engines joined, URL ties by url, country from the geo catalog (U7-N9)", () => {
    const d = C.toDomainDrilldown({
      source: { skey: "hyundai.com", domain: "hyundai.com", is_social: false, category: HMG },
      citations: 4,
      own_citations: 3,
      urls: [
        { url: "https://www.hyundai.com/us/en/b", title: null, citations: 2, engines: ["chatgpt", "gemini"], prompt_text: "best EV", country: "US" },
        { url: "https://www.hyundai.com/us/en/a", title: "A", citations: 2, engines: ["gemini"], prompt_text: null, country: null },
      ],
      prompts: [],
    });
    expect(d.urls.map((x) => [x.url.slice(-1), x.title, x.aiProvider, x.promptText])).toEqual([
      ["a", "A", "Gemini", ""],
      ["b", "www.hyundai.com/us/en/b", "ChatGPT, Gemini", "best EV"],
    ]);
  });

  it("tone row: url mode keeps the url, source mode not; unknown category -> Other", () => {
    const r: S["ToneRow"] = { key: "k", skey: "hyundai.com", domain: "hyundai.com", display: "hyundai.com/x", url: "https://hyundai.com/x", title: "X", prompt_text: "q", citations: 2, engines: ["chatgpt"], category: null };
    expect(C.toToneUrlRow(r, "url")).toEqual({ url: "https://hyundai.com/x", domain: "hyundai.com", title: "X", promptText: "q", citations: 2, providers: ["ChatGPT"], category: "Other" });
    expect(C.toToneUrlRow(r, "source").url).toBeNull();
  });

  it("website cards (C-4, DC-02): percent, unit, published origin with the BG-26 publications", () => {
    const pub = {
      data: { measured: 40, target: { num: 7, den: 40 }, owned: { num: 11, den: 40 } },
      meta: {
        ...META,
        source: {
          origin: "report",
          publication_slugs: ["a", "b"],
          publications: [
            { slug: "a", cycle_label: "9월 3주", cycle_label_en: "Sep W3", round_date: "2026-09-19", site_count: 3 },
            { slug: "b", cycle_label: "9월 3주", cycle_label_en: "Sep W3", round_date: "2026-09-19", site_count: 2 },
          ],
        },
      },
    };
    // 7/40 = 17.5 ; 11/40 = 27.5
    expect(C.toTargetHitRate(pub)).toEqual({
      hitPrompts: 7,
      ownedPrompts: 11,
      measuredPrompts: 40,
      rate: 17.5,
      ownedRate: 27.5,
      unit: "measurement",
      source: "published",
      publication: { cycleLabel: "9월 3주", cycleLabelEn: "Sep W3", roundDate: "2026-09-19", siteCount: 5 },
    });
    const live = C.toTargetHitRate({ data: { measured: 0, target: null, owned: null }, meta: { ...META, source: { origin: "live", reason: "engine_axis" } } });
    expect([live.rate, live.ownedRate, live.source, live.hitPrompts]).toEqual([null, null, "live", 0]);
    expect("source" in C.toTargetHitRate({ data: { measured: 1, target: { num: 0, den: 1 }, owned: { num: 1, den: 1 } }, meta: META })).toBe(false);
    expect(C.targetsApplicable({ sourceCategory: ["Official (HMG)"] })).toBe(false);
    // D6: the empty card has the unit of the card the page reads (K-1 url_prompts: prompt unit, no `unit`)
    expect(C.emptyTargetHitRate()).toEqual({ hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null });
  });

  it("website cards from K-1 url_prompts (DC-02 decision 6): prompt unit, legacy rounding per source, BG-26 label", () => {
    const up = { measured_prompts: 200, target_prompts: 1, owned_prompts: 201 };
    const summary = (url_prompts: S["UrlPromptCounts"] | null) =>
      ({ params: { answers: 8, applied_prompts: 1, measured_prompts: 1 }, url_prompts }) as unknown as S["SummaryData"];
    const report = {
      ...META,
      surface: "website",
      source: {
        url_rates: "report",
        reason: null,
        publications: ["a", "b"],
        round_date: "2026-09-19",
        site_count: 4,
        publication_details: [{ slug: "a", cycle_label: "9월 3주", cycle_label_en: "Sep W3", round_date: "2026-09-19" }],
      },
    } as S["Meta"];
    // published (sb-data pct1 = Math.round(n / d * 1000) / 10): 1/200 -> 0.5 ; 201/200 -> 100.5
    expect(C.toTargetHitRateFromSummary({ data: summary({ measured_prompts: 16, target_prompts: 1, owned_prompts: 7 }), meta: report })).toEqual({
      hitPrompts: 1,
      ownedPrompts: 7,
      measuredPrompts: 16,
      rate: 6.3, // 1/16 = 6.25 -> half up
      ownedRate: 43.8, // 7/16 = 43.75
      source: "published",
      publication: { cycleLabel: "9월 3주", cycleLabelEn: "Sep W3", roundDate: "2026-09-19", siteCount: 4 },
    });
    // the two legacy rules part at .x5 in floating point: 201/400 -> published 50.2, live round1(100n/d) 50.3
    const odd = summary({ measured_prompts: 400, target_prompts: 201, owned_prompts: 201 });
    expect(C.toTargetHitRateFromSummary({ data: odd, meta: report }).rate).toBe(50.2);
    const live = { ...META, surface: "website", source: { url_rates: "live", reason: "no_publication", publications: [] } } as S["Meta"];
    expect(C.toTargetHitRateFromSummary({ data: odd, meta: live })).toEqual({
      hitPrompts: 201,
      ownedPrompts: 201,
      measuredPrompts: 400,
      rate: 50.3,
      ownedRate: 50.3,
      source: "live",
    });
    expect(C.toTargetHitRateFromSummary({ data: summary(up), meta: live }).rate).toBe(0.5);
    // url_prompts null (meta.suppressed url_prompts) -> the legacy empty values (no `unit`: legacy wording)
    const none = C.toTargetHitRateFromSummary({ data: summary(null), meta: { ...META, surface: "website", suppressed: { url_prompts: "hidden" } } });
    expect(none).toEqual({ hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null });
  });
});

describe("list parameters and route helpers", () => {
  it("domainsParams: defaults stay off the query (default cursor hash), lists deduped and sorted", () => {
    expect(C.domainsParams({ limit: 200 })).toEqual({ limit: 200 });
    expect(C.domainsParams({ limit: 50, sort: "citations", q: "  " })).toEqual({ limit: 50 });
    expect(
      C.domainsParams({ limit: 1, cursor: "abc", q: " kia ", sort: "share", dir: "asc", competitor: ["b", "a", "b", ""], skey: ["z"], competitorSources: true }),
    ).toEqual({ limit: 1, cursor: "abc", q: "kia", sort: "share", dir: "asc", competitor: ["a", "b"], skey: ["z"], competitor_sources: true });
  });

  it("D4 / U7-N14: competitor[] and skey[] keep the first 100 picks in URL order (backend cap), over-long values dropped", () => {
    const many = Array.from({ length: 150 }, (_, i) => `c${String(149 - i).padStart(3, "0")}.example`);
    const first100 = many.slice(0, 100).sort();
    expect(C.PICKS_MAX).toBe(100);
    expect(C.pickList(many)).toEqual(first100);
    expect(C.pickList([...many.slice(0, 99), "x".repeat(513), "y.example"])).toEqual([...many.slice(0, 99), "y.example"].sort());
    const params = C.domainsParams({ limit: 200, competitor: many, skey: many });
    expect([params.competitor, params.skey]).toEqual([first100, first100]);
  });

  it("skey path segment: base64url round trip for social keys and non-ASCII; junk and non-canonical refused", () => {
    for (const k of ["instagram.com/hyundai", "현대.kr", "a.b-c_d"]) expect(C.decodeSkey(C.encodeSkey(k))).toBe(k);
    expect(C.encodeSkey("instagram.com/hyundai")).not.toContain("/");
    expect(C.decodeSkey("a/b")).toBeNull();
    expect(C.decodeSkey(C.encodeSkey("x") + "=")).toBeNull();
    expect(C.decodeSkey(C.encodeSkey("a\u0001b"))).toBeNull();
    expect(C.decodeSkey("")).toBeNull();
  });

  it("route query: the page's filter params only (no sub page state), cf_ only for the project's active fields", () => {
    const sp = { geography: "US~KR", q: "kia", page: "3", cursor: "c", tab: "owned", sort: "share", [`cf_${FIELD}`]: "x", cf_old: "y", source: "Official (HMG)" };
    expect(C.citationRouteQuery(sp, { surface: "global" })).toBe("geography=US%7EKR&source=Official+%28HMG%29");
    expect(C.citationRouteQuery(sp, { surface: "website" })).toBe("geography=US%7EKR&source=Official+%28HMG%29&surface=website");
    const pq = new URLSearchParams(C.citationRouteQuery(sp, { surface: "project", projectId: PROJECT, customFieldIds: [FIELD] }));
    expect([pq.get(`cf_${FIELD}`), pq.get("cf_old"), pq.get("projectId")]).toEqual(["x", null, PROJECT]);
  });

  it("route target: projectId uuid -> project, surface=website -> website, else global; bad projectId -> null", () => {
    expect(C.citationRouteTarget(new URLSearchParams(`projectId=${PROJECT}`))).toEqual({ surface: "project", projectId: PROJECT });
    expect(C.citationRouteTarget(new URLSearchParams("surface=website"))).toEqual({ surface: "website" });
    expect(C.citationRouteTarget(new URLSearchParams("surface=bogus"))).toEqual({ surface: "global" });
    expect(C.citationRouteTarget(new URLSearchParams("projectId=../x"))).toBeNull();
  });

  it("filter consistency: the route re-reads the query into the same CommonFilters the page sent", () => {
    const scope = { brands: ["Hyundai"], regions: [], countries: ["US", "KR"] };
    const user = { role: "hq" as const, scope };
    const sp = { geography: "US", engine: "chatgpt~gemini", time: "2026-09-01..2026-09-21", source: "Official (HMG)", competitor: "toyota.com~honda.com" };
    // global
    const page = { ...readStandardFilters(sp, scope), cumulative: true };
    const r = C.citationRouteFilters(new URLSearchParams(C.citationRouteQuery(sp, { surface: "global" })), { surface: "global" }, user);
    expect(analysisQuery(r.filters, r.ctx)).toEqual(analysisQuery(page, { surface: "global", scope }));
    expect(r.competitor).toEqual(["toyota.com", "honda.com"]);
    // website: region moved to websiteCountry
    const wsRaw = readStandardFilters(sp, scope, [...C.WEBSITE_CITATION_GROUPS]);
    const wsPage = { ...wsRaw, websiteCountry: wsRaw.region, region: undefined, cumulative: true };
    const w = C.citationRouteFilters(new URLSearchParams(C.citationRouteQuery(sp, { surface: "website" })), { surface: "website" }, user);
    expect(analysisQuery(w.filters, w.ctx)).toEqual(analysisQuery(wsPage, { surface: "website", scope }));
    expect(analysisQuery(w.filters, w.ctx).query.country).toEqual(["US"]);
    // project: no scope, the active cf_ fields
    const psp = { ...sp, [`cf_${FIELD}`]: "a~b" };
    const p = C.citationRouteFilters(
      new URLSearchParams(C.citationRouteQuery(psp, { surface: "project", projectId: PROJECT, customFieldIds: [FIELD] })),
      { surface: "project", projectId: PROJECT },
      user,
    );
    const pq = analysisQuery(p.filters, p.ctx);
    expect([pq.query.project_id, pq.cf]).toEqual([PROJECT, { [FIELD]: ["a", "b"] }]);
  });
});

// ── loaders (fetch stubbed) ─────────────────────────────────────────────────

type Handler = (url: URL) => Response | Promise<Response>;
const log: { url: URL; at: number }[] = [];
let handler: Handler;
const ok = (data: unknown, meta: S["Meta"] = META) =>
  new Response(JSON.stringify({ data, meta }), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: "m", details: [] } }), { status, headers: { "content-type": "application/json" } });

function defaultHandler(url: URL): Response {
  switch (url.pathname) {
    case "/v1/citations/domains":
      return ok(DOMAINS);
    case "/v1/citations/sources":
      return ok(SOURCES);
    case "/v1/citations/prompts":
      return ok(PROMPTS, { ...META, page: { limit: 50, next_cursor: null, total: 2 } });
    case "/v1/citations/targets":
      return ok({ measured: 10, target: { num: 1, den: 10 }, owned: { num: 2, den: 10 } }, { ...META, source: { origin: "live", reason: "no_publication" } });
    case "/v1/citations/sources/tone":
      return ok({ items: [], counts: { positive: 4, negative: 1 } }, { ...META, page: { limit: 50, next_cursor: null, total: 0 } });
    case "/v1/trend": {
      const dim = url.searchParams.get("dimension");
      // P12 B101 dims: the category block of a source call (shared buckets, the block's series and meta)
      if (dim === "source" && url.searchParams.getAll("dims").includes("category@13")) {
        return ok({ ...TREND_SOURCE, dims: [{ dimension: "category", series: TREND_CATEGORY.series, meta: META }] });
      }
      return ok(dim === "source" ? TREND_SOURCE : dim === "category" ? TREND_CATEGORY : TREND_SHARE);
    }
    case "/v1/filters/dates":
      return ok({ dates: ["2026-09-21"], first_measured_date: "2026-09-01", latest_round_date: "2026-09-21", presets: [], dates_truncated: false });
    case "/v1/kpi/summary":
      return ok({ params: { answers: 8, applied_prompts: 120, measured_prompts: 100 } });
    case "/v1/kpi/compare":
      return ok([], { ...META, compare: { kind: "calendarMonth", windows: null } } as S["Meta"]);
    default:
      return fail(404, "not_found");
  }
}

beforeEach(() => {
  log.length = 0;
  handler = defaultHandler;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      const url = new URL(String(u));
      log.push({ url, at: log.length });
      return handler(url);
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const paths = () => log.map((x) => x.url.pathname);
const calls = (path: string) => log.filter((x) => x.url.pathname === path).map((x) => x.url.searchParams);

describe("loadCitationsView: calls, D6 order, degrade", () => {
  it("global: domains (limit 100 = the table, competitor sources, picks), sources, one trend call, split counts (limit 1), then essentials", async () => {
    const v = await C.loadCitationsView({ cumulative: true, engine: ["chatgpt"] }, G, ["toyota.com"]);
    const d = calls("/v1/citations/domains");
    // main call (+ the picks outside the first page: skey[] with the same competitor pick). B046: the
    // standard table shows 100 rows and has no "more" row, so its first page is 100 rows
    expect(d.map((q) => [q.get("limit"), q.getAll("competitor"), q.get("competitor_sources"), q.getAll("skey")])).toContainEqual([
      "100",
      ["toyota.com"],
      "true",
      [],
    ]);
    expect(d.map((q) => [q.get("limit"), q.getAll("skey")])).toContainEqual(["200", ["toyota.com"]]);
    // B043: no citation screen reads the competitor brand totals; the coverage denominator stays (include_den not sent)
    expect(d.map((q) => [q.get("include_competitor_totals"), q.get("include_den")])).toEqual(d.map(() => ["false", null]));
    // B043: the standard sources call keeps tone and types (the tiles and the type chart read the same answer)
    const src = calls("/v1/citations/sources");
    expect(src.length).toBeGreaterThan(0);
    expect(src.map((q) => [q.get("include_tone"), q.get("include_types")])).toEqual(src.map(() => [null, null]));
    // B044: the source and category trends are one call (dims), measured_days off (performance A1)
    expect(calls("/v1/trend").map((q) => [q.get("dimension"), q.get("top"), q.get("bucket"), q.getAll("dims"), q.getAll("measured_days")])).toEqual([
      ["source", "15", "cycle", ["category@13"], ["false"]],
    ]);
    // B043: the split card reads the two counts only
    expect(
      calls("/v1/citations/prompts").map((q) => [q.get("owned"), q.get("limit"), q.get("include_refs"), q.get("fields"), q.get("both_buckets")]),
    ).toEqual([["true", "1", "false", "text", null]]);
    expect(paths()).toEqual(expect.arrayContaining(["/v1/citations/sources", "/v1/filters/dates"]));
    // FA-3: the K-1 summary fed only the measurement overview card, gone upstream (hmg-geo #305)
    expect(paths()).not.toContain("/v1/kpi/summary");
    // the common filters reach every data call
    for (const x of log.filter((l) => l.url.pathname.startsWith("/v1/citations") || l.url.pathname === "/v1/trend")) {
      expect([x.url.searchParams.get("surface"), x.url.searchParams.getAll("engine")]).toEqual(["global", ["chatgpt"]]);
    }
    expect(v.table).toEqual({ nextCursor: "c2", total: 480 });
    expect(v.competitorOptions).toEqual(["toyota.com", "honda.com", "lexus.com"]);
    expect(v.live?.promptSplit?.owned).toHaveLength(1);
  });

  it("D6: the second stage (trends, prompt split) starts only after the three essentials answered", async () => {
    const answered = new Set<string>();
    const ESSENTIAL = ["/v1/citations/domains", "/v1/citations/sources", "/v1/filters/dates"];
    const startedWith: Record<string, number> = {};
    handler = async (url) => {
      if (!ESSENTIAL.includes(url.pathname)) startedWith[url.pathname] = Math.min(startedWith[url.pathname] ?? 99, answered.size);
      await new Promise((r) => setTimeout(r, ESSENTIAL.includes(url.pathname) ? 5 : 0));
      const res = defaultHandler(url);
      if (ESSENTIAL.includes(url.pathname)) answered.add(url.pathname);
      return res;
    };
    await C.loadCitationsView({ cumulative: true }, G);
    expect(startedWith).toEqual({ "/v1/trend": 3, "/v1/citations/prompts": 3 });
  });

  it("FA-3 / B044: the global page loaders read six distinct calls, no K-1 summary", async () => {
    await Promise.all([
      C.loadCitationsView({ cumulative: true }, G),
      C.loadCitationsAsOf({ cumulative: true }, G),
      C.loadCitationDeltas({ cumulative: true }, G),
      C.loadCitationSourceParts({ cumulative: true }, G),
    ]);
    // Distinct calls (outside a request scope nothing is deduped, so the set is compared):
    // domains, sources, calendar (essentials); the source trend with the category block (dims,
    // also the category Δ base), the prompt split, the share trend (card Δ). The page adds
    // auth/me, F-1 options and, for a calendar month, K-2 compare. Before FA-3 the K-1 summary was
    // one more essential (8 -> 7); B044 folded the category trend into the source call (7 -> 6).
    const key = (x: (typeof log)[number]) =>
      `${x.url.pathname}:${x.url.searchParams.get("dimension") ?? ""}${x.url.searchParams.getAll("dims").map((d) => `+${d}`).join("")}`;
    expect([...new Set(log.map(key))].sort()).toEqual([
      "/v1/citations/domains:",
      "/v1/citations/prompts:",
      "/v1/citations/sources:",
      "/v1/filters/dates:",
      "/v1/trend:none",
      "/v1/trend:source+category@13",
    ]);
    // the view's trend call and the Δ loader's category base are the same query (one HTTP call in a request)
    const trendQueries = new Set(calls("/v1/trend").filter((q) => q.get("dimension") === "source").map((q) => q.toString()));
    expect(trendQueries.size).toBe(1);
  });

  it("B044: the one dims call gives the same trends and category Δ base as the two separate calls", async () => {
    const v = await C.loadCitationsView({ cumulative: true }, G);
    const d = await C.loadCitationDeltas({ cumulative: true }, G);
    // the separate dimension=category call of the same window has the same buckets (the window's)
    const category = { ...TREND_CATEGORY, buckets: TREND_SOURCE.buckets };
    const separate = C.toCitationsLive({ domains: env(DOMAINS), sources: env(SOURCES), sourceTrend: env(TREND_SOURCE), categoryTrend: env(category), owned: env(PROMPTS) })!;
    expect([v.live?.trend, v.live?.categoryTrend]).toEqual([separate.trend, separate.categoryTrend]);
    expect(v.live?.trend).not.toBeNull();
    expect(v.live?.categoryTrend?.series).toEqual(["Official (HMG)", "Automotive Media"]);
    expect(d.prevCategories).toEqual(C.prevCategoriesOf(env(category)));
    // an answer without the category block (older backend): no category trend, the source trend stays
    handler = (url) => (url.pathname === "/v1/trend" && url.searchParams.get("dimension") === "source" ? ok(TREND_SOURCE) : defaultHandler(url));
    const old = await C.loadCitationsView({ cumulative: true, engine: ["x"] }, G);
    expect([old.live?.trend, old.live?.categoryTrend]).toEqual([separate.trend, null]);
  });

  it("website: split cards (owned and uncited, five rows) from one both_buckets call, the K-1 summary among the essentials, no C-4 targets", async () => {
    const UNCITED_ROW = { ...PROMPT_ROW, prompt_id: "00000000-0000-4000-8000-000000000031", text: "best SUV", citations: 4 };
    handler = (url) =>
      url.pathname === "/v1/citations/prompts" && url.searchParams.get("both_buckets") === "true"
        ? ok({ ...PROMPTS, other_bucket: [UNCITED_ROW] })
        : defaultHandler(url);
    const v = await C.loadCitationsView({ cumulative: true, websiteCountry: ["HYUNDAI-N"] }, { surface: "website", scope: null });
    // B043: one call instead of owned=true + owned=false (uncited = data.other_bucket, same limit and order)
    expect(
      calls("/v1/citations/prompts").map((q) => [q.get("owned"), q.get("limit"), q.get("both_buckets"), q.get("include_refs"), q.get("fields")]),
    ).toEqual([["true", "5", "true", null, null]]);
    expect(v.live?.promptSplit).toEqual(C.toPromptSplit(PROMPTS, { counts: PROMPTS.counts, items: [UNCITED_ROW] }));
    expect(v.live?.promptSplit?.uncited.map((p) => p.promptText)).toEqual(["best SUV"]);
    // B043: the website screen draws neither tone tiles nor types
    const src = calls("/v1/citations/sources");
    expect(src.length).toBeGreaterThan(0);
    expect(src.map((q) => [q.get("include_tone"), q.get("include_types")])).toEqual(src.map(() => ["false", "false"]));
    const dom = calls("/v1/citations/domains");
    expect(dom.map((q) => q.get("include_competitor_totals"))).toEqual(dom.map(() => "false"));
    // DC-02 decision 6: the website cards read K-1 url_prompts (C-4 keeps the measurement unit, unread)
    expect(paths()).toContain("/v1/kpi/summary");
    expect(paths()).not.toContain("/v1/citations/targets");
    expect(calls("/v1/kpi/summary")[0].get("surface")).toBe("website");
    expect(calls("/v1/kpi/summary")[0].getAll("country")).toEqual(["HYUNDAI-N"]);
    expect(calls("/v1/citations/domains")[0].get("competitor_sources")).toBeNull();
    expect(calls("/v1/citations/domains")[0].getAll("country")).toEqual(["HYUNDAI-N"]);
  });

  it("D4 / U7-N14: 150 ?competitor= picks -> every domains call carries at most 100 (no 422 on the essential call)", async () => {
    const many = Array.from({ length: 150 }, (_, i) => `c${String(i).padStart(3, "0")}.example`);
    const v = await C.loadCitationsView({ cumulative: true }, G, many);
    const d = calls("/v1/citations/domains");
    expect(d.length).toBeGreaterThan(0);
    for (const q of d) {
      expect(q.getAll("competitor").length).toBeLessThanOrEqual(100);
      expect(q.getAll("skey").length).toBeLessThanOrEqual(100);
    }
    expect(d[0].getAll("competitor")).toEqual(many.slice(0, 100));
    expect(v.live).not.toBeNull();
  });

  it("U7-N13: website split cards under a source category filter are the API split with source[] (not the legacy top-80 promptList buckets)", async () => {
    const v = await C.loadCitationsView({ cumulative: true, sourceCategory: ["Official (HMG)"] }, { surface: "website", scope: null });
    expect(calls("/v1/citations/prompts").map((q) => [q.get("owned"), q.get("both_buckets"), q.getAll("source")])).toEqual([
      ["true", "true", ["officialHmg"]],
    ]);
    // the split is set (the view does not fall back to its promptList buckets)
    expect(v.live?.promptSplit).not.toBeUndefined();
  });

  it("website cards: loadTargetHitRate reads K-1 url_prompts with the page filters", async () => {
    handler = (url) =>
      url.pathname === "/v1/kpi/summary"
        ? ok(
            { params: { answers: 8, applied_prompts: 120, measured_prompts: 100 }, url_prompts: { measured_prompts: 40, target_prompts: 7, owned_prompts: 11 } },
            { ...META, surface: "website", source: { url_rates: "live", reason: "no_publication", publications: [] } },
          )
        : defaultHandler(url);
    const card = await C.loadTargetHitRate({ cumulative: true, websiteCountry: ["HYUNDAI-N"] }, { surface: "website", scope: null });
    expect(card).toEqual({ hitPrompts: 7, ownedPrompts: 11, measuredPrompts: 40, rate: 17.5, ownedRate: 27.5, source: "live" });
    expect(paths()).toEqual(["/v1/kpi/summary"]);
    expect(calls("/v1/kpi/summary")[0].getAll("country")).toEqual(["HYUNDAI-N"]);
  });

  it("website with a source category filter: no summary or targets call (legacy empty cards)", async () => {
    await C.loadCitationsView({ cumulative: true, sourceCategory: ["Official (HMG)"] }, { surface: "website", scope: null });
    const card = await C.loadTargetHitRate({ sourceCategory: ["Official (HMG)"] }, { surface: "website", scope: null });
    expect(paths()).not.toContain("/v1/citations/targets");
    expect(paths()).not.toContain("/v1/kpi/summary");
    expect(card).toEqual(C.emptyTargetHitRate());
    expect(calls("/v1/citations/sources")[0].getAll("source")).toEqual(["officialHmg"]);
  });

  it("project: project_id and cf.<field> on every call", async () => {
    await C.loadCitationsView({ cumulative: true, customFieldFilters: { [FIELD]: ["a"] } }, { surface: "project", projectId: PROJECT, scope: null, customFields: { [FIELD]: ["a"] } });
    for (const x of log.filter((l) => l.url.pathname !== "/v1/filters/dates")) {
      expect([x.url.searchParams.get("project_id"), x.url.searchParams.getAll(`cf.${FIELD}`)]).toEqual([PROJECT, ["a"]]);
    }
  });

  it("degrade: domains 503 -> live null + the legacy label; trend 504 -> only that trend null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handler = (url) => (url.pathname === "/v1/citations/domains" ? fail(503, "upstream") : defaultHandler(url));
    const v = await C.loadCitationsView({ cumulative: true }, G);
    expect(v).toEqual({ live: null, table: null, competitorOptions: [] });
    // the legacy label (read by the page through wasDegraded inside the request scope)
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("degraded=standardCitations"))).toBe(true);
    expect(wasDegraded("standardCitations")).toBe(false); // outside a request: no store (degrade-registry header)
    // citationsDegraded reads the same labels back (all false outside a request scope)
    expect(C.citationsDegraded("global")).toEqual({ data: false, trend: false, categoryTrend: false, split: false });
    warn.mockClear();
    handler = (url) => (url.pathname === "/v1/trend" ? fail(504, "timeout") : defaultHandler(url));
    const w = await C.loadCitationsView({ cumulative: true, dateFrom: "2026-09-01", dateTo: "2026-09-21" }, G);
    expect([w.live?.trend, w.live?.categoryTrend, w.live?.summary.total]).toEqual([null, null, 16]);
    // B044: the one trend call failed -> both chart labels are recorded, as the two calls did (the screens read them, B041/B042)
    const labels = () => warn.mock.calls.map((c) => String(c[0]).replace(/^.*degraded=/, ""));
    expect(labels().sort()).toEqual(["standardCitations.categoryTrend", "standardCitations.trend"]);
    // B042: a failed website split records websiteCitations.split (one call now, both cards)
    warn.mockClear();
    handler = (url) => (url.pathname === "/v1/citations/prompts" ? fail(503, "upstream") : defaultHandler(url));
    const s = await C.loadCitationsView({ cumulative: true, engine: ["gemini"] }, { surface: "website", scope: null });
    expect([s.live?.promptSplit, labels()]).toEqual([null, ["websiteCitations.split"]]);
    warn.mockRestore();
  });

  it("errors that are not a backend outage reach the page (401, 403, 422)", async () => {
    for (const [status, code] of [[401, "token_expired"], [403, "menu_forbidden"], [422, "invalid_value"]] as const) {
      handler = (url) => (url.pathname === "/v1/citations/domains" ? fail(status, code) : defaultHandler(url));
      await expect(C.loadCitationsView({ cumulative: true, brand: [String(status)] }, G)).rejects.toMatchObject({ status, code });
    }
  });
});

describe("standard secondary loaders", () => {
  it("deltas from the share and category trends", async () => {
    const d = await C.loadCitationDeltas({}, G);
    expect(Object.keys(d).sort()).toEqual(["officialDelta", "prevCategories"]);
    expect(d.officialDelta).toEqual({ delta: 6.3, basisDate: "2026-09-14" });
    expect(d.prevCategories?.asOf).toBe("2026-09-14");
    // the category Δ base is the category block of the view's trend call (B044, same query)
    expect(calls("/v1/trend").map((q) => [q.get("dimension"), q.getAll("metrics").sort(), q.getAll("dims")])).toEqual(
      expect.arrayContaining([["none", ["citation_share", "visibility"], []], ["source", [], ["category@13"]]]),
    );
    expect(calls("/v1/trend").map((q) => q.get("dimension")).sort()).toEqual(["none", "source"]);
  });

  it("B050 (kept): the share Δ needs visibility - a round without answers or with a mention gap is not a Δ basis", async () => {
    const shareOnly = { ...TREND_SHARE, series: [TREND_SHARE.series[1]] };
    const noAnswers = {
      ...TREND_SHARE,
      series: [series({ metric: "visibility", key: null, points: [pt("2026-09-07", 4, 8), pt("2026-09-14", 0, 0), pt("2026-09-21", 6, 8)] }), TREND_SHARE.series[1]],
    };
    const mentionGap = {
      ...TREND_SHARE,
      series: [series({ metric: "visibility", key: null, points: [pt("2026-09-07", 4, 8), pt("2026-09-14", null, 0, "hidden"), pt("2026-09-21", 6, 8)] }), TREND_SHARE.series[1]],
    };
    expect(C.shareDeltas(env(noAnswers)).officialDelta?.basisDate).toBe("2026-09-07");
    expect(C.shareDeltas(env(mentionGap)).officialDelta?.basisDate).toBe("2026-09-07");
    // without the visibility series every bucket has answers 0 (the card rule skips it) and the Δ is gone:
    // visibility is read by the valid-round rule, so the request keeps it (B050 "쓰이면 유지")
    expect(C.shareDeltas(env(TREND_SHARE)).officialDelta).toEqual({ delta: 6.3, basisDate: "2026-09-14" });
    expect(C.shareDeltas(env(shareOnly)).officialDelta).toBeNull();
    await C.loadCitationDeltas({ engine: ["x"] }, G);
    expect(calls("/v1/trend").find((q) => q.get("dimension") === "none")?.getAll("metrics").sort()).toEqual(["citation_share", "visibility"]);
  });

  it("types and tone from the same C-2 call; a 503 -> both null (PendingCard)", async () => {
    const p = await C.loadCitationSourceParts({}, G);
    expect(p.toneSummary?.positive.urls).toBe(4);
    expect(p.typeCategories?.map((t) => t.type)).toEqual(["mention", "recommendation", "comparison", "definition", "final_choice"]);
    expect(paths().filter((x) => x === "/v1/citations/sources/types")).toEqual([]);
    handler = (url) => (url.pathname === "/v1/citations/sources" ? fail(503, "upstream") : defaultHandler(url));
    expect(await C.loadCitationSourceParts({ engine: ["x"] }, G)).toEqual({ typeCategories: null, toneSummary: null });
  });

  it("month comparison: citations_per_answer (BG-05); a 503 drops the line", async () => {
    await C.loadCitationPeriodCompare({ dateFrom: "2026-08-01", dateTo: "2026-08-31" }, G, "calendarMonth");
    expect(calls("/v1/kpi/compare").map((q) => [q.get("kind"), q.getAll("metrics")])).toEqual([["calendarMonth", ["citations_per_answer"]]]);
    handler = (url) => (url.pathname === "/v1/kpi/compare" ? fail(503, "upstream") : defaultHandler(url));
    expect(await C.loadCitationPeriodCompare({ dateFrom: "2026-07-01", dateTo: "2026-07-31" }, G, "calendarMonth")).toBeNull();
  });
});

describe("sub pages (cursor, D5)", () => {
  it("prompts: q / limit 50 / cursor forwarded, rows + both tab counts from one answer, total = meta.page.total", async () => {
    const r = await C.loadOwnedPromptPage({}, G, { owned: false, q: " ev ", page: 3, cursor: "abc" });
    // B043: fields=text (the page draws no funnel / engines); answers kept for the modal; no both_buckets with a cursor
    expect(
      calls("/v1/citations/prompts").map((q) => [q.get("owned"), q.get("limit"), q.get("q"), q.get("cursor"), q.get("fields"), q.get("include_refs"), q.get("both_buckets")]),
    ).toEqual([["false", "50", "ev", "abc", "text", null, null]]);
    expect([r.page?.total, r.page?.page, r.page?.pageSize, r.page?.nextCursor, r.ownedCount, r.uncitedCount]).toEqual([2, 3, 50, null, 2, 5]);
  });

  it("fetchCitationPrompts: the P12 options are sent only when set; both_buckets never with a cursor", async () => {
    await C.fetchCitationPrompts({}, G, { owned: true, limit: 5 });
    await C.fetchCitationPrompts({}, G, { owned: true, limit: 5, bothBuckets: true, cursor: "c1" });
    await C.fetchCitationPrompts({}, G, { owned: true, limit: 1, includeRefs: false, fields: "text", bothBuckets: true });
    const opts = (q: URLSearchParams) => [q.get("include_refs"), q.get("fields"), q.get("both_buckets"), q.get("cursor")];
    expect(calls("/v1/citations/prompts").map(opts)).toEqual([
      [null, null, null, null],
      [null, null, null, "c1"],
      ["false", "text", "true", null],
    ]);
  });

  it("prompts: counts null when no prompt has an own citation (legacy promptSplit null)", async () => {
    handler = (url) => (url.pathname === "/v1/citations/prompts" ? ok({ counts: { owned: 0, uncited: 3 }, items: [] }) : defaultHandler(url));
    const r = await C.loadOwnedPromptPage({}, G, { owned: true, q: "", page: 1, cursor: null });
    expect([r.ownedCount, r.uncitedCount]).toEqual([null, null]);
  });

  it("a stale (409) or foreign (422 cursor_invalid) cursor reads the first page once; other 422 are thrown", async () => {
    for (const code of ["cursor_stale", "cursor_invalid"]) {
      log.length = 0;
      handler = (url) =>
        url.searchParams.get("cursor") ? fail(code === "cursor_stale" ? 409 : 422, code) : defaultHandler(url);
      const r = await C.loadOwnedPromptPage({}, G, { owned: true, q: "", page: 4, cursor: "old" });
      expect(r.page?.page).toBe(1);
      expect(calls("/v1/citations/prompts").map((q) => q.get("cursor"))).toEqual(["old", null]);
    }
    handler = () => fail(422, "invalid_value");
    await expect(C.loadOwnedPromptPage({}, G, { owned: true, q: "", page: 1, cursor: "x" })).rejects.toBeInstanceOf(HghApiError);
  });

  it("a 503 -> page null (legacy kpiDegrade)", async () => {
    handler = () => fail(503, "upstream");
    expect(await C.loadOwnedPromptPage({}, G, { owned: true, q: "", page: 1, cursor: null })).toEqual({ page: null, ownedCount: null, uncitedCount: null });
  });

  it("tone: with_counts (BG-27), group_by source for the domain switch", async () => {
    const r = await C.loadToneUrlPage({}, G, { tone: "negative", byDomain: true, q: "", page: 1, cursor: null });
    expect(calls("/v1/citations/sources/tone").map((q) => [q.get("tone"), q.get("group_by"), q.get("with_counts"), q.get("limit")])).toEqual([
      ["negative", "source", "true", "50"],
    ]);
    expect(r.counts).toEqual({ positive: 4, negative: 1 });
    expect(paths()).not.toContain("/v1/citations/sources");
  });

  it("tone B045: withCounts=false skips the counts (null = reuse the shown ones), the page is the same; a 503 keeps the degrade counts", async () => {
    const req = { tone: "positive" as const, byDomain: false, q: "ev", page: 2, cursor: "c1" };
    const counted = await C.loadToneUrlPage({}, G, req);
    const skipped = await C.loadToneUrlPage({}, G, { ...req, withCounts: false });
    expect(calls("/v1/citations/sources/tone").map((q) => [q.get("cursor"), q.get("q"), q.get("with_counts")])).toEqual([
      ["c1", "ev", "true"],
      ["c1", "ev", null],
    ]);
    expect(skipped.page).toEqual(counted.page);
    expect(skipped.counts).toBeNull();
    expect(counted.counts).toEqual({ positive: 4, negative: 1 });
    handler = () => fail(503, "upstream");
    expect(await C.loadToneUrlPage({}, G, { ...req, withCounts: false })).toEqual({ page: null, counts: { positive: null, negative: null } });
  });
});

describe("route gate (both sources, before any read)", () => {
  const legacyYes = vi.fn(async () => true);
  const legacyNo = vi.fn(async () => false);
  const user = (o: Record<string, unknown> = {}) => ({ id: "u1", role: "admin" as const, scope: { all: true } as never, menuGroups: null, ...o });

  it("place gate: role and menu groups of the screen family -> 403", async () => {
    expect(await C.citationRouteGate(user({ role: "vendor" }), "global", undefined, legacyYes)).toEqual({ ok: false, status: 403 });
    expect(await C.citationRouteGate(user({ role: "hq", menuGroups: ["project"] }), "global", undefined, legacyYes)).toEqual({ ok: false, status: 403 });
    expect(await C.citationRouteGate(user(), "global", undefined, legacyYes)).toEqual({ ok: true });
  });

  it("project: bad id / demo for non-admin -> 404; legacy source asks the repository", async () => {
    expect(await C.citationRouteGate(user(), "project", "nope", legacyYes)).toEqual({ ok: false, status: 404 });
    expect(await C.citationRouteGate(user({ role: "hq" }), "project", "de300000-0000-4000-8000-000000000001", legacyYes)).toEqual({ ok: false, status: 404 });
    expect(await C.citationRouteGate(user({ role: "vendor" }), "project", PROJECT, legacyNo)).toEqual({ ok: false, status: 404 });
    expect(legacyNo).toHaveBeenCalled();
    expect(await C.citationRouteGate(user({ role: "vendor" }), "project", PROJECT, legacyYes)).toEqual({ ok: true });
    expect(paths()).toEqual([]);
  });

  it("project with HGH_SOURCE_SESSION=api: GET /v1/projects/{id} (404 -> 404, 200 -> ok), no repository call", async () => {
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    const repo = vi.fn(async () => true);
    handler = () => fail(404, "not_found");
    expect(await C.citationRouteGate(user({ role: "vendor" }), "project", PROJECT, repo)).toEqual({ ok: false, status: 404 });
    expect(paths()).toEqual([`/v1/projects/${PROJECT}`]);
    // the light gate (view=gate: same decision and errors, no detail summary statements)
    expect(log[0].url.searchParams.getAll("view")).toEqual(["gate"]);
    // a 403 of the project gate is not a place-gate 403: hidden as 404 (project_forbidden) or kept (menu)
    handler = () => fail(403, "not_member");
    expect(await C.citationRouteGate(user({ role: "vendor" }), "project", PROJECT, repo)).toEqual({ ok: false, status: 404 });
    handler = () => fail(503, "upstream");
    await expect(C.citationRouteGate(user({ role: "vendor" }), "project", PROJECT, repo)).rejects.toMatchObject({ status: 503 });
    expect(repo).not.toHaveBeenCalled();
  });

  it("source switch: G2 global, G3 website, G6 project (default legacy)", () => {
    expect([C.isCitationsApi("global"), C.isCitationsApi("website"), C.isCitationsApi("project")]).toEqual([false, false, false]);
    expect(C.isCitationsApi("website", { HGH_SOURCE_G3: "api" })).toBe(true);
    expect(C.isCitationsApi("global", { HGH_SOURCE_G3: "api" })).toBe(false);
    expect(C.isCitationsApi("project", { HGH_SOURCE_G6: "api" })).toBe(true);
  });
});

describe("drilldown, table pages and the export relay", () => {
  it("detail: the skey is a path parameter (encoded), filters as query", async () => {
    handler = (url) =>
      url.pathname.startsWith("/v1/citations/domains/")
        ? ok({ source: { skey: "instagram.com/hyundai", domain: "instagram.com", is_social: true, category: HMG }, citations: 1, own_citations: 0, urls: [], prompts: [] })
        : defaultHandler(url);
    const d = await C.loadDomainDrilldown({ engine: ["gemini"] }, G, "instagram.com/hyundai");
    expect(d).toEqual({ urls: [], promptList: [] });
    expect(log[0].url.pathname).toBe("/v1/citations/domains/instagram.com%2Fhyundai");
    expect(log[0].url.searchParams.getAll("engine")).toEqual(["gemini"]);
  });

  it("B047: url_total / prompt_total are passed on only when the detail caps cut the lists", () => {
    const url = (i: number) => ({ url: `https://a.example/${i}`, title: "T", citations: 1, engines: ["gemini"], prompt_text: null, country: null });
    const prompt = (i: number) => ({
      prompt_id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
      text: `p${i}`,
      funnel: null,
      citations: 1,
      own_citations: 0,
      engines: ["gemini"],
      answers: [],
    });
    const detail = (o: Partial<S["DomainDetailData"]>): S["DomainDetailData"] => ({
      source: { skey: "a.example", domain: "a.example", is_social: false, category: MEDIA },
      citations: 40,
      own_citations: 0,
      urls: Array.from({ length: 10 }, (_, i) => url(i)),
      prompts: Array.from({ length: 12 }, (_, i) => prompt(i)),
      ...o,
    });
    // cut: 37 URLs (10 shown), 250 prompts (12 shown)
    const cut = C.toDomainDrilldown(detail({ url_total: 37, prompt_total: 250 }));
    expect([cut.urls.length, cut.promptList.length, cut.urlTotal, cut.promptTotal]).toEqual([10, 12, 37, 250]);
    // not cut (total = shown), or an older backend without totals: the legacy keys only (same object as before)
    expect(Object.keys(C.toDomainDrilldown(detail({ url_total: 10, prompt_total: 12 })))).toEqual(["urls", "promptList"]);
    expect(Object.keys(C.toDomainDrilldown(detail({})))).toEqual(["urls", "promptList"]);
    expect(Object.keys(C.toDomainDrilldown(detail({ url_total: 37, prompt_total: 12 })))).toEqual(["urls", "promptList", "urlTotal"]);
  });

  it("list page for the client table: rows + cursor + total; the competitor brand totals are not computed", async () => {
    const p = await C.listCitationDomains({}, G, { limit: 200, q: "kia", sort: "skey", dir: "asc", cursor: "c1", competitor: ["toyota.com"] });
    expect(
      calls("/v1/citations/domains").map((q) => [q.get("q"), q.get("sort"), q.get("dir"), q.get("cursor"), q.getAll("competitor"), q.get("include_competitor_totals")]),
    ).toEqual([["kia", "skey", "asc", "c1", ["toyota.com"], "false"]]);
    expect([p.rows.length, p.nextCursor, p.total]).toEqual([3, "c2", 480]);
  });

  it("B046: the standard first page is the table's 100 rows; website/project keep 200 with the cursor", () => {
    expect(C.mainDomainsRequest(G, ["b", "a"])).toEqual({ limit: 100, competitor: ["b", "a"], competitorSources: true, competitorTotals: false });
    expect(C.mainDomainsRequest({ surface: "website", scope: null })).toEqual({ limit: 200, competitorTotals: false });
    expect(C.STANDARD_TABLE_ROWS).toBe(100);
    expect(C.domainsParams(C.mainDomainsRequest(G))).toEqual({ limit: 100, competitor_sources: true, include_competitor_totals: false });
  });

  it("export (BG-22): streamed with the same search / sort and the locale", async () => {
    handler = () =>
      new Response("xlsx-bytes", {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=\"c.xlsx\"" },
      });
    const res = await C.relayDomainsExport({}, { surface: "website", scope: null }, { q: "kia", sort: "share", locale: "en" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("xlsx-bytes");
    expect(res.headers.get("content-disposition")).toContain("c.xlsx");
    const q = log[0].url.searchParams;
    expect([log[0].url.pathname, q.get("q"), q.get("sort"), q.get("locale"), q.get("format"), q.get("limit"), q.get("surface")]).toEqual([
      "/v1/citations/domains/export",
      "kia",
      "share",
      "en",
      "xlsx",
      null,
      "website",
    ]);
    // the export query has no include_competitor_totals (the back export already skips them, P2 B011)
    expect(q.has("include_competitor_totals")).toBe(false);
  });
});
