import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/scope/unmeasured-prompts (unit U6): the global answer-analysis place gate first on both
// sources (403 {result:null}), legacy reader unchanged (cumulative), api = BG-04
// GET /v1/kpi/unmeasured-prompts ({result:{total, rows}}), 422 -> 400 {result:null}.

const st = vi.hoisted(() => ({ session: null as unknown, calls: [] as unknown[][] }));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/scope/server", () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    fetchStandardUnmeasuredPrompts: async (...args: unknown[]) => {
      st.calls.push(args);
      return { total: 1, rows: [{ id: "legacy" }] };
    },
  };
});

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { GET } = await import("./route");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const session = (o: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "x", role: "hq", scope: { all: false, brands: ["Kia"] }, operator: "none", menuGroups: null, ...o },
});
const req = (qs: string) => new NextRequest(`https://front.test/api/scope/unmeasured-prompts?${qs}`);
const apiLog: URL[] = [];
let apiStatus = 200;

beforeEach(() => {
  st.session = session();
  st.calls = [];
  apiLog.length = 0;
  apiStatus = 200;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      apiLog.push(new URL(String(u)));
      const body =
        apiStatus === 200
          ? {
              data: { items: [{ prompt_id: "c1", scope_prompt_id: "s1", text: "t", list_type: "L", depth1: null, depth2: null, funnel_stage: null }] },
              meta: { mode: "snapshot", page: { limit: 200, next_cursor: null, total: 7 } },
            }
          : { error: { code: "invalid_value", message: "x" } };
      return new Response(JSON.stringify(body), { status: apiStatus, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each([
  ["legacy", {}],
  ["api", { HGH_SOURCE_G2: "api" }],
] as const)("gate on the %s source", (_n, env) => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  });
  it("no session -> 401; vendor -> 403 {result:null}, no read", async () => {
    st.session = null;
    expect((await GET(req(""))).status).toBe(401);
    st.session = session({ role: "vendor" });
    const res = await GET(req(""));
    expect([res.status, await res.json()]).toEqual([403, { result: null }]);
    expect([st.calls.length, apiLog.length]).toEqual([0, 0]);
  });
});

describe("sources", () => {
  it("legacy: the unchanged reader with cumulative", async () => {
    expect(await (await GET(req("geography=US"))).json()).toEqual({ result: { total: 1, rows: [{ id: "legacy" }] } });
    expect(st.calls[0][0]).toMatchObject({ cumulative: true });
  });
  it("api: BG-04 with the same filters, total before the cap; 422 -> 400 {result:null}", async () => {
    vi.stubEnv("HGH_SOURCE_G2", "api");
    const body = await (await GET(req("geography=US&engine=chatgpt"))).json();
    expect(body).toEqual({ result: { total: 7, rows: [{ id: "c1", text: "t", listType: "L", depth1: null, depth2: null, funnelStage: null }] } });
    expect([apiLog[0].pathname, apiLog[0].searchParams.get("limit"), apiLog[0].searchParams.getAll("engine")]).toEqual([
      "/v1/kpi/unmeasured-prompts",
      "200",
      ["chatgpt"],
    ]);
    apiStatus = 422;
    const r = await GET(req(""));
    expect([r.status, await r.json()]).toEqual([400, { result: null }]);
  });
});
