/**
 * Hyundai 표준 프롬프트 카탈로그 v1_4 반영 + scope 편입 (2026-07-27).
 *
 *   npx tsx --env-file=.env.local scripts/db/apply-hyundai-v14.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/db/apply-hyundai-v14.ts --apply    # live
 *
 * 정본: "Hyundai-GEO_표준 프롬프트 framework _v1_4_20260720.xlsx" Prompt_List
 * (헤더 r22, ShortList 여부=O 292행). 최종 문구 = `ver 3`(col8, 없으면 ver 2).
 *
 * 정책 (사용자 결정 2026-07-27):
 *  - 개정(v2→v3) 행: scope에 새 문구 CREATE + 카탈로그 행의 scope_prompt_id 재지정,
 *    옛 scope 프롬프트는 deactivate(active=false) — 문구가 달라졌으니 측정 시계열을
 *    분리한다. 옛 문구의 미러 이력은 보존(카탈로그 게이트가 화면에서 자동 제외).
 *  - v1_4 ShortList에서 빠진 행: 로컬 카탈로그에서 삭제 + scope deactivate.
 *    미러 이력 보존(복구 가능).
 *  - 신규 행: 로컬 INSERT + scope CREATE + 링크.
 *  - 문구 동일 행도 taxonomy(listType/depth1-3/funnel)·brand_presence(Keyword type)
 *    드리프트가 있으면 로컬만 갱신.
 *  - 새 scope 프롬프트는 scope_prompts 미러에도 즉시 upsert(다음 sync 전 조인 공백 방지).
 *
 * 측정 편입: scope 루트는 등록된 active 프롬프트를 주기적으로 측정하므로 CREATE만
 * 되면 다음 run부터 자동 포함된다(측정 트리거는 scope 내부 전용 — 수동 트리거 불가).
 *
 * idempotent: scope CREATE는 기존 동일 텍스트가 있으면 재사용, 로컬은 값 비교 후
 * 변경분만. 재실행 시 변경 0건이어야 한다.
 */
import fs from "node:fs";
import ExcelJS from "exceljs";
import postgres from "postgres";
import { pageAll, PROMPT_MAX_PAGES } from "../../lib/scope/paging";
import { HttpScopeClient } from "../../lib/scope/http";
import type { FunnelStage, Prompt } from "../../lib/scope/types";

const APPLY = process.argv.includes("--apply");
const FILE = "Hyundai-GEO_표준 프롬프트 framework _v1_4_20260720.xlsx";
const LOCAL_ROOT = process.env.STANDARD_ROOT_PROJECT_ID ?? "26751906-c175-485c-9e69-29fc68d0fdbb";
const SCOPE_ROOT = process.env.SCOPE_ROOT_PROJECT_ID;
const FUNNEL_MAP: Record<string, FunnelStage> = {
  "인지/탐색": "discovery",
  "비교/검증": "evaluation",
  "구매/사후관리": "transactional",
};

const txt = (v: unknown): string => {
  if (v == null) return "";
  const o = v as { richText?: { text: string }[]; text?: string; result?: unknown };
  if (o.richText) return o.richText.map((t) => t.text).join("");
  if (o.text !== undefined) return String(o.text);
  if (o.result !== undefined) return String(o.result);
  return String(v);
};
const norm = (s: string) => s.trim().toLowerCase();

interface XRow {
  final: string; // ver3 있으면 ver3, 없으면 ver2 (트림)
  old: string;   // ver2 (트림) — 개정 매칭용
  presence: "branded" | "unbranded" | null;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  funnel: string | null; // "1. 인지/탐색" → "인지/탐색" (DB canonical)
}

async function readV14(): Promise<XRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.getWorksheet("Prompt_List");
  if (!ws) throw new Error("Prompt_List 시트 없음");
  let hr = 0;
  const col: Record<string, number> = {};
  ws.eachRow((row, rn) => {
    if (hr) return;
    const v = Array.from(row.values as unknown[], txt).slice(1);
    const ki = v.findIndex((x) => /Keyword\s*type/i.test(x));
    if (ki < 0) return;
    hr = rn;
    col.kw = ki;
    col.listType = v.findIndex((x) => /List\s*Type/i.test(x));
    col.d1 = v.findIndex((x) => /Depth\s*1/i.test(x));
    col.d2 = v.findIndex((x) => /^Depth\s*2$/i.test(x.trim()));
    col.d3 = v.findIndex((x) => /^Depth\s*3$/i.test(x.trim()));
    col.funnel = v.findIndex((x) => /^퍼널$/.test(x.trim()));
    col.v2 = v.findIndex((x) => /^프롬프트_.*ver\s*2/i.test(x));
    col.v3 = v.findIndex((x) => /^프롬프트_.*ver\s*3/i.test(x));
    col.short = v.findIndex((x) => /ShortList/i.test(x));
  });
  if (!hr || col.v3 < 0 || col.short < 0) throw new Error("헤더(ver 3 / ShortList) 탐색 실패");
  const rows: XRow[] = [];
  ws.eachRow((row, rn) => {
    if (rn <= hr) return;
    const v = Array.from(row.values as unknown[], txt).slice(1);
    if (v[col.short]?.trim() !== "O") return;
    const v2 = v[col.v2]?.trim() ?? "";
    const v3 = v[col.v3]?.trim() ?? "";
    const final = v3 || v2;
    if (!final) return;
    const kw = v[col.kw]?.trim();
    const clean = (s?: string) => {
      const t = (s ?? "").trim();
      return t && t !== "-" ? t : null;
    };
    rows.push({
      final,
      old: v2,
      presence: kw === "Brand" ? "branded" : kw === "Generic" ? "unbranded" : null,
      listType: clean(v[col.listType]),
      depth1: clean(v[col.d1]),
      depth2: clean(v[col.d2]),
      // depth3 "-"는 기존 카탈로그가 "-" 문자열로 저장하는 관례(72건) — 유지한다.
      depth3: (v[col.d3]?.trim() || null),
      funnel: clean(v[col.funnel])?.replace(/^\d+\.\s*/, "") ?? null,
    });
  });
  return rows;
}

// 이쪽은 절단이 아니라 **무상한** 루프였다(do…while). 결함의 방향은 반대지만
// 프롬프트 페이징이 헬퍼 밖에 남아 있으면 다음 사람이 그걸 복사하므로 함께 합친다
// — 천장이 생기고, 걸리면 PAGE CAP HIT 로 드러난다 (2026-08-30 전수 조사).
async function listAllScopePrompts(client: HttpScopeClient, projectId: string): Promise<Prompt[]> {
  const { items } = await pageAll<Prompt>(
    (cursor) => client.listPrompts(projectId, { limit: 100, cursor }),
    { maxPages: PROMPT_MAX_PAGES, label: `apply-hyundai-v14 prompts(project=${projectId})` },
  );
  return items;
}

async function main() {
  if (!fs.existsSync(FILE)) throw new Error(`엑셀 없음: ${FILE}`);
  const xrows = await readV14();
  console.log(`v1_4 ShortList: ${xrows.length}행`);

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = (await sql`
    SELECT id, text, kind, brand_presence, list_type, depth1, depth2, depth3, funnel_stage,
           scope_prompt_id, created_by
    FROM prompts
    WHERE project_id = ${LOCAL_ROOT} AND brand = 'Hyundai' AND scope_prompt_id IS NOT NULL
  `) as Array<{
    id: string; text: string; kind: string; brand_presence: string | null;
    list_type: string | null; depth1: string | null; depth2: string | null;
    depth3: string | null; funnel_stage: string | null;
    scope_prompt_id: string; created_by: string;
  }>;
  const byText = new Map(db.map((r) => [norm(r.text), r]));
  const finalSet = new Set(xrows.map((x) => norm(x.final)));

  type Plan = {
    revise: Array<{ row: (typeof db)[number]; x: XRow }>;   // 문구 개정: scope 새 등록 + 옛 deactivate + 로컬 UPDATE
    metaOnly: Array<{ row: (typeof db)[number]; x: XRow }>; // 문구 동일, taxonomy/presence만 갱신
    insert: XRow[];                                          // 순수 신규
    drop: Array<(typeof db)[number]>;                        // v1_4에서 빠짐: scope deactivate + 로컬 DELETE
  };
  const plan: Plan = { revise: [], metaOnly: [], insert: [], drop: [] };

  const claimed = new Set<string>(); // 로컬 행 id — 한 행이 두 번 잡히지 않게
  for (const x of xrows) {
    const cur = byText.get(norm(x.final));
    if (cur && !claimed.has(cur.id)) {
      claimed.add(cur.id);
      const meta =
        (x.listType ?? "") !== (cur.list_type ?? "") ||
        (x.depth1 ?? "") !== (cur.depth1 ?? "") ||
        (x.depth2 ?? "") !== (cur.depth2 ?? "") ||
        (x.depth3 ?? "") !== (cur.depth3 ?? "") ||
        (x.funnel ?? "") !== (cur.funnel_stage ?? "") ||
        (x.presence ?? "") !== (cur.brand_presence ?? "");
      if (meta) plan.metaOnly.push({ row: cur, x });
      continue; // 이미 최신 문구
    }
    const old = x.old ? byText.get(norm(x.old)) : undefined;
    if (old && !claimed.has(old.id)) {
      claimed.add(old.id);
      plan.revise.push({ row: old, x });
    } else {
      plan.insert.push(x);
    }
  }
  for (const r of db) {
    if (!claimed.has(r.id) && !finalSet.has(norm(r.text))) plan.drop.push(r);
  }

  console.log(
    `계획: 문구개정 ${plan.revise.length} | 메타만 갱신 ${plan.metaOnly.length} | ` +
    `신규 ${plan.insert.length} | 제외 ${plan.drop.length} (ACR 제외 ${plan.drop.filter((r) => r.kind === "acr").length})`,
  );
  for (const x of plan.insert) console.log(`  + [신규] ${x.final.slice(0, 70)}`);
  for (const r of plan.drop.slice(0, 8)) console.log(`  - [제외|${r.kind}] ${r.text.slice(0, 70)}`);
  if (plan.drop.length > 8) console.log(`  … 제외 ${plan.drop.length - 8}건 더`);

  if (!APPLY) {
    console.log("\n(dry-run) 변경 없음 — --apply로 실행");
    await sql.end();
    return;
  }

  // ── scope 클라이언트 (HttpScopeClient 직접 — verify:scope와 동일 계약) ──
  const base = process.env.SCOPE_API_BASE, key = process.env.SCOPE_API_KEY;
  if (!base || !key || !SCOPE_ROOT) throw new Error("SCOPE_API_BASE/SCOPE_API_KEY/SCOPE_ROOT_PROJECT_ID 필요");
  const client = new HttpScopeClient(base, key);
  const existing = await listAllScopePrompts(client, SCOPE_ROOT);
  const scopeByText = new Map(existing.map((p) => [norm(p.text), p]));

  // 새 문구를 scope에 확보(있으면 재사용) → prompt_id 반환
  async function ensureScopePrompt(x: XRow, kind: string): Promise<string> {
    const hit = scopeByText.get(norm(x.final));
    if (hit) return hit.prompt_id;
    const created = await client.createPrompt(SCOPE_ROOT!, {
      text: x.final,
      funnel_stage: x.funnel ? FUNNEL_MAP[x.funnel] : undefined,
      kind: kind === "acr" ? "acr" : "single",
    });
    scopeByText.set(norm(x.final), created);
    // 미러 즉시 upsert — 다음 sync 전 조인 공백 방지
    await sql`INSERT INTO scope_prompts (prompt_id, text, funnel_stage)
      VALUES (${created.prompt_id}, ${x.final}, ${x.funnel ? FUNNEL_MAP[x.funnel] : null})
      ON CONFLICT (prompt_id) DO UPDATE SET text = EXCLUDED.text`;
    return created.prompt_id;
  }

  const metaSet = (x: XRow) => sql`
    brand_presence = ${x.presence}, list_type = ${x.listType}, depth1 = ${x.depth1},
    depth2 = ${x.depth2}, depth3 = ${x.depth3}, funnel_stage = ${x.funnel}, updated_at = now()`;

  // 1) 문구 개정 — 새 scope 프롬프트 확보 → 로컬 UPDATE(문구+메타+링크) → 옛 scope deactivate
  let deactivated = 0, createdCnt = 0;
  for (const { row, x } of plan.revise) {
    const beforeSize = scopeByText.size;
    const newId = await ensureScopePrompt(x, row.kind);
    if (scopeByText.size > beforeSize) createdCnt++;
    await sql`UPDATE prompts SET text = ${x.final}, scope_prompt_id = ${newId}, ${metaSet(x)} WHERE id = ${row.id}::uuid`;
    if (row.scope_prompt_id !== newId) {
      await client.updatePrompt(SCOPE_ROOT, row.scope_prompt_id, { enabled: false });
      deactivated++;
    }
  }
  // 2) 메타만 갱신
  for (const { row, x } of plan.metaOnly) {
    await sql`UPDATE prompts SET ${metaSet(x)} WHERE id = ${row.id}::uuid`;
  }
  // 3) 신규 — scope 확보 → 로컬 INSERT
  const creator = db[0]?.created_by;
  for (const x of plan.insert) {
    const beforeSize = scopeByText.size;
    const newId = await ensureScopePrompt(x, "single");
    if (scopeByText.size > beforeSize) createdCnt++;
    await sql`INSERT INTO prompts (project_id, text, status, category, brand, brand_presence,
        list_type, depth1, depth2, depth3, funnel_stage, kind, scope_prompt_id, created_by)
      VALUES (${LOCAL_ROOT}, ${x.final}, 'draft', 'Brand', 'Hyundai', ${x.presence},
        ${x.listType}, ${x.depth1}, ${x.depth2}, ${x.depth3}, ${x.funnel}, 'single', ${newId}, ${creator})`;
  }
  // 4) 제외 — scope deactivate → 로컬 DELETE (미러 이력 보존)
  for (const r of plan.drop) {
    await client.updatePrompt(SCOPE_ROOT, r.scope_prompt_id, { enabled: false });
    deactivated++;
    await sql`DELETE FROM prompts WHERE id = ${r.id}::uuid`;
  }

  const after = (await sql`
    SELECT count(*) n, count(*) FILTER (WHERE kind='acr') acr FROM prompts
    WHERE project_id = ${LOCAL_ROOT} AND brand = 'Hyundai' AND scope_prompt_id IS NOT NULL
  `) as Array<{ n: string; acr: string }>;
  console.log(`\n적용 완료: scope CREATE ${createdCnt} | deactivate ${deactivated}`);
  console.log(`Hyundai 카탈로그: ${after[0].n}행 (ACR ${after[0].acr}) — 새 프롬프트는 다음 측정 run부터 자동 편입`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
