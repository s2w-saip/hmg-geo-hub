import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 정규 요일 귀속 배정(0077 `hmg_assign_cycle_rounds`)을 **실행으로** 검증한다.
 *
 * 왜 실행인가: 배정은 "정규 요일 회차를 먼저 앉히고, 비정규를 이른 순으로 차례
 * 배정한다" 는 **절차**다. 텍스트 대조로는 분기 순서밖에 못 본다 — 차례 배정이
 * 실제로 자리를 물려주는지, 빈 자리가 "가까운 쪽"을 이기는지는 돌려 봐야 한다.
 *
 * 그래서 파서·플래너·plpgsql 을 가진 진짜 Postgres(pglite = wasm 빌드)에 **마이그레이션
 * 파일의 문장을 그대로** 실행한다. 규칙 구현을 테스트에 한 벌 더 적지 않는다 —
 * 두 벌이 되는 순간 이 테스트는 자기 자신을 검사하게 된다.
 *
 * 기대값은 전부 **손계산 리터럴**이다(2026년 달력):
 *   · 월요일 08-24 · 08-31 · 09-07 · 09-14 · 09-21
 *   · 금요일 07-10 · 07-17 · 07-31 · 09-11 · 09-18 · 09-25 · 10-02
 *   · 2026-09-17 목 · 09-08 화 · 07-11 토 · 07-12 일 · 08-03 월 · 10-01 목
 */
const MIGRATION = path.resolve(__dirname, "0077_scope_answer_cycle_anchors.sql");
const raw = fs.readFileSync(MIGRATION, "utf8");

/**
 * 이 테스트가 실행하는 문장 — 매핑 표 DDL·인덱스·귀속 함수 4개·배정 함수.
 * `REVOKE` 는 pglite 에 없는 롤(anon/authenticated)을 가리키므로 뺀다.
 */
const NEEDED =
  /DO \$ddl_rounds\$|DO \$idx_rounds\$|CREATE OR REPLACE FUNCTION hmg_round_|CREATE OR REPLACE FUNCTION hmg_assign_cycle_rounds/;

const statements = raw
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => NEEDED.test(s));

/** 배정 함수가 후보를 읽는 표. 배정에 필요한 컬럼만 둔 축소판이다. */
const STUB_ANCHORS = `
  CREATE TABLE scope_answer_cycle_anchors (
    job_id      uuid PRIMARY KEY,
    run_id      uuid NOT NULL,
    project_id  uuid,
    surface     text NOT NULL,
    anchor_date date NOT NULL,
    round_date  date NOT NULL
  )`;

type Round = { anchor_date: string; round_date: string; basis: string };

async function freshDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(STUB_ANCHORS);
  for (const s of statements) await db.exec(s);
  return db;
}

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";

/** 회차 하나 = 답변 행 하나로 충분하다(배정은 DISTINCT 로 회차를 뽑는다). */
async function seed(
  db: Awaited<ReturnType<typeof freshDb>>,
  project: string,
  surface: string,
  dates: string[],
): Promise<void> {
  for (const d of dates) {
    await db.query(
      `INSERT INTO scope_answer_cycle_anchors
         (job_id, run_id, project_id, surface, anchor_date, round_date)
       VALUES (gen_random_uuid(), gen_random_uuid(), $1::uuid, $2, $3::date, $3::date)`,
      [project, surface, d],
    );
  }
}

async function assign(
  db: Awaited<ReturnType<typeof freshDb>>,
  projects: string[],
): Promise<Round[]> {
  await db.query(`SELECT hmg_assign_cycle_rounds(NULL::uuid[], $1::uuid[])`, [projects]);
  const res = await db.query<Round>(
    `SELECT anchor_date::text AS anchor_date, round_date::text AS round_date, basis
       FROM scope_cycle_rounds WHERE project_id = ANY($1::uuid[]) ORDER BY anchor_date`,
    [projects],
  );
  return res.rows;
}

describe("정규 요일 귀속 배정 — 실행 검증 (pglite)", () => {
  it("마이그레이션에서 실행할 문장을 실제로 뽑았다 (정의를 테스트에 복사하지 않는다)", () => {
    // 매핑 표 DDL 1 + 인덱스 1 + 귀속 함수 4(dow·prev·next·date_of) + 배정 1 = 7
    expect(statements).toHaveLength(7);
    expect(statements.join("\n")).toContain("hmg_assign_cycle_rounds(p_run_ids uuid[]");
  });

  it("(a) 웹사이트 09-11(금)·09-17(목)·09-18(금) → 09-17 은 09-18 에 합쳐진다", async () => {
    const db = await freshDb();
    await seed(db, P1, "website", ["2026-09-11", "2026-09-17", "2026-09-18"]);
    const rows = await assign(db, [P1]);
    expect(rows).toEqual([
      { anchor_date: "2026-09-11", round_date: "2026-09-11", basis: "canonical" },
      // 앞 자리 09-11·뒤 자리 09-18 이 **둘 다 찼다** → 가까운 쪽(거리 1)인 09-18 에 합친다.
      { anchor_date: "2026-09-17", round_date: "2026-09-18", basis: "merged" },
      { anchor_date: "2026-09-18", round_date: "2026-09-18", basis: "canonical" },
    ]);
    await db.close();
  });

  it("(a') 같은 09-17·09-18 이라도 09-11 자리가 비어 있으면 **앞 자리**로 간다", async () => {
    // 규칙은 "빈 자리 우선"이라 거리(09-18 이 1일, 09-11 이 6일)보다 공석이 먼저다.
    // 실측에서 그 6개 회차가 09-18 로 합쳐진 것은 09-11 회차도 함께 있었기 때문이다.
    const db = await freshDb();
    await seed(db, P1, "website", ["2026-09-17", "2026-09-18"]);
    const rows = await assign(db, [P1]);
    expect(rows).toEqual([
      { anchor_date: "2026-09-17", round_date: "2026-09-11", basis: "prev_empty" },
      { anchor_date: "2026-09-18", round_date: "2026-09-18", basis: "canonical" },
    ]);
    await db.close();
  });

  it("(b) 글로벌 09-08(화)·09-14(월), 09-07 없음 → 09-08 은 09-07", async () => {
    const db = await freshDb();
    await seed(db, P1, "standard", ["2026-09-08", "2026-09-14"]);
    const rows = await assign(db, [P1]);
    expect(rows).toEqual([
      { anchor_date: "2026-09-08", round_date: "2026-09-07", basis: "prev_empty" },
      { anchor_date: "2026-09-14", round_date: "2026-09-14", basis: "canonical" },
    ]);
    await db.close();
  });

  it("(c) 웹사이트 07-11(토)·07-12(일) → 07-10 과 07-17 로 갈린다 (빈 자리가 거리보다 우선)", async () => {
    const db = await freshDb();
    await seed(db, P1, "website", ["2026-07-11", "2026-07-12"]);
    const rows = await assign(db, [P1]);
    expect(rows).toEqual([
      // 이른 회차가 먼저: 앞 07-10(거리 1)·뒤 07-17(거리 6) 둘 다 비어 가까운 쪽.
      { anchor_date: "2026-07-11", round_date: "2026-07-10", basis: "nearest" },
      // 그 다음 회차는 **앞 자리가 이미 찼다** → 가까운 쪽(07-10)에 합치지 않고 빈 07-17 로.
      { anchor_date: "2026-07-12", round_date: "2026-07-17", basis: "next_empty" },
    ]);
    await db.close();
  });

  it("(d) 이미 배정된 회차는 새 회차가 들어와도 움직이지 않는다", async () => {
    const db = await freshDb();
    await seed(db, P1, "website", ["2026-09-17"]);
    // 혼자면 앞뒤가 다 비어 가까운 쪽(09-18, 거리 1)으로 간다.
    expect(await assign(db, [P1])).toEqual([
      { anchor_date: "2026-09-17", round_date: "2026-09-18", basis: "nearest" },
    ]);
    // 나중에 09-18 회차가 들어와도 **09-17 의 귀속은 그대로**다(과거 값 안정성).
    await seed(db, P1, "website", ["2026-09-18"]);
    expect(await assign(db, [P1])).toEqual([
      { anchor_date: "2026-09-17", round_date: "2026-09-18", basis: "nearest" },
      { anchor_date: "2026-09-18", round_date: "2026-09-18", basis: "canonical" },
    ]);
    await db.close();
  });

  it("(e) 프로젝트 표면은 정규 요일이 없다 — anchor_date 그대로", async () => {
    const db = await freshDb();
    await seed(db, P1, "project", ["2026-09-16", "2026-09-17"]);
    expect(await assign(db, [P1])).toEqual([
      { anchor_date: "2026-09-16", round_date: "2026-09-16", basis: "project" },
      { anchor_date: "2026-09-17", round_date: "2026-09-17", basis: "project" },
    ]);
    await db.close();
  });

  it("(f) 귀속으로 **달이 바뀐다** — 웹사이트 08-03(월) → 07-31, 10-01(목) → 10-02", async () => {
    const db = await freshDb();
    await seed(db, P1, "website", ["2026-08-03"]);
    await seed(db, P2, "website", ["2026-10-01"]);
    const rows = await assign(db, [P1, P2]);
    expect(rows).toEqual([
      // 앞 07-31(거리 3) vs 뒤 08-07(거리 4) → 가까운 앞쪽. 월 귀속은 **7월**이 된다.
      { anchor_date: "2026-08-03", round_date: "2026-07-31", basis: "nearest" },
      // 앞 09-25(거리 6) vs 뒤 10-02(거리 1) → 뒤쪽. 월 귀속은 같은 10월이다.
      { anchor_date: "2026-10-01", round_date: "2026-10-02", basis: "nearest" },
    ]);
    const months = await db.query<{ a: string; m: string }>(
      `SELECT anchor_date::text AS a, date_trunc('month', round_date::timestamp)::date::text AS m
         FROM scope_cycle_rounds ORDER BY anchor_date`,
    );
    expect(months.rows).toEqual([
      { a: "2026-08-03", m: "2026-07-01" },
      { a: "2026-10-01", m: "2026-10-01" },
    ]);
    await db.close();
  });

  it("프로젝트끼리 자리를 다투지 않는다 — 점유는 프로젝트 단위다", async () => {
    const db = await freshDb();
    // 같은 09-14(월) 회차가 프로젝트 사정에 따라 다른 자리로 간다.
    await seed(db, P1, "website", ["2026-09-11", "2026-09-14"]);
    await seed(db, P2, "website", ["2026-09-14"]);
    const rows = await assign(db, [P1, P2]);
    const byProject = await db.query<{ p: string; a: string; r: string; b: string }>(
      `SELECT project_id::text AS p, anchor_date::text AS a, round_date::text AS r, basis AS b
         FROM scope_cycle_rounds ORDER BY project_id, anchor_date`,
    );
    expect(rows).toHaveLength(3);
    expect(byProject.rows).toEqual([
      { p: P1, a: "2026-09-11", r: "2026-09-11", b: "canonical" },
      // P1: 앞 자리 09-11 이 차 있어 뒤 09-18 로(거리로는 앞이 3일, 뒤가 4일인데도).
      { p: P1, a: "2026-09-14", r: "2026-09-18", b: "next_empty" },
      // P2: 앞뒤가 다 비어 가까운 쪽 09-11 로. **다른 프로젝트의 점유를 보지 않는다.**
      { p: P2, a: "2026-09-14", r: "2026-09-11", b: "nearest" },
    ]);
    await db.close();
  });

  it("run 축으로 불러도 같은 결과다 (증분 경로)", async () => {
    const db = await freshDb();
    await seed(db, P1, "website", ["2026-09-18"]);
    const runs = await db.query<{ run_id: string }>(
      `SELECT run_id::text AS run_id FROM scope_answer_cycle_anchors`,
    );
    await db.query(`SELECT hmg_assign_cycle_rounds($1::uuid[], NULL::uuid[])`, [
      runs.rows.map((r) => r.run_id),
    ]);
    const res = await db.query<Round>(
      `SELECT anchor_date::text AS anchor_date, round_date::text AS round_date, basis
         FROM scope_cycle_rounds`,
    );
    expect(res.rows).toEqual([
      { anchor_date: "2026-09-18", round_date: "2026-09-18", basis: "canonical" },
    ]);
    await db.close();
  });

  it("두 범위 인자가 다 NULL 이면 조용히 0 을 돌려주지 않고 끊는다", async () => {
    const db = await freshDb();
    await expect(
      db.query(`SELECT hmg_assign_cycle_rounds(NULL::uuid[], NULL::uuid[])`),
    ).rejects.toThrow(/둘 다 NULL/);
    await db.close();
  });
});
