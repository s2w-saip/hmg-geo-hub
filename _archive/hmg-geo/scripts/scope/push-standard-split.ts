/**
 * One-shot: push the brand-split standard catalog to the scope root project and
 * deactivate the old combined "Hyundai, Kia, and Genesis ..." prompts.
 *
 * Drives HttpScopeClient DIRECTLY off .env.local (same as verify:scope) — it does
 * NOT go through the session-enforced lib/scope/server.ts. Also touches the hmg
 * DB to repoint each catalog row's scope_prompt_id at its new per-brand prompt.
 *
 *   1. set root project regions = [KR, US, DE]            (updateProject)
 *   2. create the 240 split prompts                       (createPrompt; skip if text exists)
 *      → repoint prompts.scope_prompt_id to the new id
 *   3. deactivate the 80 combined prompts (active=false)  (updatePrompt)
 *
 * Idempotent: re-running skips prompts whose text already exists on scope.
 *
 * DRY-RUN by default (reads only). Pass --apply to mutate the live scope server.
 *   npx tsx --env-file=.env.local scripts/scope/push-standard-split.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/scope/push-standard-split.ts --apply  # live
 */
import postgres from "postgres";
import { HttpScopeClient } from "../../lib/scope/http";
import type { FunnelStage, Prompt } from "../../lib/scope/types";

const APPLY = process.argv.includes("--apply");
const CATALOG_PROJECT = "26751906-c175-485c-9e69-29fc68d0fdbb";
const REGIONS = ["KR", "US", "DE"];
const COMBINED_MARK = "Hyundai, Kia, and Genesis";
const SPLIT_BRANDS = ["Hyundai", "Kia", "Genesis"];

// 퍼널(framework, Korean) → scope FunnelStage enum.
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
  console.error(
    "✗ missing env: " +
      [!base && "SCOPE_API_BASE", !key && "SCOPE_API_KEY", !root && "SCOPE_ROOT_PROJECT_ID", !dbUrl && "DATABASE_URL"]
        .filter(Boolean)
        .join(", "),
  );
  process.exit(2);
}

const client = new HttpScopeClient(base, key);
const sql = postgres(dbUrl, { prepare: false });
import { pageAll, PROMPT_MAX_PAGES } from "../../lib/scope/paging";

// 종전 상한 50(= 5,000)으로 루트 12,012 를 조용히 잘랐다 — 공용 pageAll 로 합침
// (2026-08-30 전수 조사).
async function listAllPrompts(projectId: string): Promise<Prompt[]> {
  const { items } = await pageAll<Prompt>(
    (cursor) => client.listPrompts(projectId, { limit: 100, cursor }),
    { maxPages: PROMPT_MAX_PAGES, label: `push-standard-split prompts(project=${projectId})` },
  );
  return items;
}

async function main() {
  console.log(`\nscope split push → ${base}/api/v1  (root=${root})  mode=${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  // catalog split rows from the hmg DB
  const splitRows = (await sql`
    SELECT id, text, funnel_stage, brand
    FROM prompts
    WHERE project_id = ${CATALOG_PROJECT} AND brand IN ${sql(SPLIT_BRANDS)}
  `) as { id: string; text: string; funnel_stage: string | null; brand: string }[];

  // existing scope prompts (idempotency + combined detection)
  const existing = await listAllPrompts(root!);
  const byText = new Map<string, Prompt>();
  for (const p of existing) byText.set(p.text, p);
  const combined = existing.filter((p) => p.text.includes(COMBINED_MARK));

  const toCreate = splitRows.filter((r) => !byText.has(r.text));
  const alreadyOnScope = splitRows.length - toCreate.length;

  console.log(`catalog split rows:        ${splitRows.length}`);
  console.log(`already on scope (skip):   ${alreadyOnScope}`);
  console.log(`to CREATE on scope:        ${toCreate.length}`);
  console.log(`combined to DEACTIVATE:    ${combined.length}`);
  console.log(`regions to set:            [${REGIONS.join(", ")}]`);
  const unmapped = splitRows.filter((r) => r.funnel_stage && !FUNNEL_MAP[r.funnel_stage]);
  if (unmapped.length) console.warn(`⚠ ${unmapped.length} rows have an unmapped 퍼널 — funnel_stage will be omitted`);

  if (!APPLY) {
    console.log(`\n(dry-run) no changes made. re-run with --apply to push.\n`);
    await sql.end();
    return;
  }

  // 1. regions
  await client.updateProject(root!, { regions: REGIONS });
  console.log(`✓ regions set → [${REGIONS.join(", ")}]`);

  // 2. create + repoint scope_prompt_id
  let created = 0;
  let repointed = 0;
  let failed = 0;
  for (const r of splitRows) {
    try {
      let scopeId = byText.get(r.text)?.prompt_id;
      if (!scopeId) {
        const fs = r.funnel_stage ? FUNNEL_MAP[r.funnel_stage] : undefined;
        const p = await client.createPrompt(root!, { text: r.text, funnel_stage: fs });
        scopeId = p.prompt_id;
        byText.set(r.text, p);
        created++;
      }
      await sql`UPDATE prompts SET scope_prompt_id = ${scopeId}, updated_at = now() WHERE id = ${r.id}`;
      repointed++;
    } catch (e) {
      failed++;
      console.error(`✗ create/repoint failed: ${r.brand} — ${r.text.slice(0, 50)} — ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`✓ created ${created}, repointed ${repointed}/${splitRows.length} (failed ${failed})`);

  // 3. deactivate combined
  let deactivated = 0;
  let deactFail = 0;
  for (const p of combined) {
    try {
      await client.updatePrompt(root!, p.prompt_id, { enabled: false });
      deactivated++;
    } catch (e) {
      deactFail++;
      console.error(`✗ deactivate failed: ${p.text.slice(0, 50)} — ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`✓ deactivated ${deactivated}/${combined.length} combined (failed ${deactFail})`);

  console.log(`\ndone. next: trigger the KR/US/DE query+analysis run on scope, then mirror back.\n`);
  await sql.end();
}

main().catch(async (e) => {
  console.error("unexpected:", e);
  await sql.end();
  process.exit(1);
});
