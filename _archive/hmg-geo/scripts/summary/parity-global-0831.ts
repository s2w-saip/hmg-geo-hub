/**
 * [검증자 임시 스크립트 — 커밋 금지] 글로벌 8/31 회차 사실표 ↔ 미러 경로 패리티.
 *   bash (내부 작업 파일) <repo> npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-global-0831.ts probe
 *   … parity [WINDOW=1] [ONLY=①,②] [EXTRA='[{"name":"x","filters":{...}}]']
 *   … rebut     (반박 지점 1~5 전용 프로브 — 갈리는 격자를 데이터에서 찾는다)
 *   … explain   (사실표 대표 쿼리 EXPLAIN ANALYZE + 미러 W 대조)
 * 읽기 전용. summary_settings 절대 무접촉.
 */
process.env.DB_POOL_MAX ??= "4";
// 게이트웨이와 같은 루트 해석 — 하네스는 DATABASE_URL 만 넘기므로 여기서 고정한다(lazy read).
process.env.SCOPE_MODE = "live";
process.env.SCOPE_ROOT_PROJECT_ID ??= "be28fe15-c743-4a88-abb8-182b25602812";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { columnAvailable } from "@/lib/db/column-availability";
import { entityRegistryRepository } from "@/lib/db/repositories/entity-registry";
import { ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";
import { pickGlobalCycle, hasOpenCycle } from "@/lib/db/repositories/summary-cycles";
import { resolveGlobalSummaryRoute, summaryRouteHeaderValue } from "@/lib/summary/read/gate";
import {
  summaryGlobalAggregates, summaryGlobalSubKpis, summaryGlobalPromptTopics,
  summaryGlobalSourceComposition, summaryGlobalGeoCompetition,
  __testables, type SummaryGlobalScope,
} from "@/lib/db/repositories/summary-global-aggregates";
import {
  aggregateStandardFromMirror, aggregateSubKpisFromMirror, aggregatePromptTopicFromMirror,
  aggregateSourceCompositionFromMirror, aggregateGeoCompetitionFromMirror,
  answerWhere as mirrorAnswerWhere, withSnapshotAnswerSetScope, createSnapshotAnswerSetStore,
} from "@/lib/db/repositories/scope-aggregates";
import { STANDARD_FILTER_ARRAY_AXES, getStandardRootId, type StandardFilters, type StandardAggregates } from "@/lib/scope/result-adapter";
import { GEO_OWNED_BASES, GEO_OWNED_BASE_PREFIXES, SHARED_GLOBAL_HOSTS } from "@/lib/geo-catalog/owned";
import { STANDARD_ROOT_PROJECT_ID } from "@/lib/db/repositories/standards";
import { countriesForRhq } from "@/lib/rhq";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";

const db = getDb();
const rows = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];
const mode = process.argv[2] ?? "probe";
const WINDOW = process.env.WINDOW === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const ROOT = process.env.SCOPE_ROOT_PROJECT_ID!;
const WIN = { dateFrom: "2026-08-30", dateTo: "2026-09-01" };
const fmt = (v: unknown) => v instanceof Date ? v.toISOString() : v;
const table = (r: Record<string, unknown>[]) =>
  console.table(r.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fmt(v)]))));
const ONLYP = process.env.ONLYP;
const p = async (label: string, q: SQL) => { if (ONLYP && !label.includes(ONLYP)) return []; console.log(`\n## ${label}`); const r = await rows<Record<string, unknown>>(q); table(r); return r; };

async function activeCycle() {
  const c = await rows<{ cycle_id: string; gid: string; cycle_week: string; anchor: string }>(sql`
    SELECT cycle_id::text AS cycle_id, active_generation_id::text AS gid, cycle_week::text AS cycle_week, cycle_anchor_at::text AS anchor
    FROM summary_cycles WHERE surface='global' AND project_id=${ROOT}::uuid AND status='published' AND active_generation_id IS NOT NULL
    ORDER BY cycle_anchor_at DESC LIMIT 1`);
  if (!c[0]) throw new Error("published global cycle 없음");
  return c[0];
}
const pick = (a: string, c: { cycle_id: string; gid: string; cycle_week: string }) =>
  sql`${sql.raw(a)}.cycle_week = ${c.cycle_week}::date AND ${sql.raw(a)}.cycle_id = ${c.cycle_id}::uuid AND ${sql.raw(a)}.generation_id = ${c.gid}::uuid`;

// ── probe ───────────────────────────────────────────────────────────────────
async function probe() {
  await p("timezone / now", sql`SELECT current_setting('TimeZone') AS tz, now()::text AS now, current_user AS role`);
  await p("summary_settings", sql`SELECT key, value, updated_at FROM summary_settings ORDER BY key`);
  await p("summary_cycles(global)", sql`
    SELECT cycle_id::text, active_generation_id::text AS gid, project_id::text AS project, status, cycle_anchor_at::text AS anchor,
      cycle_week::text, view_anchor_at::text, expected_units, completed_units, measured_from::text, measured_to::text, generator_version
    FROM summary_cycles WHERE surface='global' ORDER BY cycle_anchor_at DESC`);
  const c = await activeCycle();
  const C = sql`${c.cycle_id}::uuid`;
  await p("표 행수(활성 generation)", sql`
    SELECT (SELECT count(*) FROM summary_answers a WHERE ${pick("a", c)})::int AS answers,
      (SELECT count(*) FROM summary_answers a WHERE ${pick("a", c)} AND in_full_cycle=1 AND in_root_catalog=1 AND in_tagged_region=1 AND country<>'ID' AND run_status IN ('completed','partial_failed'))::int AS answers_gated,
      (SELECT count(*) FROM summary_answers a WHERE ${pick("a", c)} AND country='ID')::int AS id_cells,
      (SELECT count(*) FROM summary_answers a WHERE ${pick("a", c)} AND country='ID' AND in_full_cycle=1)::int AS id_cells_fc,
      (SELECT count(*) FROM summary_brand_mentions b WHERE ${pick("b", c)})::int AS brand_rows,
      (SELECT count(*) FROM summary_domain_citations d WHERE ${pick("d", c)})::int AS domain_rows,
      (SELECT count(*) FROM summary_cycle_runs WHERE cycle_id=${C})::int AS cycle_runs,
      (SELECT string_agg(DISTINCT run_status, ',') FROM summary_answers a WHERE ${pick("a", c)}) AS run_statuses`);
  // 회차 이후 새 run (게이트 newer-runs 재현)
  await p("루트 run: 회차 경계·이후 run", sql`
    WITH bound AS (SELECT max(r.started_at) AS last_started, max(a.measured_at) AS last_measured
      FROM scope_runs r JOIN summary_cycle_runs cr ON cr.run_id=r.run_id LEFT JOIN scope_answers a ON a.run_id=r.run_id
      WHERE cr.cycle_id=${C})
    SELECT bound.last_started::text, bound.last_measured::text,
      (SELECT count(*) FROM scope_runs r WHERE r.project_id=${ROOT}::uuid AND r.started_at > bound.last_started
         AND NOT EXISTS (SELECT 1 FROM summary_cycle_runs cr WHERE cr.run_id=r.run_id))::int AS newer_runs_outside_cycle,
      (SELECT count(*) FROM scope_runs r WHERE r.project_id=${ROOT}::uuid AND r.started_at >= '2026-09-02'::timestamptz)::int AS runs_started_from_0902,
      (SELECT max(started_at)::text FROM scope_runs WHERE project_id=${ROOT}::uuid) AS root_max_started,
      (SELECT count(*) FROM scope_runs WHERE project_id=${ROOT}::uuid AND started_at >= now() - interval '7 days')::int AS runs_last7d,
      (SELECT count(*) FROM scope_runs r WHERE r.project_id=${ROOT}::uuid AND r.started_at >= now() - interval '7 days'
         AND EXISTS (SELECT 1 FROM summary_cycle_runs cr WHERE cr.run_id=r.run_id))::int AS runs_last7d_in_cycle,
      (SELECT max(synced_at)::text FROM scope_runs WHERE project_id=${ROOT}::uuid) AS root_max_synced
    FROM bound`);
  await p("회차 밖 최근 루트 run 목록(최신 15)", sql`
    SELECT r.run_id::text, r.status, r.started_at::text, r.cycle_anchor_at::text, r.synced_at::text,
      (SELECT count(*) FROM scope_answers a WHERE a.run_id=r.run_id)::int AS answers,
      (SELECT count(*) FROM scope_answers a WHERE a.run_id=r.run_id AND a.status='completed')::int AS completed,
      (SELECT min(measured_at)::text FROM scope_answers a WHERE a.run_id=r.run_id) AS m_from,
      (SELECT max(measured_at)::text FROM scope_answers a WHERE a.run_id=r.run_id) AS m_to,
      EXISTS (SELECT 1 FROM summary_cycle_runs cr WHERE cr.run_id=r.run_id) AS in_cycle
    FROM scope_runs r WHERE r.project_id=${ROOT}::uuid ORDER BY r.started_at DESC LIMIT 15`);
  // 회차 run 멤버십(measured_at 창) vs 미러 창(started_at 08-30..09-01) vs 라이브 7d
  await p("run 집합 대조: 회차 mem vs started_at 창 vs now()-7d", sql`
    WITH mem AS (SELECT run_id FROM summary_cycle_runs WHERE cycle_id=${C}),
    sw AS (SELECT run_id FROM scope_runs WHERE project_id=${ROOT}::uuid AND status IN ('completed','partial_failed')
           AND started_at >= ${WIN.dateFrom}::date AND started_at < (${WIN.dateTo}::date + 1)),
    l7 AS (SELECT run_id FROM scope_runs WHERE project_id=${ROOT}::uuid AND status IN ('completed','partial_failed')
           AND started_at >= now() - interval '7 days')
    SELECT (SELECT count(*) FROM mem)::int AS mem_runs, (SELECT count(*) FROM sw)::int AS window_runs,
      (SELECT count(*) FROM mem WHERE run_id NOT IN (SELECT run_id FROM sw))::int AS mem_only,
      (SELECT count(*) FROM sw WHERE run_id NOT IN (SELECT run_id FROM mem))::int AS window_only,
      (SELECT count(*) FROM l7)::int AS live7d_runs,
      (SELECT count(*) FROM l7 WHERE run_id NOT IN (SELECT run_id FROM mem))::int AS live7d_only,
      (SELECT count(*) FROM mem WHERE run_id NOT IN (SELECT run_id FROM l7))::int AS mem_not_in_live7d,
      (SELECT count(*) FROM scope_runs r JOIN mem ON mem.run_id=r.run_id WHERE r.cycle_anchor_at IS NULL)::int AS mem_anchor_null,
      (SELECT count(*) FROM scope_runs r JOIN mem ON mem.run_id=r.run_id WHERE r.status NOT IN ('completed','partial_failed'))::int AS mem_bad_status`);
  await p("회차 answers: region NULL·미러 asOf 후보", sql`
    WITH mem AS (SELECT run_id FROM summary_cycle_runs WHERE cycle_id=${C})
    SELECT count(*) FILTER (WHERE a.status='completed' AND a.region IS NULL)::int AS completed_region_null,
      count(*) FILTER (WHERE a.status='completed' AND a.prompt_id IS NULL)::int AS completed_prompt_null,
      max(a.measured_at)::text AS max_measured_at,
      max(COALESCE(r.cycle_anchor_at, a.measured_at))::text AS mirror_asof_expr
    FROM scope_answers a JOIN scope_runs r ON r.run_id=a.run_id JOIN mem ON mem.run_id=a.run_id`);
  await p("격자 후보: 차원 값(사실표 게이트 통과 셀)", sql`
    WITH g AS (SELECT * FROM summary_answers a WHERE ${pick("a", c)} AND in_full_cycle=1 AND in_root_catalog=1 AND in_tagged_region=1 AND country<>'ID')
    SELECT 'engine' AS axis, engine AS value, count(*)::int AS cells FROM g GROUP BY 2
    UNION ALL SELECT 'country', country, count(*)::int FROM g GROUP BY 2
    UNION ALL SELECT 'lang', lang, count(*)::int FROM g GROUP BY 2
    UNION ALL SELECT 'funnel', funnel_catalog, count(*)::int FROM g GROUP BY 2
    UNION ALL SELECT 'presence', brand_presence_resolved, count(*)::int FROM g GROUP BY 2
    UNION ALL SELECT 'brands', array_to_string(catalog_brands, '+'), count(*)::int FROM g GROUP BY 2
    UNION ALL SELECT 'depth1', depth1, count(*)::int FROM g GROUP BY 2
    ORDER BY 1, 3 DESC`);
  await p("scope_prompts.lang 케이싱", sql`
    SELECT count(*)::int AS prompts, count(*) FILTER (WHERE lang <> upper(lang))::int AS not_upper, string_agg(DISTINCT lang, ',') AS langs
    FROM scope_prompts WHERE lang IS NOT NULL`);
  await p("루트 카탈로그 중복·NULL 지문", sql`
    WITH r AS (SELECT scope_prompt_id AS pid, brand, funnel_stage, brand_presence, depth1, updated_at
               FROM prompts WHERE project_id=${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL),
    g AS (SELECT pid, count(*)::int AS n, count(DISTINCT funnel_stage)::int AS funnels, count(*) FILTER (WHERE funnel_stage IS NULL)::int AS funnel_null,
                 count(DISTINCT brand_presence)::int AS presences, count(*) FILTER (WHERE brand_presence IS NULL)::int AS presence_null,
                 count(DISTINCT depth1)::int AS d1s, count(DISTINCT brand)::int AS brands, count(*) FILTER (WHERE brand IS NULL)::int AS brand_null
          FROM r GROUP BY 1)
    SELECT (SELECT count(*) FROM r)::int AS rows, count(*)::int AS prompts, count(*) FILTER (WHERE n>1)::int AS dup_prompts,
      count(*) FILTER (WHERE funnels>1)::int AS funnel_disagree, count(*) FILTER (WHERE funnel_null>0 AND funnels>=1)::int AS funnel_mixed_null,
      count(*) FILTER (WHERE presence_null>0)::int AS presence_any_null, count(*) FILTER (WHERE presences>1)::int AS presence_disagree,
      count(*) FILTER (WHERE d1s>1)::int AS depth1_disagree, count(*) FILTER (WHERE brands>1)::int AS multi_brand, count(*) FILTER (WHERE brand_null>0)::int AS brand_any_null
    FROM g`);
  await p("funnel 원천: 비루트 행에만 funnel 이 있는 프롬프트 / 전체 prompts 행의 funnel 다중", sql`
    WITH root AS (SELECT scope_prompt_id AS pid, (array_agg(funnel_stage ORDER BY updated_at DESC))[1] AS f_latest,
                         bool_or(funnel_stage IS NOT NULL) AS any_non_null
                  FROM prompts WHERE project_id=${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL GROUP BY 1),
    anyp AS (SELECT scope_prompt_id AS pid, count(DISTINCT funnel_stage)::int AS fs, min(funnel_stage) AS f_min, max(funnel_stage) AS f_max
             FROM prompts WHERE scope_prompt_id IS NOT NULL AND funnel_stage IS NOT NULL GROUP BY 1)
    SELECT count(*)::int AS root_prompts,
      count(*) FILTER (WHERE root.f_latest IS NULL AND anyp.pid IS NOT NULL)::int AS latest_null_but_some_row_has,
      count(*) FILTER (WHERE root.f_latest IS NULL AND root.any_non_null)::int AS latest_null_root_other_row_has,
      count(*) FILTER (WHERE anyp.fs > 1)::int AS all_rows_multi_funnel,
      count(*) FILTER (WHERE anyp.fs > 1 AND root.f_latest IS DISTINCT FROM anyp.f_min)::int AS limit1_ambiguous_vs_latest
    FROM root LEFT JOIN anyp ON anyp.pid=root.pid`);
  await p("brand_presence: 미러 COALESCE 해석 vs 사실표 굳힌 값(셀 기준)", sql`
    WITH mir AS (
      SELECT scope_prompt_id AS pid,
        bool_or(COALESCE(brand_presence, CASE WHEN brand=${UMBRELLA_BRAND} THEN 'unbranded' WHEN brand IS NOT NULL THEN 'branded' END)='branded') AS any_branded,
        bool_or(COALESCE(brand_presence, CASE WHEN brand=${UMBRELLA_BRAND} THEN 'unbranded' WHEN brand IS NOT NULL THEN 'branded' END)='unbranded') AS any_unbranded
      FROM prompts WHERE project_id=${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL GROUP BY 1)
    SELECT count(*)::int AS cells,
      count(*) FILTER (WHERE a.brand_presence_resolved IS NULL)::int AS fact_null,
      count(*) FILTER (WHERE (a.brand_presence_resolved='branded') <> mir.any_branded)::int AS branded_diverge,
      count(*) FILTER (WHERE (a.brand_presence_resolved='unbranded') <> mir.any_unbranded)::int AS unbranded_diverge
    FROM summary_answers a JOIN mir ON mir.pid=a.prompt_id
    WHERE ${pick("a", c)} AND a.in_full_cycle=1 AND a.in_root_catalog=1 AND a.in_tagged_region=1 AND a.country<>'ID'`);
  await p("base_norm_null 행(도메인 폴백 경로) — 사실표에만 있는 분기", sql`
    SELECT count(*)::int AS rows, COALESCE(sum(citations),0)::int AS citations, count(*) FILTER (WHERE domain IS NOT NULL)::int AS with_domain,
      string_agg(DISTINCT domain, ',') AS domains
    FROM summary_domain_citations d WHERE ${pick("d", c)} AND base_norm_null=1`);
  await p("scope_runs.cycle_anchor_at 충전율(루트)", sql`
    SELECT count(*)::int AS runs, count(cycle_anchor_at)::int AS anchored FROM scope_runs WHERE project_id=${ROOT}::uuid`);
}

// ── 게이트웨이 재현 ─────────────────────────────────────────────────────────
type Grid = { name: string; filters: StandardFilters };
const HY_EU = countriesForRhq("hyundai-europe");
const GRIDS: Grid[] = [
  { name: "①admin-nofilter", filters: {} },
  { name: "②brand=Hyundai", filters: { brand: ["Hyundai"] } },
  { name: "③brand=Kia+US", filters: { brand: ["Kia"], region: ["US"] } },
  { name: "④engine=chatgpt", filters: { engine: ["chatgpt"] } },
  { name: "⑤lang=en", filters: { lang: ["en"] } },
  { name: "⑥funnel=비교/검증", filters: { funnelStage: ["비교/검증"] } },
  { name: "⑦depth1=1", filters: { depth1: [process.env.DEPTH1 ?? "__set_DEPTH1__"] } },
  { name: "⑧presence=branded", filters: { brandPresence: ["branded"] } },
  { name: "⑨presence=both", filters: { brandPresence: ["branded", "unbranded"] } },
  // RHQ 계정(region role) — readStandardFilters: brand=[락, HMG], region=권역 국가 전개
  { name: "⑩rhq=hyundai-europe", filters: { brand: ["Hyundai", UMBRELLA_BRAND], region: HY_EU } },
];
if (process.env.EXTRA) for (const g of JSON.parse(process.env.EXTRA) as Grid[]) GRIDS.push(g);

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
// lib/scope/server.ts:728-734 그대로
const scopeOwnedPrefixes = (f: StandardFilters): string[] =>
  ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.websiteCountry ?? f.region, f.lang);

const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
const pct = (a: number, b: number) => (b > 0 ? r1((100 * a) / b) : null);
const t = async <T>(fn: () => Promise<T>): Promise<[T, number]> => { const s = performance.now(); const v = await fn(); return [v, Math.round(performance.now() - s)]; };

function foldSources(s: { domain: string; citations: number; share: number; isOurs: boolean }[]) {
  const top = s.slice(0, 7), rest = s.slice(7);
  const out: Record<string, unknown> = {};
  for (const d of top) out[d.domain] = `${d.citations}|${d.share}|${d.isOurs ? "ours" : ""}`;
  out["기타"] = `${rest.reduce((a, b) => a + b.citations, 0)}|${r1(rest.reduce((a, b) => a + b.share, 0))}`;
  out["_total"] = s.reduce((a, b) => a + b.citations, 0);
  out["_domains"] = s.length;
  out["_ours"] = s.filter((d) => d.isOurs).length;
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
type Sub = Awaited<ReturnType<typeof summaryGlobalSubKpis>>;
function snapOf(agg: StandardAggregates | null, sub: Sub, topics: { topic: string | null; prompts: number }[],
  src: Parameters<typeof foldSources>[0], geo: Parameters<typeof foldGeo>[0]) {
  const trackedMentions = agg?.brands.filter((b) => b.isTracked).reduce((s, b) => s + b.mentionCount, 0) ?? 0;
  const kpi = agg ? {
    asOf: agg.asOf, asOfBadge: agg.asOf?.slice(0, 10) ?? null, totalAnswers: agg.totalAnswers, tracked: agg.trackedAnswerCount,
    "①노출률%": pct(agg.trackedAnswerCount, agg.totalAnswers),
    totalMentions: agg.totalMentions, trackedMentions, "②점유율%": pct(trackedMentions, agg.totalMentions),
    "③긍정률%": agg.sentiment.positiveRate, posM: agg.sentiment.positiveMentions, sampM: agg.sentiment.sampledMentions,
    "④평균순위": agg.position.avgPosition, posSampled: agg.position.sampledAnswers,
    citTotal: agg.citations.totalCitations, citOwned: agg.citations.ownedCitations, "⑤자사인용%": pct(agg.citations.ownedCitations, agg.citations.totalCitations),
    withCit: agg.citations.answersWithCitation, domains: agg.citations.domains.length,
    ownedDomainSum: agg.citations.domains.reduce((s, d) => s + d.ownedCitationCount, 0),
    oursDomains: agg.citations.domains.filter((d) => d.isOurs).length, brandsN: agg.brands.length,
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
  return { kpi, regions, brands, engines, topics: tp, sources: foldSources(src), geo: foldGeo(geo) };
}
function diff(label: string, a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = JSON.stringify(a[k] ?? null), vb = JSON.stringify(b[k] ?? null);
    if (va !== vb) out.push(`${label}.${k}: fact=${va} mirror=${vb}`);
  }
  return out;
}

async function prepare() {
  await Promise.all([
    columnAvailable("scope_citations", "url_norm"),
    columnAvailable("scope_prompts", "is_korean"),
    columnAvailable("scope_prompts", "regions"),
  ]);
  const roster = await entityRegistryRepository.listOwn();
  const rootId = getStandardRootId();
  if (!rootId) throw new Error("getStandardRootId() null — SCOPE_MODE/SCOPE_ROOT_PROJECT_ID 확인");
  return { ownEntities: roster.length ? roster : undefined, rootId };
}

async function parity() {
  const { ownEntities, rootId } = await prepare();
  const win = WINDOW ? WIN : {};
  const cycle = await pickGlobalCycle(rootId);
  console.log(`\n# parity mode: ${WINDOW ? `WINDOW(미러 dateFrom=${WIN.dateFrom},dateTo=${WIN.dateTo})` : "PROD(미러 창 없음 = now()-7d)"} · root=${rootId} · cycle=${cycle?.cycleId} gen=${cycle?.generationId} anchor=${cycle?.cycleAnchorAt} week=${cycle?.cycleWeek}`);
  if (!cycle) { console.log("회차 없음"); return; }
  console.log(`openCycle(gate)=${await hasOpenCycle([cycle.projectId])}`);
  const results: Array<Record<string, unknown>> = [];
  for (const g of GRIDS) {
    if (ONLY && !ONLY.has(g.name)) continue;
    const f = normalizeFilters({ ...g.filters, ...win, ownEntities });
    const route = await resolveGlobalSummaryRoute(rootId, f, "S1.dashboard");
    const own = scopeOwnedPrefixes(f);
    const scope: SummaryGlobalScope = { cycle, rootProjectId: rootId, filters: f, ownedBasePrefixes: own };
    console.log(`\n## ${g.name}  route=${summaryRouteHeaderValue(route)}  $sel=${own.length}${own.length <= 6 ? " " + JSON.stringify(own) : ""}`);
    const ms: Record<string, number> = {};
    const [fa, t1] = await t(() => summaryGlobalAggregates(scope)); ms.f_agg = t1;
    const [fs, t2] = await t(() => summaryGlobalSubKpis(scope)); ms.f_sub = t2;
    const [ft, t3] = await t(() => summaryGlobalPromptTopics(scope)); ms.f_topics = t3;
    const [fc, t4] = await t(() => summaryGlobalSourceComposition(scope)); ms.f_src = t4;
    const [fg, t5] = await t(() => summaryGlobalGeoCompetition(scope)); ms.f_geo = t5;
    // 미러 — withStandardRoot 와 같은 요청단위 공유 답변셋 스코프 안에서 순차 호출
    const M = await withSnapshotAnswerSetScope(createSnapshotAnswerSetStore(), async () => {
      const [ma, m1] = await t(() => aggregateStandardFromMirror(f, undefined, own)); ms.m_agg = m1;
      const [msb, m2] = await t(() => aggregateSubKpisFromMirror(f, undefined, own)); ms.m_sub = m2;
      const [mt, m3] = await t(() => aggregatePromptTopicFromMirror(f)); ms.m_topics = m3;
      const [mc, m4] = await t(() => aggregateSourceCompositionFromMirror(f, undefined, own)); ms.m_src = m4;
      const [mg, m5] = await t(() => aggregateGeoCompetitionFromMirror(f)); ms.m_geo = m5;
      return snapOf(ma, msb, mt, mc, mg);
    });
    const F = snapOf(fa, fs, ft, fc, fg);
    const diffs = [
      ...diff("kpi", F.kpi, M.kpi), ...diff("regions", F.regions, M.regions), ...diff("brands", F.brands, M.brands),
      ...diff("engines", F.engines, M.engines), ...diff("topics", F.topics, M.topics), ...diff("sources", F.sources, M.sources),
      ...diff("geo", F.geo, M.geo),
    ];
    console.log("   FACT kpi:", JSON.stringify(F.kpi));
    console.log("   MIRR kpi:", JSON.stringify(M.kpi));
    console.log("   FACT engines:", JSON.stringify(F.engines));
    console.log("   MIRR engines:", JSON.stringify(M.engines));
    console.log("   FACT topics:", JSON.stringify(F.topics), " MIRR:", JSON.stringify(M.topics));
    console.log("   FACT sources:", JSON.stringify(F.sources));
    console.log("   MIRR sources:", JSON.stringify(M.sources));
    console.log("   FACT geo:", JSON.stringify(F.geo));
    console.log("   MIRR geo:", JSON.stringify(M.geo));
    console.log("   FACT regions:", JSON.stringify(F.regions));
    console.log("   MIRR regions:", JSON.stringify(M.regions));
    console.log("   FACT brands:", JSON.stringify(F.brands));
    console.log("   MIRR brands:", JSON.stringify(M.brands));
    console.log("   ms:", JSON.stringify(ms));
    console.log(diffs.length ? `   ✗ DIFF ${diffs.length}건:\n     ${diffs.join("\n     ")}` : "   ✓ 전 항목 일치");
    results.push({ grid: g.name, route: summaryRouteHeaderValue(route), diffs: diffs.length,
      fact_ms: Object.entries(ms).filter(([k]) => k.startsWith("f_")).reduce((s, [, v]) => s + v, 0),
      mirror_ms: Object.entries(ms).filter(([k]) => k.startsWith("m_")).reduce((s, [, v]) => s + v, 0) });
  }
  console.log("\n# summary"); table(results);
}

// ── rebut — 반박 지점 전용 프로브 ─────────────────────────────────────────────
async function rebut() {
  const c = await activeCycle();
  const G = sql`${pick("a", c)} AND a.in_full_cycle=1 AND a.in_root_catalog=1 AND a.in_tagged_region=1 AND a.country<>'ID' AND a.run_status IN ('completed','partial_failed')`;
  // #1 같은 호스트에 base 여럿 + 루트 홈 인용 → (country, lang, brand) 슬라이스
  const multi = new Map<string, string[]>();
  for (const b of GEO_OWNED_BASES) { const h = b.prefix.split("/")[0]; if (!SHARED_GLOBAL_HOSTS.has(h)) multi.set(h, [...(multi.get(h) ?? []), b.prefix]); }
  const multiHosts = [...multi.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n## #1 다중 base 호스트(비공유) ${multiHosts.length}개:`, multiHosts.map(([h, v]) => `${h}→[${v.join(",")}]`).join(" · "));
  await p("#1 회차 루트 홈 인용(사실표 matched_base=호스트 최단 base) — 답변 슬라이스별", sql`
    WITH bases AS (SELECT unnest(${sql.param(GEO_OWNED_BASE_PREFIXES)}::text[]) AS b),
    hosts AS (SELECT split_part(b,'/',1) AS h, count(*)::int AS n, min(b) AS shortest FROM bases GROUP BY 1 HAVING count(*)>1),
    cit AS (
      SELECT d.job_id, d.matched_base, d.citations, a.country, a.lang, a.catalog_brands, a.engine
      FROM summary_domain_citations d JOIN summary_answers a ON a.job_id=d.job_id AND a.cycle_id=d.cycle_id AND a.generation_id=d.generation_id AND a.cycle_week=d.cycle_week
      WHERE ${pick("d", c)} AND ${G} AND d.matched_base <> ''
    ),
    root_home AS (
      SELECT c2.job_id, c2.url, c2.domain, a.country, a.lang, a.catalog_brands, split_part(citation_url_base_norm(c2.url),'/',1) AS host
      FROM scope_citations c2 JOIN summary_answers a ON a.job_id=c2.job_id
      WHERE ${G} AND c2.url IS NOT NULL
        AND citation_url_base_norm(c2.url) = split_part(citation_url_base_norm(c2.url),'/',1)
        AND split_part(citation_url_base_norm(c2.url),'/',1) IN (SELECT h FROM hosts)
    )
    SELECT rh.host, rh.country, rh.lang, array_to_string(rh.catalog_brands,'+') AS brands, count(*)::int AS root_home_citations, count(DISTINCT rh.job_id)::int AS jobs,
      (SELECT string_agg(b, ',') FROM bases WHERE split_part(b,'/',1)=rh.host) AS host_bases
    FROM root_home rh GROUP BY 1,2,3,4 ORDER BY 5 DESC LIMIT 20`);
  // #2 brand × depth1 결합 갈림 — 셀 단위로 (brand, depth1) 조합별 미러≠사실표
  await p("#2 brand×depth1: 미러(한 행 동시 만족) vs 사실표(brand any-match ∧ depth1 최신행) 갈리는 조합", sql`
    WITH cat AS (SELECT scope_prompt_id AS pid, brand, depth1 FROM prompts WHERE project_id=${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL),
    combos AS (SELECT DISTINCT brand, depth1 FROM cat WHERE brand IS NOT NULL AND depth1 IS NOT NULL),
    g AS (SELECT a.prompt_id, a.catalog_brands, a.depth1, count(*)::int AS cells FROM summary_answers a WHERE ${G} GROUP BY 1,2,3),
    j AS (
      SELECT co.brand, co.depth1, g.prompt_id, g.cells,
        EXISTS (SELECT 1 FROM cat WHERE cat.pid=g.prompt_id AND cat.brand=co.brand AND cat.depth1=co.depth1) AS mirror_in,
        (co.brand = ANY(g.catalog_brands) AND g.depth1 = co.depth1) AS fact_in
      FROM combos co JOIN g ON true)
    SELECT brand, depth1, count(DISTINCT prompt_id) FILTER (WHERE mirror_in<>fact_in)::int AS prompts_diverge,
      sum(cells) FILTER (WHERE mirror_in<>fact_in)::int AS cells_diverge,
      sum(cells) FILTER (WHERE mirror_in)::int AS mirror_cells, sum(cells) FILTER (WHERE fact_in)::int AS fact_cells
    FROM j GROUP BY 1,2 HAVING count(*) FILTER (WHERE mirror_in<>fact_in) > 0 ORDER BY 4 DESC LIMIT 15`);
  await p("#2b brand 단독·depth1 단독·funnel 단독: any-match(미러) vs 최신행(사실표) 갈림", sql`
    WITH cat AS (SELECT scope_prompt_id AS pid, brand, depth1, funnel_stage, brand_presence, updated_at FROM prompts WHERE project_id=${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL),
    g AS (SELECT a.prompt_id, a.catalog_brands, a.depth1, a.funnel_catalog, count(*)::int AS cells FROM summary_answers a WHERE ${G} GROUP BY 1,2,3,4),
    d1 AS (SELECT DISTINCT depth1 AS v FROM cat WHERE depth1 IS NOT NULL),
    fs AS (SELECT DISTINCT funnel_stage AS v FROM cat WHERE funnel_stage IS NOT NULL)
    SELECT 'depth1' AS axis, d1.v AS value,
      sum(g.cells) FILTER (WHERE EXISTS (SELECT 1 FROM cat WHERE cat.pid=g.prompt_id AND cat.depth1=d1.v) <> (g.depth1=d1.v))::int AS cells_diverge
    FROM d1 JOIN g ON true GROUP BY 1,2 HAVING sum(g.cells) FILTER (WHERE EXISTS (SELECT 1 FROM cat WHERE cat.pid=g.prompt_id AND cat.depth1=d1.v) <> (g.depth1=d1.v)) > 0
    UNION ALL
    SELECT 'funnel', fs.v,
      sum(g.cells) FILTER (WHERE EXISTS (SELECT 1 FROM cat WHERE cat.pid=g.prompt_id AND cat.funnel_stage=fs.v) <> (g.funnel_catalog=fs.v))::int
    FROM fs JOIN g ON true GROUP BY 1,2 HAVING sum(g.cells) FILTER (WHERE EXISTS (SELECT 1 FROM cat WHERE cat.pid=g.prompt_id AND cat.funnel_stage=fs.v) <> (g.funnel_catalog=fs.v)) > 0
    ORDER BY 3 DESC`);
  // #3 in_full_cycle — 사실표 게이트 없이 vs 있이 (미러가 게이트를 안 쓰면 이 차이가 화면 차이)
  await p("#3 in_full_cycle 게이트 효과(사실표 자체)", sql`
    SELECT count(*)::int AS cells_all_gates,
      (SELECT count(*) FROM summary_answers a WHERE ${pick("a", c)} AND in_root_catalog=1 AND in_tagged_region=1 AND country<>'ID' AND run_status IN ('completed','partial_failed'))::int AS cells_without_fc,
      (SELECT count(DISTINCT prompt_id) FROM summary_answers a WHERE ${pick("a", c)} AND in_full_cycle=0 AND in_root_catalog=1)::int AS prompts_failing_fc
    FROM summary_answers a WHERE ${G}`);
  // #4 브랜드 표 mixed-pass 그룹(사실표 is_competitor=1 행에 비통과 mention 이 합산됐는가)
  await p("#4a 브랜드 그룹 mixed pass(원본 재계산)", sql`
    WITH names AS (SELECT DISTINCT ON (entity_id) entity_id, brand FROM scope_mentions WHERE entity_type='Brand' AND brand IS NOT NULL ORDER BY entity_id, (brand ~ '^[A-Za-z]') DESC, brand)
    SELECT count(*)::int AS mixed_groups, COALESCE(sum(nonpass),0)::int AS nonpass_mentions_in_competitor_rows FROM (
      SELECT b.job_id, b.brand_id, b.brand_name, b.mentions,
        b.mentions - (SELECT COALESCE(sum(m.mention_count),0) FROM scope_mentions m LEFT JOIN names n ON n.entity_id = m.brand_rollup_entity_id
                       WHERE m.job_id=b.job_id AND m.brand_rollup_entity_id IS NOT NULL) AS nonpass
      FROM summary_brand_mentions b WHERE ${pick("b", c)} AND b.is_competitor=1 AND lower(btrim(b.brand_name)) IN ('smart','cruise','international')
    ) x WHERE nonpass <> 0`);
  await p("#4b 도메인 케이싱 변형(미러는 c.domain 원문 GROUP, 사실표는 group_key=lower)", sql`
    SELECT count(*)::int AS lower_groups_with_variants, COALESCE(sum(n),0)::int AS variant_rows FROM (
      SELECT lower(c.domain) AS ld, count(DISTINCT c.domain)::int AS n
      FROM scope_citations c JOIN summary_answers a ON a.job_id=c.job_id WHERE ${G} AND c.domain IS NOT NULL
      GROUP BY 1 HAVING count(DISTINCT c.domain) > 1) x`);
  await p("#4c 사실표 도메인 행: group_key 가 domain 과 다른 행(공식 소셜 계정 키)", sql`
    SELECT count(*)::int AS rows, COALESCE(sum(citations),0)::int AS citations, string_agg(DISTINCT domain, ',') AS domains
    FROM summary_domain_citations d WHERE ${pick("d", c)} AND d.domain IS NOT NULL AND d.group_key <> lower(d.domain)`);
  await p("#4d 숨김 국가 ID 셀: 사실표 in_full_cycle 값 분포", sql`
    SELECT country, in_full_cycle, count(*)::int AS cells FROM summary_answers a WHERE ${pick("a", c)} AND country='ID' GROUP BY 1,2`);
  await p("#4e 언어: scope_prompts.lang 소문자/혼합 존재 여부 + 회차 셀 lang 분포", sql`
    SELECT lang, count(*)::int AS cells FROM summary_answers a WHERE ${G} GROUP BY 1 ORDER BY 2 DESC`);
  await p("#4f brand_presence: 사실표 NULL 셀의 미러 해석(COALESCE→brand 유래) 분포 / 비NULL 셀의 any-match 불일치", sql`
    WITH mir AS (
      SELECT scope_prompt_id AS pid,
        bool_or(COALESCE(brand_presence, CASE WHEN brand=${UMBRELLA_BRAND} THEN 'unbranded' WHEN brand IS NOT NULL THEN 'branded' END)='branded') AS any_branded,
        bool_or(COALESCE(brand_presence, CASE WHEN brand=${UMBRELLA_BRAND} THEN 'unbranded' WHEN brand IS NOT NULL THEN 'branded' END)='unbranded') AS any_unbranded,
        string_agg(DISTINCT brand, '+') AS brands
      FROM prompts WHERE project_id=${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL GROUP BY 1)
    SELECT COALESCE(a.brand_presence_resolved, 'NULL') AS fact_resolved, mir.any_branded, mir.any_unbranded, count(*)::int AS cells, count(DISTINCT a.prompt_id)::int AS prompts,
      string_agg(DISTINCT mir.brands, ',') AS brands
    FROM summary_answers a JOIN mir ON mir.pid=a.prompt_id WHERE ${G}
    GROUP BY 1,2,3 ORDER BY 4 DESC`);
  await p("#3b 회차 run 시작 범위 — 라이브 7d 창이 회차 run 을 잃기 시작하는 시각", sql`
    SELECT min(r.started_at)::text AS mem_min_started, max(r.started_at)::text AS mem_max_started,
      (min(r.started_at) + interval '7 days')::text AS live_window_drops_from, now()::text AS now
    FROM scope_runs r JOIN summary_cycle_runs cr ON cr.run_id=r.run_id WHERE cr.cycle_id=${c.cycle_id}::uuid AND r.status IN ('completed','partial_failed')`);
  // #5 asOf
  await p("#5 asOf: 사실표 anchor vs 미러 max(COALESCE(cycle_anchor_at, measured_at)) — 국가별", sql`
    WITH mem AS (SELECT run_id FROM summary_cycle_runs WHERE cycle_id=${c.cycle_id}::uuid)
    SELECT a.country, ${c.anchor} AS fact_anchor,
      max(COALESCE(r.cycle_anchor_at, a2.measured_at))::text AS mirror_asof, max(a2.measured_at)::text AS max_measured,
      substr((max(COALESCE(r.cycle_anchor_at, a2.measured_at)) AT TIME ZONE 'UTC')::text, 1, 10) AS mirror_badge_utc,
      count(*) FILTER (WHERE r.cycle_anchor_at IS NOT NULL)::int AS cells_anchored, count(*)::int AS cells
    FROM summary_answers a JOIN scope_answers a2 ON a2.job_id=a.job_id JOIN scope_runs r ON r.run_id=a2.run_id
    WHERE ${G} GROUP BY 1 ORDER BY 1`);
}

// ── explain ─────────────────────────────────────────────────────────────────
async function explain() {
  const { ownEntities, rootId } = await prepare();
  const cycle = (await pickGlobalCycle(rootId))!;
  const uuidArr = (v: string[]) => sql`ARRAY[${sql.join(v.map((x) => sql`${x}`), sql`, `)}]::uuid[]`;
  const run = async (label: string, q: SQL) => {
    const plan = await rows<{ "QUERY PLAN": string }>(sql`EXPLAIN (ANALYZE, BUFFERS, SUMMARY) ${q}`);
    const lines = plan.map((r) => r["QUERY PLAN"]);
    console.log(`\n## EXPLAIN ${label}`);
    console.log(lines.slice(0, 4).join("\n")); console.log("   …");
    console.log(lines.filter((l) => /Execution Time|Planning Time|Seq Scan on|Partitions removed|Subplans Removed|Buffers: shared hit=\d+ read=\d+|Rows Removed by Filter: [1-9]\d{4,}/.test(l)).slice(0, 25).join("\n"));
    console.log(lines.slice(-2).join("\n"));
  };
  const grids: Array<[string, StandardFilters]> = [["무필터", {}], ["brand=Hyundai", { brand: ["Hyundai"] }], ["Kia+US", { brand: ["Kia"], region: ["US"] }]];
  for (const [name, gf] of grids) {
    const f = normalizeFilters({ ...gf, ownEntities });
    const own = scopeOwnedPrefixes(f);
    const s: SummaryGlobalScope = { cycle, rootProjectId: rootId, filters: f, ownedBasePrefixes: own };
    const W = __testables.answerWhere(s), F = __testables.factScope(s);
    const ownIds = ownEntities?.map((e) => e.id) ?? [];
    await run(`${name} 사실표 KPI① ansRows`, sql`WITH a AS (SELECT job_id, country, monitored FROM summary_answers WHERE ${W}),
      o AS (SELECT DISTINCT job_id FROM summary_brand_mentions WHERE ${F} AND brand_id = ANY(${uuidArr(ownIds)}))
      SELECT COALESCE(a.country,'UNKNOWN') AS region, COALESCE(sum(a.monitored),0)::int AS answers, count(*) FILTER (WHERE o.job_id IS NOT NULL)::int AS tracked
      FROM a LEFT JOIN o ON o.job_id = a.job_id GROUP BY 1 ORDER BY 1`);
    await run(`${name} 사실표 ⑤ citAgg`, sql`SELECT COALESCE(sum(citations),0)::int AS total,
      COALESCE(sum(citations) FILTER (WHERE ${__testables.ownedCitationExpr(own)}),0)::int AS owned, count(DISTINCT job_id) FILTER (WHERE citations>0)::int AS with_cit
      FROM summary_domain_citations WHERE ${F}`);
    await run(`${name} 사실표 GEO`, sql`SELECT country AS code, brand_name AS brand, COALESCE(sum(mentions),0)::int AS mentions, bool_or(brand_id = ANY(${uuidArr(ownIds)})) AS is_tracked
      FROM summary_brand_mentions WHERE ${F} AND is_competitor = 1 AND country IS NOT NULL GROUP BY 1, 2`);
    await run(`${name} 미러 W(답변셋 확정, now()-7d)`, sql`SELECT a.job_id FROM scope_answers a WHERE ${mirrorAnswerWhere(f, undefined)}`);
    await run(`${name} 미러 W(회차 창 고정)`, sql`SELECT a.job_id FROM scope_answers a WHERE ${mirrorAnswerWhere({ ...f, ...WIN }, undefined)}`);
  }
}

async function main() {
  if (mode === "probe") await probe();
  else if (mode === "parity") await parity();
  else if (mode === "rebut") await rebut();
  else if (mode === "explain") await explain();
  else if (mode === "sql") { await p("SQL", sql.raw(process.env.SQL!)); }
  else throw new Error(`unknown mode ${mode}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
