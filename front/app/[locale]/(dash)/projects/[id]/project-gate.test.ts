import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

// Legacy <-> api parity of the project gates owned by U2:
//   projects/[id]/layout.tsx, analysis/_lib/auth-and-locks.ts, ai-funnel/_lib/auth-and-locks.ts.
// One world (session, project row, membership) drives both sources:
//   legacy = projectRepository / projectMemberRepository mocks (the rollback path);
//   api    = fetch mock answering GET /v1/projects/{id} the way the backend does for that world
//            (core.auth.resolve_project level "active_member": admin or active member -> 200 with
//            my_role, anyone else -> 404; back/app/features/projects/project/core/service.py:110).
// Outcomes (returned value, redirect target or notFound) must be identical.

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined }));
vi.mock("@/components/dash/project-meta-broadcast", () => ({
  ProjectMetaBroadcast: function ProjectMetaBroadcast() {
    return null;
  },
}));

interface World {
  session: Session | null;
  project: null | {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    brand: string | null;
    country: string;
    ga4PropertyId: string | null;
  };
  membership: null | { status: "active" | "pending"; role: "owner" | "viewer" };
}
const world = vi.hoisted(() => ({ current: null as unknown as World, repoCalls: 0, fetchCalls: 0 }));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => world.current.session }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: {
    getById: async () => {
      world.repoCalls += 1;
      return world.current.project;
    },
  },
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: {
    findMembership: async () => {
      world.repoCalls += 1;
      return world.current.membership;
    },
  },
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { default: ProjectLayout } = await import("./layout");
const { loadProjectAnalysisContext } = await import("./analysis/_lib/auth-and-locks");
const { loadProjectFunnelContext } = await import("./ai-funnel/_lib/auth-and-locks");
const { ProjectMetaBroadcast } = await import("@/components/dash/project-meta-broadcast");
const { DEMO_PROJECT_ID } = await import("@/lib/demo");

const PID = "c0000000-0000-4000-8000-000000000003";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";

function session(role: Session["user"]["role"], id = "11111111-0000-4000-8000-000000000002"): Session {
  return { user: { id, email: "u@example.test", role, scope: { all: role === "admin" }, operator: "none", menuGroups: null } };
}
function project(over: Partial<NonNullable<World["project"]>> = {}): NonNullable<World["project"]> {
  return {
    id: PID,
    name: "Kia US",
    description: "d",
    createdAt: new Date("2026-06-01T03:04:05.123Z"),
    brand: "Kia",
    country: "US",
    ga4PropertyId: "123",
    ...over,
  };
}

/** The backend's answer for the current world (resolve_project active_member + DETAIL). */
function backend(url: string): Response {
  const w = world.current;
  const id = decodeURIComponent(url.split("/v1/projects/")[1] ?? "");
  const admin = w.session?.user.role === "admin";
  const active = w.membership?.status === "active";
  if (!w.project || w.project.id !== id || !(admin || active)) {
    return new Response(JSON.stringify({ error: { code: "not_found", message: "m", details: null } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const p = w.project;
  const data = {
    project_id: p.id,
    name: p.name,
    description: p.description,
    created_at: p.createdAt.toISOString().replace("Z", "000+00:00"), // backend microseconds + offset
    updated_at: p.createdAt.toISOString(),
    created_by: "11111111-0000-4000-8000-000000000001",
    brand_code: p.brand,
    country_code: p.country,
    ga4_property_id: p.ga4PropertyId,
    my_role: active ? w.membership!.role : null,
    scope_linked: false,
    scope_project_id: null,
    domain: null,
    ai_engines: null,
    effective_engines: [],
  };
  return new Response(JSON.stringify({ data, meta: { mode: "crud" } }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  world.repoCalls = 0;
  world.fetchCalls = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      world.fetchCalls += 1;
      return backend(String(u));
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e) };
  }
}

async function layoutMeta(locale: string, id: string) {
  const el = (await ProjectLayout({ children: "child", params: Promise.resolve({ locale, id }) })) as {
    props: { children: Array<{ type: unknown; props: { meta: unknown } } | string> };
  };
  const broadcast = el.props.children.find((c) => typeof c === "object" && c.type === ProjectMetaBroadcast) as { props: { meta: unknown } };
  return broadcast.props.meta;
}

const SURFACES = {
  layout: (id: string) => layoutMeta("ko", id),
  analysis: (id: string) => loadProjectAnalysisContext("ko", id),
  funnel: (id: string) => loadProjectFunnelContext("ko", id),
} as const;

async function both(surface: keyof typeof SURFACES, id = PID) {
  vi.stubEnv("HGH_SOURCE_SESSION", "legacy");
  const legacy = await outcome(() => SURFACES[surface](id));
  const legacyFetch = world.fetchCalls;
  vi.stubEnv("HGH_SOURCE_SESSION", "api");
  const repoBefore = world.repoCalls;
  const api = await outcome(() => SURFACES[surface](id));
  return { legacy, api, legacyFetch, apiRepoCalls: world.repoCalls - repoBefore };
}

const WORLDS: Record<string, World> = {
  adminNonMember: { session: session("admin"), project: project(), membership: null },
  activeOwner: { session: session("hq"), project: project(), membership: { status: "active", role: "owner" } },
  activeViewer: { session: session("vendor"), project: project(), membership: { status: "active", role: "viewer" } },
  pendingOwner: { session: session("hq"), project: project(), membership: { status: "pending", role: "owner" } },
  inScopeNonMember: { session: session("hq"), project: project(), membership: null },
  missingProject: { session: session("admin"), project: null, membership: null },
  umbrellaProject: { session: session("region"), project: project({ brand: null, ga4PropertyId: null, description: null }), membership: { status: "active", role: "viewer" } },
  noSession: { session: null, project: project(), membership: null },
};

// The one allowed difference: the project LAYOUT used to check existence only (visibility
// was each leaf page's job); the API gate hides non-members already there. Every leaf under
// it (page, member, setting, prompt, intent/*, analysis/*, ai-funnel/*) notFound()s the same
// viewers, so the rendered result is the same 404 (asserted per leaf gate below).
const LAYOUT_EARLY_404 = new Set(["pendingOwner", "inScopeNonMember"]);
// No session never reaches the project layout: the (dash) layout redirects to /login first
// (app/[locale]/(dash)/layout.test.ts). The layout itself only sees a missing token on api.
const LAYOUT_NO_SESSION = "noSession";

describe.each(Object.keys(WORLDS))("world %s", (name) => {
  beforeEach(() => {
    world.current = WORLDS[name];
  });

  it("analysis gate: legacy == api", async () => {
    const r = await both("analysis");
    expect(r.api).toEqual(r.legacy);
    expect(r.legacyFetch).toBe(0);
    expect(r.apiRepoCalls).toBe(0);
  });

  it("funnel gate: legacy == api (locks, brand, country, GA4 property, conversion editing)", async () => {
    const r = await both("funnel");
    expect(r.api).toEqual(r.legacy);
    expect(r.apiRepoCalls).toBe(0);
  });

  it("project layout: legacy == api (meta broadcast or 404)", async () => {
    if (name === LAYOUT_NO_SESSION) {
      bindHghAuth({ getAccessToken: async () => null });
      const r = await both("layout");
      expect(r.api).toEqual({ thrown: "REDIRECT:/ko/login" });
      return;
    }
    const r = await both("layout");
    if (LAYOUT_EARLY_404.has(name)) {
      expect(r.legacy).toMatchObject({ ok: expect.anything() });
      expect(r.api).toEqual({ thrown: "NOT_FOUND" });
      // ...and the leaf gates 404 the same viewer on both sources:
      expect((await both("analysis")).legacy).toEqual({ thrown: "NOT_FOUND" });
      expect((await both("funnel")).legacy).toEqual({ thrown: "NOT_FOUND" });
      return;
    }
    expect(r.api).toEqual(r.legacy);
  });
});

describe("expected outcomes (not just equal)", () => {
  it("owner: locks + GA4 + editing; viewer: read-only; admin: editing without membership", async () => {
    world.current = WORLDS.activeOwner;
    expect((await both("funnel")).api).toEqual({
      ok: {
        locks: [{ group: "geography", value: "US" }],
        lockedGroups: ["geography"],
        brand: "Kia",
        country: "US",
        ga4PropertyId: "123",
        canEditConversion: true,
      },
    });
    world.current = WORLDS.activeViewer;
    expect((await both("funnel")).api).toMatchObject({ ok: { canEditConversion: false } });
    world.current = WORLDS.adminNonMember;
    expect((await both("funnel")).api).toMatchObject({ ok: { canEditConversion: true } });
  });

  it("layout meta string is byte-identical to the legacy Date#toISOString", async () => {
    world.current = WORLDS.activeOwner;
    expect((await both("layout")).api).toEqual({
      ok: { id: PID, name: "Kia US", description: "d", createdAt: "2026-06-01T03:04:05.123Z" },
    });
  });

  it("non-member / pending / missing -> notFound; no session -> login", async () => {
    for (const w of ["inScopeNonMember", "pendingOwner", "missingProject"]) {
      world.current = WORLDS[w];
      expect((await both("analysis")).api, w).toEqual({ thrown: "NOT_FOUND" });
    }
    world.current = WORLDS.noSession;
    world.fetchCalls = 0;
    expect((await both("analysis")).api).toEqual({ thrown: "REDIRECT:/ko/login" });
    expect(world.fetchCalls).toBe(0);
  });

  it("demo project stays admin-only on both sources (backend has no demo concept, gap G16)", async () => {
    const demo = project({ id: DEMO_PROJECT_ID });
    world.current = { session: session("hq"), project: demo, membership: { status: "active", role: "owner" } };
    const r = await both("layout", DEMO_PROJECT_ID);
    expect(r.legacy).toEqual({ thrown: "NOT_FOUND" });
    expect(r.api).toEqual({ thrown: "NOT_FOUND" });
    world.current = { session: session("admin"), project: demo, membership: null };
    const a = await both("layout", DEMO_PROJECT_ID);
    expect(a.api).toEqual(a.legacy);
    expect(a.api).toMatchObject({ ok: { id: DEMO_PROJECT_ID } });
  });

  it("backend 401 -> login, 403 surface -> no-access, 5xx -> thrown (error boundary)", async () => {
    world.current = WORLDS.activeOwner;
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    const answer = (status: number, code: string) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: { code, message: "m", details: null } }), { status, headers: { "content-type": "application/json" } })),
      );
    answer(401, "token_expired");
    await expect(loadProjectAnalysisContext("en", PID)).rejects.toThrow("REDIRECT:/en/login");
    answer(403, "role_forbidden");
    await expect(loadProjectFunnelContext("en", PID)).rejects.toThrow("REDIRECT:/en/no-access");
    answer(500, "internal");
    await expect(layoutMeta("en", PID)).rejects.toMatchObject({ status: 500, code: "internal" });
  });
});
