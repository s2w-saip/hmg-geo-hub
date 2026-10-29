import "server-only";
import type { ScopeMirrorProgressRow } from "@/lib/db/schema";
import {
  scopeMirrorProgressRepository as progress,
  ScopeMirrorProgressStaleError,
} from "@/lib/db/repositories/scope-mirror-progress";
import { getProjectTrackedDictionary, type ProjectTrackedDictionary } from "@/lib/db/repositories/project-tracked-dictionary";
import { promptRepository } from "@/lib/db/repositories/prompts";
import { scopeMirrorRepository } from "@/lib/db/repositories/scope-mirror";
import { getScopeClient } from "@/lib/scope";
import { runCycleControl } from "@/lib/summary/cycle-control";
import type { MeasurementRunSummary } from "@/lib/scope/types";
import { buildMentionCanonicalizer, shouldDeferHeavyRecheck, shouldSkipMirroredRun } from "./sync";
import { BulkSourceChangedError } from "./bulk-plan";
import { bulkRunState, initialBulkRunState, resumeBulkRunStep, type BulkVisibility } from "./bulk-run";

/** Called by the existing discovery loop only for eligible oversized runs. */
export async function enqueueBulkRun(run: MeasurementRunSummary, projectId: string, localProjectId: string | null): Promise<void> {
  if (run.project_id && run.project_id !== projectId) throw new Error("Bulk run project mismatch");
  // A cron's run-state snapshot can predate a worker's completion. Check the
  // latest run before creating/restarting work; an existing blocked plan retries.
  const current = await progress.getForRegistration(projectId, run.measurement_run_id);
  if (current && !["complete", "blocked"].includes(current.phase)) return;
  if (current?.phase === "blocked" && current.lastError === "checkpoint-invalid") return;
  // Summary fields do not version job analysis. Retry a source-change plan on
  // fresh discovery even when those fields match, with a short duplicate guard.
  if (current?.phase === "blocked" && Date.now() - current.updatedAt.getTime() < 60_000) return;
  if (!current || current.phase === "complete") {
    const fresh = await scopeMirrorRepository.mirroredRunStates(run.measurement_run_id);
    const prior = fresh.get(run.measurement_run_id);
    const completedState = current ? bulkRunState(current) : null;
    const sourceChanged = Boolean(completedState?.recheck?.changedAt) ||
      Boolean(completedState && completedState.source.total_jobs !== run.total_jobs);
    if (!sourceChanged && shouldSkipMirroredRun(prior, run.status)) return;
    // A completed bulk receipt can still have unresolved answers in the mirror.
    // A filtered raw-failure scan or job-count change must confirm new work.
    // Legacy mirrors without a baseline still require explicit local recovery.
    if (!sourceChanged && shouldDeferHeavyRecheck(prior, run.status, run.total_jobs)) return;
  }
  const state = initialBulkRunState({ ...run, project_id: projectId });
  state.dictionary = localProjectId ? await getProjectTrackedDictionary(localProjectId) :
    current ? bulkRunState(current).dictionary ?? null : null;
  state.readyObservedAt = new Date().toISOString();
  if (current) {
    // A changed source is a new plan, not a retry of the old payload. Preserve
    // visibility ownership if the previous attempt had already hidden a cycle.
    state.visibility = bulkRunState(current).visibility;
    await progress.restart(current, state);
  } else await progress.createIfAbsent({ projectId, runId: run.measurement_run_id, state });
}

export async function finishBulkMetadata(row: ScopeMirrorProgressRow): Promise<void> {
  const state = bulkRunState(row);
  if (state.catalog.length) await promptRepository.updateStatusByScopePromptIds(
    state.catalog.map(([scopePromptId, status]) => ({ scopePromptId, status })),
  );
  // Reuse the existing attribution/counter rules, including weekly publication
  // selection. This does not force a cycle closed or generate/publish summaries.
  const control = await runCycleControl({ skipPartitions: true });
  if (control.skipped || control.errors.length) throw new Error("Bulk cycle control incomplete");
}

export interface BulkWorkerReport {
  steps: number;
  completed: number;
  failures: Array<{ runId: string; code: string }>;
  remaining: number;
  blocked: number;
  oldestReadyAgeMs: number | null;
  budgetStopped: boolean;
}

/** One bounded worker pass; a later process resumes from the same database. */
export async function processBulkQueue(opts: {
  visibility: BulkVisibility;
  budgetMs: number;
  retryDelayMs?: number;
  shouldStop?: () => boolean;
  onStep?: (data: { runId: string; step: string; ms: number; revision: number }) => void;
}): Promise<BulkWorkerReport> {
  const deadlineAt = Date.now() + opts.budgetMs;
  const report: BulkWorkerReport = { steps: 0, completed: 0, failures: [], remaining: 0, blocked: 0, oldestReadyAgeMs: null, budgetStopped: false };
  const client = getScopeClient();
  const failedThisPass = new Set<string>();
  queue: while (Date.now() < deadlineAt && !opts.shouldStop?.()) {
    // One plan can be tens of MB. Select eligible work in SQL and load one run.
    const [row] = await progress.listPending(1, {
      excludeRunIds: [...failedThisPass],
      retryBefore: new Date(Date.now() - (opts.retryDelayMs ?? 30_000)),
    });
    if (!row) break;
    let current = row;
    let canonicalizer: ReturnType<typeof buildMentionCanonicalizer>;
    try {
      const state = bulkRunState(row);
      canonicalizer = buildMentionCanonicalizer((state.dictionary ?? null) as ProjectTrackedDictionary | null);
    } catch {
      // Isolate an incompatible/corrupt checkpoint. Replanning it could lose
      // ownership of an existing hide; other queued runs can still proceed.
      try {
        await progress.advance(row, { phase: "blocked", lastError: "checkpoint-invalid" });
        report.failures.push({ runId: row.runId, code: "checkpoint-invalid" });
      } catch (error) {
        if (!(error instanceof ScopeMirrorProgressStaleError)) throw error;
      }
      failedThisPass.add(row.runId);
      continue;
    }
    while (current.phase !== "complete" && current.phase !== "blocked" && Date.now() < deadlineAt && !opts.shouldStop?.()) {
      const started = Date.now();
      try {
        const step = bulkRunState(current).step;
        current = await resumeBulkRunStep(current, {
          client, canonicalizer, visibility: opts.visibility, deadlineAt,
          beforePublish: finishBulkMetadata,
        });
        report.steps++;
        opts.onStep?.({ runId: current.runId, step, ms: Date.now() - started, revision: current.revision });
        if (current.phase === "complete") report.completed++;
      } catch (error) {
        if (error instanceof Error && error.name === "ScopeDeadlineExceededError") {
          report.budgetStopped = true;
          break queue;
        }
        // A commit may have succeeded even if the connection lost its response.
        // Re-read before recording failure or deciding what to replay.
        const latest = await progress.get(current.projectId, current.runId);
        if (latest && latest.revision !== current.revision) {
          current = latest;
          if (current.phase === "complete") report.completed++;
          continue;
        }
        if (error instanceof ScopeMirrorProgressStaleError && latest) { current = latest; continue; }
        const code = error instanceof BulkSourceChangedError ? "source-changed" :
          error instanceof Error ? error.name : "UnknownError";
        if (latest && latest.phase !== "complete") {
          await progress.advance(latest, {
            lastError: code,
            ...(error instanceof BulkSourceChangedError ? { phase: "blocked" as const } : {}),
          });
        }
        report.failures.push({ runId: current.runId, code });
        failedThisPass.add(current.runId);
        break;
      }
    }
  }
  if (Date.now() >= deadlineAt) report.budgetStopped = true;
  const counts = await progress.counts();
  report.remaining = counts.pending;
  report.blocked = counts.blocked;
  if (counts.oldestReadyAt && Number.isFinite(Date.parse(counts.oldestReadyAt))) {
    report.oldestReadyAgeMs = Math.max(0, Date.now() - Date.parse(counts.oldestReadyAt));
  }
  return report;
}
