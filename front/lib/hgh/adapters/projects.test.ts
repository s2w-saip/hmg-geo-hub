import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { User } from "@/lib/auth/types";

// Unit tests of the project management adapter (U9). Mappers with hand-computed expectations,
// readers and writes against a fetch-level fake backend (token through the lib/hgh/auth seam).
// Legacy <-> api parity of the pages and actions is in projects.parity.test.ts.

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("../auth");
const { HghApiError } = await import("../errors");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const P = await import("./projects");

type S = components["schemas"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PID = "c0000000-0000-4000-8000-000000000003";
const PID2 = "c0000000-0000-4000-8000-000000000004";
const UID = "a0000000-0000-4000-8000-000000000001";
const BASE = "https://api.hgh.test";

// ── fake backend ────────────────────────────────────────────────────────────

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}
type Handler = (r: Req) => Response | Promise<Response>;
let handler: Handler;
const calls: Req[] = [];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = (data: unknown, meta: Record<string, unknown> = {}) => json(200, { data, meta: { mode: "crud", ...meta } });
const err = (status: number, code: string, details: unknown = null) => json(status, { error: { code, message: "dev text", details } });
const noContent = () => new Response(null, { status: 204 });

function serve(h: Handler) {
  handler = h;
}
const callKeys = () => calls.map((c) => `${c.method} ${c.path}${c.query.toString() ? `?${c.query}` : ""}`);

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", BASE);
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_UPLOAD_MAX_BYTES", "");
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const u = new URL(String(input));
      let body: unknown = init.body;
      if (typeof init.body === "string") body = JSON.parse(init.body);
      const r: Req = {
        method: String(init.method ?? "GET"),
        path: u.pathname,
        query: u.searchParams,
        body,
        headers: new Headers(init.headers),
      };
      calls.push(r);
      return handler(r);
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── fixtures ────────────────────────────────────────────────────────────────

const listItem = (d: Partial<S["ProjectListItem"]> = {}): S["ProjectListItem"] => ({
  project_id: PID,
  name: "Kia US",
  description: "desc",
  domain: "kia.com/us",
  brand_code: "Kia",
  country_code: "US",
  scope_project_id: null,
  ga4_property_id: "123",
  ai_engines: null,
  effective_engines: ["chatgpt", "gemini"],
  created_by: UID,
  created_at: "2026-06-01T03:04:05.123456+00:00",
  updated_at: "2026-06-02T00:00:00+00:00",
  my_role: "owner",
  active_member_count: 2,
  prompt_count: 7,
  prompt_in_flight_count: 1,
  ...d,
});

const detail = (d: Partial<S["ProjectDetail"]> = {}): S["ProjectDetail"] => ({
  project_id: PID,
  name: "Kia US",
  description: null,
  domain: "kia.com/us",
  brand_code: "Kia",
  country_code: "US",
  scope_project_id: "e0000000-0000-4000-8000-000000000009",
  scope_linked: true,
  ga4_property_id: null,
  ai_engines: null,
  effective_engines: ["chatgpt", "gemini"],
  created_by: UID,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  my_role: "owner",
  ...d,
});

const bundle = (d: Partial<S["SettingsBundle"]> = {}): S["SettingsBundle"] => ({
  project_id: PID,
  domain: "kia.com/us",
  my_role: "owner",
  can_edit: true,
  engines: { stored: ["gemini", "chatgpt", "claude"], effective: ["gemini", "chatgpt", "claude"], allowed: ["chatgpt", "gemini"], can_edit: false },
  owned_bases: [
    { base_norm: "kia.com/us", base_url: "https://www.kia.com/us/", label: "US", created_at: "2026-06-01T00:00:00Z", created_by: UID },
  ],
  brand_aliases: { brand_code: "Kia", aliases: ["기아", "KIA Motors"] },
  competitors: [
    { brand_name: "Toyota", aliases: ["토요타"], notes: null, is_target: true, created_at: "2026-06-01T00:00:00Z" },
  ],
  vehicles: [{ brand: "Kia", model: "EV9", segment: "SUV", aliases: [], created_at: "2026-06-01T00:00:00Z" }],
  tracked_url_count: 1,
  ...d,
});

const user = (scope: User["scope"], d: Partial<User> = {}): User => ({
  id: UID,
  email: "u@hmg.test",
  role: "hq",
  operator: "global",
  menuGroups: null,
  scope,
  ...d,
});

// ── mappers ─────────────────────────────────────────────────────────────────

describe("mappers (hand-computed)", () => {
  it("ProjectListItem -> ProjectRow, every field; language null; timestamps as Date", () => {
    expect(P.toProjectRow(listItem())).toEqual({
      id: PID,
      name: "Kia US",
      description: "desc",
      domain: "kia.com/us",
      brand: "Kia",
      country: "US",
      language: null,
      scopeProjectId: null,
      ga4PropertyId: "123",
      aiEngines: null,
      createdBy: UID,
      createdAt: new Date("2026-06-01T03:04:05.123Z"),
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    });
  });

  it("card: my_role null -> viewer (legacy fallback), counts, created_at in Date#toISOString form", () => {
    expect(P.toProjectCard(listItem({ my_role: null, domain: undefined }))).toEqual({
      id: PID,
      name: "Kia US",
      domain: null,
      role: "viewer",
      promptCount: 7,
      activeMembers: 2,
      createdAt: "2026-06-01T03:04:05.123Z",
    });
  });

  it("list totals = sums over every listed project (2+3 members, 1+0 in flight)", () => {
    const v = P.toProjectsListView(
      [listItem(), listItem({ project_id: PID2, active_member_count: 3, prompt_in_flight_count: 0 })],
      [],
    );
    expect(v.totalActiveMembers).toBe(5);
    expect(v.totalQueuedPrompts).toBe(1);
    expect(v.cards.map((c) => c.id)).toEqual([PID, PID2]);
  });

  it("pending invites: API newest first -> legacy oldest first; membershipId carries the project id", () => {
    const inv = (id: string, at: string, name: string): S["PendingInvite"] => ({
      project_id: id,
      project_name: name,
      country_code: "US",
      role: "viewer",
      invited_at: at,
      invited_by: UID,
    });
    expect(P.toPendingRows([inv(PID2, "2026-06-03T00:00:00Z", "B"), inv(PID, "2026-06-02T00:00:00.5+00:00", "A")])).toEqual([
      { membershipId: PID, projectId: PID, projectName: "A", invitedAt: "2026-06-02T00:00:00.500Z" },
      { membershipId: PID2, projectId: PID2, projectName: "B", invitedAt: "2026-06-03T00:00:00.000Z" },
    ]);
  });

  it("rankByLegacyOrder keeps the API set, orders by the legacy index, unknown values last in API order", () => {
    expect(P.rankByLegacyOrder(["Kia", "X", "Genesis", "Hyundai", "Y"], ["Hyundai", "Genesis", "Kia"])).toEqual([
      "Hyundai",
      "Genesis",
      "Kia",
      "X",
      "Y",
    ]);
    // A legacy value the API does not give is not added.
    expect(P.rankByLegacyOrder(["Kia"], ["Hyundai", "Kia"])).toEqual(["Kia"]);
  });

  it("creation options: all-brand account re-ranked to GEO_BRANDS order (Hyundai, Genesis, Kia); lock from the API", () => {
    const data: S["CreationOptions"] = {
      brands: ["Hyundai", "Kia", "Genesis"],
      countries: ["KR", "DE", "US"],
      brand_locked: false,
      engines: ["chatgpt", "gemini", "deepseek"],
      default_engines: ["chatgpt", "gemini"],
    };
    const v = P.toCreationOptionsView(data, user({ all: false, brands: undefined, regions: undefined, countries: ["US", "DE", "KR"] }));
    expect(v.brands).toEqual(["Hyundai", "Genesis", "Kia"]);
    // Country scope set: legacy keeps the account's stored order.
    expect(v.countries).toEqual(["US", "DE", "KR"]);
    expect(v.brandLocked).toBe(false);
    expect(v.defaultEngines).toEqual(["chatgpt", "gemini"]);
  });

  it("settings bundle -> SettingsPageData (ids, aliases, engines normalized like legacy effectiveAiEngines)", () => {
    const d = P.toSettingsPageData(
      detail(),
      bundle(),
      [{ url_norm: "kia.com/us/ev9", url: "https://www.kia.com/us/ev9", label: null, created_at: "2026-06-01T00:00:00Z", created_by: UID }],
      [{ history_id: "42", engines: ["chatgpt"], changed_at: "2026-06-05T01:02:03.456789Z", changed_by: null }],
    );
    expect(d).toEqual({
      project: { name: "Kia US", description: null, brand: "Kia", country: "US", ga4PropertyId: null, domain: "kia.com/us" },
      canEdit: true,
      canEditEngines: false,
      // "claude" is outside the front vocabulary and dropped; catalog order chatgpt, gemini.
      engines: { initial: ["chatgpt", "gemini"], explicit: true },
      engineHistory: [{ id: "42", engines: ["chatgpt"], changedAt: "2026-06-05T01:02:03.456Z" }],
      ownedBases: [{ id: "kia.com/us", baseUrl: "https://www.kia.com/us/", label: "US" }],
      trackedUrls: [{ id: "kia.com/us/ev9", url: "https://www.kia.com/us/ev9", label: null }],
      ownBrandAliases: ["기아", "KIA Motors"],
      designatedBrands: [{ id: "Toyota", brandName: "Toyota", aliases: ["토요타"], notes: null, isTarget: true }],
      vehicles: [{ id: "Kia\u0000EV9", brand: "Kia", model: "EV9", segment: "SUV", aliases: [] }],
      scopeLink: { status: "linked", scopeProjectId: "e0000000-0000-4000-8000-000000000009" },
    });
  });

  it("settings: no stored engines -> explicit false; no scope id -> missing; umbrella project -> no own aliases", () => {
    const d = P.toSettingsPageData(
      detail({ brand_code: null, scope_project_id: null }),
      bundle({ engines: { stored: null, effective: ["chatgpt", "gemini"], allowed: [], can_edit: true } }),
      [],
      [],
    );
    expect(d.engines).toEqual({ initial: ["chatgpt", "gemini"], explicit: false });
    expect(d.canEditEngines).toBe(true);
    expect(d.scopeLink).toEqual({ status: "missing", scopeProjectId: null });
    expect(d.ownBrandAliases).toEqual([]);
  });

  it("scope link view: served_ratio 3/4 -> 75%, 0/0 -> null (block shows 'no jobs')", () => {
    const base: S["ScopeLink"] = {
      project_id: PID,
      linked: true,
      scope_project_id: null,
      state: "partial",
      latest_round: { round_date: "2026-09-20", status: "published", servable: true, view_date: null },
      jobs: { total: 4, served: 3, served_ratio: { num: 3, den: 4 }, in_progress: 1, failed: 0, last_measured_at: "2026-09-21T00:00:00Z" },
      outbox: { pending: 2, erroring: 1, prompt_pending: 0, recent: [] },
    };
    expect(P.toScopeLinkView(base)).toEqual({
      state: "partial",
      latestRound: { roundDate: "2026-09-20", status: "published", servable: true },
      jobs: { total: 4, served: 3, servedPct: 75, inProgress: 1, failed: 0, lastMeasuredAt: "2026-09-21T00:00:00.000Z" },
      outbox: { pending: 2, erroring: 1, promptPending: 0 },
    });
    const none = P.toScopeLinkView({ ...base, jobs: { ...base.jobs!, total: 0, served: 0, served_ratio: { num: 0, den: 0 } }, latest_round: null });
    expect(none.jobs?.servedPct).toBeNull();
    expect(none.latestRound).toBeNull();
  });

  it("prompts: API newest first reversed to oldest first; tags -> customValues; members, audit, candidates", () => {
    const pi = (id: string, at: string, tags: Record<string, string> = {}): S["app__features__projects__prompts__crud__schemas__PromptItem"] => ({
      prompt_id: id,
      text: `t-${id.slice(-1)}`,
      kind: "single",
      status: "draft",
      prompt_type: "comparison",
      category: null,
      brand_code: "Kia",
      lang: null,
      regions: null,
      scope_prompt_id: null,
      candidate_id: null,
      tags,
      created_at: at,
      updated_at: at,
    });
    const rows = P.toPromptRows([pi(PID2, "2026-06-02T00:00:00Z", { f1: "v" }), pi(PID, "2026-06-01T00:00:00Z")]);
    expect(rows.map((r) => r.id)).toEqual([PID, PID2]);
    expect(rows[1]).toEqual({
      id: PID2,
      text: "t-4",
      promptType: "comparison",
      category: null,
      brand: "Kia",
      status: "draft",
      scopePromptId: null,
      customValues: { f1: "v" },
    });
    expect(
      P.toMemberRow({ user_id: UID, email: "a@b.c", role: "viewer", status: "pending", invited_at: "2026-06-01T00:00:00.1234Z", invited_by: UID }),
    ).toEqual({ id: UID, email: "a@b.c", role: "viewer", status: "pending", invitedAt: "2026-06-01T00:00:00.123Z" });
    expect(
      P.toAuditEntry({ audit_id: "9", action: "promote", actor_id: UID, target_user_id: UID, actor_email: null, target_email: "t@x.y", context: "viewer->owner", created_at: "2026-06-01T00:00:00Z" }),
    ).toEqual({ id: "9", actorEmail: null, targetEmail: "t@x.y", action: "promote", context: "viewer->owner", createdAt: "2026-06-01T00:00:00.000Z" });
    expect(
      P.toCandidateRow({ candidate_id: PID, source: "google_keyword", source_keyword: undefined, text: "q", created_at: "2026-06-01T00:00:00Z" }),
    ).toEqual({ id: PID, source: "google_keyword", sourceKeyword: null, text: "q", createdAt: "2026-06-01T00:00:00.000Z" });
  });

  it("vehicle composite id round trip; malformed ids are rejected", () => {
    expect(P.splitVehicleId(P.vehicleId("Kia", "EV 9"))).toEqual({ brand: "Kia", model: "EV 9" });
    expect(P.splitVehicleId("Kia")).toBeNull();
    expect(P.splitVehicleId("\u0000EV9")).toBeNull();
    expect(P.splitVehicleId("Kia\u0000")).toBeNull();
  });

  it("Content-Disposition filename: filename* first, then filename, else null", () => {
    expect(P.dispositionFilename(`attachment; filename="a.xlsx"; filename*=UTF-8''%ED%94%84.xlsx`)).toBe("프.xlsx");
    expect(P.dispositionFilename(`attachment; filename="prompts-c0000000-20260929.xlsx"`)).toBe("prompts-c0000000-20260929.xlsx");
    expect(P.dispositionFilename("attachment")).toBeNull();
    expect(P.dispositionFilename(null)).toBeNull();
  });

  it("by-scope target: project, website, incomplete answers -> null", () => {
    expect(P.toScopeTarget({ kind: "project", project_id: PID })).toEqual({ kind: "project", projectId: PID });
    expect(P.toScopeTarget({ kind: "website", brand_code: "Genesis", country_code: "AE" })).toEqual({ kind: "website", brand: "Genesis", country: "AE" });
    expect(P.toScopeTarget({ kind: "website", brand_code: null, country_code: "AE" })).toBeNull();
  });

  it("source flag: HGH_SOURCE_G6 (default legacy)", () => {
    expect(P.isProjectsApi({})).toBe(false);
    expect(P.isProjectsApi({ HGH_SOURCE_G6: "api" })).toBe(true);
    expect(P.isProjectsApi({ HGH_SOURCE_G6: "legacy", HGH_SOURCE_G2: "api" })).toBe(false);
  });
});

// ── readers ─────────────────────────────────────────────────────────────────

describe("readers", () => {
  it("project list reads every cursor page (limit 100) plus the invites, sums over all pages", async () => {
    serve((r) => {
      if (r.path === "/v1/projects") {
        return r.query.get("cursor") === "c2"
          ? ok({ items: [listItem({ project_id: PID2, active_member_count: 5 })], next_cursor: null }, { page: { limit: 100, next_cursor: null } })
          : ok({ items: [listItem()], next_cursor: "c2" }, { page: { limit: 100, next_cursor: "c2" } });
      }
      if (r.path === "/v1/me/project-invites") return ok({ items: [] });
      return err(404, "not_found");
    });
    const v = await withRequestScope(() => P.loadProjectsList("ko"));
    expect(callKeys().sort()).toEqual(["GET /v1/me/project-invites", "GET /v1/projects?cursor=c2&limit=100", "GET /v1/projects?limit=100"]);
    expect(v.cards.map((c) => c.id)).toEqual([PID, PID2]);
    expect(v.totalActiveMembers).toBe(7);
  });

  it("project list: 401 -> login, 5xx -> thrown to the error boundary", async () => {
    serve(() => err(401, "token_expired"));
    await expect(withRequestScope(() => P.loadProjectsList("ko"))).rejects.toThrow("REDIRECT:/ko/login");
    serve(() => err(503, "unavailable"));
    await expect(withRequestScope(() => P.loadProjectsList("ko"))).rejects.toBeInstanceOf(HghApiError);
  });

  it("creation options: 403 operator_forbidden -> null (the page sends the user back); other 403 -> no-access", async () => {
    serve(() => err(403, "operator_forbidden"));
    await expect(P.loadCreationOptions("ko", user({ all: true }))).resolves.toBeNull();
    serve(() => err(403, "role_forbidden"));
    await expect(P.loadCreationOptions("ko", user({ all: true }))).rejects.toThrow("REDIRECT:/ko/no-access");
  });

  it("by-scope: non-uuid never sent; 404 -> null; project and website targets", async () => {
    serve(() => ok({ kind: "project", project_id: PID }));
    await expect(P.resolveByScope("ko", "not-a-uuid")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
    await expect(P.resolveByScope("ko", PID2)).resolves.toEqual({ kind: "project", projectId: PID });
    expect(callKeys()).toEqual([`GET /v1/projects/by-scope/${PID2}`]);
    serve(() => err(404, "not_found"));
    await expect(P.resolveByScope("ko", PID2)).resolves.toBeNull();
    serve(() => ok({ kind: "website", brand_code: "Genesis", country_code: "AE" }));
    await expect(P.resolveByScope("ko", PID2)).resolves.toEqual({ kind: "website", brand: "Genesis", country: "AE" });
  });

  const memberWorld = (my: "owner" | "viewer" | null) =>
    serve((r) => {
      if (r.path === `/v1/projects/${PID}`) return ok(detail({ my_role: my }));
      if (r.path === `/v1/projects/${PID}/members`) {
        return ok({ items: [{ user_id: UID, email: "o@x.y", role: "owner", status: "active", invited_at: "2026-06-01T00:00:00Z", invited_by: UID }] });
      }
      if (r.path === `/v1/projects/${PID}/member-audit`) return ok({ items: [], next_cursor: null });
      return err(404, "not_found");
    });

  it("member page: owner and admin-without-membership edit, viewer does not; audit limit 20", async () => {
    memberWorld("owner");
    const owner = await withRequestScope(() => P.loadMemberPage("ko", PID, false));
    expect(owner.canEdit).toBe(true);
    expect(owner.members).toEqual([{ id: UID, email: "o@x.y", role: "owner", status: "active", invitedAt: "2026-06-01T00:00:00.000Z" }]);
    expect(callKeys()).toContain(`GET /v1/projects/${PID}/member-audit?limit=20`);
    memberWorld("viewer");
    expect((await withRequestScope(() => P.loadMemberPage("ko", PID, false))).canEdit).toBe(false);
    memberWorld(null);
    expect((await withRequestScope(() => P.loadMemberPage("ko", PID, true))).canEdit).toBe(true);
  });

  it("member / setting / prompt pages: hidden project (404) -> notFound before any data call", async () => {
    serve(() => err(404, "not_found"));
    await expect(withRequestScope(() => P.loadMemberPage("ko", PID, false))).rejects.toThrow("NOT_FOUND");
    await expect(withRequestScope(() => P.loadSettingsPage("ko", PID, false))).rejects.toThrow("NOT_FOUND");
    await expect(withRequestScope(() => P.loadPromptPage("ko", PID, false))).rejects.toThrow("NOT_FOUND");
    expect(new Set(callKeys())).toEqual(new Set([`GET /v1/projects/${PID}`]));
    // A 403 on the gate hides the project too; role/menu 403 -> no-access.
    serve(() => err(403, "owner_only"));
    await expect(withRequestScope(() => P.loadMemberPage("ko", PID, false))).rejects.toThrow("NOT_FOUND");
    serve(() => err(403, "menu_forbidden"));
    await expect(withRequestScope(() => P.loadPromptPage("ko", PID, false))).rejects.toThrow("REDIRECT:/ko/no-access");
  });

  const settingsWorld = (scopeLink: () => Response = () => err(503, "unavailable")) =>
    serve((r) => {
      if (r.path === `/v1/projects/${PID}`) return ok(detail());
      if (r.path === `/v1/projects/${PID}/settings`) return ok(bundle());
      if (r.path === `/v1/projects/${PID}/settings/tracked-urls`) return ok({ items: [], next_cursor: null, total: 0 });
      if (r.path === `/v1/projects/${PID}/settings/engines/history`) return ok({ items: [], next_cursor: null });
      if (r.path === `/v1/projects/${PID}/settings/scope-link`) return scopeLink();
      return err(404, "not_found");
    });

  it("setting page, D6: four first calls (the detail GET is shared with the gate), no scope-link for non-admin", async () => {
    settingsWorld();
    const r = await withRequestScope(() => P.loadSettingsPage("ko", PID, false));
    expect(callKeys().sort()).toEqual([
      `GET /v1/projects/${PID}`,
      `GET /v1/projects/${PID}/settings`,
      `GET /v1/projects/${PID}/settings/engines/history?limit=200`,
      `GET /v1/projects/${PID}/settings/tracked-urls?limit=500`,
    ]);
    expect(r.diagnostic).toBeNull();
  });

  it("setting page, admin: scope-link after the first four; a transient failure degrades to no diagnostic", async () => {
    settingsWorld();
    const r = await withRequestScope(() => P.loadSettingsPage("ko", PID, true));
    expect(callKeys().at(-1)).toBe(`GET /v1/projects/${PID}/settings/scope-link`);
    expect(r.diagnostic).toBeNull();
    settingsWorld(() =>
      ok({ project_id: PID, linked: false, state: "unlinked", outbox: { pending: 0, erroring: 0, prompt_pending: 0, recent: [] } }),
    );
    const r2 = await withRequestScope(() => P.loadSettingsPage("ko", PID, true));
    expect(r2.diagnostic?.state).toBe("unlinked");
  });

  it("prompt page: gate + candidates + prompts + fields (limits 500), viewer read-only", async () => {
    serve((r) => {
      if (r.path === `/v1/projects/${PID}`) return ok(detail({ my_role: "viewer" }));
      if (r.path.endsWith("/prompt-candidates")) return ok({ items: [], next_cursor: null });
      if (r.path.endsWith("/prompts")) return ok({ items: [] });
      if (r.path.endsWith("/prompt-fields")) {
        return ok({ items: [{ field_id: PID2, label: "Tag", archived: false, value_count: 3, created_at: "2026-06-01T00:00:00Z" }] });
      }
      return err(404, "not_found");
    });
    const d = await withRequestScope(() => P.loadPromptPage("ko", PID, false));
    expect(callKeys().sort()).toEqual([
      `GET /v1/projects/${PID}`,
      `GET /v1/projects/${PID}/prompt-candidates?limit=500`,
      `GET /v1/projects/${PID}/prompt-fields`,
      `GET /v1/projects/${PID}/prompts?limit=500`,
    ]);
    expect(d).toEqual({ canEdit: false, candidates: [], prompts: [], customFields: [{ id: PID2, label: "Tag", archived: false }] });
  });
});

// ── writes ──────────────────────────────────────────────────────────────────

describe("write error rule (writeFailure)", () => {
  const e = (status: number, code: string) => new HghApiError(status, code);
  it("table code -> legacy message; ok codes -> ok; 401/403/404 -> UnauthorizedError; else generic", () => {
    expect(P.writeFailure(e(409, "dup"), { dup: "중복" })).toEqual({ ok: false, error: "중복" });
    expect(P.writeFailure(e(404, "gone"), {}, ["gone"])).toBe("ok");
    for (const [s, c] of [
      [401, "token_expired"],
      [403, "owner_only"],
      [403, "role_forbidden"],
      [404, "not_found"],
      [404, "field_not_found"],
    ] as const) {
      expect(() => P.writeFailure(e(s, c), {})).toThrow(UnauthorizedError);
    }
    expect(P.writeFailure(e(409, "conflict"), {})).toEqual({ ok: false, error: P.GENERIC_INVALID });
    expect(P.writeFailure(e(422, "unprocessable"), {})).toEqual({ ok: false, error: P.GENERIC_INVALID });
    expect(P.writeFailure(e(503, "unavailable"), {})).toEqual({ ok: false, error: P.RETRY_LATER });
    expect(P.writeFailure(e(504, "timeout"), {})).toEqual({ ok: false, error: P.RETRY_LATER });
    expect(P.writeFailure(e(429, "rate_limited"), {})).toEqual({ ok: false, error: P.RETRY_LATER });
    expect(() => P.writeFailure(e(500, "client_config"), {})).toThrow(HghApiError);
    expect(() => P.writeFailure(new Error("boom"), {})).toThrow("boom");
  });
});

// One row per (action, backend answer): the legacy message for every mapped backend code.
type Case = [name: string, call: () => Promise<unknown>, status: number, code: string, expected: string | "THROW" | "OK", details?: unknown];
const E = (error: string) => ({ ok: false, error });

const cases: Case[] = [
  ["invite 422", () => P.inviteMember(PID, "bad"), 422, "unprocessable", "이메일 형식이 올바르지 않습니다"],
  ["invite not found", () => P.inviteMember(PID, "a@b.c"), 404, "invitee_not_found", "해당 이메일로 가입된 사용자를 찾을 수 없습니다"],
  ["invite self", () => P.inviteMember(PID, "a@b.c"), 400, "self_invite", "본인을 초대할 수 없습니다"],
  ["invite active", () => P.inviteMember(PID, "a@b.c"), 409, "already_member", "이미 멤버입니다", { status: "active" }],
  ["invite pending", () => P.inviteMember(PID, "a@b.c"), 409, "already_invited", "이미 초대된 사용자입니다 (대기 상태)", { status: "pending" }],
  // U9-1: the code decides, details.status is compatibility data only (the race path re-reads and sends the same codes).
  ["invite active, no details", () => P.inviteMember(PID, "a@b.c"), 409, "already_member", "이미 멤버입니다"],
  ["invite pending, no details", () => P.inviteMember(PID, "a@b.c"), 409, "already_invited", "이미 초대된 사용자입니다 (대기 상태)"],
  ["invite viewer", () => P.inviteMember(PID, "a@b.c"), 403, "owner_only", "THROW"],
  ["remove owner", () => P.removeMember(PID, UID), 409, "cannot_remove_owner", "Owner는 제거할 수 없습니다 (Owner 위임 후 다시 시도)"],
  ["remove self", () => P.removeMember(PID, UID), 400, "cannot_remove_self", "본인을 제거할 수 없습니다"],
  ["remove missing", () => P.removeMember(PID, UID), 404, "member_not_found", "해당 멤버를 찾을 수 없습니다"],
  ["accept missing", () => P.respondToInvite(PID, "accept"), 404, "no_pending_invite", "대기 중인 초대가 아닙니다"],
  ["reject missing", () => P.respondToInvite(PID, "reject"), 404, "no_pending_invite", "대기 중인 초대가 아닙니다"],
  ["promote twice", () => P.changeMemberRole(PID, UID, "owner"), 409, "already_that_role", "이미 Owner입니다"],
  ["promote pending", () => P.changeMemberRole(PID, UID, "owner"), 409, "not_active", "활성 상태의 멤버만 위임 가능합니다"],
  ["demote viewer", () => P.changeMemberRole(PID, UID, "viewer"), 409, "already_that_role", "Viewer는 이미 Viewer입니다"],
  ["demote last", () => P.changeMemberRole(PID, UID, "viewer"), 409, "last_owner_cannot_demote", "마지막 Owner는 강등할 수 없습니다"],
  ["patch name", () => P.updateProject(PID, { name: "x" }), 422, "name_required", "프로젝트 명을 입력해주세요"],
  ["patch ga4", () => P.updateProject(PID, { ga4PropertyId: "a1" }), 422, "invalid_ga4_property_id", "GA4 속성 ID는 숫자만 입력하세요 (예: 469542848)"],
  ["patch brand", () => P.updateProject(PID, { brand: "Genesis" }), 403, "brand_forbidden", "브랜드는 본인 권한 내에서만 선택 가능합니다"],
  ["patch unknown brand", () => P.updateProject(PID, { brand: "Nope" }), 422, "unknown_brand", "브랜드는 본인 권한 내에서만 선택 가능합니다"],
  ["patch empty", () => P.updateProject(PID, { name: "x" }), 422, "empty_patch", "OK"],
  ["patch viewer", () => P.updateProject(PID, { name: "x" }), 403, "owner_only", "THROW"],
  ["aliases stale", () => P.updateProject(PID, { brandAliases: ["a"], brandAliasesBrand: "Kia" }), 409, "brand_mismatch", "프로젝트 브랜드가 바뀌었습니다. 새로고침 후 다시 저장해주세요"],
  ["engines operator", () => P.updateProjectEngines(PID, ["chatgpt"]), 403, "operator_forbidden", "AI 엔진 변경 권한(운영자)이 없습니다"],
  ["engines viewer", () => P.updateProjectEngines(PID, ["chatgpt"]), 403, "owner_only", "THROW"],
  ["engines unknown", () => P.updateProjectEngines(PID, ["chatgpt"]), 422, "unknown_engine", "알 수 없는 엔진입니다"],
  ["delete mismatch", () => P.deleteProject(PID, "x"), 409, "name_mismatch", "입력한 이름이 프로젝트 명과 일치하지 않습니다"],
  ["competitor dup", () => P.addTrackedCompetitor(PID, { brandName: "Toyota" }), 409, "duplicate_competitor", "이미 추가된 브랜드입니다"],
  ["competitor remove gone", () => P.removeTrackedCompetitor(PID, "Toyota"), 404, "competitor_not_found", "OK"],
  ["target gone", () => P.setTargetCompetitor(PID, "Toyota"), 404, "competitor_not_found", "해당 브랜드를 찾을 수 없습니다"],
  ["vehicle dup", () => P.addTrackedVehicle(PID, { brand: "Kia", model: "EV9" }), 409, "duplicate_vehicle", "이미 추가된 모델입니다"],
  ["vehicle remove gone", () => P.removeTrackedVehicle(PID, "Kia\u0000EV9"), 404, "vehicle_not_found", "OK"],
  ["owned dup", () => P.addOwnedBase(PID, { baseUrl: "https://kia.com" }), 409, "duplicate_owned_base", "이미 등록된 owned base예요"],
  ["owned invalid", () => P.addOwnedBase(PID, { baseUrl: "ftp://kia.com" }), 422, "invalid_url", "올바른 URL 형식이 아닙니다"],
  ["owned remove gone", () => P.removeOwnedBase(PID, "kia.com"), 404, "owned_base_not_found", "OK"],
  ["url dup", () => P.addTrackedUrl(PID, { url: "https://kia.com/a" }), 409, "duplicate_tracked_url", "이미 등록된 URL이에요"],
  ["url invalid", () => P.addTrackedUrl(PID, { url: "kia" }), 422, "invalid_url", "올바른 URL 형식이 아닙니다"],
  ["url remove gone", () => P.removeTrackedUrl(PID, "kia.com/a"), 404, "tracked_url_not_found", "OK"],
  ["candidate gone", () => P.deleteCandidate(PID, PID2), 404, "candidate_not_found", "삭제할 후보를 찾을 수 없습니다"],
  ["manual empty", () => P.addManualPrompt(PID, " x "), 422, "empty_text", "프롬프트 내용을 입력해주세요"],
  ["manual lines", () => P.addManualPrompt(PID, "x"), 422, "too_many_lines", "한 번에 1,000줄까지 추가할 수 있습니다"],
  ["manual long", () => P.addManualPrompt(PID, "x"), 422, "text_too_long", "한 줄은 4,000자까지입니다"],
  ["manual ctrl", () => P.addManualPrompt(PID, "x"), 422, "invalid_text", "제어 문자가 포함돼 있습니다"],
  ["prompt measured", () => P.deletePrompt(PID, PID2), 409, "prompt_not_deletable", "측정에 들어간 프롬프트는 완전 삭제로만 지울 수 있습니다"],
  ["prompt delete gone", () => P.deletePrompt(PID, PID2), 404, "prompt_not_found", "OK"],
  ["impact gone", () => P.getPromptLifecycleImpact(PID, PID2), 404, "prompt_not_found", "프롬프트를 찾을 수 없습니다"],
  ["impact viewer", () => P.getPromptLifecycleImpact(PID, PID2), 403, "owner_only", "THROW"],
  ["pause status", () => P.promptLifecycle(PID, PID2, "pause"), 409, "invalid_status", "측정 중인 프롬프트만 중지할 수 있습니다"],
  ["pause shared", () => P.promptLifecycle(PID, PID2, "pause"), 409, "shared_prompt", "다른 행과 측정을 공유하는 프롬프트는 개별로 중지할 수 없습니다"],
  ["resume status", () => P.promptLifecycle(PID, PID2, "resume"), 409, "invalid_status", "측정 중지된 프롬프트만 재개할 수 있습니다"],
  ["resume operator", () => P.promptLifecycle(PID, PID2, "resume"), 403, "operator_forbidden", "THROW"],
  ["hard delete gone", () => P.promptLifecycle(PID, PID2, "hard-delete"), 404, "prompt_not_found", "프롬프트를 찾을 수 없습니다"],
  ["execute none", () => P.executePrompts(PID), 409, "nothing_to_execute", "실행할 프롬프트가 없습니다"],
  ["execute operator", () => P.executePrompts(PID), 403, "operator_forbidden", "THROW"],
  ["field reserved", () => P.addCustomField(PID, "brand"), 422, "reserved_label", "기존 고정 분류축과 같은 이름은 사용할 수 없습니다"],
  ["field dup", () => P.addCustomField(PID, "Tag"), 409, "duplicate", "이미 있는 태그입니다"],
  ["field archive idor", () => P.customFieldOp(PID, PID2, "archive"), 404, "field_not_found", "THROW"],
  ["field delete idor", () => P.customFieldOp(PID, PID2, "delete"), 404, "field_not_found", "THROW"],
  ["value idor", () => P.setPromptCustomFieldValue(PID, PID2, PID2, "v"), 404, "prompt_not_found", "THROW"],
  ["bulk idor", () => P.setPromptCustomFieldValueBulk(PID, [PID2], PID2, "v"), 404, "prompt_not_found", "THROW"],
  ["clear idor", () => P.clearPromptCustomFieldValue(PID, PID2, PID2), 404, "field_not_found", "THROW"],
  ["hidden project", () => P.addTrackedUrl(PID, { url: "https://kia.com/a" }), 404, "not_found", "THROW"],
];

describe("write error tables (every mapped backend code -> the legacy message)", () => {
  it.each(cases)("%s", async (_name, call, status, code, expected, details) => {
    serve(() => err(status, code, details ?? null));
    if (expected === "THROW") {
      await expect(call()).rejects.toBeInstanceOf(UnauthorizedError);
    } else if (expected === "OK") {
      await expect(call()).resolves.toMatchObject({ ok: true });
    } else {
      await expect(call()).resolves.toEqual(E(expected));
    }
  });
});

describe("write requests (method, path, body) and success values", () => {
  it("createProject: legacy input checks first, then POST /v1/projects with the form values", async () => {
    const fd = (entries: [string, string][]) => {
      const f = new FormData();
      for (const [k, v] of entries) f.append(k, v);
      return f;
    };
    serve(() => json(201, { data: detail({ project_id: PID2 }), meta: { mode: "crud" } }));
    await expect(P.createProject(fd([["country", "US"]]))).resolves.toEqual(E("제목을 입력해주세요"));
    await expect(P.createProject(fd([["name", "n"]]))).resolves.toEqual(E("국가를 선택해주세요"));
    await expect(P.createProject(fd([["name", "n"], ["country", "US"]]))).resolves.toEqual(E("AI 엔진을 1개 이상 선택해주세요"));
    expect(calls).toHaveLength(0);
    const r = await P.createProject(
      fd([["name", " n "], ["country", "US"], ["brand", ""], ["domain", " https://kia.com "], ["aiEngines", "chatgpt"], ["aiEngines", "chatgpt"], ["aiEngines", "gemini"]]),
    );
    expect(r).toEqual({ ok: true, projectId: PID2 });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ name: "n", description: null, domain: "https://kia.com", brand_code: null, country_code: "US", ai_engines: ["chatgpt", "gemini"] });
    serve(() => err(403, "country_forbidden"));
    await expect(P.createProject(fd([["name", "n"], ["country", "ZZ"], ["aiEngines", "chatgpt"]]))).resolves.toEqual(E("선택한 국가에 대한 권한이 없습니다"));
    serve(() => err(403, "operator_forbidden"));
    await expect(P.createProject(fd([["name", "n"], ["country", "US"], ["aiEngines", "chatgpt"]]))).resolves.toEqual(E("프로젝트 생성 권한(운영자)이 없습니다"));
  });

  it("cancelInvite reads the roster first: pending -> DELETE; active -> legacy message, no DELETE; missing -> not found", async () => {
    const roster = (status: "pending" | "active") => ({
      items: [{ user_id: UID, email: "x@y.z", role: "viewer", status, invited_at: "2026-06-01T00:00:00Z", invited_by: UID }],
    });
    serve((r) => (r.method === "GET" ? ok(roster("pending")) : noContent()));
    await expect(P.cancelInvite(PID, UID)).resolves.toEqual({ ok: true, value: undefined });
    expect(callKeys()).toEqual([`GET /v1/projects/${PID}/members`, `DELETE /v1/projects/${PID}/members/${UID}`]);
    calls.length = 0;
    serve((r) => (r.method === "GET" ? ok(roster("active")) : noContent()));
    await expect(P.cancelInvite(PID, UID)).resolves.toEqual(E("대기 중인 초대만 취소할 수 있습니다"));
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    await expect(P.cancelInvite(PID, PID2)).resolves.toEqual(E("해당 멤버를 찾을 수 없습니다"));
    serve(() => err(403, "owner_only"));
    await expect(P.cancelInvite(PID, UID)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  // Verification D1: the roster read refreshes on 401 token_expired like every other action call.
  it("cancelInvite: 401 token_expired on the roster read refreshes and retries once, then DELETE", async () => {
    let gets = 0;
    serve((r) => {
      if (r.method !== "GET") return noContent();
      gets += 1;
      return gets === 1
        ? err(401, "token_expired")
        : ok({ items: [{ user_id: UID, email: "x@y.z", role: "viewer", status: "pending", invited_at: "2026-06-01T00:00:00Z", invited_by: UID }] });
    });
    await expect(P.cancelInvite(PID, UID)).resolves.toEqual({ ok: true, value: undefined });
    expect(callKeys()).toEqual([
      `GET /v1/projects/${PID}/members`,
      `GET /v1/projects/${PID}/members`,
      `DELETE /v1/projects/${PID}/members/${UID}`,
    ]);
  });

  // Verification D2: triggerReprocess on the api source keeps the legacy owner-or-admin outcome.
  it("authorizeReprocess: owner / admin -> flagged 0 (reads only); viewer, hidden, no session, bad id -> throw", async () => {
    serve(() => ok(detail({ my_role: "owner" })));
    await expect(P.authorizeReprocess(PID)).resolves.toEqual({ ok: true, value: { flagged: 0 } });
    expect(callKeys()).toEqual([`GET /v1/projects/${PID}`]);
    calls.length = 0;
    serve((r) => (r.path === "/v1/auth/me" ? ok({ role: "admin" }) : ok(detail({ my_role: null }))));
    await expect(P.authorizeReprocess(PID)).resolves.toEqual({ ok: true, value: { flagged: 0 } });
    expect(callKeys()).toEqual([`GET /v1/projects/${PID}`, "GET /v1/auth/me"]);
    serve((r) => (r.path === "/v1/auth/me" ? ok({ role: "hq" }) : ok(detail({ my_role: "viewer" }))));
    await expect(P.authorizeReprocess(PID)).rejects.toBeInstanceOf(UnauthorizedError);
    serve(() => err(404, "project_not_found"));
    await expect(P.authorizeReprocess(PID)).rejects.toBeInstanceOf(UnauthorizedError);
    serve(() => err(503, "unavailable"));
    await expect(P.authorizeReprocess(PID)).resolves.toEqual(E(P.RETRY_LATER));
    calls.length = 0;
    await expect(P.authorizeReprocess("not-a-uuid")).rejects.toBeInstanceOf(UnauthorizedError);
    bindHghAuth({ getAccessToken: async () => null });
    await expect(P.authorizeReprocess(PID)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toEqual([]);
  });

  it("updateProject: PATCH general fields (domain never sent), PUT aliases (deduped, trimmed); reprocessable 0", async () => {
    serve((r) => (r.method === "PATCH" ? ok(detail()) : ok({ tracked_brands: [], propagation: "pending" })));
    const r = await P.updateProject(PID, {
      name: " New ",
      description: "  ",
      brand: "Kia",
      ga4PropertyId: "",
      domain: "https://kia.com",
      brandAliases: [" 기아 ", "기아", ""],
      brandAliasesBrand: "Kia",
    });
    expect(r).toEqual({ ok: true, value: { reprocessable: 0 } });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PATCH", `/v1/projects/${PID}`, { name: "New", description: null, brand_code: "Kia", ga4_property_id: null }],
      ["PUT", `/v1/projects/${PID}/settings/brand-aliases`, { brand_code: "Kia", aliases: ["기아"] }],
    ]);
    calls.length = 0;
    // domain alone: nothing to send; alias save without a project brand: stale-brand message, no call.
    await expect(P.updateProject(PID, { domain: "x" })).resolves.toEqual({ ok: true, value: { reprocessable: 0 } });
    await expect(P.updateProject(PID, { brandAliases: [], brandAliasesBrand: null })).resolves.toEqual(
      E("프로젝트 브랜드가 바뀌었습니다. 새로고침 후 다시 저장해주세요"),
    );
    await expect(P.updateProject(PID, { name: "  " })).resolves.toEqual(E("프로젝트 명을 입력해주세요"));
    expect(calls).toHaveLength(0);
  });

  it("updateProjectEngines: engines normalized like legacy; result engines normalized; pushed + queued", async () => {
    serve(() => ok({ engines: ["gemini", "chatgpt"], changed: true, propagation: "pending", reenable: false, outbox_id: 5 }));
    const r = await P.updateProjectEngines(PID, ["gemini", "foo", "chatgpt", "gemini"]);
    expect(calls[0].body).toEqual({ engines: ["chatgpt", "gemini"] });
    expect(r).toEqual({ ok: true, value: { engines: ["chatgpt", "gemini"], changed: true, pushed: true, queued: true } });
  });

  it("tracked entities: ids are the natural keys; vehicle delete splits the composite id", async () => {
    serve((r) =>
      r.path.endsWith("/vehicles") && r.method === "POST"
        ? json(201, { data: { vehicle: { brand: "Kia", model: "EV9", aliases: [], created_at: "2026-06-01T00:00:00Z" }, tracked_brands: [] }, meta: { mode: "crud" } })
        : r.path.endsWith("/competitors") && r.method === "POST"
          ? json(201, { data: { competitor: { brand_name: "Toyota", aliases: [], created_at: "2026-06-01T00:00:00Z" }, tracked_brands: [] }, meta: { mode: "crud" } })
          : ok({ tracked_brands: [] }),
    );
    await expect(P.addTrackedVehicle(PID, { brand: " Kia ", model: "EV9", aliases: ["a", "a"] })).resolves.toEqual({
      ok: true,
      value: { id: "Kia\u0000EV9", reprocessable: 0 },
    });
    expect(calls[0].body).toEqual({ brand: "Kia", model: "EV9", segment: null, aliases: ["a"] });
    await expect(P.addTrackedCompetitor(PID, { brandName: "Toyota", notes: " " })).resolves.toEqual({
      ok: true,
      value: { id: "Toyota", reprocessable: 0 },
    });
    await P.removeTrackedVehicle(PID, "Kia\u0000EV 9");
    expect(callKeys().at(-1)).toBe(`DELETE /v1/projects/${PID}/settings/vehicles?brand=Kia&model=EV+9`);
    const before = calls.length;
    await expect(P.removeTrackedVehicle(PID, "garbage")).resolves.toEqual({ ok: true, value: { reprocessable: 0 } });
    expect(calls.length).toBe(before);
    await P.removeTrackedCompetitor(PID, "Toyota");
    expect(callKeys().at(-1)).toBe(`DELETE /v1/projects/${PID}/settings/competitors?brand_name=Toyota`);
    await P.setTargetCompetitor(PID, null);
    expect(calls.at(-1)?.body).toEqual({ brand_name: null });
  });

  it("owned bases and tracked URLs: empty input keeps the legacy message and is not sent; ids = normalized keys", async () => {
    await expect(P.addOwnedBase(PID, { baseUrl: " " })).resolves.toEqual(E("Owned base URL을 입력해주세요"));
    await expect(P.addTrackedUrl(PID, { url: "" })).resolves.toEqual(E("URL을 입력해주세요"));
    expect(calls).toHaveLength(0);
    serve((r) =>
      r.path.endsWith("/owned-bases")
        ? json(201, { data: { base_norm: "kia.com/us", change_id: 1, owned_base: null }, meta: { mode: "crud" } })
        : json(201, { data: { url_norm: "kia.com/us/ev9", change_id: 2, tracked_url: null }, meta: { mode: "crud" } }),
    );
    await expect(P.addOwnedBase(PID, { baseUrl: "https://www.kia.com/us/", label: " " })).resolves.toEqual({ ok: true, value: { id: "kia.com/us" } });
    expect(calls[0].body).toEqual({ base_url: "https://www.kia.com/us/", label: null });
    await expect(P.addTrackedUrl(PID, { url: "https://kia.com/us/ev9", label: "EV9" })).resolves.toEqual({ ok: true, value: { id: "kia.com/us/ev9" } });
  });

  it("candidates: chunks of 500, a chunk without rows of this project counts 0, all gone -> legacy message", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    let n = 0;
    serve(() => {
      n += 1;
      return n === 2 ? err(404, "candidate_not_found") : json(201, { data: { created: 3, prompt_ids: [], not_found: [] }, meta: { mode: "crud" } });
    });
    await expect(P.selectFromCandidates(PID, ids)).resolves.toEqual({ ok: true, value: { created: 6 } });
    expect(calls.map((c) => (c.body as { candidate_ids: string[] }).candidate_ids.length)).toEqual([500, 500, 1]);
    serve(() => err(404, "candidate_not_found"));
    await expect(P.selectFromCandidates(PID, ids.slice(0, 2))).resolves.toEqual(E("선택한 후보를 찾을 수 없습니다"));
    await expect(P.deleteCandidates(PID, ids.slice(0, 2))).resolves.toEqual(E("삭제할 후보를 찾을 수 없습니다"));
    await expect(P.selectFromCandidates(PID, [])).resolves.toEqual(E("선택된 후보가 없습니다"));
    await expect(P.deleteCandidates(PID, [])).resolves.toEqual(E("선택된 후보가 없습니다"));
  });

  it("bulk tag values: input checks, chunks of 1000 ids, counts summed", async () => {
    await expect(P.setPromptCustomFieldValueBulk(PID, [PID2], PID2, " ")).resolves.toEqual(E("값을 입력해주세요"));
    await expect(P.setPromptCustomFieldValueBulk(PID, [], PID2, "v")).resolves.toEqual(E("프롬프트를 선택해주세요"));
    await expect(P.setPromptCustomFieldValue(PID, PID2, PID2, "")).resolves.toEqual(E("값을 입력해주세요"));
    await expect(P.addCustomField(PID, " ")).resolves.toEqual(E("태그 이름을 입력해주세요"));
    await expect(P.addManualPrompt(PID, " \n  \n")).resolves.toEqual(E("프롬프트 내용을 입력해주세요"));
    expect(calls).toHaveLength(0);
    const ids = Array.from({ length: 2500 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    serve((r) => ok({ field_id: PID2, count: (r.body as { prompt_ids: string[] }).prompt_ids.length }));
    await expect(P.setPromptCustomFieldValueBulk(PID, [...ids, ids[0]], PID2, " v ")).resolves.toEqual({ ok: true, value: { count: 2500 } });
    expect(calls.map((c) => (c.body as { prompt_ids: string[]; value: string }).prompt_ids.length)).toEqual([1000, 1000, 500]);
    expect((calls[0].body as { value: string }).value).toBe("v");
  });

  it("lifecycle impact: shared_rows -> sharedRows; manual add returns the created count", async () => {
    serve((r) =>
      r.method === "GET"
        ? ok({ prompt_id: PID2, answers: 4, mentions: 9, citations: 2, published: true, shared_rows: 1 })
        : json(201, { data: { created: 3, prompt_ids: [] }, meta: { mode: "crud" } }),
    );
    await expect(P.getPromptLifecycleImpact(PID, PID2)).resolves.toEqual({ ok: true, value: { answers: 4, mentions: 9, citations: 2, sharedRows: 1 } });
    await expect(P.addManualPrompt(PID, "a\nb\n\nc")).resolves.toEqual({ ok: true, value: { count: 3 } });
    expect(calls.at(-1)?.body).toEqual({ text: "a\nb\n\nc" });
  });

  it("xlsx export: bytes -> base64, filename from Content-Disposition, legacy name when absent", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]);
    serve(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": `attachment; filename="prompts-c0000000-20260929.xlsx"; filename*=UTF-8''prompts-c0000000-20260929.xlsx`,
          },
        }),
    );
    await expect(P.exportPromptsXlsx(PID)).resolves.toEqual({ ok: true, value: { base64: "UEsDBA==", filename: "prompts-c0000000-20260929.xlsx" } });
    expect(calls[0].headers.get("accept")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    serve(() => new Response(bytes, { status: 200 }));
    const r = await P.exportTrackedUrlsXlsx(PID);
    expect(r.ok && r.value.filename).toMatch(/^tracked-urls-c0000000-\d{8}\.xlsx$/);
    serve(() => err(404, "not_found"));
    await expect(P.exportPromptsXlsx(PID)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("xlsx import: no file / over 5MB answered locally (not sent); multipart field 'file'; summary mapped", async () => {
    await expect(P.importPromptsXlsx(PID, new FormData())).resolves.toEqual(E("업로드된 파일이 없습니다"));
    const big = new FormData();
    big.set("file", new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.xlsx"));
    await expect(P.importPromptsXlsx(PID, big)).resolves.toEqual(E("파일이 너무 큽니다(최대 5MB)"));
    expect(calls).toHaveLength(0);
    serve(() => ok({ created: 2, updated: 1, skipped: 3, created_tags: 1, warnings: ["행 3: 경고"] }));
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1, 2])], "p.xlsx"));
    await expect(P.importPromptsXlsx(PID, fd)).resolves.toEqual({
      ok: true,
      value: { created: 2, updated: 1, skipped: 3, createdTags: 1, warnings: ["행 3: 경고"] },
    });
    expect(calls[0].body).toBeInstanceOf(FormData);
    expect((calls[0].body as FormData).get("file")).toBeInstanceOf(File);
    serve(() => ok({ created: 1, updated: 0, skipped: 0, warnings: [], change_id: 7 }));
    await expect(P.importTrackedUrlsXlsx(PID, fd)).resolves.toEqual({ ok: true, value: { created: 1, updated: 0, skipped: 0, warnings: [] } });
    for (const [code, msg] of [
      ["too_many_rows", "데이터 행은 5,000개까지 가져올 수 있습니다"],
      ["invalid_xlsx", "엑셀(.xlsx) 파일을 읽을 수 없습니다"],
      ["empty_sheet", "시트가 비어 있습니다"],
      ["missing_header", "헤더에 'id' 또는 'text' 열이 없습니다"],
    ] as const) {
      serve(() => err(422, code));
      await expect(P.importPromptsXlsx(PID, fd)).resolves.toEqual(E(msg));
    }
    serve(() => err(413, "payload_too_large"));
    await expect(P.importTrackedUrlsXlsx(PID, fd)).resolves.toEqual(E("파일이 너무 큽니다(최대 5MB)"));
    serve(() => err(403, "owner_only"));
    await expect(P.importTrackedUrlsXlsx(PID, fd)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("writes are sent once; 401 token_expired refreshes and retries once (server actions may write cookies)", async () => {
    let n = 0;
    serve(() => {
      n += 1;
      return n === 1 ? err(401, "token_expired") : noContent();
    });
    await expect(P.removeMember(PID, UID)).resolves.toEqual({ ok: true, value: undefined });
    expect(n).toBe(2);
    n = 0;
    serve(() => {
      n += 1;
      return err(503, "unavailable");
    });
    await expect(P.removeMember(PID, UID)).resolves.toEqual(E(P.RETRY_LATER));
    expect(n).toBe(1);
  });

  it("delete project: empty confirmation is the mismatch message (not sent); body confirm_name", async () => {
    await expect(P.deleteProject(PID, "  ")).resolves.toEqual(E("입력한 이름이 프로젝트 명과 일치하지 않습니다"));
    expect(calls).toHaveLength(0);
    serve(() => noContent());
    await expect(P.deleteProject(PID, " Kia US ")).resolves.toEqual({ ok: true, value: undefined });
    expect(calls[0].body).toEqual({ confirm_name: "Kia US" });
  });
});
