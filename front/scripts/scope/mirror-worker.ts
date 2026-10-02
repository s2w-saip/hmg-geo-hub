/** Continuous consumer for the existing mirror cron's durable bulk jobs. */
import { setTimeout as delay } from "node:timers/promises";

const USAGE = "mirror:worker --once|--watch [--discover] [--budget-ms=N] [--poll-ms=N]";
function options(argv: string[]) {
  if (argv.includes("--help")) return null;
  const mode = argv.filter((v) => v === "--once" || v === "--watch");
  if (mode.length !== 1) throw new Error(USAGE);
  const discover = argv.includes("--discover");
  const values = new Map<string, number>();
  for (const arg of argv.filter((v) => v !== "--once" && v !== "--watch" && v !== "--discover")) {
    const match = /^(--budget-ms|--poll-ms)=([1-9][0-9]*)$/.exec(arg);
    if (!match || values.has(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new Error(USAGE);
    values.set(match[1], Number(match[2]));
  }
  return { watch: mode[0] === "--watch", discover, budgetMs: values.get("--budget-ms") ?? 60_000, pollMs: values.get("--poll-ms") ?? 10_000 };
}

async function bulkDiscoveryTargets(rootProjectId: string) {
  const { projectRepository } = await import("@/lib/db/repositories/projects");
  const { getWebsiteScopeProjectIds } = await import("@/lib/db/repositories/website-sites");
  let projects: Awaited<ReturnType<typeof projectRepository.listAll>> = [];
  try {
    projects = await projectRepository.listAll();
  } catch (error) {
    console.warn("[mirror-worker] project discovery read failed; continuing with root and configured extras", error instanceof Error ? error.name : "UnknownError");
  }
  let websiteIds: string[] = [];
  try {
    websiteIds = await getWebsiteScopeProjectIds();
  } catch (error) {
    console.warn("[mirror-worker] website project discovery read failed", error instanceof Error ? error.name : "UnknownError");
  }
  const extras = (process.env.SCOPE_EXTRA_PROJECT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const localByScope = new Map(
    projects
      .filter((project) => project.scopeProjectId)
      .map((project) => [project.scopeProjectId as string, project.id] as const),
  );
  return [...new Set([rootProjectId, ...projects.flatMap((project) => project.scopeProjectId ? [project.scopeProjectId] : []), ...websiteIds, ...extras])]
    .map((projectId) => ({ projectId, localProjectId: localByScope.get(projectId) ?? null }));
}

async function main(): Promise<number> {
  let opts: ReturnType<typeof options>;
  try { opts = options(process.argv.slice(2)); } catch { console.error(USAGE); return 2; }
  if (!opts) { console.log(USAGE); return 0; }
  const required = ["DATABASE_URL", "SCOPE_API_BASE", "SCOPE_API_KEY", "SCOPE_ROOT_PROJECT_ID", "HMG_INTERNAL_BASE_URL", "CRON_SECRET"];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (process.env.SCOPE_MODE !== "live" || missing.length) {
    console.error(`Live configuration required; missing keys: ${missing.join(", ") || "SCOPE_MODE=live"}`);
    return 2;
  }
  // Startup parameters affect only this worker's DB sessions. PostgreSQL
  // cancels stalled statements/locks; no abandoned background write can commit.
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !databaseUrl.hostname || databaseUrl.pathname.length < 2) throw new Error("Invalid database URL");
    databaseUrl.searchParams.set("statement_timeout", "30000");
    databaseUrl.searchParams.set("lock_timeout", "5000");
    process.env.DATABASE_URL = databaseUrl.toString();
  } catch {
    console.error("DATABASE_URL must be a valid PostgreSQL URL");
    return 2;
  }
  process.env.DB_POOL_MAX ??= "2";
  const { processBulkQueue } = await import("@/lib/scope/mirror/bulk-worker");
  const { createBulkCycleVisibility } = await import("@/lib/db/repositories/scope-mirror-bulk-cycles");
  const visibility = createBulkCycleVisibility(async () => {
    const url = new URL("/api/internal/summary/published", process.env.HMG_INTERNAL_BASE_URL!);
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${process.env.CRON_SECRET!}` },
    });
    if (!response.ok) throw new Error("Bulk mirror cache invalidation failed");
  });
  let stop = false;
  const onStop = () => { stop = true; };
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);
  try {
    do {
      let discoveryIncomplete = false;
      if (opts.discover) {
        try {
          const [{ discoverBulkRuns }, { enqueueBulkRun }, { getScopeClient }] = await Promise.all([
            import("@/lib/scope/mirror/bulk-discovery"),
            import("@/lib/scope/mirror/bulk-worker"),
            import("@/lib/scope"),
          ]);
          const discoveryBudgetRaw = Number(process.env.MIRROR_DISCOVERY_BUDGET_MS ?? "10000");
          const discoveryBudgetMs = Number.isSafeInteger(discoveryBudgetRaw) && discoveryBudgetRaw > 0
            ? Math.min(discoveryBudgetRaw, opts.budgetMs)
            : Math.min(10_000, opts.budgetMs);
          const discovery = await discoverBulkRuns({
            client: getScopeClient(),
            targets: await bulkDiscoveryTargets(process.env.SCOPE_ROOT_PROJECT_ID!),
            enqueue: enqueueBulkRun,
            statePath: process.env.MIRROR_DISCOVERY_STATE_PATH,
            budgetMs: discoveryBudgetMs,
            maxConcurrency: 4,
          });
          discoveryIncomplete = discovery.failures.length > 0 || discovery.budgetStopped;
          console.log(JSON.stringify({ event: "bulk-discovery-pass", ...discovery }));
        } catch (error) {
          // A local state/file or target-read failure must not starve the
          // already durable queue or its retained recheck scan.
          discoveryIncomplete = true;
          console.error(JSON.stringify({
            event: "bulk-discovery-pass",
            projects: 0, pages: 0, runsSeen: 0, registrationAttempts: 0,
            failures: [{ projectId: "*", code: error instanceof Error ? error.name : "UnknownError" }],
            budgetStopped: false,
          }));
        }
        // Rechecks are deliberately watch-only. `--once --discover` remains a
        // bounded discovery/drain probe and cannot unexpectedly read every
        // retained unresolved group.
        if (opts.watch) {
          try {
            const { processBulkRechecks } = await import("@/lib/scope/mirror/bulk-recheck");
            const recheckBudgetMs = Math.min(10_000, opts.budgetMs);
            const recheck = await processBulkRechecks({ budgetMs: recheckBudgetMs, shouldStop: () => stop });
            console.log(JSON.stringify({ event: "bulk-mirror-recheck", ...recheck }));
          } catch (error) {
            console.error(JSON.stringify({
              event: "bulk-mirror-recheck",
              pages: 0, changed: 0, failures: 1, budgetStopped: false,
              error: error instanceof Error ? error.name : "UnknownError",
            }));
          }
        }
      }
      const report = await processBulkQueue({
        visibility, budgetMs: opts.budgetMs, shouldStop: () => stop,
        onStep: (step) => console.log(JSON.stringify({ event: "bulk-mirror-step", ...step })),
      });
      console.log(JSON.stringify({ event: "bulk-mirror-pass", ...report }));
      if (!opts.watch) return discoveryIncomplete || report.failures.length || report.remaining || report.blocked ? 3 : 0;
      // Keep draining productive work; retain idle/error polling and SQL retry
      // backoff when no step committed or this pass reported a failure.
      const keepDraining = report.steps > 0 && report.remaining > 0 && report.failures.length === 0;
      if (!stop && !keepDraining) await delay(opts.pollMs);
    } while (!stop);
    return 0;
  } finally {
    process.removeListener("SIGTERM", onStop);
    process.removeListener("SIGINT", onStop);
  }
}
main().then((code) => process.exit(code)).catch((error: unknown) => {
  console.error("Bulk mirror worker failed", error instanceof Error ? error.name : "UnknownError");
  process.exit(1);
});
