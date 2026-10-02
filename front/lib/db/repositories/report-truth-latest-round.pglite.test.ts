/**
 * 발행값 경로의 **최신 회차 판정** — 진짜 Postgres(pglite)에서 실행해 확인한다.
 *
 * ── 왜 이 파일이 필요한가 (2026-09-20 프리뷰 실측) ──────────────────────────
 * website 인용 화면을 **무기간**으로 열면 발행값이 아니라 라이브가 나왔다
 * (타겟 57.5% · 자사 90.2%). 기간을 2026-09-11 하루로 지정하면 발행값
 * (58.5% · 79.1%)이 정상으로 나왔다.
 *
 * 원인: `latestVisibleWebsiteRound` 가 노출 게이트(`view_anchor_date <= 오늘`)만 걸고
 * `max(round_date)` 를 내 **2026-09-18** 을 골랐다. 그런데 website 9/18 회차는 원장에서
 * 숨김(`hidden_reason` 있음 · `hidden_scope='all'`)이라 화면의 실제 최신 회차는
 * **2026-09-11** 이다. 발행물은 09-11 에 있으므로 무기간 기본 화면은 발행값이 맞다.
 *
 * 즉 "노출됐는가" 와 "화면이 고를 수 있는가" 가 다른 술어인데 두 벌을 썼다. 수리는
 * 화면이 쓰는 함수(`scope-answer-anchors.ts::selectableAnchorDatesSql`)를 그대로
 * 부르는 것이고, 이 테스트는 그 SQL 을 **실행**해 숨김 회차가 최신일 때 앞 회차를
 * 고르는지 본다. 단위 테스트(`db.execute` mock)로는 이 결함이 안 잡혔다 —
 * SQL 이 실제로 무엇을 고르는지가 결함의 본체이기 때문이다.
 *
 * 문장이 **파싱·실행된다**는 것도 여기서 함께 확인된다(배열 바인드가 `($1,$2,…)` 로
 * 펼쳐져 `::uuid[]` 캐스트가 깨지던 형태 — 2026-09-20 프리뷰 22P02 계열 재발 방지).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import {
  anchorLedgerServableSql,
  anchorNotHiddenSql,
  selectableAnchorDatesSql,
} from "./scope-answer-anchors";

const dialect = new PgDialect();

const PW = "0000bbbb-0000-4000-8000-000000000002";
const OTHER = "0000cccc-0000-4000-8000-000000000003";
const C = (n: number) => `22220000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = (n: number) => `33330000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * 이 SQL 이 만지는 **최소 스키마**. 컬럼 이름·타입은 원본(0077 · 0059 · 0070 · 0071)과
 * 같게 두되, 이 문장이 안 보는 열은 싣지 않는다.
 */
const SCHEMA = `
CREATE TABLE scope_answer_cycle_anchors (
  job_id            uuid PRIMARY KEY,
  run_id            uuid,
  project_id        uuid,
  surface           text NOT NULL,
  anchor_date       date NOT NULL,
  round_date        date NOT NULL,
  view_anchor_date  date,
  cycle_id          uuid,
  is_default_engine boolean NOT NULL DEFAULT true
);
CREATE TABLE summary_cycles (
  cycle_id            uuid PRIMARY KEY,
  surface             text NOT NULL,
  project_id          uuid,
  fleet_visible       boolean NOT NULL DEFAULT true,
  view_anchor_at      timestamptz,
  active_generation_id uuid,
  hidden_reason       text,
  hidden_scope        text
);
-- 0077 의 날짜 함수 중 이 문장이 부르는 것 하나(KST 오늘).
CREATE OR REPLACE FUNCTION hmg_anchor_today() RETURNS date
LANGUAGE sql STABLE AS $fn$ SELECT (now() AT TIME ZONE 'Asia/Seoul')::date $fn$;
`;

/**
 * 09-11(정상)과 09-18(숨김) 두 회차. 둘 다 **노출은 됐다**(`view_anchor_date` 가
 * 과거) — 그래서 노출 게이트만 보는 술어는 09-18 을 고른다.
 */
const FIXTURE = `
INSERT INTO summary_cycles
  (cycle_id, surface, project_id, fleet_visible, view_anchor_at, active_generation_id, hidden_reason, hidden_scope)
VALUES
  ('${C(11)}', 'website', '${PW}', true, '2026-09-13T00:00:00Z', '${A(900)}', NULL, NULL),
  ('${C(18)}', 'website', '${PW}', true, '2026-09-20T00:00:00Z', '${A(901)}', '측정 미완', 'all');
INSERT INTO scope_answer_cycle_anchors
  (job_id, run_id, project_id, surface, anchor_date, round_date, view_anchor_date, cycle_id, is_default_engine)
VALUES
  ('${A(1)}', '${A(1)}', '${PW}', 'website', '2026-09-11', '2026-09-11', '2026-09-13', '${C(11)}', true),
  ('${A(2)}', '${A(2)}', '${PW}', 'website', '2026-09-18', '2026-09-18', '2026-09-20', '${C(18)}', true);
`;

type Db = {
  query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (s: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function newDb(extra = ""): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite() as unknown as Db;
  await db.exec(SCHEMA);
  await db.exec(FIXTURE);
  if (extra) await db.exec(extra);
  return db;
}

/** 리더와 **같은 경로**로 SQL 을 만들어 실행한다(술어를 테스트에 복사하지 않는다). */
async function selectableDates(db: Db, projectIds: string[]): Promise<string[]> {
  const notHidden = await anchorNotHiddenSql("citations");
  const ledgerServable = await anchorLedgerServableSql();
  const q = dialect.sqlToQuery(
    selectableAnchorDatesSql("website", projectIds, {}, notHidden, ledgerServable),
  );
  const res = await db.query(q.sql, q.params as unknown[]);
  return (res.rows as Array<{ d: string | null }>)
    .map((r) => r.d)
    .filter((d): d is string => typeof d === "string");
}

/** `latestVisibleWebsiteRound` 이 하는 것 = 오름차순 목록의 마지막. */
const latest = (dates: string[]) => (dates.length > 0 ? dates[dates.length - 1] : null);

beforeEach(() => {
  resetColumnAvailabilityForTests();
  // 함대 게이트(`anchorLedgerServableSql`)는 이 프로브가 true 여야 술어를 낸다 —
  // 안 켜면 `sql`true`` 로 컴파일돼 게이트가 **조용히 사라진다**(fleet-gate.test 와 같은 설정).
  setColumnAvailabilityForTests("summary_cycle_runs", "attributed_by", true);
  setColumnAvailabilityForTests("summary_cycles", "hidden_reason", true);
  setColumnAvailabilityForTests("summary_cycles", "hidden_scope", true);
});
afterEach(() => resetColumnAvailabilityForTests());

describe("최신 회차 판정 — 숨김 회차가 최신일 때", () => {
  it("**09-18 이 숨김이면 09-11 을 고른다** (프리뷰 실측의 회귀 가드)", async () => {
    const db = await newDb();
    try {
      const dates = await selectableDates(db, [PW]);
      expect(dates).toEqual(["2026-09-11"]);
      expect(latest(dates)).toBe("2026-09-11");
    } finally {
      await db.close();
    }
  }, 120_000);

  it("**변이**: 숨김을 풀면 09-18 이 최신이 된다 (가드가 죽어 있지 않다)", async () => {
    const db = await newDb(
      `UPDATE summary_cycles SET hidden_reason = NULL, hidden_scope = NULL WHERE cycle_id = '${C(18)}';`,
    );
    try {
      const dates = await selectableDates(db, [PW]);
      expect(dates).toEqual(["2026-09-11", "2026-09-18"]);
      expect(latest(dates)).toBe("2026-09-18");
    } finally {
      await db.close();
    }
  }, 120_000);

  it("`hidden_scope='citations'` 도 인용 화면에서는 숨긴다 (계열이 citations 다)", async () => {
    const db = await newDb(
      `UPDATE summary_cycles SET hidden_scope = 'citations' WHERE cycle_id = '${C(18)}';`,
    );
    try {
      expect(latest(await selectableDates(db, [PW]))).toBe("2026-09-11");
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe("최신 회차 판정 — 나머지 게이트도 같은 한 벌이다", () => {
  it("함대 서빙 불가(활성 세대 없음)면 그 회차를 안 고른다", async () => {
    const db = await newDb(
      `UPDATE summary_cycles SET hidden_reason = NULL, hidden_scope = NULL, active_generation_id = NULL WHERE cycle_id = '${C(18)}';`,
    );
    try {
      expect(latest(await selectableDates(db, [PW]))).toBe("2026-09-11");
    } finally {
      await db.close();
    }
  }, 120_000);

  it("`fleet_visible = false` 면 그 회차를 안 고른다", async () => {
    const db = await newDb(
      `UPDATE summary_cycles SET hidden_reason = NULL, hidden_scope = NULL, fleet_visible = false WHERE cycle_id = '${C(18)}';`,
    );
    try {
      expect(latest(await selectableDates(db, [PW]))).toBe("2026-09-11");
    } finally {
      await db.close();
    }
  }, 120_000);

  it("아직 노출 안 된 회차(미래 view_anchor)는 안 고른다", async () => {
    const db = await newDb(
      `UPDATE summary_cycles SET hidden_reason = NULL, hidden_scope = NULL WHERE cycle_id = '${C(18)}';
       UPDATE scope_answer_cycle_anchors SET view_anchor_date = hmg_anchor_today() + 30 WHERE cycle_id = '${C(18)}';`,
    );
    try {
      expect(latest(await selectableDates(db, [PW]))).toBe("2026-09-11");
    } finally {
      await db.close();
    }
  }, 120_000);

  it("옵트인 엔진만 있는 회차는 안 고른다 (기본 엔진 범위)", async () => {
    const db = await newDb(
      `UPDATE summary_cycles SET hidden_reason = NULL, hidden_scope = NULL WHERE cycle_id = '${C(18)}';
       UPDATE scope_answer_cycle_anchors SET is_default_engine = false WHERE cycle_id = '${C(18)}';`,
    );
    try {
      expect(latest(await selectableDates(db, [PW]))).toBe("2026-09-11");
    } finally {
      await db.close();
    }
  }, 120_000);

  it("다른 프로젝트의 회차는 새지 않는다 (스코프)", async () => {
    const db = await newDb(
      `UPDATE summary_cycles SET hidden_reason = NULL, hidden_scope = NULL WHERE cycle_id = '${C(18)}';`,
    );
    try {
      expect(await selectableDates(db, [OTHER])).toEqual([]);
      expect(latest(await selectableDates(db, [OTHER]))).toBeNull();
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe("문장이 실제로 파싱·실행된다 (배열 바인드)", () => {
  it("project id 가 **단일 파라미터**로 나간다 — ($1,$2,…) 로 펼쳐지지 않는다", () => {
    const q = dialect.sqlToQuery(
      selectableAnchorDatesSql("website", [PW, OTHER], {}),
    );
    // `uuidArray`(scope-answer-anchors.ts:384) 가 `sql.param` 을 쓴다 — 배열 하나가
    // **파라미터 하나**로 나가고, `($1, $2, …)` 레코드로 펼쳐지지 않는다.
    expect(q.sql).toMatch(/project_id = ANY\(\$\d+::uuid\[\]\)/);
    expect(q.sql).not.toMatch(/ANY\(\(\$\d+,\s*\$\d+/);
    expect(q.params).toContainEqual([PW, OTHER]);
  });

  it("여러 project id 로도 PREPARE 가 된다 (캐스트가 깨지지 않는다)", async () => {
    const db = await newDb();
    try {
      const notHidden = await anchorNotHiddenSql("citations");
      const ledgerServable = await anchorLedgerServableSql();
      const q = dialect.sqlToQuery(
        selectableAnchorDatesSql("website", [PW, OTHER], {}, notHidden, ledgerServable),
      );
      // PREPARE 는 **플래너까지** 태운다 — 실행 결과와 별개로 문장이 유효한지 본다.
      await db.query(`PREPARE p_latest AS ${q.sql.replace(/\$(\d+)/g, "$$$1")}`, []);
      await db.query("DEALLOCATE p_latest", []);
      // 그리고 실제로 돌려서 값까지 본다(09-18 은 숨김이라 09-11).
      expect(latest(await selectableDates(db, [PW, OTHER]))).toBe("2026-09-11");
    } finally {
      await db.close();
    }
  }, 120_000);
});
