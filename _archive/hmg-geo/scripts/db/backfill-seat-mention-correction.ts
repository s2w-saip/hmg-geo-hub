/**
 * One-off backfill: apply the SEAT brand/noun disambiguation
 * (lib/scope/mirror/case-sensitive-brands.ts) to scope_mentions rows already
 * sitting in the mirror, without re-pulling anything from scope. The
 * force=1 mirror re-sync timed out (Vercel FUNCTION_INVOCATION_TIMEOUT) before
 * it could re-fetch every project's history, so this fixes the existing rows
 * directly — the answer text is already local (scope_answers.answer_text).
 *
 *   npx tsx --env-file=.env.local scripts/db/backfill-seat-mention-correction.ts [--dry-run]
 *
 * Idempotent — re-running just recomputes the same corrected values.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { correctCaseSensitiveBrandMention } from "@/lib/scope/mirror/case-sensitive-brands";
import type { ResolvedMention } from "@/lib/scope/types";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing env DATABASE_URL");

const dryRun = process.argv.includes("--dry-run");

const conn = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(conn);

const rows = (await db.execute(sql`
  SELECT m.job_id, m.entity_id, m.brand, m.entity_type, m.mention_count, m.surfaces,
         a.answer_text
  FROM scope_mentions m
  JOIN scope_answers a ON a.job_id = m.job_id
  WHERE upper(m.brand) = 'SEAT'
`)) as unknown as Array<{
  job_id: string;
  entity_id: string;
  brand: string;
  entity_type: string | null;
  mention_count: number;
  surfaces: string[] | null;
  answer_text: string | null;
}>;

console.log(`found ${rows.length} scope_mentions rows tagged brand=SEAT`);

let updated = 0;
let dropped = 0;
let unchanged = 0;

for (const row of rows) {
  const mention: ResolvedMention = {
    entity_id: row.entity_id,
    entity_type: row.entity_type,
    display_name: row.brand,
    rollups: { product_entity_id: null, brand_entity_id: null, company_entity_id: null },
    surfaces: row.surfaces ?? [],
    mention_count: row.mention_count,
  };
  const corrected = correctCaseSensitiveBrandMention(mention, row.answer_text);

  if (!corrected) {
    dropped += 1;
    if (!dryRun) {
      await db.execute(sql`
        DELETE FROM scope_mentions
        WHERE job_id = ${row.job_id}::uuid AND entity_id = ${row.entity_id}::uuid
      `);
    }
    continue;
  }
  if (corrected.mention_count === row.mention_count) {
    unchanged += 1;
    continue;
  }
  updated += 1;
  if (!dryRun) {
    // drizzle's generic sql`` tag mis-serializes a JS array param here
    // ("malformed array literal") — use the postgres.js tag directly, which
    // natively converts JS arrays to Postgres array literals.
    await conn`
      UPDATE scope_mentions
      SET mention_count = ${corrected.mention_count}, surfaces = ${conn.array(corrected.surfaces)}
      WHERE job_id = ${row.job_id}::uuid AND entity_id = ${row.entity_id}::uuid
    `;
  }
}

console.log(
  `${dryRun ? "[dry-run] " : ""}updated=${updated} dropped=${dropped} unchanged=${unchanged} total=${rows.length}`,
);
await conn.end();
