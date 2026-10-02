import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const client = postgres(process.env.DATABASE_URL!, { prepare: false });
const db = drizzle(client);

async function main() {
  // scope_runs의 project_id가 projects.scope_project_id와 매핑 안 되는 것
  const orphanRuns = await db.execute(sql`
    SELECT
      sr.project_id        AS scope_project_id,
      COUNT(*)             AS run_count,
      MAX(sr.started_at)   AS last_run,
      COUNT(DISTINCT sa.job_id) AS answer_count
    FROM scope_runs sr
    LEFT JOIN scope_answers sa ON sa.run_id = sr.run_id
    WHERE sr.project_id NOT IN (
      SELECT scope_project_id::uuid
      FROM projects
      WHERE scope_project_id IS NOT NULL
    )
    GROUP BY sr.project_id
    ORDER BY last_run DESC
  `);

  console.log("\n## scope_runs — projects 테이블과 미연결");
  console.log(`(${orphanRuns.length}개 scope project)\n`);
  if (orphanRuns.length === 0) {
    console.log("없음 ✅");
  } else {
    for (const r of orphanRuns as any[]) {
      console.log(`  ${r.scope_project_id}  runs=${r.run_count}  answers=${r.answer_count}  last=${String(r.last_run).slice(0,10)}`);
    }
  }

  // projects 테이블에는 있는데 scope_runs에 run이 하나도 없는 프로젝트
  const noRuns = await db.execute(sql`
    SELECT
      p.id,
      p.name,
      p.scope_project_id,
      p.brand,
      p.created_at
    FROM projects p
    WHERE p.scope_project_id IS NOT NULL
      AND p.scope_project_id::uuid NOT IN (
        SELECT DISTINCT project_id FROM scope_runs WHERE project_id IS NOT NULL
      )
    ORDER BY p.created_at DESC
  `);

  console.log("\n## projects — scope_runs 없는 프로젝트 (측정 미시작)");
  console.log(`(${noRuns.length}개)\n`);
  if (noRuns.length === 0) {
    console.log("없음 ✅");
  } else {
    for (const r of noRuns as any[]) {
      console.log(`  [${String(r.brand).padEnd(10)}] ${r.name}  scope=${r.scope_project_id}`);
    }
  }

  // 전체 요약
  const summary = await db.execute(sql`
    SELECT
      (SELECT COUNT(DISTINCT project_id) FROM scope_runs WHERE project_id IS NOT NULL) AS mirror_projects,
      (SELECT COUNT(*) FROM projects WHERE scope_project_id IS NOT NULL)                AS linked_projects,
      (SELECT COUNT(*) FROM scope_runs)                                                  AS total_runs,
      (SELECT COUNT(*) FROM scope_answers)                                               AS total_answers
  `);
  const s = (summary as any[])[0];
  console.log("\n## 요약");
  console.log(`  미러 프로젝트: ${s.mirror_projects}개`);
  console.log(`  projects 연결: ${s.linked_projects}개`);
  console.log(`  총 runs: ${s.total_runs}개`);
  console.log(`  총 answers: ${s.total_answers}개`);

  await client.end();
}

main().catch(console.error);
