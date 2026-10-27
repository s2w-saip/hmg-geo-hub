import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HghApiError } from "@/lib/hgh/errors";

// GET /api/scope/brand-mention-prompts: a proxy of the screen mention/drill-brand-prompts
// (back/bff/screens/mention_drilldown.py, which decides every status and body; its goldens and
// tests pin them). The route keeps the session check and relays the screen's {status, body};
// a failure the screen raises is answered with hghErrorResponse.

const st = vi.hoisted(() => ({
  session: { user: { id: "geo_readonly", role: "local_reader", scope: { all: true } } } as unknown,
  calls: [] as { name: string; query: Record<string, unknown> }[],
  reply: (): Promise<unknown> => Promise.resolve({ status: 200, body: {} }),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/screen", () => ({
  screenGet: (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    return st.reply();
  },
}));

const { GET } = await import("./route");
const QS = "mentionBrand=Toyota&own=1&ownCode=&geography=US&geography=KR";
const req = (qs: string) => new NextRequest(`https://front.test/api/scope/brand-mention-prompts?${qs}`);

beforeEach(() => {
  st.session = { user: { id: "geo_readonly", role: "local_reader", scope: { all: true } } };
  st.calls = [];
  st.reply = () => Promise.resolve({ status: 200, body: {"prompts":[{"id":"p1"}],"orders":{}} });
});

describe("GET /api/scope/brand-mention-prompts -> screen mention/drill-brand-prompts", () => {
  it("no session -> 401 {error:'unauthorized'}, nothing read", async () => {
    st.session = null;
    const res = await GET(req(QS));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(st.calls).toEqual([]);
  });

  it("sends the search params exactly as received (repeated keys, empty values) as ctx.params", async () => {
    await GET(req(QS));
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0].name).toBe("mention/drill-brand-prompts");
    expect(Object.keys(st.calls[0].query)).toEqual(["ctx.params"]);
    expect(JSON.parse(st.calls[0].query["ctx.params"] as string)).toEqual([...new URLSearchParams(QS)]);
  });

  it("relays the screen's status and body", async () => {
    const ok = await GET(req(QS));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({"prompts":[{"id":"p1"}],"orders":{}});
    for (const status of [400, 403, 404]) {
      st.reply = () => Promise.resolve({ status, body: {"prompts":[]} });
      const res = await GET(req(QS));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({"prompts":[]});
    }
    st.reply = () => Promise.resolve({ status: 401, body: { error: "unauthorized" } });
    const unauthorized = await GET(req(QS));
    expect([unauthorized.status, await unauthorized.json()]).toEqual([401, { error: "unauthorized" }]);
  });

  it("a screen failure -> hghErrorResponse ({error:{code}} with its status; anything else 500 internal)", async () => {
    st.reply = () => Promise.reject(new HghApiError(503, "source_unavailable", "Gold data could not be read"));
    const res = await GET(req(QS));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "source_unavailable" } });
    st.reply = () => Promise.reject(new HghApiError(504, "timeout"));
    expect((await GET(req(QS))).status).toBe(504);
    st.reply = () => Promise.reject(new Error("boom"));
    const internal = await GET(req(QS));
    expect([internal.status, await internal.json()]).toEqual([500, { error: { code: "internal" } }]);
  });
});
