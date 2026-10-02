/**
 * 회차 축 3종(`cycle` · `cycleBrand` · `cycleDomain`)이 실 DB 에서 무엇을 내는가 —
 * 쓰기 0, 읽기만 (PR③ 글로벌 추이 전환의 첫 확인).
 *
 * 확인하는 것:
 *   ① 새 grouping set 이 SQL 오류 없이 돈다(EXPLAIN 은 컬럼 오타를 못 잡는다).
 *   ② `axis` 판별이 새 축을 다른 축으로 접지 않는다 — 특히 도메인 `'cycle'` 이
 *      `'total'` 로 섞이면 ⑤ 분모가 회차 수만큼 부푼다.
 *   ③ 축을 켜도 **기존 축의 값이 바뀌지 않는다**(회귀 0) — 같은 회차 집합에서
 *      축 off/on 의 `total` 행을 대조한다.
 *   ④ 회차 축 합 = 전체 합(가산성).
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/probe-cycle-axes.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  readTrendAggregates,
  type TrendReadScope,
} from "@/lib/db/repositories/summary-trend-aggregates";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

/* eslint-disable no-console */
const log = console.log;

async function loadSet(): Promise<CycleSet> {
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text
    FROM summary_cycles
    WHERE surface = 'global' AND active_generation_id IS NOT NULL
    ORDER BY cycle_anchor_at DESC
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

const scopeOf = (set: CycleSet, axes: TrendReadScope["axes"]): TrendReadScope => ({
  set, filters: {}, ownVariant: OWN_VARIANT_ALL,
  ownedBasePrefixes: globalBaseUniverse(), axes,
});

async function main() {
  const set = await loadSet();
  log(`회차 ${set.cycles.length} · anchors ${set.anchorCount} · 프로젝트 ${set.projectIds.length}`);

  const off = await readTrendAggregates(scopeOf(set, undefined), {
    only: ["own", "brands", "domains"],
  });
  const on = await readTrendAggregates(
    scopeOf(set, { cycle: true, cycleBrand: true, cycleDomain: true }),
    { only: ["own", "brands", "domains"] },
  );

  // ③ 회귀 0 — 축을 켜도 기존 축 값이 그대로인가.
  const ownOff = off.own.find((r) => r.axis === "total");
  const ownOn = on.own.find((r) => r.axis === "total");
  const domOff = off.domains.find((r) => r.axis === "total");
  const domOn = on.domains.find((r) => r.axis === "total");
  const brOff = off.brands.filter((r) => r.axis === "brand");
  const brOn = on.brands.filter((r) => r.axis === "brand");
  const sumM = (rows: typeof brOff) => rows.reduce((s, r) => s + r.mentions, 0);
  log(`\n③ 축 off/on 회귀 (0 이어야 한다)`);
  log(`   own.total monitored   ${ownOff?.monitored} → ${ownOn?.monitored}`);
  log(`   own.total compMentions ${ownOff?.compMentions} → ${ownOn?.compMentions}`);
  log(`   dom.total citations   ${domOff?.citations} → ${domOn?.citations}`);
  log(`   dom.total owned       ${domOff?.ownedCitations} → ${domOn?.ownedCitations}`);
  log(`   brand 축 행수/언급합   ${brOff.length}/${sumM(brOff)} → ${brOn.length}/${sumM(brOn)}`);

  // ② 축 판별
  const ownAxes = new Map<string, number>();
  for (const r of on.own) ownAxes.set(r.axis, (ownAxes.get(r.axis) ?? 0) + 1);
  const brAxes = new Map<string, number>();
  for (const r of on.brands) brAxes.set(r.axis, (brAxes.get(r.axis) ?? 0) + 1);
  const domAxes = new Map<string, number>();
  for (const r of on.domains) domAxes.set(r.axis, (domAxes.get(r.axis) ?? 0) + 1);
  log(`\n② 축별 행수`);
  log(`   own    ${[...ownAxes].map(([k, v]) => `${k}:${v}`).join(" · ")}`);
  log(`   brands ${[...brAxes].map(([k, v]) => `${k}:${v}`).join(" · ")}`);
  log(`   domains ${[...domAxes].map(([k, v]) => `${k}:${v}`).join(" · ")}`);

  // ④ 가산성 — 회차 축 합 = 전체 합
  const cycleOwn = on.own.filter((r) => r.axis === "cycle");
  const cycleDom = on.domains.filter((r) => r.axis === "cycle");
  const cycleBrand = on.brands.filter((r) => r.axis === "cycle-brand");
  log(`\n④ 회차 축 가산성`);
  log(`   own    Σcycle.monitored ${cycleOwn.reduce((s, r) => s + r.monitored, 0)} vs total ${ownOn?.monitored}`);
  log(`   own    Σcycle.compMentions ${cycleOwn.reduce((s, r) => s + r.compMentions, 0)} vs total ${ownOn?.compMentions}`);
  log(`   dom    Σcycle.citations ${cycleDom.reduce((s, r) => s + r.citations, 0)} vs total ${domOn?.citations}`);
  log(`   dom    Σcycle.owned     ${cycleDom.reduce((s, r) => s + r.ownedCitations, 0)} vs total ${domOn?.ownedCitations}`);
  log(`   brands Σcycle-brand.mentions ${cycleBrand.reduce((s, r) => s + r.mentions, 0)} vs brand축 ${sumM(brOn)}`);
  log(`\n   anchors(own)    ${[...new Set(cycleOwn.map((r) => r.cycleAnchorAt))].join(", ")}`);
  log(`   anchors(domains) ${[...new Set(cycleDom.map((r) => r.cycleAnchorAt))].join(", ")}`);
  log(`   anchors(brands)  ${[...new Set(cycleBrand.map((r) => r.cycleAnchorAt))].join(", ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
