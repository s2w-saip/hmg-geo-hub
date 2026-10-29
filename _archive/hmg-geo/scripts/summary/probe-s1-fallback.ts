/**
 * S1 집계층 경로의 **폴백 3종** 실증 — 쓰기 0, 읽기만 (PR② T6 요건 4).
 *
 *   ① 미지원 축(depth2/depth3)          → `planTrendRead` 가 `unsupported-agg:*`
 *   ② `own_variant` 밖(admin 브랜드 다중) → `unsupported-agg:own-variant` (E4)
 *   ③ 접기 미실행(집계층 0행)            → `SummaryTrendRead.empty = true`
 *
 * ③ 은 **실재하지 않는 generation** 을 얼린 회차 집합으로 읽어 재현한다(쓰기 없음 —
 * 존재하지 않는 쌍은 0행을 낸다). 화면 키 allowlist 폴백(`screen-not-allowed`)은
 * 게이트 소관이라 `lib/summary/read/screens.test.ts` 가 이미 고정한다.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  summaryGlobalS1FromTrend,
  S1_TREND_AXES,
  S1_TREND_LIMITS,
} from "@/lib/db/repositories/summary-global-aggregates";
import {
  planTrendRead,
  resolveOwnVariantKey,
  type TrendReadScope,
} from "@/lib/db/repositories/summary-trend-aggregates";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import type { StandardFilters } from "@/lib/scope/result-adapter";

/* eslint-disable no-console */
const log = console.log;

async function loadSet(generationId?: string): Promise<CycleSet> {
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
    cycleId: r.cycle_id,
    generationId: generationId ?? r.generation_id,
    projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at,
    cycleWeek: r.cycle_week,
  }];
  return {
    surface: "global", mode: "snapshot", cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).join(","),
    projectIds: [r.project_id], missingProjectIds: [],
    weeks: [r.cycle_week], anchorCount: 1,
  };
}

const scopeOf = (set: CycleSet, filters: StandardFilters, variant: string): TrendReadScope => ({
  set, filters, ownVariant: variant, ownedBasePrefixes: ["https://www.hyundai.com/"],
  limits: S1_TREND_LIMITS, axes: S1_TREND_AXES,
});

async function main() {
  // ①②  미지원 축 판정 — DB 없이도 결정된다.
  const unsupported: Array<[string, StandardFilters]> = [
    ["depth2", { depth2: ["x"] }],
    ["depth3", { depth3: ["y"] }],
    ["admin 브랜드 다중 (Hyundai,Kia)", { brand: ["Hyundai", "Kia"] }],
    ["정상 (무필터)", {}],
    ["정상 (브랜드 1개)", { brand: ["Kia"] }],
  ];
  for (const [name, filters] of unsupported) {
    const plan = planTrendRead({ surface: "global", filters });
    log(`① 축 판정 · ${name}: ${plan.ok ? `ok(variant=${plan.ownVariant})` : `fallback:${plan.reason}`}`);
  }

  // ③  접기 미실행 = empty. 실재하지 않는 generation 쌍으로 0행을 만든다.
  const live = await loadSet();
  const ghost = await loadSet("00000000-0000-0000-0000-0000000000ff");
  const variant = resolveOwnVariantKey({}) as string;
  const liveRead = await summaryGlobalS1FromTrend(scopeOf(live, {}, variant));
  const ghostRead = await summaryGlobalS1FromTrend(scopeOf(ghost, {}, variant));
  log(`③ 라이브 generation: empty=${liveRead.empty}` +
      (liveRead.empty
        ? ""
        : ` · monitored=${liveRead.value.aggregates.totalAnswers} · GEO codes=${liveRead.value.geo?.codes.length ?? "null"}`));
  log(`③ 없는 generation: empty=${ghostRead.empty}  ← 폴백 신호(agg-empty · 카드+GEO 공용 read)`);

  // ③-b  변형 키가 어긋나도 조용히 0 이 되지 않는다(리더 주석의 계약).
  const badVariant = await summaryGlobalS1FromTrend(scopeOf(live, {}, "NOT_A_VARIANT"));
  log(`③-b 없는 own_variant: empty=${badVariant.empty}  ← 0 이 아니라 폴백이어야 한다`);

  // ④  **오폴백**(PR③ R1): `own` 은 있는데 `domains` 가 0인 셀 — 인용이 정말 0건이라
  //     값은 정확한데도 라운드 4의 `empty=some` 이 매번 세부층으로 돌렸다.
  //     여기서 그 셀을 DB 에서 **찾아** 읽어 `empty=false`(집계층 유지)를 실증한다.
  const c = live.cycles[0];
  const holes = (await getDb().execute(sql`
    WITH o AS (
      SELECT country, depth1, count(*)::int AS n FROM summary_trend_own
      WHERE surface='global' AND cycle_id=${c.cycleId}::uuid AND generation_id=${c.generationId}::uuid
        AND own_variant=${variant}
      GROUP BY 1,2),
    d AS (
      SELECT country, depth1, count(*)::int AS n FROM summary_trend_domains
      WHERE surface='global' AND cycle_id=${c.cycleId}::uuid AND generation_id=${c.generationId}::uuid
      GROUP BY 1,2)
    SELECT o.country, o.depth1 FROM o LEFT JOIN d USING (country, depth1)
    WHERE COALESCE(d.n,0) = 0 ORDER BY 1,2
  `)) as unknown as Array<{ country: string; depth1: string }>;
  log(`④ own 있고 domains 0 인 (country, depth1) 셀: ${holes.length}개`);
  for (const h of holes) {
    const f: StandardFilters = { region: [h.country], depth1: [h.depth1] };
    const read = await summaryGlobalS1FromTrend(scopeOf(live, f, variant));
    log(`   ${h.country} × ${h.depth1}: empty=${read.empty}` +
        (read.empty ? "  ← 오폴백(세부층으로 감)" : `  ← 집계층 유지 · 모수 ${read.value.aggregates.totalAnswers}`));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
