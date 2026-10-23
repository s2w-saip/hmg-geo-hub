// Renewal Citation view model — pure. The numbers come from the original citation page's
// functions (_data/citation-view.ts, citations-standard-view.tsx rules) on the same reads; this
// file only arranges them for the redesigned cards and derives what the cards add on top
// (weekly category shares, the source preference matrix, the domain rank bump, findings).

import type { CitationCategoryTotals, CitationTypeCategoryRow } from "@/lib/db/repositories/scope-aggregates";
import type { OverviewCardDelta } from "@/lib/kpi/overview-card-values";
import type { CitationDomainLive, CitationsLive, CitationTrend, EngineCategorySlice } from "@/lib/scope/result-adapter";
import {
  DEALER_CATEGORY,
  OFFICIAL_COMPETITOR_CATEGORY,
  OFFICIAL_HMG_CATEGORY,
  applyCompetitorPick,
  applyCompetitorPickToCategories,
  categoryBars,
  categoryIncluded,
  categoryShare,
  type CitationSectionDegraded,
} from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { deltaPp } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view";
import { TYPE_STRENGTH } from "@/app/[locale]/(dash)/renewal/standard/answer-analysis/mention/_components/mention-model";

export { DEALER_CATEGORY, OFFICIAL_COMPETITOR_CATEGORY, OFFICIAL_HMG_CATEGORY };

export type PrevCategories = { totals: CitationCategoryTotals; asOf: string; current?: CitationCategoryTotals } | null;

const round1 = (n: number) => Math.round(n * 10) / 10;

// ── Δ (citations-standard-view.tsx CategoryDelta / OfficialDelta) ─────────────

/** Share (%) of a category in the previous round's totals — the original's prevCategoryShare. */
export function prevCategoryShare(prev: { totals: CitationCategoryTotals } | null | undefined, name: string): number | null {
  if (!prev || prev.totals.total <= 0) return null;
  return Math.round((1000 * (prev.totals.byCategory[name] ?? 0)) / prev.totals.total) / 10;
}

/**
 * Category Δ (pp) vs the previous round. Both sides are one round: the api source carries the
 * last round's totals (`current`) because a period card value is cumulative; legacy compares the
 * card value (the original's CategoryDelta).
 */
export function categoryDelta(prev: PrevCategories, name: string, current: number | null): number | null {
  const previous = prevCategoryShare(prev, name);
  if (previous == null) return null;
  const base = prev?.current ? prevCategoryShare({ totals: prev.current }, name) : current;
  return deltaPp(base, previous);
}

export interface RnCitationDelta {
  value: number | null;
  /** card = the Overview card Δ (official share only), category = previous round's category totals */
  basis: "card" | "category" | null;
  /** the date of the round compared against */
  date: string | null;
}

/** 공식(HMG) 인용 비중 Δ: the Overview card Δ when it exists, else the category Δ (the original's OfficialDelta). */
export function officialDelta(card: OverviewCardDelta | null, prev: PrevCategories, current: number | null): RnCitationDelta {
  if (card) return { value: card.delta, basis: "card", date: card.basisDate };
  const value = categoryDelta(prev, OFFICIAL_HMG_CATEGORY, current);
  return { value, basis: value == null ? null : "category", date: prev?.asOf ?? null };
}

// ── weekly category shares (categoryTrend) ───────────────────────────────────

export interface ShareSeries {
  weeks: string[];
  byCategory: Map<string, (number | null)[]>;
}

/** Weekly share (%) of every category in categoryTrend; a gap week (collection error) is null. */
export function categoryShareSeries(trend: CitationTrend | null | undefined): ShareSeries | null {
  if (!trend || trend.points.length === 0) return null;
  const weeks = trend.points.map((p) => String(p.week ?? ""));
  const byCategory = new Map<string, (number | null)[]>(trend.series.map((s) => [s, []]));
  for (const p of trend.points) {
    const vals = trend.series.map((s) => (typeof p[s] === "number" ? (p[s] as number) : null));
    const total = vals.reduce<number>((a, v) => a + (v ?? 0), 0);
    const gap = Boolean(p.gap) || vals.every((v) => v == null);
    trend.series.forEach((s, i) => byCategory.get(s)!.push(gap || total <= 0 ? null : (100 * (vals[i] ?? 0)) / total));
  }
  return { weeks, byCategory };
}

// ── 출처 구성: one ranked list ────────────────────────────────────────────────

export interface CategoryRow {
  name: string;
  /** citations (공식(경쟁사) = the picked competitors' sum while a pick is on) */
  value: number;
  /** share (%) of all citations before the competitor pick (the original's denominator) */
  pct: number | null;
  /** the previous round's share — the tick on the bar */
  prevPct: number | null;
  delta: number | null;
  /** 공식(경쟁사) while a competitor pick is on: the original hides that Δ */
  deltaHidden: boolean;
  trend: (number | null)[] | null;
  /** the category's top domains and their share inside the category */
  top: { domain: string; pct: number }[];
}

export function categoryRows(input: {
  live: CitationsLive;
  prev: PrevCategories;
  card: OverviewCardDelta | null;
  picked: ReadonlySet<string>;
}): CategoryRow[] {
  const { live, prev, card, picked } = input;
  const categories = applyCompetitorPickToCategories(live.categories, live.domains, picked);
  // denominator = all citations before the pick (product owner 2026-09-29, the original's fullTotal)
  const fullTotal = (live.categories ?? []).reduce((s, c) => s + c.value, 0);
  const shares = categoryShareSeries(live.categoryTrend);
  const domains = applyCompetitorPick(live.domains, picked);
  return categoryBars(categories, fullTotal).map((b) => {
    const deltaHidden = picked.size > 0 && b.name === OFFICIAL_COMPETITOR_CATEGORY;
    // one number for one quantity: the 공식(HMG) row carries the tile's Δ (OfficialDelta precedence)
    const delta = deltaHidden
      ? null
      : b.name === OFFICIAL_HMG_CATEGORY
        ? officialDelta(card, prev, categoryShare(live.categories, OFFICIAL_HMG_CATEGORY)).value
        : categoryDelta(prev, b.name, b.pct);
    const own = domains.filter((d) => d.category === b.name).slice(0, 3);
    return {
      name: b.name,
      value: b.value,
      pct: b.pct,
      prevPct: deltaHidden ? null : prevCategoryShare(prev, b.name),
      delta,
      deltaHidden,
      trend: shares?.byCategory.get(b.name) ?? null,
      top: b.value > 0 ? own.map((d) => ({ domain: d.domain, pct: round1((100 * d.citations) / b.value) })) : [],
    };
  });
}

/** The Δ bars share one axis: the largest change on screen, never below ±0.5pp (noise stays short). */
export const DELTA_AXIS_MIN = 0.5;
/** Weekly share sparklines draw at least a 2pp range, so sub-point wobbles stay nearly flat. */
export const SPARK_MIN_SPAN = 2;
export function deltaAxis(rows: ReadonlyArray<Pick<CategoryRow, "delta">>): number {
  const m = Math.max(0, ...rows.map((r) => Math.abs(r.delta ?? 0)));
  return Math.max(DELTA_AXIS_MIN, Math.ceil(m * 10) / 10);
}

// ── 개요: the four tiles ──────────────────────────────────────────────────────

export type SplitState =
  | { kind: "ok"; owned: number; uncited: number }
  /** 출처 filter leaves 공식(HMG) out */
  | { kind: "noOwnCategory" }
  /** legacy does not compute the split while a 출처 filter is on (scope-aggregates wantSplit) */
  | { kind: "notComputed" }
  /** computed, no prompt cited an owned URL (the original hides the section) */
  | { kind: "noOwned" }
  /** api: the split read failed for now */
  | { kind: "degraded" };

export interface Lens {
  hmg: { value: number | null; delta: RnCitationDelta; spark: (number | null)[] };
  dealer: { value: number | null; delta: RnCitationDelta; spark: (number | null)[] };
  split: SplitState;
}

export function lens(input: {
  live: CitationsLive;
  prev: PrevCategories;
  card: OverviewCardDelta | null;
  active: readonly string[];
  sections: CitationSectionDegraded | null;
}): Lens {
  const { live, prev, card, active, sections } = input;
  const shares = categoryShareSeries(live.categoryTrend);
  // a category the 출처 filter leaves out has no share to show (the original prints 0.0%)
  const hmg = categoryIncluded(active, OFFICIAL_HMG_CATEGORY) ? categoryShare(live.categories, OFFICIAL_HMG_CATEGORY) : null;
  const dealer = categoryIncluded(active, DEALER_CATEGORY) ? categoryShare(live.categories, DEALER_CATEGORY) : null;
  const dealerD = categoryDelta(prev, DEALER_CATEGORY, dealer);
  const split = live.promptSplit;
  const state: SplitState = !categoryIncluded(active, OFFICIAL_HMG_CATEGORY)
    ? { kind: "noOwnCategory" }
    : split
      ? { kind: "ok", owned: split.ownedCount, uncited: split.uncitedCount }
      : sections?.split
        ? { kind: "degraded" }
        : split === undefined
          ? { kind: "notComputed" }
          : { kind: "noOwned" };
  return {
    hmg: { value: hmg, delta: officialDelta(card, prev, hmg), spark: shares?.byCategory.get(OFFICIAL_HMG_CATEGORY) ?? [] },
    dealer: { value: dealer, delta: { value: dealerD, basis: dealerD == null ? null : "category", date: prev?.asOf ?? null }, spark: shares?.byCategory.get(DEALER_CATEGORY) ?? [] },
    split: state,
  };
}

// ── 맥락: source preference matrix ────────────────────────────────────────────

/** Columns with fewer citations stay uncoloured: a gap on a thin sample is mostly noise. */
export const MATRIX_MIN_N = 30;

export interface MatrixCol {
  key: string;
  n: number;
  shares: Record<string, number>;
  counts: Record<string, number>;
  thin: boolean;
}
export interface Matrix {
  cols: MatrixCol[];
  rows: string[];
  /** 전체 = the columns' own sum (types double-count, so not the page total) */
  base: Record<string, number>;
  total: number;
  /** coloured columns (two or more columns, not thin) */
  live: string[];
  /** the gap (pp) drawn at full strength */
  cap: number;
}

export function matrix(source: ReadonlyArray<{ key: string; total: number; byCategory: Record<string, number> }>, order: readonly string[]): Matrix {
  const extra = new Set<string>();
  for (const s of source) for (const k of Object.keys(s.byCategory)) if (!order.includes(k)) extra.add(k);
  const rows = [...order, ...[...extra].sort()];
  const total = source.reduce((a, s) => a + s.total, 0);
  const base = Object.fromEntries(rows.map((k) => [k, total > 0 ? (100 * source.reduce((a, s) => a + (s.byCategory[k] ?? 0), 0)) / total : 0]));
  const cols: MatrixCol[] = source.map((s) => ({
    key: s.key,
    n: s.total,
    counts: Object.fromEntries(rows.map((k) => [k, s.byCategory[k] ?? 0])),
    shares: Object.fromEntries(rows.map((k) => [k, s.total > 0 ? (100 * (s.byCategory[k] ?? 0)) / s.total : 0])),
    thin: s.total < MATRIX_MIN_N,
  }));
  const live = cols.length > 1 ? cols.filter((c) => !c.thin).map((c) => c.key) : [];
  const gaps = cols.filter((c) => live.includes(c.key)).flatMap((c) => rows.map((k) => Math.abs(c.shares[k] - base[k])));
  return { cols, rows, base, total, live, cap: Math.max(3, Math.ceil(Math.max(0, ...gaps))) };
}

export const engineMatrix = (slices: EngineCategorySlice[] | null | undefined, order: readonly string[]): Matrix | null =>
  slices?.length ? matrix(slices.map((s) => ({ key: s.engine, total: s.total, byCategory: s.byCategory })), order) : null;

/** Mention types in endorsement strength order (최종 선택 → 단순 언급). */
export function typeMatrix(rows: CitationTypeCategoryRow[] | null | undefined, order: readonly string[]): Matrix | null {
  if (!rows?.length) return null;
  const by = new Map(rows.map((r) => [r.type, r]));
  const cols = TYPE_STRENGTH.map((t) => by.get(t)).filter((r): r is CitationTypeCategoryRow => Boolean(r));
  return cols.length ? matrix(cols.map((r) => ({ key: r.type, total: r.total, byCategory: r.byCategory })), order) : null;
}

export interface Skew {
  axis: "engine" | "type";
  col: string;
  category: string;
  share: number;
  base: number;
  gap: number;
}

/** The strongest preference outside 공식(HMG) (which has its own findings) on either axis. */
export function strongestSkew(engine: Matrix | null, type: Matrix | null): Skew | null {
  let best: Skew | null = null;
  for (const [axis, m] of [["engine", engine], ["type", type]] as const) {
    if (!m) continue;
    for (const c of m.cols) {
      if (!m.live.includes(c.key)) continue;
      for (const k of m.rows) {
        if (k === OFFICIAL_HMG_CATEGORY) continue;
        const gap = c.shares[k] - m.base[k];
        if (!best || Math.abs(gap) > Math.abs(best.gap)) best = { axis, col: c.key, category: k, share: c.shares[k], base: m.base[k], gap };
      }
    }
  }
  return best;
}

// ── 도메인: weekly rank bump ──────────────────────────────────────────────────

export interface BumpSeries {
  key: string;
  own: boolean;
  values: (number | null)[];
  ranks: (number | null)[];
}
export interface DomainBump {
  x: string[];
  series: BumpSeries[];
  first: number;
  last: number;
  /** the biggest rank changes first → last outside 공식(HMG), at most 3 */
  movers: { key: string; move: number }[];
}

export const BUMP_MOVERS = 3;

/** Ranks per week among the trend's domains (1 = most citations; ties keep the series order). */
export function domainBump(trend: CitationTrend | null | undefined, domains: readonly CitationDomainLive[]): DomainBump | null {
  if (!trend || trend.series.length === 0 || trend.points.length === 0) return null;
  const x = trend.points.map((p) => String(p.week ?? ""));
  const values = trend.series.map((s) => trend.points.map((p) => (!p.gap && typeof p[s] === "number" ? (p[s] as number) : null)));
  const ranks = trend.series.map(() => x.map((): number | null => null));
  x.forEach((_, i) => {
    trend.series
      .map((_, j) => ({ j, v: values[j][i] }))
      .filter((o): o is { j: number; v: number } => o.v != null)
      .sort((a, b) => b.v - a.v || a.j - b.j)
      .forEach((o, r) => (ranks[o.j][i] = r + 1));
  });
  const measured = x.map((_, i) => ranks.some((r) => r[i] != null));
  const first = measured.indexOf(true);
  const last = measured.lastIndexOf(true);
  const own = new Set(domains.filter((d) => d.isOurs).map((d) => d.domain));
  const series = trend.series.map((key, j) => ({ key, own: own.has(key), values: values[j], ranks: ranks[j] }));
  const movers =
    first >= 0 && last > first
      ? series
          .map((s) => ({ key: s.key, own: s.own, r0: s.ranks[first], r1: s.ranks[last] }))
          .filter((m): m is { key: string; own: boolean; r0: number; r1: number } => !m.own && m.r0 != null && m.r1 != null && m.r0 !== m.r1)
          .sort((a, b) => Math.abs(b.r0 - b.r1) - Math.abs(a.r0 - a.r1) || a.r1 - b.r1)
          .slice(0, BUMP_MOVERS)
          .map((m) => ({ key: m.key, move: m.r0 - m.r1 }))
      : [];
  return { x, series, first, last, movers };
}

// ── 이번 회차 요약 ─────────────────────────────────────────────────────────────

export type FindingKind = "standingLead" | "standingTrail" | "mover" | "engineGap" | "typeGap" | "opportunity" | "skew" | "climb";
export interface Finding {
  kind: FindingKind;
  tone: "warn" | "good" | "info";
  pri: number;
  /** section to jump to */
  target: string;
  /** key lit after the jump (category or domain) */
  key?: string;
  /** matrix axis the finding is about */
  axis?: "engine" | "type";
  /** sub page the finding opens instead of a jump */
  href?: "uncited";
  params: Record<string, string | number>;
}

export const FINDINGS_MAX = 4;

export function findings(input: {
  rows: CategoryRow[];
  hmgDelta: number | null;
  picked: ReadonlySet<string>;
  engine: Matrix | null;
  type: Matrix | null;
  split: SplitState;
  bump: DomainBump | null;
}): Finding[] {
  const { rows, hmgDelta, picked, engine, type, split, bump } = input;
  const out: Finding[] = [];
  const hi = rows.findIndex((r) => r.name === OFFICIAL_HMG_CATEGORY);
  if (hi >= 0 && rows.length > 1 && rows[hi].pct != null) {
    const o = rows[hi];
    const other = hi === 0 ? rows[1] : rows[0];
    out.push(
      hi === 0
        ? { kind: "standingLead", tone: "good", pri: 3, target: "sec-comp", key: o.name, params: { rival: other.name, gap: round1((o.pct ?? 0) - (other.pct ?? 0)), delta: hmgDelta ?? "" } }
        : { kind: "standingTrail", tone: "warn", pri: 8, target: "sec-comp", key: o.name, params: { rank: hi + 1, share: o.pct ?? 0, leader: other.name, leaderShare: other.pct ?? 0, delta: hmgDelta ?? "" } },
    );
  }
  const mover = rows
    .filter((r) => r.delta != null && r.name !== OFFICIAL_HMG_CATEGORY && !(r.name === OFFICIAL_COMPETITOR_CATEGORY && picked.size > 0))
    .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))[0];
  if (mover && Math.abs(mover.delta!) >= 0.05) {
    const rival = mover.name === OFFICIAL_COMPETITOR_CATEGORY && mover.delta! > 0;
    out.push({ kind: "mover", tone: rival ? "warn" : "info", pri: rival ? 7 : 4, target: "sec-comp", key: mover.name, params: { category: mover.name, delta: mover.delta!, share: mover.pct ?? 0 } });
  }
  if (engine && engine.live.length > 1 && engine.rows.includes(OFFICIAL_HMG_CATEGORY)) {
    const vals = engine.cols.filter((c) => engine.live.includes(c.key)).map((c) => ({ key: c.key, v: c.shares[OFFICIAL_HMG_CATEGORY] })).sort((a, b) => a.v - b.v);
    const lo = vals[0];
    const top = vals[vals.length - 1];
    const gap = round1(top.v - lo.v);
    out.push({ kind: "engineGap", tone: gap >= 4 ? "warn" : "info", pri: gap >= 4 ? 6 : 1, target: "sec-mix", key: OFFICIAL_HMG_CATEGORY, axis: "engine", params: { low: lo.key, lowShare: lo.v, high: top.key, gap } });
  }
  if (type && type.rows.includes(OFFICIAL_HMG_CATEGORY)) {
    const col = (k: string) => type.cols.find((c) => c.key === k && type.live.includes(k));
    const rec = col("recommendation");
    const men = col("mention");
    if (rec && men) {
      const gap = round1(rec.shares[OFFICIAL_HMG_CATEGORY] - men.shares[OFFICIAL_HMG_CATEGORY]);
      out.push({ kind: "typeGap", tone: gap < -1.5 ? "warn" : "good", pri: gap < -1.5 ? 7 : 2, target: "sec-mix", key: OFFICIAL_HMG_CATEGORY, axis: "type", params: { rec: rec.shares[OFFICIAL_HMG_CATEGORY], gap } });
    }
  }
  if (split.kind === "ok" && split.owned + split.uncited > 0 && split.uncited > 0) {
    const sh = round1((100 * split.uncited) / (split.owned + split.uncited));
    out.push({ kind: "opportunity", tone: "warn", pri: sh >= 40 ? 6 : 3, target: "sec-overview", href: "uncited", params: { n: split.uncited, share: sh } });
  }
  const sk = strongestSkew(engine, type);
  if (sk && Math.abs(sk.gap) >= 1) {
    out.push({ kind: "skew", tone: "info", pri: Math.abs(sk.gap) >= 5 ? 5 : 1, target: "sec-mix", key: sk.category, axis: sk.axis, params: { col: sk.col, category: sk.category, gap: round1(sk.gap), share: sk.share, base: sk.base } });
  }
  if (bump && bump.last > bump.first) {
    const climb = bump.series
      .map((s) => ({ s, r0: s.ranks[bump.first], r1: s.ranks[bump.last] }))
      .filter((c): c is { s: BumpSeries; r0: number; r1: number } => c.r0 != null && c.r1 != null && c.r0 > c.r1)
      .sort((a, b) => b.r0 - b.r1 - (a.r0 - a.r1))[0];
    if (climb) {
      out.push({ kind: "climb", tone: climb.s.own ? "good" : "info", pri: climb.r0 - climb.r1 >= 3 ? 5 : 2, target: "sec-dom", key: climb.s.key, params: { domain: climb.s.key, from: climb.r0, to: climb.r1, weeks: bump.last - bump.first + 1, n: bump.series.length } });
    }
  }
  return out.sort((a, b) => b.pri - a.pri).slice(0, FINDINGS_MAX);
}

// ── 도메인 순위표 ─────────────────────────────────────────────────────────────

export type DomainRow = CitationDomainLive & { rank: number };

/** Rows after the competitor pick, numbered before any search (the original's rule). */
export function rankedDomains(domains: readonly CitationDomainLive[], picked: ReadonlySet<string>): DomainRow[] {
  return applyCompetitorPick([...domains], picked).map((r, i) => ({ ...r, rank: i + 1 }));
}
