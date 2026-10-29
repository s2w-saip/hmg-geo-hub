/**
 * 표준 프롬프트 카탈로그 "브랜드 유무"(brand_presence) 적재 — 3사 framework 엑셀 정본.
 *
 *   npx tsx --env-file=.env.local scripts/db/backfill-prompt-brand-presence.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/db/backfill-prompt-brand-presence.ts
 *
 * 기준 컬럼 = `Keyword type` (Brand=branded / Generic=unbranded) — 2026-07-22 결정.
 * 최초 적재는 `brand 유무`(O/X)를 썼으나, 두 컬럼이 Hyundai에서 9건 갈렸다(Tucson/
 * IONIQ 5 등 모델명 포함 프롬프트 — 브랜드명 리터럴은 없어 O/X상 X지만 모델명이
 * 브랜드 키워드라 Keyword type=Brand). 모델명 포함까지 branded로 보는 Keyword type
 * 정의가 정확해 기준을 교체.
 * 프롬프트 텍스트로 매칭한다(엑셀에 scope_prompt_id가 없음). 헤더 행 위치가 파일마다
 * 다르므로(Genesis/Kia r20, Hyundai r22) 헤더를 탐색해서 찾는다.
 *
 * 엑셀에 없는 행(2026-07-22 기준 Hyundai 8행 = "Which EV is known for its …" 4개
 * 프롬프트 × 인지/비교 이중분류)은 문구 자체가 브랜드 무관이므로 unbranded로 확정
 * (사용자 결정 2026-07-22).
 *
 * idempotent — 같은 값을 다시 써도 무해하다. migration 0032 선행 필요.
 */
import fs from "node:fs";
import ExcelJS from "exceljs";
import postgres from "postgres";

const LOCAL_ROOT = process.env.STANDARD_ROOT_PROJECT_ID ?? "26751906-c175-485c-9e69-29fc68d0fdbb";
const DRY = process.argv.includes("--dry-run");

const FILES: Record<string, string> = {
  Genesis: "Genesis-GEO_표준 프롬프트 framework _v1_1_20260702__브랜드 체크.xlsx",
  // 2026-07-27 v1_4로 교체 — apply-hyundai-v14.ts 반영 후 ver3 문구가 정본.
  Hyundai: "Hyundai-GEO_표준 프롬프트 framework _v1_4_20260720.xlsx",
  Kia: "KIA-GEO_표준 프롬프트 framework _v1_1_20260702__브랜드 체크.xlsx",
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

/** 엑셀 한 파일 → Map<정규화 프롬프트 텍스트, 'branded'|'unbranded'> */
async function readFlags(file: string): Promise<Map<string, string>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet("Prompt_List");
  if (!ws) throw new Error(`${file}: Prompt_List 시트 없음`);

  let headerRow = 0, kwCol = -1;
  let textCols: number[] = [];
  ws.eachRow((row, rn) => {
    if (headerRow) return;
    const v = (row.values as unknown[]).slice(1).map(txt);
    const ki = v.findIndex((x) => /Keyword\s*type/i.test(x));
    if (ki >= 0) {
      headerRow = rn;
      kwCol = ki;
      // ver2/ver3 등 프롬프트 문구 컬럼 전부 — 어느 버전 문구로도 매칭되게 (v1_4는
      // ver2·ver3 두 컬럼이 공존, DB에는 ver3가 정본으로 반영돼 있다).
      textCols = v.map((x, i) => (/^프롬프트_/.test(x) ? i : -1)).filter((i) => i >= 0);
    }
  });
  if (!headerRow || kwCol < 0 || textCols.length === 0) {
    throw new Error(`${file}: 헤더('Keyword type' / '프롬프트_')를 찾지 못함`);
  }

  const map = new Map<string, string>();
  ws.eachRow((row, rn) => {
    if (rn <= headerRow) return;
    const v = (row.values as unknown[]).slice(1).map(txt);
    const flag = v[kwCol];
    const val = flag === "Brand" ? "branded" : flag === "Generic" ? "unbranded" : null;
    if (!val) return;
    for (const c of textCols) {
      const t = v[c];
      if (t) map.set(norm(t), val);
    }
  });
  return map;
}

async function main() {
  const flags: Record<string, Map<string, string>> = {};
  for (const [brand, file] of Object.entries(FILES)) {
    if (!fs.existsSync(file)) throw new Error(`엑셀 없음: ${file}`);
    flags[brand] = await readFlags(file);
    console.log(`엑셀 ${brand.padEnd(8)} ${flags[brand].size}행 읽음`);
  }

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const rows = (await sql`
    SELECT id, brand, text, brand_presence FROM prompts
    WHERE project_id = ${LOCAL_ROOT} AND scope_prompt_id IS NOT NULL
  `) as Array<{ id: string; brand: string | null; text: string; brand_presence: string | null }>;

  const plan: Array<{ id: string; to: string }> = [];
  const stat = { branded: 0, unbranded: 0, fallback: 0, noBrand: 0, unchanged: 0 };

  for (const r of rows) {
    const m = r.brand ? flags[r.brand] : undefined;
    if (!m) { stat.noBrand++; continue; } // 카탈로그 brand가 3사 밖 — 건드리지 않음
    let val = m.get(norm(r.text));
    if (!val) {
      // 엑셀 미수록 행 — 문구가 브랜드 무관이라 unbranded 확정(2026-07-22 결정)
      val = "unbranded";
      stat.fallback++;
    }
    if (r.brand_presence === val) { stat.unchanged++; continue; }
    plan.push({ id: r.id, to: val });
    stat[val as "branded" | "unbranded"]++;
  }

  console.log(
    `\n카탈로그 ${rows.length}행 → 변경 ${plan.length}건 ` +
    `(branded ${stat.branded}, unbranded ${stat.unbranded}) | ` +
    `엑셀미수록→unbranded ${stat.fallback} | 이미동일 ${stat.unchanged} | 3사밖 ${stat.noBrand}`,
  );

  if (DRY) {
    console.log("\n--dry-run — DB 변경 없음");
    await sql.end();
    return;
  }
  for (const p of plan) {
    await sql`UPDATE prompts SET brand_presence = ${p.to} WHERE id = ${p.id}::uuid`;
  }
  const after = (await sql`
    SELECT COALESCE(brand_presence, '(null)') v, count(*) n FROM prompts
    WHERE project_id = ${LOCAL_ROOT} AND scope_prompt_id IS NOT NULL GROUP BY 1 ORDER BY n DESC
  `) as Array<{ v: string; n: string }>;
  console.log("적용 후 분포:", after.map((r) => `${r.v}=${r.n}`).join(", "));
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
