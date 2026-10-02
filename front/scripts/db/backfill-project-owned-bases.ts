/**
 * Backfill legacy `projects.domain` into `project_owned_bases`.
 *
 *   npx tsx --env-file=.env.local scripts/db/backfill-project-owned-bases.ts
 *
 * Idempotent:
 * - skips rows where domain is null/blank
 * - ON CONFLICT (project_id, base_url) DO NOTHING
 *
 * This does not delete or rewrite `projects.domain`; it simply seeds the new
 * owned-base structure so existing projects stop relying on the legacy fallback.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { normalizeUrlForMatch } from "@/lib/scope/url-match";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing env DATABASE_URL");

const conn = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(conn);

const tableExists = (await db.execute(sql`
  SELECT to_regclass('public.project_owned_bases') AS t
`)) as unknown as Array<{ t: string | null }>;

if (!tableExists[0]?.t) {
  console.error(
    "✗ project_owned_bases 테이블이 없습니다. 0021 마이그레이션 먼저 적용하세요.",
  );
  await conn.end();
  process.exit(1);
}

const rows = (await db.execute(sql`
  SELECT id, domain, created_by
  FROM projects
  WHERE domain IS NOT NULL AND btrim(domain) <> ''
  ORDER BY created_at ASC
`)) as unknown as Array<{
  id: string;
  domain: string;
  created_by: string;
}>;

if (rows.length === 0) {
  console.log("No legacy project domains found.");
  await conn.end();
  process.exit(0);
}

let inserted = 0;
let skipped = 0;

for (const row of rows) {
  const normalized = normalizeUrlForMatch(row.domain);
  if (!normalized) {
    skipped += 1;
    console.warn(`skip: ${row.id} invalid domain "${row.domain}"`);
    continue;
  }
  const result = (await db.execute(sql`
    INSERT INTO project_owned_bases (project_id, base_url, label, created_by)
    VALUES (${row.id}::uuid, ${normalized}, 'legacy domain backfill', ${row.created_by}::uuid)
    ON CONFLICT (project_id, base_url) DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  if (result.length > 0) inserted += 1;
  else skipped += 1;
}

console.log(`done. inserted=${inserted} skipped=${skipped} total=${rows.length}`);
await conn.end();
