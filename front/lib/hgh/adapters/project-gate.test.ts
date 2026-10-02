import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// Unit tests of the one project gate (GET /v1/projects/{id}). API mocked at fetch, token
// injected through the lib/hgh/auth test seam. The legacy <-> api parity of the pages that
// use it is in app/[locale]/(dash)/projects/[id]/project-gate.test.ts and
// app/[locale]/(dash)/layout.test.ts.

// react-server build so the in-request GET dedupe (React cache) really dedupes.
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
const gate = await import("./project-gate");
const { canEditConversion, fetchProjectGate, isProjectId, projectLocks, projectMetaForSnb, requireProjectPage, toGateProject, toSnbMeta } = gate;

type ProjectDetail = components["schemas"]["ProjectDetail"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PID = "c0000000-0000-4000-8000-000000000003";

const detail = (d: Partial<ProjectDetail> = {}): ProjectDetail => ({
  project_id: PID,
  name: "Kia US",
  description: "desc",
  created_at: "2026-06-01T03:04:05.123456+00:00",
  updated_at: "2026-06-02T00:00:00+00:00",
  created_by: "11111111-0000-4000-8000-000000000001",
  brand_code: "Kia",
  country_code: "US",
  ga4_property_id: "123456",
  my_role: "owner",
  scope_linked: true,
  scope_project_id: null,
  domain: null,
  ai_engines: null,
  effective_engines: ["chatgpt"],
  ...d,
});

const calls: string[] = [];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (d: ProjectDetail = detail()) => () => json(200, { data: d, meta: { mode: "crud" } });
const err = (status: number, code: string) => () => json(status, { error: { code, message: "m", details: null } });
function respond(r: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      calls.push(String(u));
      return r();
    }),
  );
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const c of warn.mock.calls) expect(c.join(" ")).not.toContain(TOKEN);
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mapping (ProjectDetail -> GateProject)", () => {
  it("every field, created_at re-serialized like Date#toISOString (the legacy string)", () => {
    expect(toGateProject(detail())).toEqual({
      id: PID,
      name: "Kia US",
      description: "desc",
      createdAt: "2026-06-01T03:04:05.123Z",
      brand: "Kia",
      country: "US",
      ga4PropertyId: "123456",
      myRole: "owner",
    });
  });

  it("optional fields -> null (umbrella project, no description, admin without membership)", () => {
    const p = toGateProject(detail({ brand_code: undefined, description: undefined, ga4_property_id: null, my_role: null }));
    expect(p).toMatchObject({ brand: null, description: null, ga4PropertyId: null, myRole: null });
  });

  it("SNB meta, locks, conversion editing", () => {
    const p = toGateProject(detail());
    expect(toSnbMeta(p)).toEqual({ id: PID, name: "Kia US", description: "desc", createdAt: "2026-06-01T03:04:05.123Z" });
    expect(projectLocks(p)).toEqual({ locks: [{ group: "geography", value: "US" }], lockedGroups: ["geography"] });
    expect(canEditConversion(p, false)).toBe(true);
    expect(canEditConversion({ ...p, myRole: "viewer" }, false)).toBe(false);
    expect(canEditConversion({ ...p, myRole: null }, true)).toBe(true);
    expect(canEditConversion({ ...p, myRole: null }, false)).toBe(false);
  });

  it("only uuids are project ids", () => {
    expect(isProjectId(PID)).toBe(true);
    for (const x of ["new", "by-scope", "..", "", `${PID}x`]) expect(isProjectId(x)).toBe(false);
  });
});

describe("fetchProjectGate", () => {
  it("200 -> project, one GET /v1/projects/{id} with the session Bearer", async () => {
    respond(ok());
    await expect(fetchProjectGate(PID)).resolves.toMatchObject({ id: PID, country: "US" });
    expect(calls).toEqual([`https://api.hgh.test/v1/projects/${PID}`]);
  });

  it("404 (missing, out of scope, non-member, pending) -> null", async () => {
    respond(err(404, "not_found"));
    await expect(fetchProjectGate(PID)).resolves.toBeNull();
  });

  it("non-uuid id -> null without calling the backend", async () => {
    respond(ok());
    await expect(fetchProjectGate("new")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("other statuses are thrown", async () => {
    respond(err(403, "role_forbidden"));
    await expect(fetchProjectGate(PID)).rejects.toMatchObject({ status: 403, code: "role_forbidden" });
    respond(err(500, "internal"));
    await expect(fetchProjectGate(PID)).rejects.toMatchObject({ status: 500 });
  });

  it("layout + project layout + leaf gate in one request share one backend call", async () => {
    respond(ok());
    await withRequestScope(async () => {
      await Promise.all([fetchProjectGate(PID), projectMetaForSnb(PID, "ko"), requireProjectPage("ko", PID)]);
    });
    expect(calls).toHaveLength(1);
  });
});

describe("requireProjectPage: same outcome as the legacy page gates", () => {
  it("visible -> the project", async () => {
    respond(ok());
    await expect(requireProjectPage("ko", PID)).resolves.toMatchObject({ id: PID });
  });

  it("404 -> notFound()", async () => {
    respond(err(404, "not_found"));
    await expect(requireProjectPage("ko", PID)).rejects.toThrow("NOT_FOUND");
  });

  it("non-uuid -> notFound() (legacy crashed on the uuid cast; the (dash) layout already treated it as no project)", async () => {
    respond(ok());
    await expect(requireProjectPage("en", "not-a-uuid")).rejects.toThrow("NOT_FOUND");
    expect(calls).toHaveLength(0);
  });

  it("no token -> /{locale}/login (nothing sent)", async () => {
    bindHghAuth({ getAccessToken: async () => null });
    respond(ok());
    await expect(requireProjectPage("en", PID)).rejects.toThrow("REDIRECT:/en/login");
    expect(calls).toHaveLength(0);
  });

  it.each(["unauthenticated", "token_expired", "no_account"])("401 %s -> /{locale}/login", async (code) => {
    respond(err(401, code));
    await expect(requireProjectPage("ko", PID)).rejects.toThrow("REDIRECT:/ko/login");
  });

  it("403 role_forbidden / menu_forbidden -> /no-access (route-policy mismatch)", async () => {
    respond(err(403, "menu_forbidden"));
    await expect(requireProjectPage("ko", PID)).rejects.toThrow("REDIRECT:/ko/no-access");
  });

  it("403 other -> notFound() (project pages never confirm existence)", async () => {
    respond(err(403, "owner_only"));
    await expect(requireProjectPage("ko", PID)).rejects.toThrow("NOT_FOUND");
  });

  it("5xx -> thrown to the error boundary", async () => {
    respond(err(503, "unavailable"));
    await expect(requireProjectPage("ko", PID)).rejects.toMatchObject({ status: 503 });
  });
});

describe("projectMetaForSnb: the (dash) layout header", () => {
  it("visible -> meta; hidden or non-uuid -> null", async () => {
    respond(ok());
    await expect(projectMetaForSnb(PID, "ko")).resolves.toMatchObject({ id: PID, name: "Kia US" });
    respond(err(404, "not_found"));
    await expect(projectMetaForSnb(PID, "ko")).resolves.toBeNull();
    await expect(projectMetaForSnb("by-scope", "ko")).resolves.toBeNull();
  });

  it("401 -> login, 403 surface -> no-access (like a page)", async () => {
    respond(err(401, "token_expired"));
    await expect(projectMetaForSnb(PID, "ko")).rejects.toThrow("REDIRECT:/ko/login");
    respond(err(403, "role_forbidden"));
    await expect(projectMetaForSnb(PID, "ko")).rejects.toThrow("REDIRECT:/ko/no-access");
  });

  it.each(["owner_only", "operator_forbidden", "admin_only", "forbidden"])(
    "403 %s -> notFound(), same as requireProjectPage (never /no-access: that would confirm the id exists)",
    async (code) => {
      respond(err(403, code));
      await expect(projectMetaForSnb(PID, "ko")).rejects.toThrow("NOT_FOUND");
      await expect(requireProjectPage("ko", PID)).rejects.toThrow("NOT_FOUND");
    },
  );

  it("transient failure -> no header + one code-only log line (the project layout raises it inside the error boundary)", async () => {
    respond(err(502, "upstream"));
    await expect(projectMetaForSnb(PID, "ko")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[hgh\] 502 upstream GET \/v1\/projects\//);
  });
});
