import "server-only";

// Screen reads (BFF on the API side). Pages fetch a finished view model from
// GET /v1/screens/<name> and render it; every calculation lives in the API.
//
//   const vm = await screenGet<OverviewScreen>("overview", { surface: "global", ...searchParams });
//
// Contract: server only, no result cache (`no-store`), one shared request per (name, query)
// inside a server request, non-2xx -> HghApiError(status, code) from the error envelope so
// the existing failure states keep working.
import { HghApiError, LOCAL_CODES, parseErrorBody } from "@/lib/hgh/errors";
import { dedupeInRequest, stableKey } from "@/lib/request-dedupe";
import { HGH_TIMEOUTS, requestCallLimiter } from "@/lib/hgh/client";
import { streamResponse } from "@/lib/hgh/relay";

export type ScreenQueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];
export type ScreenQuery = Readonly<Record<string, ScreenQueryValue>>;

const DEFAULT_TIMEOUT_MS = 60_000;

function baseUrl(): URL {
  const raw = process.env.HGH_API_BASE_URL;
  if (!raw) throw new HghApiError(500, LOCAL_CODES.config, "HGH_API_BASE_URL is not set");
  const url = new URL(raw);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new HghApiError(500, LOCAL_CODES.config, "HGH_API_BASE_URL must be https (http only for localhost)");
  }
  return url;
}

/** Same serialization as the API client: arrays repeat the key, keys sorted, empty values dropped. */
export function screenSearch(query: ScreenQuery): string {
  const out = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined || v === null || v === "") continue;
      out.append(key, String(v));
    }
  }
  return out.toString();
}

const RETRY_DELAY_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One screen exchange with the API client's rules: it holds one of the request's call slots
 * (lib/hgh/client requestCallLimiter, HGH_MAX_CONCURRENT_CALLS) only while the exchange runs,
 * and a connection error (no answer, not a timeout) is retried once 200 ms later.
 */
async function exchange(url: URL, timeoutMs: number, readBody: boolean): Promise<{ res: Response; text: string }> {
  const limiter = requestCallLimiter();
  for (let attempt = 1; ; attempt += 1) {
    const slot = limiter ? await limiter.acquire() : null;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" }, signal: timeout });
      const text = readBody || !res.ok ? await res.text() : "";
      return { res, text };
    } catch (e) {
      if (timeout.aborted) {
        throw new HghApiError(504, LOCAL_CODES.timeout, `no response within ${timeoutMs} ms`, undefined, { method: "GET", path: url.pathname });
      }
      if (attempt === 1) {
        slot?.release();
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new HghApiError(502, LOCAL_CODES.network, String((e as Error)?.message ?? e), undefined, { method: "GET", path: url.pathname });
    } finally {
      slot?.release();
    }
  }
}

function screenUrl(name: string, query: ScreenQuery): URL {
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(name)) throw new TypeError(`invalid screen name: ${name}`);
  const url = new URL(`/v1/screens/${name}`, baseUrl());
  url.search = screenSearch(query);
  return url;
}

async function fetchScreen<T>(name: string, query: ScreenQuery): Promise<T> {
  const url = screenUrl(name, query);
  const timeoutMs = Number(process.env.HGH_SCREEN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const { res, text } = await exchange(url, timeoutMs, true);
  if (!res.ok) {
    const err = parseErrorBody(res.status, text, res.headers.get("content-type"));
    throw new HghApiError(res.status, err.code, err.message, err.details, { method: "GET", path: url.pathname });
  }
  return JSON.parse(text) as T;
}

export function screenGet<T>(name: string, query: ScreenQuery = {}): Promise<T> {
  return dedupeInRequest(`screen:${name}:${stableKey(screenSearch(query))}`, () => fetchScreen<T>(name, query));
}

/**
 * Stream a screen's answer back unchanged (downloads). Same headers as lib/hgh/relay
 * streamResponse; non-2xx -> HghApiError (map it with hghErrorResponse in the route).
 */
export async function screenRelay(name: string, query: ScreenQuery = {}): Promise<Response> {
  const url = screenUrl(name, query);
  const { res, text } = await exchange(url, HGH_TIMEOUTS.file, false);
  if (!res.ok) {
    const err = parseErrorBody(res.status, text, res.headers.get("content-type"));
    throw new HghApiError(res.status, err.code, err.message, err.details, { method: "GET", path: url.pathname });
  }
  return streamResponse(res);
}
