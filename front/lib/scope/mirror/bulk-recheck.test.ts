import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeasurementJob } from "@/lib/scope/types";
import { createBulkRecheck, BULK_RECHECK_INTERVAL_MS } from "./bulk-plan";

const h = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), jobs: vi.fn(), run: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/db/repositories/scope-mirror-progress", () => ({
  scopeMirrorProgressRepository: { listRecheckable: h.list, saveRecheck: h.save },
  ScopeMirrorProgressStaleError: class extends Error {},
}));
vi.mock("@/lib/scope", () => ({ getScopeClient: () => ({ listRunJobs: h.jobs, getMeasurementRun: h.run }) }));
vi.mock("./bulk-run", () => ({ bulkRunState: (row: { state: unknown }) => row.state }));
vi.mock("./bulk-worker", () => ({ enqueueBulkRun: h.enqueue }));
const { advanceBulkRecheck, processBulkRechecks } = await import("./bulk-recheck");

const job = (id: string, status = "failed"): MeasurementJob => ({
  job_id: id, status, prompt_id: "prompt", target: "chatgpt", region: "KR", measured_at: "2026-09-15T00:00:00Z",
});
const receipt = (recheck: unknown) => ({
  projectId: "project", runId: "run", phase: "complete", revision: 10,
  state: { recheck }, updatedAt: new Date("2026-09-15T00:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockReset().mockResolvedValue([]);
  h.save.mockImplementation(async (row, recheck) => ({ ...row, revision: row.revision + 1, state: { recheck } }));
  h.jobs.mockReset();
  h.run.mockReset();
});

describe("bulk late recovery observations", () => {
  it("keeps the raw failures including siblings not selected as ACR representatives", () => {
    const state = createBulkRecheck([job("a"), job("c", "completed"), job("b")], 0)!;
    expect(state.groups).toMatchObject([{ status: "failed", count: 2 }]);
    expect(createBulkRecheck([job("c", "completed")])).toBeNull();
  });

  it("compares unchanged filtered IDs across different page boundaries without requesting a replay", () => {
    const state = createBulkRecheck([job("a"), job("b"), job("c")], 0)!;
    const first = advanceBulkRecheck(state, { data: [job("c")], next_cursor: "next" }, 10);
    expect(first).toMatchObject({ cursor: "next", count: 1, changedAt: null });
    const done = advanceBulkRecheck(first, { data: [job("b"), job("a")], next_cursor: null }, 20);
    expect(done).toMatchObject({ cursor: null, count: 0, groupIndex: 0, changedAt: null });
    expect(Date.parse(done.nextCheckAt)).toBe(20 + BULK_RECHECK_INTERVAL_MS);
  });

  it("detects a recovered raw job while other failures and the run partial_failed status remain", () => {
    const state = createBulkRecheck([job("a"), job("b")], 0)!;
    const changed = advanceBulkRecheck(state, { data: [job("a")], next_cursor: null }, 100);
    expect(changed.changedAt).toBe(new Date(100).toISOString());
  });

  it("detects same-count substitutions, not just changes in failure count", () => {
    const state = createBulkRecheck([job("a"), job("b")], 0)!;
    const changed = advanceBulkRecheck(state, { data: [job("c"), job("a")], next_cursor: null }, 100);
    expect(changed.changedAt).not.toBeNull();
  });

  it("does not interpret unsupported filtering or repeated/out-of-order pages as successful scans", () => {
    const state = createBulkRecheck([job("a"), job("b")], 0)!;
    expect(() => advanceBulkRecheck(state, { data: [job("b", "completed")], next_cursor: null })).toThrow("filtered");
    const first = advanceBulkRecheck(state, { data: [job("b")], next_cursor: "next" });
    expect(() => advanceBulkRecheck(first, { data: [job("b")], next_cursor: null })).toThrow("filtered");
    expect(() => advanceBulkRecheck(first, { data: [], next_cursor: "next" })).toThrow("cursor");
  });

  it("resumes a saved filtered-page cursor on the next worker pass", async () => {
    const state = createBulkRecheck([job("a"), job("b")], 0)!;
    const row = receipt(state);
    h.list.mockResolvedValueOnce([row]).mockResolvedValue([]);
    h.jobs.mockResolvedValueOnce({ data: [job("b")], next_cursor: "next" });
    await processBulkRechecks({ budgetMs: 1000 });
    const saved = h.save.mock.calls[0][1];
    h.list.mockResolvedValueOnce([receipt(saved)]).mockResolvedValue([]);
    h.jobs.mockResolvedValueOnce({ data: [job("a")], next_cursor: null });
    await processBulkRechecks({ budgetMs: 1000 });
    expect(h.jobs.mock.calls.map((call) => call[2])).toEqual([
      { limit: 200, status: "failed", cursor: undefined },
      { limit: 200, status: "failed", cursor: "next" },
    ]);
    expect(h.save.mock.calls[1][1].changedAt).toBeNull();
  });

  it("backs off a failed observation without losing the committed cursor", async () => {
    const state = advanceBulkRecheck(createBulkRecheck([job("a"), job("b")], 0)!, {
      data: [job("b")], next_cursor: "next",
    });
    h.list.mockResolvedValueOnce([receipt(state)]).mockResolvedValue([]);
    h.jobs.mockRejectedValueOnce(new Error("network error"));
    const report = await processBulkRechecks({ budgetMs: 1000 });
    expect(report.failures).toBe(1);
    expect(h.save.mock.calls[0][1]).toMatchObject({ cursor: "next", count: 1, changedAt: null });
  });

  it("does not fabricate a recovery when a read exceeds the pass deadline", async () => {
    h.list.mockResolvedValueOnce([receipt(createBulkRecheck([job("a")], 0))]);
    h.jobs.mockImplementation(() => new Promise(() => {}));
    const report = await processBulkRechecks({ budgetMs: 30 });
    expect(report.budgetStopped).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("uses fresh single-run metadata to enqueue a confirmed recovery without waiting for history discovery", async () => {
    const state = { ...createBulkRecheck([job("a"), job("b")], 0)!, changedAt: new Date().toISOString() };
    h.list.mockResolvedValueOnce([receipt(state)]).mockResolvedValue([]);
    const source = { measurement_run_id: "run", project_id: "project", status: "partial_failed", total_jobs: 10001 };
    h.run.mockResolvedValue(source);
    const report = await processBulkRechecks({ budgetMs: 1000 });
    expect(h.run).toHaveBeenCalledWith("project", "run", expect.anything());
    expect(h.enqueue).toHaveBeenCalledWith(source, "project", null);
    expect(report.queued).toBe(1);
    expect(h.jobs).not.toHaveBeenCalled();
  });

  it("keeps a changed receipt visible while the source is running again", async () => {
    const state = { ...createBulkRecheck([job("a")], 0)!, changedAt: new Date().toISOString() };
    h.list.mockResolvedValueOnce([receipt(state)]).mockResolvedValue([]);
    h.run.mockResolvedValue({ status: "running" });
    await processBulkRechecks({ budgetMs: 1000 });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.save.mock.calls[0][1].changedAt).toBe(state.changedAt);
  });
});
