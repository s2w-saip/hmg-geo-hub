import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/filters/options (D4, U4): validation, session, the (dash) place gate, the project
// page gate (demo admin-only, SESSION source), then a thin proxy to the screen
// shared/panel-options (back/bff/screens/shared.py) with the URL values that shape the options.
// Scope comes from the session on the API side.

const st = vi.hoisted(() => ({
  session: null as unknown,
  calls: [] as string[],
  project: null as unknown,
  membership: null as unknown,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/db/repositories/request-cache", () => ({
  cachedProjectById: async () => (st.calls.push("cachedProjectById"), st.project),
  cachedMembership: async () => st.membership,
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { DEMO_PROJECT_ID } = await import("@/lib/demo");
const { GET } = await import("./route");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const req = (q: string) => new NextRequest(`http://localhost/api/filters/options?${q}`);
const user = (scope: unknown, role = "hq", menuGroups: string[] | null = null) => ({ user: { id: "u1", role, scope, menuGroups } });

const apiSeen: string[] = [];
let optionsStatus = 200;
let projectStatus = 200;

/** The screen's answer: the panel option props, computed on the API side. */
const optionsBody = {
  geographyOptions: ["GB", "US"],
  languageOptions: ["en"],
  optionMatrix: [{ brand: "Kia", region: "US", lang: "en" }],
};
const projectBody = {
  data: {
    project_id: PID,
    name: "P",
    country_code: "KR",
    created_at: "2026-09-01T00:00:00Z",
    created_by: PID,
    effective_engines: [],
    scope_linked: true,
  },
  meta: { mode: "crud" },
};

beforeEach(() => {
  st.calls.length = 0;
  apiSeen.length = 0;
  optionsStatus = 200;
  projectStatus = 200;
  st.session = user({ all: false, brands: ["Kia"], countries: ["US"] });
  st.project = { id: PID };
  st.membership = { status: "active" };
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      apiSeen.push(String(u));
      const path = new URL(String(u)).pathname;
      const status = path.startsWith("/v1/projects/") ? projectStatus : optionsStatus;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { code: "not_found", message: "m", details: null } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(path.startsWith("/v1/projects/") ? projectBody : optionsBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("validation (422) and session (401)", () => {
  it.each([
    "surface=global",
    "area=dashboard",
    "area=admin&surface=global",
    "area=dashboard&surface=mars",
    "area=analysis&surface=project",
    "area=analysis&surface=project&project_id=../x",
    // F3: every non-global surface checks project_id
    "area=dashboard&surface=website&project_id=abc",
    "area=dashboard&surface=website&project_id=",
  ])("422 for %s", async (q) => {
    const r = await GET(req(q));
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: { code: "invalid_value" } });
    expect(apiSeen).toHaveLength(0);
    expect(st.calls).toHaveLength(0);
  });

  it("global ignores project_id (never validated, never sent)", async () => {
    expect((await GET(req("area=dashboard&surface=global&project_id=abc"))).status).toBe(200);
    expect(new URL(apiSeen[0]).searchParams.get("project_id")).toBeNull();
  });

  it("401 without a session", async () => {
    st.session = null;
    const r = await GET(req("area=dashboard&surface=global"));
    expect(r.status).toBe(401);
    expect(apiSeen).toHaveLength(0);
    expect(st.calls).toHaveLength(0);
  });
});

describe("F1: the (dash) place gate runs first on both sources (canAccessRoute with menuGroups)", () => {
  const denied: [string, unknown, string][] = [
    ["vendor on global", user({ all: false, brands: ["Kia"] }, "vendor"), "area=dashboard&surface=global"],
    ["website role on global", user({ all: false, brands: ["Kia"] }, "website"), "area=analysis&surface=global"],
    ["hq with menuGroups [project] on website", user({ all: true }, "hq", ["project"]), "area=dashboard&surface=website"],
    ["website role on project", user({ all: false, brands: ["Kia"] }, "website"), `area=analysis&surface=project&project_id=${PID}`],
    ["hq with menuGroups [website] on global", user({ all: true }, "hq", ["website"]), "area=funnel&surface=global"],
  ];
  it.each(denied)("%s -> 403 without any read", async (_n, session, q) => {
    st.session = session;
    const r = await GET(req(q));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: { code: "forbidden" } });
    expect(st.calls).toHaveLength(0);
    expect(apiSeen).toHaveLength(0);
  });
  it("allowed: website role on website, vendor on project, hq with [website] on website", async () => {
    st.session = user({ all: false, brands: ["Kia"] }, "website");
    expect((await GET(req("area=dashboard&surface=website"))).status).toBe(200);
    st.session = user({ all: false, brands: ["Kia"] }, "vendor");
    expect((await GET(req(`area=analysis&surface=project&project_id=${PID}`))).status).toBe(200);
    st.session = user({ all: true }, "hq", ["website"]);
    expect((await GET(req("area=prompts&surface=website"))).status).toBe(200);
  });
});

describe("F2: project page gate (demo admin-only, SESSION source)", () => {
  it("demo project: non-admin 404 on both sources (no read), admin allowed", async () => {
    const q = `area=analysis&surface=project&project_id=${DEMO_PROJECT_ID}`;
    expect((await GET(req(q))).status).toBe(404);
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    expect((await GET(req(q))).status).toBe(404);
    expect(apiSeen).toHaveLength(0);
    expect(st.calls).toHaveLength(0);
    st.session = user({ all: true }, "admin");
    expect((await GET(req(q))).status).toBe(200);
  });

  it("legacy SESSION: missing project or non-active member -> 404; admin passes", async () => {
    const q = `area=analysis&surface=project&project_id=${PID}`;
    st.membership = null;
    expect((await GET(req(q))).status).toBe(404);
    st.membership = { status: "pending" };
    expect((await GET(req(q))).status).toBe(404);
    st.project = null;
    st.session = user({ all: true }, "admin");
    expect((await GET(req(q))).status).toBe(404);
    st.project = { id: PID };
    expect((await GET(req(q))).status).toBe(200);
  });

  it("SESSION=api: GET /v1/projects/{id} decides (404 hides), then the screen runs", async () => {
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    const q = `area=analysis&surface=project&project_id=${PID}`;
    projectStatus = 404;
    expect((await GET(req(q))).status).toBe(404);
    expect(apiSeen.map((u) => new URL(u).pathname)).toEqual([`/v1/projects/${PID}`]);
    // the gate runs alone in the route: the light read (view=gate, same decision and 404, no detail summary)
    expect(apiSeen.map((u) => new URL(u).searchParams.getAll("view"))).toEqual([["gate"]]);
    expect(st.calls).toHaveLength(0);
    projectStatus = 200;
    apiSeen.length = 0;
    expect((await GET(req(q))).status).toBe(200);
    expect(apiSeen.map((u) => new URL(u).pathname)).toEqual([`/v1/projects/${PID}`, "/v1/screens/shared/panel-options"]);
    expect(st.calls).not.toContain("cachedProjectById"); // the legacy gate is not used
  });
});

describe("proxy: screen shared/panel-options", () => {
  it("one screen read with the values that shape the options (time, brand); the answer as is, no-store", async () => {
    const r = await GET(req("area=dashboard&surface=global&time=2026-09-01..2026-09-14&brand=Hyundai&engine=gemini&geography=US"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ options: optionsBody });
    expect(apiSeen).toHaveLength(1);
    const u = new URL(apiSeen[0]);
    expect(u.pathname).toBe("/v1/screens/shared/panel-options");
    // engine and geography do not shape global options: not passed on
    expect(u.search).toBe("?brand=Hyundai&surface=global&time=2026-09-01..2026-09-14");
    expect(st.calls).toHaveLength(0);
  });

  it("website: surface and project_id (site) passed on", async () => {
    await GET(req(`area=dashboard&surface=website&project_id=${PID}`));
    const u = new URL(apiSeen[0]);
    expect([u.pathname, u.searchParams.get("surface"), u.searchParams.get("project_id")]).toEqual([
      "/v1/screens/shared/panel-options",
      "website",
      PID,
    ]);
  });

  it("project: the engine choice shapes the options too", async () => {
    st.session = user({ all: true }, "admin");
    await GET(req(`area=analysis&surface=project&project_id=${PID}&time=2026-09-01..2026-09-14&engine=gemini&geography=US`));
    const u = new URL(apiSeen[0]);
    expect(u.search).toBe(`?engine=gemini&project_id=${PID}&surface=project&time=2026-09-01..2026-09-14`);
  });

  it("screen error keeps its status (404 -> 404 {error:{code}})", async () => {
    optionsStatus = 404;
    const r = await GET(req(`area=analysis&surface=project&project_id=${PID}`));
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
  });
});
