import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/filters/options (D4, U4): validation, session, the (dash) place gate, the project
// page gate (demo admin-only, SESSION source), and the D8 data source switch.
// legacy -> the unchanged repository readers with the page arguments; api -> F-1 with the
// period only, converted by lib/hgh/adapters/filters.ts. Scope comes from the session only.

const st = vi.hoisted(() => ({
  session: null as unknown,
  calls: [] as string[],
  engineArgs: [] as unknown[],
  project: null as unknown,
  membership: null as unknown,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/db/repositories/standards", () => ({
  listCatalogTaxonomy: async (id?: string) => {
    st.calls.push(`listCatalogTaxonomy(${id ?? ""})`);
    return [{ brand: "Kia", brandPresence: "branded", listType: "L", depth1: null, depth2: null, depth3: null, depth4: null }];
  },
}));
vi.mock("@/lib/db/repositories/scope-aggregates", () => ({
  listMeasuredRegions: async (scope: unknown, ids: unknown, root: unknown, range: unknown) => {
    st.calls.push(`listMeasuredRegions(${JSON.stringify([scope, ids ?? null, root ?? null, range ?? null])})`);
    return ["US"];
  },
  listMeasuredStandardLanguages: async (scope: unknown, c: unknown, range: unknown) => {
    st.calls.push(`listMeasuredStandardLanguages(${JSON.stringify([scope, c ?? null, range])})`);
    return ["en"];
  },
  listMeasuredScopeMatrix: async (scope: unknown, range: unknown) => {
    st.calls.push(`listMeasuredScopeMatrix(${JSON.stringify([scope, range])})`);
    return [{ brand: "Kia", region: "US", lang: "en" }];
  },
}));
vi.mock("@/lib/db/repositories/website-sites", () => ({
  listWebsiteCountries: async (scope: unknown) => (st.calls.push(`listWebsiteCountries(${JSON.stringify(scope)})`), ["KR"]),
  listMeasuredLanguages: async (scope: unknown) => (st.calls.push(`listMeasuredLanguages(${JSON.stringify(scope)})`), ["ko"]),
  listWebsiteScopeMatrix: async (scope: unknown) => (st.calls.push(`listWebsiteScopeMatrix(${JSON.stringify(scope)})`), []),
}));
vi.mock("@/lib/db/repositories/project-custom-fields", () => ({
  projectCustomFieldRepository: {
    listForProject: async () => [
      { id: "f1", label: "Tag", archived: false },
      { id: "f2", label: "Old", archived: true },
    ],
    listValuesForProject: async () => [
      { fieldId: "f1", value: "b" },
      { fieldId: "f1", value: "a" },
    ],
  },
}));
vi.mock("@/lib/db/repositories/request-cache", () => ({
  cachedProjectById: async () => (st.calls.push("cachedProjectById"), st.project),
  cachedMembership: async () => st.membership,
}));
vi.mock("@/lib/scope/server", () => ({
  fetchProjectMeasuredEngines: async (id: string, f: unknown) => {
    st.calls.push("fetchProjectMeasuredEngines");
    st.engineArgs.push([id, f]);
    return ["chatgpt"];
  },
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { readStandardFilters } = await import("@/components/dash/standard-filters");
const { DEMO_PROJECT_ID } = await import("@/lib/demo");
const { GET } = await import("./route");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const req = (q: string) => new NextRequest(`http://localhost/api/filters/options?${q}`);
const user = (scope: unknown, role = "hq", menuGroups: string[] | null = null) => ({ user: { id: "u1", role, scope, menuGroups } });

const apiSeen: string[] = [];
let optionsStatus = 200;
let projectStatus = 200;

const optionsBody = {
  data: {
    catalog: null,
    custom_fields: null,
    engines: [{ code: "chatgpt", is_default: true }],
    geo_matrix: [
      { brand: "Kia", region: "US", lang: "en" },
      { brand: "Hyundai", region: "KR", lang: "ko" },
      { brand: null, region: "GB", lang: "en" },
    ],
    languages: [],
    regions: [],
    source_categories: [],
  },
  meta: { mode: "cumulative" },
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
  st.engineArgs.length = 0;
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
    vi.stubEnv("HGH_SOURCE_G1", "api");
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
  it.each(denied)("%s -> 403 without any read (legacy source)", async (_n, session, q) => {
    st.session = session;
    const r = await GET(req(q));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: { code: "forbidden" } });
    expect(st.calls).toHaveLength(0);
    expect(apiSeen).toHaveLength(0);
  });
  it.each(denied)("%s -> 403 without any read (api source)", async (_n, session, q) => {
    for (const g of ["G1", "G2", "G3", "G4", "G5", "G6"]) vi.stubEnv(`HGH_SOURCE_${g}`, "api");
    st.session = session;
    expect((await GET(req(q))).status).toBe(403);
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
    vi.stubEnv("HGH_SOURCE_G6", "api");
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

  it("SESSION=api: GET /v1/projects/{id} decides (404 hides), then the data source runs", async () => {
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    const q = `area=analysis&surface=project&project_id=${PID}`;
    projectStatus = 404;
    expect((await GET(req(q))).status).toBe(404);
    expect(apiSeen.map((u) => new URL(u).pathname)).toEqual([`/v1/projects/${PID}`]);
    expect(st.calls).toHaveLength(0);
    projectStatus = 200;
    apiSeen.length = 0;
    expect((await GET(req(q))).status).toBe(200);
    expect(apiSeen.map((u) => new URL(u).pathname)).toEqual([`/v1/projects/${PID}`]);
    expect(st.calls).not.toContain("cachedProjectById"); // the legacy gate is not used
  });
});

describe("legacy source (default): the pages' readers, unchanged arguments", () => {
  it("global = dashboard composition (brand lock narrows lists; matrix gets the account scope)", async () => {
    const r = await GET(req("area=dashboard&surface=global&time=2026-09-01..2026-09-14"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(body.options).toEqual({
      catalogRows: [{ brand: "Kia", brandPresence: "branded", listType: "L", depth1: null, depth2: null, depth3: null, depth4: null }],
      geographyOptions: ["US"],
      languageOptions: ["en"],
      optionMatrix: [{ brand: "Kia", region: "US", lang: "en" }],
    });
    const range = { dateFrom: "2026-09-01", dateTo: "2026-09-14" };
    const optionScope = { all: false, brands: ["Kia"], countries: ["US"] };
    expect(st.calls).toEqual([
      "listCatalogTaxonomy()",
      `listMeasuredRegions(${JSON.stringify([optionScope, null, true, range])})`,
      `listMeasuredStandardLanguages(${JSON.stringify([optionScope, null, range])})`,
      `listMeasuredScopeMatrix(${JSON.stringify([{ all: false, brands: ["Kia"], countries: ["US"] }, range])})`,
    ]);
    expect(apiSeen).toHaveLength(0);
  });

  it("website = website composition", async () => {
    await GET(req("area=dashboard&surface=website"));
    expect(st.calls.map((c) => c.split("(")[0])).toEqual([
      "listCatalogTaxonomy",
      "listWebsiteCountries",
      "listMeasuredLanguages",
      "listWebsiteScopeMatrix",
    ]);
  });

  it("project: catalog, regions, engines, custom fields", async () => {
    st.session = user({ all: true }, "admin");
    const body = await (await GET(req(`area=analysis&surface=project&project_id=${PID}`))).json();
    expect(body.options).toEqual({
      catalogRows: expect.any(Array),
      geographyOptions: ["US"],
      engineOptions: ["chatgpt"],
      dynamicAxes: [{ id: "f1", label: "Tag", options: ["a", "b"] }],
    });
    expect(st.calls).toContain(`listCatalogTaxonomy(${PID})`);
  });

  it("F8: project engine list gets the page's filter object (URL time and engine, cumulative)", async () => {
    const url = { time: "2026-09-01..2026-09-14", engine: "gemini" };
    await GET(req(`area=analysis&surface=project&project_id=${PID}&time=${url.time}&engine=${url.engine}&geography=US`));
    // analysis/mention/page.tsx: { ...readStandardFilters(URL), cumulative: true } (custom fields
    // are not read by the engine reader: snapshotAnswerIds uses dateFrom/dateTo and engine only)
    expect(st.engineArgs).toEqual([[PID, { ...readStandardFilters(url), cumulative: true }]]);
  });
});

describe("api source: F-1 with the period only", () => {
  it("HGH_SOURCE_G1=api: one backend call, lists narrowed by the session brand lock", async () => {
    vi.stubEnv("HGH_SOURCE_G1", "api");
    const r = await GET(req("area=dashboard&surface=global&time=2026-09-01..2026-09-14&brand=Hyundai"));
    const body = await r.json();
    expect(apiSeen).toHaveLength(1);
    expect(new URL(apiSeen[0]).search).toBe("?from=2026-09-01&surface=global&to=2026-09-14");
    // brand account Kia: the URL brand is ignored (lock), Kia + common rows
    expect(body.options.geographyOptions).toEqual(["GB", "US"]);
    expect(body.options.languageOptions).toEqual(["en"]);
    expect(body.options.optionMatrix).toHaveLength(3);
    expect(st.calls).toHaveLength(0);
  });

  it("group flags follow sourceGroupFor: website -> G3, project -> G6", async () => {
    vi.stubEnv("HGH_SOURCE_G1", "api");
    await GET(req("area=dashboard&surface=website"));
    expect(apiSeen).toHaveLength(0); // G3 still legacy
    vi.stubEnv("HGH_SOURCE_G6", "api");
    await GET(req(`area=analysis&surface=project&project_id=${PID}`));
    expect(apiSeen).toHaveLength(1);
    expect(new URL(apiSeen[0]).searchParams.get("project_id")).toBe(PID);
  });

  it("backend error keeps its status (404 -> 404 {error:{code}})", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    optionsStatus = 404;
    const r = await GET(req(`area=analysis&surface=project&project_id=${PID}`));
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
  });
});
