import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type { ScopeMirrorProgressRow } from "@/lib/db/schema";
import { initialBulkRunState } from "@/lib/scope/mirror/bulk-run";
import {
  bulkGenerationDrift,
  createBulkCycleVisibility,
  type BulkCycleVisibilityState,
} from "./scope-mirror-bulk-cycles";

const dialect = new PgDialect();
const PROJECT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const RUN2 = "55555555-5555-5555-5555-555555555555";
const CYCLE = "33333333-3333-3333-3333-333333333333";
const ANCHOR = "2026-09-15T00:00:00.123Z";

function source(totalJobs = 2, runId = RUN) {
  return {
    measurement_run_id: runId,
    project_id: PROJECT,
    trigger: "manual",
    status: "completed",
    targets: ["chatgpt"],
    regions: ["KR"],
    total_jobs: totalJobs,
    started_at: "2026-09-15T00:00:00.000Z",
    completed_at: "2026-09-15T01:00:00.000Z",
    cycle_anchor_at: ANCHOR,
  };
}

function row(totalJobs = 2, statePatch: Record<string, unknown> = {}, runId = RUN): ScopeMirrorProgressRow {
  return {
    projectId: PROJECT,
    runId,
    phase: "write",
    cursor: null,
    state: { ...initialBulkRunState(source(totalJobs, runId)), ...statePatch },
    revision: 2,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
    updatedAt: new Date("2026-09-15T00:00:01.000Z"),
    lastError: null,
  };
}

function cycle(patch: Partial<{
  hidden_reason: string | null;
  hidden_at: string | null;
  hidden_scope: string | null;
}> = {}) {
  return {
    cycle_id: CYCLE,
    project_id: PROJECT,
    cycle_anchor_at: "2026-09-15 00:00:00.123+00",
    hidden_reason: null,
    hidden_at: null,
    hidden_scope: null,
    ...patch,
  };
}

function queryText(query: unknown): string {
  return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
}

function txWith(handler: (text: string) => unknown) {
  const execute = vi.fn(async (query: unknown) => handler(queryText(query)));
  return { execute };
}

function hiddenState(before: {
  hiddenReason: string | null;
  hiddenAt: string | null;
  hiddenScope: string | null;
}, hiddenAt = "2026-09-15T02:00:00.000Z", hiddenAtDb = "2026-09-15 02:00:00+00"): BulkCycleVisibilityState {
  return {
    version: 1,
    source: { runId: RUN, projectId: PROJECT, cycleAnchorAt: ANCHOR },
    cycles: [{
      cycleId: CYCLE,
      before,
      owned: { hiddenReason: "operator", hiddenAt, hiddenAtDb, hiddenScope: "all" },
    }],
  };
}

describe("bulk cycle visibility adapter", () => {
  it("locks the exact project/anchor cycle, writes an ISO-ms owner stamp, and preserves DB text precision", async () => {
    const tx = txWith((text) => {
      if (text.includes("FROM summary_cycles c")) return [cycle()];
      if (text.includes("FROM scope_mirror_progress p")) return [];
      if (text.includes("UPDATE summary_cycles")) {
        return [{ hidden_at: "2026-09-15 02:00:00.123456+00" }];
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const vis = createBulkCycleVisibility(async () => {});
    const out = await vis.prepare(tx as never, row());
    const state = out as unknown as BulkCycleVisibilityState;
    expect(state.cycles[0]?.owned).toMatchObject({
      hiddenReason: "operator",
      hiddenScope: "all",
      hiddenAt: expect.stringMatching(/\.\d{3}Z$/),
      hiddenAtDb: "2026-09-15 02:00:00.123456+00",
    });
    const texts = tx.execute.mock.calls.map(([q]) => queryText(q));
    expect(texts[0]).toMatch(/c\.project_id = \$\d+::uuid/);
    expect(texts[0]).toMatch(/c\.cycle_anchor_at = \$\d+::timestamptz/);
    expect(texts[0]).toContain("FOR UPDATE");
    expect(texts.some((text) => text.includes("hidden_at::text AS hidden_at"))).toBe(true);
  });

  it("uses existing run membership when anchor is absent, but rejects an oversized anchorless source", async () => {
    const anchorless = row(2, { source: source(2) as unknown });
    (anchorless.state.source as Record<string, unknown>).cycle_anchor_at = null;
    const tx = txWith((text) => {
      if (text.includes("FROM summary_cycles c")) return [];
      throw new Error(`unexpected query: ${text}`);
    });
    const vis = createBulkCycleVisibility(async () => {});
    const out = await vis.prepare(tx as never, anchorless);
    expect((out as unknown as BulkCycleVisibilityState).cycles).toEqual([]);
    expect(queryText(tx.execute.mock.calls[0]![0])).toContain("FROM summary_cycle_runs cr");

    const oversized = row(10_001, { source: source(10_001) as unknown });
    (oversized.state.source as Record<string, unknown>).cycle_anchor_at = null;
    await expect(vis.prepare(tx as never, oversized)).rejects.toThrow("requires cycle_anchor_at");
  });

  it("inherits another worker's original values only when its current owned stamp matches", async () => {
    const original = { hiddenReason: null, hiddenAt: null, hiddenScope: null };
    const other = hiddenState(original, "2026-09-15T02:00:00.000Z", "2026-09-15 02:00:00.123456+00");
    const tx = txWith((text) => {
      if (text.includes("FROM summary_cycles c")) return [cycle({
        hidden_reason: "operator",
        hidden_at: "2026-09-15 02:00:00.123456+00",
        hidden_scope: "all",
      })];
      if (text.includes("FROM scope_mirror_progress p")) return [{ run_id: "other", state: { visibility: other } }];
      throw new Error(`unexpected query: ${text}`);
    });
    const out = await createBulkCycleVisibility(async () => {}).prepare(tx as never, row());
    expect((out as unknown as BulkCycleVisibilityState).cycles[0]?.before).toEqual(original);
    expect(tx.execute.mock.calls.some(([q]) => queryText(q).includes("UPDATE summary_cycles"))).toBe(false);
    const progressQuery = tx.execute.mock.calls.map(([q]) => queryText(q)).find((text) => text.includes("FROM scope_mirror_progress p"));
    expect(progressQuery).toContain("p.state->>'step' = 'invalidate-published'");
    expect(progressQuery).toContain("vc->'owned' IS NOT NULL");
  });

  it("allows an operator reason change while held, but never restores a changed/non-all cycle", async () => {
    const state = hiddenState({ hiddenReason: null, hiddenAt: null, hiddenScope: null });
    const held = row(2, { visibility: state });
    const tx = txWith((text) => {
      if (text.includes("FROM summary_cycles c")) return [cycle({
        hidden_reason: "collection_error",
        hidden_at: "2026-09-15 02:00:00+00",
        hidden_scope: "all",
      })];
      if (text.includes("FROM scope_mirror_progress p")) return [];
      throw new Error(`unexpected query: ${text}`);
    });
    const vis = createBulkCycleVisibility(async () => {});
    await expect(vis.assertHeld(tx as never, held)).resolves.toBeUndefined();

    const changedScope = txWith((text) => {
      if (text.includes("FROM summary_cycles c")) return [cycle({
        hidden_reason: "operator",
        hidden_at: "2026-09-15 02:00:00+00",
        hidden_scope: "citations",
      })];
      if (text.includes("FROM scope_mirror_progress p")) return [];
      throw new Error(`unexpected query: ${text}`);
    });
    await expect(vis.assertHeld(changedScope as never, held)).rejects.toThrow("hold lost cycle");
  });

  it("masks a preexisting citations-only hide to all while preserving its original state", async () => {
    const tx = txWith((text) => {
      if (text.includes("FROM summary_cycles c")) return [cycle({
        hidden_reason: "collection_error",
        hidden_at: "2026-09-15 02:00:00+00",
        hidden_scope: "citations",
      })];
      if (text.includes("FROM scope_mirror_progress p")) return [];
      if (text.includes("UPDATE summary_cycles")) return [{ hidden_at: "2026-09-15 03:00:00+00" }];
      throw new Error(`unexpected query: ${text}`);
    });
    const out = await createBulkCycleVisibility(async () => {}).prepare(tx as never, row());
    const state = out as unknown as BulkCycleVisibilityState;
    expect(state.cycles[0]?.before).toEqual({
      hiddenReason: "collection_error",
      hiddenAt: "2026-09-15 02:00:00+00",
      hiddenScope: "citations",
    });
    expect(state.cycles[0]?.owned).toMatchObject({ hiddenReason: "operator", hiddenScope: "all" });
    const update = tx.execute.mock.calls.map(([q]) => queryText(q)).find((text) => text.includes("UPDATE summary_cycles"));
    expect(update).toContain("IS NOT DISTINCT FROM");
  });

  it("restores only its own unchanged all-hide after no same-source worker remains", async () => {
    const state = hiddenState({ hiddenReason: null, hiddenAt: null, hiddenScope: null });
    const tx = txWith((text) => {
      if (text.includes("FROM summary_cycles c")) return [cycle({
        hidden_reason: "operator",
        hidden_at: "2026-09-15 02:00:00+00",
        hidden_scope: "all",
      })];
      if (text.includes("FROM scope_mirror_progress p")) return [];
      if (text.includes("UPDATE summary_cycles")) return [];
      throw new Error(`unexpected query: ${text}`);
    });
    await createBulkCycleVisibility(async () => {}).publish(tx as never, row(2, { visibility: state }));
    const update = tx.execute.mock.calls.map(([q]) => queryText(q)).find((text) => text.includes("UPDATE summary_cycles"));
    expect(update).toContain("hidden_reason");
    expect(update).toContain("hidden_at");
    expect(update).toContain("hidden_scope");
    expect(update).toContain("COALESCE(hidden_scope, 'all')");
  });

  it("does not restore while another same-source unfinished bulk owns the cycle", async () => {
    const state = hiddenState({ hiddenReason: null, hiddenAt: null, hiddenScope: null });
    const other = { ...state, source: { ...state.source, runId: "other" } };
    const tx = txWith((text) => {
      if (text.includes("FROM summary_cycles c")) return [cycle({
        hidden_reason: "operator",
        hidden_at: "2026-09-15 02:00:00+00",
        hidden_scope: "all",
      })];
      if (text.includes("FROM scope_mirror_progress p")) return [{ run_id: "other", state: { visibility: other } }];
      throw new Error(`unexpected query: ${text}`);
    });
    await createBulkCycleVisibility(async () => {}).publish(tx as never, row(2, { visibility: state }));
    expect(tx.execute.mock.calls.some(([q]) => queryText(q).includes("UPDATE summary_cycles"))).toBe(false);
  });
});

describe("bulkGenerationDrift", () => {
  it("uses summary_generations.started_at and returns the progress predicate result", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ table_name: "scope_mirror_progress" }])
      .mockResolvedValueOnce([{ cycle_id: CYCLE }])
      .mockResolvedValueOnce([{ drift: true }]);
    const drift = await bulkGenerationDrift({ execute } as never, CYCLE, "44444444-4444-4444-4444-444444444444");
    expect(drift).toBe(true);
    expect(queryText(execute.mock.calls[1]![0])).toContain("FOR UPDATE");
    const query = queryText(execute.mock.calls[2]![0]);
    expect(query).toContain("generation.started_at");
    expect(query).not.toContain("generation.created_at");
    expect(query).toContain("p.phase <> 'complete'");
    expect(query).toContain("summary_cycle_runs");
  });

  it("treats an unapplied progress table as no drift and does not hide errors", async () => {
    const missing = vi.fn().mockResolvedValueOnce([{ table_name: null }]);
    await expect(bulkGenerationDrift({ execute: missing } as never, CYCLE, "generation")).resolves.toBe(false);
    expect(missing).toHaveBeenCalledTimes(1);

    const failure = vi.fn().mockRejectedValue(new Error("db unavailable"));
    await expect(bulkGenerationDrift({ execute: failure } as never, CYCLE, "generation")).rejects.toThrow("db unavailable");
  });
});

const integrationUrl = process.env.MIRROR_BULK_CYCLE_TEST_DATABASE_URL;
let integrationEnabled = false;
try {
  if (integrationUrl) {
    const parsed = new URL(integrationUrl);
    integrationEnabled =
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) &&
      parsed.pathname === "/mirror_cycle_test";
  }
} catch {
  integrationEnabled = false;
}

const localDescribe = integrationEnabled ? describe : describe.skip;

localDescribe("bulk cycle visibility — isolated Postgres", () => {
  let connection: Sql;
  let db: ReturnType<typeof drizzle>;

  async function reset() {
    await db.execute(dsql`TRUNCATE TABLE scope_mirror_progress, summary_cycle_runs, summary_generations, summary_cycles`);
  }

  async function insertCycle(tx: { execute: (query: unknown) => Promise<unknown> }, values: {
    hiddenReason?: string | null;
    hiddenAt?: string | null;
    hiddenScope?: string | null;
    cycleAnchorAt?: string;
  } = {}) {
    await tx.execute(dsql`
      INSERT INTO summary_cycles
        (cycle_id, project_id, cycle_anchor_at, status, hidden_reason, hidden_at, hidden_scope)
      VALUES
        (${CYCLE}::uuid, ${PROJECT}::uuid, ${(values.cycleAnchorAt ?? ANCHOR)}::timestamptz, 'published',
         ${values.hiddenReason ?? null},
         ${values.hiddenAt ? dsql`${values.hiddenAt}::timestamptz` : dsql`NULL`},
         ${values.hiddenScope ?? null})
    `);
  }

  async function insertProgress(tx: { execute: (query: unknown) => Promise<unknown> }, runId: string, state: unknown, phase = "write") {
    await tx.execute(dsql`
      INSERT INTO scope_mirror_progress(project_id, run_id, phase, state)
      VALUES (${PROJECT}::uuid, ${runId}::uuid, ${phase}, ${JSON.stringify(state)}::jsonb)
    `);
  }

  beforeAll(async () => {
    connection = postgres(integrationUrl!, { prepare: false, connect_timeout: 5 });
    db = drizzle(connection);
    await connection.unsafe("SET client_min_messages TO warning");
    await connection.unsafe("DROP TABLE IF EXISTS scope_mirror_progress, summary_cycle_runs, summary_generations, summary_cycles CASCADE");
    await connection.unsafe("CREATE TABLE summary_cycles (cycle_id uuid PRIMARY KEY, project_id uuid NOT NULL, cycle_anchor_at timestamptz NOT NULL, status text NOT NULL, hidden_reason text, hidden_at timestamptz, hidden_scope text)");
    await connection.unsafe("CREATE TABLE summary_cycle_runs (cycle_id uuid NOT NULL, run_id uuid NOT NULL UNIQUE, PRIMARY KEY(cycle_id, run_id))");
    await connection.unsafe("CREATE TABLE summary_generations (generation_id uuid PRIMARY KEY, cycle_id uuid NOT NULL, started_at timestamptz NOT NULL)");
    await connection.unsafe("CREATE TABLE scope_mirror_progress (project_id uuid NOT NULL, run_id uuid NOT NULL PRIMARY KEY, phase text NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
  });

  afterAll(async () => {
    await connection.unsafe("DROP TABLE IF EXISTS scope_mirror_progress, summary_cycle_runs, summary_generations, summary_cycles CASCADE");
    await connection.end({ timeout: 5 });
  });

  it("hides/restores a cycle and retains sub-millisecond DB text", async () => {
    await reset();
    await insertCycle(db);
    const vis = createBulkCycleVisibility(async () => {});
    const prepared = await db.transaction((tx) => vis.prepare(tx as never, row()));
    const hidden = await db.execute(dsql`SELECT hidden_reason, hidden_scope, hidden_at::text AS hidden_at FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(hidden[0]).toMatchObject({ hidden_reason: "operator", hidden_scope: "all" });
    expect(String(hidden[0]?.hidden_at)).toMatch(/\.\d{1,6}/);
    // A process restart re-plans from its durable visibility state while the
    // cycle is still masked. The own mask must be recognized as inherited so
    // its original values remain restorable.
    const replanned = await db.transaction((tx) => vis.prepare(tx as never, row(2, { visibility: prepared })));
    expect((replanned as BulkCycleVisibilityState).cycles[0]?.before).toEqual({
      hiddenReason: null,
      hiddenAt: null,
      hiddenScope: null,
    });
    expect((replanned as BulkCycleVisibilityState).cycles[0]?.owned).toMatchObject({ hiddenScope: "all" });
    await db.transaction((tx) => vis.publish(tx as never, row(2, { visibility: replanned })));
    const restored = await db.execute(dsql`SELECT hidden_reason, hidden_at, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(restored[0]).toMatchObject({ hidden_reason: null, hidden_at: null, hidden_scope: null });
  });

  it("honors existing ledger membership when its cycle anchor differs from the source", async () => {
    await reset();
    await insertCycle(db, { cycleAnchorAt: "2026-08-31T00:00:00.000Z" });
    await db.execute(dsql`
      INSERT INTO summary_cycle_runs(cycle_id, run_id)
      VALUES (${CYCLE}::uuid, ${RUN}::uuid)
    `);
    const vis = createBulkCycleVisibility(async () => {});
    const prepared = await db.transaction((tx) => vis.prepare(tx as never, row()));
    expect((prepared as BulkCycleVisibilityState).cycles.map((c) => c.cycleId)).toEqual([CYCLE]);
    const hidden = await db.execute(dsql`SELECT hidden_reason, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(hidden[0]).toMatchObject({ hidden_reason: "operator", hidden_scope: "all" });
    await db.transaction((tx) => vis.publish(tx as never, row(2, { visibility: prepared })));
    const restored = await db.execute(dsql`SELECT hidden_reason, hidden_at, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(restored[0]).toMatchObject({ hidden_reason: null, hidden_at: null, hidden_scope: null });
  });

  it("retains an owned old-anchor cycle across a source-anchor restart without membership", async () => {
    await reset();
    const oldAnchor = "2026-08-31T00:00:00.000Z";
    const newAnchor = "2026-09-15T03:00:36.000Z";
    await insertCycle(db, { cycleAnchorAt: oldAnchor });

    const oldSource = { ...source(), cycle_anchor_at: oldAnchor };
    const oldRow = row(2, { source: oldSource });
    const vis = createBulkCycleVisibility(async () => {});
    const oldVisibility = await db.transaction((tx) => vis.prepare(tx as never, oldRow));
    await insertProgress(db, RUN, { ...oldRow.state, visibility: oldVisibility });
    const checkpoint = await db.execute(dsql`
      SELECT state->'visibility' AS visibility
        FROM scope_mirror_progress
       WHERE run_id = ${RUN}::uuid
    `);
    const persistedVisibility = checkpoint[0]?.visibility as BulkCycleVisibilityState;

    const newRow = row(2, {
      source: { ...oldSource, cycle_anchor_at: newAnchor },
      visibility: persistedVisibility,
    });
    const restartedVisibility = await db.transaction((tx) => vis.prepare(tx as never, newRow));
    expect((restartedVisibility as BulkCycleVisibilityState).cycles[0]?.cycleId).toBe(CYCLE);
    expect((restartedVisibility as BulkCycleVisibilityState).cycles[0]?.before).toEqual({
      hiddenReason: null,
      hiddenAt: null,
      hiddenScope: null,
    });
    expect((restartedVisibility as BulkCycleVisibilityState).cycles[0]?.owned).toMatchObject({ hiddenScope: "all" });

    await db.transaction((tx) => vis.publish(tx as never, row(2, {
      source: { ...oldSource, cycle_anchor_at: newAnchor },
      visibility: restartedVisibility,
    })));
    const restored = await db.execute(dsql`SELECT hidden_reason, hidden_at, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(restored[0]).toMatchObject({ hidden_reason: null, hidden_at: null, hidden_scope: null });
  });

  it("keeps a cycle held for a ledger-member worker whose source anchor differs", async () => {
    await reset();
    await insertCycle(db);
    await db.execute(dsql`
      INSERT INTO summary_cycle_runs(cycle_id, run_id)
      VALUES (${CYCLE}::uuid, ${RUN}::uuid), (${CYCLE}::uuid, ${RUN2}::uuid)
    `);
    const firstVisibility = await db.transaction((tx) => createBulkCycleVisibility(async () => {}).prepare(tx as never, row()));
    await insertProgress(db, RUN, { ...initialBulkRunState(source()), visibility: firstVisibility });

    const otherAnchor = "2026-08-31T03:00:36.000Z";
    const otherSource = { ...source(2, RUN2), cycle_anchor_at: otherAnchor };
    const otherRow = row(2, { source: otherSource }, RUN2);
    const otherVisibility = await db.transaction((tx) => createBulkCycleVisibility(async () => {}).prepare(tx as never, otherRow));
    await insertProgress(db, RUN2, { ...otherRow.state, visibility: otherVisibility });

    await db.transaction((tx) => createBulkCycleVisibility(async () => {}).publish(tx as never, row(2, { visibility: firstVisibility })));
    const held = await db.execute(dsql`SELECT hidden_reason, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(held[0]).toMatchObject({ hidden_reason: "operator", hidden_scope: "all" });

    await db.execute(dsql`
      UPDATE scope_mirror_progress
         SET phase = 'finalize', state = jsonb_set(state, '{step}', '"invalidate-published"'::jsonb)
       WHERE run_id = ${RUN}::uuid
    `);
    await db.transaction((tx) => createBulkCycleVisibility(async () => {}).publish(tx as never, secondRowWithVisibility(otherRow, otherVisibility)));
    const restored = await db.execute(dsql`SELECT hidden_reason, hidden_at, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(restored[0]).toMatchObject({ hidden_reason: null, hidden_at: null, hidden_scope: null });
  });

  it("keeps overlap hidden and the second worker restores after the first completes", async () => {
    await reset();
    await insertCycle(db);
    const firstVisibility = await db.transaction((tx) => createBulkCycleVisibility(async () => {}).prepare(tx as never, row()));
    await insertProgress(db, RUN, { ...initialBulkRunState(source()), visibility: firstVisibility });
    const secondRow = row(2, {}, RUN2);
    const secondVisibility = await db.transaction((tx) => createBulkCycleVisibility(async () => {}).prepare(tx as never, secondRow));
    await insertProgress(db, RUN2, { ...initialBulkRunState(source(2, RUN2)), visibility: secondVisibility });
    await db.transaction((tx) => createBulkCycleVisibility(async () => {}).publish(tx as never, row(2, { visibility: firstVisibility })));
    const held = await db.execute(dsql`SELECT hidden_reason, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(held[0]).toMatchObject({ hidden_reason: "operator", hidden_scope: "all" });
    // The first worker has passed publication invalidation but has not yet
    // committed its final complete phase. The reader gate treats this as
    // finished, allowing the second worker to release the last hold.
    await db.execute(dsql`
      UPDATE scope_mirror_progress
         SET phase = 'finalize', state = jsonb_set(state, '{step}', '"invalidate-published"'::jsonb)
       WHERE run_id = ${RUN}::uuid
    `);
    await db.transaction((tx) => createBulkCycleVisibility(async () => {}).publish(tx as never, secondRowWithVisibility(secondRow, secondVisibility)));
    const restored = await db.execute(dsql`SELECT hidden_reason, hidden_at, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(restored[0]).toMatchObject({ hidden_reason: null, hidden_at: null, hidden_scope: null });
  });

  it("serializes a replan behind the cycle lock and preserves the own mask", async () => {
    await reset();
    await insertCycle(db);
    const vis = createBulkCycleVisibility(async () => {});
    const prepared = await db.transaction((tx) => vis.prepare(tx as never, row()));

    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
    let lockAcquired!: () => void;
    const holderReady = new Promise<void>((resolve) => { lockAcquired = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(dsql`
        SELECT cycle_id FROM summary_cycles
         WHERE cycle_id = ${CYCLE}::uuid
         FOR UPDATE
      `);
      lockAcquired();
      await lockReleased;
    });
    await holderReady;

    let contenderFinished = false;
    const contender = db.transaction(async (tx) => {
      const restarted = await vis.prepare(tx as never, row(2, { visibility: prepared }));
      contenderFinished = true;
      expect((restarted as BulkCycleVisibilityState).cycles[0]?.before).toEqual({
        hiddenReason: null,
        hiddenAt: null,
        hiddenScope: null,
      });
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(contenderFinished).toBe(false);
    } finally {
      releaseLock();
    }
    await Promise.all([holder, contender]);
  });

  it("preserves an operator change while allowing the held gate", async () => {
    await reset();
    await insertCycle(db);
    const vis = createBulkCycleVisibility(async () => {});
    const prepared = await db.transaction((tx) => vis.prepare(tx as never, row()));
    await db.execute(dsql`UPDATE summary_cycles SET hidden_reason = 'collection_error' WHERE cycle_id = ${CYCLE}::uuid`);
    await db.transaction((tx) => vis.assertHeld(tx as never, row(2, { visibility: prepared })));
    await db.transaction((tx) => vis.publish(tx as never, row(2, { visibility: prepared })));
    const kept = await db.execute(dsql`SELECT hidden_reason, hidden_scope FROM summary_cycles WHERE cycle_id = ${CYCLE}::uuid`);
    expect(kept[0]).toMatchObject({ hidden_reason: "collection_error", hidden_scope: "all" });
  });

  it("blocks a generation when a finalize or invalidate-published progress row exists", async () => {
    await reset();
    await insertCycle(db);
    await db.execute(dsql`INSERT INTO summary_generations(generation_id, cycle_id, started_at) VALUES ('44444444-4444-4444-4444-444444444444'::uuid, ${CYCLE}::uuid, '2026-01-01T00:00:00Z'::timestamptz)`);
    await insertProgress(db, RUN, { source: source(), visibility: {} }, "finalize");
    await expect(bulkGenerationDrift(db as never, CYCLE, "44444444-4444-4444-4444-444444444444")).resolves.toBe(true);
    await db.execute(dsql`UPDATE scope_mirror_progress SET phase = 'complete', updated_at = '2025-01-01T00:00:00Z'::timestamptz WHERE run_id = ${RUN}::uuid`);
    await expect(bulkGenerationDrift(db as never, CYCLE, "44444444-4444-4444-4444-444444444444")).resolves.toBe(false);
    await db.execute(dsql`UPDATE scope_mirror_progress SET phase = 'invalidate-published' WHERE run_id = ${RUN}::uuid`);
    await expect(bulkGenerationDrift(db as never, CYCLE, "44444444-4444-4444-4444-444444444444")).resolves.toBe(true);
  });
});

function secondRowWithVisibility(rowValue: ScopeMirrorProgressRow, visibility: BulkCycleVisibilityState): ScopeMirrorProgressRow {
  return { ...rowValue, state: { ...rowValue.state, visibility } };
}
