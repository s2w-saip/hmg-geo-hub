import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { getById: vi.fn() },
}));
vi.mock("@/lib/db/repositories/project-members", () => ({
  projectMemberRepository: { findMembership: vi.fn() },
}));
vi.mock("@/lib/auth/operator-policy", () => ({
  canOperateProject: vi.fn(() => true),
}));
vi.mock("@/lib/db/repositories/prompts", () => ({
  promptCandidateRepository: { listForProject: vi.fn() },
  promptRepository: {
    listForProject: vi.fn(),
    getById: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    enqueueAll: vi.fn(),
    setScopePromptId: vi.fn(),
  },
}));
vi.mock("@/lib/prompts/excel", () => ({
  buildWorkbook: vi.fn(),
  parseWorkbook: vi.fn(),
}));
vi.mock("@/lib/scope/project-sync", () => ({
  pushDraftPromptsToScope: vi.fn(),
}));
vi.mock("@/lib/db/repositories/project-custom-fields", () => ({
  projectCustomFieldRepository: {
    listForProject: vi.fn(),
    getById: vi.fn(),
    insert: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    delete: vi.fn(),
    listValuesForProject: vi.fn(),
    setValue: vi.fn(),
    clearValue: vi.fn(),
    countFieldUsage: vi.fn(),
  },
}));

import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { promptRepository } from "@/lib/db/repositories/prompts";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import {
  addCustomField,
  archiveCustomField,
  restoreCustomField,
  deleteCustomFieldHard,
  setPromptCustomFieldValue,
  clearPromptCustomFieldValue,
} from "./_actions";

const PROJECT_ID = "project-1";
const OWNER_ID = "owner-1";

function session(): Session {
  return {
    user: {
      id: OWNER_ID,
      email: `${OWNER_ID}@hmg.test`,
      role: "country",
      scope: { all: false, regions: ["KR"], countries: ["KR"] },
    },
  };
}

const sessionMock = vi.mocked(getSession);
const getProjectMock = vi.mocked(projectRepository.getById);
const findMembershipMock = vi.mocked(projectMemberRepository.findMembership);
const insertMock = vi.mocked(projectCustomFieldRepository.insert);
const getFieldByIdMock = vi.mocked(projectCustomFieldRepository.getById);
const getPromptByIdMock = vi.mocked(promptRepository.getById);
const countFieldUsageMock = vi.mocked(projectCustomFieldRepository.countFieldUsage);
const deleteMock = vi.mocked(projectCustomFieldRepository.delete);
const setValueMock = vi.mocked(projectCustomFieldRepository.setValue);
const clearValueMock = vi.mocked(projectCustomFieldRepository.clearValue);
const archiveMock = vi.mocked(projectCustomFieldRepository.archive);
const restoreMock = vi.mocked(projectCustomFieldRepository.restore);

const FIELD_ID = "field-1";
const PROMPT_ID = "prompt-1";
const OTHER_PROJECT_ID = "project-2";

function fieldRow(overrides: { projectId?: string; archived?: boolean } = {}) {
  return {
    id: FIELD_ID,
    projectId: overrides.projectId ?? PROJECT_ID,
    label: "캠페인",
    archived: overrides.archived ?? false,
    createdBy: OWNER_ID,
    createdAt: new Date(0),
  } as never;
}

function promptRow(overrides: { projectId?: string } = {}) {
  return {
    id: PROMPT_ID,
    projectId: overrides.projectId ?? PROJECT_ID,
    text: "t",
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue(session());
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
  } as never);
  findMembershipMock.mockResolvedValue({
    id: "m1",
    projectId: PROJECT_ID,
    userId: OWNER_ID,
    role: "owner",
    status: "active",
    invitedBy: OWNER_ID,
    invitedAt: new Date(0),
    acceptedAt: new Date(0),
  } as never);
  countFieldUsageMock.mockResolvedValue(0);
  getFieldByIdMock.mockResolvedValue(fieldRow());
  getPromptByIdMock.mockResolvedValue(promptRow());
});

describe("addCustomField", () => {
  it("rejects an empty label", async () => {
    const r = await addCustomField(PROJECT_ID, { label: "  " });
    expect(r.ok).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects a reserved (core fixed-column) label", async () => {
    const r = await addCustomField(PROJECT_ID, { label: "브랜드" });
    expect(r.ok).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();

    // "Category" normalizes to "category" — still a fixed core column.
    const r2 = await addCustomField(PROJECT_ID, { label: "Category" });
    expect(r2.ok).toBe(false);
  });

  it("allows a formerly-reserved framework label (retired to custom fields, WBS 4.1.5)", async () => {
    // listType/depth*/funnelStage were retired from the project UI/Excel and
    // migrated to custom fields (migration 0035), so their labels are no longer
    // reserved — a user can now create/keep e.g. "목록 유형" as a custom field.
    insertMock.mockResolvedValue({ id: FIELD_ID } as never);
    const r = await addCustomField(PROJECT_ID, { label: "목록 유형" });
    expect(r.ok).toBe(true);
  });

  it("trims the label before inserting", async () => {
    insertMock.mockResolvedValue({ id: FIELD_ID } as never);
    const r = await addCustomField(PROJECT_ID, { label: "  캠페인  " });
    expect(r.ok).toBe(true);
    expect(insertMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      label: "캠페인",
      createdBy: OWNER_ID,
    });
  });

  it("translates a unique-label violation into a friendly error", async () => {
    insertMock.mockRejectedValue(new Error("duplicate key value violates unique constraint"));
    const r = await addCustomField(PROJECT_ID, { label: "캠페인" });
    expect(r.ok).toBe(false);
  });

  it("requires Owner — viewer cannot create a field", async () => {
    findMembershipMock.mockResolvedValue({
      id: "m1",
      projectId: PROJECT_ID,
      userId: OWNER_ID,
      role: "viewer",
      status: "active",
      invitedBy: OWNER_ID,
      invitedAt: new Date(0),
      acceptedAt: new Date(0),
    } as never);
    await expect(addCustomField(PROJECT_ID, { label: "캠페인" })).rejects.toThrow();
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("archiveCustomField / restoreCustomField", () => {
  it("archives a field owned by this project", async () => {
    const r = await archiveCustomField(PROJECT_ID, FIELD_ID);
    expect(r.ok).toBe(true);
    expect(archiveMock).toHaveBeenCalledWith(FIELD_ID);
  });

  it("restores a field owned by this project", async () => {
    const r = await restoreCustomField(PROJECT_ID, FIELD_ID);
    expect(r.ok).toBe(true);
    expect(restoreMock).toHaveBeenCalledWith(FIELD_ID);
  });
});

describe("deleteCustomFieldHard", () => {
  // Force delete (2026-07-28): the UI confirms when values exist, so the field
  // + all its assigned values are dropped in one transaction regardless of
  // usage — no server-side usage guard.
  it("force-deletes a field even when still assigned to prompts", async () => {
    countFieldUsageMock.mockResolvedValue(2);
    const r = await deleteCustomFieldHard(PROJECT_ID, FIELD_ID);
    expect(r.ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith(FIELD_ID);
  });

  it("deletes a field with zero usage", async () => {
    countFieldUsageMock.mockResolvedValue(0);
    const r = await deleteCustomFieldHard(PROJECT_ID, FIELD_ID);
    expect(r.ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith(FIELD_ID);
  });
});

describe("setPromptCustomFieldValue / clearPromptCustomFieldValue", () => {
  it("trims and stores a text value", async () => {
    const r = await setPromptCustomFieldValue(PROJECT_ID, PROMPT_ID, FIELD_ID, "  여름  ");
    expect(r.ok).toBe(true);
    expect(setValueMock).toHaveBeenCalledWith(PROMPT_ID, FIELD_ID, "여름");
  });

  it("rejects a blank value", async () => {
    const r = await setPromptCustomFieldValue(PROJECT_ID, PROMPT_ID, FIELD_ID, "   ");
    expect(r.ok).toBe(false);
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it("clears the value", async () => {
    const r = await clearPromptCustomFieldValue(PROJECT_ID, PROMPT_ID, FIELD_ID);
    expect(r.ok).toBe(true);
    expect(clearValueMock).toHaveBeenCalledWith(PROMPT_ID, FIELD_ID);
  });
});

// Cross-project IDOR guard (2026-07-06 QA finding, QA-PRJ-041): requireOwner
// only proves the caller owns *some* project — every action must separately
// verify the fieldId/promptId argument actually belongs to that project.
describe("cross-project ownership guard", () => {
  it("rejects archiveCustomField when fieldId belongs to a different project", async () => {
    getFieldByIdMock.mockResolvedValue(fieldRow({ projectId: OTHER_PROJECT_ID }));
    await expect(archiveCustomField(PROJECT_ID, FIELD_ID)).rejects.toThrow();
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it("rejects deleteCustomFieldHard when fieldId belongs to a different project", async () => {
    getFieldByIdMock.mockResolvedValue(fieldRow({ projectId: OTHER_PROJECT_ID }));
    await expect(deleteCustomFieldHard(PROJECT_ID, FIELD_ID)).rejects.toThrow();
    expect(deleteMock).not.toHaveBeenCalled();
    // must fail closed before even checking usage
    expect(countFieldUsageMock).not.toHaveBeenCalled();
  });

  it("rejects deleteCustomFieldHard when the field id doesn't exist at all", async () => {
    getFieldByIdMock.mockResolvedValue(null);
    await expect(deleteCustomFieldHard(PROJECT_ID, FIELD_ID)).rejects.toThrow();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("rejects setPromptCustomFieldValue when fieldId belongs to a different project", async () => {
    getFieldByIdMock.mockResolvedValue(fieldRow({ projectId: OTHER_PROJECT_ID }));
    await expect(
      setPromptCustomFieldValue(PROJECT_ID, PROMPT_ID, FIELD_ID, "여름"),
    ).rejects.toThrow();
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it("rejects setPromptCustomFieldValue when promptId belongs to a different project", async () => {
    getPromptByIdMock.mockResolvedValue(promptRow({ projectId: OTHER_PROJECT_ID }));
    await expect(
      setPromptCustomFieldValue(PROJECT_ID, PROMPT_ID, FIELD_ID, "여름"),
    ).rejects.toThrow();
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it("rejects clearPromptCustomFieldValue when promptId belongs to a different project", async () => {
    getPromptByIdMock.mockResolvedValue(promptRow({ projectId: OTHER_PROJECT_ID }));
    await expect(
      clearPromptCustomFieldValue(PROJECT_ID, PROMPT_ID, FIELD_ID),
    ).rejects.toThrow();
    expect(clearValueMock).not.toHaveBeenCalled();
  });

  it("allows the action through once field and prompt both resolve to the caller's project", async () => {
    const r = await setPromptCustomFieldValue(PROJECT_ID, PROMPT_ID, FIELD_ID, "여름");
    expect(r.ok).toBe(true);
    expect(setValueMock).toHaveBeenCalledWith(PROMPT_ID, FIELD_ID, "여름");
  });
});
