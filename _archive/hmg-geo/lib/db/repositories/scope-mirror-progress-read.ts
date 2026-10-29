import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";

type ProgressTableProbe = {
  available: boolean;
  expiresAt: number;
};

// A missing migration is expected during a rolling deploy and is therefore a
// normal false result. A failed probe is different: it must reach the caller,
// otherwise a transient database failure could silently publish partial data.
const ABSENT_RETRY_MS = 60_000;
const PRESENT_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
let cachedProbe: ProgressTableProbe | null = null;
let inflightProbe: Promise<boolean> | null = null;

function progressVisibilitySql(runIdCol: SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1
      FROM scope_mirror_progress p
     WHERE p.run_id = ${runIdCol}
       AND (
         p.phase = 'complete'
         OR (p.phase = 'finalize' AND p.state->>'step' = 'invalidate-published')
       ) IS NOT TRUE
  )`;
}

async function probeProgressTable(): Promise<boolean> {
  const now = Date.now();
  if (cachedProbe && cachedProbe.expiresAt > now) return cachedProbe.available;
  if (inflightProbe) return inflightProbe;

  inflightProbe = (async () => {
    // `to_regclass` is safe when migration 0073 has not been applied. Do not
    // catch this query: permission/network/server errors are not table absence.
    const rows = (await getDb().execute(sql`
      SELECT to_regclass('public.scope_mirror_progress') AS table_name
    `)) as unknown as Array<{ table_name: string | null }>;
    const available = Boolean(rows[0]?.table_name);
    cachedProbe = {
      available,
      expiresAt: available ? PRESENT_EXPIRES_AT : Date.now() + ABSENT_RETRY_MS,
    };
    return available;
  })().finally(() => {
    inflightProbe = null;
  });
  return inflightProbe;
}

/**
 * SQL gate shared by every direct mirror reader. During a rollout before
 * migration 0073 this returns `true`; once the table exists it excludes a
 * run until its durable bulk checkpoint is complete or past publication
 * invalidation.
 */
export async function bulkMirrorRunVisibleSql(runIdCol: SQL): Promise<SQL> {
  return (await probeProgressTable()) ? progressVisibilitySql(runIdCol) : sql`true`;
}

/**
 * Synchronous companion for SQL builders that must retain their existing
 * signature. Their async entrypoint probes first; an unresolved cache remains
 * fail-open until that explicit probe completes.
 */
export function bulkMirrorRunVisibleSqlKnown(runIdCol: SQL): SQL {
  return cachedProbe?.available === true ? progressVisibilitySql(runIdCol) : sql`true`;
}

/** Test-only cache reset; production callers should rely on probe caching. */
export function resetBulkMirrorRunVisibilityForTests(): void {
  cachedProbe = null;
  inflightProbe = null;
}
