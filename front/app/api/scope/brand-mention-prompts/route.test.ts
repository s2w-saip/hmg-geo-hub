import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/scope/brand-mention-prompts (unit U6): gate first on both sources (401, place 403,
// project 404), legacy readers unchanged (website remap + cumulative, no project branch), api =
// M-3 mode=brand through lib/hgh/adapters/drilldown.ts (by name, own row by own=1 + ownCode,
// project surface with project_id + cf), error map (422 -> 400 {prompts:[]}, 404 -> []).

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
      return [{ id: "legacy" }];
    };
  return {
    UnauthorizedError,
    fetchStandardBrandMentionPrompts: rec("standard"),
    fetchWebsiteBrandMentionPrompts: rec("website"),
  };
});
vi.mock("@/lib/db/repositories/request-cache", () => ({
  cachedProjectById: async () => ({ id: "p" }),
  cachedMembership: async () => st.membership,
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { GET } = await import("./route");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const FIELD = "0b3f1c2d-0000-4000-8000-000000000001";
const session = (o: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "x", role: "hq", scope: { all: false, brands: ["Kia"], regions: ["NA"], countries: ["US"] }, operator: "none", menuGroups: null, ...o },
});
const req = (qs: string) => new NextRequest(`https://front.test/api/scope/brand-mention-prompts?${qs}`);

const apiLog: URL[] = [];
let apiReply: { status: number; body: unknown };
const PAGE = {
  data: {
    mode: "brand",
    target: {},
    total: 4,
    items: [{ prompt_id: "p1", prompt_text: "t", count: 4, share: { num: 4, den: 4 }, funnel_code: null, providers: ["chatgpt"], answers: [] }],
  },
  meta: { mode: "cumulative", page: { limit: 200, next_cursor: null } },
};

beforeEach(() => {
  st.session = session();
  st.calls = [];
  st.membership = { status: "active" };
  apiLog.length = 0;
  apiReply = { status: 200, body: PAGE };
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      apiLog.push(new URL(String(u)));
      return new Response(JSON.stringify(apiReply.body), { status: apiReply.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const API = { HGH_SOURCE_G2: "api", HGH_SOURCE_G3: "api", HGH_SOURCE_G6: "api" };
const SOURCES = [
  ["legacy", {}],
  ["api", API],
] as const;
const setSource = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
};

describe.each(SOURCES)("gate on the %s source", (_n, env) => {
  beforeEach(() => setSource(env));
  it("mentionBrand required -> 400", async () => {
    expect((await GET(req(""))).status).toBe(400);
  });
  it("no session -> 401", async () => {
    st.session = null;
    const res = await GET(req("mentionBrand=Kia"));
    expect([res.status, await res.json()]).toEqual([401, { error: "unauthorized" }]);
  });
  it("menu groups without answer analysis -> 403 {prompts:[]} before any read", async () => {
    st.session = session({ menuGroups: ["project"] });
    const res = await GET(req("mentionBrand=Kia&surface=website"));
    expect([res.status, await res.json()]).toEqual([403, { prompts: [] }]);
    expect([st.calls.length, apiLog.length]).toEqual([0, 0]);
  });
  it("project page gate -> 404 {prompts:[]} before any read", async () => {
    st.membership = null;
    const res = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`));
    expect([res.status, await res.json()]).toEqual([404, { prompts: [] }]);
    expect([st.calls.length, apiLog.length]).toEqual([0, 0]);
  });
});

describe("legacy source", () => {
  it("website: the site-country remap, the axis allowlist and cumulative, as before", async () => {
    const res = await GET(req("mentionBrand=Toyota&surface=website&geography=US&depth1=x"));
    expect(await res.json()).toEqual({ prompts: [{ id: "legacy" }] });
    expect(st.calls[0].fn).toBe("website");
    expect(st.calls[0].args[0]).toBe("Toyota");
    expect(st.calls[0].args[1]).toMatchObject({ websiteCountry: ["US"], region: undefined, cumulative: true });
    expect((st.calls[0].args[1] as { depth1?: string[] }).depth1).toBeUndefined();
  });
  it("own flags are ignored (drilldown by name)", async () => {
    await GET(req("mentionBrand=Kia&own=1&ownCode=Kia"));
    expect([st.calls[0].fn, st.calls[0].args[0]]).toEqual(["standard", "Kia"]);
  });
});

describe("api source", () => {
  beforeEach(() => setSource(API));
  it("competitor row by name; the scope injection is not sent", async () => {
    const res = await GET(req("mentionBrand=Toyota&geography=US"));
    expect(((await res.json()) as { prompts: { id: string }[] }).prompts.map((p) => p.id)).toEqual(["p1"]);
    const q = apiLog[0].searchParams;
    expect([q.get("mode"), q.get("mention_brand"), q.get("own"), q.get("surface"), q.getAll("country"), q.getAll("brand")]).toEqual([
      "brand",
      "Toyota",
      null,
      "global",
      [],
      [],
    ]);
    expect(st.calls).toHaveLength(0);
  });
  it("own split row -> own=true & own_brand_code; project surface carries project_id and cf", async () => {
    await GET(req(`mentionBrand=Kia&own=1&ownCode=Kia&projectId=${PROJECT}&cf_${FIELD}=a`));
    const q = apiLog[0].searchParams;
    expect([q.get("own"), q.get("own_brand_code"), q.get("mention_brand"), q.get("surface"), q.get("project_id"), q.getAll(`cf.${FIELD}`)]).toEqual([
      "true",
      "Kia",
      null,
      "project",
      PROJECT,
      ["a"],
    ]);
  });
  it("422 -> 400 {prompts:[]}; 404 brand_not_found -> 200 {prompts:[]}; 401 -> 401", async () => {
    apiReply = { status: 422, body: { error: { code: "invalid_value", message: "x" } } };
    const r422 = await GET(req("mentionBrand=Kia"));
    expect([r422.status, await r422.json()]).toEqual([400, { prompts: [] }]);
    apiReply = { status: 404, body: { error: { code: "brand_not_found", message: "x" } } };
    const r404 = await GET(req("mentionBrand=Nope"));
    expect([r404.status, await r404.json()]).toEqual([200, { prompts: [] }]);
    apiReply = { status: 401, body: { error: { code: "no_account", message: "x" } } };
    expect((await GET(req("mentionBrand=Kia"))).status).toBe(401);
  });
});

// ── independent verification (fail) regressions ───────────────────────────

describe("U6 verification D1: the legacy project surface does not serve the standard root", () => {
  it("project-only menu account + projectId on the legacy source -> 404 {prompts:[]}, no reader call", async () => {
    st.session = session({ menuGroups: ["project"] });
    const res = await GET(req(`mentionBrand=Toyota&projectId=${PROJECT}`));
    expect([res.status, await res.json()]).toEqual([404, { prompts: [] }]);
    expect(st.calls).toHaveLength(0);
    // the same account without projectId was already refused by the place gate
    expect((await GET(req("mentionBrand=Toyota"))).status).toBe(403);
  });
  it("any account: legacy has no project reader (admin with projectId -> 404, no reader call)", async () => {
    st.session = session({ role: "admin", menuGroups: null, scope: { all: true } });
    const res = await GET(req(`mentionBrand=Toyota&projectId=${PROJECT}`));
    expect(res.status).toBe(404);
    expect(st.calls).toHaveLength(0);
  });
});

describe.each(SOURCES)("U6 verification D3: project gate backend failures (HGH_SOURCE_SESSION=api, %s source)", (_n, env) => {
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
            : apiReply;
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
      }),
    );
  });
  const err = (status: number, code: string) => ({ status, body: { error: { code, message: "internal detail" } } });
  const gateCalls = () => apiLog.filter((u) => u.pathname.startsWith("/v1/projects/")).length;

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
    expect(gateCalls()).toBe(2);
    expect(refreshed).toBe(1);
    // passed the gate: the api source reads, the legacy source has no project reader (D1)
    expect(res.status).toBe(_n === "api" ? 200 : 404);
  });
  it("403 other than role/menu -> 404 {prompts:[]} (project existence hidden); 403 menu_forbidden -> 403", async () => {
    gateReplies.push(err(403, "owner_only"));
    const hidden = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`));
    expect([hidden.status, await hidden.json()]).toEqual([404, { prompts: [] }]);
    gateReplies.push(err(403, "menu_forbidden"));
    const menu = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`));
    expect([menu.status, await menu.json()]).toEqual([403, { prompts: [] }]);
    expect(st.calls).toHaveLength(0);
  });
  it("500 -> 500 {error:{code}} without the backend message", async () => {
    gateReplies.push(err(500, "internal"));
    const res = await GET(req(`mentionBrand=Kia&projectId=${PROJECT}`));
    const body = await res.json();
    expect([res.status, body.error.code]).toEqual([500, "internal"]);
    expect(JSON.stringify(body)).not.toContain("internal detail");
    expect(st.calls).toHaveLength(0);
  });
});
