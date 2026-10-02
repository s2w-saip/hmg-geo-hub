import "server-only";

// Credentials for backend calls (design 1.3, 1.4, 7.1). Server only: tokens and the QA
// cookie never reach client props, logs or the browser bundle.
//
// Access token (owned by U2): the backend accepts `Authorization: Bearer <Supabase access
// token>` only. The token comes straight from the Supabase cookie session through the
// existing server client (utils/supabase/server.ts::createSupabaseServerClient, design 1.1):
//
//   getAccessToken()     getClaims() verifies the JWT, then the verified session's
//                        access_token. null = no session. Memoized per request (React cache),
//                        so a page with N backend calls verifies once. Note: getClaims() goes
//                        through supabase getSession(), which IMPLICITLY refreshes a token that
//                        is about to expire, in any context, writing cookies only where the
//                        context allows. That is the same exposure as the legacy getSession
//                        (same call); the middleware refresh on every navigation keeps it rare
//                        in server components.
//   refreshAccessToken() one EXPLICIT refresh for the 401 retry of route handlers and server
//                        actions (client.ts `retryOn401`). A server component cannot write
//                        cookies: refreshing there would rotate the refresh token into a cookie
//                        that is never stored, and the next middleware refresh would present the
//                        old refresh token, which Supabase treats as reuse and revokes the
//                        session. So in a read-only cookie context it does no explicit refresh
//                        (null, Supabase not called); server components rely on the middleware
//                        refresh (design 6.2) and send 401 to /login.
//
// No module has to run first (design 7.1: load-order dependency removed). bindHghAuth is kept
// only as a test injection seam and refuses to bind outside a test runner.
//
// Never logged: token values, cookie values. Errors carry codes only.
import { cache } from "react";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { HghApiError, LOCAL_CODES } from "./errors";

export interface HghAuthBinding {
  getAccessToken(): Promise<string | null>;
  refreshAccessToken?(): Promise<string | null>;
}

const SLOT = Symbol.for("hgh.auth.binding");
type Slot = { [SLOT]?: HghAuthBinding | null };

type Env = Record<string, string | undefined>;

/** Vitest sets VITEST; NODE_ENV=test covers other runners. Next dev/build never set either. */
export function isTestRunner(env: Env = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

/**
 * Test seam: bind (or with null, unbind) a token provider that replaces the Supabase
 * session. Refused outside a test runner so production can never run on an injected token.
 */
export function bindHghAuth(binding: HghAuthBinding | null): void {
  if (binding && !isTestRunner()) {
    throw new HghApiError(500, LOCAL_CODES.config, "bindHghAuth is a test seam; tokens come from the Supabase session");
  }
  (globalThis as Slot)[SLOT] = binding;
}

export function isHghAuthBound(): boolean {
  return Boolean((globalThis as Slot)[SLOT]);
}

function boundProvider(): HghAuthBinding | null {
  return (globalThis as Slot)[SLOT] ?? null;
}

// A JWT is three base64url segments. Anything else (whitespace, CR/LF) must never reach a header.
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function checkToken(token: string | null | undefined): string | null {
  if (token === null || token === undefined) return null;
  if (typeof token !== "string" || token.length > 16384 || !TOKEN_RE.test(token)) {
    throw new HghApiError(500, LOCAL_CODES.config, "access-token provider returned a malformed token");
  }
  return token;
}

// ── Supabase session provider (runtime default) ──────────────────────────────

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

async function supabaseClient(): Promise<SupabaseServerClient> {
  try {
    return await createSupabaseServerClient();
  } catch (e) {
    // Next's own control flow (cookies() during a static prerender marks the page dynamic, and
    // postpone/redirect signals) must pass through: swallowing it failed the build (/ko, 2026-09-30).
    unstable_rethrow(e);
    // Outside a request (cookies() unavailable) or NEXT_PUBLIC_SUPABASE_* unset. Fail loudly
    // instead of sending anonymous requests (which would read as "logged out").
    throw new HghApiError(500, LOCAL_CODES.authUnbound, "no Supabase session context (outside a request, or Supabase env unset)");
  }
}

/** Verified session token, or null. Same verification as the legacy getSession (getClaims). */
async function readSessionToken(): Promise<string | null> {
  const supabase = await supabaseClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  // getClaims() went through getSession() (refreshing if needed); this reads the same
  // in-memory session. Only access_token is touched (no user object on the server).
  const { data: s } = await supabase.auth.getSession();
  return s.session?.access_token ?? null;
}

// Per-request box. A successful refresh replaces the promise so later calls in the same
// request use the new token. Without an active React request cache (route handlers) every
// call gets a fresh box, i.e. no memo, which is still correct.
interface TokenBox {
  pending: Promise<string | null> | null;
}
const requestTokenBox = cache((): TokenBox => ({ pending: null }));

// Probe cookie: deleting a cookie the browser never had is the cheapest write that throws in a
// read-only (server component) cookie store. It is NOT free where it succeeds, so it runs only
// on the 401 retry path, right before a refresh that mutates the auth cookies anyway:
//   - the response carries a Set-Cookie deleting __hgh_cookie_write_probe (Max-Age 0 / epoch
//     Expires). The browser has no such cookie, so its jar does not change;
//   - in a server action any cookie mutation makes Next send `x-action-revalidated` with the
//     cookie flag (next/dist/server/app-render/action-handler.js addRevalidationHeader), and
//     the client router drops its cache. The refresh that follows would set the same flag.
export const COOKIE_WRITE_PROBE = "__hgh_cookie_write_probe";

/** True in route handlers and server actions, false in server components. */
export async function canWriteCookies(): Promise<boolean> {
  try {
    (await cookies()).delete(COOKIE_WRITE_PROBE);
    return true;
  } catch (e) {
    unstable_rethrow(e); // a dynamic-usage signal is not "read-only cookies"
    return false;
  }
}

/** Current Supabase access token, or null when the user has no session. */
export async function getAccessToken(): Promise<string | null> {
  const bound = boundProvider();
  if (bound) return checkToken(await bound.getAccessToken());
  const box = requestTokenBox();
  if (!box.pending) {
    box.pending = readSessionToken().catch((e: unknown) => {
      box.pending = null; // a failed read must not stick for the rest of the request
      throw e;
    });
  }
  return checkToken(await box.pending);
}

/**
 * Explicitly refresh once and return the new token. null when refresh is impossible: no
 * session, Supabase refused, or a server component (read-only cookies: no explicit refresh,
 * see header).
 */
export async function refreshAccessToken(): Promise<string | null> {
  const bound = boundProvider();
  if (bound) return bound.refreshAccessToken ? checkToken(await bound.refreshAccessToken()) : null;
  if (!(await canWriteCookies())) return null;
  const supabase = await supabaseClient();
  const { data, error } = await supabase.auth.refreshSession();
  const token = checkToken(error ? null : (data.session?.access_token ?? null));
  if (token) requestTokenBox().pending = Promise.resolve(token);
  return token;
}

// ── QA console cookie (design 1.4) ───────────────────────────────────────────

/** Same name and format as today: base64url(JSON{sessionId,name,issuedAt}).HMAC. */
export const QA_COOKIE = "raw_data_qa";
const QA_COOKIE_VALUE_RE = /^[A-Za-z0-9._~-]{1,4096}$/;

/**
 * `Cookie` header value carrying only the QA session cookie, or null when the value is
 * absent or not in the signed-cookie charset (never forwarded then: header injection guard).
 * The front does not verify the signature; the backend does.
 */
export function qaCookieHeader(value: string | null | undefined): string | null {
  if (!value || !QA_COOKIE_VALUE_RE.test(value)) return null;
  return `${QA_COOKIE}=${value}`;
}

/** The QA cookie of the current request (server components, route handlers, actions). */
export async function readQaCookie(): Promise<string | null> {
  const value = (await cookies()).get(QA_COOKIE)?.value ?? null;
  return value && QA_COOKIE_VALUE_RE.test(value) ? value : null;
}
