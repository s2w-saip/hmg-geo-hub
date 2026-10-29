/**
 * `promptsUpdatedFrom` 이 **실제로 scope 호출에 실려 나가는지**를 실행으로 확인한다.
 *
 * 타입만 뚫어두고 호출부에서 안 넘기면 조용히 무시된다 — "창을 걸었다고 믿는데
 * 실제로는 최신 5,000 만 보는" 패스가 된다. 그게 이 옵션이 고치려는 결함 자체와
 * 같은 모양이라, 배선을 결과로 고정한다(#140 의 자세).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listPrompts: vi.fn(),
  listMeasurementRuns: vi.fn(),
  listRunJobs: vi.fn(),
  mirroredRunStates: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/scope", () => ({
  getScopeClient: () => ({
    listPrompts: h.listPrompts,
    listMeasurementRuns: h.listMeasurementRuns,
    listRunJobs: h.listRunJobs,
  }),
}));
vi.mock("@/lib/scope/result-adapter", () => ({
  getRootConfig: () => ({ projectId: "root", scopeApiKey: "k", baseUrl: "u" }),
}));
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: { listAll: async () => [] } }));
vi.mock("@/lib/db/repositories/website-sites", () => ({ getWebsiteScopeProjectIds: async () => [] }));
vi.mock("@/lib/db/repositories/prompts", () => ({ promptRepository: { setStatusesByScopeIds: async () => 0 } }));
vi.mock("@/lib/db/repositories/project-tracked-dictionary", () => ({ getProjectTrackedDictionary: async () => null }));
vi.mock("@/lib/db/repositories/scope-mirror", () => ({
  scopeMirrorRepository: {
    mirroredRunStates: h.mirroredRunStates,
    upsertPrompts: async () => {},
    replaceRun: async () => {},
    lastAttemptByProject: async () => new Map(),
    lastSyncedByProject: async () => new Map(),
    markAttempt: async () => {},
    recordSyncAttempt: async () => {},
    markSyncAttemptStarted: async () => {},
  },
}));

import { syncStandardMirror } from "./sync";

beforeEach(() => {
  vi.clearAllMocks();
  h.listPrompts.mockResolvedValue({ data: [], next_cursor: null });
  h.listMeasurementRuns.mockResolvedValue({ data: [], next_cursor: null });
  h.listRunJobs.mockResolvedValue({ data: [], next_cursor: null });
  h.mirroredRunStates.mockResolvedValue(new Map());
});

/** listPrompts 에 실제로 전달된 query 객체. */
const lastPromptQuery = () => h.listPrompts.mock.calls.at(-1)?.[1];

describe("promptsUpdatedFrom 배선", () => {
  it("지정하면 scope 호출에 updated_from 으로 실려 나간다", async () => {
    await syncStandardMirror({ promptsUpdatedFrom: "2026-08-01T00:00:00Z" });
    expect(lastPromptQuery()).toMatchObject({ updated_from: "2026-08-01T00:00:00Z" });
  });

  it("미지정이면 updated_from 을 붙이지 않는다 — 정규 크론 동작 불변", async () => {
    await syncStandardMirror({});
    expect(lastPromptQuery()).not.toHaveProperty("updated_from");
  });

  it("limit 100 과 커서 페이지네이션은 그대로다", async () => {
    await syncStandardMirror({ promptsUpdatedFrom: "2026-08-01T00:00:00Z" });
    expect(lastPromptQuery()).toMatchObject({ limit: 100 });
  });

  it("promptsUpdatedTo 도 updated_to 로 실려 나간다 — from 만으로는 절단이 안 풀린다", async () => {
    await syncStandardMirror({
      promptsUpdatedFrom: "2026-06-01T00:00:00Z",
      promptsUpdatedTo: "2026-07-01T00:00:00Z",
    });
    expect(lastPromptQuery()).toMatchObject({
      updated_from: "2026-06-01T00:00:00Z",
      updated_to: "2026-07-01T00:00:00Z",
    });
  });

  it("to 미지정이면 updated_to 를 붙이지 않는다", async () => {
    await syncStandardMirror({ promptsUpdatedFrom: "2026-06-01T00:00:00Z" });
    expect(lastPromptQuery()).not.toHaveProperty("updated_to");
  });

  it("force·resyncBefore 와 함께 써도 창이 유지된다", async () => {
    await syncStandardMirror({
      force: true,
      resyncBefore: new Date("2026-09-01T00:00:00Z"),
      promptsUpdatedFrom: "2026-08-01T00:00:00Z",
    });
    expect(lastPromptQuery()).toMatchObject({ updated_from: "2026-08-01T00:00:00Z" });
  });
});
