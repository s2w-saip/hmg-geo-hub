import "server-only";

// Analysis common adapter, part 2 (unit U4): period comparison (K-2 GET /v1/kpi/compare) in
// the shape of the legacy fetchPeriodCompare (lib/scope/server.ts:5568) -> CompareResult[]
// (lib/kpi/period-compare.ts:243). Design 3.3 dashboard row, appendix A /dashboard row.
//
// Call rule (legacy selectedWindow, server.ts:5526-5532): no call and null unless the URL
// period has both ends (dateFrom <= dateTo). null means "draw the previous Δ" to the screens,
// exactly as before. The backend resolves the windows itself from from/to and kind, so the
// legacy months/weeks inputs are not sent; `days` is ignored by the backend when from/to exist.
//
// Field map (CompareItem -> CompareResult):
//   metric  share_of_voice -> share, sentiment -> favorability, visibility/position kept,
//           mentions_per_answer -> mentionsPerAnswer, citations_per_answer -> citationsPerAnswer;
//           citation_share has no legacy key (the legacy compare never had it): dropped
//   prev/cur Ratio{num,den} -> num/den (a fraction, no x100; den 0 -> null),
//           RankAvg{sum,count} -> sum/count (count 0 -> null): legacy ratio of interval sums
//   delta, unit, suppressed, reason (same six codes) as is
//   cycles_prev/_cur, planned_prev/_cur, missing_share_prev/_cur -> camelCase
//   family: dropped (the backend decides it per metric; legacy passed it per screen)
// Results follow the requested metric order (legacy: "결과는 이 순서를 따른다").
//
// Current-profile reproduction (WU-9, decisions 19/24/25: same values and display as production
// hmg-geo 2670a16 with read_screens incl. S1.periodCompare, no exceptions):
//   epoch gate   backend switch compare_epoch_gate: cur.hi < 2026-09-08 -> data [] and
//                meta.suppressed["*"] = "before_epoch"; this adapter returns null there, the legacy
//                "cur.hi < PERIOD_COMPARE_EPOCH -> null = previous Δ" (lib/scope/server.ts:5959).
//                With the switch off the backend never sends it (was DC-16: the API always compared)
//   unsupported  backend switch compare_suppress: the combinations the legacy summary tables could not
//                read (depth2, depth3, several but not all own brands) come back as reason
//                "unsupported" on every metric, mapped as is, so the chip shows "―" (was U4-N1)
//   delta        recomputed here from the integer pairs with the legacy deltaOf
//                (lib/kpi/period-compare.ts:538: raw difference, the chip rounds). The backend delta
//                is round1 with a float guard, which showed one tenth more at exact .x5 deltas
//                (250/400 -> 263/400: legacy 3.2pp, backend 3.3pp; was U4-N2). null when suppressed
// Known differences left. Design DC list (front-adapter-plan 3.6 (나)):
//   DC-01  engine[] empty = the default engine only. Legacy (2670a16, 14 keys) = every engine: the compare
//          reader reuses the summary trendWhere, which filters engines only when chosen
//          (summary-trend-aggregates.ts:730). The backend reproduces it for card=true requests when the
//          legacy profile switch summary_all_engines is on (WU-3). This call sends card=true on global
//          and website (cardParam): every legacy caller of fetchPeriodCompare read the summary tables
//          (lib/scope/server.ts:5921-6058 -> cachedPeriodCompare, whatever the screen: dashboard,
//          website, mention, citation), so DC-01 is closed with the switch on. Left to the backend:
//          the compare windows have no slot rule (card_slot_rep narrows the period window, not these).
import type { CompareKind, CompareMetricKey, CompareResult, SuppressionReason } from "@/lib/kpi/period-compare";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { components } from "../api-types";
import { hghGet } from "../client";
import { filterNotices, type FilterNotices } from "../convert";
import { cardParam, withParams } from "../query";
import { analysisQuery, hasClosedPeriod, type AnalysisQueryContext } from "./filters";

type S = components["schemas"];
export type ApiCompareItem = S["CompareItem"];
export type ApiCompareMeta = S["CompareMeta"];
export type ApiCompareMetric = ApiCompareItem["metric"];
export type ApiCompareKind = S["CompareInfo"]["kind"];

/** Legacy metric key -> API metric name (request). */
export const COMPARE_METRIC_TO_API: Readonly<Record<CompareMetricKey, ApiCompareMetric>> = {
  visibility: "visibility",
  share: "share_of_voice",
  favorability: "sentiment",
  position: "position",
  mentionsPerAnswer: "mentions_per_answer",
  citationsPerAnswer: "citations_per_answer",
};

/** API metric name -> legacy key (response). citation_share has none. */
export const API_METRIC_TO_COMPARE: Readonly<Partial<Record<ApiCompareMetric, CompareMetricKey>>> = {
  visibility: "visibility",
  share_of_voice: "share",
  sentiment: "favorability",
  position: "position",
  mentions_per_answer: "mentionsPerAnswer",
  citations_per_answer: "citationsPerAnswer",
};

type Measure = ApiCompareItem["cur"];

/** Ratio -> num/den, RankAvg -> sum/count; empty denominator -> null (legacy computeCompare). */
export function compareMeasureValue(m: Measure | null | undefined): number | null {
  if (!m) return null;
  if ("den" in m) return m.den > 0 ? m.num / m.den : null;
  return m.count > 0 ? m.sum / m.count : null;
}

/**
 * Legacy deltaOf (lib/kpi/period-compare.ts:538, not exported): pp = (cur - prev) x 100,
 * rank = cur - prev, pct = (cur - prev) / prev x 100 (null when prev is 0). Unrounded: the chip
 * rounds, so exact .x5 boundaries fall on the same side as the legacy float arithmetic.
 */
export function legacyCompareDelta(unit: ApiCompareItem["unit"], prev: number | null, cur: number | null): number | null {
  if (prev == null || cur == null) return null;
  if (unit === "pp") return (cur - prev) * 100;
  if (unit === "rank") return cur - prev;
  if (prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

/** Response marker of the current-profile epoch gate (back kpi/compare/logic.py EPOCH_GATED). */
export const COMPARE_EPOCH_GATED = "before_epoch";

/** One CompareItem -> CompareResult, or null for a metric the legacy screens never had. */
export function toCompareResult(item: ApiCompareItem): CompareResult | null {
  const metric = API_METRIC_TO_COMPARE[item.metric];
  if (!metric) return null;
  const prev = compareMeasureValue(item.prev);
  const cur = compareMeasureValue(item.cur);
  return {
    metric,
    unit: item.unit,
    prev,
    cur,
    // legacy computeCompare: suppressed -> null, otherwise deltaOf on the two ratios
    delta: item.suppressed ? null : legacyCompareDelta(item.unit, prev, cur),
    suppressed: item.suppressed,
    reason: (item.reason ?? null) as SuppressionReason | null,
    cyclesPrev: item.cycles_prev,
    cyclesCur: item.cycles_cur,
    plannedPrev: item.planned_prev,
    plannedCur: item.planned_cur,
    missingSharePrev: item.missing_share_prev,
    missingShareCur: item.missing_share_cur,
  };
}

/** Items -> results in the requested order (a requested metric the answer lacks is skipped). */
export function toCompareResults(items: readonly ApiCompareItem[], requested: readonly CompareMetricKey[]): CompareResult[] {
  const byMetric = new Map<CompareMetricKey, CompareResult>();
  for (const item of items) {
    const r = toCompareResult(item);
    if (r && !byMetric.has(r.metric)) byMetric.set(r.metric, r);
  }
  const out: CompareResult[] = [];
  for (const m of requested) {
    const r = byMetric.get(m);
    if (r) out.push(r);
  }
  return out;
}

export interface PeriodCompareRequest extends AnalysisQueryContext {
  /** resolveRequestComparePeriodShape(...).kind (or "cycle", which the legacy never used). */
  kind: CompareKind | "cycle";
  metrics: readonly CompareMetricKey[];
}

export interface PeriodCompareView {
  results: CompareResult[];
  /** meta.compare: kind, the resolved windows, first published rounds. */
  compare: ApiCompareMeta["compare"];
  notices: FilterNotices;
}

/**
 * GET /v1/kpi/compare for the screen's filters. null (no call) unless the period has both
 * ends, the legacy "기간 미선택 = 종전 Δ" rule. Also null when the backend reports the epoch gate
 * (meta.suppressed["*"] = "before_epoch"), the legacy "적용일 이전 = 종전 Δ" rule.
 */
export async function fetchPeriodCompareView(
  filters: StandardFilters,
  req: PeriodCompareRequest,
): Promise<PeriodCompareView | null> {
  if (!hasClosedPeriod(filters)) return null;
  const { kind, metrics, ...ctx } = req;
  const { query, cf } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/kpi/compare", {
    query: withParams(query, {
      kind,
      metrics: [...new Set(metrics.map((m) => COMPARE_METRIC_TO_API[m]))],
      ...cardParam(ctx.surface, true),
    }),
    cf,
  });
  if (res.meta.suppressed?.["*"] === COMPARE_EPOCH_GATED) return null;
  return {
    results: toCompareResults(res.data, metrics),
    compare: res.meta.compare,
    notices: filterNotices(res.meta),
  };
}

/** Drop-in for the legacy fetchPeriodCompare(filters, opts): CompareResult[] | null. */
export async function fetchPeriodCompareApi(
  filters: StandardFilters,
  req: PeriodCompareRequest,
): Promise<CompareResult[] | null> {
  return (await fetchPeriodCompareView(filters, req))?.results ?? null;
}
