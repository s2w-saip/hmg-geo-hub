/**
 * 제외 대상(EXCLUDED_SITE_COUNTRY_CODES) 프로젝트의 2026-09-04 회차를 원장째 지운다.
 *
 *   npm run summary:purge-0904            # dry-run (행수만)
 *   npm run summary:purge-0904 -- --yes   # 실제 DELETE
 *
 * 삭제 순서 = 세부층 6표 → summary_generations → summary_cycle_runs → summary_cycles.
 * 대상 cycle_id 를 먼저 확정하고 그 id 로만 지운다(다른 회차 무영향).
 */
process.env.DB_POOL_MAX ??= "2";

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { EXCLUDED_SITE_COUNTRY_CODES } from "./excluded";

const CYCLE_ANCHOR_AT = "2026-09-04T00:00:00Z";
const CYCLE_WEEK = "2026-08-31";
const SURFACE = "website";
const APPLY = process.argv.slice(2).includes("--yes");

const db = getDb();
const rows = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];

const FACT_TABLES = [
  "summary_cycle_jobs",
  "summary_answers",
  "summary_brand_mentions",
  "summary_domain_citations",
  "summary_target_hits",
  "summary_prompt_dim",
];

async function main() {
  const targets = await rows<{ cycle_id: string; project_id: string }>(sql`
    SELECT c.cycle_id, c.project_id::text AS project_id
    FROM summary_cycles c
    WHERE c.surface = ${SURFACE} AND c.cycle_anchor_at = ${CYCLE_ANCHOR_AT}::timestamptz
      AND c.project_id IN (
        SELECT DISTINCT scope_project_id::uuid FROM website_sites
        WHERE scope_project_id IS NOT NULL
          AND country_code = ANY(${sql.param(EXCLUDED_SITE_COUNTRY_CODES)}::text[])
      )
  `);
  console.log(`제외 코드 ${EXCLUDED_SITE_COUNTRY_CODES.join(",")} · 대상 회차 ${targets.length}개`, targets);
  if (targets.length === 0) return;
  const ids = targets.map((t) => t.cycle_id);

  const before = await rows<Record<string, unknown>>(sql`
    SELECT
      ${sql.join(
        FACT_TABLES.map(
          (t) => sql`(SELECT count(*) FROM ${sql.raw(t)} WHERE cycle_week = ${CYCLE_WEEK}::date
                       AND cycle_id = ANY(${sql.param(ids)}::uuid[]))::int AS ${sql.raw(t)}`,
        ),
        sql`, `,
      )},
      (SELECT count(*) FROM summary_generations WHERE cycle_id = ANY(${sql.param(ids)}::uuid[]))::int AS summary_generations,
      (SELECT count(*) FROM summary_cycle_runs  WHERE cycle_id = ANY(${sql.param(ids)}::uuid[]))::int AS summary_cycle_runs,
      (SELECT count(*) FROM summary_cycles      WHERE cycle_id = ANY(${sql.param(ids)}::uuid[]))::int AS summary_cycles
  `);
  console.log("삭제 예정 행수:", before[0]);
  if (!APPLY) {
    console.log("── DRY-RUN (삭제 없음). 실제 삭제는 --yes ──");
    return;
  }

  const deleted: Record<string, number> = {};
  await db.transaction(async (tx) => {
    for (const t of FACT_TABLES) {
      const r = (await tx.execute(sql`
        DELETE FROM ${sql.raw(t)}
        WHERE cycle_week = ${CYCLE_WEEK}::date AND cycle_id = ANY(${sql.param(ids)}::uuid[])
        RETURNING 1
      `)) as unknown as unknown[];
      deleted[t] = r.length;
    }
    for (const t of ["summary_generations", "summary_cycle_runs", "summary_cycles"]) {
      const r = (await tx.execute(sql`
        DELETE FROM ${sql.raw(t)} WHERE cycle_id = ANY(${sql.param(ids)}::uuid[]) RETURNING 1
      `)) as unknown as unknown[];
      deleted[t] = r.length;
    }
  });
  console.log("삭제 완료:", deleted);
  const left = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM summary_cycles WHERE cycle_id = ANY(${sql.param(ids)}::uuid[])
  `);
  console.log(`잔존 회차 ${left[0]?.n} (0 이어야 한다)`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
