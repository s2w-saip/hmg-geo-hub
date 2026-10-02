import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/scope/brand-citations (unit U6): gate first on both sources, legacy readers unchanged
// (rows with inline drilldown; skey -> 400), api = C-1 list with mention_brand ({domains}, rows
// carry skey) and the per-source detail (&skey= -> {urls, promptList}).

const st = vi.hoisted(() => ({
  session: null as unknown,
  calls: [] as { fn: string; args: unknown[] }[],
  membership: { status: "active" } as unknown,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/scope/server", () => {
  class UnauthorizedError extends Error {}
  const rec =
    (fn: string) =>
    async (...args: unknown[]) => {
      st.calls.push({ fn, args });
      return [{ domain: "legacy.example" }];
    };
  return { UnauthorizedError, fetchBrandCitations: rec("standard"), fetchWebsiteBrandCitations: rec("website") };
});
vi.mock("@/lib/db/repositories/request-cache", () => ({
  cachedProjectById: async () => ({ id: "p" }),
  cachedMembership: async () => st.membership,
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { GET } = await import("./route");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const session = (o: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "x", role: "admin", scope: { all: true }, operator: "none", menuGroups: null, ...o },
});
const req = (qs: string) => new NextRequest(`https://front.test/api/scope/brand-citations?${qs}`);

const apiLog: URL[] = [];
const LIST = {
  data: {
    items: [
      { category: null, citations: 3, citing_answers: 2, citing_prompts: 2, competitor_brand: null, coverage: { num: 2, den: 10 }, domain: "a.example", is_own: false, is_social: false, is_target: false, match_rank: 1, own_citations: 0, rank: 1, share: { num: 3, den: 6 }, skey: "a.example" },
    ],
    competitor_totals: [],
    summary: { answers_den: 10, own_share: { num: 0, den: 6 }, total_citations: 6, unique_sources: 2 },
  },
  meta: { mode: "cumulative", page: { limit: 200, next_cursor: null } },
};
const DETAIL = {
  data: {
    citations: 3,
    own_citations: 0,
    prompts: [],
    urls: [{ url: "https://a.example/x", title: "X", citations: 3, engines: ["gemini"], prompt_text: "q", country: null }],
    source: { category: null, domain: "a.example", is_social: false, skey: "a.example" },
  },
  meta: { mode: "cumulative" },
};

beforeEach(() => {
  st.session = session();
  st.calls = [];
  st.membership = { status: "active" };
  apiLog.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(String(u));
      apiLog.push(url);
      const body = url.pathname === "/v1/citations/domains" ? LIST : DETAIL;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const API = { HGH_SOURCE_G2: "api", HGH_SOURCE_G3: "api", HGH_SOURCE_G6: "api" };
const setSource = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
};

describe.each([
  ["legacy", {}],
  ["api", API],
] as const)("gate on the %s source", (_n, env) => {
  beforeEach(() => setSource(env));
  it("vendor on the website drilldown -> 403 {domains:[]}; on the detail -> the detail shape", async () => {
    st.session = session({ role: "vendor", scope: { all: false, brands: [] } });
    const list = await GET(req("mentionBrand=Kia&surface=website"));
    expect([list.status, await list.json()]).toEqual([403, { domains: [] }]);
    const det = await GET(req("mentionBrand=Kia&surface=website&skey=a.example"));
    expect([det.status, await det.json()]).toEqual([403, { urls: [], promptList: [] }]);
    expect([st.calls.length, apiLog.length]).toEqual([0, 0]);
  });
  it("project page gate -> 404 before any read", async () => {
    st.session = session({ role: "hq", scope: { all: false, brands: ["Kia"] } });
    st.membership = { status: "removed" };
    expect((await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`))).status).toBe(404);
    expect([st.calls.length, apiLog.length]).toEqual([0, 0]);
  });
});

describe("legacy source", () => {
  it("rows with inline drilldown from the unchanged reader; a detail request -> 400", async () => {
    expect(await (await GET(req("mentionBrand=Kia"))).json()).toEqual({ domains: [{ domain: "legacy.example" }] });
    expect(st.calls[0].args[1]).toMatchObject({ cumulative: true });
    expect((await GET(req("mentionBrand=Kia&skey=a.example"))).status).toBe(400);
  });
});

describe("api source", () => {
  beforeEach(() => setSource(API));
  it("list: rows with skey, empty drilldown; project surface reads the project (U6-N11)", async () => {
    const body = (await (await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`))).json()) as { domains: { skey: string; urls: unknown[] }[] };
    expect(body.domains.map((d) => [d.skey, d.urls.length])).toEqual([["a.example", 0]]);
    expect([apiLog[0].searchParams.get("surface"), apiLog[0].searchParams.get("project_id"), apiLog[0].searchParams.get("mention_brand")]).toEqual([
      "project",
      PROJECT,
      "Kia",
    ]);
  });
  it("detail: {urls, promptList} for the source", async () => {
    const body = await (await GET(req("mentionBrand=Kia&surface=website&skey=a.example"))).json();
    expect(body).toEqual({
      urls: [{ url: "https://a.example/x", title: "X", count: 3, aiProvider: "Gemini", promptText: "q", country: null }],
      promptList: [],
    });
    expect(apiLog[0].pathname).toBe("/v1/citations/domains/a.example");
  });
  it("skey validation: empty -> 400", async () => {
    expect((await GET(req("mentionBrand=Kia&skey="))).status).toBe(400);
  });
});

// ── independent verification (fail) regressions ───────────────────────────

describe("U6 verification D1: legacy project requests read the standard root, so the standard place gate holds too", () => {
  it("project-only menu account + projectId on the legacy source -> 403 {domains:[]}, no reader call", async () => {
    st.session = session({ role: "hq", scope: { all: false, brands: ["Kia"] }, menuGroups: ["project"] });
    const res = await GET(req(`mentionBrand=Toyota&projectId=${PROJECT}`));
    expect([res.status, await res.json()]).toEqual([403, { domains: [] }]);
    expect(st.calls).toHaveLength(0);
    expect((await GET(req("mentionBrand=Toyota"))).status).toBe(403);
  });
  it("an active member who may read the standard analysis keeps the legacy behaviour (standard reader)", async () => {
    st.session = session({ role: "hq", scope: { all: false, brands: ["Kia"] }, menuGroups: null });
    const res = await GET(req(`mentionBrand=Toyota&projectId=${PROJECT}`));
    expect([res.status, st.calls[0]?.fn]).toEqual([200, "standard"]);
  });
  it("api source: the project surface is read from the project, the menu account passes (U6-N11)", async () => {
    setSource(API);
    st.session = session({ role: "hq", scope: { all: false, brands: ["Kia"] }, menuGroups: ["project"] });
    const res = await GET(req(`mentionBrand=Toyota&projectId=${PROJECT}`));
    expect(res.status).toBe(200);
    expect(apiLog[0].searchParams.get("surface")).toBe("project");
  });
});

describe.each([
  ["legacy", {}],
  ["api", API],
] as const)("U6 verification D3: project gate backend failures (HGH_SOURCE_SESSION=api, %s source)", (_n, env) => {
  const gateReplies: { status: number; body: unknown }[] = [];
  let refreshed = 0;
  beforeEach(() => {
    setSource(env);
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    gateReplies.length = 0;
    refreshed = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        const url = new URL(String(u));
        apiLog.push(url);
        const r =
          url.pathname === `/v1/projects/${PROJECT}`
            ? (gateReplies.shift() ?? { status: 200, body: { data: { project_id: PROJECT, name: "p", created_at: "2026-01-01T00:00:00Z", country_code: "US" }, meta: { mode: "crud" } } })
            : { status: 200, body: url.pathname === "/v1/citations/domains" ? LIST : DETAIL };
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
      }),
    );
  });
  const err = (status: number, code: string) => ({ status, body: { error: { code, message: "internal detail" } } });

  it("401 token_expired that survives the refresh -> 401 {error:'unauthorized'} (not thrown)", async () => {
    bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => (refreshed++, null) });
    gateReplies.push(err(401, "token_expired"));
    const res = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`));
    expect([res.status, await res.json()]).toEqual([401, { error: "unauthorized" }]);
    expect(refreshed).toBe(1);
    expect(st.calls).toHaveLength(0);
  });
  it("401 token_expired then a refreshed token -> the gate retries once and passes", async () => {
    bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => (refreshed++, TOKEN) });
    gateReplies.push(err(401, "token_expired"));
    const res = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`));
    expect([res.status, apiLog.filter((u) => u.pathname.startsWith("/v1/projects/")).length, refreshed]).toEqual([200, 2, 1]);
  });
  it("403 other than role/menu -> 404 (existence hidden), detail shape kept; 403 role_forbidden -> 403", async () => {
    gateReplies.push(err(403, "owner_only"));
    const hidden = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}&skey=a.example`));
    expect([hidden.status, await hidden.json()]).toEqual([404, { urls: [], promptList: [] }]);
    gateReplies.push(err(403, "role_forbidden"));
    const role = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`));
    expect([role.status, await role.json()]).toEqual([403, { domains: [] }]);
    expect(st.calls).toHaveLength(0);
  });
  it("503 -> 503 {error:{code}} without the backend message", async () => {
    gateReplies.push(err(503, "unavailable"), err(503, "unavailable"));
    const res = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`));
    const body = await res.json();
    expect([res.status, body.error.code]).toEqual([503, "unavailable"]);
    expect(JSON.stringify(body)).not.toContain("internal detail");
    expect(st.calls).toHaveLength(0);
  });
});
