import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: {
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setScopeProjectId: vi.fn(),
    setAiEngines: vi.fn(),
    listEngineHistory: vi.fn(),
  },
}));
vi.mock("@/lib/scope/project-sync", () => ({
  pushScopeUpdate: vi.fn(async () => ({ newScopeProjectId: null })),
  deleteScopeMirror: vi.fn(async () => {}),
  createScopeMirror: vi.fn(async () => null),
  syncScopeSchedule: vi.fn(async () => ({ pushed: true })),
  attachScopeMirror: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: { findMembership: vi.fn(), listForProject: vi.fn(), setRole: vi.fn() },
}));
vi.mock("@/lib/db/repositories/member-audit-logs", () => ({
  memberAuditLogRepository: { insert: vi.fn(), listForProject: vi.fn() },
}));
vi.mock("@/lib/db/repositories/tracked-entities", () => ({
  trackedBrandRepository: { listForProject: vi.fn(), upsert: vi.fn(), deleteByCanonical: vi.fn() },
  trackedCompetitorRepository: { listForProject: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  trackedVehicleRepository: { listForProject: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  syncTrackedBrandCatalog: vi.fn(),
  flagPromptsForReanalysis: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { pushScopeUpdate, syncScopeSchedule } from "@/lib/scope/project-sync";
import { updateProjectEngines } from "./_actions";

const PROJECT_ID = "project-1";
const OWNER_ID = "owner-1";

function session(id: string, operator: "none" | "assigned" | "global" = "assigned"): Session {
  return {
    user: {
      id,
      email: `${id}@hmg.test`,
      role: "country",
      operator,
      scope: { all: false, regions: ["KR"], countries: ["KR"] },
    },
  };
}

function fakeProject(over: Partial<{ aiEngines: string[] | null; scopeProjectId: string | null }> = {}) {
  return {
    id: PROJECT_ID,
    name: "p",
    description: null,
    domain: null,
    brand: "Hyundai",
    country: "KR",
    language: null,
    scopeProjectId: "scope-1",
    ga4PropertyId: null,
    aiEngines: null,
    createdBy: OWNER_ID,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

const sessionMock = vi.mocked(getSession);
const getProjectMock = vi.mocked(projectRepository.getById);
const setAiEnginesMock = vi.mocked(projectRepository.setAiEngines);
const setScopeProjectIdMock = vi.mocked(projectRepository.setScopeProjectId);
const findMembershipMock = vi.mocked(projectMemberRepository.findMembership);
const syncScheduleMock = vi.mocked(syncScopeSchedule);
const pushScopeUpdateMock = vi.mocked(pushScopeUpdate);

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue(session(OWNER_ID));
  findMembershipMock.mockResolvedValue({
    id: "mem",
    projectId: PROJECT_ID,
    userId: OWNER_ID,
    role: "owner",
    status: "active",
    invitedBy: OWNER_ID,
    invitedAt: new Date(0),
    acceptedAt: new Date(0),
  });
  getProjectMock.mockResolvedValue(fakeProject());
  setAiEnginesMock.mockImplementation(async (id, engines) => fakeProject({ aiEngines: engines }));
  syncScheduleMock.mockResolvedValue({ pushed: true });
  pushScopeUpdateMock.mockResolvedValue({ newScopeProjectId: null });
});

describe("updateProjectEngines", () => {
  it("normalizes input, persists + appends history, pushes schedule targets", async () => {
    const r = await updateProjectEngines(PROJECT_ID, ["gemini", "chatgpt", "bogus", "gemini"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ engines: ["chatgpt", "gemini"], changed: true, pushed: true });
    expect(setAiEnginesMock).toHaveBeenCalledWith(PROJECT_ID, ["chatgpt", "gemini"], OWNER_ID);
    expect(syncScheduleMock).toHaveBeenCalledWith(
      { id: PROJECT_ID, scopeProjectId: "scope-1", aiEngines: ["chatgpt", "gemini"] },
      { reenable: false },
    );
  });

  it("re-selecting after an explicit [] save asks scope to re-enable the schedule", async () => {
    getProjectMock.mockResolvedValue(fakeProject({ aiEngines: [] }));
    const r = await updateProjectEngines(PROJECT_ID, ["chatgpt"]);
    expect(r.ok).toBe(true);
    expect(syncScheduleMock).toHaveBeenCalledWith(
      { id: PROJECT_ID, scopeProjectId: "scope-1", aiEngines: ["chatgpt"] },
      { reenable: true },
    );
  });

  it("legacy (NULL) project: saving the default set is still a first explicit save", async () => {
    getProjectMock.mockResolvedValue(fakeProject({ aiEngines: null }));
    const r = await updateProjectEngines(PROJECT_ID, ["chatgpt", "gemini"]);
    expect(r.ok && r.value.changed).toBe(true);
    expect(setAiEnginesMock).toHaveBeenCalledTimes(1);
  });

  it("no-op when the explicit selection is unchanged (no history growth), still re-syncs", async () => {
    getProjectMock.mockResolvedValue(fakeProject({ aiEngines: ["chatgpt", "gemini"] }));
    const r = await updateProjectEngines(PROJECT_ID, ["gemini", "chatgpt"]);
    expect(r.ok && r.value.changed).toBe(false);
    expect(setAiEnginesMock).not.toHaveBeenCalled();
    expect(syncScheduleMock).toHaveBeenCalledTimes(1);
  });

  it("empty selection is allowed (collection paused) and reported as pushed", async () => {
    getProjectMock.mockResolvedValue(fakeProject({ aiEngines: ["chatgpt"] }));
    const r = await updateProjectEngines(PROJECT_ID, []);
    expect(r.ok && r.value.engines).toEqual([]);
    expect(setAiEnginesMock).toHaveBeenCalledWith(PROJECT_ID, [], OWNER_ID);
  });

  it("creates the mirror first when the project is unmirrored, then syncs the schedule to it", async () => {
    getProjectMock.mockResolvedValue(fakeProject({ scopeProjectId: null }));
    pushScopeUpdateMock.mockResolvedValue({ newScopeProjectId: "scope-new" });
    const r = await updateProjectEngines(PROJECT_ID, ["deepseek"]);
    expect(r.ok).toBe(true);
    expect(setScopeProjectIdMock).toHaveBeenCalledWith(PROJECT_ID, "scope-new");
    expect(syncScheduleMock).toHaveBeenCalledWith(
      { id: PROJECT_ID, scopeProjectId: "scope-new", aiEngines: ["deepseek"] },
      { reenable: false },
    );
  });

  it("surfaces pushed=false when scope sync fails (local value stays authoritative)", async () => {
    syncScheduleMock.mockResolvedValue({ pushed: false });
    const r = await updateProjectEngines(PROJECT_ID, ["chatgpt"]);
    expect(r.ok && r.value.pushed).toBe(false);
    expect(setAiEnginesMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an Owner without operator authority (operator=none) — cost lever", async () => {
    sessionMock.mockResolvedValue(session(OWNER_ID, "none"));
    const r = await updateProjectEngines(PROJECT_ID, ["chatgpt"]);
    expect(r.ok).toBe(false);
    expect(setAiEnginesMock).not.toHaveBeenCalled();
    expect(syncScheduleMock).not.toHaveBeenCalled();
  });

  it("rejects non-owner viewers", async () => {
    findMembershipMock.mockResolvedValue({
      id: "mem",
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      role: "viewer",
      status: "active",
      invitedBy: OWNER_ID,
      invitedAt: new Date(0),
      acceptedAt: new Date(0),
    });
    await expect(updateProjectEngines(PROJECT_ID, ["chatgpt"])).rejects.toThrow();
    expect(setAiEnginesMock).not.toHaveBeenCalled();
  });
});
