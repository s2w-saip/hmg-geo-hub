import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeMirrorProgressRow } from "@/lib/db/schema";
import type { MeasurementJob } from "@/lib/scope/types";
import type { ScopeClient } from "@/lib/scope/client";
import {
  initialBulkRunState,
  resumeBulkRunStep,
  type BulkVisibility,
} from "./bulk-run";
import { BulkSourceChangedError } from "./bulk-plan";

type Payload = { answers: string[]; acrRows: number; finalized: boolean };
type Tx = {
  payload: Payload;
  visibilityHeld: boolean;
  expectedAcrRows: number;
  execute: ReturnType<typeof vi.fn>;
};

const h = vi.hoisted(() => ({
  advance: vi.fn(),
  prepareMirrorWrite: vi.fn(),
  writeMirrorChunk: vi.fn(),
  appendJobRows: vi.fn(),
  calls: [] as Array<{ cursor?: string; include?: string }>,
  writeCalls: [] as Array<{ answers: number; acr: number; finalize: boolean }>,
}));

vi.mock("@/lib/db/repositories/scope-mirror-progress", () => ({
  scopeMirrorProgressRepository: { advance: h.advance },
}));
vi.mock("@/lib/db/repositories/scope-mirror", async () => ({
  prepareMirrorWrite: h.prepareMirrorWrite,
  writeMirrorChunk: h.writeMirrorChunk,
}));
vi.mock("@/lib/scope/paging", () => ({ assertScopeDeadline: vi.fn() }));
vi.mock("@/lib/scope/read-deadline", () => ({
  withScopeReadDeadline: (client: ScopeClient) => client,
}));
vi.mock("./sync", async () => {
  const actual = await vi.importActual<typeof import("./sync")>("./sync");
  return { ...actual, appendJobRows: h.appendJobRows };
});

const PROJECT = "project-1";
const RUN = "run-1";

function job(i: number): MeasurementJob {
  return {
    job_id: `job-${String(i).padStart(2, "0")}`,
    prompt_id: `prompt-${i}`,
    target: "chatgpt",
    region: "KR",
    status: "completed",
    measured_at: `2026-09-15T00:${String(i).padStart(2, "2")}:00.000Z`,
    result: {
      answer_text: `answer-${i}`,
      citations: [],
      measured_at: `2026-09-15T00:${String(i).padStart(2, "2")}:00.000Z`,
    },
    analysis: {
      status: "completed",
      acr_summary: {
        prompt_run_id: `prompt-run-${i}`,
        rows: [{
          rollupLevel: "brand",
          entityId: `entity-${i}`,
          plannedIterations: 3,
          validTurn1Iterations: 3,
          validAcrIterations: 3,
          appearanceCount: 2,
          choiceCount: 1,
          conditionalChoiceCount: 0,
          appearanceRate: 0.66,
          acr: 0.33,
          overallChoiceShare: 0.33,
          offShortlistChoiceCount: 0,
          unresolvedChoiceCount: 0,
          genericChoiceCount: 0,
        }],
      },
    },
  };
}

const JOBS = Array.from({ length: 26 }, (_, i) => job(i));
const PAGES = [
  { data: JOBS.slice(0, 13), next_cursor: "p1" },
  { data: JOBS.slice(13), next_cursor: null },
];

function source() {
  return {
    measurement_run_id: RUN,
    project_id: PROJECT,
    trigger: "manual",
    status: "completed",
    targets: ["chatgpt"],
    regions: ["KR"],
    total_jobs: JOBS.length,
    started_at: "2026-09-15T00:00:00.000Z",
    completed_at: "2026-09-15T01:00:00.000Z",
  };
}

function row(patch: Partial<ScopeMirrorProgressRow> = {}): ScopeMirrorProgressRow {
  return {
    projectId: PROJECT,
    runId: RUN,
    phase: "plan",
    cursor: null,
    state: initialBulkRunState(source()),
    revision: 0,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
    updatedAt: new Date("2026-09-15T00:00:00.000Z"),
    lastError: null,
    ...patch,
  };
}

function jsonRestart<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeClient(failure?: () => Error | undefined): ScopeClient {
  return {
    listRunJobs: vi.fn(async (_projectId, _runId, options) => {
      const cursor = options?.cursor;
      h.calls.push({ cursor, include: options?.include });
      const error = failure?.();
      if (error) throw error;
      return cursor ? PAGES[1]! : PAGES[0]!;
    }),
  } as unknown as ScopeClient;
}

function makeStore(initial = row()) {
  const store: {
    row: ScopeMirrorProgressRow;
    payload: Payload;
    held: boolean;
    loseResponse: boolean;
    lock: Promise<unknown>;
  } = {
    row: initial,
    payload: { answers: [], acrRows: 0, finalized: false },
    held: false,
    loseResponse: false,
    lock: Promise.resolve(),
  };

  h.advance.mockImplementation((expected, patch, write) => {
    const run = async () => {
      const current = store.row;
      if (current.revision !== expected.revision || current.phase !== expected.phase) {
        throw new Error("Scope mirror progress is stale");
      }
      const tx: Tx = {
        payload: jsonRestart(store.payload),
        visibilityHeld: store.held,
        expectedAcrRows: Number((current.state as { expectedAcrRows?: number }).expectedAcrRows ?? 0),
        execute: vi.fn(async () => [{ differences: 0, acr_rows: tx.expectedAcrRows }]),
      };
      if (write) await write(tx as never);
      store.payload = tx.payload;
      store.held = tx.visibilityHeld;
      const statePatch = (patch as { state?: Record<string, unknown>; stateMerge?: Record<string, unknown> });
      store.row = {
        ...current,
        ...patch,
        state: statePatch.state ?? (statePatch.stateMerge
          ? { ...current.state, ...statePatch.stateMerge }
          : current.state),
        revision: current.revision + 1,
        updatedAt: new Date("2026-09-15T00:00:01.000Z"),
      };
      if (store.loseResponse) {
        store.loseResponse = false;
        throw new Error("response lost after commit");
      }
      return store.row;
    };
    store.lock = store.lock.then(run, run);
    return store.lock;
  });
  return store;
}

function visibility(store: ReturnType<typeof makeStore>, failures?: { invalidate?: boolean }): BulkVisibility {
  return {
    prepare: vi.fn(async (tx: unknown) => {
      (tx as Tx).visibilityHeld = true;
      return { hidden: true };
    }),
    assertHeld: vi.fn(async (tx: unknown) => {
      if (!(tx as Tx).visibilityHeld) throw new Error("visibility hold missing");
    }),
    publish: vi.fn(async (tx: unknown) => {
      if (!(tx as Tx).visibilityHeld) throw new Error("visibility hold missing");
      (tx as Tx).payload.finalized = true;
    }),
    invalidate: vi.fn(async () => {
      if (failures?.invalidate) throw new Error("invalidate failed");
    }),
  };
}

function opts(client: ScopeClient, vis: BulkVisibility) {
  return {
    client,
    canonicalizer: { canonicalize: (value: string) => value } as never,
    visibility: vis,
    deadlineAt: Date.now() + 60_000,
  };
}

async function step(store: ReturnType<typeof makeStore>, options: ReturnType<typeof opts>) {
  store.row = jsonRestart(await resumeBulkRunStep(jsonRestart(store.row), options));
  return store.row;
}

async function toJobs(store: ReturnType<typeof makeStore>, options: ReturnType<typeof opts>) {
  await step(store, options); // plan page 1
  await step(store, options); // plan page 2 → prepare
  await step(store, options); // prepare
  await step(store, options); // invalidate hidden
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.writeCalls.length = 0;
  h.prepareMirrorWrite.mockResolvedValue({ anchors: false, drops: false, occAvailable: false, stances: false });
  h.appendJobRows.mockImplementation(async (item: MeasurementJob, ctx: { sink: { answers: unknown[] }; catalogStatusUpdates: Map<string, unknown> }) => {
    ctx.sink.answers.push({ jobId: item.job_id });
    if (item.prompt_id) ctx.catalogStatusUpdates.set(item.prompt_id, "done");
    return false;
  });
  h.writeMirrorChunk.mockImplementation(async (tx: Tx, _run: unknown, answers: unknown[], _m: unknown[], _c: unknown[], acr: unknown[], _o: unknown[], _stances: unknown[], _caps: unknown, options: { finalize?: boolean }) => {
    tx.payload.answers.push(...answers.map((answer: { jobId: string }) => answer.jobId));
    tx.payload.acrRows += acr.length;
    if (options.finalize) tx.payload.finalized = true;
    h.writeCalls.push({ answers: answers.length, acr: acr.length, finalize: options.finalize === true });
  });
});

describe("bulk mirror runner checkpoint boundaries", () => {
  it("does not re-fetch the first plan page after a second-page failure", async () => {
    let failed = false;
    const client = makeClient(() => {
      if (!failed && h.calls.length === 2) {
        failed = true;
        return new Error("plan page failed");
      }
      return undefined;
    });
    const store = makeStore();
    const vis = visibility(store);
    const o = opts(client, vis);

    await step(store, o);
    await expect(resumeBulkRunStep(jsonRestart(store.row), o)).rejects.toThrow("plan page failed");
    expect(store.row.cursor).toBe("p1");
    await step(store, o);
    expect(h.calls.map((call) => call.cursor)).toEqual([undefined, "p1", "p1"]);
    expect(h.calls.filter((call) => call.cursor === undefined)).toHaveLength(1);
  });

  it("rolls back a failed page and resumes a committed page after response loss", async () => {
    const store = makeStore();
    const client = makeClient();
    const vis = visibility(store);
    const o = opts(client, vis);
    await toJobs(store, o);

    await step(store, o);
    expect(store.payload.answers).toHaveLength(13);
    const before = jsonRestart(store.payload);
    h.writeMirrorChunk.mockRejectedValueOnce(new Error("page 2 failed"));
    await expect(resumeBulkRunStep(jsonRestart(store.row), o)).rejects.toThrow("page 2 failed");
    expect(store.payload).toEqual(before);
    expect(store.row.cursor).toBe("p1");

    store.loseResponse = true;
    await expect(resumeBulkRunStep(jsonRestart(store.row), o)).rejects.toThrow("response lost after commit");
    expect(store.row.cursor).toBeNull();
    expect(store.row.state).toMatchObject({ pageIndex: 2, step: "acr" });
    await step(store, o);
    expect(store.payload.answers).toHaveLength(26);
    expect(h.writeCalls.filter((call) => call.answers === 13)).toHaveLength(2);
  });

  it("allows only one duplicate worker to pass the revision CAS", async () => {
    const store = makeStore();
    const client = makeClient();
    const vis = visibility(store);
    const o = opts(client, vis);
    await toJobs(store, o);
    const duplicate = jsonRestart(store.row);
    const results = await Promise.allSettled([
      resumeBulkRunStep(duplicate, o),
      resumeBulkRunStep(duplicate, o),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(h.writeCalls).toHaveLength(1);
  });

  it("does not finalize or publish before all job and ACR chunks finish", async () => {
    const store = makeStore();
    const client = makeClient();
    const vis = visibility(store);
    const o = opts(client, vis);
    await toJobs(store, o);
    await step(store, o);
    await step(store, o);
    expect(store.row.state).toMatchObject({ step: "acr" });
    expect(h.writeCalls.every((call) => !call.finalize)).toBe(true);
    expect(vis.publish).not.toHaveBeenCalled();
    await step(store, o); // ACR rows 0..24
    expect(store.row.state).toMatchObject({ step: "acr", acrIndex: 25 });
    expect(vis.publish).not.toHaveBeenCalled();
    await step(store, o); // final ACR row
    expect(store.row.state).toMatchObject({ step: "verify" });
    expect(h.writeCalls.every((call) => !call.finalize)).toBe(true);
    await step(store, o); // verification/finalize watermark
    expect(h.writeCalls.at(-1)?.finalize).toBe(true);
    expect(vis.publish).not.toHaveBeenCalled();
    await step(store, o);
    expect(vis.publish).toHaveBeenCalledTimes(1);
  });

  it("requests stance payloads for the durable job pass", async () => {
    const store = makeStore();
    const client = makeClient();
    const vis = visibility(store);
    const o = opts(client, vis);
    await toJobs(store, o);

    await step(store, o);

    expect(h.calls.at(-1)?.include).toBe("result,occurrences,stances");
    expect(h.writeMirrorChunk.mock.calls[0]?.[7]).toEqual([]);
  });

  it("does not write payload after hidden invalidation fails", async () => {
    const store = makeStore();
    const client = makeClient();
    const vis = visibility(store, { invalidate: true });
    const o = opts(client, vis);
    await step(store, o);
    await step(store, o);
    await step(store, o);
    await expect(resumeBulkRunStep(jsonRestart(store.row), o)).rejects.toThrow("invalidate failed");
    expect(store.row.state).toMatchObject({ step: "invalidate-hidden" });
    expect(store.payload.answers).toHaveLength(0);
    expect(h.writeMirrorChunk).not.toHaveBeenCalled();
  });

  it("rejects plan content drift before exposing any payload write", async () => {
    const store = makeStore();
    const client = makeClient();
    const vis = visibility(store);
    const o = opts(client, vis);
    await toJobs(store, o);
    const original = JOBS[0];
    (PAGES[0]!.data[0] as MeasurementJob).status = "failed";
    await expect(resumeBulkRunStep(jsonRestart(store.row), o)).rejects.toBeInstanceOf(BulkSourceChangedError);
    expect(store.payload.answers).toHaveLength(0);
    expect(h.writeMirrorChunk).not.toHaveBeenCalled();
    PAGES[0]!.data[0] = original!;
  });
});
