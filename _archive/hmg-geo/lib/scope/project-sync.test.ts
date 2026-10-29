import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScopeMirror,
  pushScopeUpdate,
  deleteScopeMirror,
  pushDraftPromptsToScope,
  type LocalProjectForSync,
  type DraftPromptForSync,
} from "@/lib/scope/project-sync";

// Mock the scope gateway + mode selector so these stay pure unit tests of the
// mapping + best-effort/mock-guard behavior (no session, no real client).
const createProject = vi.fn();
const updateProject = vi.fn();
const deleteProject = vi.fn();
const createPrompt = vi.fn();
const isMockMode = vi.fn();

vi.mock("@/lib/scope/server", () => ({
  createProject: (...a: unknown[]) => createProject(...a),
  updateProject: (...a: unknown[]) => updateProject(...a),
  deleteProject: (...a: unknown[]) => deleteProject(...a),
  createPrompt: (...a: unknown[]) => createPrompt(...a),
}));
vi.mock("@/lib/scope", () => ({ isMockMode: () => isMockMode() }));

const base: LocalProjectForSync = {
  id: "local-1",
  name: "현대차 GEO",
  domain: "hyundai.com",
  brand: "Hyundai",
  country: "KR",
  scopeProjectId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  isMockMode.mockReturnValue(false); // default: live
});

describe("mock mode is a no-op (live-only mirror)", () => {
  beforeEach(() => isMockMode.mockReturnValue(true));

  it("createScopeMirror reports `skipped` (not a failure) and never calls scope", async () => {
    expect(await createScopeMirror(base)).toEqual({ status: "skipped" });
    expect(createProject).not.toHaveBeenCalled();
  });
  it("pushScopeUpdate is inert", async () => {
    expect(await pushScopeUpdate({ ...base, scopeProjectId: "s-1" })).toEqual({
      newScopeProjectId: null,
    });
    expect(updateProject).not.toHaveBeenCalled();
  });
  it("deleteScopeMirror never calls scope", async () => {
    await deleteScopeMirror("s-1");
    expect(deleteProject).not.toHaveBeenCalled();
  });
});

describe("createScopeMirror (live)", () => {
  it("maps brand→tracked_brands, country→regions and returns the scope id", async () => {
    createProject.mockResolvedValue({ project_id: "scope-uuid-1" });
    const outcome = await createScopeMirror(base);
    expect(outcome).toEqual({ status: "created", scopeProjectId: "scope-uuid-1" });
    expect(createProject).toHaveBeenCalledWith({
      name: "현대차 GEO",
      domain: "hyundai.com",
      tracked_brands: [{ brand_name: "Hyundai" }],
      regions: ["KR"],
    });
  });

  it("mirrors a brand-less project with empty tracked_brands (scope allows [])", async () => {
    createProject.mockResolvedValue({ project_id: "scope-uuid-2" });
    await createScopeMirror({ ...base, brand: null, domain: null });
    expect(createProject).toHaveBeenCalledWith({
      name: "현대차 GEO",
      domain: undefined,
      tracked_brands: [],
      regions: ["KR"],
    });
  });

  // 2026-08-15~19 scope 장애 회귀 방지: 실패는 `failed` 로 **구분되어** 나와야
  // 한다. 옛 시그니처는 mock 무동작과 같은 null 이라 호출자가 성공으로 취급했다.
  it("reports `failed` (distinct from `skipped`) when scope rejects", async () => {
    createProject.mockRejectedValue(new Error("scope 503"));
    expect(await createScopeMirror(base)).toEqual({ status: "failed" });
  });
});

describe("pushScopeUpdate (live)", () => {
  it("updates an already-mirrored project, no new id", async () => {
    updateProject.mockResolvedValue({});
    const res = await pushScopeUpdate({ ...base, scopeProjectId: "s-1", brand: "Kia" });
    expect(updateProject).toHaveBeenCalledWith("s-1", {
      name: "현대차 GEO",
      domain: "hyundai.com",
      tracked_brands: [{ brand_name: "Kia" }],
    });
    expect(res).toEqual({ newScopeProjectId: null });
  });

  it("creates the mirror lazily when not yet linked, returning the new id", async () => {
    createProject.mockResolvedValue({ project_id: "scope-uuid-3" });
    const res = await pushScopeUpdate({ ...base, scopeProjectId: null });
    expect(res).toEqual({ newScopeProjectId: "scope-uuid-3" });
    expect(createProject).toHaveBeenCalledOnce();
  });

  it("swallows update failures", async () => {
    updateProject.mockRejectedValue(new Error("scope 500"));
    const res = await pushScopeUpdate({ ...base, scopeProjectId: "s-1" });
    expect(res).toEqual({ newScopeProjectId: null });
  });
});

describe("deleteScopeMirror (live)", () => {
  it("deletes the scope project when linked", async () => {
    deleteProject.mockResolvedValue(undefined);
    await deleteScopeMirror("s-1");
    expect(deleteProject).toHaveBeenCalledWith("s-1");
  });
  it("is a no-op when unlinked", async () => {
    await deleteScopeMirror(null);
    expect(deleteProject).not.toHaveBeenCalled();
  });
  it("swallows delete failures", async () => {
    deleteProject.mockRejectedValue(new Error("scope 500"));
    await expect(deleteScopeMirror("s-1")).resolves.toBeUndefined();
  });
});

describe("pushDraftPromptsToScope", () => {
  const drafts: DraftPromptForSync[] = [
    { id: "p1", text: "제네시스 전기차 추천", brand: "Genesis", category: "차종", scopePromptId: null },
    { id: "p2", text: "아이오닉 vs EV6", brand: "Hyundai", category: null, scopePromptId: null },
  ];

  // Fresh persist spies per test; also record call ORDER relative to createPrompt
  // so we can assert each id is saved before the next push (crash-safety).
  let onMirrorCreated: ReturnType<typeof vi.fn>;
  let onPromptPushed: ReturnType<typeof vi.fn>;
  let order: string[];
  beforeEach(() => {
    order = [];
    createPrompt.mockImplementation(async (_pid: string, input: { text: string }) => {
      order.push(`push:${input.text}`);
      return { prompt_id: `sp-for-${input.text}` };
    });
    onMirrorCreated = vi.fn(async (id: string) => void order.push(`mirror:${id}`));
    onPromptPushed = vi.fn(async (localId: string) => void order.push(`persist:${localId}`));
  });
  const persist = () => ({ onMirrorCreated, onPromptPushed });

  it("is a no-op in mock mode, flagged `skipped` so the caller still enqueues", async () => {
    isMockMode.mockReturnValue(true);
    const res = await pushDraftPromptsToScope({ ...base, scopeProjectId: "s-1" }, drafts, persist());
    expect(res).toEqual({ pushedCount: 0, pushedIds: [], failedCount: 0, skipped: true });
    expect(createPrompt).not.toHaveBeenCalled();
    expect(onPromptPushed).not.toHaveBeenCalled();
  });

  it("is a no-op when there are no drafts", async () => {
    const res = await pushDraftPromptsToScope({ ...base, scopeProjectId: "s-1" }, [], persist());
    expect(res).toEqual({ pushedCount: 0, pushedIds: [], failedCount: 0, skipped: false });
    expect(createPrompt).not.toHaveBeenCalled();
  });

  it("pushes each draft to the existing mirror and encodes hmg: keywords", async () => {
    const res = await pushDraftPromptsToScope({ ...base, scopeProjectId: "s-1" }, drafts, persist());
    expect(createPrompt).toHaveBeenNthCalledWith(1, "s-1", {
      text: "제네시스 전기차 추천",
      keywords: ["hmg:brand:Genesis", "hmg:category:차종"],
    });
    expect(createPrompt).toHaveBeenNthCalledWith(2, "s-1", {
      text: "아이오닉 vs EV6",
      keywords: ["hmg:brand:Hyundai"],
    });
    expect(res).toEqual({
      pushedCount: 2,
      pushedIds: ["p1", "p2"],
      failedCount: 0,
      skipped: false,
    });
    expect(onPromptPushed).toHaveBeenNthCalledWith(1, "p1", "sp-for-제네시스 전기차 추천");
    expect(onPromptPushed).toHaveBeenNthCalledWith(2, "p2", "sp-for-아이오닉 vs EV6");
  });

  it("persists each id immediately — before the next push (crash-safe)", async () => {
    await pushDraftPromptsToScope({ ...base, scopeProjectId: "s-1" }, drafts, persist());
    // Interleaved, not batched: p1 is persisted before p2 is pushed.
    expect(order).toEqual([
      "push:제네시스 전기차 추천",
      "persist:p1",
      "push:아이오닉 vs EV6",
      "persist:p2",
    ]);
  });

  it("creates the mirror lazily and persists the link before any push", async () => {
    createProject.mockResolvedValue({ project_id: "scope-new" });
    const res = await pushDraftPromptsToScope({ ...base, scopeProjectId: null }, [drafts[0]], persist());
    expect(createProject).toHaveBeenCalledOnce();
    expect(onMirrorCreated).toHaveBeenCalledWith("scope-new");
    expect(createPrompt).toHaveBeenCalledWith("scope-new", expect.anything());
    // mirror link saved before the first prompt is pushed.
    expect(order).toEqual(["mirror:scope-new", "push:제네시스 전기차 추천", "persist:p1"]);
    expect(res.pushedCount).toBe(1);
  });

  // 고아 6건의 회귀 테스트: 미러 생성 실패는 skipped=false + failedCount>0 으로
  // 나와야 한다. 호출자(executePrompts)는 이걸 보고 프롬프트를 draft 로 남긴다 —
  // queued 로 넘기면 RUN 재시도 경로가 사라져 영구 고아가 된다.
  it("bails without pushing when the mirror can't be created, and reports the failure", async () => {
    createProject.mockRejectedValue(new Error("scope 503"));
    const res = await pushDraftPromptsToScope({ ...base, scopeProjectId: null }, drafts, persist());
    expect(createPrompt).not.toHaveBeenCalled();
    expect(onMirrorCreated).not.toHaveBeenCalled();
    expect(res).toEqual({
      pushedCount: 0,
      pushedIds: [],
      failedCount: drafts.length,
      skipped: false,
    });
  });

  it("skips already-mirrored drafts (idempotent re-RUN)", async () => {
    const res = await pushDraftPromptsToScope(
      { ...base, scopeProjectId: "s-1" },
      [{ ...drafts[0], scopePromptId: "sp-existing" }],
      persist(),
    );
    expect(createPrompt).not.toHaveBeenCalled();
    expect(onPromptPushed).not.toHaveBeenCalled();
    expect(res.pushedCount).toBe(0);
  });

  it("swallows a per-prompt push failure and still persists the others", async () => {
    createPrompt.mockReset();
    createPrompt
      .mockRejectedValueOnce(new Error("scope 500"))
      .mockResolvedValueOnce({ prompt_id: "sp-2" });
    const res = await pushDraftPromptsToScope({ ...base, scopeProjectId: "s-1" }, drafts, persist());
    expect(res.pushedCount).toBe(1);
    // 부분 실패: 성공분만 pushedIds 에 담긴다 → 호출자가 p1 을 draft 로 남긴다.
    expect(res.pushedIds).toEqual(["p2"]);
    expect(res.failedCount).toBe(1);
    expect(res.skipped).toBe(false);
    expect(onPromptPushed).toHaveBeenCalledOnce();
    expect(onPromptPushed).toHaveBeenCalledWith("p2", "sp-2");
  });
});
