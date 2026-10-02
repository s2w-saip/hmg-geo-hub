import "server-only";

// File and cookie relays between the browser-facing /api/* route handlers (paths
// unchanged) and the backend (design 2.7, decision D7 (a): stream relay + a clear limit error).
//
//   download: route handler -> relayDownload(...) -> Response streaming upstream.body
//             (no buffering). Passed through: Content-Type, Content-Disposition (always an
//             attachment), X-Export-Truncated. Added: Cache-Control no-store,
//             X-Content-Type-Options nosniff. Route handlers using it: `export const
//             runtime = "nodejs"` and a maxDuration.
//   upload:   server action / route handler File -> relayUpload(...) -> backend multipart
//             (field "file") or raw xlsx body. Size is checked BEFORE sending so the user
//             gets 413 payload_too_large with the limit instead of a platform error.
//   cookies:  relaySetCookies passes on ONLY the QA session cookie (raw_data_qa) and only
//             in the shape the backend issues: host-only (no Domain), Path=/, HttpOnly,
//             SameSite Lax/Strict, Secure in production. Anything else upstream says in
//             Set-Cookie is dropped, so the backend (or anything in front of it) cannot plant
//             cookies such as the Supabase session or load-balancer cookies on the front domain.
import { hghRaw, type HghOptions, type HghPathFor, type HghRawOptions, type HghUploadPath, type OptsArgs } from "./client";
import { HghApiError, LOCAL_CODES } from "./errors";
import { QA_COOKIE } from "./auth";

/** Upstream headers a download relay forwards (lowercase). */
export const DOWNLOAD_HEADER_ALLOWLIST = ["content-type", "content-disposition", "x-export-truncated"] as const;

/** Backend upload ceiling (HGH_UPLOAD_MAX_BYTES, back/app/core/upload.py): 10 MiB. */
export const BACKEND_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Upload limit the relay enforces: HGH_UPLOAD_MAX_BYTES when set (lower it to the hosting
 * platform's request-body limit, confirmed at deploy time per D7), capped at the backend's.
 */
export function uploadLimitBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HGH_UPLOAD_MAX_BYTES?.trim();
  if (!raw) return BACKEND_UPLOAD_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HghApiError(500, LOCAL_CODES.config, "HGH_UPLOAD_MAX_BYTES must be a positive integer");
  }
  return Math.min(n, BACKEND_UPLOAD_MAX_BYTES);
}

/** Throws 413 payload_too_large (details.limitBytes) when the file is over the limit. Never sends. */
export function assertUploadSize(file: Blob, limitBytes: number = uploadLimitBytes()): void {
  if (file.size > limitBytes) {
    throw new HghApiError(413, LOCAL_CODES.tooLarge, `upload over ${limitBytes} bytes`, {
      limitBytes,
      sizeBytes: file.size,
    });
  }
}

/** Content-Disposition forced to `attachment` (parameters such as filename* kept). */
export function attachmentDisposition(value: string | null): string {
  if (!value) return "attachment";
  const [type, ...params] = value.split(";");
  if (type.trim().toLowerCase() === "attachment") return value;
  return params.length ? `attachment;${params.join(";")}` : "attachment";
}

/** New streaming Response from an upstream 2xx: body untouched, headers allow-listed and hardened. */
export function streamResponse(upstream: Response): Response {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  for (const name of DOWNLOAD_HEADER_ALLOWLIST) {
    const v = upstream.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  headers.set("Content-Disposition", attachmentDisposition(upstream.headers.get("content-disposition")));
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * GET an export endpoint and stream it back. Options are typed per path (query, pathParams,
 * accept). Non-2xx throws HghApiError (map it with hghErrorResponse in the route handler).
 * Timeout class "file" (120 s) covers the body.
 */
export async function relayDownload<P extends HghPathFor<"get">>(
  path: P,
  ...args: OptsArgs<HghRawOptions<P, "get">>
): Promise<Response> {
  const upstream = await hghRaw<"get", P>("get", path, ...args);
  return streamResponse(upstream);
}

export type RelayUploadOptions<P extends HghUploadPath> = Omit<HghOptions<P, "post">, "body"> & {
  /** "multipart" (default): FormData field `field`; "raw": the file itself as the body (xlsx endpoints accept both). */
  mode?: "multipart" | "raw";
  field?: string;
  /** File name for multipart when the Blob is not a File. */
  filename?: string;
  limitBytes?: number;
};

/** Relay one uploaded file to a backend import endpoint and return its JSON answer. */
export async function relayUpload<P extends HghUploadPath>(
  path: P,
  file: Blob,
  ...args: OptsArgs<RelayUploadOptions<P>>
): Promise<unknown> {
  const { mode = "multipart", field = "file", filename, limitBytes, ...rest } = (args[0] ?? {}) as RelayUploadOptions<P>;
  assertUploadSize(file, limitBytes ?? uploadLimitBytes());
  let body: FormData | Blob;
  if (mode === "raw") {
    body = file;
  } else {
    body = new FormData();
    const name = filename ?? (typeof File !== "undefined" && file instanceof File ? file.name : "upload");
    body.append(field, file, name);
  }
  // `rest` is HghOptions<P, "post"> without body; the upload body is typed by HghUploadPath.
  const res = await hghRaw("post", path, { ...rest, body, accept: "application/json" } as never);
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HghApiError(502, LOCAL_CODES.nonJson, "upload answer is not JSON");
  }
}

// ── QA session cookie relay (design 1.4) ─────────────────────────────────────

export interface QaCookieRelayOptions {
  /** Require the Secure attribute. Default: NODE_ENV === "production". */
  requireSecure?: boolean;
}

const QA_VALUE_RE = /^[A-Za-z0-9._~-]{1,4096}$/;
const ALLOWED_ATTRS = new Set(["path", "httponly", "secure", "samesite", "expires", "max-age"]);

/**
 * Is this Set-Cookie line the QA session cookie in the shape the backend issues
 * (back/app/features/qa/review/sessions/router.py: set_cookie / delete_cookie)?
 * Returns the reason when not. The cookie value is never part of the reason.
 */
export function checkQaSetCookie(line: string, opts: QaCookieRelayOptions = {}): { ok: true } | { ok: false; reason: string } {
  const requireSecure = opts.requireSecure ?? process.env.NODE_ENV === "production";
  const [pair, ...attrParts] = line.split(";");
  const eq = pair.indexOf("=");
  const name = (eq < 0 ? pair : pair.slice(0, eq)).trim();
  const value = eq < 0 ? "" : pair.slice(eq + 1).trim();
  if (name !== QA_COOKIE) return { ok: false, reason: `name ${name.slice(0, 40)} is not ${QA_COOKIE}` };
  if (!(value === "" || value === '""' || QA_VALUE_RE.test(value))) return { ok: false, reason: "value charset" };
  const attrs = new Map<string, string>();
  for (const part of attrParts) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    const key = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
    attrs.set(key, i < 0 ? "" : p.slice(i + 1).trim());
  }
  if (attrs.has("domain")) return { ok: false, reason: "Domain attribute (must be host-only)" };
  for (const key of attrs.keys()) if (!ALLOWED_ATTRS.has(key)) return { ok: false, reason: `attribute ${key.slice(0, 40)}` };
  if (attrs.get("path") !== "/") return { ok: false, reason: "Path must be /" };
  if (!attrs.has("httponly")) return { ok: false, reason: "HttpOnly missing" };
  const sameSite = attrs.get("samesite")?.toLowerCase();
  if (sameSite !== "lax" && sameSite !== "strict") return { ok: false, reason: "SameSite must be Lax or Strict" };
  if (requireSecure && !attrs.has("secure")) return { ok: false, reason: "Secure missing" };
  return { ok: true };
}

/**
 * Append the upstream QA session Set-Cookie (issue or clear) to `target`. Every other
 * Set-Cookie, and a QA cookie in any other shape, is dropped and logged by name and reason.
 */
export function relaySetCookies(
  upstream: Response,
  target: Headers,
  opts: QaCookieRelayOptions = {},
): { relayed: number; rejected: number } {
  let relayed = 0;
  let rejected = 0;
  for (const line of upstream.headers.getSetCookie()) {
    const check = checkQaSetCookie(line, opts);
    if (check.ok) {
      target.append("Set-Cookie", line);
      relayed += 1;
    } else {
      rejected += 1;
      console.warn(`[hgh] upstream Set-Cookie dropped: ${check.reason}`);
    }
  }
  return { relayed, rejected };
}
