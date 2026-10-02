import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  answerMeasuredAxis,
  periodAxis,
  periodBounds,
  periodBoundsClause,
  periodBoundsPredicate,
  runAnchorAxis,
  runStartedAxis,
} from "./period-bounds";

// 여섯 자리에 복사돼 있던 경계 두 줄을 빌더 하나로 모았다. 아래 기대 문자열은
// 리팩터 직전 소스에서 그대로 옮긴 것이다 — 호출부는 그 두 줄을 빌더 호출로
// 치환했을 뿐이므로, 이 단언이 곧 바이트 동일성 증명이다.

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q).sql;
const FROM = "2026-08-20";
const TO = "2026-09-04";

describe("축 식 — 종전 인라인과 글자가 같아야 한다", () => {
  it("run_started (dateBoundPredicate/Clause)", () =>
    expect(text(runStartedAxis().expr)).toBe("COALESCE(r.cycle_anchor_at, r.started_at)"));

  it("run_anchor (cumulativeRunWindow 서브쿼리 안 — 별칭 없음)", () =>
    expect(text(runAnchorAxis().expr)).toBe("cycle_anchor_at"));

  it("answer_measured (행 클리핑 — 별칭 표기는 호출부가 준다)", () => {
    expect(text(answerMeasuredAxis(sql`a.measured_at`).expr)).toBe("a.measured_at");
    expect(text(answerMeasuredAxis(sql.raw("measured_at")).expr)).toBe("measured_at");
  });

  // 앵커 축(`anchor_round`)의 전용 단언은 `anchor-axis.test.ts` 에 있다. 여기서는
  // 축 생성기가 상한 옵션을 **명시할 때만** 포함 상한을 낸다는 것만 고정한다 —
  // 기본값이 바뀌면 종전 네 축의 상한이 하루씩 움직인다.
  it("inclusiveUpper 는 명시할 때만 붙는다", () => {
    expect(periodAxis("anchor_round", sql`ca.round_date`).inclusiveUpper).toBeUndefined();
    expect(
      periodAxis("anchor_round", sql`ca.round_date`, { inclusiveUpper: true }).inclusiveUpper,
    ).toBe(true);
    for (const ax of [runStartedAxis(), runAnchorAxis(), answerMeasuredAxis(sql`a.measured_at`)]) {
      expect(ax.inclusiveUpper, ax.name).toBeUndefined();
    }
  });
});

describe("경계 술어 — 종전 두 줄과 글자가 같아야 한다", () => {
  const ax = runStartedAxis();

  it("양쪽 모두", () => {
    const b = periodBounds({ dateFrom: FROM, dateTo: TO }, ax);
    expect(b.map(text)).toEqual([
      "COALESCE(r.cycle_anchor_at, r.started_at) >= $1::date",
      "COALESCE(r.cycle_anchor_at, r.started_at) < ($1::date + 1)",
    ]);
  });

  it("한쪽만 — 순서는 from → to", () => {
    expect(periodBounds({ dateFrom: FROM }, ax).map(text)).toEqual([
      "COALESCE(r.cycle_anchor_at, r.started_at) >= $1::date",
    ]);
    expect(periodBounds({ dateTo: TO }, ax).map(text)).toEqual([
      "COALESCE(r.cycle_anchor_at, r.started_at) < ($1::date + 1)",
    ]);
  });

  it("기간 없음 — 빈 배열", () => {
    expect(periodBounds({}, ax)).toEqual([]);
    expect(periodBounds({ dateFrom: null, dateTo: null }, ax)).toEqual([]);
    expect(periodBounds({ dateFrom: "", dateTo: "" }, ax)).toEqual([]);
  });

  it("predicate — 기간 없으면 true(무경계)", () => {
    expect(text(periodBoundsPredicate({}, ax))).toBe("true");
    expect(text(periodBoundsPredicate({ dateFrom: FROM, dateTo: TO }, ax))).toBe(
      "COALESCE(r.cycle_anchor_at, r.started_at) >= $1::date AND COALESCE(r.cycle_anchor_at, r.started_at) < ($2::date + 1)",
    );
  });

  it("clause — 선행 AND, 기간 없으면 빈 조각", () => {
    expect(text(periodBoundsClause({}, ax))).toBe("");
    expect(text(periodBoundsClause({ dateFrom: FROM, dateTo: TO }, ax))).toBe(
      " AND COALESCE(r.cycle_anchor_at, r.started_at) >= $1::date AND COALESCE(r.cycle_anchor_at, r.started_at) < ($2::date + 1)",
    );
  });

  it("상한은 종료일 포함(+1일 미만) — 반개구간", () => {
    const { params } = dialect.sqlToQuery(
      periodBoundsPredicate({ dateFrom: FROM, dateTo: TO }, ax),
    );
    expect(params).toEqual([FROM, TO]);
  });
});
