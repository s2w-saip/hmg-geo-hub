/**
 * ACR 대상 규칙 백필 + scope 반영 (2026-07-07 파일럿 기준).
 *
 * 대상 규칙 (결정론적 — 사람 판단 없이 재적용 가능):
 *   ① 표준 루트 카탈로그(prompts.project_id = CATALOG)
 *   ② funnel_stage = '비교/검증' (--funnel 로 확장: 예 --funnel=구매/사후관리)
 *   ③ 중립형 — 텍스트에 자사 브랜드/차종 미포함 (NEUTRAL_EXCLUDE)
 *   ④ 후보군 유도형 — which/recommend/best/top/worth/suggest (CANDIDATE_CUE)
 *
 * ACR은 2턴 × acr_iterations(프로젝트 기본 10)라 프롬프트당 측정량이 ~20배 —
 * 규칙 확장은 비용 결정이므로 dry-run 결과를 보고 실행할 것.
 *
 *   npx tsx --env-file=.env.local scripts/scope/backfill-acr-kind.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/scope/backfill-acr-kind.ts --apply   # 로컬 kind='acr'
 *   npx tsx --env-file=.env.local scripts/scope/backfill-acr-kind.ts --push    # 로컬 kind를 scope에 PATCH (로컬≠scope 전부)
 *
 * --apply 는 로컬 카탈로그만 바꾼다 (측정 비용 無). --push 가 실제로 scope
 * 프롬프트의 kind를 바꿔 다음 측정 주기부터 2턴 ACR이 돈다 (비용 발생 지점).
 */
import postgres from "postgres";
import { pageAll, PROMPT_MAX_PAGES } from "../../lib/scope/paging";
import { HttpScopeClient } from "../../lib/scope/http";
import type { Prompt } from "../../lib/scope/types";

const APPLY = process.argv.includes("--apply");
const PUSH = process.argv.includes("--push");
const FUNNELS = process.argv
  .filter((a) => a.startsWith("--funnel="))
  .map((a) => a.slice("--funnel=".length));
if (FUNNELS.length === 0) FUNNELS.push("비교/검증");

const CATALOG = "26751906-c175-485c-9e69-29fc68d0fdbb";

// 자사(HMG) 브랜드/차종이 텍스트에 박힌 프롬프트는 "하나만 골라"가 성립하지
// 않으므로 제외. 표준 카탈로그의 실제 어휘 기준 (2026-07-07 705행 검수).
const NEUTRAL_EXCLUDE =
  /hyundai|kia|genesis|ioniq|tucson|palisade|sportage|ev9|gv[0-9]|santa fe|sonata|elantra|kona|niro|carnival|telluride|seltos|casper|staria|g[789]0|grandeur|k[0-9]/i;
// 후보군을 유도하는 질문 형태 — 1턴 shortlist가 나와야 2턴 선택이 측정된다.
const CANDIDATE_CUE =
  /^\s*which|recommend|best|top|worth (considering|buying)|suggest/i;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("✗ missing env DATABASE_URL");
  process.exit(2);
}
const sql = postgres(dbUrl, { prepare: false });

async function main() {
  console.log(
    `\nbackfill-acr-kind mode=${PUSH ? "PUSH" : APPLY ? "APPLY(local)" : "DRY-RUN"} funnels=[${FUNNELS.join(", ")}]\n`,
  );

  const rows = (await sql`
    SELECT id, text, funnel_stage, kind, scope_prompt_id
    FROM prompts WHERE project_id = ${CATALOG}
  `) as {
    id: string;
    text: string;
    funnel_stage: string | null;
    kind: string;
    scope_prompt_id: string | null;
  }[];

  const matches = rows.filter(
    (r) =>
      r.funnel_stage != null &&
      FUNNELS.includes(r.funnel_stage) &&
      !NEUTRAL_EXCLUDE.test(r.text) &&
      CANDIDATE_CUE.test(r.text),
  );
  const toFlip = matches.filter((r) => r.kind !== "acr");

  console.log(`catalog rows:        ${rows.length}`);
  console.log(`rule matches:        ${matches.length}`);
  console.log(`to flip → 'acr':     ${toFlip.length} (이미 acr: ${matches.length - toFlip.length})`);
  toFlip.slice(0, 10).forEach((r) => console.log(`   + ${r.text.slice(0, 90)}`));
  if (toFlip.length > 10) console.log(`   … +${toFlip.length - 10}`);

  if (APPLY && toFlip.length) {
    const ids = toFlip.map((r) => r.id);
    await sql`UPDATE prompts SET kind = 'acr', updated_at = now() WHERE id IN ${sql(ids)}`;
    console.log(`✓ local kind='acr' set on ${ids.length} rows`);
  }

  if (PUSH) {
    const base = process.env.SCOPE_API_BASE;
    const key = process.env.SCOPE_API_KEY;
    const root = process.env.SCOPE_ROOT_PROJECT_ID;
    if (!base || !key || !root) {
      console.error("✗ --push needs SCOPE_API_BASE/SCOPE_API_KEY/SCOPE_ROOT_PROJECT_ID");
      process.exit(2);
    }
    const client = new HttpScopeClient(base, key);
    // scope의 현재 kind를 읽어 로컬(정본)과 다른 행만 PATCH — 멱등.
    // 종전 상한 60(= 6,000)으로 루트 12,012 의 절반만 읽고 조용히 끝났다.
    // 뒤쪽 프롬프트의 kind 가 통째로 미비교로 빠졌다는 뜻이다 (2026-08-30 전수 조사).
    const { items: scopePrompts } = await pageAll<Prompt>(
      (cursor) => client.listPrompts(root, { limit: 100, cursor }),
      { maxPages: PROMPT_MAX_PAGES, label: `backfill-acr-kind prompts(project=${root})` },
    );
    const scopeKind = new Map(scopePrompts.map((p) => [p.prompt_id, p.kind ?? "single"]));

    const fresh = (await sql`
      SELECT kind, scope_prompt_id FROM prompts
      WHERE project_id = ${CATALOG} AND scope_prompt_id IS NOT NULL
    `) as { kind: string; scope_prompt_id: string }[];
    const drift = fresh.filter(
      (r) => scopeKind.has(r.scope_prompt_id) && scopeKind.get(r.scope_prompt_id) !== r.kind,
    );
    console.log(`scope drift (local≠scope): ${drift.length}`);
    let patched = 0;
    for (const r of drift) {
      await client.updatePrompt(root, r.scope_prompt_id, {
        kind: r.kind === "acr" ? "acr" : "single",
      });
      patched++;
    }
    console.log(`✓ PATCHed kind on scope: ${patched}`);
  }

  if (!APPLY && !PUSH) console.log(`\n(dry-run) no changes. --apply(로컬) / --push(scope 반영).\n`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
