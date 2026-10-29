/**
 * Run a bounded mirror recovery window outside Vercel's request deadline.
 * Use `npm run mirror:local-resync -- ...` so the existing summary tsconfig
 * supplies the server-only shim. --help needs no database configuration.
 *
 * The window filters the fetched run list; old windows can still be outside
 * its page cap. Any remaining cap, skipped run, deadline, or project error
 * exits 3. Reuse the printed resyncBefore timestamp when continuing a pass.
 *
 * Large-run ingestion still needs the separately reviewed bulk runner; do
 * not copy larger local page/budget settings into the production cron env.
 * See docs/mirror-hardening-2026-09-15.md for limits and the CLI contract.
 */
import { LOCAL_RESYNC_USAGE, localResyncReport, parseLocalResyncOptions } from "./local-resync-options";

async function main(): Promise<number> {
  if (process.argv.slice(2).includes("--help")) {
    console.log(LOCAL_RESYNC_USAGE);
    return 0;
  }
  let options: ReturnType<typeof parseLocalResyncOptions>;
  try {
    options = parseLocalResyncOptions(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments");
    return 2;
  }
  // Validate before loading the sync module (which initializes the DB client).
  const required = ["DATABASE_URL", "SCOPE_API_BASE", "SCOPE_API_KEY", "SCOPE_ROOT_PROJECT_ID"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (process.env.SCOPE_MODE !== "live" || missing.length) {
    console.error(`Live configuration required: SCOPE_MODE=live; missing keys: ${missing.join(", ") || "none"}`);
    return 2;
  }
  const {
    syncStandardMirror, MIRROR_JOB_MAX_PAGES, MIRROR_RUN_MAX_PAGES, mirrorJobCapacity,
  } = await import("@/lib/scope/mirror/sync");
  console.error(
    `[local-resync] MIRROR_JOB_MAX_PAGES=${MIRROR_JOB_MAX_PAGES} ` +
    `(jobs/run cap ${mirrorJobCapacity()}) · MIRROR_RUN_MAX_PAGES=${MIRROR_RUN_MAX_PAGES} · ` +
    `maxRuns=${options.maxRuns} · budgetMs=${options.budgetMs} · ` +
    `resyncBefore=${options.resyncBefore.toISOString()} · ` +
    `promptsUpdatedFrom=${options.promptsUpdatedFrom ?? "all"} · promptsUpdatedTo=${options.promptsUpdatedTo ?? "all"} · ` +
    `window ${options.runsSince.toISOString()} → ${options.runsUntil.toISOString()}`,
  );
  const startedAt = Date.now();
  const result = await syncStandardMirror({
    ...options,
    // An explicitly scoped offline recovery can use its full local budget.
    projectBudgetMs: options.budgetMs,
  });
  const report = localResyncReport(result, options.resyncBefore);
  console.log(JSON.stringify({
    since: options.runsSince.toISOString(), until: options.runsUntil.toISOString(),
    projectIds: options.projectIds,
    promptsUpdatedFrom: options.promptsUpdatedFrom, promptsUpdatedTo: options.promptsUpdatedTo,
    maxRuns: options.maxRuns, ...report, ms: Date.now() - startedAt,
  }));
  return report.exitCode;
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
  // Do not dump SQL parameters or source answer payloads on an unexpected error.
  console.error("Local resync failed", error instanceof Error ? error.name : "UnknownError");
  process.exit(1);
});
