import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// react-server build so cache() (in-request dedupe) really memoizes; see test/request-scope.ts.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});

// Observe whether the trace writer touches the filesystem at all.
const appendSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    appendFile: async (...args: Parameters<typeof orig.appendFile>) => {
      appendSpy.calls += 1;
      return orig.appendFile(...args);
    },
  };
});

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("./auth");
const { HghApiError } = await import("./errors");
const client = await import("./client");
const { hghDelete, hghGet, hghPost, hghRaw, readHghConfig, hghSource, sourceGroupFor, clientIpFromHeaders, RELAY_HEADERS, fillPath, selectTraceValues } =
  client;

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const FRESH = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ2In0.bmV3";
const SECRET = "relay-secret-0123456789";
const BASE = "https://api.hgh.test";

interface Call {
  url: string;
  init: RequestInit;
  headers: Headers;
}
let calls: Call[] = [];
type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

function mockFetch(...responders: Responder[]) {
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init, headers: new Headers(init.headers) });
    const r = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return r(u, init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const envelopeErr = (status: number, code: string) => json(status, { error: { code, message: `m ${code}`, details: null } });
const ok = (data: unknown = { ok: true }) => () => json(200, { data, meta: { mode: "snapshot" } });
const networkError = () => {
  throw new TypeError("fetch failed");
};

let refreshCalls = 0;
beforeEach(() => {
  calls = [];
  refreshCalls = 0;
  appendSpy.calls = 0;
  vi.stubEnv("HGH_API_BASE_URL", BASE);
  vi.stubEnv("HGH_API_TIMEOUT_MS", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_API_TRACE_SELECT", "");
  vi.stubEnv("VERCEL", "");
  bindHghAuth({
    getAccessToken: async () => TOKEN,
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return FRESH;
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  bindHghAuth(null);
});

describe("config", () => {
  it("HGH_API_BASE_URL is required, https only (http allowed for localhost), trailing slash dropped", () => {
    expect(() => readHghConfig({})).toThrow(expect.objectContaining({ status: 500, code: "client_config" }));
    expect(() => readHghConfig({ HGH_API_BASE_URL: "http://api.example.com" })).toThrow(/https/);
    expect(() => readHghConfig({ HGH_API_BASE_URL: "https://u:p@api.example.com" })).toThrow(/credentials/);
    expect(readHghConfig({ HGH_API_BASE_URL: "http://127.0.0.1:18080/" }).baseUrl).toBe("http://127.0.0.1:18080");
    expect(readHghConfig({ HGH_API_BASE_URL: "https://cdn.example.com/api/" }).baseUrl).toBe("https://cdn.example.com/api");
  });

  it("timeout override and relay secret are validated", () => {
    expect(readHghConfig({ HGH_API_BASE_URL: BASE, HGH_API_TIMEOUT_MS: "2500" }).readTimeoutMs).toBe(2500);
    expect(() => readHghConfig({ HGH_API_BASE_URL: BASE, HGH_API_TIMEOUT_MS: "fast" })).toThrow(/HGH_API_TIMEOUT_MS/);
    expect(() => readHghConfig({ HGH_API_BASE_URL: BASE, HGH_RELAY_SECRET: "short" })).toThrow(/HGH_RELAY_SECRET/);
  });

  it("missing base URL fails the call before any fetch", async () => {
    vi.stubEnv("HGH_API_BASE_URL", "");
    const f = mockFetch(ok());
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ status: 500, code: "client_config" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("request shape", () => {
  it("GET: base + path + sorted query, Bearer, Accept json, X-Request-Id, no-store, no redirects followed", async () => {
    mockFetch(ok({ role: "admin" }));
    const query = { surface: "global" as const, country: ["US"], engine: ["chatgpt", "gemini"] };
    const out = await hghGet("/v1/kpi/summary", { query });
    expect(out).toEqual({ data: { role: "admin" }, meta: { mode: "snapshot" } });
    const [c] = calls;
    expect(c.url).toBe(`${BASE}/v1/kpi/summary?country=US&engine=chatgpt&engine=gemini&surface=global`);
    expect(c.init.method).toBe("GET");
    expect(c.init.cache).toBe("no-store");
    expect(c.init.redirect).toBe("manual");
    expect(c.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(c.headers.get("accept")).toBe("application/json");
    expect(c.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.init.body).toBeUndefined();
  });

  it("cf custom fields are sent as cf.<uuid> next to the typed query", async () => {
    mockFetch(ok());
    const field = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const query = { surface: "project" as const, project_id: "0f8fad5b-d9cb-469f-a165-70867728950e" };
    const cf = { [field]: ["a", "b"] };
    await hghGet("/v1/kpi/summary", { query: { ...query, cycle_offset: 0 }, cf });
    expect(new URL(calls[0].url).searchParams.getAll(`cf.${field}`)).toEqual(["a", "b"]);
    expect(new URL(calls[0].url).search).toBe(
      `?cf.${field}=a&cf.${field}=b&cycle_offset=0&project_id=0f8fad5b-d9cb-469f-a165-70867728950e&surface=project`,
    );
  });

  it("path params are filled and encoded", async () => {
    mockFetch(ok());
    await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: "a b/c" } });
    expect(calls[0].url).toBe(`${BASE}/v1/projects/a%20b%2Fc`);
  });

  it("dot segments and empty path values are refused before any fetch (no route escape)", async () => {
    const f = mockFetch(ok());
    for (const bad of ["..", ".", ""]) {
      await expect(hghGet("/v1/projects/{project_id}", { pathParams: { project_id: bad } })).rejects.toMatchObject({
        status: 500,
        code: "client_config",
      });
      expect(() => fillPath("/v1/projects/{project_id}/members", { project_id: bad })).toThrow(/must not be empty/);
    }
    expect(f).not.toHaveBeenCalled();
    // Without the guard the URL parser would collapse the segment and hit another route:
    expect(new URL(`${BASE}/v1/projects/../members`).pathname).toBe("/v1/members");
  });

  it("dot-like values that are not dot segments stay inside their segment", async () => {
    mockFetch(ok(), ok(), ok());
    await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: "..." } });
    await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: "%2e%2e" } });
    await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: "../x" } });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1/projects/...",
      "/v1/projects/%252e%252e",
      "/v1/projects/..%2Fx",
    ]);
  });

  it("JSON body is serialized with its content type; FormData is left to fetch", async () => {
    mockFetch(ok(), ok());
    await hghDelete("/v1/projects/{project_id}", { pathParams: { project_id: "p" }, body: { confirm_name: "n" } });
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(calls[0].init.body).toBe(JSON.stringify({ confirm_name: "n" }));
    const fd = new FormData();
    fd.append("file", new Blob(["x"]), "a.xlsx");
    await hghPost("/v1/projects/{project_id}/prompts/import", { pathParams: { project_id: "p" }, body: fd });
    expect(calls[1].init.body).toBe(fd);
    expect(calls[1].headers.get("content-type")).toBeNull();
  });

  it("204 -> undefined", async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(hghPost("/v1/projects/{project_id}/members/me/accept", { pathParams: { project_id: "p" } })).resolves.toBeUndefined();
  });
});

describe("errors", () => {
  it("envelope -> HghApiError(status, code) with the request id that was sent", async () => {
    mockFetch(() => envelopeErr(403, "menu_forbidden"));
    const e = await hghGet("/v1/auth/me").catch((x) => x);
    expect(e).toBeInstanceOf(HghApiError);
    expect([e.status, e.code, e.method, e.path]).toEqual([403, "menu_forbidden", "GET", "/v1/auth/me"]);
    expect(e.requestId).toBe(calls[0].headers.get("x-request-id"));
  });

  it("2xx that is not JSON -> 502 upstream_non_json", async () => {
    mockFetch(() => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ status: 502, code: "upstream_non_json" });
  });

  it("CloudFront HTML 502 -> upstream_non_json with status 502", async () => {
    mockFetch(() => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(hghPost("/v1/admin/catalog/prompts/bulk/apply", { body: {} as never })).rejects.toMatchObject({
      status: 502,
      code: "upstream_non_json",
    });
  });
});

describe("auth modes", () => {
  it("no session token -> 401 unauthenticated without calling the backend", async () => {
    bindHghAuth({ getAccessToken: async () => null });
    const f = mockFetch(ok());
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(f).not.toHaveBeenCalled();
  });

  it("unbound provider -> 500 auth_unbound without calling the backend", async () => {
    bindHghAuth(null);
    const f = mockFetch(ok());
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ status: 500, code: "auth_unbound" });
    expect(f).not.toHaveBeenCalled();
  });

  it("malformed token from the provider is never put in a header", async () => {
    bindHghAuth({ getAccessToken: async () => "abc\r\nX-Evil: 1" });
    const f = mockFetch(ok());
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ status: 500 });
    expect(f).not.toHaveBeenCalled();
  });

  it("QA cookie mode sends only Cookie raw_data_qa=..., no Authorization", async () => {
    mockFetch(ok());
    await hghGet("/v1/qa/filters", { auth: { qaCookie: "eyJzIjoxfQ.c2ln" } });
    expect(calls[0].headers.get("cookie")).toBe("raw_data_qa=eyJzIjoxfQ.c2ln");
    expect(calls[0].headers.get("authorization")).toBeNull();
  });

  it("QA cookie missing or with header-breaking characters -> 401 qa_unauthorized, not sent", async () => {
    const f = mockFetch(ok());
    await expect(hghGet("/v1/qa/filters", { auth: { qaCookie: null } })).rejects.toMatchObject({ status: 401, code: "qa_unauthorized" });
    await expect(hghGet("/v1/qa/filters", { auth: { qaCookie: "a;b=c" } })).rejects.toMatchObject({ code: "qa_unauthorized" });
    expect(f).not.toHaveBeenCalled();
  });

  it("auth none and explicit bearer", async () => {
    mockFetch(ok(), ok());
    await hghPost("/v1/qa/sessions", { auth: "none", body: {} as never });
    expect(calls[0].headers.get("authorization")).toBeNull();
    await hghGet("/v1/auth/me", { auth: { bearer: FRESH } });
    expect(calls[1].headers.get("authorization")).toBe(`Bearer ${FRESH}`);
  });
});

describe("retries", () => {
  it("GET: one retry after a connection error", async () => {
    const f = mockFetch(networkError, ok());
    await expect(hghGet("/v1/auth/me")).resolves.toMatchObject({ data: { ok: true } });
    expect(f).toHaveBeenCalledTimes(2);
    expect(calls[0].headers.get("x-request-id")).not.toBe(calls[1].headers.get("x-request-id"));
  });

  it("GET: second connection error -> 502 network_error (only one retry)", async () => {
    const f = mockFetch(networkError, networkError, ok());
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ status: 502, code: "network_error" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("writes are not retried on connection errors or 503", async () => {
    const f = mockFetch(networkError, ok());
    await expect(hghPost("/v1/admin/catalog/prompts/bulk/apply", { body: {} as never })).rejects.toMatchObject({ code: "network_error" });
    expect(f).toHaveBeenCalledTimes(1);
    const g = mockFetch(() => envelopeErr(503, "auth_unavailable"), ok());
    await expect(hghPost("/v1/admin/catalog/prompts/bulk/apply", { body: {} as never })).rejects.toMatchObject({ status: 503 });
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("GET: 503 auth_unavailable retried once; other 503 codes are not", async () => {
    const f = mockFetch(() => envelopeErr(503, "auth_unavailable"), ok());
    await expect(hghGet("/v1/auth/me")).resolves.toBeDefined();
    expect(f).toHaveBeenCalledTimes(2);
    const g = mockFetch(() => envelopeErr(503, "unavailable"), ok());
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ status: 503 });
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("401 token_expired with retryOn401: refresh once, retry with the new token", async () => {
    mockFetch(() => envelopeErr(401, "token_expired"), ok());
    await expect(hghPost("/v1/admin/catalog/prompts/bulk/apply", { body: {} as never, retryOn401: true })).resolves.toBeDefined();
    expect(refreshCalls).toBe(1);
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual([`Bearer ${TOKEN}`, `Bearer ${FRESH}`]);
  });

  it("401 without opt-in, after a failed refresh, twice, or no_account -> 401 surfaces", async () => {
    mockFetch(() => envelopeErr(401, "token_expired"));
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ status: 401, code: "token_expired" });
    expect(refreshCalls).toBe(0);

    const twice = mockFetch(() => envelopeErr(401, "token_expired"));
    await expect(hghGet("/v1/auth/me", { retryOn401: true })).rejects.toMatchObject({ status: 401 });
    expect(twice).toHaveBeenCalledTimes(2);
    expect(refreshCalls).toBe(1);

    const noAccount = mockFetch(() => envelopeErr(401, "no_account"));
    await expect(hghGet("/v1/auth/me", { retryOn401: true })).rejects.toMatchObject({ code: "no_account" });
    expect(noAccount).toHaveBeenCalledTimes(1);
    expect(refreshCalls).toBe(1);

    bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
    const failedRefresh = mockFetch(() => envelopeErr(401, "token_expired"));
    await expect(hghGet("/v1/auth/me", { retryOn401: true })).rejects.toMatchObject({ status: 401 });
    expect(failedRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("timeout and abort", () => {
  // Like fetch: rejects with the signal's reason once aborted (also when already aborted).
  const hang: Responder = (_url, init) =>
    new Promise((_, reject) => {
      if (init.signal?.aborted) return reject(init.signal.reason);
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("timeout -> 504 timeout, never retried", async () => {
    const f = mockFetch(hang);
    await expect(hghGet("/v1/auth/me", { timeoutMs: 30 })).rejects.toMatchObject({ status: 504, code: "timeout" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("HGH_API_TIMEOUT_MS overrides the read default", async () => {
    vi.stubEnv("HGH_API_TIMEOUT_MS", "150");
    mockFetch(hang);
    const t0 = Date.now();
    await expect(hghGet("/v1/auth/me")).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("caller abort is rethrown as the caller's reason, not converted", async () => {
    const f = mockFetch(hang);
    const ac = new AbortController();
    const p = hghGet("/v1/auth/me", { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("user left")), 20);
    await expect(p).rejects.toThrow("user left");
    expect(f).toHaveBeenCalledTimes(1);
    const early = new AbortController();
    early.abort(new Error("gone before start"));
    await expect(hghGet("/v1/auth/me", { signal: early.signal })).rejects.toThrow("gone before start");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("D2 client IP relay headers", () => {
  it("on: clientIp + HGH_RELAY_SECRET -> X-HGH-Client-IP and X-HGH-Relay-Secret", async () => {
    vi.stubEnv("HGH_RELAY_SECRET", SECRET);
    mockFetch(ok());
    await hghPost("/v1/qa/sessions", { auth: "none", body: {} as never, clientIp: "203.0.113.7" });
    expect(calls[0].headers.get(RELAY_HEADERS.clientIp)).toBe("203.0.113.7");
    expect(calls[0].headers.get(RELAY_HEADERS.secret)).toBe(SECRET);
  });

  it("off: no clientIp, no secret, or an invalid IP -> neither header", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(ok());
    await hghGet("/v1/auth/me", { clientIp: "203.0.113.7" }); // secret unset
    vi.stubEnv("HGH_RELAY_SECRET", SECRET);
    await hghGet("/v1/auth/me", { dedupe: false }); // no clientIp
    await hghGet("/v1/auth/me", { clientIp: "not-an-ip\r\n", dedupe: false });
    for (const c of calls) {
      expect(c.headers.get(RELAY_HEADERS.clientIp)).toBeNull();
      expect(c.headers.get(RELAY_HEADERS.secret)).toBeNull();
    }
    expect(calls).toHaveLength(3);
  });

  it("clientIpFromHeaders: x-real-ip, else leftmost x-forwarded-for, validated", () => {
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "1.1.1.1" }))).toBe("198.51.100.2");
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "2001:db8::1, 10.0.0.1" }))).toBe("2001:db8::1");
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "evil" }))).toBeNull();
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });
});

describe("local trace (HGH_API_TRACE_FILE)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hgh-fe-u1-trace-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("off by default: no file, no fs call", async () => {
    mockFetch(ok(), () => envelopeErr(404, "not_found"));
    await hghGet("/v1/auth/me");
    await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: "x" } }).catch(() => undefined);
    expect(appendSpy.calls).toBe(0);
  });

  it("on: one JSONL line per attempt with requestId, route, query, status, ms, body hash; no token", async () => {
    const file = join(dir, "on.jsonl");
    vi.stubEnv("HGH_API_TRACE_FILE", file);
    const body = { data: { v: 1, secret_text: "answer body" }, meta: { mode: "snapshot" } };
    mockFetch(() => json(200, body), () => envelopeErr(404, "not_found"));
    await hghGet("/v1/kpi/summary", { query: { surface: "global", engine: ["gemini", "chatgpt"] } });
    await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: "p1" } }).catch(() => undefined);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("answer body"); // hashes only, never the body
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      method: "GET",
      route: "/v1/kpi/summary",
      path: "/v1/kpi/summary",
      query: { engine: ["gemini", "chatgpt"], surface: ["global"] },
      status: 200,
      attempt: 1,
      requestId: calls[0].headers.get("x-request-id"),
      bodySha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    });
    expect(typeof lines[0].ms).toBe("number");
    expect(lines[0].body).toBeUndefined();
    expect(lines[0].values).toBeUndefined();
    expect(lines[1]).toMatchObject({ route: "/v1/projects/{project_id}", path: "/v1/projects/p1", status: 404, code: "not_found" });
  });

  it("HGH_API_TRACE_SELECT adds only the selected values (scalars, array lengths); retries log each attempt", async () => {
    const file = join(dir, "select.jsonl");
    const select = join(dir, "select.json");
    writeFileSync(
      select,
      JSON.stringify({
        "/v1/kpi/summary": ["data.cards[0].visibility.num", "data.cards.length", "meta.as_of", "data.cards", "data.missing", "data.text"],
      }),
    );
    vi.stubEnv("HGH_API_TRACE_FILE", file);
    vi.stubEnv("HGH_API_TRACE_SELECT", select);
    const body = {
      data: { cards: [{ visibility: { num: 7, den: 10 } }, { visibility: { num: 1, den: 2 } }], text: "x".repeat(500) },
      meta: { mode: "snapshot", as_of: "2026-09-25" },
    };
    mockFetch(networkError, () => json(200, body), ok());
    await hghGet("/v1/kpi/summary", { query: { surface: "global" } });
    await hghGet("/v1/auth/me"); // route not in the selection: hash only
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.attempt, l.status, l.code ?? null])).toEqual([
      [1, 0, "network_error"],
      [2, 200, null],
      [1, 200, null],
    ]);
    expect(lines[1].values).toEqual({
      "data.cards[0].visibility.num": 7,
      "data.cards.length": 2,
      "meta.as_of": "2026-09-25",
      "data.cards": "<non-scalar>",
      "data.missing": null,
      "data.text": "x".repeat(200),
    });
    expect(lines[1].body).toBeUndefined();
    expect(lines[2].values).toBeUndefined();
  });

  it("the selection file is ignored without HGH_API_TRACE_FILE, and a broken one never fails the request", async () => {
    const select = join(dir, "broken.json");
    writeFileSync(select, "{not json");
    vi.stubEnv("HGH_API_TRACE_SELECT", select);
    mockFetch(ok());
    await expect(hghGet("/v1/auth/me")).resolves.toBeDefined();
    expect(appendSpy.calls).toBe(0);
    const file = join(dir, "broken-select.jsonl");
    vi.stubEnv("HGH_API_TRACE_FILE", file);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(hghGet("/v1/kpi/summary", { query: { surface: "global" } })).resolves.toBeDefined();
    expect(JSON.parse(readFileSync(file, "utf8").trim()).values).toBeUndefined();
  });

  it("selectTraceValues cannot copy a whole response", () => {
    expect(selectTraceValues({ a: { b: [1, 2, 3] } }, ["", "a", "a.b", "a.b[1]", "a.b.length", "a.__proto__"])).toEqual({
      "": "<non-scalar>",
      a: "<non-scalar>",
      "a.b": "<non-scalar>",
      "a.b[1]": 2,
      "a.b.length": 3,
      "a.__proto__": null,
    });
  });

  it("ignored on Vercel even when set", async () => {
    const file = join(dir, "vercel.jsonl");
    vi.stubEnv("HGH_API_TRACE_FILE", file);
    vi.stubEnv("VERCEL", "1");
    mockFetch(ok());
    await hghGet("/v1/auth/me");
    expect(existsSync(file)).toBe(false);
  });
});

describe("in-request GET dedupe", () => {
  it("same (route, query) in one request -> one fetch; different query or POST -> separate", async () => {
    const f = mockFetch(ok(), ok(), ok(), ok(), ok());
    await withRequestScope(async () => {
      const [a, b] = await Promise.all([
        hghGet("/v1/kpi/summary", { query: { surface: "global", engine: ["x"], cycle_offset: 1 } }),
        hghGet("/v1/kpi/summary", { query: { cycle_offset: 1, engine: ["x"], surface: "global" } }),
      ]);
      expect(a).toBe(b);
      await hghGet("/v1/kpi/summary", { query: { surface: "global", cycle_offset: 0 } });
      await hghPost("/v1/qa/sessions", { auth: "none", body: {} as never });
      await hghPost("/v1/qa/sessions", { auth: "none", body: {} as never });
    });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("dedupe:false and separate requests are not folded", async () => {
    const f = mockFetch(ok());
    await withRequestScope(async () => {
      await hghGet("/v1/auth/me");
      await hghGet("/v1/auth/me", { dedupe: false });
    });
    await withRequestScope(async () => hghGet("/v1/auth/me"));
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("hghRaw", () => {
  it("returns the unread 2xx Response; non-2xx still throws", async () => {
    mockFetch(
      () => new Response("a,b\r\n", { status: 200, headers: { "content-type": "text/csv" } }),
      () => envelopeErr(422, "unprocessable"),
    );
    const res = await hghRaw("get", "/v1/qa/notes/export", { auth: { qaCookie: "abc.def" }, accept: "text/csv" });
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("a,b\r\n");
    expect(calls[0].headers.get("accept")).toBe("text/csv");
    await expect(hghRaw("get", "/v1/qa/notes/export", { auth: { qaCookie: "abc.def" } })).rejects.toMatchObject({ status: 422 });
  });
});

describe("source flags (D8)", () => {
  it("default legacy; api only for 'api'; anything else legacy with one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(hghSource("G1", {})).toBe("legacy");
    expect(hghSource("G1", { HGH_SOURCE_G1: "api" })).toBe("api");
    expect(hghSource("G1", { HGH_SOURCE_G1: " API " })).toBe("api");
    expect(hghSource("G2", { HGH_SOURCE_G2: "legacy" })).toBe("legacy");
    expect(hghSource("G3", { HGH_SOURCE_G3: "yes" })).toBe("legacy");
    expect(hghSource("G3", { HGH_SOURCE_G3: "yes" })).toBe("legacy");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("group per (area, surface)", () => {
    const table: Array<[Parameters<typeof sourceGroupFor>[0], Parameters<typeof sourceGroupFor>[1], string]> = [
      ["dashboard", "global", "G1"],
      ["analysis", "global", "G2"],
      ["funnel", "global", "G4"],
      ["prompts", "global", "G5"],
      ["dashboard", "website", "G3"],
      ["analysis", "website", "G3"],
      ["prompts", "website", "G3"],
      ["dashboard", "project", "G6"],
      ["analysis", "project", "G6"],
      ["projects", "global", "G6"],
      ["intent", "project", "G6"],
      ["admin", "global", "G7"],
      ["qa", "global", "G7"],
      ["session", "global", "SESSION"],
    ];
    for (const [area, surface, group] of table) expect(`${area}/${surface}:${sourceGroupFor(area, surface)}`).toBe(`${area}/${surface}:${group}`);
  });
});
