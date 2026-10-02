import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileRow } from "@/lib/db/schema";

// (dash) layout, legacy <-> api, through the REAL session facade: the same account is served
// by the legacy source (Supabase claims + profiles row) and by the api source (GET /v1/auth/me
// answered the way the backend answers for that account), and the layout must render the same
// GNB rail tabs, SNB routes, SNB project header and route-guard redirects. route-policy.ts is
// untouched; only its inputs (role, menuGroups) come from the new session shape.
// Components are stubbed: the test reads the props the layout hands to GnbRail and Sidebar.

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
const req = vi.hoisted(() => ({ pathname: "/ko/dashboard" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-pathname": req.pathname }),
  cookies: async () => ({ get: () => undefined, delete: () => undefined }),
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/perf/nocache-probe", () => ({ perfNoCacheActive: async () => false }));
vi.mock("sonner", () => ({ Toaster: () => null }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null }));
vi.mock("@/components/locale-switcher", () => ({ LocaleSwitcher: () => null }));
vi.mock("@/components/wordmark", () => ({ Wordmark: () => null }));
vi.mock("@/components/dash/beta-notice", () => ({ BetaNoticeBanner: () => null, BetaNoticeDialog: () => null }));
vi.mock("@/components/dash/sidebar", () => ({
  Sidebar: function Sidebar() {
    return null;
  },
  SidebarMobileTrigger: function SidebarMobileTrigger() {
    return null;
  },
}));
vi.mock("@/components/dash/gnb-rail", () => ({
  GnbRail: function GnbRail() {
    return null;
  },
}));

interface World {
  profile: ProfileRow | null;
  project: null | { id: string; name: string; description: string | null; createdAt: Date };
  membership: null | { status: "active" | "pending"; role: "owner" | "viewer" };
  projectStatus?: number; // force a backend failure on GET /v1/projects/{id}
}
const w = vi.hoisted(() => ({ cur: null as unknown as World, fetches: [] as string[] }));

vi.mock("@/utils/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getClaims: async () => ({ data: w.cur.profile ? { claims: { sub: w.cur.profile.id, email: w.cur.profile.email } } : null, error: null }),
      getSession: async () => ({ data: { session: w.cur.profile ? { access_token: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" } : null }, error: null }),
    },
  }),
}));
vi.mock("@/lib/db/repositories/profiles", () => ({ profileRepository: { getByUserId: async () => w.cur.profile } }));
vi.mock("@/lib/db/repositories/request-cache", () => ({
  cachedMembership: async () => w.cur.membership,
  cachedProjectById: async () => w.cur.project,
}));

const { default: DashLayout } = await import("./layout");
const { GnbRail } = await import("@/components/dash/gnb-rail");
const { Sidebar, SidebarMobileTrigger } = await import("@/components/dash/sidebar");

const PID = "c0000000-0000-4000-8000-000000000003";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Backend answers for the current world: /v1/auth/me and GET /v1/projects/{id} (active_member). */
function backend(url: string): Response {
  const path = new URL(url).pathname;
  const p = w.cur.profile;
  if (path === "/v1/auth/me") {
    if (!p) return json(401, { error: { code: "no_account", message: "m", details: null } });
    const all = p.scopeAll || p.role === "admin";
    const list = (xs: string[] | null) => (all || !xs?.length ? null : xs);
    return json(200, {
      data: {
        user_id: p.id,
        email: p.email,
        display_name: null,
        role: p.role,
        operator: p.role === "vendor" ? "none" : p.operator,
        scope: { all, brands: list(p.brands), regions: list(p.regions), countries: list(p.countries) },
        menu_groups: p.menuGroups,
        is_qa_reviewer: false,
      },
      meta: { mode: "session" },
    });
  }
  if (w.cur.projectStatus) return json(w.cur.projectStatus, { error: { code: "upstream", message: "m", details: null } });
  const admin = p?.role === "admin";
  const active = w.cur.membership?.status === "active";
  if (!w.cur.project || !path.endsWith(w.cur.project.id) || !(admin || active)) {
    return json(404, { error: { code: "not_found", message: "m", details: null } });
  }
  const pr = w.cur.project;
  return json(200, {
    data: {
      project_id: pr.id,
      name: pr.name,
      description: pr.description,
      created_at: pr.createdAt.toISOString(),
      updated_at: pr.createdAt.toISOString(),
      created_by: p!.id,
      country_code: "US",
      brand_code: "Kia",
      my_role: active ? w.cur.membership!.role : null,
      scope_linked: false,
      effective_engines: [],
    },
    meta: { mode: "crud" },
  });
}

let seq = 0;
function profile(p: Partial<ProfileRow> & Pick<ProfileRow, "role">): ProfileRow {
  seq += 1;
  return {
    id: `11111111-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    email: `u${seq}@example.test`,
    scopeAll: false,
    brands: ["Kia"],
    regions: null,
    countries: null,
    operator: "none",
    menuGroups: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...p,
  };
}

interface Found {
  type: unknown;
  props: Record<string, unknown>;
}
function find(node: unknown, type: unknown): Found | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = find(n, type);
      if (f) return f;
    }
    return null;
  }
  const el = node as Found;
  if (el.type === type) return el;
  return find(el.props?.children, type);
}

async function render(source: "legacy" | "api"): Promise<unknown> {
  vi.stubEnv("HGH_SOURCE_SESSION", source);
  try {
    const tree = await DashLayout({ children: null, params: Promise.resolve({ locale: "ko" }) });
    const rail = find(tree, GnbRail)!.props;
    const snb = find(tree, Sidebar)!.props;
    const mobile = find(tree, SidebarMobileTrigger)!.props;
    expect(mobile.projectMeta).toEqual(snb.projectMeta);
    return {
      tabs: rail.tabs,
      user: rail.user,
      routes: (snb.routes as { path: string }[]).map((r) => r.path),
      projectMeta: snb.projectMeta,
    };
  } catch (e) {
    return { thrown: (e as Error).message };
  }
}

beforeEach(() => {
  w.fetches = [];
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      w.fetches.push(new URL(String(u)).pathname);
      return backend(String(u));
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ACCOUNTS: Record<string, ProfileRow> = {
  admin: profile({ role: "admin", scopeAll: true, brands: null, operator: "global" }),
  hqMenus: profile({ role: "hq", menuGroups: ["standard", "project"], operator: "assigned" }),
  hqEmptyMenus: profile({ role: "hq", menuGroups: [] }),
  hqBogusMenu: profile({ role: "hq", menuGroups: ["project", "bogus"] as never }),
  region: profile({ role: "region", regions: ["kia-western-europe"] }),
  country: profile({ role: "country", countries: ["US"] }),
  vendor: profile({ role: "vendor", brands: null, menuGroups: ["project"] }),
  website: profile({ role: "website", menuGroups: ["website"] }),
};
const PATHS = ["/ko/dashboard", "/ko/standard/answer-analysis/mention", "/ko/website", "/ko/projects", "/ko/admin", "/ko/no-access", "/ko/nowhere"];

describe("GNB rail, SNB routes and route guard: same for the same account on both sources", () => {
  for (const [name, account] of Object.entries(ACCOUNTS)) {
    it.each(PATHS)(`${name} %s`, async (pathname) => {
      w.cur = { profile: account, project: null, membership: null };
      req.pathname = pathname;
      const legacy = (await render("legacy")) as { thrown?: string; tabs?: unknown[] };
      const api = await render("api");
      expect(api).toEqual(legacy);
      // Guard against "equal because both broke": a throw may only be the guard's redirect.
      if (legacy.thrown) expect(legacy.thrown).toMatch(/^REDIRECT:\/ko\/no-access$/);
      else expect(Array.isArray(legacy.tabs)).toBe(true);
    });
  }

  it("the api render really used /v1/auth/me (and legacy did not)", async () => {
    w.cur = { profile: ACCOUNTS.hqMenus, project: null, membership: null };
    req.pathname = "/ko/dashboard";
    await render("legacy");
    expect(w.fetches).toEqual([]);
    await render("api");
    expect(w.fetches).toEqual(["/v1/auth/me"]);
  });

  it("sanity: an hq account narrowed to [standard, project] gets exactly those rail groups", async () => {
    w.cur = { profile: ACCOUNTS.hqMenus, project: null, membership: null };
    req.pathname = "/ko/dashboard";
    const r = (await render("api")) as { tabs: { group: string }[] };
    expect(r.tabs.map((t) => t.group)).toEqual(["standard", "project"]);
  });

  it("no session: both sources redirect to /login", async () => {
    w.cur = { profile: null, project: null, membership: null };
    expect(await render("legacy")).toEqual({ thrown: "REDIRECT:/ko/login" });
    expect(await render("api")).toEqual({ thrown: "REDIRECT:/ko/login" });
  });
});

describe("SNB project header (admin or active member only)", () => {
  const project = { id: PID, name: "Kia US", description: "d", createdAt: new Date("2026-06-01T03:04:05.123Z") };
  const CASES: Record<string, World> = {
    adminNonMember: { profile: ACCOUNTS.admin, project, membership: null },
    activeViewer: { profile: ACCOUNTS.vendor, project, membership: { status: "active", role: "viewer" } },
    activeOwner: { profile: ACCOUNTS.hqMenus, project, membership: { status: "active", role: "owner" } },
    pendingOwner: { profile: ACCOUNTS.hqMenus, project, membership: { status: "pending", role: "owner" } },
    inScopeNonMember: { profile: ACCOUNTS.hqMenus, project, membership: null },
    missing: { profile: ACCOUNTS.admin, project: null, membership: null },
  };

  it.each(Object.keys(CASES))("%s: same header on both sources", async (name) => {
    w.cur = CASES[name];
    req.pathname = `/ko/projects/${PID}/analysis/mention`;
    const legacy = (await render("legacy")) as { projectMeta: unknown };
    const api = (await render("api")) as { projectMeta: unknown };
    expect(api).toEqual(legacy);
    const visible = ["adminNonMember", "activeViewer", "activeOwner"].includes(name);
    expect(api.projectMeta).toEqual(visible ? { id: PID, name: "Kia US", description: "d", createdAt: "2026-06-01T03:04:05.123Z" } : null);
  });

  it("static sibling segments (/projects/new, /projects/by-scope/x) are not project ids: no lookup at all", async () => {
    w.cur = CASES.adminNonMember;
    for (const p of ["/ko/projects/new", "/ko/projects/by-scope/x"]) {
      req.pathname = p;
      w.fetches = [];
      expect(await render("api")).toMatchObject({ projectMeta: null });
      expect(w.fetches).toEqual(["/v1/auth/me"]);
    }
  });

  it("backend failure on the project call: header omitted, layout still renders (the project layout raises it in the error boundary)", async () => {
    w.cur = { ...CASES.activeOwner, projectStatus: 502 };
    req.pathname = `/ko/projects/${PID}`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await render("api")).toMatchObject({ projectMeta: null });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
