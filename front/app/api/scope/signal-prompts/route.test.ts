import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/scope/signal-prompts (unit U6): signal validated first, then the gate on both sources,
// legacy readers unchanged (project without profile scope + custom tags), api = M-3 mode=signal.

const st = vi.hoisted(() => ({
  session: null as unknown,
  calls: [] as { fn: string; args: unknown[] }[],
  membership: { status: "active" } as unknown,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/db/repositories/scope-aggregates", () => ({
  isSignalKey: (v: string) =>
    ["positive", "neutral", "mixed", "negative", "mention", "recommendation", "comparison", "definition", "final_choice"].includes(v),
}));
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
    fetchStandardSignalPrompts: rec("standard"),
    fetchWebsiteSignalPrompts: rec("website"),
    fetchProjectSignalPrompts: rec("project"),
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
  user: { id: "u1", email: "x", role: "hq", scope: { all: false, brands: ["Kia"] }, operator: "none", menuGroups: null, ...o },
});
const req = (qs: string) => new NextRequest(`https://front.test/api/scope/signal-prompts?${qs}`);
const apiLog: URL[] = [];

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
      apiLog.push(new URL(String(u)));
      const body = { data: { mode: "signal", target: {}, total: 0, items: [] }, meta: { mode: "cumulative", page: { limit: 50, next_cursor: "x" } } };
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
  it("invalid signal -> 400 before the session", async () => {
    st.session = null;
    expect((await GET(req("signal=bogus"))).status).toBe(400);
  });
  it("vendor on the standard dialog -> 403 {prompts:[]}; project non-member -> 404", async () => {
    st.session = session({ role: "vendor" });
    expect((await GET(req("signal=positive"))).status).toBe(403);
    st.session = session();
    st.membership = null;
    expect((await GET(req(`signal=positive&projectId=${PROJECT}`))).status).toBe(404);
    expect([st.calls.length, apiLog.length]).toEqual([0, 0]);
  });
});

describe("legacy source", () => {
  it("project: no profile scope, custom tags, cumulative", async () => {
    await GET(req(`signal=negative&projectId=${PROJECT}&cf_${FIELD}=x`));
    expect(st.calls[0].fn).toBe("project");
    expect(st.calls[0].args[2]).toMatchObject({ customFieldFilters: { [FIELD]: ["x"] }, cumulative: true });
    expect((st.calls[0].args[2] as { brand?: string[] }).brand).toBeUndefined();
  });
});

describe("api source", () => {
  beforeEach(() => setSource(API));
  it("one page (no cursor loop), 50 prompts x 6 references, signal key, website surface", async () => {
    const res = await GET(req("signal=mention&surface=website&geography=KR"));
    expect(await res.json()).toEqual({ prompts: [] });
    expect(apiLog).toHaveLength(1);
    const q = apiLog[0].searchParams;
    expect([q.get("mode"), q.get("signal"), q.get("limit"), q.get("answers_limit"), q.get("surface"), q.getAll("country")]).toEqual([
      "signal",
      "mention",
      "50",
      "6",
      "website",
      ["KR"],
    ]);
    expect(st.calls).toHaveLength(0);
  });
});
