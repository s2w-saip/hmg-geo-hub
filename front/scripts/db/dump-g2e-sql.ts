/**
 * G2e — 추이 답변셋 문장의 **A/B 덤프** (수리 전 술어 대 dim 술어).
 *
 * 왜 스크립트인가: 손으로 쓴 근사로 EXPLAIN 을 재면 그 계획은 제품이 내는 계획이
 * 아니다. 이 파일은 **실제 빌더**(`answerWhere`·`trendDimJoinSql`·`anchorJoinSql`)가
 * 낸 텍스트를 그대로 떨군다 — `dump-axis-on-sql.ts` 와 같은 자세다.
 *
 * 무엇을 렌더하는가: `aggregateStandardTrendFromMirror` 의 **답변셋 생성 문장**이다.
 * 그 함수는 `withAnswerSet(cols, W, …, { join, dedupe })` 를 부르고, 그 안에서
 *   `SELECT DISTINCT ON (<dedupe.on>) <cols> FROM scope_answers a<join> WHERE <W>
 *    ORDER BY <dedupe.order>`
 * 한 문장이 만들어진다(`scope-aggregates.ts::withAnswerSet`). 여기서 같은 템플릿으로
 * 같은 조각을 조립한다 — 그 문장이 이 경로의 단일 최대 비용이고, PR④ 가 건드린
 * 유일한 자리이기 때문이다.
 *
 *   A = 수리 전(1910e33 시점) 술어 — 격자 키 off. 현재값 술어만 걸린다.
 *   B = 새 dim 술어 — 격자 키 on. dim 파생표가 FROM 에 붙고 술어가 WHERE 에 있다.
 *
 * 판정은 **B − A 순증**이다(목표 500ms 이내).
 *
 * 실행: **vitest 하네스**가 부른다(`lib/db/repositories/g2e-dump.test.ts`).
 * `npx tsx` 로 직접 못 돈다 — 이 모듈 사슬이 `server-only` 를 끌고 오고 그 패키지는
 * Next 밖에서 해석되지 않는다(`dump-axis-on-sql.ts` 와 같은 제약).
 *
 * DB 에 접속하지 않는다 — 판정을 테스트용 세터로 고정하고 빌더만 돌린다.
 */
import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import { setAnchorAxisForTests } from "@/lib/period/anchor-axis-state";
import { setTrendGridForTests } from "@/lib/period/trend-grid-flag";
import { anchorJoinSql, anchorRoundDateSql } from "@/lib/period/anchor-axis";
import { anchorCellSnapshotKeys } from "@/lib/period/cell-snapshot";
import {
  answerWhere,
  trendMirrorJoins,
  __testables as aggTestables,
  TREND_WINDOW_DAYS,
} from "@/lib/db/repositories/scope-aggregates";
import { anchorWeekSql } from "@/lib/period/anchor-axis";

const dialect = new PgDialect();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 프로덕션의 함대 게이트와 같은 텍스트(테스트 세터 기본값은 `true` 라 주입한다). */
const FLEET_FRAG = sql`(ca.surface = 'project' OR EXISTS (
    SELECT 1 FROM summary_cycles sc
     WHERE sc.cycle_id = ca.cycle_id
       AND sc.fleet_visible
       AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
       AND sc.active_generation_id IS NOT NULL
  ))`;
const NOT_HIDDEN_FRAG = (alias: string): SQL => sql`NOT EXISTS (
    SELECT 1 FROM summary_cycles c
     WHERE c.cycle_id = ${sql.raw(alias)}.cycle_id
       AND (c.hidden_reason IS NOT NULL AND COALESCE(c.hidden_scope, 'all') = 'all')
  )`;

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v)) return `ARRAY[${v.map((x) => literal(x)).join(", ")}]`;
  const s = String(v).replace(/'/g, "''");
  return UUID_RE.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
}

function compile(q: SQL): string {
  const { sql: text, params } = dialect.sqlToQuery(q);
  let out = text;
  for (let i = params.length; i >= 1; i -= 1) {
    out = out.split(`$${i}`).join(literal(params[i - 1]));
  }
  if (/\$\d/.test(out)) throw new Error(`인라인 안 된 바인드가 남았다: ${out.slice(0, 200)}`);
  return out.trim();
}

/** 프로덕션의 글로벌 루트 **scope** project id — `scope_runs.project_id` 와 비교하는 값. */
const SCOPE_ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

/**
 * 축 on + 컬럼 프로브 true + **루트 주소 지정**. 격자 키만 A/B 로 갈린다.
 *
 * ⚠️ `SCOPE_ROOT_PROJECT_ID` 를 세우지 않으면 `addressableRootProjectId()` 가 null 이라
 *    루트 스코프가 `true` 로 빠진다 — 그 문장은 프로덕션이 내는 것이 아니다(전 프로젝트
 *    스캔). 덤프의 목적이 "제품이 내는 계획" 이므로 여기서 env 를 세운다.
 */
/** 덤프가 바꾼 env 를 되돌리기 위한 보관소(`npm test` 가 이 모듈을 함께 돈다). */
const savedEnv: { mode?: string; root?: string } = {};

function fixState(grid: boolean): void {
  // `getRootConfig()` 는 mock 모드면 무조건 null 을 낸다 — 둘을 함께 세운다.
  if (!("mode" in savedEnv)) {
    savedEnv.mode = process.env.SCOPE_MODE;
    savedEnv.root = process.env.SCOPE_ROOT_PROJECT_ID;
  }
  process.env.SCOPE_MODE = "live";
  process.env.SCOPE_ROOT_PROJECT_ID = SCOPE_ROOT;
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, true);
  setAnchorAxisForTests(
    true,
    { ca: NOT_HIDDEN_FRAG("ca"), ca2: NOT_HIDDEN_FRAG("ca2") },
    undefined,
    { ca: FLEET_FRAG, ca2: FLEET_FRAG },
  );
  // 카탈로그 전 회차 탈출구(제품 책임자 2026-09-20 ①)를 덤프에 실으려면 **실제 회차 id** 가
  // 필요하다. 이 리포는 DB 에 접속하지 않으므로 env 로 받는다 — 비어 있으면 술어가
  // 안 실리고 덤프는 종전과 같다(그 자체가 "목록이 비면 바이트 동일" 의 실증이다).
  //   G2E_PRE_CATALOG_CYCLE_IDS="<uuid>,<uuid>"  ← P0 SQL 의 `cycle_id` 열을 그대로
  setTrendGridForTests(grid, grid ? preCatalogIdsFromEnv() : []);
}

/** `G2E_PRE_CATALOG_CYCLE_IDS` → uuid 목록. 형식이 아닌 값은 버린다(SQL 에 안 싣는다). */
function preCatalogIdsFromEnv(): string[] {
  return (process.env.G2E_PRE_CATALOG_CYCLE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
}

/**
 * `aggregateStandardTrendFromMirror` 의 답변셋 문장을 같은 조각으로 조립한다.
 * 필터 없음(전체 브랜드·지역) · 주 단위 · 루트.
 */
function answerSetStatement(grid: boolean): string {
  fixState(grid);
  const bkt = anchorWeekSql();
  const keys = anchorCellSnapshotKeys({ alias: "a." });
  const W = answerWhere({}, undefined, {
    allRuns: true,
    hiddenFamily: "all",
    trendRoundFloor: true,
    caJoined: trendMirrorJoins().joined,
  });
  // `withAnswerSet` 이 만드는 것과 같은 템플릿(그 함수의 `select` 식) + 같은 창 술어
  // (`aggregateStandardTrendFromMirror` 의 `bucketed`). 손으로 쓴 바닥을 쓰면 5차가
  // 잡은 두 번째 앵커 조인이 덤프에서 사라져 계획이 제품과 달라진다.
  const mirrorJoins = trendMirrorJoins();
  const join = sql`${anchorJoinSql(sql.raw("a.job_id"))}${mirrorJoins.join}`;
  const cols = sql`a.job_id, a.run_id, a.measured_at, ${bkt} AS bucket, ${anchorRoundDateSql()} AS round_date`;
  const floor = aggTestables.trendWindowFloor(
    sql`a.measured_at`,
    sql.raw("a.job_id"),
    mirrorJoins.joined,
    mirrorJoins.joined,
  );
  return compile(sql`SELECT DISTINCT ON (${keys.all}) ${cols}
  FROM scope_answers a${join}
 WHERE ${W} AND a.measured_at IS NOT NULL AND ${floor}
 ORDER BY ${keys.all}, ${keys.tieBreak}`);
}

/**
 * C = **게이트만 조인 판본, dim 술어 없음**. 게이트와 dim 의 비용을 가른다.
 *
 * ⚠️ 제품에 이 상태는 **없다**(둘 다 `X.trendGrid` 하나가 켠다). 비용 귀속을 위해
 *    같은 빌더 조각을 손으로 조합한 **진단 전용** 문장이다: A 의 술어(현재값)에
 *    5차가 만든 `sv` 조인과 그 술어만 얹는다.
 */
function gateOnlyStatement(): string {
  fixState(false);
  const bkt = anchorWeekSql();
  const keys = anchorCellSnapshotKeys({ alias: "a." });
  const W = answerWhere({}, undefined, {
    allRuns: true,
    hiddenFamily: "all",
    trendRoundFloor: true,
  });
  const svJoin = aggTestables.trendServableJoinSql();
  const gate = aggTestables.trendServableJoinedPred();
  const cols = sql`a.job_id, a.run_id, a.measured_at, ${bkt} AS bucket, ${anchorRoundDateSql()} AS round_date`;
  const floor = sql`${anchorRoundDateSql()} >= hmg_anchor_today() - ${sql.raw(String(TREND_WINDOW_DAYS))}`;
  return compile(sql`SELECT DISTINCT ON (${keys.all}) ${cols}
  FROM scope_answers a${anchorJoinSql(sql.raw("a.job_id"))}${svJoin}
 WHERE ${W} AND ${gate} AND a.measured_at IS NOT NULL AND ${floor}
 ORDER BY ${keys.all}, ${keys.tieBreak}`);
}

const HEADER = (label: string, note: string) => `-- G2e-${label} · 추이 답변셋 문장 ${note}
--
-- **손으로 쓰지 않았다** — \`scripts/db/dump-g2e-sql.ts\` 가 실제 빌더
-- (\`answerWhere\`·\`trendDimJoinSql\`·\`anchorJoinSql\`)에서 뽑아 바인드를 리터럴로
-- 인라인한 것이다. 조립 템플릿은 \`scope-aggregates.ts::withAnswerSet\` 의 \`select\` 와 같다.
--
-- 조건: 루트 be28fe15-c743-4a88-abb8-182b25602812 · **필터 없음**(전체 브랜드·지역) ·
--       주 단위 · 축 on · 창 = \`round_date >= hmg_anchor_today() - ${TREND_WINDOW_DAYS}\`.
--
-- 판정은 **B − A 순증**이다(목표 500ms 이내). 웜 캐시에서 각각 두 번 돌려 두 번째 값을 쓴다.
-- \`EXPLAIN (ANALYZE, BUFFERS)\` 는 문장을 실제로 실행한다(읽기 전용).
EXPLAIN (ANALYZE, BUFFERS)
`;

export interface G2eDump {
  name: string;
  body: string;
}

/** A/B 두 문장. 호출부(테스트 하네스)가 파일로 떨군다. */
/** 덤프가 세운 env 를 원래대로 — 이 모듈은 `npm test` 안에서도 돈다. */
function restoreEnv(): void {
  if (!("mode" in savedEnv)) return;
  if (savedEnv.mode === undefined) delete process.env.SCOPE_MODE;
  else process.env.SCOPE_MODE = savedEnv.mode;
  if (savedEnv.root === undefined) delete process.env.SCOPE_ROOT_PROJECT_ID;
  else process.env.SCOPE_ROOT_PROJECT_ID = savedEnv.root;
  delete savedEnv.mode;
  delete savedEnv.root;
}

export function buildG2eStatements(): G2eDump[] {
  const a = answerSetStatement(false);
  const b = answerSetStatement(true);
  const c = gateOnlyStatement();
  restoreEnv();
  if (a === b) throw new Error("A 와 B 가 같다 — 격자 키가 안 먹었다");
  return [
    {
      name: "G2e-C-gate-only.sql",
      body: `${HEADER("C", "(진단 전용 — 함대 게이트 조인만, dim 술어 없음)")}${c}\n`,
    },
    {
      name: "G2e-A-current.sql",
      body: `${HEADER("A", "(수리 전 = 격자 키 off, 현재값 술어)")}${a}\n`,
    },
    {
      name: "G2e-B-dim.sql",
      body: `${HEADER("B", "(격자 키 on, dim 스냅샷 술어 + 파생표 조인)")}${b}\n`,
    },
  ];
}

/**
 * 파일로 떨군다. **`G2E_DUMP_DIR` 이 있을 때만** 쓴다 — 종전에는 `npm test` 마다 리포
 * 밖 스크래치패드 3파일을 말없이 덮어썼다(검증자 주의 2).
 */
export function writeG2eStatements(outDir = process.env.G2E_DUMP_DIR): boolean {
  if (!outDir || !fs.existsSync(outDir)) return false;
  for (const s of buildG2eStatements()) {
    fs.writeFileSync(path.join(outDir, s.name), s.body);
  }
  return true;
}
