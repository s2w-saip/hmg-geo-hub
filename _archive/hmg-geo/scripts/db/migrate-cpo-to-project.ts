/**
 * 현대·제네시스 인증중고차(CPO, certified.hyundai.com)를 웹사이트 파이프라인에서
 * 분리해 별도 프로젝트로 이관 (2026-07-27 결정).
 *
 * 배경: 2차 배치 file 109가 웹사이트 시드로 들어와 Hyundai/KR 웹사이트 사이트
 * (scope 프로젝트 f82f9faa)에 합류했는데, CPO는 오피셜 사이트 인용 측정이 아니라
 * 독립 프로젝트로 관리하기로 함. 조회 권한(멤버) 설정은 추후 별도 작업.
 *
 * 수행:
 *   1. projects 로컬 행 생성 (brand=Hyundai, country=KR) + scope 프로젝트 생성
 *   2. website_prompts(file_seq=109) 20건 → prompts 테이블 복사 + 새 scope
 *      프로젝트로 push (keywords=[target_url])
 *   3. project_tracked_urls에 20개 타겟 URL 등록 (KPI⑥ 분모)
 *   4. 기존 웹사이트 scope 프로젝트에서 옛 프롬프트 20건 삭제
 *   5. website_prompts(file_seq=109) 행 삭제
 *
 * 안전장치: 이관 전 확인 결과 이 20개 프롬프트로 측정된 답변 0건 — 미러 정리
 * 불필요. 같은 이름의 프로젝트가 이미 있으면 중단(중복 실행 방지).
 *
 *   npx tsx --env-file=.env.local scripts/db/migrate-cpo-to-project.ts [--dry-run]
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { projects, prompts, websitePrompts, projectTrackedUrls } from "../../lib/db/schema";
import { getScopeClient } from "../../lib/scope/index";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");

const dryRun = process.argv.includes("--dry-run");

const PROJECT_NAME = "현대·제네시스 인증중고차 (CPO)";
const PROJECT_DOMAIN = "certified.hyundai.com";
const ADMIN_ID = "93f6c65c-ba00-478f-8276-4b8dc665c07f"; // admin@hmg.test
const WEBSITE_SCOPE_PROJECT = "f82f9faa-b02c-41b6-8c82-990ee444ef6d"; // Hyundai/KR 웹사이트

const conn = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(conn);

// ── 0. 소스 행 + 중복 실행 가드 ──────────────────────────────────────────────
const source = await db
  .select()
  .from(websitePrompts)
  .where(eq(websitePrompts.fileSeq, 109))
  .orderBy(websitePrompts.seqNo);
if (source.length === 0) throw new Error("website_prompts에 file_seq=109 행이 없습니다 (이미 이관됨?)");
console.log(`source: ${source.length} prompts (file_seq=109)`);

const dupe = await db.select().from(projects).where(eq(projects.name, PROJECT_NAME));
if (dupe.length > 0) throw new Error(`이미 같은 이름의 프로젝트가 있습니다: ${dupe[0].id}`);

const measured = (await db.execute(sql`
  SELECT count(*)::int AS c FROM scope_answers
  WHERE prompt_id IN (SELECT scope_prompt_id::uuid FROM website_prompts WHERE file_seq = 109 AND scope_prompt_id IS NOT NULL)
`)) as unknown as Array<{ c: number }>;
if (Number(measured[0].c) > 0) {
  throw new Error(`이미 측정된 답변 ${measured[0].c}건 존재 — 미러 정리 계획 없이 진행 불가`);
}

if (dryRun) {
  console.log("[dry-run] 생성될 프로젝트:", PROJECT_NAME, "| 이관 프롬프트:", source.length);
  console.log("[dry-run] 삭제될 웹사이트 scope 프롬프트:", source.filter((r) => r.scopePromptId).length);
  await conn.end();
  process.exit(0);
}

const scopeClient = getScopeClient();

// ── 1. 로컬 프로젝트 + scope 프로젝트 생성 ──────────────────────────────────
const [project] = await db
  .insert(projects)
  .values({
    name: PROJECT_NAME,
    description: "현대인증중고차·제네시스 인증중고차 통합 CPO 사이트 GEO 측정",
    domain: PROJECT_DOMAIN,
    brand: "Hyundai",
    country: "KR",
    createdBy: ADMIN_ID,
  })
  .returning();
console.log("local project created:", project.id);

const scopeProj = await scopeClient.createProject({
  name: PROJECT_NAME,
  domain: PROJECT_DOMAIN,
  tracked_brands: [{ brand_name: "Hyundai" }, { brand_name: "Genesis" }],
  regions: ["KR"],
});
await db
  .update(projects)
  .set({ scopeProjectId: scopeProj.project_id, updatedAt: new Date() })
  .where(eq(projects.id, project.id));
console.log("scope project created:", scopeProj.project_id);

// ── 2. 프롬프트 복사 + 새 scope 프로젝트로 push ─────────────────────────────
let pushed = 0;
for (const r of source) {
  const sp = await scopeClient.createPrompt(scopeProj.project_id, {
    text: r.promptText,
    keywords: [r.targetUrl],
  });
  await db.insert(prompts).values({
    projectId: project.id,
    text: r.promptText,
    status: "queued",
    scopePromptId: sp.prompt_id,
    createdBy: ADMIN_ID,
  });
  pushed++;
}
console.log(`prompts copied+pushed: ${pushed}/${source.length}`);

// ── 3. 타겟 URL 등록 (KPI⑥) ────────────────────────────────────────────────
const uniqueUrls = [...new Set(source.map((r) => r.targetUrl))];
for (const url of uniqueUrls) {
  await db.insert(projectTrackedUrls).values({
    projectId: project.id,
    url,
    createdBy: ADMIN_ID,
  }).onConflictDoNothing();
}
console.log(`tracked urls registered: ${uniqueUrls.length}`);

// ── 4. 웹사이트 scope 프로젝트에서 옛 프롬프트 삭제 ─────────────────────────
let deleted = 0;
for (const r of source) {
  if (!r.scopePromptId) continue;
  try {
    await scopeClient.deletePrompt(WEBSITE_SCOPE_PROJECT, r.scopePromptId);
    deleted++;
  } catch (e) {
    console.warn(`  [scope] deletePrompt 실패 (${r.scopePromptId}):`, e instanceof Error ? e.message : e);
  }
}
console.log(`old website scope prompts deleted: ${deleted}`);

// ── 5. website_prompts 행 삭제 ──────────────────────────────────────────────
await db.delete(websitePrompts).where(eq(websitePrompts.fileSeq, 109));
console.log("website_prompts file_seq=109 rows deleted");

console.log("\ndone. project:", project.id, "| scope:", scopeProj.project_id);
await conn.end();
