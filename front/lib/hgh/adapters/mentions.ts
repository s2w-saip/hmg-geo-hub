import "server-only";

// Mentions adapter (unit U6): the mention screens' body data from the backend, in the shapes the
// legacy readers produced. Design 3.3 "언급·답변 드릴다운", appendix B (B-2 MentionsLive, B-3 Sub
// KPI, 정합 1..10), 3.6 BG rows, decisions D5, D6, D8, D13.
//
//   legacy (lib/scope/server.ts)                 api (this module)
//   fetchStandardMentions        SRV:3726         loadMentionsLive(filters, {surface: global})
//   fetchWebsiteMentions         SRV:4983         loadMentionsLive(filters, {surface: website})
//   fetchProjectMentions         SRV:756          loadMentionsLive(filters, {surface: project, projectId})
//   fetchStandard/Website/ProjectSubKpis         loadSubKpis(filters, ctx)
//   fetchWebsite/ProjectSubKpisPrev              loadSubKpisPrev(filters, ctx)
//   trackedCompetitorRepository.getTargetBrand   loadDesignatedTargetBrand(projectId) (BG-38)
//   (the measurement overview card left the mention screens upstream, hmg-geo #305: its loader
//   loadOverviewCounts is gone, sync S1 FA-3; B4 stays, the body and the Sub KPI read it)
//
// Calls (one set per screen; identical queries are shared in the request by the client dedupe):
//   B1 GET /v1/mentions/brands  full=true, sort=mentions, split_own=true (D13),
//                               include=multi,prompts,types (BG-12, BG-13, BG-14); the website and
//                               project screens send include=prompts,types (their table has no multi
//                               toggle, B036)
//   B2 GET /v1/mentions/types   (typeTotals; merged perspective = legacy tracked rollup),
//                               include_stance=false unless the stance card reads it (B036)
//   B3 GET /v1/trend            bucket=cycle, dimension=brand, metrics=visibility,share_of_voice,
//                               position, top=10, split_own=true (the KPI tab and the bottom chart
//                               share it: 정합 3). Website/project (bottom chart only, B037):
//                               metrics=share_of_voice, measured_days=false
//   B4 GET /v1/kpi/summary      (U4 fetchKpiSummary: measured prompts, BG-06 prompts_without_brand),
//                               parts=measured on every mention call (MENTION_SUMMARY_PARTS: ①~⑤ come
//                               always; the KPI tab sends the same parts so the calls fold)
//   B5 GET /v1/kpi/engines      part=exposure (Sub KPI rows: mention columns + multi/top3, no citation
//                               columns, B036; the KPI tab reads part=sov)
// D6 (first render budget): the first loader of a screen fires the four essentials at once
// (global: B1, B4, the calendar, the overview trend; website/project: B1, B4, the calendar, B5);
// afterEssentials() holds every other call until those four settled.
//
// Field rules (hand-checked in mentions.test.ts):
//   brand ← name (split own row = its brand code, merged own row = vp_label, BG-48 = trend label)
//   mentions ← mentions ; prompts ← prompts (BG-12) ; multi ← multi (BG-13)
//   share ← round(1000 * share.num / share.den) / 10, den 0 -> 0     (legacy pctOf, AGG:5739)
//   mentionRate ← same rule on exposure
//   avgPosition ← round1(avg_rank.sum / avg_rank.count), no ranked answer -> null
//   isTracked ← is_own ; sentiment ← sentiment ; brandKey ← brand_key
//   ownBrandCode ← own_brand_code (extra field: the drilldown's own target, BG-17)
//   summary.total ← totals.mentions_total ; uniqueBrands ← totals.brand_count
//   summary.totalPrompts ← B4 params.measured_prompts, a failed B4 -> null ("—", not a made-up 0, B035)
//   totalAnswers ← totals.answers
//   brandsTotal ← totals.brand_count, only when the full list was cut (data.truncated or
//           meta.truncated.brands, B039): the table adds the "{total}개 중 {shown}개" line
//   sentimentTotals ← sum of the own rows' sentiment, all four 0 -> null
//   typeTotals ← B2 by_type[].own_mentions when the own rows have mentions, else null
//   typesByBrand ← types_total + brands[].types (BG-14), types_total sum 0 -> null
//   trend ← B3 share_of_voice numerators by week (Monday of each round), gap rounds as gap
//           weeks (buildMentionTrend: same builder, same "2 weeks" rule, same-week rounds summed)
//   Empty: meta.suppressed['*'] -> null (EmptyState), totals.answers 0 -> the empty shape
//   Sub KPI rows ← B5 rows: rank_sum/ranked -> avgPosition, nulls -> 0 (StandardSubKpis as is,
//           so buildMentionSubKpis runs unchanged); a hidden mention family -> rows []
//   Prev: cumulative (from/to) -> to = the first round of the window (meta.cycles), fewer than 2
//         rounds -> null; snapshot -> cycle_offset=1, asOf = meta.as_of, '*' suppressed -> null
//
// Known differences. Design DC list (front-adapter-plan 3.6 (나)):
//   DC-01  engine[] empty = the default engine only (legacy: every engine)
//   DC-05  prev (Sub KPI Δ) is the previous round (legacy: previous measure day)
//   DC-08  trend series = top 10 over the window (legacy: weekly top 10 union capped at 15);
//          default window 12 rounds (legacy 120 days)
//   DC-12  handled by D13 (split_own): one own row and one own line per perspective brand
// Outside the DC list (U6 numbering, for the A4 notice; asserted in mentions.test.ts):
//   U6-N1  the full brand list is capped at 10,000 competitor rows (FULL_CAP, legacy: every
//          brand). Above it data.truncated is set, the table shows the first 10,000 and says so
//          with the existing "{total}개 중 {shown}개 표시" line (BG-19 full, B039)
//   U6-N2  project custom-field values of deleted prompts are no longer offered (options API)
//   U6-N3  mentions of a brand the parser could not resolve (brand_key 0) are not a table row
//          (backend rule F03); legacy kept an unnamed row when it had a display name
import type { PrevSubKpis } from "@/lib/scope/server";
import type { StandardSubKpis, SubKpiEngineRow } from "@/lib/db/repositories/scope-aggregates";
import type {
  MentionsBrandLive,
  MentionsLive,
  MentionTrend,
  MentionTypesByBrand,
  StandardFilters,
} from "@/lib/scope/result-adapter";
import { buildMentionTrend } from "@/lib/scope/result-adapter";
import type { MentionSentimentBreakdown, MentionTypeBreakdown } from "@/lib/scope/types";
import { dedupeInRequest, stableKey } from "@/lib/request-dedupe";
import { degradeOnApiFailure, wasDegraded } from "@/lib/scope/degrade-registry";
import type { components } from "../api-types";
import { hghGet } from "../client";
import { asOfDate, pct1OrZero, rankAvg, wholeSuppression, type ApiMeta } from "../convert";
import { isHghApiError } from "../errors";
import { withParams } from "../query";
import { analysisQuery, fetchFilterDates, type AnalysisQueryContext } from "./filters";
import { fetchKpiSummary, type SummaryPart, type SummaryResponse } from "./summary";
import { bucketRoundDate, fetchTrend, mondayOf, pointGap, seriesLabel, type TrendResponse } from "./trend";

type S = components["schemas"];
export type ApiBrandsData = S["BrandsData"];
export type ApiBrandItem = S["BrandItem"];
export type ApiTypesData = S["app__features__analytics__mentions__types__schemas__TypesData"];
export type ApiEnginesData = S["EnginesData"];
export type ApiEngineItem = S["EngineItem"];

/** Screen context: surface (+ project), the session scope readStandardFilters used, project custom fields. */
export type MentionsContext = AnalysisQueryContext;

/** A brand row with the own-row key of a split perspective (D13): the drilldown's own target. */
export type ApiMentionsBrandLive = MentionsBrandLive & { ownBrandCode?: string };

/**
 * MentionsLive of the API source: totalPrompts is null when the summary read failed (B035, the
 * card shows "—" instead of a made-up 0) and brandsTotal carries the count before the 10,000 cap
 * when the full list was cut (B039). Otherwise the legacy shape as is.
 */
export type ApiMentionsLive = Omit<MentionsLive, "summary"> & {
  summary: Omit<MentionsLive["summary"], "totalPrompts"> & { totalPrompts: number | null };
  brandsTotal?: number;
};

export const MENTION_TYPES = ["mention", "recommendation", "comparison", "definition", "final_choice"] as const;

// ── calls ───────────────────────────────────────────────────────────────────

export interface Enveloped<T> {
  data: T;
  meta: ApiMeta;
}

/** B1 options. Every mention call of a screen uses the same set so they share one request. */
export const BRANDS_TABLE = {
  top_n: 100,
  sort: "mentions",
  split_own: true,
  full: true,
  include: ["multi", "prompts", "types"],
} as const;

/**
 * B1 of the website and project screens (B036; project since P13): both draw MentionsView, whose
 * brand table has no multi-mention toggle (BrandRankTable multiToggle off, the multi values are
 * never shown or exported; the Sub KPI multi card reads B5), so the multi extras are not
 * requested. Every other option and so every shown value is the same as BRANDS_TABLE.
 */
export const VIEW_BRANDS_TABLE = { ...BRANDS_TABLE, include: ["prompts", "types"] } as const;

/** The B1 options of a screen (every B1 call of one screen must use the same set). */
export function brandsTableOf(ctx: Pick<MentionsContext, "surface">): BrandsRequest {
  return ctx.surface === "website" || ctx.surface === "project" ? VIEW_BRANDS_TABLE : BRANDS_TABLE;
}

export interface BrandsRequest {
  top_n?: number;
  sort?: "mentions" | "share" | "avg_rank";
  split_own?: boolean;
  full?: boolean;
  include?: readonly ("prompts" | "multi" | "types" | "hmg")[];
  group_by?: "engine";
  /** With group_by=engine only (B092/B038): by_engine alone, the window-wide rows are skipped. */
  engine_only?: boolean;
}

/** GET /v1/mentions/brands for the screen filters (default: the table call B1 of the screen). */
export async function fetchMentionBrands(
  filters: StandardFilters,
  ctx: MentionsContext,
  req: BrandsRequest = brandsTableOf(ctx),
): Promise<Enveloped<ApiBrandsData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const extra: {
    top_n?: number;
    sort?: "mentions" | "share" | "avg_rank";
    split_own?: boolean;
    full?: boolean;
    include?: ("prompts" | "multi" | "types" | "hmg")[];
    group_by?: "engine";
    engine_only?: boolean;
  } = {};
  if (req.top_n !== undefined) extra.top_n = req.top_n;
  if (req.sort) extra.sort = req.sort;
  if (req.split_own) extra.split_own = true;
  if (req.full) extra.full = true;
  if (req.include?.length) extra.include = [...req.include];
  if (req.group_by) extra.group_by = req.group_by;
  if (req.group_by && req.engine_only) extra.engine_only = true;
  const res = await hghGet("/v1/mentions/brands", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

/**
 * GET /v1/mentions/types (merged perspective, as the legacy tracked rollup). include_stance=false
 * unless opts.stance (B036): only the stance card reads data.stance and it is off today
 * (STANCE_CARD_ENABLED), so the stance statement is skipped; by_type, answers_total and the
 * sentiment matrix are the same.
 */
export async function fetchMentionTypes(
  filters: StandardFilters,
  ctx: MentionsContext,
  opts: { stance?: boolean } = {},
): Promise<Enveloped<ApiTypesData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/mentions/types", {
    query: opts.stance ? query : withParams(query, { include_stance: false }),
    cf,
  });
  return { data: res.data, meta: res.meta };
}

export type EnginesPart = "all" | "exposure" | "sov" | "favorability" | "position" | "citation";

/**
 * B036: the engine-row columns the Sub KPI reads (backend part: columns it does not compute come
 * back null). buildMentionSubKpis reads the mention columns and the rank detail (multi, top3), never
 * cit_total / cit_owned, so part=exposure (mentions + rank detail) instead of all.
 */
export const SUB_KPI_ENGINE_PART: EnginesPart = "exposure";

/** GET /v1/kpi/engines (default part: the Sub KPI rows; the KPI tab passes its own part). */
export async function fetchEngineRows(
  filters: StandardFilters,
  ctx: MentionsContext,
  opts: { cycleOffset?: 0 | 1; part?: EnginesPart } = {},
): Promise<Enveloped<ApiEnginesData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const extra: { part: EnginesPart; cycle_offset?: number } = { part: opts.part ?? SUB_KPI_ENGINE_PART };
  if (opts.cycleOffset) extra.cycle_offset = opts.cycleOffset;
  const res = await hghGet("/v1/kpi/engines", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

/**
 * B4 parts of every mention-screen summary call (mentions and kpi-tab alike, so the in-request
 * dedupe folds them): the screens read params.measured_prompts / prompts_without_brand and the
 * ①~⑤ pairs (always computed), never applied_prompts, analysis_gap or the URL cards.
 */
export const MENTION_SUMMARY_PARTS: readonly SummaryPart[] = ["measured"];

/** GET /v1/kpi/summary of a mention screen (B4, MENTION_SUMMARY_PARTS). */
export function fetchMentionSummary(
  filters: StandardFilters,
  ctx: MentionsContext,
  opts: { cycleOffset?: 0 | 1 } = {},
): Promise<SummaryResponse> {
  return fetchKpiSummary(filters, { ...ctx, ...opts, parts: MENTION_SUMMARY_PARTS });
}

/** B3: the brand trend shared by the KPI tab (brand, first rank) and the bottom weekly chart. */
export const BRAND_TREND_METRICS = ["visibility", "share_of_voice", "position"] as const;

/**
 * B3 of the website/project screens (B037): only the bottom weekly chart reads it, and
 * toMentionTrend takes the share_of_voice numerators and the round dates, never measured days.
 * The series (own + top 10 by mentions) do not depend on the requested metrics.
 */
export const CHART_BRAND_TREND_METRICS = ["share_of_voice"] as const;

export function fetchBrandTrend(filters: StandardFilters, ctx: MentionsContext): Promise<TrendResponse> {
  const chartOnly = ctx.surface !== "global";
  return fetchTrend(filters, {
    ...ctx,
    bucket: "cycle",
    dimension: "brand",
    metrics: chartOnly ? CHART_BRAND_TREND_METRICS : BRAND_TREND_METRICS,
    top: 10,
    splitOwn: true,
    ...(chartOnly ? { measuredDays: false } : {}),
  });
}

/** The overview trend (dimension none) shared by the KPI tab hero, card Δ and D6 essentials. */
export const OVERVIEW_TREND_METRICS = ["visibility", "share_of_voice", "sentiment", "position"] as const;

export function fetchOverviewTrend(filters: StandardFilters, ctx: MentionsContext): Promise<TrendResponse> {
  return fetchTrend(filters, { ...ctx, bucket: "cycle", dimension: "none", metrics: OVERVIEW_TREND_METRICS });
}

// ── D6: first render budget ─────────────────────────────────────────────────

/**
 * The four calls a mention screen needs first (D6): brands (table, header pill, KPI rows),
 * summary (KPI hero, body prompt total, Sub KPI), the calendar, and the overview trend on the global KPI screen
 * (hero trend, card Δ) or the engine rows on website/project (Sub KPI cards). Settled, never
 * rejected: each consumer still sees its own error. One run per request (dedupe).
 */
export function mentionsEssentials(filters: StandardFilters, ctx: MentionsContext): Promise<void> {
  const key = stableKey(["u6-essentials", filters, ctx.surface, ctx.projectId ?? null, ctx.customFields ?? null]);
  return dedupeInRequest(key, async () => {
    await Promise.allSettled([
      fetchMentionBrands(filters, ctx),
      fetchMentionSummary(filters, ctx),
      fetchFilterDates({ surface: ctx.surface, projectId: ctx.projectId, family: "mentions" }),
      ctx.surface === "global" ? fetchOverviewTrend(filters, ctx) : fetchEngineRows(filters, ctx),
    ]);
  });
}

/** Start the essentials without waiting (first-stage loaders call it before their own read). */
export function startEssentials(filters: StandardFilters, ctx: MentionsContext): void {
  void mentionsEssentials(filters, ctx);
}

/** Run a second-stage call after the essentials settled (D6 option b). */
export async function afterEssentials<T>(filters: StandardFilters, ctx: MentionsContext, run: () => Promise<T>): Promise<T> {
  await mentionsEssentials(filters, ctx);
  return run();
}

// ── conversions ─────────────────────────────────────────────────────────────

/** One brand row -> MentionsBrandLive (+ ownBrandCode for split own rows). */
export function toMentionsBrandLive(item: ApiBrandItem): ApiMentionsBrandLive {
  const out: ApiMentionsBrandLive = {
    brand: item.name,
    mentions: item.mentions,
    prompts: item.prompts ?? 0,
    share: pct1OrZero(item.share),
    mentionRate: pct1OrZero(item.exposure),
    avgPosition: rankAvg(item.avg_rank),
    isTracked: item.is_own,
    sentiment: { ...item.sentiment },
  };
  if (item.multi) out.multi = { mentions: item.multi.mentions, answers: item.multi.answers, prompts: item.multi.prompts };
  if (item.brand_key !== null && item.brand_key !== undefined) out.brandKey = item.brand_key;
  if (item.own_brand_code) out.ownBrandCode = item.own_brand_code;
  return out;
}

/** Own rows' sentiment summed; all four 0 -> null (legacy sentimentSeen). */
export function ownSentimentTotals(brands: readonly ApiBrandItem[]): MentionSentimentBreakdown | null {
  const t = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  for (const b of brands) {
    if (!b.is_own) continue;
    t.positive += b.sentiment.positive;
    t.neutral += b.sentiment.neutral;
    t.negative += b.sentiment.negative;
    t.mixed += b.sentiment.mixed;
  }
  return t.positive + t.neutral + t.negative + t.mixed > 0 ? t : null;
}

function typeBreakdown(counts: Partial<Record<(typeof MENTION_TYPES)[number], number>> | null | undefined): MentionTypeBreakdown {
  return {
    mention: counts?.mention ?? 0,
    recommendation: counts?.recommendation ?? 0,
    comparison: counts?.comparison ?? 0,
    definition: counts?.definition ?? 0,
    final_choice: counts?.final_choice ?? 0,
  };
}

/** by_type own_mentions as the legacy type breakdown; null when the own brand has no mention (legacy typesSeen). */
export function toTypeTotals(types: ApiTypesData, brands: readonly ApiBrandItem[]): MentionTypeBreakdown | null {
  const ownMentions = brands.filter((b) => b.is_own).reduce((s, b) => s + b.mentions, 0);
  if (ownMentions <= 0) return null;
  const byType: Partial<Record<(typeof MENTION_TYPES)[number], number>> = {};
  for (const r of types.by_type) byType[r.type] = r.own_mentions;
  return typeBreakdown(byType);
}

/** types_total + per-brand types (BG-14) -> MentionTypesByBrand; no type signal at all -> null. */
export function toTypesByBrand(data: ApiBrandsData): MentionTypesByBrand | null {
  const totals = typeBreakdown(data.types_total ?? null);
  const sum = MENTION_TYPES.reduce((s, t) => s + totals[t], 0);
  if (sum <= 0) return null;
  return {
    totals,
    brands: data.brands.map((b) => ({ brand: b.name, isTracked: b.is_own, types: typeBreakdown(b.types ?? null) })),
  };
}

/**
 * B3 -> MentionTrend (the bottom "주별 브랜드 언급 수" chart). Series = the trend series of
 * share_of_voice (own first, API order); a point = that round's mention count, its week = the
 * Monday of the round date (rounds of one week are summed, as the legacy same-week fold); gap
 * rounds become gap weeks. Fewer than two valued weeks -> null (buildMentionTrend rule).
 */
export function toMentionTrend(data: TrendResponse["data"]): MentionTrend | null {
  const series = data.series.filter((s) => s.metric === "share_of_voice");
  const own = series.filter((s) => s.is_own);
  const ordered = [...own, ...series.filter((s) => !s.is_own)];
  const labels: string[] = [];
  const entries: { date: string; week: string; brand: string; count: number }[] = [];
  const gapWeeks = new Set<string>();
  const roundOf = new Map(data.buckets.map((b) => [b.key, bucketRoundDate(b)]));
  for (const s of ordered) {
    const label = seriesLabel(s, data);
    if (!labels.includes(label)) labels.push(label);
    for (const p of s.points) {
      const round = roundOf.get(p.bucket) ?? p.bucket;
      if (pointGap(p)) {
        gapWeeks.add(mondayOf(round));
        continue;
      }
      if (!p.ratio) continue;
      entries.push({ date: round, week: mondayOf(round), brand: label, count: p.ratio.num });
    }
  }
  return buildMentionTrend(entries, labels, [...gapWeeks].sort());
}

/** The legacy empty shape (EMPTY_MENTIONS, AGG:5513). */
export function emptyMentionsLive(): MentionsLive {
  return {
    summary: { total: 0, uniqueBrands: 0, totalPrompts: 0 },
    asOf: null,
    brands: [],
    perBrandPrompts: {},
    sentimentTotals: null,
    typeTotals: null,
    hasPosition: false,
    trend: null,
  };
}

export interface MentionsParts {
  brands: Enveloped<ApiBrandsData>;
  types: Enveloped<ApiTypesData> | null;
  summary: SummaryResponse | null;
  /** null = the trend call failed (trendDegraded). */
  trend: TrendResponse | null;
  trendFailed?: boolean;
}

/** The full brand list (B1) was cut at the backend cap (data.truncated or meta.truncated.brands). */
export function brandsTruncated(res: Enveloped<ApiBrandsData>): boolean {
  return res.data.truncated === true || res.meta.truncated?.brands === true;
}

/** B1..B4 -> MentionsLive (field rules in the header). */
export function toMentionsLive(p: MentionsParts): ApiMentionsLive | null {
  if (wholeSuppression(p.brands.meta)) return null;
  const d = p.brands.data;
  if (d.totals.answers === 0) return emptyMentionsLive();
  const brands = d.brands.map(toMentionsBrandLive);
  return {
    summary: {
      total: d.totals.mentions_total,
      uniqueBrands: d.totals.brand_count,
      totalPrompts: p.summary?.data.params.measured_prompts ?? null,
      totalAnswers: d.totals.answers,
    },
    ...(brandsTruncated(p.brands) ? { brandsTotal: d.totals.brand_count } : {}),
    asOf: asOfDate(p.brands.meta),
    brands,
    perBrandPrompts: {},
    sentimentTotals: ownSentimentTotals(d.brands),
    typeTotals: p.types && !wholeSuppression(p.types.meta) ? toTypeTotals(p.types.data, d.brands) : null,
    typesByBrand: toTypesByBrand(d),
    hasPosition: d.brands.some((b) => (b.avg_rank?.count ?? 0) > 0),
    own: { share: pct1OrZero(d.own.share), avgPosition: rankAvg(d.own.avg_rank) },
    trend: p.trend ? toMentionTrend(p.trend.data) : null,
    ...(p.trendFailed ? { trendDegraded: true } : {}),
  };
}

/** Engine rows -> legacy SubKpiEngineRow (null fields -> 0). */
export function toSubKpiRow(r: ApiEngineItem): SubKpiEngineRow {
  const n = (v: number | null | undefined) => v ?? 0;
  const ranked = n(r.ranked);
  return {
    engine: r.engine,
    answers: n(r.answers),
    tracked: n(r.tracked),
    multi: n(r.multi),
    top1: n(r.top1),
    top3: n(r.top3),
    avgPosition: ranked > 0 ? n(r.rank_sum) / ranked : null,
    totalMentions: n(r.total_mentions),
    trackedMentions: n(r.tracked_mentions),
    sentMentions: n(r.sent_mentions),
    positiveMentions: n(r.positive_mentions),
    negativeMentions: n(r.negative_mentions),
    citTotal: n(r.cit_total),
    citOwned: n(r.cit_owned),
  };
}

const MENTION_KEYS = ["visibility", "share_of_voice", "sentiment", "position"];

/** Engine rows for Sub KPI: none when the whole answer or the mention family is suppressed. */
export function toSubKpiRows(engines: Enveloped<ApiEnginesData>): SubKpiEngineRow[] {
  const s = engines.meta.suppressed ?? {};
  if (s["*"] || MENTION_KEYS.some((k) => s[k] === "hidden")) return [];
  return engines.data.rows.map(toSubKpiRow);
}

/** Engine rows + summary params -> StandardSubKpis (buildMentionSubKpis input). */
export function toStandardSubKpis(engines: Enveloped<ApiEnginesData>, summary: SummaryResponse | null): StandardSubKpis {
  const params = summary && !wholeSuppression(summary.meta) ? summary.data.params : null;
  return {
    rows: toSubKpiRows(engines),
    promptsWithoutBrand: params?.prompts_without_brand ?? null,
    measuredPrompts: params ? params.measured_prompts : null,
  };
}

// ── loaders (drop-in for the legacy fetchers) ──────────────────────────────

/**
 * API failure policy of the screens: backend 5xx, timeouts and aborts degrade to `fallback`
 * with the legacy degrade label (lib/scope/degrade-registry); 401/403/404/422 are thrown for
 * the page (throwForPage) or the route.
 */
export async function degrade<T, F>(label: string, run: () => Promise<T>, fallback: F): Promise<T | F> {
  const v = await degradeOnApiFailure(label, run);
  return v === null ? fallback : v;
}

/** Drop-in for fetchStandard/Website/ProjectMentions: MentionsLive | null (ApiMentionsLive, see there). */
export async function loadMentionsLive(filters: StandardFilters, ctx: MentionsContext): Promise<ApiMentionsLive | null> {
  startEssentials(filters, ctx);
  const label = `${ctx.surface}Mentions`;
  const brands = await degradeOnApiFailure(label, () => fetchMentionBrands(filters, ctx));
  if (!brands) return null;
  const [types, summary, trend] = await Promise.all([
    degradeOnApiFailure(`${label}.types`, () => afterEssentials(filters, ctx, () => fetchMentionTypes(filters, ctx))),
    degradeOnApiFailure(`${label}.summary`, () => fetchMentionSummary(filters, ctx)),
    degradeOnApiFailure(`${label}.trend`, () => afterEssentials(filters, ctx, () => fetchBrandTrend(filters, ctx))),
  ]);
  return toMentionsLive({ brands, types, summary, trend, trendFailed: trend === null });
}

/** Which mention reads of this request were transient failures (degrade marks, B034/B035). */
export interface MentionsDegraded {
  /** B1: the body is null because the read failed, not because there is no data. */
  data: boolean;
  /** B2: the type card has no value because the read failed. */
  types: boolean;
  /** B4/B5 and the previous window: Sub KPI cards, the prompt total or the Δ badges are missing. */
  subKpis: boolean;
}

/**
 * The degrade marks of the mention screen loaders (loadMentionsLive, loadSubKpis,
 * loadSubKpisPrev) in this request, for the screen's existing degraded notice. Read it after
 * those loaders settled: the marks are written when a read fails (lib/scope/degrade-registry).
 */
export function mentionsDegraded(ctx: Pick<MentionsContext, "surface">): MentionsDegraded {
  const s = ctx.surface;
  return {
    data: wasDegraded(`${s}Mentions`),
    types: wasDegraded(`${s}Mentions.types`),
    subKpis: [`${s}SubKpis`, `${s}SubKpis.summary`, `${s}SubKpisPrev`, `${s}Mentions.summary`].some((l) => wasDegraded(l)),
  };
}

/** The header "측정 기준일" pill (legacy MentionsLive.asOf): meta.as_of of the B1 call. */
export async function loadMentionsAsOf(filters: StandardFilters, ctx: MentionsContext): Promise<string | null> {
  startEssentials(filters, ctx);
  const res = await degradeOnApiFailure(`${ctx.surface}Mentions`, () => fetchMentionBrands(filters, ctx));
  return res && !wholeSuppression(res.meta) ? asOfDate(res.meta) : null;
}

/** The brand rows the KPI tab reads (same B1 call as the body). */
export async function loadMentionBrandRows(filters: StandardFilters, ctx: MentionsContext): Promise<ApiMentionsBrandLive[]> {
  startEssentials(filters, ctx);
  const res = await degradeOnApiFailure(`${ctx.surface}Mentions`, () => fetchMentionBrands(filters, ctx));
  if (!res || wholeSuppression(res.meta)) return [];
  return res.data.brands.map(toMentionsBrandLive);
}

/** Own-row sentiment (favorability tab sentiment card). */
export async function loadSentimentTotals(filters: StandardFilters, ctx: MentionsContext): Promise<MentionSentimentBreakdown | null> {
  startEssentials(filters, ctx);
  const res = await degradeOnApiFailure(`${ctx.surface}Mentions`, () => fetchMentionBrands(filters, ctx));
  if (!res || wholeSuppression(res.meta)) return null;
  return ownSentimentTotals(res.data.brands);
}

/** typesByBrand (KPI tab type section). */
export async function loadTypesByBrand(filters: StandardFilters, ctx: MentionsContext): Promise<MentionTypesByBrand | null> {
  startEssentials(filters, ctx);
  const res = await degradeOnApiFailure(`${ctx.surface}Mentions`, () => fetchMentionBrands(filters, ctx));
  if (!res || wholeSuppression(res.meta)) return null;
  return toTypesByBrand(res.data);
}

/** Drop-in for fetchStandard/Website/ProjectSubKpis. A failed read is the legacy empty sub (rows []). */
export async function loadSubKpis(filters: StandardFilters, ctx: MentionsContext): Promise<StandardSubKpis> {
  startEssentials(filters, ctx);
  // The engine rows are an essential on website/project (Sub KPI cards) and second stage on global.
  const engineRead = () => fetchEngineRows(filters, ctx);
  const [engines, summary] = await Promise.all([
    degradeOnApiFailure(`${ctx.surface}SubKpis`, () =>
      ctx.surface === "global" ? afterEssentials(filters, ctx, engineRead) : engineRead(),
    ),
    degradeOnApiFailure(`${ctx.surface}SubKpis.summary`, () => fetchMentionSummary(filters, ctx)),
  ]);
  if (!engines) {
    return { rows: [], promptsWithoutBrand: null, measuredPrompts: summary ? summary.data.params.measured_prompts : null };
  }
  return toStandardSubKpis(engines, summary);
}

/** The first round of the window (meta.cycles), or null. */
export function firstCycle(meta: ApiMeta | null | undefined): string | null {
  const cycles = [...(meta?.cycles ?? [])].sort();
  return cycles[0] ?? null;
}

/**
 * Drop-in for fetchWebsite/ProjectSubKpisPrev: the Sub KPI of the comparison point.
 * Cumulative (both ends): the window up to its first round (legacy: up to the first measure
 * day), null with fewer than two rounds. Snapshot: cycle_offset=1 (legacy: previous measure day).
 */
export async function loadSubKpisPrev(filters: StandardFilters, ctx: MentionsContext): Promise<PrevSubKpis | null> {
  return degrade(
    `${ctx.surface}SubKpisPrev`,
    () =>
      afterEssentials(filters, ctx, async () => {
        if (filters.dateFrom || filters.dateTo) {
          const cur = await fetchMentionSummary(filters, ctx);
          const cycles = [...new Set(cur.meta.cycles ?? [])].sort();
          if (cycles.length < 2) return null;
          const first = cycles[0];
          const from = filters.dateFrom && filters.dateFrom <= first ? filters.dateFrom : first;
          const prevFilters: StandardFilters = { ...filters, dateFrom: from, dateTo: first };
          const [engines, summary] = await Promise.all([
            fetchEngineRows(prevFilters, ctx),
            fetchMentionSummary(prevFilters, ctx),
          ]);
          return { sub: toStandardSubKpis(engines, summary), asOf: first };
        }
        const [engines, summary] = await Promise.all([
          fetchEngineRows(filters, ctx, { cycleOffset: 1 }),
          fetchMentionSummary(filters, ctx, { cycleOffset: 1 }),
        ]);
        if (wholeSuppression(engines.meta) || !engines.meta.as_of) return null;
        return { sub: toStandardSubKpis(engines, summary), asOf: engines.meta.as_of };
      }),
    null,
  );
}

/**
 * Designated comparison brand of a project (legacy getTargetBrand): ProjectDetail.target_brand
 * (BG-38), the same GET /v1/projects/{id} as the project gate (shared in the request).
 * 404 (hidden project) -> null, like the legacy lookup of a missing row.
 */
export async function loadDesignatedTargetBrand(projectId: string): Promise<string | null> {
  try {
    const res = await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: projectId } });
    return res.data.target_brand ?? null;
  } catch (e) {
    if (isHghApiError(e) && e.status === 404) return null;
    throw e;
  }
}
