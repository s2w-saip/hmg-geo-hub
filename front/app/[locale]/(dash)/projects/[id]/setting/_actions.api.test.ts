import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// API-source routing of the setting actions (HGH_SOURCE_G6=api, unit U9): backend settings / roster
// API called with the natural-key ids, legacy repositories, Scope sync and session gate untouched,
// revalidatePath / redirect exactly as legacy (success only). Code -> message mapping:
// lib/hgh/adapters/projects.test.ts; outcome parity: lib/hgh/adapters/projects.parity.test.ts.

const h = vi.hoisted(() => ({ revalidate: [] as string[] }));
const untouched = () =>
  new Proxy(
    {},
    {
      // "then" and symbols stay undefined so a module-level proxy is not taken for a promise.
      get: (_t, name) =>
        name === "then" || typeof name === "symbol"
          ? undefined
          : () => {
              throw new Error(`legacy dependency touched: ${String(name)}`);
            },
    },
  );
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidate.push(p) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: () => {
    throw new Error("legacy session gate touched");
  },
}));
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: untouched() }));
vi.mock("@/lib/db/repositories/project-members", () => ({ projectMemberRepository: untouched() }));
vi.mock("@/lib/db/repositories/member-audit-logs", () => ({ memberAuditLogRepository: untouched() }));
vi.mock("@/lib/db/repositories/tracked-entities", () => ({
  trackedBrandRepository: untouched(),
  trackedCompetitorRepository: untouched(),
  trackedVehicleRepository: untouched(),
  syncTrackedBrandCatalog: () => {
    throw new Error("legacy catalog sync touched");
  },
  flagPromptsForReanalysis: () => {
    throw new Error("legacy reanalysis flag touched");
  },
}));
vi.mock("@/lib/db/repositories/project-tracked-urls", () => untouched());
vi.mock("@/lib/db/repositories/project-owned-bases", () => untouched());
vi.mock("@/lib/scope/project-sync", () => untouched());

const { bindHghAuth } = await import("@/lib/hgh/auth");
const A = await import("./_actions");

const PID = "c0000000-0000-4000-8000-000000000003";
const UID = "a0000000-0000-4000-8000-000000000001";
const calls: { method: string; url: string; body: unknown }[] = [];
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const data = (d: unknown, status = 200) => json(status, { data: d, meta: { mode: "crud" } });
let answer: (method: string, path: string) => Response;
const key = (c: { method: string; url: string }) => `${c.method} ${c.url}`;

beforeEach(() => {
  calls.length = 0;
  h.revalidate.length = 0;
  vi.stubEnv("HGH_SOURCE_G6", "api");
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  bindHghAuth({ getAccessToken: async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" });
  answer = () => new Response(null, { status: 204 });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = String(init.method ?? "GET");
    calls.push({ method, url: `${u.pathname}${u.search}`, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    return answer(method, u.pathname);
  });
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const P = (s = "") => `/v1/projects/${PID}${s}`;
const SETTING = `/projects/${PID}/setting`;

describe("setting actions on the api source", () => {
  it("updateProject: PATCH + PUT aliases; revalidates project, setting and list", async () => {
    answer = (m) => (m === "PATCH" ? data({ project_id: PID }) : data({ tracked_brands: [] }));
    await expect(A.updateProject(PID, { name: "N", brandAliases: ["a"], brandAliasesBrand: "Kia" })).resolves.toEqual({ ok: true, value: { reprocessable: 0 } });
    expect(calls.map(key)).toEqual([`PATCH ${P()}`, `PUT ${P("/settings/brand-aliases")}`]);
    expect(h.revalidate).toEqual([`/projects/${PID}`, SETTING, "/projects"]);
  });

  it("updateProjectEngines: PUT engines, queued result, setting revalidated", async () => {
    answer = () => data({ engines: ["chatgpt"], changed: false, propagation: "none" });
    await expect(A.updateProjectEngines(PID, ["chatgpt"])).resolves.toEqual({ ok: true, value: { engines: ["chatgpt"], changed: false, pushed: true, queued: true } });
    expect(calls.map(key)).toEqual([`PUT ${P("/settings/engines")}`]);
    expect(h.revalidate).toEqual([SETTING]);
  });

  it("deleteProject: DELETE {confirm_name}, then list revalidated and redirect; mismatch stays", async () => {
    await expect(A.deleteProject(PID, "Kia US", "en")).rejects.toThrow("REDIRECT:/en/projects");
    expect(calls).toEqual([{ method: "DELETE", url: P(), body: { confirm_name: "Kia US" } }]);
    expect(h.revalidate).toEqual(["/projects"]);
    h.revalidate.length = 0;
    answer = () => json(409, { error: { code: "name_mismatch", message: "m" } });
    await expect(A.deleteProject(PID, "x", "en")).resolves.toEqual({ ok: false, error: "입력한 이름이 프로젝트 명과 일치하지 않습니다" });
    expect(h.revalidate).toEqual([]);
  });

  it("promote / demote: PATCH /members/{user_id} {role}; member tab revalidated", async () => {
    answer = () => data({ user_id: UID });
    await A.promoteToOwner(PID, UID);
    await A.demoteToViewer(PID, UID);
    expect(calls).toEqual([
      { method: "PATCH", url: P(`/members/${UID}`), body: { role: "owner" } },
      { method: "PATCH", url: P(`/members/${UID}`), body: { role: "viewer" } },
    ]);
    expect(h.revalidate).toEqual([`/projects/${PID}/member`, `/projects/${PID}/member`]);
  });

  it("tracked entities, owned bases, tracked URLs: natural-key ids; setting (and target: project) revalidated", async () => {
    answer = (m, path) =>
      m === "POST"
        ? path.endsWith("/owned-bases")
          ? data({ base_norm: "kia.com", change_id: 1 }, 201)
          : path.endsWith("/tracked-urls")
            ? data({ url_norm: "kia.com/a", change_id: 2 }, 201)
            : data({ tracked_brands: [] }, 201)
        : data({ tracked_brands: [], base_norm: "kia.com", change_id: 3, url_norm: "kia.com/a" });
    await A.addTrackedCompetitor(PID, { brandName: "Toyota" });
    await A.removeTrackedCompetitor(PID, "Toyota");
    await A.setTargetCompetitor(PID, "Toyota");
    await A.addTrackedVehicle(PID, { brand: "Kia", model: "EV9" });
    await A.removeTrackedVehicle(PID, "Kia\u0000EV9");
    await expect(A.addProjectOwnedBaseAction(PID, { baseUrl: "https://kia.com" })).resolves.toEqual({ ok: true, value: { id: "kia.com" } });
    await A.removeProjectOwnedBaseAction(PID, "kia.com");
    await expect(A.addProjectTrackedUrlAction(PID, { url: "https://kia.com/a" })).resolves.toEqual({ ok: true, value: { id: "kia.com/a" } });
    await A.removeProjectTrackedUrlAction(PID, "kia.com/a");
    expect(calls.map(key)).toEqual([
      `POST ${P("/settings/competitors")}`,
      `DELETE ${P("/settings/competitors")}?brand_name=Toyota`,
      `PUT ${P("/settings/competitors/target")}`,
      `POST ${P("/settings/vehicles")}`,
      `DELETE ${P("/settings/vehicles")}?brand=Kia&model=EV9`,
      `POST ${P("/settings/owned-bases")}`,
      `DELETE ${P("/settings/owned-bases")}?base_norm=kia.com`,
      `POST ${P("/settings/tracked-urls")}`,
      `DELETE ${P("/settings/tracked-urls")}?url_norm=kia.com%2Fa`,
    ]);
    expect(h.revalidate).toEqual([SETTING, SETTING, SETTING, `/projects/${PID}`, SETTING, SETTING, SETTING, SETTING, SETTING, SETTING]);
  });

  it("tracked URL xlsx: export relays bytes; import relays the file", async () => {
    answer = (m) =>
      m === "GET"
        ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-disposition": 'attachment; filename="tracked-urls-c0000000-20260929.xlsx"' } })
        : data({ created: 1, updated: 0, skipped: 0, warnings: [] });
    await expect(A.exportTrackedUrlsXlsx(PID)).resolves.toEqual({ ok: true, value: { base64: "AQID", filename: "tracked-urls-c0000000-20260929.xlsx" } });
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1])], "u.xlsx"));
    await expect(A.importTrackedUrlsXlsx(PID, fd)).resolves.toEqual({ ok: true, value: { created: 1, updated: 0, skipped: 0, warnings: [] } });
    expect(calls.map(key)).toEqual([`GET ${P("/settings/tracked-urls/export")}`, `POST ${P("/settings/tracked-urls/import")}`]);
    expect(h.revalidate).toEqual([SETTING]);
  });

  // Verification D2: the api-source no-op still requires what legacy requireOwner accepted.
  it("triggerReprocess: owner -> flagged 0 after one gate read, no write, no revalidate; others throw", async () => {
    const gate = (my_role: string | null) => data({ project_id: PID, my_role });
    answer = () => gate("owner");
    await expect(A.triggerReprocess(PID)).resolves.toEqual({ ok: true, value: { flagged: 0 } });
    expect(calls.map(key)).toEqual([`GET ${P()}`]);
    calls.length = 0;
    answer = (_m, path) => (path === "/v1/auth/me" ? data({ role: "hq" }) : gate("viewer"));
    await expect(A.triggerReprocess(PID)).rejects.toThrow("setting action requires active Owner");
    expect(calls.map(key)).toEqual([`GET ${P()}`, "GET /v1/auth/me"]);
    answer = (_m, path) => (path === "/v1/auth/me" ? data({ role: "admin" }) : gate(null));
    await expect(A.triggerReprocess(PID)).resolves.toEqual({ ok: true, value: { flagged: 0 } });
    answer = () => json(404, { error: { code: "project_not_found", message: "m" } });
    await expect(A.triggerReprocess(PID)).rejects.toThrow("project not found");
    calls.length = 0;
    bindHghAuth({ getAccessToken: async () => null });
    await expect(A.triggerReprocess(PID)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(h.revalidate).toEqual([]);
  });
});
