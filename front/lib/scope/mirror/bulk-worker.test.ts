import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  mirroredRunStates: vi.fn(),
  restart: vi.fn(),
  createIfAbsent: vi.fn(),
  listPending: vi.fn(),
  counts: vi.fn(),
  advance: vi.fn(),
  resume: vi.fn(),
  bulkRunState: vi.fn(),
  initialBulkRunState: vi.fn(),
}));

vi.mock("@/lib/db/repositories/scope-mirror-progress", () => ({
  scopeMirrorProgressRepository: {
    get: (...args: unknown[]) => h.get(...args),
    getForRegistration: (...args: unknown[]) => h.get(...args),
    mirroredRunStates: (...args: unknown[]) => h.mirroredRunStates(...args),
    restart: (...args: unknown[]) => h.restart(...args),
    createIfAbsent: (...args: unknown[]) => h.createIfAbsent(...args),
    listPending: (...args: unknown[]) => h.listPending(...args),
    counts: (...args: unknown[]) => h.counts(...args),
    advance: (...args: unknown[]) => h.advance(...args),
  },
  ScopeMirrorProgressStaleError: class ScopeMirrorProgressStaleError extends Error {
    constructor() { super("stale"); this.name = "ScopeMirrorProgressStaleError"; }
  },
}));
vi.mock("@/lib/db/repositories/scope-mirror", () => ({
  scopeMirrorRepository: {
    mirroredRunStates: (...args: unknown[]) => h.mirroredRunStates(...args),
  },
}));
vi.mock("@/lib/db/repositories/project-tracked-dictionary", () => ({
  getProjectTrackedDictionary: vi.fn(async () => null),
}));
vi.mock("@/lib/db/repositories/prompts", () => ({
  promptRepository: { updateStatusByScopePromptIds: vi.fn(async () => 0) },
}));
vi.mock("@/lib/scope", () => ({ getScopeClient: () => ({}) }));
vi.mock("@/lib/summary/cycle-control", () => ({ runCycleControl: vi.fn() }));
vi.mock("./sync", () => ({
  buildMentionCanonicalizer: vi.fn(() => ({
    canonicalizeBrand: (value: unknown) => value,
    canonicalizeProduct: (value: unknown) => value,
  })),
  shouldSkipMirroredRun: (prior: { status: string; hasUnresolved: boolean; recheckable: boolean } | undefined, currentStatus: string) =>
    Boolean(prior && prior.status === currentStatus && !(prior.hasUnresolved && prior.recheckable)),
  shouldDeferHeavyRecheck: (prior: { status: string; hasUnresolved: boolean; recheckable: boolean } | undefined, currentStatus: string, totalJobs: number | null | undefined) =>
    Boolean(prior && prior.status === currentStatus && typeof totalJobs === "number" && totalJobs > 500),
}));
vi.mock("./bulk-plan", () => ({
  BulkSourceChangedError: class BulkSourceChangedError extends Error {
    constructor(message = "source changed") { super(message); this.name = "BulkSourceChangedError"; }
  },
}));
vi.mock("./bulk-run", () => ({
  bulkRunState: (row: { state: unknown }) => h.bulkRunState(row),
  initialBulkRunState: (source: unknown) => h.initialBulkRunState(source),
  resumeBulkRunStep: (...args: unknown[]) => h.resume(...args),
}));

const { enqueueBulkRun, processBulkQueue } = await import("./bulk-worker");

const PROJECT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const source = (overrides: Record<string, unknown> = {}) => ({
  measurement_run_id: RUN,
  project_id: PROJECT,
  status: "completed",
  started_at: "2026-09-15T00:00:00.000Z",
  completed_at: "2026-09-15T00:05:00.000Z",
  total_jobs: 10001,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockResolvedValue(null);
  h.mirroredRunStates.mockResolvedValue(new Map());
  h.restart.mockResolvedValue(undefined);
  h.createIfAbsent.mockResolvedValue(undefined);
  h.listPending.mockResolvedValue([]);
  h.counts.mockResolvedValue({ pending: 0, blocked: 0 });
  h.advance.mockResolvedValue(undefined);
  h.initialBulkRunState.mockImplementation((s: unknown) => ({ source: s, dictionary: null, visibility: {} }));
  h.bulkRunState.mockImplementation((row: { state?: unknown }) => row.state ?? { dictionary: null });
});

describe("bulk discovery and worker recovery", () => {
  it("does not re-enqueue an already completed run", async () => {
    const completed = {
      projectId: PROJECT,
      runId: RUN,
      phase: "complete",
      revision: 7,
      state: { source: source(), visibility: {} },
    };
    h.get.mockResolvedValue(completed);
    h.mirroredRunStates.mockResolvedValue(new Map([[RUN, {
      status: "completed", hasUnresolved: false, recheckable: false, syncedAt: new Date(),
    }]]));

    await enqueueBulkRun(source(), PROJECT, null);

    expect(h.mirroredRunStates).toHaveBeenCalledWith(RUN);
    expect(h.restart).not.toHaveBeenCalled();
    expect(h.createIfAbsent).not.toHaveBeenCalled();
  });

  it("does not restart a completed heavy receipt when only unresolved answers remain", async () => {
    const completed = {
      projectId: PROJECT,
      runId: RUN,
      phase: "complete",
      revision: 7,
      state: { source: source(), visibility: {} },
    };
    h.get.mockResolvedValue(completed);
    h.mirroredRunStates.mockResolvedValue(new Map([[RUN, {
      status: "completed", hasUnresolved: true, recheckable: true, syncedAt: new Date(),
    }]]));

    await enqueueBulkRun(source(), PROJECT, null);

    expect(h.mirroredRunStates).toHaveBeenCalledWith(RUN);
    expect(h.restart).not.toHaveBeenCalled();
    expect(h.createIfAbsent).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not create a receipt for an existing terminal heavy mirror (unresolved=%s)", async (hasUnresolved) => {
    h.get.mockResolvedValue(null);
    h.mirroredRunStates.mockResolvedValue(new Map([[RUN, {
      status: "partial_failed", hasUnresolved, recheckable: true, syncedAt: new Date(),
    }]]));

    await enqueueBulkRun(source({ status: "partial_failed", total_jobs: 66144 }), PROJECT, null);

    expect(h.mirroredRunStates).toHaveBeenCalledWith(RUN);
    expect(h.createIfAbsent).not.toHaveBeenCalled();
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("leaves an in-progress receipt untouched before watermark checks", async () => {
    h.get.mockResolvedValue({
      projectId: PROJECT, runId: RUN, phase: "write", revision: 2,
      state: { source: source(), visibility: {} },
    });

    await enqueueBulkRun(source(), PROJECT, null);

    expect(h.mirroredRunStates).not.toHaveBeenCalled();
    expect(h.createIfAbsent).not.toHaveBeenCalled();
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("replans the same terminal status after a raw failure-set change, even when the mirrored representatives were completed", async () => {
    h.get.mockResolvedValue({
      projectId: PROJECT, runId: RUN, phase: "complete", revision: 7,
      state: { source: source({ status: "partial_failed" }), visibility: {}, recheck: { changedAt: new Date().toISOString() } },
    });
    h.mirroredRunStates.mockResolvedValue(new Map([[RUN, {
      status: "partial_failed", hasUnresolved: false, recheckable: true, syncedAt: new Date(),
    }]]));
    await enqueueBulkRun(source({ status: "partial_failed" }), PROJECT, null);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("replans when the raw job count changes without a run status change", async () => {
    h.get.mockResolvedValue({
      projectId: PROJECT, runId: RUN, phase: "complete", revision: 7,
      state: { source: source({ total_jobs: 10001 }), visibility: {} },
    });
    h.mirroredRunStates.mockResolvedValue(new Map([[RUN, {
      status: "completed", hasUnresolved: false, recheckable: false, syncedAt: new Date(),
    }]]));
    await enqueueBulkRun(source({ total_jobs: 10002 }), PROJECT, null);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("restarts a completed receipt when the source terminal status changes", async () => {
    const completed = {
      projectId: PROJECT,
      runId: RUN,
      phase: "complete",
      revision: 7,
      state: { source: source({ status: "failed" }), visibility: {} },
    };
    h.get.mockResolvedValue(completed);
    h.mirroredRunStates.mockResolvedValue(new Map([[RUN, {
      status: "failed", hasUnresolved: true, recheckable: true, syncedAt: new Date(),
    }]]));

    await enqueueBulkRun(source({ status: "completed" }), PROJECT, null);

    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("restarts a blocked run when discovery presents a new source plan", async () => {
    const blocked = {
      projectId: PROJECT,
      runId: RUN,
      phase: "blocked",
      revision: 4,
      updatedAt: new Date(Date.now() - 120_000),
      state: { source: source({ status: "failed", total_jobs: 12000 }), visibility: { cycle: "held" } },
    };
    h.get.mockResolvedValue(blocked);

    await enqueueBulkRun(source({ status: "completed", total_jobs: 13000 }), PROJECT, null);

    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.restart.mock.calls[0][0]).toBe(blocked);
    expect(h.restart.mock.calls[0][1].source.status).toBe("completed");
    expect(h.restart.mock.calls[0][1].source.total_jobs).toBe(13000);
  });

  it("backs off a freshly blocked run without requiring source equality", async () => {
    const blocked = {
      projectId: PROJECT,
      runId: RUN,
      phase: "blocked",
      revision: 4,
      updatedAt: new Date(),
      state: { source: source({ status: "failed", total_jobs: 12000 }), visibility: { cycle: "held" } },
    };
    h.get.mockResolvedValue(blocked);

    await enqueueBulkRun(source({ status: "failed", total_jobs: 12000 }), PROJECT, null);

    expect(h.restart).not.toHaveBeenCalled();
    expect(h.createIfAbsent).not.toHaveBeenCalled();
  });

  it("retries an expired blocked row even when the source summary is unchanged", async () => {
    const blocked = {
      projectId: PROJECT,
      runId: RUN,
      phase: "blocked",
      revision: 4,
      updatedAt: new Date(Date.now() - 61_000),
      state: { source: source({ status: "failed", total_jobs: 12000 }), visibility: { cycle: "held" } },
    };
    h.get.mockResolvedValue(blocked);

    await enqueueBulkRun(source({ status: "failed", total_jobs: 12000 }), PROJECT, null);

    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.restart.mock.calls[0][0]).toBe(blocked);
  });

  it("reloads after a response-loss error when the commit already advanced the row", async () => {
    const row = {
      projectId: PROJECT,
      runId: RUN,
      phase: "write",
      revision: 2,
      updatedAt: new Date(),
      lastError: null,
      state: { dictionary: null, step: "jobs" },
    };
    const committed = { ...row, phase: "complete", revision: 3 };
    h.listPending
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([]);
    h.bulkRunState.mockReturnValue(row.state);
    h.resume.mockImplementation(async () => {
      h.get.mockResolvedValue(committed);
      throw new Error("connection closed after commit");
    });
    h.counts.mockResolvedValue({ pending: 0, blocked: 0 });

    const report = await processBulkQueue({ visibility: {} as never, budgetMs: 1000 });

    expect(report.completed).toBe(1);
    expect(report.failures).toEqual([]);
    expect(h.advance).not.toHaveBeenCalled();
  });

  it("blocks one malformed checkpoint and continues with the next queued run", async () => {
    const malformed = {
      projectId: PROJECT,
      runId: "33333333-3333-4333-8333-333333333333",
      phase: "write",
      revision: 4,
      updatedAt: new Date(),
      lastError: null,
      state: { malformed: true },
    };
    const next = {
      projectId: PROJECT,
      runId: "44444444-4444-4444-8444-444444444444",
      phase: "write",
      revision: 0,
      updatedAt: new Date(),
      lastError: null,
      state: { dictionary: null, step: "jobs" },
    };
    h.listPending.mockReset()
      .mockResolvedValueOnce([malformed])
      .mockResolvedValueOnce([next])
      .mockResolvedValueOnce([]);
    h.bulkRunState.mockImplementation((row: { state?: unknown }) => {
      if ((row.state as { malformed?: boolean } | undefined)?.malformed) {
        throw new Error("Invalid or incompatible bulk mirror checkpoint");
      }
      return row.state;
    });
    h.resume.mockResolvedValue({ ...next, phase: "complete", revision: 1 });
    h.counts.mockResolvedValue({ pending: 0, blocked: 1, oldestReadyAt: null });

    const report = await processBulkQueue({ visibility: {} as never, budgetMs: 1000 });

    expect(h.listPending).toHaveBeenCalled();
    expect(h.bulkRunState).toHaveBeenCalled();
    expect(h.advance).toHaveBeenCalledWith(malformed, {
      phase: "blocked",
      lastError: "checkpoint-invalid",
    });
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(report.completed).toBe(1);
    expect(report.failures).toEqual([{ runId: malformed.runId, code: "checkpoint-invalid" }]);
  });

  it("stops the outer queue after a deadline stop instead of retrying the same run", async () => {
    const row = {
      projectId: PROJECT,
      runId: RUN,
      phase: "write",
      revision: 2,
      updatedAt: new Date(),
      lastError: null,
      state: { dictionary: null, step: "jobs" },
    };
    h.listPending.mockReset().mockResolvedValue([row]);
    h.bulkRunState.mockReturnValue(row.state);
    const deadline = new Error("scope deadline");
    deadline.name = "ScopeDeadlineExceededError";
    h.resume.mockRejectedValue(deadline);
    h.counts.mockResolvedValue({ pending: 1, blocked: 0, oldestReadyAt: null });
    let nowCalls = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (nowCalls++ < 20 ? 1_000 : 2_000));

    try {
      const report = await processBulkQueue({ visibility: {} as never, budgetMs: 100 });
      expect(h.listPending).toHaveBeenCalledTimes(1);
      expect(h.resume).toHaveBeenCalledTimes(1);
      expect((report as typeof report & { budgetStopped: boolean }).budgetStopped).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
});
