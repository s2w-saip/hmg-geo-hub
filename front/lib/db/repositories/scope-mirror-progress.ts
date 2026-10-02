import "server-only";

import { and, asc, eq, getTableColumns, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  scopeMirrorProgress,
  type ScopeMirrorProgressRow,
} from "@/lib/db/schema";

export type ScopeMirrorProgressPhase = ScopeMirrorProgressRow["phase"];

export interface ScopeMirrorProgressInput {
  projectId: string;
  runId: string;
  cursor?: string | null;
  state?: Record<string, unknown>;
}

export interface ScopeMirrorProgressListOptions {
  excludeRunIds?: string[];
  retryBefore?: Date;
}

export type ScopeMirrorProgressPatch = Partial<
  Pick<ScopeMirrorProgressRow, "phase" | "cursor" | "state" | "lastError">
> & {
  /** Merge top-level checkpoint metadata without returning/re-sending the plan. */
  stateMerge?: Record<string, unknown>;
};

/** The transaction type exported for a writer that must share this lock. */
export type ScopeMirrorProgressTx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export class ScopeMirrorProgressStaleError extends Error {
  readonly code = "SCOPE_MIRROR_PROGRESS_STALE" as const;

  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly expectedRevision: number,
    readonly expectedPhase: ScopeMirrorProgressPhase,
  ) {
    super("Scope mirror progress is stale");
    this.name = "ScopeMirrorProgressStaleError";
  }
}

export class ScopeMirrorProgressCompletedError extends Error {
  readonly code = "SCOPE_MIRROR_PROGRESS_COMPLETED" as const;

  constructor(readonly projectId: string, readonly runId: string) {
    super("Completed scope mirror progress cannot be changed");
    this.name = "ScopeMirrorProgressCompletedError";
  }
}

export class ScopeMirrorProgressUnavailableError extends Error {
  readonly code = "SCOPE_MIRROR_PROGRESS_UNAVAILABLE" as const;

  constructor() {
    super("scope_mirror_progress table is unavailable; enable the progress feature after applying migration 0073");
    this.name = "ScopeMirrorProgressUnavailableError";
  }
}

function isState(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePatch(patch: ScopeMirrorProgressPatch): void {
  if (patch.phase !== undefined && !["plan", "write", "finalize", "complete", "blocked"].includes(patch.phase)) {
    throw new TypeError("Invalid scope mirror progress phase");
  }
  if (patch.state !== undefined && !isState(patch.state)) {
    throw new TypeError("Scope mirror progress state must be an object");
  }
  if (patch.stateMerge !== undefined && !isState(patch.stateMerge)) {
    throw new TypeError("Scope mirror progress stateMerge must be an object");
  }
  if (patch.state !== undefined && patch.stateMerge !== undefined) {
    throw new TypeError("Scope mirror progress state and stateMerge are mutually exclusive");
  }
}

/** Probe without touching or logging any state payload. */
export async function ensureScopeMirrorProgressAvailable(): Promise<void> {
  const rows = (await getDb().execute(sql`
    SELECT to_regclass('public.scope_mirror_progress') AS table_name
  `)) as unknown as Array<{ table_name: string | null }>;
  if (!rows[0]?.table_name) throw new ScopeMirrorProgressUnavailableError();
}

async function selectOne(
  executor: Pick<ReturnType<typeof getDb>, "select">,
  projectId: string,
  runId: string,
): Promise<ScopeMirrorProgressRow | null> {
  const rows = await executor
    .select()
    .from(scopeMirrorProgress)
    .where(and(eq(scopeMirrorProgress.projectId, projectId), eq(scopeMirrorProgress.runId, runId)))
    .limit(1);
  return rows[0] ?? null;
}

async function lockRun(tx: ScopeMirrorProgressTx, runId: string): Promise<void> {
  // The legacy mirror writer and this progress writer share this lock key so a
  // checkpoint cannot race a run-level replace. The namespace keeps it local
  // to mirror progress locks without exposing any payload or credential.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${runId}, 73451))
  `);
}

export async function createIfAbsent(
  input: ScopeMirrorProgressInput,
): Promise<ScopeMirrorProgressRow> {
  if (input.state !== undefined && !isState(input.state)) {
    throw new TypeError("Scope mirror progress state must be an object");
  }
  await ensureScopeMirrorProgressAvailable();
  const db = getDb();
  return db.transaction(async (tx) => {
    await lockRun(tx, input.runId);
    const inserted = await tx
      .insert(scopeMirrorProgress)
      .values({
        projectId: input.projectId,
        runId: input.runId,
        phase: "plan",
        cursor: input.cursor,
        state: input.state,
      })
      .onConflictDoNothing({ target: [scopeMirrorProgress.projectId, scopeMirrorProgress.runId] })
      .returning();
    return inserted[0] ?? (await selectOne(tx, input.projectId, input.runId)) ??
      (() => { throw new Error("scopeMirrorProgress.createIfAbsent: row disappeared"); })();
  });
}

export async function get(
  projectId: string,
  runId: string,
): Promise<ScopeMirrorProgressRow | null> {
  await ensureScopeMirrorProgressAvailable();
  return selectOne(getDb(), projectId, runId);
}

export async function listPending(
  limit: number,
  options: ScopeMirrorProgressListOptions = {},
): Promise<ScopeMirrorProgressRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive safe integer");
  await ensureScopeMirrorProgressAvailable();
  const conditions = [notInArray(scopeMirrorProgress.phase, ["complete", "blocked"] as const)];
  if (options.excludeRunIds?.length) {
    conditions.push(notInArray(scopeMirrorProgress.runId, options.excludeRunIds));
  }
  if (options.retryBefore) {
    if (Number.isNaN(options.retryBefore.getTime())) throw new RangeError("retryBefore must be a valid date");
    conditions.push(or(isNull(scopeMirrorProgress.lastError), lte(scopeMirrorProgress.updatedAt, options.retryBefore))!);
  }
  return getDb()
    .select()
    .from(scopeMirrorProgress)
    .where(and(...conditions))
    .orderBy(asc(scopeMirrorProgress.createdAt), asc(scopeMirrorProgress.projectId), asc(scopeMirrorProgress.runId))
    .limit(limit);
}

export async function advance(
  expectedRow: ScopeMirrorProgressRow,
  patch: ScopeMirrorProgressPatch,
  write?: (tx: ScopeMirrorProgressTx) => Promise<void>,
): Promise<ScopeMirrorProgressRow> {
  validatePatch(patch);
  await ensureScopeMirrorProgressAvailable();
  const db = getDb();
  return db.transaction(async (tx) => {
    await lockRun(tx, expectedRow.runId);
    const current = await tx
      .select({ phase: scopeMirrorProgress.phase, revision: scopeMirrorProgress.revision })
      .from(scopeMirrorProgress)
      .where(and(eq(scopeMirrorProgress.projectId, expectedRow.projectId), eq(scopeMirrorProgress.runId, expectedRow.runId)))
      .for("update")
      .limit(1);
    const row = current[0];
    if (!row || row.revision !== expectedRow.revision || row.phase !== expectedRow.phase) {
      throw new ScopeMirrorProgressStaleError(
        expectedRow.projectId,
        expectedRow.runId,
        expectedRow.revision,
        expectedRow.phase,
      );
    }
    if (row.phase === "complete") {
      throw new ScopeMirrorProgressCompletedError(expectedRow.projectId, expectedRow.runId);
    }
    if (write) await write(tx);

    const next = await tx
      .update(scopeMirrorProgress)
      .set({
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.stateMerge !== undefined
          ? { state: sql`${scopeMirrorProgress.state} || ${JSON.stringify(patch.stateMerge)}::jsonb` }
          : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(scopeMirrorProgress.projectId, expectedRow.projectId),
        eq(scopeMirrorProgress.runId, expectedRow.runId),
        eq(scopeMirrorProgress.phase, row.phase),
        eq(scopeMirrorProgress.revision, row.revision),
      ))
      .returning({ revision: scopeMirrorProgress.revision, updatedAt: scopeMirrorProgress.updatedAt });
    if (!next[0]) throw new Error("scopeMirrorProgress.advance: row disappeared");
    return {
      ...expectedRow,
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.stateMerge !== undefined
        ? { state: { ...expectedRow.state, ...patch.stateMerge } }
        : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      revision: next[0].revision,
      updatedAt: next[0].updatedAt,
    };
  });
}

export const scopeMirrorProgressRepository = {
  createIfAbsent,
  get,
  listPending,
  advance,
  async getForRegistration(projectId: string, runId: string): Promise<ScopeMirrorProgressRow | null> {
    await ensureScopeMirrorProgressAvailable();
    const [row] = await getDb().select({
      ...getTableColumns(scopeMirrorProgress),
      // Discovery needs only the phase while a run is active. Do not transfer
      // a tens-of-MB plan on every lightweight run-list poll.
      state: sql<Record<string, unknown>>`CASE WHEN ${scopeMirrorProgress.phase} IN ('complete', 'blocked')
        THEN ${scopeMirrorProgress.state} ELSE '{}'::jsonb END`,
    }).from(scopeMirrorProgress).where(and(
      eq(scopeMirrorProgress.projectId, projectId), eq(scopeMirrorProgress.runId, runId),
    )).limit(1);
    return row ?? null;
  },
  async listRecheckable(now = new Date()): Promise<ScopeMirrorProgressRow[]> {
    await ensureScopeMirrorProgressAvailable();
    return getDb().select().from(scopeMirrorProgress).where(and(
      eq(scopeMirrorProgress.phase, "complete"),
      sql`${scopeMirrorProgress.state}->'recheck'->>'version' = '1'`,
      sql`${scopeMirrorProgress.state}->'recheck'->'groups'->0->>'status' IS NOT NULL`,
      sql`${scopeMirrorProgress.state}->'recheck'->>'nextCheckAt' <= ${now.toISOString()}`,
    )).orderBy(asc(sql`${scopeMirrorProgress.state}->'recheck'->>'nextCheckAt'`), asc(scopeMirrorProgress.createdAt)).limit(1);
  },
  /** Read-only source observation: never advance the data-change timestamp. */
  async saveRecheck(expected: ScopeMirrorProgressRow, recheck: object): Promise<ScopeMirrorProgressRow> {
    if (expected.phase !== "complete" || !isState(recheck)) throw new TypeError("Rechecks require a completed receipt");
    await ensureScopeMirrorProgressAvailable();
    return getDb().transaction(async (tx) => {
      await lockRun(tx, expected.runId);
      const rows = await tx.update(scopeMirrorProgress).set({
        state: sql`jsonb_set(${scopeMirrorProgress.state}, '{recheck}', ${JSON.stringify(recheck)}::jsonb)`,
        revision: expected.revision + 1,
        // updatedAt is consumed by summary swap as a data-change watermark.
        // A filtered GET and its scan cursor do not change mirrored answers.
      }).where(and(
        eq(scopeMirrorProgress.projectId, expected.projectId), eq(scopeMirrorProgress.runId, expected.runId),
        eq(scopeMirrorProgress.phase, "complete"), eq(scopeMirrorProgress.revision, expected.revision),
      )).returning({ revision: scopeMirrorProgress.revision });
      if (!rows[0]) throw new ScopeMirrorProgressStaleError(expected.projectId, expected.runId, expected.revision, expected.phase);
      return { ...expected, revision: rows[0].revision, state: { ...expected.state, recheck } };
    });
  },
  async restart(expected: ScopeMirrorProgressRow, state: Record<string, unknown>): Promise<ScopeMirrorProgressRow> {
    if (!["complete", "blocked"].includes(expected.phase)) throw new Error("Only finished or source-blocked work can be replanned");
    if (!isState(state)) throw new TypeError("Scope mirror progress state must be an object");
    await ensureScopeMirrorProgressAvailable();
    return getDb().transaction(async (tx) => {
      await lockRun(tx, expected.runId);
      const rows = await tx.select().from(scopeMirrorProgress).where(and(
        eq(scopeMirrorProgress.projectId, expected.projectId), eq(scopeMirrorProgress.runId, expected.runId),
      )).for("update").limit(1);
      const current = rows[0];
      if (!current || current.revision !== expected.revision || current.phase !== expected.phase) {
        throw new ScopeMirrorProgressStaleError(expected.projectId, expected.runId, expected.revision, expected.phase);
      }
      if (!isState(current.state)) throw new TypeError("Scope mirror progress state must be an object");
      const next = await tx.update(scopeMirrorProgress).set({
        phase: "plan", cursor: null, state, lastError: null, revision: current.revision + 1,
        createdAt: new Date(), updatedAt: new Date(),
      }).where(and(eq(scopeMirrorProgress.projectId, expected.projectId), eq(scopeMirrorProgress.runId, expected.runId))).returning();
      if (!next[0]) throw new Error("scopeMirrorProgress.restart: row disappeared");
      return next[0];
    });
  },
  async counts(): Promise<{ pending: number; blocked: number; oldestReadyAt: string | null }> {
    await ensureScopeMirrorProgressAvailable();
    const rows = await getDb().execute(sql`SELECT
      count(*) FILTER (WHERE phase NOT IN ('complete', 'blocked'))::int AS pending,
      count(*) FILTER (WHERE phase = 'blocked')::int AS blocked,
      min(COALESCE(state->'source'->>'completed_at', state->>'readyObservedAt')) FILTER (
        WHERE phase NOT IN ('complete', 'blocked')
          AND COALESCE(state->'source'->>'completed_at', state->>'readyObservedAt') IS NOT NULL
      ) AS oldest_ready_at
      FROM scope_mirror_progress`);
    const row = (rows as unknown as Array<{
      pending: number;
      blocked: number;
      oldest_ready_at: string | null;
    }>)[0];
    if (!row) throw new Error("scopeMirrorProgress.counts: aggregate row missing");
    return {
      pending: Number(row.pending),
      blocked: Number(row.blocked),
      oldestReadyAt: row.oldest_ready_at ?? null,
    };
  },
};
