/**
 * Hyundai N 프롬프트 중복 정리 — 부모 사이트(현대 한국·글로벌)에 섞여 들어간 사본 제거.
 *
 * 배경: seed-website-prompts.ts 가 `hyundai-n` 을 부모 브랜드 "Hyundai" 로 매핑하던
 * 시절, 파일 040/041(hyundai-n.com)이 Hyundai/KR·Hyundai/worldwide 사이트로
 * 적재됐다. 이후 별도 `Hyundai N` 사이트가 생기면서 같은 프롬프트가 두 사이트·두
 * scope 프로젝트에 존재하게 됐고, 매 라운드 이중 측정됐다. 리포트도 자기 base 밖
 * (hyundai-n.com) 타겟을 집계해 현대 한국·글로벌 수치가 왜곡됐다.
 * 시더는 이제 "Hyundai N" 으로 매핑한다(같은 커밋) — 이 스크립트는 기존 데이터를 맞춘다.
 *
 * 정본 = `Hyundai N` 사이트. 부모 사이트 쪽 사본만 지운다. 두 사이트는 서로 다른
 * scope_prompt_id 를 쓰므로(사전 검증됨) 부모 쪽 삭제가 N 측정에 영향을 주지 않는다.
 *
 * 멱등하다 — 지울 대상이 없으면 아무 것도 하지 않는다.
 *
 *   npx tsx --env-file=.env.local scripts/db/dedupe-hyundai-n-prompts.ts          # 드라이런
 *   npx tsx --env-file=.env.local scripts/db/dedupe-hyundai-n-prompts.ts --apply  # 실행
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { getScopeClient } from "../../lib/scope/index";

const APPLY = process.argv.includes("--apply");
const N_FILE_SEQS = [40, 41]; // hyundai-n.com 원본 파일

const conn = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const db = drizzle(conn);

type Row = { id: string; scope_prompt_id: string | null; pid: string; cc: string; file_seq: number };
const targets = (await db.execute(sql.raw(`
  SELECT wp.id, wp.scope_prompt_id, ws.scope_project_id AS pid, ws.country_code AS cc, wp.file_seq
  FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
  WHERE ws.brand = 'Hyundai' AND wp.file_seq IN (${N_FILE_SEQS.join(",")})
`))) as unknown as Row[];

if (targets.length === 0) {
  console.log("정리할 대상이 없습니다 — 이미 적용된 상태입니다.");
  await conn.end();
  process.exit(0);
}

// 안전장치: 정본(N 사이트)이 온전한지, 그리고 scope 프롬프트 id 가 겹치지 않는지
const [{ n_rows, n_pushed }] = (await db.execute(sql.raw(`
  SELECT count(*)::int AS n_rows, count(wp.scope_prompt_id)::int AS n_pushed
  FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
  WHERE ws.brand = 'Hyundai N'`))) as unknown as Array<{ n_rows: number; n_pushed: number }>;
const [{ shared }] = (await db.execute(sql.raw(`
  SELECT count(*)::int AS shared FROM website_prompts a
  JOIN website_prompts b ON a.scope_prompt_id = b.scope_prompt_id AND a.id <> b.id
  JOIN website_sites sa ON sa.id = a.site_id JOIN website_sites sb ON sb.id = b.site_id
  WHERE sa.brand = 'Hyundai' AND sb.brand = 'Hyundai N'
    AND a.file_seq IN (${N_FILE_SEQS.join(",")})`))) as unknown as Array<{ shared: number }>;

console.log(`정본(Hyundai N 사이트) 프롬프트 ${n_rows}개 · scope 푸시 ${n_pushed}개`);
console.log(`부모 사이트의 중복 사본 ${targets.length}개 (scope 연결 ${targets.filter((t) => t.scope_prompt_id).length}개)`);
console.log(`두 사이트가 공유하는 scope 프롬프트 id: ${shared}개`);
if (n_rows !== n_pushed || n_rows === 0) {
  console.error("✗ 정본 사이트가 온전하지 않습니다 — 중단합니다."); await conn.end(); process.exit(1);
}
if (shared > 0) {
  console.error("✗ 두 사이트가 같은 scope 프롬프트를 공유합니다 — 삭제하면 정본까지 사라집니다. 중단합니다.");
  await conn.end(); process.exit(1);
}

const idList = targets.filter((t) => t.scope_prompt_id).map((t) => `'${t.scope_prompt_id}'::uuid`).join(",");
const answers = idList
  ? ((await db.execute(sql.raw(`SELECT job_id FROM scope_answers WHERE prompt_id IN (${idList})`))) as unknown as Array<{ job_id: string }>)
  : [];
console.log(`연결된 미러 답변 ${answers.length}건 (멘션·인용 포함 정리 대상)`);

if (!APPLY) {
  console.log("\n[드라이런] --apply 를 붙이면 실행합니다. 순서: scope 프롬프트 삭제 → 미러 정리 → 로컬 행 삭제");
  await conn.end();
  process.exit(0);
}

// ① scope 프롬프트 삭제 — 향후 이중 측정 중단
const client = getScopeClient();
let deleted = 0, failed = 0;
for (const t of targets) {
  if (!t.scope_prompt_id) continue;
  try { await client.deletePrompt(t.pid, t.scope_prompt_id); deleted++; }
  catch (e) { failed++; console.warn(`  deletePrompt 실패 ${t.scope_prompt_id}:`, e instanceof Error ? e.message : e); }
}
console.log(`① scope 프롬프트 삭제 ${deleted}/${targets.filter((t) => t.scope_prompt_id).length} (실패 ${failed})`);

// ② 미러 정리 — run 행은 부모 사이트의 다른 프롬프트와 공유하므로 보존
if (answers.length) {
  const jobs = answers.map((a) => `'${a.job_id}'::uuid`).join(",");
  await db.execute(sql.raw(`DELETE FROM scope_mentions  WHERE job_id IN (${jobs})`));
  await db.execute(sql.raw(`DELETE FROM scope_citations WHERE job_id IN (${jobs})`));
  await db.execute(sql.raw(`DELETE FROM scope_answers   WHERE job_id IN (${jobs})`));
}
console.log(`② 미러 정리: 답변 ${answers.length}건 + 연결 멘션·인용 삭제`);

// ③ 로컬 행 삭제
await db.execute(sql.raw(
  `DELETE FROM website_prompts WHERE id IN (${targets.map((t) => `'${t.id}'::uuid`).join(",")})`));
console.log(`③ website_prompts ${targets.length}행 삭제`);

const [{ left }] = (await db.execute(sql.raw(`
  SELECT count(*)::int AS left FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
  WHERE ws.brand = 'Hyundai' AND wp.file_seq IN (${N_FILE_SEQS.join(",")})`))) as unknown as Array<{ left: number }>;
console.log(`\n검증: 부모 사이트 잔여 ${left}행 · 정본 ${n_rows}행 유지`);
await conn.end();
process.exit(failed ? 1 : 0);
