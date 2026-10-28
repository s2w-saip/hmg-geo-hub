import "server-only";

// HUB login, Global prompt editing and saved filters on the BFF (back/bff/app.py: /v1/auth/*,
// /v1/hub/global-prompts*, /v1/hub/saved-filters*).
// Server only: the token comes from the httpOnly cookie and goes out as `Authorization: Bearer`, so the
// browser never calls the BFF. Non-2xx -> HghApiError(status, code, message, details) from the envelope.
import { HghApiError, LOCAL_CODES, isHghApiError, parseErrorBody } from "@/lib/hgh/errors";
import { baseUrl } from "@/lib/screen";

export type HubMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const TIMEOUT_MS = 20_000;

export interface HubUser {
  id: string;
  login: string;
  email: string | null;
  displayName: string | null;
  role: "admin";
}

export async function hubFetch<T>(
  method: HubMethod,
  path: string,
  opts: { token?: string; body?: unknown; query?: string } = {},
): Promise<T> {
  if (!/^\/v1\/(auth|hub)\/[a-z0-9/-]+$/.test(path)) throw new TypeError(`invalid HUB path: ${path}`);
  const url = new URL(path, baseUrl());
  if (opts.query) url.search = opts.query;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const ctx = { method, path: url.pathname };
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: "no-store",
      signal: timeout,
    });
  } catch (e) {
    if (timeout.aborted) throw new HghApiError(504, LOCAL_CODES.timeout, `no response within ${TIMEOUT_MS} ms`, undefined, ctx);
    throw new HghApiError(502, LOCAL_CODES.network, String((e as Error)?.message ?? e), undefined, ctx);
  }
  const text = await res.text();
  if (!res.ok) {
    const err = parseErrorBody(res.status, text, res.headers.get("content-type"));
    throw new HghApiError(res.status, err.code, err.message, err.details, ctx);
  }
  return JSON.parse(text) as T;
}

export async function hubLogin(login: string, password: string): Promise<{ token: string; expiresAt: number; user: HubUser }> {
  return (await hubFetch<{ data: { token: string; expiresAt: number; user: HubUser } }>("POST", "/v1/auth/login", { body: { login, password } })).data;
}

/** The token's account while it is a signed-in top-level administrator; null when the BFF refuses it (401). */
export async function hubMe(token: string): Promise<HubUser | null> {
  try {
    return (await hubFetch<{ data: { user: HubUser } }>("GET", "/v1/auth/me", { token })).data.user;
  } catch (e) {
    if (isHghApiError(e) && e.status === 401) return null;
    throw e;
  }
}
