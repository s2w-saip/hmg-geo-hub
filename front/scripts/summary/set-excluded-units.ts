// summary_settings.website_excluded_fs 설정 — 보고서가 제외한 유닛(file_seq) JSON 배열.
// 실행: bash notes/hmg-db-exec.sh <워크트리> npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/set-excluded-units.ts 71,94,97   (빈 문자열 = 해제)
import postgres from "postgres";
const arg = process.argv[2] ?? "";
const list = arg.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
if (list.some((n) => !Number.isInteger(n) || n <= 0)) { console.error("정수 file_seq 목록만"); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: "require" });
try {
  const v = JSON.stringify(list);
  await sql`INSERT INTO summary_settings (key, value, updated_at) VALUES ('website_excluded_fs', ${v}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  const rows = await sql`SELECT key, value, updated_at FROM summary_settings ORDER BY key`;
  for (const r of rows) console.log(`${r.key} = ${r.value}  (${r.updated_at.toISOString()})`);
} finally { await sql.end(); }
