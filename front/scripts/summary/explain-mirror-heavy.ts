/**
 * 아직 예산이 없던 **무거운 미러 read** 의 문장 census — 쓰기 0 (PR③ 위생 A).
 *
 * E-2 는 S3(`fetchStandardCitations`) 하나만 켰다. 나머지 다섯 경로가 같은 위험을
 * 갖고 있는데(무예산 + 무degrade → 함수 120 s 초과 시 **HTML 절단**), 예산을 걸려면
 * "문장 하나가 얼마나 오래 잡는가 · 경로 전체가 얼마나 걸리는가"를 먼저 재야 한다:
 *
 *   s2            `aggregateMentionsFromMirror(f, undefined, "none")`      (표준 언급)
 *   s5            `aggregateMentionsFromMirror(f, websiteIds, "none")`     (웹사이트 언급)
 *   s6            `aggregateCitationsFromMirror(f, websiteIds, …, true)`   (웹사이트 인용)
 *   proj-mentions `aggregateMentionsFromMirror(f, projectId)`              (프로젝트 · JS 경로)
 *   proj-citations`aggregateCitationsFromMirror(f, projectId, …)`          (프로젝트 인용)
 *
 * ── 왜 EXPLAIN 하네스가 아니라 세션 계측인가 ────────────────────────────────
 * 이 경로들은 `withAnswerSet`(TEMP TABLE + ANALYZE) 안에서 돈다. 문장을 밖으로 떼어
 * EXPLAIN 하면 `_answer_set` 이 없어 아예 못 돌고, CTE 로 바꿔 재면 비용 귀속이
 * 틀린다(`kpi-tab-budget.ts` 머리 주석이 그 오진의 대가를 적어 뒀다 — 8 s 상한이
 * 매번 문장을 죽였다). 그래서 **드라이버 세션을 계측**해 프로덕션과 같은 경로에서
 * 문장별 왕복(wall)을 재고, `--explain` 이면 **같은 트랜잭션 안에서** 그 문장에
 * `EXPLAIN (ANALYZE, BUFFERS)` 를 한 번 더 보내 서버측 Execution Time 을 받는다.
 *
 * ⚠️ wall 에는 로컬 → 원격 풀러 왕복(≈140 ms/문장)이 들어 있다. 예산 산정은
 *    Execution Time(서버측)을 쓰고 wall 은 문장 수 × RTT 를 가늠하는 데만 쓴다.
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-mirror-heavy.ts \
 *       [--path=s2|s5|s6|proj-mentions|proj-citations|all] [--explain] [--repeat=1]
 *       [--week=measured|cycle]   언급 추이 주 격자 키 (기본 measured = 종전) — **s2 에만** 실린다
 *
 *   --verify  예산 배선 실증. 같은 경로를 **무예산 → 예산** 으로 연달아 돌려
 *             (a) 값이 완전히 같은지 (b) `SET LOCAL statement_timeout` 이 실제로 나갔는지
 *             (c) 상한을 1 ms 로 조이면 `isTimeoutFailure` 가 참인 오류로 죽는지 를 본다.
 *             (c) 가 없으면 예산은 있어도 degrade 로 연결되지 않는다.
 */
import { PostgresJsSession } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  aggregateMentionsFromMirror,
  aggregateCitationsFromMirror,
  aggregateStandardFromMirror,
  aggregateGeoCompetitionFromMirror,
  websiteDeclaredOwnedBases,
} from "@/lib/db/repositories/scope-aggregates";
import type { AnswerSetBudget } from "@/lib/db/repositories/scope-aggregates";
import { getProjectIdsForScope } from "@/lib/db/repositories/website-sites";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import {
  isTimeoutFailure,
  mirrorHeavyBudget,
  type MirrorHeavyProfile,
} from "@/lib/scope/kpi-tab-budget";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const PATHS = (arg("path") ?? "all").split(",");
const EXPLAIN = argv.includes("--explain");
const VERIFY = argv.includes("--verify");
const REPEAT = Number(arg("repeat") ?? 1);
// 언급 추이의 주 격자 키(2026-09-17) — `measured`(종전) · `cycle`(원장 `cycle_week`).
// `scope-aggregates.ts::trendWeekKey` 가 정본. `cycle` 은 `ans` CTE 에 LEFT JOIN 하나를
// 더하므로, 이 리포 규율("성능 영향 있는 SQL 변경은 EXPLAIN 근거 없이 배포 금지")상
// 전후 플랜을 같은 세션에서 비교할 수 있어야 한다.
//
// ⚠️ **`s2` 에만 싣는다.** 화면 키 `S2.mentionTrend` 는 글로벌 표면 전용이고, 웹사이트
//    리더(`fetchWebsiteMentions` → s5)·프로젝트 리더는 인자를 안 넘겨 프로덕션에서
//    **항상 `measured`** 다. s5 에 실으면 프로덕션에 없는 조합을 재게 된다.
const WEEK = (arg("week") ?? "measured") === "cycle" ? "cycle" as const : "measured" as const;
/* eslint-disable no-console */
const log = console.log;
// 예산이 **미처리 거부**를 만들면 서버리스에서 함수가 죽는다 — 표면화한다.
process.on("unhandledRejection", (e) => {
  log(`⚠️ unhandledRejection: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
});

// ── 세션 계측 (프로토타입 1곳 — db·모든 tx 세션이 이 프로토타입을 공유한다) ──
type Rec = { path: string; ms: number; exec: number | null; text: string };
const recs: Rec[] = [];
let current = "";
const proto = PostgresJsSession.prototype as unknown as {
  prepareQuery: (...a: unknown[]) => { execute: (...a: unknown[]) => Promise<unknown> };
};
const origPrepare = proto.prepareQuery;
proto.prepareQuery = function patched(this: unknown, ...args: unknown[]) {
  const query = args[0] as { sql: string; params: unknown[] };
  const pq = origPrepare.apply(this, args);
  const origExec = pq.execute.bind(pq);
  const self = this;
  pq.execute = async (...a: unknown[]) => {
    const t0 = performance.now();
    let out: unknown;
    try {
      out = await origExec(...a);
    } finally {
      const ms = performance.now() - t0;
      let exec: number | null = null;
      if (EXPLAIN && /^\s*(SELECT|WITH)/i.test(query.sql)) {
        try {
          // **같은 세션**(= 같은 커넥션·같은 tx)이라 `_answer_set` 이 보인다.
          const plan = (await origPrepare
            .call(self, { sql: `EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`, params: query.params })
            .execute()) as Array<Record<string, string>>;
          const lines = plan.map((r) => Object.values(r)[0]).join("\n");
          exec = Number(/Execution Time: ([\d.]+)/.exec(lines)?.[1] ?? 0) || null;
        } catch {
          exec = null; // EXPLAIN 이 안 되는 문장(SET·DDL 등)은 wall 만 남긴다.
        }
      }
      recs.push({ path: current, ms, exec, text: query.sql.replace(/\s+/g, " ").trim() });
    }
    return out;
  };
  return pq;
};

const db = getDb();

async function pickWebsiteIds(): Promise<string[]> {
  const ids = await getProjectIdsForScope({ all: true } as never);
  return ids;
}

async function pickProjectId(): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT r.project_id::text AS pid, count(*)::int AS n
    FROM scope_answers a JOIN scope_runs r ON r.run_id = a.run_id
    WHERE a.status = 'completed'
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1
  `)) as unknown as Array<{ pid: string; n: number }>;
  if (!rows.length) throw new Error("미러에 완료 답변이 있는 프로젝트가 없다");
  log(`프로젝트 표면 대상 — ${rows[0].pid} (답변 ${rows[0].n})`);
  return rows[0].pid;
}

async function run(name: string, fn: () => Promise<unknown>) {
  if (!PATHS.includes("all") && !PATHS.includes(name)) return;
  for (let i = 0; i < REPEAT; i++) {
    current = name;
    const t0 = performance.now();
    await fn();
    const wall = performance.now() - t0;
    const mine = recs.filter((r) => r.path === name);
    log(`\n=== ${name} · 회차 ${i + 1}/${REPEAT} · 함수 wall ${wall.toFixed(0)} ms · 문장 ${mine.length}개 ===`);
  }
}

const websiteIds = PATHS.some((p) => p === "all" || p.startsWith("s5") || p.startsWith("s6") || p === "s4-cards")
  ? await pickWebsiteIds()
  : [];
if (websiteIds.length) log(`웹사이트 표면 project ${websiteIds.length}개`);
const own = websiteIds.length ? await websiteDeclaredOwnedBases({}, websiteIds) : { prefixes: [], universe: undefined };
const projectId = PATHS.some((p) => p === "all" || p.startsWith("proj")) ? await pickProjectId() : "";
recs.length = 0;

await run("s2", () => aggregateMentionsFromMirror({}, undefined, "none", {}, WEEK));
// s5 는 `--week` 를 타지 않는다 — 프로덕션 웹사이트 리더가 항상 종전 격자다(위 ⚠️).
await run("s5", () => aggregateMentionsFromMirror({}, websiteIds, "none"));
await run("s6", () =>
  aggregateCitationsFromMirror({}, websiteIds, own.prefixes.length ? own.prefixes : globalBaseUniverse(), own.universe, true));
await run("s1-cards", () => aggregateStandardFromMirror({}, undefined, globalBaseUniverse()));
await run("s4-cards", () =>
  aggregateStandardFromMirror({}, websiteIds, own.prefixes.length ? own.prefixes : globalBaseUniverse(), own.universe, true));
await run("geo-comp", () => aggregateGeoCompetitionFromMirror({}));
await run("proj-mentions", () => aggregateMentionsFromMirror({}, projectId));
await run("proj-citations", () => aggregateCitationsFromMirror({}, projectId, globalBaseUniverse()));

if (VERIFY) {
  log("\n── 예산 배선 실증 (--verify) ───────────────────────────────────────────");
  type Case = { name: string; run: (b?: AnswerSetBudget) => Promise<unknown>; profile: MirrorHeavyProfile };
  const cases: Case[] = [
    { name: "s2", profile: "mentions", run: (b) => aggregateMentionsFromMirror({}, undefined, "none", b) },
    { name: "s5", profile: "mentions", run: (b) => aggregateMentionsFromMirror({}, websiteIds, "none", b) },
    { name: "s6", profile: "citationsWide",
      run: (b) => aggregateCitationsFromMirror({}, websiteIds,
        own.prefixes.length ? own.prefixes : globalBaseUniverse(), own.universe, true, b) },
    { name: "proj-mentions", profile: "mentionsJs", run: (b) => aggregateMentionsFromMirror({}, projectId, "all", b) },
    { name: "proj-citations", profile: "citationsWide",
      run: (b) => aggregateCitationsFromMirror({}, projectId, globalBaseUniverse(), undefined, false, b) },
  ].filter((c) => PATHS.includes("all") || PATHS.includes(c.name));

  for (const c of cases) {
    recs.length = 0;
    current = `${c.name}:무예산`;
    const before = JSON.stringify(await c.run(undefined));
    const nSetBefore = recs.filter((r) => /SET LOCAL statement_timeout/.test(r.text)).length;
    current = `${c.name}:예산`;
    const budget = mirrorHeavyBudget(c.profile);
    const after = JSON.stringify(await c.run(budget));
    const sets = recs.filter((r) => /SET LOCAL statement_timeout/.test(r.text));
    // (c) 상한을 **조여서** 반드시 죽이고, 그 오류가 degrade 대상으로 분류되는지 본다.
    //     1 ms 로 조이면 트랜잭션 제어문(ROLLBACK)까지 잘려 드라이버가 미처리 거부를 낸다 —
    //     500 ms 는 BEGIN/SET/ROLLBACK 은 통과하고 본 문장만 죽는 지점이다.
    current = `${c.name}:tight`;
    // ⚠️ **"이미 지난 마감" 을 주면 안 된다**(2026-09-11 검증 F2). 그건 발행 전 검사만
    //    확인하고 끝나서, 진행 중 read 가 마감에 포기되는지를 못 본다 — 그 사각 때문에
    //    `mentionsJs` 의 무예산 상태가 이 하네스를 통과했다. 마감은 **시작 후**(+300 ms)에
    //    오도록 준다: 어떤 경로도 300 ms 안에 끝나지 않으므로 반드시 진행 중에 발화한다.
    const tight = budget.statementTimeoutMs === undefined
      ? { deadlineAt: Date.now() + 300 }
      : { statementTimeoutMs: 500, deadlineAt: Date.now() + 300 };
    let fired = "발화 안 함(❌)";
    try {
      await c.run(tight);
    } catch (e) {
      fired = isTimeoutFailure(e)
        ? `발화(시작 후 300 ms 마감${budget.statementTimeoutMs === undefined ? "" : " + 문장 500 ms"}) · isTimeoutFailure=true (✔)`
        : `발화했으나 **degrade 대상 아님**(❌): ${e instanceof Error ? e.message.slice(0, 80) : e}`;
    }
    log(`[${c.name}] 프로파일 ${c.profile}(문장 ${budget.statementTimeoutMs ?? "없음"}) · ` +
        `값 동일 ${before === after ? "✔" : "✗ **차이**"} · ` +
        `SET LOCAL ${nSetBefore} → ${sets.length}개 · 조임 검사: ${fired}`);
  }
}

log("\n── 문장 census (경로별) ────────────────────────────────────────────────");
const byPath = new Map<string, Rec[]>();
for (const r of recs) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
for (const [p, rs] of byPath) {
  const wallSum = rs.reduce((s, r) => s + r.ms, 0);
  const execSum = rs.reduce((s, r) => s + (r.exec ?? 0), 0);
  const wallMax = Math.max(...rs.map((r) => r.ms));
  const execMax = Math.max(...rs.map((r) => r.exec ?? 0));
  log(`\n[${p}] 문장 ${rs.length}개 · wall 합 ${wallSum.toFixed(0)} ms(최장 ${wallMax.toFixed(0)}) · exec 합 ${execSum.toFixed(0)} ms(최장 ${execMax.toFixed(0)})`);
  for (const r of [...rs].sort((a, b) => (b.exec ?? b.ms) - (a.exec ?? a.ms)).slice(0, 8)) {
    log(`   ${(r.exec ?? 0).toFixed(0).padStart(7)} ms exec · ${r.ms.toFixed(0).padStart(7)} ms wall · ${r.text.slice(0, 110)}`);
  }
  // 예산 산정식(kpi-tab-budget.ts 와 동일): 문장 = max × 1.7 × 1.3, 경로 = 합 × 1.7
  const stmtBase = execMax || wallMax;
  const pathBase = execSum || wallSum;
  log(`   → 제안 문장 상한 ${(stmtBase * 1.7 * 1.3 / 1000).toFixed(1)} s · 경로 예산 ${(pathBase * 1.7 / 1000).toFixed(1)} s`);
}
process.exit(0);
