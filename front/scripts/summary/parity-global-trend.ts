/**
 * 글로벌 **추이 3종** 패리티 — 쓰기 0, 읽기만 (PR③).
 *
 * 오늘 미러 경로와 새 집계층 경로를 **겹치는 회차**에서 대조한다. 지금 라이브 원장에
 * 노출 가능한 글로벌 회차는 `74eca7fb`(anchor 2026-08-31) **하나**뿐이므로, 미러의
 * 주(week) 버킷 `2026-08-31` 과 집계층의 회차 버킷 `2026-08-31` 을 맞대 본다.
 *
 * ⚠️ **0 오차를 기대할 수 없는 항목이 구조적으로 있다.** 두 축이 정의부터 다르다:
 *   · 미러 버킷 = `date_trunc('week', measured_at)`, 집계층 버킷 = `cycle_anchor_at`.
 *     8/1 이후 `measured_at ≠ cycle_anchor_at` 인 답변이 59,527건 있다 — 회차가 주
 *     경계를 넘겨 측정되면 같은 답변이 다른 버킷에 든다.
 *   · 미러 답변셋은 셀(prompt×target×region)당 최신 1건 dedupe + 120일 창,
 *     집계층은 그 회차에 굳혀진 행 전부.
 *   · ⑤ 판정식이 다르다 — 미러 추이는 `ownedBasePrefixClause` 만 쓰고
 *     **도메인 정규식 폴백 분기가 없다**(`citationOwnedClause` 를 안 쓴다).
 *     집계층은 카드와 같은 `ownedCitationExpr`(폴백 포함)를 쓴다.
 *   · 우선노출도 `avgPosition` 은 미러가 `(name,job)` avg 의 답변 가중 평균,
 *     집계층이 `(job,brand_id)` `min(avg_position)` 의 합/개수다.
 * 그래서 이 하네스는 **판정하지 않고 차이를 그대로 찍는다**. 판정은 사람이 한다.
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-global-trend.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  aggregateStandardTrendFromMirror,
  aggregateBrandTrendFromMirror,
  aggregateFirstPositionFromMirror,
} from "@/lib/db/repositories/scope-aggregates";
import {
  readGlobalTrendCore,
  readGlobalBrandSnapshot,
  readGlobalBrandSeries,
  attachBrandSeries,
  pickSeriesBrands,
  toStandardTrendBuckets,
  toBrandTrend,
  toFirstPosition,
} from "@/lib/db/repositories/summary-global-trend-read";
import { resolveOwnVariantKey } from "@/lib/db/repositories/summary-trend-aggregates";
import { ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { restrictToFleetVisible, type CycleSet } from "@/lib/summary/read/cycle-set";

/* eslint-disable no-console */
const log = console.log;
const n = (v: unknown) => Number(v ?? 0);

async function loadSet(): Promise<CycleSet> {
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text, fleet_visible
    FROM summary_cycles
    WHERE surface = 'global' AND active_generation_id IS NOT NULL
    ORDER BY cycle_anchor_at
  `)) as unknown as Array<{
    cycle_id: string; generation_id: string; project_id: string;
    cycle_anchor_at: string; cycle_week: string; fleet_visible: boolean | null;
  }>;
  if (!rows.length) throw new Error("활성 generation 이 있는 global 회차가 없다");
  const cycles = rows.map((r) => ({
    cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
    fleetVisible: r.fleet_visible !== false,
  }));
  // 프로덕션 읽기 경로(`server.ts::viaGlobalSeries`)와 **같은 집합**이어야 한다 —
  // 중복 주의 패자를 여기서 안 빼면 하네스가 화면에 없는 점을 대조하게 된다(2026-09-18).
  return restrictToFleetVisible({
    surface: "global", mode: "period", cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
  });
}

const ownedPrefixesFor = (f: StandardFilters): string[] =>
  ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.websiteCountry ?? f.region, f.lang);

const diff = (a: number, b: number) => (b - a === 0 ? "0" : `**${b - a > 0 ? "+" : ""}${b - a}** (${a}→${b})`);

async function main() {
  const set = await loadSet();
  const root = set.projectIds[0];
  const filters: StandardFilters = {};
  const prefixes = ownedPrefixesFor(filters);
  const variant = resolveOwnVariantKey(filters);
  if (!variant) throw new Error("own_variant 없음");
  log(`회차 ${set.cycles.length} · anchors ${set.anchorCount} · root ${root}`);
  log(`anchors: ${set.cycles.map((c) => c.cycleAnchorAt.slice(0, 10)).join(", ")}\n`);

  const scope = { set, filters, ownVariant: variant, ownedBasePrefixes: prefixes };
  const core = await readGlobalTrendCore(scope);
  if (core.empty) { log("집계층 비어 있음 — 폴백"); return; }
  // 브랜드는 2단 — 스냅샷(마지막 회차)에서 top-10 을 고르고 그 이름으로만 회차 축.
  const last = set.cycles.reduce((a, b) => (a.cycleAnchorAt > b.cycleAnchorAt ? a : b));
  const snapSet: CycleSet = {
    ...set, mode: "snapshot", cycles: [last],
    cycleKey: `${last.cycleId}:${last.generationId}`, weeks: [last.cycleWeek], anchorCount: 1,
  };
  const snap = await readGlobalBrandSnapshot({ ...scope, set: snapSet });
  if (snap.empty) { log("브랜드 스냅샷 비어 있음 — 폴백"); return; }
  const names = pickSeriesBrands(snap.value, 10).map((b) => b.brand);
  const bySeries = await readGlobalBrandSeries(scope, names);
  if (bySeries.empty) { log("브랜드 회차축 비어 있음 — 폴백"); return; }
  const series = attachBrandSeries(core.value, bySeries.value, snap.value);
  const keys = series.buckets.map((b) => b.bucketStart);
  log(`집계층 버킷: ${keys.join(", ")}`);

  // ── ① StandardTrendBucket ────────────────────────────────────────────────
  const mirTrend = await aggregateStandardTrendFromMirror(filters, "week", root, prefixes);
  const aggTrend = toStandardTrendBuckets(series);
  log(`\n① 카드 시계열 — 미러 주버킷 ${mirTrend.length}개 / 집계층 회차버킷 ${aggTrend.length}개`);
  log(`   미러 버킷: ${mirTrend.map((b) => b.bucketStart).join(", ")}`);
  const F = ["answers", "trackedAnswers", "totalMentions", "trackedMentions",
    "sentMentions", "positiveMentions", "totalCitations", "ownedCitations"] as const;
  log(`   버킷 | ${F.join(" | ")} | avgPos`);
  for (const key of keys) {
    const m = mirTrend.find((b) => b.bucketStart === key);
    const a = aggTrend.find((b) => b.bucketStart === key);
    if (!m || !a) { log(`   ${key}: ${m ? "집계층" : "미러"} 없음 — 대조 불가`); continue; }
    log(`   ${key} | ${F.map((f) => diff(n(m[f]), n(a[f]))).join(" | ")} | ${m.avgPosition}→${a.avgPosition}`);
  }

  // ── ② BrandTrendResult ───────────────────────────────────────────────────
  const mirBrand = await aggregateBrandTrendFromMirror(filters, root, { unit: "week", topBrands: 10, trendDays: 91 });
  const aggBrand = toBrandTrend(series, { unit: "week", cap: 10, filters });
  log(`\n② 브랜드 추이 — 시리즈 ${mirBrand.brands.length}→${aggBrand.brands.length}`);
  log(`   미러 시리즈: ${mirBrand.brands.map((b) => b.brand).join(", ")}`);
  log(`   집계층 시리즈: ${aggBrand.brands.map((b) => b.brand).join(", ")}`);
  for (const key of keys) {
    const m = mirBrand.buckets.find((b) => b.bucketStart === key);
    const a = aggBrand.buckets.find((b) => b.bucketStart === key);
    if (!m || !a) { log(`   ${key}: ${m ? "집계층" : "미러"} 없음`); continue; }
    log(`   ${key} | answers ${diff(m.answers, a.answers)} | totalMentions ${diff(m.totalMentions, a.totalMentions)}`);
    for (const b of aggBrand.brands.slice(0, 4)) {
      const mb = m.brands.find((x) => x.brand === b.brand);
      const ab = a.brands.find((x) => x.brand === b.brand);
      if (!mb || !ab) { log(`      ${b.brand}: ${mb ? "집계층" : "미러"} 없음`); continue; }
      log(`      ${b.brand} | mentions ${diff(mb.mentions, ab.mentions)} | answers ${diff(mb.answers, ab.answers)}`
        + ` | share ${mb.sharePct}→${ab.sharePct} | exposure ${mb.exposurePct}→${ab.exposurePct}`);
    }
  }

  // ── ③ FirstPositionResult ────────────────────────────────────────────────
  const mirFp = await aggregateFirstPositionFromMirror(filters, root, { unit: "week", topBrands: 10, trendDays: 91 });
  // 미러는 **경쟁 순위 축**이다(`scope-aggregates.ts:3326-3331` 의 `pos`→`rk`) — 그러니
  // 대조 상대는 `"comp"` 다. `"ordinal"`(본문 서수, 오늘의 `S1.firstPosition`)은 미러에
  // 없는 양이라 나란히 찍어 **얼마나 다른 양인지** 보이게만 한다(0069 / PR④-b).
  const aggFp = toFirstPosition(series, { unit: "week", cap: 10, positionAxis: "comp" });
  const aggFpOrd = toFirstPosition(series, { unit: "week", cap: 10, positionAxis: "ordinal" });
  log(`\n③ 우선노출도 — 시리즈 ${mirFp.brands.length}→${aggFp.brands.length} · latest ${mirFp.latest.length}→${aggFp.latest.length}`);
  log(`   ⚠️ latest 모집단이 다르다: 미러=스냅샷 창(최근 7일 run), 집계층=마지막 회차`);
  log(`   브랜드 | 미러 latest(avgPos/rank/ranked) | 집계층 latest(comp 축) | 집계층 서수축`);
  for (const b of aggFp.latest.slice(0, 6)) {
    const m = mirFp.latest.find((x) => x.brand === b.brand);
    const o = aggFpOrd.latest.find((x) => x.brand === b.brand);
    log(`   ${b.brand} | ${m ? `${m.avgPosition}/${m.rank}/${m.rankedAnswers}` : "없음"}`
      + ` | ${b.avgPosition}/${b.rank}/${b.rankedAnswers}`
      + ` | ${o?.avgPosition ?? "-"}/${o?.rank ?? "-"}/${o?.rankedAnswers ?? "-"}`);
  }
  for (const key of keys) {
    const m = mirFp.buckets.find((b) => b.bucketStart === key);
    const a = aggFp.buckets.find((b) => b.bucketStart === key);
    if (!m || !a) { log(`   버킷 ${key}: ${m ? "집계층" : "미러"} 없음`); continue; }
    log(`   버킷 ${key} — 브랜드별 avgPosition(미러→집계층)`);
    for (const b of aggFp.brands.slice(0, 4)) {
      const mb = m.brands.find((x) => x.brand === b);
      const ab = a.brands.find((x) => x.brand === b);
      log(`      ${b} | ${mb?.avgPosition ?? "-"}→${ab?.avgPosition ?? "-"}`
        + ` | ranked ${mb?.rankedAnswers ?? "-"}→${ab?.rankedAnswers ?? "-"}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
