import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HghApiError } from "@/lib/hgh/errors";

// GET /api/website/prompts/{page|rows} (renewal Website › Prompts): the session and the /website/prompts menu
// gate, then a thin proxy to the screen website/prompts-* with the browser's params (never `ctx.*`) and the
// account's role as ctx.admin.

const st = vi.hoisted(() => ({
  session: null as unknown,
  calls: [] as [string, Record<string, unknown>][],
  fail: null as Error | null,
}));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/screen", () => ({
  screenGet: async (name: string, query: Record<string, unknown>) => {
    st.calls.push([name, query]);
    if (st.fail) throw st.fail;
    return { screen: name };
  },
}));

const { GET } = await import("./route");

const session = (o: Record<string, unknown> = {}) => ({ user: { id: "u1", role: "admin", scope: { all: true }, menuGroups: null, ...o } });
const get = (view: string, qs = "") =>
  GET(new NextRequest(`http://localhost/api/website/prompts/${view}${qs ? `?${qs}` : ""}`), { params: Promise.resolve({ view }) });

beforeEach(() => {
  st.session = session();
  st.calls.length = 0;
  st.fail = null;
});

describe("GET /api/website/prompts/[view]", () => {
  it.each([
    ["page", "website/prompts-page"],
    ["rows", "website/prompts-rows"],
    ["insights", "website/prompts-insights"],
  ])("%s relays to the screen %s", async (view, screen) => {
    const res = await get(view, "geography=DE&geography=AT&engine=gemini&q=ev6&sort=answers&dir=asc&size=25&page=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ screen });
    expect(st.calls).toEqual([
      [screen, { geography: ["DE", "AT"], engine: "gemini", q: "ev6", sort: "answers", dir: "asc", size: "25", page: "2", "ctx.admin": true }],
    ]);
  });

  it("takes the route context from the session, not the browser", async () => {
    st.session = session({ role: "hq" });
    await get("page", "ctx.admin=true&ctx.surface=global&brand=Kia");
    expect(st.calls[0][1]).toEqual({ brand: "Kia", "ctx.admin": false });
  });

  it("unknown view is 404 without a read", async () => {
    expect((await get("export-all")).status).toBe(404);
    expect(st.calls).toEqual([]);
  });

  it("no session is 401, a menu without website is 403", async () => {
    st.session = null;
    expect((await get("page")).status).toBe(401);
    st.session = session({ role: "hq", menuGroups: ["standard"] });
    expect((await get("page")).status).toBe(403);
    expect(st.calls).toEqual([]);
  });

  it("a screen error keeps its status and code", async () => {
    st.fail = new HghApiError(503, "source_unavailable", "Gold data could not be read");
    const res = await get("page");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("source_unavailable");
  });
});
