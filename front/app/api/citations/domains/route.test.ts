import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// /api/citations/domains, /[skey], /export (unit U7): validation, then session, the place gate
// and the project gate on BOTH sources (U4 verification F1), then the source switch (api only:
// the legacy screens never call these routes). Then each route is a thin proxy to its screen
// (back/bff/screens/citation.py): the answer is the screen's; screen errors keep their status
// with {error:{code}}.

const st = vi.hoisted(() => ({
  session: null as unknown,
  membership: { status: "active" } as unknown,
  project: { id: "p" } as unknown,
}));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/scope/server", () => ({}));
vi.mock("@/lib/db/repositories/request-cache", () => ({
  cachedProjectById: async () => st.project,
  cachedMembership: async () => st.membership,
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { encodeSkey } = await import("@/lib/hgh/citation-route");
const list = await import("./route");
const detail = await import("./[skey]/route");
const exporter = await import("./export/route");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const session = (o: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "x", role: "admin", scope: { all: true }, operator: "none", menuGroups: null, ...o },
});
const req = (path: string, qs: string) => new NextRequest(`https://front.test${path}?${qs}`);
const getList = (qs: string) => list.GET(req("/api/citations/domains", qs));
const getDetail = (skey: string, qs: string) =>
  detail.GET(req(`/api/citations/domains/${skey}`, qs), { params: Promise.resolve({ skey }) });
const getExport = (qs: string) => exporter.GET(req("/api/citations/domains/export", qs));

const apiLog: URL[] = [];
const ROW = { domain: "a.example", citations: 3, share: 50, prompts: 2, coverageRate: 20, urls: [], promptList: [], isOurs: false, category: null, subcategory: null, skey: "a.example", rank: 4, no: 4 };
let backend: (url: URL) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// The routes are thin proxies to the screens (back/bff/screens/citation.py): the stub answers them.
const defaultBackend = (url: URL): Response => {
  if (url.pathname === "/v1/screens/citation/domains") return json({ rows: [ROW], nextCursor: "n1", total: 201, views: { "": { idx: [0], maxCit: 3, maxCov: 20 } } });
  if (url.pathname === "/v1/screens/citation/domain-detail")
    return json({ urls: [{ url: "https://www.instagram.com/hyundai/p/1", title: "P", count: 1, aiProvider: "Gemini", promptText: "q", country: null }], promptList: [], promptOrders: { prompt: { asc: [], desc: [] }, citations: { asc: [], desc: [] }, share: { asc: [], desc: [] } } });
  if (url.pathname === "/v1/screens/citation/domains-export") return json({ error: { code: "not_found", message: "Source not present in Gold" } }, 404);
  if (url.pathname.startsWith("/v1/projects/")) return json({ error: { code: "not_found" } }, 404);
  return json({ error: { code: "not_found" } }, 404);
};

const API = { HGH_SOURCE_G2: "api", HGH_SOURCE_G3: "api", HGH_SOURCE_G6: "api" };
beforeEach(() => {
  st.session = session();
  st.membership = { status: "active" };
  st.project = { id: "p" };
  apiLog.length = 0;
  backend = defaultBackend;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  for (const [k, v] of Object.entries(API)) vi.stubEnv(k, v);
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      const url = new URL(String(u));
      apiLog.push(url);
      return backend(url);
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const code = async (r: Response) => ((await r.json()) as { error?: { code?: string } }).error?.code;

describe("validation (before the session)", () => {
  it("422 invalid_value: bad projectId, sort, dir, limit, q; bad skey segment; bad locale / max_rows", async () => {
    st.session = null; // proves validation runs first
    for (const qs of [`projectId=../x`, "sort=domain", "dir=up", "limit=0", "limit=201", "limit=1.5", `q=${"a".repeat(201)}`, "q=%01"]) {
      const r = await getList(qs);
      expect([qs, r.status]).toEqual([qs, 422]);
    }
    for (const seg of ["a/b", "YQ==", ""]) expect((await getDetail(seg, "")).status).toBe(422);
    for (const qs of ["locale=fr", "max_rows=0", "max_rows=5001", "sort=bogus"]) expect((await getExport(qs)).status).toBe(422);
    expect(apiLog).toEqual([]);
  });
});

describe("gates on both sources", () => {
  it.each([["api"], ["legacy"]])("source %s: 401 without a session, 403 for a role or menu outside the screen family", async (src) => {
    if (src === "legacy") for (const k of Object.keys(API)) vi.stubEnv(k, "legacy");
    st.session = null;
    expect([(await getList("")).status, (await getDetail(encodeSkey("a.example"), "")).status, (await getExport("")).status]).toEqual([401, 401, 401]);
    st.session = session({ role: "vendor", scope: null });
    const r = await getList("");
    expect([r.status, await code(r)]).toEqual([403, "forbidden"]);
    st.session = session({ role: "hq", scope: { brands: ["Hyundai"], regions: [], countries: ["US"] }, menuGroups: ["project"] });
    expect((await getList("surface=website")).status).toBe(403);
    expect(apiLog).toEqual([]);
  });

  it.each([["api"], ["legacy"]])("source %s: project gate (demo project admin only; legacy repository = admin or active member)", async (src) => {
    if (src === "legacy") for (const k of Object.keys(API)) vi.stubEnv(k, "legacy");
    st.session = session({ role: "vendor", scope: null });
    expect((await getList("projectId=de300000-0000-4000-8000-000000000001")).status).toBe(404);
    st.membership = { status: "removed" };
    expect((await getList(`projectId=${PROJECT}`)).status).toBe(404);
    st.membership = { status: "active" };
    st.project = null;
    expect((await getList(`projectId=${PROJECT}`)).status).toBe(404);
    expect(apiLog).toEqual([]);
  });

  it("project gate through the backend when HGH_SOURCE_SESSION=api (404 there -> 404, no data call)", async () => {
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    st.session = session({ role: "vendor", scope: null });
    const r = await getList(`projectId=${PROJECT}`);
    expect(r.status).toBe(404);
    expect(apiLog.map((u) => u.pathname)).toEqual([`/v1/projects/${PROJECT}`]);
  });

  it("legacy source: the routes answer 404 after the gates (the legacy screens carry rows inline)", async () => {
    for (const k of Object.keys(API)) vi.stubEnv(k, "legacy");
    const r = await getList("");
    expect([r.status, await code(r)]).toEqual([404, "not_found"]);
    expect((await getDetail(encodeSkey("a.example"), "")).status).toBe(404);
    expect(apiLog).toEqual([]);
  });

  it("per-surface flags: website api while global legacy", async () => {
    vi.stubEnv("HGH_SOURCE_G2", "legacy");
    expect((await getList("")).status).toBe(404);
    expect((await getList("surface=website")).status).toBe(200);
  });
});

describe("api answers (screen proxies)", () => {
  it("list: the request params as they came + the route context to citation/domains; the screen answer as is", async () => {
    st.session = session({ role: "admin", scope: { all: true } });
    const r = await getList("surface=website&geography=US~HYUNDAI-N&engine=gemini&q=kia&sort=share&dir=asc&cursor=abc&limit=50");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as { rows: { domain: string; no: number }[]; nextCursor: string; total: number };
    expect(body.rows).toEqual([expect.objectContaining({ domain: "a.example", skey: "a.example", rank: 4, no: 4 })]);
    expect([body.nextCursor, body.total]).toEqual(["n1", 201]);
    expect(apiLog.map((u) => u.pathname)).toEqual(["/v1/screens/citation/domains"]);
    const q = apiLog[0].searchParams;
    expect([q.get("ctx.surface"), q.get("ctx.role"), q.get("geography"), q.get("engine"), q.get("q"), q.get("sort"), q.get("dir"), q.get("cursor"), q.get("limit")]).toEqual([
      "website",
      "admin",
      "US~HYUNDAI-N",
      "gemini",
      "kia",
      "share",
      "asc",
      "abc",
      "50",
    ]);
  });

  it("list: the standard competitor pick is forwarded as the URL param; scope comes from the session, never from the query", async () => {
    st.session = session({ role: "hq", scope: { brands: ["Hyundai"], regions: [], countries: ["US", "KR"] } });
    await getList("competitor=toyota.com~honda.com&own_brand=Kia&scope=all");
    const q = apiLog[0].searchParams;
    expect([q.get("ctx.surface"), q.get("competitor"), q.get("ctx.scope")]).toEqual(["global", "toyota.com~honda.com", null]);
  });

  it("detail: base64url segment -> ctx.skey; project id and cf filters as the route context and params", async () => {
    const field = "0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";
    const r = await getDetail(encodeSkey("instagram.com/hyundai"), `projectId=${PROJECT}&cf_${field}=a~b`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { urls: { aiProvider: string; promptText: string }[]; promptList: unknown[] };
    expect(body.urls.map((u) => [u.aiProvider, u.promptText])).toEqual([["Gemini", "q"]]);
    const q = apiLog[0].searchParams;
    expect([apiLog[0].pathname, q.get("ctx.skey"), q.get("ctx.surface"), q.get("ctx.project_id"), q.get(`cf_${field}`)]).toEqual([
      "/v1/screens/citation/domain-detail",
      "instagram.com/hyundai",
      "project",
      PROJECT,
      "a~b",
    ]);
  });

  it("export: the Gold source has no export (404 from the screen) -> 404 as before; the params reach the screen", async () => {
    const r = await getExport("surface=website&q=kia&sort=coverage&locale=en&max_rows=100");
    expect([r.status, await code(r)]).toEqual([404, "not_found"]);
    const q = apiLog[0].searchParams;
    expect([apiLog[0].pathname, q.get("q"), q.get("sort"), q.get("locale"), q.get("max_rows")]).toEqual(["/v1/screens/citation/domains-export", "kia", "coverage", "en", "100"]);
  });

  it("screen errors keep their status: 409 cursor_stale (client restarts), 404 detail, 503", async () => {
    backend = () => json({ error: { code: "cursor_stale", message: "m", details: [] } }, 409);
    let r = await getList("cursor=old");
    expect([r.status, await code(r)]).toEqual([409, "cursor_stale"]);
    backend = () => json({ error: { code: "not_found", message: "m", details: [] } }, 404);
    r = await getDetail(encodeSkey("gone.example"), "");
    expect([r.status, await code(r)]).toEqual([404, "not_found"]);
    backend = () => json({ error: { code: "upstream", message: "m", details: [] } }, 503);
    r = await getExport("");
    expect(r.status).toBe(503);
  });
});
