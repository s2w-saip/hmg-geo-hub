import "server-only";

// Dashboard adapter (unit U5): the three dashboards (/dashboard, /website, /projects/[id]) on
// the backend API, in the shapes their legacy view-models already produce. Design 3.3
// "대시보드", appendix A (/dashboard, /website, /projects/[id]), 3.5 #1 #2, decisions D5 D6 D8
// D13. The screens branch per request on isAnalysisApi("dashboard", surface) (D8: global G1,
// website G3, project G6, default legacy) and keep calling the legacy functions otherwise.
//
// Calls (one function per endpoint shape; D6 essentials reuse them, so the in-request GET
// dedupe of lib/hgh/client folds a repeated call into one request):
//   summary     GET /v1/kpi/summary            (project: by_funnel=true, BG-08 topics); parts=urls
//                                              (DASHBOARD_SUMMARY_PARTS, B089): the cards never read
//                                              measured/applied prompts or the analysis gap
//   brands      GET /v1/mentions/brands        top_n=20 sort=mentions include=hmg (BG-15);
//                                              project with a designated target: full=true + q=<target>
//                                              (BG-19, the target row only). Website and project:
//                                              include_sentiment=false (KPI #16 reads mentions only);
//                                              global keeps the sentiment (③ competitor minis read it)
//   conversion  GET /v1/funnel/conversion      ⑦ GA4 directly (design 4.2): project home only
//                                              (property_source=market, summary_only=true B096). The
//                                              global dashboard no longer calls it (2026-10-14): Overview
//                                              renders the five OVERVIEW_KPI_KEYS only, so ⑦ was fetched
//                                              but never shown
//   trend       GET /v1/trend                  U4 fetchTrend (cycle for Δ, week for charts)
//   brandTrend  GET /v1/trend dimension=brand  visibility, share_of_voice, position; the candidate
//                                              brand keys (BG-11) with the minimum top (the card reads
//                                              the candidates' Δ only), split_own (D13)
//   domains     GET /v1/citations/domains      limit=0 + competitor_sources (BG-20, competitor
//                                              row) or limit=7 (composition); include_den=false and
//                                              include_competitor_totals=false (B011: neither reads
//                                              the coverage denominator or the competitor sums)
//   engines     GET /v1/kpi/engines            parts=sov+citation (B090): the badge columns only
//   geo         GET /v1/geo                    GEO section (website: not called when the perspective
//                                              has no single active brand, see website/_data/live.ts)
//   dates       GET /v1/filters/dates family=all, options GET /v1/filters/options (U4)
//   project     GET /v1/projects/{id} (the U2 gate call, shared), .../settings?view=card,
//               .../prompt-candidates?limit=5&include_total=false
//
// D6 (first render = 3-4 calls). essentialsGate() starts (or joins) the surface's essential
// calls and waits for all of them to settle; every other section loader waits on it before
// issuing its own call. The gate and the calls are kept per request, failures included, so a
// section that starts later never re-sends a failed essential call (U5 verification D3); the
// shell calendar reads the kept dates call (loadEssentialFilterDates), the project tiles
// (loadProjectOverview) the kept project and candidates calls, the competitor rows
// (loadCompetitorSources) the kept brands call (U5 N2). Nothing else changes in the screens:
// only the streaming order.
//   global   summary, brands, dates                 (header pill, cards, filter calendar)
//   website  summary, brands, dates, options        (cards, filter bar)
//   project  project detail, recent candidates, dates, options (tiles, panels, filter bar: the page
//            shell); the KPI section (summary first) streams after them
//
// Shape rules (hand-checked in dashboard.test.ts, legacy parity in dashboard.parity.test.ts):
//   ①~⑤ cards        U4 toMirrorKpis; KPI #16 U4 applyCompetitorSovFromBrands (HMG siblings by
//                    is_hmg_own, never by name)
//   ⑦ conversion     (project home) total_markets 0 -> value null; 1 -> pct(ai.conv) with
//                    sessions > 0 (else null), ratio {conversions, sessions}, sparkline =
//                    trend[].ai_sessions; > 1 -> pct(ai.conv) (0 when no sessions, legacy rollup),
//                    ratio, coverage
//   competitor rows  BrandItem -> CompetitorBrandValue {name, mentions, pct(share), pct(exposure),
//                    rankAvg(avg_rank), is_own || is_hmg_own, sentiment, brand_key}; citation row
//                    from competitor_sources as official-competitor domain rows (share = pct of
//                    all citations) so the card keeps folding domains to brands (no component
//                    change, 3.5 #1 resolved by BG-20)
//   GEO              markets tree -> GeoRegionRow (pct / mirror pct / rankAvg), country display
//                    name geoLocateByCode (locale free, as legacy), ourLabel = own_label
//   composition      top 7 domains + "기타" (total - top citations), topics from measured_by_funnel
//   engines          EngineItem -> SubKpiEngineRow (avgPosition = rank_sum / ranked), then the
//                    legacy applyEngineConsistency
//   project tiles    ProjectDetail counts (BG-38) + first candidate page (created_at desc)
//
// WU-3 card path (card=true, lib/hgh/query.ts cardParam; global and website only, never project).
// Sent on the calls whose legacy reader (hmg-geo 2670a16 + read_screens 14 keys) was the summary
// tables, so the backend can apply the legacy card definitions (card_slot_rep, summary_all_engines):
//   summary     global S1.dashboard viaGlobalS1 (lib/scope/server.ts:2101-2122, period route
//               :1904-1907, slot restriction :1945-1958); website S4.dashboard viaTrend (:5165-5176,
//               period route :5117-5119, slot restriction :5124)
//   brands      global KPI #16 = the same S1 read (:2120 aggregates.brands) and the competitor rows
//               S1.competitors viaGlobalS1 (:4124-4150); website KPI #16 = the S4 card read (:5165)
//   trend       global S1.dashboard viaGlobalSeries (:2170, :2972-3041); website websiteTrendSet (:5186-5212)
//   brandTrend  global S1.competitors viaGlobalSeries (:3552-3570, the on branch :3671-3718)
//   geo         global S1.dashboard viaGlobalS1 (:4359-4373); website S4.dashboard viaTrend (:5284-5294)
//   engines     website badge S4.subkpi viaTrend (:5228-5250, website/_data/live.ts:335). Not global:
//               the global badge was S2.mention (:2212), not in the 14 keys = mirror
//   domains     no period only: global competitor citation row S3.citation viaGlobalTrend (:4332-4347)
//               and website composition S6.citation viaTrend (:5274-5282) read the summary tables on a
//               snapshot; neither screen key is in PERIOD_ROUTE_BY_SCREEN (period-route-flag.ts:70-74),
//               so with a period the snapshot gate (cycle-set.ts:282-294) sent them to the mirror
//   compare     every screen (compare.ts header)
// Not sent: the answer-analysis tabs (summary.ts fetchKpiSummary from kpi-tab.ts / citations.ts,
// trend.ts fetchTrend from mentions.ts / citations.ts / kpi-tab.ts), the filters and project calls.
// Known differences. Design DC list (front-adapter-plan 3.6 (나)) as they reach these screens:
//   DC-01 engine[] empty = default engine only (SQL-checked in dashboard.pglite.parity.test.ts); with the
//         legacy profile switch summary_all_engines on, the card-path calls above read every engine;
//   DC-02 resolved by decision 6: the website URL-rate cards are per prompt (url_prompts) with the
//   legacy wording (no copyVariant); DC-03 ⑦ denominator sessions, window = 28 days to the latest
//   loaded GA4 date (BG-30 days). DC-03 wording: that api card carries copyVariant "api" and the
//   tile reads dashboard.kpi.api.* (messages/units/u5: "AI 채널 세션"); legacy cards keep the
//   legacy keys (messages are global, so no key is overwritten);
//   DC-04 admin brand[] changes "own"; DC-05 card Δ = previous round (bucket=cycle); DC-06/07/22
//   options and calendar (U4); DC-08 trend series; DC-16 period compare (DC-21 position resolved upstream, 6bc5c54);
//   DC-23 project ⑥ owned-base judgement: the legacy rule (one effective owned base) is the backend
//   profile project_accuracy_single_base; the project ⑥ card and trend line read that value (#13).
// Outside the DC list (U5 numbering, asserted in dashboard.parity.test.ts KNOWN_DIFF):
//   U5-N1 GEO "our" label = backend own_label: an account scoped to several brands reads "HMG"
//         (legacy joined the brand names, "Hyundai, Kia"); admin with one brand chosen reads that
//         brand (legacy "HMG" while the values were narrowed by DC-04 anyway)
//   U5-N2 composition "기타" share = pct(rest citations, all citations); legacy summed the rounded
//         shares of the rest rows (differs by rounding only)
//   U5-N3 global card sparkline comes from the same bucket=cycle trend as the Δ (design: one
//         call). Weekly rounds give the same points; two rounds in one week show two points
//   U5-N4 project ⑦ with a URL country other than the project's: no tile (the backend market is
//         the project's own); legacy looked up the GA4 property of the chosen country
//   U5-N5 project tiles "last AI call" = ProjectDetail.last_run_at (same definition, backend
//         clock); recent candidates come from the first page (created_at desc), same order
//   U5-N6 failure paths only: a transient failure (5xx, timeout) of a secondary read (brand rows
//         for KPI #16, GA4 ⑦, engine badge, composition, GEO) empties that part and keeps the
//         cards; the legacy readers failed the whole section (or, for GA4, also returned null).
//         Website: the engine badge, composition and GEO reads degrade exactly as the legacy
//         degradeAware readers did (same labels websiteSubKpis / websiteSourceComposition /
//         websiteGeoCompetition, same empty shapes); 4xx is raised on every surface.
//         B027: a section that would vanish (global and website GEO, website composition, project
//         composition and ⑦) records a degrade label (global GEO the legacy standardGeoCompetition,
//         project projectComposition / projectTrafficConversion) and the page draws the existing
//         DegradeNotice (kpi.degraded) in its place on the api source; inline parts (badge, Δ,
//         KPI #16, as-of chip) stay silent (no existing notice pattern, UC-16)
//   U5-N7 website composition topics = [] (the website panel never draws topics, showTopics=false;
//         the legacy reader computed and discarded them); project topics come from BG-08
import { cache } from "react";
import type { AllowedScope } from "@/lib/auth/types";
import { stableKey } from "@/lib/request-dedupe";
import type { StandardFilters, CompetitorBrandValue, CitationDomainLive } from "@/lib/scope/result-adapter";
import type { BucketUnit, StandardSubKpis, SubKpiEngineRow } from "@/lib/db/repositories/scope-aggregates";
import type { KpiSummary } from "@/app/[locale]/(dash)/dashboard/_data/sample";
import type {
  GeoCountryRow,
  GeoRegionRow,
  LiveComposition,
  LiveDashboard,
  LiveGeo,
  LiveSourceSlice,
  LiveTopicSlice,
  MarketCompetition,
} from "@/app/[locale]/(dash)/dashboard/_data/live";
import type { GeoMetrics } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import type { OverviewCompetitorSources } from "@/app/[locale]/(dash)/dashboard/_components/overview-kpi-cards";
import type { PromptCandidateRow, PromptRow } from "@/lib/db/schema";
import { geoLocateByCode } from "@/lib/geo-catalog";
import { competitorDeltaBrands } from "@/lib/scope/competitor-row";
import { OFFICIAL_COMPETITOR_CATEGORY } from "@/lib/citation-categorizer/taxonomy";
import type { components } from "../api-types";
import { hghGet } from "../client";
import { isHghApiError } from "../errors";
import { asOfDate, pct1OrZero, rankAvg, type ApiMeta, type Ratio } from "../convert";
import { cardParam, withParams, type Surface } from "../query";
import {
  analysisQuery,
  fetchFilterDates,
  fetchFilterOptions,
  toFilterDatesView,
  type AnalysisQueryContext,
  type FilterDatesView,
} from "./filters";
import {
  DASHBOARD_SUMMARY_PARTS,
  applyCompetitorSovFromBrands,
  fetchKpiSummary,
  summaryIsEmpty,
  toMirrorKpis,
  toUrlRateKpis,
  type SummaryResponse,
} from "./summary";
import {
  OVERVIEW_TREND_METRICS,
  fetchTrend,
  toBrandTrendResult,
  toFirstPositionResult,
  toLiveTrend,
  type ApiLiveTrend,
  type TrendBucketName,
  type TrendMetric,
} from "./trend";

type S = components["schemas"];
export type ApiBrandsData = S["BrandsData"];
export type ApiBrandItem = S["BrandItem"];
export type ApiConversionData = S["ConversionData"];
export type ApiDomainsData = S["DomainsData"];
export type ApiEnginesData = S["EnginesData"];
export type ApiEngineItem = S["EngineItem"];
export type ApiGeoData = S["GeoData"];
export type ApiGeoMetrics = S["GeoMetrics"];
export type ApiProjectDetail = S["ProjectDetail"];
export type ApiSettingsBundle = S["SettingsBundle"];
export type ApiCandidateItem = S["app__features__projects__prompts__candidates__schemas__CandidateItem"];

/** A dashboard read: the surface, the project on surface=project, the session scope (never sent). */
export type DashboardCtx = AnalysisQueryContext;

interface Envelope<T> {
  data: T;
  meta: ApiMeta;
}

// ── calls ────────────────────────────────────────────────────────────────────

/** Card competitor pool: 20 competitors by mentions (4 cards x 4 candidates, HMG siblings dropped later). */
export const CARD_BRANDS_TOP_N = 20;
/** Legacy SOURCE_TOP_N (dashboard/_data/live.ts:769, website/_data/live.ts:53). */
export const SOURCE_TOP_N = 7;
/** Legacy GA4 KPI window (lib/ga4/conversion.ts: 28daysAgo..today). */
export const CONVERSION_DAYS = 28;
/**
 * Competitor Δ trend top (B031). The card reads the Δ of the candidate brands only
 * (competitorDeltaBrands: the three Δ cards' top 4), and those are requested by brand_key
 * (BG-11: added beyond top), so top is the backend minimum (was 20, appendix A). The candidates'
 * series and their last two values are the same either way (lastTwoDelta skips the null slots).
 */
export const BRAND_TREND_TOP = 1;
/**
 * Website overview trend metrics (B032): ①~⑤ and the live ⑥ citation_accuracy series (WU-9).
 * M06/M07 (target / owned URL rate) are left out: no website reader draws them (the chart series,
 * the card Δ and ⑥ read M01..M05 and ACC; urlRateOrigin has no consumer), and with ACC present ⑥
 * never reads their numerators (toLiveTrend). The backend then skips url_rates and the report
 * statement. The project trend (PROJECT_TREND_METRICS) still requests M06/M07 next to ACC (#13).
 */
export const WEBSITE_OVERVIEW_TREND_METRICS: readonly TrendMetric[] = [...OVERVIEW_TREND_METRICS, "citation_accuracy"];

/** Summary of a dashboard (project: with the funnel topic counts, one call for pill and cards). */
export function fetchDashboardSummary(filters: StandardFilters, ctx: DashboardCtx): Promise<SummaryResponse> {
  return fetchKpiSummary(filters, {
    ...ctx,
    card: true,
    parts: DASHBOARD_SUMMARY_PARTS,
    ...(ctx.surface === "project" ? { byFunnel: true } : {}),
  });
}

/** BG-19 q (brands schemas: 1..100 characters, no control characters); out of bounds = not sent. */
function targetNameQuery(name: string): { q?: string } {
  return name.length >= 1 && name.length <= 100 && !/[\x00-\x1f\x7f]/.test(name) ? { q: name } : {};
}

/**
 * Brand rows for KPI #16 and the competitor minis. `designatedTarget` (project) reads the
 * competitor rows whose name contains it (full=true + q, BG-19: case-insensitive part match, own
 * rows always kept): applyCompetitorSovFromBrands picks the exact name among them, as it did among
 * every row. include_sentiment=false on website and project: they read the mentions of the
 * competitor rows only (KPI #16). The global rows also feed the ③ competitor minis
 * (competitorValueOf "sentiment"), so the global call keeps the default.
 */
export async function fetchCardBrands(
  filters: StandardFilters,
  ctx: DashboardCtx,
  designatedTarget?: string | null,
): Promise<Envelope<ApiBrandsData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const sentiment = ctx.surface === "global" ? {} : { include_sentiment: false };
  const extra = designatedTarget
    ? { full: true, sort: "mentions" as const, include: ["hmg" as const], ...targetNameQuery(designatedTarget), ...sentiment }
    : { top_n: CARD_BRANDS_TOP_N, sort: "mentions" as const, include: ["hmg" as const], ...cardParam(ctx.surface, true), ...sentiment };
  const res = await hghGet("/v1/mentions/brands", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

/**
 * ⑦ GET /v1/funnel/conversion (design 4.2: the dashboard adapter calls it directly). Only the
 * market axes the legacy tile used are sent (global: URL brand and country; project: country),
 * no period (the tile had its own window) and no engine (the legacy tile ignored it).
 * include_pages=false: the tile reads summary, coverage and trend only (toTrafficConversionKpi),
 * so the backend skips the per-page aggregation (a backend without the flag ignores it).
 * Project: summary_only=true (B096) as well: the home tile reads the AI conversion rate and its
 * numerator / denominator only (no sparkline, getProjectDashboardApi), so the backend also skips
 * the trend and engine comparison statements (trend / by_engine [] and by_country null).
 */
export async function fetchTrafficConversion(
  filters: StandardFilters,
  ctx: DashboardCtx,
): Promise<Envelope<ApiConversionData>> {
  const marketOnly: StandardFilters = ctx.surface === "project" ? { region: filters.region } : { brand: filters.brand, region: filters.region };
  const { query } = analysisQuery(marketOnly, { surface: ctx.surface, projectId: ctx.projectId, scope: ctx.scope });
  const extra =
    ctx.surface === "project"
      ? { days: CONVERSION_DAYS, property_source: "market" as const, include_pages: false, summary_only: true }
      : { days: CONVERSION_DAYS, include_pages: false };
  const res = await hghGet("/v1/funnel/conversion", { query: withParams(query, extra) });
  return { data: res.data, meta: res.meta };
}

export interface DomainsCall {
  limit: number;
  competitorSources?: boolean;
}

/**
 * card=true on a domains call only without a period (see the header "WU-3 card path"): the legacy
 * readers (S3.citation / S6.citation) never took the period route, so a period read was the
 * mirror (the window's rounds are not all the latest one: range-outside-cycle / range-multi-cycle).
 */
const domainsCard = (query: { from?: string; to?: string }): boolean => !query.from && !query.to;

export async function fetchDashboardDomains(
  filters: StandardFilters,
  ctx: DashboardCtx,
  call: DomainsCall,
): Promise<Envelope<ApiDomainsData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  // host_fold: the legacy dashboard domain list is per host (summary trend `axis = 'domain'` and the mirror `GROUP BY c2.domain`),
  // with or without a period; the citations screen table is per group key. card covers the no-period call, host_fold the period one
  // (WU-12, back profile switch domains_card_by_host). Global and website only, like card (project is not verified).
  // B011 (B029): the competitor row reads own_share.den and competitor_sources, the composition the
  // top rows and own_share.den. Neither reads the coverage denominator (summary.answers_den, row
  // coverage.den) or competitor_totals, so the backend skips both (own_share is not affected).
  const extra: {
    limit: number;
    competitor_sources?: boolean;
    card?: true;
    host_fold?: true;
    include_den: false;
    include_competitor_totals: false;
  } = {
    limit: call.limit,
    ...cardParam(ctx.surface, domainsCard(query)),
    ...(ctx.surface === "global" || ctx.surface === "website" ? { host_fold: true as const } : {}),
    include_den: false,
    include_competitor_totals: false,
  };
  if (call.competitorSources) extra.competitor_sources = true;
  const res = await hghGet("/v1/citations/domains", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

/**
 * The engine badge columns (B090 parts=sov+citation): answers, tracked, mentions, sentiment, rank
 * sum / ranked and the citation pair, i.e. every input of applyEngineConsistency. rank_detail
 * (multi, top1, top3) is not computed: the dashboards never read it (null -> 0 in toEngineRow).
 */
export const BADGE_ENGINE_PARTS = ["citation", "sov"] as const;

export async function fetchEngineRows(filters: StandardFilters, ctx: DashboardCtx): Promise<Envelope<ApiEnginesData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  // card: the website badge only (legacy S4.subkpi, summary). The global badge was S2.mention (mirror).
  const extra = { parts: [...BADGE_ENGINE_PARTS], ...cardParam(ctx.surface, ctx.surface === "website") };
  const res = await hghGet("/v1/kpi/engines", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

export async function fetchGeo(filters: StandardFilters, ctx: DashboardCtx): Promise<Envelope<ApiGeoData>> {
  const { query } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/geo", { query: withParams(query, cardParam(ctx.surface, true)) });
  return { data: res.data, meta: res.meta };
}

/** GET /v1/projects/{id}: the same call (and in-request dedupe key) as the U2 project gate. */
export async function fetchProjectDetail(projectId: string): Promise<ApiProjectDetail> {
  const res = await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: projectId } });
  return res.data;
}

/**
 * view=card (P3): the KPI section reads the owned base count, tracked_url_count, the domain and the
 * designated comparison brand only (toProjectCardSettings); engines, aliases and vehicles are not
 * read (null) and competitors is the designated row alone.
 */
export async function fetchProjectSettings(projectId: string): Promise<ApiSettingsBundle> {
  const res = await hghGet("/v1/projects/{project_id}/settings", {
    pathParams: { project_id: projectId },
    query: { view: "card" },
  });
  return res.data;
}

/**
 * Recent candidates for the dashboard panel: the backend lists created_at desc, so one small page.
 * include_total=false (P3): the candidates tile reads ProjectDetail.candidate_count (BG-38), never
 * meta.page.total, so the backend skips the COUNT.
 */
export const RECENT_LIMIT = 5;
export async function fetchRecentCandidates(projectId: string): Promise<ApiCandidateItem[]> {
  const res = await hghGet("/v1/projects/{project_id}/prompt-candidates", {
    pathParams: { project_id: projectId },
    query: { limit: RECENT_LIMIT, include_total: false },
  });
  return res.data.items;
}

// ── D6: first render budget ─────────────────────────────────────────────────
//
// The gate and its four calls are memoised per request (React cache), failures included:
//   * the gate promise is made once per (surface, the inputs its calls read) and every later
//     section joins it, so a section that starts after the gate settled does not re-issue it;
//   * each essential call's promise is kept even when it rejects (the in-request GET dedupe of
//     lib/hgh/client drops a failed entry so a section may retry; for the gate a failed call is
//     settled, not pending). The shell's calendar reads the same kept promise
//     (loadEssentialFilterDates), so a failed /v1/filters/dates is sent once per request, not
//     once by the gate and again by the shell (U5 verification D3: 2 x the read timeout).
// Outside a request scope (scripts, plain unit tests) nothing is memoised: each call runs.

interface EssentialStore {
  calls: Map<string, Promise<unknown>>;
  gates: Map<string, Promise<void>>;
}
const essentialStore = cache((): EssentialStore => ({ calls: new Map(), gates: new Map() }));

function requestEssentials(): EssentialStore | null {
  try {
    return essentialStore();
  } catch {
    return null;
  }
}

/** The kept promise of one essential call in this request (rejections kept too). */
function keptCall<T>(key: string, run: () => Promise<T>): Promise<T> {
  const store = requestEssentials();
  if (!store) return run();
  const hit = store.calls.get(key);
  if (hit) return hit as Promise<T>;
  const p = run();
  // Kept rejected promises are read later (or never): mark them handled here.
  p.catch(() => undefined);
  store.calls.set(key, p);
  return p;
}

export type EssentialCall = () => Promise<unknown>;

const datesKey = (ctx: DashboardCtx): string =>
  stableKey(["dates", ctx.surface, ctx.surface === "global" ? null : (ctx.projectId ?? null)]);

function keptDates(ctx: DashboardCtx): Promise<Awaited<ReturnType<typeof fetchFilterDates>>> {
  return keptCall(datesKey(ctx), () =>
    fetchFilterDates({ surface: ctx.surface, projectId: ctx.projectId, family: "all" }),
  );
}

/** Key of one essential call of (surface, project); `input` = what the call reads besides them. */
const essentialKey = (name: string, ctx: Pick<DashboardCtx, "surface" | "projectId">, input: unknown): string =>
  stableKey([name, ctx.surface, ctx.projectId ?? null, input]);

/** The kept card brand rows (essential on global and website; the competitor rows read it too). */
function keptCardBrands(filters: StandardFilters, ctx: DashboardCtx): Promise<Envelope<ApiBrandsData>> {
  const read = { filters, scope: ctx.scope ?? null, customFields: ctx.customFields ?? null };
  return keptCall(essentialKey("brands", ctx, read), () => fetchCardBrands(filters, ctx));
}

/** The kept project detail (project essential; the tiles read it too). */
function keptProjectDetail(projectId: string): Promise<ApiProjectDetail> {
  return keptCall(essentialKey("project", { surface: "project", projectId }, null), () => fetchProjectDetail(projectId));
}

/** The kept recent candidates (project essential; the tiles read it too). */
function keptCandidates(projectId: string): Promise<ApiCandidateItem[]> {
  return keptCall(essentialKey("candidates", { surface: "project", projectId }, null), () => fetchRecentCandidates(projectId));
}

/** The first-render calls of a dashboard surface (see header). */
export function essentialCalls(filters: StandardFilters, ctx: DashboardCtx): EssentialCall[] {
  const k = (name: string, input: unknown) => essentialKey(name, ctx, input);
  const read = { filters, scope: ctx.scope ?? null, customFields: ctx.customFields ?? null };
  const dates = () => keptDates(ctx);
  const options = () =>
    keptCall(k("options", [filters.dateFrom ?? null, filters.dateTo ?? null]), () =>
      fetchFilterOptions({ surface: ctx.surface, projectId: ctx.projectId, dateFrom: filters.dateFrom, dateTo: filters.dateTo }),
    );
  const summary = () => keptCall(k("summary", read), () => fetchDashboardSummary(filters, ctx));
  const brands = () => keptCardBrands(filters, ctx);
  switch (ctx.surface) {
    case "global":
      return [summary, brands, dates];
    case "website":
      return [summary, brands, dates, options];
    case "project":
      return [() => keptProjectDetail(ctx.projectId!), () => keptCandidates(ctx.projectId!), dates, options];
  }
}

/** The inputs the surface's essential calls read: one gate per distinct set in a request. */
function gateKey(filters: StandardFilters, ctx: DashboardCtx): string {
  if (ctx.surface === "project") {
    return stableKey(["gate", "project", ctx.projectId ?? null, filters.dateFrom ?? null, filters.dateTo ?? null]);
  }
  return stableKey(["gate", ctx.surface, filters, ctx.scope ?? null]);
}

/**
 * Resolves once every call has settled. Failures are not raised here: each section still sees
 * its own call's error.
 */
export async function afterEssentials(calls: readonly EssentialCall[]): Promise<void> {
  await Promise.allSettled(calls.map((c) => c()));
}

/** The request's gate for (filters, ctx): made once, joined by every later section. */
export function essentialsGate(filters: StandardFilters, ctx: DashboardCtx): Promise<void> {
  const store = requestEssentials();
  if (!store) return afterEssentials(essentialCalls(filters, ctx));
  const key = gateKey(filters, ctx);
  const hit = store.gates.get(key);
  if (hit) return hit;
  const gate = afterEssentials(essentialCalls(filters, ctx));
  store.gates.set(key, gate);
  return gate;
}

/** Runs a non-essential section read after the first-render calls (D6 (b)). */
export async function afterFirstRender<T>(filters: StandardFilters, ctx: DashboardCtx, run: () => Promise<T>): Promise<T> {
  await essentialsGate(filters, ctx);
  return run();
}

/**
 * The shell calendar from the essential dates call (the same kept promise as the gate's, so a
 * failure is not re-sent in this request). Transient failure -> null (legacy
 * standardCollectionDates().catch(null)); 4xx is raised.
 */
export async function loadEssentialFilterDates(ctx: DashboardCtx): Promise<FilterDatesView | null> {
  const res = await orNullOnTransient(keptDates(ctx));
  return res ? toFilterDatesView(res) : null;
}

// ── ⑦ conversion ─────────────────────────────────────────────────────────────

const pctOf = (num: number, den: number): number => pct1OrZero({ num, den });

/**
 * ⑦ trafficConversion card of the project home (legacy GA4 card rules; see header). Returns null
 * when the scope reaches no GA4 market at all (the tile is left out).
 */
export function toTrafficConversionKpi(data: ApiConversionData): KpiSummary | null {
  const total = data.coverage.total_markets;
  const measured = data.coverage.measured_markets;
  const ai = data.summary.ai;
  // copyVariant: the tile reads the session wording (DC-03) from dashboard.kpi.api.* (u5 messages).
  const base = { key: "trafficConversion" as const, delta: null, direction: "flat" as const, copyVariant: "api" as const };
  if (total <= 0) return null;
  if (total === 1) {
    if (measured < 1 || ai.sessions <= 0) return { ...base, value: null };
    return {
      ...base,
      value: pctOf(ai.conversions, ai.sessions),
      ratio: { numerator: ai.conversions, denominator: ai.sessions },
      ...(data.trend.length ? { sparkline: data.trend.map((p) => p.ai_sessions) } : {}),
    };
  }
  return {
    ...base,
    value: pctOf(ai.conversions, ai.sessions),
    ratio: { numerator: ai.conversions, denominator: ai.sessions },
    coverage: { measured, total },
  };
}

// ── competitor rows ──────────────────────────────────────────────────────────

/** BrandItem -> CompetitorBrandValue (legacy MentionsBrandLive subset). */
export function toCompetitorBrandValue(b: ApiBrandItem): CompetitorBrandValue {
  return {
    brand: b.name,
    mentions: b.mentions,
    share: pct1OrZero(b.share),
    mentionRate: pct1OrZero(b.exposure),
    avgPosition: rankAvg(b.avg_rank),
    isTracked: b.is_own || b.is_hmg_own === true,
    sentiment: {
      positive: b.sentiment.positive,
      neutral: b.sentiment.neutral,
      negative: b.sentiment.negative,
      mixed: b.sentiment.mixed,
    },
    ...(typeof b.brand_key === "number" ? { brandKey: b.brand_key } : {}),
  };
}

export function toCompetitorBrandValues(items: readonly ApiBrandItem[]): CompetitorBrandValue[] {
  return items.map(toCompetitorBrandValue);
}

/** Brand keys of the competitor Δ candidates (the three Δ cards' top 4, legacy competitorDeltaBrands). */
export function candidateBrandKeys(brands: readonly CompetitorBrandValue[]): number[] {
  const byName = new Map(brands.map((b) => [b.brand, b.brandKey]));
  const keys: number[] = [];
  for (const name of competitorDeltaBrands([...brands])) {
    const k = byName.get(name);
    if (typeof k === "number" && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * competitor_sources -> official-competitor domain rows (CitationDomainLive), so the card's
 * competitorCitationShares keeps folding domains to brands with the legacy domain rule.
 * share = pct(citations, all citations) (legacy mirror pct of the domain row). null = no rows.
 */
export function toCompetitorCitationDomains(data: ApiDomainsData): CitationDomainLive[] | null {
  const sources = data.competitor_sources;
  if (!sources) return null;
  const total = data.summary.own_share.den;
  return sources.map((s) => ({
    domain: s.domain,
    citations: s.citations,
    share: pctOf(s.citations, total),
    prompts: 0,
    coverageRate: 0,
    urls: [],
    promptList: [],
    isOurs: false,
    category: OFFICIAL_COMPETITOR_CATEGORY,
    subcategory: null,
    skey: s.skey,
  }));
}

// ── GEO ──────────────────────────────────────────────────────────────────────

const mirrorPct = (r: Ratio | null | undefined): number | null => (r && r.den > 0 ? pct1OrZero(r) : null);

function geoMetrics(own: ApiGeoMetrics, rival: { brand: string; metrics: ApiGeoMetrics } | null | undefined): GeoMetrics {
  const r = (pick: (m: ApiGeoMetrics) => number | null) => (rival ? { name: rival.brand, value: pick(rival.metrics) } : null);
  return {
    visibility: { ours: mirrorPct(own.visibility), rival: r((m) => mirrorPct(m.visibility)) },
    shareOfVoice: { ours: mirrorPct(own.share_of_voice), rival: r((m) => mirrorPct(m.share_of_voice)) },
    sentiment: { ours: mirrorPct(own.sentiment), rival: r((m) => mirrorPct(m.sentiment)) },
    position: { ours: rankAvg(own.position), rival: r((m) => rankAvg(m.position)) },
    citationShare: { ours: mirrorPct(own.citation_share), rival: null },
  };
}

type ApiGeoRow = S["GeoRegionRow"] | S["GeoCountryRow"];

function marketOf(row: ApiGeoRow): MarketCompetition {
  return {
    hmgSov: pct1OrZero(row.own.share_of_voice),
    hmgRank: row.rank.our,
    fieldSize: row.rank.field_size,
    topBrand: row.top_own_brand ? { name: row.top_own_brand.brand, sov: pct1OrZero(row.top_own_brand.share_of_voice) } : null,
    topRival: row.top_rival ? { name: row.top_rival.brand, sov: pct1OrZero(row.top_rival.metrics.share_of_voice) } : null,
    metrics: geoMetrics(row.own, row.top_rival),
    // 언급 0(점유율 분모 0): 0.0%·순위는 측정값이 아니다(지도는 mirrorPct 로 이미 "—")
    ...(!(row.own.share_of_voice && row.own.share_of_voice.den > 0) ? { noMentions: true } : {}),
  };
}

/** GEO-1 answer -> LiveGeo (legacy buildGeo shape; the backend already rolled up and sorted). */
export function toLiveGeo(data: ApiGeoData): LiveGeo {
  const markets: GeoRegionRow[] = data.markets.map((m) => ({
    region: m.region_id,
    ...marketOf(m),
    countries: m.countries.map(
      (c): GeoCountryRow => ({ code: c.code, country: geoLocateByCode(c.code)?.country ?? c.code, ...marketOf(c) }),
    ),
  }));
  return { markets, pending: [...data.pending], ourLabel: data.own_label };
}

// ── engines, composition ─────────────────────────────────────────────────────

const n0 = (v: number | null | undefined): number => v ?? 0;

/** EngineItem -> SubKpiEngineRow (legacy engine breakdown row; avgPosition = rank_sum / ranked). */
export function toEngineRow(r: ApiEngineItem): SubKpiEngineRow {
  const ranked = n0(r.ranked);
  return {
    engine: r.engine,
    answers: n0(r.answers),
    tracked: n0(r.tracked),
    multi: n0(r.multi),
    top1: n0(r.top1),
    top3: n0(r.top3),
    avgPosition: ranked > 0 ? n0(r.rank_sum) / ranked : null,
    totalMentions: n0(r.total_mentions),
    trackedMentions: n0(r.tracked_mentions),
    sentMentions: n0(r.sent_mentions),
    positiveMentions: n0(r.positive_mentions),
    negativeMentions: n0(r.negative_mentions),
    citTotal: n0(r.cit_total),
    citOwned: n0(r.cit_owned),
  };
}

/** The engine badge input in the legacy StandardSubKpis shape (only rows is read by the dashboards). */
export function toSubKpis(data: ApiEnginesData): StandardSubKpis {
  return { rows: data.rows.map(toEngineRow), promptsWithoutBrand: null, measuredPrompts: null };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Top SOURCE_TOP_N domains + "기타" (U5-N2) in the legacy LiveSourceSlice shape. */
export function toSourceSlices(data: ApiDomainsData, topN = SOURCE_TOP_N): LiveSourceSlice[] {
  const total = data.summary.own_share.den;
  const head: LiveSourceSlice[] = data.items.slice(0, topN).map((d) => ({
    domain: d.domain,
    citations: d.citations,
    share: pct1OrZero(d.share),
    isOurs: d.is_own,
  }));
  const rest = total - head.reduce((s, d) => s + d.citations, 0);
  return rest > 0 ? [...head, { domain: "", citations: rest, share: pctOf(rest, total), isOurs: false }] : head;
}

/** measured_by_funnel -> the legacy topic slices (share = round1(100 * prompts / all)). */
export function toTopicSlices(summary: SummaryResponse | null): LiveTopicSlice[] {
  const rows = summary?.data.params.measured_by_funnel ?? [];
  const total = rows.reduce((s, r) => s + r.measured_prompts, 0);
  return rows.map((r) => ({
    topic: r.funnel ?? null,
    prompts: r.measured_prompts,
    share: total > 0 ? round1((100 * r.measured_prompts) / total) : 0,
  }));
}

// ── loaders in the legacy shapes ─────────────────────────────────────────────

/** ①~⑤ (+ URL-rate cards on website/project) with KPI #16, or null for the legacy empty state. */
export function toDashboardKpis(
  summary: SummaryResponse,
  brands: ApiBrandsData | null,
  opts: { urlRates?: boolean; designatedTarget?: string | null } = {},
): KpiSummary[] | null {
  if (summaryIsEmpty(summary.data, summary.meta)) return null;
  const cards = toMirrorKpis(summary.data, summary.meta);
  if (opts.urlRates) {
    const u = toUrlRateKpis(summary.data, summary.meta);
    // Website URL-rate cards per prompt (DC-02 decision 6): the legacy wording, no copyVariant.
    // A measurement-unit answer (not website) keeps the api wording from dashboard.kpi.api.*.
    if (u) {
      const copy = u.unit === "measurement" ? { copyVariant: "api" as const } : {};
      cards.push({ ...u.ownedUrlRate, ...copy }, { ...u.targetUrlRate, ...copy }, u.citationAccuracy);
    }
  }
  if (!brands) return cards;
  return applyCompetitorSovFromBrands(cards, summary.data.share_of_voice?.num ?? 0, brands.brands, opts.designatedTarget);
}

/**
 * B027 degrade labels of the project home sections that would otherwise vanish on a transient
 * failure: the composition panel (topics + sources) and the ⑦ tile ("답변의 전환"). The api source
 * records them (projects/[id]/_data/live.ts degradeOnApiFailure) and project-dashboard.tsx draws
 * the existing DegradeNotice in their place. The legacy readers had no label for these reads.
 */
export const PROJECT_COMPOSITION_LABEL = "projectComposition";
export const PROJECT_CONVERSION_LABEL = "projectTrafficConversion";

/** A transient backend failure (5xx, timeout, network, abort): the part degrades, 4xx is raised. */
export function isTransientApiFailure(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return isHghApiError(e) && e.status >= 500;
}

/** The value, or null when the read failed transiently (4xx and other errors are raised). */
export async function orNullOnTransient<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isTransientApiFailure(e)) return null;
    throw e;
  }
}

/**
 * Global dashboard (legacy getLiveDashboard): ①~⑤, KPI #16 automatic. The summary decides the
 * empty state (its failure is the caller's to degrade); a transient failure of the brand rows only
 * drops KPI #16. ⑦ is not read: the Overview cards render OVERVIEW_KPI_KEYS only (see header).
 */
export async function loadLiveDashboard(filters: StandardFilters, ctx: DashboardCtx): Promise<LiveDashboard | null> {
  const [summary, brands] = await Promise.all([
    fetchDashboardSummary(filters, ctx),
    orNullOnTransient(fetchCardBrands(filters, ctx)),
  ]);
  if (summaryIsEmpty(summary.data, summary.meta)) return null;
  const cards = toMirrorKpis(summary.data, summary.meta);
  if (!brands) return { kpis: cards };
  return {
    kpis: applyCompetitorSovFromBrands(cards, summary.data.share_of_voice?.num ?? 0, brands.data.brands),
  };
}

/** Website dashboard (legacy getLiveWebsiteDashboard): ①~⑤, owned/target URL rate, accuracy, #16. */
export async function loadWebsiteDashboard(filters: StandardFilters, ctx: DashboardCtx): Promise<LiveDashboard | null> {
  const [summary, brands] = await Promise.all([
    fetchDashboardSummary(filters, ctx),
    orNullOnTransient(fetchCardBrands(filters, ctx)),
  ]);
  const kpis = toDashboardKpis(summary, brands?.data ?? null, { urlRates: true });
  return kpis ? { kpis } : null;
}

/** meta.as_of of the dashboard summary (the header pill / as-of chip). */
export async function loadDashboardAsOf(filters: StandardFilters, ctx: DashboardCtx): Promise<string | null> {
  return asOfDate((await fetchDashboardSummary(filters, ctx)).meta);
}

/** LiveTrend of a dashboard (null when the backend has no slot, legacy "no buckets"). */
export async function loadLiveTrend(
  filters: StandardFilters,
  ctx: DashboardCtx,
  bucket: TrendBucketName,
  metrics?: readonly TrendMetric[],
  /** LiveTrend.unit (the legacy call's unit). Default: week for bucket=week, else day. */
  unit?: BucketUnit,
): Promise<ApiLiveTrend | null> {
  // measured_days=false: no LiveTrend reader shows or computes with measuredDays (the chart row
  // carries it unread), so the backend skips the rd.job join (performance A1).
  const res = await fetchTrend(filters, { ...ctx, bucket, ...(metrics ? { metrics } : {}), measuredDays: false, card: true });
  if (res.data.buckets.length === 0) return null;
  // LiveTrend.unit is the legacy BucketUnit (week | day): the cycle trend replaces the legacy day roll-up.
  return toLiveTrend(res.data, { unit: unit ?? (bucket === "week" ? "week" : "day") });
}

/** The competitor row sources (legacy fetchStandardCompetitorSources) from brands, brand trend and domains. */
export async function loadCompetitorSources(
  filters: StandardFilters,
  ctx: DashboardCtx,
  opts: { onFailure?: (label: string, e: unknown) => void } = {},
): Promise<OverviewCompetitorSources> {
  const guard = async <T>(labels: string[], p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      if (!opts.onFailure) throw e;
      for (const l of labels) opts.onFailure(l, e);
      return null;
    }
  };
  // The kept essential brands call (global, website): a failed one is not sent again (U5 N2).
  const brandsRes = await guard(["standardMentions"], keptCardBrands(filters, ctx));
  const brands = brandsRes ? toCompetitorBrandValues(brandsRes.data.brands) : [];
  const keys = candidateBrandKeys(brands);
  const [trend, domains] = await Promise.all([
    guard(
      ["brandTrend", "firstPosition"],
      fetchTrend(filters, {
        ...ctx,
        bucket: "cycle",
        dimension: "brand",
        // the three Δ cards (COMPETITOR_DELTA_KEYS: visibility, shareOfVoice, position)
        metrics: ["visibility", "share_of_voice", "position"],
        // B031: the candidates come by brand_key; top is the minimum (BRAND_TREND_TOP)
        top: BRAND_TREND_TOP,
        brandKeys: keys,
        // Competitor Δ reads the last two values only (competitor-values.ts), never measuredDays.
        measuredDays: false,
        card: true,
      }),
    ),
    guard(["standardCitationDomains"], fetchDashboardDomains(filters, ctx, { limit: 0, competitorSources: true })),
  ]);
  return {
    brands,
    brandTrend: trend ? toBrandTrendResult(trend.data) : null,
    firstPosition: trend ? toFirstPositionResult(trend.data) : null,
    citationDomains: domains ? toCompetitorCitationDomains(domains.data) : null,
    // 도메인 점유율의 분모: 경쟁사 미니값을 반올림 점유율 합이 아니라 인용 수 합 ÷ 분모로 낸다(competitorCitationShares)
    citationTotal: domains?.data.competitor_sources ? domains.data.summary.own_share.den : null,
  };
}

/** GEO section (legacy getLiveGeo / getLiveWebsiteGeo body). */
export async function loadLiveGeo(filters: StandardFilters, ctx: DashboardCtx): Promise<LiveGeo> {
  return toLiveGeo((await fetchGeo(filters, ctx)).data);
}

/** Engine badge rows (legacy getLiveSubKpis / getLiveWebsiteSubKpis). */
export async function loadSubKpis(filters: StandardFilters, ctx: DashboardCtx): Promise<StandardSubKpis> {
  return toSubKpis((await fetchEngineRows(filters, ctx)).data);
}

/** Composition panel (legacy getLive*Composition): sources always, topics on project (BG-08). */
export async function loadComposition(filters: StandardFilters, ctx: DashboardCtx): Promise<LiveComposition> {
  const [domains, summary] = await Promise.all([
    fetchDashboardDomains(filters, ctx, { limit: SOURCE_TOP_N }),
    ctx.surface === "project" ? fetchDashboardSummary(filters, ctx) : Promise.resolve(null),
  ]);
  return { topics: toTopicSlices(summary), sources: toSourceSlices(domains.data) };
}

// ── project dashboard ────────────────────────────────────────────────────────

/** The tiles and panels of the project dashboard (both sources build this; see project live.ts). */
export interface ProjectOverview {
  promptCount: number;
  statusCounts: { status: PromptRow["status"]; count: number }[];
  candidateCount: number;
  activeMemberCount: number;
  /** Latest updated_at of running/done prompts (legacy lastAi). */
  lastAi: Date | null;
  /** Some prompt is done (pending-aggregation wording). */
  hasMeasuredPrompts: boolean;
  recentCandidates: Pick<PromptCandidateRow, "id" | "text" | "sourceKeyword" | "source" | "createdAt">[];
  recentPrompts: Pick<PromptRow, "id" | "text" | "status" | "updatedAt">[];
}

export const PROMPT_STATUS_ORDER: PromptRow["status"][] = ["draft", "queued", "running", "done", "failed", "paused"];

const CANDIDATE_SOURCES: ReadonlySet<string> = new Set<PromptCandidateRow["source"]>(["google_keyword", "social_scraping", "manual"]);

/** ProjectDetail (BG-38 counts) + first candidate page -> ProjectOverview. */
export function toProjectOverview(d: ApiProjectDetail, candidates: readonly ApiCandidateItem[]): ProjectOverview {
  const counts: Partial<Record<PromptRow["status"], number>> = d.prompt_counts ?? {};
  const statusCounts = PROMPT_STATUS_ORDER.map((status) => ({ status, count: counts[status] ?? 0 }));
  return {
    promptCount: statusCounts.reduce((s, c) => s + c.count, 0),
    statusCounts,
    candidateCount: d.candidate_count ?? 0,
    activeMemberCount: d.active_member_count ?? 0,
    lastAi: d.last_run_at ? new Date(d.last_run_at) : null,
    hasMeasuredPrompts: (counts.done ?? 0) > 0,
    recentCandidates: candidates.slice(0, RECENT_LIMIT).map((c) => ({
      id: c.candidate_id,
      text: c.text,
      sourceKeyword: c.source_keyword ?? null,
      source: (CANDIDATE_SOURCES.has(c.source) ? c.source : "manual") as PromptCandidateRow["source"],
      createdAt: new Date(c.created_at),
    })),
    recentPrompts: (d.recent_prompts ?? []).slice(0, RECENT_LIMIT).map((p) => ({
      id: p.prompt_id,
      text: p.text,
      status: (PROMPT_STATUS_ORDER as string[]).includes(p.status) ? (p.status as PromptRow["status"]) : "draft",
      updatedAt: new Date(p.updated_at),
    })),
  };
}

/** The tiles read the kept essential calls: a failed one is not sent again in the request (U5 N2). */
export async function loadProjectOverview(projectId: string): Promise<ProjectOverview> {
  const [detail, candidates] = await Promise.all([keptProjectDetail(projectId), keptCandidates(projectId)]);
  return toProjectOverview(detail, candidates);
}

/** Settings the project KPI section reads (legacy live.ts:154-187 inputs). */
export interface ProjectCardSettings {
  ownedBaseCount: number;
  trackedUrlCount: number;
  domain: string | null;
  targetBrand: string | null;
}

export function toProjectCardSettings(s: ApiSettingsBundle): ProjectCardSettings {
  return {
    ownedBaseCount: s.owned_bases.length,
    trackedUrlCount: s.tracked_url_count,
    domain: s.domain ?? null,
    targetBrand: s.competitors.find((c) => c.is_target)?.brand_name ?? null,
  };
}

/** Surfaces that exist for the dashboards (for callers that build a ctx from a route). */
export function dashboardCtx(surface: Surface, scope: AllowedScope | null, projectId?: string): DashboardCtx {
  return surface === "project" ? { surface, scope, projectId } : { surface, scope };
}
