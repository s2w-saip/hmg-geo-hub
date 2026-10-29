// summary table(웹사이트, 활성 generation) → 엑셀. 읽기 전용.
// 실행: bash (내부 작업 파일) <워크트리> npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/export-website-xlsx.ts <출력.xlsx>
// 시트: 안내 · 회차 · 유닛 KPI(보고서 KPI 요약과 같은 열) · 답변 · 브랜드 언급 · 도메인 인용 · 타겟 히트 · 프롬프트 · 검산
import ExcelJS from "exceljs";
import postgres from "postgres";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: export-website-xlsx.ts <out.xlsx>"); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: "require" });
const q = async <T = Record<string, unknown>>(s: string) => (await sql.unsafe(s)) as unknown as T[];

const ACT = `act as (select c.cycle_id, c.active_generation_id gid, c.project_id, c.cycle_anchor_at, c.cycle_week from summary_cycles c where c.surface='website' and c.view_anchor_at is not null)`;
// 프롬프트 수는 website_prompts 재집계가 아니라 유닛 멤버십(summary_prompt_dim.report_fs — report-spec 의
// langCode·urlLike/urlNotLike 적용 후)으로 센다. 예: Kia/GR(74)은 website_prompts 100행이지만 kia.com/eu 타겟 22개가
// 유닛 밖이라 78 이 정본이다(3자 검증 2026-09-06 지적).
const UNIT = `unit as (select wp.file_seq, ws.brand, ws.country_code, wp.lang_code, wp.domain, max(wp.owned_base_url) owned_base_url,
  (select count(*)::int from summary_prompt_dim p join act on act.cycle_id=p.cycle_id and act.gid=p.generation_id where p.report_fs = wp.file_seq) prompts
  from website_prompts wp join website_sites ws on ws.id=wp.site_id group by 1,2,3,4,5)`;

try {
  const excluded = await q<{ value: string }>(`select value from summary_settings where key='website_excluded_fs'`);
  const exclFs: number[] = excluded[0]?.value ? JSON.parse(excluded[0].value) : [];
  const settings = await q<{ key: string; value: string; updated_at: Date }>(`select key, value, updated_at from summary_settings order by key`);

  const cycles = await q(`with ${ACT} select c.cycle_id, c.project_id, c.cycle_anchor_at, c.cycle_week, c.status, c.closed_by, c.anchor_source, c.expected_units, c.completed_units, c.sealed_units, c.completion_ratio, c.analysis_gap_ratio, c.analysis_gate, c.measured_from, c.measured_to, c.view_anchor_at, c.generator_version, c.active_generation_id,
    (select string_agg(distinct ws.brand||'/'||ws.country_code, ', ') from website_sites ws where ws.scope_project_id::text=c.project_id::text) sites,
    (select count(*)::int from summary_cycle_runs r where r.cycle_id=c.cycle_id) runs
    from summary_cycles c join act on act.cycle_id=c.cycle_id order by c.project_id`);

  // 유닛 KPI — 보고서 KPI 요약 시트와 같은 정의(run 상태 게이트·report_fs 유닛·CPO 는 행에 포함, 평균 모수에서만 제외)
  const unitKpi = await q(`with ${ACT}, ${UNIT},
    a as (select a.job_id, a.report_fs, a.engine, a.unit_owned, a.unit_target, a.all_citations from summary_answers a join act on act.cycle_id=a.cycle_id and act.gid=a.generation_id where a.report_fs is not null and a.run_status in ('completed','partial_failed')),
    d as (select d.job_id, sum(d.citations) cit, sum(d.unit_owned_citations) own from summary_domain_citations d join act on act.cycle_id=d.cycle_id and act.gid=d.generation_id group by 1)
    select u.file_seq "유닛", u.brand "브랜드", u.country_code "국가코드", u.domain "사이트", upper(u.lang_code) "언어", u.prompts::int "프롬프트 수",
      count(a.job_id)::int "답변 수", coalesce(sum(d.cit),0)::int "전체 인용 수", coalesce(sum(d.own),0)::int "자사 인용 수",
      round(100.0*coalesce(sum(d.own),0)/nullif(sum(d.cit),0),2) "AI 인용 점유율(%)",
      sum(a.unit_owned)::int "자사 인용 답변 수", sum(case when a.unit_owned=1 and a.unit_target=1 then 1 else 0 end)::int "타겟 URL 인용 답변 수",
      round(100.0*sum(case when a.unit_owned=1 and a.unit_target=1 then 1 else 0 end)/nullif(sum(a.unit_owned),0),2) "AI 타겟 출처 인용률(%)",
      u.owned_base_url "자사 판정 base", string_agg(distinct a.engine, ',' order by a.engine) "AI 엔진",
      case when u.file_seq = any($1::int[]) then '보고서 제외' when u.country_code='CPO' then '평균 제외(CPO)' else '' end "비고"
    from unit u left join a on a.report_fs=u.file_seq left join d on d.job_id=a.job_id
    group by u.file_seq, u.brand, u.country_code, u.domain, u.lang_code, u.prompts, u.owned_base_url
    having count(a.job_id) > 0 order by u.file_seq`.replace("$1::int[]", `'{${exclFs.join(",")}}'::int[]`));

  const answers = await q(`with ${ACT} select a.report_fs "유닛", a.project_id "프로젝트", a.country "국가", a.lang "언어", a.engine "AI 엔진", a.job_id "답변 ID", a.prompt_id "프롬프트 ID", a.run_status "run 상태",
      a.monitored "모니터링", a.all_mentions "전체 언급", a.all_citations "전체 인용", a.has_any_brand "브랜드 언급 有", a.unit_owned "자사 인용 답변(1)", a.unit_target "타겟 URL 인용 답변(1)", a.in_full_cycle, a.in_tagged_region, a.in_root_catalog
    from summary_answers a join act on act.cycle_id=a.cycle_id and act.gid=a.generation_id order by a.report_fs nulls last, a.job_id`);
  const brands = await q(`with ${ACT} select ua.report_fs "유닛", b.job_id "답변 ID", b.engine "AI 엔진", b.country "국가", b.brand_id "브랜드 ID", b.brand_name "브랜드", b.is_competitor "경쟁 브랜드(1)", b.mentions "언급 수", b.first_rank "최초 순위", b.positive "긍정", b.neutral "중립", b.negative "부정", b.mixed "혼합", b.type_mention, b.type_recommendation, b.type_comparison, b.type_definition, b.type_final_choice
    from summary_brand_mentions b join act on act.cycle_id=b.cycle_id and act.gid=b.generation_id left join summary_answers ua on ua.cycle_id=b.cycle_id and ua.generation_id=b.generation_id and ua.job_id=b.job_id order by ua.report_fs nulls last, b.job_id, b.brand_name`);
  const domains = await q(`with ${ACT} select ua.report_fs "유닛", d.job_id "답변 ID", d.engine "AI 엔진", d.country "국가", d.group_key "출처 키", d.domain "도메인", d.matched_base "매칭 base", d.base_norm_null, d.citations "인용 수", d.unit_owned_citations "자사 인용 수(유닛)"
    from summary_domain_citations d join act on act.cycle_id=d.cycle_id and act.gid=d.generation_id left join summary_answers ua on ua.cycle_id=d.cycle_id and ua.generation_id=d.generation_id and ua.job_id=d.job_id order by ua.report_fs nulls last, d.job_id, d.group_key`);
  const targets = await q(`with ${ACT} select t.job_id "답변 ID", t.project_id "프로젝트", t.engine "AI 엔진", t.country "국가", t.matched_base_tracked "매칭 base(tracked)", array_to_string(t.target_keys, ' | ') "타겟 키", t.citations "인용 수"
    from summary_target_hits t join act on act.cycle_id=t.cycle_id and act.gid=t.generation_id order by t.job_id`);
  const prompts = await q(`with ${ACT} select p.report_fs "유닛", p.prompt_id "프롬프트 ID", p.project_id "프로젝트", p.site_country "사이트 국가", p.site_lang "사이트 언어", p.unit_base "유닛 base", p.target_url_norm "타겟 URL(정규화)", p.target_url_norm_report "타겟 URL(보고서 정규화)", p.owned_base_url "선언 base", p.text "프롬프트"
    from summary_prompt_dim p join act on act.cycle_id=p.cycle_id and act.gid=p.generation_id order by p.report_fs nulls last, p.prompt_id`);

  const wb = new ExcelJS.Workbook();
  wb.creator = "hmg-geo summary table export";
  const info = wb.addWorksheet("안내");
  info.addRows([
    ["summary table 내보내기 — 웹사이트 9/4 회차 (활성 generation)"],
    ["생성 시각(UTC)", new Date().toISOString()],
    ["원천", "hmg-geo Supabase summary_* (0059/0060)"],
    ["회차 수", cycles.length],
    ["평균 모수 규칙", "run 상태 completed/partial_failed · report_fs(보고서 유닛) 있는 답변 · CPO(109) 평균 제외 · 보고서 제외 유닛 " + JSON.stringify(exclFs)],
    ["설정", settings.map((s) => `${s.key}=${s.value}`).join(" · ")],
    ["시트", "회차 / 유닛 KPI / 답변 / 브랜드 언급 / 도메인 인용 / 타겟 히트 / 프롬프트 / 검산"],
  ]);
  const addTable = (name: string, rows: Record<string, unknown>[]) => {
    const ws = wb.addWorksheet(name);
    if (!rows.length) { ws.addRow(["(행 없음)"]); return ws; }
    const cols = Object.keys(rows[0]);
    ws.addRow(cols).font = { bold: true };
    for (const r of rows) ws.addRow(cols.map((c) => { const v = r[c]; return v instanceof Date ? v.toISOString() : (v === null ? "" : (typeof v === "object" ? JSON.stringify(v) : v)); }));
    ws.views = [{ state: "frozen", ySplit: 1 }];
    return ws;
  };
  addTable("회차", cycles);
  const kpiWs = addTable("유닛 KPI", unitKpi);
  addTable("답변", answers);
  addTable("브랜드 언급", brands);
  addTable("도메인 인용", domains);
  addTable("타겟 히트", targets);
  addTable("프롬프트", prompts);
  // 검산 — 유닛 KPI 시트 위 수식(Σ/Σ, CPO·보고서 제외 유닛 제외)
  const chk = wb.addWorksheet("검산");
  const n = unitKpi.length + 1;
  const exclCond = (col: string) => `SUMPRODUCT(('유닛 KPI'!$P$2:$P$${n}="")*('유닛 KPI'!${col}$2:${col}$${n}))`;
  chk.addRows([
    ["항목", "값(수식)", "설명"],
    ["⑤ 전체 = Σ자사 인용 ÷ Σ전체 인용 (CPO·보고서 제외 유닛 제외)", { formula: `ROUND(${exclCond("I")}/${exclCond("H")}*100,2)` }, "보고서 bench.g5 와 같아야 함"],
    ["⑥ 전체 = Σ타겟 답변 ÷ Σ자사 인용 답변 (동일 모수)", { formula: `ROUND(${exclCond("L")}/${exclCond("K")}*100,2)` }, "보고서 bench.g6 와 같아야 함"],
    ["답변 수 합(모수)", { formula: `${exclCond("G")}` }, ""],
  ]);
  kpiWs.getColumn(16).width = 16;
  await wb.xlsx.writeFile(OUT);
  console.log(`wrote ${OUT}: cycles ${cycles.length} · unitKpi ${unitKpi.length} · answers ${answers.length} · brands ${brands.length} · domains ${domains.length} · targets ${targets.length} · prompts ${prompts.length} · excluded ${JSON.stringify(exclFs)}`);
} finally {
  await sql.end();
}
