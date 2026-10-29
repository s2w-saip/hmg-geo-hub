/**
 * [검증자 임시 스크립트 — 커밋 금지] 웹사이트 9/4 회차 사실표 ↔ 미러 경로 패리티.
 *   npx tsx --env-file=.env.local --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-website-0904.ts probe
 *   … parity [WINDOW=1]   (격자별 두 경로 직접 호출·대조; WINDOW=1 이면 미러에 dateFrom/dateTo=회차 창)
 *   … explain             (사실표 대표 쿼리 EXPLAIN ANALYZE)
 * 읽기 전용. summary_settings 는 절대 건드리지 않는다.
 */
process.env.DB_POOL_MAX ??= "4";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { columnAvailable } from "@/lib/db/column-availability";
import { getProjectIdsForScope } from "@/lib/db/repositories/website-sites";
import { entityRegistryRepository } from "@/lib/db/repositories/entity-registry";
import { narrowScopeBrands, ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";
import { pickWebsiteCycles, type WebsiteCyclePick } from "@/lib/db/repositories/summary-cycles";
import { resolveWebsiteSummaryRoute, summaryRouteHeaderValue } from "@/lib/summary/read/gate";
import {
  summaryWebsiteAggregates, summaryWebsiteSubKpis, summaryWebsitePromptTopics,
  summaryWebsiteSourceComposition, summaryWebsiteGeoCompetition, summaryWebsiteCitationAccuracy,
  __testables, type SummaryWebsiteScope,
} from "@/lib/db/repositories/summary-website-aggregates";
import {
  aggregateStandardFromMirror, aggregateSubKpisFromMirror, aggregatePromptTopicFromMirror,
  aggregateSourceCompositionFromMirror, aggregateGeoCompetitionFromMirror,
  aggregateWebsiteCitationAccuracy, websiteDeclaredOwnedBases, type StandardSubKpis,
} from "@/lib/db/repositories/scope-aggregates";

/** 집계층 read 가 `empty` 일 때의 자리표시 — 하네스는 값 비교만 한다(PR③ R3). */
const EMPTY_SUB: StandardSubKpis = { rows: [], promptsWithoutBrand: null, measuredPrompts: null };
import { STANDARD_FILTER_ARRAY_AXES, type StandardFilters, type StandardAggregates } from "@/lib/scope/result-adapter";
import type { AllowedScope } from "@/lib/auth/types";

const db = getDb();
const rows = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];
const mode = process.argv[2] ?? "probe";
const WINDOW = process.env.WINDOW === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const fmt = (v: unknown) => v instanceof Date ? v.toISOString() : v;
const table = (r: Record<string, unknown>[]) =>
  console.table(r.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fmt(v)]))));

// ── probe ───────────────────────────────────────────────────────────────────
async function probe() {
  const p = async (label: string, q: SQL) => { console.log(`\n## ${label}`); table(await rows(q)); };
  await p("summary_settings", sql`SELECT key, value, updated_at FROM summary_settings ORDER BY key`);
  await p("no-cycle projects by brand", sql`
    WITH proj AS (SELECT DISTINCT scope_project_id AS pid, brand FROM website_sites WHERE scope_project_id IS NOT NULL),
    cyc AS (SELECT project_id::text AS pid FROM summary_cycles WHERE surface='website' AND status='published')
    SELECT brand, count(*)::int AS projects, count(*) FILTER (WHERE pid IN (SELECT pid FROM cyc))::int AS with_cycle,
      string_agg(CASE WHEN pid NOT IN (SELECT pid FROM cyc) THEN (SELECT string_agg(country_code, '/') FROM website_sites w WHERE w.scope_project_id = proj.pid) END, ', ') AS no_cycle_sites
    FROM proj GROUP BY 1 ORDER BY 1`);
  await p("cycle projects with stale-mirror cells (mirror latest older than window)", sql`
    WITH cyc AS (SELECT project_id AS pid FROM summary_cycles WHERE surface='website' AND status='published'),
    mir AS (
      SELECT DISTINCT ON (a.prompt_id, a.target, a.region) r.project_id AS pid, a.job_id, a.measured_at
      FROM scope_answers a JOIN scope_runs r ON r.run_id = a.run_id
      WHERE r.project_id IN (SELECT pid FROM cyc) AND r.status IN ('completed','partial_failed') AND a.status='completed'
      ORDER BY a.prompt_id, a.target, a.region, a.measured_at DESC),
    fac AS (SELECT a.job_id FROM summary_answers a JOIN summary_cycles c ON c.cycle_id=a.cycle_id AND c.active_generation_id=a.generation_id WHERE c.surface='website' AND c.status='published'),
    d AS (SELECT m.pid, count(*)::int AS stale, max(m.measured_at) AS max_measured, min(m.measured_at) AS min_measured
          FROM mir m WHERE NOT EXISTS (SELECT 1 FROM fac f WHERE f.job_id = m.job_id) GROUP BY 1)
    SELECT d.pid::text AS project_id, (SELECT brand FROM website_sites w WHERE w.scope_project_id = d.pid::text LIMIT 1) AS brand,
      (SELECT string_agg(country_code, '/') FROM website_sites w WHERE w.scope_project_id = d.pid::text) AS sites,
      d.stale, (SELECT count(*) FROM mir m WHERE m.pid = d.pid)::int AS mirror_total, d.min_measured, d.max_measured
    FROM d ORDER BY d.stale DESC`);
  await p("prompts catalog multi-row funnel conflicts (website prompts)", sql`
    WITH wp AS (SELECT DISTINCT scope_prompt_id::uuid AS pid FROM website_prompts WHERE scope_prompt_id IS NOT NULL),
    c AS (SELECT p.scope_prompt_id AS pid, count(*)::int AS n, count(DISTINCT p.funnel_stage)::int AS funnels,
                 bool_or(p.deleted_at IS NOT NULL) AS any_deleted, count(*) FILTER (WHERE p.funnel_stage IS NULL)::int AS null_funnels
          FROM prompts p WHERE p.scope_prompt_id IN (SELECT pid FROM wp) GROUP BY 1)
    SELECT count(*)::int AS prompts_in_catalog, count(*) FILTER (WHERE n > 1)::int AS multi_row,
      count(*) FILTER (WHERE funnels > 1)::int AS multi_funnel, count(*) FILTER (WHERE any_deleted)::int AS with_deleted,
      count(*) FILTER (WHERE n > 1 AND null_funnels > 0 AND funnels >= 1)::int AS mixed_null_nonnull,
      (SELECT count(*) FROM wp)::int AS website_prompts
    FROM c`);
  await p("website lang codes / engines", sql`
    SELECT (SELECT string_agg(DISTINCT lang_code, ',') FROM website_prompts) AS langs,
           (SELECT string_agg(DISTINCT engine, ',') FROM summary_answers) AS engines,
           (SELECT count(*) FROM website_sites WHERE brand='Kia' AND country_code='DE')::int AS kia_de_sites,
           (SELECT count(*) FROM summary_cycles c JOIN website_sites w ON w.scope_project_id=c.project_id::text WHERE w.brand='Kia' AND w.country_code='DE' AND c.status='published')::int AS kia_de_cycle`);
}

// ── withWebsite 재현 ─────────────────────────────────────────────────────────
type Grid = { name: string; brand?: string[]; filters: StandardFilters };
const GRIDS: Grid[] = [
  { name: "①admin-nofilter", filters: {} },
  { name: "②brand=Hyundai", brand: ["Hyundai"], filters: {} },
  { name: "③brand=Kia+DE", brand: ["Kia"], filters: { websiteCountry: ["DE"] } },
  { name: "④engine=chatgpt", filters: { engine: ["chatgpt"] } },
  { name: "⑤lang=en", filters: { lang: ["en"] } },
  { name: "⑥country=worldwide", filters: { websiteCountry: ["worldwide"] } },
  { name: "⑦Genesis SA-Riyadh", brand: ["Genesis"], filters: { websiteCountry: ["SA-Riyadh"] } },
];

function normalizeFilters(filters: StandardFilters): StandardFilters {
  const norm: StandardFilters = {};
  for (const axis of STANDARD_FILTER_ARRAY_AXES) {
    const values = filters[axis];
    if (values?.length) norm[axis] = [...values].sort();
  }
  if (filters.dateFrom) norm.dateFrom = filters.dateFrom;
  if (filters.dateTo) norm.dateTo = filters.dateTo;
  if (filters.contextBrand?.length) norm.contextBrand = [...filters.contextBrand].sort();
  if (filters.ownEntities?.length) norm.ownEntities = [...filters.ownEntities].sort((a, b) => a.id.localeCompare(b.id));
  return norm;
}

async function websiteOwnedPrefixes(projectIds: string[], f: StandardFilters) {
  const { prefixes, universe } = await websiteDeclaredOwnedBases(f, projectIds);
  return prefixes.length
    ? { prefixes, universe }
    : { prefixes: ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.websiteCountry ?? f.region, f.lang), universe: undefined };
}

const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
const pct = (a: number, b: number) => (b > 0 ? r1((100 * a) / b) : null);
const t = async <T>(fn: () => Promise<T>): Promise<[T, number]> => { const s = performance.now(); const v = await fn(); return [v, Math.round(performance.now() - s)]; };

type Snap = {
  kpi: Record<string, unknown>;
  regions: Record<string, unknown>;
  brands: Record<string, unknown>;
  engines: Record<string, unknown>;
  topics: Record<string, unknown>;
  sources: Record<string, unknown>;
  geo: Record<string, unknown>;
  k6: Record<string, unknown>;
  ms: Record<string, number>;
};

function foldSources(s: { domain: string; citations: number; share: number; isOurs: boolean }[]) {
  const top = s.slice(0, 7);
  const rest = s.slice(7);
  const out: Record<string, unknown> = {};
  for (const d of top) out[d.domain] = `${d.citations}|${d.share}|${d.isOurs ? "ours" : ""}`;
  out["기타"] = `${rest.reduce((a, b) => a + b.citations, 0)}|${r1(rest.reduce((a, b) => a + b.share, 0))}`;
  out["_total"] = s.reduce((a, b) => a + b.citations, 0);
  out["_domains"] = s.length;
  return out;
}
function foldGeo(g: { code: string; brand: string; mentions: number; isTracked: boolean }[]) {
  const out: Record<string, unknown> = {};
  const sorted = [...g].sort((a, b) => b.mentions - a.mentions || (a.code + a.brand).localeCompare(b.code + b.brand));
  for (const x of sorted.slice(0, 10)) out[`${x.code}·${x.brand}`] = `${x.mentions}${x.isTracked ? "*" : ""}`;
  out["_rows"] = g.length;
  out["_codes"] = [...new Set(g.map((x) => x.code))].sort().join(",");
  out["_sum"] = g.reduce((a, b) => a + b.mentions, 0);
  out["_tracked_sum"] = g.filter((x) => x.isTracked).reduce((a, b) => a + b.mentions, 0);
  return out;
}

function snapOf(agg: StandardAggregates | null, sub: StandardSubKpis,
  topics: { topic: string | null; prompts: number }[], src: Parameters<typeof foldSources>[0],
  geo: Parameters<typeof foldGeo>[0], k6: { ownedAnswers: number; targetAnswers: number; rate: number | null },
  ms: Record<string, number>): Snap {
  const trackedMentions = agg?.brands.filter((b) => b.isTracked).reduce((s, b) => s + b.mentionCount, 0) ?? 0;
  const kpi = agg ? {
    asOf: agg.asOf, totalAnswers: agg.totalAnswers, tracked: agg.trackedAnswerCount,
    "①노출률%": pct(agg.trackedAnswerCount, agg.totalAnswers),
    totalMentions: agg.totalMentions, trackedMentions, "②점유율%": pct(trackedMentions, agg.totalMentions),
    "③긍정률%": agg.sentiment.positiveRate, posM: agg.sentiment.positiveMentions, sampM: agg.sentiment.sampledMentions,
    "④평균순위": agg.position.avgPosition, posSampled: agg.position.sampledAnswers,
    citTotal: agg.citations.totalCitations, citOwned: agg.citations.ownedCitations, "⑤자사인용%": pct(agg.citations.ownedCitations, agg.citations.totalCitations),
    withCit: agg.citations.answersWithCitation, domains: agg.citations.domains.length,
    ownedDomainSum: agg.citations.domains.reduce((s, d) => s + d.ownedCitationCount, 0),
    oursDomains: agg.citations.domains.filter((d) => d.isOurs).length,
    brandsN: agg.brands.length,
  } : { null: true };
  const regions: Record<string, unknown> = {};
  for (const r of agg?.regions ?? []) regions[r.region] = `${r.answerCount}/${r.trackedAnswerCount}`;
  const brands: Record<string, unknown> = {};
  for (const b of (agg?.brands ?? []).slice(0, 12)) brands[b.name] = `${b.mentionCount}/${b.answerCount}${b.isTracked ? "*" : ""}`;
  const engines: Record<string, unknown> = { promptsWithoutBrand: sub.promptsWithoutBrand, measuredPrompts: sub.measuredPrompts };
  for (const r of [...sub.rows].sort((a, b) => a.engine.localeCompare(b.engine))) {
    engines[r.engine] = `ans${r.answers} trk${r.tracked} multi${r.multi} top1:${r.top1} top3:${r.top3} pos${r.avgPosition} men${r.totalMentions}/${r.trackedMentions} sent${r.sentMentions}+${r.positiveMentions}-${r.negativeMentions} cit${r.citTotal}/${r.citOwned}`;
  }
  const tp: Record<string, unknown> = {};
  for (const x of topics) tp[x.topic ?? "null"] = x.prompts;
  tp["_sum"] = topics.reduce((a, b) => a + b.prompts, 0);
  return { kpi, regions, brands, engines, topics: tp, sources: foldSources(src), geo: foldGeo(geo), k6: { ...k6 }, ms };
}

function diff(label: string, a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = JSON.stringify(a[k] ?? null), vb = JSON.stringify(b[k] ?? null);
    if (va !== vb) out.push(`${label}.${k}: fact=${va} mirror=${vb}`);
  }
  return out;
}

async function parity() {
  await columnAvailable("scope_citations", "url_norm");
  const roster = await entityRegistryRepository.listOwn();
  const ownEntities = roster.length ? roster : undefined;
  const cycleProjects = new Set((await rows<{ pid: string }>(sql`
    SELECT project_id::text AS pid FROM summary_cycles WHERE surface='website' AND status='published'`)).map((r) => r.pid));
  const win = WINDOW ? { dateFrom: "2026-09-03", dateTo: "2026-09-05" } : {};
  console.log(`\n# parity mode: ${WINDOW ? "WINDOW(미러에 dateFrom=09-03,dateTo=09-05)" : "PROD(미러 창 없음)"} · cycle projects=${cycleProjects.size}`);
  const results: Array<Record<string, unknown>> = [];
  for (const g of GRIDS) {
    if (ONLY && !ONLY.has(g.name)) continue;
    const scope: AllowedScope = { all: true } as AllowedScope;
    const eff = narrowScopeBrands(scope, g.brand);
    const allIds = await getProjectIdsForScope(eff);
    const f = normalizeFilters({ ...g.filters, ...win, brand: undefined, contextBrand: eff.all ? undefined : eff.brands, ownEntities });
    // 프로덕션 라우팅(전체 id 로 게이트를 그대로 통과시킬 때) — read_enabled 는 DB 값 그대로(0이면 disabled)
    const prodRoute = await resolveWebsiteSummaryRoute(allIds, f, "S4.dashboard");
    const ids = allIds.filter((id) => cycleProjects.has(id));
    const cycles = await pickWebsiteCycles(ids);
    console.log(`\n## ${g.name}  projects all=${allIds.length} withCycle=${ids.length}  prodRoute(all ids)=${summaryRouteHeaderValue(prodRoute)}  cycles=${cycles?.length ?? "null"}`);
    if (!cycles) { console.log("   → 사실표 회차 없음, 건너뜀"); continue; }
    const own = await websiteOwnedPrefixes(ids, f);
    const scopeF: SummaryWebsiteScope = { cycles, projectIds: ids, filters: f, ownedBasePrefixes: own.prefixes };
    const ms: Record<string, number> = {};
    // 사실표
    const [fa, t1] = await t(() => summaryWebsiteAggregates(scopeF)); ms.f_agg = t1;
    const [fsRead, t2] = await t(() => summaryWebsiteSubKpis(scopeF)); ms.f_sub = t2;
    const fs = fsRead.empty ? EMPTY_SUB : fsRead.value;   // PR③ R3: read → 값
    const [ft, t3] = await t(() => summaryWebsitePromptTopics(scopeF)); ms.f_topics = t3;
    const [fcRead, t4] = await t(() => summaryWebsiteSourceComposition(scopeF)); ms.f_src = t4;
    const fc = fcRead.empty ? [] : fcRead.value;          // PR③ R3: read → 값
    const [fg, t5] = await t(() => summaryWebsiteGeoCompetition(scopeF)); ms.f_geo = t5;
    const [f6, t6] = await t(() => summaryWebsiteCitationAccuracy(scopeF)); ms.f_k6 = t6;
    // 미러
    const [ma, m1] = await t(() => aggregateStandardFromMirror(f, ids, own.prefixes, own.universe)); ms.m_agg = m1;
    const [msb, m2] = await t(() => aggregateSubKpisFromMirror(f, ids, own.prefixes, own.universe)); ms.m_sub = m2;
    const [mt, m3] = await t(() => aggregatePromptTopicFromMirror(f, ids)); ms.m_topics = m3;
    const [mc, m4] = await t(() => aggregateSourceCompositionFromMirror(f, ids, own.prefixes)); ms.m_src = m4;
    const [mg, m5] = await t(() => aggregateGeoCompetitionFromMirror(f, ids)); ms.m_geo = m5;
    const [m6, m6t] = await t(() => aggregateWebsiteCitationAccuracy(f, ids, own.prefixes, own.universe)); ms.m_k6 = m6t;
    const F = snapOf(fa, fs, ft, fc, fg, f6, ms);
    const M = snapOf(ma, msb, mt, mc, mg, m6, ms);
    const diffs = [
      ...diff("kpi", F.kpi, M.kpi), ...diff("regions", F.regions, M.regions), ...diff("brands", F.brands, M.brands),
      ...diff("engines", F.engines, M.engines), ...diff("topics", F.topics, M.topics), ...diff("sources", F.sources, M.sources),
      ...diff("geo", F.geo, M.geo), ...diff("⑥", F.k6, M.k6),
    ];
    console.log(`   own.prefixes=${own.prefixes.length} universe=${own.universe?.length ?? "undef"}`);
    console.log("   FACT  kpi:", JSON.stringify(F.kpi));
    console.log("   MIRR  kpi:", JSON.stringify(M.kpi));
    console.log("   FACT  ⑥:", JSON.stringify(F.k6), " MIRR ⑥:", JSON.stringify(M.k6));
    console.log("   FACT  engines:", JSON.stringify(F.engines));
    console.log("   MIRR  engines:", JSON.stringify(M.engines));
    console.log("   FACT  topics:", JSON.stringify(F.topics), " MIRR:", JSON.stringify(M.topics));
    console.log("   FACT  sources:", JSON.stringify(F.sources));
    console.log("   MIRR  sources:", JSON.stringify(M.sources));
    console.log("   FACT  geo:", JSON.stringify(F.geo));
    console.log("   MIRR  geo:", JSON.stringify(M.geo));
    console.log("   FACT  regions:", JSON.stringify(F.regions));
    console.log("   MIRR  regions:", JSON.stringify(M.regions));
    console.log("   FACT  brands:", JSON.stringify(F.brands));
    console.log("   MIRR  brands:", JSON.stringify(M.brands));
    console.log("   ms:", JSON.stringify(ms));
    console.log(diffs.length ? `   ✗ DIFF ${diffs.length}건:\n     ${diffs.join("\n     ")}` : "   ✓ 전 항목 일치");
    results.push({ grid: g.name, projects: ids.length, diffs: diffs.length, fact_ms: Object.entries(ms).filter(([k]) => k.startsWith("f_")).reduce((s, [, v]) => s + v, 0), mirror_ms: Object.entries(ms).filter(([k]) => k.startsWith("m_")).reduce((s, [, v]) => s + v, 0) });
  }
  console.log("\n# summary"); table(results);
}

// ── explain ─────────────────────────────────────────────────────────────────
async function explain() {
  const roster = await entityRegistryRepository.listOwn();
  const ownEntities = roster.length ? roster : undefined;
  const cycleProjects = new Set((await rows<{ pid: string }>(sql`SELECT project_id::text AS pid FROM summary_cycles WHERE surface='website' AND status='published'`)).map((r) => r.pid));
  const run = async (label: string, ids: string[], f: StandardFilters, build: (s: SummaryWebsiteScope) => SQL) => {
    const cycles = (await pickWebsiteCycles(ids))!;
    const own = await websiteOwnedPrefixes(ids, f);
    const scope: SummaryWebsiteScope = { cycles, projectIds: ids, filters: f, ownedBasePrefixes: own.prefixes };
    const q = build(scope);
    const plan = await rows<{ "QUERY PLAN": string }>(sql`EXPLAIN (ANALYZE, BUFFERS, SUMMARY) ${q}`);
    const lines = plan.map((r) => r["QUERY PLAN"]);
    console.log(`\n## EXPLAIN ${label}`);
    const keep = lines.filter((l) => /Execution Time|Planning Time|Buffers: shared|Seq Scan|Index.*Scan|Append|Partitions removed|summary_|rows=\d+ loops=1\)$/.test(l));
    console.log(lines.slice(0, 6).join("\n"));
    console.log("   …");
    console.log(keep.filter((l) => !/Bitmap Index Scan/.test(l)).join("\n"));
    console.log(lines.slice(-3).join("\n"));
  };
  const uuidArr = (v: string[]) => sql`ARRAY[${sql.join(v.map((x) => sql`${x}`), sql`, `)}]::uuid[]`;
  const ownArr = (f: StandardFilters) => uuidArr(f.ownEntities?.map((e) => e.id) ?? []);
  // 1) 무필터 KPI ① (지역 롤업 + 분자)
  const all = (await getProjectIdsForScope({ all: true } as AllowedScope)).filter((id) => cycleProjects.has(id));
  const f0 = normalizeFilters({ ownEntities });
  await run("무필터 KPI① ansRows", all, f0, (s) => {
    const W = __testables.answerWhere(s); const F = __testables.factScope(s);
    return sql`WITH a AS (SELECT job_id, country, monitored FROM summary_answers WHERE ${W}),
      o AS (SELECT DISTINCT job_id FROM summary_brand_mentions WHERE ${F} AND brand_id = ANY(${ownArr(s.filters)}))
      SELECT COALESCE(a.country,'UNKNOWN') AS region, COALESCE(sum(a.monitored),0)::int AS answers,
        count(*) FILTER (WHERE o.job_id IS NOT NULL)::int AS tracked
      FROM a LEFT JOIN o ON o.job_id = a.job_id GROUP BY 1 ORDER BY 1`;
  });
  // 2) 브랜드=Hyundai 브랜드 표 GEO
  const eff = narrowScopeBrands({ all: true } as AllowedScope, ["Hyundai"]);
  const hy = (await getProjectIdsForScope(eff)).filter((id) => cycleProjects.has(id));
  const f1 = normalizeFilters({ contextBrand: eff.brands, ownEntities });
  await run("brand=Hyundai GEO 경쟁", hy, f1, (s) => sql`
    SELECT country AS code, brand_name AS brand, COALESCE(sum(mentions),0)::int AS mentions,
      bool_or(brand_id = ANY(${ownArr(s.filters)})) AS is_tracked
    FROM summary_brand_mentions WHERE ${__testables.factScope(s)} AND is_competitor = 1 AND country IS NOT NULL
    GROUP BY 1, 2`);
}

async function main() {
  if (mode === "probe") await probe();
  else if (mode === "parity") await parity();
  else if (mode === "explain") await explain();
  else throw new Error(`unknown mode ${mode}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
