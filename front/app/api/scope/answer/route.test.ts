import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/scope/answer (unit U6): the gate runs first on BOTH sources (session 401, place gate
// 403, project page gate 404), then HGH_SOURCE_<G2|G3|G6> picks the legacy readers (unchanged:
// website geo remap, project without the profile scope) or AN-2 through lib/hgh/adapters/answers.ts
// (404/403/422 -> {available:false}, 401 -> 401 {error:"unauthorized"}).

const st = vi.hoisted(() => ({
  session: null as unknown,
  calls: [] as { fn: string; args: unknown[] }[],
  project: { id: "p" } as unknown,
  membership: { status: "active" } as unknown,
  body: { available: true, answerText: "legacy" } as unknown,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/scope/server", () => {
  class UnauthorizedError extends Error {}
  const rec =
    (fn: string) =>
    async (...args: unknown[]) => {
      st.calls.push({ fn, args });
      return st.body;
    };
  return {
    UnauthorizedError,
    fetchStandardAnswerBody: rec("standard"),
    fetchProjectAnswerBody: rec("project"),
    fetchWebsiteAnswerBody: rec("website"),
  };
});
vi.mock("@/lib/db/repositories/request-cache", () => ({
  cachedProjectById: async () => st.project,
  cachedMembership: async () => st.membership,
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { GET } = await import("./route");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const JOB = "3f2b8c1e-0000-4000-8000-00000000abcd";
const hq = (o: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "x", role: "hq", scope: { all: false, brands: ["Kia"], regions: ["NA"], countries: ["US"] }, operator: "none", menuGroups: null, ...o },
});
const req = (qs: string) => new NextRequest(`https://front.test/api/scope/answer?${qs}`);

const apiLog: URL[] = [];
let apiReply: { status: number; body: unknown };
const DETAIL = {
  id: JOB,
  body: { available: true, answer_text: "api text" },
  header: { measured_at: null },
  citations: [],
  mentions: { brands: [], models: [] },
  sentiment: { spans: [], skipped: 0 },
  stances: [],
};

beforeEach(() => {
  st.session = hq();
  st.calls = [];
  st.project = { id: "p" };
  st.membership = { status: "active" };
  apiLog.length = 0;
  apiReply = { status: 200, body: { data: DETAIL, meta: { mode: "audit" } } };
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

const SOURCES = [
  ["legacy", {}],
  ["api", { HGH_SOURCE_G2: "api", HGH_SOURCE_G3: "api", HGH_SOURCE_G6: "api" }],
] as const;
const setSource = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
};

describe.each(SOURCES)("gate on the %s source", (_name, env) => {
  beforeEach(() => setSource(env));
  it("jobId required -> 400", async () => {
    expect((await GET(req(""))).status).toBe(400);
  });
  it("no session -> 401 {error:'unauthorized'} and no read", async () => {
    st.session = null;
    const res = await GET(req(`jobId=${JOB}`));
    expect([res.status, await res.json()]).toEqual([401, { error: "unauthorized" }]);
    expect([st.calls.length, apiLog.length]).toEqual([0, 0]);
  });
  it("place gate: a vendor on the standard modal -> 403 {available:false}, no read", async () => {
    st.session = hq({ role: "vendor" });
    const res = await GET(req(`jobId=${JOB}`));
    expect([res.status, await res.json()]).toEqual([403, { available: false }]);
    expect([st.calls.length, apiLog.length]).toEqual([0, 0]);
  });
  it("project page gate: not an active member -> 404 {available:false}, no read", async () => {
    st.membership = { status: "pending" };
    const res = await GET(req(`jobId=${JOB}&projectId=${PROJECT}`));
    expect([res.status, await res.json()]).toEqual([404, { available: false }]);
    expect([st.calls.length, apiLog.filter((u) => u.pathname.startsWith("/v1/answers")).length]).toEqual([0, 0]);
  });
});

describe("legacy source: the unchanged readers", () => {
  it("website: region moved to websiteCountry; standard: scope brand lock injected", async () => {
    await GET(req(`jobId=${JOB}&surface=website&geography=US`));
    await GET(req(`jobId=${JOB}`));
    expect(st.calls[0].fn).toBe("website");
    expect(st.calls[0].args[1]).toMatchObject({ websiteCountry: ["US"], region: undefined });
    expect(st.calls[1].fn).toBe("standard");
    expect((st.calls[1].args[1] as { brand?: string[] }).brand).toContain("Kia");
  });
  it("project: no profile scope (no brand lock) and the project id", async () => {
    await GET(req(`jobId=${JOB}&projectId=${PROJECT}`));
    expect(st.calls[0].fn).toBe("project");
    expect(st.calls[0].args[0]).toBe(PROJECT);
    expect((st.calls[0].args[2] as { brand?: string[] }).brand).toBeUndefined();
  });
});

describe("api source: AN-2 through the adapter", () => {
  beforeEach(() => setSource(SOURCES[1][1]));
  it("body converted; surface from the modal; the account brand lock is not sent", async () => {
    const res = await GET(req(`jobId=${JOB}&surface=website`));
    expect(await res.json()).toMatchObject({ available: true, answerText: "api text" });
    expect(apiLog[0].pathname).toBe(`/v1/answers/${JOB}`);
    expect(apiLog[0].search).toBe("?surface=website");
    expect(st.calls).toHaveLength(0);
  });
  it("404 -> {available:false}; 401 -> 401 {error:'unauthorized'}; 503 -> error response", async () => {
    apiReply = { status: 404, body: { error: { code: "not_found", message: "x" } } };
    expect(await (await GET(req(`jobId=${JOB}`))).json()).toEqual({ available: false });
    apiReply = { status: 401, body: { error: { code: "token_expired", message: "x" } } };
    const r401 = await GET(req(`jobId=${JOB}`));
    expect([r401.status, await r401.json()]).toEqual([401, { error: "unauthorized" }]);
    apiReply = { status: 503, body: { error: { code: "upstream", message: "x" } } };
    const r503 = await GET(req(`jobId=${JOB}`));
    expect([r503.status, ((await r503.json()) as { error: { code: string } }).error.code]).toEqual([503, "upstream"]);
  });
});
