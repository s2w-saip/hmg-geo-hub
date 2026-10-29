import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// redirect() throws a special Next.js error; we catch and assert the throw
// instead of asserting a return value (which would never reach the caller).
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    const e = new Error("REDIRECT");
    (e as Error & { __redirect?: string }).__redirect = path;
    throw e;
  }),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: {
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setScopeProjectId: vi.fn(),
  },
}));
// Isolate the scope-mirror side-effects (project-sync calls the scope gateway,
// which we don't exercise in these action unit tests). Stubs are inert: update
// reports "no new mirror id", delete is a no-op.
vi.mock("@/lib/scope/project-sync", () => ({
  pushScopeUpdate: vi.fn(async () => ({ newScopeProjectId: null })),
  deleteScopeMirror: vi.fn(async () => {}),
  createScopeMirror: vi.fn(async () => null),
  syncScopeSchedule: vi.fn(async () => ({ pushed: false })),
  attachScopeMirror: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: {
    findMembership: vi.fn(),
    listForProject: vi.fn(),
    setRole: vi.fn(),
  },
}));
vi.mock("@/lib/db/repositories/member-audit-logs", () => ({
  memberAuditLogRepository: { insert: vi.fn(), listForProject: vi.fn() },
}));
vi.mock("@/lib/db/repositories/tracked-entities", () => ({
  trackedBrandRepository: {
    listForProject: vi.fn(),
    upsert: vi.fn(),
    deleteByCanonical: vi.fn(),
  },
  trackedCompetitorRepository: {
    listForProject: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
  trackedVehicleRepository: {
    listForProject: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
  syncTrackedBrandCatalog: vi.fn(),
  flagPromptsForReanalysis: vi.fn(),
}));

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import {
  trackedBrandRepository,
  trackedCompetitorRepository,
  trackedVehicleRepository,
  syncTrackedBrandCatalog,
  flagPromptsForReanalysis,
} from "@/lib/db/repositories/tracked-entities";
import {
  updateProject,
  deleteProject,
  promoteToOwner,
  demoteToViewer,
  addTrackedVehicle,
} from "./_actions";

const PROJECT_ID = "project-1";
const OWNER_ID = "owner-1";
const VIEWER_ID = "viewer-1";

function session(id: string, role: "owner" | "admin" = "owner"): Session {
  return {
    user: {
      id,
      email: `${id}@hmg.test`,
      role: role === "admin" ? "admin" : "country",
      scope: { all: false, regions: ["KR"], countries: ["KR"] },
    },
  };
}

const sessionMock = vi.mocked(getSession);
const getProjectMock = vi.mocked(projectRepository.getById);
const updateProjectMock = vi.mocked(projectRepository.update);
const deleteProjectRepoMock = vi.mocked(projectRepository.delete);
const findMembershipMock = vi.mocked(projectMemberRepository.findMembership);
const listForProjectMock = vi.mocked(projectMemberRepository.listForProject);
const setRoleMock = vi.mocked(projectMemberRepository.setRole);
const redirectMock = vi.mocked(redirect);
const trackedBrandUpsertMock = vi.mocked(trackedBrandRepository.upsert);
const syncTrackedBrandCatalogMock = vi.mocked(syncTrackedBrandCatalog);
const flagPromptsForReanalysisMock = vi.mocked(flagPromptsForReanalysis);
const trackedCompetitorListMock = vi.mocked(trackedCompetitorRepository.listForProject);
const trackedCompetitorInsertMock = vi.mocked(trackedCompetitorRepository.insert);
const trackedVehicleInsertMock = vi.mocked(trackedVehicleRepository.insert);

function ownerMembership(userId = OWNER_ID) {
  return {
    id: `mem-${userId}`,
    projectId: PROJECT_ID,
    userId,
    role: "owner" as const,
    status: "active" as const,
    invitedBy: OWNER_ID,
    invitedAt: new Date(0),
    acceptedAt: new Date(0),
  };
}

function fakeProject(name = "p") {
  return {
    id: PROJECT_ID,
    name,
    description: null,
    domain: null,
    brand: null,
    country: "KR",
    language: null,
    createdBy: OWNER_ID,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue(session(OWNER_ID));
  getProjectMock.mockResolvedValue(fakeProject());
  findMembershipMock.mockResolvedValue(ownerMembership());
  updateProjectMock.mockResolvedValue(fakeProject());
  trackedBrandUpsertMock.mockResolvedValue(undefined);
  syncTrackedBrandCatalogMock.mockResolvedValue(undefined);
  flagPromptsForReanalysisMock.mockResolvedValue(0);
  trackedCompetitorListMock.mockResolvedValue([]);
  trackedCompetitorInsertMock.mockResolvedValue({} as never);
  trackedVehicleInsertMock.mockResolvedValue({ id: "vehicle-1" } as never);
});

describe("updateProject", () => {
  it("rejects empty name", async () => {
    const r = await updateProject(PROJECT_ID, { name: "   " });
    expect(r.ok).toBe(false);
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it("normalises null-empty strings to null for optional fields", async () => {
    const r = await updateProject(PROJECT_ID, {
      name: " New Name ",
      description: "  ",
      domain: "",
      brand: "Hyundai",
    });
    expect(r.ok).toBe(true);
    expect(updateProjectMock).toHaveBeenCalledWith(PROJECT_ID, {
      name: "New Name",
      description: null,
      domain: null,
      brand: "Hyundai",
    });
  });

  it("updates owned-brand aliases and flags reanalysis when brand rules changed", async () => {
    getProjectMock.mockResolvedValue(fakeProject());
    updateProjectMock.mockResolvedValue({
      ...fakeProject(),
      brand: "Hyundai",
    } as never);
    flagPromptsForReanalysisMock.mockResolvedValue(4);

    const r = await updateProject(PROJECT_ID, {
      brand: "Hyundai",
      brandAliases: ["hyundai", "현대", "현대"],
      brandAliasesBrand: "Hyundai",
    });

    expect(r.ok).toBe(true);
    expect(trackedBrandUpsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      canonicalName: "Hyundai",
      aliases: ["hyundai", "현대"],
    });
    expect(syncTrackedBrandCatalogMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(flagPromptsForReanalysisMock).toHaveBeenCalledWith(PROJECT_ID);
    if (r.ok) expect(r.value.reprocessable).toBe(4);
  });

  it("clears stale aliases when brand changed before alias field was re-edited", async () => {
    getProjectMock.mockResolvedValue({
      ...fakeProject(),
      brand: "Hyundai",
    } as never);
    updateProjectMock.mockResolvedValue({
      ...fakeProject(),
      brand: "Kia",
    } as never);

    const r = await updateProject(PROJECT_ID, {
      brand: "Kia",
      brandAliases: ["hyundai", "현대"],
      brandAliasesBrand: null,
    });

    expect(r.ok).toBe(true);
    expect(trackedBrandUpsertMock).not.toHaveBeenCalled();
    expect(trackedBrandRepository.deleteByCanonical).toHaveBeenCalledWith(PROJECT_ID, "Hyundai");
    expect(trackedBrandRepository.deleteByCanonical).toHaveBeenCalledWith(PROJECT_ID, "Kia");
    expect(syncTrackedBrandCatalogMock).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("requires Owner — viewer cannot update", async () => {
    findMembershipMock.mockResolvedValue({
      ...ownerMembership(),
      role: "viewer",
    });
    await expect(updateProject(PROJECT_ID, { name: "x" })).rejects.toThrow();
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it("admin bypass — non-member admin can update", async () => {
    sessionMock.mockResolvedValue(session("admin-1", "admin"));
    findMembershipMock.mockResolvedValue(null);
    const r = await updateProject(PROJECT_ID, { name: "renamed" });
    expect(r.ok).toBe(true);
    expect(updateProjectMock).toHaveBeenCalled();
  });
});

describe("addTrackedVehicle", () => {
  it("auto-registers a new vehicle brand into the tracked-brand list", async () => {
    trackedCompetitorListMock.mockResolvedValue([]);
    const r = await addTrackedVehicle(PROJECT_ID, { brand: "Tesla", model: "Model Y" });
    expect(r.ok).toBe(true);
    expect(trackedCompetitorInsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      brandName: "Tesla",
    });
  });

  it("does not duplicate a brand already in the tracked-brand list", async () => {
    trackedCompetitorListMock.mockResolvedValue([
      { id: "c-1", projectId: PROJECT_ID, brandName: "Tesla", aliases: null, notes: null, isTarget: false },
    ]);
    const r = await addTrackedVehicle(PROJECT_ID, { brand: "Tesla", model: "Model Y" });
    expect(r.ok).toBe(true);
    expect(trackedCompetitorInsertMock).not.toHaveBeenCalled();
  });

  it("skips auto-registration when the vehicle brand is the project's own brand", async () => {
    getProjectMock.mockResolvedValue({ ...fakeProject(), brand: "Hyundai" } as never);
    const r = await addTrackedVehicle(PROJECT_ID, { brand: "Hyundai", model: "Ioniq 5" });
    expect(r.ok).toBe(true);
    expect(trackedCompetitorInsertMock).not.toHaveBeenCalled();
  });
});

describe("deleteProject", () => {
  it("rejects when confirm name does not match", async () => {
    getProjectMock.mockResolvedValue(fakeProject("Sample"));
    const r = await deleteProject(PROJECT_ID, "wrong-name", "ko");
    expect(r && r.ok).toBe(false);
    expect(deleteProjectRepoMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("deletes + redirects when name matches", async () => {
    getProjectMock.mockResolvedValue(fakeProject("Sample"));
    deleteProjectRepoMock.mockResolvedValue(undefined);
    // redirect() throws our stub error — expect the call site to propagate it
    await expect(
      deleteProject(PROJECT_ID, "Sample", "ko"),
    ).rejects.toThrow("REDIRECT");
    expect(deleteProjectRepoMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(redirectMock).toHaveBeenCalledWith("/ko/projects");
  });
});

describe("promoteToOwner", () => {
  it("rejects promoting a pending invite", async () => {
    listForProjectMock.mockResolvedValue([
      {
        id: "mem-pending",
        projectId: PROJECT_ID,
        userId: VIEWER_ID,
        role: "viewer",
        status: "pending",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: null,
        email: "v@hmg.test",
        systemRole: "country",
      },
    ]);
    const r = await promoteToOwner(PROJECT_ID, "mem-pending");
    expect(r.ok).toBe(false);
    expect(setRoleMock).not.toHaveBeenCalled();
  });

  it("rejects promoting an already-Owner", async () => {
    listForProjectMock.mockResolvedValue([
      {
        id: "mem-owner",
        projectId: PROJECT_ID,
        userId: "other-owner",
        role: "owner",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "o@hmg.test",
        systemRole: "country",
      },
    ]);
    const r = await promoteToOwner(PROJECT_ID, "mem-owner");
    expect(r.ok).toBe(false);
    expect(setRoleMock).not.toHaveBeenCalled();
  });

  it("flips an active Viewer to Owner", async () => {
    listForProjectMock.mockResolvedValue([
      {
        id: "mem-viewer",
        projectId: PROJECT_ID,
        userId: VIEWER_ID,
        role: "viewer",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "v@hmg.test",
        systemRole: "country",
      },
    ]);
    setRoleMock.mockResolvedValue({} as never);
    const r = await promoteToOwner(PROJECT_ID, "mem-viewer");
    expect(r.ok).toBe(true);
    expect(setRoleMock).toHaveBeenCalledWith("mem-viewer", "owner");
  });
});

describe("demoteToViewer", () => {
  function buildOwners(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `mem-owner-${i}`,
      projectId: PROJECT_ID,
      userId: `owner-${i}`,
      role: "owner" as const,
      status: "active" as const,
      invitedBy: OWNER_ID,
      invitedAt: new Date(0),
      acceptedAt: new Date(0),
      email: `o${i}@hmg.test`,
      systemRole: "country",
    }));
  }

  it("refuses to demote the last active Owner", async () => {
    listForProjectMock.mockResolvedValue(buildOwners(1));
    const r = await demoteToViewer(PROJECT_ID, "mem-owner-0");
    expect(r.ok).toBe(false);
    expect(setRoleMock).not.toHaveBeenCalled();
  });

  it("allows demoting an Owner when others remain", async () => {
    listForProjectMock.mockResolvedValue(buildOwners(2));
    setRoleMock.mockResolvedValue({} as never);
    const r = await demoteToViewer(PROJECT_ID, "mem-owner-1");
    expect(r.ok).toBe(true);
    expect(setRoleMock).toHaveBeenCalledWith("mem-owner-1", "viewer");
  });

  it("rejects demoting a Viewer", async () => {
    listForProjectMock.mockResolvedValue([
      {
        id: "mem-viewer",
        projectId: PROJECT_ID,
        userId: VIEWER_ID,
        role: "viewer",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "v@hmg.test",
        systemRole: "country",
      },
    ]);
    const r = await demoteToViewer(PROJECT_ID, "mem-viewer");
    expect(r.ok).toBe(false);
    expect(setRoleMock).not.toHaveBeenCalled();
  });
});
