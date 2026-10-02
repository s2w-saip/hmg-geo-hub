// 정본 엑셀(HMG-GEO-web_geo_citation-data_v2.5_All_asof20260904_20260906.xlsx → CSV) ↔ 사실표 job 단위 대조.
// 읽기 전용. 실행: bash notes/hmg-db-exec.sh <워크트리> npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-xlsx-v25.ts <csv 디렉토리>
import fs from "node:fs";
import postgres from "postgres";

const DIR = process.argv[2] ?? "notes/hmg-summary-verify/xlsx";
function csv(path: string): string[][] {
  const t = fs.readFileSync(path, "utf8");
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
// 답변별 집계: 유닛,브랜드,국가,사이트,언어,측정일,답변 ID,프롬프트 번호,AI 엔진,인용 수,자사 인용 수,타겟 인용 수,자사 인용 답변(1),타겟 URL 인용 답변(1)
const ans = csv(`${DIR}/answers.csv`).slice(1).filter((r) => r.length >= 14);
type X = { unit: number; job: string; engine: string; cit: number; own: number; tgt: number; ownA: number; tgtA: number };
const xs = new Map<string, X>();
for (const r of ans) xs.set(r[6], { unit: +r[0], job: r[6], engine: r[8], cit: +r[9], own: +r[10], tgt: +r[11], ownA: +r[12], tgtA: +r[13] });
console.log(`xlsx answers ${xs.size} · units ${new Set([...xs.values()].map((x) => x.unit)).size}`);

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: "require" });
type F = { job_id: string; report_fs: number | null; engine: string; all_citations: number; unit_owned: number; unit_target: number; unit_owned_citations: number };
const fs_ = (await sql.unsafe(`
with act as (select cycle_id, active_generation_id gid from summary_cycles where surface='website' and view_anchor_at is not null)
select a.job_id::text job_id, a.report_fs, a.engine, a.all_citations, a.unit_owned, a.unit_target,
       coalesce((select sum(d.unit_owned_citations) from summary_domain_citations d where d.cycle_id=a.cycle_id and d.generation_id=a.generation_id and d.job_id=a.job_id),0)::int unit_owned_citations
from summary_answers a join act on act.cycle_id=a.cycle_id and act.gid=a.generation_id`)) as unknown as F[];
await sql.end();
const fm = new Map(fs_.map((f) => [f.job_id, f]));
console.log(`fact answers ${fm.size} · with report_fs ${fs_.filter((f) => f.report_fs != null).length}`);

let onlyX = 0, onlyF = 0, unitMis = 0, citMis = 0, ownMis = 0, ownAMis = 0, tgtAMis = 0, pass = 0;
const ex: string[] = [];
const perUnit = new Map<number, { n: number; ownCitX: number; ownCitF: number; ownAX: number; ownAF: number; tgtAX: number; tgtAF: number }>();
for (const [job, x] of xs) {
  const f = fm.get(job);
  if (!f) { onlyX++; if (ex.length < 15) ex.push(`onlyX unit ${x.unit} ${job} ${x.engine}`); continue; }
  const u = perUnit.get(x.unit) ?? { n: 0, ownCitX: 0, ownCitF: 0, ownAX: 0, ownAF: 0, tgtAX: 0, tgtAF: 0 };
  u.n++; u.ownCitX += x.own; u.ownCitF += f.unit_owned_citations; u.ownAX += x.ownA; u.ownAF += f.unit_owned; u.tgtAX += x.tgtA; u.tgtAF += f.unit_owned && f.unit_target ? 1 : 0;
  perUnit.set(x.unit, u);
  let bad = false;
  if (f.report_fs !== x.unit) { unitMis++; bad = true; if (ex.length < 15) ex.push(`unit ${job}: fact ${f.report_fs} vs xlsx ${x.unit}`); }
  if (f.all_citations !== x.cit) { citMis++; bad = true; if (ex.length < 15) ex.push(`cit ${job} u${x.unit}: fact ${f.all_citations} vs xlsx ${x.cit}`); }
  if (f.unit_owned_citations !== x.own) { ownMis++; bad = true; if (ex.length < 15) ex.push(`ownCit ${job} u${x.unit}: fact ${f.unit_owned_citations} vs xlsx ${x.own}`); }
  if ((f.unit_owned ? 1 : 0) !== x.ownA) { ownAMis++; bad = true; }
  if (((f.unit_owned && f.unit_target) ? 1 : 0) !== x.tgtA) { tgtAMis++; bad = true; if (ex.length < 15) ex.push(`tgtA ${job} u${x.unit}: fact ${f.unit_owned}&${f.unit_target} vs xlsx ${x.tgtA}`); }
  if (!bad) pass++;
}
for (const [job, f] of fm) if (!xs.has(job) && f.report_fs != null) onlyF++;
console.log(`job-level: pass ${pass} · onlyXlsx ${onlyX} · onlyFact(report_fs≠null) ${onlyF} · unitMismatch ${unitMis} · citCount ${citMis} · ownedCit ${ownMis} · ownedAns ${ownAMis} · targetAns ${tgtAMis}`);
console.log(ex.join("\n"));
const badUnits = [...perUnit.entries()].filter(([, u]) => u.ownCitX !== u.ownCitF || u.ownAX !== u.ownAF || u.tgtAX !== u.tgtAF).sort((a, b) => a[0] - b[0]);
console.log(`unit-level mismatches: ${badUnits.length} / ${perUnit.size}`);
for (const [unit, u] of badUnits) console.log(`  u${unit}: ownCit ${u.ownCitF}≠${u.ownCitX} · ownAns ${u.ownAF}≠${u.ownAX} · tgtAns ${u.tgtAF}≠${u.tgtAX} (n ${u.n})`);

// ── KPI 요약 시트(kpi.csv) 대조 — 유닛 단위 ⑤⑥ 원자료 ────────────────────────
// 열: 유닛,브랜드,국가,사이트,언어,측정 기준일,측정 구간,AI 엔진,프롬프트 수,답변 수,
//     전체 인용 수,자사 인용 수,AI 인용 점유율,자사 인용 답변 수,타겟 URL 인용 답변 수,
//     AI 타겟 출처 인용률,자사 판정 base,타겟 URL 수
const kpiRows = csv(`${DIR}/kpi.csv`).slice(1).filter((r) => r.length >= 18 && r[0]);
const factUnit = new Map<number, { na: number; cit: number; own: number; ownA: number; tgtA: number }>();
for (const f of fs_) {
  if (f.report_fs == null) continue;
  const u = factUnit.get(Number(f.report_fs)) ?? { na: 0, cit: 0, own: 0, ownA: 0, tgtA: 0 };
  u.na++; u.cit += f.all_citations; u.own += f.unit_owned_citations;
  u.ownA += f.unit_owned ? 1 : 0; u.tgtA += f.unit_owned && f.unit_target ? 1 : 0;
  factUnit.set(Number(f.report_fs), u);
}
let kp = 0, kf = 0, km = 0;
const kl: string[] = [];
for (const r of kpiRows) {
  const unit = Number(r[0]);
  const f = factUnit.get(unit);
  if (!f) { km++; kl.push(`✗ u${unit} ${r[1]}/${r[2]}/${r[4]}: 사실표 유닛 없음 (xlsx 답변 ${r[9]})`); continue; }
  const d: string[] = [];
  if (f.na !== Number(r[9])) d.push(`na ${f.na}≠${r[9]}`);
  if (f.cit !== Number(r[10])) d.push(`전체인용 ${f.cit}≠${r[10]}`);
  if (f.own !== Number(r[11])) d.push(`자사인용 ${f.own}≠${r[11]}`);
  if (f.ownA !== Number(r[13])) d.push(`자사답변 ${f.ownA}≠${r[13]}`);
  if (f.tgtA !== Number(r[14])) d.push(`타겟답변 ${f.tgtA}≠${r[14]}`);
  if (d.length) { kf++; kl.push(`✗ u${unit} ${r[1]}/${r[2]}/${r[4]} base=${r[16]}: ${d.join(" · ")}`); }
  else kp++;
}
console.log(`\nKPI 시트 대조: ${kpiRows.length} 유닛 · pass ${kp} · fail ${kf} · 사실표 없음 ${km}`);
if (kl.length) console.log(kl.join("\n"));
