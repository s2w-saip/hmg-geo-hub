import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/lib/auth/types";
import type { ProjectSummary } from "./types";

const { getSession, upstreamList, upstreamGet, localById, localByScopeId, findMembership } = vi.hoisted(() => ({
  getSession: vi.fn(), upstreamList: vi.fn(), upstreamGet: vi.fn(),
  localById: vi.fn(), localByScopeId: vi.fn(), findMembership: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession }));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {} }));
vi.mock("@/lib/scope/index", () => ({
  isMockMode: () => false,
  getScopeClient: () => ({ listProjects: upstreamList, getProject: upstreamGet }),
}));
vi.mock("@/lib/db/repositories/request-cache", () => ({ cachedProjectById: localById }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { getByScopeProjectId: localByScopeId },
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: { findMembership },
}));
import { getProject, listProjects, UnauthorizedError } from "./server";

const summary = (project_id: string): ProjectSummary => ({ project_id, name: project_id, regions: ["KR"] });
const localProjects = [
  { id: "local-own", scopeProjectId: "scope-own", brand: "Hyundai", country: "KR" },
  { id: "local-other", scopeProjectId: "scope-other", brand: "Kia", country: "KR" },
  { id: "local-member", scopeProjectId: "scope-member", brand: "Genesis", country: "US" },
  { id: "local-pending", scopeProjectId: "scope-pending", brand: "Genesis", country: "US" },
  { id: "local-common", scopeProjectId: "scope-common", brand: null, country: "KR" },
];
const user: User = {
  id: "user", email: "user@example.test", role: "country", operator: "none", menuGroups: null,
  scope: { all: false, brands: ["Hyundai"], countries: ["KR"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SCOPE_ROOT_PROJECT_ID", "standard-root");
  getSession.mockResolvedValue({ user });
  localById.mockImplementation(async (id) => localProjects.find((project) => project.id === id) ?? null);
  localByScopeId.mockImplementation(async (id) => localProjects.find((project) => project.scopeProjectId === id) ?? null);
  findMembership.mockImplementation(async (projectId) => projectId === "local-member"
    ? { status: "active" }
    : projectId === "local-pending" ? { status: "pending" } : null);
  upstreamGet.mockImplementation(async (id) => summary(id));
  upstreamList.mockResolvedValue({
    data: ["scope-other", "scope-own", "scope-member", "scope-pending", "scope-common", "unmapped"].map(summary),
    next_cursor: null,
    total: 1000,
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("project access at the Scope gateway", () => {
  it("filters the list by scope or active membership and hides unrecognized projects and workspace totals", async () => {
    const page = await listProjects();
    expect(page).toEqual({
      data: ["scope-own", "scope-member", "scope-common"].map(summary), next_cursor: null,
    });
  });
  it("vendors can only list active memberships, including when scopeAll is mis-set", async () => {
    getSession.mockResolvedValue({ user: { ...user, role: "vendor", scope: { all: true } } });
    expect((await listProjects()).data.map((item) => item.project_id)).toEqual(["scope-member"]);
    await expect(getProject("scope-own")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(getProject("standard-root")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await getProject("scope-member")).toEqual(summary("scope-member"));
  });
  it.each(["admin", "hq", "region", "country", "website"])("preserves explicitly unrestricted %s list/detail access", async (role) => {
    getSession.mockResolvedValue({ user: { ...user, role, scope: { all: true } } });
    const page = await listProjects({ cursor: "upstream-admin", limit: 2 });
    expect(page).toHaveProperty("total", 1000);
    expect(upstreamList).toHaveBeenCalledWith({ cursor: "upstream-admin", limit: 2 });
    expect(await getProject("unmapped")).toEqual(summary("unmapped"));
    expect(localByScopeId).not.toHaveBeenCalled();
  });
  it("preserves multi-brand country scope without requiring a brand assignment", async () => {
    getSession.mockResolvedValue({ user: { ...user, scope: { all: false, countries: ["KR"] } } });
    expect((await listProjects()).data.map((item) => item.project_id)).toEqual([
      "scope-other", "scope-own", "scope-member", "scope-common",
    ]);
    expect(await getProject("scope-other")).toEqual(summary("scope-other"));
    await expect(getProject("scope-pending")).rejects.toBeInstanceOf(UnauthorizedError);
  });
  it("does not forward a restricted user's cursor or upstream workspace positions", async () => {
    upstreamList.mockImplementation(async ({ cursor }: { cursor?: string } = {}) => cursor
      ? { data: [summary("scope-pending"), summary("scope-member")], next_cursor: null, total: 5 }
      : { data: [summary("scope-other"), summary("unmapped"), summary("scope-own")], next_cursor: "workspace-private-position", total: 5 });
    const first = await listProjects({ limit: 1 });
    expect(first.data.map((item) => item.project_id)).toEqual(["scope-own"]);
    expect(first).not.toHaveProperty("total");
    expect(first.next_cursor).toBeTruthy();
    expect(first.next_cursor).not.toContain("workspace-private-position");
    const second = await listProjects({ limit: 1, cursor: first.next_cursor! });
    expect(second).toEqual({ data: [summary("scope-member")], next_cursor: null });
    expect(upstreamList.mock.calls.some(([query]) => query.cursor === first.next_cursor)).toBe(false);
  });
  it("continues past entirely hidden upstream pages to reach authorized records", async () => {
    upstreamList.mockImplementation(async ({ cursor }: { cursor?: string } = {}) => cursor
      ? { data: [summary("scope-member")], next_cursor: null }
      : { data: [summary("scope-other")], next_cursor: "hidden-page" });
    expect(await listProjects()).toEqual({ data: [summary("scope-member")], next_cursor: null });
  });
  it("does not treat an entirely unassigned scope as unrestricted project access", async () => {
    getSession.mockResolvedValue({ user: { ...user, scope: { all: false } } });
    expect((await listProjects()).data.map((item) => item.project_id)).toEqual(["scope-member"]);
    await expect(getProject("scope-own")).rejects.toBeInstanceOf(UnauthorizedError);
  });
  it("uses the same scope/membership decision for detail and listing", async () => {
    for (const id of ["scope-own", "scope-member", "scope-common", "local-own"]) {
      expect(await getProject(id)).toEqual(summary(id));
    }
    for (const id of ["scope-other", "scope-pending", "unmapped"]) {
      await expect(getProject(id)).rejects.toBeInstanceOf(UnauthorizedError);
    }
  });
  it("requires a session before fetching upstream projects", async () => {
    getSession.mockResolvedValue(null);
    await expect(listProjects()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(upstreamList).not.toHaveBeenCalled();
  });
  it.each(["workspace-private-position", "visible:-1", "visible:1.5", "visible:999999999999999999999"])(
    "rejects invalid visible cursor %j before calling upstream", async (cursor) => {
      await expect(listProjects({ cursor })).rejects.toBeInstanceOf(UnauthorizedError);
      expect(upstreamList).not.toHaveBeenCalled();
    },
  );
  it("does not silently present a truncated workspace scan as the complete visible list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      upstreamList.mockResolvedValue({ data: [], next_cursor: "more-hidden-records" });
      await expect(listProjects()).rejects.toThrow("Project listing exceeded its page limit");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
