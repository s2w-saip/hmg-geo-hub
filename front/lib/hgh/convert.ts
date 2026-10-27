// Shared shape conversions (design 2.5 and 3.2): API envelope pieces -> the values the remaining
// adapters (projects, QA) consume. Pure functions. The analysis conversions moved to the screens
// (back/bff/screens/_convert.py).
//
// Percent rounding: pct1OrNull = the legacy pctOrNull(): round1((100 * n) / d), d=0 -> null.
import type { components } from "./api-types";

export type Ratio = components["schemas"]["Ratio"];
export type ApiPage = components["schemas"]["Page"];

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Ratio -> one-decimal percent; missing ratio or den 0 -> null ("no measurement"). */
export function pct1OrNull(r: Ratio | null | undefined): number | null {
  if (!r || !(r.den > 0)) return null;
  return round1((100 * r.num) / r.den);
}

/** Plain fraction num/den (no rounding) or null when den is 0. */
export function ratioValue(r: Ratio | null | undefined): number | null {
  if (!r || !(r.den > 0)) return null;
  return r.num / r.den;
}

// ── meta.ignored_filters / dropped_filters ───────────────────────────────────

export interface FilterNotices {
  /** Axes the feature does not use on this surface (sent but not applied). */
  ignored: string[];
  /** Axis -> values dropped as out of scope or unknown. */
  dropped: Record<string, string[]>;
  hasAny: boolean;
}
