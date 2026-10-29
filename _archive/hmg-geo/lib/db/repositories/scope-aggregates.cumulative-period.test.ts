import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { answerWhere } from "./scope-aggregates";

// 2026-09-04 기획 수정(고객 피드백: "기간을 7일/30일로 바꿔도 숫자가 안 바뀐다").
//
// 원인은 기간 의미론이었다 — 기간 필터는 "기간 내 **최신 배치**"를 고르는 데만
// 쓰여서(스냅샷), 두 기간이 같은 회차를 가리키면 결과가 글자 그대로 동일했다.
// 답변분석(Mention·Citation)은 이제 filters.cumulative 로 **기간 내 누적**을
// 요청한다: 배치 선택 대신 measured_at 범위로 행을 좁혀 그 기간의 모든 측정을
// 합산한다. 대시보드·웹사이트 KPI 는 스냅샷 의미론 그대로다.
//
// 이 파일이 고정하는 계약:
//   1) cumulative 면 measured_at 범위 클리핑이 걸린다 (기간이 실제로 작동한다)
//   2) cumulative 면 배치 선택(full-cycle job_id 서브쿼리)을 타지 않는다
//   3) cumulative 인데 기간이 없으면 기본 7일 창으로 막는다 (전 이력 스캔 금지)
//   4) 기본(스냅샷)은 종전 그대로 — 회귀 방지
const compile = (q: SQL) => new PgDialect().sqlToQuery(q);

describe("기간 의미론 — 답변분석은 누적, 그 외는 스냅샷", () => {
  it("cumulative: measured_at 범위로 행을 좁힌다 (종료일 포함)", () => {
    const { sql, params } = compile(
      answerWhere({ cumulative: true, dateFrom: "2026-08-05", dateTo: "2026-09-04" }),
    );
    expect(sql).toContain("a.measured_at >=");
    expect(sql).toContain("a.measured_at < (");
    expect(params).toContain("2026-08-05");
    expect(params).toContain("2026-09-04");
  });

  it("cumulative: 배치 선택(job_id 서브쿼리)을 타지 않는다", () => {
    const cum = compile(
      answerWhere({ cumulative: true, dateFrom: "2026-08-05", dateTo: "2026-09-04" }),
    ).sql;
    expect(cum).not.toContain("a.job_id in");
    expect(cum.toLowerCase()).toContain("a.run_id in");
  });

  it("cumulative 인데 기간이 없으면 기본 7일 창 (전 이력 스캔 금지)", () => {
    const { sql } = compile(answerWhere({ cumulative: true }));
    expect(sql).toContain("a.measured_at >= now() - interval '7 days'");
  });

  it("스냅샷(기본)은 종전대로 — measured_at 클리핑도 누적 기본창도 없다", () => {
    const snap = compile(
      answerWhere({ dateFrom: "2026-08-05", dateTo: "2026-09-04" }),
    ).sql;
    expect(snap).not.toContain("a.measured_at >=");
    expect(snap).not.toContain("interval '7 days'");
  });
});

// 2026-09-04 회귀 — 누적 스위치가 추이 읽기의 창을 덮어쓰면 안 된다.
//
// 답변분석 페이지는 filters.cumulative 를 페이지의 모든 read 에 그대로 넘긴다.
// 추이 리더(readMentionBrandDayCounts 등)는 자기 120일 창을 갖는 allRuns 읽기인데,
// cumulative 의 "기간 미지정 → 기본 7일" 규칙까지 얹히면 주별 그래프가 한 주로
// 접혀 "주별 상위 10개 브랜드/도메인"이 통째로 사라진다(실제 발생).
describe("추이 읽기는 누적 기본창의 영향을 받지 않는다", () => {
  it("allRuns 읽기에는 7일 기본창이 붙지 않는다 (cumulative 필터여도)", () => {
    const { sql } = compile(answerWhere({ cumulative: true }, undefined, { allRuns: true }));
    expect(sql).not.toContain("interval '7 days'");
  });

  it("allRuns 읽기의 명시 기간 클리핑은 그대로 (둘 중 좁은 쪽)", () => {
    const { sql, params } = compile(
      answerWhere({ cumulative: true, dateFrom: "2026-08-05", dateTo: "2026-09-04" }, undefined, {
        allRuns: true,
      }),
    );
    expect(sql).toContain("a.measured_at >=");
    expect(params).toContain("2026-08-05");
  });
});
