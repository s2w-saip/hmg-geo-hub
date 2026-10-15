/**
 * 0077 백필 스크립트의 **안전 계약**. DB 없이 돈다 — 수치는 실행한 사람이 본다.
 *
 * 이 파일이 막는 것은 독립 검증이 찾은 차단 결함 셋이다:
 *   · BLOCK-1 rowcount 하한 단언이 upsert 의 `IS DISTINCT FROM` 가드와 모순 →
 *     `--recompute` 가 구조적으로 실패하고, 정상 백필도 미러 cron 과 경합하면 멈춘다
 *   · BLOCK-3 `no_source > 0` 이면 같은 배치에서 영구 실패
 *   · BLOCK-4 전수 대조가 dry-run 과 다른 모수를 쓴다
 *
 * 스크립트는 import 즉시 `postgres()` 를 열고 env 가 없으면 `process.exit` 하므로
 * **소스 텍스트로 계약을 고정한다**(실행하지 않는다).
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { readSourceText } from "@/test/source-text";

const FILE = path.resolve(__dirname, "backfill-answer-cycle-anchors.ts");
const src = readSourceText(FILE);
/** 주석을 뺀 실행 본문 — 계약은 "실행되는 것"에만 건다. */
const code = src
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

const DRYRUN = readSourceText(
  path.resolve(__dirname, "answer-cycle-anchors-dryrun.sql"),
);

describe("BLOCK-1 — 하한 단언은 rowcount 가 아니라 배치 후 상태다", () => {
  it("rowcount 는 **상한만** 본다", () => {
    expect(code).toContain("if (n > cap)");
    // 하한을 rowcount 로 보던 형태가 남아 있으면 안 된다.
    expect(code).not.toContain("if (n < expected)");
    expect(code).not.toContain("const expected = RECOMPUTE ? cap");
  });

  it("배치마다 `batchState()` 로 누락·불일치를 단언한다", () => {
    expect(code).toContain("const st = await batchState(ids);");
    expect(code).toContain("if (st.missing > 0 || st.inconsistent > 0)");
  });

  it("상태 질의는 '대상 job 이 전부 있고 파생 키가 맞는가' 를 센다", () => {
    // 대상 = 그 배치 run 의 completed · project_id NOT NULL
    expect(code).toContain(
      "WHERE a.run_id = ANY(${ids}::uuid[]) AND a.status = 'completed' AND r.project_id IS NOT NULL",
    );
    // 기대 집합 = 네 출처 중 하나라도 있는 job
    expect(code).toContain(
      "WHERE reg_job IS NOT NULL OR ledger_anchor IS NOT NULL\n        OR run_anchor IS NOT NULL OR measured_at IS NOT NULL",
    );
    // 누락
    expect(code).toContain("WHERE NOT EXISTS (SELECT 1 FROM scope_answer_cycle_anchors c");
    // 값 일치 — 축이 둘이다. 주·월은 **귀속 날짜(round_date)** 에서, anchor_date 는
    // **실제 앵커(anchor_at)** 에서 나와야 하고, round_date 는 매핑 표와 같아야 한다.
    expect(code).toContain("c.round_date   IS DISTINCT FROM m.round_date");
    expect(code).toContain("c.anchor_week  IS DISTINCT FROM hmg_anchor_week(c.round_date)");
    expect(code).toContain("c.anchor_month IS DISTINCT FROM hmg_anchor_month(c.round_date)");
    expect(code).toContain("hmg_anchor_date(c.anchor_at) IS DISTINCT FROM c.anchor_date");
    expect(code).toContain("LEFT JOIN scope_cycle_rounds m");
  });

  it("상태 질의는 읽기 전용 트랜잭션에서 돈다", () => {
    const fn = code.slice(code.indexOf("async function batchState"), code.indexOf("AS inconsistent"));
    expect(fn).toContain('await tx.unsafe("SET TRANSACTION READ ONLY")');
    expect(fn).toContain("SET LOCAL statement_timeout");
  });
});

describe("BLOCK-3 — 출처 없는 답변은 시작 전에 끊는다", () => {
  it("`--apply` 가 census → 게이트 순서로 돈다", () => {
    const apply = code.slice(code.indexOf("async function apply()"), code.indexOf("for (let i = 0;"));
    const iCensus = apply.indexOf("const c = await census();");
    const iGate = apply.indexOf("await assertNoSourceGate(c);");
    const iWork = apply.indexOf("await loadWorklist();");
    expect(iCensus).toBeGreaterThan(-1);
    expect(iGate).toBeGreaterThan(iCensus);
    expect(iWork).toBeGreaterThan(iGate); // 게이트가 worklist 조회보다 앞이다
  });

  it("게이트는 0 이 아니면 목록과 함께 던진다", () => {
    const g = code.slice(code.indexOf("async function assertNoSourceGate"), code.indexOf("async function batchState"));
    expect(g).toContain("if (c.no_source === 0) return;");
    expect(g).toContain("ORDER BY a.run_id LIMIT 20");
    expect(g).toContain("throw new Error(");
    expect(g).toContain("no_source > 0");
  });

  it("배치 단언도 출처 없는 행을 기대 집합에서 뺀다", () => {
    expect(code).toContain("AS no_source,\n         (SELECT count(*) FROM expected e");
    expect(code).toContain("if (st.no_source > 0)");
  });

  it("dry-run 이 같은 수를 내고 0 이 아니면 경고한다", () => {
    expect(code).toContain("--apply 가 시작 전에 중단된다 — BLOCK-3");
    expect(DRYRUN).toContain("AS no_source");
  });
});

describe("BLOCK-4 — 전수 대조와 dry-run 이 같은 분해를 쓴다", () => {
  it("분해는 네 항이고 정의는 `census()` 한 곳이다", () => {
    expect(code).toContain("async function census()");
    for (const k of ["completed", "no_run_row", "excluded_null_project", "no_source", "in_scope"]) {
      expect(code).toContain(`AS ${k}`);
    }
    // verify() 가 census() 를 재사용한다(술어를 두 벌로 쓰지 않는다).
    const v = code.slice(code.indexOf("async function verify("));
    expect(v).toContain("const c = await census();");
    expect(v).not.toContain("AS still_missing");
    expect(v).not.toContain("AS excluded_null_project,");
  });

  it("`scope_runs` 행이 없는 completed 답변을 별도 항으로 센다", () => {
    expect(code).toContain("LEFT JOIN scope_runs r ON r.run_id = x.run_id");
    expect(code).toContain("count(*) FILTER (WHERE r_run IS NULL)::int");
  });

  it("dry-run S1 도 LEFT JOIN 이고 같은 네 항을 낸다", () => {
    const s1 = DRYRUN.slice(
      DRYRUN.indexOf("-- @@statement S1_coverage"),
      DRYRUN.indexOf("-- @@statement S2_registry"),
    );
    expect(s1).toContain("LEFT JOIN run_ctx rc ON rc.run_id = a.run_id");
    // S1 에 INNER 로 묶던 형태가 남아 있으면 안 된다(그 답변이 모수에서 통째로 빠진다).
    expect(s1).not.toMatch(/\n {4}JOIN run_ctx rc ON rc\.run_id = a\.run_id/);
    for (const k of ["AS no_run_row", "AS excluded_null_project", "AS no_source", "AS rows_out"]) {
      expect(DRYRUN).toContain(k);
    }
    expect(DRYRUN).toContain(
      "completed_answers = rows_out + no_run_row + excluded_null_project + no_source",
    );
  });

  it("두 곳 다 분해가 안 맞으면 멈춘다 / 표시한다", () => {
    expect(code).toContain('if (diff !== 0) throw new Error("모수 분해가 안 맞는다');
    // verify 는 고아를 등식에서 빼고 따로 센다(테이블 행에는 있고 completed 에는 없다).
    expect(code).toContain('n("rows_out") - n("orphans")');
  });
});

describe("B-1 — 작업 단위는 회차다 (배치가 회차를 자르지 않는다)", () => {
  it("worklist SQL 을 직접 갖지 않고 배치 모듈의 것을 쓴다", () => {
    expect(code).toContain('from "./answer-cycle-anchors-batching"');
    expect(code).toContain("conn.unsafe(WORKLIST_SQL)");
    // run 단위로 잘라 배치를 만들던 형태가 남아 있으면 안 된다.
    expect(code).not.toContain("targets.slice(i, i + RUNS_PER_BATCH)");
    expect(code).not.toContain("batch.map((r) => r.run_id)");
  });

  it("배치는 회차 목록을 `planBatches` 로 구성하고 cap 은 그 배치의 답변 수다", () => {
    expect(code).toContain("const plan = planBatches(targets, {");
    expect(code).toContain("maxAnswers: ANSWERS_PER_BATCH");
    expect(code).toContain("maxRuns: RUNS_PER_BATCH");
    expect(code).toContain("const cap = batch.answers;");
    expect(code).toContain("if (n > cap)");
  });

  it("배치 상한의 1차 축은 답변 수이고 기본값이 박혀 있다", () => {
    expect(code).toContain('const ANSWERS_PER_BATCH = flag("answers", 20_000);');
    expect(code).toContain('const RUNS_PER_BATCH = flag("runs", 200);');
    expect(code).toContain('const LIMIT_CYCLES = flag("limit", Number.MAX_SAFE_INTEGER);');
  });
});

describe("A-2 — 부분 실행(--limit)은 시작·끝·검증에서 드러난다", () => {
  it("`--limit` 절단 여부가 partial 로 잡힌다", () => {
    expect(code).toContain("const partial = targets.length < work.length;");
    expect(code).toContain("⏸ 부분 실행 —");
  });

  it("부분 실행이면 전수 재배정 패스를 **명시적으로** 건너뛴다", () => {
    expect(code).toContain("} else if (partial) {");
    expect(code).toContain("전수 재배정 패스를 건너뛴다");
    expect(code).toContain("db:reassign:cycle-rounds -- --all --apply");
  });

  it("검증이 부분 실행과 완주를 구분한다", () => {
    const v = code.slice(code.indexOf("async function verify("));
    expect(v).toContain("scope.partial");
    expect(v).toContain("미완주 (잔여 회차 남음)");
    expect(v).toContain("전수 재배정 패스 ");
    // 잔여가 남은 상태의 차이를 결함 신호로 찍지 않는다.
    expect(v).toContain("차이(잔여 — 부분 실행)");
  });
});

describe("변하지 않아야 하는 안전수칙", () => {
  it("기본은 dry-run — `--apply` 없으면 쓰기 경로로 가지 않는다", () => {
    expect(code).toContain('const APPLY = argv.includes("--apply");');
    expect(code).toContain("if (!APPLY) {");
  });

  it("dry-run 은 읽기 전용이 실제로 걸렸는지 단언한다", () => {
    expect(code).toContain('await tx.unsafe("SET TRANSACTION READ ONLY")');
    expect(code).toContain('ro?.transaction_read_only !== "on"');
  });

  it("쓰기 tx 는 READ WRITE 를 명시한다 (Supavisor GUC 누출)", () => {
    expect(code).toContain('await tx.unsafe("SET TRANSACTION READ WRITE")');
  });

  it("재개 경로는 DB 재조회다 — 스냅샷 파일이 없다", () => {
    expect(code).toContain("async function loadWorklist()");
    expect(code).not.toMatch(/writeFileSync|readFileSync\(.*state/);
  });

  it("산술을 TS 로 재구현하지 않는다 — DB 함수만 부른다", () => {
    expect(code).toContain("SELECT refresh_answer_cycle_anchors(");
    expect(code).not.toMatch(/AT TIME ZONE '/);
    expect(code).not.toMatch(/'(UTC|Asia\/Seoul)'/);
  });

  it("원본 테이블을 쓰지 않는다", () => {
    expect(code).not.toMatch(/(UPDATE|DELETE FROM|INSERT INTO)\s+scope_(answers|runs|answer_anchors)\b/);
  });

  it("루트 프로젝트 id 는 해소 헬퍼 한 곳에서 오고, 형식 오류는 던진다 (N-4·N-14)", () => {
    expect(code).toContain("const ROOT_PROJECT_ID = anchorRootProjectIdOrThrow();");
    expect(code).toContain("${ROOT_PROJECT_ID}::uuid");
  });

  it("N-15 — 테이블이 최신판인지도 본다 (함수만 보면 이전 판을 통과시킨다)", () => {
    // 함수는 CREATE OR REPLACE 라 재적용으로 갱신되지만 테이블 DDL 은 to_regclass
    // 가드 안이라 갱신되지 않는다. 컬럼과 CHECK 를 함께 확인한다.
    expect(code).toContain("FROM information_schema.columns");
    for (const c of [
      "measured_at_orig",
      "is_default_engine",
      "ledger_view_anchor_date",
      "round_date",
    ]) {
      expect(code).toContain(`"${c}"`);
    }
    expect(code).toContain("이전 판 0077 이 적용된 DB 다");
    // 매핑 표와 배정·전파 함수까지 본다 — 셋이 한 파일에서 함께 생긴다.
    expect(code).toContain("to_regclass('public.scope_cycle_rounds')");
    expect(code).toContain("hmg_assign_cycle_rounds");
    expect(code).toContain("hmg_propagate_cycle_rounds");
    // 사라진 어휘(`fleet_align`)로 쓰인 행이 남아 있으면 시작 전에 끊는다.
    expect(code).toContain("WHERE source = 'fleet_align'");
  });

  it("N-15 — 앱 프로브도 신판 컬럼을 본다", async () => {
    const path2 = await import("node:path");
    const ca = readSourceText(
      path2.resolve(__dirname, "../../lib/db/column-availability.ts"),
    );
    expect(ca).toContain('columnAvailable("scope_answer_cycle_anchors", "round_date")');
    expect(ca).not.toContain('columnAvailable("scope_answer_cycle_anchors", "anchor_date")');
  });
});
