/**
 * 표준(root) 미러 답변 raw 추출 — 브랜드별 CSV.
 *
 *   npx tsx --env-file=.env.local scripts/db/export-standard-answers.ts
 *   npx tsx --env-file=.env.local scripts/db/export-standard-answers.ts --days 14 --out exports
 *
 * 1행 = 1답변(프롬프트 × 엔진 × 지역). 언급 브랜드는 열로 펼쳐 답변별 언급 횟수를
 * 채운다(0은 빈칸). 브랜드 열은 기간 내 총 언급량 desc 정렬이라 주요 브랜드가 왼쪽.
 *
 * 파일은 프롬프트 카탈로그 브랜드(Hyundai/Kia/Genesis)별로 분리한다. 카탈로그에서
 * 한 프롬프트가 두 브랜드에 태깅된 경우(2026-07-08 기준 32건) 그 답변은 양쪽 파일에
 * 모두 나타난다 — 프롬프트가 실제로 두 브랜드 소속이므로 의도된 중복.
 *
 * 언급 브랜드는 앱 KPI와 동일한 rollup(brand_rollup_entity_id → 상위 Brand 이름)을
 * 적용해 대시보드 수치와 맞춘다. 비경쟁 브랜드(Apple/Google 등) 제외는 적용하지
 * 않는다 — raw 추출이므로 미러에 있는 그대로 낸다.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const SCOPE_ROOT = process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";
const LOCAL_ROOT = process.env.STANDARD_ROOT_PROJECT_ID ?? "26751906-c175-485c-9e69-29fc68d0fdbb";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DAYS = Number(arg("days", "7"));
const OUT_DIR = arg("out", "exports");

// RFC4180 — 쉼표/따옴표/개행이 든 답변 본문을 안전하게 감싼다.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const window = sql`
    r.project_id = ${SCOPE_ROOT}
    AND r.status IN ('completed', 'partial_failed')
    AND a.status = 'completed'
    AND r.started_at >= now() - (${DAYS} || ' days')::interval
  `;

  // ① 브랜드 열 순서 — 기간 내 총 언급량 desc (앱과 동일 rollup)
  const brandCols = (await sql`
    WITH names AS (
      SELECT DISTINCT ON (entity_id) entity_id, brand
      FROM scope_mentions WHERE entity_type = 'Brand' AND brand IS NOT NULL
    )
    SELECT COALESCE(n.brand, m.brand) AS name, sum(m.mention_count)::int AS mentions
    FROM scope_mentions m
    LEFT JOIN names n ON n.entity_id = m.brand_rollup_entity_id
    JOIN scope_answers a ON a.job_id = m.job_id
    JOIN scope_runs r ON r.run_id = a.run_id
    WHERE ${window} AND COALESCE(n.brand, m.brand) IS NOT NULL
    GROUP BY 1 ORDER BY mentions DESC
  `).map((r) => r.name as string);

  // ② 답변별 언급 브랜드 카운트
  const mentionRows = (await sql`
    WITH names AS (
      SELECT DISTINCT ON (entity_id) entity_id, brand
      FROM scope_mentions WHERE entity_type = 'Brand' AND brand IS NOT NULL
    )
    SELECT m.job_id, COALESCE(n.brand, m.brand) AS name, sum(m.mention_count)::int AS cnt
    FROM scope_mentions m
    LEFT JOIN names n ON n.entity_id = m.brand_rollup_entity_id
    JOIN scope_answers a ON a.job_id = m.job_id
    JOIN scope_runs r ON r.run_id = a.run_id
    WHERE ${window} AND COALESCE(n.brand, m.brand) IS NOT NULL
    GROUP BY m.job_id, 2
  `) as Array<{ job_id: string; name: string; cnt: number }>;

  const byJob = new Map<string, Map<string, number>>();
  for (const m of mentionRows) {
    let e = byJob.get(m.job_id);
    if (!e) byJob.set(m.job_id, (e = new Map()));
    e.set(m.name, m.cnt);
  }

  // ③ 답변 + 카탈로그 메타 (카탈로그 브랜드별로 나눠 쓰기 위해 prompts 조인)
  const answers = (await sql`
    SELECT a.job_id, a.measured_at, a.prompt_id, a.target, a.region, a.model_slug, a.answer_text,
           p.text AS prompt_text, p.brand, p.funnel_stage, p.list_type, p.depth1, p.depth2, p.depth3
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id
    JOIN prompts p ON p.scope_prompt_id = a.prompt_id AND p.project_id = ${LOCAL_ROOT}
    WHERE ${window}
    ORDER BY p.brand, a.measured_at
  `) as Array<Record<string, unknown>>;

  const META = [
    "job_id", "측정일시", "프롬프트ID", "프롬프트", "카탈로그브랜드", "퍼널단계",
    "리스트타입", "depth1", "depth2", "depth3", "엔진", "지역", "모델", "답변본문",
  ];
  const header = [...META, ...brandCols].map(csvCell).join(",");

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const byBrand = new Map<string, string[]>();
  for (const a of answers) {
    const counts = byJob.get(a.job_id as string);
    const row = [
      a.job_id, a.measured_at, a.prompt_id, a.prompt_text, a.brand, a.funnel_stage,
      a.list_type, a.depth1, a.depth2, a.depth3, a.target, a.region, a.model_slug, a.answer_text,
      ...brandCols.map((b) => counts?.get(b) ?? ""), // 0은 빈칸 — 파일 크기·가독성
    ].map(csvCell).join(",");
    const key = (a.brand as string) ?? "미분류";
    (byBrand.get(key) ?? byBrand.set(key, []).get(key)!).push(row);
  }

  console.log(`표준 루트 최근 ${DAYS}일 — 답변 ${answers.length}행, 언급 브랜드 열 ${brandCols.length}개`);
  for (const [brand, rows] of byBrand) {
    const file = path.join(OUT_DIR, `standard-answers-${brand}-${stamp}.csv`);
    // UTF-8 BOM — Excel이 한글을 깨지 않게 연다.
    fs.writeFileSync(file, "﻿" + header + "\n" + rows.join("\n") + "\n", "utf8");
    const mb = (fs.statSync(file).size / 1048576).toFixed(1);
    console.log(`  ${file} — ${rows.length}행, ${mb}MB`);
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
