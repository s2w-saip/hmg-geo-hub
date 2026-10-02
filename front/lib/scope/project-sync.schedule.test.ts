import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/scope/server", () => ({
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  createPrompt: vi.fn(),
  getSchedule: vi.fn(),
  putSchedule: vi.fn(),
}));
vi.mock("@/lib/scope", () => ({ isMockMode: vi.fn(() => false) }));
vi.mock("@/lib/demo", () => ({ isDemoProject: vi.fn(() => false) }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { setScopeProjectId: vi.fn() },
}));

import { getSchedule, putSchedule } from "@/lib/scope/server";
import { isMockMode } from "@/lib/scope";
import { projectRepository } from "@/lib/db/repositories/projects";
import { attachScopeMirror, syncScopeSchedule } from "./project-sync";

const getMock = vi.mocked(getSchedule);
const putMock = vi.mocked(putSchedule);
const P = { id: "local-1", scopeProjectId: "scope-1", aiEngines: ["chatgpt"] as string[] | null };

function row(over: Partial<Awaited<ReturnType<typeof getSchedule>>> = {}) {
  return {
    enabled: false,
    interval_days: 3,
    targets: [] as string[],
    regions: ["KR"],
    prompt_ids: ["p1"],
    last_run_at: null,
    next_run_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: null,
    ...over,
  };
}
const NO_ROW = row({ interval_days: 1, regions: [], prompt_ids: null, created_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isMockMode).mockReturnValue(false);
  putMock.mockResolvedValue(row());
});

describe("syncScopeSchedule", () => {
  it("no row → enabled=true, weekly, targets=selection", async () => {
    getMock.mockResolvedValue(NO_ROW);
    expect(await syncScopeSchedule(P)).toEqual({ pushed: true });
    expect(putMock).toHaveBeenCalledWith("scope-1", {
      enabled: true, interval_days: 7, targets: ["chatgpt"], regions: [], prompt_ids: null,
    });
  });

  it("existing row → preserves enabled/interval/regions/prompt_ids, swaps targets only", async () => {
    getMock.mockResolvedValue(row({ enabled: false, targets: ["chatgpt", "gemini"] }));
    await syncScopeSchedule({ ...P, aiEngines: ["gemini"] });
    expect(putMock).toHaveBeenCalledWith("scope-1", {
      enabled: false, interval_days: 3, targets: ["gemini"], regions: ["KR"], prompt_ids: ["p1"],
    });
  });

  it("zero engines → enabled=false even on a fresh row", async () => {
    getMock.mockResolvedValue(NO_ROW);
    await syncScopeSchedule({ ...P, aiEngines: [] });
    expect(putMock.mock.calls[0][1].enabled).toBe(false);
  });

  it("reenable flips a disabled row back on (0 → N transition)", async () => {
    getMock.mockResolvedValue(row({ enabled: false }));
    await syncScopeSchedule({ ...P, aiEngines: ["chatgpt"] }, { reenable: true });
    expect(putMock.mock.calls[0][1].enabled).toBe(true);
    // without the flag an operator-disabled row stays off
    putMock.mockClear();
    await syncScopeSchedule({ ...P, aiEngines: ["chatgpt"] });
    expect(putMock.mock.calls[0][1].enabled).toBe(false);
  });

  it("legacy NULL selection is pushed as the default targets", async () => {
    getMock.mockResolvedValue(NO_ROW);
    await syncScopeSchedule({ ...P, aiEngines: null });
    expect(putMock.mock.calls[0][1].targets).toEqual(["chatgpt", "gemini"]);
  });

  it("GET failure → nothing is written (no destructive PUT), pushed=false", async () => {
    getMock.mockRejectedValue(new Error("502"));
    expect(await syncScopeSchedule(P)).toEqual({ pushed: false });
    expect(putMock).not.toHaveBeenCalled();
  });

  it("PUT failure → pushed=false, no throw", async () => {
    getMock.mockResolvedValue(NO_ROW);
    putMock.mockRejectedValue(new Error("500"));
    expect(await syncScopeSchedule(P)).toEqual({ pushed: false });
  });

  it("no-op in mock mode / without mirror", async () => {
    vi.mocked(isMockMode).mockReturnValue(true);
    expect(await syncScopeSchedule(P)).toEqual({ pushed: false });
    vi.mocked(isMockMode).mockReturnValue(false);
    expect(await syncScopeSchedule({ ...P, scopeProjectId: null })).toEqual({ pushed: false });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe("attachScopeMirror", () => {
  it("links, then syncs the schedule only when engines are explicit", async () => {
    getMock.mockResolvedValue(NO_ROW);
    await attachScopeMirror("local-1", "scope-9", null);
    expect(projectRepository.setScopeProjectId).toHaveBeenCalledWith("local-1", "scope-9");
    expect(putMock).not.toHaveBeenCalled();
    await attachScopeMirror("local-1", "scope-9", ["deepseek"]);
    expect(putMock).toHaveBeenCalledWith("scope-9", expect.objectContaining({ targets: ["deepseek"], enabled: true }));
  });
});
