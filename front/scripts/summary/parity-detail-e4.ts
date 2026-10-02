/**
 * T10 · E4 세부층 폴백 경로 패리티/타이밍 하네스 — 쓰기 0, 읽기만.
 *
 * `planTrendRead` 가 거부하는 축(admin 임의 브랜드 조합 = `unsupported-agg:own-variant`,
 * `depth2`/`depth3`)은 집계층이 아니라 **세부층 사실표**로 폴백한다(`onDetail`).
 * 그 폴백 리더가 내는 **화면 객체 전체**를 스냅샷으로 떠서, 조인 제거 전후가
 * **정수 0 오차**인지 본다.
 *
 * 사용 (같은 명령을 조인 제거 **전 커밋**과 **후 커밋**에서 각각 한 번씩):
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-detail-e4.ts --out=<파일>
 *   # 대조
 *   npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-detail-e4.ts --diff <before> <after>
 *
 * 스냅샷에는 값(`v`)과 시간(`ms`)이 따로 들어간다 — `--diff` 는 **값만** 대조하고
 * 시간은 표로 나란히 찍는다(시간은 실행마다 흔들리는 값이라 판정에 쓰지 않는다).
 */
process.env.DB_POOL_MAX ??= "4";
import { writeFileSync, readFileSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { entityRegistryRepository } from "@/lib/db/repositories/entity-registry";
import { getProjectIdsForScope } from "@/lib/db/repositories/website-sites";
import { narrowScopeBrands, ownedBasePrefixesForScope, trackedEntityIdsFor } from "@/lib/scope/hmg-brands";
import { websiteDeclaredOwnedBases } from "@/lib/db/repositories/scope-aggregates";
import { pickWebsiteCycles, type SummaryCyclePick } from "@/lib/db/repositories/summary-cycles";
import { summaryUnitFlagsAvailable, websiteExcludedUnits } from "@/lib/db/repositories/summary-settings";
import {
  summaryGlobalAggregates,
  summaryGlobalSubKpis,
  summaryGlobalPromptTopics,
  summaryGlobalSourceComposition,
  summaryGlobalGeoCompetition,
  __testables as globalTestables,
  type SummaryGlobalScope,
} from "@/lib/db/repositories/summary-global-aggregates";
import {
  summaryWebsiteAggregatesDetail,
  summaryWebsiteSubKpisDetail,
  summaryWebsiteSourceCompositionDetail,
  summaryWebsiteGeoCompetitionDetail,
  __testables as websiteTestables,
  type SummaryWebsiteScope,
} from "@/lib/db/repositories/summary-website-aggregates";
import type { StandardFilters, StandardAggregates } from "@/lib/scope/result-adapter";
import type { StandardSubKpis, SourceDomainSlice, GeoBrandMention, PromptTopicSlice } from "@/lib/db/repositories/scope-aggregates";
import type { AllowedScope } from "@/lib/auth/types";

/* eslint-disable no-console */
const argv = process.argv.slice(2);
const OUT = argv.find((a) => a.startsWith("--out="))?.slice("--out=".length);
const DIFF = argv[0] === "--diff" ? [argv[1], argv[2]] : null;
const EXPLAIN = argv[0] === "--explain";

type Case = { name: string; filters: StandardFilters; brand?: string[] };

/** 글로벌 격자 — E4(admin 다중)·depth2/3·오타 락이 핵심이고 나머지는 회귀 그물이다. */
const GLOBAL_CASES: Case[] = [
  { name: "G-무필터(admin)", filters: {} },
  { name: "G-E4 admin 다중 Hyundai,Kia", filters: { brand: ["Hyundai", "Kia"] } },
  { name: "G-E4 admin 다중 3사", filters: { brand: ["Hyundai", "Kia", "Genesis"] } },
  { name: "G-R2 오타 락 HYNDAI,KIA", filters: { brand: ["HYNDAI", "KIA"] } },
  { name: "G-브랜드 락 Kia", filters: { brand: ["Kia"] } },
  { name: "G-depth2 Action_Pricing Plan", filters: { depth2: ["Action_Pricing Plan"] } },
  { name: "G-depth3 Design", filters: { depth3: ["Design"] } },
  { name: "G-국가 KR + 언어 KO", filters: { region: ["KR"], lang: ["KO"] } },
  { name: "G-국가 다중 KR,US,DE", filters: { region: ["KR", "US", "DE"] } },
  { name: "G-엔진 chatgpt", filters: { engine: ["chatgpt"] } },
  { name: "G-brandPresence branded", filters: { brandPresence: ["branded"] } },
];

/** 웹사이트 격자 — 폴백 4종(`summaryWebsite*Detail`)이 도는 축. */
const WEBSITE_CASES: Case[] = [
  { name: "W-무필터(admin)", filters: {} },
  { name: "W-브랜드 Hyundai", brand: ["Hyundai"], filters: {} },
  { name: "W-브랜드 Kia + DE", brand: ["Kia"], filters: { websiteCountry: ["DE"] } },
  { name: "W-국가 worldwide", filters: { websiteCountry: ["worldwide"] } },
  { name: "W-엔진 chatgpt", filters: { engine: ["chatgpt"] } },
];

const t = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const s = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - s)];
};

/**
 * 화면 객체 → 대조용 평면 스냅샷. 비율은 쓰지 않는다(분자·분모 정수로 환원).
 *
 * ⚠️ `brands`·`domains` 는 `.sort()` 로 접는다 — 따라서 이 하네스의 판정은 **집합
 * (원소·값) 동치**이지 **행 순서 동치가 아니다**(T11 검증 F1). 순서까지 봐야 하는
 * 것은 리더 쪽에서 결정적 `ORDER BY` 로 고정한다(② 브랜드 타일 = `mentions DESC, name`).
 * `regions` 만 서버 순서를 그대로 둔다(`ORDER BY 1` 이 결정적이라 대조 가치가 있다).
 */
function foldAggregates(g: StandardAggregates | null): Record<string, unknown> {
  if (!g) return { null: true };
  return {
    totalAnswers: g.totalAnswers,
    trackedAnswerCount: g.trackedAnswerCount,
    totalMentions: g.totalMentions,
    ownPositive: g.sentiment.positiveMentions,
    ownSignals: g.sentiment.sampledMentions,
    positiveRate: g.sentiment.positiveRate,
    avgPosition: g.position.avgPosition,
    rankedAnswers: g.position.sampledAnswers,
    citTotal: g.citations.totalCitations,
    citOwned: g.citations.ownedCitations,
    withCitation: g.citations.answersWithCitation,
    sampledAnswers: g.citations.sampledAnswers,
    asOf: g.asOf,
    regions: g.regions.map((r) => `${r.region}:${r.answerCount}/${r.trackedAnswerCount}`),
    brands: g.brands.map((b) => `${b.name}:${b.mentionCount}/${b.answerCount}${b.isTracked ? "*" : ""}`).sort(),
    domains: g.citations.domains
      .map((d) => `${d.host}:${d.citingAnswers}/${d.citationCount}/${d.ownedCitationCount}${d.isOurs ? "*" : ""}`)
      .sort(),
  };
}

function foldSubKpis(s: StandardSubKpis): Record<string, unknown> {
  return {
    promptsWithoutBrand: s.promptsWithoutBrand,
    measuredPrompts: s.measuredPrompts,
    rows: [...s.rows]
      .sort((a, b) => a.engine.localeCompare(b.engine))
      .map(
        (r) =>
          `${r.engine}|ans${r.answers}|trk${r.tracked}|multi${r.multi}|t1:${r.top1}|t3:${r.top3}|pos${r.avgPosition}` +
          `|men${r.totalMentions}/${r.trackedMentions}|sig${r.sentMentions}+${r.positiveMentions}-${r.negativeMentions}` +
          `|cit${r.citTotal}/${r.citOwned}`,
      ),
  };
}

const foldSources = (s: SourceDomainSlice[]): Record<string, unknown> => ({
  rows: s.map((d) => `${d.domain}:${d.citations}:${d.share}${d.isOurs ? "*" : ""}`).sort(),
  total: s.reduce((a, b) => a + b.citations, 0),
});
const foldGeo = (g: GeoBrandMention[]): Record<string, unknown> => ({
  rows: g.map((x) => `${x.code}·${x.brand}:${x.mentions}${x.isTracked ? "*" : ""}`).sort(),
  sum: g.reduce((a, b) => a + b.mentions, 0),
});
const foldTopics = (tp: PromptTopicSlice[]): Record<string, unknown> => ({
  rows: tp.map((x) => `${x.topic ?? "null"}:${x.prompts}`).sort(),
  sum: tp.reduce((a, b) => a + b.prompts, 0),
});

async function globalScopeOf(): Promise<Omit<SummaryGlobalScope, "filters" | "ownedBasePrefixes">> {
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text
    FROM summary_cycles
    WHERE surface = 'global' AND active_generation_id IS NOT NULL
    ORDER BY cycle_anchor_at DESC LIMIT 1
  `)) as unknown as Array<{
    cycle_id: string; generation_id: string; project_id: string;
    cycle_anchor_at: string; cycle_week: string;
  }>;
  const r = rows[0];
  if (!r) throw new Error("활성 generation 이 있는 global 회차가 없다");
  const cycle: SummaryCyclePick = {
    cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
  };
  return { cycle, rootProjectId: r.project_id };
}

async function run(): Promise<void> {
  const roster = await entityRegistryRepository.listOwn();
  const ownEntities = roster.length ? roster : undefined;
  const snap: Record<string, { v: Record<string, unknown>; ms: Record<string, number> }> = {};

  // ── 글로벌 세부층 6문장 리더 ───────────────────────────────────────────────
  const base = await globalScopeOf();
  for (const c of GLOBAL_CASES) {
    const f: StandardFilters = { ...c.filters, ownEntities };
    const scope: SummaryGlobalScope = {
      ...base,
      filters: f,
      ownedBasePrefixes: ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.region, f.lang),
    };
    const ms: Record<string, number> = {};
    const [agg, m1] = await t(() => summaryGlobalAggregates(scope)); ms.agg = m1;
    const [sub, m2] = await t(() => summaryGlobalSubKpis(scope)); ms.sub = m2;
    const [tp, m3] = await t(() => summaryGlobalPromptTopics(scope)); ms.topics = m3;
    const [src, m4] = await t(() => summaryGlobalSourceComposition(scope)); ms.src = m4;
    const [geo, m5] = await t(() => summaryGlobalGeoCompetition(scope)); ms.geo = m5;
    ms.total = Object.values(ms).reduce((a, b) => a + b, 0);
    snap[c.name] = {
      v: { agg: foldAggregates(agg), sub: foldSubKpis(sub), topics: foldTopics(tp), src: foldSources(src), geo: foldGeo(geo) },
      ms,
    };
    console.log(`· ${c.name}  ${JSON.stringify(ms)}`);
  }

  // ── 웹사이트 세부층 폴백 4종 ──────────────────────────────────────────────
  const [unitFlags, excludedUnits] = await Promise.all([summaryUnitFlagsAvailable(), websiteExcludedUnits()]);
  const cycleProjects = new Set(
    ((await getDb().execute(sql`
      SELECT project_id::text AS pid FROM summary_cycles WHERE surface='website' AND active_generation_id IS NOT NULL
    `)) as unknown as Array<{ pid: string }>).map((r) => r.pid),
  );
  for (const c of WEBSITE_CASES) {
    const eff = narrowScopeBrands({ all: true } as AllowedScope, c.brand);
    const ids = (await getProjectIdsForScope(eff)).filter((id) => cycleProjects.has(id));
    const picked = await pickWebsiteCycles(ids);
    if (!picked?.cycles.length) { console.log(`· ${c.name} → 회차 없음, 건너뜀`); continue; }
    const cycles = picked.cycles;
    const f: StandardFilters = {
      ...c.filters,
      ownEntities,
      contextBrand: eff.all ? undefined : eff.brands,
    };
    const declared = await websiteDeclaredOwnedBases(f, ids);
    const prefixes = declared.prefixes.length
      ? declared.prefixes
      : ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.websiteCountry ?? f.region, f.lang);
    const scope: SummaryWebsiteScope = { cycles, projectIds: ids, filters: f, ownedBasePrefixes: prefixes, unitFlags, excludedUnits };
    const ms: Record<string, number> = {};
    const [agg, m1] = await t(() => summaryWebsiteAggregatesDetail(scope)); ms.agg = m1;
    const [sub, m2] = await t(() => summaryWebsiteSubKpisDetail(scope)); ms.sub = m2;
    const [src, m3] = await t(() => summaryWebsiteSourceCompositionDetail(scope)); ms.src = m3;
    const [geo, m4] = await t(() => summaryWebsiteGeoCompetitionDetail(scope)); ms.geo = m4;
    ms.total = Object.values(ms).reduce((a, b) => a + b, 0);
    snap[c.name] = {
      v: { agg: foldAggregates(agg), sub: foldSubKpis(sub), src: foldSources(src), geo: foldGeo(geo) },
      ms,
    };
    console.log(`· ${c.name} (projects=${ids.length}, cycles=${cycles.length}, unitFlags=${unitFlags})  ${JSON.stringify(ms)}`);
  }

  if (OUT) {
    writeFileSync(OUT, JSON.stringify(snap, null, 1));
    console.log(`\n→ ${OUT}`);
  }
}

function diff(): void {
  const [aPath, bPath] = DIFF as [string, string];
  const a = JSON.parse(readFileSync(aPath, "utf8")) as Record<string, { v: unknown; ms: Record<string, number> }>;
  const b = JSON.parse(readFileSync(bPath, "utf8")) as Record<string, { v: unknown; ms: Record<string, number> }>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  let bad = 0;
  const timing: Array<Record<string, unknown>> = [];
  for (const k of keys) {
    const va = JSON.stringify(a[k]?.v ?? null);
    const vb = JSON.stringify(b[k]?.v ?? null);
    if (va !== vb) {
      bad++;
      console.log(`✗ ${k} — 값 불일치`);
      // 어느 절이 어긋났는지만 좁혀 준다(전문 덤프는 파일에 있다).
      const oa = (a[k]?.v ?? {}) as Record<string, unknown>;
      const ob = (b[k]?.v ?? {}) as Record<string, unknown>;
      for (const sec of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
        const sa = JSON.stringify(oa[sec] ?? null);
        const sb = JSON.stringify(ob[sec] ?? null);
        if (sa !== sb) console.log(`    ${sec}:\n      before=${sa.slice(0, 900)}\n      after =${sb.slice(0, 900)}`);
      }
    } else {
      console.log(`✓ ${k}`);
    }
    timing.push({ case: k, before_ms: a[k]?.ms?.total ?? null, after_ms: b[k]?.ms?.total ?? null });
  }
  console.log(`\n판정: ${bad === 0 ? "✓ 전 격자 정수 0 오차" : `✗ ${bad}/${keys.length} 격자 불일치`}`);
  console.table(timing);
  if (bad) process.exitCode = 1;
}

// ── --explain: 조인 제거 전/후 **서버측 실행시간**(EXPLAIN ANALYZE) ──────────
//
// 하네스가 로컬에서 재는 ms 는 Supabase 왕복(문장당 ~300 ms)이 지배해 판정에 못 쓴다.
// 여기서는 같은 술어로 **옛 형태(세미조인)와 새 형태(직접 술어)** 를 각각 EXPLAIN 해
// `Execution Time` 만 뽑는다. 옛 형태는 이 파일에 **동결**해 둔 사본이다(코드에는 없다).
async function explain(): Promise<void> {
  const db = getDb();
  /** 같은 문장을 3회 돌려 **최소값**을 쓴다 — 웜 상태의 하한이 가장 흔들리지 않는다. */
  const ms = async (q: SQL): Promise<number> => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const plan = (await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${q}`)) as unknown as Array<
        Record<string, string>
      >;
      const line = plan.map((r) => Object.values(r)[0] ?? "").find((l) => l.startsWith("Execution Time"));
      runs.push(line ? Number(line.replace(/[^\d.]/g, "")) : NaN);
    }
    return Math.round(Math.min(...runs) * 10) / 10;
  };
  /**
   * 계획에서 **인덱스 이름**만 뽑는다.
   *
   * ⚠️ 두 노드의 문법이 다르다 — `Index Scan using <인덱스> on <테이블>` 은 인덱스가
   * `using` 뒤에 오고, `Bitmap Index Scan on <인덱스>` 는 `on` 뒤가 인덱스다.
   * 하나의 `on (\w+)` 로 뭉뚱그리면 전자에서 **테이블명이 잡힌다**(T11 검증 F2:
   * 웹사이트 분자가 `summary_brand_mentions_20260831, summary_answers_20260831` 로
   * 보고돼 인덱스 판정이 통째로 틀렸다 — 실제로는 `_pkey` + `report_fs` 인덱스였다).
   * Seq Scan 도 함께 표기한다 — "(no index scan)" 이 조용히 나오는 것보다 낫다.
   */
  const idx = async (q: SQL): Promise<string> => {
    const plan = (await db.execute(sql`EXPLAIN (COSTS OFF) ${q}`)) as unknown as Array<Record<string, string>>;
    const names = plan
      .map((r) => Object.values(r)[0] ?? "")
      .flatMap((l) => [
        ...[...l.matchAll(/Index (?:Only )?Scan(?: Backward)? using ([a-z0-9_]+)/g)].map((m) => m[1]!),
        ...[...l.matchAll(/Bitmap Index Scan on ([a-z0-9_]+)/g)].map((m) => m[1]!),
        ...[...l.matchAll(/(?:Parallel )?Seq Scan on ([a-z0-9_]+)/g)].map((m) => `seq:${m[1]!}`),
      ]);
    return [...new Set(names)].join(", ") || "(no scan node)";
  };

  /** ② 브랜드 타일 — 종전(단일 단계 count DISTINCT). */
  const brandTileOld = (F: SQL, own: SQL) => sql`
    SELECT brand_name AS name, sum(mentions)::int AS mentions, count(DISTINCT job_id)::int AS answers,
      bool_or(brand_id = ANY(${own})) AS is_tracked
    FROM summary_brand_mentions WHERE ${F} AND is_competitor = 1 GROUP BY 1 ORDER BY mentions DESC`;
  /** ② 브랜드 타일 — 새(2단 집계, 병렬 가능). */
  const brandTileNew = (F: SQL, own: SQL) => sql`
    SELECT name, sum(mentions)::int AS mentions, count(*)::int AS answers, bool_or(is_tracked) AS is_tracked
    FROM (
      SELECT brand_name AS name, job_id, sum(mentions)::int AS mentions,
        bool_or(brand_id = ANY(${own})) AS is_tracked
      FROM summary_brand_mentions WHERE ${F} AND is_competitor = 1 GROUP BY 1, 2
    ) t GROUP BY 1 ORDER BY mentions DESC, name`;
  const citAgg = (F: SQL) => sql`
    SELECT COALESCE(sum(citations),0)::int AS total,
      count(DISTINCT job_id) FILTER (WHERE citations > 0)::int AS with_cit
    FROM summary_domain_citations WHERE ${F}`;
  const domRows = (F: SQL) => sql`
    SELECT domain AS host, count(DISTINCT job_id)::int AS citing_answers,
      COALESCE(sum(citations),0)::int AS citations
    FROM summary_domain_citations WHERE ${F} AND domain IS NOT NULL
    GROUP BY domain ORDER BY citing_answers DESC`;

  const roster = await entityRegistryRepository.listOwn();
  const ownEntities = roster.length ? roster : undefined;
  const base = await globalScopeOf();
  const rows: Array<Record<string, unknown>> = [];

  for (const c of GLOBAL_CASES.filter((x) => /E4|depth2|depth3|무필터/.test(x.name))) {
    const f: StandardFilters = { ...c.filters, ownEntities };
    const scope: SummaryGlobalScope = {
      ...base,
      filters: f,
      ownedBasePrefixes: ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.region, f.lang),
    };
    const W = globalTestables.answerWhere(scope);
    const Fnew = globalTestables.factScope(scope); // = W (조인 없음)
    // 동결 사본 — PR③ 이전의 `factScope`.
    const Fold = sql`${globalTestables.cycleScope(scope.cycle)} AND job_id IN (
      SELECT job_id FROM summary_answers WHERE ${W}
    )`;
    const own = sql`${sql.param(ownIdsOf(f))}::uuid[]`;

    // 종전(세미조인) ↔ 새(직접 술어) 문장 쌍. 옛 문장은 이 파일에 **동결**한 사본이다.
    const rankByJob = (F: SQL) => sql`
      WITH _bp AS (
        SELECT job_id, brand_name, min(first_rank) AS tp, bool_or(brand_id = ANY(${own})) AS is_own
        FROM summary_brand_mentions WHERE ${F} AND is_competitor = 1 AND first_rank IS NOT NULL
        GROUP BY 1, 2
      ), _rk AS (SELECT job_id, is_own, rank() OVER (PARTITION BY job_id ORDER BY tp) AS rk FROM _bp)
      SELECT job_id, min(rk)::int AS tp FROM _rk WHERE is_own GROUP BY job_id`;
    const ownByJobOld = (F: SQL) => sql`
      SELECT b.job_id, b.mc, r.tp
      FROM (SELECT job_id, sum(mentions)::int AS mc FROM summary_brand_mentions
            WHERE ${F} AND brand_id = ANY(${own}) GROUP BY job_id) b
      LEFT JOIN (${rankByJob(F)}) r ON r.job_id = b.job_id`;
    const ownByJobNew = (F: SQL) => sql`
      SELECT b.job_id, b.engine, b.prompt_id, b.mc, r.tp
      FROM (SELECT job_id, engine, prompt_id, sum(mentions)::int AS mc FROM summary_brand_mentions
            WHERE ${F} AND brand_id = ANY(${own}) GROUP BY job_id, engine, prompt_id) b
      LEFT JOIN (${rankByJob(F)}) r ON r.job_id = b.job_id`;

    const pairs: Array<{ label: string; old: SQL[]; next: SQL[] }> = [
      {
        label: "①분모·분자+③",
        old: [
          sql`WITH a AS (SELECT job_id, country, monitored FROM summary_answers WHERE ${W}),
              o AS (SELECT DISTINCT job_id FROM summary_brand_mentions WHERE ${Fold} AND brand_id = ANY(${own}))
              SELECT COALESCE(a.country,'UNKNOWN') AS region, COALESCE(sum(a.monitored),0)::int AS answers,
                count(*) FILTER (WHERE o.job_id IS NOT NULL)::int AS tracked
              FROM a LEFT JOIN o ON o.job_id = a.job_id GROUP BY 1 ORDER BY 1`,
          sql`SELECT COALESCE(sum(positive),0)::int AS p, COALESCE(sum(neutral),0)::int AS ne,
                COALESCE(sum(negative),0)::int AS ng, COALESCE(sum(mixed),0)::int AS mx
              FROM summary_brand_mentions WHERE ${Fold} AND brand_id = ANY(${own})`,
        ],
        next: [
          sql`SELECT COALESCE(country,'UNKNOWN') AS region, COALESCE(sum(monitored),0)::int AS answers
              FROM summary_answers WHERE ${W} GROUP BY 1 ORDER BY 1`,
          sql`SELECT COALESCE(country,'UNKNOWN') AS region, (grouping(country) = 1) AS is_total,
                count(DISTINCT job_id)::int AS tracked, COALESCE(sum(positive),0)::int AS p,
                COALESCE(sum(neutral),0)::int AS ne, COALESCE(sum(negative),0)::int AS ng,
                COALESCE(sum(mixed),0)::int AS mx
              FROM summary_brand_mentions WHERE ${Fnew} AND brand_id = ANY(${own})
              GROUP BY GROUPING SETS ((country), ())`,
        ],
      },
      { label: "②브랜드", old: [brandTileOld(Fold, own)], next: [brandTileNew(Fnew, own)] },
      {
        label: "④순위",
        old: [sql`SELECT round(avg(tp)::numeric,1) AS avg_position, count(*)::int AS sampled FROM (${rankByJob(Fold)}) t`],
        next: [sql`SELECT round(avg(tp)::numeric,1) AS avg_position, count(*)::int AS sampled FROM (${rankByJob(Fnew)}) t`],
      },
      { label: "⑤인용", old: [citAgg(Fold), domRows(Fold)], next: [citAgg(Fnew), domRows(Fnew)] },
      {
        label: "SubKPI",
        old: [
          sql`WITH a AS (SELECT job_id, engine, monitored FROM summary_answers WHERE ${W}), o AS (${ownByJobOld(Fold)})
              SELECT a.engine AS target, COALESCE(sum(a.monitored),0)::int AS answers,
                count(*) FILTER (WHERE o.job_id IS NOT NULL)::int AS tracked,
                count(*) FILTER (WHERE COALESCE(o.mc,0) >= 2)::int AS multi,
                count(*) FILTER (WHERE o.job_id IS NOT NULL AND COALESCE(o.tp,100) <= 1)::int AS top1,
                count(*) FILTER (WHERE o.job_id IS NOT NULL AND COALESCE(o.tp,100) <= 3)::int AS top3,
                round(avg(o.tp)::numeric,1) AS avg_position
              FROM a LEFT JOIN o ON o.job_id = a.job_id GROUP BY a.engine`,
          sql`WITH a AS (SELECT job_id, prompt_id FROM summary_answers WHERE ${W}), o AS (${ownByJobOld(Fold)}),
              pa AS (SELECT a.prompt_id, bool_or(o.job_id IS NOT NULL) AS mentioned
                     FROM a LEFT JOIN o ON o.job_id = a.job_id GROUP BY a.prompt_id)
              SELECT count(*) FILTER (WHERE NOT mentioned)::int AS missing, count(*)::int AS prompts FROM pa`,
        ],
        next: [
          sql`SELECT engine AS target, (grouping(engine) = 1) AS is_total,
                COALESCE(sum(monitored),0)::int AS answers, count(DISTINCT prompt_id)::int AS prompts
              FROM summary_answers WHERE ${W} GROUP BY GROUPING SETS ((engine), ())`,
          sql`SELECT engine AS target, (grouping(engine) = 1) AS is_total, count(*)::int AS tracked,
                count(*) FILTER (WHERE mc >= 2)::int AS multi,
                count(*) FILTER (WHERE COALESCE(tp,100) <= 1)::int AS top1,
                count(*) FILTER (WHERE COALESCE(tp,100) <= 3)::int AS top3,
                round(avg(tp)::numeric,1) AS avg_position, count(DISTINCT prompt_id)::int AS prompts
              FROM (${ownByJobNew(Fnew)}) o GROUP BY GROUPING SETS ((engine), ())`,
        ],
      },
    ];

    const row: Record<string, unknown> = { case: c.name };
    let sumOld = 0;
    let sumNew = 0;
    for (const pr of pairs) {
      let a = 0;
      let b = 0;
      for (const q of pr.old) a += await ms(q);
      for (const q of pr.next) b += await ms(q);
      row[`${pr.label}·전`] = Math.round(a);
      row[`${pr.label}·후`] = Math.round(b);
      sumOld += a;
      sumNew += b;
    }
    row["경로합·전"] = Math.round(sumOld);
    row["경로합·후"] = Math.round(sumNew);
    row["분자 index"] = await idx(pairs[0]!.next[1]!);
    rows.push(row);
  }
  console.log("\n# 글로벌 세부층 — 문장별 서버측 Execution Time (ms)");
  console.table(rows);

  // 웹사이트 — 유닛 게이트가 켜진 함대(95 회차) 대표 1건.
  const [unitFlags, excludedUnits] = await Promise.all([summaryUnitFlagsAvailable(), websiteExcludedUnits()]);
  const cycleProjects = new Set(
    ((await db.execute(sql`
      SELECT project_id::text AS pid FROM summary_cycles WHERE surface='website' AND active_generation_id IS NOT NULL
    `)) as unknown as Array<{ pid: string }>).map((r) => r.pid),
  );
  const eff = narrowScopeBrands({ all: true } as AllowedScope, undefined);
  const ids = (await getProjectIdsForScope(eff)).filter((id) => cycleProjects.has(id));
  const picked = await pickWebsiteCycles(ids);
  if (picked?.cycles.length) {
    const f: StandardFilters = { ownEntities };
    const declared = await websiteDeclaredOwnedBases(f, ids);
    const wscope: SummaryWebsiteScope = {
      cycles: picked.cycles, projectIds: ids, filters: f,
      ownedBasePrefixes: declared.prefixes.length ? declared.prefixes : ownedBasePrefixesForScope(undefined, ownEntities, undefined, undefined),
      unitFlags, excludedUnits,
    };
    const Wq = websiteTestables.answerWhere(wscope);
    const Fold = websiteTestables.factScope(wscope);
    const Fnew = websiteTestables.detailFactScope(wscope);
    const own = sql`${sql.param(ownIdsOf(f))}::uuid[]`;
    const oldQ1 = sql`
      WITH a AS (SELECT job_id, country, monitored FROM summary_answers WHERE ${Wq}),
      o AS (SELECT DISTINCT job_id FROM summary_brand_mentions WHERE ${Fold} AND brand_id = ANY(${own}))
      SELECT COALESCE(a.country, 'UNKNOWN') AS region, COALESCE(sum(a.monitored), 0)::int AS answers,
        count(*) FILTER (WHERE o.job_id IS NOT NULL)::int AS tracked
      FROM a LEFT JOIN o ON o.job_id = a.job_id GROUP BY 1 ORDER BY 1`;
    const newNum = sql`
      SELECT COALESCE(country, 'UNKNOWN') AS region, (grouping(country) = 1) AS is_total,
        count(DISTINCT job_id)::int AS tracked,
        COALESCE(sum(positive), 0)::int AS p, COALESCE(sum(neutral), 0)::int AS ne,
        COALESCE(sum(negative), 0)::int AS ng, COALESCE(sum(mixed), 0)::int AS mx
      FROM summary_brand_mentions WHERE ${Fnew} AND brand_id = ANY(${own})
      GROUP BY GROUPING SETS ((country), ())`;
    console.log("\n# 웹사이트 세부층 폴백 (함대 95 회차, unitFlags=" + unitFlags + ")");
    console.table([
      {
        case: "W-무필터(admin)",
        "① before": await ms(oldQ1),
        "① after(분자)": await ms(newNum),
        "② before": await ms(brandTileOld(Fold, own)),
        "② after": await ms(brandTileNew(Fnew, own)),
        "분자 index": await idx(newNum),
      },
    ]);
  }
}

/** `$own` — 리더와 같은 입력. */
function ownIdsOf(f: StandardFilters): string[] {
  return trackedEntityIdsFor(f.contextBrand ?? f.brand, f.ownEntities);
}

await (DIFF ? Promise.resolve(diff()) : EXPLAIN ? explain() : run());
process.exit(process.exitCode ?? 0);
