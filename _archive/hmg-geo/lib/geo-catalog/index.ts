// Web GEO catalog — typed access to the brand × region × country × language ×
// website list sourced from webgeo_final_list.xlsx. Single source of truth for
// the HMG geo hierarchy; reference these accessors instead of hardcoding
// region/country lists. See ./README.md for data-quality notes + regeneration.

import rawEntries from "./_data/web-geo-final.json";
import { GEO_COUNTRY_ISO } from "./country-codes";
import type {
  GeoBrandNode,
  GeoEntry,
  GeoFilter,
  GeoRegionNode,
} from "./types";

export * from "./types";
export { GEO_COUNTRY_ISO } from "./country-codes";
export { GEO_COUNTRY_NUMERIC, numericForAlpha2 } from "./country-numeric";
export { countryName } from "./country-name";

// The full catalog (218 rows). JSON is the build artifact of the .xlsx.
export const GEO_ENTRIES = rawEntries as unknown as GeoEntry[];

const uniq = <T>(a: T[]): T[] => [...new Set(a)];

/** Distinct brands / regions, in first-seen order. */
export const GEO_BRANDS = uniq(GEO_ENTRIES.map((e) => e.brand));
export const GEO_REGIONS = uniq(GEO_ENTRIES.map((e) => e.region));

/**
 * Geographic regions for display (every catalog region except the "Global"
 * placeholder, which is N Brand / Worldwide rows with no real geography). This
 * is the full 권역 axis the GEO snapshot enumerates — regions with no measured
 * answers still render (as "no data") so coverage gaps are visible.
 */
export const GEO_DISPLAY_REGIONS = GEO_REGIONS.filter((r) => r !== "Global");

function match(e: GeoEntry, f: GeoFilter): boolean {
  return (
    (!f.brand || e.brand === f.brand) &&
    (!f.region || e.region === f.region) &&
    (!f.country || e.country === f.country)
  );
}

/** Entries matching the (optional) brand/region/country filter. */
export function geoEntries(f: GeoFilter = {}): GeoEntry[] {
  return GEO_ENTRIES.filter((e) => match(e, f));
}

/** Distinct regions, optionally narrowed to one brand. */
export function geoRegions(brand?: string): string[] {
  return uniq(geoEntries({ brand }).map((e) => e.region));
}

/** Distinct countries, optionally narrowed to brand and/or region. */
export function geoCountries(f: Omit<GeoFilter, "country"> = {}): string[] {
  return uniq(geoEntries(f).map((e) => e.country));
}

/** ISO alpha-2 code for a catalog country name (null for placeholders). */
export function geoCountryCode(country: string): string | null {
  return GEO_COUNTRY_ISO[country] ?? null;
}

/**
 * Distinct {code, name} country options (deduped by ISO code, sorted by name)
 * for scope-assignment / filter dropdowns — emit `code` (matches
 * scope_answers.region), show `name`. Placeholder rows with no ISO are skipped.
 */
export function geoCountryOptions(
  f: Omit<GeoFilter, "country"> = {},
): { code: string; name: string }[] {
  const seen = new Set<string>();
  const out: { code: string; name: string }[] = [];
  for (const name of geoCountries(f)) {
    const code = GEO_COUNTRY_ISO[name];
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** region → countries (across all brands). */
export const GEO_COUNTRIES_BY_REGION: Record<string, string[]> =
  Object.fromEntries(GEO_REGIONS.map((r) => [r, geoCountries({ region: r })]));

/** brand → regions. */
export const GEO_REGIONS_BY_BRAND: Record<string, string[]> =
  Object.fromEntries(GEO_BRANDS.map((b) => [b, geoRegions(b)]));

// ── Owned-domain set ─────────────────────────────────────────────────────
// MOVED to ./owned.ts (2026-08-24). That layer needs the Public Suffix List to
// fold catalog hosts to registrable domains, and this barrel is imported by
// CLIENT components (brand-select, geo-map, citations-view) — keeping it here
// put the 147KB PSL snapshot into the browser bundle (+50 kB First Load JS on
// 9 routes, measured). Server-side callers import `@/lib/geo-catalog/owned`.

// ── ISO code → catalog location (권역 + 국가명) ───────────────────────────
// scope tags each answer with scope_answers.region = an ISO alpha-2 country
// code (US/KR/DE/…). To roll the mirror's per-country aggregates up into the
// catalog's continental 권역 → 국가 hierarchy, invert GEO_COUNTRY_ISO over the
// entries: first region/name seen per code wins (a country sits in one
// continental region). The "Global" placeholder region (N Brand / Worldwide) is
// excluded — it carries no geography.
export interface GeoLocation {
  /** Continental region grouping (North America / Asia / Europe / …). */
  region: string;
  /** Catalog country display name (e.g. "United States"). */
  country: string;
}

const CODE_TO_LOCATION = new Map<string, GeoLocation>();
for (const e of GEO_ENTRIES) {
  if (e.region === "Global") continue;
  const code = GEO_COUNTRY_ISO[e.country];
  if (code && !CODE_TO_LOCATION.has(code)) {
    CODE_TO_LOCATION.set(code, { region: e.region, country: e.country });
  }
}

/** Catalog 권역 + 국가명 for an ISO alpha-2 code (scope_answers.region), or null. */
export function geoLocateByCode(code: string): GeoLocation | null {
  return CODE_TO_LOCATION.get(code) ?? null;
}

// ── Cited URL → catalog entry (the cited site's country, via /kr-style path) ──
// Resolves WHICH localized brand site a citation points to — its country, which
// the domain alone can't give for shared hosts (hyundai.com serves 73 countries
// by path: /kr, /in, …). Match key = host + first path segment
// ("hyundai.com/kr"); host alone is a fallback ONLY when the host maps to a
// single country (country-TLD sites like hyundai.com.mx). Most-specific wins.
// Candidate match keys, most-specific first: a `?country=XX` query (regional
// hubs like hyundai.com/africa/en?country=BJ encode the country there), then
// host + first path segment (hyundai.com/kr), then bare host (country-TLD sites).
function urlKeys(url: string): string[] | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const keys: string[] = [];
  const qc = u.searchParams.get("country")?.toUpperCase();
  if (qc) keys.push(`${host}?country=${qc}`);
  const seg = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (seg) keys.push(`${host}/${seg}`);
  keys.push(host);
  return keys;
}

// Register a key → entry ONLY when that key maps to a single country (so an
// ambiguous key — a shared host, or a regional hub path like /africa serving
// many countries — never resolves to the wrong one). Lookup walks the keys
// most-specific first and returns the first unambiguous hit.
const KEY_COUNTRIES = new Map<string, Set<string>>();
const ENTRY_KEYS: { entry: GeoEntry; keys: string[] }[] = [];
for (const e of GEO_ENTRIES) {
  const keys = e.url ? urlKeys(e.url) : null;
  if (!keys) continue;
  ENTRY_KEYS.push({ entry: e, keys });
  for (const k of keys) {
    let set = KEY_COUNTRIES.get(k);
    if (!set) KEY_COUNTRIES.set(k, (set = new Set()));
    set.add(e.country);
  }
}
const URL_KEY_TO_ENTRY = new Map<string, GeoEntry>();
for (const { entry, keys } of ENTRY_KEYS) {
  for (const k of keys) {
    if (KEY_COUNTRIES.get(k)?.size === 1 && !URL_KEY_TO_ENTRY.has(k)) {
      URL_KEY_TO_ENTRY.set(k, entry);
    }
  }
}

/**
 * The catalog entry (brand · region · country · language) a citation URL points
 * to — resolves the cited *site's* country, including shared hosts via the path
 * segment (hyundai.com/kr → South Korea). null when the URL can't be pinned to a
 * single localized site (e.g. bare hyundai.com with no locale path).
 */
export function geoEntryForUrl(url: string): GeoEntry | null {
  const keys = urlKeys(url);
  if (!keys) return null;
  for (const k of keys) {
    const e = URL_KEY_TO_ENTRY.get(k);
    if (e) return e;
  }
  return null;
}

/** Build the Brand ▸ Region ▸ Country ▸ entries tree (optionally one brand). */
export function geoHierarchy(brand?: string): GeoBrandNode[] {
  const brands = brand ? [brand] : GEO_BRANDS;
  return brands.map((b) => {
    const regions: GeoRegionNode[] = geoRegions(b).map((r) => ({
      region: r,
      countries: geoCountries({ brand: b, region: r }).map((c) => ({
        country: c,
        code: geoCountryCode(c),
        entries: geoEntries({ brand: b, region: r, country: c }),
      })),
    }));
    return { brand: b, regions };
  });
}
