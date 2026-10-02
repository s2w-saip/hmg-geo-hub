// 회차 지문(`readCycleFingerprints`)을 **진짜 Postgres(pglite)** 에서 돌린다 (2026-09-27).
//
// 무엇을 증명하나 — 지문은 "앵커 축 셀의 값을 바꾸는 게이트 입력"이 바뀔 때 **반드시**
// 바뀌고, 게이트가 안 읽는 변화(새 회차 열림·status 전이·세대 교체·진행률)에는 **바뀌지
// 않아야** 한다(hmg-geo PR #297 검증 C4: 요약 생성 1시간 동안 30초마다 바뀌어 적중률 0).
// 기간 비교용 `ledger` 지문은 status·세대까지 본다.
//
// `getDb()` 를 pglite 로 **그대로 흘려보낸다**(PgDialect 로 $n 문장을 만든다) — 문장이
// 실제로 파싱·해석되는지(42703·42P01·42883)와 트랜잭션 상한 문장까지 이 파일이 본다.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { newDb, type PgliteDb } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";

// ⚠️ **진짜 drizzle 세션**(`drizzle-orm/pglite`)을 경유한다(hmg-geo PR #297 재검증 K4).
// drizzle-orm 0.45 는 쿼리 오류를 `DrizzleQueryError` 로 감싸 SQLSTATE 를 `e.cause.code` 에
// 둔다. 종전 테스트는 `execute` 를 손으로 흉내 내 원래 오류를 그대로 던졌고, 그래서
// `e.code` 만 읽던 42P01 기억 해제가 프로덕션에서 동작하지 않는 것을 못 잡았다.
const dialect = new PgDialect();
let current: PgliteDb | null = null;
let db: ReturnType<typeof drizzle> | null = null;
const executed: string[] = [];
/** 다음 트랜잭션 한 번을 대신할 함수(실패 주입용). */
let nextTx: ((fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>) | null = null;
// 결과 **모양**만 postgres-js(프로덕션 드라이버, 행 배열)와 맞춘다 — drizzle pglite 는
// `{ rows }` 를 돌려준다. 오류는 drizzle 이 던진 그대로(감싼 채) 올라간다.
type Execable = { execute: (q: SQL) => Promise<unknown> };
const asRows = (r: unknown) => (r as { rows?: unknown[] })?.rows ?? r;
const rowsExec = (x: Execable) => ({ execute: async (q: SQL) => asRows(await x.execute(q)) });
const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  if (nextTx) {
    const f = nextTx;
    nextTx = null;
    return f(fn);
  }
  return db!.transaction((tx) => fn(rowsExec(tx as unknown as Execable)));
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: async (q: SQL) => asRows(await db!.execute(q)),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => transaction(fn),
  }),
}));

async function open(opts: { withV78: boolean; fixtures?: string }): Promise<void> {
  current = await newDb(opts);
  db = drizzle(current as unknown as PGlite, {
    logger: { logQuery: (q: string) => void executed.push(q) },
  });
}
async function close(): Promise<void> {
  await current?.close();
  current = null;
  db = null;
}
/** 프로브용 직접 실행(행 배열). */
async function rowsOf(q: SQL): Promise<Array<Record<string, unknown>>> {
  const c = dialect.sqlToQuery(q);
  return (await current!.query(c.sql, c.params as unknown[])).rows as Array<Record<string, unknown>>;
}

const {
  readCycleFingerprints,
  resetCycleFingerprintCapsForTests,
  cycleFingerprintCapsCachedForTests,
  cycleFingerprintSql,
  CYCLE_FINGERPRINT_CAPS_SQL,
} = await import("./cycle-fingerprint");

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const C1 = "aaaaaaaa-0000-0000-0000-000000000001";
const C2 = "aaaaaaaa-0000-0000-0000-000000000002";
const C3 = "aaaaaaaa-0000-0000-0000-000000000003";

// 0070·0071 은 트랜잭션 가드(lock_timeout 단언)가 있어 pglite 에 그대로 못 태운다.
// 두 마이그레이션이 만드는 컬럼만 같은 타입으로 붙인다(0070: text·timestamptz, 0071: text).
const HIDDEN_COLS = `
  ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS hidden_reason text;
  ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
  ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS hidden_scope text;`;

/** 9/18 회차: 원장 발행·노출 완료 + state 행(노출일 지남). */
const SEED = `
  INSERT INTO summary_cycles (cycle_id, surface, project_id, cycle_anchor_at, cycle_week,
      anchor_source, status, fleet_visible, active_generation_id, view_anchor_at,
      completion_ratio, completed_units)
  VALUES ('${C1}', 'website', '${P1}', now() - interval '9 days', current_date - 9,
      'scope', 'published', true, gen_random_uuid(), now() - interval '8 days', 1.0, 100);
  INSERT INTO scope_cycle_anchor_state (cycle_key, project_id, surface, source,
      anchor_at, anchor_date, round_date, ledger_view_date)
  VALUES ('${P1}|1', '${P1}', 'website', 'ledger',
      now() - interval '9 days', current_date - 9, current_date - 9, current_date - 8);`;

const fp = () => readCycleFingerprints();

describe("회차 지문 — pglite 실행(drizzle 세션 경유)", () => {
  beforeAll(async () => {
    await open({ withV78: true, fixtures: HIDDEN_COLS + SEED });
  });
  afterAll(close);
  beforeEach(() => {
    resetCycleFingerprintCapsForTests();
    executed.length = 0;
  });

  it("가용성 프로브가 0077·0078·0070·0071 을 전부 참으로 본다", async () => {
    expect((await rowsOf(CYCLE_FINGERPRINT_CAPS_SQL))[0]).toEqual({
      state_table: true, view_fns: true, ledger: true, hidden_cols: true, hidden_scope: true,
    });
  });

  it("두 지문 모두 md5 32자이고, 아무것도 안 바뀌면 같다", async () => {
    const a = await fp();
    expect(a.gate).toMatch(/^[0-9a-f]{32}$/);
    expect(a.ledger).toMatch(/^[0-9a-f]{32}$/);
    expect(a.gate).not.toBe(a.ledger);
    expect(await fp()).toEqual(a);
  });

  it("읽기 전용 트랜잭션 + 문장·락 상한 안에서 읽는다(검증 C3)", async () => {
    await fp();
    const i = executed.indexOf("SET TRANSACTION READ ONLY");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(executed[i + 1]).toBe("SET LOCAL statement_timeout = '2000ms'");
    expect(executed[i + 2]).toBe("SET LOCAL lock_timeout = '1000ms'");
  });

  it("가용성이 전부 참이면 기억된다 — 두 번째 판정은 지문 문장만", async () => {
    await fp();
    const first = executed.filter((s) => s.startsWith("SELECT")).length;
    executed.length = 0;
    await fp();
    expect(first).toBe(2); // 프로브 + 지문
    expect(executed.filter((s) => s.startsWith("SELECT"))).toHaveLength(1);
  });

  // ── gate 가 바뀌어야 하는 것 ─────────────────────────────────────────────

  it("[9/27 사고 재현] 노출일이 지난 새 회차의 state 행이 생기면 gate 가 바뀐다", async () => {
    const before = (await fp()).gate;
    await current!.exec(`
      INSERT INTO scope_cycle_anchor_state (cycle_key, project_id, surface, source,
          anchor_at, anchor_date, round_date, ledger_view_date)
      VALUES ('${P1}|2', '${P1}', 'website', 'registry',
          now() - interval '2 days', current_date - 2, current_date - 2, current_date - 1);`);
    expect((await fp()).gate).not.toBe(before);
  });

  it("회차가 서빙 가능해지는 순간(원장 노출 시각을 시계가 넘음) gate 가 바뀐다", async () => {
    await current!.exec(`
      INSERT INTO summary_cycles (cycle_id, surface, project_id, cycle_anchor_at, cycle_week,
          anchor_source, status, fleet_visible, active_generation_id, view_anchor_at)
      VALUES ('${C2}', 'website', '${P1}', now() - interval '2 days', current_date - 2,
          'scope', 'published', true, gen_random_uuid(), now() + interval '1 hour');`);
    const future = (await fp()).gate;
    // now() 를 움직일 수 없으니 노출 시각을 미래→과거로 옮겨 같은 판정 전환을 만든다.
    await current!.exec(
      `UPDATE summary_cycles SET view_anchor_at = now() - interval '1 hour' WHERE cycle_id = '${C2}'`,
    );
    expect((await fp()).gate).not.toBe(future);
  });

  it("앵커 노출일(state)이 오늘을 넘으면 gate 가 바뀐다", async () => {
    await current!.exec(
      `UPDATE scope_cycle_anchor_state SET ledger_view_date = current_date + 3 WHERE cycle_key = '${P1}|2'`,
    );
    const closed = (await fp()).gate;
    await current!.exec(
      `UPDATE scope_cycle_anchor_state SET ledger_view_date = current_date - 1 WHERE cycle_key = '${P1}|2'`,
    );
    expect((await fp()).gate).not.toBe(closed);
  });

  it("숨김·범위·fleet_visible 이 바뀌면 gate 가 바뀐다", async () => {
    const steps = [
      `UPDATE summary_cycles SET hidden_reason = 'collection_error', hidden_at = now() WHERE cycle_id = '${C2}'`,
      `UPDATE summary_cycles SET hidden_scope = 'citations' WHERE cycle_id = '${C2}'`,
      `UPDATE summary_cycles SET hidden_reason = NULL, hidden_scope = NULL WHERE cycle_id = '${C2}'`,
      `UPDATE summary_cycles SET fleet_visible = false WHERE cycle_id = '${C2}'`,
    ];
    const seen: string[] = [(await fp()).gate];
    for (const s of steps) {
      await current!.exec(s);
      const next = (await fp()).gate;
      expect(next, s).not.toBe(seen[seen.length - 1]);
      seen.push(next);
    }
    await current!.exec(`UPDATE summary_cycles SET fleet_visible = true WHERE cycle_id = '${C2}'`);
  });

  // 재검증 V4 — 생성기(operator) 귀속은 싱크 무효화를 안 거친다. 서빙 중 회차에 run 이
  // 늦게 붙거나 빠지면(= 앵커 행 cycle_id 가 옮겨 가면) 지문이 바뀌어야 한다.
  it("[V4] 서빙 중 회차의 run 멤버십이 바뀌면(늦은 귀속·이동) gate 가 바뀐다", async () => {
    const R1 = "bbbbbbbb-0000-0000-0000-000000000001";
    const R2 = "bbbbbbbb-0000-0000-0000-000000000002";
    await current!.exec(`INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by)
                         VALUES ('${C1}', '${R1}', 'operator')`);
    const one = (await fp()).gate;
    await current!.exec(`INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by)
                         VALUES ('${C1}', '${R2}', 'operator')`);
    const two = (await fp()).gate;
    expect(two).not.toBe(one);
    // 같은 수로 **다른 run** 으로 바뀌어도 잡는다(ON CONFLICT 가 attributed_at 을 안 고친다).
    await current!.exec(`UPDATE summary_cycle_runs SET cycle_id = '${C2}' WHERE run_id = '${R2}'`);
    await current!.exec(`INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by)
                         VALUES ('${C1}', 'bbbbbbbb-0000-0000-0000-000000000003', 'operator')`);
    expect((await fp()).gate).not.toBe(two);
  });

  // 재검증 V1 — global 세대별 dim 조인(`trendDimJoinSql`·`trendDimScopedJobIds`).
  it("[V1] 서빙 중 global 회차의 세대 교체는 gate 를 바꾼다", async () => {
    const G = "aaaaaaaa-0000-0000-0000-00000000000a";
    await current!.exec(`
      INSERT INTO summary_cycles (cycle_id, surface, project_id, cycle_anchor_at, cycle_week,
          anchor_source, status, fleet_visible, active_generation_id, view_anchor_at)
      VALUES ('${G}', 'global', '${P2}', now() - interval '3 days', current_date - 3,
          'scope', 'published', true, gen_random_uuid(), now() - interval '1 day');`);
    const before = (await fp()).gate;
    await current!.exec(
      `UPDATE summary_cycles SET active_generation_id = gen_random_uuid() WHERE cycle_id = '${G}'`,
    );
    expect((await fp()).gate).not.toBe(before);
  });

  // ── gate 가 바뀌면 안 되는 것 (요약 생성·관제 틱 동안 콜드 폭주 방지) ──────

  it("새 회차가 열리기만 하면(서빙 전) gate 는 그대로, ledger 도 그대로다", async () => {
    const before = await fp();
    await current!.exec(`
      INSERT INTO summary_cycles (cycle_id, surface, project_id, cycle_anchor_at, cycle_week,
          anchor_source, status, fleet_visible)
      VALUES ('${C3}', 'website', '${P2}', now(), current_date, 'scope', 'open', true);`);
    expect(await fp()).toEqual(before);
  });

  it("서빙 전 회차의 run 귀속(드레인)은 gate 를 안 바꾼다", async () => {
    const before = await fp();
    await current!.exec(`INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by)
                         VALUES ('${C3}', 'cccccccc-0000-0000-0000-000000000001', 'scope')`);
    expect(await fp()).toEqual(before);
  });

  it("status 전이(open→closed→generating)와 진행률은 gate 를 안 바꾼다 — ledger 는 종결 전이를 본다", async () => {
    const before = await fp();
    await current!.exec(
      `UPDATE summary_cycles SET completion_ratio = 0.5, completed_units = 50 WHERE cycle_id = '${C3}'`,
    );
    expect(await fp()).toEqual(before);
    await current!.exec(`UPDATE summary_cycles SET status = 'closed' WHERE cycle_id = '${C3}'`);
    const closed = await fp();
    expect(closed.gate).toBe(before.gate);
    expect(closed.ledger).not.toBe(before.ledger);
    await current!.exec(`UPDATE summary_cycles SET status = 'generating' WHERE cycle_id = '${C3}'`);
    expect((await fp()).gate).toBe(before.gate);
  });

  it("서빙 중인 회차의 status 전이(published→stale→published)도 gate 를 안 바꾼다", async () => {
    // 서빙 게이트는 status 를 안 읽는다(anchorLedgerServableSql). 요약 재생성이 서빙 중
    // 회차를 stale 로 내렸다 올리는 동안 전 셀이 콜드가 되면 안 된다(검증 C4).
    const before = await fp();
    await current!.exec(`UPDATE summary_cycles SET status = 'stale', stale_since = now() WHERE cycle_id = '${C1}'`);
    expect((await fp()).gate).toBe(before.gate);
    await current!.exec(`UPDATE summary_cycles SET status = 'published', stale_since = NULL WHERE cycle_id = '${C1}'`);
    expect((await fp()).gate).toBe(before.gate);
  });

  it("서빙 중인 website 회차의 세대 교체는 gate 를 안 바꾸고 ledger 만 바꾼다", async () => {
    // website·project 표면에는 세대별 dim 을 조인하는 미러 리더가 없다(PR 본문의 grep 근거).
    const before = await fp();
    await current!.exec(
      `UPDATE summary_cycles SET active_generation_id = gen_random_uuid() WHERE cycle_id = '${C1}'`,
    );
    const after = await fp();
    expect(after.gate).toBe(before.gate);
    expect(after.ledger).not.toBe(before.ledger);
  });

  it("아직 노출일이 안 온 회차의 state 행은 지문에 안 들어간다", async () => {
    const before = await fp();
    await current!.exec(`
      INSERT INTO scope_cycle_anchor_state (cycle_key, project_id, surface, source,
          anchor_at, anchor_date, round_date, ledger_view_date)
      VALUES ('${P2}|9', '${P2}', 'website', 'run', now(), current_date, current_date, NULL);`);
    expect(await fp()).toEqual(before);
  });

  // ── 사라진 표 (검증 D5 · 재검증 K4) ──────────────────────────────────────

  it("[K4] 기억한 표가 사라지면 drizzle 이 감싼 오류(cause.code=42P01)로도 기억을 비우고, 다음 판정은 다시 프로브해 성공한다", async () => {
    await fp();
    expect(cycleFingerprintCapsCachedForTests()).toBe(true);
    await current!.exec(`ALTER TABLE scope_cycle_anchor_state RENAME TO scope_cycle_anchor_state_x`);
    try {
      const err = await fp().then(
        () => { throw new Error("실패해야 한다"); },
        (e: unknown) => e as { code?: unknown; cause?: { code?: unknown } },
      );
      // drizzle 0.45 는 감싼다 — 최상위 code 는 비고 원인에 SQLSTATE 가 있다(이 테스트의 전제).
      expect(err.cause?.code).toBe("42P01");
      expect(cycleFingerprintCapsCachedForTests()).toBe(false);
      await expect(fp()).resolves.toMatchObject({ gate: expect.stringMatching(/^[0-9a-f]{32}$/) });
    } finally {
      await current!.exec(`ALTER TABLE scope_cycle_anchor_state_x RENAME TO scope_cycle_anchor_state`);
    }
  });
});

// ── 재검증 v3 공백 V4b — 멤버십은 run **수**가 아니라 run **집합**이다 ────────────
// 격리된 DB 에서 같은 수·다른 run 인 두 형태를 만든다. 수만 보면 둘 다 지문이 그대로다.
describe("[V4b] 서빙 중 회차 멤버십 — 같은 수, 다른 run", () => {
  const S1 = "dddddddd-0000-0000-0000-000000000001"; // 서빙 중 website
  const S2 = "dddddddd-0000-0000-0000-000000000002"; // 서빙 중 website
  const O3 = "dddddddd-0000-0000-0000-000000000003"; // 서빙 전(open)
  const run = (n: number) => `eeeeeeee-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const cycle = (id: string, pid: string, servable: boolean) => `
    INSERT INTO summary_cycles (cycle_id, surface, project_id, cycle_anchor_at, cycle_week,
        anchor_source, status, fleet_visible, active_generation_id, view_anchor_at)
    VALUES ('${id}', 'website', '${pid}', now() - interval '3 days', current_date - 3, 'scope',
        '${servable ? "published" : "open"}', true,
        ${servable ? "gen_random_uuid()" : "NULL"},
        ${servable ? "now() - interval '1 day'" : "NULL"});`;
  const member = (c: string, r: string) =>
    `INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by) VALUES ('${c}', '${r}', 'operator');`;

  beforeEach(async () => {
    await close();
    await open({
      withV78: true,
      fixtures: HIDDEN_COLS + cycle(S1, P1, true) + cycle(S2, P2, true) + cycle(O3, "33333333-3333-3333-3333-333333333333", false)
        + member(S1, run(1)) + member(S1, run(2)) + member(S2, run(9)),
    });
    resetCycleFingerprintCapsForTests();
  });
  afterAll(close);

  it("서빙 중 회차의 run 하나를 서빙 전 회차로 옮기고 다른 run 을 넣으면(수 불변) gate 가 바뀐다", async () => {
    const before = (await fp()).gate;
    await current!.exec(`UPDATE summary_cycle_runs SET cycle_id = '${O3}' WHERE run_id = '${run(2)}'`);
    await current!.exec(member(S1, run(5)));
    expect((await fp()).gate).not.toBe(before);
  });

  it("서빙 중 두 회차가 run 을 맞바꾸면(두 회차 모두 수 불변) gate 가 바뀐다", async () => {
    const before = (await fp()).gate;
    await current!.exec(`UPDATE summary_cycle_runs SET cycle_id = '${S2}' WHERE run_id = '${run(1)}'`);
    await current!.exec(`UPDATE summary_cycle_runs SET cycle_id = '${S1}' WHERE run_id = '${run(9)}'`);
    expect((await fp()).gate).not.toBe(before);
  });
});

// ── 재검증 v3 공백 V4d — 멤버십 표가 없는 배포 ─────────────────────────────────
// `summary_cycles` 는 있는데 `summary_cycle_runs` 가 없으면 원장 성분 전체를 뺀다. 가용성에서
// 그 조건을 빼면 지문 문장이 42P01 로 죽어 매 판정이 실패(5분 버킷 콜드)가 된다.
describe("[V4d] summary_cycle_runs 가 없는 배포", () => {
  beforeAll(async () => {
    await close();
    await open({ withV78: true, fixtures: HIDDEN_COLS + "DROP TABLE summary_cycle_runs;" });
  });
  afterAll(close);

  it("원장 가용성을 거짓으로 보고, 지문은 정상으로 나온다", async () => {
    resetCycleFingerprintCapsForTests();
    expect((await rowsOf(CYCLE_FINGERPRINT_CAPS_SQL))[0]).toMatchObject({ ledger: false });
    await expect(readCycleFingerprints()).resolves.toMatchObject({
      gate: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });
});

describe("회차 지문 — 0078·원장 숨김 미적용 배포", () => {
  beforeAll(async () => {
    await open({ withV78: false });
  });
  afterAll(close);

  it("없는 표를 참조하지 않는다 — 성분이 빠진 지문이 정상으로 나온다", async () => {
    resetCycleFingerprintCapsForTests();
    expect((await rowsOf(CYCLE_FINGERPRINT_CAPS_SQL))[0]).toMatchObject({
      state_table: false, hidden_cols: false, hidden_scope: false,
    });
    await expect(readCycleFingerprints()).resolves.toMatchObject({
      gate: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("가용성이 하나라도 거짓이면 기억하지 않는다", async () => {
    resetCycleFingerprintCapsForTests();
    await readCycleFingerprints();
    expect(cycleFingerprintCapsCachedForTests()).toBe(false);
  });
});

describe("회차 지문 — 실패는 삼키지 않는다", () => {
  it("DB 오류는 throw 한다(폴백은 소비자가 정한다)", async () => {
    resetCycleFingerprintCapsForTests();
    nextTx = async () => {
      throw Object.assign(new Error("boom"), { code: "57014" });
    };
    await expect(readCycleFingerprints()).rejects.toThrow("boom");
  });

  it("지문 형식이 아니면 throw 한다", async () => {
    resetCycleFingerprintCapsForTests();
    const results: unknown[] = [
      undefined, undefined, undefined,
      [{ state_table: true, view_fns: true, ledger: true, hidden_cols: true, hidden_scope: true }],
      [{ fp_gate: "not-a-hash", fp_ledger: "x" }],
    ];
    nextTx = async (fn) => fn({ execute: async () => results.shift() });
    await expect(readCycleFingerprints()).rejects.toThrow("지문 형식");
  });
});

describe("회차 지문 문장 — 형태", () => {
  const ALL = { stateTable: true, viewFns: true, ledger: true, hiddenCols: true, hiddenScope: true };
  const text = (caps: typeof ALL) => dialect.sqlToQuery(cycleFingerprintSql(caps)).sql;

  it("앵커 행과 같은 노출일·오늘 함수로 자르고, 오늘(KST)을 해시에 싣는다(검증 G2)", () => {
    expect(text(ALL)).toContain(
      "hmg_anchor_view_date(st.surface, st.anchor_date, st.ledger_view_date) <= hmg_anchor_today()",
    );
    expect(text(ALL)).toContain("to_char(hmg_anchor_today(), 'YYYY-MM-DD')");
  });

  it("gate 의 원장 성분은 서빙 게이트 식과 같다(anchorLedgerServableSql)", () => {
    expect(text(ALL)).toContain("sc.fleet_visible AND sc.view_anchor_at IS NOT NULL");
    expect(text(ALL)).toContain("sc.view_anchor_at <= now() AND sc.active_generation_id IS NOT NULL");
  });

  it("진행률 컬럼은 어느 지문에도 싣지 않는다", () => {
    expect(text(ALL)).not.toContain("completion_ratio");
    expect(text(ALL)).not.toContain("completed_units");
  });

  it("없는 성분은 문장에서 빠진다", () => {
    const none = text({ ...ALL, stateTable: false, hiddenCols: false, hiddenScope: false });
    expect(none).not.toContain("scope_cycle_anchor_state");
    expect(none).not.toContain("hidden_reason");
    expect(none).not.toContain("hidden_scope");
    expect(text({ ...ALL, ledger: false })).not.toContain("summary_cycles");
  });

  it("가용성 플래그가 해시 입력에 실린다(적용 직후 키가 갈린다)", () => {
    const a = dialect.sqlToQuery(cycleFingerprintSql(ALL)).params;
    const b = dialect.sqlToQuery(cycleFingerprintSql({ ...ALL, hiddenScope: false })).params;
    expect(a[0]).toBe("11111");
    expect(b[0]).toBe("11110");
  });
});
