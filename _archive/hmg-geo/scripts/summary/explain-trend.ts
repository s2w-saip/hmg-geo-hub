/**
 * 집계층 리더 **EXPLAIN 하네스** — 쓰기 0, 읽기·EXPLAIN 만 (PR② T4 수용 기준·§4 판정).
 *
 * `lib/db/repositories/summary-trend-aggregates.ts::buildTrendStatements` 가 만든
 * **바로 그 4문장**을 실 DB 에 EXPLAIN (ANALYZE, BUFFERS) 로 태워 세 가지를 판정한다:
 *
 *   ⓐ 조회 인덱스 컬럼 순서 — 0059 `summary_trend_*_pick (surface, project_id, cycle_anchor_at)`
 *      와 0065 `summary_trend_*_read (surface, cycle_anchor_at, project_id, country, engine)`
 *      중 **플래너가 무엇을 고르는가**. 0065 는 근거 없이 옛것을 지우지 않았다(추가만).
 *   ⓑ generation 정리 인덱스 4개(`summary_trend_*_gen`)의 이득 — 0065 W8 미증명 항목.
 *      정리 DELETE 의 술어(`cycle_id = $c AND generation_id <> $g`)를 **EXPLAIN 만**
 *      (ANALYZE 없이 = 실행 안 함) 태워 무엇을 고르는지·PK 대비 비용이 어떤지 본다.
 *   ⓒ 페이지 DB 합 — 4문장 Execution Time 의 순차 합. 플랜 §4-1 외삽치
 *      (글로벌 ≈268 ms · 웹사이트 ≈112 ms)와 대조한다.
 *
 * 회차 선택은 **`summary_cycles.active_generation_id`** 에서 가져온다(코디네이터 요건) —
 * 집계층 행의 `generation_id` 는 재생성마다 바뀌므로 얼린 쌍이 아니면 0행을 읽는다.
 *
 * 사용:
 *   npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-trend.ts \
 *     --surface=global --cycle=<uuid> [--full] [--repeat=3]
 *
 *   --full   전체 계획 텍스트를 찍는다(기본은 요약 + 인덱스 사용 목록).
 *   --repeat 같은 문장을 N회 돌려 최소/중앙값을 본다(1회차는 캐시 콜드일 수 있다).
 *   --rows   리더를 실제로 실행해 **모양·층간 정합**을 찍는다. EXPLAIN 은 컬럼 이름
 *            오타를 못 잡는다(계획만 보고 결과를 안 읽는다) — 이 플래그가 그 그물이다.
 *   --time=N EXPLAIN **없이** N회 실행해 실 소요를 잰다. `EXPLAIN (ANALYZE)` 는 노드마다
 *            타이머를 걸어 과대 계상하므로, 페이지 DB 합(ⓒ)의 정본은 이쪽이다.
 *            순차 합과 **병렬(Promise.all) wall** 을 함께 낸다 — 화면은 병렬로 발행한다.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  buildTrendStatements,
  readTrendAggregates,
  type TrendReadScope,
} from "@/lib/db/repositories/summary-trend-aggregates";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import { summaryUnitFlagsAvailable, websiteExcludedUnits } from "@/lib/db/repositories/summary-settings";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SURFACE = (arg("surface") ?? "global") as "global" | "website";
const CYCLE_ID = arg("cycle");
const FULL = argv.includes("--full");
const ROWS = argv.includes("--rows");
const REPEAT = Number(arg("repeat") ?? 1);
const TIME = Number(arg("time") ?? 0);
/** 절단 없이(라운드 1과 같은 형태) 돌려 페이로드 절감을 대조한다. */
const NO_LIMIT = argv.includes("--no-limit");
/** 라운드 3 선택 축을 전부 켠다(회차·엔진 브랜드·도메인 국가). */
const AXES = argv.includes("--axes") || argv.includes("--axes-heavy");
/** 비싼 축((country, group_key))까지 켠다. */
const HEAVY_AXES = argv.includes("--axes-heavy");
/** 발행할 표를 고른다 — `--only=own,brands`. */
const ONLY_RAW = arg("only");
const ONLY = ONLY_RAW?.split(",").filter(Boolean) as
  | ("own" | "answers" | "brands" | "domains")[]
  | undefined;

const dialect = new PgDialect();
/* eslint-disable no-console */
const log = console.log;

type CycleRow = {
  cycle_id: string;
  generation_id: string;
  project_id: string;
  cycle_anchor_at: string;
  cycle_week: string;
  surface: string;
};

/** 회차 집합 — 게이트를 거치지 않고 원장에서 직접 얼린다(하네스이므로). */
async function loadSet(): Promise<CycleSet> {
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text, surface
    FROM summary_cycles
    WHERE surface = ${SURFACE}
      AND active_generation_id IS NOT NULL
      ${CYCLE_ID ? sql`AND cycle_id = ${CYCLE_ID}::uuid` : sql``}
      ${CYCLE_ID ? sql`` : sql`AND cycle_anchor_at = (SELECT max(cycle_anchor_at) FROM summary_cycles WHERE surface = ${SURFACE} AND active_generation_id IS NOT NULL)`}
  `)) as unknown as CycleRow[];
  if (rows.length === 0) throw new Error(`활성 generation 이 있는 ${SURFACE} 회차가 없다`);
  const cycles = rows.map((r) => ({
    cycleId: r.cycle_id,
    generationId: r.generation_id,
    projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at,
    cycleWeek: r.cycle_week,
  }));
  return {
    surface: SURFACE,
    mode: "snapshot",
    cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
  };
}

/** 계획 텍스트에서 실제로 쓰인 인덱스 이름과 스캔 종류를 뽑는다. */
function scansOf(plan: string): string[] {
  const out: string[] = [];
  for (const line of plan.split("\n")) {
    const m = line.match(/(Seq Scan|Index Scan|Index Only Scan|Bitmap Index Scan|Bitmap Heap Scan)[^\n]*/);
    if (m) out.push(m[0].trim());
  }
  return out;
}

async function explain(label: string, q: SQL, analyze: boolean): Promise<number | null> {
  const db = getDb();
  const prefix = analyze ? "EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)" : "EXPLAIN";
  const rows = (await db.execute(
    sql`${sql.raw(prefix)} ${q}`,
  )) as unknown as Array<Record<string, string>>;
  const plan = rows.map((r) => Object.values(r)[0]).join("\n");
  const ms = plan.match(/Execution Time: ([\d.]+) ms/);
  const planning = plan.match(/Planning Time: ([\d.]+) ms/);
  const cost = plan.match(/cost=[\d.]+\.\.([\d.]+)/);
  log(`\n── ${label} ──`);
  if (ms) log(`   Execution ${ms[1]} ms · Planning ${planning?.[1] ?? "?"} ms`);
  else if (cost) log(`   (미실행) 추정 총비용 ${cost[1]}`);
  for (const s of new Set(scansOf(plan))) log(`   · ${s}`);
  if (FULL) log(plan.split("\n").map((l) => `   | ${l}`).join("\n"));
  return ms ? Number(ms[1]) : null;
}

async function main() {
  const set = await loadSet();
  log(`표면 ${set.surface} · 회차 ${set.cycles.length}개 · 프로젝트 ${set.projectIds.length}개 · 주 ${set.weeks.join(",")}`);
  log(`anchor ${set.cycles.map((c) => c.cycleAnchorAt).join(" / ")}`);

  const [unitFlags, excludedUnits] = await Promise.all([
    summaryUnitFlagsAvailable(),
    websiteExcludedUnits(),
  ]);
  const scope: TrendReadScope = {
    set,
    filters: {},
    ownVariant: OWN_VARIANT_ALL,
    unitFlags,
    excludedUnits,
    limits: NO_LIMIT
      ? { domain: null, group: null, brand: null, geoBrandPerCountry: null }
      : undefined,
    axes: AXES
      ? { cycle: true, engineBrand: true, domainCountry: true, domainCountryGroup: HEAVY_AXES }
      : undefined,
    // 하네스 근사: 두 표면 모두 글로벌 base universe 를 쓴다. `is_ours` 정규식의 크기만
    // 영향을 주고 회차 술어·집계 형태는 같다 — 지연 판정 목적에는 충분하다.
    ownedBasePrefixes: globalBaseUniverse(),
  };

  if (ROWS) {
    const agg = await readTrendAggregates(scope, ONLY ? { only: ONLY } : undefined);
    const total = agg.own.find((r) => r.axis === "total");
    const domTotal = agg.domains.find((r) => r.axis === "total");
    const ansTotal = agg.answers.find((r) => r.axis === "total");
    const compFromBrands = agg.brands
      .filter((r) => r.country === null)
      .reduce((s2, r) => s2 + r.mentions, 0);
    log(`\n── 리더 실행(모양·층간 정합) ──`);
    log(`   own ${agg.own.length}행(엔진 ${agg.own.filter((r) => r.axis === "engine").length}·국가 ${agg.own.filter((r) => r.axis === "country").length}) · answers ${agg.answers.length} · brands ${agg.brands.length} · domains ${agg.domains.length} · empty=${agg.empty}`);
    log(`   모수      own.monitored ${total?.monitored} = answers.total ${ansTotal?.monitored}`);
    log(`   ⑤ 분모    own.allCitations ${total?.allCitations} = domains.total ${domTotal?.citations} = answers.total ${ansTotal?.allCitations}`);
    log(`   ② 분모    own.compMentions ${total?.compMentions} = brands(브랜드축) ${compFromBrands}`);
    log(`   축 분포   answers ${[...new Set(agg.answers.map((r) => r.axis))].join(",")} · domains ${[...new Set(agg.domains.map((r) => r.axis))].join(",")}`);
    log(`   GEO 행    brands country≠null ${agg.brands.filter((r) => r.country !== null).length} · isTracked ${agg.brands.filter((r) => r.isTracked).length}`);
    const restB = agg.brands.filter((r) => r.isRest);
    const restD = agg.domains.filter((r) => r.isRest);
    log(`   절단      brands rest ${restB.length}행(합친 ${restB.reduce((s2, r) => s2 + r.restCount, 0)}) · domains rest ${restD.length}행(합친 ${restD.reduce((s2, r) => s2 + r.restCount, 0)}) · limits=${NO_LIMIT ? "none" : "default"}`);
    const bytes = JSON.stringify(agg).length;
    log(`   페이로드  총 ${agg.own.length + agg.answers.length + agg.brands.length + agg.domains.length}행 · JSON ${(bytes / 1024).toFixed(0)} KB`);
  }

  const statements = buildTrendStatements(scope, ONLY ? { only: ONLY } : undefined);
  log(`\n축 ${AXES ? "on(cycle·engineBrand·domainCountry)" : "off"} · only ${ONLY?.join(",") ?? "(전부)"}`);
  log(`문장 ${statements.length}개 · 바인드 ${statements
    .map((s) => `${s.key}:${dialect.sqlToQuery(s.sql).params.length}`)
    .join(" ")}`);

  // ── 행 수 실측 ────────────────────────────────────────────────────────────
  for (const t of ["summary_trend_answers", "summary_trend_brands", "summary_trend_domains", "summary_trend_own"]) {
    const r = (await getDb().execute(sql`
      SELECT count(*)::bigint AS n FROM ${sql.raw(t)}
      WHERE cycle_id = ANY(${sql.param(set.cycles.map((c) => c.cycleId))}::uuid[])
        AND generation_id = ANY(${sql.param(set.cycles.map((c) => c.generationId))}::uuid[])
    `)) as unknown as Array<{ n: string }>;
    log(`   ${t}: ${r[0]?.n ?? "?"}행`);
  }

  // ── ⓒ 실 소요(EXPLAIN 없이) ───────────────────────────────────────────────
  if (TIME > 0) {
    const db = getDb();
    const best = new Map<string, number>();
    let wallBest = Infinity;
    for (let i = 0; i < TIME; i += 1) {
      for (const s2 of statements) {
        const t0 = performance.now();
        await db.execute(s2.sql);
        const ms = performance.now() - t0;
        best.set(s2.key, Math.min(best.get(s2.key) ?? Infinity, ms));
      }
      const t1 = performance.now();
      await Promise.all(statements.map((s2) => db.execute(s2.sql)));
      wallBest = Math.min(wallBest, performance.now() - t1);
    }
    const seq = [...best.values()].reduce((a, b) => a + b, 0);
    log(`\n── 실 소요(EXPLAIN 없음 · ${TIME}회 최소) ──`);
    for (const [k, v] of best) log(`   ${k}: ${v.toFixed(1)} ms`);
    log(`   순차 합 ${seq.toFixed(1)} ms · 병렬 wall ${wallBest.toFixed(1)} ms`);
  }

  // ── ⓐ·ⓒ 4문장 EXPLAIN ANALYZE ────────────────────────────────────────────
  const totals: number[] = [];
  for (let i = 0; i < Math.max(1, REPEAT); i += 1) {
    let sum = 0;
    for (const s of statements) {
      const ms = await explain(`${s.key} (${s.table}) run#${i + 1}`, s.sql, true);
      if (ms) sum += ms;
    }
    totals.push(sum);
    log(`\n=== run#${i + 1} 4문장 순차 합 ${sum.toFixed(1)} ms ===`);
  }
  log(`\n### 페이지 DB 합(최소) ${Math.min(...totals).toFixed(1)} ms · 전 회차 ${totals.map((t) => t.toFixed(1)).join(" / ")}`);

  // ── ⓑ generation 정리 DELETE 의 계획 (EXPLAIN 만 — 실행 없음) ─────────────
  log(`\n\n══ ⓑ generation 정리 인덱스 판정 (EXPLAIN only · 쓰기 0) ══`);
  const c0 = set.cycles[0];
  for (const t of ["summary_trend_answers", "summary_trend_brands", "summary_trend_domains", "summary_trend_own"]) {
    await explain(
      `${t} 정리 DELETE`,
      sql`DELETE FROM ${sql.raw(t)} WHERE cycle_id = ${c0.cycleId}::uuid AND generation_id <> ${c0.generationId}::uuid`,
      false,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
