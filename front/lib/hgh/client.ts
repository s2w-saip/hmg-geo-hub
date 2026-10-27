import "server-only";

// The one backend client (design 2.2). Server only: runs in server components, route
// handlers and server actions; the browser keeps calling /api/* only.
//
//   const { query, cf } = toCommonQuery(filters, ctx);
//   hghGet("/v1/kpi/summary", { query: withParams(query, { cycle_offset: 1 }), cf })
//   hghPost("/v1/projects/{project_id}/members", { pathParams: { project_id }, body, retryOn401: true })
//
// Types come from lib/hgh/api-types.ts per (path, method): path params, the query object
// (known parameter names and value types; required ones such as `surface` are enforced),
// the JSON body and the 2xx JSON answer. `cf.<uuid>` custom-field filters are not in the
// OpenAPI document; they travel in the separate `cf` field, allowed only on paths whose
// query carries `surface` (CommonFilters).
//
// Contract:
//   - Base URL HGH_API_BASE_URL (https; http only for localhost). Checked on the first
//     call, not at import: legacy-source deployments (D8 default) may not set it.
//   - No result cache (D8): every fetch is `cache: "no-store"`. The only sharing is
//     in-request GET dedupe (lib/request-dedupe), allowed by design 3.2 (4).
//   - Auth: Bearer <Supabase access token> from lib/hgh/auth (bound by U2), or the QA
//     cookie, or none. A missing session token fails locally with 401 unauthenticated.
//   - X-Request-Id (UUID v4) per HTTP attempt, echoed on HghApiError.requestId.
//   - Errors: every non-2xx becomes HghApiError(status, code) from the envelope (errors.ts).
//   - Timeouts per call class (HGH_TIMEOUTS). Timeout -> 504 "timeout", not retried.
//   - Retries: GET only, once, 200 ms later, for connection errors and 503 auth_unavailable.
//     Any method, once, after 401 token_expired/unauthenticated when the caller opted in
//     with retryOn401 (route handlers, server actions: contexts that can write refreshed
//     cookies). Writes are never retried otherwise.
//   - D2 relay: `clientIp` + HGH_RELAY_SECRET add X-HGH-Client-IP and X-HGH-Relay-Secret
//     so the backend can rate-limit by the real viewer IP instead of the Vercel egress IP.
//     The backend trusts X-HGH-Client-IP only when the secret matches (backend request).
//   - Path parameters: encodeURIComponent, and "", "." and ".." are refused (a dot segment
//     would be normalised away by URL parsing and reach another route). The final URL path
//     is checked against the intended one.
//   - Local trace: with HGH_API_TRACE_FILE set (and not on Vercel), one JSONL line per HTTP
//     attempt: ts, requestId, attempt, method, route, path, query, status, ms, code,
//     bodySha256. Response bodies are never written; HGH_API_TRACE_SELECT names a JSON file
//     {route: [json paths]} whose values (scalars and array lengths only) are added as
//     `values` for the screen checks (design 5.3). Unset = no work at all.
//   - Source flags (D8): hghSource(group) reads HGH_SOURCE_<group>=api|legacy, default legacy.
//   - Header parameters: only where the OpenAPI operation declares them (If-Match on
//     PATCH /v1/admin/users/{user_id}, U11; X-HGH-Timeout-Ms on the four LLM routes, the BFF's
//     wait so the backend bounds the LLM call to it: back/app/core/llm.py request_deadline),
//     typed per path. Integer values travel as decimal strings. Names the client sets itself
//     (Authorization, Cookie, Accept, Content-Type, X-Request-Id, relay headers) are refused.
//   - Concurrency (G-25, D6): inside one server request (the React request cache scope, the
//     same one the GET dedupe uses) at most HGH_MAX_CONCURRENT_CALLS HTTP exchanges are in
//     flight; the next call waits for a slot, first come first served. The per-call timeout
//     starts when the slot is granted. Outside a request scope (scripts, tests) no limit.
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { cache } from "react";
import { localReadOnly } from "@/lib/local-readonly";
import { dedupeInRequest, stableKey } from "@/lib/request-dedupe";
import type { paths } from "./api-types";
import { getAccessToken, qaCookieHeader, refreshAccessToken } from "./auth";
import { HghApiError, LOCAL_CODES, parseErrorBody } from "./errors";
import { queryToObject, serializeQuery, type CustomFieldQuery, type HghQueryInput, type Surface } from "./query";

// ── configuration ────────────────────────────────────────────────────────────

/** Default timeout per call class (design 2.2). HGH_API_TIMEOUT_MS overrides `read`. */
export const HGH_TIMEOUTS = {
  read: 10_000, // analysis reads (1 s SLO x 10)
  adminLong: 35_000, // admin_long reads (AD-2, AD-3)
  write: 15_000, // writes
  external: 70_000, // backend calls that wait on LLM / Supabase Admin / GA4 / DataForSEO
  file: 120_000, // CSV/xlsx download streams and uploads
} as const;
export type HghTimeoutClass = keyof typeof HGH_TIMEOUTS;

/** D2 relay header names (backend reads them only with a matching secret). */
export const RELAY_HEADERS = {
  clientIp: "X-HGH-Client-IP",
  secret: "X-HGH-Relay-Secret",
} as const;

export interface HghConfig {
  baseUrl: string;
  readTimeoutMs: number;
  relaySecret: string | null;
  traceFile: string | null;
  /** JSON file {route: [json path]} selecting response values for the trace (local only). */
  traceSelectFile: string | null;
}

type Env = Record<string, string | undefined>;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const RELAY_SECRET_RE = /^[\x21-\x7e]{16,256}$/;

function configError(message: string): HghApiError {
  return new HghApiError(500, LOCAL_CODES.config, message);
}

/** Reads and validates HGH_* settings. Throws HghApiError(500, client_config). */
export function readHghConfig(env: Env = process.env): HghConfig {
  const raw = env.HGH_API_BASE_URL?.trim();
  if (!raw) throw configError("HGH_API_BASE_URL is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError("HGH_API_BASE_URL is not a URL");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local))) {
    throw configError("HGH_API_BASE_URL must be https (http only for localhost)");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw configError("HGH_API_BASE_URL must not carry query, fragment or credentials");
  }
  let readTimeoutMs: number = HGH_TIMEOUTS.read;
  const t = env.HGH_API_TIMEOUT_MS?.trim();
  if (t) {
    const n = Number(t);
    if (!Number.isInteger(n) || n < 100 || n > 600_000) {
      throw configError("HGH_API_TIMEOUT_MS must be an integer between 100 and 600000");
    }
    readTimeoutMs = n;
  }
  const secret = env.HGH_RELAY_SECRET?.trim() || null;
  if (secret && !RELAY_SECRET_RE.test(secret)) {
    throw configError("HGH_RELAY_SECRET must be 16-256 printable ASCII characters without spaces");
  }
  // Trace is a local harness tool: ignored on Vercel even if set by mistake.
  const traceFile = env.VERCEL ? null : env.HGH_API_TRACE_FILE?.trim() || null;
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    readTimeoutMs,
    relaySecret: secret,
    traceFile,
    traceSelectFile: traceFile ? env.HGH_API_TRACE_SELECT?.trim() || null : null,
  };
}

// ── request-scoped concurrency (G-25, D6) ────────────────────────────────────

/**
 * Most backend calls one server request keeps in flight at once. Design G-25: five or more
 * concurrent calls from one screen saturate the backend. Decision D6 (b) sends a screen's four
 * essential calls first and the other sections after them; this bound makes the limit hold on
 * the wire too (a section that fans out waits for a slot instead of opening a fifth call).
 */
export const HGH_MAX_CONCURRENT_CALLS = 4;

/** A held slot. release() is idempotent. */
export interface HghCallSlot {
  release(): void;
}

/**
 * FIFO counting semaphore for backend calls. A slot covers one HTTP exchange only (fetch until
 * the body is read; for hghRaw until the headers), never the waits around it (kept or deduped
 * promises, token refresh, retry delay), so a slot holder never waits on another call and the
 * limiter cannot deadlock. A released slot passes straight to the oldest waiter (nobody
 * overtakes). A waiter whose signal aborts leaves the queue and rejects with the signal's reason.
 */
export class HghCallLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("HghCallLimiter max must be a positive integer");
  }

  /** Slots held now. */
  get inFlight(): number {
    return this.active;
  }

  /** Callers waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<HghCallSlot> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.max && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.slot());
    }
    return new Promise<HghCallSlot>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.slot());
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  private slot(): HghCallSlot {
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        const next = this.waiters.shift();
        if (next) next(); // the slot passes on: the count stays
        else this.active -= 1;
      },
    };
  }
}

const requestLimiterStore = cache((): HghCallLimiter => new HghCallLimiter(HGH_MAX_CONCURRENT_CALLS));

/**
 * The limiter of the current server request, or null outside a request scope (scripts, plain
 * unit tests: no limit, as before). cache() memoizes only inside a request scope; outside it
 * runs the factory on every call, so two reads give two different limiters.
 */
export function requestCallLimiter(): HghCallLimiter | null {
  try {
    const limiter = requestLimiterStore();
    return limiter === requestLimiterStore() ? limiter : null;
  } catch {
    return null;
  }
}

// ── source flags (D8) ────────────────────────────────────────────────────────

export type HghSource = "api" | "legacy";

/** Conversion groups (integrated design 6.2 S4..S10) + the session switch (U2). */
export const HGH_SOURCE_GROUPS = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "SESSION"] as const;
export type HghSourceGroup = (typeof HGH_SOURCE_GROUPS)[number];

const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(message);
}

/** HGH_SOURCE_<group> = api | legacy. Unset or anything else -> legacy (warned once). */
export function hghSource(group: HghSourceGroup, env: Env = process.env): HghSource {
  if (localReadOnly(env)) return "api";
  const name = `HGH_SOURCE_${group}`;
  const raw = env[name]?.trim().toLowerCase();
  if (raw === "api") return "api";
  if (raw && raw !== "legacy") warnOnce(name, `[hgh] ${name}="${raw}" is not api|legacy; using legacy`);
  return "legacy";
}

/** Adapter areas. Surface-bound areas switch with their surface's group. */
export type HghArea =
  | "dashboard" // U5
  | "analysis" // U6, U7: mentions, citations, answers
  | "funnel" // U8: ACR, conversion
  | "prompts" // U8: prompt catalog
  | "projects" // U9
  | "intent" // U10
  | "admin" // U11
  | "qa" // U12
  | "session"; // U2

const GLOBAL_GROUP: Partial<Record<HghArea, HghSourceGroup>> = {
  dashboard: "G1",
  analysis: "G2",
  funnel: "G4",
  prompts: "G5",
};

/**
 * One flag per (area, surface): website surface = G3 and project surface = G6 for every
 * analysis area (the website group converts as a surface, design 4.3); global analysis
 * areas map to G1/G2/G4/G5; projects and intent = G6; admin and qa = G7.
 */
export function sourceGroupFor(area: HghArea, surface: Surface = "global"): HghSourceGroup {
  switch (area) {
    case "projects":
    case "intent":
      return "G6";
    case "admin":
    case "qa":
      return "G7";
    case "session":
      return "SESSION";
    default:
      if (surface === "website") return "G3";
      if (surface === "project") return "G6";
      return GLOBAL_GROUP[area] ?? "G1";
  }
}

// ── client IP relay (D2) ─────────────────────────────────────────────────────

function validIp(v: string | null | undefined): string | null {
  const s = v?.trim();
  return s && s.length <= 64 && isIP(s) ? s : null;
}

/**
 * The viewer IP as Vercel reports it: x-real-ip, else the leftmost x-forwarded-for.
 * Trustworthy only behind a proxy that overwrites these headers (Vercel does);
 * local next dev usually has neither (null).
 */
export function clientIpFromHeaders(h: Headers): string | null {
  return validIp(h.get("x-real-ip")) ?? validIp(h.get("x-forwarded-for")?.split(",")[0]);
}

/** clientIpFromHeaders for the current request (next/headers). */
export async function requestClientIp(): Promise<string | null> {
  const { headers } = await import("next/headers");
  return clientIpFromHeaders(await headers());
}

// ── path-typed API ───────────────────────────────────────────────────────────

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export type HghPath = keyof paths;
type OpOf<P extends HghPath, M extends HttpMethod> = NonNullable<paths[P][M]>;

/** Paths that declare method M. */
export type HghPathFor<M extends HttpMethod> = {
  [P in HghPath]: [NonNullable<paths[P][M]>] extends [never] ? never : P;
}[HghPath];

type PathParamsOf<O> = O extends { parameters: { path: infer PP } } ? PP : never;
type ParamsOf<O> = O extends { parameters: infer PS } ? PS : never;
type QueryParamsOf<O> = ParamsOf<O> extends { query?: infer Q } ? NonNullable<Q> : never;
type HeaderParamsOf<O> = ParamsOf<O> extends { header?: infer H } ? NonNullable<H> : never;
type QueryRequired<O> = ParamsOf<O> extends { query: unknown } ? true : false;
type RequestContentOf<O> = O extends { requestBody: { content: infer C } }
  ? C
  : O extends { requestBody?: { content: infer C } }
    ? C
    : never;
type BodyFromContent<C> =
  | (C extends { "application/json": infer J } ? J : never)
  | (C extends { "multipart/form-data": unknown } ? FormData : never)
  | (C extends { "application/octet-stream": unknown } ? Blob : never)
  | (C extends { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": unknown } ? Blob : never);
type ResponsesOf<O> = O extends { responses: infer R } ? R : never;
type JsonContent<X> = X extends { content: { "application/json": infer J } } ? J : undefined;

/** Parsed 2xx JSON body of (path, method); undefined for 204. */
export type HghResponse<P extends HghPath, M extends HttpMethod> = JsonContent<
  ResponsesOf<OpOf<P, M>>[Extract<keyof ResponsesOf<OpOf<P, M>>, 200 | 201 | 202 | 204>]
>;

export type HghAuthMode =
  | "session" // Bearer from lib/hgh/auth getAccessToken() (default)
  | "none" // no credentials (QA login POST, health)
  | { bearer: string } // explicit token (login action right after signInWithPassword)
  | { qaCookie: string | null }; // QA console: Cookie raw_data_qa=<value>, no Authorization

export interface HghBaseOptions {
  auth?: HghAuthMode;
  signal?: AbortSignal;
  /** Explicit timeout; wins over timeoutClass. */
  timeoutMs?: number;
  /** Defaults: GET "read", other methods "write". */
  timeoutClass?: HghTimeoutClass;
  /** D2: real viewer IP (requestClientIp()). Sent only when HGH_RELAY_SECRET is set. */
  clientIp?: string | null;
  /** One refresh + retry after 401 (route handlers and server actions only). */
  retryOn401?: boolean;
  /** In-request GET dedupe (default true for GET with session/QA auth). */
  dedupe?: boolean;
}

type PathArg<O> = [PathParamsOf<O>] extends [never] ? { pathParams?: undefined } : { pathParams: PathParamsOf<O> };
/** `query` typed from OpenAPI (required when the path has a required query parameter); `cf` only with CommonFilters. */
type QueryArg<O> = [QueryParamsOf<O>] extends [never]
  ? { query?: undefined; cf?: undefined }
  : (QueryRequired<O> extends true ? { query: QueryParamsOf<O> } : { query?: QueryParamsOf<O> }) &
      ("surface" extends keyof QueryParamsOf<O> ? { cf?: CustomFieldQuery } : { cf?: undefined });
/** `header` only on operations that declare header parameters (If-Match). */
type HeaderArg<O> = [HeaderParamsOf<O>] extends [never] ? { header?: undefined } : { header?: HeaderParamsOf<O> };
type BodyArg<O> = [RequestContentOf<O>] extends [never]
  ? { body?: undefined }
  : O extends { requestBody: unknown }
    ? { body: BodyFromContent<RequestContentOf<O>> }
    : { body?: BodyFromContent<RequestContentOf<O>> };

export type HghOptions<P extends HghPath, M extends HttpMethod> = HghBaseOptions &
  PathArg<OpOf<P, M>> &
  QueryArg<OpOf<P, M>> &
  HeaderArg<OpOf<P, M>> &
  BodyArg<OpOf<P, M>>;
/** Rest-argument shape: options may be omitted only when nothing in them is required. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type OptsArgs<T> = {} extends T ? [opts?: T] : [opts: T];

/** POST paths that take a file (multipart `file` field or the raw xlsx body). */
export type HghUploadPath = {
  [P in HghPathFor<"post">]: "multipart/form-data" extends keyof RequestContentOf<OpOf<P, "post">> ? P : never;
}[HghPathFor<"post">];

export function hghGet<P extends HghPathFor<"get">>(path: P, ...args: OptsArgs<HghOptions<P, "get">>): Promise<HghResponse<P, "get">> {
  return requestJson("get", path, args[0] as InternalOptions) as Promise<HghResponse<P, "get">>;
}
export function hghPost<P extends HghPathFor<"post">>(path: P, ...args: OptsArgs<HghOptions<P, "post">>): Promise<HghResponse<P, "post">> {
  return requestJson("post", path, args[0] as InternalOptions) as Promise<HghResponse<P, "post">>;
}
export function hghPut<P extends HghPathFor<"put">>(path: P, ...args: OptsArgs<HghOptions<P, "put">>): Promise<HghResponse<P, "put">> {
  return requestJson("put", path, args[0] as InternalOptions) as Promise<HghResponse<P, "put">>;
}
export function hghPatch<P extends HghPathFor<"patch">>(path: P, ...args: OptsArgs<HghOptions<P, "patch">>): Promise<HghResponse<P, "patch">> {
  return requestJson("patch", path, args[0] as InternalOptions) as Promise<HghResponse<P, "patch">>;
}
export function hghDelete<P extends HghPathFor<"delete">>(path: P, ...args: OptsArgs<HghOptions<P, "delete">>): Promise<HghResponse<P, "delete">> {
  return requestJson("delete", path, args[0] as InternalOptions) as Promise<HghResponse<P, "delete">>;
}

/** hghRaw options: the typed options of (path, method) plus the Accept header. */
export type HghRawOptions<P extends HghPath, M extends HttpMethod> = HghOptions<P, M> & {
  /** Accept header (default: any). */
  accept?: string;
};

/**
 * Raw 2xx Response with the body unread (download streams, Set-Cookie relays). Non-2xx
 * still throws HghApiError. Never deduped. Default timeout class "file" (covers the body).
 */
export function hghRaw<M extends HttpMethod, P extends HghPathFor<M>>(
  method: M,
  path: P,
  ...args: OptsArgs<HghRawOptions<P, M>>
): Promise<Response> {
  return execute(method, path, { timeoutClass: "file", ...(args[0] as InternalOptions) }, "raw") as Promise<Response>;
}

// ── implementation ───────────────────────────────────────────────────────────

interface InternalOptions extends HghBaseOptions {
  pathParams?: Record<string, string | number>;
  query?: HghQueryInput;
  cf?: CustomFieldQuery;
  body?: unknown;
  header?: Record<string, string | number | null | undefined>;
  accept?: string;
}

/** Header names the client owns; an operation header parameter may not set them. */
const RESERVED_HEADERS = new Set(
  ["authorization", "cookie", "accept", "content-type", "x-request-id", RELAY_HEADERS.clientIp, RELAY_HEADERS.secret].map((h) =>
    h.toLowerCase(),
  ),
);
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,1024}$/;

/**
 * Operation header parameters (null/undefined skipped; an integer is sent as its decimal string).
 * Throws client_config on a reserved or malformed header (a non-integer number included).
 */
export function operationHeaders(header: InternalOptions["header"]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries(header ?? {})) {
    if (raw === null || raw === undefined) continue;
    if (!HEADER_NAME_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      throw configError(`header parameter "${name}" is not allowed`);
    }
    if (typeof raw === "number" && !Number.isSafeInteger(raw)) throw configError(`header parameter "${name}" has a malformed value`);
    const value = String(raw);
    if (!HEADER_VALUE_RE.test(value)) throw configError(`header parameter "${name}" has a malformed value`);
    out.push([name, value]);
  }
  return out;
}

const RETRY_DELAY_MS = 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DOT_SEGMENTS = new Set([".", ".."]);

/**
 * Fill {name} segments. encodeURIComponent leaves "." alone, so "." / ".." would become dot
 * segments that URL parsing removes (/v1/projects/../members -> /v1/members): refused, as
 * are empty values, before and after encoding.
 */
export function fillPath(route: string, params: Record<string, string | number> | undefined): string {
  return route.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === null) throw configError(`missing path parameter "${name}" for ${route}`);
    const raw = String(v);
    const encoded = encodeURIComponent(raw);
    if (raw === "" || encoded === "" || DOT_SEGMENTS.has(raw) || DOT_SEGMENTS.has(encoded)) {
      throw configError(`path parameter "${name}" for ${route} must not be empty, "." or ".."`);
    }
    return encoded;
  });
}

function timeoutFor(method: HttpMethod, opts: InternalOptions, cfg: HghConfig): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const cls = opts.timeoutClass ?? (method === "get" ? "read" : "write");
  return cls === "read" ? cfg.readTimeoutMs : HGH_TIMEOUTS[cls];
}

interface EncodedBody {
  body?: BodyInit;
  contentType?: string;
}

function encodeBody(body: unknown): EncodedBody {
  if (body === undefined) return {};
  if (typeof FormData !== "undefined" && body instanceof FormData) return { body }; // fetch sets the boundary
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return { body, contentType: body.type || "application/octet-stream" };
  }
  if (body instanceof URLSearchParams) return { body, contentType: "application/x-www-form-urlencoded" };
  return { body: JSON.stringify(body), contentType: "application/json" };
}

type AuthHeader = { name: "Authorization" | "Cookie"; value: string } | null;

async function resolveAuth(mode: HghAuthMode, route: string): Promise<AuthHeader> {
  if (mode === "none") return null;
  if (mode === "session") {
    const token = await getAccessToken();
    if (!token) throw new HghApiError(401, LOCAL_CODES.unauthenticated, "no session token", undefined, { path: route });
    return { name: "Authorization", value: `Bearer ${token}` };
  }
  if ("bearer" in mode) {
    if (!/^[A-Za-z0-9_.-]{1,16384}$/.test(mode.bearer)) throw configError("explicit bearer token is malformed");
    return { name: "Authorization", value: `Bearer ${mode.bearer}` };
  }
  const cookie = qaCookieHeader(mode.qaCookie);
  if (!cookie) throw new HghApiError(401, "qa_unauthorized", "no QA session cookie", undefined, { path: route });
  return { name: "Cookie", value: cookie };
}

interface TraceEntry {
  ts: string;
  requestId: string;
  attempt: number;
  method: string;
  route: string;
  path: string;
  query: Record<string, string[]>;
  status: number;
  ms: number;
  code?: string;
  bodySha256?: string;
  /** Selected response values (HGH_API_TRACE_SELECT), never the whole body. */
  values?: Record<string, TraceValue>;
}

export type TraceValue = string | number | boolean | null;
const TRACE_STRING_MAX = 200;

/**
 * Values at simple JSON paths ("meta.as_of", "data.items[0].name", "data.items.length")
 * for the E2E value checks. Only scalars (strings cut to 200 chars) and array lengths are
 * returned; a missing path gives null and an object/array leaf gives "<non-scalar>", so a
 * selection can never copy a whole response into the trace.
 */
export function selectTraceValues(json: unknown, paths: readonly string[]): Record<string, TraceValue> {
  const out: Record<string, TraceValue> = {};
  for (const path of paths) {
    const tokens = [...path.matchAll(/[^.[\]]+|\[(\d+)\]/g)].map((m) => (m[1] !== undefined ? Number(m[1]) : m[0]));
    let cur: unknown = json;
    for (const t of tokens) {
      if (cur === null || cur === undefined) break;
      if (t === "length" && Array.isArray(cur)) cur = cur.length;
      else if (typeof t === "number") cur = Array.isArray(cur) ? cur[t] : undefined;
      else cur = typeof cur === "object" && Object.hasOwn(cur as object, t) ? (cur as Record<string, unknown>)[t] : undefined;
    }
    if (cur === undefined || cur === null) out[path] = null;
    else if (typeof cur === "string") out[path] = cur.slice(0, TRACE_STRING_MAX);
    else if (typeof cur === "number" || typeof cur === "boolean") out[path] = cur;
    else out[path] = "<non-scalar>";
  }
  return out;
}

/** HGH_API_TRACE_SELECT file: {"<route template>": ["json.path", ...]}. Read per traced call (local only). */
async function traceSelection(cfg: HghConfig, route: string): Promise<string[] | null> {
  if (!cfg.traceSelectFile) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(cfg.traceSelectFile, "utf8")) as unknown;
    const paths = (parsed as Record<string, unknown> | null)?.[route];
    if (paths === undefined) return null;
    if (!Array.isArray(paths) || !paths.every((x) => typeof x === "string")) throw new Error("shape");
    return paths as string[];
  } catch {
    warnOnce("trace-select", "[hgh] HGH_API_TRACE_SELECT is unreadable or not {route: string[]}; values skipped");
    return null;
  }
}

async function writeTrace(cfg: HghConfig, entry: TraceEntry): Promise<void> {
  if (!cfg.traceFile) return;
  try {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(cfg.traceFile, `${JSON.stringify(entry)}\n`);
  } catch {
    warnOnce("trace-write", "[hgh] HGH_API_TRACE_FILE is not writable; trace skipped");
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function devFilterLog(route: string, requestId: string, json: unknown): void {
  if (process.env.NODE_ENV !== "development") return;
  const meta = (json as { meta?: { ignored_filters?: string[]; dropped_filters?: Record<string, string[]> } } | null)?.meta;
  const ignored = meta?.ignored_filters ?? [];
  const dropped = Object.keys(meta?.dropped_filters ?? {});
  if (ignored.length || dropped.length) {
    console.warn(`[hgh] filters not applied ${route} ignored=[${ignored.join(",")}] dropped=[${dropped.join(",")}] rid=${requestId}`);
  }
}

function authKind(mode: HghAuthMode | undefined): string {
  if (!mode || mode === "session") return "session";
  if (mode === "none") return "none";
  return "bearer" in mode ? "bearer" : "qa";
}

function requestJson(method: HttpMethod, route: string, opts: InternalOptions = {}): Promise<unknown> {
  const kind = authKind(opts.auth);
  const dedupe = method === "get" && opts.dedupe !== false && !opts.signal && (kind === "session" || kind === "qa");
  if (!dedupe) return execute(method, route, opts, "json");
  const key = stableKey([
    "hgh",
    method,
    route,
    opts.pathParams ?? null,
    serializeQuery(opts.query, opts.cf),
    opts.header ?? null,
    kind,
    opts.timeoutMs ?? opts.timeoutClass ?? null,
  ]);
  return dedupeInRequest(key, () => execute(method, route, opts, "json"));
}

async function execute(method: HttpMethod, route: string, opts: InternalOptions, mode: "json" | "raw"): Promise<unknown> {
  if (localReadOnly() && method !== "get") {
    throw new HghApiError(405, "read_only", "The Gold service is read-only");
  }
  const cfg = readHghConfig();
  const path = fillPath(route, opts.pathParams);
  const qs = serializeQuery(opts.query, opts.cf);
  const url = `${cfg.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  // Belt and braces for fillPath: URL parsing must not have moved the request elsewhere.
  if (new URL(url).pathname !== new URL(`${cfg.baseUrl}${path}`).pathname || !new URL(url).pathname.endsWith(path)) {
    throw configError(`request path was normalised away from ${route}`);
  }
  const timeoutMs = timeoutFor(method, opts, cfg);
  const encoded = encodeBody(opts.body);
  const extraHeaders = operationHeaders(opts.header);
  const authMode = localReadOnly() ? "none" : (opts.auth ?? "session");
  let auth = await resolveAuth(authMode, route);
  const traceQuery = cfg.traceFile ? queryToObject(opts.query, opts.cf) : {};

  let clientIp: string | null = null;
  if (opts.clientIp) {
    clientIp = validIp(opts.clientIp);
    if (clientIp && !cfg.relaySecret) {
      warnOnce("relay-secret", "[hgh] clientIp given but HGH_RELAY_SECRET is not set; IP not relayed");
      clientIp = null;
    }
  }

  let transientRetried = false;
  let authRetried = false;
  const limiter = requestCallLimiter();
  for (let attempt = 1; ; attempt += 1) {
    opts.signal?.throwIfAborted();
    const requestId = randomUUID();
    const ctx = { requestId, method: method.toUpperCase(), path };
    const headers = new Headers({
      Accept: mode === "json" ? "application/json" : (opts.accept ?? "*/*"),
      "X-Request-Id": requestId,
    });
    if (encoded.contentType) headers.set("Content-Type", encoded.contentType);
    for (const [name, value] of extraHeaders) headers.set(name, value);
    if (auth) headers.set(auth.name, auth.value);
    if (clientIp && cfg.relaySecret) {
      headers.set(RELAY_HEADERS.clientIp, clientIp);
      headers.set(RELAY_HEADERS.secret, cfg.relaySecret);
    }

    // G-25/D6: one request slot per HTTP exchange. Waiting in the queue is not part of the call:
    // the timeout and the traced ms start once the slot is granted. The caller's abort while
    // queued rejects here with its reason, before any fetch.
    const slot = limiter ? await limiter.acquire(opts.signal) : null;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
    const t0 = performance.now();
    const trace = (status: number, extra: Partial<TraceEntry> = {}) =>
      writeTrace(cfg, {
        ts: new Date().toISOString(),
        requestId,
        attempt,
        method: ctx.method,
        route,
        path,
        query: traceQuery,
        status,
        ms: Math.round(performance.now() - t0),
        ...extra,
      });

    // The exchange (fetch, then the body unless hghRaw hands back a 2xx unread) holds the slot;
    // it is released on every path (answer, error, abort, timeout) before any retry delay or
    // token refresh below.
    let res: Response | null = null;
    let fetchError: unknown = null;
    let text = "";
    let bodyError: { err: unknown } | null = null;
    try {
      try {
        res = await fetch(url, {
          method: ctx.method,
          headers,
          body: encoded.body,
          cache: "no-store",
          redirect: "manual",
          signal,
        });
      } catch (err) {
        fetchError = err;
      }
      if (res) {
        const is2xx = res.status >= 200 && res.status < 300;
        if (is2xx && mode === "raw") {
          // body left unread for the caller (download stream, Set-Cookie relay)
        } else if (is2xx) {
          try {
            text = res.status === 204 ? "" : await readBody(res, timeoutSignal, timeoutMs, ctx, trace);
          } catch (err) {
            bodyError = { err };
          }
        } else {
          try {
            text = await readBody(res, timeoutSignal, timeoutMs, ctx, trace);
          } catch (err) {
            if (err instanceof HghApiError) bodyError = { err }; // body timed out: report the timeout
          }
        }
      }
    } finally {
      slot?.release();
    }

    if (!res) {
      if (opts.signal?.aborted) {
        await trace(0, { code: "aborted" });
        throw opts.signal.reason ?? fetchError;
      }
      if (timeoutSignal.aborted) {
        await trace(0, { code: LOCAL_CODES.timeout });
        throw new HghApiError(504, LOCAL_CODES.timeout, `no response within ${timeoutMs} ms`, undefined, ctx);
      }
      await trace(0, { code: LOCAL_CODES.network });
      if (method === "get" && !transientRetried) {
        transientRetried = true;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new HghApiError(502, LOCAL_CODES.network, "backend unreachable", undefined, ctx);
    }
    if (bodyError) throw bodyError.err;

    if (res.status >= 200 && res.status < 300) {
      if (mode === "raw") {
        await trace(res.status);
        return res;
      }
      let json: unknown = undefined;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          await trace(res.status, { code: LOCAL_CODES.nonJson, bodySha256: sha256(text) });
          throw new HghApiError(502, LOCAL_CODES.nonJson, `2xx body is not JSON (${res.status})`, undefined, ctx);
        }
      }
      if (cfg.traceFile) {
        const selected = await traceSelection(cfg, route);
        await trace(res.status, { bodySha256: sha256(text), ...(selected ? { values: selectTraceValues(json, selected) } : {}) });
      }
      devFilterLog(route, requestId, json);
      return json;
    }

    const detail = parseErrorBody(res.status, text, res.headers.get("content-type"));
    await trace(res.status, { code: detail.code, bodySha256: sha256(text) });

    if (res.status === 503 && detail.code === "auth_unavailable" && method === "get" && !transientRetried) {
      transientRetried = true;
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (
      res.status === 401 &&
      opts.retryOn401 &&
      authMode === "session" &&
      !authRetried &&
      (detail.code === "token_expired" || detail.code === "unauthenticated")
    ) {
      authRetried = true;
      const fresh = await refreshAccessToken();
      if (fresh) {
        auth = { name: "Authorization", value: `Bearer ${fresh}` };
        continue;
      }
    }
    throw new HghApiError(res.status, detail.code, detail.message, detail.details, ctx);
  }
}

async function readBody(
  res: Response,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
  ctx: { requestId: string; method: string; path: string },
  trace: (status: number, extra?: Partial<TraceEntry>) => Promise<void>,
): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (timeoutSignal.aborted) {
      await trace(res.status, { code: LOCAL_CODES.timeout });
      throw new HghApiError(504, LOCAL_CODES.timeout, `body not complete within ${timeoutMs} ms`, undefined, ctx);
    }
    throw err;
  }
}
