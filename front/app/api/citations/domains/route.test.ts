import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// /api/citations/domains, /[skey], /export (unit U7): validation, then session, the place gate
// and the project gate on BOTH sources (U4 verification F1), then the source switch (api only:
// the legacy screens never call these routes). The api answer is the adapter's shape; backend
// errors keep their status with {error:{code}}.

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
const { encodeSkey } = await import("@/lib/hgh/adapters/citations");
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
const ROW = {
  skey: "a.example", domain: "a.example", is_social: false, category: null, citations: 3, share: { num: 3, den: 6 },
  citing_answers: 2, citing_prompts: 2, coverage: { num: 2, den: 10 }, is_own: false, is_target: false, own_citations: 0,
  competitor_brand: null, rank: 4, match_rank: 1,
};
let backend: (url: URL) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const defaultBackend = (url: URL): Response => {
  if (url.pathname === "/v1/citations/domains")
    return json({
      data: { summary: { total_citations: 6, unique_sources: 2, own_share: { num: 0, den: 6 }, answers_den: 10 }, items: [ROW], competitor_totals: [] },
      meta: { mode: "cumulative", page: { limit: 200, next_cursor: "n1", total: 201 } },
    });
  if (url.pathname.startsWith("/v1/citations/domains/") && url.pathname !== "/v1/citations/domains/export")
    return json({
      data: {
        source: { skey: "x", domain: "x", is_social: true, category: null },
        citations: 1,
        own_citations: 0,
        urls: [{ url: "https://www.instagram.com/hyundai/p/1", title: "P", citations: 1, engines: ["gemini"], prompt_text: "q", country: null }],
        prompts: [],
      },
      meta: { mode: "cumulative" },
    });
  if (url.pathname === "/v1/citations/domains/export")
    return new Response("bytes", {
      status: 200,
      headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="d.csv"', "x-export-truncated": "true", "set-cookie": "no=1" },
    });
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

describe("api answers", () => {
  it("list: adapter rows (skey, ranks), cursor and total; the page filters re-read like the page (website country axis)", async () => {
    st.session = session({ role: "admin", scope: { all: true } });
    const r = await getList("surface=website&geography=US~HYUNDAI-N&engine=gemini&q=kia&sort=share&dir=asc&cursor=abc&limit=50");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as { rows: { domain: string; skey: string; rank: number; matchRank: number; prompts: number }[]; nextCursor: string; total: number };
    expect(body.rows).toEqual([expect.objectContaining({ domain: "a.example", skey: "a.example", rank: 4, matchRank: 1, prompts: 2, share: 50, coverageRate: 20 })]);
    expect([body.nextCursor, body.total]).toEqual(["n1", 201]);
    const q = apiLog[0].searchParams;
    expect([q.get("surface"), q.getAll("country"), q.getAll("engine"), q.get("q"), q.get("sort"), q.get("dir"), q.get("cursor"), q.get("limit")]).toEqual([
      "website",
      ["HYUNDAI-N", "US"],
      ["gemini"],
      "kia",
      "share",
      "asc",
      "abc",
      "50",
    ]);
  });

  it("list: the standard competitor pick is forwarded; scope comes from the session, never from the query", async () => {
    st.session = session({ role: "hq", scope: { brands: ["Hyundai"], regions: [], countries: ["US", "KR"] } });
    await getList("competitor=toyota.com~honda.com&own_brand=Kia&scope=all");
    const q = apiLog[0].searchParams;
    expect([q.get("surface"), q.getAll("competitor"), q.get("own_brand"), q.get("scope"), q.get("limit")]).toEqual(["global", ["honda.com", "toyota.com"], null, null, "200"]);
  });

  it("detail: base64url segment -> the source key as the backend path parameter; project id and cf filters", async () => {
    const field = "0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";
    const r = await getDetail(encodeSkey("instagram.com/hyundai"), `projectId=${PROJECT}&cf_${field}=a~b`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { urls: { url: string; aiProvider: string; promptText: string }[]; promptList: unknown[] };
    expect(body.urls.map((u) => [u.aiProvider, u.promptText])).toEqual([["Gemini", "q"]]);
    expect(apiLog[0].pathname).toBe("/v1/citations/domains/instagram.com%2Fhyundai");
    expect([apiLog[0].searchParams.get("project_id"), apiLog[0].searchParams.getAll(`cf.${field}`)]).toEqual([PROJECT, ["a", "b"]]);
  });

  it("export: streamed with the relay header whitelist (no set-cookie), same search and sort", async () => {
    const r = await getExport("surface=website&q=kia&sort=coverage&locale=en&max_rows=100");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("bytes");
    expect([r.headers.get("content-disposition"), r.headers.get("x-export-truncated"), r.headers.get("set-cookie")]).toEqual([
      'attachment; filename="d.csv"',
      "true",
      null,
    ]);
    const q = apiLog[0].searchParams;
    expect([apiLog[0].pathname, q.get("q"), q.get("sort"), q.get("locale"), q.get("max_rows")]).toEqual(["/v1/citations/domains/export", "kia", "coverage", "en", "100"]);
  });

  it("backend errors keep their status: 409 cursor_stale (client restarts), 404 detail, 503", async () => {
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
