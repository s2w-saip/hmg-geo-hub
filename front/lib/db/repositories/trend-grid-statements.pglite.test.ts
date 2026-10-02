// 격자 on 문장 전수가 진짜 Postgres(pglite)에서 이름·컬럼까지 해석되는가 (2026-09-20, W1).
//
// 왜 필요한가 — `axis-on-statements.pglite.test.ts` 머리 주석의 교훈이 그대로 적용된다:
// **문장 텍스트 스냅샷은 컬럼의 존재를 검증하지 않는다.** 축 on 의 글로벌 대시보드가
// `column "round_date" does not exist`(42703)로 통째로 죽었을 때 스냅샷·소스 가드는
// 전부 통과하고 있었다.
//
// 이 PR 이 내는 격자 on 문장은 축 on 문장과 **다른 표를 본다**(집계층 4표, 앵커 표가
// 아니다). 그래서 그쪽 매니페스트("전부 앵커 표를 본다" 를 단언한다)에 넣지 않고 여기서
// 따로 건다. 검증하는 명제는 하나다: **게이트를 뺀 WHERE 가 여전히 해석된다.**
//
// `PREPARE` 를 쓰는 이유는 그쪽과 같다 — 파싱 + 이름·컬럼 해석까지 하고(42703/42P01/42883),
// 행을 읽지 않아 픽스처 데이터가 필요 없다.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { createTableFrom, MIG_DIR } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";
import {
  buildTrendStatements,
  type TrendReadScope,
} from "./summary-trend-aggregates";
import { answerWhere, detailAnswerWhere } from "./scope-aggregates";
import {
  S1_STATEMENT_KEYS,
  S1_TREND_AXES,
  S1_TREND_LIMITS,
  __trendTestables,
} from "./summary-global-aggregates";

const { toCompetitorBrands } = __trendTestables;
import { setAnchorAxisForTests } from "@/lib/period/anchor-axis-state";
import { setTrendGridForTests } from "@/lib/period/trend-grid-flag";
import {
  citationCyclesOf,
  restrictToSlotRepresentative,
  type CycleSet,
} from "@/lib/summary/read/cycle-set";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { SYNC_PROBED_COLUMNS, setColumnAvailabilityForTests } from "@/lib/db/column-availability";

type Db = {
  exec: (s: string) => Promise<unknown>;
  query: <T>(s: string) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
};

const dialect = new PgDialect();
const mig = (f: string) => path.join(MIG_DIR, f);
const MIRROR_SQL = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");
const AGG_TABLES = [
  "summary_trend_answers",
  "summary_trend_brands",
  "summary_trend_domains",
  "summary_trend_own",
] as const;

const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

const set: CycleSet = {
  surface: "global",
  mode: "period",
  cycles: [1, 4].map((n) => ({
    cycleId: UUID(n),
    generationId: UUID(n + 1),
    projectId: UUID(3),
    cycleAnchorAt: n === 1 ? "2026-08-31T00:00:00.000Z" : "2026-09-07T00:00:00.000Z",
    cycleWeek: n === 1 ? "2026-08-31" : "2026-09-07",
    roundDate: n === 1 ? "2026-08-31" : "2026-09-07",
  })),
  cycleKey: "k",
  projectIds: [UUID(3)],
  missingProjectIds: [],
  weeks: ["2026-08-31", "2026-09-07"],
  anchorCount: 2,
};

const scope: TrendReadScope = {
  set,
  filters: { region: ["KR"], engine: ["chatgpt"], brandPresence: ["branded"] },
  ownVariant: OWN_VARIANT_ALL,
  ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/"],
  // 회차 축 4종을 전부 켠다 — 추이 경로가 실제로 내는 grouping set 을 덮는다.
  axes: { cycle: true, cycleBrand: true, cycleDomain: true },
  trendGrid: true,
};

/** 리터럴 인라인(축 on 매니페스트의 `compile` 과 같은 규약 — uuid 는 `::uuid`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  for (let i = params.length; i >= 1; i -= 1) out = out.split(`$${i}`).join(literal(params[i - 1]));
  if (/\$\d/.test(out)) throw new Error(`인라인 안 된 바인드가 남았다: ${out.slice(0, 200)}`);
  return out.trim();
}

/** 0077 앵커 표 DDL — 축 on 가드와 같은 파일에서 읽는다(타입 복사 금지). */
function anchorTableDdl(): string {
  const src = fs.readFileSync(mig("0077_scope_answer_cycle_anchors.sql"), "utf8");
  const m = src.match(/CREATE TABLE scope_answer_cycle_anchors \([\s\S]*?\n {4}\);/);
  if (!m) throw new Error("0077 의 scope_answer_cycle_anchors DDL 을 못 찾았다");
  return m[0].replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS");
}

/** 프로덕션의 함대 게이트와 **같은 텍스트**(`anchorLedgerServableSql`). */
const FLEET_FRAG = sql`(ca.surface = 'project' OR EXISTS (
    SELECT 1 FROM summary_cycles sc
     WHERE sc.cycle_id = ca.cycle_id
       AND sc.fleet_visible
       AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
       AND sc.active_generation_id IS NOT NULL
  ))`;

let db: Db;

beforeAll(async () => {
  // 0069 컬럼(`comp_rank_sum`)을 문장에 싣게 한다 — 프로브가 false 면 상수 0 이 나가
  // 이 가드가 정작 검증해야 할 컬럼 참조를 건너뛴다.
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, true);
  // PR④ — 미러 추이 술어를 켠 상태로 고정한다. 함대 조각은 프로덕션과 같은 텍스트를
  // 주입해야 `summary_cycles` 컬럼 참조가 실제로 PREPARE 에 걸린다(기본값은 `true`).
  setAnchorAxisForTests(true, undefined, undefined, { ca: FLEET_FRAG, ca2: FLEET_FRAG });
  setTrendGridForTests(true);
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite() as unknown as Db;
  const ddl: string[] = [
    ...AGG_TABLES.map((t) => createTableFrom(mig("0059_summary_tables.sql"), t)),
    // 0065 — `summary_trend_own` 확장 7컬럼(마이그레이션의 DO 루프와 같은 타입).
    ...[
      "comp_mentions", "all_citations", "own_citations", "own_fallback_citations",
      "tile_own_mentions", "citing_answers", "prompts_measured",
    ].map((c) => `ALTER TABLE summary_trend_own ADD COLUMN IF NOT EXISTS ${c} int NOT NULL DEFAULT 0;`),
    // 0066 — 4표 공통 두 컬럼 + 도메인 표 유닛 자사 인용.
    ...AGG_TABLES.flatMap((t) => [
      `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS report_fs int NOT NULL DEFAULT 0;`,
      `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS presence_set text[] NOT NULL DEFAULT '{}';`,
    ]),
    `ALTER TABLE summary_trend_domains ADD COLUMN IF NOT EXISTS unit_owned_citations int NOT NULL DEFAULT 0;`,
    // 0069 — 경쟁 순위 두 칸.
    `ALTER TABLE summary_trend_brands ADD COLUMN IF NOT EXISTS comp_rank_sum real NOT NULL DEFAULT 0;`,
    `ALTER TABLE summary_trend_brands ADD COLUMN IF NOT EXISTS comp_ranked_answers int NOT NULL DEFAULT 0;`,
    // ── PR④ 미러 술어가 읽는 표 ──────────────────────────────────────────────
    ...[
      "scope_runs", "scope_answers", "scope_prompts",
    ].map((t) => createTableFrom(MIRROR_SQL, t)),
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS project_id uuid;`,
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS cycle_anchor_at timestamptz;`,
    // 0046 `is_korean` · 시장 태깅 `regions` — 술어가 이 **두 컬럼을 고른다**.
    `ALTER TABLE scope_prompts ADD COLUMN IF NOT EXISTS is_korean boolean;`,
    `ALTER TABLE scope_prompts ADD COLUMN IF NOT EXISTS regions text[];`,
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycles"),
    ...[
      "hidden_reason text", "hidden_scope text", "fleet_visible boolean",
      "view_anchor_at timestamptz", "active_generation_id uuid", "cycle_week date",
    ].map((c) => `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS ${c};`),
    // dim 스냅샷 경로(2026-09-20 후속)가 읽는 표. 파티션 부모라 PREPARE 에는 파티션이
    // 없어도 되지만, 실제 실행까지 보려면 파티션이 필요하다(verify-sql 가드가 본다).
    createTableFrom(mig("0059_summary_tables.sql"), "summary_prompt_dim"),
    anchorTableDdl(),
    `CREATE TABLE IF NOT EXISTS prompts (
       id uuid PRIMARY KEY, scope_prompt_id uuid, project_id uuid, brand text, list_type text,
       depth1 text, depth2 text, depth3 text, region text, country text, lang_code text,
       brand_presence text, funnel_stage text, kind text, enabled boolean, status text,
       deleted_at timestamptz, updated_at timestamptz);`,
    `CREATE TABLE IF NOT EXISTS prompt_custom_field_values (prompt_id uuid, field_id uuid, value text);`,
    `CREATE OR REPLACE FUNCTION hmg_anchor_today() RETURNS date
       LANGUAGE sql IMMUTABLE AS $fn$ SELECT current_date $fn$;`,
  ];
  for (const s of ddl) await db.exec(s);
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("격자 on 문장 — 이름·컬럼이 해석된다", () => {
  it("게이트를 뺀 4문장이 전부 PREPARE 를 통과한다", async () => {
    const stmts = buildTrendStatements(scope);
    expect(stmts).toHaveLength(4);
    const failed: string[] = [];
    for (const st of stmts) {
      const body = compile(st.sql);
      expect(body, st.key).not.toContain("in_full_cycle");
      try {
        await db.exec(`PREPARE _g AS ${body}`);
        await db.exec(`DEALLOCATE _g`);
      } catch (e) {
        failed.push(`${st.key}: ${String((e as Error).message).split("\n")[0]}`);
      }
    }
    expect(failed, failed.join("\n")).toEqual([]);
  }, 120_000);

  // 대조군 — 같은 픽스처에서 게이트를 **켠** 문장도 통과해야 한다. 이게 깨지면
  // 위 통과가 "격자 덕분" 이 아니라 픽스처가 헐거운 것이다.
  it("게이트를 켠 종전 4문장도 같은 픽스처에서 통과한다", async () => {
    const { trendGrid: _omit, ...off } = scope;
    const stmts = buildTrendStatements(off as TrendReadScope);
    const failed: string[] = [];
    for (const st of stmts) {
      const body = compile(st.sql);
      expect(body, st.key).toContain("in_full_cycle = 1");
      try {
        await db.exec(`PREPARE _o AS ${body}`);
        await db.exec(`DEALLOCATE _o`);
      } catch (e) {
        failed.push(`${st.key}: ${String((e as Error).message).split("\n")[0]}`);
      }
    }
    expect(failed, failed.join("\n")).toEqual([]);
  }, 120_000);
});

// ── PR④ — 미러 추이 술어 ────────────────────────────────────────────────────
//
// PREPARE 는 **이름 해석만** 본다(엉뚱한 컬럼을 골라도 이름만 맞으면 통과한다).
// 그래서 텍스트 단언을 나란히 둔다 — 두 가드가 서로의 사각을 덮는다.
describe("격자 on 미러 술어 — 해석되고, 고르는 컬럼이 맞다", () => {
  const ROOT = undefined;
  const cases: Array<[string, () => SQL]> = [
    ["answerWhere(추이·기간 없음)", () => answerWhere({}, ROOT, { allRuns: true })],
    [
      "answerWhere(추이·기간)",
      () => answerWhere({ dateFrom: "2026-08-20", dateTo: "2026-09-04" }, ROOT, { allRuns: true }),
    ],
    ["detailAnswerWhere(추이)", () => detailAnswerWhere({}, ROOT, { allRuns: true })],
  ];

  it("술어를 얹은 SELECT 가 PREPARE 를 통과한다", async () => {
    const failed: string[] = [];
    for (const [name, build] of cases) {
      const body = `SELECT count(*)::int AS n FROM scope_answers a WHERE ${compile(build())}`;
      try {
        await db.exec(`PREPARE _m AS ${body}`);
        await db.exec(`DEALLOCATE _m`);
      } catch (e) {
        failed.push(`${name}: ${String((e as Error).message).split("\n")[0]}`);
      }
    }
    expect(failed, failed.join("\n")).toEqual([]);
  }, 120_000);

  it("고르는 컬럼이 사실표 게이트와 같은 것이다", () => {
    for (const [name, build] of cases) {
      const t = compile(build());
      // 한국어 비-KR — `scope_prompts.is_korean`(0046 승격 컬럼)
      expect(t, name).toContain("sp.is_korean");
      // 시장 태그 — `scope_prompts.regions`(scope #474)
      expect(t, name).toContain("cardinality(sp.regions) > 0");
      // 함대 대표 — 원장 `summary_cycles.fleet_visible`
      expect(t, name).toContain("sc.fleet_visible");
      // 카탈로그 게이트 — dim 경로는 `pd.in_root_catalog`, 폴백은 `prompts` 현재값.
      expect(t, name).toContain("d.in_root_catalog = 1");
      expect(t, name).toContain("SELECT scope_prompt_id FROM prompts");
      // full-cycle 게이트는 추이에 **없다**(D2)
      expect(t, name).not.toContain("_fc_base");
    }
  });
});

// ── 카탈로그 도입 전 회차 — **값이 실제로 나온다** (제품 책임자 2026-09-20 지시 ①) ───
//
// 여기는 PREPARE 가 아니라 **실행**이다. 이 규칙의 실패 모드가 "문장은 해석되는데
// 행이 0" 이기 때문이다(6월 자리가 빈 원인이 정확히 그것이었다) — 이름 해석만 보는
// 가드로는 절대 안 잡힌다.
//
// 픽스처는 두 회차다:
//   · JUNE — 사실표 행은 있는데 `in_root_catalog = 1` 이 **하나도 없다**(카탈로그 전 세대)
//   · AUG  — 혼합 회차(카탈로그 행 있음 + 밖 행 있음). 규칙이 **여기엔 적용되면 안 된다**.
describe("카탈로그 전 회차 — 게이트를 열면 6월 자리에 값이 선다", () => {
  const JUNE = { cycle: UUID(21), gen: UUID(22), anchor: "2026-06-18T15:00:00.000Z", week: "2026-06-15" };
  const AUG = { cycle: UUID(23), gen: UUID(24), anchor: "2026-08-31T00:00:00.000Z", week: "2026-08-31" };
  const PROJECT = UUID(3);

  const ownRow = (
    c: { cycle: string; gen: string; anchor: string; week: string },
    inCatalog: 0 | 1,
    monitored: number,
    tracked: number,
    // 엔진은 PK 의 일부다 — 같은 회차에 행을 둘 넣으려면 여기가 달라야 한다.
    engine = "chatgpt",
  ) => `INSERT INTO summary_trend_own
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, engine,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant,
       monitored, tracked_answers, multi_answers, top1_answers, top3_answers,
       ranked_answers, own_mentions, own_positive, own_signals, prompts_tracked)
     VALUES ('${c.cycle}'::uuid, '${c.gen}'::uuid, '${c.anchor}'::timestamptz, '${c.week}'::date,
       'global', '${PROJECT}'::uuid, 'US', '${engine}',
       ${inCatalog}, 1, 0, 'completed', '${OWN_VARIANT_ALL}',
       ${monitored}, ${tracked}, 0, 0, 0, 0, 0, 0, 0, 0);`;

  const setOf = (cycles: Array<{ cycle: string; gen: string; anchor: string; week: string }>): CycleSet => ({
    surface: "global",
    mode: "period",
    cycles: cycles.map((c) => ({
      cycleId: c.cycle,
      generationId: c.gen,
      projectId: PROJECT,
      cycleAnchorAt: c.anchor,
      cycleWeek: c.week,
      roundDate: c.anchor.slice(0, 10),
    })) as unknown as CycleSet["cycles"],
    cycleKey: "pc",
    projectIds: [PROJECT],
    missingProjectIds: [],
    weeks: cycles.map((c) => c.week),
    anchorCount: cycles.length,
  });

  const scopeOf = (
    cycles: Array<{ cycle: string; gen: string; anchor: string; week: string }>,
    preCatalogCycleIds?: string[],
  ): TrendReadScope => ({
    set: setOf(cycles),
    filters: {},
    ownVariant: OWN_VARIANT_ALL,
    ownedBasePrefixes: [],
    axes: { cycle: true },
    trendGrid: true,
    ...(preCatalogCycleIds ? { preCatalogCycleIds } : {}),
  });

  /** `own` 문장을 실행해 회차 축 행의 (자리, 모수, 분자)를 낸다. */
  async function runOwn(scope: TrendReadScope) {
    const [st] = buildTrendStatements(scope, { only: ["own"] });
    const rows = await db.query<{ axis: string; cycle_anchor_at: string; monitored: string; tracked_answers: string }>(
      compile(st.sql),
    );
    return rows.rows
      .filter((r) => r.axis === "cycle")
      .map((r) => ({
        // pglite 는 timestamptz 를 Date 로 돌려준다 — 문자열 자르기 전에 ISO 로 되돌린다.
        day: new Date(r.cycle_anchor_at as unknown as string).toISOString().slice(0, 10),
        monitored: Number(r.monitored),
        tracked: Number(r.tracked_answers),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  beforeAll(async () => {
    await db.exec(ownRow(JUNE, 0, 900, 600, "chatgpt"));
    await db.exec(ownRow(JUNE, 0, 600, 300, "gemini"));
    await db.exec(ownRow(AUG, 1, 1000, 500));
    await db.exec(ownRow(AUG, 0, 400, 400));
  }, 60_000);

  it("목록이 없으면 6월 자리는 **행이 0**이다 (오늘의 증상)", async () => {
    expect(await runOwn(scopeOf([JUNE]))).toEqual([]);
  });

  it("목록에 넣으면 그 회차가 측정한 프롬프트 **전체**가 모수다", async () => {
    expect(await runOwn(scopeOf([JUNE], [JUNE.cycle]))).toEqual([
      { day: "2026-06-18", monitored: 1500, tracked: 900 },
    ]);
  });

  it("혼합 회차(AUG)는 목록에 넣어도 **규칙 대상이 아니다** — 판정이 데이터에 있다", async () => {
    // 카탈로그 행이 하나라도 있으면 판정 SQL 의 `NOT EXISTS` 가 거짓이라 목록에 못 든다.
    // 만약 운영 실수로 들어오면 모수가 부푼다는 것을 여기서 수치로 드러낸다(1000 → 1400).
    expect(await runOwn(scopeOf([AUG]))).toEqual([
      { day: "2026-08-31", monitored: 1000, tracked: 500 },
    ]);
    expect(await runOwn(scopeOf([AUG], [AUG.cycle]))).toEqual([
      { day: "2026-08-31", monitored: 1400, tracked: 900 },
    ]);
  });

  it("두 회차를 함께 읽으면 6월만 열리고 8월은 종전 게이트다", async () => {
    expect(await runOwn(scopeOf([JUNE, AUG], [JUNE.cycle]))).toEqual([
      { day: "2026-06-18", monitored: 1500, tracked: 900 },
      { day: "2026-08-31", monitored: 1000, tracked: 500 },
    ]);
  });
});

// ── 회귀(2026-09-20 프리뷰): 한 자리 두 회차 중 하나가 `citations` 숨김 ───────
//
// 08-24 자리의 실제 모양이다: 앵커 08-18(정상)과 앵커 08-25(`hidden_scope='citations'`)
// 가 같은 귀속 날짜에 있다. 여기서 검증하는 명제 둘 —
//   ① **언급·노출률**(`own`)은 그 자리에 값이 있다. 대표가 숨김이 아닌 회차이기 때문.
//   ② **인용**(`domains`)은 숨김 회차를 읽지 않는다. 대표가 숨김일 때만 그 자리가 빈다.
// 값을 실제로 읽는다(PREPARE 가 아니다) — 이 회귀의 지문이 "문장은 도는데 행이 0" 이다.
describe("한 자리 두 회차(하나는 인용 숨김) — 노출률은 살고 인용만 빠진다", () => {
  const OK = { cycle: UUID(31), gen: UUID(32), anchor: "2026-08-18T15:48:00.000Z", week: "2026-08-17" };
  const HID = { cycle: UUID(33), gen: UUID(34), anchor: "2026-08-25T15:48:00.000Z", week: "2026-08-24" };
  const PROJECT = UUID(3);
  const ROUND = "2026-08-24";

  const ownRow = (c: typeof OK, monitored: number, tracked: number) =>
    `INSERT INTO summary_trend_own
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, engine,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant,
       monitored, tracked_answers, multi_answers, top1_answers, top3_answers,
       ranked_answers, own_mentions, own_positive, own_signals, prompts_tracked)
     VALUES ('${c.cycle}'::uuid, '${c.gen}'::uuid, '${c.anchor}'::timestamptz, '${c.week}'::date,
       'global', '${PROJECT}'::uuid, 'US', 'chatgpt', 1, 1, 0, 'completed', '${OWN_VARIANT_ALL}',
       ${monitored}, ${tracked}, 0, 0, 0, 0, 0, 0, 0, 0);`;

  const domRow = (c: typeof OK, citations: number) =>
    `INSERT INTO summary_trend_domains
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, engine,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status,
       group_key, domain, base_norm_null, citations, citing_answers)
     VALUES ('${c.cycle}'::uuid, '${c.gen}'::uuid, '${c.anchor}'::timestamptz, '${c.week}'::date,
       'global', '${PROJECT}'::uuid, 'US', 'chatgpt', 1, 1, 0, 'completed',
       'news', 'example.com', 0, ${citations}, ${citations});`;

  const setOf = (excluded?: string[]): CycleSet => {
    const base = {
      surface: "global" as const,
      mode: "period" as const,
      cycles: [OK, HID].map((c) => ({
        cycleId: c.cycle,
        generationId: c.gen,
        projectId: PROJECT,
        cycleAnchorAt: c.anchor,
        cycleWeek: c.week,
        roundDate: ROUND,
        // 격자 on 신호 — 이것이 없으면 자리 대표 거르기가 no-op 이다.
        completionRatio: 1,
      })) as unknown as CycleSet["cycles"],
      cycleKey: "merged",
      projectIds: [PROJECT],
      missingProjectIds: [],
      weeks: [OK.week, HID.week],
      anchorCount: 1,
    };
    return excluded?.length ? { ...base, citationExcludedCycleIds: excluded } : base;
  };

  const scopeOf = (s: CycleSet): TrendReadScope => ({
    set: s,
    filters: {},
    ownVariant: OWN_VARIANT_ALL,
    ownedBasePrefixes: [],
    axes: { cycle: true, cycleDomain: true },
    trendGrid: true,
  });

  async function run(key: "own" | "domains", s: CycleSet) {
    const [st] = buildTrendStatements(scopeOf(s), { only: [key] });
    const r = await db.query<Record<string, unknown>>(compile(st.sql));
    return r.rows.filter((x) => x.axis === "cycle");
  }

  beforeAll(async () => {
    await db.exec(ownRow(OK, 9068, 6500));
    await db.exec(ownRow(HID, 9652, 6635));
    await db.exec(domRow(OK, 500));
    await db.exec(domRow(HID, 12));   // 깨진 회차 — 인용률이 비정상으로 낮다
  }, 60_000);

  // ⚠️ 2026-09-20 독립 검증 차단 2 이후: 언급 대표는 **인용 전용 숨김을 무시한다**.
  //    `hidden_scope='citations'` 는 그 회차의 인용만 깨졌다는 뜻이고 언급 값은 정상이다
  //    (제품 책임자 방침). 그래서 이 자리의 대표는 계열마다 갈린다 — 언급 `HID`(늦은 앵커),
  //    인용 `OK`. 프로덕션 8/24 자리의 실제 대응은 언급 1045851c · 인용 2a4f2bb1 이다.
  it("① 언급 대표는 늦은 앵커(숨김 회차)이고, 그 자리에 노출률 값이 선다", async () => {
    const { set, mergedSlots, familySplitSlots } = restrictToSlotRepresentative(setOf([HID.cycle]));
    expect(mergedSlots).toEqual([ROUND]);
    expect(set.cycles.map((c) => c.cycleId)).toEqual([HID.cycle]);
    expect(familySplitSlots).toEqual([ROUND]);
    const rows = await run("own", set);
    expect(rows).toHaveLength(1);
    // 숨김 회차의 **언급** 모수는 살아 있다(9,652 = 그 회차가 실제로 돈 유닛).
    expect(Number(rows[0].monitored)).toBe(9652);
    expect(Number(rows[0].tracked_answers)).toBe(6635);
  });

  it("② 인용 계열은 **자기 대표**(숨김 아님)를 읽는다", async () => {
    const { set } = restrictToSlotRepresentative(setOf([HID.cycle]));
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual([OK.cycle]);
    const rows = await run("domains", set);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].citations)).toBe(500);
  });

  it("③ 깨진 회차의 인용(12)이 값에 섞이지 않는다", async () => {
    const { set } = restrictToSlotRepresentative(setOf([HID.cycle]));
    const rows = await run("domains", set);
    expect(Number(rows[0].citations)).not.toBe(12);
    expect(Number(rows[0].citations)).not.toBe(512);
  });

  it("④ 수리 전 규칙(늦은 앵커)이면 인용이 **0행**이 된다 — 회귀의 지문", async () => {
    // 숨김 회차만 남은 집합 = 초판이 고르던 것. 인용 문장의 회차 집합이 비어 자리가 죽는다.
    const hiddenOnly: CycleSet = {
      ...setOf([HID.cycle]),
      cycles: setOf().cycles.filter((c) => c.cycleId === HID.cycle),
      cycleKey: "hidden-only",
    };
    expect(await run("domains", hiddenOnly)).toHaveLength(0);
    // 반대로 언급은 그 상태에서도 살아 있다(값의 출처가 다르다).
    expect(await run("own", hiddenOnly)).toHaveLength(1);
  });
});

// ── 엔진 축 매퍼 — **실제 실행**으로 확인 (2026-09-20) ───────────────────────
//
// `toSeries` 가 새로 읽는 `cycle-engine` 축은 `axes.cycle` 이 이미 내던 grouping set 이다.
// "문장은 도는데 그 축 행이 안 나온다" 가 이 변경의 실패 모드라, PREPARE 가 아니라
// 행을 읽어 확인한다.
describe("엔진 축 — 문장이 `cycle-engine` 행을 실제로 낸다", () => {
  const CY = { cycle: UUID(41), gen: UUID(42), anchor: "2026-09-14T15:48:00.000Z", week: "2026-09-14" };
  const PROJECT = UUID(3);

  const ownRow = (engine: string, monitored: number, tracked: number) =>
    `INSERT INTO summary_trend_own
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, engine,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant,
       monitored, tracked_answers, multi_answers, top1_answers, top3_answers,
       ranked_answers, own_mentions, own_positive, own_signals, prompts_tracked)
     VALUES ('${CY.cycle}'::uuid, '${CY.gen}'::uuid, '${CY.anchor}'::timestamptz, '${CY.week}'::date,
       'global', '${PROJECT}'::uuid, 'US', '${engine}', 1, 1, 0, 'completed', '${OWN_VARIANT_ALL}',
       ${monitored}, ${tracked}, 0, 0, 0, 0, 0, 0, 0, 0);`;

  const scopeOf = (): TrendReadScope => ({
    set: {
      surface: "global",
      mode: "period",
      cycles: [{
        cycleId: CY.cycle, generationId: CY.gen, projectId: PROJECT,
        cycleAnchorAt: CY.anchor, cycleWeek: CY.week, roundDate: "2026-09-14",
      }] as unknown as CycleSet["cycles"],
      cycleKey: "eng",
      projectIds: [PROJECT],
      missingProjectIds: [],
      weeks: [CY.week],
      anchorCount: 1,
    },
    filters: {},
    ownVariant: OWN_VARIANT_ALL,
    ownedBasePrefixes: [],
    axes: { cycle: true },
    trendGrid: true,
  });

  beforeAll(async () => {
    await db.exec(ownRow("chatgpt", 600, 420));
    await db.exec(ownRow("gemini", 400, 200));
  }, 60_000);

  it("`cycle-engine` 축 행이 엔진마다 하나씩 나온다", async () => {
    const [st] = buildTrendStatements(scopeOf(), { only: ["own"] });
    const r = await db.query<{ axis: string; bucket: string | null; monitored: string; tracked_answers: string }>(
      compile(st.sql),
    );
    const rows = r.rows
      .filter((x) => x.axis === "cycle-engine")
      .map((x) => ({ engine: x.bucket, monitored: Number(x.monitored), tracked: Number(x.tracked_answers) }))
      .sort((a, b) => (String(a.engine) < String(b.engine) ? -1 : 1));
    expect(rows).toEqual([
      { engine: "chatgpt", monitored: 600, tracked: 420 },
      { engine: "gemini", monitored: 400, tracked: 200 },
    ]);
  });

  it("엔진 행의 합이 `cycle` 축 합계와 같다 (축을 더해도 문장이 하나다)", async () => {
    const [st] = buildTrendStatements(scopeOf(), { only: ["own"] });
    const r = await db.query<{ axis: string; monitored: string }>(compile(st.sql));
    const total = r.rows.filter((x) => x.axis === "cycle").reduce((s2, x) => s2 + Number(x.monitored), 0);
    const byEngine = r.rows
      .filter((x) => x.axis === "cycle-engine")
      .reduce((s2, x) => s2 + Number(x.monitored), 0);
    expect(byEngine).toBe(total);
    expect(total).toBe(1000);
  });
});

// ── M1(2026-09-20 독립 검증): `citationCycles` 가 실린 도메인 문장 ───────────
//
// N3 의 계열별 대표는 **인용 문장의 회차 스코프를 바꾼다**(`citationScopeOf` →
// `cycleScope`). 그 문장을 지금까지 어떤 pglite 가드도 파싱하지 않았다 — 이 트랙이
// 42P01 로 한 번 값을 치른 사각이라, 여기서 **PREPARE 와 실행을 둘 다** 한다.
describe("계열별 대표 — 인용 문장이 자기 회차를 읽는다", () => {
  const MENTION = { cycle: UUID(51), gen: UUID(52), anchor: "2026-08-25T15:48:00.000Z", week: "2026-08-24" };
  const CITATION = { cycle: UUID(53), gen: UUID(54), anchor: "2026-08-18T15:48:00.000Z", week: "2026-08-17" };
  const PROJECT = UUID(3);

  const domRow = (c: typeof MENTION, citations: number) =>
    `INSERT INTO summary_trend_domains
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, engine,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status,
       group_key, domain, base_norm_null, citations, citing_answers)
     VALUES ('${c.cycle}'::uuid, '${c.gen}'::uuid, '${c.anchor}'::timestamptz, '${c.week}'::date,
       'global', '${PROJECT}'::uuid, 'US', 'chatgpt', 1, 1, 0, 'completed',
       'news', 'example.com', 0, ${citations}, ${citations});`;

  const pickOf = (c: typeof MENTION) => ({
    cycleId: c.cycle, generationId: c.gen, projectId: PROJECT,
    cycleAnchorAt: c.anchor, cycleWeek: c.week, roundDate: "2026-08-24",
  });

  /** 언급 대표는 숨김 회차, 인용 대표는 **다른 회차**(N3 이 만드는 모양). */
  const splitSet = (): CycleSet => ({
    surface: "global",
    mode: "period",
    cycles: [pickOf(MENTION)] as unknown as CycleSet["cycles"],
    cycleKey: "split",
    projectIds: [PROJECT],
    missingProjectIds: [],
    weeks: [MENTION.week],
    anchorCount: 1,
    citationCycles: [pickOf(CITATION)] as unknown as CycleSet["cycles"],
  });

  const scopeOf = (set: CycleSet): TrendReadScope => ({
    set,
    filters: {},
    ownVariant: OWN_VARIANT_ALL,
    ownedBasePrefixes: [],
    axes: { cycle: true, cycleDomain: true },
    trendGrid: true,
  });

  beforeAll(async () => {
    await db.exec(domRow(MENTION, 7));      // 깨진 회차 — 인용률이 비정상
    await db.exec(domRow(CITATION, 500));   // 정상 회차
  }, 60_000);

  it("PREPARE 를 통과한다 (이름·컬럼 해석)", async () => {
    const [st] = buildTrendStatements(scopeOf(splitSet()), { only: ["domains"] });
    const body = compile(st.sql);
    await db.exec(`PREPARE _cc AS ${body}`);
    await db.exec(`DEALLOCATE _cc`);
    // 인용 문장의 쌍 IN 은 **인용 대표**의 id 를 담는다(언급 대표가 아니다).
    expect(body).toContain(CITATION.cycle);
    expect(body).not.toContain(MENTION.cycle);
  }, 60_000);

  it("실행하면 **인용 대표 회차의 값**이 나온다 (깨진 7 이 아니다)", async () => {
    const [st] = buildTrendStatements(scopeOf(splitSet()), { only: ["domains"] });
    const r = await db.query<{ axis: string; citations: string }>(compile(st.sql));
    const cyc = r.rows.filter((x) => x.axis === "cycle");
    expect(cyc).toHaveLength(1);
    expect(Number(cyc[0].citations)).toBe(500);
  });

  it("`citationCycles` 가 없으면 종전대로 언급 대표를 읽는다", async () => {
    const plain = { ...splitSet() } as CycleSet & { citationCycles?: unknown };
    delete plain.citationCycles;
    const [st] = buildTrendStatements(scopeOf(plain as CycleSet), { only: ["domains"] });
    const r = await db.query<{ axis: string; citations: string }>(compile(st.sql));
    const cyc = r.rows.filter((x) => x.axis === "cycle");
    expect(Number(cyc[0].citations)).toBe(7);
  });
});

// ── 경쟁사 값 문장 — **PREPARE + 실행** (2026-09-20) ─────────────────────────
//
// 언급 화면의 경쟁사 값이 이 문장으로 옮겨 왔다(`fetchStandardMentionCompetitorBrands`
// → `viaGlobalS1` → `summaryGlobalS1FromTrend`, `S1_STATEMENT_KEYS`). 그 전까지 그
// 경로에 붙어 있던 가드는 **문장 텍스트**뿐이고, 이 리포에서 그 사각으로 42P01 이 한 번
// 샜다(`grid-off-baseline.pglite.test.ts` 머리 주석).
//
// 그래서 여기서는 셋을 다 한다: 세 문장 PREPARE · 브랜드 문장 실행 · `toCompetitorBrands`
// 가 그 행에서 실제로 내는 값 확인(0069 두 칸이 상수 0 으로 대체되지 않았는지 포함).
describe("경쟁사 값 문장 — 파싱·실행·매핑", () => {
  const CY = { cycle: UUID(61), gen: UUID(62), anchor: "2026-09-21T15:48:00.000Z", week: "2026-09-21" };
  const PROJECT = UUID(3);

  /** `brand` 축 = 국가·엔진·회차 GROUPING 이 전부 1(집계 행). 매퍼와 같은 판정이다. */
  const brandAxis = (x: Record<string, unknown>): boolean =>
    Number(x.by_country) === 1 &&
    Number(x.by_engine) === 1 &&
    Number(x.by_cycle) === 1 &&
    x.brand_name != null;

  /** 당사 판정은 `brand_id = ANY(ownEntities)` 다 — 표에 `is_tracked` 컬럼은 없다. */
  const HYUNDAI_ID = UUID(71);
  const TESLA_ID = UUID(72);

  const brandRow = (
    name: string,
    brandId: string,
    mentions: number,
    answers: number,
    comp: { sum: number; cnt: number },
    sent: [number, number, number, number],
  ) =>
    `INSERT INTO summary_trend_brands
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, engine,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status,
       brand_id, brand_name, is_competitor, mentions, answers,
       rank_sum, ranked_answers, top3_answers, comp_rank_sum, comp_ranked_answers,
       positive, neutral, negative, mixed,
       type_mention, type_recommendation, type_comparison, type_definition, type_final_choice)
     VALUES ('${CY.cycle}'::uuid, '${CY.gen}'::uuid, '${CY.anchor}'::timestamptz, '${CY.week}'::date,
       'global', '${PROJECT}'::uuid, 'US', 'chatgpt', 1, 1, 0, 'completed',
       '${brandId}'::uuid, '${name}', 1, ${mentions}, ${answers},
       0, 0, 0, ${comp.sum}, ${comp.cnt},
       ${sent[0]}, ${sent[1]}, ${sent[2]}, ${sent[3]},
       0, 0, 0, 0, 0);`;

  const ownTotalRow = (monitored: number) =>
    `INSERT INTO summary_trend_own
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, engine,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant,
       monitored, tracked_answers, multi_answers, top1_answers, top3_answers,
       ranked_answers, own_mentions, own_positive, own_signals, prompts_tracked)
     VALUES ('${CY.cycle}'::uuid, '${CY.gen}'::uuid, '${CY.anchor}'::timestamptz, '${CY.week}'::date,
       'global', '${PROJECT}'::uuid, 'US', 'chatgpt', 1, 1, 0, 'completed', '${OWN_VARIANT_ALL}',
       ${monitored}, 0, 0, 0, 0, 0, 0, 0, 0, 0);`;

  const s1Scope = (): TrendReadScope => ({
    set: {
      surface: "global",
      mode: "period",
      cycles: [{
        cycleId: CY.cycle, generationId: CY.gen, projectId: PROJECT,
        cycleAnchorAt: CY.anchor, cycleWeek: CY.week, roundDate: "2026-09-21",
      }] as unknown as CycleSet["cycles"],
      cycleKey: "s1-comp",
      projectIds: [PROJECT],
      missingProjectIds: [],
      weeks: [CY.week],
      anchorCount: 1,
    },
    // 당사 엔티티 = Hyundai 하나. 이 목록이 `is_tracked` 를 만든다.
    filters: { ownEntities: [{ id: HYUNDAI_ID, name: "Hyundai" }] },
    ownVariant: OWN_VARIANT_ALL,
    ownedBasePrefixes: [],
    axes: S1_TREND_AXES,
    limits: S1_TREND_LIMITS,
    trendGrid: true,
  });

  beforeAll(async () => {
    await db.exec(ownTotalRow(1000));
    // 모수 1000 · 브랜드 축 언급 합 200 → mentionRate = answers/1000, share = mentions/200.
    await db.exec(brandRow("Tesla", TESLA_ID, 65, 301, { sum: 39, cnt: 10 }, [669, 200, 100, 31]));
    await db.exec(brandRow("Hyundai", HYUNDAI_ID, 135, 533, { sum: 26, cnt: 10 }, [576, 240, 140, 44]));
  }, 60_000);

  it("S1 세 문장(own·brands·domains)이 PREPARE 를 통과한다", async () => {
    const stmts = buildTrendStatements(s1Scope(), { only: S1_STATEMENT_KEYS });
    expect(stmts.map((s) => s.key).sort()).toEqual([...S1_STATEMENT_KEYS].sort());
    const failed: string[] = [];
    for (const st of stmts) {
      try {
        await db.exec(`PREPARE _c AS ${compile(st.sql)}`);
        await db.exec(`DEALLOCATE _c`);
      } catch (e) {
        failed.push(`${st.key}: ${String((e as Error).message).split("\n")[0]}`);
      }
    }
    expect(failed, failed.join("\n")).toEqual([]);
  }, 120_000);

  it("브랜드 문장을 **실행**하면 경쟁 순위 두 칸이 실려 온다(상수 0 이 아니다)", async () => {
    const [st] = buildTrendStatements(s1Scope(), { only: ["brands"] });
    const r = await db.query<Record<string, unknown>>(compile(st.sql));
    const rows = r.rows.filter(brandAxis);
    expect(rows.map((x) => x.brand_name).sort()).toEqual(["Hyundai", "Tesla"]);
    const tesla = rows.find((x) => x.brand_name === "Tesla")!;
    expect(Number(tesla.comp_rank_sum)).toBe(39);
    expect(Number(tesla.comp_ranked_answers)).toBe(10);
    expect(Number(tesla.positive)).toBe(669);
  });

  it("그 행에서 `toCompetitorBrands` 가 두 화면이 보는 값을 낸다", async () => {
    const [st] = buildTrendStatements(s1Scope(), { only: ["brands"] });
    const r = await db.query<Record<string, unknown>>(compile(st.sql));
    const brandRows = r.rows
      .filter(brandAxis)
      .map((x) => ({
        axis: "brand" as const,
        country: null, engine: null, cycleAnchorAt: null,
        brandName: x.brand_name as string,
        isRest: false, restCount: 0, keyRows: 1,
        isTracked: x.is_tracked === true,
        mentions: Number(x.mentions), answers: Number(x.answers),
        rankSum: Number(x.rank_sum), rankedAnswers: Number(x.ranked_answers),
        compRankSum: Number(x.comp_rank_sum), compRankedAnswers: Number(x.comp_ranked_answers),
        top3Answers: 0,
        positive: Number(x.positive), neutral: Number(x.neutral),
        negative: Number(x.negative), mixed: Number(x.mixed),
        typeMention: 0, typeRecommendation: 0, typeComparison: 0,
        typeDefinition: 0, typeFinalChoice: 0,
      }));
    const ownTotal = { monitored: 1000 } as Parameters<typeof toCompetitorBrands>[1];
    const out = toCompetitorBrands(
      { empty: false, answers: [], own: [], brands: brandRows, domains: [] } as never,
      ownTotal,
    );
    const tesla = out.find((b) => b.brand === "Tesla")!;
    expect(tesla).toMatchObject({
      mentions: 65,
      share: 32.5,      // 65 / 200
      mentionRate: 30.1, // 301 / 1000
      avgPosition: 3.9,  // 39 / 10  (comp 축)
      isTracked: false,
    });
    // 당사 개별 행도 같은 함수가 낸다(언급 화면의 당사 3사 행이 이 값이다).
    expect(out.find((b) => b.brand === "Hyundai")).toMatchObject({
      mentionRate: 53.3,
      avgPosition: 2.6,
      isTracked: true,
    });
  });
});
