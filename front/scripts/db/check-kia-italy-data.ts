/**
 * Kia Italy 프로젝트 데이터 진단 — 프롬프트 등록 / scope mirror 답변 / 인용
 * 도메인이 실제로 있는지 한 번에 확인.
 *
 *   npx tsx --env-file=.env.local scripts/db/check-kia-italy-data.ts
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");
const conn = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(conn);

const proj = (await db.execute(sql`
  SELECT id, name, domain, brand, country, scope_project_id, created_at
  FROM projects WHERE name = 'Kia Italy' LIMIT 1
`)) as unknown as Array<{
  id: string;
  name: string;
  domain: string | null;
  brand: string | null;
  country: string;
  scope_project_id: string | null;
  created_at: string;
}>;
const p = proj[0];
if (!p) {
  console.log("✗ 'Kia Italy' 프로젝트 없음");
  await conn.end();
  process.exit(0);
}
console.log("=== 프로젝트 ===");
console.log(`id              : ${p.id}`);
console.log(`name            : ${p.name}`);
console.log(`domain          : ${p.domain}`);
console.log(`brand / country : ${p.brand} / ${p.country}`);
console.log(`scope_project_id: ${p.scope_project_id ?? "(없음)"}`);
console.log(`created_at      : ${p.created_at}`);

// 프롬프트 (이 프로젝트가 갖는 프롬프트)
const prompts = (await db.execute(sql`
  SELECT count(*)::int AS total,
         count(scope_prompt_id)::int AS linked_to_scope
  FROM prompts WHERE project_id = ${p.id}
`)) as unknown as Array<{ total: number; linked_to_scope: number }>;
console.log("\n=== prompts (이 프로젝트) ===");
console.log(`total              : ${prompts[0].total}`);
console.log(`linked to scope    : ${prompts[0].linked_to_scope}`);

// scope mirror — answers / mentions / citations 카운트 (전체)
const mirror = (await db.execute(sql`
  SELECT
    (SELECT count(*)::int FROM scope_answers) AS answers_total,
    (SELECT count(DISTINCT region)::int FROM scope_answers WHERE region IS NOT NULL) AS regions,
    (SELECT count(*)::int FROM scope_answers WHERE region = 'IT') AS answers_it,
    (SELECT count(*)::int FROM scope_citations) AS citations_total,
    (SELECT count(*)::int FROM scope_citations WHERE url LIKE '%kia.com/it%') AS citations_kia_it
`)) as unknown as Array<{
  answers_total: number;
  regions: number;
  answers_it: number;
  citations_total: number;
  citations_kia_it: number;
}>;
console.log("\n=== scope mirror ===");
console.log(`answers (전체)            : ${mirror[0].answers_total}`);
console.log(`distinct regions          : ${mirror[0].regions}`);
console.log(`answers WHERE region=IT   : ${mirror[0].answers_it}`);
console.log(`citations (전체)          : ${mirror[0].citations_total}`);
console.log(`citations url LIKE kia.com/it: ${mirror[0].citations_kia_it}`);

// Kia Italy 프로젝트 prompt → scope_answers 매칭 (scope_prompt_id 경유)
const linked = (await db.execute(sql`
  SELECT count(DISTINCT a.job_id)::int AS answers
  FROM scope_answers a
  WHERE a.prompt_id IN (
    SELECT scope_prompt_id FROM prompts
    WHERE project_id = ${p.id} AND scope_prompt_id IS NOT NULL
  )
`)) as unknown as Array<{ answers: number }>;
console.log(`answers (Kia Italy prompts 매칭): ${linked[0].answers}`);

await conn.end();
