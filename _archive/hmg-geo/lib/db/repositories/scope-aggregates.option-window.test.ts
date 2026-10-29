import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { optionWindowPredicate } from "./scope-aggregates";

// 2026-09-04 고객 지시: "비어있는 측정은 안 보이게 해야 한다".
//
// 필터 옵션(국가·언어·매트릭스)은 종전에 창을 안 걸어 **이력에 한 번이라도 측정된**
// 값을 전부 냈다. 그래서 측정이 멈춘 시장이 드롭다운에 남고 고르면 빈 화면이 됐다 —
// 프로덕션 실측: 이집트(EG)가 8/25 이후 측정 0인데 45개국 목록에 계속 노출됐고,
// 창을 걸면 44개국이 된다(과거 기간을 명시하면 그때 측정이 있으므로 다시 나온다).
//
// 이 파일이 고정하는 계약은 하나 — **옵션의 창 = 데이터의 창**. 두 규칙이 갈라지면
// 다시 "옵션엔 있는데 고르면 0건"이 된다. 데이터 경로(snapshotAnswerIds 루트 분기)는
// 명시 기간이 있으면 그 범위, 없으면 최근 7일을 **run 의 started_at** 으로 판정한다.
const compile = (q: SQL) => new PgDialect().sqlToQuery(q);

describe("optionWindowPredicate — 옵션 창은 데이터 창과 같아야 한다", () => {
  it("기간 미지정이면 최근 7일 (데이터 경로의 기본 창과 동일)", () => {
    const { sql } = compile(optionWindowPredicate());
    expect(sql).toContain("r.started_at >= now() - interval '7 days'");
  });

  it("빈 객체도 기본 창으로 떨어진다", () => {
    expect(compile(optionWindowPredicate({})).sql).toContain("interval '7 days'");
  });

  it("기간을 지정하면 그 범위 — 상한은 종료일 포함(+1일 미만)", () => {
    const { sql, params } = compile(
      optionWindowPredicate({ dateFrom: "2026-08-20", dateTo: "2026-08-27" }),
    );
    expect(sql).toContain("r.started_at >=");
    expect(sql).toContain("r.started_at < (");
    expect(sql).not.toContain("interval '7 days'");
    expect(params).toContain("2026-08-20");
    expect(params).toContain("2026-08-27");
  });

  it("한쪽만 지정해도 기본 창으로 되돌아가지 않는다", () => {
    expect(compile(optionWindowPredicate({ dateFrom: "2026-08-20" })).sql).not.toContain(
      "interval '7 days'",
    );
    expect(compile(optionWindowPredicate({ dateTo: "2026-08-27" })).sql).not.toContain(
      "interval '7 days'",
    );
  });

  it("판정 기준은 measured_at 이 아니라 run 의 started_at (데이터 경로와 동일 축)", () => {
    expect(compile(optionWindowPredicate()).sql).not.toContain("measured_at");
  });
});
