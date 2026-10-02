import "server-only";

// Analysis common adapter, part 4 (unit U4): summary cards (K-1 GET /v1/kpi/summary) in the
// shape the screens already render: KpiSummary[] of buildMirrorKpis (dashboard/_data/live.ts:278)
// plus the website/project URL-rate cards (website/_data/live.ts:65) and the measurement
// overview counts. Design 3.3, appendix A R-ratio, R-rank, R-supp.
//
// Card rules (same values as buildMirrorKpis on the same counts):
//   ① visibility     value pct(num, den) (Math.round(n/d*1000)/10), ratio {num, den} always
//   ② shareOfVoice   value pct; den 0 -> value 0 and no ratio (legacy), ratio only when den > 0
//   ③ sentiment      value round1(100 * positive / signals); den 0 -> null, no ratio
//   ④ position       value round1(sum / count); count 0 -> null. ratio {sum, count}: the true rank
//                    sum (legacy re-derived round(avg * count), off by rounding when count > 10)
//   ⑤ citationShare  value pct; den 0 -> null, ratio only when den > 0
//   A metric in meta.suppressed as hidden (or any reason other than no_data) -> value null and no
//   ratio ("측정 대기"): the legacy never served hidden rounds, so it had no such case.
//   delta null / direction flat: Δ comes from the trend (applyTrendDeltas) as today.
// Website/project cards (Q5):
//   ownedUrlRate / targetUrlRate  website: per prompt from data.url_prompts (DC-02 decision 6,
//                    urlPromptRates); project: the measurement Ratio, value round1(100 * num / den),
//                    den 0 -> null; provenance from meta.source (url_rates report -> published
//                    with the BG-26 round label, round_date, site_count; live -> live)
//   citationAccuracy value round1(100 * num / den) (num = target and own, den = own), no provenance
// Empty state (R-supp): meta.suppressed['*'] (no_active_snapshot, ...) or params.answers == 0 is
// the legacy `agg == null || totalAnswers === 0` (whole screen empty).
// Competitor SOV (KPI #16, legacy applyCompetitorSov live.ts:356): applyCompetitorSovFromBrands
// takes GET /v1/mentions/brands items; own mentions = share_of_voice numerator; HMG siblings are
// excluded by BG-15 is_hmg_own (request include=hmg), never by name.
//
// Known differences. Design DC list (front-adapter-plan 3.6 (나)):
//   DC-01  engine[] empty = default engine only (legacy: all engines)
//   (DC-02 resolved by decision 6, "현행 문구 유지": the website URL-rate cards read url_prompts,
//   the legacy prompt unit and wording; target_url_rate / owned_url_rate stay per measurement for
//   the project cards)
//   DC-04  admin brand[] changes the perspective (own) and the global base includes the umbrella
//   (DC-21 resolved: ④ = rank sum / ranked answers (D5) on both sides; the legacy KPI tab joined
//   that competition rank definition in hmg-geo 6bc5c54, sync S1 FA-4)
// Outside the DC list (U4 numbering, for the A4 notice; asserted in summary.test.ts KNOWN_DIFF):
//   U4-N6  ④ card ratio numerator = the true rank sum (the value itself is round1(sum / count)).
//          The legacy re-derived it as round(avg x count) and was off by rounding when count > 10
//          (105 / 20: legacy 106). It is the numerator of the position definition shown under the card
//   U4-N7  a hidden round (suppressed hidden, or any reason other than no_data) is a null card
//          ("측정 대기"); the legacy never served hidden rounds, so it had no such state
import type { KpiProvenance, KpiSummary } from "@/app/[locale]/(dash)/dashboard/_data/sample";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { components } from "../api-types";
import { hghGet } from "../client";
import {
  asOfDate,
  filterNotices,
  pct1OrNull,
  pct1OrZero,
  rankAvg,
  suppressionOf,
  wholeSuppression,
  type ApiMeta,
  type FilterNotices,
  type Ratio,
  type SuppressReason,
} from "../convert";
import { cardParam, withParams } from "../query";
import { analysisQuery, type AnalysisQueryContext } from "./filters";

type S = components["schemas"];
export type ApiSummaryData = S["SummaryData"];
export type ApiBrandItem = S["BrandItem"];

export interface SummaryRequest extends AnalysisQueryContext {
  /** Snapshot only: 0 latest exposed round (default), 1 the previous one. */
  cycleOffset?: 0 | 1;
  /** BG-08: params.measured_by_funnel (project composition donut). */
  byFunnel?: boolean;
  /** WU-3 card path (cardParam): the dashboard cards only, never the answer-analysis tabs. */
  card?: boolean;
}

export interface SummaryResponse {
  data: ApiSummaryData;
  meta: ApiMeta;
}

/** GET /v1/kpi/summary for the screen's filters (one call; header pill and cards share it). */
export async function fetchKpiSummary(filters: StandardFilters, req: SummaryRequest): Promise<SummaryResponse> {
  const { cycleOffset, byFunnel, card, ...ctx } = req;
  const { query, cf } = analysisQuery(filters, ctx);
  const extra: { cycle_offset?: number; by_funnel?: boolean; card?: true } = { ...cardParam(ctx.surface, card) };
  if (cycleOffset) extra.cycle_offset = cycleOffset;
  if (byFunnel) extra.by_funnel = true;
  const res = await hghGet("/v1/kpi/summary", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

type CardKey = "visibility" | "share_of_voice" | "sentiment" | "position" | "citation_share";

/** A card blocked by suppression other than "no data" (hidden, unsupported, ...). */
function blocked(meta: ApiMeta | null | undefined, key: CardKey | string): SuppressReason | null {
  const r = suppressionOf(meta, key);
  return r && r !== "no_data" ? r : null;
}

const card = (key: KpiSummary["key"], value: number | null, ratio?: KpiSummary["ratio"]): KpiSummary => ({
  key,
  value,
  delta: null,
  direction: "flat",
  ...(ratio ? { ratio } : {}),
});

const ratioPair = (r: Ratio) => ({ numerator: r.num, denominator: r.den });

/** ①~⑤ in buildMirrorKpis order and shape (see the header rules). */
export function toMirrorKpis(data: ApiSummaryData, meta: ApiMeta | null | undefined): KpiSummary[] {
  const vis = blocked(meta, "visibility") ? null : data.visibility;
  const sov = blocked(meta, "share_of_voice") ? null : data.share_of_voice;
  const sen = blocked(meta, "sentiment") ? null : data.sentiment;
  const pos = blocked(meta, "position") ? null : data.position;
  const cit = blocked(meta, "citation_share") ? null : data.citation_share;
  const answers = data.params.answers;

  // ① den 0 is "no data" (the API sends null + no_data): legacy pct(tracked, 0) = 0 with {0, 0}.
  const visCard = blocked(meta, "visibility")
    ? card("visibility", null)
    : vis
      ? card("visibility", pct1OrZero(vis), ratioPair(vis))
      : card("visibility", 0, { numerator: 0, denominator: answers });
  // ② no mentions: legacy value 0, ratio undefined.
  const sovCard = blocked(meta, "share_of_voice")
    ? card("shareOfVoice", null)
    : sov && sov.den > 0
      ? card("shareOfVoice", pct1OrZero(sov), ratioPair(sov))
      : card("shareOfVoice", 0);
  const senValue = pct1OrNull(sen);
  const sentimentCard = card("sentiment", senValue, sen && senValue !== null ? ratioPair(sen) : undefined);
  const posValue = rankAvg(pos);
  const positionCard = card(
    "position",
    posValue,
    pos && posValue !== null ? { numerator: pos.sum, denominator: pos.count } : undefined,
  );
  const citationCard =
    cit && cit.den > 0 ? card("citationShare", pct1OrZero(cit), ratioPair(cit)) : card("citationShare", null);
  return [visCard, sovCard, sentimentCard, positionCard, citationCard];
}

/**
 * meta.source -> KpiProvenance (legacy website promptRates.source / publication). Published:
 * the first publication detail's labels (BG-26), round_date, site_count. Live: source only.
 * No meta.source (global, or a hidden window) -> undefined.
 */
export function provenanceOf(meta: ApiMeta | null | undefined): KpiProvenance | undefined {
  const src = meta?.source as
    | {
        url_rates?: string;
        round_date?: string;
        site_count?: number;
        publication_details?: { cycle_label?: string | null; cycle_label_en?: string | null }[];
      }
    | null
    | undefined;
  if (!src?.url_rates) return undefined;
  if (src.url_rates !== "report") return { source: "live", cycleLabel: null, cycleLabelEn: null };
  const d = src.publication_details?.[0];
  return {
    source: "published",
    cycleLabel: d?.cycle_label ?? null,
    cycleLabelEn: d?.cycle_label_en ?? null,
    ...(src.round_date ? { roundDate: src.round_date } : {}),
    ...(typeof src.site_count === "number" ? { siteCount: src.site_count } : {}),
  };
}

export interface UrlRateKpis {
  ownedUrlRate: KpiSummary;
  targetUrlRate: KpiSummary;
  citationAccuracy: KpiSummary;
  /**
   * Unit of ownedUrlRate / targetUrlRate: "prompt" on website (url_prompts, the legacy wording),
   * "measurement" on project (the api wording, copyVariant "api").
   */
  unit: "prompt" | "measurement";
}

/** The legacy WebsitePromptHitRates numbers (lib/scope/server.ts fetchWebsiteTargetHitRate). */
export interface UrlPromptRates {
  hitPrompts: number;
  ownedPrompts: number;
  measuredPrompts: number;
  /** Target URL rate (%), null when no measured prompt ("측정 대기"). */
  rate: number | null;
  /** Owned URL rate (%), same denominator. */
  ownedRate: number | null;
}

const EMPTY_URL_PROMPT_RATES: UrlPromptRates = { hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null };

/**
 * DC-02, decision 6 ("현행 문구 유지"): the website owned / target URL rates per prompt, from
 * data.url_prompts (owned_prompts or target_prompts over measured_prompts, the two cards share the
 * denominator). Rounding follows the legacy source of the value, bit for bit: a published value
 * (meta.source url_rates report, legacy publishedSubtotal) used sb-data pct1
 * Math.round(n / d * 1000) / 10; a live value (summary-website-aggregates, scope-aggregates
 * aggregateWebsiteTargetHitRate) used round1(100 * n / d). url_prompts null (meta.suppressed
 * url_prompts: hidden, no_data) -> zeros and null rates, the legacy EMPTY_WEBSITE_PROMPT_HIT_RATES.
 */
export function urlPromptRates(data: ApiSummaryData, meta: ApiMeta | null | undefined): UrlPromptRates {
  const u = data.url_prompts;
  if (!u || !(u.measured_prompts > 0)) return { ...EMPTY_URL_PROMPT_RATES, measuredPrompts: u?.measured_prompts ?? 0 };
  const report = (meta?.source as { url_rates?: string } | null | undefined)?.url_rates === "report";
  const rate = (n: number): number => {
    const r = { num: n, den: u.measured_prompts };
    return report ? pct1OrZero(r) : (pct1OrNull(r) ?? 0);
  };
  return {
    hitPrompts: u.target_prompts,
    ownedPrompts: u.owned_prompts,
    measuredPrompts: u.measured_prompts,
    rate: rate(u.target_prompts),
    ownedRate: rate(u.owned_prompts),
  };
}

/**
 * Website/project URL-rate cards (M07, M06, citation accuracy). null on global (not_website_surface).
 * Website owned / target cards are per prompt (urlPromptRates, DC-02 decision 6), as the legacy
 * website/_data/live.ts cards: value = rate, ratio {prompts, measured prompts} only when measured > 0.
 */
export function toUrlRateKpis(data: ApiSummaryData, meta: ApiMeta | null | undefined): UrlRateKpis | null {
  // global: no such cards (the backend marks the three URL metrics not_website_surface).
  if (meta?.surface === "global" || meta?.suppressed?.owned_url_rate === "not_website_surface") return null;
  const provenance = provenanceOf(meta);
  const withProvenance = (c: KpiSummary): KpiSummary => (provenance ? { ...c, provenance } : c);
  const accValue = pct1OrNull(data.citation_accuracy);
  const citationAccuracy = card(
    "citationAccuracy",
    accValue,
    data.citation_accuracy && accValue !== null ? ratioPair(data.citation_accuracy) : undefined,
  );
  if (meta?.surface === "website") {
    const p = urlPromptRates(data, meta);
    const pair = (n: number) => (p.measuredPrompts > 0 ? { numerator: n, denominator: p.measuredPrompts } : undefined);
    return {
      ownedUrlRate: withProvenance(card("ownedUrlRate", p.ownedRate, pair(p.ownedPrompts))),
      targetUrlRate: withProvenance(card("targetUrlRate", p.rate, pair(p.hitPrompts))),
      citationAccuracy,
      unit: "prompt",
    };
  }
  const rate = (key: "ownedUrlRate" | "targetUrlRate", r: Ratio | null): KpiSummary =>
    withProvenance(card(key, pct1OrNull(r), r && r.den > 0 ? ratioPair(r) : undefined));
  return {
    ownedUrlRate: rate("ownedUrlRate", data.owned_url_rate),
    targetUrlRate: rate("targetUrlRate", data.target_url_rate),
    citationAccuracy,
    unit: "measurement",
  };
}

/** Legacy "no live data" (agg null or totalAnswers 0): whole-answer suppression or no answers. */
export function summaryIsEmpty(data: ApiSummaryData, meta: ApiMeta | null | undefined): boolean {
  return wholeSuppression(meta) !== null || data.params.answers === 0;
}

export interface SummaryParamsView {
  /** std_in answers (M12 base). */
  answers: number;
  /** Applied prompts (catalog / registration, measurement-independent). */
  appliedPrompts: number;
  /** Measured prompts (legacy measuredPrompts). */
  measuredPrompts: number;
  /** BG-06: measured prompts without a perspective-brand mention, null when hidden or empty. */
  promptsWithoutBrand: number | null;
  /** BG-08 (by_funnel): measured prompts per funnel stage, null unless requested. */
  measuredByFunnel: { funnel: string | null; measuredPrompts: number }[] | null;
}

export interface KpiSummaryView {
  /** meta.as_of: the header "측정 기준일" pill (legacy agg.asOf). */
  asOf: string | null;
  mode: ApiMeta["mode"];
  /** Round dates in the window (meta.cycles). */
  cycles: string[];
  /** Whole screen empty (R-supp). */
  empty: boolean;
  /** Why empty: the '*' reason, "no_answers" for answers 0, else null. */
  emptyReason: SuppressReason | "no_answers" | null;
  /** ①~⑤ (buildMirrorKpis shape). */
  kpis: KpiSummary[];
  /** Website/project URL-rate cards; null on global. */
  urlRates: UrlRateKpis | null;
  params: SummaryParamsView;
  /** A16 analysis gap: gap / base answers, rate as one-decimal percent (null when base 0). */
  analysisGap: { gapAnswers: number; baseAnswers: number; rate: number | null };
  provenance: KpiProvenance | undefined;
  /** meta.suppressed as given (metric key -> reason). */
  suppressed: Record<string, string>;
  /** "Not applied" marks: ignored_filters (axis unused by this surface), dropped_filters. */
  notices: FilterNotices;
}

export function toKpiSummaryView(res: SummaryResponse): KpiSummaryView {
  const { data, meta } = res;
  const whole = wholeSuppression(meta);
  const empty = summaryIsEmpty(data, meta);
  return {
    asOf: asOfDate(meta),
    mode: meta.mode,
    cycles: [...(meta.cycles ?? [])],
    empty,
    emptyReason: whole ?? (data.params.answers === 0 ? "no_answers" : null),
    kpis: toMirrorKpis(data, meta),
    urlRates: toUrlRateKpis(data, meta),
    params: {
      answers: data.params.answers,
      appliedPrompts: data.params.applied_prompts,
      measuredPrompts: data.params.measured_prompts,
      promptsWithoutBrand: data.params.prompts_without_brand ?? null,
      measuredByFunnel:
        data.params.measured_by_funnel?.map((f) => ({ funnel: f.funnel ?? null, measuredPrompts: f.measured_prompts })) ?? null,
    },
    analysisGap: {
      gapAnswers: data.analysis_gap.gap_answers,
      baseAnswers: data.analysis_gap.base_answers,
      rate: pct1OrNull({ num: data.analysis_gap.gap_answers, den: data.analysis_gap.base_answers }),
    },
    provenance: provenanceOf(meta),
    suppressed: { ...(meta.suppressed ?? {}) },
    notices: filterNotices(meta),
  };
}

/** fetchKpiSummary + toKpiSummaryView. */
export async function loadKpiSummary(filters: StandardFilters, req: SummaryRequest): Promise<KpiSummaryView> {
  return toKpiSummaryView(await fetchKpiSummary(filters, req));
}

/**
 * KPI #16 on the shareOfVoice card (legacy applyCompetitorSov): our mentions (share_of_voice
 * numerator) / the reference brand's mentions x 100, one decimal. Reference = the designated
 * target (project is_target, matched by name ignoring case, mentions 0 when absent -> value null)
 * or else the most-mentioned competitor that is neither own nor an HMG sibling (is_hmg_own,
 * BG-15). No competitor at all -> cards unchanged. Cards without shareOfVoice pass through.
 */
export function applyCompetitorSovFromBrands(
  kpis: KpiSummary[],
  ownMentions: number | null,
  brands: readonly Pick<ApiBrandItem, "name" | "mentions" | "is_own" | "is_hmg_own">[],
  designatedTarget?: string | null,
): KpiSummary[] {
  const competitors = brands.filter((b) => !b.is_own && b.is_hmg_own !== true);
  const target = designatedTarget
    ? (competitors.find((b) => b.name.toLowerCase() === designatedTarget.toLowerCase()) ?? {
        name: designatedTarget,
        mentions: 0,
      })
    : [...competitors].sort((a, b) => b.mentions - a.mentions)[0];
  if (!target) return kpis;
  const ours = ownMentions ?? 0;
  const competitorSov = {
    brand: target.name,
    value: target.mentions > 0 ? Math.round((1000 * ours) / target.mentions) / 10 : null,
  };
  return kpis.map((k) => (k.key === "shareOfVoice" ? { ...k, competitorSov } : k));
}
