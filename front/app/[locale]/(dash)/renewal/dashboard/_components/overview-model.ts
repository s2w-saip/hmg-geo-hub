// Renewal Overview "at a glance" (2026-10-22) — the pure parts of the three cards: the
// KPI row's standing line, the brand × KPI table and the market × KPI heat table. Every
// value comes from the original /dashboard readers (overviewCardState, competitorMinis /
// competitorCitationShares + competitorDeltas, LiveGeo); this file only arranges them.

import { OVERVIEW_KPI_KEYS, metricValue, type OverviewKpiKey } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import type { CompetitorMini } from "@/app/[locale]/(dash)/dashboard/_components/overview-kpi-cards";
import type { GeoCountryRow, GeoRegionRow, MarketCompetition } from "@/app/[locale]/(dash)/dashboard/_data/live";
import { brandKey } from "@/lib/scope/competitor-row";

export const isRank = (k: OverviewKpiKey) => k === "position";

/** Comparator, best first (rank: lower is better). */
export const better = (k: OverviewKpiKey) => (a: number, b: number) => (isRank(k) ? a - b : b - a);

const known = (v: number | null | undefined): v is number => v != null;

export interface Standing {
  rank: number;
  count: number;
}

/**
 * 당사's place among itself + the KPI's compared competitors (the card's 4), best first;
 * a tie puts 당사 ahead. null = no own value or no competitor value to compare with.
 */
export function standing(k: OverviewKpiKey, own: number | null, rivals: ReadonlyArray<{ value: number | null }>): Standing | null {
  if (own == null) return null;
  const vals = rivals.map((r) => r.value).filter(known);
  if (vals.length === 0) return null;
  return { rank: 1 + vals.filter((v) => better(k)(v, own) < 0).length, count: vals.length + 1 };
}

// ─── 브랜드 비교 ────────────────────────────────────────────────────────────

export interface BrandCell {
  value: number | null;
  delta: number | null;
}

export interface BrandMatrixRow {
  name: string;
  own: boolean;
  /** null = the brand is not among that KPI's compared competitors ('—'). */
  cells: Record<OverviewKpiKey, BrandCell | null>;
}

export interface BrandMatrixCol {
  key: OverviewKpiKey;
  /** best value in the column (bold), null = no value */
  best: number | null;
  /** largest value in the column — the bar scale */
  max: number | null;
  standing: Standing | null;
}

/**
 * Rows: 당사, then every KPI's compared competitors in KPI order (first appearance wins the
 * position; names match through brandKey). Δ is the 직전 회차 Δ on every row — 당사 from
 * the trend Δ, competitors from competitorDeltas — so a picked period never mixes bases in
 * one table (the KPI row above carries the period compare).
 */
export function brandMatrix(
  own: { label: string; values: Record<OverviewKpiKey, number | null>; deltas: Record<OverviewKpiKey, number | null> },
  rivals: Record<OverviewKpiKey, ReadonlyArray<CompetitorMini>>,
): { rows: BrandMatrixRow[]; cols: BrandMatrixCol[] } {
  const order: string[] = [];
  const names = new Map<string, string>();
  for (const k of OVERVIEW_KPI_KEYS) {
    for (const m of rivals[k]) {
      const key = brandKey(m.brand);
      if (names.has(key)) continue;
      names.set(key, m.brand);
      order.push(key);
    }
  }
  const empty = () => Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, null])) as Record<OverviewKpiKey, BrandCell | null>;
  const ownRow: BrandMatrixRow = { name: own.label, own: true, cells: empty() };
  for (const k of OVERVIEW_KPI_KEYS) ownRow.cells[k] = { value: own.values[k], delta: own.deltas[k] };
  const rows: BrandMatrixRow[] = [
    ownRow,
    ...order.map((key) => {
      const cells = empty();
      for (const k of OVERVIEW_KPI_KEYS) {
        const m = rivals[k].find((x) => brandKey(x.brand) === key);
        if (m) cells[k] = { value: m.value, delta: m.delta ?? null };
      }
      return { name: names.get(key) ?? key, own: false, cells };
    }),
  ];
  const cols = OVERVIEW_KPI_KEYS.map((k) => {
    const vals = rows.map((r) => r.cells[k]?.value).filter(known);
    return {
      key: k,
      best: vals.length ? [...vals].sort(better(k))[0] : null,
      max: vals.length ? Math.max(...vals) : null,
      standing: standing(k, own.values[k], rivals[k]),
    };
  });
  return { rows, cols };
}

/** Bar length (%) of a value against its column: rank bars grow toward 1위. */
export function barWidth(k: OverviewKpiKey, v: number | null, max: number | null): number {
  if (v == null || max == null || max <= 0) return 0;
  return isRank(k) ? Math.max(6, (1 - (v - 1) / max) * 100) : Math.max(2, (v / max) * 100);
}

// ─── 시장별 현황 ────────────────────────────────────────────────────────────

/** The market's biggest competitor (most mentions) — one rival for every KPI (marketMetrics). */
export function marketRival(m: MarketCompetition): string | null {
  return m.metrics?.shareOfVoice?.rival?.name ?? m.topRival?.name ?? null;
}

/** The rival's value for one KPI (citation share has none). */
export function rivalValue(m: MarketCompetition, k: OverviewKpiKey): number | null {
  const r = m.metrics?.[k]?.rival;
  if (r) return r.value;
  return k === "shareOfVoice" && !m.metrics && m.topRival ? m.topRival.sov : null;
}

/** 당사 − rival, signed so that + = ahead (rank: fewer positions is ahead). */
export function gapOf(k: OverviewKpiKey, v: number | null, rv: number | null): number | null {
  if (v == null || rv == null) return null;
  return Math.round((isRank(k) ? rv - v : v - rv) * 10) / 10;
}

/**
 * Heat bin 0–4 of a value among the shown countries' values for one KPI (5 quantile
 * steps, 4 = ahead — rank flips so a lower position is darker). null = no value.
 */
export function heatBinner(k: OverviewKpiKey, values: ReadonlyArray<number | null>): (v: number | null) => number | null {
  const sorted = values.filter(known).sort((a, b) => a - b);
  return (v) => {
    if (v == null || sorted.length === 0) return null;
    const b = Math.min(4, Math.floor((sorted.indexOf(v) / sorted.length) * 5));
    return isRank(k) ? 4 - b : b;
  };
}

export interface MarketSort {
  key: OverviewKpiKey;
  /** true = trailing countries first */
  worst: boolean;
}

/** Countries of one region in the chosen column's order; countries without a value go last. */
export function sortCountries(countries: ReadonlyArray<GeoCountryRow>, sort: MarketSort): GeoCountryRow[] {
  const cmp = better(sort.key);
  return [...countries].sort((a, b) => {
    const av = metricValue(a, sort.key);
    const bv = metricValue(b, sort.key);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return cmp(av, bv) * (sort.worst ? -1 : 1);
  });
}

export interface MarketColumn {
  bin: (v: number | null) => number | null;
  /** 1-based place of a country among the shown countries (best first), null = no value */
  nth: (code: string) => number | null;
  count: number;
}

/** Per-KPI heat bins and places over every shown country (all regions together). */
export function marketColumns(regions: ReadonlyArray<GeoRegionRow>): Record<OverviewKpiKey, MarketColumn> {
  const all = regions.flatMap((r) => r.countries);
  return Object.fromEntries(
    OVERVIEW_KPI_KEYS.map((k) => {
      const valued = all.map((c) => ({ code: c.code, v: metricValue(c, k) })).filter((x): x is { code: string; v: number } => x.v != null);
      const ranked = [...valued].sort((a, b) => better(k)(a.v, b.v)).map((x) => x.code);
      return [
        k,
        {
          bin: heatBinner(k, valued.map((x) => x.v)),
          nth: (code: string) => {
            const i = ranked.indexOf(code);
            return i < 0 ? null : i + 1;
          },
          count: valued.length,
        },
      ];
    }),
  ) as Record<OverviewKpiKey, MarketColumn>;
}
