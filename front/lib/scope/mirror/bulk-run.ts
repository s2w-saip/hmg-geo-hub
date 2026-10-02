import "server-only";
import { sql } from "drizzle-orm";
import type { ScopeMirrorProgressRow } from "@/lib/db/schema";
import {
  scopeMirrorProgressRepository as progress,
  type ScopeMirrorProgressTx,
} from "@/lib/db/repositories/scope-mirror-progress";
import {
  prepareMirrorWrite, writeMirrorChunk,
  type MirrorRun, type MirrorWriteCapabilities,
} from "@/lib/db/repositories/scope-mirror";
import type { ScopeClient } from "@/lib/scope/client";
import type { MeasurementRunSummary } from "@/lib/scope/types";
import { assertScopeDeadline } from "@/lib/scope/paging";
import { withScopeReadDeadline } from "@/lib/scope/read-deadline";
import {
  acrRollupRows, appendJobRows, newMirrorRowSink,
  type CatalogPromptStatus, type MentionCanonicalizer,
} from "./sync";
import {
  addPlanPage, emptyBulkPlan, finalizeBulkPlan, verifyWritePage,
  createBulkRecheck, BULK_RECHECK_INTERVAL_MS,
  type BulkPlan, type BulkRecheckState,
} from "./bulk-plan";

export interface BulkRunState extends Record<string, unknown> {
  version: 1;
  source: MeasurementRunSummary & { cycle_anchor_at?: string | null };
  plan: BulkPlan;
  selected: string[];
  pageIndex: number;
  acrIndex: number;
  expectedAcrRows: number;
  /**
   * 계획이 쓸 ACR prompt_run 별 엔티티 수 `[prompt_run_id, n]` (2026-09-28).
   * verify 는 run_id 가 아니라 이 집합으로 대조한다 — 롤업은 prompt_run 단위로
   * 교체되므로(scope-mirror.ts writeMirrorChunk) 다른 run 이 같은 prompt_run 을
   * 나중에 쓰면 run_id 기준 행 수는 줄어든다. 없으면(이 필드 이전 체크포인트) 종전
   * run_id 행 수 대조로 폴백한다.
   */
  expectedAcr?: Array<[string, number]>;
  answersWritten: number;
  step: "plan" | "prepare" | "invalidate-hidden" | "jobs" | "acr" | "verify" | "publish" | "invalidate-published" | "done";
  catalog: Array<[string, CatalogPromptStatus]>;
  visibility: Record<string, unknown>;
  recheck?: BulkRecheckState | null;
}

/** Required integration with the existing cycle hide/publication mechanism. */
export interface BulkVisibility {
  prepare(tx: ScopeMirrorProgressTx, row: ScopeMirrorProgressRow): Promise<Record<string, unknown>>;
  assertHeld(tx: ScopeMirrorProgressTx, row: ScopeMirrorProgressRow): Promise<void>;
  publish(tx: ScopeMirrorProgressTx, row: ScopeMirrorProgressRow): Promise<void>;
  invalidate(): Promise<void>;
}

export function initialBulkRunState(source: BulkRunState["source"]): BulkRunState {
  if (!["completed", "failed", "partial_failed"].includes(source.status)) {
    throw new Error("Bulk mirror requires a terminal source run");
  }
  if (!source.project_id || !source.measurement_run_id || !Number.isSafeInteger(source.total_jobs) || source.total_jobs < 0) {
    throw new Error("Invalid bulk source run");
  }
  for (const date of [source.started_at, source.completed_at, source.cycle_anchor_at]) {
    if (date != null && !Number.isFinite(Date.parse(date))) throw new Error("Invalid bulk source timestamp");
  }
  return {
    version: 1, source: {
      ...source,
      started_at: new Date(source.started_at).toISOString(),
      completed_at: source.completed_at ? new Date(source.completed_at).toISOString() : null,
      ...(source.cycle_anchor_at ? { cycle_anchor_at: new Date(source.cycle_anchor_at).toISOString() } : {}),
    }, plan: emptyBulkPlan(), selected: [], pageIndex: 0,
    acrIndex: 0, expectedAcrRows: 0, answersWritten: 0, step: "plan",
    catalog: [], visibility: {},
  };
}

export function bulkRunState(row: ScopeMirrorProgressRow): BulkRunState {
  const s = row.state as BulkRunState;
  if (s.version !== 1 || s.source?.measurement_run_id !== row.runId || s.source?.project_id !== row.projectId || s.plan?.version !== 1) {
    throw new Error("Invalid or incompatible bulk mirror checkpoint");
  }
  return s;
}

export function bulkRunRow(source: BulkRunState["source"]): MirrorRun {
  return {
    runId: source.measurement_run_id, projectId: source.project_id,
    status: source.status, totalJobs: source.total_jobs,
    startedAt: source.started_at ? new Date(source.started_at) : null,
    completedAt: source.completed_at ? new Date(source.completed_at) : null,
    ...(source.cycle_anchor_at ? { cycleAnchorAt: new Date(source.cycle_anchor_at) } : {}),
  };
}

/**
 * verify 실패에 이름을 붙인다 — 워커는 `error.name` 을 `lastError` 로 남기므로
 * (bulk-worker.ts) 이름 없는 `Error` 면 커서에 "Error" 만 남아 원인을 못 가른다.
 * 메시지 접두어("Bulk mirror verification failed")는 종전 그대로 유지한다.
 */
export class BulkVerifyMismatchError extends Error {
  constructor(name: "BulkVerifyAnswerMismatch" | "BulkVerifyAcrMismatch", detail: string) {
    super(`Bulk mirror verification failed: ${detail}`);
    this.name = name;
  }
}

/** 계획의 ACR 행 → prompt_run 별 엔티티 수 (순수 함수, 테스트 대상). */
export function expectedAcrByPromptRun(rows: Array<{ promptRunId: string }>): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.promptRunId, (m.get(r.promptRunId) ?? 0) + 1);
  return [...m.entries()];
}

/** Verify identity, not just a count that could hide missing/replaced answers. */
export async function verifyBulkRows(
  tx: ScopeMirrorProgressTx,
  runId: string,
  state: BulkRunState,
  caps: MirrorWriteCapabilities,
): Promise<void> {
  const expectedIds = JSON.stringify(state.selected);
  const dropFilter = caps.drops
    ? sql`WHERE NOT EXISTS (SELECT 1 FROM scope_answer_drops d WHERE d.job_id = e.job_id)`
    : sql``;
  // ACR 대조 (2026-09-28): run_id 행 수가 아니라 **계획의 prompt_run 집합**으로 본다.
  // 롤업은 prompt_run 단위로 교체되므로, 이 run 의 ACR 스텝 뒤·verify 전에 다른 run 이
  // 같은 prompt_run 을 일반 싱크로 쓰면 그 행들의 run_id 가 넘어간다. run_id 로 세면
  // 그때부터 verify 가 영구 실패하고(재시도해도 같은 값) 회차 숨김이 풀리지 않는다.
  // 불일치 = ① 계획한 prompt_run 의 행이 하나도 없다 ② 그 prompt_run 을 전부 이 run 이
  // 쥐고 있는데 엔티티 수가 계획과 다르다 ③ 이 run 소유 행이 계획 밖 prompt_run 에 있다.
  // 다른 run 이 가져간 prompt_run 은 그 writer 의 (더 늦은) 스냅샷이므로 존재만 본다.
  const expectedAcr = state.expectedAcr ? JSON.stringify(state.expectedAcr) : null;
  const acrMismatch = expectedAcr
    ? sql`(
      WITH exp AS (
        SELECT (e->>0)::uuid AS prompt_run_id, (e->>1)::int AS n
          FROM jsonb_array_elements(${expectedAcr}::jsonb) e
      ), act AS (
        SELECT x.prompt_run_id, count(*)::int AS total,
               count(*) FILTER (WHERE x.run_id = ${runId}::uuid)::int AS own
          FROM scope_acr_rollups x
         WHERE x.prompt_run_id IN (SELECT prompt_run_id FROM exp)
         GROUP BY x.prompt_run_id
      )
      SELECT jsonb_build_object(
        'mismatch',
          (SELECT count(*)::int FROM exp LEFT JOIN act USING (prompt_run_id)
            WHERE act.total IS NULL OR (act.own = act.total AND act.total <> exp.n))
          + (SELECT count(*)::int FROM scope_acr_rollups x
              WHERE x.run_id = ${runId}::uuid
                AND x.prompt_run_id NOT IN (SELECT prompt_run_id FROM exp)),
        -- 관측용: 다른 run 이 가져가 **존재만 확인한** prompt_run 수.
        'foreign', (SELECT count(*)::int FROM act WHERE act.own < act.total)
      )
    )`
    : sql`NULL::jsonb`;
  const result = await tx.execute(sql`
    WITH expected_raw AS (
      SELECT value::uuid AS job_id FROM jsonb_array_elements_text(${expectedIds}::jsonb)
    ), expected AS (SELECT e.job_id FROM expected_raw e ${dropFilter}),
    actual AS (SELECT job_id FROM scope_answers WHERE run_id = ${runId}::uuid),
    differences AS (
      (SELECT job_id FROM expected EXCEPT SELECT job_id FROM actual)
      UNION ALL (SELECT job_id FROM actual EXCEPT SELECT job_id FROM expected)
    )
    SELECT (SELECT count(*)::int FROM differences) AS differences,
      (SELECT count(*)::int FROM scope_acr_rollups WHERE run_id = ${runId}::uuid) AS acr_rows,
      ${acrMismatch} AS acr_check
  `) as unknown as Array<{
    differences: number; acr_rows: number;
    acr_check: { mismatch: number; foreign: number } | string | null;
  }>;
  const r = result[0];
  if (!r || Number(r.differences) !== 0) {
    throw new BulkVerifyMismatchError("BulkVerifyAnswerMismatch", `answer differences=${r ? Number(r.differences) : "none"}`);
  }
  if (expectedAcr) {
    const check = typeof r.acr_check === "string" ? JSON.parse(r.acr_check) : r.acr_check;
    const mismatch = Number(check?.mismatch);
    const foreign = Number(check?.foreign ?? 0);
    if (mismatch !== 0) {
      throw new BulkVerifyMismatchError(
        "BulkVerifyAcrMismatch",
        `acr prompt_run mismatches=${mismatch} foreign_owned=${foreign}`,
      );
    }
    if (foreign > 0) {
      console.info(`[mirror] bulk verify run=${runId}: ${foreign} ACR prompt_run(s) owned by other runs (presence-checked only)`);
    }
  } else if (Number(r.acr_rows) !== state.expectedAcrRows) {
    throw new BulkVerifyMismatchError(
      "BulkVerifyAcrMismatch",
      `acr rows=${Number(r.acr_rows)} expected=${state.expectedAcrRows} (legacy run_id count)`,
    );
  }
}

/**
 * Execute one durable step. The next process needs only the returned DB row.
 * Source fetches happen outside the transaction; data and cursor commit together.
 * Callers re-read after any uncertain outcome instead of reusing a stale row.
 */
export async function resumeBulkRunStep(row: ScopeMirrorProgressRow, opts: {
  client: ScopeClient;
  canonicalizer: MentionCanonicalizer;
  visibility: BulkVisibility;
  beforePublish?: (row: ScopeMirrorProgressRow) => Promise<void>;
  deadlineAt: number;
}): Promise<ScopeMirrorProgressRow> {
  if (row.phase === "complete" || row.phase === "blocked") return row;
  assertScopeDeadline(opts.deadlineAt);
  const state = bulkRunState(row);
  const source = bulkRunRow(state.source);
  const client = withScopeReadDeadline(opts.client, opts.deadlineAt);
  const commit = (next: BulkRunState, phase: ScopeMirrorProgressRow["phase"], cursor: string | null,
    write?: (tx: ScopeMirrorProgressTx) => Promise<void>) => {
    assertScopeDeadline(opts.deadlineAt);
    if (next.plan === state.plan) {
      const { plan: _plan, ...stateMerge } = next;
      return progress.advance(row, { stateMerge, phase, cursor, lastError: null }, write);
    }
    return progress.advance(row, { state: next, phase, cursor, lastError: null }, write);
  };

  if (state.step === "plan") {
    const page = await client.listRunJobs(row.projectId, row.runId, { limit: 200, cursor: row.cursor ?? undefined });
    const plan = addPlanPage(state.plan, page, row.cursor);
    const next: BulkRunState = { ...state, plan };
    if (page.next_cursor) return commit(next, "plan", page.next_cursor);
    const ready = finalizeBulkPlan(plan, state.source.total_jobs, row.runId);
    next.selected = ready.selectedJobIds;
    next.expectedAcrRows = ready.acrRollups.length;
    next.expectedAcr = expectedAcrByPromptRun(ready.acrRollups);
    next.recheck = createBulkRecheck(plan.jobs);
    // The payload pass needs page fingerprints and selected IDs, not all slim jobs.
    next.plan = { ...plan, jobs: [] };
    next.step = "prepare";
    return commit(next, "write", null);
  }

  if (state.step === "prepare") {
    const next: BulkRunState = { ...state, step: "invalidate-hidden", visibility: {} };
    return commit(next, "write", null, async (tx) => {
      Object.assign(next.visibility, await opts.visibility.prepare(tx, row));
    });
  }
  if (state.step === "invalidate-hidden") {
    await opts.visibility.invalidate();
    return commit({ ...state, step: "jobs" }, "write", null);
  }

  if (state.step === "jobs") {
    const page = await client.listRunJobs(row.projectId, row.runId, {
      limit: 200, cursor: row.cursor ?? undefined, include: "result,occurrences,stances",
    });
    verifyWritePage(state.plan, state.pageIndex, page);
    const sink = newMirrorRowSink();
    const selected = new Set(state.selected);
    const catalog = new Map(state.catalog);
    for (const job of page.data) {
      if (selected.has(job.job_id)) await appendJobRows(job, {
        client, runId: row.runId, canonicalizer: opts.canonicalizer,
        sink, catalogStatusUpdates: catalog, deadlineAt: opts.deadlineAt, requireResult: true,
      });
    }
    const caps = await prepareMirrorWrite();
    const next: BulkRunState = {
      ...state, pageIndex: state.pageIndex + 1, catalog: [...catalog],
      answersWritten: state.answersWritten + sink.answers.length,
      step: page.next_cursor ? "jobs" : "acr",
    };
    return commit(next, "write", page.next_cursor ?? null, async (tx) => {
      await opts.visibility.assertHeld(tx, row);
      await writeMirrorChunk(tx, source, sink.answers, sink.mentions, sink.citations, [], sink.occurrences, sink.stances, caps, {
        append: state.pageIndex > 0, reset: state.pageIndex === 0, finalize: false,
      });
    });
  }

  if (state.step === "acr") {
    // ACR rows are bounded too: never put the entire run into the first write.
    const end = Math.min(state.plan.snapshots.length, state.acrIndex + 25);
    const acr = acrRollupRows(new Map(state.plan.snapshots.slice(state.acrIndex, end)), new Map(state.plan.names), row.runId);
    const caps = await prepareMirrorWrite();
    const done = end === state.plan.snapshots.length;
    return commit({ ...state, acrIndex: end, step: done ? "verify" : "acr",
      ...(done ? { plan: { ...state.plan, snapshots: [], names: [] } } : {}),
    }, done ? "finalize" : "write", null, async (tx) => {
      await opts.visibility.assertHeld(tx, row);
      await writeMirrorChunk(tx, source, [], [], [], acr, [], [], caps, { append: true, finalize: false });
    });
  }

  if (state.step === "verify") {
    if (state.pageIndex !== state.plan.pages.length || state.answersWritten !== state.selected.length) {
      throw new Error("Bulk mirror has incomplete payload pages");
    }
    const caps = await prepareMirrorWrite();
    return commit({ ...state, step: "publish", plan: emptyBulkPlan(), selected: [], expectedAcr: undefined }, "finalize", null, async (tx) => {
      await opts.visibility.assertHeld(tx, row);
      await verifyBulkRows(tx, row.runId, state, caps);
      await writeMirrorChunk(tx, source, [], [], [], [], [], [], caps, { append: true, finalize: true });
    });
  }

  if (state.step === "publish") {
    await opts.beforePublish?.(row);
    return commit({ ...state, step: "invalidate-published" }, "finalize", null, async (tx) => {
      await opts.visibility.assertHeld(tx, row);
      await opts.visibility.publish(tx, row);
    });
  }
  if (state.step === "invalidate-published") {
    await opts.visibility.invalidate();
    // Keep the completion receipt but release the potentially large planning data.
    return commit({ ...state, step: "done", plan: emptyBulkPlan(), selected: [], catalog: [],
      ...(state.recheck ? { recheck: { ...state.recheck, nextCheckAt: new Date(Date.now() + BULK_RECHECK_INTERVAL_MS).toISOString() } } : {}),
    }, "complete", null);
  }
  throw new Error("Unknown bulk mirror checkpoint step");
}
