// Admin › 고객 관심 데이터 관리 (2026-11-02): filters, sort, URL mirror, labels and input checks, kept pure for the tests.
// The input checks mirror the BFF's (back/bff/hub_stores/interest.py); the BFF decides.
import { LOCATION_LANGUAGE_PRESETS } from "@/lib/keyword/location-presets";
import {
  INTEREST_BRANDS,
  INTEREST_SOURCE_STATES,
  INTEREST_STATUSES,
  KEYWORD_SOURCES,
  KEYWORD_STATES,
  SOURCE_CHANNELS,
  type InterestSourceRow,
  type KeywordCondition,
  type KeywordRow,
} from "./interest-api";

export const ALL = "all";
export const COMMON = "common"; // the brand axis: no brand = common to every brand

// ─── tabs ────────────────────────────────────────────────────────────────────

export const INTEREST_TABS = ["keywords", "sources"] as const;
export type InterestTab = (typeof INTEREST_TABS)[number];

export function tabOf(v: string | string[] | null | undefined): InterestTab {
  const s = Array.isArray(v) ? v[0] : v;
  return (INTEREST_TABS as readonly string[]).includes(s ?? "") ? (s as InterestTab) : "keywords";
}

// ─── conditions ──────────────────────────────────────────────────────────────

export function conditionKey(c: KeywordCondition): string {
  return `${c.location_code}:${c.language_code}`;
}

export function conditionOfKey(key: string): KeywordCondition {
  const at = key.indexOf(":");
  return { location_code: Number(key.slice(0, at)), language_code: key.slice(at + 1) };
}

/** 한국 · ko: the preset's country name; a location outside the presets stays its DataForSEO code. */
export function conditionLabel(c: KeywordCondition, locale: string): string {
  const preset = LOCATION_LANGUAGE_PRESETS.find((p) => p.location_code === c.location_code);
  const name = preset ? (locale === "ko" ? preset.name : preset.nameEn) : String(c.location_code);
  return `${name} · ${c.language_code}`;
}

export const REGION_KEYS: Record<string, string> = {
  "North America": "northAmerica",
  Asia: "asia",
  Europe: "europe",
  Oceania: "oceania",
  "South America": "southAmerica",
  "Middle East": "middleEast",
  Africa: "africa",
};

// ─── keywords ────────────────────────────────────────────────────────────────

export const KEYWORD_AXES = ["market", "source", "brand", "state", "status"] as const;
export type KeywordAxis = (typeof KEYWORD_AXES)[number];
export type KeywordFilter = Record<KeywordAxis, string>;
export const DEFAULT_KEYWORD_FILTER: KeywordFilter = { market: ALL, source: ALL, brand: ALL, state: ALL, status: ALL };

export const KEYWORD_SORTS = ["term", "conditions", "observed", "state"] as const;
export type KeywordSort = (typeof KEYWORD_SORTS)[number];
export const DEFAULT_KEYWORD_SORT: { key: KeywordSort; asc: boolean } = { key: "term", asc: true };

export function keywordFirstAsc(key: KeywordSort): boolean {
  return key === "term" || key === "state";
}

/** The markets the list holds, in the presets' order; a condition outside the presets comes last. */
export function keywordMarkets(rows: readonly KeywordRow[]): string[] {
  const seen = new Set(rows.flatMap((r) => r.conditions.map(conditionKey)));
  const rank = (k: string) => {
    const i = LOCATION_LANGUAGE_PRESETS.findIndex((p) => conditionKey(p) === k);
    return i < 0 ? 999 : i;
  };
  return [...seen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function keywordAxisOptions(axis: KeywordAxis, markets: readonly string[]): string[] {
  if (axis === "market") return [...markets];
  if (axis === "source") return [...KEYWORD_SOURCES];
  if (axis === "brand") return [COMMON, ...INTEREST_BRANDS];
  if (axis === "state") return [...KEYWORD_STATES];
  return [...INTEREST_STATUSES];
}

export function brandMatches(row: { brands: readonly string[]; status: string | null }, brand: string): boolean {
  if (brand === ALL) return true;
  if (brand === COMMON) return row.status != null && row.brands.length === 0;
  return row.brands.includes(brand);
}

export function keywordMatches(r: KeywordRow, f: KeywordFilter, search: string): boolean {
  if (f.market !== ALL && !r.conditions.some((c) => conditionKey(c) === f.market)) return false;
  if (f.source !== ALL && !r.sourceTypes.includes(f.source as (typeof KEYWORD_SOURCES)[number])) return false;
  if (!brandMatches(r, f.brand)) return false;
  if (f.state !== ALL && r.state !== f.state) return false;
  if (f.status !== ALL && r.status !== f.status) return false;
  const q = search.trim().toLowerCase();
  return !q || r.termNorm.includes(q);
}

const KEYWORD_STATE_ORDER: Record<string, number> = { pending: 0, upstream: 1, applied: 2 };

export function sortKeywords(rows: readonly KeywordRow[], key: KeywordSort, asc: boolean, locale: string): KeywordRow[] {
  const dir = asc ? 1 : -1;
  const compare = (a: KeywordRow, b: KeywordRow): number => {
    if (key === "conditions") return a.conditions.length - b.conditions.length;
    if (key === "observed") return (a.gold?.observedAt ?? "").localeCompare(b.gold?.observedAt ?? "");
    if (key === "state") return (a.state ? KEYWORD_STATE_ORDER[a.state] : 9) - (b.state ? KEYWORD_STATE_ORDER[b.state] : 9);
    return 0;
  };
  return [...rows].sort((a, b) => compare(a, b) * dir || (key === "term" ? dir : 1) * a.term.localeCompare(b.term, locale));
}

export function keywordCounts(rows: readonly KeywordRow[]) {
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    stopped: rows.filter((r) => r.status === "stopped").length,
    pending: rows.filter((r) => r.state === "pending").length,
    upstream: rows.filter((r) => r.state === "upstream").length,
  };
}

export function keywordFilterToQuery(f: KeywordFilter, search: string): string {
  const p = new URLSearchParams();
  for (const a of KEYWORD_AXES) if (f[a] !== ALL) p.set(a, f[a]);
  if (search.trim()) p.set("q", search.trim());
  return p.toString();
}

export function queryToKeywordFilter(q: string | URLSearchParams): { filters: KeywordFilter; search: string } {
  const p = typeof q === "string" ? new URLSearchParams(q) : q;
  const pick = (name: string, allowed: readonly string[]) => {
    const v = p.get(name);
    return v && allowed.includes(v) ? v : ALL;
  };
  const market = p.get("market");
  return {
    filters: {
      market: market && /^\d+:[A-Za-z-]+$/.test(market) ? market : ALL,
      source: pick("source", KEYWORD_SOURCES),
      brand: pick("brand", [COMMON, ...INTEREST_BRANDS]),
      state: pick("state", KEYWORD_STATES),
      status: pick("status", INTEREST_STATUSES),
    },
    search: p.get("q") ?? "",
  };
}

export function pickedKeywordAxes(f: KeywordFilter): KeywordAxis[] {
  return KEYWORD_AXES.filter((a) => f[a] !== ALL);
}

// ─── community sources ───────────────────────────────────────────────────────

export const SOURCE_AXES = ["channel", "brand", "state", "status"] as const;
export type SourceAxis = (typeof SOURCE_AXES)[number];
export type SourceFilter = Record<SourceAxis, string>;
export const DEFAULT_SOURCE_FILTER: SourceFilter = { channel: ALL, brand: ALL, state: ALL, status: ALL };

export const SOURCE_SORTS = ["mentions", "url", "channel", "state"] as const;
export type SourceSort = (typeof SOURCE_SORTS)[number];
export const DEFAULT_SOURCE_SORT: { key: SourceSort; asc: boolean } = { key: "mentions", asc: false };

export function sourceFirstAsc(key: SourceSort): boolean {
  return key !== "mentions";
}

export function sourceAxisOptions(axis: SourceAxis): string[] {
  if (axis === "channel") return [...SOURCE_CHANNELS];
  if (axis === "brand") return [COMMON, ...INTEREST_BRANDS];
  if (axis === "state") return [...INTEREST_SOURCE_STATES];
  return [...INTEREST_STATUSES];
}

export function sourceMatches(r: InterestSourceRow, f: SourceFilter, search: string): boolean {
  if (f.channel !== ALL && r.channel !== f.channel) return false;
  if (!brandMatches(r, f.brand)) return false;
  if (f.state !== ALL && r.state !== f.state) return false;
  if (f.status !== ALL && r.status !== f.status) return false;
  const q = search.trim().toLowerCase();
  return !q || r.key.includes(q);
}

const SOURCE_STATE_ORDER: Record<string, number> = { observed: 0, unseen: 1, upstream: 2 };

export function sortSources(rows: readonly InterestSourceRow[], key: SourceSort, asc: boolean): InterestSourceRow[] {
  const dir = asc ? 1 : -1;
  const compare = (a: InterestSourceRow, b: InterestSourceRow): number => {
    if (key === "mentions") return (a.gold?.mentions ?? 0) - (b.gold?.mentions ?? 0);
    if (key === "channel") return (a.channel ?? "~").localeCompare(b.channel ?? "~");
    if (key === "state") return (a.state ? SOURCE_STATE_ORDER[a.state] : 9) - (b.state ? SOURCE_STATE_ORDER[b.state] : 9);
    return a.key.localeCompare(b.key);
  };
  return [...rows].sort((a, b) => compare(a, b) * dir || (b.gold?.mentions ?? 0) - (a.gold?.mentions ?? 0) || a.key.localeCompare(b.key));
}

export function sourceCounts(rows: readonly InterestSourceRow[]) {
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    stopped: rows.filter((r) => r.status === "stopped").length,
    upstream: rows.filter((r) => r.state === "upstream").length,
  };
}

export function sourceFilterToQuery(f: SourceFilter, search: string): string {
  const p = new URLSearchParams({ tab: "sources" });
  for (const a of SOURCE_AXES) if (f[a] !== ALL) p.set(a, f[a]);
  if (search.trim()) p.set("q", search.trim());
  return p.toString();
}

export function queryToSourceFilter(q: string | URLSearchParams): { filters: SourceFilter; search: string } {
  const p = typeof q === "string" ? new URLSearchParams(q) : q;
  const pick = (name: string, allowed: readonly string[]) => {
    const v = p.get(name);
    return v && allowed.includes(v) ? v : ALL;
  };
  return {
    filters: {
      channel: pick("channel", SOURCE_CHANNELS),
      brand: pick("brand", [COMMON, ...INTEREST_BRANDS]),
      state: pick("state", INTEREST_SOURCE_STATES),
      status: pick("status", INTEREST_STATUSES),
    },
    search: p.get("q") ?? "",
  };
}

export function pickedSourceAxes(f: SourceFilter): SourceAxis[] {
  return SOURCE_AXES.filter((a) => f[a] !== ALL);
}

// ─── input checks (the BFF's rules) ──────────────────────────────────────────

export const TERM_MAX = 99;
export const NOTE_MAX = 500;
const KEY_MAX = 300;
const URL_MAX = 500;
const TERM_REFUSED = /[()[\]{},\u0000-\u001f\u007f]/;
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

export type KeywordProblem = "term" | "conditions" | "sources" | "note";

export function keywordProblems(v: { term: string; conditions: readonly KeywordCondition[]; sourceTypes: readonly string[]; note: string }): KeywordProblem[] {
  const out: KeywordProblem[] = [];
  const term = v.term.trim();
  if (!term || term.length > TERM_MAX || TERM_REFUSED.test(term)) out.push("term");
  if (v.conditions.length < 1 || v.conditions.length > 40) out.push("conditions");
  if (v.sourceTypes.length < 1) out.push("sources");
  if (v.note.trim().length > NOTE_MAX) out.push("note");
  return out;
}

/** The key the HUB stores for a domain or URL; null when it cannot be one. */
export function sourceKeyOf(value: string): string | null {
  const url = value.trim();
  const key = url
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[?#]/)[0]
    .replace(/\/+$/, "")
    .replace(/^www\./, "");
  const host = key.split("/")[0].replace(/^\.+|\.+$/g, "");
  if (key.length < 3 || key.length > KEY_MAX || url.length > URL_MAX || !host.includes(".") || SPACE_OR_CONTROL.test(url)) return null;
  return key;
}
