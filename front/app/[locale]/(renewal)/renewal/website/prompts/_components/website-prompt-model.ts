// Renewal Website › Prompts: the screens' shapes (back/bff/screens/website_prompts.py), the engine colours,
// the list's own picks and the URL the list keeps. Every number the page shows is one of these fields or a
// count of them; nothing here estimates or judges.

import type { WebsitePromptSortKey as LegacySortKey, WebsitePromptViewRow } from "@/lib/db/repositories/website-sites";

/** A row of the list: the original's fields, the rounds it was measured in and its answers by engine (in the lens). */
export interface WebsitePromptRow extends WebsitePromptViewRow {
  firstMeasuredAt: string | null;
  rounds: string[];
  engineAnswers: Record<string, number>;
}

export type WebsitePromptSortKey = LegacySortKey | "firstMeasuredAt" | "rounds";

/** Screen website/prompts-page: one numbered page of the list (its picks applied) and its labels. */
export interface WebsitePromptsPage {
  rows: WebsitePromptRow[];
  total: number;
  /** Rows before the list's own picks (filters, search and lens only). */
  listed: number;
  page: number;
  pages: number;
  pageSize: number;
  rangeFrom: number;
  rangeTo: number;
  sort: WebsitePromptSortKey;
  dir: "asc" | "desc";
  /** The lens's rounds, oldest first (each row's strip). */
  roundAxis: string[];
}

export interface Tally {
  prompts: number;
  measured: number;
  answers: number;
}

/** Screen website/prompts-insights: counts of the listed rows (filters, search, lens; not the list's picks). */
export interface WebsitePromptInsights {
  prompts: number;
  measured: number;
  answers: number;
  roundAxis: string[];
  engines: { engine: string; prompts: number; answers: number }[];
  rounds: { date: string; prompts: number }[];
  lastMeasured: { date: string | null; prompts: number }[];
  depth: { answers: number; prompts: number }[];
  engineSets: { engines: string[]; prompts: number }[];
  brands: (Tally & { brand: string })[];
  markets: { country: string; prompts: number; brands: Record<string, number> }[];
  langs: (Tally & { lang: string })[];
  sites: (Tally & { domain: string })[];
}

// ── engines: one colour per engine, whatever the list holds (the renewal's validated palette, grey beyond) ──

const ENGINE_ORDER = ["chatgpt", "gemini", "deepseek", "perplexity"] as const;
const ENGINE_COLORS = ["#002c5f", "#1baf7a", "#eb6834", "#6250d6"];
const ENGINE_GREY = "#c9c3bb";

export function engineColor(code: string): string {
  const i = (ENGINE_ORDER as readonly string[]).indexOf(code);
  return i >= 0 ? ENGINE_COLORS[i] : ENGINE_GREY;
}

/** Engines in the fixed order (colour order), unknown ones after, by name. */
export function byEngineOrder(codes: readonly string[]): string[] {
  const rank = (c: string) => {
    const i = (ENGINE_ORDER as readonly string[]).indexOf(c);
    return i >= 0 ? i : ENGINE_ORDER.length;
  };
  return [...codes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ── the list's own picks (made from the insights; the BFF reads them as read_drill) ──

export interface Drill {
  /** measured in the lens ("1") or not ("0") */
  m?: "0" | "1";
  /** a round the prompt was measured in */
  rd?: string;
  /** its latest round; "none" = unmeasured */
  last?: string;
  /** its exact engine set, sorted and joined with "~"; "none" = no engine */
  eset?: string;
  /** its exact answer count */
  ans?: number;
}
export type DrillKey = keyof Drill;
export const DRILL_KEYS: readonly DrillKey[] = ["m", "rd", "last", "eset", "ans"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readDrill(sp: { get(name: string): string | null }): Drill {
  const d: Drill = {};
  const m = sp.get("m");
  if (m === "0" || m === "1") d.m = m;
  const rd = sp.get("rd");
  if (rd && DAY.test(rd)) d.rd = rd;
  const last = sp.get("last");
  if (last && (DAY.test(last) || last === "none")) d.last = last;
  const eset = sp.get("eset");
  if (eset) d.eset = eset === "none" ? "none" : engineSetKey(eset.split("~"));
  const ans = sp.get("ans");
  if (ans && /^\d+$/.test(ans)) d.ans = Number(ans);
  return d;
}

export const engineSetKey = (engines: readonly string[]): string =>
  engines.length ? [...new Set(engines.filter(Boolean).map((e) => e.toLowerCase()))].sort().join("~") : "none";

export type Sort = { key: WebsitePromptSortKey; asc: boolean };
export const DEFAULT_SORT: Sort = { key: "lastMeasuredAt", asc: false };
export const DEFAULT_SIZE = 50;
export const PAGE_SIZES = [25, 50, 100] as const;

/** The page URL's search with this list's own params set (defaults dropped, so a plain link stays plain). */
export function withList(current: string, list: { q: string; sort: Sort; size: number; page?: number; drill?: Drill }): URLSearchParams {
  const p = new URLSearchParams(current);
  const set = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
  set("q", list.q.trim() || null);
  const dflt = list.sort.key === DEFAULT_SORT.key && list.sort.asc === DEFAULT_SORT.asc;
  set("sort", dflt ? null : list.sort.key);
  set("dir", dflt ? null : list.sort.asc ? "asc" : "desc");
  set("size", list.size === DEFAULT_SIZE ? null : String(list.size));
  set("page", list.page && list.page > 1 ? String(list.page) : null);
  const drill = list.drill ?? {};
  for (const k of DRILL_KEYS) set(k, drill[k] === undefined ? null : String(drill[k]));
  return p;
}

/** A round date as the charts label it (MM-DD; the year is in the tip). */
export const shortDay = (d: string) => d.slice(5);
