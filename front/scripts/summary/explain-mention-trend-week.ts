/**
 * 언급 추이 **주 격자 키** A/B EXPLAIN 하네스 — 쓰기 0, 읽기·EXPLAIN 만 (2026-09-17).
 *
 * 리포 규율("성능 영향이 있는 SQL 변경은 EXPLAIN 근거 없이 배포 금지")의 근거를 만든다.
 * `scope-aggregates.ts::trendWeekKey` 가 `cycle` 에서 `ans` CTE 에 LEFT JOIN 둘
 * (`summary_cycle_runs` · `summary_cycles`)을 더하므로, 그 조인이 플랜을 바꾸는지 본다.
 *
 * `explain-mirror-heavy.ts --path=s2 --explain --week=…` 는 **경로 전체**의 문장 census 다.
 * 이 파일은 그 안의 **추이 문장 하나**만 떼어, 같은 세션에서 두 변형을 번갈아 태운다
 * (콜드/워밍 편향을 없애려면 A→B→A→B 가 A×3→B×3 보다 낫다).
 *
 * ⚠️ **EXPLAIN 경로**(기본)는 `withAnswerSet` 의 TEMP 테이블을 쓰지 않는다 —
 *    `answerWhere(allRuns)` 를 인라인으로 갖는 독립 문장이라 밖에서 그대로 EXPLAIN 할 수
 *    있다(s2 의 다른 문장들과 다른 점이고, `explain-mirror-heavy.ts` 머리 주석의 제약이
 *    여기엔 없다). 따라서 EXPLAIN 만 돌릴 때는 `READ ONLY` 트랜잭션에서도 돈다.
 *
 * ⚠️ **`--rows` 는 다르다.** 리더 전체(`aggregateMentionsFromMirror`)를 실제로 실행하므로
 *    그 경로의 `withAnswerSet` 이 **`CREATE TEMP TABLE _answer_set ON COMMIT DROP` +
 *    `ANALYZE _answer_set`** 를 발행한다. 세션 임시 객체라 **영속 쓰기는 아니고**(커밋 시
 *    사라진다) 고객 데이터를 건드리지도 않지만, `SET TRANSACTION READ ONLY` 세션에서는
 *    TEMP 생성이 거부되어 **`--rows` 가 돌지 않는다**. 읽기 전용 제약이 걸린 환경에서는
 *    `--rows` 없이(EXPLAIN 만) 쓰고, 값 대조는 별도 SELECT 로 한다.
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json \
 *       scripts/summary/explain-mention-trend-week.ts [--repeat=3] [--full] [--rows]
 *   · `--repeat=0 --rows` = 값 대조만(EXPLAIN 생략).
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  aggregateMentionsFromMirror,
  answerWhere,
  excludeHiddenCycleRuns,
  mentionBrandDayCountsQuery,
  trendWeekKey,
  TREND_WINDOW_DAYS,
  type TrendWeekSource,
} from "@/lib/db/repositories/scope-aggregates";
import { bulkMirrorRunVisibleSql } from "@/lib/db/repositories/scope-mirror-progress-read";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const REPEAT = Number(arg("repeat") ?? 3);
const FULL = argv.includes("--full");
/**
 * EXPLAIN **없이** 리더를 두 변형으로 실제 실행해 주별 값을 나란히 찍는다.
 * EXPLAIN 은 값을 안 본다 — 주 배정이 실제로 고쳐졌는지는 이 플래그가 본다.
 */
const ROWS = argv.includes("--rows");
const ROW_BRANDS = (arg("brands") ?? "Hyundai,Kia,Genesis").split(",");
const ROW_WEEKS = Number(arg("weeks") ?? 12);
/* eslint-disable no-console */
const log = console.log;

const dialect = new PgDialect();
const db = getDb();

async function build(source: TrendWeekSource) {
  // 리더와 같은 순서 — 프로브를 먼저 끝내야 술어가 같은 모양으로 나온다.
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const wk = await trendWeekKey(source);
  return mentionBrandDayCountsQuery({
    filters: {},
    wk,
    trendFloor: sql`a.measured_at >= now() - ${sql.raw(`interval '${TREND_WINDOW_DAYS} days'`)}`,
    answerWhere: answerWhere({}, undefined, { allRuns: true }),
    notHidden: await excludeHiddenCycleRuns(sql`a.run_id`, "mention"),
    seriesClause: sql``,
  });
}

async function explain(source: TrendWeekSource): Promise<{ exec: number; plan: string }> {
  // 바인드를 보존해야 한다 — 문장을 문자열로 평탄화하면 계획 재사용·형변환이 달라진다.
  const rows = (await db.execute(
    sql`EXPLAIN (ANALYZE, BUFFERS) ${await build(source)}`,
  )) as unknown as Array<Record<string, string>>;
  const plan = rows.map((r) => Object.values(r)[0]).join("\n");
  return { exec: Number(/Execution Time: ([\d.]+)/.exec(plan)?.[1] ?? 0), plan };
}

/** 문장 길이·바인드 수 — 두 변형의 차이가 조인 둘뿐임을 눈으로 확인하는 용도. */
function shape(q: { sql: string; params: unknown[] }): string {
  return `${q.sql.replace(/\s+/g, " ").length} chars · ${q.params.length} binds`;
}

for (const source of ["measured", "cycle"] as const) {
  log(`  ${source.padEnd(8)} 문장 — ${shape(dialect.sqlToQuery(await build(source)))}`);
}

if (ROWS) {
  log("\n── 주별 값 대조 (리더 실행 · EXPLAIN 없음) ─────────────────────────────");
  const got: Record<string, Map<string, Record<string, number | null>>> = {};
  for (const source of ["measured", "cycle"] as const) {
    const live = await aggregateMentionsFromMirror({}, undefined, "none", {}, source);
    const t = live?.trend;
    const byWeek = new Map<string, Record<string, number | null>>();
    for (const p of t?.points ?? []) {
      const week = String(p.week);
      const row: Record<string, number | null> = {};
      for (const b of ROW_BRANDS) row[b] = (p[b] as number | null | undefined) ?? null;
      byWeek.set(week, row);
    }
    got[source] = byWeek;
    log(`  ${source.padEnd(8)} 시리즈 ${t?.series.length ?? 0}개 · 점 ${t?.points.length ?? 0}개`);
  }
  const weeks = [...new Set([...got.measured.keys(), ...got.cycle.keys()])].sort().slice(-ROW_WEEKS);
  const cell = (v: number | null | undefined) => (v == null ? "-" : String(v)).padStart(8);
  log(`\n  주          ${ROW_BRANDS.map((b) => `${b} 종전/신규`.padStart(22)).join("")}`);
  for (const w of weeks) {
    const a = got.measured.get(w);
    const b = got.cycle.get(w);
    log(`  ${w}  ${ROW_BRANDS.map((n) => `${cell(a?.[n])} /${cell(b?.[n])}`.padStart(22)).join("")}`);
  }
  log(`\n  시리즈 종전: ${[...(await seriesOf("measured"))].join(", ")}`);
  log(`  시리즈 신규: ${[...(await seriesOf("cycle"))].join(", ")}`);
}

async function seriesOf(source: TrendWeekSource): Promise<string[]> {
  const live = await aggregateMentionsFromMirror({}, undefined, "none", {}, source);
  return live?.trend?.series ?? [];
}

const out: Record<TrendWeekSource, number[]> = { measured: [], cycle: [] };
let lastPlan: Record<TrendWeekSource, string> = { measured: "", cycle: "" };

for (let i = 0; i < REPEAT; i++) {
  for (const source of ["measured", "cycle"] as const) {
    const r = await explain(source);
    out[source].push(r.exec);
    lastPlan[source] = r.plan;
    log(`  ${source.padEnd(8)} 회차 ${i + 1}/${REPEAT} — Execution ${r.exec.toFixed(1)} ms`);
  }
}

const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
if (REPEAT < 1) {
  // `--repeat=0 --rows` = 값 대조만. EXPLAIN 표본이 없으면 요약을 찍지 않는다.
  await db.$client.end?.();
  process.exit(0);
}
log("\n── 요약 (Execution Time, 중앙값) ──────────────────────────────────────");
log(`  measured (종전) : ${med(out.measured).toFixed(1)} ms   [${out.measured.map((v) => v.toFixed(0)).join(", ")}]`);
log(`  cycle    (신규) : ${med(out.cycle).toFixed(1)} ms   [${out.cycle.map((v) => v.toFixed(0)).join(", ")}]`);
log(`  Δ               : ${(med(out.cycle) - med(out.measured)).toFixed(1)} ms`);

for (const source of ["measured", "cycle"] as const) {
  const nodes = lastPlan[source]
    .split("\n")
    .filter((l) => /Join|Scan|Sort|Unique|Aggregate/.test(l))
    .map((l) => l.trim().replace(/\s+\(cost[\s\S]*$/, ""));
  log(`\n── ${source} 플랜 노드 ──`);
  log(nodes.map((n) => `  ${n}`).join("\n"));
  if (FULL) log(`\n${lastPlan[source]}`);
}
await db.$client.end?.();
