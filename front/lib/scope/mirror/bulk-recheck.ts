import "server-only";
import { scopeMirrorProgressRepository as progress, ScopeMirrorProgressStaleError } from "@/lib/db/repositories/scope-mirror-progress";
import { getScopeClient } from "@/lib/scope";
import type { Paginated, MeasurementJob } from "@/lib/scope/types";
import { withScopeReadDeadline } from "@/lib/scope/read-deadline";
import { bulkRunState } from "./bulk-run";
import { enqueueBulkRun } from "./bulk-worker";
import { BULK_RECHECK_INTERVAL_MS, EMPTY_JOB_DIGEST, extendJobDigest, type BulkRecheckState } from "./bulk-plan";

/** One filtered page, with no answer writes, hiding, or source mutations. */
export function advanceBulkRecheck(state: BulkRecheckState, page: Paginated<MeasurementJob>, now = Date.now()): BulkRecheckState {
  const group = state.groups[state.groupIndex];
  if (state.version !== 1 || !group || state.changedAt || !Number.isSafeInteger(state.count) || state.count < 0) {
    throw new Error("Invalid bulk recheck state");
  }
  let lastJobId = state.lastJobId;
  const ids: string[] = [];
  for (const job of page.data) {
    if (!job.job_id || job.status !== group.status || (lastJobId != null && job.job_id >= lastJobId)) {
      throw new Error("Invalid filtered jobs page");
    }
    lastJobId = job.job_id;
    ids.push(job.job_id);
  }
  const cursor = page.next_cursor ?? null;
  if (cursor && (cursor === state.cursor || !ids.length)) throw new Error("Filtered jobs cursor did not advance");
  const count = state.count + ids.length;
  const digest = extendJobDigest(state.digest, ids);
  const next = { ...state, cursor, count, digest, lastJobId, nextCheckAt: new Date(now).toISOString() };
  if (cursor) return next;
  if (count !== group.count || digest !== group.digest) return { ...next, changedAt: new Date(now).toISOString() };
  const finished = state.groupIndex + 1 === state.groups.length;
  return {
    ...next, groupIndex: finished ? 0 : state.groupIndex + 1,
    cursor: null, count: 0, digest: EMPTY_JOB_DIGEST, lastJobId: null,
    nextCheckAt: new Date(now + (finished ? BULK_RECHECK_INTERVAL_MS : 0)).toISOString(),
  };
}

/**
 * Poll only raw unresolved groups retained by this worker's completed receipts.
 * A confirmed change fetches fresh run metadata directly; it need not wait for
 * that old run to appear again in discovery's deeper history pages.
 * Legacy mirrors without a receipt/baseline are never replayed by this scan.
 */
export async function processBulkRechecks(opts: { budgetMs: number; shouldStop?: () => boolean }) {
  const deadlineAt = Date.now() + opts.budgetMs;
  const client = withScopeReadDeadline(getScopeClient(), deadlineAt);
  const report = { pages: 0, changed: 0, queued: 0, failures: 0, budgetStopped: false };
  while (Date.now() < deadlineAt && !opts.shouldStop?.()) {
    const [row] = await progress.listRecheckable();
    if (!row) break;
    let state: BulkRecheckState | null | undefined;
    try {
      state = bulkRunState(row).recheck;
      if (!state) throw new Error("Missing recheck state");
      if (state.changedAt) {
        const source = await client.getMeasurementRun(row.projectId, row.runId);
        if (["completed", "failed", "partial_failed"].includes(source.status)) {
          await enqueueBulkRun(source, row.projectId, null);
          report.queued++;
        } else {
          // A ticket may be running again. Keep the previous complete mirror
          // visible until the source returns to a terminal state.
          await progress.saveRecheck(row, { ...state, nextCheckAt: new Date(Date.now() + 30_000).toISOString() });
        }
        continue;
      }
      const group = state.groups[state.groupIndex];
      if (!group) throw new Error("Invalid recheck group");
      const page = await client.listRunJobs(row.projectId, row.runId, {
        limit: 200, status: group.status, cursor: state.cursor ?? undefined,
      });
      const next = advanceBulkRecheck(state, page);
      await progress.saveRecheck(row, next);
      report.pages++;
      if (next.changedAt) report.changed++;
    } catch (error) {
      if (error instanceof ScopeMirrorProgressStaleError) continue;
      if (error instanceof Error && error.name === "ScopeDeadlineExceededError") { report.budgetStopped = true; break; }
      report.failures++;
      // Back off this scan, preserving its committed cursor and visible data.
      try {
        const previous = state ?? (typeof row.state.recheck === "object" && row.state.recheck != null ? row.state.recheck : {});
        await progress.saveRecheck(row, { ...previous, nextCheckAt: new Date(Date.now() + 30_000).toISOString() });
      } catch (saveError) {
        if (!(saveError instanceof ScopeMirrorProgressStaleError)) throw saveError;
      }
    }
  }
  if (Date.now() >= deadlineAt) report.budgetStopped = true;
  return report;
}
