/** Fresh Supabase projects only. See docs/handover-db-bootstrap.md. */
import postgres from "postgres";
import { applyBootstrap, assertEmptyDatabase, targetIdentity, type Query } from "./bootstrap-lib";
import { bootstrapPlan, SKIPPED_MIGRATIONS } from "./bootstrap-plan";

async function main() {
  const args = process.argv.slice(2);
  const valid = args.every((arg) => ["--dry-run", "--preflight", "--yes", "--help"].includes(arg) || arg.startsWith("--confirm="));
  if (!valid) throw new Error("Unknown option. Use --dry-run, --preflight, or --yes --confirm=<project-ref|local>.");
  if (args.includes("--help")) {
    console.log("db:bootstrap: --dry-run (offline plan), --preflight (read-only target checks), --yes --confirm=<project-ref|local> (fresh DB only)");
    return;
  }
  const modes = ["--dry-run", "--preflight", "--yes"].filter((arg) => args.includes(arg));
  if (modes.length > 1) throw new Error("Choose exactly one mode: --dry-run, --preflight, or --yes.");
  const steps = bootstrapPlan();
  console.log(`Fresh Supabase bootstrap: ${steps.length} SQL files, one transaction.`);
  for (const [name, reason] of Object.entries(SKIPPED_MIGRATIONS)) console.log(`Skip ${name}: ${reason}`);
  if (!modes.length || modes[0] === "--dry-run") {
    for (const step of steps) console.log(`  ${step.name}`);
    console.log("Offline plan only; no database connection or writes. Use --preflight to inspect a fresh target.");
    return;
  }
  const { DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL } = process.env;
  if (!DATABASE_URL || !NEXT_PUBLIC_SUPABASE_URL) throw new Error("DATABASE_URL and NEXT_PUBLIC_SUPABASE_URL are required.");
  const target = targetIdentity(DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL);
  console.log(`Target: ${target.label}`);
  if (modes[0] === "--yes" && !args.includes(`--confirm=${target.confirm}`)) {
    throw new Error(`Explicit target confirmation required: --yes --confirm=${target.confirm}`);
  }
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
  try {
    if (modes[0] === "--preflight") {
      await sql.begin("read only", async (tx) => {
        await tx.unsafe("SET LOCAL search_path = public, pg_catalog; SET LOCAL statement_timeout = '15s'");
        await assertEmptyDatabase(((text, params) => tx.unsafe(text, params as never[])) as Query);
      });
      console.log(`Preflight passed (read-only). Apply with --yes --confirm=${target.confirm}.`);
      return;
    }
    const result = await sql.begin(async (tx) => applyBootstrap(
      ((text, params) => tx.unsafe(text, params as never[])) as Query,
      (text) => tx.unsafe(text), steps, (name) => console.log(`Apply ${name}`),
    ));
    console.log(`Bootstrap committed and verified: ${result.tables} parent/base tables, ${result.columns} columns; browser roles denied.`);
    console.log("Next: create the first admin, then load the demo or authorized source data. Re-running bootstrap is deliberately refused.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("No reset/drop is performed. A failed apply transaction rolls back all bootstrap changes.");
  process.exitCode = 1;
});
