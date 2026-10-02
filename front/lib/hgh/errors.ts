// Backend error envelope -> one shared error shape for screens (design 2.3).
//
// The backend always answers errors as {error:{code, message, details}}
// (back/app/core/errors.py). Rules kept here, in one place:
//   - Branch on status + code only. Never on `details`: the backend is free to change
//     it (design 6.2, m-3 dropped constraint names from details).
//   - `message` is developer text. Screen copy comes from messages `apiError.<kind>`
//     (messages/units/u1.*.json), never from the backend message.
//   - Non-JSON bodies (CloudFront 502 HTML, proxies) become code "upstream_non_json".
//   - Logs carry code/status/requestId/path only: no token, cookie or body.
//
// Pure module (no server-only): client components may use classifyHghError on the
// {error:{code}} bodies that /api/* route handlers relay.
import { notFound, redirect } from "next/navigation";

export interface HghErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export interface HghErrorEnvelope {
  error: HghErrorDetail;
}

export interface HghErrorContext {
  requestId?: string;
  method?: string;
  path?: string;
}

/** Error raised by lib/hgh for every non-2xx backend answer and for local transport failures. */
export class HghApiError extends Error {
  readonly name = "HghApiError";
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;

  constructor(status: number, code: string, message?: string, details?: unknown, ctx: HghErrorContext = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = ctx.requestId;
    this.method = ctx.method;
    this.path = ctx.path;
  }
}

export function isHghApiError(e: unknown): e is HghApiError {
  return e instanceof HghApiError;
}

// Codes produced locally (no backend round trip or no usable backend answer).
export const LOCAL_CODES = {
  timeout: "timeout", // 504: AbortSignal.timeout fired
  network: "network_error", // 502: connection refused/reset, DNS, TLS
  nonJson: "upstream_non_json", // any status: body was not the JSON envelope
  config: "client_config", // 500: HGH_API_BASE_URL missing/invalid, bad call site
  authUnbound: "auth_unbound", // 500: no access-token provider bound (lib/hgh/auth.ts)
  unauthenticated: "unauthenticated", // 401: no session token, request not sent
  tooLarge: "payload_too_large", // 413: upload over the relay limit, request not sent
  pageLimit: "page_limit_exceeded", // 500: fetchAllPages hit maxPages
} as const;

const STATUS_FALLBACK_CODE: Record<number, string> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable",
  429: "rate_limited",
  500: "internal",
  502: "upstream",
  503: "unavailable",
  504: "timeout",
};

/**
 * Parse an error body. Only a well-formed envelope (`error.code` string) is trusted;
 * anything else is reported as upstream_non_json with the HTTP status kept.
 */
export function parseErrorBody(status: number, text: string, contentType: string | null): HghErrorDetail {
  if (contentType && /\bjson\b/i.test(contentType)) {
    try {
      const body = JSON.parse(text) as unknown;
      const err = (body as { error?: unknown } | null)?.error as Partial<HghErrorDetail> | undefined;
      if (err && typeof err === "object" && typeof err.code === "string" && err.code) {
        return {
          code: err.code,
          message: typeof err.message === "string" ? err.message : err.code,
          details: err.details ?? undefined,
        };
      }
    } catch {
      // fall through: JSON content type with a broken body
    }
  }
  return {
    code: LOCAL_CODES.nonJson,
    message: `non-envelope ${status} response (${STATUS_FALLBACK_CODE[status] ?? "error"})`,
  };
}

/** Build an HghApiError from a non-2xx Response (consumes the body). */
export async function errorFromResponse(res: Response, ctx: HghErrorContext = {}): Promise<HghApiError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  const detail = parseErrorBody(res.status, text, res.headers.get("content-type"));
  return new HghApiError(res.status, detail.code, detail.message, detail.details, ctx);
}

// ── classification: status + code -> one screen-facing kind ───────────────────

export const HGH_ERROR_KINDS = [
  "session", // 401 (Supabase session): log in again at /login
  "qaSession", // 401 qa_unauthorized: QA console cookie missing/expired, back to the QA gate (not /login)
  "forbidden", // 403 role_forbidden / menu_forbidden: surface or menu not allowed
  "permission", // 403 owner_only / operator_forbidden / admin_only / other: action not allowed
  "notFound", // 404 (also hides "exists but not yours", IDOR contract)
  "cursorStale", // 409 cursor_stale: data generation moved, restart from first page
  "conflict", // 409 other (conflict, duplicate_pending, lock_lost, ...)
  "invalid", // 400 / 422 (unprocessable, invalid_value, constraint_violation, cursor_invalid, ...)
  "tooLarge", // 413
  "unsupportedMedia", // 415
  "rateLimited", // 429
  "timeout", // 504 / local timeout
  "unavailable", // 502 / 503 / network error / non-JSON upstream
  "internal", // 500 and anything unexpected
] as const;
export type HghErrorKind = (typeof HGH_ERROR_KINDS)[number];

export interface HghUiError {
  kind: HghErrorKind;
  status: number;
  code: string;
  /** Worth a "retry" button: transient upstream or rate limit. */
  retryable: boolean;
  /** next-intl key, defined in messages/units/u1.{ko,en}.json. */
  messageKey: `apiError.${HghErrorKind}`;
  requestId?: string;
}

const SURFACE_FORBIDDEN_CODES = new Set(["role_forbidden", "menu_forbidden"]);

export function errorKindOf(status: number, code: string): HghErrorKind {
  if (code === LOCAL_CODES.timeout || status === 504) return "timeout";
  if (code === LOCAL_CODES.network || code === LOCAL_CODES.nonJson) return "unavailable";
  switch (status) {
    case 401:
      return code === "qa_unauthorized" ? "qaSession" : "session";
    case 403:
      return SURFACE_FORBIDDEN_CODES.has(code) ? "forbidden" : "permission";
    case 404:
      return "notFound";
    case 409:
      return code === "cursor_stale" ? "cursorStale" : "conflict";
    case 400:
    case 422:
      return "invalid";
    case 413:
      return "tooLarge";
    case 415:
      return "unsupportedMedia";
    case 429:
      return "rateLimited";
    case 502:
    case 503:
      return "unavailable";
    default:
      return "internal";
  }
}

const RETRYABLE: ReadonlySet<HghErrorKind> = new Set(["timeout", "unavailable", "rateLimited"]);

export function classifyHghError(e: { status: number; code: string; requestId?: string }): HghUiError {
  const kind = errorKindOf(e.status, e.code);
  return {
    kind,
    status: e.status,
    code: e.code,
    retryable: RETRYABLE.has(kind),
    messageKey: `apiError.${kind}`,
    requestId: e.requestId,
  };
}

export function isCursorStale(e: unknown): boolean {
  return isHghApiError(e) && e.status === 409 && e.code === "cursor_stale";
}

// ── per-context handlers (design 2.3 table) ─────────────────────────────────

export interface PageErrorOptions {
  /** Where 401 (Supabase session) goes. Default `/{locale}/login`. */
  loginPath?: string;
  /** Where 401 qa_unauthorized goes. Default `/{locale}/raw-data-qa` (the QA gate, as today). */
  qaLoginPath?: string;
  /**
   * 403 owner_only / operator_forbidden / admin_only on a page. Pages differ today:
   * admin redirects to no-access, project setting/member pages call notFound() to hide
   * the project. Default "no-access".
   */
  permission?: "no-access" | "not-found";
}

/**
 * Server component (page / layout) handling. Never returns:
 * 401 -> /{locale}/login, 401 qa_unauthorized -> /{locale}/raw-data-qa (both overridable),
 * 403 surface -> /{locale}/no-access, 403 action -> per option,
 * 404 -> notFound(), anything else (including 422, which is a front bug on reads, and
 * 5xx) is rethrown to the (dash) error boundary.
 */
export function throwForPage(e: unknown, locale: string, opts: PageErrorOptions = {}): never {
  if (!isHghApiError(e)) throw e;
  const kind = errorKindOf(e.status, e.code);
  if (kind === "session") redirect(opts.loginPath ?? `/${locale}/login`);
  if (kind === "qaSession") redirect(opts.qaLoginPath ?? `/${locale}/raw-data-qa`);
  if (kind === "forbidden") redirect(`/${locale}/no-access`);
  if (kind === "permission") {
    if (opts.permission === "not-found") notFound();
    redirect(`/${locale}/no-access`);
  }
  if (kind === "notFound") notFound();
  throw e;
}

/**
 * Route handler (/api/*) response for a failed backend call: same status, body
 * {error:{code}} plus requestId. The backend message and details are not forwarded.
 * Routes whose client expects another body shape convert before calling this.
 * Non-HghApiError values become 500 internal (logged without payload).
 */
export function hghErrorResponse(e: unknown): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (!isHghApiError(e)) {
    console.error("[hgh] route handler failure", e instanceof Error ? e.name : typeof e);
    return Response.json({ error: { code: "internal" } }, { status: 500, headers });
  }
  if (e.requestId) headers["X-Request-Id"] = e.requestId;
  const status = e.status >= 400 && e.status <= 599 ? e.status : 502;
  return Response.json({ error: { code: e.code, requestId: e.requestId } }, { status, headers });
}

export interface HghActionError {
  ok: false;
  error: HghErrorKind;
  code: string;
}

/**
 * Server action result for a failed backend call. Actions map `error` (kind) onto the
 * error keys their forms already use. Non-HghApiError values are rethrown.
 */
export function toActionError(e: unknown): HghActionError {
  if (!isHghApiError(e)) throw e;
  return { ok: false, error: errorKindOf(e.status, e.code), code: e.code };
}

/** One log line without payload: code, status, method, path, requestId. */
export function describeHghError(e: HghApiError): string {
  return `[hgh] ${e.status} ${e.code} ${e.method ?? ""} ${e.path ?? ""} rid=${e.requestId ?? "-"}`.replace(/\s+/g, " ");
}
