import { createHash } from "node:crypto";
import type { MirrorAcrRollup } from "@/lib/db/repositories/scope-mirror";
import type { MeasurementJob, Paginated } from "@/lib/scope/types";
import {
  acrRollupRows,
  collectAcrEntityNames,
  collectAcrPromptRuns,
  dedupeAcrIterationJobs,
  slimJobForFold,
  type AcrEntityNames,
  type AcrPromptRunSnapshot,
} from "./sync";

export interface BulkPlanPage {
  cursor: string | null;
  nextCursor: string | null;
  ids: string[];
  fingerprint: string;
}

/** The persisted shape is deliberately JSON-only: no Map, Date, or Set. */
export interface BulkPlan {
  version: 1;
  jobs: MeasurementJob[];
  snapshots: Array<[string, AcrPromptRunSnapshot]>;
  names: Array<[string, { name: string | null; brandRollup: string | null }]>;
  pages: BulkPlanPage[];
}

export type BulkPendingStatus = "queued" | "running" | "failed";
export const BULK_RECHECK_INTERVAL_MS = 5 * 60_000;
export const EMPTY_JOB_DIGEST = createHash("sha256").update("").digest("hex");

export interface BulkRecheckState {
  version: 1;
  groups: Array<{ status: BulkPendingStatus; count: number; digest: string }>;
  groupIndex: number;
  cursor: string | null;
  count: number;
  digest: string;
  lastJobId: string | null;
  nextCheckAt: string;
  changedAt: string | null;
}

/** ID order is shared by filtered and unfiltered Scope feeds (UUID DESC). */
export function extendJobDigest(previous: string, ids: string[]): string {
  let digest = previous;
  for (const id of ids) digest = createHash("sha256").update(digest).update(id).digest("hex");
  return digest;
}

/** Capture raw failures before ACR representative selection discards siblings. */
export function createBulkRecheck(jobs: MeasurementJob[], now = Date.now()): BulkRecheckState | null {
  const groups = (["queued", "running", "failed"] as const).map((status) => {
    const ids = jobs.filter((job) => job.status === status).map((job) => job.job_id)
      .sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
    return { status, count: ids.length, digest: extendJobDigest(EMPTY_JOB_DIGEST, ids) };
  }).filter((group) => group.count > 0);
  return groups.length ? {
    version: 1, groups, groupIndex: 0, cursor: null, count: 0,
    digest: EMPTY_JOB_DIGEST, lastJobId: null,
    nextCheckAt: new Date(now + BULK_RECHECK_INTERVAL_MS).toISOString(), changedAt: null,
  } : null;
}

export class BulkSourceChangedError extends Error {
  readonly code = "BULK_SOURCE_CHANGED" as const;

  constructor(message: string) {
    super(message);
    this.name = "BulkSourceChangedError";
  }
}

/** Stable JSON used by both planning and the payload verification pass. */
export function stableSerialize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, child]) => key !== "occurrences" && child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(",")}}`;
}

function planningProjection(job: MeasurementJob): unknown {
  // Deliberately excludes result (the first pass does not request it) and all
  // occurrence arrays. This fingerprint proves planning metadata consistency,
  // not that an answer body has remained unchanged.
  return {
    job_id: job.job_id,
    prompt_id: job.prompt_id,
    target: job.target,
    region: job.region,
    status: job.status,
    measured_at: job.measured_at,
    analysis: {
      acr_summary: job.analysis?.acr_summary ?? null,
      resolved_mentions: job.analysis?.resolved_mentions ?? null,
    },
  };
}

export function fingerprintJobs(jobs: MeasurementJob[]): string {
  return createHash("sha256")
    .update(stableSerialize(jobs.map(planningProjection)), "utf8")
    .digest("hex");
}

export function emptyBulkPlan(): BulkPlan {
  return { version: 1, jobs: [], snapshots: [], names: [], pages: [] };
}

function sourceChanged(message: string): never {
  throw new BulkSourceChangedError(message);
}

function cursorLabel(cursor: string | null): string {
  return cursor === null ? "<start>" : `<cursor length=${cursor.length}>`;
}

function pageCursor(plan: BulkPlan): string | null {
  return plan.pages.length
    ? plan.pages[plan.pages.length - 1].nextCursor
    : null;
}

/** Add one first-pass page without mutating the prior checkpoint. */
export function addPlanPage(
  plan: BulkPlan,
  page: Paginated<MeasurementJob>,
  cursor: string | null,
): BulkPlan {
  if (plan.version !== 1)
    sourceChanged(`unsupported bulk plan version: ${plan.version}`);
  const expected = pageCursor(plan);
  if (cursor !== expected) {
    sourceChanged(
      `page cursor is out of order: expected ${cursorLabel(expected)}, got ${cursorLabel(cursor)}`,
    );
  }
  if (plan.pages.length && expected === null)
    sourceChanged("page added after terminal page");

  const items = page.data ?? [];
  const nextCursor = page.next_cursor ?? null;
  if (items.length === 0 && nextCursor !== null)
    sourceChanged("empty page has a next_cursor");
  if (nextCursor !== null && nextCursor === cursor)
    sourceChanged("page cursor does not advance");

  const seenCursors = new Set<string>();
  for (const [index, prior] of plan.pages.entries()) {
    if (prior.cursor !== null) seenCursors.add(prior.cursor);
    // The immediate predecessor's nextCursor is the valid cursor argument
    // for this page; older next cursors are repeated/non-forward values.
    if (index < plan.pages.length - 1 && prior.nextCursor !== null) {
      seenCursors.add(prior.nextCursor);
    }
  }
  if (cursor !== null && seenCursors.has(cursor))
    sourceChanged("page cursor repeats");
  if (nextCursor !== null && seenCursors.has(nextCursor))
    sourceChanged("next_cursor is not forward");

  const priorIds = new Set(plan.jobs.map((job) => job.job_id));
  const pageIds = new Set<string>();
  for (const job of items) {
    if (!job?.job_id) sourceChanged("page contains a job without job_id");
    if (pageIds.has(job.job_id) || priorIds.has(job.job_id)) {
      sourceChanged(`duplicate job_id in bulk source: ${job.job_id}`);
    }
    pageIds.add(job.job_id);
  }

  const jobs = items.map(slimJobForFold);
  // The collectors replace Map entries rather than mutating existing values,
  // so shallow copies preserve the prior plan while avoiding O(N) JSON cloning
  // on every page.
  const snapshots = new Map<string, AcrPromptRunSnapshot>(plan.snapshots);
  const names = new Map<
    string,
    { name: string | null; brandRollup: string | null }
  >(plan.names);
  collectAcrPromptRuns(items, snapshots);
  collectAcrEntityNames(items, names);

  return {
    version: 1,
    jobs: [...plan.jobs, ...jobs],
    snapshots: [...snapshots.entries()],
    names: [...names.entries()],
    pages: [
      ...plan.pages,
      {
        cursor,
        nextCursor,
        ids: [...pageIds],
        fingerprint: fingerprintJobs(items),
      },
    ],
  };
}

export function finalizeBulkPlan(
  plan: BulkPlan,
  totalJobs: number,
  runId: string,
): { selectedJobIds: string[]; acrRollups: MirrorAcrRollup[] } {
  if (plan.version !== 1)
    sourceChanged(`unsupported bulk plan version: ${plan.version}`);
  if (!Number.isSafeInteger(totalJobs) || totalJobs < 0)
    sourceChanged("invalid totalJobs");
  if (
    (plan.pages.length === 0 && totalJobs !== 0) ||
    (plan.pages.length > 0 &&
      plan.pages[plan.pages.length - 1].nextCursor !== null)
  ) {
    sourceChanged("bulk plan is incomplete");
  }
  if (plan.jobs.length !== totalJobs) {
    sourceChanged(
      `total_jobs mismatch: expected ${totalJobs}, planned ${plan.jobs.length}`,
    );
  }
  const selectedJobIds = dedupeAcrIterationJobs(plan.jobs).map(
    (job) => job.job_id,
  );
  const snapshots = new Map<string, AcrPromptRunSnapshot>(plan.snapshots);
  const names: AcrEntityNames = new Map(plan.names);
  return {
    selectedJobIds,
    acrRollups: acrRollupRows(snapshots, names, runId),
  };
}

/** Verify a second-pass page against its immutable first-pass plan. */
export function verifyWritePage(
  plan: BulkPlan,
  pageIndex: number,
  page: Paginated<MeasurementJob>,
): void {
  const expected = plan.pages[pageIndex];
  if (!expected) sourceChanged(`unknown planned page: ${pageIndex}`);
  const cursor = pageIndex === 0 ? null : plan.pages[pageIndex - 1].nextCursor;
  const nextCursor = page.next_cursor ?? null;
  const ids = (page.data ?? []).map((job) => job.job_id);
  if (expected.cursor !== cursor || expected.nextCursor !== nextCursor) {
    sourceChanged(`cursor changed for planned page ${pageIndex}`);
  }
  if (
    ids.length !== expected.ids.length ||
    ids.some((id, i) => id !== expected.ids[i])
  ) {
    sourceChanged(`job ID set/order changed for planned page ${pageIndex}`);
  }
  if ((page.data ?? []).length === 0 && nextCursor !== null) {
    sourceChanged(`empty write page ${pageIndex} has a next_cursor`);
  }
  const actual = fingerprintJobs(page.data ?? []);
  if (actual !== expected.fingerprint) {
    sourceChanged(`planning metadata changed for page ${pageIndex}`);
  }
}
