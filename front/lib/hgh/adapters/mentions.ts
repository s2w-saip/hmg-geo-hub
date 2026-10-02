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
//                               include=multi,prompts,types (BG-12, BG-13, BG-14)
//   B2 GET /v1/mentions/types   (typeTotals; merged perspective = legacy tracked rollup)
//   B3 GET /v1/trend            bucket=cycle, dimension=brand, metrics=visibility,share_of_voice,
//                               position, top=10, split_own=true (the KPI tab and the bottom chart
//                               share it: 정합 3)
//   B4 GET /v1/kpi/summary      (U4 fetchKpiSummary: measured/applied prompts, BG-06 prompts_without_brand)
//   B5 GET /v1/kpi/engines      part=all (Sub KPI rows; the KPI tab reuses the same answer)
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
//   summary.totalPrompts ← B4 params.measured_prompts ; totalAnswers ← totals.answers
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
//   U6-N1  the full brand list is capped at 2000 competitor rows (legacy: every brand). Above
//          it data.truncated is set and the table shows the first 2000 (BG-19 full)
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
import { degradeOnApiFailure } from "@/lib/scope/degrade-registry";
import type { components } from "../api-types";
import { hghGet } from "../client";
import { asOfDate, pct1OrZero, rankAvg, wholeSuppression, type ApiMeta } from "../convert";
import { isHghApiError } from "../errors";
import { withParams } from "../query";
import { analysisQuery, fetchFilterDates, type AnalysisQueryContext } from "./filters";
import { fetchKpiSummary, type SummaryResponse } from "./summary";
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

export interface BrandsRequest {
  top_n?: number;
  sort?: "mentions" | "share" | "avg_rank";
  split_own?: boolean;
  full?: boolean;
  include?: readonly ("prompts" | "multi" | "types" | "hmg")[];
  group_by?: "engine";
}

/** GET /v1/mentions/brands for the screen filters (default: the table call B1). */
export async function fetchMentionBrands(
  filters: StandardFilters,
  ctx: MentionsContext,
  req: BrandsRequest = BRANDS_TABLE,
): Promise<Enveloped<ApiBrandsData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const extra: {
    top_n?: number;
    sort?: "mentions" | "share" | "avg_rank";
    split_own?: boolean;
    full?: boolean;
    include?: ("prompts" | "multi" | "types" | "hmg")[];
    group_by?: "engine";
  } = {};
  if (req.top_n !== undefined) extra.top_n = req.top_n;
  if (req.sort) extra.sort = req.sort;
  if (req.split_own) extra.split_own = true;
  if (req.full) extra.full = true;
  if (req.include?.length) extra.include = [...req.include];
  if (req.group_by) extra.group_by = req.group_by;
  const res = await hghGet("/v1/mentions/brands", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

/** GET /v1/mentions/types (merged perspective, as the legacy tracked rollup). */
export async function fetchMentionTypes(filters: StandardFilters, ctx: MentionsContext): Promise<Enveloped<ApiTypesData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/mentions/types", { query, cf });
  return { data: res.data, meta: res.meta };
}

export type EnginesPart = "all" | "exposure" | "sov" | "favorability" | "position" | "citation";

/** GET /v1/kpi/engines part=all (the Sub KPI rows and the KPI tab engine scalars share it). */
export async function fetchEngineRows(
  filters: StandardFilters,
  ctx: MentionsContext,
  opts: { cycleOffset?: 0 | 1; part?: EnginesPart } = {},
): Promise<Enveloped<ApiEnginesData>> {
  const { query, cf } = analysisQuery(filters, ctx);
  const extra: { part: EnginesPart; cycle_offset?: number } = { part: opts.part ?? "all" };
  if (opts.cycleOffset) extra.cycle_offset = opts.cycleOffset;
  const res = await hghGet("/v1/kpi/engines", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

/** B3: the brand trend shared by the KPI tab (brand, first rank) and the bottom weekly chart. */
export const BRAND_TREND_METRICS = ["visibility", "share_of_voice", "position"] as const;

export function fetchBrandTrend(filters: StandardFilters, ctx: MentionsContext): Promise<TrendResponse> {
  return fetchTrend(filters, {
    ...ctx,
    bucket: "cycle",
    dimension: "brand",
    metrics: BRAND_TREND_METRICS,
    top: 10,
    splitOwn: true,
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
      fetchKpiSummary(filters, ctx),
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

/** B1..B4 -> MentionsLive (field rules in the header). */
export function toMentionsLive(p: MentionsParts): MentionsLive | null {
  if (wholeSuppression(p.brands.meta)) return null;
  const d = p.brands.data;
  if (d.totals.answers === 0) return emptyMentionsLive();
  const brands = d.brands.map(toMentionsBrandLive);
  return {
    summary: {
      total: d.totals.mentions_total,
      uniqueBrands: d.totals.brand_count,
      totalPrompts: p.summary?.data.params.measured_prompts ?? 0,
      totalAnswers: d.totals.answers,
    },
    asOf: asOfDate(p.brands.meta),
    brands,
    perBrandPrompts: {},
    sentimentTotals: ownSentimentTotals(d.brands),
    typeTotals: p.types && !wholeSuppression(p.types.meta) ? toTypeTotals(p.types.data, d.brands) : null,
    typesByBrand: toTypesByBrand(d),
    hasPosition: d.brands.some((b) => (b.avg_rank?.count ?? 0) > 0),
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

/** Drop-in for fetchStandard/Website/ProjectMentions: MentionsLive | null. */
export async function loadMentionsLive(filters: StandardFilters, ctx: MentionsContext): Promise<MentionsLive | null> {
  startEssentials(filters, ctx);
  const label = `${ctx.surface}Mentions`;
  const brands = await degradeOnApiFailure(label, () => fetchMentionBrands(filters, ctx));
  if (!brands) return null;
  const [types, summary, trend] = await Promise.all([
    degradeOnApiFailure(`${label}.types`, () => afterEssentials(filters, ctx, () => fetchMentionTypes(filters, ctx))),
    degradeOnApiFailure(`${label}.summary`, () => fetchKpiSummary(filters, ctx)),
    degradeOnApiFailure(`${label}.trend`, () => afterEssentials(filters, ctx, () => fetchBrandTrend(filters, ctx))),
  ]);
  return toMentionsLive({ brands, types, summary, trend, trendFailed: trend === null });
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
    degradeOnApiFailure(`${ctx.surface}SubKpis.summary`, () => fetchKpiSummary(filters, ctx)),
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
          const cur = await fetchKpiSummary(filters, ctx);
          const cycles = [...new Set(cur.meta.cycles ?? [])].sort();
          if (cycles.length < 2) return null;
          const first = cycles[0];
          const from = filters.dateFrom && filters.dateFrom <= first ? filters.dateFrom : first;
          const prevFilters: StandardFilters = { ...filters, dateFrom: from, dateTo: first };
          const [engines, summary] = await Promise.all([
            fetchEngineRows(prevFilters, ctx),
            fetchKpiSummary(prevFilters, ctx),
          ]);
          return { sub: toStandardSubKpis(engines, summary), asOf: first };
        }
        const [engines, summary] = await Promise.all([
          fetchEngineRows(filters, ctx, { cycleOffset: 1 }),
          fetchKpiSummary(filters, { ...ctx, cycleOffset: 1 }),
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
