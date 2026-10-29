/**
 * 응답을 받아오는 [프로젝트 단위] 진단.
 *
 * scope_answers 는 scope_prompts 와 prompt_id 로 link.
 * scope_prompts 자체엔 project_id 없음 → hmg-geo prompts.scope_prompt_id 로
 * hmg-geo projects 에 link 가능. 그래서 "이 답변이 어느 프로젝트에 묶이나" =
 * prompts → projects 경로.
 *
 *   npx tsx --env-file=.env.local scripts/db/check-scope-projects.ts
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");
const conn = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(conn);

console.log("=== env ===");
console.log(`SCOPE_ROOT_PROJECT_ID = ${process.env.SCOPE_ROOT_PROJECT_ID ?? "(없음)"}`);

// 1. mirror 의 scope_prompts 카운트 + hmg-geo prompts 와 link 카운트
const promptCounts = (await db.execute(sql`
  SELECT
    (SELECT count(*)::int FROM scope_prompts) AS sp_total,
    (SELECT count(*)::int FROM prompts WHERE scope_prompt_id IS NOT NULL) AS hmg_linked,
    (SELECT count(*)::int FROM prompts) AS hmg_total
`)) as unknown as Array<{ sp_total: number; hmg_linked: number; hmg_total: number }>;
console.log("\n=== 프롬프트 카운트 ===");
console.log(`scope_prompts (mirror)     : ${promptCounts[0].sp_total}`);
console.log(`hmg-geo prompts (전체)     : ${promptCounts[0].hmg_total}`);
console.log(`hmg-geo prompts → scope link: ${promptCounts[0].hmg_linked}`);

// 2. 답변이 묶이는 hmg-geo 프로젝트 (prompts.project_id 경유)
const byProject = (await db.execute(sql`
  SELECT
    pr.id AS project_id,
    pr.name AS project_name,
    pr.brand,
    pr.country,
    pr.scope_project_id,
    count(DISTINCT a.job_id)::int AS answers
  FROM scope_answers a
  JOIN prompts p ON p.scope_prompt_id = a.prompt_id
  JOIN projects pr ON pr.id = p.project_id
  GROUP BY pr.id, pr.name, pr.brand, pr.country, pr.scope_project_id
  ORDER BY answers DESC
`)) as unknown as Array<{
  project_id: string;
  project_name: string;
  brand: string | null;
  country: string;
  scope_project_id: string | null;
  answers: number;
}>;
console.log("\n=== 답변이 묶이는 hmg-geo 프로젝트 ===");
if (byProject.length === 0) {
  console.log("  (없음 — 어떤 답변도 hmg-geo 프로젝트와 연결 안 됨)");
} else {
  for (const r of byProject) {
    console.log(
      `  ${r.project_name}  brand=${r.brand} country=${r.country}  answers=${r.answers}  scope_project_id=${r.scope_project_id ?? "(null)"}`,
    );
  }
}

// 3. hmg-geo 프로젝트와 link 안 되는 mirror 답변 (orphan)
const orphan = (await db.execute(sql`
  SELECT count(DISTINCT a.job_id)::int AS orphans
  FROM scope_answers a
  WHERE a.prompt_id IS NULL
     OR a.prompt_id NOT IN (
       SELECT scope_prompt_id FROM prompts WHERE scope_prompt_id IS NOT NULL
     )
`)) as unknown as Array<{ orphans: number }>;
console.log(`\n=== orphan 답변 (hmg-geo prompts 미연결) ===`);
console.log(`  ${orphan[0].orphans}건 / 전체 29,441건 가까이일 가능성`);

// 4. region / target 분포 (전체)
const regions = (await db.execute(sql`
  SELECT COALESCE(region, '(null)') AS region, count(*)::int AS n
  FROM scope_answers
  GROUP BY region ORDER BY n DESC
`)) as unknown as Array<{ region: string; n: number }>;
console.log("\n=== scope_answers: region 분포 ===");
for (const r of regions) console.log(`  ${r.region}  ${r.n}`);

const targets = (await db.execute(sql`
  SELECT COALESCE(target, '(null)') AS target, count(*)::int AS n
  FROM scope_answers
  GROUP BY target ORDER BY n DESC LIMIT 10
`)) as unknown as Array<{ target: string; n: number }>;
console.log("\n=== scope_answers: target(엔진) 분포 ===");
for (const r of targets) console.log(`  ${r.target}  ${r.n}`);

// 5. hmg-geo 모든 projects 의 scope 연결 상태
const projects = (await db.execute(sql`
  SELECT name, brand, country, scope_project_id,
    (SELECT count(*)::int FROM prompts WHERE project_id = projects.id) AS prompts_total,
    (SELECT count(*)::int FROM prompts WHERE project_id = projects.id AND scope_prompt_id IS NOT NULL) AS prompts_linked
  FROM projects ORDER BY created_at
`)) as unknown as Array<{
  name: string;
  brand: string | null;
  country: string;
  scope_project_id: string | null;
  prompts_total: number;
  prompts_linked: number;
}>;
console.log("\n=== hmg-geo projects (전체) ===");
for (const p of projects) {
  console.log(
    `  ${p.name}  brand=${p.brand} country=${p.country}  scope=${p.scope_project_id ?? "(없음)"}  prompts=${p.prompts_total}/${p.prompts_linked} linked`,
  );
}

// 6. 측정 cadence
const cadence = (await db.execute(sql`
  SELECT min(measured_at) AS first_at, max(measured_at) AS last_at,
         count(DISTINCT date_trunc('day', measured_at))::int AS distinct_days
  FROM scope_answers WHERE measured_at IS NOT NULL
`)) as unknown as Array<{ first_at: string; last_at: string; distinct_days: number }>;
console.log("\n=== scope_answers: 측정 cadence ===");
console.log(`  first_at      : ${cadence[0].first_at}`);
console.log(`  last_at       : ${cadence[0].last_at}`);
console.log(`  distinct days : ${cadence[0].distinct_days}`);

await conn.end();
