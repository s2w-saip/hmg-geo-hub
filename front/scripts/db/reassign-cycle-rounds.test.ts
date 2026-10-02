import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 운영자 재배정 스크립트의 계약.
 *
 * 이 스크립트는 **과거 배정을 흔드는 유일한 경로**다. 규율이 깨지는 방향이 전부
 * "조용히" 다 — 앵커 값을 같이 옮기거나, dry-run 이 실제로는 쓰거나, 대상 없이
 * 전수를 도는 식이다. 그래서 형태를 텍스트로 고정한다.
 * (배정 규칙 자체의 검증은 `lib/db/migrations/0077_cycle_rounds.pglite.test.ts`
 *  가 **실행으로** 한다 — 여기서는 배선만 본다.)
 */
const FILE = path.resolve(__dirname, "reassign-cycle-rounds.ts");
const code = fs.readFileSync(FILE, "utf8");

describe("① 쓰는 대상 — 매핑 표와 귀속 파생 컬럼뿐", () => {
  it("앵커 값·코어·미러·회차 원장을 건드리지 않는다", () => {
    // 쓰기 문장에 나오는 테이블은 scope_cycle_rounds 하나뿐이어야 한다.
    const writes = code.match(/(DELETE FROM|INSERT INTO|UPDATE)\s+(\w+)/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("DELETE FROM scope_cycle_rounds");
    // 답변 행 갱신은 전파 함수가 한다(SQL 사본을 두지 않는다).
    expect(code).toContain("hmg_propagate_cycle_rounds(NULL::uuid[]");
    for (const t of ["scope_runs", "scope_answers", "summary_cycles", "summary_cycle_runs"]) {
      expect(code, t).not.toContain(t);
    }
  });

  it("배정 규칙의 사본을 갖지 않는다 — DB 함수를 부른다", () => {
    expect(code).toContain("hmg_assign_cycle_rounds(NULL::uuid[]");
    expect(code).not.toContain("ISODOW");
    expect(code).not.toMatch(/'canonical'|'prev_empty'|'next_empty'/);
  });
});

describe("② 기본 dry-run", () => {
  it("--apply 가 없으면 트랜잭션을 롤백한다", () => {
    expect(code).toContain('const APPLY = argv.includes("--apply");');
    expect(code).toContain("if (!APPLY) throw new Error(ROLLBACK_MARK);");
    // 롤백 표식은 실제 오류와 구분해 삼킨다(진짜 실패를 조용히 넘기지 않는다).
    expect(code).toContain("if (msg !== ROLLBACK_MARK) throw e;");
  });

  it("dry-run 이 읽기 전용이 아니라는 사실을 머리 주석에 적어 둔다", () => {
    expect(code).toContain("읽기 전용이 **아니다**");
    expect(code).toContain("ROLLBACK");
  });
});

describe("③ 대상 한정과 단언", () => {
  it("대상 없이 돌지 않는다 — --projects 또는 --all 이 필요하다", () => {
    expect(code).toContain("`--projects=<uuid,…>` 또는 `--all` 중 하나를 준다");
    expect(code).toContain("`--all` 과 `--projects` 를 함께 줄 수 없다");
  });

  it("날짜 구간은 형식을 검사한다", () => {
    expect(code).toContain("/^\\d{4}-\\d{2}-\\d{2}$/.test(v)");
    expect(code).toContain("--from 이 --to 보다 늦다");
  });

  it("재배정 뒤 **모든 회차가 매핑을 갖는지** 단언하고, 아니면 롤백한다", () => {
    expect(code).toContain("재배정 후에도 매핑이 없는 회차가");
    expect(code).toContain("NOT EXISTS (SELECT 1 FROM scope_cycle_rounds m");
  });

  it("0077 적용 여부를 표와 함수 시그니처로 본다", () => {
    expect(code).toContain("to_regclass('public.scope_cycle_rounds')");
    expect(code).toContain("to_regprocedure('public.hmg_assign_cycle_rounds(uuid[], uuid[])')");
  });
});

describe("④ A-4 — dry-run 이 미러 싱크를 막는다는 사실을 실행 전에 알린다", () => {
  it("dry-run 실행 전 락 경고를 찍는다", () => {
    expect(code).toContain("⚠️ dry-run 은 읽기 전용이 아니다");
    expect(code).toContain("advisory");
    expect(code).toContain("refresh_answer_cycle_anchors");
    // 경고에 이번 실행의 실제 타임아웃·트랜잭션 수를 함께 찍는다.
    expect(code).toContain("이번 실행: lock_timeout=${LOCK_TIMEOUT}");
  });

  it("타임아웃 기본값이 dry-run 에서 짧고, 옵션으로 더 줄일 수 있다", () => {
    expect(code).toContain('asTimeout("statement-timeout", APPLY ? "10min" : "2min")');
    expect(code).toContain('asTimeout("lock-timeout", APPLY ? "5s" : "2s")');
    // 값은 그대로 SET LOCAL 에 들어가므로 형식을 검사한다.
    expect(code).toContain("/^\\d+(ms|s|min)$/.test(v)");
  });

  it("`--all` dry-run 은 프로젝트를 나눠 여러 트랜잭션으로 돈다 (기본 25개)", () => {
    expect(code).toContain("const passes = APPLY ? [projects] : chunk(projects, CHUNK);");
    expect(code).toContain("if (v === null) return 25;");
    expect(code).toContain("function chunk(xs: string[], n: number): string[][]");
    // apply 는 원자성 때문에 한 트랜잭션이고, 그 사실도 경고로 알린다.
    expect(code).toContain("--apply 는 원자성을 위해 **한 트랜잭션**이다");
  });

  it("패스별 결과를 합산해 한 번만 보고한다", () => {
    expect(code).toContain("async function runPass(projects: string[]): Promise<PassResult>");
    expect(code).toContain("acc.movedRows += r.movedRows;");
    expect(code).toContain("report(acc.before, acc.after, acc);");
  });
});

describe("⑤ 안전수칙 배선", () => {
  it("단일 트랜잭션 + SET LOCAL 타임아웃 + READ WRITE 선언", () => {
    expect(code).toContain('await tx.unsafe("SET TRANSACTION READ WRITE")');
    expect(code).toContain("SET LOCAL statement_timeout");
    expect(code).toContain("SET LOCAL lock_timeout");
  });

  it("package.json 에 스크립트가 등록돼 있다", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:reassign:cycle-rounds"]).toBe(
      "tsx --env-file=.env.local scripts/db/reassign-cycle-rounds.ts",
    );
  });
});

describe("⑥ SQL 을 품은 스크립트의 템플릿 리터럴 안전 (8212ce6 잠복 결함)", () => {
  // `scripts/**` 는 tsconfig 에서 제외돼 `tsc --noEmit` 이 보지 않는다. SQL 주석 안의
  // 백틱 하나가 태그드 템플릿을 닫아 TS1005 를 내도 **CI 가 못 잡는다.**
  const FILES = [
    "reassign-cycle-rounds.ts",
    "backfill-answer-cycle-anchors.ts",
  ];
  for (const f of FILES) {
    it(`${f}: SQL 주석(--) 줄에 백틱이 없다`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
      const bad = src
        .split("\n")
        .filter((l) => /^\s*--/.test(l) && l.includes("`"));
      expect(bad).toEqual([]);
    });
    it(`${f}: 백틱 총 개수가 짝수다`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
      expect((src.match(/`/g) ?? []).length % 2).toBe(0);
    });
  }
});
