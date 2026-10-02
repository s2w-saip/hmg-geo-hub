import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeasurementRunSummary, Paginated } from "@/lib/scope/types";
import { discoverBulkRuns, readBulkDiscoveryState } from "./bulk-discovery";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function run(id: string, totalJobs = 10_001, status = "completed"): MeasurementRunSummary {
  return {
    measurement_run_id: id,
    project_id: "project",
    trigger: "scheduled",
    status,
    targets: ["chatgpt"],
    regions: ["KR"],
    total_jobs: totalJobs,
    started_at: "2026-09-15T00:00:00.000Z",
    completed_at: "2026-09-15T00:01:00.000Z",
  };
}

function page(data: MeasurementRunSummary[], next_cursor: string | null): Paginated<MeasurementRunSummary> {
  return { data, next_cursor };
}

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hmg-bulk-discovery-"));
  paths.push(directory);
  return join(directory, "state.json");
}

describe("bulk discovery", () => {
  it("polls one page per project, enqueueing only terminal oversized runs", async () => {
    const path = await statePath();
    const pages: Record<string, Record<string, Paginated<MeasurementRunSummary>>> = {
      p1: {
        head: page([run("new"), run("small", 10_000), run("running", 10_001, "running")], "p1-deep"),
        "p1-deep": page([run("old")], null),
      },
      p2: { head: page([run("p2-new", 10_001, "partial_failed")], null) },
    };
    const listMeasurementRuns = vi.fn(async (projectId: string, query?: { cursor?: string }) =>
      pages[projectId]![query?.cursor ?? "head"]!,
    );
    const enqueue = vi.fn(async () => undefined);

    const report = await discoverBulkRuns({
      client: { listMeasurementRuns },
      targets: [
        { projectId: "p1", localProjectId: "local-1" },
        { projectId: "p2", localProjectId: null },
      ],
      enqueue,
      statePath: path,
      budgetMs: 10_000,
      maxConcurrency: 1,
    });

    expect(report).toMatchObject({ projects: 2, pages: 2, runsSeen: 4, registrationAttempts: 2, failures: [], budgetStopped: false });
    expect(enqueue.mock.calls.map(([item]) => item.measurement_run_id).sort()).toEqual(["new", "p2-new"]);
    expect(listMeasurementRuns.mock.calls.map(([, query]) => query?.cursor)).toEqual([undefined, undefined]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ projects: { p1: { cursor: "p1-deep" }, p2: { cursor: null } } });
  });

  it("persists the deep cursor after a head page and resumes it after a deadline", async () => {
    const path = await statePath();
    let clock = 0;
    const pages: Record<string, Paginated<MeasurementRunSummary>> = {
      head: page([run("head")], "c1"),
      c1: page([run("deep-1")], "c2"),
      c2: page([run("deep-2")], null),
    };
    const listMeasurementRuns = vi.fn(async (_projectId: string, query?: { cursor?: string }) => pages[query?.cursor ?? "head"]!);
    const enqueue = vi.fn(async () => { clock = 101; });

    const first = await discoverBulkRuns({
      client: { listMeasurementRuns }, targets: [{ projectId: "p", localProjectId: null }], enqueue,
      statePath: path, budgetMs: 100, maxConcurrency: 1, now: () => clock,
    });
    expect(first.budgetStopped).toBe(true);
    expect((await readBulkDiscoveryState(path)).projects.p).toMatchObject({ cursor: "c1", lastHeadAt: expect.any(String) });
    expect(listMeasurementRuns).toHaveBeenCalledTimes(1);

    clock = 0;
    enqueue.mockReset().mockImplementation(async () => undefined);
    const second = await discoverBulkRuns({
      client: { listMeasurementRuns }, targets: [{ projectId: "p", localProjectId: null }], enqueue,
      statePath: path, budgetMs: 100, maxConcurrency: 1, now: () => clock,
    });
    expect(second.failures).toEqual([]);
    expect(listMeasurementRuns.mock.calls.slice(1).map(([, query]) => query?.cursor)).toEqual(["c1"]);
    expect(enqueue.mock.calls.map(([item]) => item.measurement_run_id)).toEqual(["deep-1"]);
    expect((await readBulkDiscoveryState(path)).projects.p).toMatchObject({ cursor: "c2", lastHeadAt: expect.any(String) });
  });

  it("isolates a project failure and leaves its cursor unchanged while other projects proceed", async () => {
    const path = await statePath();
    const listMeasurementRuns = vi.fn(async (projectId: string) => {
      if (projectId === "bad") throw new Error("source unavailable");
      return page([run("good")], null);
    });
    const enqueue = vi.fn(async () => undefined);

    const report = await discoverBulkRuns({
      client: { listMeasurementRuns },
      targets: [{ projectId: "bad", localProjectId: null }, { projectId: "good", localProjectId: "local" }],
      enqueue, statePath: path, budgetMs: 10_000, maxConcurrency: 1,
    });

    expect(report.failures).toEqual([{ projectId: "bad", code: "Error" }]);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ measurement_run_id: "good" }), "good", "local");
    const state = await readBulkDiscoveryState(path);
    expect(state.projects.bad).toBeUndefined();
    expect(state.projects.good).toMatchObject({ cursor: null, lastHeadAt: expect.any(String) });
  });

  it("does not advance a page when enqueue fails, so the next pass can safely retry it", async () => {
    const path = await statePath();
    const listMeasurementRuns = vi.fn(async () => page([run("retry")], "c1"));
    const enqueue = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);

    const failed = await discoverBulkRuns({
      client: { listMeasurementRuns }, targets: [{ projectId: "p", localProjectId: null }], enqueue,
      statePath: path, budgetMs: 10_000, maxConcurrency: 1,
    });
    expect(failed.failures).toEqual([{ projectId: "p", code: "Error" }]);
    expect((await readBulkDiscoveryState(path)).projects.p?.pending).toMatchObject({ index: 0, nextCursor: "c1" });

    await discoverBulkRuns({
      client: { listMeasurementRuns }, targets: [{ projectId: "p", localProjectId: null }], enqueue,
      statePath: path, budgetMs: 10_000, maxConcurrency: 1,
    });
    expect((await readBulkDiscoveryState(path)).projects.p).toMatchObject({ cursor: "c1", lastHeadAt: expect.any(String) });
  });

  it("alternates deep pages between five-minute head polls", async () => {
    const path = await statePath();
    let clock = 0;
    const pages: Record<string, Paginated<MeasurementRunSummary>> = {
      head: page([run("head")], "c1"),
      c1: page([run("deep-1")], "c2"),
      c2: page([run("deep-2")], null),
    };
    const listMeasurementRuns = vi.fn(async (_projectId: string, query?: { cursor?: string }) => pages[query?.cursor ?? "head"]!);
    const enqueue = vi.fn(async () => undefined);
    const opts = {
      client: { listMeasurementRuns }, targets: [{ projectId: "p", localProjectId: null }], enqueue,
      statePath: path, budgetMs: 10_000, maxConcurrency: 1, now: () => clock,
    };

    await discoverBulkRuns(opts);
    clock = 1_000;
    await discoverBulkRuns(opts);
    await discoverBulkRuns(opts);
    await discoverBulkRuns(opts);
    expect(listMeasurementRuns.mock.calls.map(([, query]) => query?.cursor)).toEqual([undefined, "c1", "c2"]);
    clock = 5 * 60_000;
    await discoverBulkRuns(opts);
    expect(listMeasurementRuns.mock.calls.at(-1)?.[1]?.cursor).toBeUndefined();
  });

  it("forces the saved deep page when a full project pass outlasts the head interval", async () => {
    const path = await statePath();
    let clock = 0;
    const pages: Record<string, Paginated<MeasurementRunSummary>> = {
      p1Head: page([run("p1-head")], "p1-deep"),
      p1Deep: page([run("p1-deep")], null),
      p2Head: page([run("p2-head")], "p2-deep"),
      p2Deep: page([run("p2-deep")], null),
    };
    const listMeasurementRuns = vi.fn(async (projectId: string, query?: { cursor?: string }) => {
      const key = query?.cursor ?? `${projectId}Head`;
      clock += 6 * 60_000;
      return pages[key === "p1-deep" ? "p1Deep" : key === "p2-deep" ? "p2Deep" : key]!;
    });
    const enqueue = vi.fn(async () => undefined);
    const opts = {
      client: { listMeasurementRuns },
      targets: [
        { projectId: "p1", localProjectId: null },
        { projectId: "p2", localProjectId: null },
      ],
      enqueue,
      statePath: path,
      budgetMs: 30 * 60_000,
      maxConcurrency: 1,
      now: () => clock,
    };

    await discoverBulkRuns(opts);
    await discoverBulkRuns(opts);

    expect(listMeasurementRuns.mock.calls.map(([, query]) => query?.cursor)).toEqual([
      undefined,
      undefined,
      "p1-deep",
      "p2-deep",
    ]);
    expect(enqueue.mock.calls.map(([item]) => item.measurement_run_id)).toEqual([
      "p1-head",
      "p2-head",
      "p1-deep",
      "p2-deep",
    ]);
  });

  it("reserves the next project before its enqueue work starts", async () => {
    const path = await statePath();
    const listMeasurementRuns = vi.fn(async (projectId: string) => page([run(projectId)], null));
    const observed: number[] = [];
    const enqueue = vi.fn(async () => { observed.push((await readBulkDiscoveryState(path)).nextProjectIndex); });

    await discoverBulkRuns({
      client: { listMeasurementRuns },
      targets: [{ projectId: "p1", localProjectId: null }, { projectId: "p2", localProjectId: null }],
      enqueue, statePath: path, budgetMs: 10_000, maxConcurrency: 1,
    });
    expect(observed).toEqual([1, 0]);
    expect((await readBulkDiscoveryState(path)).nextProjectIndex).toBe(0);
  });

  it("drains 100 eligible runs over five budgeted passes without refetching the pending page", async () => {
    const path = await statePath();
    let clock = 0;
    const runs = Array.from({ length: 100 }, (_, i) => run(`run-${String(i).padStart(3, "0")}`));
    const listMeasurementRuns = vi.fn(async () => page(runs, "deep-1"));
    const seen: string[] = [];
    const enqueue = vi.fn(async (item: MeasurementRunSummary) => { seen.push(item.measurement_run_id); clock += 500; });
    const opts = {
      client: { listMeasurementRuns }, targets: [{ projectId: "p", localProjectId: null }], enqueue,
      statePath: path, budgetMs: 10_000, maxConcurrency: 1, now: () => clock,
    };

    for (let passIndex = 0; passIndex < 5; passIndex++) await discoverBulkRuns(opts);

    expect(listMeasurementRuns).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(runs.map((item) => item.measurement_run_id));
    expect((await readBulkDiscoveryState(path)).projects.p).toMatchObject({ cursor: "deep-1" });
    expect((await readBulkDiscoveryState(path)).projects.p).not.toHaveProperty("pending");
  });

  it("retains old head registrations while a newer head is inserted", async () => {
    const path = await statePath();
    let clock = 0;
    let headRead = 0;
    const old = [run("old-1"), run("old-2"), run("old-3")];
    const listMeasurementRuns = vi.fn(async (_projectId: string, query?: { cursor?: string }) => {
      if (query?.cursor === "deep") return page([], null);
      headRead++;
      return headRead === 1 ? page(old, "deep") : page([run("new-head"), ...old], "deep");
    });
    const seen: string[] = [];
    const enqueue = vi.fn(async (item: MeasurementRunSummary) => { seen.push(item.measurement_run_id); clock += 500; });
    const opts = {
      client: { listMeasurementRuns }, targets: [{ projectId: "p", localProjectId: null }], enqueue,
      statePath: path, budgetMs: 1_000, maxConcurrency: 1, now: () => clock,
    };

    await discoverBulkRuns(opts);
    await discoverBulkRuns(opts);
    expect(seen).toEqual(old.map((item) => item.measurement_run_id));
    expect(listMeasurementRuns).toHaveBeenCalledTimes(1);

    await discoverBulkRuns(opts);
    clock = 5 * 60_000;
    await discoverBulkRuns(opts);
    expect(listMeasurementRuns.mock.calls.map(([, query]) => query?.cursor)).toEqual([undefined, "deep", undefined]);
    expect(seen).toContain("new-head");
  });

  it("does not replay a committed prefix after an enqueue failure", async () => {
    const path = await statePath();
    const runs = [run("prefix-1"), run("prefix-2"), run("prefix-3")];
    const listMeasurementRuns = vi.fn(async () => page(runs, "deep"));
    const seen: string[] = [];
    let failSecond = true;
    const enqueue = vi.fn(async (item: MeasurementRunSummary) => {
      if (failSecond && seen.length === 1) { failSecond = false; throw new Error("registration failed"); }
      seen.push(item.measurement_run_id);
    });
    const opts = {
      client: { listMeasurementRuns }, targets: [{ projectId: "p", localProjectId: null }], enqueue,
      statePath: path, budgetMs: 10_000, maxConcurrency: 1,
    };

    const first = await discoverBulkRuns(opts);
    expect(first.failures).toEqual([{ projectId: "p", code: "Error" }]);
    expect((await readBulkDiscoveryState(path)).projects.p?.pending).toMatchObject({ index: 1 });
    await discoverBulkRuns(opts);
    expect(seen).toEqual(["prefix-1", "prefix-2", "prefix-3"]);
    expect(enqueue.mock.calls.map(([item]) => item.measurement_run_id)).toEqual(["prefix-1", "prefix-2", "prefix-2", "prefix-3"]);
  });

  it("rejects a malformed persisted pending page before any source read", async () => {
    const path = await statePath();
    await writeFile(path, JSON.stringify({ version: 1, nextProjectIndex: 0, projects: {
      p: { cursor: null, pending: { cursor: null, nextCursor: "deep", readAt: "invalid", head: true,
        priorCursor: null, runs: [{ measurement_run_id: "r", project_id: "p", status: "completed", total_jobs: 10001 }], index: 0 } },
    } }));
    await expect(discoverBulkRuns({
      client: { listMeasurementRuns: vi.fn() }, targets: [{ projectId: "p", localProjectId: null }],
      enqueue: vi.fn(), statePath: path, budgetMs: 100,
    })).rejects.toThrow("Invalid bulk discovery checkpoint");
  });
});
