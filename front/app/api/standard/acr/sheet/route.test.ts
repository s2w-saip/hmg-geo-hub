import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HghApiError } from "@/lib/hgh/errors";

// GET /api/standard/acr/sheet: the session and the renewal ACR menu gate, then a thin proxy to the screen
// acr/renewal-sheet with the browser's params (never `ctx.*`).

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
    return { sheet: null };
  },
}));

const { GET } = await import("./route");

const session = (o: Record<string, unknown> = {}) => ({ user: { id: "u1", role: "hq", scope: { all: true }, menuGroups: null, ...o } });
const get = (qs = "") => GET(new NextRequest(`http://localhost/api/standard/acr/sheet${qs ? `?${qs}` : ""}`));

beforeEach(() => {
  st.session = session();
  st.calls.length = 0;
  st.fail = null;
});

describe("GET /api/standard/acr/sheet", () => {
  it("relays the page params and the sheet to the screen acr/renewal-sheet", async () => {
    const res = await get("engine=gemini~chatgpt&time=2026-09-07..2026-10-05&sheet=US%7Cgemini&engine=x");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ sheet: null });
    expect(st.calls).toEqual([["acr/renewal-sheet", { engine: ["gemini~chatgpt", "x"], time: "2026-09-07..2026-10-05", sheet: "US|gemini" }]]);
  });

  it("drops route context params from the browser", async () => {
    await get("ctx.surface=website&ctx.project_id=x&sheet=%7Cchatgpt");
    expect(st.calls[0][1]).toEqual({ sheet: "|chatgpt" });
  });

  it("no session is 401, a menu without standard is 403", async () => {
    st.session = null;
    expect((await get("sheet=US%7Cgemini")).status).toBe(401);
    st.session = session({ menuGroups: ["website"] });
    expect((await get("sheet=US%7Cgemini")).status).toBe(403);
    st.session = session({ role: "vendor" });
    expect((await get("sheet=US%7Cgemini")).status).toBe(403);
    expect(st.calls).toEqual([]);
  });

  it("a screen error keeps its status and code", async () => {
    st.fail = new HghApiError(422, "invalid_value", "sheet must be <country>|<engine>");
    const res = await get("sheet=US");
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_value");
  });
});
