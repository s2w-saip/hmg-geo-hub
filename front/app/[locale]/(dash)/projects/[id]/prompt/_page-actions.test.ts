import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Paged-read server actions of the prompt tab (_page-actions.ts) on both sources.
//   B021  the paged reads the list makes after the first render (server actions alone in their request)
//         gate with the light GET /v1/projects/{id}?view=gate, shared in the request; the first render
//         gates once with the full call it shares with the layouts. Select-all reads 5,000 ids per call
//         on the api source (back screen.py IDS_ONLY_MAX) instead of 500, with the same consistency
//         checks; legacy keeps 500.
//   B016  the api source keeps each tag field's project-wide value count (the tag-column delete
//         confirmation reads it); the legacy rows are unchanged.

// react-server build so the in-request GET dedupe (React cache) really dedupes.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});
const h = vi.hoisted(() => ({ legacyQueries: [] as Array<{ offset: number; limit: number; ids_only: boolean }>, legacyTotal: 0 }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "ko" }));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "a0000000-0000-4000-8000-000000000001", role: "hq", menuGroups: null } }),
}));
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: { getById: async (id: string) => ({ id }) } }));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: { findMembership: async () => ({ status: "active", role: "owner" }) },
}));
vi.mock("@/lib/db/repositories/project-custom-fields", () => ({
  projectCustomFieldRepository: {
    listForProject: async () => [
      { id: "f0000000-0000-4000-8000-000000000001", label: "T", archived: false, projectId: "p", createdBy: "u", createdAt: new Date(0) },
    ],
  },
}));
vi.mock("@/lib/db/repositories/project-prompt-page", () => {
  const page = (rows: unknown[], ids: string[], total: number, offset: number, limit: number) => ({
    rows, ids, total, offset, limit, show_brand: false, show_category: false, draft_count: 0, values: {},
  });
  return {
    readProjectPromptPage: async (_id: string, q: { offset: number; limit: number; ids_only: boolean }) => {
      h.legacyQueries.push({ offset: q.offset, limit: q.limit, ids_only: q.ids_only });
      const n = Math.max(0, Math.min(q.limit, h.legacyTotal - q.offset));
      return page([], Array.from({ length: n }, (_, i) => `id-${q.offset + i}`), h.legacyTotal, q.offset, q.limit);
    },
    readProjectCandidatePage: async (_id: string, q: { offset: number; limit: number }) => page([], [], 0, q.offset, q.limit),
  };
});

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("@/lib/hgh/auth");
const A = await import("./_page-actions");

const PID = "c0000000-0000-4000-8000-000000000003";
const F = "f0000000-0000-4000-8000-000000000001";
const calls: { method: string; path: string; search: string; body: Record<string, unknown> | null }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const data = (d: unknown) => json(200, { data: d, meta: { mode: "crud" } });
const detail = {
  project_id: PID, name: "Kia US", description: null, domain: null, brand_code: "Kia", country_code: "US", scope_project_id: null,
  scope_linked: false, ga4_property_id: null, ai_engines: null, effective_engines: null, created_by: PID,
  created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", my_role: "owner",
};
const screenPage = (ids: string[], total: number, offset: number, limit: number) => ({
  rows: [], ids, total, offset, limit, show_brand: false, show_category: false, draft_count: 0, values: {},
});
let apiTotal = 0;

beforeEach(() => {
  calls.length = 0;
  h.legacyQueries.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  bindHghAuth({ getAccessToken: async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = String(init.method ?? "GET");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path: u.pathname, search: u.search, body });
    if (u.pathname === `/v1/projects/${PID}`) return data(detail);
    if (u.pathname.endsWith("/prompt-fields")) {
      return data({ items: [{ field_id: F, label: "T", archived: false, value_count: 7, created_at: "2026-06-01T00:00:00Z" }] });
    }
    if (u.pathname.endsWith("/screen")) {
      const offset = Number(body?.offset ?? 0);
      const limit = Number(body?.limit ?? 200);
      if (!body?.ids_only) return data(screenPage([], 0, offset, limit));
      const n = Math.max(0, Math.min(limit, apiTotal - offset));
      return data(screenPage(Array.from({ length: n }, (_, i) => `id-${offset + i}`), apiTotal, offset, limit));
    }
    return json(404, { error: { code: "not_found", message: "m" } });
  });
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("select all (loadAllProjectPromptIds)", () => {
  it("api: 5,000 ids per call (7,200 -> 2 calls instead of 15), the light gate read once per request", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    apiTotal = 7200;
    const ids = await withRequestScope(() => A.loadAllProjectPromptIds(PID));
    expect(ids).toEqual(Array.from({ length: 7200 }, (_, i) => `id-${i}`));
    const screens = calls.filter((c) => c.path.endsWith("/prompts/screen"));
    expect(screens.map((c) => [c.body?.offset, c.body?.limit, c.body?.ids_only])).toEqual([[0, 5000, true], [5000, 5000, true]]);
    // Same body as the 500-id reads apart from limit (projectPageQuery defaults).
    expect(screens[0].body).toEqual({ offset: 0, limit: 5000, sort: "", direction: null, collation: "en", ids_only: true, include_values: true });
    expect(calls.filter((c) => c.method === "GET").map((c) => `${c.path}${c.search}`)).toEqual([`/v1/projects/${PID}?view=gate`]);
  });

  it("api: exactly 5,000 ids end after one call; a short page or a moving total is refused as before", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    apiTotal = 5000;
    await expect(withRequestScope(() => A.loadAllProjectPromptIds(PID))).resolves.toHaveLength(5000);
    expect(calls.filter((c) => c.path.endsWith("/prompts/screen"))).toHaveLength(1);
    apiTotal = 5001;
    const shortPage = vi.fn(async () => data(screenPage(["only-one"], 5001, 0, 5000)));
    vi.stubGlobal("fetch", async (input: string) =>
      new URL(String(input)).pathname === `/v1/projects/${PID}` ? data(detail) : shortPage(),
    );
    await expect(withRequestScope(() => A.loadAllProjectPromptIds(PID))).rejects.toThrow("Incomplete prompt selection");
  });

  it("legacy: 500 ids per read, unchanged", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "legacy");
    h.legacyTotal = 1200;
    await expect(A.loadAllProjectPromptIds(PID)).resolves.toHaveLength(1200);
    expect(h.legacyQueries).toEqual([
      { offset: 0, limit: 500, ids_only: true },
      { offset: 500, limit: 500, ids_only: true },
      { offset: 1000, limit: 500, ids_only: true },
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe("paged reads after the render (loadProjectPromptRows / loadProjectCandidateRows)", () => {
  it("api: one light gate read (view=gate) per request, then the screen reads", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    await withRequestScope(async () => {
      await A.loadProjectPromptRows(PID, { offset: 200 });
      await A.loadProjectCandidateRows(PID, { offset: 0 });
    });
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
      `GET /v1/projects/${PID}?view=gate`,
      `POST /v1/projects/${PID}/prompts/screen`,
      `POST /v1/projects/${PID}/prompt-candidates/screen`,
    ]);
  });

  it("api: a hidden project is notFound before any screen read (same mapping as the page gate)", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push({ method: "GET", path: new URL(String(input)).pathname, search: new URL(String(input)).search, body: null });
      return json(404, { error: { code: "not_found", message: "m" } });
    });
    await expect(withRequestScope(() => A.loadProjectPromptRows(PID, {}))).rejects.toThrow("NOT_FOUND");
    expect(calls.map((c) => `${c.path}${c.search}`)).toEqual([`/v1/projects/${PID}?view=gate`]);
  });
});

describe("first render (loadProjectPromptScreen)", () => {
  it("api: gates once with the full call the layouts share; tag fields keep the project-wide value count", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    const r = await withRequestScope(() => A.loadProjectPromptScreen(PID));
    expect(r.canEdit).toBe(true);
    expect(r.customFields).toEqual([{ id: F, label: "T", archived: false, valueCount: 7 }]);
    expect(calls.filter((c) => c.path === `/v1/projects/${PID}`).map((c) => c.search)).toEqual([""]);
  });

  it("legacy: same field rows as before (no count)", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "legacy");
    const r = await A.loadProjectPromptScreen(PID);
    expect(r.customFields).toEqual([{ id: F, label: "T", archived: false }]);
    expect(calls).toHaveLength(0);
  });
});
