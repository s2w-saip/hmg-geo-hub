import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  MIGRATION_0078,
  MIGRATION_0079,
  type PgliteDb,
  newDb,
  statementsOf,
} from "../../../scripts/db/answer-cycle-anchors-pglite-fixture";

const SCRIPTS_DB = path.resolve(__dirname, "..", "..", "..", "scripts", "db");
const AUDIT_SQL = path.join(SCRIPTS_DB, "answer-cycle-anchors-audit.sql");
const DRYRUN_SQL = path.join(SCRIPTS_DB, "answer-cycle-anchors-dryrun.sql");

/**
 * 0078 — 조건부 회차 확장과 원장 앵커 선택 규칙을 **실행으로** 검증한다.
 *
 * 이 파일의 수용 기준은 **동치성**이다: 임의의 run 도착 순서에 대해
 * "좁은 재계산 + 조건부 확장"(0077+0078)의 최종 상태가
 * "항상 회차 전체 재계산"(0077 단독)의 최종 상태와 **같아야** 한다.
 * 그래서 같은 픽스처·같은 호출 순서를 **두 DB**(0077 단독 / 0077+0078)에 태우고
 * 테이블 전체를 대조한다 — 기대값을 손으로 적는 대신 옛 구현을 기준선으로 쓴다.
 * (규칙 자체의 손계산 리터럴은 아래 §손계산 테스트가 따로 고정한다.)
 *
 * 예외가 하나 있다: **원장 회차 둘에 걸친 회차**는 0077 이 틀렸으므로(min 이 유령
 * 회차를 고른다) 기준선과 같으면 안 된다. 그 시나리오만 손계산 기대값으로 가른다.
 *
 * 날짜는 전부 손계산이다(KST = UTC+9, 2026년 달력):
 *   · 2026-09-14 월 · 09-07 월 · 09-18 금 · 09-17 목 · 09-16 수 · 09-15 화
 */

// ── 픽스처 상수 ──────────────────────────────────────────────────────────────
const PG = "0000aaaa-0000-4000-8000-000000000001"; // 글로벌 루트 (standard)
const PW = "0000bbbb-0000-4000-8000-000000000002"; // 웹사이트 (website)
const pad = (n: number) => String(n).padStart(12, "0");
const R = (n: number) => `11110000-0000-4000-8000-${pad(n)}`;
const A = (n: number) => `33330000-0000-4000-8000-${pad(n)}`;
const C = (n: number) => `22220000-0000-4000-8000-${pad(n)}`;

/**
 * 기본 픽스처 — 글로벌(standard) 회차 하나에 run 3개, run 당 답변 2건.
 *
 * `C(9)` 는 **어느 run 에도 귀속되지 않은** 원장 회차다. 두 가지 역할만 한다:
 *   ① `p_root_project_id` 가 NULL 일 때 표면 standard 판정의 폴백 근거
 *      (원장이 그 프로젝트의 회차를 'global' 로 부르는가)
 *   ② 0053 레지스트리의 **UTC 날짜 09-06** → KST 이관 대상 회차
 *      (2026-09-06T16:00Z 의 UTC 일자 = 09-06, KST 일자 = 09-07)
 */
const BASE = `
INSERT INTO projects (name, country, scope_project_id) VALUES ('root', 'KR', '${PG}');
INSERT INTO summary_cycles
  (cycle_id, surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status, view_anchor_at)
VALUES ('${C(9)}', 'global', '${PG}', '2026-09-06T16:00:00Z', '2026-09-07', 'scope', 'closed', NULL);
INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at) VALUES
  ('${R(1)}', '${PG}', 'completed', '2026-09-14T01:00:00Z'),
  ('${R(2)}', '${PG}', 'completed', '2026-09-14T01:00:00Z'),
  ('${R(3)}', '${PG}', 'completed', '2026-09-14T01:00:00Z');
INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at) VALUES
  ('${A(1)}', '${R(1)}', 'chatgpt',  'KR', 'completed', '2026-09-14T02:00:00Z'),
  ('${A(2)}', '${R(1)}', 'gemini',   'KR', 'completed', '2026-09-14T02:01:00Z'),
  ('${A(3)}', '${R(2)}', 'chatgpt',  'KR', 'completed', '2026-09-14T02:02:00Z'),
  ('${A(4)}', '${R(2)}', 'deepseek', 'KR', 'completed', '2026-09-14T02:03:00Z'),
  ('${A(5)}', '${R(3)}', 'chatgpt',  'KR', 'completed', '2026-09-14T02:04:00Z'),
  ('${A(6)}', '${R(3)}', 'gemini',   'KR', 'completed', '2026-09-14T02:05:00Z');
`;

/** 0053 레지스트리 행 하나(회차의 한 답변에만 붙는 **부분 등록**이 정상이다). */
const ADD_REGISTRY = `
INSERT INTO scope_answer_anchors (job_id, anchor, source_measured_at, reason)
VALUES ('${A(3)}', '2026-09-06', '2026-09-14T02:02:00Z', 'manual-fold');
`;
const DROP_REGISTRY = `DELETE FROM scope_answer_anchors WHERE job_id = '${A(3)}';`;

/** 원장 귀속이 나중에 붙는다 — 회차 출처가 run → ledger 로 바뀐다. */
const ATTACH_LEDGER = `
INSERT INTO summary_cycles
  (cycle_id, surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status, view_anchor_at)
VALUES ('${C(1)}', 'global', '${PG}', '2026-09-14T01:00:00Z', '2026-09-14', 'scope', 'open', NULL);
INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by) VALUES
  ('${C(1)}', '${R(1)}', 'scope'),
  ('${C(1)}', '${R(2)}', 'scope'),
  ('${C(1)}', '${R(3)}', 'scope');
`;

/** 노출일이 나중에 찍힌다(회차 발행). */
const PUBLISH = `
UPDATE summary_cycles SET view_anchor_at = '2026-09-16T01:00:00Z' WHERE cycle_id = '${C(1)}';
`;

/** `cycle_anchor_at` 이 NULL 인 **단독 run**(회차를 이루지 못한다). */
const SOLO_RUN = `
INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at)
VALUES ('${R(9)}', '${PG}', 'completed', NULL);
INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at)
VALUES ('${A(9)}', '${R(9)}', 'chatgpt', 'KR', 'completed', '2026-09-15T02:00:00Z');
`;

// ── 스냅샷·시퀀스 실행 ───────────────────────────────────────────────────────
type Step = { sql?: string; refresh?: string[] };

const SNAP_ANCHORS = `
  SELECT job_id::text                                   AS job_id,
         run_id::text                                   AS run_id,
         surface, source,
         (anchor_at AT TIME ZONE 'UTC')::text           AS anchor_at,
         anchor_date::text                              AS anchor_date,
         anchor_week::text                              AS anchor_week,
         anchor_month::text                             AS anchor_month,
         round_date::text                               AS round_date,
         coalesce(view_anchor_date::text, '-')          AS view_anchor_date,
         coalesce(ledger_view_anchor_date::text, '-')   AS ledger_view_anchor_date,
         coalesce(cycle_id::text, '-')                  AS cycle_id,
         coalesce((source_measured_at AT TIME ZONE 'UTC')::text, '-') AS source_measured_at,
         coalesce(reason, '-')                          AS reason,
         (measured_at_orig AT TIME ZONE 'UTC')::text    AS measured_at_orig,
         is_default_engine
    FROM scope_answer_cycle_anchors ORDER BY job_id`;

const SNAP_ROUNDS = `
  SELECT project_id::text AS project_id, surface,
         anchor_date::text AS anchor_date, round_date::text AS round_date, basis
    FROM scope_cycle_rounds ORDER BY project_id, anchor_date`;

async function snapshot(db: PgliteDb) {
  const anchors = (await db.query(SNAP_ANCHORS)) as { rows: unknown[] };
  const rounds = (await db.query(SNAP_ROUNDS)) as { rows: unknown[] };
  return { anchors: anchors.rows, rounds: rounds.rows };
}

async function refresh(db: PgliteDb, ids: string[]): Promise<number> {
  const res = (await db.query(
    `SELECT refresh_answer_cycle_anchors($1::uuid[], NULL)::bigint AS n`,
    [ids],
  )) as { rows: Array<Record<string, unknown>> };
  return Number(res.rows[0].n);
}

async function play(withV78: boolean, fixture: string, steps: Step[]) {
  const db = await newDb({ withV78, fixtures: fixture });
  try {
    for (const s of steps) {
      if (s.sql) await db.exec(s.sql);
      if (s.refresh) await refresh(db, s.refresh);
    }
    return await snapshot(db);
  } finally {
    await db.close();
  }
}

/** 같은 픽스처·같은 순서를 두 구현에 태워 최종 상태를 대조한다. */
async function expectEquivalent(name: string, fixture: string, steps: Step[]) {
  const base = await play(false, fixture, steps);
  const next = await play(true, fixture, steps);
  expect(next.anchors, `${name}: 앵커 행이 기준선과 다르다`).toEqual(base.anchors);
  expect(next.rounds, `${name}: 귀속 매핑이 기준선과 다르다`).toEqual(base.rounds);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("0078 적용 자체", () => {
  it("모든 문장이 적용된다 (자가검증·스모크 포함)", async () => {
    const statements = statementsOf(MIGRATION_0078);
    // 함수 6(cycle_key·registry_runs·prune·propagate 교체·sync·refresh) + 테이블 2
    // + 인덱스 2 + lock_timeout 1 + 자가검증 1 + 스모크 1 = 13 문장
    expect(statements.length).toBe(13);
    const db = await newDb({ withV78: true });
    try {
      const fns = (await db.query(
        `SELECT proname::text AS name FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN ('hmg_cycle_key','hmg_refresh_cycle_registry_runs',
                            'hmg_prune_cycle_registry_runs',
                            'hmg_sync_cycle_anchor_state','refresh_answer_cycle_anchors')
          ORDER BY 1`,
      )) as { rows: Array<Record<string, string>> };
      expect(fns.rows.map((r) => r.name)).toEqual([
        "hmg_cycle_key",
        "hmg_prune_cycle_registry_runs",
        "hmg_refresh_cycle_registry_runs",
        "hmg_sync_cycle_anchor_state",
        "refresh_answer_cycle_anchors",
      ]);
      // 시그니처는 0077 그대로여야 한다(to_regprocedure 단언·capability 프로브 보호).
      const sig = (await db.query(
        `SELECT to_regprocedure('public.refresh_answer_cycle_anchors(uuid[], uuid)') IS NOT NULL AS ok`,
      )) as { rows: Array<Record<string, boolean>> };
      expect(sig.rows[0].ok).toBe(true);
      const tables = (await db.query(
        `SELECT tablename::text AS t FROM pg_tables
          WHERE tablename IN ('scope_cycle_anchor_state','scope_cycle_registry_runs') ORDER BY 1`,
      )) as { rows: Array<Record<string, string>> };
      expect(tables.rows.map((r) => r.t)).toEqual([
        "scope_cycle_anchor_state",
        "scope_cycle_registry_runs",
      ]);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("REVOKE 가 신규 객체 전부를 덮는다 (lockdown 공백 방지)", () => {
    const raw = fs.readFileSync(MIGRATION_0078, "utf8");
    for (const target of [
      'ON "scope_cycle_anchor_state"',
      'ON "scope_cycle_registry_runs"',
      "ON FUNCTION hmg_cycle_key(uuid, timestamptz, uuid)",
      "ON FUNCTION hmg_refresh_cycle_registry_runs(uuid[])",
      "ON FUNCTION hmg_prune_cycle_registry_runs(text[])",
      "ON FUNCTION hmg_sync_cycle_anchor_state(uuid[], uuid)",
      "ON FUNCTION refresh_answer_cycle_anchors(uuid[], uuid)",
    ]) {
      expect(raw, target).toContain(`REVOKE ALL ${target} FROM PUBLIC, anon, authenticated;`);
    }
  });
});

// ── §동치성 ─────────────────────────────────────────────────────────────────
describe("동치성 — 좁은 재계산 + 조건부 확장 = 항상 회차 전체 재계산", () => {
  const ORDERS: Array<{ name: string; steps: Step[] }> = [
    { name: "순서 1-2-3", steps: [{ refresh: [R(1)] }, { refresh: [R(2)] }, { refresh: [R(3)] }] },
    { name: "순서 3-1-2", steps: [{ refresh: [R(3)] }, { refresh: [R(1)] }, { refresh: [R(2)] }] },
    { name: "순서 2-3-1", steps: [{ refresh: [R(2)] }, { refresh: [R(3)] }, { refresh: [R(1)] }] },
    { name: "한 번에", steps: [{ refresh: [R(1), R(2), R(3)] }] },
    {
      name: "재호출 반복(멱등)",
      steps: [
        { refresh: [R(1)] }, { refresh: [R(1)] }, { refresh: [R(2)] },
        { refresh: [R(1)] }, { refresh: [R(3)] }, { refresh: [R(2)] },
      ],
    },
  ];

  for (const o of ORDERS) {
    it(`(a) 같은 회차 run 3개 — ${o.name}`, async () => {
      await expectEquivalent(o.name, BASE, o.steps);
    }, 120_000);
  }

  it("(a') 도착 순서가 달라도 0078 끼리의 최종 상태가 같다", async () => {
    const first = await play(true, BASE, ORDERS[0].steps);
    for (const o of ORDERS.slice(1)) {
      const other = await play(true, BASE, o.steps);
      expect(other.anchors, o.name).toEqual(first.anchors);
      expect(other.rounds, o.name).toEqual(first.rounds);
    }
  }, 180_000);

  it("(b) 도중에 0053 레지스트리 행이 생기면 회차 전체가 새 앵커로 따라간다", async () => {
    const snap = await expectEquivalent("registry 추가", BASE, [
      { refresh: [R(1)] },
      { refresh: [R(2)] },
      { refresh: [R(3)] },
      { sql: ADD_REGISTRY },
      // 접기 절차의 계약대로 **손댄 job 의 run** 만 넘긴다.
      { refresh: [R(2)] },
    ]);
    const rows = snap.anchors as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    // 레지스트리는 A(3) 한 건에만 붙었는데 **6건 전부**가 회차 앵커를 상속한다.
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["registry"]));
    // 0053 의 UTC 날짜 09-06 → 그 UTC 일자를 가진 회차(2026-09-06T16:00Z)를 찾아
    // KST 로 다시 자르면 2026-09-07(월 = 글로벌 정규 요일).
    expect(new Set(rows.map((r) => r.anchor_date))).toEqual(new Set(["2026-09-07"]));
    expect(new Set(rows.map((r) => r.round_date))).toEqual(new Set(["2026-09-07"]));
  }, 120_000);

  it("(c) 레지스트리 행이 사라져도 기준선과 같다 (고정 출처는 자동 경로가 안 지운다)", async () => {
    await expectEquivalent("registry 삭제", BASE, [
      { refresh: [R(1), R(2), R(3)] },
      { sql: ADD_REGISTRY },
      { refresh: [R(2)] },
      { sql: DROP_REGISTRY },
      { refresh: [R(2)] },
      { refresh: [R(1)] },
    ]);
  }, 120_000);

  it("(c') 레지스트리가 사라진 뒤 **새로 들어온 run** 은 자동 앵커를 받는다", async () => {
    const NEW_RUN = `
      INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at)
      VALUES ('${R(4)}', '${PG}', 'completed', '2026-09-14T01:00:00Z');
      INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at)
      VALUES ('${A(7)}', '${R(4)}', 'chatgpt', 'KR', 'completed', '2026-09-14T02:06:00Z');`;
    const snap = await expectEquivalent("registry 삭제 후 신규 run", BASE, [
      { refresh: [R(1), R(2), R(3)] },
      { sql: ADD_REGISTRY },
      { refresh: [R(2)] },
      { sql: DROP_REGISTRY + NEW_RUN },
      { refresh: [R(4)] },
    ]);
    const rows = snap.anchors as Array<Record<string, unknown>>;
    const fresh = rows.find((r) => r.job_id === A(7))!;
    // 새 run 의 답변은 고정 이력이 없으므로 자동 경로(run 앵커)를 그대로 받는다.
    expect(fresh.source).toBe("run");
    expect(fresh.anchor_date).toBe("2026-09-14");
    // 기존 6건은 고정(registry)이라 그대로 09-07 이다.
    expect(rows.filter((r) => r.source === "registry")).toHaveLength(6);
  }, 120_000);

  it("(d) cycle_anchor_at NULL 단독 run 이 섞여도 같다", async () => {
    await expectEquivalent("단독 run", BASE + SOLO_RUN, [
      { refresh: [R(9)] },
      { refresh: [R(1)] },
      { refresh: [R(9)] },
      { refresh: [R(2)] },
      { refresh: [R(3)] },
    ]);
  }, 120_000);

  it("(e) 원장 귀속이 나중에 붙으면 회차 전체가 ledger 출처로 바뀐다", async () => {
    const snap = await expectEquivalent("원장 귀속", BASE, [
      { refresh: [R(1), R(2), R(3)] },
      { sql: ATTACH_LEDGER },
      { refresh: [R(1)] },
    ]);
    const rows = snap.anchors as Array<Record<string, unknown>>;
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["ledger"]));
    expect(new Set(rows.map((r) => r.cycle_id))).toEqual(new Set([C(1)]));
  }, 120_000);

  it("(f) 노출일이 나중에 찍히면 회차 전체가 따라간다", async () => {
    const snap = await expectEquivalent("노출일", BASE, [
      { refresh: [R(1), R(2), R(3)] },
      { sql: ATTACH_LEDGER },
      { refresh: [R(1)] },
      { sql: PUBLISH },
      // 발행 전파는 그 원장 회차의 run 을 넘긴다 — 여기서는 일부러 **하나만** 넘겨
      // 회차 전체가 따라오는지 본다.
      { refresh: [R(1)] },
    ]);
    const rows = snap.anchors as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.view_anchor_date))).toEqual(new Set(["2026-09-16"]));
    expect(new Set(rows.map((r) => r.ledger_view_anchor_date))).toEqual(new Set(["2026-09-16"]));
  }, 120_000);

  it("(g) 답변이 completed 에서 벗어나면 그 run 의 행만 사라진다 (B8)", async () => {
    await expectEquivalent("상태 이탈", BASE, [
      { refresh: [R(1), R(2), R(3)] },
      { sql: `UPDATE scope_answers SET status = 'failed' WHERE job_id = '${A(5)}';` },
      { refresh: [R(3)] },
    ]);
  }, 120_000);
});

// ── §비용 상한 ──────────────────────────────────────────────────────────────
describe("평소 호출은 회차 크기에 비례하지 않는다", () => {
  const PB = "0000dddd-0000-4000-8000-000000000004";
  const BIG_RUNS = 50;

  /** run 50개 · 답변 100건이 **한 회차**에 들어 있는 픽스처. */
  function bigFixture(): string {
    const runs: string[] = [];
    const answers: string[] = [];
    for (let i = 1; i <= BIG_RUNS; i += 1) {
      runs.push(`('${R(100 + i)}', '${PB}', 'completed', '2026-09-14T01:00:00Z')`);
      answers.push(
        `('${A(100 + i * 2)}', '${R(100 + i)}', 'chatgpt', 'KR', 'completed', '2026-09-14T02:00:00Z')`,
      );
      answers.push(
        `('${A(101 + i * 2)}', '${R(100 + i)}', 'gemini', 'KR', 'completed', '2026-09-14T02:01:00Z')`,
      );
    }
    return `
INSERT INTO projects (name, country, scope_project_id) VALUES ('big', 'KR', '${PB}');
INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at) VALUES ${runs.join(",\n")};
INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at) VALUES ${answers.join(",\n")};
`;
  }

  const expandedCount = async (db: PgliteDb): Promise<number> => {
    const r = (await db.query(
      `SELECT coalesce(sum(expanded_count), 0)::int AS n FROM scope_cycle_anchor_state`,
    )) as { rows: Array<Record<string, unknown>> };
    return Number(r.rows[0].n);
  };

  it("첫 호출만 넓히고, 그 뒤 run 49개는 **확장 없이** 자기 답변만 쓴다", async () => {
    const db = await newDb({ withV78: true, fixtures: bigFixture() });
    try {
      // ① 첫 호출 — 회차 상태가 없으므로 회차 전체로 넓힌다(부트스트랩 1회).
      const first = await refresh(db, [R(101)]);
      expect(first).toBe(BIG_RUNS * 2); // 100행 전부 INSERT
      expect(await expandedCount(db)).toBe(1);

      // ② 나머지 run — 회차 해소 결과가 그대로이므로 좁게 돈다.
      //    쓰기는 0행이고(값이 안 바뀐다) **확장 카운터가 늘지 않는다.**
      for (let i = 2; i <= BIG_RUNS; i += 1) {
        const n = await refresh(db, [R(100 + i)]);
        expect(n, `run ${i} 가 회차 전체를 다시 썼다`).toBe(0);
      }
      expect(await expandedCount(db), "평소 호출이 회차를 넓혔다").toBe(1);

      // ③ 회차 수준 값이 실제로 달라지면 그때는 넓힌다(확장이 죽어 있지 않다는 증거).
      await db.exec(`
        INSERT INTO scope_answer_anchors (job_id, anchor, source_measured_at, reason)
        VALUES ('${A(100 + 2 * 2)}', '2026-09-07', '2026-09-14T02:00:00Z', 'manual-fold');`);
      const widened = await refresh(db, [R(102)]);
      expect(widened, "레지스트리가 붙었는데 회차가 안 따라왔다").toBe(BIG_RUNS * 2);
      expect(await expandedCount(db)).toBe(2);
    } finally {
      await db.close();
    }
  }, 180_000);

  it("**변이**: 조건부 판정을 끄면(= 항상 확장) 매 호출이 회차 전체를 다시 쓴다", async () => {
    // 0077 단독 = "항상 회차 전체 재계산" 구현이다. 그것이 실제로 매번 100행을
    // 후보로 삼는다는 것을 보여 이 테스트가 변화를 잡을 수 있음을 확인한다.
    const db = await newDb({ withV78: false, fixtures: bigFixture() });
    try {
      expect(await refresh(db, [R(101)])).toBe(BIG_RUNS * 2);
      // 두 번째 호출은 값이 안 바뀌어 rowcount 는 0 이지만, 0077 은 확장 자체를
      // 건너뛸 수단이 없다 — 그 사실을 NOTICE 문구로 고정한다.
      const raw = fs.readFileSync(
        require.resolve("./0077_scope_answer_cycle_anchors.sql"),
        "utf8",
      );
      expect(raw).toContain("회차 상속으로 run %개 → %개로 넓혔다");
    } finally {
      await db.close();
    }
  }, 180_000);
});

// ── §원장 앵커 선택 규칙 (결함 B) ───────────────────────────────────────────
describe("한 회차가 원장 회차 둘에 걸칠 때의 앵커 선택", () => {
  /**
   * website 회차 run 5개. 원장은 둘로 갈린다.
   *   본 회차  `2026-09-18T00:00:00Z` — run 앵커와 **같다**
   *   유령 회차 `2026-09-17T03:40:00Z` — 09-19 재제출 run 이 붙은 옛 스케줄 앵커
   *
   * 손계산: KST(2026-09-18T00:00Z) = 09-18 09:00 → **2026-09-18**(금 = website 정규 요일)
   *         KST(2026-09-17T03:40Z) = 09-17 12:40 → 2026-09-17(목)
   */
  function splitFixture(mainRuns: number, ghostRuns: number, ghostAt: string, extraGhost?: {
    at: string;
    runs: number;
  }): string {
    const runs: string[] = [];
    const answers: string[] = [];
    const attrib: string[] = [];
    let idx = 200;
    const add = (cycleId: string) => {
      idx += 1;
      runs.push(`('${R(idx)}', '${PW}', 'completed', '2026-09-18T00:00:00Z')`);
      answers.push(
        `('${A(idx)}', '${R(idx)}', 'chatgpt', 'KR', 'completed', '2026-09-18T01:00:00Z')`,
      );
      attrib.push(`('${cycleId}', '${R(idx)}', 'scope')`);
    };
    for (let i = 0; i < mainRuns; i += 1) add(C(11));
    for (let i = 0; i < ghostRuns; i += 1) add(C(12));
    for (let i = 0; i < (extraGhost?.runs ?? 0); i += 1) add(C(13));
    const cycles = [
      `('${C(11)}', 'website', '${PW}', '2026-09-18T00:00:00Z', '2026-09-14', 'scope', 'closed', NULL)`,
      `('${C(12)}', 'website', '${PW}', '${ghostAt}', '2026-09-14', 'scope', 'closed', NULL)`,
    ];
    if (extraGhost) {
      cycles.push(
        `('${C(13)}', 'website', '${PW}', '${extraGhost.at}', '2026-09-14', 'scope', 'closed', NULL)`,
      );
    }
    return `
INSERT INTO website_sites (brand, country_code, scope_project_id) VALUES ('Hyundai', 'KR', '${PW}');
INSERT INTO summary_cycles
  (cycle_id, surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status, view_anchor_at)
VALUES ${cycles.join(",\n")};
INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at) VALUES ${runs.join(",\n")};
INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at) VALUES ${answers.join(",\n")};
INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by) VALUES ${attrib.join(",\n")};
`;
  }

  const anchorsOf = async (withV78: boolean, fixture: string) => {
    const db = await newDb({ withV78, fixtures: fixture });
    try {
      const ids = (await db.query(
        `SELECT run_id::text AS id FROM scope_runs WHERE project_id = '${PW}'`,
      )) as { rows: Array<Record<string, string>> };
      await refresh(db, ids.rows.map((r) => r.id));
      const rows = (await db.query(
        `SELECT DISTINCT source, (anchor_at AT TIME ZONE 'UTC')::text AS anchor_at,
                anchor_date::text AS anchor_date, round_date::text AS round_date
           FROM scope_answer_cycle_anchors WHERE project_id = '${PW}'`,
      )) as { rows: unknown[] };
      return rows.rows;
    } finally {
      await db.close();
    }
  };

  it("① run 앵커와 같은 원장 회차를 고른다 (0077 은 min 으로 유령 회차를 골랐다)", async () => {
    const fx = splitFixture(4, 1, "2026-09-17T03:40:00Z");
    // 0077 기준선 = 결함 재현: min → 유령 회차 09-17.
    expect(await anchorsOf(false, fx)).toEqual([
      {
        source: "ledger",
        anchor_at: "2026-09-17 03:40:00",
        anchor_date: "2026-09-17",
        // 09-17(목)은 앞 09-11·뒤 09-18 이 둘 다 비어 가까운 09-18 로 간다.
        round_date: "2026-09-18",
      },
    ]);
    // 0078 = 수리: run 앵커와 같은 원장 회차(09-18).
    expect(await anchorsOf(true, fx)).toEqual([
      {
        source: "ledger",
        anchor_at: "2026-09-18 00:00:00",
        anchor_date: "2026-09-18",
        round_date: "2026-09-18",
      },
    ]);
  }, 180_000);

  it("② run 앵커와 같은 원장 회차가 없으면 run 수가 가장 많은 쪽", async () => {
    // 본 회차를 비우고(0 run) 유령 둘: 09-17(3 run) vs 09-16(1 run) → 09-17.
    const fx = splitFixture(0, 3, "2026-09-17T03:40:00Z", { at: "2026-09-16T03:40:00Z", runs: 1 });
    expect(await anchorsOf(true, fx)).toEqual([
      {
        source: "ledger",
        anchor_at: "2026-09-17 03:40:00",
        anchor_date: "2026-09-17", // KST 09-17 12:40
        round_date: "2026-09-18",
      },
    ]);
  }, 180_000);

  it("③ 동수면 이른 앵커 (min 과 같아져 종전 동작으로 수렴한다)", async () => {
    const fx = splitFixture(0, 1, "2026-09-17T03:40:00Z", { at: "2026-09-16T03:40:00Z", runs: 1 });
    expect(await anchorsOf(true, fx)).toEqual([
      {
        source: "ledger",
        anchor_at: "2026-09-16 03:40:00",
        anchor_date: "2026-09-16", // KST 09-16 12:40 (수)
        // 09-16(수) → 앞 09-11·뒤 09-18 둘 다 비었고 뒤가 2일로 더 가깝다.
        round_date: "2026-09-18",
      },
    ]);
    // 갈리지 않은 회차(원장 하나)는 종전과 완전히 같다.
    const plain = splitFixture(3, 0, "2026-09-17T03:40:00Z");
    expect(await anchorsOf(true, plain)).toEqual(await anchorsOf(false, plain));
  }, 180_000);

  it("감사 SQL — 0077 이 쓴 값은 긴급으로 울고, 0078 이 쓴 값은 통과한다", async () => {
    const fx = splitFixture(4, 1, "2026-09-17T03:40:00Z");
    const audit = async (withV78: boolean) => {
      // 기준선(0077)에 쓴 뒤 **감사에 필요한 0078 객체만** 올려 같은 감사를 돌린다.
      const db = await newDb({ withV78, fixtures: fx });
      try {
        const ids = (await db.query(
          `SELECT run_id::text AS id FROM scope_runs WHERE project_id = '${PW}'`,
        )) as { rows: Array<Record<string, string>> };
        await refresh(db, ids.rows.map((r) => r.id));
        if (!withV78) for (const s of statementsOf(MIGRATION_0078)) await db.exec(s);
        const rows = (
          (await db.query(fs.readFileSync(AUDIT_SQL, "utf8"))) as {
            rows: Array<Record<string, unknown>>;
          }
        ).rows;
        return Object.fromEntries(
          rows.map((r) => [String(r.check), { n: Number(r.n), severity: Number(r.severity) }]),
        );
      } finally {
        await db.close();
      }
    };

    const base = await audit(false);
    // 프로덕션에서 관측된 지문: 회차 전체(5행)가 유령 회차 앵커를 받아 긴급으로 운다.
    expect(base.ledger_anchor_drift).toEqual({ n: 5, severity: 2 });
    // 원인 지표는 주의 등급으로 규모만 드러낸다(회차 1개가 원장 둘에 걸쳤다).
    expect(base.cycle_ledger_split).toEqual({ n: 1, severity: 1 });

    const fixed = await audit(true);
    expect(fixed.ledger_anchor_drift).toEqual({ n: 0, severity: 0 });
    expect(fixed.cycle_ledger_split).toEqual({ n: 1, severity: 1 });
    // 0078 이 쓴 DB 는 긴급 항목이 하나도 없어야 한다.
    expect(
      Object.entries(fixed).filter(([, v]) => v.severity > 1),
      JSON.stringify(fixed),
    ).toEqual([]);
  }, 180_000);

  it("원장 앵커 선택 규칙의 **사본**이 세 곳에서 같다 (드리프트 가드)", () => {
    const ORDER = "ORDER BY cycle_key, matches_run DESC, runs DESC, ledger_anchor_at ASC";
    expect(fs.readFileSync(MIGRATION_0078, "utf8")).toContain(ORDER);
    // dry-run 은 S1·S4·S5 세 문장이 각각 자기 사본을 갖는다.
    expect(fs.readFileSync(DRYRUN_SQL, "utf8").split(ORDER).length - 1).toBe(3);
    expect(fs.readFileSync(AUDIT_SQL, "utf8")).toContain(ORDER);
  });
});

// ── §W2 운영자 재배정이 회차 상태를 낡게 만들지 않는다 ─────────────────────
describe("재배정(매핑 이동)이 회차 상태의 귀속 날짜를 함께 옮긴다", () => {
  /**
   * 증분 배정과 전수 재배정이 **다른 자리**를 주는 픽스처.
   *   · 웹사이트 회차 09-17(목)이 먼저 들어오면 앞 09-11·뒤 09-18 이 둘 다 비어
   *     가까운 09-18 로 간다(basis nearest).
   *   · 나중에 09-18(금) 회차가 들어와도 과거 배정은 움직이지 않는다.
   *   · 전수 재배정은 정규 요일 회차(09-18)를 **먼저** 앉히므로 09-17 은 앞 자리
   *     09-11 이 비어 있고 뒤 09-18 이 차 있어 `prev_empty` 로 간다.
   * 즉 재배정이 답변 행의 round_date 를 09-18 → 09-11 로 옮긴다. (전부 손계산)
   */
  const PR = "0000eeee-0000-4000-8000-000000000005";
  const FIX = `
INSERT INTO website_sites (brand, country_code, scope_project_id) VALUES ('Kia', 'KR', '${PR}');
INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at) VALUES
  ('${R(31)}', '${PR}', 'completed', '2026-09-16T15:30:00Z'),
  ('${R(32)}', '${PR}', 'completed', '2026-09-17T15:30:00Z');
INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at) VALUES
  ('${A(31)}', '${R(31)}', 'chatgpt', 'KR', 'completed', '2026-09-16T16:00:00Z'),
  ('${A(32)}', '${R(32)}', 'chatgpt', 'KR', 'completed', '2026-09-17T16:00:00Z');
`;
  // KST: 09-16T15:30Z → 09-17 00:30 (목) · 09-17T15:30Z → 09-18 00:30 (금)

  const auditMap = async (db: PgliteDb) => {
    const rows = (
      (await db.query(fs.readFileSync(AUDIT_SQL, "utf8"))) as {
        rows: Array<Record<string, unknown>>;
      }
    ).rows;
    return Object.fromEntries(
      rows.map((r) => [String(r.check), { n: Number(r.n), severity: Number(r.severity) }]),
    );
  };

  it("재배정 뒤 cycle_state_drift·round_date_drift 가 0 이다", async () => {
    const db = await newDb({ withV78: true, fixtures: FIX });
    try {
      // 증분 도착: 09-17 회차 먼저, 09-18 회차 나중.
      await refresh(db, [R(31)]);
      await refresh(db, [R(32)]);
      const seat0 = (await db.query(
        `SELECT anchor_date::text AS a, round_date::text AS r, basis
           FROM scope_cycle_rounds WHERE project_id = '${PR}' ORDER BY 1`,
      )) as { rows: unknown[] };
      expect(seat0.rows).toEqual([
        { a: "2026-09-17", r: "2026-09-18", basis: "nearest" },
        { a: "2026-09-18", r: "2026-09-18", basis: "canonical" },
      ]);
      expect(await auditMap(db).then((m) => m.cycle_state_drift)).toEqual({ n: 0, severity: 0 });

      // 운영자 재배정 경로를 그대로 재현한다(reassign-cycle-rounds.ts 의 ①②③).
      // ⚠️ `refresh_answer_cycle_anchors` 를 부르지 않는다 — 그것이 이 테스트의 요점이다.
      await db.exec(`DELETE FROM scope_cycle_rounds WHERE project_id = '${PR}';`);
      await db.query(`SELECT hmg_assign_cycle_rounds(NULL::uuid[], $1::uuid[])`, [[PR]]);
      const moved = (await db.query(
        `SELECT hmg_propagate_cycle_rounds(NULL::uuid[], $1::uuid[])::int AS n`,
        [[PR]],
      )) as { rows: Array<Record<string, unknown>> };

      // 자리가 실제로 옮겨졌는가(전수 재배정은 정규 요일을 먼저 앉힌다).
      const seat1 = (await db.query(
        `SELECT anchor_date::text AS a, round_date::text AS r, basis
           FROM scope_cycle_rounds WHERE project_id = '${PR}' ORDER BY 1`,
      )) as { rows: unknown[] };
      expect(seat1.rows).toEqual([
        { a: "2026-09-17", r: "2026-09-11", basis: "prev_empty" },
        { a: "2026-09-18", r: "2026-09-18", basis: "canonical" },
      ]);
      expect(Number(moved.rows[0].n), "답변 행이 옮겨지지 않았다").toBe(1);

      // 답변 행과 **회차 상태**가 둘 다 따라왔는가.
      const after = (await db.query(
        `SELECT c.round_date::text AS answer_round, s.round_date::text AS state_round
           FROM scope_answer_cycle_anchors c
           JOIN scope_runs r ON r.run_id = c.run_id
           JOIN scope_cycle_anchor_state s
             ON s.cycle_key = hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id)
          WHERE c.job_id = '${A(31)}'`,
      )) as { rows: unknown[] };
      expect(after.rows).toEqual([{ answer_round: "2026-09-11", state_round: "2026-09-11" }]);

      const m = await auditMap(db);
      expect(m.cycle_state_drift, "재배정이 회차 상태를 낡게 만들었다").toEqual({
        n: 0,
        severity: 0,
      });
      expect(m.round_date_drift).toEqual({ n: 0, severity: 0 });
      // 그리고 다음 호출이 "round_date 가 달라졌다"고 오판해 넓히지 않는다.
      const expandedBefore = (await db.query(
        `SELECT coalesce(sum(expanded_count), 0)::int AS n FROM scope_cycle_anchor_state`,
      )) as { rows: Array<Record<string, unknown>> };
      await refresh(db, [R(31)]);
      const expandedAfter = (await db.query(
        `SELECT coalesce(sum(expanded_count), 0)::int AS n FROM scope_cycle_anchor_state`,
      )) as { rows: Array<Record<string, unknown>> };
      expect(Number(expandedAfter.rows[0].n)).toBe(Number(expandedBefore.rows[0].n));
    } finally {
      await db.close();
    }
  }, 180_000);

  it("**변이**: 상태만 옛 자리로 되돌리면 감사가 긴급으로 운다", async () => {
    const db = await newDb({ withV78: true, fixtures: FIX });
    try {
      await refresh(db, [R(31)]);
      await refresh(db, [R(32)]);
      // 0078 이전 판(전파가 상태를 안 맞추던 형태)을 손으로 재현한다.
      await db.exec(
        `UPDATE scope_cycle_anchor_state SET round_date = round_date - 7 WHERE project_id = '${PR}';`,
      );
      const m = await auditMap(db);
      expect(m.cycle_state_drift.n).toBeGreaterThan(0);
      expect(m.cycle_state_drift.severity).toBe(2);
    } finally {
      await db.close();
    }
  }, 180_000);
});

// ── §W1 0053 값 정정 ────────────────────────────────────────────────────────
describe("0053 의 앵커 **값만** 정정된 경우", () => {
  const auditRow = async (db: PgliteDb, name: string) => {
    const rows = (
      (await db.query(fs.readFileSync(AUDIT_SQL, "utf8"))) as {
        rows: Array<Record<string, unknown>>;
      }
    ).rows;
    const r = rows.find((x) => String(x.check) === name)!;
    return { n: Number(r.n), severity: Number(r.severity) };
  };

  it("행 수가 같아도 감사가 잡는다 (요약의 앵커 값까지 대조)", async () => {
    const db = await newDb({ withV78: true, fixtures: BASE });
    try {
      await db.exec(ADD_REGISTRY);
      await refresh(db, [R(1), R(2), R(3)]);
      expect(await auditRow(db, "registry_summary_drift")).toEqual({ n: 0, severity: 0 });

      // 값만 정정한다 — **행 수는 그대로 1**이다. 종전 술어(행 수 비교)는 이걸 놓쳤다.
      await db.exec(
        `UPDATE scope_answer_anchors SET anchor = '2026-09-07' WHERE job_id = '${A(3)}';`,
      );
      // 계약(손댄 job 의 run 을 넘긴다)을 어기고 **다른 run** 으로만 부른다.
      await refresh(db, [R(1)]);
      expect(
        await auditRow(db, "registry_summary_drift"),
        "0053 값 정정을 감사가 놓쳤다",
      ).toEqual({ n: 1, severity: 2 });

      // 회수: 손댄 job 의 run 으로 부르면 요약이 갱신되고 경보가 걷힌다.
      await refresh(db, [R(2)]);
      expect(await auditRow(db, "registry_summary_drift")).toEqual({ n: 0, severity: 0 });
      const g = (await db.query(
        `SELECT reg_anchor_min::text AS mn, reg_anchor_max::text AS mx, reg_rows
           FROM scope_cycle_registry_runs`,
      )) as { rows: unknown[] };
      expect(g.rows).toEqual([{ mn: "2026-09-07", mx: "2026-09-07", reg_rows: 1 }]);
    } finally {
      await db.close();
    }
  }, 180_000);
});

// ── §W8 롤백 SQL ────────────────────────────────────────────────────────────
describe("롤백 SQL", () => {
  const ROLLBACK = path.join(SCRIPTS_DB, "0078-rollback.sql");

  /** 마커 사이의 본문을 뽑는다. */
  function between(src: string, name: string): string {
    const m = new RegExp(
      `-- >>> 0077:${name} BEGIN \\(자동 대조 대상\\)\\n([\\s\\S]*?)\\n-- <<< 0077:${name} END`,
    ).exec(src);
    if (!m) throw new Error(`롤백 SQL 에서 ${name} 마커를 못 찾았다`);
    return m[1].trim();
  }

  it("붙여넣은 0077 함수 본문이 0077 파일과 **문자 단위로** 같다", () => {
    const rb = fs.readFileSync(ROLLBACK, "utf8");
    const mig = fs
      .readFileSync(path.join(__dirname, "0077_scope_answer_cycle_anchors.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim());
    for (const [marker, needle] of [
      ["refresh_answer_cycle_anchors", "CREATE OR REPLACE FUNCTION refresh_answer_cycle_anchors"],
      ["hmg_propagate_cycle_rounds", "CREATE OR REPLACE FUNCTION hmg_propagate_cycle_rounds"],
    ] as const) {
      const src = mig.filter((s) => s.includes(needle));
      expect(src, marker).toHaveLength(1);
      expect(between(rb, marker), marker).toBe(src[0]);
    }
  });

  it("0078 이 만든 객체를 빠짐없이 지우고, 감사 되돌림을 머리말에 적는다", () => {
    const rb = fs.readFileSync(ROLLBACK, "utf8");
    for (const drop of [
      "DROP FUNCTION IF EXISTS hmg_sync_cycle_anchor_state(uuid[], uuid);",
      "DROP FUNCTION IF EXISTS hmg_prune_cycle_registry_runs(text[]);",
      "DROP FUNCTION IF EXISTS hmg_refresh_cycle_registry_runs(uuid[]);",
      "DROP TABLE IF EXISTS scope_cycle_anchor_state;",
      "DROP TABLE IF EXISTS scope_cycle_registry_runs;",
      "DROP FUNCTION IF EXISTS hmg_cycle_key(uuid, timestamptz, uuid);",
    ]) {
      expect(rb, drop).toContain(drop);
    }
    // 앵커 테이블·매핑 표는 건드리지 않는다.
    expect(rb).not.toMatch(/DROP TABLE[^\n]*scope_answer_cycle_anchors/);
    expect(rb).not.toMatch(/DROP TABLE[^\n]*scope_cycle_rounds/);
    // W8: 감사 SQL 되돌림이 머리말에 있어야 한다.
    expect(rb).toContain("answer-cycle-anchors-audit.sql");
    expect(rb).toContain("88383fe"); // 되돌릴 커밋 sha 를 적어 둔다
  });
});

// ── §N1 롤백 SQL 을 **실행한다** ────────────────────────────────────────────
describe("롤백 SQL 실행 (0077 → 0078 → 롤백 → 0077 스모크)", () => {
  const ROLLBACK = path.join(SCRIPTS_DB, "0078-rollback.sql");

  const objects = async (db: PgliteDb) => {
    const fns = (await db.query(
      `SELECT proname::text AS n FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('hmg_cycle_key','hmg_refresh_cycle_registry_runs',
                          'hmg_prune_cycle_registry_runs','hmg_sync_cycle_anchor_state')
        ORDER BY 1`,
    )) as { rows: Array<Record<string, string>> };
    const tbl = (await db.query(
      `SELECT tablename::text AS n FROM pg_tables
        WHERE tablename IN ('scope_cycle_anchor_state','scope_cycle_registry_runs') ORDER BY 1`,
    )) as { rows: Array<Record<string, string>> };
    return [...fns.rows.map((r) => r.n), ...tbl.rows.map((r) => r.n)];
  };

  it("롤백 뒤 신규 객체 6개가 사라지고 0077 판 refresh 가 값 그대로 돈다", async () => {
    const db = await newDb({ withV78: true, fixtures: BASE });
    try {
      await db.exec(ADD_REGISTRY);
      await refresh(db, [R(1), R(2), R(3)]);
      const before = await snapshot(db);
      expect(await objects(db)).toEqual([
        "hmg_cycle_key",
        "hmg_prune_cycle_registry_runs",
        "hmg_refresh_cycle_registry_runs",
        "hmg_sync_cycle_anchor_state",
        "scope_cycle_anchor_state",
        "scope_cycle_registry_runs",
      ]);

      // ⚠️ 텍스트 대조가 아니라 **파일 전체를 그대로 실행**한다. BEGIN/COMMIT·DROP
      //    순서·검증 DO 블록이 여기서 처음으로 돈다(재검증 N1).
      //    검증 DO 블록이 실패하면 이 exec 가 throw 하고 트랜잭션이 통째로 롤백된다.
      await db.exec(fs.readFileSync(ROLLBACK, "utf8"));

      expect(await objects(db), "0078 객체가 남았다").toEqual([]);
      // 0077 판 함수는 남아 있고, 그 스모크(없는 run → 0행)는 롤백 SQL 안에서 이미 돌았다.
      const sig = (await db.query(
        `SELECT to_regprocedure('public.refresh_answer_cycle_anchors(uuid[], uuid)') IS NOT NULL AS a,
                to_regprocedure('public.hmg_propagate_cycle_rounds(uuid[], uuid[])') IS NOT NULL AS b`,
      )) as { rows: Array<Record<string, boolean>> };
      expect([sig.rows[0].a, sig.rows[0].b]).toEqual([true, true]);

      // 그리고 **진짜 데이터**로도 돈다 — 0077 재계산이 같은 값을 낸다(쓰기 0행).
      expect(await refresh(db, [R(1)]), "롤백 뒤 0077 재계산이 값을 바꿨다").toBe(0);
      expect(await snapshot(db), "롤백이 앵커 행을 건드렸다").toEqual(before);
    } finally {
      await db.close();
    }
  }, 180_000);

  it("앵커 표·매핑 표는 롤백이 건드리지 않는다", async () => {
    const db = await newDb({ withV78: true, fixtures: BASE });
    try {
      await refresh(db, [R(1), R(2), R(3)]);
      const before = await snapshot(db);
      await db.exec(fs.readFileSync(ROLLBACK, "utf8"));
      const tables = (await db.query(
        `SELECT tablename::text AS n FROM pg_tables
          WHERE tablename IN ('scope_answer_cycle_anchors','scope_cycle_rounds') ORDER BY 1`,
      )) as { rows: Array<Record<string, string>> };
      expect(tables.rows.map((r) => r.n)).toEqual([
        "scope_answer_cycle_anchors",
        "scope_cycle_rounds",
      ]);
      expect(await snapshot(db)).toEqual(before);
    } finally {
      await db.close();
    }
  }, 180_000);
});

// ── §N4 0079 인덱스 마이그레이션 ────────────────────────────────────────────
describe("0079 (scope_runs 복합 인덱스)", () => {
  const IDX = "scope_runs_project_cycle_idx";

  it("저널이 0078 바로 뒤에 하루 간격으로 붙는다", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(__dirname, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const i = journal.entries.findIndex((e) => e.tag === "0078_answer_cycle_anchor_hot_path");
    expect(i).toBeGreaterThan(-1);
    const next = journal.entries[i + 1];
    expect(next?.tag).toBe("0079_scope_runs_project_cycle_idx");
    expect(fs.existsSync(path.join(__dirname, `${next.tag}.sql`))).toBe(true);
    expect(next.idx - journal.entries[i].idx).toBe(1);
    // 벽시계를 넣으면 단조가 깨져 drizzle 이 조용히 스킵한다 — 하루 단위 배수여야 한다.
    expect(next.when - journal.entries[i].when).toBe(86_400_000);
  });

  it("인덱스가 없는 DB 에서는 만들고, 이미 있으면 **아무것도 하지 않는다**", async () => {
    const db = await newDb({ withV78: false, withV79: false });
    try {
      const count = async () => {
        const r = (await db.query(
          `SELECT count(*)::int AS n FROM pg_indexes
            WHERE tablename = 'scope_runs' AND indexname = '${IDX}'`,
        )) as { rows: Array<Record<string, unknown>> };
        return Number(r.rows[0].n);
      };
      expect(await count()).toBe(0);

      for (const s of statementsOf(MIGRATION_0079)) await db.exec(s);
      expect(await count()).toBe(1);
      const def = (await db.query(
        `SELECT indexdef::text AS d FROM pg_indexes WHERE indexname = '${IDX}'`,
      )) as { rows: Array<Record<string, string>> };
      expect(def.rows[0].d).toMatch(/\(project_id,\s*cycle_anchor_at\)/);

      // 재적용 — 카탈로그 선확인이 걸려 `CREATE INDEX` 를 **부르지 않는다**.
      // oid 가 그대로면 지웠다 다시 만들지 않았다는 증거다(락도 안 잡았다).
      const oid0 = (await db.query(`SELECT '${IDX}'::regclass::oid::int AS o`)) as {
        rows: Array<Record<string, unknown>>;
      };
      for (const s of statementsOf(MIGRATION_0079)) await db.exec(s);
      const oid1 = (await db.query(`SELECT '${IDX}'::regclass::oid::int AS o`)) as {
        rows: Array<Record<string, unknown>>;
      };
      expect(await count()).toBe(1);
      expect(Number(oid1.rows[0].o), "재적용이 인덱스를 다시 만들었다").toBe(
        Number(oid0.rows[0].o),
      );
    } finally {
      await db.close();
    }
  }, 180_000);

  it("0078 과 한 세트로 올라간다 (픽스처가 0079 를 안다)", async () => {
    const db = await newDb({ withV78: true });
    try {
      const r = (await db.query(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = '${IDX}'`,
      )) as { rows: Array<Record<string, unknown>> };
      expect(Number(r.rows[0].n)).toBe(1);
    } finally {
      await db.close();
    }
  }, 120_000);
});

// ── §N3 INVALID 인덱스 점검 ─────────────────────────────────────────────────
describe("INVALID 인덱스 점검 (0079 DO 블록이 못 막는 자리)", () => {
  const CHECK_SQL = path.join(SCRIPTS_DB, "check-index-validity.sql");

  const auditRow = async (db: PgliteDb, name: string) => {
    const rows = (
      (await db.query(fs.readFileSync(AUDIT_SQL, "utf8"))) as {
        rows: Array<Record<string, unknown>>;
      }
    ).rows;
    const r = rows.find((x) => String(x.check) === name)!;
    return { n: Number(r.n), severity: Number(r.severity) };
  };

  it("정상 DB 에서는 점검 SQL 이 트랙 인덱스를 전부 severity 0 으로 낸다", async () => {
    const db = await newDb({ withV78: true, fixtures: BASE });
    try {
      const rows = (
        (await db.query(fs.readFileSync(CHECK_SQL, "utf8"))) as {
          rows: Array<Record<string, unknown>>;
        }
      ).rows;
      // 0077 의 인덱스 7 + PK 2 + 0078 의 2 + PK 2 + 0079 의 1 = 트랙이 만든 전부.
      expect(rows.length).toBeGreaterThan(8);
      expect(rows.filter((r) => Number(r.severity) !== 0)).toEqual([]);
      expect(rows.map((r) => r.index_name)).toContain("scope_runs_project_cycle_idx");
      expect(await auditRow(db, "invalid_index")).toEqual({ n: 0, severity: 0 });
    } finally {
      await db.close();
    }
  }, 180_000);

  it("**변이**: 인덱스를 INVALID 로 만들면 점검과 감사가 둘 다 긴급으로 운다", async () => {
    const db = await newDb({ withV78: true, fixtures: BASE });
    try {
      // `CREATE INDEX CONCURRENTLY` 실패가 남기는 상태를 카탈로그에서 직접 만든다
      // (pglite 는 단일 연결이라 진짜 CONCURRENTLY 중단을 재현할 수 없다).
      await db.exec(`SET allow_system_table_mods = on;`);
      await db.exec(
        `UPDATE pg_index SET indisvalid = false
          WHERE indexrelid = 'public.scope_runs_project_cycle_idx'::regclass;`,
      );
      const rows = (
        (await db.query(fs.readFileSync(CHECK_SQL, "utf8"))) as {
          rows: Array<Record<string, unknown>>;
        }
      ).rows;
      const bad = rows.filter((r) => Number(r.severity) === 2);
      expect(bad.map((r) => r.index_name)).toEqual(["scope_runs_project_cycle_idx"]);
      expect(await auditRow(db, "invalid_index")).toEqual({ n: 1, severity: 2 });
    } finally {
      await db.close();
    }
  }, 180_000);
});

// ── §회수 목록 쿼리 ─────────────────────────────────────────────────────────
describe("원장 혼재 회차의 회수 대상 run 목록 쿼리", () => {
  const LIST_SQL = path.join(SCRIPTS_DB, "answer-cycle-anchors-ledger-split-runs.sql");
  const PS = "0000ffff-0000-4000-8000-000000000006";

  it("0077 이 쓴 DB 에서 회차마다 run 하나와 회수 필요 여부를 낸다", async () => {
    // 본 회차 09-18T00:00Z 에 run 2개, 유령 회차 09-17T03:40Z 에 run 1개.
    const fx = `
INSERT INTO website_sites (brand, country_code, scope_project_id) VALUES ('Genesis', 'KR', '${PS}');
INSERT INTO summary_cycles
  (cycle_id, surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status, view_anchor_at)
VALUES ('${C(21)}', 'website', '${PS}', '2026-09-18T00:00:00Z', '2026-09-14', 'scope', 'closed', NULL),
       ('${C(22)}', 'website', '${PS}', '2026-09-17T03:40:00Z', '2026-09-14', 'scope', 'closed', NULL);
INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at) VALUES
  ('${R(41)}', '${PS}', 'completed', '2026-09-18T00:00:00Z'),
  ('${R(42)}', '${PS}', 'completed', '2026-09-18T00:00:00Z'),
  ('${R(43)}', '${PS}', 'completed', '2026-09-18T00:00:00Z');
INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at) VALUES
  ('${A(41)}', '${R(41)}', 'chatgpt', 'KR', 'completed', '2026-09-18T01:00:00Z'),
  ('${A(42)}', '${R(42)}', 'chatgpt', 'KR', 'completed', '2026-09-18T01:00:00Z'),
  ('${A(43)}', '${R(43)}', 'chatgpt', 'KR', 'completed', '2026-09-18T01:00:00Z');
INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by) VALUES
  ('${C(21)}', '${R(41)}', 'scope'),
  ('${C(21)}', '${R(42)}', 'scope'),
  ('${C(22)}', '${R(43)}', 'scope');
`;
    // 0077(min 규칙)로 먼저 쓴 뒤 0078 을 올린다 = 프로덕션의 지금 상태.
    const db = await newDb({ withV78: false, fixtures: fx });
    try {
      await refresh(db, [R(41), R(42), R(43)]);
      for (const s of statementsOf(MIGRATION_0078)) await db.exec(s);

      const rows = (
        (await db.query(fs.readFileSync(LIST_SQL, "utf8"))) as {
          rows: Array<Record<string, unknown>>;
        }
      ).rows;
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.project_id).toBe(PS);
      expect(Number(r.ledger_variants)).toBe(2);
      // 0078 규칙이 고를 앵커 = run 앵커와 같은 09-18T00:00Z → KST 09-18
      expect(r.picked_anchor_date).toBe("2026-09-18");
      // 0077 의 min 이 쓴 현재 값 = 09-17
      expect(r.current_anchor_date).toBe("2026-09-17");
      expect(r.needs_recovery).toBe(true);
      expect([R(41), R(42), R(43)]).toContain(String(r.recover_run_id));
      expect(Number(r.answers)).toBe(3);

      // 그 run 하나를 넘기면 실제로 회수된다.
      await refresh(db, [String(r.recover_run_id)]);
      const after = (await db.query(
        `SELECT DISTINCT anchor_date::text AS d FROM scope_answer_cycle_anchors
          WHERE project_id = '${PS}'`,
      )) as { rows: unknown[] };
      expect(after.rows).toEqual([{ d: "2026-09-18" }]);
      // 회수 뒤에는 목록이 "회수 필요 없음"으로 바뀐다.
      const rows2 = (
        (await db.query(fs.readFileSync(LIST_SQL, "utf8"))) as {
          rows: Array<Record<string, unknown>>;
        }
      ).rows;
      expect(rows2.map((x) => x.needs_recovery)).toEqual([false]);
    } finally {
      await db.close();
    }
  }, 180_000);
});

// ── §0078 적용 순서 ─────────────────────────────────────────────────────────
describe("0078 은 0077 백필 뒤에 적용해도 기존 행을 바꾸지 않는다", () => {
  it("적용 전후 스냅샷이 같고, 상태 표가 지연 부트스트랩된다", async () => {
    // ① 0077 만으로 백필한 상태를 만든다.
    const db = await newDb({ withV78: false, fixtures: BASE + SOLO_RUN });
    try {
      await db.exec(ADD_REGISTRY);
      await refresh(db, [R(1), R(2), R(3), R(9)]);
      const before = await snapshot(db);
      expect((before.anchors as unknown[]).length).toBe(7);

      // ② 그 DB 에 0078 을 적용한다(스모크 호출 포함).
      for (const s of statementsOf(MIGRATION_0078)) await db.exec(s);
      expect(await snapshot(db), "0078 적용만으로 기존 행이 바뀌었다").toEqual(before);

      // ③ 적용 후 첫 재계산 — 상태 표가 채워지고 행은 그대로다.
      const wrote = await refresh(db, [R(1)]);
      expect(wrote, "재계산이 같은 값을 다시 썼다").toBe(0);
      expect(await snapshot(db), "0078 재계산이 기존 행을 바꿨다").toEqual(before);

      const st = (await db.query(
        `SELECT count(*)::int AS n FROM scope_cycle_anchor_state`,
      )) as { rows: Array<Record<string, unknown>> };
      expect(Number(st.rows[0].n)).toBeGreaterThan(0);
      // 레지스트리 요약도 부트스트랩된다(회차를 넓히면서 전 run 을 훑는다).
      const reg = (await db.query(
        `SELECT run_id::text AS run_id FROM scope_cycle_registry_runs ORDER BY 1`,
      )) as { rows: Array<Record<string, string>> };
      expect(reg.rows.map((r) => r.run_id)).toEqual([R(2)]);
    } finally {
      await db.close();
    }
  }, 180_000);
});
