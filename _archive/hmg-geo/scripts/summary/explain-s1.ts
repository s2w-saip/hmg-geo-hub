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
 * 사용:
 *   bash (내부 작업 파일) <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-s1.ts [--repeat=3] [--full]
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
import { buildTrendStatements, type TrendReadScope } from "@/lib/db/repositories/summary-trend-aggregates";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const REPEAT = Number(arg("repeat") ?? 3);
const FULL = argv.includes("--full");
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

/** EXPLAIN 은 바인드를 유지해야 하므로 SQL 객체 앞에 문자열을 붙여 만든다. */
function explained(q: SQL): SQL {
  return sql`EXPLAIN (ANALYZE, BUFFERS) ${q}`;
}

async function explainOne(label: string, q: SQL): Promise<number> {
  const rows = (await getDb().execute(explained(q))) as unknown as Array<Record<string, string>>;
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
): TrendReadScope => ({
  set, filters: {}, ownVariant: OWN_VARIANT_ALL,
  ownedBasePrefixes: globalBaseUniverse(), limits, axes,
});

async function main() {
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
