import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HghApiError } from "@/lib/hgh/errors";
import { browserScreenQuery } from "@/lib/hub/screen-read";
import type { HubUser } from "@/lib/hub/client";

const api = vi.hoisted(() => ({ me: vi.fn(), screen: vi.fn() }));
vi.mock("@/lib/hub/client", () => ({ hubMe: api.me, hubLogin: vi.fn() }));
vi.mock("@/lib/screen", () => ({ screenGet: api.screen }));
const session = await import("../hub/session/route");
const screens = await import("./[...path]/route");
const user: HubUser = { id: "11111111-1111-4111-8111-111111111111", login: "fixture", email: null, displayName: null, role: "admin", scope: { all: true }, mustChangePassword: false };
const req = (path: string, cookie = true) => new NextRequest(`http://127.0.0.1:3334${path}`, { headers: cookie ? { cookie: "hgh_hub_session=v1.fixture.signature" } : {} });
const screen = (name: string, query = "", cookie = true) => screens.GET(req(`/api/screens/${name}${query}`, cookie), { params: Promise.resolve({ path: name.split("/") }) });
beforeEach(() => { vi.stubEnv("HGH_LOCAL_READ_ONLY", "1"); api.me.mockReset().mockResolvedValue(user); api.screen.mockReset().mockResolvedValue({ value: null, realZero: 0 }); });
afterEach(() => vi.unstubAllEnvs());

describe("local React session bridge", () => {
  it("returns no session without a cookie and never asks the data server", async () => {
    const res = await session.GET(req("/api/hub/session", false));
    expect(await res.json()).toEqual({ user: null }); expect(api.me).not.toHaveBeenCalled();
  });
  it("returns only the real account view and keeps the token server-side", async () => {
    const res = await session.GET(req("/api/hub/session"));
    expect(await res.json()).toEqual({ user }); expect(api.me).toHaveBeenCalledWith("v1.fixture.signature");
    expect(res.headers.get("cache-control")).toBe("no-store"); expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("returns null for a revoked session and preserves server failure", async () => {
    api.me.mockResolvedValue(null); expect(await (await session.GET(req("/api/hub/session"))).json()).toEqual({ user: null });
    api.me.mockRejectedValue(new HghApiError(503, "source_unavailable"));
    expect((await session.GET(req("/api/hub/session"))).status).toBe(503);
  });
  it("does not enable the migration endpoints outside the existing local mode", async () => {
    vi.stubEnv("HGH_LOCAL_READ_ONLY", "");
    expect((await session.GET(req("/api/hub/session"))).status).toBe(404);
    expect((await screen("overview/cards")).status).toBe(404); expect(api.me).not.toHaveBeenCalled();
  });
});

describe("local React screen bridge", () => {
  it("refuses absent, revoked and password-change sessions before reading a screen", async () => {
    expect((await screen("overview/cards", "", false)).status).toBe(401);
    api.me.mockResolvedValue(null); expect((await screen("overview/cards")).status).toBe(401);
    api.me.mockResolvedValue({ ...user, mustChangePassword: true }); expect((await screen("overview/cards")).status).toBe(403);
    expect(api.screen).not.toHaveBeenCalled();
  });
  it("preserves repeated filters, zero and null without calculating screen values", async () => {
    const res = await screen("overview/cards", "?geography=KR&geography=US&page=0&ctx.role=admin&ctx.admin=true&ctx.today=2099-01-01");
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ value: null, realZero: 0 });
    expect(api.screen).toHaveBeenCalledWith("overview/cards", { geography: ["KR", "US"], page: "0", "ctx.surface": "global", "ctx.role": "admin", "ctx.admin": "true" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("derives privilege context from the account, never from the browser", async () => {
    api.me.mockResolvedValue({ ...user, role: "country", scope: { all: false, countries: ["KR"], brands: ["Kia"] } });
    expect((await screen("website/summary", "?ctx.surface=global&ctx.role=admin&ctx.admin=true")).status).toBe(200);
    expect(api.screen).toHaveBeenCalledWith("website/summary", { "ctx.surface": "website", "ctx.role": "country", "ctx.admin": "false" });
  });
  it("denies project reads for a country account, even with a forged admin query", async () => {
    api.me.mockResolvedValue({ ...user, role: "country", scope: { all: false, countries: ["KR"] } });
    expect((await screen("projects/list", "?ctx.admin=true")).status).toBe(403);
    expect((await screen("projects/settings", `?ctx.project_id=${user.id}&ctx.role=admin`)).status).toBe(403);
    expect(api.screen).not.toHaveBeenCalled();
  });
  it("allows known project reads with a valid id and refuses malformed context", async () => {
    expect((await screen("projects/settings")).status).toBe(422);
    expect((await screen("projects/settings", `?ctx.project_id=${user.id}`)).status).toBe(200);
    expect(api.screen).toHaveBeenCalledWith("projects/settings", expect.objectContaining({ "ctx.project_id": user.id, "ctx.surface": "project" }));
    expect((await screen("overview/geo", "?ctx.locale=xx")).status).toBe(422);
    expect((await screen("overview/cards", "?ctx.surface=unknown")).status).toBe(422);
  });
  it("does not expose arbitrary screen builders or database paths", async () => {
    for (const name of ["sources/analytics", "unknown", "../hub/accounts"]) expect((await screen(name)).status).toBe(404);
    expect(api.screen).not.toHaveBeenCalled();
  });
  it("keeps a failed aggregation a failure with no substitute payload", async () => {
    api.screen.mockRejectedValue(new HghApiError(503, "source_unavailable", "not ready"));
    const res = await screen("overview/cards"); expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "source_unavailable" } });
  });
  it("forces the renewal variant while preserving the caller's ordinary filters", () => {
    const query = browserScreenQuery("citation/website", new URLSearchParams("ctx.variant=legacy&ctx.role=admin&brand=Kia"), user);
    expect(query).toMatchObject({ "ctx.variant": "renewal", "ctx.surface": "website", brand: "Kia" });
  });
});
