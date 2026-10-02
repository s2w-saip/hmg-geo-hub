import "server-only";

// Citations adapter (unit U7): the citation screens' data from the backend, in the shapes the
// legacy readers produced. Design 3.3 "인용(부록 C)", appendix C (공통 변환 규칙 and the five
// screens), 3.5 #6..#8, decisions D5 (cursor), D6 (first render budget), D8 (source flag).
//
//   legacy (lib/scope/server.ts)                          api (this module)
//   fetchStandard/Website/ProjectCitations SRV:3894/5011/805  loadCitationsView -> {live, table}
//   competitorDomainOptions(live.domains)  _data/citation-view.ts:95  competitorOptionsOf (BG-20)
//   fetchStandardOverviewCardDelta("citationShare") SRV:2159   loadCitationDeltas.officialDelta
//   fetchStandardCitationCategoriesPrev    SRV:2347         loadCitationDeltas.prevCategories
//   (the measurement overview card and the base URL prev sub KPI left the page upstream, hmg-geo
//   #305 and 783478c: their loaders, loadCitationOverview and loadCitationDeltas.prev, and the
//   global K-1 essential that fed the card are gone, sync S1 FA-3)
//   fetchStandardCitationTypeCategories    SRV:3390         loadCitationSourceParts.typeCategories
//   fetchStandardCitationToneSummary       SRV:3400         loadCitationSourceParts.toneSummary
//   fetchStandardCitationOwnedPrompts      SRV:3425         loadOwnedPromptPage (C-3, cursor)
//   fetchStandardCitationToneUrls          SRV:3410         loadToneUrlPage (C-2, cursor, BG-27)
//   fetchWebsiteTargetHitRate              SRV:5194         loadTargetHitRate (K-1 url_prompts, BG-26;
//                                                           DC-02 decision 6, C-4 is no longer read)
//   (inline urls / promptList of each row)                 loadDomainDrilldown (C-1 detail, lazy)
//   (client search / sort / export of every row)           listCitationDomains (BG-21), export (BG-22)
//
// Calls. One CitationsLive = C-1 domains (summary, table, competitor sources) + C-2 sources
// (categories, engines, types, tone) + T-1 source trend (top 15) + T-1 category trend (top 13)
// + C-3 prompts (split counts; website/project also the top 5 of each side). Identical queries
// share one request through the client dedupe, so the header pill, the overview card, the filter
// bar and the body read one domains call.
// D6: the essentials (domains, sources and the calendar; plus the K-1 summary on website, the
// URL-rate cards) fire first; every other call waits in afterCitationEssentials until they settled.
//
// Field rules (hand-checked in citations.test.ts):
//   domain row  domain <- skey (the group key the legacy table showed, social accounts host+path),
//               citations, share <- Math.round(num/den*1000)/10 (den 0 -> 0, legacy pctOf),
//               prompts <- citing_prompts (BG-24), coverageRate <- coverage the same way,
//               isOurs <- is_own, category <- legacy label of the category slug, skey kept,
//               rank / matchRank kept (BG-21: '#' of the standard / website-project tables),
//               urls and promptList empty (loaded when the row opens, 3.5 #6)
//   summary     total <- total_citations, uniqueDomains <- unique_sources, officialOwnShare <-
//               own_share the legacy way (Math.round(num/den*1000)/10, den 0 -> null)
//   categories  [{name: legacy label, value: citations}] in API order (citations desc), null when
//               there is no citation
//   engines     by_engine merged per display label (claude-web and claude-sonnet are both
//               "Claude", as the legacy Map keyed by providerLabel), byCategory keyed by label,
//               sorted by total desc, null when empty
//   types       the five mention types in the legacy order (MENTION_TYPE_KEYS), zero-filled
//   tone        tone.{positive,negative}.{urls,citations,answers} as is
//   trends      rows in bucket order: week <- bucket key (round date, the legacy grid slot key),
//               value <- point.ratio.num; a gapped bucket (collection_error, hidden) or a bucket
//               without any value becomes {week, <series>: null, gap} (legacy gridGapRow); fewer
//               than two valued buckets or no series -> null. Category series are the snapshot
//               categories in their order (legacy buildWeeklyTrend(entries, categories)).
//   split       ownedCount / uncitedCount <- counts; owned 0 -> null (legacy "section hidden")
//   Δ           officialDelta = overviewCardDelta over the bucket=cycle citation_share trend (last
//               two valued rounds, the Overview card rule); the category Δ base is the previous
//               valued category-trend bucket
//   answers     {jobId, provider label, region, mentionCount <- citations in that answer,
//               position null, no highlights, measuredAt null, runs 1} (legacy citationAnswerRef)
//
// Empty and failure (legacy CitationsLive | null): meta.suppressed['*'] -> null (EmptyState);
// no citation in the window -> the legacy empty shape (EMPTY_CITATIONS). A backend 5xx, timeout
// or abort of the domains or sources call -> null plus the legacy degrade label (the standard
// screen then shows its "delayed" card); a failed trend -> that trend null; a failed prompt
// split -> null. 401/403/404/422 are thrown for the page (throwForPage) or the route.
//
// Known differences. Design DC list (front-adapter-plan 3.6 (나)): DC-01 (engine[] empty = the
// default engine), DC-05 (Δ per round), DC-08 (trend
// series = top N of the whole window, 12 buckets by default), DC-10 (prompt split owned per
// citation row; tone tiles and tone lists apply source[]). Resolved: DC-02 by decision 6 ("현행
// 문구 유지"): the website cards read K-1 url_prompts (prompt unit, legacy wording and rounding,
// summary.ts urlPromptRates). DC-11 (category Δ base =
// the previous round): the legacy moved to the same base in hmg-geo d175da4 (#322,
// citationCategoriesPrevRound: the previous valued slot of the card Δ trend, its category
// totals). prevCategoriesOf picks the same round: a slot with citations has answers, and a
// citation or mention gap drops the category points too (U4-N5). Sync S1 FA-4, no A4 notice.
// Outside the DC list (U7 numbering, for the A4 notice; asserted in citations.test.ts):
//   U7-N1  asOf is the round date of the answer set (meta.as_of), not the latest measured_at instant
//   U7-N2  every row has its drilldown (loaded on open); the legacy loaded urls / prompts only for
//          the top 80 domains and a capped official tail ("상위 도메인에만 제공" is gone)
//   U7-N3  competitor options are capped at 500 sources (BG-20 cap); legacy listed every official
//          competitor domain of the cache-slimmed table (1,500 to 2,000 rows)
//   U7-N4  website/project domain table: the first 200 rows and "더 보기" (cursor, D5); search,
//          sort and the export run on the backend over every row (legacy: every row loaded once)
//   U7-N5  standard domain table: search and sort run on the backend over every source (legacy:
//          over the cache-slimmed 1,500 to 2,000 rows); the table still shows the top 100
//   U7-N6  domain name sort is the backend skey order (legacy localeCompare: case and non-ASCII
//          letters may order differently)
//   U7-N7  prompt and tone sub pages page with a cursor: next and previous only (previous = the
//          cursors kept on the client, or the first page when the page was opened directly)
//   U7-N8  website target / owned URL card note: the API always states its origin (published or
//          live); the legacy note was absent while the report-truth switch was off
//   U7-N9  domain drilldown URL country = the geo catalog country of the URL (legacy rule), the
//          API country field is not used (kept equal to the legacy value on purpose)
//   U7-N10 drilldown URL list at the 10-URL cap: among URLs tied on citations the backend keeps
//          the lowest url_hash, the legacy the lowest url (a different URL may make the cut);
//          the displayed order is the legacy one (count desc, then url)
//   U7-N11 website cards over several published reports: the round labels of the first report
//          and the summed site count (the legacy read one publication)
//   U7-N12 a sub page URL whose cursor no longer fits (stale round, or the filter panel changed
//          the filters and kept the cursor) reads page one instead of failing (409 / 422 cursor_*)
//   U7-N13 website / project owned and uncited prompt cards under a source category filter
//          (?source=): the API splits with source[] over every citation row (C-3); the legacy
//          skipped the SQL split there and built the buckets from the domain rows' promptList,
//          which only the top 80 domains carried, so the counts and top 5 lists may differ
//   U7-N14 ?competitor= picks beyond 100 (the backend cap of competitor[] / skey[]): the first 100
//          in URL order apply, the rest are ignored (legacy applied any number; the picker offers
//          up to 500 options, observed use is tens)
// Parity: citations.parity.test.ts runs the UNCHANGED legacy aggregate (and the prompts sub page
// reader) on PGlite against a backend model of the same world; only the entries above differ.
import type { AllowedScope, MenuGroup, Role } from "@/lib/auth/types";
import type {
  CitationCategoryTotals,
  CitationOwnedPromptPage,
  CitationTone,
  CitationToneSummary,
  CitationToneUrlPage,
  CitationTypeCategoryRow,
} from "@/lib/db/repositories/scope-aggregates";
import type { OverviewCardDelta } from "@/lib/kpi/overview-card-values";
import { overviewCardDelta } from "@/lib/kpi/overview-card-values";
import type { CompareResult } from "@/lib/kpi/period-compare";
import type {
  CitationCategorySlice,
  CitationDomainLive,
  CitationPromptLive,
  CitationsLive,
  CitationsPromptSplit,
  CitationTrend,
  CitationUrlLive,
  EngineCategorySlice,
  MentionAnswerLive,
  StandardFilters,
} from "@/lib/scope/result-adapter";
import { providerLabel } from "@/lib/scope/result-adapter";
import { CITATION_CATEGORIES, CITATION_CATEGORY_SLUGS } from "@/lib/citation-categorizer/taxonomy";
import { displayCitationUrl } from "@/lib/url-display";
import { geoEntryForUrl } from "@/lib/geo-catalog";
import { isDemoProject } from "@/lib/demo";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { readProjectCustomFieldFiltersRaw } from "@/components/dash/project-custom-field-filters";
import { splitFilterValues } from "@/components/dash/filter-encoding";
import type { TrendGapRow, TrendGap } from "@/lib/viz/trend-gap";
import { degradeOnApiFailure } from "@/lib/scope/degrade-registry";
import { dedupeInRequest, stableKey } from "@/lib/request-dedupe";
import type { components } from "../api-types";
import { hghGet, hghSource } from "../client";
import { asOfDate, wholeSuppression, type ApiMeta, type Ratio } from "../convert";
import { errorKindOf, isHghApiError } from "../errors";
import { pageInfo } from "../paginate";
import { relayDownload } from "../relay";
import { withParams, type Surface } from "../query";
import { analysisQuery, canReadAnalysis, fetchFilterDates, isAnalysisApi, type AnalysisQueryContext } from "./filters";
import { fetchKpiSummary, provenanceOf, urlPromptRates, type SummaryResponse } from "./summary";
import { fetchTrend, toStandardTrendBuckets, type TrendResponse } from "./trend";
import { fetchPeriodCompareApi } from "./compare";
import { fetchProjectGate, isProjectId } from "./project-gate";

type S = components["schemas"];
export type ApiDomainsData = S["DomainsData"];
export type ApiDomainRow = S["DomainRow"];
export type ApiDomainDetail = S["DomainDetailData"];
export type ApiSourcesData = S["SourcesData"];
export type ApiPromptsData = S["CitationPromptsData"];
export type ApiPromptRow = S["PromptRow"];
export type ApiPromptAnswer = S["app__features__analytics__citations__prompts__schemas__AnswerRef"];
export type ApiDetailAnswer = S["app__features__analytics__citations__domains__shared__AnswerRef"];
export type ApiToneData = S["ToneData"];
export type ApiToneRow = S["ToneRow"];
export type ApiTargetsData = S["TargetsData"];
export type ApiCategoryRef = S["CategoryRef"];

interface Enveloped<T> {
  data: T;
  meta: ApiMeta;
}

/** analysisQuery context of a citation screen (surface, projectId, scope, customFields). */
export type CitationsContext = AnalysisQueryContext;

// ── constants ───────────────────────────────────────────────────────────────

/** Rows of the first domains page (design 3.3: limit=200, the backend maximum). */
export const DOMAIN_PAGE = 200;
/** Rows the standard table shows (DOMAIN_RANK_LIMIT, citations-standard-view.tsx). */
export const STANDARD_TABLE_ROWS = 100;
/** Series of the weekly top domains chart (legacy union cap 15) and the category chart (13). */
export const SOURCE_TREND_TOP = 15;
export const CATEGORY_TREND_TOP = 13;
/** Rows of each prompt split card on website/project (PromptBucketCard shows five). */
export const SPLIT_CARD_ROWS = 5;
/** Page size of the prompt and tone sub pages (legacy pageSize 50). */
export const SUBPAGE_SIZE = 50;
/** The five mention types in the legacy order (MENTION_TYPE_KEYS, scope-aggregates.ts:10677). */
export const MENTION_TYPES = ["mention", "recommendation", "comparison", "definition", "final_choice"] as const;

/** BG-21 sort keys. */
export type DomainSort = "citations" | "share" | "coverage" | "prompts" | "skey";
export const DOMAIN_SORTS: ReadonlySet<string> = new Set<DomainSort>(["citations", "share", "coverage", "prompts", "skey"]);

// ── conversions ─────────────────────────────────────────────────────────────

const LABEL_BY_SLUG: ReadonlyMap<string, string> = new Map(
  Object.entries(CITATION_CATEGORY_SLUGS).map(([label, slug]) => [slug, label]),
);

/** Category in the legacy vocabulary ("Official (HMG)", ...); unknown slug -> the API name. */
export function categoryLabelOf(c: Pick<ApiCategoryRef, "slug" | "name"> | null | undefined): string | null {
  if (!c) return null;
  return LABEL_BY_SLUG.get(c.slug) ?? c.name;
}

/** category_key -> label: from the answer's categories, else the seed code table (key = order 1..13). */
export function categoryKeyLabels(sources: Pick<ApiSourcesData, "categories">): (key: number) => string {
  const byKey = new Map<number, string>();
  for (const c of sources.categories) byKey.set(c.category.category_key, categoryLabelOf(c.category) ?? c.category.name);
  return (key) => byKey.get(key) ?? CITATION_CATEGORIES[key - 1] ?? String(key);
}

/** Legacy mirror percent: Math.round(num/den*1000)/10; den 0 -> 0 (pctOf) or null (summary share). */
export function mirrorPctOrZero(r: Ratio | null | undefined): number {
  return r && r.den > 0 ? Math.round((r.num / r.den) * 1000) / 10 : 0;
}
export function mirrorPctOrNull(r: Ratio | null | undefined): number | null {
  return r && r.den > 0 ? Math.round((r.num / r.den) * 1000) / 10 : null;
}

/** A domain row with the two BG-21 rank numbers (the screens read rank or matchRank for '#'). */
export type RankedCitationDomain = CitationDomainLive & { rank?: number; matchRank?: number };

/** C-1 DomainRow -> CitationDomainLive (+ skey, rank, matchRank). */
export function toCitationDomain(r: ApiDomainRow): RankedCitationDomain {
  const out: RankedCitationDomain = {
    domain: r.skey,
    citations: r.citations,
    share: mirrorPctOrZero(r.share),
    prompts: r.citing_prompts ?? 0,
    coverageRate: mirrorPctOrZero(r.coverage),
    urls: [],
    promptList: [],
    isOurs: r.is_own,
    category: categoryLabelOf(r.category),
    subcategory: null,
    skey: r.skey,
  };
  if (typeof r.rank === "number") out.rank = r.rank;
  if (typeof r.match_rank === "number") out.matchRank = r.match_rank;
  return out;
}

/** C-2 categories -> CitationCategorySlice[] (null when there is no citation, legacy rule). */
export function toCategorySlices(sources: ApiSourcesData): CitationCategorySlice[] | null {
  if (sources.total_citations <= 0) return null;
  return sources.categories.map((c) => ({ name: categoryLabelOf(c.category) ?? c.category.name, value: c.citations }));
}

/** C-2 by_engine -> EngineCategorySlice[] merged per display label (legacy engineCategorySlices). */
export function toEngineCategories(sources: ApiSourcesData): EngineCategorySlice[] | null {
  const label = categoryKeyLabels(sources);
  const byEngine = new Map<string, Map<string, number>>();
  for (const e of sources.by_engine) {
    const eng = providerLabel(e.engine);
    const m = byEngine.get(eng) ?? new Map<string, number>();
    for (const c of e.categories) m.set(label(c.category_key), (m.get(label(c.category_key)) ?? 0) + c.citations);
    byEngine.set(eng, m);
  }
  if (byEngine.size === 0) return null;
  return [...byEngine.entries()]
    .map(([engine, cats]) => ({
      engine,
      total: [...cats.values()].reduce((s, v) => s + v, 0),
      byCategory: Object.fromEntries(cats),
    }))
    .sort((a, b) => b.total - a.total);
}

/** C-2 types -> CitationTypeCategoryRow[] (five types in the legacy order, zero-filled). */
export function toTypeCategoryRows(sources: ApiSourcesData): CitationTypeCategoryRow[] {
  const label = categoryKeyLabels(sources);
  const byType = new Map(sources.types.map((t) => [t.type, t]));
  return MENTION_TYPES.map((type) => {
    const t = byType.get(type);
    const byCategory: Record<string, number> = {};
    for (const c of t?.categories ?? []) {
      if (c.citations <= 0) continue;
      const name = label(c.category_key);
      byCategory[name] = (byCategory[name] ?? 0) + c.citations;
    }
    return { type, total: t?.total ?? 0, byCategory };
  });
}

/** C-2 tone -> CitationToneSummary (same fields). */
export function toToneSummary(sources: ApiSourcesData): CitationToneSummary {
  const tile = (x: ApiSourcesData["tone"]["positive"]) => ({ urls: x.urls, citations: x.citations, answers: x.answers });
  return { positive: tile(sources.tone.positive), negative: tile(sources.tone.negative) };
}

const NO_VALUE_GAP: TrendGap = { reason: "no_value" };

/** Gap marker of an API point: collection_error / hidden (not_published) / no_answer, analysis_pending (no_value). */
export function citationPointGap(p: { gap?: boolean; gap_reason?: string | null } | undefined): TrendGap | undefined {
  if (!p?.gap && !p?.gap_reason) return undefined;
  if (p.gap_reason === "collection_error") return { reason: "collection_error" };
  if (p.gap_reason === "hidden") return { reason: "not_published" };
  return NO_VALUE_GAP;
}

/**
 * T-1 dimension=source|category -> WeeklyTrend. `seriesOrder` (category chart) keeps the given
 * series in that order and drops the others (legacy buildWeeklyTrend(entries, categories)).
 */
export function toCitationTrend(
  data: TrendResponse["data"],
  opts: { seriesOrder?: readonly string[] } = {},
): CitationTrend | null {
  const byName = new Map<string, TrendResponse["data"]["series"][number]>();
  for (const s of data.series) {
    const name = data.dimension === "category" ? (s.key ? LABEL_BY_SLUG.get(s.key) : null) ?? s.label ?? s.key : s.key;
    if (name && !byName.has(name)) byName.set(name, s);
  }
  const names = opts.seriesOrder ? opts.seriesOrder.filter((n) => byName.has(n)) : [...byName.keys()];
  if (names.length === 0) return null;
  const idx = names.map((n) => new Map(byName.get(n)!.points.map((p) => [p.bucket, p])));
  let valued = 0;
  const points: TrendGapRow[] = data.buckets.map((b) => {
    const row: TrendGapRow = { week: b.key };
    let gap: TrendGap | undefined;
    let any = false;
    names.forEach((n, i) => {
      const p = idx[i].get(b.key);
      gap ??= citationPointGap(p);
      if (p?.ratio && !p.gap) {
        any = true;
        row[n] = p.ratio.num;
      } else {
        row[n] = 0;
      }
    });
    if (gap || !any) {
      for (const n of names) row[n] = null;
      row.gap = gap ?? NO_VALUE_GAP;
    } else {
      valued += 1;
    }
    return row;
  });
  if (valued < 2) return null;
  return { series: names, points };
}

/** C-3 answer reference -> MentionAnswerLive (legacy citationAnswerRef). */
export function toPromptAnswer(a: ApiPromptAnswer): MentionAnswerLive {
  return {
    jobId: a.job_id,
    provider: providerLabel(a.provider),
    region: a.region ?? null,
    mentionCount: a.citations_in_answer,
    position: null,
    highlights: { brand: [], model: [] },
    measuredAt: null,
    runs: 1,
  };
}

/** C-3 PromptRow -> CitationPromptLive (split cards, the prompts sub page rows). */
export function toCitationPrompt(r: ApiPromptRow): CitationPromptLive {
  return {
    id: r.prompt_id,
    promptText: r.text ?? "",
    funnelStage: r.funnel ?? null,
    citations: r.citations,
    providers: r.providers.map(providerLabel),
    answers: r.answers.map(toPromptAnswer),
  };
}

/** C-3 answers (owned=true, optional owned=false) -> CitationsPromptSplit; owned 0 -> null. */
export function toPromptSplit(owned: ApiPromptsData, uncited?: ApiPromptsData | null): CitationsPromptSplit | null {
  if (owned.counts.owned === 0) return null;
  return {
    owned: owned.items.map(toCitationPrompt),
    uncited: (uncited?.items ?? []).map(toCitationPrompt),
    ownedCount: owned.counts.owned,
    uncitedCount: owned.counts.uncited,
  };
}

/** C-1 detail -> the row's URL list and prompt list (legacy foldCitationsLive shapes). */
export function toDomainDrilldown(d: ApiDomainDetail): { urls: CitationUrlLive[]; promptList: CitationPromptLive[] } {
  return {
    urls: d.urls
      .map((u) => ({
        url: u.url,
        title: u.title || displayCitationUrl(u.url),
        count: u.citations,
        aiProvider: u.engines.map(providerLabel).join(", "),
        promptText: u.prompt_text ?? "",
        country: geoEntryForUrl(u.url)?.country ?? null,
      }))
      // Legacy order: count desc, then the url (the backend breaks ties by url_hash).
      .sort((a, b) => b.count - a.count || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
    promptList: d.prompts
      .map((p) => ({
        id: p.prompt_id,
        promptText: p.text ?? "",
        funnelStage: p.funnel ?? null,
        citations: p.citations,
        ownedCitations: p.own_citations,
        providers: p.engines.map(providerLabel),
        answers: p.answers.map(toDetailAnswer),
      }))
      .sort((a, b) => b.citations - a.citations),
  };
}

function toDetailAnswer(a: ApiDetailAnswer): MentionAnswerLive {
  return {
    jobId: a.job_id,
    provider: providerLabel(a.engine ?? ""),
    region: a.country ?? null,
    mentionCount: a.citations,
    position: null,
    highlights: { brand: [], model: [] },
    measuredAt: null,
    runs: 1,
  };
}

/** The legacy empty shape (EMPTY_CITATIONS, scope-aggregates.ts:5524). */
export function emptyCitationsLive(): CitationsLive {
  return {
    summary: { total: 0, uniqueDomains: 0, officialOwnShare: null },
    asOf: null,
    domains: [],
    categories: null,
    trend: null,
    categoryTrend: null,
    engineCategories: null,
    promptSplit: null,
  };
}

export interface CitationsParts {
  domains: Enveloped<ApiDomainsData>;
  sources: Enveloped<ApiSourcesData>;
  sourceTrend: TrendResponse | null;
  categoryTrend: TrendResponse | null;
  /** owned=true answer (counts, top owned rows); null = failed (split null). */
  owned: Enveloped<ApiPromptsData> | null;
  /** owned=false answer (website/project cards); undefined = not requested. */
  uncited?: Enveloped<ApiPromptsData> | null;
}

/** The parts -> CitationsLive | null (see the header rules). */
export function toCitationsLive(p: CitationsParts): CitationsLive | null {
  if (wholeSuppression(p.domains.meta) !== null) return null;
  const d = p.domains.data;
  if (d.summary.total_citations <= 0) return emptyCitationsLive();
  const categories = toCategorySlices(p.sources.data);
  return {
    summary: {
      total: d.summary.total_citations,
      uniqueDomains: d.summary.unique_sources,
      officialOwnShare: mirrorPctOrNull(d.summary.own_share),
    },
    asOf: asOfDate(p.domains.meta),
    domains: d.items.map(toCitationDomain),
    categories,
    trend: p.sourceTrend ? toCitationTrend(p.sourceTrend.data) : null,
    categoryTrend:
      p.categoryTrend && categories
        ? toCitationTrend(p.categoryTrend.data, { seriesOrder: categories.map((c) => c.name) })
        : null,
    engineCategories: toEngineCategories(p.sources.data),
    promptSplit: p.owned ? toPromptSplit(p.owned.data, p.uncited?.data ?? null) : null,
  };
}

/** BG-20 competitor sources -> the legacy competitor option list (group keys, citations desc). */
export function competitorOptionsOf(d: ApiDomainsData): string[] {
  return (d.competitor_sources ?? [])
    .slice()
    .sort((a, b) => b.citations - a.citations || a.skey.localeCompare(b.skey))
    .map((s) => s.skey);
}

/** What the client table needs to read beyond the first page (BG-21 route, D5 cursor). */
export interface CitationTableSource {
  /** /api/citations/domains query: surface, projectId and the page's filter URL params. */
  query: string;
  nextCursor: string | null;
  total: number | null;
}

// ── fetchers ────────────────────────────────────────────────────────────────

export interface DomainsRequest {
  limit: number;
  cursor?: string | null;
  q?: string;
  sort?: DomainSort;
  dir?: "asc" | "desc";
  /** BG-20 ?competitor= picks (applyCompetitorPick on the backend). */
  competitor?: readonly string[];
  /** BG-20 skey[]: these rows only. */
  skey?: readonly string[];
  competitorSources?: boolean;
}

/** Backend cap of competitor[] and skey[] (DomainsQuery SKEY_MAX_ITEMS) and of one skey's length. */
export const PICKS_MAX = 100;
const SKEY_MAX_LEN = 512;

/**
 * ?competitor= picks / skey[] as the backend takes them: deduped, empty and over-long values
 * dropped, the first PICKS_MAX in the URL order kept (U7-N14; more would be a 422 on the essential
 * domains call and the whole screen would fail), then sorted (stable cache and dedupe keys).
 */
export const pickList = (xs: readonly string[] | undefined): string[] =>
  [...new Set(xs ?? [])]
    .filter((x) => x && x.length <= SKEY_MAX_LEN)
    .slice(0, PICKS_MAX)
    .sort();

/** Extra C-1 list parameters (only the ones set: default requests keep the default cursor hash). */
export type DomainsParams = {
  limit?: number;
  cursor?: string;
  q?: string;
  sort?: DomainSort;
  dir?: "asc" | "desc";
  competitor?: string[];
  skey?: string[];
  competitor_sources?: boolean;
};

export function domainsParams(req: Partial<DomainsRequest>): DomainsParams {
  const out: DomainsParams = {};
  if (req.limit !== undefined) out.limit = req.limit;
  if (req.cursor) out.cursor = req.cursor;
  const q = req.q?.trim();
  if (q) out.q = q;
  if (req.sort && req.sort !== "citations") out.sort = req.sort;
  if (req.dir) out.dir = req.dir;
  const competitor = pickList(req.competitor);
  if (competitor.length) out.competitor = competitor;
  const skey = pickList(req.skey);
  if (skey.length) out.skey = skey;
  if (req.competitorSources) out.competitor_sources = true;
  return out;
}

export async function fetchCitationDomains(
  filters: StandardFilters,
  ctx: CitationsContext,
  req: DomainsRequest,
): Promise<Enveloped<ApiDomainsData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/citations/domains", { query: withParams(query, domainsParams(req)), cf });
  return { data: res.data, meta: res.meta };
}

export async function fetchCitationSources(filters: StandardFilters, ctx: CitationsContext): Promise<Enveloped<ApiSourcesData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/citations/sources", { query, cf });
  return { data: res.data, meta: res.meta };
}

export async function fetchCitationPrompts(
  filters: StandardFilters,
  ctx: CitationsContext,
  req: { owned: boolean; limit: number; q?: string; cursor?: string | null },
): Promise<Enveloped<ApiPromptsData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const extra: { owned: boolean; limit: number; q?: string; cursor?: string } = { owned: req.owned, limit: req.limit };
  const q = req.q?.trim();
  if (q) extra.q = q;
  if (req.cursor) extra.cursor = req.cursor;
  const res = await hghGet("/v1/citations/prompts", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

export async function fetchCitationTone(
  filters: StandardFilters,
  ctx: CitationsContext,
  req: { tone: CitationTone; groupBy: "url" | "source"; limit: number; q?: string; cursor?: string | null; withCounts?: boolean },
): Promise<Enveloped<ApiToneData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const extra: { tone: CitationTone; group_by: "url" | "source"; limit: number; q?: string; cursor?: string; with_counts?: boolean } = {
    tone: req.tone,
    group_by: req.groupBy,
    limit: req.limit,
  };
  const q = req.q?.trim();
  if (q) extra.q = q;
  if (req.cursor) extra.cursor = req.cursor;
  if (req.withCounts) extra.with_counts = true;
  const res = await hghGet("/v1/citations/sources/tone", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

export async function fetchCitationTargets(filters: StandardFilters, ctx: CitationsContext): Promise<Enveloped<ApiTargetsData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/citations/targets", { query, cf });
  return { data: res.data, meta: res.meta };
}

export async function fetchDomainDetail(
  filters: StandardFilters,
  ctx: CitationsContext,
  skey: string,
): Promise<Enveloped<ApiDomainDetail>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/citations/domains/{skey}", { pathParams: { skey }, query, cf });
  return { data: res.data, meta: res.meta };
}

// The citation trends send measured_days=false (performance A1): toCitationTrend, prevCategoriesOf
// and shareDeltas read no measuredDays.
export function fetchSourceTrend(filters: StandardFilters, ctx: CitationsContext): Promise<TrendResponse> {
  return fetchTrend(filters, { ...ctx, bucket: "cycle", dimension: "source", top: SOURCE_TREND_TOP, measuredDays: false });
}
export function fetchCategoryTrend(filters: StandardFilters, ctx: CitationsContext): Promise<TrendResponse> {
  return fetchTrend(filters, { ...ctx, bucket: "cycle", dimension: "category", top: CATEGORY_TREND_TOP, measuredDays: false });
}
/**
 * The Overview card Δ input: citation_share plus visibility (its den = the bucket's answers; the
 * card rule skips a bucket without answers or with a mention-family gap, overviewTrendValues).
 */
export function fetchShareTrend(filters: StandardFilters, ctx: CitationsContext): Promise<TrendResponse> {
  return fetchTrend(filters, {
    ...ctx,
    bucket: "cycle",
    dimension: "none",
    metrics: ["visibility", "citation_share"],
    measuredDays: false,
  });
}

/** The main domains call of a screen (standard: competitor picks and the competitor sources). */
export function mainDomainsRequest(ctx: CitationsContext, competitor?: readonly string[]): DomainsRequest {
  return ctx.surface === "global"
    ? { limit: DOMAIN_PAGE, competitor: competitor ?? [], competitorSources: true }
    : { limit: DOMAIN_PAGE };
}

// ── D6: first render budget ─────────────────────────────────────────────────

/**
 * The calls a citation screen needs first: domains (pill, table, competitor options), sources
 * (status tiles, categories), the calendar, and on website the K-1 summary (website cards, DC-02
 * decision 6: url_prompts). Project:
 * the three (its options call runs before them to read the custom fields). The global K-1
 * summary that fed the measurement overview card left with the card (hmg-geo #305, sync S1
 * FA-3): nothing on the citation screens reads it. Settled, never rejected; one run per request.
 */
export function citationsEssentials(filters: StandardFilters, ctx: CitationsContext, competitor?: readonly string[]): Promise<void> {
  const key = stableKey(["u7-essentials", filters, ctx.surface, ctx.projectId ?? null, ctx.customFields ?? null, pickList(competitor)]);
  return dedupeInRequest(key, async () => {
    const calls: Promise<unknown>[] = [
      fetchCitationDomains(filters, ctx, mainDomainsRequest(ctx, competitor)),
      fetchCitationSources(filters, ctx),
      fetchFilterDates({ surface: ctx.surface, projectId: ctx.projectId, family: "citations" }),
    ];
    if (ctx.surface === "website" && targetsApplicable(filters)) calls.push(fetchKpiSummary(filters, ctx));
    await Promise.allSettled(calls);
  });
}

/** Run a second-stage call after the essentials settled (D6 option b). */
export async function afterCitationEssentials<T>(
  filters: StandardFilters,
  ctx: CitationsContext,
  run: () => Promise<T>,
  competitor?: readonly string[],
): Promise<T> {
  await citationsEssentials(filters, ctx, competitor);
  return run();
}

// ── loaders (drop-ins for the legacy fetchers) ─────────────────────────────

/** Legacy degrade labels of the citation aggregate per surface. */
export const CITATIONS_DEGRADE_LABEL: Readonly<Record<Surface, string>> = {
  global: "standardCitations",
  website: "websiteCitations",
  project: "projectCitations",
};

export interface CitationsView {
  live: CitationsLive | null;
  /** null when live is null (nothing to page). */
  table: Omit<CitationTableSource, "query"> | null;
  competitorOptions: string[];
}

/**
 * Drop-in for fetchStandard/Website/ProjectCitations (+ the page and competitor options of the
 * main domains call). competitor = the ?competitor= picks (standard only). Picks outside the
 * first page are read with skey[] and appended (the category tile sums them, legacy
 * applyCompetitorPickToCategories over every row).
 */
export function loadCitationsView(
  filters: StandardFilters,
  ctx: CitationsContext,
  competitor: readonly string[] = [],
): Promise<CitationsView> {
  const picks = ctx.surface === "global" ? pickList(competitor) : [];
  const key = stableKey(["u7-view", filters, ctx.surface, ctx.projectId ?? null, ctx.customFields ?? null, picks]);
  return dedupeInRequest(key, async () => {
    void citationsEssentials(filters, ctx, picks);
    const label = CITATIONS_DEGRADE_LABEL[ctx.surface];
    const later = <T>(run: () => Promise<T>) => afterCitationEssentials(filters, ctx, run, picks);
    const [core, sourceTrend, categoryTrend, owned, uncited, pickedRows] = await Promise.all([
      degradeOnApiFailure(label, () =>
        Promise.all([
          fetchCitationDomains(filters, ctx, mainDomainsRequest(ctx, picks)),
          fetchCitationSources(filters, ctx),
        ]),
      ),
      degradeOnApiFailure(`${label}.trend`, () => later(() => fetchSourceTrend(filters, ctx))),
      degradeOnApiFailure(`${label}.categoryTrend`, () => later(() => fetchCategoryTrend(filters, ctx))),
      degradeOnApiFailure(`${label}.split`, () =>
        later(() => fetchCitationPrompts(filters, ctx, { owned: true, limit: ctx.surface === "global" ? 1 : SPLIT_CARD_ROWS })),
      ),
      ctx.surface === "global"
        ? Promise.resolve(undefined)
        : degradeOnApiFailure(`${label}.split`, () =>
            later(() => fetchCitationPrompts(filters, ctx, { owned: false, limit: SPLIT_CARD_ROWS })),
          ),
      picks.length
        ? degradeOnApiFailure(`${label}.competitor`, () =>
            later(() => fetchCitationDomains(filters, ctx, { limit: DOMAIN_PAGE, skey: picks, competitor: picks })),
          )
        : Promise.resolve(null),
    ]);
    if (!core) return { live: null, table: null, competitorOptions: [] };
    const [domains, sources] = core;
    const live = toCitationsLive({ domains, sources, sourceTrend, categoryTrend, owned, uncited });
    if (live && pickedRows) {
      const have = new Set(live.domains.map((r) => r.domain));
      for (const r of pickedRows.data.items) if (!have.has(r.skey)) live.domains.push(toCitationDomain(r));
    }
    const page = pageInfo(domains.meta);
    return {
      live,
      table: live ? { nextCursor: page.nextCursor, total: page.total } : null,
      competitorOptions: competitorOptionsOf(domains.data),
    };
  });
}

/** Header pill / filter bar asOf: the domains call's round date (U7-N1). */
export async function loadCitationsAsOf(
  filters: StandardFilters,
  ctx: CitationsContext,
  competitor: readonly string[] = [],
): Promise<string | null> {
  return (await loadCitationsView(filters, ctx, competitor)).live?.asOf ?? null;
}

export interface CitationDeltas {
  officialDelta: OverviewCardDelta | null;
  prevCategories: { totals: CitationCategoryTotals; asOf: string } | null;
}

/** Share trend -> the Overview card Δ (the page reads no prev sub KPI since hmg-geo 783478c). */
export function shareDeltas(trend: TrendResponse | null): Pick<CitationDeltas, "officialDelta"> {
  if (!trend) return { officialDelta: null };
  return { officialDelta: overviewCardDelta(toStandardTrendBuckets(trend.data), "citationShare") };
}

/** Category trend -> the previous valued bucket's category totals (the legacy base since d175da4). */
export function prevCategoriesOf(trend: TrendResponse | null): CitationDeltas["prevCategories"] {
  if (!trend) return null;
  const data = trend.data;
  const valued: { key: string; byCategory: Record<string, number>; total: number }[] = [];
  for (const b of data.buckets) {
    const byCategory: Record<string, number> = {};
    let total: number | null = null;
    let any = false;
    for (const s of data.series) {
      const p = s.points.find((x) => x.bucket === b.key);
      if (!p || p.gap || !p.ratio) continue;
      any = true;
      const name = (s.key ? LABEL_BY_SLUG.get(s.key) : undefined) ?? s.label ?? s.key ?? "";
      byCategory[name] = (byCategory[name] ?? 0) + p.ratio.num;
      total = p.ratio.den;
    }
    if (any && total !== null && total > 0) valued.push({ key: b.key, byCategory, total });
  }
  if (valued.length < 2) return null;
  const prev = valued[valued.length - 2];
  return { totals: { total: prev.total, byCategory: prev.byCategory }, asOf: prev.key };
}

/** Standard status Δ sources: the share trend and the category trend (second stage). */
export async function loadCitationDeltas(
  filters: StandardFilters,
  ctx: CitationsContext,
  competitor?: readonly string[],
): Promise<CitationDeltas> {
  const [share, category] = await Promise.all([
    degradeOnApiFailure("citationShareDelta", () =>
      afterCitationEssentials(filters, ctx, () => fetchShareTrend(filters, ctx), competitor),
    ),
    degradeOnApiFailure("citationCategoriesPrev", () =>
      afterCitationEssentials(filters, ctx, () => fetchCategoryTrend(filters, ctx), competitor),
    ),
  ]);
  return { ...shareDeltas(share), prevCategories: prevCategoriesOf(category) };
}

/** Type composition and tone tiles from the same C-2 answer (null = degrade, legacy kpiDegrade). */
export async function loadCitationSourceParts(
  filters: StandardFilters,
  ctx: CitationsContext,
): Promise<{ typeCategories: CitationTypeCategoryRow[] | null; toneSummary: CitationToneSummary | null }> {
  const res = await degradeOnApiFailure("citationTypeCategories", () => fetchCitationSources(filters, ctx));
  if (!res) return { typeCategories: null, toneSummary: null };
  return { typeCategories: toTypeCategoryRows(res.data), toneSummary: toToneSummary(res.data) };
}

/**
 * Month comparison line (BG-05 citations_per_answer), second stage (D6). A 5xx / timeout drops
 * the line (null, degrade label "citationPeriodCompare") instead of failing the body.
 */
export function loadCitationPeriodCompare(
  filters: StandardFilters,
  ctx: CitationsContext,
  kind: Parameters<typeof fetchPeriodCompareApi>[1]["kind"],
  competitor?: readonly string[],
): Promise<CompareResult[] | null> {
  return degradeOnApiFailure("citationPeriodCompare", () =>
    afterCitationEssentials(
      filters,
      ctx,
      () => fetchPeriodCompareApi(filters, { ...ctx, kind, metrics: ["citationsPerAnswer"] }),
      competitor,
    ),
  );
}

// ── sub pages (C-3, C-2 tone; cursor pages, D5) ─────────────────────────────

/** A cursor page in the legacy page shape (+ the next cursor). */
export type CursorPageOf<P> = P & { nextCursor: string | null };

const isRestartable = (e: unknown) =>
  isHghApiError(e) && ((e.status === 409 && e.code === "cursor_stale") || (e.status === 422 && e.code === "cursor_invalid"));

/** One page for a URL cursor; a stale or foreign cursor reads the first page instead (page 1). */
async function pageOrFirst<T>(cursor: string | null, run: (c: string | null) => Promise<T>): Promise<{ res: T; restarted: boolean }> {
  try {
    return { res: await run(cursor), restarted: false };
  } catch (e) {
    if (cursor && isRestartable(e)) return { res: await run(null), restarted: true };
    throw e;
  }
}

export interface SubpageRequest {
  q: string;
  /** Page number carried with the cursor (display only). */
  page: number;
  cursor: string | null;
}

/**
 * Prompts sub page (owned / uncited). Tab counts come from the same answer (counts). null =
 * degrade (legacy kpiDegrade). total = meta.page.total (q applied) or the tab count without q.
 */
export async function loadOwnedPromptPage(
  filters: StandardFilters,
  ctx: CitationsContext,
  req: SubpageRequest & { owned: boolean },
): Promise<{ page: CursorPageOf<CitationOwnedPromptPage> | null; ownedCount: number | null; uncitedCount: number | null }> {
  const got = await degradeOnApiFailure("citationOwnedPrompts", () =>
    pageOrFirst(req.cursor, (cursor) =>
      fetchCitationPrompts(filters, ctx, { owned: req.owned, limit: SUBPAGE_SIZE, q: req.q, cursor }),
    ),
  );
  if (!got) return { page: null, ownedCount: null, uncitedCount: null };
  const { res, restarted } = got;
  const info = pageInfo(res.meta);
  const tabCount = req.owned ? res.data.counts.owned : res.data.counts.uncited;
  return {
    page: {
      rows: res.data.items.map((r) => {
        const p = toCitationPrompt(r);
        return { id: p.id, promptText: p.promptText, funnelStage: p.funnelStage, citations: p.citations, providers: p.providers, answers: p.answers };
      }),
      total: info.total ?? (req.q.trim() ? res.data.items.length : tabCount),
      page: restarted ? 1 : req.page,
      pageSize: info.limit ?? SUBPAGE_SIZE,
      nextCursor: info.nextCursor,
    },
    // Legacy tab counts came from promptSplit, which is null when no prompt has an own citation.
    ownedCount: res.data.counts.owned === 0 ? null : res.data.counts.owned,
    uncitedCount: res.data.counts.owned === 0 ? null : res.data.counts.uncited,
  };
}

/** C-2 ToneRow -> the legacy tone row. */
export function toToneUrlRow(r: ApiToneRow, groupBy: "url" | "source"): CitationToneUrlPage["rows"][number] {
  return {
    url: groupBy === "url" ? (r.url ?? null) : null,
    domain: r.skey,
    title: r.title ?? null,
    promptText: r.prompt_text ?? null,
    citations: r.citations,
    providers: r.engines.map(providerLabel),
    category: categoryLabelOf(r.category) ?? "Other",
  };
}

/** Tone sub page (with_counts: the two tab counts in the same answer, BG-27). null = degrade. */
export async function loadToneUrlPage(
  filters: StandardFilters,
  ctx: CitationsContext,
  req: SubpageRequest & { tone: CitationTone; byDomain: boolean },
): Promise<{ page: CursorPageOf<CitationToneUrlPage> | null; counts: { positive: number | null; negative: number | null } }> {
  const groupBy = req.byDomain ? "source" : "url";
  const got = await degradeOnApiFailure("citationToneUrls", () =>
    pageOrFirst(req.cursor, (cursor) =>
      fetchCitationTone(filters, ctx, { tone: req.tone, groupBy, limit: SUBPAGE_SIZE, q: req.q, cursor, withCounts: true }),
    ),
  );
  if (!got) return { page: null, counts: { positive: null, negative: null } };
  const { res, restarted } = got;
  const info = pageInfo(res.meta);
  return {
    page: {
      rows: res.data.items.map((r) => toToneUrlRow(r, groupBy)),
      total: info.total ?? res.data.items.length,
      page: restarted ? 1 : req.page,
      pageSize: info.limit ?? SUBPAGE_SIZE,
      nextCursor: info.nextCursor,
    },
    counts: { positive: res.data.counts?.positive ?? null, negative: res.data.counts?.negative ?? null },
  };
}

// ── website target / owned URL cards (C-4) ──────────────────────────────────

export interface TargetHitRateView {
  hitPrompts: number;
  ownedPrompts: number;
  measuredPrompts: number;
  rate: number | null;
  ownedRate: number | null;
  source?: "published" | "live";
  publication?: { cycleLabel: string | null; cycleLabelEn: string | null; roundDate: string; siteCount: number };
  /**
   * Set only by the C-4 converter (toTargetHitRate): its rates count measurements (A2), and the
   * card then reads the measurement definition text (messages/units/u7). Absent on the legacy
   * object and on the K-1 url_prompts view the page reads now (prompt unit, DC-02 decision 6).
   */
  unit?: "measurement";
}

/** Legacy page rule: a source category filter leaves both rates empty (no call). */
export function targetsApplicable(filters: Pick<StandardFilters, "sourceCategory">): boolean {
  return !filters.sourceCategory?.length;
}

/**
 * The empty card (legacy EMPTY_WEBSITE_PROMPT_HIT_RATES values, no source). Prompt unit like the
 * filled card (K-1 url_prompts, DC-02 decision 6): its tooltip reads the same legacy definition
 * (U7 verification D6: the empty and the filled card never differ in wording).
 */
export function emptyTargetHitRate(): TargetHitRateView {
  return { hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null };
}

interface TargetsSource {
  origin?: string;
  publications?: { cycle_label?: string | null; cycle_label_en?: string | null; round_date?: string; site_count?: number }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct1 = (r: Ratio | null | undefined): number | null => (r && r.den > 0 ? round1((100 * r.num) / r.den) : null);

/** C-4 -> the card props (legacy WebsitePromptHitRates; DC-02 measurement unit). */
export function toTargetHitRate(res: Enveloped<ApiTargetsData>): TargetHitRateView {
  const d = res.data;
  const out: TargetHitRateView = {
    hitPrompts: d.target?.num ?? 0,
    ownedPrompts: d.owned?.num ?? 0,
    measuredPrompts: d.measured,
    rate: pct1(d.target),
    ownedRate: pct1(d.owned),
    unit: "measurement",
  };
  const src = res.meta.source as TargetsSource | null | undefined;
  if (src?.origin === "report") {
    out.source = "published";
    const pubs = src.publications ?? [];
    const first = pubs[0];
    out.publication = {
      cycleLabel: first?.cycle_label ?? null,
      cycleLabelEn: first?.cycle_label_en ?? null,
      roundDate: first?.round_date ?? asOfDate(res.meta) ?? "",
      siteCount: pubs.reduce((s, p) => s + (p.site_count ?? 0), 0),
    };
  } else if (src?.origin === "live") {
    out.source = "live";
  }
  return out;
}

/**
 * K-1 -> the card props (legacy WebsitePromptHitRates, DC-02 decision 6): prompt counts and rates
 * from url_prompts (summary.ts urlPromptRates, legacy rounding per source), the published label
 * from meta.source (BG-26: first publication detail, round_date, site_count = the legacy
 * publishedSubtotal.siteCount). url_prompts null (meta.suppressed url_prompts) -> the empty values.
 */
export function toTargetHitRateFromSummary(res: SummaryResponse): TargetHitRateView {
  const out: TargetHitRateView = { ...urlPromptRates(res.data, res.meta) };
  const prov = provenanceOf(res.meta);
  if (prov?.source === "published") {
    out.source = "published";
    out.publication = {
      cycleLabel: prov.cycleLabel ?? null,
      cycleLabelEn: prov.cycleLabelEn ?? null,
      roundDate: prov.roundDate ?? asOfDate(res.meta) ?? "",
      siteCount: prov.siteCount ?? 0,
    };
  } else if (prov?.source === "live") {
    out.source = "live";
  }
  return out;
}

/** Website cards: K-1 url_prompts, or the empty card under a source category filter (legacy page rule). */
export async function loadTargetHitRate(filters: StandardFilters, ctx: CitationsContext): Promise<TargetHitRateView> {
  if (!targetsApplicable(filters)) return emptyTargetHitRate();
  return toTargetHitRateFromSummary(await fetchKpiSummary(filters, ctx));
}

// ── BFF routes (/api/citations/domains, /[skey], /export) ────────────────────

/** Screen and route source: HGH_SOURCE_<group of (analysis, surface)> (G2 global, G3 website, G6 project). */
export function isCitationsApi(surface: Surface, env?: Record<string, string | undefined>): boolean {
  return isAnalysisApi("analysis", surface, env);
}

export interface CitationRouteUser {
  id: string;
  role: Role;
  scope: AllowedScope | null;
  menuGroups?: readonly MenuGroup[] | null;
}

export type LegacyProjectAllowed = (projectId: string, user: CitationRouteUser) => Promise<boolean>;
export type RouteGate = { ok: true } | { ok: false; status: 403 | 404 };

/**
 * The route gate, applied before any read on BOTH sources (U4 F1): the (dash) place gate of the
 * screen family (canReadAnalysis, 403), then on project the project page gate (demo project admin
 * only; HGH_SOURCE_SESSION=api -> GET /v1/projects/{id}, legacy -> the injected repository check;
 * 404). A 401 or 5xx of the api project gate is thrown.
 */
export async function citationRouteGate(
  user: CitationRouteUser,
  surface: Surface,
  projectId: string | undefined,
  legacyProjectAllowed: LegacyProjectAllowed,
): Promise<RouteGate> {
  if (!canReadAnalysis(user, "analysis", surface)) return { ok: false, status: 403 };
  if (surface === "project") {
    const id = projectId ?? "";
    if (!isProjectId(id)) return { ok: false, status: 404 };
    if (isDemoProject(id) && user.role !== "admin") return { ok: false, status: 404 };
    if (hghSource("SESSION") === "api") {
      try {
        return (await fetchProjectGate(id)) ? { ok: true } : { ok: false, status: 404 };
      } catch (e) {
        if (isHghApiError(e) && e.status === 403) {
          return { ok: false, status: errorKindOf(e.status, e.code) === "forbidden" ? 403 : 404 };
        }
        throw e;
      }
    }
    if (!(await legacyProjectAllowed(id, user))) return { ok: false, status: 404 };
  }
  return { ok: true };
}

// ── route context: the same filters the page read ────────────────────────────

/** Website citation screen axes (website/answer-analysis/citation/page.tsx WEBSITE_ONLY_GROUPS). */
export const WEBSITE_CITATION_GROUPS: readonly DimensionGroup[] = ["geography", "language", "engine", "time", "source"];

/** URL keys that are sub page or table state, never filters (dropped from the route query). */
const NON_FILTER_KEYS: ReadonlySet<string> = new Set([
  "tab", "tone", "q", "page", "by", "cursor", "sort", "dir", "limit", "locale", "surface", "projectId",
]);

type SearchParamsRecord = Record<string, string | string[] | undefined>;

/**
 * The query the page hands its client table and drilldown (they append q / sort / cursor / skey):
 * the page's own filter params (sub page state removed; on project only the active custom
 * fields' cf_ params, as readProjectCustomFieldFilters) plus surface=website or projectId.
 */
export function citationRouteQuery(
  sp: SearchParamsRecord,
  target: { surface: Surface; projectId?: string; customFieldIds?: readonly string[] },
): string {
  const out = new URLSearchParams();
  const activeCf = new Set((target.customFieldIds ?? []).map((id) => `cf_${id}`));
  for (const key of Object.keys(sp).sort()) {
    if (NON_FILTER_KEYS.has(key)) continue;
    if (key.startsWith("cf_") && (target.surface !== "project" || !activeCf.has(key))) continue;
    const v = sp[key];
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(key, one);
  }
  if (target.surface === "website") out.set("surface", "website");
  if (target.surface === "project" && target.projectId) out.set("projectId", target.projectId);
  return out.toString();
}

export interface CitationRouteTarget {
  surface: Surface;
  projectId?: string;
}

/** surface / projectId of a route request: projectId (uuid) -> project, surface=website -> website, else global. */
export function citationRouteTarget(q: URLSearchParams): CitationRouteTarget | null {
  const projectId = q.get("projectId");
  if (projectId !== null) return isProjectId(projectId) ? { surface: "project", projectId } : null;
  return { surface: q.get("surface") === "website" ? "website" : "global" };
}

/**
 * The page's filter object and API context for a route request (each screen's page reads the
 * same URL the same way): global readStandardFilters(sp, scope); website with the website axes
 * (+ brand for admin) and region moved to websiteCountry; project without scope and with the
 * cf_ params (the page only forwarded the active fields'). All with cumulative (answer analysis).
 */
export function citationRouteFilters(
  q: URLSearchParams,
  target: CitationRouteTarget,
  user: Pick<CitationRouteUser, "role" | "scope">,
): { filters: StandardFilters; ctx: CitationsContext; competitor: string[] } {
  const sp: SearchParamsRecord = {};
  for (const key of new Set(q.keys())) {
    const all = q.getAll(key);
    sp[key] = all.length > 1 ? all : all[0];
  }
  const scope = user.scope ?? undefined;
  if (target.surface === "project") {
    const customFields = readProjectCustomFieldFiltersRaw(sp);
    return {
      filters: { ...readStandardFilters(sp), customFieldFilters: customFields, cumulative: true },
      ctx: { surface: "project", projectId: target.projectId, scope: null, customFields },
      competitor: [],
    };
  }
  if (target.surface === "website") {
    const groups: DimensionGroup[] = [...WEBSITE_CITATION_GROUPS, ...(user.role === "admin" ? (["brand"] as DimensionGroup[]) : [])];
    const raw = readStandardFilters(sp, scope, groups);
    return {
      filters: { ...raw, websiteCountry: raw.region, region: undefined, cumulative: true },
      ctx: { surface: "website", scope: user.scope ?? null },
      competitor: [],
    };
  }
  return {
    filters: { ...readStandardFilters(sp, scope), cumulative: true },
    ctx: { surface: "global", scope: user.scope ?? null },
    competitor: splitFilterValues(sp.competitor),
  };
}

/** base64url of a UTF-8 string (skey in a path segment: "/" of social keys never reaches the router). */
export function encodeSkey(skey: string): string {
  return Buffer.from(skey, "utf8").toString("base64url");
}
export function decodeSkey(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(segment)) return null;
  const s = Buffer.from(segment, "base64url").toString("utf8");
  return s && encodeSkey(s) === segment && !/[\x00-\x1f\x7f]/.test(s) ? s : null;
}

/** C-1 detail for an opened row (route /api/citations/domains/[skey]). */
export async function loadDomainDrilldown(
  filters: StandardFilters,
  ctx: CitationsContext,
  skey: string,
): Promise<{ urls: CitationUrlLive[]; promptList: CitationPromptLive[] }> {
  return toDomainDrilldown((await fetchDomainDetail(filters, ctx, skey)).data);
}

export interface DomainListPage {
  rows: RankedCitationDomain[];
  nextCursor: string | null;
  total: number | null;
}

/** C-1 list page for the client table (route /api/citations/domains). */
export async function listCitationDomains(
  filters: StandardFilters,
  ctx: CitationsContext,
  req: DomainsRequest,
): Promise<DomainListPage> {
  const res = await fetchCitationDomains(filters, ctx, req);
  const info = pageInfo(res.meta);
  return { rows: res.data.items.map(toCitationDomain), nextCursor: info.nextCursor, total: info.total };
}

/** BG-22 export stream (route /api/citations/domains/export). */
export function relayDomainsExport(
  filters: StandardFilters,
  ctx: CitationsContext,
  req: Omit<DomainsRequest, "limit" | "cursor" | "competitorSources"> & {
    locale: "ko" | "en";
    format?: "xlsx" | "csv";
    maxRows?: number;
  },
): Promise<Response> {
  const { query, cf } = analysisQuery(filters, ctx);
  const { limit: _limit, ...list } = domainsParams(req);
  const extra: Omit<DomainsParams, "limit" | "cursor" | "competitor_sources"> & {
    locale: "ko" | "en";
    format: "xlsx" | "csv";
    max_rows?: number;
  } = { ...list, locale: req.locale, format: req.format ?? "xlsx" };
  if (req.maxRows) extra.max_rows = req.maxRows;
  return relayDownload("/v1/citations/domains/export", { query: withParams(query, extra), cf });
}
