import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

// Verifies that every successful member-lifecycle action also writes an
// audit log row (Task R3). The 7 actions live across two files:
//   member/_actions: invite / cancel / remove / accept / reject
//   setting/_actions: promote / demote
// Each should call memberAuditLogRepository.insert exactly once on the
// success path, with the right action enum + actor/target ids.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((p: string) => {
    const e = new Error("REDIRECT");
    (e as Error & { __redirect?: string }).__redirect = p;
    throw e;
  }),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/profiles", () => ({
  profileRepository: { getByEmail: vi.fn() },
}));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { getById: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: {
    findMembership: vi.fn(),
    listForProject: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    accept: vi.fn(),
    setRole: vi.fn(),
    pendingForUser: vi.fn(),
  },
}));
vi.mock("@/lib/db/repositories/member-audit-logs", () => ({
  memberAuditLogRepository: { insert: vi.fn(), listForProject: vi.fn() },
}));
vi.mock("@/lib/db/repositories/tracked-entities", () => ({
  trackedCompetitorRepository: { listForProject: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  trackedVehicleRepository: { listForProject: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  flagPromptsForReanalysis: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { memberAuditLogRepository } from "@/lib/db/repositories/member-audit-logs";
import {
  inviteMember,
  cancelInvite,
  removeMember,
  acceptInvite,
  rejectInvite,
} from "./_actions";
import {
  promoteToOwner,
  demoteToViewer,
} from "../setting/_actions";

const PROJECT_ID = "p1";
const OWNER_ID = "owner-1";

function session(id: string): Session {
  return {
    user: {
      id,
      email: `${id}@hmg.test`,
      role: "country",
      scope: { all: false, regions: ["KR"], countries: ["KR"] },
    },
  };
}

const auditInsertMock = vi.mocked(memberAuditLogRepository.insert);
const sessionMock = vi.mocked(getSession);

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

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue(session(OWNER_ID));
  vi.mocked(projectRepository.getById).mockResolvedValue({
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
  vi.mocked(projectMemberRepository.findMembership).mockResolvedValue(ownerMembership());
});

describe("audit log: writes one row per successful action", () => {
  it("invite -> 'invite' with target=invitee, actor=Owner", async () => {
    vi.mocked(profileRepository.getByEmail).mockResolvedValue({
      id: "new-user",
      email: "new@hmg.test",
    } as never);
    // findMembership called twice in invite: auth check + dedupe
    vi.mocked(projectMemberRepository.findMembership)
      .mockResolvedValueOnce(ownerMembership())
      .mockResolvedValueOnce(null);
    vi.mocked(projectMemberRepository.insert).mockResolvedValue({} as never);
    const r = await inviteMember(PROJECT_ID, "new@hmg.test");
    expect(r.ok).toBe(true);
    expect(auditInsertMock).toHaveBeenCalledTimes(1);
    expect(auditInsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: OWNER_ID,
      targetUserId: "new-user",
      action: "invite",
      context: "role=viewer",
    });
  });

  it("cancelInvite -> 'cancel_invite'", async () => {
    vi.mocked(projectMemberRepository.listForProject).mockResolvedValue([
      {
        id: "mem-x",
        projectId: PROJECT_ID,
        userId: "u-pending",
        role: "viewer",
        status: "pending",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: null,
        email: "p@hmg.test",
        systemRole: "country",
      },
    ]);
    const r = await cancelInvite(PROJECT_ID, "mem-x");
    expect(r.ok).toBe(true);
    expect(auditInsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: OWNER_ID,
      targetUserId: "u-pending",
      action: "cancel_invite",
    });
  });

  it("removeMember -> 'remove' with prior role context", async () => {
    vi.mocked(projectMemberRepository.listForProject).mockResolvedValue([
      {
        id: "mem-v",
        projectId: PROJECT_ID,
        userId: "u-viewer",
        role: "viewer",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "v@hmg.test",
        systemRole: "country",
      },
    ]);
    const r = await removeMember(PROJECT_ID, "mem-v");
    expect(r.ok).toBe(true);
    expect(auditInsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: OWNER_ID,
      targetUserId: "u-viewer",
      action: "remove",
      context: "role=viewer",
    });
  });

  it("acceptInvite -> 'accept' self-acted (actor === target)", async () => {
    const VIEWER = "u-viewer";
    sessionMock.mockResolvedValue(session(VIEWER));
    vi.mocked(projectMemberRepository.pendingForUser).mockResolvedValue([
      {
        id: "mem-p",
        projectId: PROJECT_ID,
        userId: VIEWER,
        role: "viewer",
        status: "pending",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: null,
      },
    ]);
    const r = await acceptInvite("mem-p");
    expect(r.ok).toBe(true);
    expect(auditInsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: VIEWER,
      targetUserId: VIEWER,
      action: "accept",
    });
  });

  it("rejectInvite -> 'reject' self-acted", async () => {
    const VIEWER = "u-viewer";
    sessionMock.mockResolvedValue(session(VIEWER));
    vi.mocked(projectMemberRepository.pendingForUser).mockResolvedValue([
      {
        id: "mem-p",
        projectId: PROJECT_ID,
        userId: VIEWER,
        role: "viewer",
        status: "pending",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: null,
      },
    ]);
    const r = await rejectInvite("mem-p");
    expect(r.ok).toBe(true);
    expect(auditInsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: VIEWER,
      targetUserId: VIEWER,
      action: "reject",
    });
  });

  it("promoteToOwner -> 'promote' with viewer->owner context", async () => {
    vi.mocked(projectMemberRepository.listForProject).mockResolvedValue([
      {
        id: "mem-v",
        projectId: PROJECT_ID,
        userId: "u-viewer",
        role: "viewer",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "v@hmg.test",
        systemRole: "country",
      },
    ]);
    vi.mocked(projectMemberRepository.setRole).mockResolvedValue({} as never);
    const r = await promoteToOwner(PROJECT_ID, "mem-v");
    expect(r.ok).toBe(true);
    expect(auditInsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: OWNER_ID,
      targetUserId: "u-viewer",
      action: "promote",
      context: "viewer->owner",
    });
  });

  it("demoteToViewer -> 'demote' (with at least 2 Owners)", async () => {
    vi.mocked(projectMemberRepository.listForProject).mockResolvedValue([
      {
        id: "mem-o1",
        projectId: PROJECT_ID,
        userId: "u-o1",
        role: "owner",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "o1@hmg.test",
        systemRole: "country",
      },
      {
        id: "mem-o2",
        projectId: PROJECT_ID,
        userId: "u-o2",
        role: "owner",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "o2@hmg.test",
        systemRole: "country",
      },
    ]);
    vi.mocked(projectMemberRepository.setRole).mockResolvedValue({} as never);
    const r = await demoteToViewer(PROJECT_ID, "mem-o2");
    expect(r.ok).toBe(true);
    expect(auditInsertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: OWNER_ID,
      targetUserId: "u-o2",
      action: "demote",
      context: "owner->viewer",
    });
  });
});

describe("audit log: NOT written on action failure", () => {
  it("invite rejected by bad email — no audit row", async () => {
    const r = await inviteMember(PROJECT_ID, "not-an-email");
    expect(r.ok).toBe(false);
    expect(auditInsertMock).not.toHaveBeenCalled();
  });

  it("demote refused on last Owner — no audit row", async () => {
    vi.mocked(projectMemberRepository.listForProject).mockResolvedValue([
      {
        id: "mem-only",
        projectId: PROJECT_ID,
        userId: "u-only",
        role: "owner",
        status: "active",
        invitedBy: OWNER_ID,
        invitedAt: new Date(0),
        acceptedAt: new Date(0),
        email: "o@hmg.test",
        systemRole: "country",
      },
    ]);
    const r = await demoteToViewer(PROJECT_ID, "mem-only");
    expect(r.ok).toBe(false);
    expect(auditInsertMock).not.toHaveBeenCalled();
  });
});
