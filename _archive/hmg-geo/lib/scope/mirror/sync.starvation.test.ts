import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 2026-09-13 **미러 싱크 전면 정지** 사고의 회귀 테스트.
 *
 * ── 사고 ──────────────────────────────────────────────────────────────────
 * 코어 회차 8 이 measurement_run **1건에 66,144 잡**으로 들어왔다(회차 7 은
 * 1,348 run 분산). 루트는 `orderSyncTargets` 가 항상 맨 앞에 고정하는데, 예산
 * 검사가 **프로젝트 사이에서만** 걸려 루트의 run 루프가 Vercel `maxDuration`
 * 300s 를 통째로 먹었다. 커서 갱신(`recordSyncAttempt`)이 `syncOneProject`
 * **뒤**에 있었으므로 하드킬과 함께 사라졌고 — 216개 **전 프로젝트**의
 * `scope_sync_cursors.last_attempt_at` 이 17:24:42Z 에서 멈췄다(크론 15회분 전부 504).
 *
 * 여기서 못박는 계약 넷:
 *   ① 커서 시도 표시는 프로젝트 작업 **전에** 찍는다 — 킬당해도 로테이션이 전진한다.
 *   ② 한 프로젝트의 예외가 **다음 프로젝트를 굶기지 않는다**.
 *   ③ 상한을 구조적으로 넘는 run 은 **왕복 0으로** 걸러낸다.
 *   ④ jobs 피드가 잘린 run 은 **쓰지 않는다** — 부분 run 이 terminal 로 굳으면 영구 결손이다.
 */

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000001";

const recordSyncAttempt = vi.fn();
const markSyncAttemptStarted = vi.fn();
const replaceRun = vi.fn();
const upsertPrompts = vi.fn();
const listRunJobs = vi.fn();
const listMeasurementRuns = vi.fn();
const listPrompts = vi.fn();
const listAll = vi.fn();
const updateStatusByScopePromptIds = vi.fn();
const mirroredStates = new Map();

vi.mock("@/lib/db/repositories/scope-mirror", () => ({
  scopeMirrorRepository: {
    recordSyncAttempt: (...a: unknown[]) => recordSyncAttempt(...a),
    markSyncAttemptStarted: (...a: unknown[]) => markSyncAttemptStarted(...a),
    replaceRun: (...a: unknown[]) => replaceRun(...a),
    upsertPrompts: (...a: unknown[]) => upsertPrompts(...a),
    mirroredRunStates: async () => mirroredStates,
    lastAttemptByProject: async () => new Map(),
    lastSyncedByProject: async () => new Map(),
  },
}));
vi.mock("@/lib/scope", () => ({
  getScopeClient: () => ({
    listPrompts: (...a: unknown[]) => listPrompts(...a),
    listMeasurementRuns: (...a: unknown[]) => listMeasurementRuns(...a),
    listRunJobs: (...a: unknown[]) => listRunJobs(...a),
    getQueryRun: async () => ({ result: null }),
  }),
}));
vi.mock("@/lib/scope/result-adapter", () => ({ getRootConfig: () => ({ projectId: ROOT }) }));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { listAll: () => listAll() },
}));
vi.mock("@/lib/db/repositories/prompts", () => ({
  promptRepository: { updateStatusByScopePromptIds: (...a: unknown[]) => updateStatusByScopePromptIds(...a) },
}));
vi.mock("@/lib/db/repositories/website-sites", () => ({
  getWebsiteScopeProjectIds: async () => [],
}));
vi.mock("@/lib/db/repositories/project-tracked-dictionary", () => ({
  getProjectTrackedDictionary: async () => null,
}));

const { syncStandardMirror, mirrorJobCapacity, isOversizedRun } = await import("./sync");

const page = <T,>(data: T[]) => ({ data, next_cursor: null });
/** 상한을 절대 못 채우는 정상 크기 run. */
const smallRun = (runId: string) => ({
  measurement_run_id: runId,
  project_id: undefined,
  status: "completed",
  started_at: "2026-09-13T00:00:00.000Z",
  completed_at: null,
  total_jobs: 10,
});
const completedJob = (jobId: string, promptId: string) => ({
  job_id: jobId,
  prompt_id: promptId,
  prompt_run_id: undefined,
  target: "chatgpt",
  region: null,
  status: "completed",
  measured_at: "2026-09-13T00:00:00.000Z",
  result: { answer_text: "ok", citations: [] },
  analysis: { resolved_mentions: [] },
});

beforeEach(() => {
  recordSyncAttempt.mockReset().mockResolvedValue(undefined);
  markSyncAttemptStarted.mockReset().mockResolvedValue(undefined);
  replaceRun.mockReset().mockResolvedValue(undefined);
  upsertPrompts.mockReset().mockResolvedValue(undefined);
  listPrompts.mockReset().mockResolvedValue(page([]));
  listMeasurementRuns.mockReset().mockResolvedValue(page([]));
  listRunJobs.mockReset().mockResolvedValue(page([]));
  listAll.mockReset().mockResolvedValue([{ id: "local-1", scopeProjectId: OTHER }]);
  updateStatusByScopePromptIds.mockReset().mockResolvedValue(0);
  mirroredStates.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("① 커서 시도 표시는 프로젝트 작업 **전에** 찍는다", () => {
  it("선기록이 그 프로젝트의 scope 호출보다 먼저 불린다", async () => {
    const order: string[] = [];
    markSyncAttemptStarted.mockImplementation(async (id: string) => {
      order.push(`start:${id}`);
    });
    listPrompts.mockImplementation(async (id: string) => {
      order.push(`prompts:${id}`);
      return page([]);
    });

    await syncStandardMirror();

    // 루트가 첫 순번 — 그 프로젝트의 첫 scope 왕복보다 커서가 앞선다.
    expect(order[0]).toBe(`start:${ROOT}`);
    expect(order[1]).toBe(`prompts:${ROOT}`);
  });

  it("하드킬을 흉내내도(첫 프로젝트에서 throw) 그 프로젝트 커서는 이미 찍혀 있다", async () => {
    // 선기록이 없으면 이 프로젝트는 다음 패스에도 같은 앞순번을 점유한다.
    listPrompts.mockImplementation(async (id: string) => {
      if (id === ROOT) throw new Error("boom");
      return page([]);
    });

    await syncStandardMirror();

    expect(markSyncAttemptStarted.mock.calls.filter((c) => c[0] === ROOT).length).toBe(1);
    const rootCalls = recordSyncAttempt.mock.calls.filter((c) => c[0] === ROOT);
    expect(rootCalls.length).toBe(1);
    expect(String(rootCalls[0][1])).toContain("boom");
  });

  // ── R2 (2026-09-13 리뷰) ────────────────────────────────────────────────
  // 선기록이 last_error 를 NULL 로 덮으면, 그 패스가 하드킬당했을 때 직전 실패
  // 사유가 사라진다. 이번 사고를 잡아낸 단서가 정확히 그 값이었다.
  it("★ 선기록은 last_error 를 건드리지 않는다 — recordSyncAttempt(pid, null) 이 아니다", async () => {
    await syncStandardMirror();

    // 선기록 경로는 error 인자를 아예 받지 않는다.
    expect(markSyncAttemptStarted).toHaveBeenCalledWith(ROOT);
    expect(markSyncAttemptStarted.mock.calls.every((c) => c.length === 1)).toBe(true);
    // 성공 시에만 recordSyncAttempt(pid, null) 로 **해소**한다.
    expect(recordSyncAttempt).toHaveBeenCalledWith(ROOT, null);
  });

  it("선기록이 실패해도 싱크는 계속된다 — 커서 쓰기가 싱크를 깨뜨리지 않는다", async () => {
    markSyncAttemptStarted.mockRejectedValue(new Error("cursor down"));

    const r = await syncStandardMirror();

    expect(listPrompts.mock.calls.some((c) => c[0] === ROOT)).toBe(true);
    expect(r.perProject.find((p) => p.projectId === ROOT)?.error).toBeUndefined();
  });
});

describe("② 한 프로젝트의 실패가 다음 프로젝트를 굶기지 않는다", () => {
  it("루트가 던져도 나머지 프로젝트는 돌고 커서를 받는다", async () => {
    listPrompts.mockImplementation(async (id: string) => {
      if (id === ROOT) throw new Error("ACR 23505");
      return page([]);
    });

    const r = await syncStandardMirror();

    expect(r.perProject.find((p) => p.projectId === ROOT)?.error).toContain("ACR 23505");
    // 두 번째 프로젝트가 실제로 돌았다.
    expect(listPrompts.mock.calls.some((c) => c[0] === OTHER)).toBe(true);
    expect(recordSyncAttempt.mock.calls.some((c) => c[0] === OTHER)).toBe(true);
  });

  it("커서에는 PG 사유가 **앞에** 남는다 — drizzle 파라미터 덤프에 묻히지 않는다", async () => {
    // 실제 사고: message 253,517자(파라미터 전량), 원인은 cause 에만 있었다.
    const err = new Error(`Failed query: insert into "scope_acr_rollups" ${"$x, ".repeat(50_000)}`);
    (err as Error & { cause: unknown }).cause = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "scope_acr_rollups_pkey"',
      detail: "Key (prompt_run_id, entity_id)=(pr-1, e-1) already exists.",
    };
    listPrompts.mockImplementation(async (id: string) => {
      if (id === ROOT) throw err;
      return page([]);
    });

    await syncStandardMirror();

    const msg = String(
      recordSyncAttempt.mock.calls.filter((c) => c[0] === ROOT).at(-1)?.[1] ?? "",
    );
    expect(msg.slice(0, 200)).toContain("23505");
    expect(msg.slice(0, 200)).toContain("duplicate key value");
    // 커서 행이 250KB 로 붓지 않는다.
    expect(msg.length).toBeLessThanOrEqual(2_000);
  });

  it("root의 프로젝트 예산이 먼저 소진돼도 다음 프로젝트가 같은 패스에서 진행된다", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    listPrompts.mockImplementation(async (id: string) => {
      order.push(id);
      if (id === ROOT) await new Promise((resolve) => setTimeout(resolve, 100));
      return page([]);
    });

    const pending = syncStandardMirror({ budgetMs: 500, projectBudgetMs: 50 });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(51);
    const r = await pending;
    vi.clearAllTimers();

    expect(order).toEqual([ROOT, OTHER]);
    expect(r.budgetStoppedProjects).toContain(ROOT);
    expect(r.perProject.some((p) => p.projectId === OTHER)).toBe(true);
  });

  it("run 중 deadline은 앞서 커밋한 run의 카운터를 잃지 않고 현재 run만 재시도한다", async () => {
    vi.useFakeTimers();
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page([smallRun("run-written"), smallRun("run-timeout")]) : page([]),
    );
    listRunJobs.mockImplementation(async (_projectId: string, runId: string) => {
      if (runId === "run-timeout") await new Promise((resolve) => setTimeout(resolve, 25_000));
      return page([]);
    });

    // Allow the upfront cost estimate; expire during the second run read.
    const pending = syncStandardMirror({
      budgetMs: 30_000,
      projectBudgetMs: 20_000,
      projectIds: [ROOT],
    });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(20_001);
    const r = await pending;
    vi.clearAllTimers();

    expect(listRunJobs).toHaveBeenCalledTimes(2);
    expect(r.runs).toBe(1);
    expect(replaceRun).toHaveBeenCalledTimes(1);
    expect(r.budgetStoppedProjects).toContain(ROOT);
  });

  it("deadline 뒤 catalog flush는 성공 run 상태만 반영한다", async () => {
    vi.useFakeTimers();
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page([smallRun("run-written"), smallRun("run-timeout")]) : page([]),
    );
    listRunJobs.mockImplementation(async (_projectId: string, runId: string) => {
      if (runId === "run-timeout") await new Promise((resolve) => setTimeout(resolve, 25_000));
      return page([completedJob(`job-${runId}`, `prompt-${runId}`)]);
    });

    // Allow the upfront cost estimate; expire during the second run read.
    const pending = syncStandardMirror({
      budgetMs: 30_000,
      projectBudgetMs: 20_000,
      projectIds: [ROOT],
    });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(20_001);
    const r = await pending;
    vi.clearAllTimers();

    expect(listRunJobs).toHaveBeenCalledTimes(2);
    expect(r.runs).toBe(1);
    expect(updateStatusByScopePromptIds).toHaveBeenCalledTimes(1);
    expect(updateStatusByScopePromptIds).toHaveBeenCalledWith([
      { scopePromptId: "prompt-run-written", status: "done" },
    ]);
    expect(updateStatusByScopePromptIds.mock.calls[0][0]).not.toEqual(
      expect.arrayContaining([{ scopePromptId: "prompt-run-timeout", status: "done" }]),
    );
  });
});

describe("⑤ maxRuns 절단은 다음 eligible run을 표면화한다", () => {
  it("한도에 닿고 다음 eligible run이 있으면 runLimitHits를 남긴다", async () => {
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT
        ? page([smallRun("run-1"), smallRun("run-2")])
        : page([]),
    );

    const r = await syncStandardMirror({ maxRuns: 1, projectIds: [ROOT] });

    expect(r.runs).toBe(1);
    expect(r.runLimitHits).toEqual([{ projectId: ROOT, nextRunId: "run-2" }]);
  });

  it("한도에 닿아도 다음 eligible run이 없으면 hit을 만들지 않는다", async () => {
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page([smallRun("run-only")]) : page([]),
    );

    const r = await syncStandardMirror({ maxRuns: 1, projectIds: [ROOT] });

    expect(r.runs).toBe(1);
    expect(r.runLimitHits).toEqual([]);
  });

  it("maxRuns 뒤 terminal watermark만 남으면 runLimitHits를 만들지 않는다", async () => {
    const cutoff = "run-cutoff";
    mirroredStates.set(cutoff, {
      status: "completed",
      hasUnresolved: false,
      recheckable: false,
      syncedAt: new Date("2026-09-13T00:00:00.000Z"),
    });
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page([smallRun("run-written"), smallRun(cutoff)]) : page([]),
    );

    const r = await syncStandardMirror({ maxRuns: 1, projectIds: [ROOT] });

    expect(r.runs).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.runLimitHits).toEqual([]);
  });

  it("maxRuns 뒤 oversized run만 남으면 oversized 진단은 유지하고 runLimitHits는 비운다", async () => {
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT
        ? page([smallRun("run-written"), { ...smallRun("run-big"), total_jobs: 99_999 }])
        : page([]),
    );

    const r = await syncStandardMirror({ maxRuns: 1, projectIds: [ROOT] });

    expect(r.runs).toBe(1);
    expect(r.oversizedRuns).toEqual([
      { projectId: ROOT, runId: "run-big", totalJobs: 99_999 },
    ]);
    expect(r.runLimitHits).toEqual([]);
  });

  it("maxRuns 뒤 recheck cap만 남으면 recheckCapHits를 유지하고 runLimitHits는 비운다", async () => {
    const priorRuns = Array.from({ length: 25 }, (_, index) => `run-prior-${index}`);
    for (const runId of [...priorRuns, "run-tail"]) {
      mirroredStates.set(runId, {
        status: "completed",
        hasUnresolved: true,
        recheckable: true,
        syncedAt: new Date("2026-09-13T00:00:00.000Z"),
      });
    }
    const runs = [
      ...priorRuns.map((runId) => smallRun(runId)),
      smallRun("run-written"),
      smallRun("run-tail"),
    ];
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page(runs) : page([]),
    );

    const r = await syncStandardMirror({ maxRuns: 26, projectIds: [ROOT] });

    expect(r.runs).toBe(26);
    expect(r.recheckCapHits).toEqual([ROOT]);
    expect(r.runLimitHits).toEqual([]);
  });
});

describe("③ 상한을 구조적으로 넘는 run 은 왕복 0으로 걸러낸다", () => {
  it("total_jobs 가 상한 초과면 listRunJobs 도 replaceRun 도 부르지 않는다", async () => {
    const big = { ...smallRun("3353963e-3b35-40a1-b99c-a236ca35df3c"), total_jobs: 66_144 };
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page([big]) : page([]),
    );

    const r = await syncStandardMirror();

    expect(listRunJobs).not.toHaveBeenCalled();
    expect(replaceRun).not.toHaveBeenCalled();
    expect(r.oversizedRuns).toEqual([
      { projectId: ROOT, runId: "3353963e-3b35-40a1-b99c-a236ca35df3c", totalJobs: 66_144 },
    ]);
  });

  it("상한 이하의 run 은 종전대로 미러된다 — 회귀 방지", async () => {
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page([smallRun("run-ok")]) : page([]),
    );

    const r = await syncStandardMirror();

    expect(listRunJobs).toHaveBeenCalled();
    expect(replaceRun).toHaveBeenCalledTimes(1);
    expect(r.oversizedRuns).toEqual([]);
    expect(r.runs).toBe(1);
  });

  it("isOversizedRun 은 상한 **초과**만 참 — 경계값은 통과시킨다", () => {
    const cap = mirrorJobCapacity();
    expect(cap).toBe(10_000); // MIRROR_JOB_MAX_PAGES(50) × 200
    expect(isOversizedRun(cap)).toBe(false);
    expect(isOversizedRun(cap + 1)).toBe(true);
    // total_jobs 를 모르면 막지 않는다 — 모른다고 버리면 정상 run 이 사라진다.
    expect(isOversizedRun(null)).toBe(false);
    expect(isOversizedRun(undefined)).toBe(false);
  });
});

describe("④ jobs 피드가 잘린 run 은 쓰지 않는다", () => {
  it("truncated 면 replaceRun 을 부르지 않고 truncatedRuns 로 표면화한다", async () => {
    // total_jobs 는 상한 이하로 보고됐지만 실제 피드가 계속 이어지는 경우
    // (코어가 total_jobs 를 늦게 갱신하는 창). 부분 run 을 terminal 로 굳히면
    // `shouldSkipMirroredRun` 이 다음 패스부터 영원히 skip 한다 = 영구 결손.
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page([smallRun("run-trunc")]) : page([]),
    );
    listRunJobs.mockResolvedValue({ data: [], next_cursor: "still-more" });

    const r = await syncStandardMirror();

    expect(replaceRun).not.toHaveBeenCalled();
    expect(r.truncatedRuns).toEqual([{ projectId: ROOT, runId: "run-trunc" }]);
    expect(r.pageCapHits).toContainEqual({ projectId: ROOT, kind: "jobs" });
  });

  it("조용한 결손은 예외가 없어도 커서 last_error 에 남는다", async () => {
    listMeasurementRuns.mockImplementation(async (id: string) =>
      id === ROOT ? page([{ ...smallRun("run-big"), total_jobs: 99_999 }]) : page([]),
    );

    await syncStandardMirror();

    const msg = String(
      recordSyncAttempt.mock.calls.filter((c) => c[0] === ROOT).at(-1)?.[1] ?? "",
    );
    expect(msg).toContain("[attention]");
    expect(msg).toContain("oversized run(s) skipped");
    expect(msg).toContain("run-big");
  });
});
