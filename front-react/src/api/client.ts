import { HghApiError, parseErrorBody } from "@/lib/hgh/errors";

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];
export type Query = Readonly<Record<string, QueryValue>>;
export const CONNECTED = import.meta.env.VITE_HUB_CONNECTED === "true";

export function queryString(query: Query = {}): string {
  const result = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== null && v !== undefined && v !== "") result.append(key, String(v));
    }
  }
  return result.toString();
}

/** Only the same-origin HUB is reachable. Session credentials stay in HttpOnly cookies. */
export async function request<T>(path: string, options: {
  method?: string; body?: unknown; query?: Query; signal?: AbortSignal;
  connected?: boolean; fetcher?: typeof fetch;
} = {}): Promise<T> {
  if (!(options.connected ?? CONNECTED)) throw new HghApiError(503, "hub_not_connected");
  if (!/^\/api\/(?!\/)/.test(path) || path.includes("..") || path.includes("\\") || /[?#]/.test(path)) {
    throw new TypeError("Only same-origin /api/ paths are supported");
  }
  const query = queryString(options.query);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(path + (query ? `?${query}` : ""), {
      method: options.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new HghApiError(signal.aborted ? 504 : 502, signal.aborted ? "timeout" : "network_error");
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!response.ok) {
    const detail = parseErrorBody(response.status, text, response.headers.get("content-type"));
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("hub-session-expired"));
    throw new HghApiError(response.status, detail.code, detail.message, detail.details);
  }
  if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) throw new HghApiError(502, "upstream_non_json");
  try { return JSON.parse(text) as T; }
  catch { throw new HghApiError(502, "upstream_non_json"); }
}

export function screen<T>(name: string, query: Query, signal?: AbortSignal): Promise<T> {
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(name)) throw new TypeError("Invalid screen name");
  return request(`/api/screens/${name}`, { query, signal });
}

export function hub<T>(name: string, query: Query = {}, signal?: AbortSignal): Promise<T> {
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(name)) throw new TypeError("Invalid HUB path");
  return request<{ data: T }>(`/api/hub/${name}`, { query, signal }).then(v => v.data);
}
