// Admin › 인용 출처 분류 › 시드 · 공식 소셜 · 코드표 (2026-10-30): filters, sort, URL mirror and input checks, kept pure
// for the tests. The input checks mirror the BFF's (back/bff/hub_stores/source_lists.py); the BFF decides.
import { SEED_STATES, SEED_STATUSES, type SeedRow, type SocialMatcher } from "./source-lists-api";

export const ALL = "all";

// ─── tabs ────────────────────────────────────────────────────────────────────

export const SOURCE_TABS = ["overrides", "seeds", "social", "codes"] as const;
export type SourceTab = (typeof SOURCE_TABS)[number];

export function tabOf(v: string | string[] | null | undefined): SourceTab {
  const s = Array.isArray(v) ? v[0] : v;
  return (SOURCE_TABS as readonly string[]).includes(s ?? "") ? (s as SourceTab) : "overrides";
}

// ─── seeds ───────────────────────────────────────────────────────────────────

export const SEED_AXES = ["category", "state", "status"] as const;
export type SeedAxis = (typeof SEED_AXES)[number];
export type SeedFilter = Record<SeedAxis, string>;
export const DEFAULT_SEED_FILTER: SeedFilter = { category: ALL, state: ALL, status: ALL };

export const SEED_SORTS = ["citations", "domain", "category", "state"] as const;
export type SeedSort = (typeof SEED_SORTS)[number];
export const DEFAULT_SEED_SORT: { key: SeedSort; asc: boolean } = { key: "citations", asc: false };

export function seedFirstAsc(key: SeedSort): boolean {
  return key === "domain" || key === "category";
}

/** The category a row means: the HUB's, or Gold's for an upstream row the HUB does not have. */
export function seedCategory(r: SeedRow): string | null {
  return r.category ?? r.gold?.category ?? null;
}

export function seedCitations(r: SeedRow): number {
  return r.gold?.citations ?? 0;
}

/** The values an axis can pick; RnRadioAxis adds its own 전체 (ALL) row in front. */
export function seedAxisOptions(axis: SeedAxis, categories: readonly string[]): string[] {
  if (axis === "category") return [...categories];
  if (axis === "state") return [...SEED_STATES];
  return [...SEED_STATUSES];
}

export function seedMatches(r: SeedRow, f: SeedFilter, search: string): boolean {
  if (f.category !== ALL && seedCategory(r) !== f.category) return false;
  if (f.state !== ALL && r.state !== f.state) return false;
  if (f.status !== ALL && r.status !== f.status) return false;
  const q = search.trim().toLowerCase();
  return !q || r.skey.includes(q);
}

const SEED_STATE_ORDER: Record<string, number> = { pending: 0, shadowed: 1, upstream: 2, applied: 3 };

export function sortSeeds(rows: readonly SeedRow[], key: SeedSort, asc: boolean, categoryOrder: ReadonlyMap<string, number>): SeedRow[] {
  const value = (r: SeedRow): number | string => {
    if (key === "citations") return seedCitations(r);
    if (key === "domain") return r.skey;
    if (key === "category") return categoryOrder.get(seedCategory(r) ?? "") ?? 999;
    return r.state ? SEED_STATE_ORDER[r.state] : 9;
  };
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return c * dir || seedCitations(b) - seedCitations(a) || a.skey.localeCompare(b.skey);
  });
}

export function seedCounts(rows: readonly SeedRow[]) {
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    removed: rows.filter((r) => r.status === "removed").length,
    pending: rows.filter((r) => r.state === "pending").length,
    upstream: rows.filter((r) => r.state === "upstream").length,
  };
}

export function seedFilterToQuery(f: SeedFilter, search: string): string {
  const p = new URLSearchParams({ tab: "seeds" });
  for (const a of SEED_AXES) if (f[a] !== ALL) p.set(a, f[a]);
  if (search.trim()) p.set("q", search.trim());
  return p.toString();
}

export function queryToSeedFilter(q: string | URLSearchParams): { filters: SeedFilter; search: string } {
  const p = typeof q === "string" ? new URLSearchParams(q) : q;
  const pick = (a: SeedAxis, allowed: readonly string[] | null) => {
    const v = p.get(a);
    return v && (allowed ? allowed.includes(v) : /^[a-z][A-Za-z0-9]{0,63}$/.test(v)) ? v : ALL;
  };
  return {
    filters: { category: pick("category", null), state: pick("state", SEED_STATES), status: pick("status", SEED_STATUSES) },
    search: p.get("q") ?? "",
  };
}

export function pickedSeedAxes(f: SeedFilter): SeedAxis[] {
  return SEED_AXES.filter((a) => f[a] !== ALL);
}

// ─── keys (the BFF's rules) ──────────────────────────────────────────────────

const KEY_MAX = 300;
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

/** A seed key as the HUB stores it: lower case, trimmed, no leading www.; null when it cannot be a domain. */
export function seedKeyOf(value: string): string | null {
  const key = value.trim().toLowerCase().replace(/^www\./, "");
  if (key.length < 3 || key.length > KEY_MAX || !key.includes(".") || key.includes("/") || SPACE_OR_CONTROL.test(key)) return null;
  return key;
}

export type SocialProblem = "key" | "matchers" | "prefix" | "duplicate";

/** The account key's domain: the part before the first slash. */
export function socialDomainOf(key: string): string {
  return key.trim().split("/")[0].toLowerCase();
}

/** What the BFF would refuse for an account: the key shape, 1..10 matchers, each prefix under the key's domain, unique. */
export function socialProblems(key: string, matchers: readonly SocialMatcher[]): SocialProblem[] {
  const out: SocialProblem[] = [];
  const k = key.trim();
  const domain = socialDomainOf(k);
  const path = k.slice(k.indexOf("/") + 1);
  if (
    !k.includes("/") ||
    !path ||
    k.length > KEY_MAX ||
    SPACE_OR_CONTROL.test(k) ||
    !domain.includes(".") ||
    domain.startsWith("www.")
  ) {
    out.push("key");
  }
  if (matchers.length < 1 || matchers.length > 10) out.push("matchers");
  const prefixes = matchers.map((m) => m.prefix.trim());
  if (prefixes.some((p) => p !== p.toLowerCase() || !p.startsWith(`${domain}/`) || p.length <= domain.length + 1 || p.length > KEY_MAX || SPACE_OR_CONTROL.test(p))) {
    out.push("prefix");
  }
  if (new Set(prefixes).size !== prefixes.length) out.push("duplicate");
  return out;
}

/** The first matcher a new account gets: the key itself, lower case, at a segment boundary. */
export function defaultMatcher(key: string): SocialMatcher {
  return { prefix: key.trim().toLowerCase(), boundary: true };
}

// ─── code table ──────────────────────────────────────────────────────────────

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;

export type CodeProblem = "nameKo" | "nameEn" | "description";

export function codeProblems(v: { nameKo: string; nameEn: string; description: string }): CodeProblem[] {
  const bad = (s: string) => !s.trim() || s.trim().length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(s);
  const out: CodeProblem[] = [];
  if (bad(v.nameKo)) out.push("nameKo");
  if (bad(v.nameEn)) out.push("nameEn");
  if (v.description.trim().length > DESCRIPTION_MAX) out.push("description");
  return out;
}

/** The category order after moving one code a step up or down (unchanged at either end). */
export function moveCode(codes: readonly string[], code: string, dir: "up" | "down"): string[] {
  const i = codes.indexOf(code);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= codes.length) return [...codes];
  const out = [...codes];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
