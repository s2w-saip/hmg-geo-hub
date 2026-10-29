/** Offline catalog fixture generator. Uses an in-memory PostgreSQL engine; no network/credentials. */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { bootstrapPlan, REPO_ROOT } from "./bootstrap-plan";
import { readBootstrapCatalog, type Query } from "./bootstrap-lib";

async function main() {
  if (process.argv.slice(2).join(" ") !== "--write") throw new Error("Usage: npx tsx scripts/db/bootstrap-schema.ts --write (offline, review the resulting diff)");
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; BEGIN; SET LOCAL search_path = public, pg_catalog;");
    for (const step of bootstrapPlan()) await db.exec(step.sql);
    const query: Query = async <T extends Record<string, unknown>>(text: string, params?: unknown[]) => (await db.query<T>(text, params)).rows;
    const catalog = await readBootstrapCatalog(query);
    await db.exec("ROLLBACK");
    const output = path.join(REPO_ROOT, "scripts/db/bootstrap-schema.json");
    fs.writeFileSync(output, "{\n" + Object.entries(catalog).map(([key, rows]) =>
      `  ${JSON.stringify(key)}: [\n${rows.map((row) => "    " + JSON.stringify(row)).join(",\n")}\n  ]`,
    ).join(",\n") + "\n}\n");
    console.log(`Wrote offline bootstrap catalog: ${catalog.columns.length} columns. Review this fixture alongside migration changes.`);
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
