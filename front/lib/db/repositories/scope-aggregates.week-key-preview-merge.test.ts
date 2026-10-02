/**
 * 프리뷰 병합 규칙 (2026-09-28) — main #300(글로벌 회차 주 = 앵커의 KST 주)을 프리뷰의
 * 주 격자 체계(#272 `trendWeekKey` 원장 조인 · 0077 앵커 축) 위에 얹는 규칙을 고정한다.
 *
 *   ① 우선순위는 그대로: **앵커 축 > 원장 cycle 조인 > 측정 폴백**.
 *   ② 측정 폴백(원장 미귀속 run · 원장 미적용 · `measured` 요청)은 **표면별**
 *      `mirrorWeekKey` 다 — 글로벌은 KST 회차 주, 웹사이트·프로젝트는 종전 식 문자 그대로.
 *   ③ dedup(DISTINCT ON)의 주 자리는 항상 버킷 키와 같은 식이다.
 *
 * `scope-aggregates.global-week-kst.test.ts`(main #300 원본)는 원장 미적용 경로만 본다
 * (그 파일은 원장 프로브를 mock 하지 않는다). 이 파일은 원장이 **있는** 프리뷰 경로와
 * 앵커 축 경로를 본다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

const ledgerAvailable = vi.fn<[], Promise<boolean>>();
vi.mock("@/lib/db/repositories/summary-settings", () => ({
  summaryLedgerAvailable: () => ledgerAvailable(),
}));

const dialect = new PgDialect();
const captured: string[] = [];
const execute = vi.fn(async (q: SQL) => {
  try {
    captured.push(dialect.sqlToQuery(q).sql);
  } catch {
    /* raw SET 등 */
  }
  return [] as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const PIDS = ["11111111-1111-1111-1111-111111111111"];
const KST_KEY =
  "COALESCE((date_trunc('week', (_wk._wk_anchor AT TIME ZONE 'Asia/Seoul')))::date::timestamptz, date_trunc('week', a.measured_at))";
const CYCLE_KST_KEY = `COALESCE(_cw.cycle_week, (${KST_KEY})::date)`;
const CYCLE_UTC_KEY = "COALESCE(_cw.cycle_week, (date_trunc('week', a.measured_at))::date)";
const CW_TAIL = ") _cw ON _cw.run_id = a.run_id";
const WK_JOIN =
  " LEFT JOIN (SELECT run_id AS _wk_run_id, cycle_anchor_at AS _wk_anchor FROM scope_runs) _wk ON _wk._wk_run_id = a.run_id";

const q = (s: SQL) => dialect.sqlToQuery(s).sql;

beforeAll(async () => {
  ledgerAvailable.mockResolvedValue(true);
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
  ledgerAvailable.mockResolvedValue(true);
});

afterEach(async () => {
  const st = await import("@/lib/period/anchor-axis-state");
  st.setAnchorAxisForTests(false);
});

const run = async (fn: () => Promise<unknown>): Promise<string[]> => {
  captured.length = 0;
  try {
    await fn();
  } catch {
    /* 빈 mock 결과로 후처리가 실패해도 SQL 은 이미 캡처됐다 */
  }
  return [...captured];
};

describe("trendWeekKey — 측정 폴백이 표면별 격자다 (규칙 ②)", () => {
  it("cycle + 글로벌: 원장 주, 미귀속은 **KST 회차 주**로 폴백 · 조인 둘(_cw 다음 _wk)", async () => {
    const m = await import("./scope-aggregates");
    const wk = await m.trendWeekKey("cycle", "anchorKst");
    expect(wk.applied).toBe("cycle");
    expect(wk.grid).toBe("anchorKst");
    expect(q(wk.key)).toBe(CYCLE_KST_KEY);
    const join = q(sql`FROM scope_answers a${wk.join}`);
    expect(join.indexOf(CW_TAIL)).toBeGreaterThan(-1);
    expect(join.endsWith(WK_JOIN)).toBe(true);
    // DISTINCT ON 과 ORDER BY 가 문자적으로 같아야 하므로 키 안에 바인드가 없어야 한다.
    expect(dialect.sqlToQuery(wk.key).params).toEqual([]);
  });

  it("cycle + 웹사이트·프로젝트: 프리뷰 #272 식 문자 그대로(조인 하나)", async () => {
    const m = await import("./scope-aggregates");
    const wk = await m.trendWeekKey("cycle", "measured");
    expect(q(wk.key)).toBe(CYCLE_UTC_KEY);
    expect(q(wk.join)).not.toContain("_wk");
    // 인자 생략 = measured (종전 호출부 무변경).
    const dflt = await m.trendWeekKey("cycle");
    expect(q(dflt.key)).toBe(CYCLE_UTC_KEY);
    expect(q(dflt.join)).toBe(q(wk.join));
  });

  it("measured 요청 + 글로벌: `mirrorWeekKey('anchorKst')` 와 같은 조각", async () => {
    const m = await import("./scope-aggregates");
    const wk = await m.trendWeekKey("measured", "anchorKst");
    const mk = m.mirrorWeekKey("anchorKst");
    expect(wk.applied).toBe("measured");
    expect(q(wk.key)).toBe(q(mk.key));
    expect(q(wk.join)).toBe(q(mk.join));
  });

  it("원장 미적용이면 cycle 요청도 표면별 폴백(글로벌 KST · 그 외 종전)", async () => {
    ledgerAvailable.mockResolvedValue(false);
    const m = await import("./scope-aggregates");
    const g = await m.trendWeekKey("cycle", "anchorKst");
    expect(g.applied).toBe("measured");
    expect(q(g.key)).toBe(KST_KEY);
    expect(q(g.join)).toBe(WK_JOIN);
    const p = await m.trendWeekKey("cycle", "measured");
    expect(q(p.key)).toBe("date_trunc('week', a.measured_at)");
    expect(q(p.join)).toBe("");
  });

  it("앵커 축이 켜져 있으면 표면·원천과 무관하게 앵커 축이 이긴다 (규칙 ①)", async () => {
    const st = await import("@/lib/period/anchor-axis-state");
    st.setAnchorAxisForTests(true);
    const m = await import("./scope-aggregates");
    for (const grid of ["anchorKst", "measured"] as const) {
      for (const src of ["cycle", "measured"] as const) {
        const wk = await m.trendWeekKey(src, grid);
        expect(wk.applied).toBe("anchor");
        expect(q(wk.key)).not.toMatch(/_cw|_wk|Asia\/Seoul/);
        expect(q(wk.join)).not.toMatch(/_cw|_wk/);
      }
    }
  });
});

describe("호출부 — dedup 주 자리 = 버킷 키 (규칙 ③)", () => {
  it("언급 주간 롤업(cycle · 글로벌): 같은 키가 DISTINCT ON · 선택 · ORDER BY 세 자리", async () => {
    const m = await import("./scope-aggregates");
    const wk = await m.trendWeekKey("cycle", m.mirrorWeekGridFor(undefined));
    const s = q(
      m.mentionBrandDayCountsQuery({
        filters: {},
        wk,
        trendFloor: sql`true`,
        answerWhere: sql`true`,
        notHidden: sql`true`,
        seriesClause: sql``,
      }),
    );
    expect(s.split(CYCLE_KST_KEY).length - 1).toBe(3);
    expect(s).toContain(`DISTINCT ON (a.prompt_id, a.target, a.region, ${CYCLE_KST_KEY})`);
    expect(s).toContain(`ORDER BY a.prompt_id, a.target, a.region, ${CYCLE_KST_KEY}`);
    expect(s.indexOf(WK_JOIN)).toBeLessThan(s.indexOf("WHERE a.measured_at IS NOT NULL"));
  });

  it("KPI 탭 브랜드 추이(cycle · 글로벌 week): 버킷 = 원장 주 + KST 폴백, 조인 둘", async () => {
    const m = await import("./scope-aggregates");
    const stmts = await run(() =>
      m.aggregateBrandTrendFromMirror({}, undefined, { weekSource: "cycle" }),
    );
    const trend = stmts.filter((s) => /CREATE TEMP TABLE _answer_set/.test(s) && /AS bucket/.test(s));
    expect(trend).toHaveLength(1);
    expect(trend[0]).toContain(`${CYCLE_KST_KEY} AS bucket`);
    expect(trend[0]).toContain(CW_TAIL);
    expect(trend[0]).toContain(WK_JOIN.trim());
    // 축 경계도 KST 절단(규칙 4 — 버킷과 같은 격자).
    const b = stmts.filter((s) => /AS win_start/.test(s));
    expect(b).toHaveLength(1);
    expect(b[0]).toContain("AT TIME ZONE 'Asia/Seoul'");
  });

  it("KPI 탭 브랜드 추이(day · 글로벌): 월요일 격자를 얹지 않는다 — 종전 측정일", async () => {
    const m = await import("./scope-aggregates");
    const stmts = await run(() =>
      m.aggregateBrandTrendFromMirror({}, undefined, { unit: "day", weekSource: "cycle" }),
    );
    const trend = stmts.filter((s) => /CREATE TEMP TABLE _answer_set/.test(s) && /AS bucket/.test(s));
    expect(trend).toHaveLength(1);
    expect(trend[0]).toContain("date_trunc($1, a.measured_at) AS bucket");
    expect(trend[0]).not.toMatch(/_wk|_cw/);
  });

  it("KPI 탭 우선 노출도 추이(프로젝트): 종전 문장 그대로", async () => {
    const m = await import("./scope-aggregates");
    const stmts = await run(() => m.aggregateFirstPositionFromMirror({}, PIDS, {}));
    const trend = stmts.filter((s) => /CREATE TEMP TABLE _answer_set/.test(s) && /AS bucket/.test(s));
    expect(trend).toHaveLength(1);
    expect(trend[0]).toContain("date_trunc($1, a.measured_at) AS bucket");
    expect(trend[0]).not.toMatch(/_wk|Asia\/Seoul/);
  });
});

// ── 값 — 원장 주가 있으면 그것, 없으면 KST 회차 주 (PGlite 실행) ────────────────
describe("값 — PGlite 에서 조각 실행 (cycle · 글로벌)", () => {
  let pg: PGlite;
  const RUN_LEDGER = "a0000000-0000-4000-8000-000000000001"; // 원장 귀속: cycle_week 2026-09-14
  const RUN_FREE = "a0000000-0000-4000-8000-000000000002"; // 원장 미귀속, 앵커 09-20T15:50Z(KST 월)
  const RUN_NULL = "a0000000-0000-4000-8000-000000000003"; // 원장 미귀속, 앵커 NULL

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      SET TimeZone = 'UTC';
      CREATE TABLE scope_runs (run_id uuid PRIMARY KEY, cycle_anchor_at timestamptz);
      CREATE TABLE scope_answers (job_id text PRIMARY KEY, run_id uuid, measured_at timestamptz);
      CREATE TABLE summary_cycles (cycle_id uuid PRIMARY KEY, cycle_week date);
      CREATE TABLE summary_cycle_runs (cycle_id uuid, run_id uuid UNIQUE);
      INSERT INTO scope_runs VALUES
        ('${RUN_LEDGER}', '2026-09-13T15:48:00Z'),
        ('${RUN_FREE}', '2026-09-20T15:50:00Z'),
        ('${RUN_NULL}', NULL);
      INSERT INTO scope_answers VALUES
        ('j-ledger', '${RUN_LEDGER}', '2026-09-13T16:30:00Z'),
        ('j-free', '${RUN_FREE}', '2026-09-20T16:10:00Z'),
        ('j-null', '${RUN_NULL}', '2026-09-13T16:30:00Z');
      INSERT INTO summary_cycles VALUES ('c0000000-0000-4000-8000-000000000001', '2026-09-14');
      INSERT INTO summary_cycle_runs VALUES ('c0000000-0000-4000-8000-000000000001', '${RUN_LEDGER}');
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("원장 → 2026-09-14 · 미귀속 KST → 2026-09-21 · 앵커 NULL → 종전 UTC 주 2026-09-07, 행 불변", async () => {
    const m = await import("./scope-aggregates");
    const wk = await m.trendWeekKey("cycle", "anchorKst");
    const built = dialect.sqlToQuery(sql`
      SELECT a.job_id, to_char(${wk.key}, 'YYYY-MM-DD') AS wk
      FROM scope_answers a${wk.join} ORDER BY a.job_id`);
    const out = (await pg.query<{ job_id: string; wk: string }>(built.sql, built.params as unknown[])).rows;
    expect(Object.fromEntries(out.map((r) => [r.job_id, r.wk]))).toEqual({
      "j-free": "2026-09-21", // UTC 폴백이었다면 2026-09-14 (9/14 회차와 충돌)
      "j-ledger": "2026-09-14",
      "j-null": "2026-09-07",
    });
  });

  it("세션 TZ 가 KST 여도 같은 날짜", async () => {
    const m = await import("./scope-aggregates");
    const wk = await m.trendWeekKey("cycle", "anchorKst");
    await pg.exec(`SET TimeZone = 'Asia/Seoul'`);
    try {
      const built = dialect.sqlToQuery(sql`
        SELECT a.job_id, to_char(${wk.key}, 'YYYY-MM-DD') AS wk
        FROM scope_answers a${wk.join} WHERE a.job_id IN ('j-ledger', 'j-free') ORDER BY a.job_id`);
      const out = (await pg.query<{ job_id: string; wk: string }>(built.sql, built.params as unknown[])).rows;
      expect(out.map((r) => r.wk)).toEqual(["2026-09-21", "2026-09-14"]);
    } finally {
      await pg.exec(`SET TimeZone = 'UTC'`);
    }
  });
});
