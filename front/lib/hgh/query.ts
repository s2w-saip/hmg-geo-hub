// Filter state -> backend query string, in ONE place (design 2.4, 3.2 (1), appendix A
// "필터 상태 → CommonFilters 직렬화").
//
// Input is the StandardFilters that readStandardFilters() produced from the URL plus the
// session scope it was read with. readStandardFilters INJECTS the account scope into the
// filters (brand lock, allowed countries); the backend computes scope itself and would
// treat injected values differently (umbrella 'HMG' dropped, empty intersections -> 0
// rows), so scope-derived values are stripped here and only URL choices are sent.
//
// Output rules (CommonFilters, back/app/core/filters.py):
//   - list axes: same name repeated (country=GB&country=US), values sorted and deduped
//   - empty axes are omitted (the backend is fail-closed on an axis that was sent empty)
//   - from/to: both or neither; a one-sided URL range is closed with /v1/filters/dates
//     bounds (the caller passes them, see resolveDateRange)
//   - own_brand, account regions/countries: never sent (server decides)
//   - cf.<uuid>: project surface only, returned apart from the typed query (`cf`)
//   - feature parameters (cycle_offset, kind, bucket, limit, cursor, ...) are added with
//     withParams(), which refuses a common axis at compile time and at run time
//
// The result is a typed object, not a query string: lib/hgh/client checks it against the
// OpenAPI query parameters of the path being called (names and value types), and turns
// it into a sorted query string itself.
import type { AllowedScope } from "@/lib/auth/types";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { effectiveScopeCountries } from "@/lib/rhq";
import { citationCategorySlug, CITATION_CATEGORY_SLUGS } from "@/lib/citation-categorizer/taxonomy";
import { formatAsOfDate } from "@/lib/as-of-date";

export type Surface = "global" | "website" | "project";

export type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | readonly QueryScalar[] | null | undefined;
/** Untyped query accepted by serializeQuery (the client passes its typed query through it). */
export type HghQueryInput = URLSearchParams | { readonly [key: string]: QueryValue };
/** Project custom-field filters sent as `cf.<field uuid>=value` (repeated). */
export type CustomFieldQuery = { readonly [fieldId: string]: readonly string[] };

/** CommonFilters as a typed query object (back/app/core/filters.py CommonFilters). */
export interface CommonQuery {
  surface: Surface;
  project_id?: string;
  brand?: string[];
  country?: string[];
  lang?: string[];
  engine?: string[];
  from?: string;
  to?: string;
  funnel?: string[];
  brand_presence?: string[];
  list_type?: string[];
  depth1?: string[];
  depth2?: string[];
  depth3?: string[];
  source?: string[];
}

/** toCommonQuery result: spread `query` into the call's query, pass `cf` as the call's cf. */
export interface CommonFilterParams {
  query: CommonQuery;
  cf?: CustomFieldQuery;
}

/** CommonFilters query names. Feature params must not reuse them (withParams guards). */
export const COMMON_QUERY_KEYS = [
  "surface",
  "project_id",
  "brand",
  "country",
  "lang",
  "engine",
  "from",
  "to",
  "funnel",
  "brand_presence",
  "list_type",
  "depth1",
  "depth2",
  "depth3",
  "source",
] as const satisfies readonly (keyof CommonQuery)[];
const COMMON_KEY_SET: ReadonlySet<string> = new Set(COMMON_QUERY_KEYS);
const CF_PREFIX = "cf.";

/** Backend CommonFilters date range (filters.py DATE_MIN..DATE_MAX); outside -> 422. */
export const API_DATE_MIN = "2000-01-01";
export const API_DATE_MAX = "2100-12-31";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_SET: ReadonlySet<string> = new Set(Object.values(CITATION_CATEGORY_SLUGS));

/** /v1/filters/dates fields used to close a one-sided range. */
export interface DateBounds {
  firstMeasuredDate?: string | null;
  latestRoundDate?: string | null;
}

export interface CommonQueryContext {
  /** Decided by the route (/dashboard,/standard = global, /website = website, /projects/[id] = project). */
  surface: Surface;
  /** Required for surface=project. For website it narrows to one site (optional). Not sent on global. */
  projectId?: string;
  /**
   * The scope readStandardFilters() was called with (session user.scope), or null when it
   * was called without one. Used only to recognise injected values; never sent.
   */
  scope: AllowedScope | null;
  /** readProjectCustomFieldFilters(Raw) result: fieldId -> values. Sent on project only. */
  customFields?: Record<string, string[]>;
  /** Needed only when isOpenEndedRange(filters); see resolveDateRange. */
  dateBounds?: DateBounds;
  /** Test seam: today's KST date (YYYY-MM-DD). */
  today?: string;
}

export class HghQueryError extends Error {
  readonly name = "HghQueryError";
  constructor(
    readonly code:
      | "project_id_required"
      | "open_ended_range_needs_bounds"
      | "common_key_override"
      | "invalid_custom_field",
    message: string,
  ) {
    super(message);
  }
}

// ── generic serialization ────────────────────────────────────────────────────

function scalar(v: QueryScalar): string {
  return typeof v === "string" ? v : String(v);
}

/**
 * Query object (or URLSearchParams) + custom fields -> URLSearchParams. Arrays repeat the
 * name, null/undefined are skipped, cf field ids must be UUIDs (cf.<uuid>, else throws).
 */
export function toSearchParams(input: HghQueryInput | undefined, cf?: CustomFieldQuery): URLSearchParams {
  const out = new URLSearchParams();
  if (input instanceof URLSearchParams) {
    for (const [k, v] of input) out.append(k, v);
  } else if (input) {
    for (const key of Object.keys(input)) {
      const v = input[key];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v as readonly QueryScalar[]) out.append(key, scalar(item));
      } else {
        out.append(key, scalar(v as QueryScalar));
      }
    }
  }
  for (const fieldId of Object.keys(cf ?? {})) {
    if (!UUID_RE.test(fieldId)) {
      throw new HghQueryError("invalid_custom_field", `cf field id is not a UUID: ${fieldId.slice(0, 40)}`);
    }
    for (const v of cf![fieldId]) out.append(`${CF_PREFIX}${fieldId.toLowerCase()}`, v);
  }
  return out;
}

/**
 * Stable query string: keys sorted (code-unit order), each key's values kept in their
 * given order. Used for the request URL and the in-request dedupe key, so the same
 * filter state always produces the same string.
 */
export function serializeQuery(input: HghQueryInput | undefined, cf?: CustomFieldQuery): string {
  const sp = toSearchParams(input, cf);
  const keys = [...new Set(sp.keys())].sort();
  const out = new URLSearchParams();
  for (const k of keys) for (const v of sp.getAll(k)) out.append(k, v);
  return out.toString();
}

/** Query as an object of value arrays, keys sorted (trace logs, tests). */
export function queryToObject(input: HghQueryInput | undefined, cf?: CustomFieldQuery): Record<string, string[]> {
  const sp = toSearchParams(input, cf);
  const out: Record<string, string[]> = {};
  for (const k of [...new Set(sp.keys())].sort()) out[k] = sp.getAll(k);
  return out;
}

type NoCommonKeys = { readonly [K in keyof CommonQuery]?: never };

/**
 * Add feature parameters (cycle_offset, kind, limit, cursor, ...) to a common query.
 * A CommonFilters name or a cf.* key is refused: at compile time for the common names,
 * at run time for both (design 2.4 "공통 축과 섞지 않는다"). Returns a new object.
 */
export function withParams<Q extends CommonQuery, E extends { readonly [key: string]: QueryValue } & NoCommonKeys>(
  common: Q,
  extra: E,
): Q & E {
  for (const key of Object.keys(extra)) {
    if (COMMON_KEY_SET.has(key) || key.startsWith(CF_PREFIX)) {
      throw new HghQueryError("common_key_override", `withParams: "${key}" is a common filter key`);
    }
  }
  return { ...common, ...extra };
}

/**
 * The card path switch (CommonFilters.card, WU-3): `{ card: true }` for a global or website
 * read that the legacy screen served from the summary tables, else nothing (project never
 * sends it: the backend ignores it there, and an unread parameter would only split the result
 * cache key). The backend applies the legacy profile card definitions (card_slot_rep: one
 * round per slot in a period window; summary_all_engines: no engine filter = every engine)
 * only when those switches are on; otherwise the answer is the same as without it.
 */
export function cardParam(surface: Surface, on: boolean | undefined): { card?: true } {
  return on && surface !== "project" ? { card: true } : {};
}

// ── date range ───────────────────────────────────────────────────────────────

export function todayKst(now: Date = new Date()): string {
  return formatAsOfDate(now.toISOString());
}

/** True when the URL range has exactly one end (?time=2026-06-01.. or ..2026-06-30). */
export function isOpenEndedRange(f: Pick<StandardFilters, "dateFrom" | "dateTo">): boolean {
  return Boolean(f.dateFrom) !== Boolean(f.dateTo);
}

function clampDay(d: string): string {
  if (d < API_DATE_MIN) return API_DATE_MIN;
  if (d > API_DATE_MAX) return API_DATE_MAX;
  return d;
}

/**
 * from/to for the API, or null for "no period" (snapshot).
 * - both set: kept (ordered), clamped to the API range
 * - one set: the missing end comes from bounds (from: firstMeasuredDate, to:
 *   latestRoundDate, else today KST). bounds must be passed; without them this throws,
 *   because the caller has to fetch /v1/filters/dates first (serialization stays sync).
 *   If the filled range ends up reversed (from after the latest round) it collapses
 *   to a one-day range: no data either way, as today.
 */
export function resolveDateRange(
  f: Pick<StandardFilters, "dateFrom" | "dateTo">,
  bounds: DateBounds | undefined,
  today: string = todayKst(),
): { from: string; to: string } | null {
  const rawFrom = f.dateFrom && ISO_DAY.test(f.dateFrom) ? f.dateFrom : undefined;
  const rawTo = f.dateTo && ISO_DAY.test(f.dateTo) ? f.dateTo : undefined;
  if (!rawFrom && !rawTo) return null;
  if (rawFrom && rawTo) {
    const [a, b] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];
    return { from: clampDay(a), to: clampDay(b) };
  }
  if (!bounds) {
    throw new HghQueryError(
      "open_ended_range_needs_bounds",
      "one-sided date range: pass dateBounds from GET /v1/filters/dates",
    );
  }
  let from = rawFrom;
  let to = rawTo;
  if (!to) to = bounds.latestRoundDate && ISO_DAY.test(bounds.latestRoundDate) ? bounds.latestRoundDate : today;
  if (!from) from = bounds.firstMeasuredDate && ISO_DAY.test(bounds.firstMeasuredDate) ? bounds.firstMeasuredDate : to;
  from = clampDay(from);
  to = clampDay(to);
  if (from > to) to = from;
  return { from, to };
}

// ── CommonFilters ────────────────────────────────────────────────────────────

function uniqSorted(values: readonly string[] | undefined, map?: (v: string) => string): string[] {
  if (!values?.length) return [];
  const out = new Set<string>();
  for (const raw of values) {
    const v = (map ? map(raw) : raw).trim();
    if (v) out.add(v);
  }
  return [...out].sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

/** URL source name ('Official (HMG)') -> slug ('officialHmg'). Slugs pass; unknown names pass raw (server drops them). */
export function sourceSlug(value: string): string {
  if (SLUG_SET.has(value)) return value;
  return citationCategorySlug(value) ?? value;
}

/**
 * Countries chosen in the URL, or [] when the value is the scope injection of
 * readStandardFilters (no ?geography, or an intersection that fell back to the whole
 * allowed set). Same-set comparison: picking every allowed country is also omitted,
 * which the server resolves to the same rows.
 */
export function urlCountries(countries: readonly string[] | undefined, scope: AllowedScope | null): string[] {
  const values = uniqSorted(countries);
  if (!values.length) return [];
  const injected = effectiveScopeCountries(scope ?? undefined);
  if (injected && sameSet(values, injected)) return [];
  return values;
}

/** Brand values chosen in the URL, or [] when readStandardFilters applied the brand lock. */
export function urlBrands(brands: readonly string[] | undefined, scope: AllowedScope | null): string[] {
  const locked = Boolean(scope && !scope.all && scope.brands?.length);
  return locked ? [] : uniqSorted(brands);
}

/**
 * StandardFilters -> CommonFilters as a typed query object (+ project custom fields).
 * Empty axes are left out; values are sorted and deduped.
 * Throws HghQueryError when surface=project has no projectId or a one-sided range has no bounds.
 */
export function toCommonQuery(f: StandardFilters, ctx: CommonQueryContext): CommonFilterParams {
  const { surface } = ctx;
  if (surface === "project" && !ctx.projectId) {
    throw new HghQueryError("project_id_required", "surface=project needs projectId");
  }
  const range = resolveDateRange(f, isOpenEndedRange(f) ? ctx.dateBounds : undefined, ctx.today ?? todayKst());

  const query: CommonQuery = { surface };
  if (ctx.projectId && surface !== "global") query.project_id = ctx.projectId;
  if (range) {
    query.from = range.from;
    query.to = range.to;
  }
  const put = (key: Exclude<keyof CommonQuery, "surface" | "project_id" | "from" | "to">, values: string[]) => {
    if (values.length) query[key] = values;
  };
  put("brand", urlBrands(f.brand, ctx.scope));
  put("brand_presence", uniqSorted(f.brandPresence));
  put("country", urlCountries(surface === "website" ? (f.websiteCountry ?? f.region) : f.region, ctx.scope));
  put("depth1", uniqSorted(f.depth1));
  put("depth2", uniqSorted(f.depth2));
  put("depth3", uniqSorted(f.depth3));
  put("engine", uniqSorted(f.engine, (v) => v.toLowerCase()));
  put("funnel", uniqSorted(f.funnelStage));
  put("lang", uniqSorted(f.lang, (v) => v.toLowerCase()));
  put("list_type", uniqSorted(f.listType));
  put("source", uniqSorted(f.sourceCategory, sourceSlug));

  let cf: Record<string, string[]> | undefined;
  if (surface === "project" && ctx.customFields) {
    for (const fieldId of Object.keys(ctx.customFields)) {
      if (!UUID_RE.test(fieldId)) continue; // backend 422s a malformed cf key; the URL reader drops them too
      const values = uniqSorted(ctx.customFields[fieldId]);
      if (values.length) (cf ??= {})[fieldId.toLowerCase()] = values;
    }
  }
  return cf ? { query, cf } : { query };
}
