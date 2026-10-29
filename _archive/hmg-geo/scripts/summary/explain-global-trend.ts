/**
 * 글로벌 추이 read 의 EXPLAIN·소요 — 쓰기 0 (PR③ 목표: 문장 합 ≤ 300 ms).
 *
 * 재는 것:
 *   ⓐ 회차 축 3종을 켠 3문장의 `EXPLAIN (ANALYZE, BUFFERS)` Execution Time.
 *   ⓑ 축을 **끈** 같은 3문장(라운드 2 형태) — 축이 얼마를 더 먹는가.
 *   ⓒ 미러 3함수 왕복 vs 집계층 read 왕복(같은 터널이라 A/B 가 공정하다).
 *
 * 사용:
 *   bash (내부 작업 파일) <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-global-trend.ts [--mirror]
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  buildTrendStatements,
  type TrendReadScope,
} from "@/lib/db/repositories/summary-trend-aggregates";
import {
  G_CORE_AXES,
  G_CORE_LIMITS,
  G_CORE_STATEMENT_KEYS,
  G_BRAND_AXES,
  G_BRAND_SERIES_LIMITS,
  G_BRAND_SNAPSHOT_LIMITS,
  G_BRAND_STATEMENT_KEYS,
  readGlobalTrendCore,
} from "@/lib/db/repositories/summary-global-trend-read";
import {
  aggregateStandardTrendFromMirror,
  aggregateBrandTrendFromMirror,
  aggregateFirstPositionFromMirror,
} from "@/lib/db/repositories/scope-aggregates";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const argv = process.argv.slice(2);
const WITH_MIRROR = argv.includes("--mirror");
const REPEAT = Number(argv.find((a) => a.startsWith("--repeat="))?.split("=")[1] ?? 3);

/* eslint-disable no-console */
const log = console.log;

async function loadSet(): Promise<CycleSet> {
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text
    FROM summary_cycles
    WHERE surface = 'global' AND active_generation_id IS NOT NULL
    ORDER BY cycle_anchor_at
  `)) as unknown as Array<{
    cycle_id: string; generation_id: string; project_id: string;
    cycle_anchor_at: string; cycle_week: string;
  }>;
  if (!rows.length) throw new Error("활성 generation 이 있는 global 회차가 없다");
  const cycles = rows.map((r) => ({
    cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
  }));
  return {
    surface: "global", mode: "period", cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
  };
}

async function explainOne(label: string, q: SQL): Promise<number> {
  const rows = (await getDb().execute(
    sql`EXPLAIN (ANALYZE, BUFFERS) ${q}`,
  )) as unknown as Array<Record<string, string>>;
  const lines = rows.map((r) => Object.values(r)[0] ?? "");
  const ms = Number(lines.find((l) => l.startsWith("Execution Time:"))?.match(/([\d.]+) ms/)?.[1] ?? 0);
  const idx = lines.filter((l) => /Index (Only )?Scan|Seq Scan|Bitmap/.test(l)).map((l) => l.trim());
  log(`── ${label} ──`);
  log(`   Execution ${ms.toFixed(1)} ms`);
  if (idx[0]) log(`   · ${idx[0]}`);
  return ms;
}

const base = (set: CycleSet): TrendReadScope => ({
  set, filters: {}, ownVariant: OWN_VARIANT_ALL, ownedBasePrefixes: globalBaseUniverse(),
});
/** 코어(own·domains 회차 축) */
const coreScope = (set: CycleSet, withAxes = true): TrendReadScope => ({
  ...base(set), limits: G_CORE_LIMITS, axes: withAxes ? G_CORE_AXES : undefined,
});
/** 브랜드 1단 — 스냅샷(축 없음) */
const snapScope = (set: CycleSet): TrendReadScope => ({
  ...base(set), limits: G_BRAND_SNAPSHOT_LIMITS,
});
/** 브랜드 2단 — 회차 축 + 이름 제한. 제한 없이도 재서 2단의 이득을 본다. */
const seriesScope = (set: CycleSet, names?: string[]): TrendReadScope => ({
  ...base(set), limits: G_BRAND_SERIES_LIMITS, axes: G_BRAND_AXES, brandNames: names,
});

async function main() {
  const set = await loadSet();
  log(`회차 ${set.cycles.length} · anchors ${set.anchorCount}\n`);

  const run = async (label: string, st: ReturnType<typeof buildTrendStatements>) => {
    log(`══ ${label} — 문장 ${st.length}개 ══`);
    let sum = 0;
    const each: Array<[string, number]> = [];
    for (const s of st) {
      const ms = await explainOne(`${s.key} (${s.table})`, s.sql);
      each.push([s.key, ms]);
      sum += ms;
    }
    const longest = each.reduce((a, b) => (b[1] > a[1] ? b : a));
    log(`\n### ${label} 합 ${sum.toFixed(1)} ms · 최장 ${longest[0]} ${longest[1].toFixed(1)} ms\n`);
    return sum;
  };

  const lastCycle = set.cycles.reduce((a, b) => (a.cycleAnchorAt > b.cycleAnchorAt ? a : b));
  const snapSet: CycleSet = {
    ...set, mode: "snapshot", cycles: [lastCycle],
    cycleKey: `${lastCycle.cycleId}:${lastCycle.generationId}`,
    weeks: [lastCycle.cycleWeek], anchorCount: 1,
  };
  const names = (process.env.G_TREND_BRANDS ?? "Hyundai,Kia,Genesis,Toyota,Tesla,BMW,Mercedes-Benz,Honda,Porsche,Volkswagen").split(",");

  const core = await run("코어(own·domains 회차축)", buildTrendStatements(coreScope(set), { only: G_CORE_STATEMENT_KEYS }));
  await run("코어(축 OFF · 대조)", buildTrendStatements(coreScope(set, false), { only: G_CORE_STATEMENT_KEYS }));
  const snap = await run("브랜드 1단(스냅샷 1회차)", buildTrendStatements(snapScope(snapSet), { only: G_BRAND_STATEMENT_KEYS }));
  const s2 = await run(`브랜드 2단(top-${names.length} 제한)`, buildTrendStatements(seriesScope(set, names), { only: G_BRAND_STATEMENT_KEYS }));
  const s2all = await run("브랜드 2단(제한 없음 · 대조)", buildTrendStatements(seriesScope(set), { only: G_BRAND_STATEMENT_KEYS }));
  log(`### 화면별 DB 합 — 카드 추이 ${core.toFixed(1)} ms · 브랜드/우선노출도 ${(core + snap + s2).toFixed(1)} ms`);
  log(`### 2단의 이득 — 브랜드 회차축 제한없음 ${s2all.toFixed(1)} → 제한 ${s2.toFixed(1)} ms\n`);

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

  log(`══ 왕복 소요(min of ${REPEAT}, 터널 RTT 포함) ══`);
  const agg = await timed("집계층 코어 read (2문장)", () => readGlobalTrendCore(coreScope(set)));
  if (WITH_MIRROR) {
    const root = set.projectIds[0];
    const prefixes = globalBaseUniverse();
    const a = await timed("미러 fetchStandardTrend(week)", () =>
      aggregateStandardTrendFromMirror({}, "week", root, prefixes));
    const b = await timed("미러 kpiBrandTrend(28d)", () =>
      aggregateBrandTrendFromMirror({}, root, { unit: "week", topBrands: 10, trendDays: 28 }));
    const c = await timed("미러 kpiFirstPosition(84d)", () =>
      aggregateFirstPositionFromMirror({}, root, { unit: "week", topBrands: 10, trendDays: 84 }));
    log(`   → 미러 3함수 합 ${(a + b + c).toFixed(1)} ms vs 집계층 ${agg.toFixed(1)} ms` +
        ` = ${((a + b + c) / agg).toFixed(1)}배`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
