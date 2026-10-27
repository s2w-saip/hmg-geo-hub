// The backend query in ONE place (design 2.4): the typed CommonFilters query object the client checks
// against the OpenAPI parameters, feature parameters added with withParams(), and the stable query
// string the client sends. The filter state -> CommonFilters mapping itself (URL choices, scope
// stripping, period closing) runs in the screens (back/bff/screens/_query.py).
//
// Output rules (CommonFilters, back/app/core/filters.py):
//   - list axes: same name repeated (country=GB&country=US)
//   - cf.<uuid>: project surface only, passed apart from the typed query (`cf`)
//   - feature parameters (cycle_offset, kind, bucket, limit, cursor, ...) are added with
//     withParams(), which refuses a common axis at compile time and at run time
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

/** A common query and its custom fields: spread `query` into the call's query, pass `cf` as the call's cf. */
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HghQueryError extends Error {
  readonly name = "HghQueryError";
  constructor(
    readonly code: "common_key_override" | "invalid_custom_field",
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

// ── today ────────────────────────────────────────────────────────────────────

/** Today's date in KST (YYYY-MM-DD). */
export function todayKst(now: Date = new Date()): string {
  return formatAsOfDate(now.toISOString());
}
