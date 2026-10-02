/**
 * ⚠️ 초기 시드 전용 (2026-08-12 catalog-prompt-audit 이후). 운영 카탈로그의
 * 편집·교체는 /admin/standards/prompts UI(단건·벌크 xlsx)가 정본 경로다 — 이
 * 스크립트는 감사 원장을 남기지 않고 scope 프롬프트를 생성·삭제하므로 운영
 * 사용 금지.
 *
 * Reconcile the scope root project + hmg mirror to the v0.4 catalog (already
 * loaded into the `prompts` table). Makes scope_prompts == the catalog text set:
 *
 *   - CREATE on scope every catalog prompt missing there (the unlinked rows),
 *     then repoint prompts.scope_prompt_id at the new id.
 *   - DELETE from scope every prompt no longer in the catalog (the v0.4 drops),
 *     and CASCADE-delete its mirror data (scope_mentions → citations → answers →
 *     scope_prompts), FK-safe.
 *
 * DRY-RUN by default. Pass --apply to mutate the live scope server + mirror.
 *   npx tsx --env-file=.env.local scripts/scope/reconcile-v04.ts
 *   npx tsx --env-file=.env.local scripts/scope/reconcile-v04.ts --apply
 */
import postgres from "postgres";
import { HttpScopeClient, ScopeHttpError } from "../../lib/scope/http";
import type { FunnelStage, Prompt } from "../../lib/scope/types";

const APPLY = process.argv.includes("--apply");
const CATALOG = "26751906-c175-485c-9e69-29fc68d0fdbb";
const FUNNEL_MAP: Record<string, FunnelStage> = {
  "인지/탐색": "discovery",
  "비교/검증": "evaluation",
  "구매/사후관리": "transactional",
};

const base = process.env.SCOPE_API_BASE;
const key = process.env.SCOPE_API_KEY;
const root = process.env.SCOPE_ROOT_PROJECT_ID;
const dbUrl = process.env.DATABASE_URL;
if (!base || !key || !root || !dbUrl) {
  console.error("✗ missing env (SCOPE_API_BASE/SCOPE_API_KEY/SCOPE_ROOT_PROJECT_ID/DATABASE_URL)");
  process.exit(2);
}
const client = new HttpScopeClient(base, key);
const sql = postgres(dbUrl, { prepare: false });
import { pageAll, PROMPT_MAX_PAGES } from "../../lib/scope/paging";

// 종전 상한 60(= 6,000)으로 루트 12,012 의 절반만 읽고 조용히 끝났다.
// 공용 pageAll 로 합쳐 상한을 PROMPT_MAX_PAGES 로 올리고, 소진 시 PAGE CAP HIT
// 로그가 뜨게 한다 (2026-08-30 전수 조사).
async function listAllPrompts(projectId: string): Promise<Prompt[]> {
  const { items } = await pageAll<Prompt>(
    (cursor) => client.listPrompts(projectId, { limit: 100, cursor }),
    { maxPages: PROMPT_MAX_PAGES, label: `reconcile-v04 prompts(project=${projectId})` },
  );
  return items;
}

async function main() {
  console.log(`\nreconcile v0.4 → ${base}/api/v1 (root=${root}) mode=${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  // desired = catalog text set; toCreate = catalog rows not yet on scope (unlinked)
  const catalogRows = (await sql`
    SELECT id, text, funnel_stage, kind, scope_prompt_id FROM prompts WHERE project_id = ${CATALOG}
  `) as { id: string; text: string; funnel_stage: string | null; kind: string; scope_prompt_id: string | null }[];
  const catalogTexts = new Set(catalogRows.map((r) => r.text));
  const toCreate = catalogRows.filter((r) => !r.scope_prompt_id);

  const existing = await listAllPrompts(root!);
  const toDelete = existing.filter((p) => !catalogTexts.has(p.text));

  // mirror blast radius for the deletions
  const delIds = toDelete.map((p) => p.prompt_id);
  let answers = 0, mentions = 0, citations = 0;
  if (delIds.length) {
    const [c] = (await sql`
      SELECT
        (SELECT count(*) FROM scope_answers WHERE prompt_id IN ${sql(delIds)}) AS answers,
        (SELECT count(*) FROM scope_mentions WHERE job_id IN (SELECT job_id FROM scope_answers WHERE prompt_id IN ${sql(delIds)})) AS mentions,
        (SELECT count(*) FROM scope_citations WHERE job_id IN (SELECT job_id FROM scope_answers WHERE prompt_id IN ${sql(delIds)})) AS citations
    `) as { answers: string; mentions: string; citations: string }[];
    answers = Number(c.answers); mentions = Number(c.mentions); citations = Number(c.citations);
  }

  console.log(`catalog rows:          ${catalogRows.length}`);
  console.log(`scope prompts now:     ${existing.length}`);
  console.log(`to CREATE on scope:    ${toCreate.length}`);
  toCreate.forEach((r) => console.log(`   + ${r.text}`));
  console.log(`to DELETE on scope:    ${toDelete.length}`);
  console.log(`mirror cascade:        answers ${answers}, mentions ${mentions}, citations ${citations}`);

  if (!APPLY) {
    console.log(`\n(dry-run) no changes. re-run with --apply.\n`);
    await sql.end();
    return;
  }

  // 1. create the new catalog prompts on scope + repoint
  let created = 0;
  for (const r of toCreate) {
    const fs = r.funnel_stage ? FUNNEL_MAP[r.funnel_stage] : undefined;
    const p = await client.createPrompt(root!, {
      text: r.text,
      funnel_stage: fs,
      // 카탈로그의 측정 종류(kind)를 함께 실어 ACR 프롬프트가 재생성돼도 유지.
      kind: r.kind === "acr" ? "acr" : "single",
    });
    await sql`UPDATE prompts SET scope_prompt_id = ${p.prompt_id}, updated_at = now() WHERE id = ${r.id}`;
    created++;
  }
  console.log(`✓ created ${created} on scope (+ repointed)`);

  // 2. delete dropped prompts on scope
  let del = 0, gone = 0, fail = 0;
  for (const p of toDelete) {
    try {
      await client.deletePrompt(root!, p.prompt_id);
      del++;
    } catch (e) {
      if (e instanceof ScopeHttpError && e.status === 404) gone++;
      else { fail++; console.error(`✗ delete ${p.prompt_id} — ${e instanceof Error ? e.message : e}`); }
    }
  }
  console.log(`✓ scope: deleted ${del}, already-absent ${gone}, failed ${fail}`);

  // 3. mirror cascade (FK-safe), only for the deleted ids
  if (delIds.length) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM scope_mentions WHERE job_id IN (SELECT job_id FROM scope_answers WHERE prompt_id IN ${tx(delIds)})`;
      await tx`DELETE FROM scope_citations WHERE job_id IN (SELECT job_id FROM scope_answers WHERE prompt_id IN ${tx(delIds)})`;
      await tx`DELETE FROM scope_answers WHERE prompt_id IN ${tx(delIds)}`;
      await tx`DELETE FROM scope_prompts WHERE prompt_id IN ${tx(delIds)}`;
    });
    console.log(`✓ mirror cascade deleted (mentions ${mentions}, citations ${citations}, answers ${answers}, prompts ${delIds.length})`);
  }

  console.log(`\ndone. next: re-measure the ${created} new prompt(s) on scope (KR/US/DE), then re-mirror.\n`);
  await sql.end();
}

main().catch(async (e) => {
  console.error("unexpected:", e);
  await sql.end();
  process.exit(1);
});
