import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// 기간 축 = **회차 앵커**(`scope_runs.cycle_anchor_at`) — 제품 책임자 2026-09-16 재확인:
// "측정이 아니라 앵커 기준으로 보여야 한다."
//
// 왜 축이 문제가 되는가 — 회차의 꼬리 측정이 다음 날로 이월되는 것이 상시 현상이라
// 두 축이 자주 다른 날을 가리킨다. 라이브 실측(미러, 90일 완료 답변 477,770건):
//   date(measured_at) ≠ date(cycle_anchor_at) → **128,945건 (27.0%)**
// 사실표(summary) 경로는 이미 앵커 축이다(`summary-cycles.ts::pickCyclesInRange`
// 가 `c.cycle_anchor_at` 으로 회차를 고른다) — 미러 경로를 거기에 맞춘 것이다.
//
// 마이그레이션 없이 끝난 이유: 앵커는 **run 단위 속성**이라 `scope_answers` 에
// 컬럼을 더하지 않고도 run 준-조인으로 판정된다. 누적 경로는 이미 걸려 있던 run
// 스코프 semi-join 에 앵커 경계를 접어 넣어 스캔을 늘리지 않는다.
//
// 폴백: 앵커가 NULL 인 run(라이브 실측 37/27,273 = 0.14%, 0058 이전 잔여)은 종전
// 축으로 판정한다 — 그 답변이 조용히 사라지지 않게.

vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: vi.fn(), transaction: vi.fn() }) }));

const { answerWhere, detailAnswerWhere, latestAcrPromptRunIds } = await import(
  "@/lib/db/repositories/scope-aggregates"
);
const dialect = new PgDialect();
const PID = "33333333-3333-4333-8333-333333333333";
const RANGE = { dateFrom: "2026-08-19", dateTo: "2026-09-15" } as const;
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("스냅샷(배치 선택)의 기간 축", () => {
  it("run 축이 앵커다 — started_at 단독으로 판정하지 않는다", () => {
    const s = flat(dialect.sqlToQuery(answerWhere({ ...RANGE }, [PID])).sql);
    expect(s).toContain("COALESCE(r.cycle_anchor_at, r.started_at) >=");
    expect(s).toContain("COALESCE(r.cycle_anchor_at, r.started_at) < (");
    // 행 축으로 새면 "배치는 원자 단위" 규약이 깨진다.
    expect(s).not.toMatch(/a\.measured_at >= \$\d/);
  });
});

describe("누적(기간=회차 합)의 기간 축", () => {
  const cum = (extra: Record<string, unknown> = {}) =>
    flat(dialect.sqlToQuery(detailAnswerWhere({ ...RANGE, cumulative: true, ...extra }, [PID])).sql);

  it("앵커가 있는 run 은 앵커로 판정한다", () => {
    const s = cum();
    expect(s).toMatch(/cycle_anchor_at IS NOT NULL AND cycle_anchor_at >= \$\d+::date/);
    expect(s).toMatch(/cycle_anchor_at < \(\$\d+::date \+ 1\)/);
  });

  it("앵커가 NULL 인 run 만 종전 축(measured_at)으로 폴백한다", () => {
    const s = cum();
    expect(s).toContain("cycle_anchor_at IS NULL");
    expect(s).toMatch(/cycle_anchor_at IS NULL\)? AND a\.measured_at >= \$\d+::date/);
  });

  // ⚠️ **발생 횟수로 고정한다** (2026-09-16 독립 검증 지적).
  // 종전 단언은 "폴백 arm 이후를 잘라내고 나머지에 클리핑이 없는지" 를 봤는데,
  // 되살아난 클리핑은 **항상 그 뒤에 붙으므로** 구조적으로 검출 불가능했다 —
  // 두 가드(`detailAllRunsWindowPreds` 의 `!cumulative`, `answerWhere` 의
  // `allRuns && !cumulative`)를 **둘 다 제거해도 3,946개 테스트가 전부 통과**했다.
  // 데이터 영향은 09-08 회차일 40,500 → 38,506 (−1,994, −4.9%) = 이 브랜치의
  // 핵심 산출물 원복. 위치가 아니라 **개수**를 세면 그 뮤테이션이 잡힌다.
  const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

  it("measured_at 클리핑은 폴백 arm 의 **1회뿐**이다 (추가되면 잡힌다)", () => {
    const s = cum();
    expect(occurrences(s, "a.measured_at >=")).toBe(1);
    expect(occurrences(s, "a.measured_at <")).toBe(1);
    // 그 1회는 반드시 앵커 NULL 폴백 arm 안이다.
    expect(s).toMatch(/cycle_anchor_at IS NULL\)? AND a\.measured_at >= \$\d+::date/);
    // 앵커 경계도 정확히 한 벌.
    expect(occurrences(s, "cycle_anchor_at >=")).toBe(1);
    expect(occurrences(s, "cycle_anchor_at <")).toBe(1);
  });

  it("answerWhere 도 같은 개수 계약 (술어가 한 벌이므로 같이 움직여야 한다)", () => {
    const s = flat(dialect.sqlToQuery(answerWhere({ ...RANGE, cumulative: true }, [PID])).sql);
    expect(occurrences(s, "a.measured_at >=")).toBe(1);
    expect(occurrences(s, "a.measured_at <")).toBe(1);
  });

  it("기간 바인딩 파라미터는 축당 2개씩 — 앵커 arm + 폴백 arm (총 4)", () => {
    const { params } = dialect.sqlToQuery(
      detailAnswerWhere({ ...RANGE, cumulative: true }, [PID]),
    );
    expect(params.filter((v) => v === RANGE.dateFrom).length).toBe(2);
    expect(params.filter((v) => v === RANGE.dateTo).length).toBe(2);
  });

  it("answerWhere 와 detailAnswerWhere 가 같은 축을 쓴다", () => {
    const a = flat(dialect.sqlToQuery(answerWhere({ ...RANGE, cumulative: true }, [PID])).sql);
    expect(a).toContain("cycle_anchor_at IS NOT NULL");
    expect(a).toContain("cycle_anchor_at IS NULL");
  });

  it("기간이 없으면 앵커 분기를 만들지 않는다 (기본 = 최신 1회차 스냅샷)", () => {
    const s = flat(dialect.sqlToQuery(detailAnswerWhere({ cumulative: true }, [PID])).sql);
    expect(s).not.toContain("cycle_anchor_at");
    expect(s).toContain("a.job_id IN");
  });
});

describe("추이(allRuns)는 축을 바꾸지 않는다", () => {
  // 추이는 버킷 자체가 measured_at 일(day)이라, 필터만 앵커로 옮기면 버킷 경계와
  // 모집단 경계가 어긋난다(반쯤 담긴 버킷). 자기 창을 쓰는 읽기라 대상이 아니다.
  it("allRuns 는 종전대로 measured_at 행 클리핑", () => {
    const s = flat(dialect.sqlToQuery(detailAnswerWhere({ ...RANGE }, [PID], { allRuns: true })).sql);
    expect(s).toMatch(/a\.measured_at >= \$\d+::date/);
    expect(s).not.toContain("cycle_anchor_at");
  });
});

describe("ACR 도 같은 축", () => {
  it("기간이 걸리면 앵커 준-조인으로 판정한다", () => {
    const s = flat(dialect.sqlToQuery(latestAcrPromptRunIds({ ...RANGE, cumulative: true })).sql);
    expect(s).toContain("cycle_anchor_at IS NOT NULL");
    expect(s).toContain("x.run_id IN (SELECT run_id FROM scope_runs");
  });

  it("기간이 없으면 축 술어 자체가 없다", () => {
    const s = flat(dialect.sqlToQuery(latestAcrPromptRunIds({})).sql);
    expect(s).not.toContain("cycle_anchor_at");
  });
});
