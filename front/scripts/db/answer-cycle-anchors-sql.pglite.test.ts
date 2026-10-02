import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { splitDryRunStatements } from "./answer-cycle-anchors-dryrun-split";
import {
  type CycleRow,
  WORKLIST_SQL,
  planBatches,
} from "./answer-cycle-anchors-batching";
// 토대(기존 표 DDL·문장 분리·pglite 기동)는 0078 테스트와 **한 곳**을 쓴다.
import {
  MIG_DIR,
  MIGRATION_0077,
  MIGRATION_0078,
  type PgliteDb,
  migrationStatements,
  newDb,
} from "./answer-cycle-anchors-pglite-fixture";

/**
 * 0077 계열 SQL 을 **진짜 Postgres(pglite = wasm 빌드)에서 실행**한다.
 *
 * 왜 이 파일이 생겼나: 종전 검증은 전부 **텍스트 대조**였고, 그래서 실 DB 에서만
 * 드러나는 문법·타입 결함을 **두 번** 놓쳤다.
 *   ① `min(uuid)` 부재 — 이 DB 에 uuid min/max 집계가 없다
 *   ② `a.target = ANY((SELECT engines FROM de))` — `ANY` 에 스칼라 **서브쿼리**를 주면
 *      배열이 펼쳐지지 않고 서브쿼리의 **행 값**(text[])과 비교돼
 *      `42883 operator does not exist: text = text[]` 로 S4·S5 가 통째로 죽었다
 *      (2026-09-19 프로덕션 미러, PostgreSQL 17.6 실측)
 * 둘 다 "문장을 한 번 돌려보기만 했으면" 즉시 드러난다. 그래서 여기서 돌린다.
 *
 * 무엇을 실행하는가:
 *   · 0077 마이그레이션 문장 전부(REVOKE 제외 — pglite 에 anon/authenticated 롤이 없다)
 *   · dry-run SQL 의 문장 전부(S1~S5) — 분리는 백필 스크립트와 **같은 분리기**를 쓴다
 *   · 감사 SQL 1문장
 *   · 백필·재배정 스크립트가 발행하는 SQL 전부(소스에서 추출 — 사본을 두지 않는다)
 *   · `refresh_answer_cycle_anchors()` 실제 호출과 그 결과 테이블
 *
 * 기대값은 전부 **손계산 리터럴**이다(픽스처는 아래 §fixtures, KST = UTC+9):
 *   · 2026-09-07 월 · 09-14 월 · 09-11 금 · 09-18 금 · 09-15 화 · 09-17 목
 */

const DRYRUN_SQL = path.resolve(__dirname, "answer-cycle-anchors-dryrun.sql");
const AUDIT_SQL = path.resolve(__dirname, "answer-cycle-anchors-audit.sql");

/**
 * 백필·재배정 스크립트가 **실제로 발행하는** SQL 을 소스에서 뽑는다.
 * 바인드 자리(`${…}`)는 빈 배열·NULL 로 바꾼다 — 행은 0이지만 PG 는 파싱·계획하므로
 * 타입·함수·컬럼 부재가 그대로 드러난다(0077 의 적용 시점 스모크와 같은 논리).
 */
const BIND: Record<string, string> = {
  ids: "'{}'",
  runIds: "'{}'",
  projects: "'{}'",
  ROOT_PROJECT_ID: "NULL",
  FROM: "NULL",
  TO: "NULL",
  // lib/scope/anchor-worklist.ts 의 조립 자리: 빈 값이면 전 테이블 WORKLIST_SQL 이다.
  preCtes: "",
  runFilter: "",
  having: "",
};

function scriptStatements(file: string): string[] {
  const code = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const out: string[] = [];
  for (const m of code.matchAll(/`([^`]*)`/g)) {
    const body = m[1];
    if (!/^\s*(WITH|SELECT|DELETE|INSERT|UPDATE)\b/i.test(body)) continue;
    out.push(
      body.replace(/\$\{([^}]*)\}/g, (_all, expr: string) => {
        const key = expr.trim();
        if (!(key in BIND)) {
          throw new Error(
            `${path.basename(file)} 의 SQL 에 모르는 바인드 자리 \${${key}} 가 있다 — BIND 에 등록할 것`,
          );
        }
        return BIND[key];
      }),
    );
  }
  if (out.length === 0) throw new Error(`${file} 에서 SQL 을 못 뽑았다`);
  return out;
}

// ── §fixtures ────────────────────────────────────────────────────────────────
const PG = "0000aaaa-0000-4000-8000-000000000001"; // 글로벌 루트 (standard)
const PW = "0000bbbb-0000-4000-8000-000000000002"; // 웹사이트 (website)
const PP = "0000cccc-0000-4000-8000-000000000003"; // 프로젝트 (project)
const R1 = "11111111-0000-4000-8000-000000000001";
const R2 = "11111111-0000-4000-8000-000000000002";
const R3 = "11111111-0000-4000-8000-000000000003";
const R4 = "11111111-0000-4000-8000-000000000004";
const R5 = "11111111-0000-4000-8000-000000000005"; // project_id NULL
const RX = "11111111-0000-4000-8000-0000000000ff"; // scope_runs 에 없는 run
const C1 = "22222222-0000-4000-8000-000000000001";
const C2 = "22222222-0000-4000-8000-000000000002";
const A = (n: number) => `33333333-0000-4000-8000-00000000000${n}`;

/**
 * 픽스처 (KST = UTC+9). 앵커 날짜·귀속 자리는 전부 손계산이다:
 *   R1 ledger   PG standard  2026-09-14T01:00Z → KST 09-14(월, 정규)  → 자리 09-14
 *   R4 registry PG standard  회차 09-06T16:00Z → KST 09-07(월, 정규)  → 자리 09-07
 *               (0053 레지스트리 anchor 는 UTC 날짜 09-06 → 회차를 찾아 KST 로 이관)
 *   R2 run      PW website   2026-09-16T15:30Z → KST 09-17(목, 비정규) → 앞 09-11·뒤 09-18
 *               둘 다 비었고 뒤가 1일로 더 가깝다 → 자리 09-18 (basis nearest)
 *   R3 fallback PP project   회차 앵커 없음 · measured 09-15T02:00Z → KST 09-15 → 자리 09-15
 *   R5          project_id NULL  → 제외
 *   RX          scope_runs 행 없음 → 제외
 */
const FIXTURES = `
INSERT INTO projects (name, country, scope_project_id) VALUES
  ('root', 'KR', '${PG}'),          -- 글로벌 루트도 projects 에 한 행 있다(표면 판정 순서 함정)
  ('proj', 'KR', '${PP}');
INSERT INTO website_sites (brand, country_code, scope_project_id) VALUES
  ('Hyundai', 'KR', '${PW}');
INSERT INTO summary_cycles
  (cycle_id, surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status, view_anchor_at)
VALUES
  ('${C1}', 'global', '${PG}', '2026-09-14T01:00:00Z', '2026-09-14', 'scope', 'published',
   '2026-09-16T01:00:00Z'),
  ('${C2}', 'global', '${PG}', '2026-09-06T16:00:00Z', '2026-09-07', 'scope', 'closed', NULL);
INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by) VALUES
  ('${C1}', '${R1}', 'scope'),
  ('${C2}', '${R4}', 'scope');
INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at) VALUES
  ('${R1}', '${PG}', 'completed', '2026-09-14T01:00:00Z'),
  ('${R2}', '${PW}', 'completed', '2026-09-16T15:30:00Z'),
  ('${R3}', '${PP}', 'completed', NULL),
  ('${R4}', '${PG}', 'completed', '2026-09-06T16:00:00Z'),
  ('${R5}', NULL,    'completed', '2026-09-14T01:00:00Z');
INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at) VALUES
  ('${A(1)}', '${R1}', 'chatgpt',  'KR', 'completed', '2026-09-14T02:00:00Z'),
  ('${A(2)}', '${R1}', 'deepseek', 'KR', 'completed', '2026-09-14T02:05:00Z'),
  ('${A(3)}', '${R2}', 'gemini',   'KR', 'completed', '2026-09-16T15:35:00Z'),
  ('${A(4)}', '${R3}', 'chatgpt',  'KR', 'completed', '2026-09-15T02:00:00Z'),
  ('${A(5)}', '${R4}', 'chatgpt',  'KR', 'completed', '2026-09-06T16:05:00Z'),
  ('${A(6)}', '${RX}', 'chatgpt',  'KR', 'completed', '2026-09-14T02:00:00Z'),
  ('${A(7)}', '${R5}', 'chatgpt',  'KR', 'completed', '2026-09-14T02:00:00Z');
INSERT INTO scope_answer_anchors (job_id, anchor, source_measured_at, reason) VALUES
  ('${A(5)}', '2026-09-06', '2026-09-06T16:05:00Z', 'manual-fold');
`;

type Db = PgliteDb;

/**
 * ⚠️ 0077 **과 0078** 을 함께 올린다(2026-09-20). 프로덕션은 두 파일이 다 적용된
 * 상태이고, 감사 SQL 은 0078 의 `hmg_cycle_key`·회차 상태 표를 읽는다 — 0077 만
 * 올린 DB 로 감사를 돌리면 이제 "테스트만 도는 조합"을 검사하게 된다.
 */
async function freshDb(): Promise<Db> {
  return newDb({ withV78: true, fixtures: FIXTURES });
}

const n = (row: Record<string, unknown>, k: string) => Number(row[k]);

describe("0077 계열 SQL 실행 검증 (pglite)", () => {
  let db: Db;
  let dryrun: Array<{ name: string; sql: string }>;

  beforeAll(async () => {
    db = await freshDb();
    dryrun = splitDryRunStatements(fs.readFileSync(DRYRUN_SQL, "utf8"));
  }, 120_000);

  it("0077 의 모든 문장이 실제로 적용된다 (적용 시점 스모크 포함)", async () => {
    const statements = migrationStatements(fs.readFileSync(MIGRATION_0077, "utf8"));
    // 테이블 2 + 인덱스 2 + 함수 17 + 자가검증 1 + 스모크 1 + DDL 가드 1 = 24 문장
    expect(statements.length).toBe(24);
    const fns = (await db.query(
      `SELECT count(*)::int AS n FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'hmg\\_%'`,
    )) as { rows: Array<Record<string, unknown>> };
    // 0077 의 16 + 0078 의 4(cycle_key·refresh/prune_cycle_registry_runs·sync_cycle_anchor_state).
    // `refresh_answer_cycle_anchors` 는 접두사가 달라 여기 안 잡힌다.
    expect(n(fns.rows[0], "n")).toBe(20);
    expect(migrationStatements(fs.readFileSync(MIGRATION_0078, "utf8")).length).toBe(13);
    // 인덱스도 실제로 만들어졌는가 — 특히 부분 인덱스는 문법 오류가 여기서만 드러난다.
    const idx = (await db.query(
      `SELECT indexname::text AS name, indexdef::text AS def FROM pg_indexes
        WHERE tablename IN ('scope_answer_cycle_anchors', 'scope_cycle_rounds')
        ORDER BY 1`,
    )) as { rows: Array<Record<string, string>> };
    expect(idx.rows.map((r) => r.name)).toContain("scope_answer_cycle_anchors_cycle_idx");
    const cycleIdx = idx.rows.find((r) => r.name === "scope_answer_cycle_anchors_cycle_idx");
    expect(cycleIdx?.def).toMatch(/\(cycle_id\)\s+WHERE \(cycle_id IS NOT NULL\)/);
  });

  it("dry-run 문장 S1~S5 가 전부 실행된다 (문장 5개)", async () => {
    expect(dryrun.map((s) => s.name)).toEqual([
      "S1_coverage",
      "S2_registry",
      "S3_gate",
      "S4_cycles",
      "S5_rounds",
    ]);
    for (const st of dryrun) {
      const res = (await db.query(st.sql)) as { rows: unknown[] };
      expect(res.rows.length, `${st.name} 가 행을 돌려주지 않았다`).toBeGreaterThan(0);
    }
  });

  it("S1 전수 분해가 손계산과 맞는다", async () => {
    const r = ((await db.query(dryrun[0].sql)) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(n(r, "completed_answers")).toBe(7);
    expect(n(r, "rows_out")).toBe(5);
    expect(n(r, "no_run_row")).toBe(1);
    expect(n(r, "excluded_null_project")).toBe(1);
    expect(n(r, "no_source")).toBe(0);
    // 등식이 닫힌다 (백필 census() 와 같은 분해 — BLOCK-4)
    expect(
      n(r, "completed_answers") -
        n(r, "rows_out") -
        n(r, "no_run_row") -
        n(r, "excluded_null_project") -
        n(r, "no_source"),
    ).toBe(0);
    expect([
      n(r, "src_registry"),
      n(r, "src_ledger"),
      n(r, "src_run"),
      n(r, "src_fallback_measured"),
    ]).toEqual([1, 2, 1, 1]);
    // 표면 판정 순서(website → standard → project). 루트가 projects 에도 있으므로
    // 순서가 뒤집히면 sf_standard 가 0 이 되고 sf_project 가 4 가 된다.
    expect([n(r, "sf_standard"), n(r, "sf_website"), n(r, "sf_project")]).toEqual([3, 1, 1]);
    expect(n(r, "sf_unclassified")).toBe(0);
  });

  it("S2 레지스트리 이관(R1=KST)이 손계산과 맞는다", async () => {
    const r = ((await db.query(dryrun[1].sql)) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(n(r, "registry_rows")).toBe(1);
    expect(n(r, "registry_in_table")).toBe(1);
    expect(n(r, "registry_orphans")).toBe(0);
    // 0053 의 UTC 날짜 09-06 → 회차 시각을 KST 로 다시 잘라 09-07 (하루 이동)
    expect(n(r, "registry_shifted")).toBe(1);
    expect(n(r, "registry_utc_kept")).toBe(0);
    expect(n(r, "registry_unfolded")).toBe(0);
    expect(n(r, "registry_vs_auto")).toBe(1);
    expect(n(r, "registry_no_auto_anchor")).toBe(0);
  });

  it("S3 노출 게이트가 표면별로 맞는다", async () => {
    const rows = ((await db.query(dryrun[2].sql)) as { rows: Array<Record<string, unknown>> }).rows;
    const by = Object.fromEntries(rows.map((x) => [String(x.surface), x]));
    expect(Object.keys(by).sort()).toEqual(["project", "standard", "website"]);
    // standard: R1 두 건은 원장 노출일 09-16, R4 한 건은 회차 미발행 → 비노출
    expect(n(by.standard, "rows_out")).toBe(3);
    expect(n(by.standard, "view_null_cycle_unpublished")).toBe(1);
    expect(n(by.standard, "view_null_no_cycle")).toBe(0);
    expect(n(by.standard, "view_null")).toBe(1);
    // website: 회차에 안 붙은 run → 비노출
    expect(n(by.website, "rows_out")).toBe(1);
    expect(n(by.website, "view_null_no_cycle")).toBe(1);
    expect(n(by.website, "view_null")).toBe(1);
    // project: 결정 ⑫ 로 앵커+1일이 들어가 비노출이 0 이다
    expect(n(by.project, "rows_out")).toBe(1);
    expect(n(by.project, "ledger_view_missing")).toBe(1);
    expect(n(by.project, "view_null")).toBe(0);
    for (const s of ["standard", "website", "project"]) {
      expect(n(by[s], "view_future"), s).toBe(0);
      expect(n(by[s], "measured_ne_anchor"), s).toBe(0);
    }
  });

  it("S4 회차 입도 지표가 맞는다 (기본 엔진 판정 포함)", async () => {
    const r = ((await db.query(dryrun[3].sql)) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(n(r, "cycles")).toBe(4);
    expect([
      n(r, "cycles_registry"),
      n(r, "cycles_ledger"),
      n(r, "cycles_run"),
      n(r, "cycles_fallback"),
    ]).toEqual([1, 1, 1, 1]);
    expect(n(r, "cycle_registry_split")).toBe(0);
    expect(n(r, "cycle_answer_unit_split")).toBe(0);
    expect(n(r, "reg_same_own_cycle")).toBe(1);
    expect(n(r, "reg_moved_other_cycle")).toBe(0);
    expect(n(r, "reg_utc_kept")).toBe(0);
    expect(n(r, "reg_solo_no_anchor")).toBe(0);
    expect(n(r, "project_week_split")).toBe(0);
    // 네 회차 전부 chatgpt·gemini 답변을 갖는다 → 기본 엔진 한정 지표도 같다.
    expect(n(r, "project_week_split_default_engine")).toBe(0);
  });

  it("S5 정규 요일 귀속 1차 근사가 맞는다", async () => {
    const r = ((await db.query(dryrun[4].sql)) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(n(r, "round_cycles")).toBe(4);
    expect(n(r, "round_canonical")).toBe(2); // 09-14 월 · 09-07 월
    expect(n(r, "round_project")).toBe(1); // project 표면은 정규 요일이 없다
    expect(n(r, "round_offday")).toBe(1); // 09-17 목
    expect(n(r, "round_offday_website")).toBe(1);
    expect(n(r, "round_offday_standard")).toBe(0);
    expect([
      n(r, "est_prev_empty"),
      n(r, "est_next_empty"),
      n(r, "est_nearest"),
      n(r, "est_merged"),
    ]).toEqual([0, 0, 1, 0]);
    expect(n(r, "est_merged_seats")).toBe(0);
    expect(n(r, "est_collisions")).toBe(0);
    expect(n(r, "est_move_back")).toBe(0);
    expect(n(r, "est_move_fwd")).toBe(1); // 09-17 → 09-18
    expect(n(r, "est_move_max")).toBe(1);
  });

  it("refresh_answer_cycle_anchors 가 돌고 결과 행이 손계산과 맞는다", async () => {
    const w = (await db.query(
      `SELECT refresh_answer_cycle_anchors($1::uuid[], NULL)::bigint AS n`,
      [[R1, R2, R3, R4, R5]],
    )) as { rows: Array<Record<string, unknown>> };
    expect(n(w.rows[0], "n")).toBe(5);

    const res = (await db.query(
      `SELECT job_id::text AS job_id, surface, source,
              anchor_date::text AS anchor_date, round_date::text AS round_date,
              anchor_week::text AS anchor_week, anchor_month::text AS anchor_month,
              is_default_engine,
              coalesce(view_anchor_date::text, '-') AS view_anchor_date
         FROM scope_answer_cycle_anchors ORDER BY job_id`,
    )) as { rows: Array<Record<string, unknown>> };
    expect(res.rows).toEqual([
      {
        job_id: A(1), surface: "standard", source: "ledger",
        anchor_date: "2026-09-14", round_date: "2026-09-14",
        anchor_week: "2026-09-14", anchor_month: "2026-09-01",
        is_default_engine: true, view_anchor_date: "2026-09-16",
      },
      {
        job_id: A(2), surface: "standard", source: "ledger",
        anchor_date: "2026-09-14", round_date: "2026-09-14",
        anchor_week: "2026-09-14", anchor_month: "2026-09-01",
        is_default_engine: false, view_anchor_date: "2026-09-16",
      },
      {
        // 09-17(목) → 뒤 자리 09-18(금). 주 버킷은 **귀속 날짜** 기준이다.
        job_id: A(3), surface: "website", source: "run",
        anchor_date: "2026-09-17", round_date: "2026-09-18",
        anchor_week: "2026-09-14", anchor_month: "2026-09-01",
        is_default_engine: true, view_anchor_date: "-",
      },
      {
        job_id: A(4), surface: "project", source: "fallback_measured",
        anchor_date: "2026-09-15", round_date: "2026-09-15",
        anchor_week: "2026-09-14", anchor_month: "2026-09-01",
        is_default_engine: true, view_anchor_date: "2026-09-16",
      },
      {
        // 0053 UTC 날짜 09-06 → 회차를 찾아 KST 09-07(월, 정규 요일)
        job_id: A(5), surface: "standard", source: "registry",
        anchor_date: "2026-09-07", round_date: "2026-09-07",
        anchor_week: "2026-09-07", anchor_month: "2026-09-01",
        is_default_engine: true, view_anchor_date: "-",
      },
    ]);

    const rounds = (await db.query(
      `SELECT surface, anchor_date::text AS anchor_date, round_date::text AS round_date, basis
         FROM scope_cycle_rounds ORDER BY anchor_date`,
    )) as { rows: unknown[] };
    expect(rounds.rows).toEqual([
      { surface: "standard", anchor_date: "2026-09-07", round_date: "2026-09-07", basis: "canonical" },
      { surface: "standard", anchor_date: "2026-09-14", round_date: "2026-09-14", basis: "canonical" },
      { surface: "project", anchor_date: "2026-09-15", round_date: "2026-09-15", basis: "project" },
      { surface: "website", anchor_date: "2026-09-17", round_date: "2026-09-18", basis: "nearest" },
    ]);
  });

  it("감사 SQL 이 실행되고 경고·긴급 항목이 하나도 없다", async () => {
    const rows = (
      (await db.query(fs.readFileSync(AUDIT_SQL, "utf8"))) as {
        rows: Array<Record<string, unknown>>;
      }
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    const failing = rows.filter((r) => Number(r.severity) > 0);
    expect(failing, JSON.stringify(failing)).toEqual([]);
    const basis = rows
      .filter((r) => String(r.check).startsWith("basis/"))
      .map((r) => `${r.check}=${r.n}`)
      .sort();
    expect(basis).toEqual([
      "basis/project/project=1",
      "basis/standard/canonical=2",
      "basis/website/nearest=1",
    ]);
  });

  it("백필·재배정 스크립트가 발행하는 SQL 이 전부 실행된다", async () => {
    const files = [
      path.resolve(__dirname, "backfill-answer-cycle-anchors.ts"),
      path.resolve(__dirname, "reassign-cycle-rounds.ts"),
      // 작업 목록 SQL 의 정본(회차 키 정의를 0077 과 한 곳에서 맞추기 위해). 배치 모듈은
      // 이것을 다시 내보낸다. 크론 따라잡기의 창 변형은 CTE 조각이라 여기서 뽑히지 않는다.
      path.resolve(__dirname, "../../lib/scope/anchor-worklist.ts"),
    ];
    const statements = files.flatMap(scriptStatements);
    // 새 쿼리를 추가했으면 이 수도 올린다(추출이 조용히 0 으로 줄어드는 것을 막는다).
    expect(statements.length).toBe(30);
    await db.exec("BEGIN");
    try {
      for (const s of statements) {
        await db.query(s); // 빈 배열 바인드라 0행이지만 파싱·계획·타입 검사는 전부 탄다
      }
    } finally {
      await db.exec("ROLLBACK");
    }
  });
});

// ── B-1 재현 ────────────────────────────────────────────────────────────────
/**
 * `refresh_answer_cycle_anchors` 는 받은 run 을 **회차 전체**(같은 project_id + 같은
 * `cycle_anchor_at`)로 넓혀 쓴다. 그래서 배치가 회차를 자르면 함수가 돌려주는 rowcount
 * 가 배치 밖 답변까지 세고, 백필의 상한 단언(`n > cap`)이 **첫 배치에서 거짓으로** 터진다.
 * 배치 트랜잭션은 이미 커밋된 뒤라 재실행해도 같은 경보가 반복된다.
 *
 * 여기서는 ① 수리된 경로(회차 단위 worklist + 회차를 자르지 않는 배치)가 상한을 넘지
 * 않는 것과 ② 수리 전(run 단위 worklist)이 실제로 상한을 넘는 것을 **둘 다 실행으로**
 * 확인한다. ②가 이 테스트의 변이 검출이다.
 */
describe("B-1 — 배치가 회차를 자르지 않는다 (회차 단위 worklist)", () => {
  const PB = "0000dddd-0000-4000-8000-000000000004";
  const R6 = "11111111-0000-4000-8000-000000000006";
  const R7 = "11111111-0000-4000-8000-000000000007";
  const B = (i: number) => `44444444-0000-4000-8000-00000000000${i}`;

  /** 같은 회차(같은 프로젝트·같은 cycle_anchor_at)에 run 둘, 각 답변 2건. */
  const SPLIT_FIXTURE = `
INSERT INTO projects (name, country, scope_project_id) VALUES ('split', 'KR', '${PB}');
INSERT INTO scope_runs (run_id, project_id, status, cycle_anchor_at) VALUES
  ('${R6}', '${PB}', 'completed', '2026-09-14T01:00:00Z'),
  ('${R7}', '${PB}', 'completed', '2026-09-14T01:00:00Z');
INSERT INTO scope_answers (job_id, run_id, target, region, status, measured_at) VALUES
  ('${B(1)}', '${R6}', 'chatgpt', 'KR', 'completed', '2026-09-14T02:00:00Z'),
  ('${B(2)}', '${R6}', 'gemini',  'KR', 'completed', '2026-09-14T02:01:00Z'),
  ('${B(3)}', '${R7}', 'chatgpt', 'KR', 'completed', '2026-09-14T02:02:00Z'),
  ('${B(4)}', '${R7}', 'gemini',  'KR', 'completed', '2026-09-14T02:03:00Z');
`;

  async function splitDb(): Promise<Db> {
    const db = await freshDb();
    await db.exec(SPLIT_FIXTURE);
    return db;
  }

  const worklist = async (db: Db): Promise<CycleRow[]> =>
    ((await db.query(WORKLIST_SQL)) as { rows: CycleRow[] }).rows;

  const refresh = async (db: Db, ids: string[]): Promise<number> =>
    Number(
      (
        (await db.query(`SELECT refresh_answer_cycle_anchors($1::uuid[], NULL)::bigint AS n`, [
          ids,
        ])) as { rows: Array<Record<string, unknown>> }
      ).rows[0].n,
    );

  it("worklist 가 같은 회차의 run 을 한 행으로 묶는다", async () => {
    const db = await splitDb();
    const rows = await worklist(db);
    const mine = rows.filter((r) => r.cycle_key.startsWith(PB));
    expect(mine).toHaveLength(1);
    expect(mine[0].run_ids).toEqual([R6, R7]);
    expect(mine[0].total).toBe(4);
    expect(mine[0].pending).toBe(4);
    // 앵커가 NULL 인 run(R3)은 다른 run 과 뭉치지 않고 단독 회차로 남는다.
    const solo = rows.filter((r) => r.cycle_key.includes("|run:"));
    expect(solo.map((r) => r.run_ids)).toEqual([[R3]]);
    await db.close();
  }, 120_000);

  it("상한보다 큰 회차도 쪼개지 않고, 기록 행수가 상한을 넘지 않는다", async () => {
    const db = await splitDb();
    const mine = (await worklist(db)).filter((r) => r.cycle_key.startsWith(PB));
    // 상한을 회차보다 **작게** 줘도 한 배치다(회차는 배치 구성의 최소 단위).
    const plan = planBatches(mine, { maxAnswers: 2, maxRuns: 1 });
    expect(plan).toHaveLength(1);
    expect(plan[0].ids).toEqual([R6, R7]);
    expect(plan[0].answers).toBe(4);
    const n = await refresh(db, plan[0].ids);
    expect(n).toBe(4);
    expect(n).toBeLessThanOrEqual(plan[0].answers); // 백필의 `n > cap` 이 안 터진다
    await db.close();
  }, 120_000);

  it("**변이**: run 단위로 쪼개면(수리 전) 첫 배치에서 상한이 터진다", async () => {
    const db = await splitDb();
    // 수리 전의 worklist 는 run 한 개가 한 행이었다 — 그 입력을 그대로 재현한다.
    const runUnit: CycleRow[] = [
      { cycle_key: "run-unit-6", run_ids: [R6], total: 2, pending: 2 },
      { cycle_key: "run-unit-7", run_ids: [R7], total: 2, pending: 2 },
    ];
    const broken = planBatches(runUnit, { maxAnswers: 2, maxRuns: 50 });
    expect(broken).toHaveLength(2); // 한 회차가 두 배치로 갈렸다
    const n = await refresh(db, broken[0].ids);
    expect(n).toBe(4); // 회차 확장으로 배치 밖 run 의 답변까지 썼다
    expect(n).toBeGreaterThan(broken[0].answers); // = 2 → `n > cap` 이 참 (B-1)
    await db.close();
  }, 120_000);

  it("전 회차를 배치로 돌려도 매 배치의 상한과 상태 단언이 거짓 중단하지 않는다", async () => {
    const db = await splitDb();
    const cycles = await worklist(db);
    // 최대 스트레스: 상한 1 이라 회차 하나가 곧 배치 하나다(경계가 가장 많다).
    const plan = planBatches(cycles, { maxAnswers: 1, maxRuns: 1 });
    expect(plan).toHaveLength(cycles.length);
    let written = 0;
    for (const b of plan) {
      // 0077 은 귀속 날짜가 매핑과 어긋나면 **같은 트랜잭션에서 예외**를 던진다 —
      // 이 호출이 전부 성공한다는 것이 배치 후 상태 단언의 실행 증거다.
      const n = await refresh(db, b.ids);
      expect(n, b.cycles[0].cycle_key).toBeLessThanOrEqual(b.answers);
      written += n;
    }
    const rows = (await db.query(
      `SELECT count(*)::int AS n FROM scope_answer_cycle_anchors`,
    )) as { rows: Array<Record<string, unknown>> };
    expect(n(rows.rows[0], "n")).toBe(written);
    // 재실행(멱등) — 값이 안 바뀌어 rowcount 는 줄지만 상한은 여전히 안 터진다.
    for (const b of plan) {
      expect(await refresh(db, b.ids)).toBeLessThanOrEqual(b.answers);
    }
    await db.close();
  }, 120_000);
});

// ── C-1: dry-run 의 자리 산술 사본을 함수와 대조한다 ──────────────────────────
describe("dry-run 의 prev/next 자리 산술이 0077 함수와 같다 (사본 대조)", () => {
  /** 식을 **파일에서 뽑는다** — 테스트에 사본을 또 적으면 대조가 아니다. */
  function seatExprs(sql: string): { prev: string; next: string } {
    const prev = /\n\s*(\S[^\n]*?) AS prev_seat,/.exec(sql)?.[1];
    const next = /\n\s*(\S[^\n]*?) AS next_seat\b/.exec(sql)?.[1];
    if (!prev || !next) throw new Error("dry-run SQL 에서 prev_seat/next_seat 식을 못 찾았다");
    return { prev, next };
  }

  /** 2026 전체 날짜 × 정규 요일 1..7 에서 식과 함수가 어긋나는 조합 수. */
  const compareSql = (e: { prev: string; next: string }) => `
    SELECT count(*)::int AS bad FROM (
      SELECT g.d::date AS anchor_date, w.dow,
             EXTRACT(ISODOW FROM g.d)::int AS adow
        FROM generate_series(DATE '2026-01-01', DATE '2026-12-31', INTERVAL '1 day') g(d),
             generate_series(1, 7) w(dow)
    ) s
     WHERE (${e.prev}) IS DISTINCT FROM hmg_round_prev_canonical(anchor_date, dow)
        OR (${e.next}) IS DISTINCT FROM hmg_round_next_canonical(anchor_date, dow)`;

  it("2,555 조합 전부에서 같다", async () => {
    const db = await freshDb();
    const e = seatExprs(fs.readFileSync(DRYRUN_SQL, "utf8"));
    expect(e.prev).toContain("anchor_date -");
    expect(e.next).toContain("anchor_date +");
    const r = (await db.query(compareSql(e))) as { rows: Array<Record<string, unknown>> };
    expect(n(r.rows[0], "bad")).toBe(0);
    await db.close();
  }, 120_000);

  it("**변이**: 사본의 부호를 뒤집으면 대조가 깨진다", async () => {
    const db = await freshDb();
    const e = seatExprs(fs.readFileSync(DRYRUN_SQL, "utf8"));
    const r = (await db.query(
      compareSql({ prev: e.prev.replace("anchor_date -", "anchor_date +"), next: e.next }),
    )) as { rows: Array<Record<string, unknown>> };
    expect(n(r.rows[0], "bad")).toBeGreaterThan(0);
    await db.close();
  }, 120_000);
});

describe("변이 검증 — 이 테스트가 실제로 그 두 결함을 잡는가", () => {
  it("`ANY((SELECT engines FROM de))` 로 되돌리면 S4·S5 가 실패한다", async () => {
    const db = await freshDb();
    const broken = fs
      .readFileSync(DRYRUN_SQL, "utf8")
      .replace(/\n\s*CROSS JOIN de\n/g, "\n")
      .replace(/\(a\.target = ANY\(de\.engines\)\)/g, "(a.target = ANY((SELECT engines FROM de)))");
    const sts = splitDryRunStatements(broken);
    for (const name of ["S4_cycles", "S5_rounds"]) {
      const st = sts.find((s) => s.name === name)!;
      await expect(db.query(st.sql), name).rejects.toThrow();
    }
    // S1~S3 은 그 식을 쓰지 않으므로 그대로 돈다(변이가 국소적임을 확인).
    for (const name of ["S1_coverage", "S2_registry", "S3_gate"]) {
      const st = sts.find((s) => s.name === name)!;
      await expect(db.query(st.sql)).resolves.toBeTruthy();
    }
    await db.close();
  }, 120_000);

  it("`min(uuid)` 로 되돌리면 dry-run 과 refresh 가 둘 다 실패한다", async () => {
    const db = await freshDb();
    // ① dry-run: cyc_base 의 GROUP BY 키를 집계로 바꾼다
    const broken = fs
      .readFileSync(DRYRUN_SQL, "utf8")
      .replace(
        /SELECT cycle_key, project_id,\n(\s*)min\(run_anchor_at\)/,
        "SELECT cycle_key, min(project_id) AS project_id,\n$1min(run_anchor_at)",
      );
    const s1 = splitDryRunStatements(broken).find((s) => s.name === "S1_coverage")!;
    await expect(db.query(s1.sql)).rejects.toThrow(/min\(uuid\)/);

    // ② 마이그레이션 함수: 같은 자리를 집계로 바꾼 사본을 올리고 호출한다.
    const mig = fs.readFileSync(MIGRATION_0077, "utf8");
    const fn = migrationStatements(mig).find((s) =>
      s.startsWith("CREATE OR REPLACE FUNCTION refresh_answer_cycle_anchors"),
    )!;
    const brokenFn = fn.replace(
      "SELECT cycle_key,\n             project_id,\n             min(cycle_anchor_at) AS run_anchor_at",
      "SELECT cycle_key,\n             min(project_id) AS project_id,\n             min(cycle_anchor_at) AS run_anchor_at",
    );
    expect(brokenFn, "변이가 적용되지 않았다 — 원문이 바뀌었는지 확인").not.toBe(fn);
    await db.exec(brokenFn);
    await expect(
      db.query(`SELECT refresh_answer_cycle_anchors($1::uuid[], NULL)`, [[R1]]),
    ).rejects.toThrow(/min\(uuid\)/);
    await db.close();
  }, 120_000);
});
