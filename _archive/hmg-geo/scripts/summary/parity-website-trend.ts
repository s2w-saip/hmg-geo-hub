/**
 * 웹사이트 추이 2종 **패리티 + 소요** — 쓰기 0, 읽기·EXPLAIN 만 (PR③).
 *
 * 대조 축은 "측정일 주 버킷 ↔ 회차 버킷" 이다. 미러는 `date_trunc('week', measured_at)` 로,
 * 집계층은 **`cycle_week`** 로 접고 표시일만 그 주 함대의 min anchor 로 둔다 — 그래서 값을
 * 맞대는 것은 "그 회차의 측정이 전부 들어 있는 주" 하나뿐이고, 이 스크립트는 그 대응을
 * 대표 anchor 의 주(월요일)로 계산해 짝짓는다.
 *
 * 찍는 것:
 *   ① 미러 주 버킷 전체 · 집계층 회차 버킷 전체
 *   ② 겹치는 버킷의 정수 8종 오차(answers · ① 분자 · ② 분모/분자 · ③ 분모/분자 · ⑤ 분모/분자)
 *   ③ ⑥ 두 경로(미러 주 버킷 vs 집계층 회차 버킷)
 *   ④ 소요 — 집계층 ①·⑥ 각각 N회, 미러 ① 1회(느리다)
 *   ⑤ ⑥ 문장의 EXPLAIN (ANALYZE, BUFFERS) 요약
 *
 * 사용:
 *   bash (내부 작업 파일) <워크트리> npx tsx --tsconfig scripts/summary/tsconfig.json \
 *     scripts/summary/parity-website-trend.ts [--repeat=3] [--mirror] [--explain]
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  aggregateStandardTrendFromMirror,
  aggregateWebsiteCitationAccuracyTrend,
  websiteDeclaredOwnedBases,
  type StandardTrendBucket,
} from "@/lib/db/repositories/scope-aggregates";
import {
  summaryWebsiteTrend,
  summaryWebsiteCitationAccuracyTrend,
} from "@/lib/db/repositories/summary-website-aggregates";
import {
  summaryUnitFlagsAvailable,
  websiteExcludedUnits,
} from "@/lib/db/repositories/summary-settings";
import { getWebsiteScopeProjectIds } from "@/lib/db/repositories/website-sites";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import type { WebsiteCyclePick } from "@/lib/db/repositories/summary-cycles";
import type { StandardFilters } from "@/lib/scope/result-adapter";

/* eslint-disable no-console */
const log = console.log;
const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const REPEAT = Number(arg("repeat") ?? 3);
const WITH_MIRROR = argv.includes("--mirror");
const WITH_EXPLAIN = argv.includes("--explain");
const WEBSITE_TARGETS_OWNED = true;

const n = (v: unknown) => Number(v ?? 0);
/** UTC 월요일 — 미러 `date_trunc('week', …)` 와 같은 규칙. */
const mondayOf = (iso: string): string => {
  const d = new Date(iso);
  const dow = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
};

type CycleRow = {
  cycle_id: string; generation_id: string; project_id: string;
  cycle_anchor_at: string; cycle_week: string;
};

const rows = (await getDb().execute(sql`
  SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
         cycle_anchor_at::text, cycle_week::text
  FROM summary_cycles
  WHERE surface = 'website' AND active_generation_id IS NOT NULL
    AND view_anchor_at IS NOT NULL AND view_anchor_at <= now() AND fleet_visible
  ORDER BY cycle_anchor_at, project_id
`)) as unknown as CycleRow[];
if (!rows.length) throw new Error("노출 가능한 website 회차가 없다");

const cycles: WebsiteCyclePick[] = rows.map((r) => ({
  cycleId: r.cycle_id,
  generationId: r.generation_id,
  projectId: r.project_id,
  cycleAnchorAt: new Date(r.cycle_anchor_at).toISOString(),
  cycleWeek: r.cycle_week.slice(0, 10),
}));
const anchors = [...new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10)))].sort();
const set: CycleSet = {
  surface: "website",
  mode: "period",
  cycles,
  cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
  projectIds: [...new Set(cycles.map((c) => c.projectId))],
  missingProjectIds: [],
  weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
  anchorCount: anchors.length,
};

const filters: StandardFilters = {};
const ids = await getWebsiteScopeProjectIds();
const own = await websiteDeclaredOwnedBases(filters, set.projectIds);
const [unitFlags, excludedUnits] = await Promise.all([
  summaryUnitFlagsAvailable(),
  websiteExcludedUnits(),
]);
const scope = {
  set,
  cycles,
  projectIds: set.projectIds,
  filters,
  ownedBasePrefixes: own.prefixes,
  unitFlags,
  excludedUnits,
};
log(`회차 ${cycles.length}개 · anchor ${anchors.join(", ")} · 프로젝트 ${set.projectIds.length}/${ids.length}`);
log(`unitFlags=${unitFlags} excluded=${JSON.stringify(excludedUnits)} bases=${own.prefixes.length}`);

// ── ① 추이 ──────────────────────────────────────────────────────────────────
const t0 = Date.now();
const agg = await summaryWebsiteTrend(scope);
const aggMs = Date.now() - t0;
const show = (b: StandardTrendBucket) =>
  `${b.bucketStart} answers ${b.answers} ①${b.trackedAnswers} ②${b.trackedMentions}/${b.totalMentions}` +
  ` ③${b.positiveMentions}/${b.sentMentions} ④${b.avgPosition} ⑤${b.ownedCitations}/${b.totalCitations}`;
log(`\n[집계층 회차 버킷] ${agg.length}개 · ${aggMs} ms`);
agg.forEach((b) => log("  " + show(b)));

if (WITH_MIRROR) {
  const m0 = Date.now();
  const mirror = await aggregateStandardTrendFromMirror(
    filters, "week", set.projectIds, own.prefixes, own.universe, WEBSITE_TARGETS_OWNED,
  );
  log(`\n[미러 주 버킷] ${mirror.length}개 · ${Date.now() - m0} ms`);
  mirror.forEach((b) => log("  " + show(b)));

  log("\n[겹치는 버킷 정수 오차] (집계층 − 미러)");
  const byWeek = new Map(mirror.map((b) => [b.bucketStart.slice(0, 10), b]));
  for (const a of agg) {
    const w = mondayOf(a.cycleAnchorAt ?? a.bucketStart);
    const m = byWeek.get(w);
    if (!m) { log(`  ${a.bucketStart} → 미러 주 ${w} 없음`); continue; }
    const diffs: string[] = [];
    const cmp = (label: string, x: number, y: number) => {
      if (x !== y) diffs.push(`${label} ${x} vs ${y} (${x - y >= 0 ? "+" : ""}${x - y})`);
    };
    cmp("answers", a.answers, m.answers);
    cmp("①분자", a.trackedAnswers, m.trackedAnswers);
    cmp("②분모", a.totalMentions, m.totalMentions);
    cmp("②분자", a.trackedMentions, m.trackedMentions);
    cmp("③분모", a.sentMentions, m.sentMentions);
    cmp("③분자", a.positiveMentions, m.positiveMentions);
    cmp("⑤분모", a.totalCitations, m.totalCitations);
    cmp("⑤분자", a.ownedCitations, m.ownedCitations);
    cmp("④", n(a.avgPosition), n(m.avgPosition));
    log(`  ${a.bucketStart} ↔ 주 ${w}: ${diffs.length ? diffs.join(" · ") : "오차 0"}`);
  }
}

// ── ⑥ 추이 ──────────────────────────────────────────────────────────────────
const a0 = Date.now();
const acc = await summaryWebsiteCitationAccuracyTrend(scope);
const accMs = Date.now() - a0;
log(`\n[⑥ 집계층 회차 버킷] ${acc.length}개 · ${accMs} ms`);
acc.forEach((b) => log(`  ${b.bucketStart} ${b.targetAnswers}/${b.ownedAnswers} = ${b.rate}%`));

if (WITH_MIRROR) {
  const am = await aggregateWebsiteCitationAccuracyTrend(
    filters, "week", set.projectIds, own.prefixes, own.universe,
  );
  log(`[⑥ 미러 주 버킷] ${am.length}개`);
  am.forEach((b) => log(`  ${b.bucketStart} ${b.targetAnswers}/${b.ownedAnswers} = ${b.rate}%`));
}

// ── 카드 ↔ 회차 버킷 (같은 회차·같은 집계층: **오차 0 이어야 한다**) ─────────
if (argv.includes("--card")) {
  const { summaryWebsiteAggregates, summaryWebsiteCitationAccuracy } =
    await import("@/lib/db/repositories/summary-website-aggregates");
  const card = await summaryWebsiteAggregates(scope);
  const acc6 = await summaryWebsiteCitationAccuracy(scope);
  const b = agg.find((x) => x.bucketStart === anchors[anchors.length - 1]);
  if (!card || !b) { log("\n[카드 대조] 카드 또는 마지막 회차 버킷이 없다"); }
  else {
    const tracked = card.brands.filter((x) => x.isTracked).reduce((s, x) => s + x.mentionCount, 0);
    const pairs: Array<[string, number, number]> = [
      ["answers", b.answers, card.totalAnswers],
      ["①분자", b.trackedAnswers, card.trackedAnswerCount],
      ["②분모", b.totalMentions, card.totalMentions],
      ["②분자", b.trackedMentions, tracked],
      ["③분모", b.sentMentions, card.sentiment.sampledMentions],
      ["③분자", b.positiveMentions, card.sentiment.positiveMentions],
      ["④", n(b.avgPosition), n(card.position.avgPosition)],
      ["⑤분모", b.totalCitations, card.citations.totalCitations],
      ["⑤분자", b.ownedCitations, card.citations.ownedCitations],
    ];
    log("\n[카드 대조] (회차 버킷 vs 카드) — 같은 회차·같은 집계층");
    for (const [k, x, y] of pairs) {
      log(`  ${k}: ${x} vs ${y} ${x === y ? "= 0" : `**${x - y >= 0 ? "+" : ""}${x - y}**`}`);
    }
    const b6 = acc[0];
    if (b6) {
      log(`  ⑥분모: ${b6.ownedAnswers} vs ${acc6.ownedAnswers} ${b6.ownedAnswers === acc6.ownedAnswers ? "= 0" : "**차이**"}`);
      log(`  ⑥분자: ${b6.targetAnswers} vs ${acc6.targetAnswers} ${b6.targetAnswers === acc6.targetAnswers ? "= 0" : "**차이**"}`);
    }
  }
}

// ── 소요 반복 ───────────────────────────────────────────────────────────────
const times: Record<string, number[]> = { trend: [], accuracy: [] };
for (let i = 0; i < REPEAT; i++) {
  let s = Date.now(); await summaryWebsiteTrend(scope); times.trend.push(Date.now() - s);
  s = Date.now(); await summaryWebsiteCitationAccuracyTrend(scope); times.accuracy.push(Date.now() - s);
}
log(`\n[소요 ${REPEAT}회] ① ${times.trend.join("/")} ms · ⑥ ${times.accuracy.join("/")} ms`);

// ── EXPLAIN (⑥ 세부층 문장) ─────────────────────────────────────────────────
if (WITH_EXPLAIN) {
  const { __testables } = await import("@/lib/db/repositories/summary-website-aggregates");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const q = sql`
    SELECT cycle_id::text AS cycle_id,
           COALESCE(sum((unit_owned::int = 1)::int), 0)::int AS owned_answers,
           COALESCE(sum((unit_owned::int = 1 AND unit_target::int = 1)::int), 0)::int AS target_answers
    FROM summary_answers WHERE ${__testables.answerWhere(scope)}
    GROUP BY cycle_id`;
  // 유닛 경로 밖(플랜이 지목한 `summary_target_hits`)도 회차 GROUP BY 로 예산 안인지 함께 본다.
  const q2 = sql`
    WITH t AS (
      SELECT cycle_id, job_id,
             bool_or(matched_base_tracked <> '') AS owned, bool_or(cardinality(target_keys) > 0) AS target
      FROM summary_target_hits WHERE ${__testables.factScope(scope)}
      GROUP BY cycle_id, job_id
    )
    SELECT cycle_id::text, count(*) FILTER (WHERE owned)::int AS owned_answers,
           count(*) FILTER (WHERE owned AND target)::int AS target_answers
    FROM t GROUP BY cycle_id`;
  // ① 추이가 내는 **그 문장**(집계층 own · 회차 축).
  const { buildTrendStatements } = await import("@/lib/db/repositories/summary-trend-aggregates");
  const { WEBSITE_TREND_AXES } = await import("@/lib/db/repositories/summary-website-aggregates");
  const [ownStmt] = buildTrendStatements(
    {
      set, filters, ownVariant: "ALL", ownedBasePrefixes: own.prefixes,
      unitFlags, excludedUnits,
      limits: { domain: null, group: null, brand: null, geoBrandPerCountry: null },
      axes: WEBSITE_TREND_AXES,
    },
    { only: ["own"] },
  );
  for (const [label, stmt] of [
    ["① own(회차 축)", ownStmt.sql],
    ["유닛(summary_answers)", q],
    ["target_hits", q2],
  ] as const) {
    const c = dialect.sqlToQuery(stmt);
    const plan = (await getDb().execute(
      sql.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${bind(c.sql, c.params)}`),
    )) as unknown as Array<Record<string, unknown>>;
    const j = (plan[0]?.["QUERY PLAN"] ?? plan[0]) as Array<Record<string, unknown>>;
    const root = Array.isArray(j) ? j[0] : (j as Record<string, unknown>);
    log(`\n[⑥ EXPLAIN · ${label}] Execution ${root?.["Execution Time"]} ms · Planning ${root?.["Planning Time"]} ms`);
  }
}

/** EXPLAIN 은 바인드를 못 받으므로 리터럴로 굳힌다 — **이 스크립트 전용**(읽기 전용 하네스). */
function bind(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, i) => {
    const v = params[Number(i) - 1];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return `ARRAY[${v.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(",")}]`;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

process.exit(0);
