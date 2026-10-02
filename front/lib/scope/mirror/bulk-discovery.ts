import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScopeClient } from "@/lib/scope/client";
import type { MeasurementRunSummary } from "@/lib/scope/types";
import { isOversizedRun, mirrorJobCapacity } from "./sync";
import { ScopeDeadlineExceededError } from "@/lib/scope/paging";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "partial_failed"]);
export const DEFAULT_BULK_DISCOVERY_STATE_PATH = "/var/lib/hmg-runner/mirror-discovery-state.json";
const DISCOVERY_PAGE_LIMIT = 100;
export const BULK_DISCOVERY_HEAD_INTERVAL_MS = 5 * 60_000;

export interface BulkDiscoveryTarget {
  projectId: string;
  localProjectId: string | null;
}

export interface BulkDiscoveryProjectState {
  cursor: string | null;
  /** Last successfully read head page. Older checkpoints may omit this. */
  lastHeadAt?: string;
  /** Force one deep visit after a head page, even if the project loop is slow. */
  nextDeep?: boolean;
  /**
   * A fetched page whose registrations were only partially acknowledged. The
   * summaries are bounded to one run-list page and let a new head be inserted
   * without moving an unregistered old run out of the page.
   */
  pending?: BulkDiscoveryPendingPage;
}

export interface BulkDiscoveryPendingPage {
  cursor: string | null;
  nextCursor: string | null;
  readAt: string;
  head: boolean;
  priorCursor: string | null;
  runs: MeasurementRunSummary[];
  index: number;
}

export interface BulkDiscoveryState {
  version: 1;
  nextProjectIndex: number;
  projects: Record<string, BulkDiscoveryProjectState>;
}

export interface BulkDiscoveryReport {
  projects: number;
  pages: number;
  runsSeen: number;
  registrationAttempts: number;
  failures: Array<{ projectId: string; code: string }>;
  budgetStopped: boolean;
}

export interface BulkDiscoveryOptions {
  client: Pick<ScopeClient, "listMeasurementRuns">;
  targets: readonly BulkDiscoveryTarget[];
  enqueue: (
    run: MeasurementRunSummary,
    projectId: string,
    localProjectId: string | null,
  ) => Promise<void>;
  statePath?: string;
  budgetMs: number;
  maxConcurrency?: number;
  now?: () => number;
}

export class BulkDiscoveryCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkDiscoveryCheckpointError";
  }
}

function emptyState(): BulkDiscoveryState {
  return { version: 1, nextProjectIndex: 0, projects: {} };
}

function validState(value: unknown): value is BulkDiscoveryState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as BulkDiscoveryState;
  if (state.version !== 1 || !Number.isSafeInteger(state.nextProjectIndex) || state.nextProjectIndex < 0) return false;
  if (typeof state.projects !== "object" || state.projects === null || Array.isArray(state.projects)) return false;
  return Object.values(state.projects).every((project) => {
    if (typeof project !== "object" || project === null ||
      (project.cursor !== null && typeof project.cursor !== "string") ||
      (project.lastHeadAt !== undefined &&
        (typeof project.lastHeadAt !== "string" || !Number.isFinite(Date.parse(project.lastHeadAt)))) ||
      (project.nextDeep !== undefined && typeof project.nextDeep !== "boolean")) return false;
    const pending = project.pending;
    if (pending === undefined) return true;
    if (typeof pending !== "object" || pending === null ||
      (pending.cursor !== null && typeof pending.cursor !== "string") ||
      (pending.nextCursor !== null && typeof pending.nextCursor !== "string") ||
      typeof pending.head !== "boolean" ||
      (pending.priorCursor !== null && typeof pending.priorCursor !== "string") ||
      typeof pending.readAt !== "string" || !Number.isFinite(Date.parse(pending.readAt)) ||
      !Array.isArray(pending.runs) || pending.runs.length === 0 || pending.runs.length > DISCOVERY_PAGE_LIMIT ||
      !Number.isSafeInteger(pending.index) || pending.index < 0 || pending.index > pending.runs.length) return false;
    const ids = new Set<string>();
    return pending.runs.every((run) => {
      if (typeof run !== "object" || run === null ||
        typeof run.measurement_run_id !== "string" || !run.measurement_run_id ||
        typeof run.project_id !== "string" || !run.project_id ||
        !Number.isSafeInteger(run.total_jobs) || run.total_jobs < 0 ||
        typeof run.status !== "string" || !TERMINAL_RUN_STATUSES.has(run.status) || ids.has(run.measurement_run_id)) return false;
      ids.add(run.measurement_run_id);
      return true;
    });
  });
}

export async function readBulkDiscoveryState(path: string): Promise<BulkDiscoveryState> {
  try {
    const raw = await readFile(path, "utf8");
    const value: unknown = JSON.parse(raw);
    if (!validState(value)) throw new BulkDiscoveryCheckpointError("Invalid bulk discovery checkpoint");
    return value;
  } catch (error) {
    if (error instanceof BulkDiscoveryCheckpointError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    if (error instanceof SyntaxError) throw new BulkDiscoveryCheckpointError("Invalid bulk discovery checkpoint JSON");
    throw error;
  }
}

/** Replace the checkpoint by rename so a process crash cannot leave truncated JSON. */
export async function writeBulkDiscoveryState(path: string, state: BulkDiscoveryState): Promise<void> {
  if (!validState(state)) throw new BulkDiscoveryCheckpointError("Cannot write invalid bulk discovery checkpoint");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function eligible(run: MeasurementRunSummary): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status) && isOversizedRun(run.total_jobs, mirrorJobCapacity());
}

function uniqueTargets(targets: readonly BulkDiscoveryTarget[]): BulkDiscoveryTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (!target.projectId || seen.has(target.projectId)) return false;
    seen.add(target.projectId);
    return true;
  });
}

async function listRunsWithDeadline(
  client: Pick<ScopeClient, "listMeasurementRuns">,
  target: BulkDiscoveryTarget,
  cursor: string | null,
  deadlineAt: number,
  now: () => number,
): Promise<Awaited<ReturnType<ScopeClient["listMeasurementRuns"]>>> {
  if (now() >= deadlineAt) throw new ScopeDeadlineExceededError();
  const remaining = deadlineAt - now();
  if (remaining <= 0) throw new ScopeDeadlineExceededError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ScopeDeadlineExceededError());
    }, remaining);
  });
  try {
    const request = client.listMeasurementRuns(
      target.projectId,
      { limit: DISCOVERY_PAGE_LIMIT, ...(cursor === null ? {} : { cursor }) },
      { signal: controller.signal },
    );
    const page = await Promise.race([request, timeout]);
    if (now() >= deadlineAt) throw new ScopeDeadlineExceededError();
    return page;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Poll only the measurement-run feed. A head page is re-read every few minutes
 * so a new run is noticed while an older page cursor is being drained. The
 * persisted cursor advances only after every eligible run on that page was
 * enqueued.
 */
export async function discoverBulkRuns(opts: BulkDiscoveryOptions): Promise<BulkDiscoveryReport> {
  if (!Number.isSafeInteger(opts.budgetMs) || opts.budgetMs < 1) throw new RangeError("budgetMs must be a positive safe integer");
  const targets = uniqueTargets(opts.targets);
  const statePath = opts.statePath ?? DEFAULT_BULK_DISCOVERY_STATE_PATH;
  const now = opts.now ?? Date.now;
  const deadlineAt = now() + opts.budgetMs;
  const state = await readBulkDiscoveryState(statePath);
  const report: BulkDiscoveryReport = { projects: 0, pages: 0, runsSeen: 0, registrationAttempts: 0, failures: [], budgetStopped: false };
  if (targets.length === 0) return report;

  const start = state.nextProjectIndex % targets.length;
  const count = { next: 0 };
  let writeTail = Promise.resolve();
  const persist = async () => {
    const next = writeTail.then(() => writeBulkDiscoveryState(statePath, state));
    writeTail = next.catch(() => undefined);
    await next;
  };

  const finishPage = async (
    target: BulkDiscoveryTarget,
    pending: BulkDiscoveryPendingPage,
    prior: BulkDiscoveryProjectState,
  ) => {
    if (pending.head) {
      const cursor = pending.priorCursor === null ? pending.nextCursor : pending.priorCursor;
      state.projects[target.projectId] = {
        cursor,
        lastHeadAt: pending.readAt,
        nextDeep: cursor !== null,
      };
    } else {
      state.projects[target.projectId] = {
        cursor: pending.nextCursor,
        ...(prior.lastHeadAt ? { lastHeadAt: prior.lastHeadAt } : {}),
        nextDeep: false,
      };
    }
    await persist();
  };

  const drainPending = async (
    target: BulkDiscoveryTarget,
    pending: BulkDiscoveryPendingPage,
    prior: BulkDiscoveryProjectState,
  ) => {
    while (pending.index < pending.runs.length) {
      if (now() >= deadlineAt) throw new ScopeDeadlineExceededError();
      await opts.enqueue(pending.runs[pending.index]!, target.projectId, target.localProjectId);
      report.registrationAttempts++;
      // A crash before this checkpoint may repeat only the last acknowledged
      // registration; enqueueBulkRun is idempotent/CAS guarded for that case.
      pending.index++;
      await persist();
    }
    await finishPage(target, pending, prior);
  };

  const processPage = async (target: BulkDiscoveryTarget, pageCursor: string | null, prior: BulkDiscoveryProjectState, head: boolean) => {
    const page = await listRunsWithDeadline(opts.client, target, pageCursor, deadlineAt, now);
    report.pages++;
    report.runsSeen += page.data.length;
    const nextCursor = page.next_cursor ?? null;
    if (page.data.length === 0 && nextCursor !== null) {
      throw new BulkDiscoveryCheckpointError("Bulk discovery returned an empty page with a next cursor");
    }
    if (nextCursor !== null && nextCursor === pageCursor) {
      throw new BulkDiscoveryCheckpointError("Bulk discovery cursor did not advance");
    }
    const runs = page.data.filter(eligible);
    if (runs.length === 0) {
      await finishPage(target, {
        cursor: pageCursor, nextCursor,
        readAt: new Date(now()).toISOString(), head,
        priorCursor: prior.cursor, runs: [], index: 0,
      }, prior);
      return;
    }
    const pending: BulkDiscoveryPendingPage = {
      cursor: pageCursor,
      nextCursor,
      readAt: new Date(now()).toISOString(),
      head,
      priorCursor: prior.cursor,
      runs,
      index: 0,
    };
    state.projects[target.projectId] = { ...prior, pending };
    // The page and its first registration position are durable before the
    // first enqueue. A new head cannot evict these retained summaries.
    await persist();
    await drainPending(target, pending, prior);
  };

  const processTarget = async (target: BulkDiscoveryTarget) => {
    const prior = state.projects[target.projectId] ?? { cursor: null };
    if (prior.pending) {
      await drainPending(target, prior.pending, prior);
      return;
    }
    const headAt = prior.lastHeadAt ? Date.parse(prior.lastHeadAt) : NaN;
    const forceDeep = prior.nextDeep === true && prior.cursor !== null;
    const headDue = !forceDeep && (!Number.isFinite(headAt) || now() - headAt >= BULK_DISCOVERY_HEAD_INTERVAL_MS);
    // One visit performs one page. Head visits are periodic and deep visits
    // consume the saved cursor between heads, preventing either side from
    // monopolizing a short discovery budget.
    if (!headDue && prior.cursor === null) return;
    const pageCursor = headDue ? null : prior.cursor;
    await processPage(target, pageCursor, prior, headDue);
  };

  const maxConcurrency = Math.max(1, Math.min(opts.maxConcurrency ?? 4, 4, targets.length));
  const worker = async () => {
    while (true) {
      if (now() >= deadlineAt) return;
      const offset = count.next++;
      if (offset >= targets.length) return;
      const target = targets[(start + offset) % targets.length]!;
      // Reserve the next target before making a network call. A hard kill
      // after this write may skip one visit, but it cannot repeat the same
      // project forever or reset another worker's rotation.
      state.nextProjectIndex = (start + offset + 1) % targets.length;
      try {
        await persist();
      } catch (error) {
        report.failures.push({ projectId: target.projectId, code: error instanceof Error ? error.name : "UnknownError" });
        return;
      }
      report.projects++;
      try {
        await processTarget(target);
      } catch (error) {
        const code = error instanceof ScopeDeadlineExceededError
          ? "ScopeDeadlineExceededError"
          : error instanceof Error ? error.name : "UnknownError";
        report.failures.push({ projectId: target.projectId, code });
        if (error instanceof ScopeDeadlineExceededError) return;
      }
    }
  };
  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  if (now() >= deadlineAt || count.next < targets.length) report.budgetStopped = true;
  state.nextProjectIndex = (start + Math.min(count.next, targets.length)) % targets.length;
  await persist();
  return report;
}
