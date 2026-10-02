/**
 * S3/S6 인용 롤업 패리티 — 쓰기 0, 읽기만 (PR② T7 수용 기준 ①).
 *
 * ── 기대값을 **세부층**으로 잡는 이유 ──────────────────────────────────────
 *
 * 처음에는 미러(`aggregateCitationsFromMirror`)를 기대값으로 삼았는데 0 오차가 안
 * 나온다. 원인은 계산이 아니라 **모집단**이다 — 2026-09-10 실측(글로벌):
 *   · 미러 `detailAnswerWhere({})` = 36,304 답변, measured_at 2026-09-08~09-09
 *   · 사실표 8/31 회차                = 37,738 답변
 * 미러는 "기간 내 **최신 배치**" 창이고 사실표는 **published 회차**다. 새 측정이
 * 들어오면 둘이 갈라지고, 라이브에서는 게이트(`openRuns`·`hasNewerRunsOutsideCycles`)
 * 가 그 상태를 잡아 **미러로 폴백**하므로 두 값이 동시에 화면에 나오지 않는다.
 * 이 하네스는 게이트를 우회하므로 그 차이가 그대로 보인다 — 그래서 기대값은
 * v4.1 §7-1 이 말하는 **"집계층은 세부층과 동치여야 한다(같은 회차·같은 필터)"** 다.
 *
 * 대조:
 *   ① `citations`·`ownedCitations`·`isOurs` — 집계층 SUM vs 세부층 SUM (그룹별)
 *   ② **`prompts`·`citingAnswers`** — 2단 조회(top-80 한정) vs 세부층 **전량** 집계.
 *      `group_key = ANY($top80)` 한정이 **무손실**인지가 수용 기준 ① 의 실체다.
 *   ③ 요약(`total`·`uniqueDomains`·`officialOwnShare`)·카테고리 도넛
 *   ④ 출처 도넛 — 세부층 리더(`summaryGlobalSourceComposition`) vs 집계층 쌍둥이
 *   ⑤ (`--mirror`) 미러와의 차이 — 판정이 아니라 **모집단 관측**으로만 찍는다
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-citations.ts [--website] [--mirror] [--only=무필터]
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  summaryGlobalCitationsFromTrend,
  summaryGlobalSourceComposition,
  summaryGlobalSourceCompositionFromTrend,
  __testables as GLOBAL_T,
} from "@/lib/db/repositories/summary-global-aggregates";
import {
  summaryWebsiteCitationsFromTrend,
  __testables as WEBSITE_T,
} from "@/lib/db/repositories/summary-website-aggregates";
import {
  aggregateCitationsFromMirror,
  websiteDeclaredOwnedBases,
} from "@/lib/db/repositories/scope-aggregates";
import {
  ownedCitationExpr,
  resolveOwnVariantKey,
  type TrendReadScope,
} from "@/lib/db/repositories/summary-trend-aggregates";
import { summaryUnitFlagsAvailable, websiteExcludedUnits } from "@/lib/db/repositories/summary-settings";
import { loadCitationOverrides } from "@/lib/citation-categorizer/overrides-loader";
import { resolveCitationCategory } from "@/lib/citation-categorizer";
import { ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import type { CitationsLive, StandardFilters } from "@/lib/scope/result-adapter";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const WEBSITE = argv.includes("--website");
const MIRROR = argv.includes("--mirror");
const ONLY = arg("only");
const TOP = 80;

/* eslint-disable no-console */
const log = console.log;
const n = (v: unknown) => Number(v ?? 0);
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

type CycleRow = {
  cycle_id: string; generation_id: string; project_id: string;
  cycle_anchor_at: string; cycle_week: string;
};

async function loadSet(): Promise<CycleSet> {
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text
      FROM summary_cycles
     WHERE surface = ${WEBSITE ? "website" : "global"} AND active_generation_id IS NOT NULL
       ${WEBSITE ? sql`AND view_anchor_at IS NOT NULL AND view_anchor_at <= now()` : sql``}
     ORDER BY cycle_anchor_at DESC
       ${WEBSITE ? sql`` : sql`LIMIT 1`}
  `)) as unknown as CycleRow[];
  if (!rows.length) throw new Error("활성 generation 이 있는 회차가 없다");
  const cycles = rows.map((r) => ({
    cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
  }));
  return {
    surface: WEBSITE ? "website" : "global", mode: "snapshot", cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
  };
}

/** 화면이 넘기는 `$sel` 과 같은 함수·같은 입력(`lib/scope/server.ts::scopeOwnedPrefixes`). */
const ownedPrefixesFor = (f: StandardFilters): string[] =>
  ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.websiteCountry ?? f.region, f.lang);

const GLOBAL_CASES: Array<{ name: string; filters: StandardFilters }> = [
  { name: "무필터", filters: {} },
  { name: "국가1 (KR)", filters: { region: ["KR"] } },
  { name: "국가3 (KR,US,DE)", filters: { region: ["KR", "US", "DE"] } },
  { name: "엔진1 (chatgpt)", filters: { engine: ["chatgpt"] } },
  { name: "언어1 (EN)", filters: { lang: ["EN"] } },
  { name: "브랜드락 (Kia)", filters: { brand: ["Kia"] } },
  { name: "brandPresence (branded)", filters: { brandPresence: ["branded"] } },
];
const WEBSITE_CASES: Array<{ name: string; filters: StandardFilters }> = [
  { name: "무필터", filters: {} },
  { name: "국가1 (KR)", filters: { websiteCountry: ["KR"] } },
  { name: "가상국가 (worldwide)", filters: { websiteCountry: ["worldwide"] } },
  { name: "엔진1 (chatgpt)", filters: { engine: ["chatgpt"] } },
  { name: "언어1 (en)", filters: { lang: ["en"] } },
  { name: "국가2 (KR,US)", filters: { websiteCountry: ["KR", "US"] } },
  { name: "국가+언어 (KR/ko)", filters: { websiteCountry: ["KR"], lang: ["ko"] } },
];

// ── 세부층 기준선 ───────────────────────────────────────────────────────────

interface DetailRow {
  citations: number; ownedCitations: number; isOurs: boolean;
  prompts: number; citingAnswers: number;
}

/**
 * 세부층 전량 롤업 — **2단 조회와 같은 표·같은 술어**를 `group_key` 한정 없이 돈다.
 * 여기서 나온 `prompts`·`citing_answers` 가 수용 기준 ① 의 "세부층 값" 정본이다.
 */
async function detailBaseline(where: SQL, ownedSum: SQL, oursAgg: SQL): Promise<Map<string, DetailRow>> {
  const rows = (await getDb().execute(sql`
    SELECT group_key,
           COALESCE(sum(citations), 0)::int AS citations,
           ${ownedSum}                      AS owned_citations,
           ${oursAgg}                       AS is_ours,
           count(DISTINCT prompt_id)::int                        AS prompts,
           count(DISTINCT job_id)::int                           AS citing_answers
      FROM summary_domain_citations WHERE ${where}
     GROUP BY group_key
  `)) as unknown as Array<Record<string, unknown>>;
  const out = new Map<string, DetailRow>();
  for (const r of rows) {
    out.set(r.group_key as string, {
      citations: n(r.citations), ownedCitations: n(r.owned_citations),
      isOurs: r.is_ours === true, prompts: n(r.prompts), citingAnswers: n(r.citing_answers),
    });
  }
  return out;
}

async function answerCount(where: SQL): Promise<number> {
  const rows = (await getDb().execute(
    sql`SELECT count(*)::int AS answers FROM summary_answers WHERE ${where}`,
  )) as unknown as Array<{ answers: unknown }>;
  return n(rows[0]?.answers);
}

const set = await loadSet();
log(`${WEBSITE ? "웹사이트 함대" : "글로벌"} — 회차 ${set.cycles.length} · 프로젝트 ${set.projectIds.length} · anchor ${set.cycles[0]?.cycleAnchorAt.slice(0, 10)}`);

const unitFlags = WEBSITE ? await summaryUnitFlagsAvailable() : false;
const excludedUnits = WEBSITE ? await websiteExcludedUnits() : [];
const overrides = await loadCitationOverrides();
const cases = (WEBSITE ? WEBSITE_CASES : GLOBAL_CASES).filter((c) => !ONLY || c.name === ONLY);

let pass = 0;
let fail = 0;
for (const c of cases) {
  const f = c.filters;
  log(`\n■ ${c.name}`);
  let next: Awaited<ReturnType<typeof summaryGlobalCitationsFromTrend>>;
  let detailWhere: SQL;
  let ansWhere: SQL;
  let ownedSum: SQL;
  let oursAgg: SQL;
  let prefixes: string[];

  if (WEBSITE) {
    const own = await websiteDeclaredOwnedBases(f, set.projectIds);
    prefixes = own.prefixes.length ? own.prefixes : globalBaseUniverse();
    const wscope = {
      set, cycles: set.cycles, projectIds: set.projectIds, filters: f,
      ownedBasePrefixes: prefixes, unitFlags, excludedUnits,
    };
    next = await summaryWebsiteCitationsFromTrend(wscope as never);
    detailWhere = WEBSITE_T.factScope(wscope as never);
    ansWhere = WEBSITE_T.answerWhere(wscope as never);
    // ⚠️ 유닛 경로의 ⑤ 분자는 `sum(citations) FILTER (…)` 가 **아니라** 굳혀진 유닛
    // 카운트의 합이다(`summary-trend-aggregates::ownedCitationsAgg`). 처음에 FILTER 로
    // 기준선을 잡았더니 웹사이트 7케이스 중 6케이스에서 `officialOwnShare` 가 0.1~0.8 pp
    // 어긋났다 — **리더가 아니라 기준선이 틀렸다**(2026-09-10).
    if (unitFlags) {
      ownedSum = sql`COALESCE(sum(unit_owned_citations), 0)::int`;
      oursAgg = sql`COALESCE(sum(unit_owned_citations), 0) > 0`;
    } else {
      const e = ownedCitationExpr(prefixes);
      ownedSum = sql`COALESCE(sum(citations) FILTER (WHERE ${e}), 0)::int`;
      oursAgg = sql`COALESCE(bool_or(${e}), false)`;
    }
  } else {
    const variant = resolveOwnVariantKey(f);
    if (!variant) { log("  own_variant 밖(E4) · 건너뜀"); continue; }
    prefixes = ownedPrefixesFor(f);
    const scope: TrendReadScope = { set, filters: f, ownVariant: variant, ownedBasePrefixes: prefixes };
    next = await summaryGlobalCitationsFromTrend(scope);
    const gscope = {
      cycle: set.cycles[0], rootProjectId: set.projectIds[0], filters: f, ownedBasePrefixes: prefixes,
    };
    detailWhere = GLOBAL_T.answerWhere(gscope as never);
    ansWhere = detailWhere;
    const e = ownedCitationExpr(prefixes);
    ownedSum = sql`COALESCE(sum(citations) FILTER (WHERE ${e}), 0)::int`;
    oursAgg = sql`COALESCE(bool_or(${e}), false)`;
  }

  if (next.empty) { log("  새 = EMPTY (집계층 폴백)"); fail++; continue; }
  const v = next.value;
  const base = await detailBaseline(detailWhere, ownedSum, oursAgg);
  const answers = await answerCount(ansWhere);

  // ③ 요약 — 세부층 전량에서 재계산
  let bTotal = 0;
  let bOwned = 0;
  const bCat = new Map<string, number>();
  for (const [k, r] of base) {
    bTotal += r.citations;
    bOwned += r.ownedCitations;
    const cat = resolveCitationCategory(null, k, overrides);
    bCat.set(cat, (bCat.get(cat) ?? 0) + r.citations);
  }
  const chk = (label: string, a: number, b: number) => {
    const ok = a === b;
    if (ok) pass++; else fail++;
    log(`  ${ok ? "PASS" : "FAIL"} ${label.padEnd(22)} 세부층 ${a} · 집계층 ${b}${ok ? "" : ` (Δ ${b - a})`}`);
  };
  chk("summary.total", bTotal, v.summary.total);
  chk("summary.uniqueDomains", base.size, v.summary.uniqueDomains);
  chk("officialOwnShare×10", Math.round(pctOf(bOwned, bTotal) * 10), Math.round(n(v.summary.officialOwnShare) * 10));
  const catBad = [...bCat].filter(([k, x]) => (v.categories ?? []).find((y) => y.name === k)?.value !== x);
  chk("categories 불일치", 0, catBad.length);

  // ①② 도메인 표 top-80 — 2단 조회가 세부층 전량과 같은가
  const fieldBad = new Map<string, number>();
  const samples: string[] = [];
  for (const d of v.domains) {
    const b = base.get(d.domain);
    if (!b) { fieldBad.set("세부층에 없음", (fieldBad.get("세부층에 없음") ?? 0) + 1); continue; }
    const cmp: Array<[string, number | boolean, number | boolean]> = [
      ["citations", b.citations, d.citations],
      ["prompts", b.prompts, d.prompts],
      ["coverageRate", pctOf(b.citingAnswers, answers), d.coverageRate],
      ["share", pctOf(b.citations, bTotal), d.share],
      ["isOurs", b.isOurs, d.isOurs],
    ];
    for (const [name, x, y] of cmp) {
      if (x !== y) {
        fieldBad.set(name, (fieldBad.get(name) ?? 0) + 1);
        if (samples.length < 3) samples.push(`${d.domain}.${name}: 세부층 ${String(x)} vs 집계층 ${String(y)}`);
      }
    }
  }
  const badN = [...fieldBad.values()].reduce((s, x) => s + x, 0);
  chk(`도메인 top-${TOP} 불일치`, 0, badN);
  log(`       (대조 ${v.domains.length}행 · 세부층 그룹 ${base.size} · 답변 ${answers})`);
  for (const s of samples) log(`       ${s}`);
  if (fieldBad.size) log(`       필드별: ${[...fieldBad].map(([k, x]) => `${k}:${x}`).join(" ")}`);

  if (MIRROR) {
    const today: CitationsLive | null = WEBSITE
      ? await aggregateCitationsFromMirror(f, set.projectIds, prefixes,
          (await websiteDeclaredOwnedBases(f, set.projectIds)).universe, true)
      : await aggregateCitationsFromMirror(f, undefined, prefixes);
    log(`  [관측] 미러 total ${today?.summary.total ?? "null"} · uniqueDomains ${today?.summary.uniqueDomains ?? "-"}` +
        ` — 창(window) 의미론이라 회차와 모집단이 다를 수 있다(머리 주석)`);
  }
}

if (!WEBSITE) {
  log("\n■ 출처 도넛 — 세부층 리더 vs 집계층 쌍둥이 (무필터)");
  const scope: TrendReadScope = {
    set, filters: {}, ownVariant: resolveOwnVariantKey({}) as string, ownedBasePrefixes: ownedPrefixesFor({}),
  };
  const detail = await summaryGlobalSourceComposition({
    cycle: set.cycles[0], rootProjectId: set.projectIds[0], filters: {},
    ownedBasePrefixes: ownedPrefixesFor({}),
  } as never);
  const agg = await summaryGlobalSourceCompositionFromTrend(scope);
  if (agg.empty) { log("  FAIL 새 = EMPTY"); fail++; }
  else {
    const a = new Map(detail.map((r) => [r.domain, r]));
    let bad = 0;
    for (const r of agg.value) {
      const x = a.get(r.domain);
      if (!x || x.citations !== r.citations || x.share !== r.share || x.isOurs !== r.isOurs) bad++;
    }
    if (bad === 0) pass++; else fail++;
    log(`  ${bad === 0 ? "PASS" : "FAIL"} 세부층 ${detail.length}행 · 집계층 ${agg.value.length}행 · 불일치 ${bad}`);
  }
}

log(`\n=== ${WEBSITE ? "S6" : "S3"} 패리티: PASS ${pass} · FAIL ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
