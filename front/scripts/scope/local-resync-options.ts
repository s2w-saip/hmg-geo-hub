import type { MirrorSyncResult } from "@/lib/scope/mirror/sync";

export const LOCAL_RESYNC_USAGE = "mirror:local-resync <runsSince ISO> <runsUntil ISO> [projectId] [--max-runs N] [--resync-before ISO] [--prompts-updated-from ISO] [--prompts-updated-to ISO]";

function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function instant(value: string, name: string): Date {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  const result = new Date(value);
  if (!parts || Number.isNaN(result.getTime())) {
    throw new Error(`${name} must be an ISO timestamp with timezone`);
  }
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  // Date accepts impossible calendar dates (e.g. February 30) by rolling
  // into the next month. A recovery window must never silently move.
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`${name} must be a valid calendar timestamp`);
  }
  return result;
}

export function parseLocalResyncOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  now = new Date(),
) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const [key, inline] = value.split(/=(.*)/s);
    if (!["--max-runs", "--resync-before", "--prompts-updated-from", "--prompts-updated-to"].includes(key) || flags.has(key)) {
      throw new Error("Unknown or duplicate option");
    }
    const flagValue = inline ?? argv[++i];
    if (!flagValue || flagValue.startsWith("--")) throw new Error(`Missing value for ${key}`);
    flags.set(key, flagValue);
  }
  if (positional.length < 2 || positional.length > 3) throw new Error(LOCAL_RESYNC_USAGE);
  const [since, until, project] = positional;
  const runsSince = instant(since, "runsSince");
  const runsUntil = instant(until, "runsUntil");
  if (runsSince >= runsUntil) throw new Error("runsSince must be before runsUntil");
  if (project && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(project)) {
    throw new Error("projectId must be a UUID");
  }
  const cutoff = flags.get("--resync-before") ?? env.MIRROR_RESYNC_BEFORE ?? now.toISOString();
  const resyncBefore = instant(cutoff, "resyncBefore");
  if (resyncBefore > now) throw new Error("resyncBefore must not be in the future");
  const promptFrom = flags.get("--prompts-updated-from");
  const promptTo = flags.get("--prompts-updated-to");
  const promptsUpdatedFrom = promptFrom ? instant(promptFrom, "promptsUpdatedFrom").toISOString() : undefined;
  const promptsUpdatedTo = promptTo ? instant(promptTo, "promptsUpdatedTo").toISOString() : undefined;
  if (promptsUpdatedFrom && promptsUpdatedTo && promptsUpdatedFrom >= promptsUpdatedTo) {
    throw new Error("promptsUpdatedFrom must be before promptsUpdatedTo");
  }
  return {
    force: true as const,
    maxRuns: positiveInteger(flags.get("--max-runs") ?? env.MIRROR_RESYNC_MAX_RUNS ?? "50", "maxRuns"),
    budgetMs: positiveInteger(env.MIRROR_LOCAL_BUDGET_MS ?? String(6 * 60 * 60 * 1000), "MIRROR_LOCAL_BUDGET_MS"),
    runsSince,
    runsUntil,
    resyncBefore,
    promptsUpdatedFrom,
    promptsUpdatedTo,
    projectIds: project ? [project] : undefined,
  };
}

/** A finite pass can succeed only when every requested source was consumed. */
export function localResyncReport(result: MirrorSyncResult, resyncBefore: Date) {
  const perProjectErrors = result.perProject.filter((p) => p.error);
  const incomplete = result.oversizedRuns.length > 0 || result.truncatedRuns.length > 0 ||
    result.budgetStoppedProjects.length > 0 || result.pageCapHits.length > 0 ||
    result.recheckCapHits.length > 0 || result.projectIdsNotFound.length > 0 ||
    result.runLimitHits.length > 0 || result.deferred > 0 || perProjectErrors.length > 0;
  return {
    complete: !incomplete,
    exitCode: incomplete ? 3 : 0,
    resyncBefore: resyncBefore.toISOString(),
    runs: result.runs,
    answers: result.answers,
    skipped: result.skipped,
    resyncSkipped: result.resyncSkipped,
    oversizedRuns: result.oversizedRuns,
    truncatedRuns: result.truncatedRuns,
    budgetStoppedProjects: result.budgetStoppedProjects,
    runLimitHits: result.runLimitHits,
    pageCapHits: result.pageCapHits,
    recheckCapHits: result.recheckCapHits,
    projectIdsNotFound: result.projectIdsNotFound,
    deferred: result.deferred,
    perProjectErrors,
  };
}
