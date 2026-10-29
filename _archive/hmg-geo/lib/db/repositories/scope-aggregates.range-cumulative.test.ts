import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// 2026-09-06 회귀 가드 — "기간을 바꿔도 숫자가 안 바뀐다".
//
// 웹사이트 대시보드는 기간이 걸리면 **그 기간 회차들의 합**을 보여준다(운영 결정).
// 종전 스냅샷("기간 내 최신 배치")은 달력을 어떻게 움직여도 그 안에 최신 회차만
// 들어 있으면 같은 숫자를 냈다 — 프리셋이 전부 오늘 끝나는 트레일링 창이라
// 실질적으로 항상 그랬다(실측: 국가=KR 7일·30일·1년 전부 답변 910·언급 11,881).
//
// 그 스위치가 `filters.cumulative` 이고, 여기서 고정하는 것은 **SQL 이 실제로 두
// 갈래로 갈린다**는 것이다:
//   · 스냅샷  → 배치 선택(`a.job_id IN (…)`), measured_at 클리핑 없음
//   · 누적    → 런 전체(`a.run_id IN (…)`) + `a.measured_at` 범위 클리핑
// 실측 검산(국가=KR, 08-08~09-06 누적): 답변 3,459 = 926+1,623+910,
// 언급 42,380 = 11,881+22,280+8,219 — 구간별 합과 정확히 일치했다.

vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: vi.fn(), transaction: vi.fn() }) }));

const { answerWhere } = await import("@/lib/db/repositories/scope-aggregates");
const dialect = new PgDialect();
const sqlText = (f: Parameters<typeof answerWhere>[0]) =>
  dialect.sqlToQuery(answerWhere(f, ["11111111-1111-4111-8111-111111111111"])).sql;

const RANGE = { dateFrom: "2026-08-08", dateTo: "2026-09-06" } as const;

describe("기간 축 의미론", () => {
  it("스냅샷(기본)은 배치를 고르고 measured_at 을 자르지 않는다", () => {
    const s = sqlText({ ...RANGE });
    expect(s).toContain("a.job_id IN");
    // 신선도 바닥(`a.measured_at >= pm.floor_at`)은 배치 선택의 일부라 남는다 —
    // 없어야 하는 것은 **필터 날짜로 행을 자르는** 클리핑(파라미터 바인딩)이다.
    expect(s).toContain("a.measured_at >= pm.floor_at");
    expect(s).not.toMatch(/a\.measured_at >= \$\d/);
  });

  it("누적은 런 전체 + measured_at 클리핑 — 기간 안 회차가 전부 합산된다", () => {
    const s = sqlText({ ...RANGE, cumulative: true });
    expect(s).toContain("a.run_id IN");
    expect(s).toMatch(/a\.measured_at >= \$\d+::date/);
    expect(s).toMatch(/a\.measured_at < \(\$\d+::date \+ 1\)/);
    // 배치 선택으로 되돌아가면 "기간을 바꿔도 안 바뀐다" 가 재발한다.
    expect(s).not.toContain("a.job_id IN");
  });

  it("두 갈래의 SQL 이 실제로 다르다", () => {
    expect(sqlText({ ...RANGE })).not.toBe(sqlText({ ...RANGE, cumulative: true }));
  });
});
