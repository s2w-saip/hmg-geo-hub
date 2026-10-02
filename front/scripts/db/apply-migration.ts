/**
 * 마이그레이션 적용기 — **이 리포의 유일한 적용 경로**.
 *
 *   npm run db:apply -- 0045          # 파일명 접두어로 선택
 *   npm run db:apply -- 0044 0045     # 여러 개 순서대로
 *
 * `drizzle-kit migrate`(db:migrate)는 쓰지 않는다 — 저널의 when 하나만 보고 이미
 * 적용된 마이그레이션을 재실행하기 때문이다(scripts/db/migrate-guard.mjs 참고).
 * 적용 여부의 정본은 저널이 아니라 **DB 실측**이다(`npm run db:drift`).
 *
 * 실측(2026-08-22, 프로덕션): `drizzle.__drizzle_migrations` 는 **19행 · max(created_at)
 * = 1782200000000 = `0019_website_sites_prompts`** 에서 멈춰 있다. 즉 **0020부터는
 * 전부 이 스크립트(또는 대시보드)로 손으로 적용됐다** — 저널에 0020~0043 태그가
 * 있는 것과 무관하다(저널은 generate 를 되살리기 위한 것이지 적용 기록이 아니다).
 * ⚠️ 그래서 migrate 를 한 번이라도 돌리면 0020 이후 **24개가 재실행 대상**이 된다.
 *
 * 파일은 반드시 idempotent(IF NOT EXISTS / DROP CONSTRAINT IF EXISTS /
 * ON CONFLICT DO NOTHING)로 작성 — 재실행 안전이 이 방식의 전제다.
 * `db:generate` 가 뽑아주는 SQL 은 멱등하지 않으므로 적용 전에 손질한다.
 *
 * 접두어가 여러 파일과 일치하면(예: 0043 이 두 개) 중단하고 후보를 출력한다 —
 * 전체 파일명을 넘겨 지정한다.
 *
 * DATABASE_URL은 .env.local에서 로드된다.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = "lib/db/migrations";

async function main() {
  const prefixes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (prefixes.length === 0) {
    console.error("사용법: npm run db:apply -- <번호 접두어…>  (예: npm run db:apply -- 0023)");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — .env.local 확인");

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const targets: string[] = [];
  for (const p of prefixes) {
    const matched = files.filter((f) => f.startsWith(p));
    if (matched.length === 0) throw new Error(`'${p}'와 일치하는 마이그레이션 파일이 없습니다`);
    if (matched.length > 1) throw new Error(`'${p}'가 여러 파일과 일치합니다: ${matched.join(", ")}`);
    targets.push(matched[0]);
  }

  const sql = postgres(url, { prepare: false, connect_timeout: 15 });
  try {
    for (const file of targets) {
      const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
      });
      console.log(`✅ applied: ${file}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
