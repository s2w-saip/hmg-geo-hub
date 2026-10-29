/**
 * Hard-delete the 80 combined "Hyundai, Kia, and Genesis ..." prompts everywhere,
 * with a cascade over their mirrored measurement data.
 *
 *   - scope server: deletePrompt() for each combined prompt (so a later mirror's
 *     upsertPrompts can't resurrect them).
 *   - hmg DB (txn): scope_mentions → scope_citations → scope_answers → scope_prompts
 *     for the combined prompts, in FK-safe order.
 *
 * Safety: aborts if any catalog `prompts` row still links to a combined prompt
 * (would orphan a catalog→measurement link). The split rows were repointed to
 * their own per-brand prompts earlier, so this should be 0.
 *
 * DRY-RUN by default. Pass --apply to actually delete.
 *   npx tsx --env-file=.env.local scripts/scope/delete-combined.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/scope/delete-combined.ts --apply  # live
 */
import postgres from "postgres";
import { HttpScopeClient, ScopeHttpError } from "../../lib/scope/http";

const APPLY = process.argv.includes("--apply");
const COMBINED_MARK = "Hyundai, Kia, and Genesis";
const LIKE = `%${COMBINED_MARK}%`;

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

async function main() {
  console.log(`\ndelete combined → ${base}/api/v1  (root=${root})  mode=${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  const ids = (
    (await sql`SELECT prompt_id FROM scope_prompts WHERE text LIKE ${LIKE}`) as { prompt_id: string }[]
  ).map((r) => r.prompt_id);

  const [c] = (await sql`
    SELECT
      (SELECT count(*) FROM scope_answers WHERE prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE text LIKE ${LIKE})) AS answers,
      (SELECT count(*) FROM scope_mentions WHERE job_id IN (SELECT job_id FROM scope_answers WHERE prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE text LIKE ${LIKE}))) AS mentions,
      (SELECT count(*) FROM scope_citations WHERE job_id IN (SELECT job_id FROM scope_answers WHERE prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE text LIKE ${LIKE}))) AS citations,
      (SELECT count(*) FROM prompts WHERE scope_prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE text LIKE ${LIKE})) AS catalog_refs
  `) as { answers: string; mentions: string; citations: string; catalog_refs: string }[];

  console.log(`combined prompts:   ${ids.length}`);
  console.log(`scope_answers:      ${c.answers}`);
  console.log(`scope_mentions:     ${c.mentions}`);
  console.log(`scope_citations:    ${c.citations}`);
  console.log(`catalog refs (must be 0): ${c.catalog_refs}`);

  if (Number(c.catalog_refs) > 0) {
    console.error(`\n✗ aborting: ${c.catalog_refs} catalog prompts still link to a combined prompt.`);
    await sql.end();
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`\n(dry-run) no changes made. re-run with --apply to delete.\n`);
    await sql.end();
    return;
  }

  // 1. scope server
  let del = 0;
  let gone = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await client.deletePrompt(root!, id);
      del++;
    } catch (e) {
      if (e instanceof ScopeHttpError && e.status === 404) {
        gone++; // already absent on scope
      } else {
        fail++;
        console.error(`✗ scope deletePrompt ${id} — ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.log(`✓ scope: deleted ${del}, already-absent ${gone}, failed ${fail}`);

  // 2. hmg cascade (FK-safe order, single txn)
  await sql.begin(async (tx) => {
    await tx`DELETE FROM scope_mentions WHERE job_id IN (SELECT job_id FROM scope_answers WHERE prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE text LIKE ${LIKE}))`;
    await tx`DELETE FROM scope_citations WHERE job_id IN (SELECT job_id FROM scope_answers WHERE prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE text LIKE ${LIKE}))`;
    await tx`DELETE FROM scope_answers WHERE prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE text LIKE ${LIKE})`;
    await tx`DELETE FROM scope_prompts WHERE text LIKE ${LIKE}`;
  });
  console.log(`✓ hmg cascade deleted (mentions ${c.mentions}, citations ${c.citations}, answers ${c.answers}, prompts ${ids.length})`);

  console.log(`\ndone.\n`);
  await sql.end();
}

main().catch(async (e) => {
  console.error("unexpected:", e);
  await sql.end();
  process.exit(1);
});
