import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// The local mode's middleware (2026-10-27): reads everywhere, writes only to /api/hub/* (HUB login and
// Global prompt editing). Since 2026-10-28 every page and read needs the HUB login: without its cookie a
// page goes to the login (with the way back) and the API refuses; the login itself stays open.

vi.mock("next-intl/middleware", () => ({ default: () => () => NextResponse.next() }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    throw new Error("Supabase is not used in the local mode");
  },
}));

const { middleware } = await import("./middleware");

const SIGNED_IN = "hgh_hub_session=tok";
const at = (method: string, path: string, opts: { host?: string; cookie?: string } = {}) =>
  middleware(new NextRequest(new URL(path, `http://${opts.host ?? "127.0.0.1:3333"}`), {
    method,
    headers: opts.cookie ? { cookie: opts.cookie } : undefined,
  }));

beforeEach(() => vi.stubEnv("HGH_LOCAL_READ_ONLY", "1"));
afterEach(() => vi.unstubAllEnvs());

describe("local mode middleware", () => {
  it("lets the HUB writes through and refuses every other write", async () => {
    for (const [method, path] of [["POST", "/api/hub/session"], ["DELETE", "/api/hub/session"], ["PUT", "/api/hub/global-prompts/x"]]) {
      expect((await at(method, path, { cookie: SIGNED_IN })).headers.get("x-middleware-next"), `${method} ${path}`).toBe("1");
    }
    for (const [method, path] of [["POST", "/ko/renewal/dashboard"], ["POST", "/api/standard/prompts/page"], ["PUT", "/api/hubx"], ["POST", "/ko/login"]]) {
      expect((await at(method, path, { cookie: SIGNED_IN })).status, `${method} ${path}`).toBe(405);
    }
  });

  it("without the HUB login: a page goes to the login and comes back, the API refuses", async () => {
    const res = await at("GET", "/ko/renewal/dashboard?tab=x");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/ko/login");
    expect(location.searchParams.get("next")).toBe("/ko/renewal/dashboard?tab=x");
    expect(new URL((await at("GET", "/en/dashboard")).headers.get("location") ?? "").pathname).toBe("/en/login");
    for (const path of ["/api/standard/prompts/page", "/api/hub/global-prompts", "/api/filters/options"]) {
      expect((await at("GET", path)).status, path).toBe(401);
    }
    // the QA console runs on the legacy database, which the local mode never opens: not public here
    expect((await at("GET", "/ko/raw-data-qa")).headers.get("location")).toContain("/ko/login");
  });

  it("serves the login page and the login itself without a session", async () => {
    const res = await at("GET", "/ko/login");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-pathname")).toBe("/ko/login");
    expect((await at("POST", "/api/hub/session")).headers.get("x-middleware-next")).toBe("1");
  });

  it("with the HUB login: pages and reads go through (the layouts check the token with the BFF)", async () => {
    const page = await at("GET", "/ko/renewal/dashboard", { cookie: SIGNED_IN });
    expect(page.headers.get("location")).toBeNull();
    expect(page.headers.get("x-pathname")).toBe("/ko/renewal/dashboard");
    expect((await at("GET", "/api/standard/prompts/page", { cookie: SIGNED_IN })).headers.get("x-middleware-next")).toBe("1");
    // an empty cookie is no login
    expect((await at("GET", "/api/filters/options", { cookie: "hgh_hub_session=" })).status).toBe(401);
  });

  it("still answers only on the local host", async () => {
    expect((await at("POST", "/api/hub/session", { host: "192.168.0.10:3333" })).status).toBe(403);
    expect((await at("GET", "/ko/login", { host: "192.168.0.10:3333" })).status).toBe(403);
  });
});
