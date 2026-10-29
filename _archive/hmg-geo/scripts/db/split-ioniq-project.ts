/**
 * IONIQ(Strategic Model) 프롬프트를 표준(글로벌)에서 분리 → 전용 프로젝트로 이관.
 * (이노션 요청 2026-07-27: "글로벌에서 아이오닉 프롬프트를 빼서 프로젝트 대시보드로",
 *  라벨 기준 = list_type 'Strategic Model', ShortList만)
 *
 *   npx tsx --env-file=.env.local scripts/db/split-ioniq-project.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/db/split-ioniq-project.ts --apply    # live
 *
 * 대상: root 카탈로그의 brand='Hyundai' AND list_type='Strategic Model' (88행 =
 * single 84 + acr 4; 'ioniq' 텍스트 미포함 EV 일반 문구 28건도 라벨 기준으로 포함).
 *
 * 절차 (사용자 결정 2026-07-28: 지역=루트와 동일 6개국, 기존 이력=보존):
 *  1. scope에 전용 프로젝트 CREATE — 루트의 tracked_brands/regions 복제.
 *     (재실행 시 동명 프로젝트가 있으면 재사용 — idempotent)
 *  2. 88개 프롬프트를 새 scope 프로젝트에 CREATE (funnel/kind 유지).
 *  3. 로컬 projects에 프로젝트 행 INSERT (brand=Hyundai, country='KR' 대표값,
 *     scope_project_id 연결 → mirror sync가 자동 편입) + admin owner 멤버십.
 *  4. 로컬 prompts 88행을 새 프로젝트로 이동(project_id·scope_prompt_id 재지정,
 *     taxonomy/brand_presence/kind 유지). 표준 카탈로그 296→208행 — 표준 화면은
 *     카탈로그 게이트가 자동 제외.
 *  5. scope 루트의 기존 88개 프롬프트 deactivate(active=false) — 측정만 중단,
 *     미러 이력 보존(복구 가능).
 *  6. scope_prompts 미러에 새 prompt_id upsert(조인 공백 방지).
 *
 * 측정 편입: scope가 새 프로젝트의 active 프롬프트를 주기 측정 → mirror sync가
 * scope_project_id 연결 프로젝트를 자동 수집 → 프로젝트 대시보드(KPI/언급/인용/ACR)
 * 에 표시. 기존 84건의 표준 루트 측정 이력은 프로젝트로 이관되지 않는다(다른
 * 프로젝트 소속 run) — 새 프로젝트는 이력 0에서 시작.
 */
import postgres from "postgres";
import { pageAll, PROMPT_MAX_PAGES } from "../../lib/scope/paging";
import { HttpScopeClient } from "../../lib/scope/http";
import type { FunnelStage, Paginated, Project, Prompt } from "../../lib/scope/types";

const APPLY = process.argv.includes("--apply");
const LOCAL_ROOT = process.env.STANDARD_ROOT_PROJECT_ID ?? "26751906-c175-485c-9e69-29fc68d0fdbb";
const SCOPE_ROOT = process.env.SCOPE_ROOT_PROJECT_ID;
const PROJECT_NAME = "Hyundai IONIQ (Strategic Model)";
const FUNNEL_MAP: Record<string, FunnelStage> = {
  "인지/탐색": "discovery",
  "비교/검증": "evaluation",
  "구매/사후관리": "transactional",
};

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const rows = (await sql`
    SELECT id, text, kind, funnel_stage, scope_prompt_id, created_by
    FROM prompts
    WHERE project_id = ${LOCAL_ROOT} AND brand = 'Hyundai'
      AND list_type = 'Strategic Model' AND scope_prompt_id IS NOT NULL
    ORDER BY text
  `) as Array<{ id: string; text: string; kind: string; funnel_stage: string | null; scope_prompt_id: string; created_by: string }>;
  console.log(`분리 대상: ${rows.length}행 (acr ${rows.filter((r) => r.kind === "acr").length})`);

  if (!APPLY) {
    for (const r of rows.slice(0, 6)) console.log(`  · [${r.kind}|${r.funnel_stage}] ${r.text.slice(0, 65)}`);
    console.log(`  … 외 ${Math.max(0, rows.length - 6)}건`);
    console.log("\n(dry-run) 변경 없음 — --apply로 실행");
    await sql.end();
    return;
  }

  const base = process.env.SCOPE_API_BASE, key = process.env.SCOPE_API_KEY;
  if (!base || !key || !SCOPE_ROOT) throw new Error("SCOPE_API_BASE/SCOPE_API_KEY/SCOPE_ROOT_PROJECT_ID 필요");
  const client = new HttpScopeClient(base, key);

  // 1) scope 프로젝트 확보 (동명 재사용 — idempotent)
  let scopeProject: Project | undefined;
  {
    let cursor: string | undefined;
    do {
      const page: Paginated<Project> = await client.listProjects({ limit: 100, cursor });
      scopeProject = page.data.find((p) => p.name === PROJECT_NAME) ?? scopeProject;
      if (!page.next_cursor) break;
      cursor = page.next_cursor ?? undefined;
    } while (cursor && !scopeProject);
  }
  if (!scopeProject) {
    const root = await client.getProject(SCOPE_ROOT);
    scopeProject = await client.createProject({
      name: PROJECT_NAME,
      domain: "hyundai.com",
      tracked_brands: root.tracked_brands?.length ? root.tracked_brands : [{ brand_name: "Hyundai" }],
      regions: root.regions?.length ? root.regions : ["US", "KR", "DE", "AE", "BR", "EG"],
    });
    console.log(`scope 프로젝트 생성: ${scopeProject.project_id}`);
  } else {
    console.log(`scope 프로젝트 재사용: ${scopeProject.project_id}`);
  }
  const spid = scopeProject.project_id;

  // 새 프로젝트의 기존 프롬프트(재실행 대비) — 텍스트로 재사용.
  // 종전에는 상한 없는 do…while 이었다. 절단은 아니었지만 프롬프트 페이징을
  // 공용 헬퍼 밖에 남겨두면 다음 사람이 복사하므로 합친다 (2026-08-30 전수 조사).
  const { items: existing } = await pageAll<Prompt>(
    (cursor) => client.listPrompts(spid, { limit: 100, cursor }),
    { maxPages: PROMPT_MAX_PAGES, label: `split-ioniq prompts(project=${spid})` },
  );
  const byText = new Map(existing.map((p) => [p.text.trim().toLowerCase(), p]));

  // 2) 로컬 프로젝트 확보 (scope_project_id로 idempotent)
  let [local] = (await sql`SELECT id FROM projects WHERE scope_project_id = ${spid}`) as Array<{ id: string }>;
  if (!local) {
    const creator = rows[0]?.created_by;
    [local] = (await sql`
      INSERT INTO projects (name, description, brand, country, scope_project_id, created_by)
      VALUES (${PROJECT_NAME}, ${"표준 Strategic Model(IONIQ) 분리 프로젝트 — 2026-07-28 이관"},
              'Hyundai', 'KR', ${spid}, ${creator})
      RETURNING id
    `) as Array<{ id: string }>;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, status, invited_by)
      VALUES (${local.id}, ${creator}, 'owner', 'active', ${creator})
      ON CONFLICT DO NOTHING`;
    console.log(`로컬 프로젝트 생성: ${local.id} (owner=${creator})`);
  } else {
    console.log(`로컬 프로젝트 재사용: ${local.id}`);
  }

  // 3) 프롬프트 이관: scope CREATE(재사용) → 로컬 행 이동 → 루트 쪽 deactivate
  let created = 0, moved = 0, deactivated = 0;
  for (const r of rows) {
    let p = byText.get(r.text.trim().toLowerCase());
    if (!p) {
      p = await client.createPrompt(spid, {
        text: r.text,
        funnel_stage: r.funnel_stage ? FUNNEL_MAP[r.funnel_stage] : undefined,
        kind: r.kind === "acr" ? "acr" : "single",
      });
      byText.set(r.text.trim().toLowerCase(), p);
      created++;
    }
    await sql`INSERT INTO scope_prompts (prompt_id, text, funnel_stage)
      VALUES (${p.prompt_id}, ${r.text}, ${r.funnel_stage ? FUNNEL_MAP[r.funnel_stage] : null})
      ON CONFLICT (prompt_id) DO UPDATE SET text = EXCLUDED.text`;
    const oldScopeId = r.scope_prompt_id;
    await sql`UPDATE prompts SET project_id = ${local.id}, scope_prompt_id = ${p.prompt_id}, updated_at = now()
      WHERE id = ${r.id}::uuid`;
    moved++;
    if (oldScopeId !== p.prompt_id) {
      await client.updatePrompt(SCOPE_ROOT, oldScopeId, { enabled: false });
      deactivated++;
    }
  }

  const after = (await sql`
    SELECT
      (SELECT count(*) FROM prompts WHERE project_id = ${LOCAL_ROOT} AND brand='Hyundai' AND scope_prompt_id IS NOT NULL) AS root_hyundai,
      (SELECT count(*) FROM prompts WHERE project_id = ${local!.id} AND scope_prompt_id IS NOT NULL) AS ioniq
  `) as Array<{ root_hyundai: string; ioniq: string }>;
  console.log(`\n적용 완료: scope CREATE ${created} | 이동 ${moved} | 루트 deactivate ${deactivated}`);
  console.log(`표준 Hyundai 카탈로그: ${after[0].root_hyundai}행 | IONIQ 프로젝트: ${after[0].ioniq}행`);
  console.log(`scope_project_id=${spid} — mirror sync가 자동 편입, 다음 측정 run부터 프로젝트 대시보드 표시`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
