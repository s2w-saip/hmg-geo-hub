import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 측정 기준일(asOf) 회차 기준 통일 — PR① B5 (2026-09-09).
//
// 같은 요청·같은 필터인데 화면마다 "측정 기준일"이 달랐다: 인용 화면은 회차
// (`max(COALESCE(r.cycle_anchor_at, a.measured_at))`, #209 로 이관 완료), 언급
// 헤드라인은 `max(a.measured_at)` 이라 회차 꼬리 측정 시각을 집었다. 측정 이월은
// 상시 현상이라(8/1 이후 `measured_at ≠ cycle_anchor_at` 인 답변 59,527건) 두 탭이
// 실제로 다른 날짜를 표시했다.
//
// 이 테스트가 고정하는 것:
//   ① 언급 헤드라인의 asOf 식이 인용 정본의 asOf 식과 **문자열 동일**
//   ② 그 식을 쓰는 문장은 `LEFT JOIN scope_runs r ON r.run_id = a.run_id` 를 갖는다
//   ③ `_answer_set` 투영은 종전 컬럼을 그대로 두고 `a.run_id` 를 **추가만** 했다
//      (컬럼이 빠지면 TEMP 표에 없어 42703 — 2026-09-05 프로덕션 장애 형태)
//   ④ TEMP 생성 문장은 여전히 요청당 1회(추가 왕복 없음)

const dialect = new PgDialect();
const captured: string[] = [];
const execute = vi.fn(async (q: SQL) => {
  try {
    captured.push(dialect.sqlToQuery(q).sql);
  } catch {
    /* raw SET 등 — 형태 검사 대상 아님 */
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

// 정본 식 — 두 화면이 공유해야 하는 문자열.
const AS_OF_EXPR = "max(coalesce(r.cycle_anchor_at, a.measured_at))";
const RUNS_JOIN = "left join scope_runs r on r.run_id = a.run_id";
const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

beforeAll(async () => {
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
});

const run = async (fn: () => Promise<unknown>) => {
  captured.length = 0;
  try {
    await fn();
  } catch {
    /* 빈 mock 결과로 후처리가 실패해도 SQL 은 이미 캡처됐다 */
  }
  return captured.map(norm);
};

describe("asOf — 언급 헤드라인과 인용이 같은 회차 식을 쓴다", () => {
  it("언급 헤드라인의 asOf 식이 인용 정본과 문자열 동일하다", async () => {
    const m = await import("./scope-aggregates");
    const mention = await run(() => m.aggregateMentionsFromMirror({}, PIDS, "none"));
    const citation = await run(() => m.aggregateCitationsFromMirror({}, PIDS, []));

    const mentionAsOf = mention.filter((s) => s.includes(AS_OF_EXPR));
    const citationAsOf = citation.filter((s) => s.includes(AS_OF_EXPR));
    expect(mentionAsOf.length).toBe(1);
    expect(citationAsOf.length).toBeGreaterThan(0);
    // 종전 식(회차 무시)의 asOf 는 남아 있지 않다. (`max(a.measured_at) - interval`
    // 은 셀 신선도 floor_at 이라 다른 축 — 여기서 걸면 안 된다.)
    expect(mention.some((s) => /max\(a\.measured_at\)\s+as\s+as_of/.test(s))).toBe(false);
  });

  it("asOf 식을 쓰는 문장은 scope_runs 를 LEFT JOIN 한다", async () => {
    const m = await import("./scope-aggregates");
    const mention = await run(() => m.aggregateMentionsFromMirror({}, PIDS, "none"));
    for (const s of mention.filter((x) => x.includes(AS_OF_EXPR))) {
      expect(s).toContain(RUNS_JOIN);
    }
  });

  it("_answer_set 투영은 종전 컬럼 + a.run_id (추가만)", async () => {
    const m = await import("./scope-aggregates");
    const mention = await run(() => m.aggregateMentionsFromMirror({}, PIDS, "none"));
    const create = mention.filter((s) => s.includes("create temp table _answer_set"));
    expect(create.length).toBe(1); // TEMP 생성은 요청당 1회 — 추가 왕복 없음
    for (const c of ["a.job_id", "a.prompt_id", "a.measured_at", "a.run_id"]) {
      expect(create[0]!).toContain(c);
    }
  });
});
