// Renewal ACR — pure view model over the ACR screen data (StandardAcr, both data paths)
// plus the 당사 합계. No new reads: everything below is derived from what the app's ACR
// page already loads.
//
//   당사 합계      API `own`, or the legacy own counts (fetchStandardAcrOwn) over the totals
//   추이           당사 = the own brands' series added up (one pick per repetition, so own
//                  brands never overlap); rivals = the other series brands (compare candidates)
//   증감           last − previous bucket, only for round buckets (API) and a snapshot read:
//                  legacy buckets are measured days, whose last point is not the card value
//   지도 평균선     Σ Top1 ÷ Σ 후보군 over the shown brands (a reference, not a conversion rate)
//   요약           rules over the same numbers, most important first

import type { AcrOwnCounts, StandardAcr } from "@/lib/db/repositories/scope-aggregates";

export type AcrBrand = StandardAcr["brands"][number];

export interface AcrOwnTotal {
  choiceCount: number;
  appearanceCount: number;
  choiceShare: number | null;
  coverage: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const pct = (n: number, d: number): number | null => (d > 0 ? round1((100 * n) / d) : null);

/** Legacy own counts → the API `own` shape (same rounding as the brand rows: round1(100 n / d)). */
export function ownFromCounts(c: AcrOwnCounts, totals: StandardAcr["totals"]): AcrOwnTotal {
  return { choiceCount: c.choiceCount, appearanceCount: c.appearanceCount, choiceShare: pct(c.choiceCount, totals.iterations), coverage: pct(c.cells, totals.promptRuns) };
}

export interface AcrBrandRow extends AcrBrand {
  rank: number;
  trend: Array<number | null> | null;
  d: number | null;
}

export interface AcrEngineWins {
  engine: string;
  ownWins: number;
  /** winner brand → prompts it tops on this engine (null key = nobody chosen) */
  byBrand: Map<string | null, number>;
}

export type AcrFindingKind = "standing" | "leak" | "engine" | "sweep" | "model" | "mover" | "dist";
export interface AcrFinding {
  kind: AcrFindingKind;
  tone: "warn" | "good" | "info";
  pri: number;
  target: "sec-overview" | "sec-comp" | "sec-prompt" | "sec-model" | "sec-dist";
  /** brand to light after the jump */
  brand?: string;
  /** a view the target card should switch to first */
  act?: { battle?: "notown" } | { sheet: string };
  params: Record<string, string | number>;
}

export interface AcrView {
  own: AcrOwnTotal | null;
  ownBrands: string[];
  brands: AcrBrandRow[];
  /** trend buckets (labels as given: YYYY-MM-DD) */
  dates: string[];
  ownTrend: Array<number | null> | null;
  ownDelta: number | null;
  /** compare candidates: rivals with a trend, best first */
  rivals: string[];
  showDelta: boolean;
  rank: number;
  leader: AcrBrand | null;
  /** 지도 평균선 slope */
  k: number;
  engines: string[];
  engineWins: AcrEngineWins[];
  sweeps: Array<{ brand: string; count: number }>;
  findings: AcrFinding[];
}

const lastTwo = (vs: ReadonlyArray<number | null>): number | null => {
  const idx: number[] = [];
  for (let i = vs.length - 1; i >= 0 && idx.length < 2; i--) if (vs[i] != null) idx.push(i);
  return idx.length === 2 ? round1(vs[idx[0]]! - vs[idx[1]]!) : null;
};

export function acrView(data: StandardAcr, own: AcrOwnTotal | null, opts: { roundBuckets: boolean; period: boolean }): AcrView {
  const ownBrands = data.brands.filter((b) => b.isOurs).map((b) => b.brand);
  const seriesKeys = new Set(data.trend.flatMap((b) => Object.keys(b.series)));
  const dates = data.trend.map((b) => b.date);
  const ownInSeries = [...seriesKeys].filter((k) => ownBrands.includes(k));
  // 당사 trend = own series added up; a bucket without any own key holds no own pick (0)
  const ownTrend = ownInSeries.length ? data.trend.map((b) => round1(ownInSeries.reduce((s, k) => s + (b.series[k] ?? 0), 0))) : null;
  const showDelta = opts.roundBuckets && !opts.period;
  const seriesOf = (brand: string) => (seriesKeys.has(brand) ? data.trend.map((b) => b.series[brand] ?? null) : null);
  const brands: AcrBrandRow[] = data.brands.map((b, i) => {
    const trend = b.isOurs && ownBrands.length === 1 && ownTrend ? ownTrend : seriesOf(b.brand);
    return { ...b, rank: i + 1, trend, d: showDelta && trend ? lastTwo(trend) : null };
  });
  const ownDelta = showDelta && ownTrend ? lastTwo(ownTrend) : null;
  const rivals = data.brands.filter((b) => !b.isOurs && seriesKeys.has(b.brand)).map((b) => b.brand);
  const comps = data.brands.filter((b) => !b.isOurs);
  const ownShare = own?.choiceShare ?? null;
  const rank = 1 + comps.filter((b) => (b.choiceShare ?? -1) > (ownShare ?? -1)).length;
  const shown = data.brands.filter((b) => (b.coverage ?? 0) > 0);
  const k = shown.reduce((s, b) => s + (b.choiceShare ?? 0), 0) / (shown.reduce((s, b) => s + (b.coverage ?? 0), 0) || 1);

  const engines = data.totals.engines.length ? [...data.totals.engines] : [...new Set(data.battle.flatMap((r) => r.cells.map((c) => c.engine)))];
  const engineWins: AcrEngineWins[] = engines.map((engine) => {
    const byBrand = new Map<string | null, number>();
    let ownWins = 0;
    for (const r of data.battle) {
      const c = r.cells.find((x) => x.engine === engine);
      const w = c?.winner ?? null;
      byBrand.set(w, (byBrand.get(w) ?? 0) + 1);
      if (c?.winnerIsOurs) ownWins++;
    }
    return { engine, ownWins, byBrand };
  });
  const sweepCount = new Map<string, number>();
  if (engines.length > 1) {
    for (const r of data.battle) {
      const ws = r.cells.map((c) => c.winner);
      if (ws.length === engines.length && ws.every((w) => w && w === ws[0]) && !r.cells[0].winnerIsOurs) sweepCount.set(ws[0]!, (sweepCount.get(ws[0]!) ?? 0) + 1);
    }
  }
  const sweeps = [...sweepCount].map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand));

  const view: AcrView = { own, ownBrands, brands, dates, ownTrend, ownDelta, rivals, showDelta, rank, leader: comps[0] ?? null, k, engines, engineWins, sweeps, findings: [] };
  view.findings = acrFindings(data, view);
  return view;
}

/** "이번 회차 요약": rules over the numbers on the page; the four most important. */
export function acrFindings(data: StandardAcr, v: AcrView): AcrFinding[] {
  const out: AcrFinding[] = [];
  const o = v.own;
  const lead = v.leader;
  if (o?.choiceShare != null && lead?.choiceShare != null) {
    const gap = round1(o.choiceShare - lead.choiceShare);
    const first = gap >= 0;
    const leadRow = v.brands.find((b) => b.brand === lead.brand);
    const gapMove = v.ownDelta != null && leadRow?.d != null ? round1(v.ownDelta - leadRow.d) : null;
    out.push({
      kind: "standing",
      tone: first ? "good" : "warn",
      pri: first ? 3 : 9,
      target: "sec-comp",
      brand: lead.brand,
      params: { rival: lead.brand, gap: Math.abs(gap), first: first ? 1 : 0, move: gapMove == null ? "" : Math.abs(gapMove), widened: gapMove == null ? "" : (gapMove > 0) === first ? 1 : 0, own: o.choiceShare, rivalShare: lead.choiceShare },
    });
  }
  // an own brand next to a rival with a similar shortlist presence (±6pp) but fewer picks
  let leak: { a: AcrBrand; c: AcrBrand; dt: number } | null = null;
  for (const a of data.brands.filter((b) => b.isOurs))
    for (const c of data.brands.filter((b) => !b.isOurs)) {
      if (a.coverage == null || c.coverage == null || a.choiceShare == null || c.choiceShare == null) continue;
      if (Math.abs(a.coverage - c.coverage) > 6) continue;
      const dt = a.choiceShare - c.choiceShare;
      if (!leak || dt < leak.dt) leak = { a, c, dt };
    }
  if (leak && leak.dt < -0.5)
    out.push({
      kind: "leak",
      tone: "warn",
      pri: 8,
      target: "sec-comp",
      brand: leak.c.brand,
      params: { own: leak.a.brand, rival: leak.c.brand, gap: round1(Math.abs(leak.dt)), ownCov: leak.a.coverage!, rivalCov: leak.c.coverage!, ownTop1: leak.a.choiceShare!, rivalTop1: leak.c.choiceShare! },
    });
  if (v.engineWins.length > 1) {
    const w = [...v.engineWins].sort((a, b) => a.ownWins - b.ownWins);
    const lo = w[0];
    const hi = w[w.length - 1];
    if (hi.ownWins - lo.ownWins >= 3)
      out.push({ kind: "engine", tone: "warn", pri: 6, target: "sec-prompt", act: { battle: "notown" }, params: { engine: lo.engine, wins: lo.ownWins, total: data.battle.length, other: hi.engine, diff: hi.ownWins - lo.ownWins } });
  }
  const sw = v.sweeps[0];
  if (sw && sw.count >= 3) out.push({ kind: "sweep", tone: "warn", pri: 7, target: "sec-prompt", brand: sw.brand, act: { battle: "notown" }, params: { rival: sw.brand, count: sw.count } });
  const om = data.modelConversion.filter((m) => m.isOurs && m.conversionRate != null).sort((a, b) => b.conversionRate! - a.conversionRate!);
  if (om.length >= 2) {
    const best = om[0];
    const worst = om[om.length - 1];
    out.push({ kind: "model", tone: "info", pri: 5, target: "sec-model", brand: best.brand ?? undefined, params: { model: best.model, rate: best.conversionRate!, worst: worst.model, worstRate: worst.conversionRate! } });
  }
  const mover = v.brands.filter((b) => b.d != null).sort((a, b) => Math.abs(b.d!) - Math.abs(a.d!))[0];
  if (mover && Math.abs(mover.d!) >= 0.5)
    out.push({
      kind: "mover",
      tone: mover.isOurs ? (mover.d! > 0 ? "good" : "warn") : mover.d! > 0 ? "warn" : "info",
      pri: 4,
      target: "sec-overview",
      brand: mover.brand,
      params: { brand: mover.brand, d: mover.d!, ownD: v.ownDelta ?? "" },
    });
  const sheet = data.territory[0];
  if (sheet) {
    const zero = sheet.rows.filter((r) => !r.entries.some((e) => v.ownBrands.includes(e.brand))).length;
    if (zero >= 3) out.push({ kind: "dist", tone: "warn", pri: 5, target: "sec-dist", act: { sheet: `${sheet.region ?? ""}|${sheet.engine}` }, params: { region: sheet.region ?? "", engine: sheet.engine, zero, rows: sheet.rows.length } });
  }
  return out.sort((a, b) => b.pri - a.pri).slice(0, 4);
}

/** Sheet key used by the 선택 분포 tabs. */
export const sheetKeyOf = (s: StandardAcr["territory"][number]) => `${s.region ?? ""}|${s.engine}`;

/** Board order: the chosen metric descending, nulls last, ties by the server rank. */
export function sortBrandRows(rows: AcrBrandRow[], key: "choiceShare" | "coverage" | "d"): AcrBrandRow[] {
  return [...rows].sort((a, b) => (b[key] ?? -1e9) - (a[key] ?? -1e9) || a.rank - b.rank);
}
