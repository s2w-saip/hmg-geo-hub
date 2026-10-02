// `_answer_set` 의 **투영과 소비를 진짜 Postgres(pglite)에서 실행**한다 (2026-09-20).
//
// 고치는 결함(프리뷰 차단): 축을 켠 글로벌 `/ko/dashboard` 가 회차를 포함한 주 단위
// 창에서 통째로 에러 바운더리로 떨어졌다. 서버 원인은 `column "round_date" does not
// exist`(42703) 다. 투영(`kpiTabTrendCols`)은 `wk.applied === "anchor"` 로, 소비
// (`kpiTabCellSnapshot`)는 `anchorAxisKnownEnabled()` 로 축을 각자 판단했는데,
// 한 호출부가 `wk` 를 안 넘겨 **두 조건이 갈렸다**.
//
// 왜 기존 테스트가 못 잡았나 — 셋 다 원리적으로 못 잡는다:
//   ① **문장 텍스트 스냅샷**(`period-axis.snapshot.test.ts` 78건,
//      `scope-aggregates.anchor-axis.test.ts`)은 "이 글자가 나간다"를 고정할 뿐,
//      그 글자가 가리키는 컬럼이 TEMP 표에 있는지는 **실행해야만** 안다.
//   ② 소비 문장은 `round_date` 를 **bare**(별칭 없이) 읽는다 — TEMP 표 위에서 도니까.
//      그래서 `ca.round_date` 를 찾는 소스 대조·정규식 가드에 걸리지 않았다.
//   ③ 그 호출부(`aggregateFirstPositionFromMirror`)는 단위 테스트가 DB 를 모킹하므로
//      `CREATE TEMP TABLE` 이 실제로 실행된 적이 없었다.
//
// 그래서 여기서는 텍스트를 보지 않고 **돌린다**. 이 파일이 잡는 뮤테이션:
//   · 투영에서 `round_date`/`measured_at_orig` 가 빠진다 → 소비가 42703.
//   · 투영은 축 on 인데 조인(`ca`)이 안 나간다 → `ca.*` 가 42P01/42703.
//   · 축 off 인데 소비가 앵커 키를 읽는다 → 같은 형태로 42703.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  resetAnchorAxisForTests,
  setAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import { newDb, type PgliteDb } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";

// 이 파일은 pglite 로 직접 문장을 돌린다 — 리포지토리의 드라이버는 타지 않는다.
// (프로브가 조용히 도는 것만 막으면 되므로 빈 결과를 주는 더미로 충분하다.)
const execute = vi.fn(async () => [] as unknown as never);
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const dialect = new PgDialect();

let db: PgliteDb;
let T: typeof import("./scope-aggregates").__testables;

/** 한 문장을 컴파일해 바인드 파라미터까지 그대로 실행한다. */
async function run(q: SQL): Promise<{ rows: unknown[] }> {
  const { sql: text, params } = dialect.sqlToQuery(q);
  return db.query(text, params as unknown[]);
}

/** `withAnswerSet` 이 만드는 TEMP 표를 **같은 형태**로 만든다(2041 행의 select 조립). */
async function makeAnswerSet(cols: SQL, join: SQL): Promise<void> {
  await db.exec(`DROP TABLE IF EXISTS _answer_set`);
  await run(sql`CREATE TEMP TABLE _answer_set AS SELECT ${cols} FROM scope_answers a${join} WHERE true`);
}

/** 소비 문장 — 프리뷰에서 죽던 커버리지 집계가 이 모양이다. */
const coverage = (): SQL => sql`
  WITH ans AS (${T.kpiTabCellSnapshot()})
  SELECT bucket,
         count(*)::int AS answers,
         count(DISTINCT date_trunc('day', measured_at))::int AS measured_days
    FROM ans GROUP BY bucket ORDER BY bucket`;

beforeAll(async () => {
  db = await newDb({ withV78: true });
  // 앵커 행이 달린 답변 2건(같은 셀·같은 회차 = dedup 이 실제로 한 건을 지운다).
  await db.exec(`
    INSERT INTO scope_answers (job_id, run_id, status, measured_at, target, region, prompt_id)
    VALUES ('11111111-1111-4111-8111-111111111111'::uuid, '22222222-2222-4222-8222-222222222222'::uuid,
            'completed', '2026-09-11T02:00:00Z', 'chatgpt', 'KR', '33333333-3333-4333-8333-333333333333'::uuid),
           ('11111111-1111-4111-8111-111111111112'::uuid, '22222222-2222-4222-8222-222222222222'::uuid,
            'completed', '2026-09-12T02:00:00Z', 'chatgpt', 'KR', '33333333-3333-4333-8333-333333333333'::uuid)
  `);
  await db.exec(`
    INSERT INTO scope_answer_cycle_anchors
      (job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week, anchor_month,
       round_date, measured_at_orig, is_default_engine, source)
    VALUES ('11111111-1111-4111-8111-111111111111'::uuid, '22222222-2222-4222-8222-222222222222'::uuid,
            '44444444-4444-4444-8444-444444444444'::uuid, 'standard',
            '2026-09-11T02:00:00Z', DATE '2026-09-11', DATE '2026-09-07', DATE '2026-09-01',
            DATE '2026-09-11', '2026-09-11T02:00:00Z', true, 'ledger'),
           ('11111111-1111-4111-8111-111111111112'::uuid, '22222222-2222-4222-8222-222222222222'::uuid,
            '44444444-4444-4444-8444-444444444444'::uuid, 'standard',
            '2026-09-11T02:00:00Z', DATE '2026-09-11', DATE '2026-09-07', DATE '2026-09-01',
            DATE '2026-09-11', '2026-09-12T02:00:00Z', true, 'ledger')
  `);
  T = (await import("./scope-aggregates")).__testables;
}, 180_000);

afterAll(async () => {
  resetAnchorAxisForTests();
  await db?.close();
});

beforeEach(() => execute.mockClear());

describe("축 on — 투영과 소비가 실제로 맞물린다", () => {
  beforeEach(() => setAnchorAxisForTests(true));

  it("투영이 ca.* 를 읽고 조인도 같이 나간다", async () => {
    const axis = await T.kpiTabTrendAxis("week", "measured");
    expect(axis.applied).toBe("anchor");
    expect(dialect.sqlToQuery(axis.cols).sql).toContain("ca.");
    expect(dialect.sqlToQuery(sql`x${axis.join}`).sql).toContain(
      "scope_answer_cycle_anchors",
    );
  });

  it.each(["week", "day"] as const)(
    "%s 버킷: 커버리지 문장이 42703 없이 돈다 (프리뷰에서 죽던 그 문장)",
    async (unit) => {
      const axis = await T.kpiTabTrendAxis(unit, "measured");
      await makeAnswerSet(axis.cols, axis.join);
      const { rows } = await run(coverage());
      // 같은 회차·같은 셀이므로 대표 1건만 남는다(회차 단위 dedup).
      expect(rows).toHaveLength(1);
      expect((rows[0] as { answers: number }).answers).toBe(1);
    },
  );

  it("동점은 measured_at_orig 최신이 이긴다 — 투영에 그 컬럼이 실렸다는 증거", async () => {
    const axis = await T.kpiTabTrendAxis("week", "measured");
    await makeAnswerSet(axis.cols, axis.join);
    const { rows } = await run(sql`SELECT job_id FROM (${T.kpiTabCellSnapshot()}) s`);
    expect((rows[0] as { job_id: string }).job_id).toBe(
      "11111111-1111-4111-8111-111111111112",
    );
  });

  it("TEMP 표가 소비 문장이 요구하는 컬럼을 전부 들고 있다", async () => {
    const axis = await T.kpiTabTrendAxis("week", "measured");
    await makeAnswerSet(axis.cols, axis.join);
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '_answer_set'`,
    );
    const have = new Set((rows as Array<{ column_name: string }>).map((r) => r.column_name));
    for (const need of [
      "job_id",
      "prompt_id",
      "target",
      "region",
      "measured_at",
      "bucket",
      "round_date",
      "measured_at_orig",
    ]) {
      expect(have.has(need), `TEMP 표에 ${need} 가 없다`).toBe(true);
    }
  });
});

describe("축 off — 종전 투영·소비가 그대로 돈다", () => {
  beforeEach(() => setAnchorAxisForTests(false));

  it("투영에 ca. 도 round_date 도 없고 커버리지 문장이 돈다", async () => {
    const axis = await T.kpiTabTrendAxis("week", "measured");
    expect(axis.applied).toBe("measured");
    const cols = dialect.sqlToQuery(axis.cols).sql;
    expect(cols).not.toContain("ca.");
    expect(cols).not.toContain("round_date");
    await makeAnswerSet(axis.cols, axis.join);
    expect(dialect.sqlToQuery(T.kpiTabCellSnapshot()).sql).not.toContain("round_date");
    const { rows } = await run(coverage());
    // 측정 축에서는 두 답변이 서로 다른 주에 떨어지지 않는다(9/11·9/12 = 같은 주)
    // — 셀 dedup 이 최신 1건만 남긴다.
    expect(rows).toHaveLength(1);
  });
});
