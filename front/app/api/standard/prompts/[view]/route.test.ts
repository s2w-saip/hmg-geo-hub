import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HghApiError } from "@/lib/hgh/errors";

// GET /api/standard/prompts/{page|export|history}: the session and the /standard/prompts menu gate,
// then a thin proxy to the screen catalog/prompts-* with the browser's params (never `ctx.*`).

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

const session = (o: Record<string, unknown> = {}) => ({ user: { id: "u1", role: "hq", scope: { all: true }, menuGroups: null, ...o } });
const get = (view: string, qs = "") =>
  GET(new NextRequest(`http://localhost/api/standard/prompts/${view}${qs ? `?${qs}` : ""}`), { params: Promise.resolve({ view }) });

beforeEach(() => {
  st.session = session();
  st.calls.length = 0;
  st.fail = null;
});

describe("GET /api/standard/prompts/[view]", () => {
  it.each([
    ["page", "catalog/prompts-page"],
    ["export", "catalog/prompts-export"],
    ["history", "catalog/prompts-history"],
  ])("%s relays to the screen %s", async (view, screen) => {
    const res = await get(view, "f.kind=acr&sort=market&ml.KR=%ED%95%9C%EA%B5%AD&asc=false");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ screen });
    expect(st.calls).toEqual([[screen, { "f.kind": "acr", sort: "market", "ml.KR": "한국", asc: "false" }]]);
  });

  it("drops route context params from the browser", async () => {
    await get("page", "ctx.surface=website&ctx.project_id=x&search=ev");
    expect(st.calls[0][1]).toEqual({ search: "ev" });
  });

  it("unknown view is 404 without a read", async () => {
    expect((await get("admin")).status).toBe(404);
    expect(st.calls).toEqual([]);
  });

  it("no session is 401, a menu without standard is 403", async () => {
    st.session = null;
    expect((await get("page")).status).toBe(401);
    st.session = session({ menuGroups: ["website"] });
    expect((await get("page")).status).toBe(403);
    st.session = session({ role: "vendor" });
    expect((await get("page")).status).toBe(403);
    expect(st.calls).toEqual([]);
  });

  it("a screen error keeps its status and code", async () => {
    st.fail = new HghApiError(422, "invalid_value", "Invalid catalog page query");
    const res = await get("page", "sort=nope");
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_value");
  });
});
