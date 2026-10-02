// 격자 off · 축 on 의 **8c9b3e7 기준선** + 모든 `caJoined` 호출부의 PREPARE (2026-09-20).
//
// 검증자 판정(5f5b84e)이 잡은 둘을 함께 막는다:
//   · 차단 — `trendWindowFloor(caJoined=true)` 가 `sv` 조인 없는 문장에 `sv` 를 넣어
//     `42P01 missing FROM-clause entry for table "sv"` 로 죽었다. 격자가 꺼져 있어도
//     **축만 켜지면** 발현해 통합 프리뷰의 인용 화면이 즉시 장애였다.
//   · 주의 — 종전 "끄면 바이트 동일" 단언이 **같은 상태를 두 번 컴파일하는 항등식**이라
//     아무것도 못 잡았다. 기준선을 리터럴로 박는다.
//
// PREPARE 는 `db.execute` mock 이 아니라 **실제 파서**다 — 그것이 42P01 을 잡는 유일한 수단이다.
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { createTableFrom, MIG_DIR } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";
import {
  answerWhere,
  detailAnswerWhere,
  trendMirrorJoins,
  __testables as agg,
} from "./scope-aggregates";
import { anchorJoinSql } from "@/lib/period/anchor-axis";
import {
  setAnchorAxisForTests,
  resetAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import { setTrendGridForTests, resetTrendGridForTests } from "@/lib/period/trend-grid-flag";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
  resetColumnAvailabilityForTests,
} from "@/lib/db/column-availability";

type Db = { exec: (s: string) => Promise<unknown>; close: () => Promise<void> };

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q).sql;
const mig = (f: string) => path.join(MIG_DIR, f);
const MIRROR_SQL = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");

const FLEET_FRAG = sql`(ca.surface = 'project' OR EXISTS (
    SELECT 1 FROM summary_cycles sc
     WHERE sc.cycle_id = ca.cycle_id
       AND sc.fleet_visible
       AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
       AND sc.active_generation_id IS NOT NULL
  ))`;

function fixAxis(grid: boolean): void {
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, true);
  setAnchorAxisForTests(true, undefined, undefined, { ca: FLEET_FRAG, ca2: FLEET_FRAG });
  setTrendGridForTests(grid);
}

beforeEach(() => {
  resetTrendGridForTests();
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
});
afterEach(() => {
  resetTrendGridForTests();
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
});

// ── `caJoined`(=`trendWindowFloor`) 를 쓰는 **모든** 호출부의 FROM 절 ──────────
//
// 셋뿐이다(소스 전수: `trendWindowFloor(` 호출 6곳 중 3인자 이상을 넘기는 것).
// 각자 자기 FROM 을 그대로 적는다 — 그것이 42P01 을 재현하는 유일한 방법이다.
type Case = { name: string; from: (grid: boolean) => SQL; where: (grid: boolean) => SQL };

const CASES: Case[] = [
  {
    // 정상 경로 — 앵커 + dim·sv 조인을 함께 붙인다.
    name: "aggregateStandardTrendFromMirror (추이 답변셋)",
    from: () => sql`scope_answers a${anchorJoinSql(sql.raw("a.job_id"))}${trendMirrorJoins().join}`,
    where: () => {
      const j = trendMirrorJoins();
      const W = answerWhere({}, undefined, {
        allRuns: true,
        hiddenFamily: "all",
        trendRoundFloor: true,
        caJoined: j.joined,
      });
      return sql`${W} AND a.measured_at IS NOT NULL AND ${agg.trendWindowFloor(
        sql`a.measured_at`,
        sql.raw("a.job_id"),
        j.joined,
        j.joined,
      )}`;
    },
  },
  {
    // ⚠️ 차단 결함의 자리 — 앵커만 조인한다(`sv` 없음).
    name: "readCitationDomainDayCounts (인용 주간 추이)",
    from: () => sql`scope_answers a${anchorJoinSql(sql.raw("a.job_id"))}`,
    where: () =>
      sql`${answerWhere({}, undefined, { allRuns: true })} AND ${agg.trendWindowFloor(
        undefined,
        undefined,
        true,
      )}`,
  },
  {
    name: "aggregateWebsiteCitationAccuracyTrend (웹 인용 정확도 추이)",
    from: () => sql`scope_answers a${anchorJoinSql(sql.raw("a.job_id"))}`,
    where: () =>
      sql`${answerWhere({}, ["11111111-1111-4111-8111-111111111111"], {
        allRuns: true,
      })} AND a.measured_at IS NOT NULL AND ${agg.trendWindowFloor(undefined, undefined, true)}`,
  },
];

let db: Db;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite() as unknown as Db;
  const anchorDdl = (() => {
    const src = fs.readFileSync(mig("0077_scope_answer_cycle_anchors.sql"), "utf8");
    const m = src.match(/CREATE TABLE scope_answer_cycle_anchors \([\s\S]*?\n {4}\);/);
    if (!m) throw new Error("0077 DDL 을 못 찾았다");
    return m[0].replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS");
  })();
  for (const s of [
    ...["scope_runs", "scope_answers", "scope_prompts"].map((t) => createTableFrom(MIRROR_SQL, t)),
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS project_id uuid;`,
    `ALTER TABLE scope_prompts ADD COLUMN IF NOT EXISTS is_korean boolean;`,
    `ALTER TABLE scope_prompts ADD COLUMN IF NOT EXISTS regions text[];`,
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycles"),
    createTableFrom(mig("0059_summary_tables.sql"), "summary_prompt_dim"),
    ...["fleet_visible boolean", "view_anchor_at timestamptz", "active_generation_id uuid"].map(
      (c) => `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS ${c};`,
    ),
    anchorDdl,
    `CREATE TABLE IF NOT EXISTS prompts (
       id uuid PRIMARY KEY, scope_prompt_id uuid, project_id uuid, brand text, list_type text,
       depth1 text, depth2 text, depth3 text, funnel_stage text, brand_presence text);`,
    `CREATE TABLE IF NOT EXISTS website_sites (id uuid PRIMARY KEY, scope_project_id uuid);`,
    `CREATE OR REPLACE FUNCTION hmg_anchor_today() RETURNS date
       LANGUAGE sql IMMUTABLE AS $fn$ SELECT current_date $fn$;`,
  ]) {
    await db.exec(s);
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("모든 caJoined 호출부가 두 상태에서 PREPARE 를 통과한다", () => {
  for (const grid of [false, true]) {
    const label = grid ? "격자 on · 축 on" : "격자 off · 축 on";
    it(`${label} — ${CASES.length}개 문장 전부`, async () => {
      const failed: string[] = [];
      for (const c of CASES) {
        fixAxis(grid);
        const stmt = `SELECT a.job_id FROM ${compile(c.from(grid))} WHERE ${compile(c.where(grid))}`;
        try {
          await db.exec(`PREPARE _p AS ${stmt}`);
          await db.exec(`DEALLOCATE _p`);
        } catch (e) {
          failed.push(`${label} / ${c.name}: ${String((e as Error).message).split("\n")[0]}`);
        }
      }
      expect(failed, failed.join("\n")).toEqual([]);
    }, 120_000);
  }

  it("조인 없는 호출부는 `sv` 를 **참조하지 않는다** (차단 결함의 지문)", () => {
    for (const grid of [false, true]) {
      fixAxis(grid);
      for (const c of CASES.slice(1)) {
        const stmt = `${compile(c.from(grid))} ${compile(c.where(grid))}`;
        expect(stmt, `${c.name} (grid=${grid})`).not.toContain("sv.cycle_id");
      }
    }
  });
});

// ── 격자 off · 축 on 의 **기준선**(8c9b3e7) ────────────────────────────────
//
// 항등식이 아니라 **박아 둔 텍스트**와 비교한다. 이 PR 이 격자 off 에서 바꾸는 것은
// `anchorLedgerServableSql` 의 `hidden_reason` 항 **하나뿐**이고(검증자 주장 5 통과 —
// 계열별 숨김 규칙으로 대체된 의도된 변경), 그 밖의 글자가 달라지면 여기서 깨진다.
// ⚠️ 여기 있던 "함대 조각의 차이는 한 항이다" 단언은 **같은 `replace` 결과를 서로
//    비교하는 항등식**이었다(2026-09-20 2차 검증 §6-1). 기준선 대조는 텍스트를 박아 둔
//    `trend-aligned-preds.test.ts` 가 전담한다 — 여기서는 **파서**만 본다.
describe("격자 off · 축 on 기준선 — 바뀌는 것은 hidden_reason 한 항뿐", () => {
  it("격자 off 의 추이 술어에 dim·sv 가 한 글자도 없다", () => {
    fixAxis(false);
    for (const build of [
      () => answerWhere({}, undefined, { allRuns: true }),
      () => detailAnswerWhere({}, undefined, { allRuns: true }),
    ]) {
      const t = compile(build());
      for (const frag of ["summary_prompt_dim", "sv.cycle_id", "d.in_root_catalog", "dim_small"]) {
        expect(t, frag).not.toContain(frag);
      }
    }
  });

  it("격자 off 의 루트 카탈로그 게이트는 **그대로** 있다", () => {
    fixAxis(false);
    expect(compile(answerWhere({}, undefined, { allRuns: true }))).toContain(
      "SELECT scope_prompt_id FROM prompts WHERE project_id =",
    );
  });
});
