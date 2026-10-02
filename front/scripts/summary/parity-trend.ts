/**
 * 집계층 리더 **패리티 격자** — 쓰기 0, 읽기만 (PR② T4 라운드 2).
 *
 * 오늘 화면이 쓰는 사실표 리더(`summaryGlobalAggregates` / `summaryWebsiteAggregates`)와
 * 새 집계층 리더(`readTrendAggregates`)를 **같은 회차·같은 필터**로 돌려 정수 오차를 낸다.
 * 격자는 T3 의 ⑤ 격자와 같은 케이스다: 무필터 · 국가1 · 국가1+언어1 · 국가2 · 언어1 · 브랜드.
 *
 * 대조 항목(전부 정수 — 비율은 정수 분자·분모로 환원해 본다):
 *   모수(monitored) · ① 분자(tracked answers) · ② 분자/분모(당사·경쟁 언급)
 *   · ③ 분자/분모 · ④ 분자/분모 · **⑤ 분자/분모** · 고유 브랜드 수 · 고유 도메인 수
 *
 * ⑤ 분자는 **집계층 도메인 표**에서 온다(라운드 2 결정) — `trend_own.own_citations` 는
 * 감사값으로만 함께 찍어 둘의 차이를 눈에 보이게 한다.
 *
 * 사용:
 *   npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-trend.ts --surface=global
 *   npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-trend.ts --surface=website
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  readTrendAggregates,
  resolveOwnVariantKey,
  summaryTrendGenerationInvariantSql,
  type TrendReadScope,
} from "@/lib/db/repositories/summary-trend-aggregates";
import { summaryGlobalAggregates, summaryGlobalSubKpis } from "@/lib/db/repositories/summary-global-aggregates";
import { summaryWebsiteAggregates, summaryWebsiteSubKpis } from "@/lib/db/repositories/summary-website-aggregates";
import { summaryUnitFlagsAvailable, websiteExcludedUnits } from "@/lib/db/repositories/summary-settings";
import { ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SURFACE = (arg("surface") ?? "global") as "global" | "website";
const CYCLE_ID = arg("cycle");

/* eslint-disable no-console */
const log = console.log;
const n = (v: unknown) => Number(v ?? 0);

type CycleRow = {
  cycle_id: string; generation_id: string; project_id: string;
  cycle_anchor_at: string; cycle_week: string;
};

async function loadSet(): Promise<CycleSet> {
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text
    FROM summary_cycles
    WHERE surface = ${SURFACE} AND active_generation_id IS NOT NULL
      ${CYCLE_ID ? sql`AND cycle_id = ${CYCLE_ID}::uuid` : sql``}
  `)) as unknown as CycleRow[];
  if (!rows.length) throw new Error(`활성 generation 이 있는 ${SURFACE} 회차가 없다`);
  const cycles = rows.map((r) => ({
    cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
  }));
  return {
    surface: SURFACE, mode: "snapshot", cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
  };
}

/** 화면이 넘기는 `$sel` 과 **같은 함수·같은 입력**(`lib/scope/server.ts::scopeOwnedPrefixes`). */
const ownedPrefixesFor = (f: StandardFilters): string[] =>
  ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.websiteCountry ?? f.region, f.lang);

type Case = { name: string; filters: StandardFilters; excludedOverride?: number[] };

const GLOBAL_CASES: Case[] = [
  { name: "무필터", filters: {} },
  { name: "국가1 (KR)", filters: { region: ["KR"] } },
  { name: "국가1+언어1 (KR/KO)", filters: { region: ["KR"], lang: ["KO"] } },
  { name: "국가2 (KR,US)", filters: { region: ["KR", "US"] } },
  { name: "언어1 (EN)", filters: { lang: ["EN"] } },
  { name: "브랜드 (Kia)", filters: { brand: ["Kia"] } },
  { name: "brandPresence (branded)", filters: { brandPresence: ["branded"] } },
];

// 이 회차(a3204f07)의 실제 축: country=NO · lang=no · engine={chatgpt,gemini} · report_fs=76.
// 격자는 "데이터가 있는 축" 으로 잡아야 대조가 의미를 갖는다(모수 0 이면 양쪽 다 null).
const WEBSITE_CASES: Case[] = [
  { name: "무필터", filters: {} },
  { name: "국가1 (NO)", filters: { websiteCountry: ["NO"] } },
  { name: "국가1+언어1 (NO/no)", filters: { websiteCountry: ["NO"], lang: ["no"] } },
  { name: "국가2 (NO,KR)", filters: { websiteCountry: ["NO", "KR"] } },
  { name: "언어1 (no)", filters: { lang: ["no"] } },
  { name: "엔진1 (chatgpt)", filters: { engine: ["chatgpt"] } },
  // 유닛 게이트 동치 확인 — 이 회차의 유일한 유닛(76)을 제외 목록에 넣으면 **양쪽 다** 0 이어야 한다.
  { name: "유닛 제외 (fs=76)", filters: {}, excludedOverride: [76] },
];

type Row = Record<string, number>;

/** 새 리더 → 대조 항목. ⑤ 분자는 **도메인 표 total 행**에서 온다. */
async function fromTrend(scope: TrendReadScope): Promise<Row & { auditOwnCit: number }> {
  const a = await readTrendAggregates(scope);
  const own = a.own.find((r) => r.axis === "total");
  const dom = a.domains.find((r) => r.axis === "total");
  const brandRows = a.brands.filter((r) => r.country === null);
  const named = brandRows.filter((r) => !r.isRest);
  const rest = brandRows.filter((r) => r.isRest);
  const domNamed = a.domains.filter((r) => r.axis === "domain" && !r.isRest && r.domain !== null);
  const domRest = a.domains.filter((r) => r.axis === "domain" && r.isRest);
  return {
    monitored: own?.monitored ?? 0,
    trackedAnswers: own?.trackedAnswers ?? 0,
    ownMentions: own?.ownMentions ?? 0,
    compMentions: own?.compMentions ?? 0,
    ownPositive: own?.ownPositive ?? 0,
    ownSignals: own?.ownSignals ?? 0,
    avgPosition: own && own.rankedAnswers > 0
      ? Math.round((own.rankSum / own.rankedAnswers) * 10) / 10 : 0,
    rankedAnswers: own?.rankedAnswers ?? 0,
    citOwned: dom?.ownedCitations ?? 0,
    citTotal: dom?.citations ?? 0,
    brandCount: named.length + rest.reduce((s, r) => s + r.restCount, 0),
    domainCount: domNamed.length + domRest.reduce((s, r) => s + r.restCount, 0),
    auditOwnCit: (own?.ownCitations ?? 0) + (own?.ownFallbackCitations ?? 0),
  };
}

/** 오늘 리더(`StandardAggregates`) → 같은 항목. 중첩 구조에 주의(citations·sentiment·position). */
function fromToday(g: NonNullable<Awaited<ReturnType<typeof summaryGlobalAggregates>>>): Row {
  const brands = g.brands ?? [];
  return {
    monitored: n(g.totalAnswers),
    trackedAnswers: n(g.trackedAnswerCount),
    ownMentions: brands.filter((b) => b.isTracked).reduce((s, b) => s + n(b.mentionCount), 0),
    compMentions: n(g.totalMentions),
    ownPositive: n(g.sentiment?.positiveMentions),
    ownSignals: n(g.sentiment?.sampledMentions),
    citOwned: n(g.citations?.ownedCitations),
    citTotal: n(g.citations?.totalCitations),
    brandCount: brands.length,
    domainCount: (g.citations?.domains ?? []).length,
    avgPosition: Math.round(n(g.position?.avgPosition) * 10) / 10,
    rankedAnswers: n(g.position?.sampledAnswers),
  };
}

async function main() {
  const set = await loadSet();
  const unitFlags = await summaryUnitFlagsAvailable();
  const excludedUnits = await websiteExcludedUnits();
  log(`표면 ${SURFACE} · 회차 ${set.cycles.length} · 프로젝트 ${set.projectIds.length} · unitFlags=${unitFlags} · 제외유닛 ${excludedUnits.length}개`);
  log(`gen ${[...new Set(set.cycles.map((c) => c.generationId))].join(",")}`);

  const cases = SURFACE === "global" ? GLOBAL_CASES : WEBSITE_CASES;
  const keys = ["monitored", "trackedAnswers", "ownMentions", "compMentions", "ownPositive",
    "ownSignals", "avgPosition", "rankedAnswers", "citOwned", "citTotal",
    "brandCount", "domainCount"] as const;

  log(`\n케이스 | ${keys.join(" | ")} | ⑤(오늘) | ⑤(새) | ⑤감사(own)`);
  for (const c of cases) {
    const filters: StandardFilters = { ...c.filters };
    const prefixes = SURFACE === "global" ? ownedPrefixesFor(filters) : globalBaseUniverse();
    const variant = resolveOwnVariantKey(filters);
    if (!variant) { log(`${c.name}: own_variant 없음(E4) — 건너뜀`); continue; }
    const excl = c.excludedOverride ?? excludedUnits;
    const scope: TrendReadScope = {
      set, filters, ownVariant: variant, ownedBasePrefixes: prefixes,
      unitFlags, excludedUnits: excl,
    };
    const nu = await fromTrend(scope);

    const today = SURFACE === "global"
      ? await summaryGlobalAggregates({
          cycle: set.cycles[0], rootProjectId: set.projectIds[0], filters, ownedBasePrefixes: prefixes,
        })
      : await summaryWebsiteAggregates({
          cycles: set.cycles as never, projectIds: set.projectIds, filters,
          ownedBasePrefixes: prefixes, unitFlags, excludedUnits: excl,
        });
    if (!today) {
      log(`${c.name}: 오늘 리더 null(모수 0) · 새 리더 monitored=${nu.monitored} → ${nu.monitored === 0 ? "동치 OK" : "**불일치**"}`);
      continue;
    }
    const od = fromToday(today as never);

    const diffs = keys.map((k) => {
      const d = nu[k] - od[k];
      return d === 0 ? "0" : `**${d > 0 ? "+" : ""}${d}** (${od[k]}→${nu[k]})`;
    });
    const rateToday = od.citTotal > 0 ? ((100 * od.citOwned) / od.citTotal).toFixed(2) : "-";
    const rateNew = nu.citTotal > 0 ? ((100 * nu.citOwned) / nu.citTotal).toFixed(2) : "-";
    const rateAudit = nu.citTotal > 0 ? ((100 * nu.auditOwnCit) / nu.citTotal).toFixed(2) : "-";
    log(`${c.name} | ${diffs.join(" | ")} | ${rateToday}% | ${rateNew}% | ${rateAudit}%`);
  }

  await generationInvariant();
  await negativeGrid(set, unitFlags, excludedUnits);
  await emptyProbe(set, unitFlags, excludedUnits);
}

/**
 * 라운드 4: **회차 술어의 전제 감사** — "집계층은 회차당 generation 1개".
 * 기간 모드가 `cycle_id = ANY × generation_id = ANY`(교차곱)를 쓰는 근거이고,
 * 깨지면 남의 generation 행이 합계에 섞인다.
 */
async function generationInvariant() {
  const rows = (await getDb().execute(summaryTrendGenerationInvariantSql())) as unknown as Array<{
    tbl: string; max_gens_per_cycle: number; max_cycles_per_gen: number;
  }>;
  log(`\n 불변식 감사 | 표 | 회차당 generation 최대 | generation당 회차 최대 | 판정`);
  for (const r of rows) {
    const ok = n(r.max_gens_per_cycle) <= 1 && n(r.max_cycles_per_gen) <= 1;
    log(` | ${r.tbl} | ${r.max_gens_per_cycle} | ${r.max_cycles_per_gen} | ${ok ? "OK" : "**위반**"}`);
  }
}

/**
 * 라운드 3 ①: **엔진별 `negativeMentions`** — `axes.engineBrand` 로 낸 값 vs 오늘 Sub-KPI.
 * `trend_own` 에 `own_negative` 가 없어 브랜드 표의 당사 행 `negative` 를 엔진별로 합하는
 * 것이 스키마 없이 낼 유일한 경로다(그래서 이 대조가 그 경로의 유일한 그물이다).
 */
async function negativeGrid(set: CycleSet, unitFlags: boolean, excludedUnits: number[]) {
  const filters: StandardFilters = {};
  const prefixes = SURFACE === "global" ? ownedPrefixesFor(filters) : globalBaseUniverse();
  const variant = resolveOwnVariantKey(filters) as string;
  const agg = await readTrendAggregates(
    { set, filters, ownVariant: variant, ownedBasePrefixes: prefixes, unitFlags, excludedUnits,
      axes: { engineBrand: true } },
    { only: ["brands"] },
  );
  const today = SURFACE === "global"
    ? await summaryGlobalSubKpis({ cycle: set.cycles[0], rootProjectId: set.projectIds[0], filters, ownedBasePrefixes: prefixes })
    : await (async () => {
        // 집계층 read 는 `SummaryTrendRead` 다(PR③ R3) — 하네스는 값만 본다.
        const r = await summaryWebsiteSubKpis({ cycles: set.cycles as never, projectIds: set.projectIds,
          filters, ownedBasePrefixes: prefixes, unitFlags, excludedUnits });
        if (r.empty) throw new Error("집계층 Sub-KPI 가 empty — 접기 미실행 회차다");
        return r.value;
      })();

  log(`\n엔진 | negativeMentions(오늘) | (새=engineBrand 축) | 오차`);
  for (const row of today.rows) {
    const mine = agg.brands
      .filter((b) => b.axis === "engine" && b.engine === row.engine && b.isTracked && !b.isRest)
      .reduce((s2, b) => s2 + b.negative, 0);
    const d = mine - n(row.negativeMentions);
    log(`${row.engine} | ${n(row.negativeMentions)} | ${mine} | ${d === 0 ? "0" : `**${d}**`}`);
  }
}

/**
 * 라운드 3 ②: **`empty` 결함 전/후**. 존재하지 않는 generation 으로 읽으면 `empty=true` 여야
 * 한다. 라운드 2까지는 `GROUPING SETS ((), …)` 가 빈 입력에도 합계 행 1개를 내서 **항상
 * false** 였다(접기 안 된 회차가 0 으로 그려질 위험).
 */
async function emptyProbe(set: CycleSet, unitFlags: boolean, excludedUnits: number[]) {
  const filters: StandardFilters = {};
  const prefixes = SURFACE === "global" ? ownedPrefixesFor(filters) : globalBaseUniverse();
  const variant = resolveOwnVariantKey(filters) as string;
  const base = { filters, ownVariant: variant, ownedBasePrefixes: prefixes, unitFlags, excludedUnits };
  const bogus: CycleSet = {
    ...set,
    cycles: set.cycles.map((c) => ({ ...c, generationId: "00000000-0000-0000-0000-0000000000ff" })),
  };
  const real = await readTrendAggregates({ set, ...base });
  const none = await readTrendAggregates({ set: bogus, ...base });
  log(`\n empty 프로브 | own 행 | own.total.keyRows | empty`);
  log(` 있는 generation | ${real.own.length} | ${real.own.find((r) => r.axis === "total")?.keyRows} | ${real.empty}`);
  log(` 없는 generation | ${none.own.length} | ${none.own.find((r) => r.axis === "total")?.keyRows} | ${none.empty}`);
  const onlyDom = await readTrendAggregates({ set: bogus, ...base }, { only: ["domains"] });
  log(` 없는 gen + only=[domains] | domains ${onlyDom.domains.length}행 | empty ${onlyDom.empty}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
