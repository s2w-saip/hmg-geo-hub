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
//   3) **기간이 없으면 cumulative 스위치가 켜져 있어도 스냅샷이다** (2026-09-16 개정)
//
// ── 3) 의 개정 근거 (무효 판정) ──────────────────────────────────────────────
// 종전 단언은 "cumulative 인데 기간이 없으면 기본 7일 창"이었고, 그것이 지키려던
// 것은 **전 이력 스캔 금지**였다(기간 없는 누적이 전체 이력을 훑는 것).
//
// 2026-09-16 제품 확정 기획("필터 없음(기본) = 최신 1회차 / 기간 설정 = 그 기간
// 누적")으로 그 단언은 **무효**가 됐다 — 가드가 불필요해진 것이 아니라, 보호하려던
// **상태 자체가 도달 불가능**해졌기 때문이다. `cumulativeMode` 가 기간 없이는
// 누적을 켜지 않으므로 "cumulative 인데 기간이 없는" 술어는 만들어지지 않는다.
// 그리고 대체 단언(스냅샷 = 배치 선택)은 같은 위험을 **더 강하게** 막는다 —
// 스냅샷은 셀당 최신 1건 배치 선택이라 애초에 전 이력 스캔이 아니다.
//
// 기획을 이렇게 바꾼 직접 이유는 기본창이 `now() − 7일`이라 **최근 7일 측정이 없는
// 프로젝트가 통째로 빈 화면**이 되기 때문이다(라이브 실측 2026-09-15 16:30 UTC:
// 루트 제외 scope 프로젝트 186개 중 51개 해당).
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

  it("기간이 없으면 cumulative 스위치가 켜져 있어도 스냅샷 (기본 = 최신 1회차)", () => {
    const { sql } = compile(answerWhere({ cumulative: true }));
    // 스냅샷 = 배치 선택. 전 이력 스캔도, 누적 기본창도 아니다.
    expect(sql).toContain("a.job_id IN");
    expect(sql).not.toContain("a.measured_at >= now() - interval '7 days'");
    // 페이지가 넘기는 값과 무관하게 SQL 이 같아야 한다 — 기본 화면 불변의 계약.
    expect(sql).toBe(compile(answerWhere({})).sql);
  });

  it("기간이 한쪽만 있어도 누적이다 (open-ended)", () => {
    expect(compile(answerWhere({ cumulative: true, dateFrom: "2026-08-05" })).sql)
      .toContain("a.run_id IN");
    expect(compile(answerWhere({ cumulative: true, dateTo: "2026-09-04" })).sql)
      .toContain("a.run_id IN");
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
