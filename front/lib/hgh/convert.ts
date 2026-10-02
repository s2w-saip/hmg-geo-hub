// Shared shape conversions (design 2.5 and 3.2): API envelope pieces -> the values the
// existing screens already consume. Pure functions; adapters combine them.
//
// Percent rounding: the two legacy helpers round the same ratio differently at exact
// .x5 boundaries (201/400 -> 50.2 vs 50.3, 24 cases for integers up to 3000). Each
// helper below reproduces the one legacy rule it replaces bit for bit, so a screen that
// switches source keeps its numbers:
//   pct1OrZero  = dashboard/_data/live.ts pct(): Math.round((n / d) * 1000) / 10, d=0 -> 0
//   pct1OrNull  = answer-analysis/_data/kpi-view.ts pctOrNull(): round1((100 * n) / d), d=0 -> null
import type { components } from "./api-types";

export type Ratio = components["schemas"]["Ratio"];
export type RankAvg = components["schemas"]["RankAvg"];
export type ApiMeta = components["schemas"]["Meta"];
export type ApiPage = components["schemas"]["Page"];

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Ratio -> one-decimal percent; missing ratio or den 0 -> 0 (dashboard KPI cards). */
export function pct1OrZero(r: Ratio | null | undefined): number {
  if (!r || !(r.den > 0)) return 0;
  return Math.round((r.num / r.den) * 1000) / 10;
}

/** Ratio -> one-decimal percent; missing ratio or den 0 -> null ("no measurement", KPI tab views). */
export function pct1OrNull(r: Ratio | null | undefined): number | null {
  if (!r || !(r.den > 0)) return null;
  return round1((100 * r.num) / r.den);
}

/** Plain fraction num/den (no rounding) or null when den is 0. */
export function ratioValue(r: Ratio | null | undefined): number | null {
  if (!r || !(r.den > 0)) return null;
  return r.num / r.den;
}

/** RankAvg -> average rank rounded to one decimal, or null when there is no ranked answer. */
export function rankAvg(r: RankAvg | null | undefined): number | null {
  if (!r || !(r.count > 0)) return null;
  return round1(r.sum / r.count);
}

// ── meta.suppressed ─────────────────────────────────────────────────────────

/** Reason codes the backend may put in meta.suppressed (back/app/core/envelope.py SUPPRESS_*). */
export const SUPPRESS_REASONS = [
  "no_active_snapshot",
  "hidden",
  "partial_hidden",
  "no_data",
  "unsupported",
  "source_pending",
  "no_prev",
] as const;
export type SuppressReason = (typeof SUPPRESS_REASONS)[number];
const REASON_SET: ReadonlySet<string> = new Set(SUPPRESS_REASONS);

export function isSuppressReason(v: string): v is SuppressReason {
  return REASON_SET.has(v);
}

type MetaLike = Partial<Pick<ApiMeta, "suppressed" | "ignored_filters" | "dropped_filters" | "as_of" | "cycles" | "mode">> | null | undefined;

/**
 * Suppression reason for one metric key: the key's own reason, else the whole-response
 * reason ('*'), else null. An unknown code (backend added one) is returned as "unsupported"
 * so screens still render an empty state instead of a number.
 */
export function suppressionOf(meta: MetaLike, key: string): SuppressReason | null {
  const s = meta?.suppressed;
  if (!s) return null;
  const reason = s[key] ?? s["*"];
  if (!reason) return null;
  return isSuppressReason(reason) ? reason : "unsupported";
}

/** Whole response suppressed ('*' key: no_active_snapshot, source_pending, ...). */
export function wholeSuppression(meta: MetaLike): SuppressReason | null {
  return suppressionOf(meta, "*");
}

/** A value, or null when meta suppresses that key (keeps "0" and "not measured" apart). */
export function unlessSuppressed<T>(meta: MetaLike, key: string, value: T): T | null {
  return suppressionOf(meta, key) ? null : value;
}

// ── meta.ignored_filters / dropped_filters ───────────────────────────────────

export interface FilterNotices {
  /** Axes the feature does not use on this surface (sent but not applied). */
  ignored: string[];
  /** Axis -> values dropped as out of scope or unknown. */
  dropped: Record<string, string[]>;
  hasAny: boolean;
}

/** "Not applied" marks for filter chips, or for one log line when no chip UI exists. */
export function filterNotices(meta: MetaLike): FilterNotices {
  const ignored = [...(meta?.ignored_filters ?? [])];
  const dropped: Record<string, string[]> = {};
  for (const [axis, values] of Object.entries(meta?.dropped_filters ?? {})) {
    if (values?.length) dropped[axis] = [...values];
  }
  return { ignored, dropped, hasAny: ignored.length > 0 || Object.keys(dropped).length > 0 };
}

// ── dates ────────────────────────────────────────────────────────────────────

/** meta.as_of (ISO date) for the "측정 기준일" pill, or null. Pass to the existing formatter as is. */
export function asOfDate(meta: MetaLike): string | null {
  return meta?.as_of ?? null;
}

/**
 * Round dates in ascending order. The API returns /v1/filters/dates `dates` newest
 * first; the legacy calendar contract is oldest first (design 3.2 (2)).
 */
export function ascendingDates(dates: readonly string[] | null | undefined): string[] {
  return [...(dates ?? [])].sort();
}
