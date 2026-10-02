// 보고서 v2.4(HMG-GEO-web_geo_status_report_v2.4_*_20260906.html, sb-data JSON)
// ↔ 사실표 9/4 회차 **유닛 플래그** 대조. 읽기 전용.
//
//   bash notes/hmg-db-exec.sh <워크트리> \
//     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-report-v24.ts [보고서 경로]
//
// 유닛 = summary_answers.report_fs (= 보고서 u = website_prompts.file_seq, 0060).
// 산식(전부 저장된 플래그만 쓴다 — 조회 시 규칙 재현 없음):
//   na  = 유닛 답변 수                        np = 유닛 프롬프트 수(dim)
//   c5  = [Σ unit_owned_citations, Σ all_citations]
//   c6  = [Σ(unit_owned ∧ unit_target),  Σ unit_owned]      ← unit_target 은 flat(유닛 타겟 집합)
//   cs  = [Σ unit_owned, Σ monitored]
import fs from "node:fs";
import postgres from "postgres";

const args = process.argv.slice(2);
const REPORT =
  args.find((a) => a.endsWith(".html")) ??
  "~/workspace/HMG-GEO-web_geo_status_report_v2.4_Global_20260906.html";
// 추출기 산출 JSON(scripts/reports/extract-citation-data.mts 의 out) — 있으면 **정본 대조**를
// 함께 돈다. 보고서 HTML 은 9/6 시점 산출물이라 그 이후 데이터/규칙 변화를 반영하지 않는다.
const EXTRACT = args.find((a) => a.endsWith(".json"));
const html = fs.readFileSync(REPORT, "utf8");
const m = html.match(/<script[^>]*id="sb-data"[^>]*>([\s\S]*?)<\/script>/);
if (!m) throw new Error("sb-data not found");
const db = JSON.parse(m[1]) as {
  sites: Array<{
    u: string; c: string; l: string; b: string; na: number; np: number;
    k5: number; k6: number; c5: [number, number]; c6: [number, number]; cs: [number, number];
  }>;
  bench: { g5: number; g6: number; n: number };
};

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
type Row = {
  report_fs: number; na: number; np: number; all_cit: number;
  owned_cit: number; owned_ans: number; target_ans: number; monitored: number;
};
const rows = (await sql.unsafe(`
WITH act AS (
  SELECT cycle_id, active_generation_id AS gid FROM summary_cycles
  WHERE surface = 'website' AND cycle_anchor_at = '2026-09-04T00:00:00Z'
    AND status = 'published' AND active_generation_id IS NOT NULL
),
a AS (
  SELECT x.job_id, x.prompt_id, x.report_fs, x.all_citations, x.monitored, x.unit_owned, x.unit_target
  FROM summary_answers x JOIN act ON act.cycle_id = x.cycle_id AND act.gid = x.generation_id
  WHERE x.report_fs IS NOT NULL
),
dc AS (
  SELECT d.job_id, sum(d.unit_owned_citations)::int AS uoc
  FROM summary_domain_citations d JOIN act ON act.cycle_id = d.cycle_id AND act.gid = d.generation_id
  JOIN a ON a.job_id = d.job_id
  GROUP BY 1
),
np AS (
  SELECT p.report_fs, count(*)::int AS np
  FROM summary_prompt_dim p JOIN act ON act.cycle_id = p.cycle_id AND act.gid = p.generation_id
  WHERE p.report_fs IS NOT NULL GROUP BY 1
)
SELECT a.report_fs::int,
  count(*)::int AS na,
  max(np.np)::int AS np,
  sum(a.all_citations)::int AS all_cit,
  COALESCE(sum(dc.uoc), 0)::int AS owned_cit,
  count(*) FILTER (WHERE a.unit_owned = 1)::int AS owned_ans,
  count(*) FILTER (WHERE a.unit_owned = 1 AND a.unit_target = 1)::int AS target_ans,
  sum(a.monitored)::int AS monitored
FROM a LEFT JOIN dc ON dc.job_id = a.job_id LEFT JOIN np ON np.report_fs = a.report_fs
GROUP BY 1 ORDER BY 1`)) as unknown as Row[];
await sql.end();

const byU = new Map(rows.map((r) => [Number(r.report_fs), r]));
const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
let pass = 0, fail = 0, missing = 0;
const lines: string[] = [];
let n5 = 0, d5 = 0, n6 = 0, d6 = 0, r5n = 0, r5d = 0, r6n = 0, r6d = 0;
for (const s of db.sites) {
  const u = Number(s.u);
  const r = byU.get(u);
  if (!r) { missing++; lines.push(`✗ ${s.u} ${s.b}/${s.c}/${s.l}: 사실표 없음 (report na=${s.na})`); continue; }
  const diffs: string[] = [];
  if (r.na !== s.na) diffs.push(`na ${r.na}≠${s.na}`);
  if (r.np !== s.np) diffs.push(`np ${r.np}≠${s.np}`);
  if (r.all_cit !== s.c5[1]) diffs.push(`allCit ${r.all_cit}≠${s.c5[1]}`);
  if (r.owned_cit !== s.c5[0]) diffs.push(`ownedCit ${r.owned_cit}≠${s.c5[0]}`);
  if (r.owned_ans !== s.c6[1]) diffs.push(`ownedAns ${r.owned_ans}≠${s.c6[1]}`);
  if (r.target_ans !== s.c6[0]) diffs.push(`targetAns ${r.target_ans}≠${s.c6[0]}`);
  if (r.owned_ans !== s.cs[0]) diffs.push(`cs0 ${r.owned_ans}≠${s.cs[0]}`);
  if (r.monitored !== s.cs[1]) diffs.push(`cs1 ${r.monitored}≠${s.cs[1]}`);
  n5 += r.owned_cit; d5 += r.all_cit; n6 += r.target_ans; d6 += r.owned_ans;
  r5n += s.c5[0]; r5d += s.c5[1]; r6n += s.c6[0]; r6d += s.c6[1];
  if (diffs.length) {
    fail++;
    lines.push(`✗ ${s.u} ${s.b}/${s.c}/${s.l}: ${diffs.join(" · ")}` +
      `  [k5 ${pct(r.owned_cit, r.all_cit)} vs ${s.k5} | k6 ${pct(r.target_ans, r.owned_ans)} vs ${s.k6}]`);
  } else pass++;
}
console.log(`report sites ${db.sites.length} · pass ${pass} · fail ${fail} · missing ${missing}`);
console.log(`bench(report, n=${db.bench.n}): g5 ${db.bench.g5} g6 ${db.bench.g6}`);
console.log(`pooled(fact):        g5 ${(100 * n5 / d5).toFixed(2)} (${n5}/${d5})  g6 ${(100 * n6 / d6).toFixed(2)} (${n6}/${d6})`);
console.log(`pooled(report rows): g5 ${(100 * r5n / r5d).toFixed(2)} (${r5n}/${r5d})  g6 ${(100 * r6n / r6d).toFixed(2)} (${r6n}/${r6d})`);
if (lines.length) console.log(lines.join("\n"));

// ── 정본 대조: 추출기(scripts/reports/extract-citation-data.mts) 직접 산출과 ────
if (EXTRACT) {
  const out = JSON.parse(fs.readFileSync(EXTRACT, "utf8")) as Array<{
    brand: string; cc: string; lang: string; fs: number; base: string;
    summary: { answers: number | string; mp: number | string; tc: number | string; oc: number | string; oa: number | string };
    prompts: Array<{ owned_answers: number | string; target_hit: boolean }>;
  }>;
  const specRows = JSON.parse(
    fs.readFileSync("scripts/reports/report-spec.json", "utf8"),
  ) as Array<{ brand: string; cc: string; langCode?: string; fs: number }>;
  if (out.length !== specRows.length) {
    console.log(`\n⚠️ 추출기 산출 ${out.length} ≠ spec ${specRows.length} — 인덱스 정렬 불가, 정본 대조 생략`);
  } else {
    // 추출기 출력은 spec 순서 그대로다(스킵 0건). spec 인덱스 → report_fs 는
    // 사실표 dim 에서 (unit_base, 프롬프트 수)가 아니라 **brand/cc/lang 조합**으로 되찾는다.
    const sql2 = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    const fsMap = (await sql2.unsafe(`
      SELECT DISTINCT ws.brand, ws.country_code cc, wp.lang_code lang, wp.file_seq fs
      FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id`)) as unknown as Array<{
      brand: string; cc: string; lang: string; fs: number }>;
    await sql2.end();
    const key = (b: string, c: string, l: string) => `${b}|${c}|${l}`;
    const seqByKey = new Map<string, number[]>();
    for (const r of fsMap) {
      const k = key(r.brand, r.cc, r.lang);
      const l = seqByKey.get(k) ?? [];
      if (!l.includes(Number(r.fs))) l.push(Number(r.fs));
      seqByKey.set(k, l);
    }
    let p2 = 0, f2 = 0, u2 = 0;
    const l2: string[] = [];
    for (let i = 0; i < out.length; i++) {
      const e = out[i], sp = specRows[i];
      const cands = seqByKey.get(key(sp.brand, sp.cc, sp.langCode ?? "")) ?? [];
      // 후보가 여럿이면(같은 사이트·언어가 spec 두 줄로 갈린 fs=41 사례) spec.fs 를 우선하고,
      // 그것이 후보에 없으면 남은 하나를 쓴다.
      const fsId = cands.length === 1 ? cands[0] : (cands.includes(sp.fs) ? sp.fs : cands.find((x) => x !== sp.fs));
      const r = fsId === undefined ? undefined : byU.get(fsId);
      if (!r) { u2++; l2.push(`? ${sp.brand}/${sp.cc}/${sp.langCode} (spec fs ${sp.fs}): 사실표 유닛 미상`); continue; }
      const d: string[] = [];
      const N = (v: unknown) => Number(v ?? 0);
      if (r.na !== N(e.summary.answers)) d.push(`na ${r.na}≠${N(e.summary.answers)}`);
      if (r.np !== e.prompts.length) d.push(`np ${r.np}≠${e.prompts.length}`);
      if (r.all_cit !== N(e.summary.tc)) d.push(`tc ${r.all_cit}≠${N(e.summary.tc)}`);
      if (r.owned_cit !== N(e.summary.oc)) d.push(`oc ${r.owned_cit}≠${N(e.summary.oc)}`);
      if (r.owned_ans !== N(e.summary.oa)) d.push(`oa ${r.owned_ans}≠${N(e.summary.oa)}`);
      if (d.length) { f2++; l2.push(`✗ fs ${fsId} ${sp.brand}/${sp.cc}/${sp.langCode} base=${e.base}: ${d.join(" · ")}`); }
      else p2++;
    }
    console.log(`\n── 정본(추출기 직접 산출) 대조: ${out.length} 유닛 · pass ${p2} · fail ${f2} · 미상 ${u2}`);
    if (l2.length) console.log(l2.join("\n"));
  }
}
const extra = rows.filter((r) => !db.sites.some((s) => Number(s.u) === Number(r.report_fs)));
if (extra.length) console.log(`사실표에만 있는 유닛: ${extra.map((r) => `${r.report_fs}(na ${r.na})`).join(", ")}`);
