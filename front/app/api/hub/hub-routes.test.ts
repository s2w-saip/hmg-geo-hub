import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HghApiError } from "@/lib/hgh/errors";

// /api/hub/* (2026-10-27): the local mode's only writes. Same-origin writes only, the session cookie
// set and cleared here, and the BFF's answers and refusals passed through unchanged.

const bff = vi.hoisted(() => ({
  fetch: vi.fn(),
  login: vi.fn(),
}));
vi.mock("@/lib/hub/client", () => ({ hubFetch: bff.fetch, hubLogin: bff.login }));

const session = await import("./session/route");
const prompts = await import("./global-prompts/[[...rest]]/route");

const ID = "8f6f0c1e-2b7a-4c1e-9d2a-1b2c3d4e5f60";
const SITE = "http://127.0.0.1:3333";

function req(method: string, path: string, opts: { body?: unknown; origin?: string | null; cookie?: string } = {}) {
  const headers = new Headers({ host: "127.0.0.1:3333" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? SITE);
  if (opts.cookie) headers.set("cookie", `hgh_hub_session=${opts.cookie}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(new URL(path, SITE), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (rest?: string[]) => ({ params: Promise.resolve({ rest }) });

beforeEach(() => {
  vi.stubEnv("HGH_LOCAL_READ_ONLY", "1");
  bff.fetch.mockReset();
  bff.login.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("POST/DELETE /api/hub/session", () => {
  it("signs in: the token goes into an httpOnly, strict cookie until it expires; only the user reaches the page", async () => {
    bff.login.mockResolvedValue({ token: "v1.tok.sig", expiresAt: 1_800_000_000, user: { login: "admin" } });
    const res = await session.POST(req("POST", "/api/hub/session", { body: { login: "admin", password: "pw" } }));
    expect(res.status).toBe(200);
    expect(bff.login).toHaveBeenCalledWith("admin", "pw");
    expect(await res.json()).toEqual({ user: { login: "admin" } });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hgh_hub_session=v1.tok.sig");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toMatch(/Expires=/i);
  });

  it("refuses cross-site, malformed and non-local requests; passes the BFF's refusal through", async () => {
    expect((await session.POST(req("POST", "/api/hub/session", { body: { login: "a", password: "b" }, origin: "http://evil.test" }))).status).toBe(403);
    expect((await session.POST(req("POST", "/api/hub/session", { body: { login: "a", password: "b" }, origin: null }))).status).toBe(403);
    expect((await session.POST(req("POST", "/api/hub/session", { body: { login: "a" } }))).status).toBe(422);
    bff.login.mockRejectedValue(new HghApiError(429, "rate_limited", "later"));
    const limited = await session.POST(req("POST", "/api/hub/session", { body: { login: "a", password: "b" } }));
    expect([limited.status, (await limited.json()).error.code]).toEqual([429, "rate_limited"]);
    expect(limited.headers.get("set-cookie")).toBeNull();
    vi.stubEnv("HGH_LOCAL_READ_ONLY", "");
    expect((await session.POST(req("POST", "/api/hub/session", { body: { login: "a", password: "b" } }))).status).toBe(404);
  });

  it("signs out by clearing the cookie", async () => {
    const res = await session.DELETE(req("DELETE", "/api/hub/session", { cookie: "v1.tok.sig" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/hgh_hub_session=;.*Max-Age=0/i);
    expect((await session.DELETE(req("DELETE", "/api/hub/session", { origin: "http://evil.test" }))).status).toBe(403);
  });
});

describe("/api/hub/global-prompts", () => {
  it("forwards the token, the allowed list params and nothing else", async () => {
    bff.fetch.mockResolvedValue({ data: { items: [] } });
    const res = await prompts.GET(req("GET", "/api/hub/global-prompts?q=ev&status=all&limit=50&ctx.project=x&token=y", { cookie: "tok", origin: null }), ctx());
    expect(res.status).toBe(200);
    expect(bff.fetch).toHaveBeenCalledWith("GET", "/v1/hub/global-prompts", { token: "tok", body: undefined, query: "q=ev&status=all&limit=50" });
  });

  it("creates with 201 and passes edits, archive and restore through", async () => {
    bff.fetch.mockResolvedValue({ data: { item: {} } });
    expect((await prompts.POST(req("POST", "/api/hub/global-prompts", { body: { text: "x" }, cookie: "tok" }), ctx())).status).toBe(201);
    expect(bff.fetch).toHaveBeenLastCalledWith("POST", "/v1/hub/global-prompts", { token: "tok", body: { text: "x" }, query: "" });
    expect((await prompts.PUT(req("PUT", `/api/hub/global-prompts/${ID}`, { body: { text: "y", expectedVersion: 2 }, cookie: "tok" }), ctx([ID]))).status).toBe(200);
    expect((await prompts.POST(req("POST", `/api/hub/global-prompts/${ID}/archive`, { body: { expectedVersion: 3 }, cookie: "tok" }), ctx([ID, "archive"]))).status).toBe(200);
    expect(bff.fetch).toHaveBeenLastCalledWith("POST", `/v1/hub/global-prompts/${ID}/archive`, { token: "tok", body: { expectedVersion: 3 }, query: "" });
  });

  it("refuses unknown paths, missing sessions, cross-site writes and bad bodies before the BFF", async () => {
    const cases: Array<[Promise<Response>, number]> = [
      [prompts.GET(req("GET", "/api/hub/global-prompts/x", { cookie: "tok" }), ctx(["x"])), 404],
      [prompts.POST(req("POST", `/api/hub/global-prompts/${ID}/delete`, { body: {}, cookie: "tok" }), ctx([ID, "delete"])), 404],
      [prompts.PUT(req("PUT", "/api/hub/global-prompts", { body: {}, cookie: "tok" }), ctx()), 404],
      [prompts.GET(req("GET", "/api/hub/global-prompts"), ctx()), 401],
      [prompts.PUT(req("PUT", `/api/hub/global-prompts/${ID}`, { body: {}, cookie: "tok", origin: "http://evil.test" }), ctx([ID])), 403],
      [prompts.POST(req("POST", "/api/hub/global-prompts", { cookie: "tok" }), ctx()), 422],
    ];
    for (const [res, status] of cases) expect((await res).status).toBe(status);
    expect(bff.fetch).not.toHaveBeenCalled();
  });

  it("passes the BFF's refusal with its code, message and details", async () => {
    bff.fetch.mockRejectedValue(new HghApiError(409, "version_conflict", "reload", { currentVersion: 4 }));
    const res = await prompts.PUT(req("PUT", `/api/hub/global-prompts/${ID}`, { body: { text: "y", expectedVersion: 2 }, cookie: "tok" }), ctx([ID]));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "version_conflict", message: "reload", details: { currentVersion: 4 } } });
  });
});
