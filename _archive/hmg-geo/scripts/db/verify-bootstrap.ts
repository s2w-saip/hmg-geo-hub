/** Read-only verification of the complete bootstrap schema, functions, indexes and ACLs. */
import postgres from "postgres";
import { targetIdentity, verifyBootstrap, type Query } from "./bootstrap-lib";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--application-only")) throw new Error("Unknown option. Supported: --application-only (warn about exposed objects outside the application baseline).");
  const applicationOnly = args.includes("--application-only");
  const { DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL } = process.env;
  if (!DATABASE_URL || !NEXT_PUBLIC_SUPABASE_URL) throw new Error("DATABASE_URL and NEXT_PUBLIC_SUPABASE_URL are required.");
  const target = targetIdentity(DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, "verify");
  console.log(`Verify target (read-only): ${target.label}`);
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
  try {
    const result = await sql.begin("read only", async (tx) => {
      await tx.unsafe("SET LOCAL search_path = public, pg_catalog; SET LOCAL statement_timeout = '30s'");
      return verifyBootstrap(((text, params) => tx.unsafe(text, params as never[])) as Query, { applicationOnly });
    });
    console.log(`Verified ${result.tables} baseline parent/base tables, ${result.columns} columns, constraints, indexes, enums, function bodies and ${applicationOnly ? "application" : "all public non-extension"} browser-role ACLs.`);
    for (const name of result.externalExposures) console.warn(`WARNING: exposed external public object (outside application baseline, unresolved): ${name}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((error: unknown) => {
  console.error(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
