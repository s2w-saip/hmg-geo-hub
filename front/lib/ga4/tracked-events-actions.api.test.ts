import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

// Conversion-event server actions (unit U8): the place gate on BOTH sources before the branch
// (verify D1: project -> admin or /projects; admin registry -> admin + /admin/ga4 menu; else
// /website/ai-funnel), the source switch per place (project G6, website G3, admin registry G7:
// verify D2, U8-N9), the backend paths (BG-29 GET/PUT /v1/funnel/conversion/events, admin GET/PUT
// /v1/admin/ga4/properties/{id}/events) and the error map to the legacy action outcomes. The
// legacy path (repositories + live GA4) must stay the default and must not touch the backend.

const st = vi.hoisted(() => ({
  session: null as Session | null,
  legacyLoad: vi.fn(),
  legacySave: vi.fn(),
  resolveProperty: vi.fn(),
  resolveProperties: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("./tracked-events-service", () => ({ loadEventsForProperty: st.legacyLoad, saveEventsForProperty: st.legacySave }));
vi.mock("./property-map", () => ({ resolveProperty: st.resolveProperty, resolveProperties: st.resolveProperties }));
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: { getById: async () => null } }));
vi.mock("@/lib/db/repositories/project-members", () => ({ projectMemberRepository: { findMembership: async () => null } }));
vi.mock("@/lib/scope/server", () => ({}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const A = await import("./tracked-events-actions");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const session = (role: Session["user"]["role"] = "country", menuGroups: Session["user"]["menuGroups"] = null): Session => ({
  user: { id: "u1", email: "u@hmg.test", role, scope: { all: false, brands: ["Kia"], countries: ["IT"] }, operator: "none", menuGroups },
});

const calls: { url: URL; method: string; body: unknown }[] = [];
const answer = { status: 200, json: null as unknown };
const EVENTS = {
  data: {
    property_id: "123",
    window_from: "2026-06-18",
    window_to: "2026-09-15",
    loaded: true,
    registered: true,
    can_edit: true,
    items: [
      { event_name: "purchase", count: 5, tracked: true },
      { event_name: "view", count: 90, tracked: false },
    ],
  },
  meta: { mode: "admin" },
};

beforeEach(() => {
  calls.length = 0;
  answer.status = 200;
  answer.json = EVENTS;
  st.session = session();
  st.legacyLoad.mockReset().mockResolvedValue([{ eventName: "legacy", count: 1, tracked: false }]);
  st.legacySave.mockReset().mockResolvedValue(undefined);
  st.resolveProperty.mockReset().mockResolvedValue("123");
  st.resolveProperties.mockReset().mockResolvedValue([{ brand: "Kia", country: "IT", propertyId: "123" }]);
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, init?: RequestInit) => {
      calls.push({ url: new URL(String(u)), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const fail = (status: number, code: string) => {
  answer.status = status;
  answer.json = { error: { code, message: "x" } };
};

describe("source switch", () => {
  it("default (no flag): legacy repositories + GA4, no backend call", async () => {
    expect(await A.loadConversionEvents("123")).toEqual({ ok: true, value: [{ eventName: "legacy", count: 1, tracked: false }] });
    expect(await A.saveConversionEvents("123", ["purchase"])).toEqual({ ok: true, value: { notice: null } });
    expect(st.legacyLoad).toHaveBeenCalledWith("123");
    expect(st.legacySave).toHaveBeenCalledWith("123", ["purchase"], "u1");
    expect(calls).toHaveLength(0);
  });

  it("HGH_SOURCE_G3=api: website context goes to the backend, legacy untouched", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    expect(await A.loadConversionEvents(" 123 ")).toEqual({
      ok: true,
      value: [
        { eventName: "purchase", count: 5, tracked: true },
        { eventName: "view", count: 90, tracked: false },
      ],
    });
    expect([calls[0].method, calls[0].url.pathname, calls[0].url.searchParams.get("property_id"), calls[0].url.searchParams.has("project_id")]).toEqual([
      "GET",
      "/v1/funnel/conversion/events",
      "123",
      false,
    ]);
    expect(st.legacyLoad).not.toHaveBeenCalled();
    expect(st.resolveProperties).not.toHaveBeenCalled();
  });

  it("a project context follows G6, not G3", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    // G6 still legacy: the legacy project gate runs (no such project -> denied), no backend call
    await expect(A.loadConversionEvents("123", PROJECT)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(0);
  });

  it("HGH_SOURCE_G6=api: project context sends project_id; save sends the names", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    await A.loadConversionEvents("123", PROJECT);
    expect(calls[0].url.searchParams.get("project_id")).toBe(PROJECT);
    answer.json = { data: { property_id: "123", event_names: ["purchase"], propagation: "pending", change_id: 3 }, meta: { mode: "crud" } };
    expect(await A.saveConversionEvents("123", ["purchase", "lead"], PROJECT)).toEqual({ ok: true, value: { notice: "savedPending" } });
    expect([calls[1].method, calls[1].url.searchParams.get("project_id"), calls[1].body]).toEqual(["PUT", PROJECT, { event_names: ["purchase", "lead"] }]);
    expect(st.legacySave).not.toHaveBeenCalled();
  });

  it("U8-N8 (verify D4): a queued api save returns the pending notice; an unchanged set (propagation none) the plain one", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    answer.json = { data: { property_id: "123", event_names: ["purchase"], propagation: "pending", change_id: 5 }, meta: { mode: "crud" } };
    expect(await A.saveConversionEvents("123", ["purchase"])).toEqual({ ok: true, value: { notice: "savedPending" } });
    answer.json = { data: { property_id: "123", event_names: ["purchase"], propagation: "none", change_id: null }, meta: { mode: "crud" } };
    expect(await A.saveConversionEvents("123", ["purchase"])).toEqual({ ok: true, value: { notice: null } });
  });

  it("the property id format check stays first (no backend call)", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    const r = await A.loadConversionEvents("abc");
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("no session -> UnauthorizedError before any call", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    st.session = null;
    await expect(A.loadConversionEvents("123")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(0);
  });
});

describe("error map (api)", () => {
  beforeEach(() => vi.stubEnv("HGH_SOURCE_G3", "api"));

  it("read: 404 (outside the account, IDOR hiding) and 403 -> UnauthorizedError, as legacy authorize failure", async () => {
    fail(404, "not_found");
    await expect(A.loadConversionEvents("123")).rejects.toBeInstanceOf(UnauthorizedError);
    fail(403, "menu_forbidden");
    await expect(A.loadConversionEvents("123")).rejects.toBeInstanceOf(UnauthorizedError);
    fail(403, "forbidden");
    await expect(A.saveConversionEvents("123", [])).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("401 -> UnauthorizedError (one refresh is tried first)", async () => {
    fail(401, "token_expired");
    await expect(A.loadConversionEvents("123")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("write 404 = property outside the registry -> error text (G13); 422 -> invalid", async () => {
    fail(404, "not_found");
    expect(await A.saveConversionEvents("123", ["x"])).toEqual({ ok: false, error: "notRegistered" });
    fail(422, "invalid_value");
    expect(await A.saveConversionEvents("123", ["bad name"])).toEqual({ ok: false, error: "invalid" });
  });

  it("5xx / unavailable -> load or save failed, not thrown", async () => {
    fail(503, "unavailable");
    expect(await A.loadConversionEvents("123")).toEqual({ ok: false, error: "loadFailed" });
    expect(await A.saveConversionEvents("123", [])).toEqual({ ok: false, error: "saveFailed" });
  });
});

describe("place gate before the source branch (verify D1)", () => {
  it("PROBE-5: a country account without the website menu, no project: refused on legacy and api, no read or write", async () => {
    st.session = session("country", ["project"]);
    for (const flag of ["", "legacy", "api"]) {
      vi.stubEnv("HGH_SOURCE_G3", flag);
      await expect(A.loadConversionEvents("123")).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(A.saveConversionEvents("123", ["purchase", "lead"])).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(st.legacyLoad).not.toHaveBeenCalled();
    expect(st.legacySave).not.toHaveBeenCalled();
    expect(st.resolveProperties).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("a project context needs the /projects place (menu project) on both sources", async () => {
    st.session = session("country", ["website"]);
    for (const flag of ["", "api"]) {
      vi.stubEnv("HGH_SOURCE_G6", flag);
      await expect(A.loadConversionEvents("123", PROJECT)).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(A.saveConversionEvents("123", ["purchase"], PROJECT)).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(calls).toHaveLength(0);
    // with the project menu the backend decides the membership (api)
    st.session = session("country", ["project"]);
    vi.stubEnv("HGH_SOURCE_G6", "api");
    expect((await A.loadConversionEvents("123", PROJECT)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("U8 N1: an admin whose menu is narrowed to standard is refused a project context on every source", async () => {
    st.session = session("admin", ["standard"]);
    for (const flag of ["", "legacy", "api"]) {
      vi.stubEnv("HGH_SOURCE_G6", flag);
      await expect(A.loadConversionEvents("123", PROJECT)).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(A.saveConversionEvents("123", ["purchase"], PROJECT)).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(st.legacyLoad).not.toHaveBeenCalled();
    expect(st.legacySave).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("the website menu passes (legacy authorize then checks the scope property)", async () => {
    st.session = session("country", ["website"]);
    expect((await A.loadConversionEvents("123")).ok).toBe(true);
    expect(st.legacyLoad).toHaveBeenCalledWith("123");
  });
});

describe("admin registry place follows G7 (verify D2, U8-N9)", () => {
  const ADMIN_EVENTS = {
    data: { property_id: "123", window_from: "2026-06-18", window_to: "2026-09-15", loaded: true, items: [{ event_name: "purchase", count: 5, tracked: true }] },
    meta: { mode: "admin" },
  };

  it("PROBE-7: a narrowed admin (menu admin only) with G3=api keeps the registry source (G7 legacy), not a 403", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    st.session = session("admin", ["admin"]);
    expect(await A.loadConversionEvents("123")).toEqual({ ok: true, value: [{ eventName: "legacy", count: 1, tracked: false }] });
    expect(await A.saveConversionEvents("123", ["purchase"])).toEqual({ ok: true, value: { notice: null } });
    expect(calls).toHaveLength(0);
  });

  it("G7=api: GET and PUT /v1/admin/ga4/properties/{id}/events (no BG-29 call)", async () => {
    vi.stubEnv("HGH_SOURCE_G7", "api");
    st.session = session("admin", null);
    answer.json = ADMIN_EVENTS;
    expect(await A.loadConversionEvents("123")).toEqual({ ok: true, value: [{ eventName: "purchase", count: 5, tracked: true }] });
    answer.json = { data: { property_id: "123", event_names: ["purchase"], propagation: "pending", change_id: 4 }, meta: { mode: "admin" } };
    expect(await A.saveConversionEvents("123", ["purchase"])).toEqual({ ok: true, value: { notice: "savedPending" } });
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ["GET", "/v1/admin/ga4/properties/123/events"],
      ["PUT", "/v1/admin/ga4/properties/123/events"],
    ]);
    expect(calls[1].body).toEqual({ event_names: ["purchase"] });
    expect(st.legacyLoad).not.toHaveBeenCalled();
    expect(st.legacySave).not.toHaveBeenCalled();
  });

  it("G7=api: an admin read of a property outside the registry (404) is the notRegistered text, not a refusal", async () => {
    vi.stubEnv("HGH_SOURCE_G7", "api");
    st.session = session("admin", ["admin"]);
    fail(404, "not_found");
    expect(await A.loadConversionEvents("123")).toEqual({ ok: false, error: "notRegistered" });
  });

  it("an admin without the admin menu is on the website place (G3); with neither menu, refused", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "api");
    vi.stubEnv("HGH_SOURCE_G7", "legacy");
    st.session = session("admin", ["website"]);
    expect((await A.loadConversionEvents("123")).ok).toBe(true);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/funnel/conversion/events"]);
    st.session = session("admin", ["project"]);
    await expect(A.loadConversionEvents("123")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(1);
  });
});
