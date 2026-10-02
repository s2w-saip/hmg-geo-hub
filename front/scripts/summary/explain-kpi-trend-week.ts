/**
 * 4-KPI 탭 추이 3종의 **주 격자 키** A/B 하네스 — 영속 쓰기 0 (2026-09-18).
 *
 * 리포 규율("성능 영향이 있는 SQL 변경은 EXPLAIN 근거 없이 배포 금지")의 근거를 만든다.
 * `kpiTabTrendAxis` 가 `cycle` 에서 **답변셋 생성 문장**(`CREATE TEMP TABLE _answer_set`)에
 * LEFT JOIN 하나(`summary_cycle_runs ⋈ summary_cycles`)를 더하므로, 그 조인이 플랜을
 * 바꾸는지와 뒤따르는 문장들이 영향을 받는지를 본다.
 *
 * **계측과 EXPLAIN 이 2단으로 갈려 있다** — 이 경로의 문장 대부분(`ans`·브랜드·유형)은
 * `withAnswerSet` 의 TEMP 테이블 위에서 돌아 밖에서 EXPLAIN 할 수 없고, 그 문장들의
 * **텍스트는 이번 변경으로 바뀌지 않는다**. 바뀌는 것은 답변셋 생성 문장
 * (`CREATE TEMP TABLE _answer_set AS <select>`) 하나뿐이고, 그 SELECT 는 기저 테이블만
 * 읽어 단독 EXPLAIN 이 된다. 그래서:
 *   ① `explain-mirror-heavy.ts` 처럼 드라이버 세션을 계측해 **문장별 wall** 을 재고
 *      (A→B 교대라 콜드/워밍 편향이 한쪽에 실리지 않는다),
 *   ② `--explain` 이면 캡처한 **답변셋 SELECT** 만 자기 트랜잭션에서
 *      `EXPLAIN (ANALYZE, BUFFERS)` 한다.
 * ①에서 인라인 EXPLAIN 을 쓰지 않는 이유는 아래 코드 주석(25P02·마감 충돌) 참조.
 *
 * ⚠️ `CREATE TEMP TABLE … ON COMMIT DROP` + `ANALYZE` 를 발행한다(프로덕션과 같은 경로).
 *    세션 임시 객체라 커밋과 함께 사라지고 고객 데이터를 건드리지 않지만,
 *    `SET TRANSACTION READ ONLY` 세션에서는 TEMP 생성이 거부되어 이 하네스가 돌지 않는다.
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json \
 *       scripts/summary/explain-kpi-trend-week.ts \
 *       [--path=brand,engine] [--repeat=2] [--explain] [--rows] [--region=KR] [--engine=chatgpt]
 *   · `--rows` = 주별 값 대조(측정 주 vs 회차 주). EXPLAIN 은 값을 안 본다.
 *   · `--region=`·`--engine=` = 필터 변형(무필터 외 최소 1종을 같이 재기 위한 것).
 */
import { PostgresJsSession } from "drizzle-orm/postgres-js";
import { getDb } from "@/lib/db";
import {
  aggregateBrandTrendFromMirror,
  aggregateEngineKpiTrendFromMirror,
  type TrendWeekSource,
} from "@/lib/db/repositories/scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import {
  KPI_TAB_STATEMENT_TIMEOUT_MS,
  KPI_TAB_ENGINE_BUDGET_MS,
  KPI_TAB_SINGLE_BUDGET_MS,
} from "@/lib/scope/kpi-tab-budget";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const PATHS = (arg("path") ?? "brand,engine").split(",");
const REPEAT = Number(arg("repeat") ?? 2);
const EXPLAIN = argv.includes("--explain");
const ROWS = argv.includes("--rows");
const TREND_DAYS = Number(arg("days") ?? 120);
const FILTERS: StandardFilters = {
  ...(arg("region") ? { region: [arg("region") as string] } : {}),
  ...(arg("engine") ? { engine: [arg("engine") as string] } : {}),
};
const LABEL = Object.keys(FILTERS).length
  ? `필터(${Object.entries(FILTERS).map(([k, v]) => `${k}=${v}`).join(" ")})`
  : "무필터";
/* eslint-disable no-console */
const log = console.log;
process.on("unhandledRejection", (e) => {
  log(`⚠️ unhandledRejection: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
});

// ── 세션 계측 (프로토타입 1곳 — 모든 tx 세션이 이 프로토타입을 공유한다) ──
type Rec = { tag: string; ms: number; exec: number | null; buffers: number | null; text: string };
const recs: Rec[] = [];
/** 태그별 답변셋 SELECT 본체 — `--explain` 단계가 이것만 따로 잰다. */
const answerSetSql = new Map<string, { sql: string; params: unknown[] }>();
let current = "";
const proto = PostgresJsSession.prototype as unknown as {
  prepareQuery: (...a: unknown[]) => { execute: (...a: unknown[]) => Promise<unknown> };
};
const origPrepare = proto.prepareQuery;
proto.prepareQuery = function patched(this: unknown, ...args: unknown[]) {
  const query = args[0] as { sql: string; params: unknown[] };
  const pq = origPrepare.apply(this, args);
  const origExec = pq.execute.bind(pq);
  pq.execute = async (...a: unknown[]) => {
    const t0 = performance.now();
    let out: unknown;
    try {
      out = await origExec(...a);
    } finally {
      const ms = performance.now() - t0;
      // 답변셋 생성 문장(`CREATE TEMP TABLE … AS <select>`)의 **SELECT 본체**만 따로
      // 보관한다. 이번 변경이 문장 텍스트를 바꾸는 자리가 거기 하나뿐이고, 그 SELECT 는
      // 기저 테이블만 읽어 **트랜잭션 밖에서 단독 EXPLAIN 이 된다**.
      //
      // ⚠️ 인라인 EXPLAIN 을 쓰지 않는 이유(2026-09-18 실측):
      //    ① `EXPLAIN (ANALYZE) CREATE TEMP TABLE … AS …` 는 테이블을 **실제로 만든다** →
      //       원 문장이 이미 만든 뒤라 중복으로 죽고 트랜잭션이 abort(25P02) 된다.
      //    ② 접두사를 떼고 같은 트랜잭션에서 EXPLAIN 하면 문장 하나가 두 번 도는 셈이라
      //       `SET LOCAL statement_timeout`·집계 마감에 걸려 경로가 통째로 멈춘다.
      //    그래서 **계측(wall)과 EXPLAIN 을 분리**한다 — 아래 `--explain` 단계 참조.
      const body = query.sql.replace(/^\s*CREATE TEMP TABLE \w+ ON COMMIT DROP AS\s+/i, "");
      if (body !== query.sql) answerSetSql.set(current, { sql: body, params: query.params });
      recs.push({ tag: current, ms, exec: null, buffers: null, text: query.sql.replace(/\s+/g, " ").trim() });
    }
    return out;
  };
  return pq;
};

const budget = (path: string) => ({
  statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
  budgetMs: path === "engine" ? KPI_TAB_ENGINE_BUDGET_MS : KPI_TAB_SINGLE_BUDGET_MS,
});

async function call(path: string, weekSource: TrendWeekSource) {
  if (path === "brand") {
    return aggregateBrandTrendFromMirror(FILTERS, undefined, {
      trendDays: TREND_DAYS, topBrands: 10, weekSource, ...budget(path),
    });
  }
  return aggregateEngineKpiTrendFromMirror(FILTERS, undefined, {
    trendDays: TREND_DAYS, weekSource, ...budget(path),
  });
}

// ── A/B 교대 실행 ───────────────────────────────────────────────────────────
log(`대상 ${PATHS.join(",")} · ${LABEL} · 창 ${TREND_DAYS}일 · 회차 ${REPEAT} · explain=${EXPLAIN}`);
for (let i = 0; i < REPEAT; i++) {
  for (const path of PATHS) {
    for (const ws of ["measured", "cycle"] as const) {
      current = `${path}:${ws}:${i + 1}`;
      const t0 = performance.now();
      await call(path, ws);
      log(`  ${current} · 함수 wall ${(performance.now() - t0).toFixed(0)} ms`);
    }
  }
}

log("\n── 문장 census (경로·주키별 · wall) ────────────────────────────────────");
const byTag = new Map<string, Rec[]>();
for (const r of recs) byTag.set(r.tag, [...(byTag.get(r.tag) ?? []), r]);
for (const [tag, rs] of [...byTag.entries()].sort()) {
  const wallSum = rs.reduce((s, r) => s + r.ms, 0);
  const wallMax = Math.max(...rs.map((r) => r.ms));
  log(`\n[${tag}] 문장 ${rs.length}개 · wall 합 ${wallSum.toFixed(0)} ms(최장 ${wallMax.toFixed(0)})`);
  for (const r of [...rs].sort((a, b) => b.ms - a.ms).slice(0, 6)) {
    log(`   ${r.ms.toFixed(0).padStart(7)} ms wall · ${r.text.slice(0, 100)}`);
  }
}

// ── 바뀐 문장의 EXPLAIN — 답변셋 SELECT 단독 (계측과 분리) ──────────────────
if (EXPLAIN) {
  log("\n── 답변셋 SELECT EXPLAIN (ANALYZE, BUFFERS) ────────────────────────────");
  // 드라이버(postgres.js)를 직접 쓴다 — 캡처한 텍스트에 `$n` 바인드가 그대로 있어
  // drizzle SQL 객체로 되돌릴 수 없고, 값을 인라인하면 형변환이 달라져 플랜이 바뀐다.
  const client = getDb().$client;
  // 태그에서 회차 번호를 떼고 (경로:주키) 별로 **첫 것 하나**만 잰다 — 같은 조합의
  // 문장은 회차가 달라도 텍스트·바인드가 같다.
  const seen = new Set<string>();
  for (const [tag, q] of answerSetSql) {
    const key = tag.split(":").slice(0, 2).join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    for (let i = 0; i < REPEAT; i++) {
      const out = (await client.begin(async (tx) => {
        // 진행 중 문장을 죽이지 않는다 — 이 단계는 측정이지 예산 집행이 아니다.
        await tx.unsafe("SET LOCAL statement_timeout = 180000");
        return tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${q.sql}`, q.params as never);
      })) as unknown as Array<Record<string, string>>;
      const lines = out.map((r) => Object.values(r)[0]).join("\n");
      const exec = Number(/Execution Time: ([\d.]+)/.exec(lines)?.[1] ?? 0);
      const plan = Number(/Planning Time: ([\d.]+)/.exec(lines)?.[1] ?? 0);
      const buffers = [...lines.matchAll(/shared hit=(\d+)(?: read=(\d+))?/g)]
        .reduce((s, m) => s + Number(m[1]) + Number(m[2] ?? 0), 0);
      const nodes = lines.split("\n").filter((l) => /->|^\s*\w.*cost=/.test(l)).length;
      log(`[${key}] #${i + 1} exec ${exec.toFixed(0)} ms · planning ${plan.toFixed(1)} ms · shared(hit+read) ${buffers} · 노드 ${nodes}`);
      if (i === REPEAT - 1) {
        log(lines.split("\n").filter((l) => /Join|Scan|Aggregate|Sort/.test(l)).slice(0, 10)
          .map((l) => `      ${l.trim().slice(0, 130)}`).join("\n"));
        log(`      → 문장 상한 여유: ${(exec / 1000).toFixed(1)} s / ${(KPI_TAB_STATEMENT_TIMEOUT_MS / 1000).toFixed(0)} s`);
      }
    }
  }
}

// ── 값 대조 ────────────────────────────────────────────────────────────────
if (ROWS) {
  log("\n── 주별 값 대조 (측정 주 vs 회차 주) ───────────────────────────────────");
  for (const ws of ["measured", "cycle"] as const) {
    const engine = await aggregateEngineKpiTrendFromMirror(FILTERS, undefined, {
      trendDays: TREND_DAYS, weekSource: ws, ...budget("engine"),
    });
    log(`\n[engine:${ws}] degraded=${engine.trendDegraded} · 버킷 ${engine.buckets.length}개 · 창 ${engine.windowStartBucket}~${engine.windowEndBucket}`);
    log("   주        답변      노출답변   AI노출률   유형(단순언급)");
    const typeBy = new Map(engine.typeTrend.map((t) => [t.bucketStart, t]));
    for (const b of engine.buckets) {
      const answers = b.engines.reduce((s, e) => s + e.answers, 0);
      const tracked = b.engines.reduce((s, e) => s + e.trackedAnswers, 0);
      const pct = answers > 0 ? ((tracked / answers) * 100).toFixed(1) : "—";
      const t = typeBy.get(b.bucketStart);
      log(`   ${b.bucketStart}  ${String(answers).padStart(8)}  ${String(tracked).padStart(8)}  ${pct.padStart(8)}%  ${String(t?.byType.mention ?? 0).padStart(8)} / 답변 ${t?.answers ?? 0}`);
    }
    const brand = await aggregateBrandTrendFromMirror(FILTERS, undefined, {
      trendDays: TREND_DAYS, topBrands: 10, weekSource: ws, ...budget("brand"),
    });
    log(`[brand:${ws}] 시리즈 ${brand.brands.length}개 (${brand.brands.map((b) => b.brand).join(", ")})`);
    log("   주        답변      Hyundai 노출률  전체언급");
    for (const b of brand.buckets) {
      const h = b.brands.find((x) => x.brand === "Hyundai");
      log(`   ${b.bucketStart}  ${String(b.answers).padStart(8)}  ${String(h?.exposurePct ?? "—").padStart(8)}%  ${String(b.totalMentions).padStart(9)}`);
    }
  }
}
process.exit(0);
