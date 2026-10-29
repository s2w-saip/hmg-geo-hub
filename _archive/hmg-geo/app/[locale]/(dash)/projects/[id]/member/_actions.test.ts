import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

// Mock everything the action layer touches. Tests assert on the shape of
// repository calls + the spec-mandated denials (not on Drizzle / Supabase).
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/profiles", () => ({
  profileRepository: {
    getByEmail: vi.fn(),
  },
}));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: {
    getById: vi.fn(),
  },
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: {
    findMembership: vi.fn(),
    listForProject: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    accept: vi.fn(),
    pendingForUser: vi.fn(),
  },
}));
vi.mock("@/lib/db/repositories/member-audit-logs", () => ({
  memberAuditLogRepository: { insert: vi.fn(), listForProject: vi.fn() },
}));

import { getSession } from "@/lib/auth/session";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import {
  inviteMember,
  cancelInvite,
  removeMember,
  acceptInvite,
  rejectInvite,
} from "./_actions";

const PROJECT_ID = "project-1";
const OWNER_ID = "owner-1";
const VIEWER_ID = "viewer-1";

function session(id: string, role: "owner" | "viewer" | "admin" = "owner"): Session {
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
const getByEmailMock = vi.mocked(profileRepository.getByEmail);
const getProjectMock = vi.mocked(projectRepository.getById);
const findMembershipMock = vi.mocked(projectMemberRepository.findMembership);
const listForProjectMock = vi.mocked(projectMemberRepository.listForProject);
const insertMembershipMock = vi.mocked(projectMemberRepository.insert);
const deleteMembershipMock = vi.mocked(projectMemberRepository.delete);
const acceptMembershipMock = vi.mocked(projectMemberRepository.accept);
const pendingForUserMock = vi.mocked(projectMemberRepository.pendingForUser);

function ownerMembership() {
  return {
    id: "membership-owner",
    projectId: PROJECT_ID,
    userId: OWNER_ID,
    role: "owner" as const,
    status: "active" as const,
    invitedBy: OWNER_ID,
    invitedAt: new Date(0),
    acceptedAt: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue(session(OWNER_ID));
  getProjectMock.mockResolvedValue({
    id: PROJECT_ID,
    name: "p",
    description: null,
    domain: null,
    brand: null,
    country: "KR",
    language: null,
    createdBy: OWNER_ID,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  findMembershipMock.mockResolvedValue(ownerMembership());
});

describe("inviteMember", () => {
  it("rejects malformed email", async () => {
    const r = await inviteMember(PROJECT_ID, "not-an-email");
    expect(r.ok).toBe(false);
    expect(insertMembershipMock).not.toHaveBeenCalled();
  });

  it("rejects unknown invitee email (no profile)", async () => {
    getByEmailMock.mockResolvedValue(null);
    const r = await inviteMember(PROJECT_ID, "new@hmg.test");
    expect(r.ok).toBe(false);
    expect(insertMembershipMock).not.toHaveBeenCalled();
  });

  it("rejects inviting yourself", async () => {
    getByEmailMock.mockResolvedValue({
      id: OWNER_ID,
      email: "owner@hmg.test",
    } as never);
    const r = await inviteMember(PROJECT_ID, "owner@hmg.test");
    expect(r.ok).toBe(false);
    expect(insertMembershipMock).not.toHaveBeenCalled();
  });

  it("rejects when invitee already has a membership", async () => {
    getByEmailMock.mockResolvedValue({
      id: VIEWER_ID,
      email: "viewer@hmg.test",
    } as never);
    // First call → owner membership (the auth check), second → the
    // duplicate check for the invitee.
    findMembershipMock.mockResolvedValueOnce(ownerMembership());
    findMembershipMock.mockResolvedValueOnce({
      id: "membership-existing",
      projectId: PROJECT_ID,
      userId: VIEWER_ID,
      role: "viewer",
      status: "active",
      invitedBy: OWNER_ID,
      invitedAt: new Date(0),
      acceptedAt: new Date(0),
    });
    const r = await inviteMember(PROJECT_ID, "viewer@hmg.test");
    expect(r.ok).toBe(false);
    expect(insertMembershipMock).not.toHaveBeenCalled();
  });

  it("inserts a pending viewer membership for a fresh invite", async () => {
    getByEmailMock.mockResolvedValue({
      id: "new-user",
      email: "new@hmg.test",
    } as never);
    findMembershipMock.mockResolvedValueOnce(ownerMembership()); // auth
    findMembershipMock.mockResolvedValueOnce(null); // dedupe
    insertMembershipMock.mockResolvedValue({} as never);
    const r = await inviteMember(PROJECT_ID, "  New@HMG.test ");
    expect(r.ok).toBe(true);
    expect(insertMembershipMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      userId: "new-user",
      invitedBy: OWNER_ID,
      role: "viewer",
    });
  });

  it("admin bypass — non-member admin can invite", async () => {
    sessionMock.mockResolvedValue(session("admin-1", "admin"));
    findMembershipMock.mockResolvedValueOnce(null); // dedupe (no auth membership check for admin)
    getByEmailMock.mockResolvedValue({ id: "new-user", email: "new@hmg.test" } as never);
    insertMembershipMock.mockResolvedValue({} as never);
    const r = await inviteMember(PROJECT_ID, "new@hmg.test");
    expect(r.ok).toBe(true);
  });
});

describe("cancelInvite", () => {
  it("refuses to cancel a non-pending (active) member", async () => {
    listForProjectMock.mockResolvedValue([
      {
        id: "mem-active",
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
    const r = await cancelInvite(PROJECT_ID, "mem-active");
    expect(r.ok).toBe(false);
    expect(deleteMembershipMock).not.toHaveBeenCalled();
  });

  it("deletes a pending invite", async () => {
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
    const r = await cancelInvite(PROJECT_ID, "mem-pending");
    expect(r.ok).toBe(true);
    expect(deleteMembershipMock).toHaveBeenCalledWith("mem-pending");
  });
});

describe("removeMember", () => {
  it("refuses to remove an Owner row", async () => {
    listForProjectMock.mockResolvedValue([
      {
        id: "mem-co-owner",
        projectId: PROJECT_ID,
        userId: "other-owner",
        role: "owner",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "co@hmg.test",
        systemRole: "country",
      },
    ]);
    const r = await removeMember(PROJECT_ID, "mem-co-owner");
    expect(r.ok).toBe(false);
    expect(deleteMembershipMock).not.toHaveBeenCalled();
  });

  it("refuses self-removal", async () => {
    listForProjectMock.mockResolvedValue([
      {
        id: "mem-self",
        projectId: PROJECT_ID,
        userId: OWNER_ID,
        role: "viewer",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "owner@hmg.test",
        systemRole: "country",
      },
    ]);
    const r = await removeMember(PROJECT_ID, "mem-self");
    expect(r.ok).toBe(false);
    expect(deleteMembershipMock).not.toHaveBeenCalled();
  });

  it("removes an active viewer", async () => {
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
    const r = await removeMember(PROJECT_ID, "mem-viewer");
    expect(r.ok).toBe(true);
    expect(deleteMembershipMock).toHaveBeenCalledWith("mem-viewer");
  });
});

describe("acceptInvite / rejectInvite", () => {
  it("rejects accepting an invite not addressed to caller", async () => {
    sessionMock.mockResolvedValue(session(VIEWER_ID, "viewer"));
    pendingForUserMock.mockResolvedValue([]);
    const r = await acceptInvite("mem-other");
    expect(r.ok).toBe(false);
    expect(acceptMembershipMock).not.toHaveBeenCalled();
  });

  it("flips status to active when invite belongs to caller", async () => {
    sessionMock.mockResolvedValue(session(VIEWER_ID, "viewer"));
    pendingForUserMock.mockResolvedValue([
      {
        id: "mem-pending",
        projectId: PROJECT_ID,
        userId: VIEWER_ID,
        role: "viewer",
        status: "pending",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: null,
      },
    ]);
    const r = await acceptInvite("mem-pending");
    expect(r.ok).toBe(true);
    expect(acceptMembershipMock).toHaveBeenCalledWith("mem-pending");
  });

  it("deletes the row on reject", async () => {
    sessionMock.mockResolvedValue(session(VIEWER_ID, "viewer"));
    pendingForUserMock.mockResolvedValue([
      {
        id: "mem-pending",
        projectId: PROJECT_ID,
        userId: VIEWER_ID,
        role: "viewer",
        status: "pending",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: null,
      },
    ]);
    const r = await rejectInvite("mem-pending");
    expect(r.ok).toBe(true);
    expect(deleteMembershipMock).toHaveBeenCalledWith("mem-pending");
  });
});
