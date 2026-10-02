/**
 * S1 대시보드가 **실제로 내는 문장**의 EXPLAIN·소요 — 쓰기 0 (PR② T6 수용 기준 ④).
 *
 * `explain-trend.ts` 는 리더 코어의 4문장 전부를 잰다. S1 이 발행하는 것은 그중
 * **3개**다(라운드 2 — 카드와 GEO 가 한 read 를 나눠 쓴다):
 *
 *   own · brands · domains   (`S1_STATEMENT_KEYS` + `S1_TREND_AXES` + `S1_TREND_LIMITS`)
 *
 * 라운드 1(카드 3 + GEO 2 = 5문장, `summary_trend_brands` 2회 스캔) 과 비교하려면
 * `--round1` 로 그 형태를 함께 잰다.
 *
 * 함께 재는 것:
 *   · **오늘 vs 새** 리포지터리 함수 왕복 소요(min of N) — 같은 터널이라 A/B 가 공정하다.
 *     절대값에는 로컬→원격 터널 RTT 가 들어 있다(Vercel→Supabase 와 다르다).
 *   · EXPLAIN (ANALYZE, BUFFERS) Execution Time — 페이지 DB 합의 정본.
 *
 * ── 기간(회차 N개) 확장: 2026-09-18, W5 ───────────────────────────────────
 *
 * `--from`/`--to` 를 주면 **회차 집합**(기간 모드)으로 같은 문장을 잰다. 회차 선택은
 * 화면과 같은 판정(`pickCyclesInRange` + `judgeCycleRange`)을 그대로 쓴다: 직접
 * 고르면 폴백되는 회차까지 넣어 "실제로 발행되지 않는 문장" 을 재게 된다.
 *
 * 조합은 **셋을 함께** 잰다(한 조합만 재고 결론짓지 않는다: 2026-09-17 #708 선례:
 * 작은 워크스페이스가 statement_timeout 으로 죽는 형태가 최대 워크스페이스에서는
 * +5% 로만 보였다): (a) 무필터 함대 (b) 단일 브랜드 (c) 소형(브랜드 + 국가).
 * 조합마다 **같은 세션에서 1회차 ↔ N회차를 교대로** 잰다(A/B, 캐시·부하 조건 동일).
 *
 * 읽기 전용: 모든 문장이 `SET LOCAL transaction_read_only = on` 트랜잭션 안에서 돈다.
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-s1.ts \
 *       [--repeat=3] [--full] [--from=2026-08-20 --to=2026-09-18] [--no-roundtrip]
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  S1_STATEMENT_KEYS,
  S1_TREND_AXES,
  S1_TREND_LIMITS,
  summaryGlobalAggregates,
  summaryGlobalS1FromTrend,
} from "@/lib/db/repositories/summary-global-aggregates";
import {
  buildTrendStatements,
  planTrendRead,
  type TrendReadScope,
} from "@/lib/db/repositories/summary-trend-aggregates";
import { pickCyclesInRange } from "@/lib/db/repositories/summary-cycles";
import { ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import { judgeCycleRange, type CycleSet } from "@/lib/summary/read/cycle-set";
import type { StandardFilters } from "@/lib/scope/result-adapter";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const REPEAT = Number(arg("repeat") ?? 3);
const FULL = argv.includes("--full");
const FROM = arg("from");
const TO = arg("to");
/** 왕복 비교(ⓑ)는 세부층 6문장을 더 부른다: 기간 모드에서는 의미가 없어 끌 수 있다. */
const NO_ROUNDTRIP = argv.includes("--no-roundtrip");
/** 라운드 1 형태(카드 3 + GEO 2, 축 없음)를 함께 재서 전/후를 대조한다. */
const ROUND1 = argv.includes("--round1");

const dialect = new PgDialect();
/* eslint-disable no-console */
const log = console.log;

async function loadSet(): Promise<CycleSet> {
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
  if (!rows.length) throw new Error("활성 generation 이 있는 global 회차가 없다");
  const r = rows[0];
  const cycles = [{
    cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
  }];
  return {
    surface: "global", mode: "snapshot", cycles,
    cycleKey: `${r.cycle_id}:${r.generation_id}`,
    projectIds: [r.project_id], missingProjectIds: [],
    weeks: [r.cycle_week], anchorCount: 1,
  };
}

/**
 * 기간(회차 집합): **화면과 같은 판정**을 쓴다(`pickCyclesInRange` + `judgeCycleRange`).
 * 직접 고르면 폴백될 회차까지 넣게 되고, 그러면 실제로 발행되지 않는 문장을 재게 된다.
 */
async function loadPeriodSet(root: string, from: string, to: string): Promise<CycleSet> {
  const rows = await pickCyclesInRange({
    surface: "global", projectIds: [root], dateFrom: from, dateTo: to,
  });
  if (!rows) throw new Error("회차 범위 조회 불가(cycle-set-unavailable)");
  const judged = judgeCycleRange("global", [root], rows);
  if (!judged.ok) throw new Error(`기간 판정이 폴백이다: ${judged.reason}`);
  return judged.set;
}

/** EXPLAIN 은 바인드를 유지해야 하므로 SQL 객체 앞에 문자열을 붙여 만든다. */
function explained(q: SQL): SQL {
  return sql`EXPLAIN (ANALYZE, BUFFERS) ${q}`;
}

async function explainOne(label: string, q: SQL): Promise<number> {
  // 읽기 전용 단언: 하네스가 postgres 롤을 주므로 트랜잭션에서 스스로 막는다.
  // (Supavisor 는 startup 파라미터를 버리므로 `SET LOCAL` 이 유일하게 확실한 경로다.)
  const rows = (await getDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);
    return tx.execute(explained(q));
  })) as unknown as Array<Record<string, string>>;
  const lines = rows.map((r) => Object.values(r)[0] ?? "");
  const exec = lines.find((l) => l.startsWith("Execution Time:"));
  const plan = lines.find((l) => l.startsWith("Planning Time:"));
  const idx = lines.filter((l) => /Index (Only )?Scan|Seq Scan|Bitmap/.test(l)).map((l) => l.trim());
  const ms = Number(exec?.match(/([\d.]+) ms/)?.[1] ?? 0);
  log(`── ${label} ──`);
  log(`   Execution ${ms.toFixed(1)} ms · ${plan?.trim() ?? ""}`);
  for (const l of idx.slice(0, 2)) log(`   · ${l}`);
  if (FULL) for (const l of lines) log(`     ${l}`);
  return ms;
}

const scopeOf = (
  set: CycleSet,
  limits?: TrendReadScope["limits"],
  axes?: TrendReadScope["axes"],
  filters: StandardFilters = {},
): TrendReadScope => {
  // 변형·자사 base 는 **화면과 같은 함수**로 뽑는다: 무필터에서만 OWN_VARIANT_ALL 이다.
  const plan = planTrendRead({ surface: "global", filters });
  if (!plan.ok) throw new Error(`집계층이 표현 못 하는 조합이다: ${plan.reason}`);
  const owned = Object.keys(filters).length
    ? ownedBasePrefixesForScope(filters.contextBrand ?? filters.brand, undefined, filters.region, filters.lang)
    : globalBaseUniverse();
  return {
    set, filters, ownVariant: plan.ownVariant,
    ownedBasePrefixes: owned, limits, axes,
  };
};

/** W5.3: 조합 셋. 한 조합만 재고 결론짓지 않는다. */
const COMBOS: Array<{ name: string; filters: StandardFilters }> = [
  { name: "(a) 무필터 함대", filters: {} },
  { name: "(b) 단일 브랜드", filters: { brand: ["Hyundai"] } },
  { name: "(c) 소형(브랜드+국가)", filters: { brand: ["Hyundai"], region: ["KR"] } },
];

/** 한 조합·한 집합의 S1 3문장 합. */
async function explainCombo(label: string, set: CycleSet, filters: StandardFilters): Promise<number> {
  const sts = buildTrendStatements(scopeOf(set, S1_TREND_LIMITS, S1_TREND_AXES, filters), {
    only: S1_STATEMENT_KEYS,
  });
  let sum = 0;
  for (const st of sts) sum += await explainOne(`${label} · ${st.key} (${st.table})`, st.sql);
  log(`   ▸ ${label} 합 ${sum.toFixed(1)} ms\n`);
  return sum;
}

/** W5.4: 같은 세션에서 1회차 ↔ N회차를 **교대로** 잰다. */
async function periodMain(root: string, from: string, to: string) {
  const period = await loadPeriodSet(root, from, to);
  const last = period.cycles.reduce((a, b) => (a.cycleAnchorAt > b.cycleAnchorAt ? a : b));
  const single: CycleSet = {
    ...period, mode: "snapshot", cycles: [last],
    cycleKey: `${last.cycleId}:${last.generationId}`,
    weeks: [last.cycleWeek], anchorCount: 1,
  };
  log(`창 ${from}..${to} · 회차 ${period.anchorCount}개(주 ${period.weeks.length}) · skipped ${period.skippedCount ?? 0}`);
  log(`대조 단일 회차 = ${last.cycleAnchorAt} (${last.cycleId})\n`);

  const table: Array<{ combo: string; one: number; many: number }> = [];
  for (const c of COMBOS) {
    log(`══ ${c.name} ══\n`);
    const one = await explainCombo(`${c.name} · 1회차`, single, c.filters);
    const many = await explainCombo(`${c.name} · ${period.anchorCount}회차`, period, c.filters);
    table.push({ combo: c.name, one, many });
  }
  log(`\n### 회차 1개 vs ${period.anchorCount}개: S1 3문장 합(ms)`);
  log(`| 조합 | 1회차 | ${period.anchorCount}회차 | 배수 |`);
  log(`| --- | --- | --- | --- |`);
  for (const r of table) {
    log(`| ${r.combo} | ${r.one.toFixed(1)} | ${r.many.toFixed(1)} | ${(r.many / r.one).toFixed(2)}x |`);
  }
  log(`\n(회차 수 배수 ${period.anchorCount}x 보다 작으면 선형 이하: AC5.2)`);
}

async function main() {
  if (FROM || TO) {
    const base = await loadSet();
    await periodMain(base.projectIds[0] as string, FROM as string, TO as string);
    return;
  }
  const set = await loadSet();
  log(`회차 ${set.cycles[0].cycleId} · gen ${set.cycles[0].generationId}\n`);

  const s1Scope = scopeOf(set, S1_TREND_LIMITS, S1_TREND_AXES);
  const s1 = buildTrendStatements(s1Scope, { only: S1_STATEMENT_KEYS });

  log(`══ ⓐ EXPLAIN (ANALYZE, BUFFERS) — S1 이 내는 문장 ${s1.length}개 (라운드 2) ══\n`);
  const each: Array<{ label: string; ms: number }> = [];
  let sum = 0;
  for (const st of s1) {
    const ms = await explainOne(`${st.key} (${st.table})`, st.sql);
    each.push({ label: st.key, ms });
    sum += ms;
  }
  const longest = each.reduce((a, b) => (b.ms > a.ms ? b : a));
  log(`\n### 페이지 DB 합 ${sum.toFixed(1)} ms · 최장 문장 ${longest.label} ${longest.ms.toFixed(1)} ms`);

  if (ROUND1) {
    log(`\n══ ⓐ' 라운드 1 형태(카드 3 + GEO 2 = 5문장) ══\n`);
    const card = buildTrendStatements(scopeOf(set), { only: S1_STATEMENT_KEYS });
    const geo = buildTrendStatements(scopeOf(set, { geoBrandPerCountry: null }), {
      only: ["own", "brands"],
    });
    let r1 = 0;
    for (const st of card) r1 += await explainOne(`카드 ${st.key} (${st.table})`, st.sql);
    for (const st of geo) r1 += await explainOne(`GEO ${st.key} (${st.table})`, st.sql);
    log(`\n### 라운드 1 페이지 DB 합 ${r1.toFixed(1)} ms → 라운드 2 ${sum.toFixed(1)} ms`);
  }

  // ── ⓑ 오늘 vs 새 — 리포지터리 함수 왕복(min of REPEAT) ────────────────────
  if (NO_ROUNDTRIP) return;
  log(`\n══ ⓑ 왕복 소요(min of ${REPEAT}, 터널 RTT 포함) ══`);
  const timed = async (label: string, fn: () => Promise<unknown>) => {
    let best = Infinity;
    for (let i = 0; i < REPEAT; i += 1) {
      const t0 = performance.now();
      await fn();
      best = Math.min(best, performance.now() - t0);
    }
    log(`   ${label}: ${best.toFixed(1)} ms`);
    return best;
  };
  const today = await timed("오늘 카드 (세부층 6문장)", () =>
    summaryGlobalAggregates({
      cycle: set.cycles[0], rootProjectId: set.projectIds[0], filters: {},
      ownedBasePrefixes: globalBaseUniverse(),
    }));
  const next = await timed("새   카드+GEO (집계층 3문장 공용)", () => summaryGlobalS1FromTrend(s1Scope));
  log(`   → ${(today / next).toFixed(2)}배 (오늘 카드만 vs 새 카드+GEO)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
