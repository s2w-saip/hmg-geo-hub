import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

// Verifies the tracked-entity actions (Task P3): add/remove for both
// competitors and vehicles, the reprocess flag plumbing, and the empty
// "trigger reprocess" stub. Mocks every external repo so the action's
// orchestration is what gets exercised.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((p: string) => {
    const e = new Error("REDIRECT");
    (e as Error & { __redirect?: string }).__redirect = p;
    throw e;
  }),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { getById: vi.fn(), update: vi.fn(), delete: vi.fn() },
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
  trackedBrandRepository: { listForProject: vi.fn(), upsert: vi.fn(), deleteByCanonical: vi.fn() },
  trackedCompetitorRepository: { listForProject: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  trackedVehicleRepository: { listForProject: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  syncTrackedBrandCatalog: vi.fn(),
  flagPromptsForReanalysis: vi.fn(),
}));

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
  addTrackedCompetitor,
  removeTrackedCompetitor,
  addTrackedVehicle,
  removeTrackedVehicle,
  triggerReprocess,
} from "./_actions";

const PROJECT_ID = "p1";
const OWNER_ID = "owner-1";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(session(OWNER_ID));
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
  vi.mocked(projectMemberRepository.findMembership).mockResolvedValue({
    id: "m1",
    projectId: PROJECT_ID,
    userId: OWNER_ID,
    role: "owner",
    status: "active",
    invitedBy: OWNER_ID,
    invitedAt: new Date(0),
    acceptedAt: new Date(0),
  });
  vi.mocked(trackedBrandRepository.listForProject).mockResolvedValue([]);
  vi.mocked(trackedCompetitorRepository.listForProject).mockResolvedValue([]);
});

describe("addTrackedCompetitor", () => {
  it("rejects empty brand", async () => {
    const r = await addTrackedCompetitor(PROJECT_ID, { brandName: "   " });
    expect(r.ok).toBe(false);
    expect(trackedCompetitorRepository.insert).not.toHaveBeenCalled();
  });

  it("inserts trimmed brand + flags reprocess count", async () => {
    vi.mocked(trackedCompetitorRepository.insert).mockResolvedValue({
      id: "c1",
    } as never);
    vi.mocked(flagPromptsForReanalysis).mockResolvedValue(7);
    const r = await addTrackedCompetitor(PROJECT_ID, {
      brandName: "  Tesla  ",
      notes: " EV ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reprocessable).toBe(7);
    expect(trackedCompetitorRepository.insert).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      brandName: "Tesla",
      aliases: null,
      notes: "EV",
    });
    expect(syncTrackedBrandCatalog).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("translates unique-violation into a user-friendly error", async () => {
    vi.mocked(trackedCompetitorRepository.insert).mockRejectedValue(
      new Error("duplicate key value violates unique constraint"),
    );
    const r = await addTrackedCompetitor(PROJECT_ID, { brandName: "Tesla" });
    expect(r.ok).toBe(false);
    expect(flagPromptsForReanalysis).not.toHaveBeenCalled();
  });
});

describe("removeTrackedCompetitor", () => {
  it("deletes + returns reprocess count", async () => {
    vi.mocked(flagPromptsForReanalysis).mockResolvedValue(3);
    const r = await removeTrackedCompetitor(PROJECT_ID, "c1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reprocessable).toBe(3);
    expect(trackedCompetitorRepository.delete).toHaveBeenCalledWith("c1");
    expect(syncTrackedBrandCatalog).toHaveBeenCalledWith(PROJECT_ID);
  });
});

describe("addTrackedVehicle", () => {
  it("requires both brand and model", async () => {
    const noBrand = await addTrackedVehicle(PROJECT_ID, { brand: "  ", model: "Ioniq 5" });
    expect(noBrand.ok).toBe(false);
    const noModel = await addTrackedVehicle(PROJECT_ID, { brand: "Hyundai", model: "" });
    expect(noModel.ok).toBe(false);
    expect(trackedVehicleRepository.insert).not.toHaveBeenCalled();
  });

  it("inserts trimmed values + returns reprocess count", async () => {
    vi.mocked(trackedVehicleRepository.insert).mockResolvedValue({ id: "v1" } as never);
    vi.mocked(flagPromptsForReanalysis).mockResolvedValue(5);
    const r = await addTrackedVehicle(PROJECT_ID, {
      brand: " Hyundai ",
      model: " Ioniq 5 ",
      segment: " SUV ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reprocessable).toBe(5);
    expect(trackedVehicleRepository.insert).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      brand: "Hyundai",
      model: "Ioniq 5",
      segment: "SUV",
      aliases: null,
    });
    expect(trackedCompetitorRepository.insert).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      brandName: "Hyundai",
    });
    expect(syncTrackedBrandCatalog).toHaveBeenCalledWith(PROJECT_ID);
  });
});

describe("removeTrackedVehicle", () => {
  it("deletes + returns reprocess count", async () => {
    vi.mocked(flagPromptsForReanalysis).mockResolvedValue(2);
    const r = await removeTrackedVehicle(PROJECT_ID, "v1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reprocessable).toBe(2);
    expect(trackedVehicleRepository.delete).toHaveBeenCalledWith("v1");
    expect(syncTrackedBrandCatalog).toHaveBeenCalledWith(PROJECT_ID);
  });
});

describe("triggerReprocess", () => {
  it("flags prompts + reports the count", async () => {
    vi.mocked(flagPromptsForReanalysis).mockResolvedValue(11);
    const r = await triggerReprocess(PROJECT_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flagged).toBe(11);
  });
});

describe("auth gating", () => {
  it("viewer cannot add a competitor", async () => {
    vi.mocked(projectMemberRepository.findMembership).mockResolvedValue({
      id: "m1",
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      role: "viewer",
      status: "active",
      invitedBy: OWNER_ID,
      invitedAt: new Date(0),
      acceptedAt: new Date(0),
    });
    await expect(
      addTrackedCompetitor(PROJECT_ID, { brandName: "Tesla" }),
    ).rejects.toThrow();
    expect(trackedCompetitorRepository.insert).not.toHaveBeenCalled();
  });

  it("admin bypass — non-member admin can add", async () => {
    vi.mocked(getSession).mockResolvedValue(session("admin-1", "admin"));
    vi.mocked(projectMemberRepository.findMembership).mockResolvedValue(null);
    vi.mocked(trackedCompetitorRepository.insert).mockResolvedValue({ id: "c1" } as never);
    vi.mocked(flagPromptsForReanalysis).mockResolvedValue(0);
    const r = await addTrackedCompetitor(PROJECT_ID, { brandName: "Tesla" });
    expect(r.ok).toBe(true);
  });
});
