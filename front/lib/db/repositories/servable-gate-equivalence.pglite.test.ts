// 함대 게이트 **재작성 전후 동치** — semi-join 판본 대 조인 판본 (2026-09-20, 5차).
//
// 5차 실측에서 순증의 1.06초가 게이트였다: `a.job_id IN (SELECT ca.job_id FROM
// scope_answer_cycle_anchors ca WHERE ca.surface='project' OR EXISTS (… summary_cycles …))`
// 가 앵커 표를 한 번 더 찌르고(`ca_1` loops=187,233) 회차를 행마다 조회했다(`sc_1` 같은 수).
// 조인 판본으로 바꿨는데, **통과하는 답변 집합이 바뀌면 안 된다.**
//
// 텍스트 단언으로는 그것을 못 본다(두 술어는 글자가 전혀 다르다). 그래서 실제 Postgres
// (pglite)에서 두 형태를 **같은 픽스처에 돌려 결과 집합을 비교**한다.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { createTableFrom, MIG_DIR } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";
import { __testables as agg } from "./scope-aggregates";

type Db = {
  exec: (s: string) => Promise<unknown>;
  query: (s: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
};

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q).sql;
const mig = (f: string) => path.join(MIG_DIR, f);
const MIRROR_SQL = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");

/** 재작성 **전** 판본 — `anchorLedgerServableSql` 의 텍스트 그대로(1910e33 이후). */
const SEMI_JOIN_FORM = `a.job_id IN (
  SELECT ca.job_id FROM scope_answer_cycle_anchors ca
   WHERE (ca.surface = 'project' OR EXISTS (
     SELECT 1 FROM summary_cycles sc
      WHERE sc.cycle_id = ca.cycle_id
        AND sc.fleet_visible
        AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
        AND sc.active_generation_id IS NOT NULL
   )))`;

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
    createTableFrom(MIRROR_SQL, "scope_answers"),
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycles"),
    ...["fleet_visible boolean", "view_anchor_at timestamptz", "active_generation_id uuid"].map(
      (c) => `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS ${c};`,
    ),
    anchorDdl,
  ]) {
    await db.exec(s);
  }
  await seed();
}, 180_000);

afterAll(async () => {
  await db?.close();
});

const CYC = {
  servable: "11111111-1111-4111-8111-111111111111",
  notFleet: "22222222-2222-4222-8222-222222222222",
  noGen: "33333333-3333-4333-8333-333333333333",
  future: "44444444-4444-4444-8444-444444444444",
};

/** 회차 넷 + 그 회차의 답변 하나씩 + 앵커 없는 답변 + cycle_id NULL 앵커. */
async function seed(): Promise<void> {
  const rows: string[] = [];
  // ⚠️ `(project_id, cycle_anchor_at)` UNIQUE 라 회차마다 앵커 시각을 다르게 준다.
  let anchorDay = 0;
  const cycle = (id: string, fleet: boolean, gen: boolean, viewPast: boolean) => {
    anchorDay += 1;
    return `INSERT INTO summary_cycles (cycle_id, project_id, surface, cycle_anchor_at, cycle_week,
       anchor_source, status, fleet_visible, active_generation_id, view_anchor_at)
     VALUES ('${id}'::uuid, '99999999-9999-4999-8999-999999999999'::uuid, 'global',
       '2026-08-0${anchorDay}T00:00:00Z', '2026-07-27'::date, 'scope', 'published', ${fleet},
       ${gen ? `'88888888-8888-4888-8888-888888888888'::uuid` : "NULL"},
       ${viewPast ? "'2026-08-05T00:00:00Z'" : "'2099-01-01T00:00:00Z'"});`;
  };
  rows.push(cycle(CYC.servable, true, true, true));
  rows.push(cycle(CYC.notFleet, false, true, true));
  rows.push(cycle(CYC.noGen, true, false, true));
  rows.push(cycle(CYC.future, true, true, false));

  let n = 0;
  const answer = (job: string, cycleId: string | null, surface: string) => {
    n += 1;
    return `INSERT INTO scope_answers (job_id, run_id, prompt_id, target, region, status)
       VALUES ('${job}'::uuid, '77777777-7777-4777-8777-77777777777${n}'::uuid,
         '66666666-6666-4666-8666-666666666666'::uuid, 'chatgpt', 'US', 'completed');
     INSERT INTO scope_answer_cycle_anchors
       (job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week, anchor_month,
        measured_at_orig, is_default_engine, round_date, cycle_id, source)
       VALUES ('${job}'::uuid, '77777777-7777-4777-8777-77777777777${n}'::uuid,
         '99999999-9999-4999-8999-999999999999'::uuid, '${surface}',
         '2026-08-01T00:00:00Z', '2026-08-01'::date, '2026-07-27'::date, '2026-08-01'::date,
         '2026-08-01T00:00:00Z', true, '2026-08-03'::date,
         ${cycleId ? `'${cycleId}'::uuid` : "NULL"}, 'ledger');`;
  };
  rows.push(answer("aaaaaaaa-0000-4000-8000-000000000001", CYC.servable, "standard"));
  rows.push(answer("aaaaaaaa-0000-4000-8000-000000000002", CYC.notFleet, "standard"));
  rows.push(answer("aaaaaaaa-0000-4000-8000-000000000003", CYC.noGen, "standard"));
  rows.push(answer("aaaaaaaa-0000-4000-8000-000000000004", CYC.future, "standard"));
  // cycle_id 가 NULL 인 standard 앵커 — 원장이 허락한 적 없는 행.
  rows.push(answer("aaaaaaaa-0000-4000-8000-000000000005", null, "standard"));
  // project 표면은 원장이 없어 통과시킨다(그 팔의 회귀 가드).
  rows.push(answer("aaaaaaaa-0000-4000-8000-000000000006", null, "project"));
  // 앵커 행이 **아예 없는** 답변 — 두 형태 모두에서 빠져야 한다(INNER 조인 계약).
  rows.push(`INSERT INTO scope_answers (job_id, run_id, prompt_id, target, region, status)
     VALUES ('aaaaaaaa-0000-4000-8000-000000000007'::uuid,
       '77777777-7777-4777-8777-777777777779'::uuid,
       '66666666-6666-4666-8666-666666666666'::uuid, 'chatgpt', 'US', 'completed');`);
  for (const r of rows) await db.exec(r);
}

const jobsOf = async (stmt: string): Promise<string[]> => {
  const { rows } = await db.query(stmt);
  return rows.map((r) => String(r.job_id)).sort();
};

describe("함대 게이트 — semi-join 판본과 조인 판본이 같은 집합을 낸다", () => {
  it("두 형태의 통과 집합이 **완전히 같다**", async () => {
    const before = await jobsOf(
      `SELECT a.job_id FROM scope_answers a WHERE ${SEMI_JOIN_FORM}`,
    );
    const after = await jobsOf(
      `SELECT a.job_id FROM scope_answers a
         JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
         ${compile(agg.trendServableJoinSql())}
        WHERE ${compile(agg.trendServableJoinedPred())}`,
    );
    expect(after).toEqual(before);
  });

  it("노출 불가 회차의 답변은 **빠진다** (대표 아님·미발행·노출일 전)", async () => {
    const after = await jobsOf(
      `SELECT a.job_id FROM scope_answers a
         JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
         ${compile(agg.trendServableJoinSql())}
        WHERE ${compile(agg.trendServableJoinedPred())}`,
    );
    expect(after).toContain("aaaaaaaa-0000-4000-8000-000000000001"); // servable
    for (const excluded of ["…2", "…3", "…4"].map((_, i) =>
      `aaaaaaaa-0000-4000-8000-00000000000${i + 2}`,
    )) {
      expect(after, excluded).not.toContain(excluded);
    }
  });

  it("앵커 없는 답변·cycle_id NULL 의 처리가 기존과 같다", async () => {
    const after = await jobsOf(
      `SELECT a.job_id FROM scope_answers a
         JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
         ${compile(agg.trendServableJoinSql())}
        WHERE ${compile(agg.trendServableJoinedPred())}`,
    );
    // cycle_id NULL + standard → 빠진다. project 표면 → 통과.
    expect(after).not.toContain("aaaaaaaa-0000-4000-8000-000000000005");
    expect(after).toContain("aaaaaaaa-0000-4000-8000-000000000006");
    // 앵커 행이 없는 답변은 INNER 조인에서 빠진다(semi-join 판본도 같다).
    expect(after).not.toContain("aaaaaaaa-0000-4000-8000-000000000007");
  });

  it("조인 판본은 행을 늘리지 않는다 (cycle_id 가 PK 라 1:1)", async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM scope_answers a
         JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
         ${compile(agg.trendServableJoinSql())}`,
    );
    const { rows: base } = await db.query(
      `SELECT count(*)::int AS n FROM scope_answers a
         JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id`,
    );
    expect(Number(rows[0]?.n)).toBe(Number(base[0]?.n));
  });
});
