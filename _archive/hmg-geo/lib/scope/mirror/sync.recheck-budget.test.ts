import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 2026-09-14 **크론 16틱 연속 300s 타임아웃**(이슈 #262)의 회귀 테스트.
 *
 * ── 사고 ──────────────────────────────────────────────────────────────────
 * 18:00Z 부터 23:00Z 까지 `/api/cron/sync-mirror` 가 매 틱
 * `Task timed out after 300 seconds` 로 죽었다(수동 호출도 504).
 *
 * 사슬:
 *   ① terminal 이지만 failed 답변이 남은 run 은 `shouldSkipMirroredRun` 이
 *      skip 하지 않는다 → 재확인 창(3일) 동안 **매 틱 전량 재당김**된다.
 *   ② 상한은 건수(`RECHECK_MAX_RUNS_PER_PASS` 25)뿐이고 **크기 상한이 없었다** —
 *      2,170 잡(11페이지) · 1,000 잡(5페이지) 짜리가 매 패스 include=result,
 *      occurrences 로 넘어왔다. 오버사이즈 가드(capacity 10,000)는 못 막는다.
 *   ③ 예산 검사는 `Date.now() > deadlineAt`, 즉 **이미 초과했는가**뿐이라
 *      경계 직전에 시작한 run 이 300s 를 넘겼다 → 하드킬 → tx 롤백 →
 *      다음 틱이 같은 run 을 다시 시작 → 영구 반복.
 *
 * 여기서 못박는 계약 둘:
 *   ① **재확인**만 잡 수 상한을 본다 — 신규 run·상태 변경 run·force 는 안 본다.
 *   ② 남은 예산 < 예상 비용이면 그 run 을 **시작하지 않는다**(budgetStopped).
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
const mirroredRunStates = vi.fn();

vi.mock("@/lib/db/repositories/scope-mirror", () => ({
  scopeMirrorRepository: {
    recordSyncAttempt: (...a: unknown[]) => recordSyncAttempt(...a),
    markSyncAttemptStarted: (...a: unknown[]) => markSyncAttemptStarted(...a),
    replaceRun: (...a: unknown[]) => replaceRun(...a),
    upsertPrompts: (...a: unknown[]) => upsertPrompts(...a),
    mirroredRunStates: () => mirroredRunStates(),
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
  promptRepository: { updateStatusByScopePromptIds: async () => 0 },
}));
vi.mock("@/lib/db/repositories/website-sites", () => ({
  getWebsiteScopeProjectIds: async () => [],
}));
vi.mock("@/lib/db/repositories/project-tracked-dictionary", () => ({
  getProjectTrackedDictionary: async () => null,
}));

const {
  syncStandardMirror,
  shouldDeferHeavyRecheck,
  shouldStopBeforeRun,
  estimateRunPullMs,
  jobPageAvgMs,
  createPassPacing,
  recordJobPageSample,
  MIRROR_JOB_PAGE_MS_FLOOR,
  MIRROR_RECHECK_MAX_JOBS,
  MIRROR_JOB_PAGE_MS_FALLBACK,
  MIRROR_REPLACE_RUN_COST_MS,
  MIRROR_JOB_PAGE_LIMIT,
  mirrorJobCapacity,
} = await import("./sync");

const page = <T,>(data: T[]) => ({ data, next_cursor: null });
/** 최소 형태의 job n개. status=failed 라 `getQueryRun` 폴백을 타지 않는다. */
const jobsPage = (n: number) =>
  page(
    Array.from({ length: n }, (_, i) => ({
      job_id: `job-${i}`,
      prompt_id: `p-${i}`,
      target: "chatgpt",
      region: "KR",
      status: "failed",
      measured_at: "2026-09-14T18:00:00.000Z",
    })),
  );
const run = (runId: string, totalJobs: number, status = "completed") => ({
  measurement_run_id: runId,
  project_id: undefined,
  status,
  started_at: "2026-09-14T18:00:00.000Z",
  completed_at: null,
  total_jobs: totalJobs,
});
/** 이미 미러돼 있고 미완 답변이 남아 **재확인 대상**인 run 의 상태. */
const priorRecheckable = (status = "completed") => ({
  status,
  hasUnresolved: true,
  recheckable: true,
  syncedAt: new Date("2026-09-14T17:00:00.000Z"),
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
  mirroredRunStates.mockReset().mockResolvedValue(new Map());
});

/** 루트에만 이 run 들을 태운다. */
function rootRuns(...runs: ReturnType<typeof run>[]) {
  listMeasurementRuns.mockImplementation(async (id: string) =>
    id === ROOT ? page(runs) : page([]),
  );
}

describe("① 재확인 잡 수 상한 — 순수 함수", () => {
  it("기본 상한은 500 이다", () => {
    expect(MIRROR_RECHECK_MAX_JOBS).toBe(500);
  });

  it("상한을 넘는 **재확인**은 미룬다 (status 무변경 + prior 존재)", () => {
    expect(shouldDeferHeavyRecheck(priorRecheckable(), "completed", 2_170)).toBe(true);
  });

  it("상태가 바뀐 run 은 크기와 무관하게 당긴다 — 종전 규칙 보존", () => {
    expect(shouldDeferHeavyRecheck(priorRecheckable("running"), "completed", 66_144)).toBe(
      false,
    );
  });

  it("처음 보는 run(prior 없음)은 미루지 않는다 — 신규 데이터가 밀리면 안 된다", () => {
    expect(shouldDeferHeavyRecheck(undefined, "completed", 66_144)).toBe(false);
  });

  it("경계값은 통과시킨다 — **초과**만 미룬다", () => {
    expect(shouldDeferHeavyRecheck(priorRecheckable(), "completed", 500)).toBe(false);
    expect(shouldDeferHeavyRecheck(priorRecheckable(), "completed", 501)).toBe(true);
  });

  it("잡 수를 모르면 막지 않는다 — 모른다고 버리면 정상 run 이 사라진다", () => {
    expect(shouldDeferHeavyRecheck(priorRecheckable(), "completed", null)).toBe(false);
    expect(shouldDeferHeavyRecheck(priorRecheckable(), "completed", undefined)).toBe(false);
  });

  it("상한은 인자로 덮을 수 있다 (env 조정 경로의 단위 확인)", () => {
    expect(shouldDeferHeavyRecheck(priorRecheckable(), "completed", 600, 5_000)).toBe(false);
  });
});

describe("① 재확인 잡 수 상한 — 싱크 경로", () => {
  it("무거운 재확인은 listRunJobs 왕복 0 으로 미루고 recheckDeferredHeavy 로 보고한다", async () => {
    rootRuns(run("run-heavy", 2_170));
    mirroredRunStates.mockResolvedValue(new Map([["run-heavy", priorRecheckable()]]));

    const r = await syncStandardMirror();

    expect(listRunJobs).not.toHaveBeenCalled();
    expect(replaceRun).not.toHaveBeenCalled();
    expect(r.recheckDeferredHeavy).toEqual([
      { projectId: ROOT, runId: "run-heavy", jobs: 2_170 },
    ]);
    expect(r.runs).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("가벼운 재확인은 종전대로 당긴다 — 회귀 방지", async () => {
    rootRuns(run("run-light", 100));
    mirroredRunStates.mockResolvedValue(new Map([["run-light", priorRecheckable()]]));

    const r = await syncStandardMirror();

    expect(listRunJobs).toHaveBeenCalledTimes(1);
    expect(replaceRun).toHaveBeenCalledTimes(1);
    expect(r.recheckDeferredHeavy).toEqual([]);
    expect(r.runs).toBe(1);
  });

  it("상태가 바뀐 대형 run 은 당긴다 (mirror=running → scope=completed)", async () => {
    rootRuns(run("run-flip", 2_170, "completed"));
    mirroredRunStates.mockResolvedValue(new Map([["run-flip", priorRecheckable("running")]]));

    const r = await syncStandardMirror();

    expect(replaceRun).toHaveBeenCalledTimes(1);
    expect(r.recheckDeferredHeavy).toEqual([]);
  });

  it("처음 보는 대형 run 은 당긴다 (prior 없음)", async () => {
    rootRuns(run("run-new", 2_170));
    mirroredRunStates.mockResolvedValue(new Map());

    const r = await syncStandardMirror();

    expect(replaceRun).toHaveBeenCalledTimes(1);
    expect(r.recheckDeferredHeavy).toEqual([]);
  });

  it("force 경로는 상한을 보지 않는다 — 명시적 재싱크가 회수 경로다", async () => {
    rootRuns(run("run-heavy", 2_170));
    mirroredRunStates.mockResolvedValue(new Map([["run-heavy", priorRecheckable()]]));

    const r = await syncStandardMirror({ force: true });

    expect(replaceRun).toHaveBeenCalledTimes(1);
    expect(r.recheckDeferredHeavy).toEqual([]);
  });

  it("이월은 커서 last_error 에 남는다 — 정규 크론으로는 안 풀리는 상태다", async () => {
    rootRuns(run("run-heavy", 2_170));
    mirroredRunStates.mockResolvedValue(new Map([["run-heavy", priorRecheckable()]]));

    await syncStandardMirror();

    const msg = String(
      recordSyncAttempt.mock.calls.filter((c) => c[0] === ROOT).at(-1)?.[1] ?? "",
    );
    expect(msg).toContain("[attention]");
    expect(msg).toContain("heavy recheck deferred");
    expect(msg).toContain("run-heavy");
  });

  it("oversized 동일 terminal 상태는 callback에서 원장 재큐잉을 판정한다", async () => {
    const runId = "run-oversized-recheck";
    rootRuns(run(runId, mirrorJobCapacity() + 1, "partial_failed"));
    mirroredRunStates.mockResolvedValue(new Map([[runId, priorRecheckable("partial_failed")]]));
    const queueBulkRun = vi.fn().mockResolvedValue(undefined);

    const r = await syncStandardMirror({ queueBulkRun });

    expect(queueBulkRun).toHaveBeenCalledTimes(1);
    expect(listRunJobs).not.toHaveBeenCalled();
    expect(r.recheckDeferredHeavy).toEqual([{ projectId: ROOT, runId, jobs: mirrorJobCapacity() + 1 }]);
    expect(r.oversizedRuns).toEqual([{ projectId: ROOT, runId, totalJobs: mirrorJobCapacity() + 1 }]);
  });

  it("oversized 신규 run과 status 변경 run은 bulk worker에 넣는다", async () => {
    const newId = "run-oversized-new";
    const changedId = "run-oversized-status-changed";
    const jobs = mirrorJobCapacity() + 1;
    rootRuns(run(newId, jobs, "completed"), run(changedId, jobs, "completed"));
    mirroredRunStates.mockResolvedValue(new Map([[changedId, priorRecheckable("failed")]]));
    const queueBulkRun = vi.fn().mockResolvedValue(undefined);

    const r = await syncStandardMirror({ queueBulkRun });

    expect(queueBulkRun).toHaveBeenCalledTimes(2);
    expect(queueBulkRun.mock.calls.map((call) => call[0].measurement_run_id)).toEqual([newId, changedId]);
    expect(r.recheckDeferredHeavy).toEqual([]);
  });
});

describe("② 예산 인지 per-run 중단 — 순수 함수", () => {
  it("예상 비용 = 페이지 수 × ms/페이지 + replace 상수", () => {
    // 2,170 잡 → ceil(2170/200) = 11 페이지
    expect(estimateRunPullMs(2_170)).toBe(
      11 * MIRROR_JOB_PAGE_MS_FALLBACK + MIRROR_REPLACE_RUN_COST_MS,
    );
    expect(MIRROR_JOB_PAGE_LIMIT).toBe(200);
  });

  it("실측 페이스는 **잡당**으로 정규화한다 — 가득 찬 페이지 환산값을 쓴다", () => {
    // 1,200잡을 12,000ms 에 당겼다 = 10ms/job → 가득 찬 페이지(200) = 2,000ms
    const pacing = createPassPacing();
    recordJobPageSample(pacing, 12_000, 1_200);
    expect(jobPageAvgMs(pacing)).toBe(2_000);
    expect(estimateRunPullMs(2_170, pacing)).toBe(11 * 2_000 + MIRROR_REPLACE_RUN_COST_MS);
    // 표본이 없으면 보수적 상수로 되돌아간다.
    expect(jobPageAvgMs(createPassPacing())).toBe(MIRROR_JOB_PAGE_MS_FALLBACK);
  });

  // ★ 검증자 재현(2026-09-15): 페이지당 평균을 쓰면 희소한 첫 페이지가 단가를
  //   끌어내려 대형 run 이 통과했다(예상 5,110ms vs 실제 16,535ms, 1.65배 초과).
  it("희소 페이지가 단가를 끌어내리지 않는다 — 하한이 걸린다", () => {
    const pacing = createPassPacing();
    recordJobPageSample(pacing, 10, 10); // 10잡을 10ms — 1ms/job
    // 페이지당 평균이었다면 10ms/페이지였을 것이다. 정규화하면 200ms,
    // 거기에 하한(FALLBACK/4 = 1,000ms)이 걸린다.
    expect(MIRROR_JOB_PAGE_MS_FLOOR).toBe(MIRROR_JOB_PAGE_MS_FALLBACK / 4);
    expect(jobPageAvgMs(pacing)).toBe(MIRROR_JOB_PAGE_MS_FLOOR);
    // 2,170잡 = 11페이지 → 16,000ms. 잔여 9,990ms 에서 **막힌다**(종전 5,110ms).
    expect(estimateRunPullMs(2_170, pacing)).toBe(16_000);
    expect(shouldStopBeforeRun(9_990, 2_170, pacing)).toBe(true);
  });

  it("잡 0건 페이지는 표본이 아니다 — 빈 왕복으로 단가를 만들지 않는다", () => {
    const pacing = createPassPacing();
    recordJobPageSample(pacing, 5_000, 0);
    expect(pacing).toEqual({ jobMs: 0, jobs: 0 });
    expect(jobPageAvgMs(pacing)).toBe(MIRROR_JOB_PAGE_MS_FALLBACK);
  });

  it("남은 시간 < 예상 비용이면 시작하지 않는다", () => {
    expect(shouldStopBeforeRun(20_000, 2_170)).toBe(true); // 예상 49,000ms
    expect(shouldStopBeforeRun(60_000, 2_170)).toBe(false);
  });

  it("무제한 예산(로컬 회수 도구)은 절대 멈추지 않는다", () => {
    expect(shouldStopBeforeRun(Number.POSITIVE_INFINITY, 66_144)).toBe(false);
  });
});

describe("② 예산 인지 per-run 중단 — 싱크 경로", () => {
  it("잔여 예산보다 큰 run 은 **시작하지 않고** budgetStopped 로 끝낸다", async () => {
    // 10,000 잡 = 50 페이지 → 예상 205,000ms. capacity 경계값이라 oversized 는 아니다.
    expect(mirrorJobCapacity()).toBe(10_000);
    rootRuns(run("run-big", 10_000));

    const r = await syncStandardMirror({ budgetMs: 20_000 });

    expect(listRunJobs).not.toHaveBeenCalled();
    expect(replaceRun).not.toHaveBeenCalled();
    expect(r.budgetStoppedProjects).toContain(ROOT);
    expect(r.runs).toBe(0);
  });

  it("같은 예산에서 작은 run 은 그대로 돈다 — 과잉 차단이 아니다", async () => {
    rootRuns(run("run-small", 10));

    const r = await syncStandardMirror({ budgetMs: 20_000 });

    expect(listRunJobs).toHaveBeenCalledTimes(1);
    expect(r.runs).toBe(1);
    expect(r.budgetStoppedProjects).toEqual([]);
  });

  it("중단은 그 run **앞**에서 일어난다 — 앞선 run 은 이미 미러돼 있고, 단가는 실측으로 바뀐다", async () => {
    // 첫 run 이 실제로 300ms/페이지를 쓰게 만든다 → 이후 예상 단가가 그 실측으로
    // 바뀐다(보수적 상수 4,000ms 가 아니라). 50페이지 × 300ms + 5,000 = 20,000ms
    // > 잔여(≈11.7s) 이므로 둘째 run 은 시작조차 하지 않는다.
    listRunJobs.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return page([]);
    });
    rootRuns(run("run-small", 10), run("run-big", 10_000));

    // 첫 run 의 예상(보수적 상수) 9,000ms < 12,000ms → 통과한다.
    const r = await syncStandardMirror({ budgetMs: 12_000 });

    expect(listRunJobs).toHaveBeenCalledTimes(1);
    expect(r.runs).toBe(1);
    expect(replaceRun).toHaveBeenCalledTimes(1);
    expect(replaceRun.mock.calls[0][0].runId).toBe("run-small");
    expect(r.budgetStoppedProjects).toContain(ROOT);
  });

  // ★ 돌연변이 판별 테스트 (2026-09-15 검증 지적 M1): `recordJobPageSample` 호출을
  //   지우면 페이스가 영원히 보수적 상수로 남는데, 그래도 통과하는 테스트만 있으면
  //   그 두 줄은 사실상 검증되지 않은 코드다. 이 케이스는 **실측 페이스가 있어야만**
  //   통과한다 — 상수(4,000ms/페이지)로는 둘째 run 이 막힌다.
  it("★ 실측 페이스가 반영돼야만 통과한다 (상수였다면 둘째 run 이 막힌다)", async () => {
    // run A: 200잡 1페이지를 300ms 에 → 1.5ms/job → 가득 찬 페이지 환산 300ms,
    //        하한이 걸려 1,000ms/페이지.
    // run B: 400잡 = 2페이지 → 실측이면 2×1,000+5,000 = 7,000ms,
    //        상수였다면 2×4,000+5,000 = 13,000ms.
    // 예산 10,000ms 에서 run A 가 300ms 를 쓰면 잔여 ≈9,650ms →
    //        실측: 통과 / 상수: 차단.
    listRunJobs.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return jobsPage(200);
    });
    rootRuns(run("run-a", 200), run("run-b", 400));

    const r = await syncStandardMirror({ budgetMs: 10_000 });

    expect(r.runs).toBe(2);
    expect(listRunJobs).toHaveBeenCalledTimes(2);
    expect(r.budgetStoppedProjects).toEqual([]);
  });

  it("예산 중단도 커서 last_error 에 남는다", async () => {
    rootRuns(run("run-big", 10_000));

    await syncStandardMirror({ budgetMs: 20_000 });

    const msg = String(
      recordSyncAttempt.mock.calls.filter((c) => c[0] === ROOT).at(-1)?.[1] ?? "",
    );
    expect(msg).toContain("budget stop inside run loop");
  });
});
