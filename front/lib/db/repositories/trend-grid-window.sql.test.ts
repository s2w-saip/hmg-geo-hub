import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { answerWhere, __testables as agg } from "./scope-aggregates";
import { roundDateLowerBounds } from "./__fixtures__/sql-bounds";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import {
  setAnchorAxisForTests,
  resetAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import {
  setTrendGridForTests,
  resetTrendGridForTests,
} from "@/lib/period/trend-grid-flag";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
  resetColumnAvailabilityForTests,
} from "@/lib/db/column-availability";

// ════════════════════════════════════════════════════════════════════════════
// 통합 B1 — **SQL 을 거쳐** 실효 하한이 자리 창과 같은지 본다
// ════════════════════════════════════════════════════════════════════════════
//
// 왜 순수 함수 테스트로는 부족한가: `round_date` 하한은 두 곳에서 나온다.
//
//   ① `trendWindowFloor` 의 창 바닥       `ca.round_date >= hmg_anchor_today() - N`
//   ② `answerWhere` 의 기간 술어          `ca.round_date >= '<dateFrom>'::date`
//
// 둘은 **AND** 로 결합되므로 **좁은 쪽이 이긴다.** 호출부가 `dateFrom = S0` 를 심어도
// ①이 120 이면 `S0 < 오늘 − 120` 인 구간에서 값은 120일에서 잘리고, 자리는 180일까지
// 뻗으므로 그 차이만큼이 `no_value` 갭(화면에서는 수집 오류와 같은 음영)이 된다.
// 1차 수리가 ②만 넣고 ①을 안 걷어내 B1 이 안 닫혔던 자리가 정확히 여기다.
//
// 그래서 이 파일은 **컴파일된 SQL 텍스트에서 하한을 전부 뽑아** 가장 좁은 것을 본다.

const dialect = new PgDialect();
const compile = (q: SQL): string => dialect.sqlToQuery(q).sql;

/** 오늘 기준 150일 전 — B1 의 정의(`S0 < 오늘 − 120`)를 만족하는 자리 바닥. */
const S0 = "2026-04-23";
const FILTERS: StandardFilters = { dateFrom: S0 };

// 추출 헬퍼는 **한 벌**이다(`__fixtures__/sql-bounds.ts`) — 테스트 파일끼리 import 하면
// 그쪽 describe 가 같이 돌아 결과가 섞인다(2026-09-20 회귀 수리 때 실제로 겪었다).

/** 상수 바닥(`hmg_anchor_today() - N`)의 N. 기간 술어면 `null`. */
function floorDays(bound: string): number | null {
  const m = /hmg_anchor_today\(\)\s*-\s*(\d+)/.exec(bound);
  return m ? Number(m[1]) : null;
}

beforeEach(() => {
  setColumnAvailabilityForTests(
    Object.fromEntries(SYNC_PROBED_COLUMNS.map((c) => [c, true])) as never,
  );
  // 축 on — 격자는 축을 선행 조건으로 둔다.
  setAnchorAxisForTests(true);
});
afterEach(() => {
  resetColumnAvailabilityForTests();
  resetAnchorAxisForTests();
  resetTrendGridForTests();
});

describe("주별 Top-N 두 리더의 창 바닥 (B1)", () => {
  it("격자 on · 격자에 얹히는 호출 → 바닥이 180 이라 실효 하한이 S0 다", () => {
    setTrendGridForTests(true);
    // 리더가 **실제로 거는** 조각이다(재조립이 아니다 — `__testables` 로 낸 같은 함수).
    const floor = compile(agg.weeklyTopNTrendFloor(true));
    const period = compile(answerWhere(FILTERS, undefined, { allRuns: true }));
    const bounds = [...roundDateLowerBounds(floor), ...roundDateLowerBounds(period)];
    expect(bounds.length, "하한을 하나도 못 뽑았다 — 추출기가 썩었다").toBeGreaterThan(0);

    const days = bounds.map(floorDays).filter((d): d is number => d !== null);
    // 창 바닥은 180 이어야 한다. 120 이 남아 있으면 그쪽이 더 좁아 S0 를 덮는다.
    expect(days, "창 바닥에 120 이 남아 있다 — B1 미해소").not.toContain(120);
    expect(days).toContain(180);
    // 기간 술어(= S0)가 **가장 좁은 하한**이다: 150 < 180.
    expect(Math.min(...days), "상수 바닥이 S0(150일 전)보다 좁다").toBeGreaterThan(150);
  });

  it("**변이** — 격자에 안 얹힌다고 하면(1차 수리 상태) 바닥이 120 이라 S0 가 잘린다", () => {
    setTrendGridForTests(true);
    const floor = compile(agg.weeklyTopNTrendFloor(false));
    const days = roundDateLowerBounds(floor)
      .map(floorDays)
      .filter((d): d is number => d !== null);
    expect(days, "변이가 안 먹었다 — 이 테스트가 결함을 못 잡는다").toContain(120);
    // 120 < 150 이므로 이 하한이 이긴다 = 30일치 자리가 거짓 갭이 된다.
    expect(Math.min(...days)).toBeLessThan(150);
  });

  it("격자 off 면 두 판본이 **같은 텍스트**다 — 바이트 무변경", () => {
    setTrendGridForTests(false);
    expect(compile(agg.weeklyTopNTrendFloor(true)))
      .toBe(compile(agg.weeklyTopNTrendFloor(false)));
    const days = roundDateLowerBounds(compile(agg.weeklyTopNTrendFloor(true)))
      .map(floorDays)
      .filter((d): d is number => d !== null);
    expect(days).toContain(120);
    expect(days).not.toContain(180);
  });

  it("`caJoined` 판본(인용 리더)도 같은 바닥을 쓴다", () => {
    setTrendGridForTests(true);
    const joined = roundDateLowerBounds(compile(agg.weeklyTopNTrendFloor(true, true)))
      .map(floorDays)
      .filter((d): d is number => d !== null);
    expect(joined).toContain(180);
    expect(joined).not.toContain(120);
  });
});

describe("격자에 얹히는 값 원천 전부 — 상수 바닥이 자리 상한과 같다", () => {
  /**
   * 값이 격자에 닿는 경로의 **창 바닥** 전수. 셋은 `trendFloorDays(unit)` 를 직접 싣고,
   * 주별 Top-N 둘은 `weeklyTopNTrendFloor` 를 경유한다. 어느 쪽이든 격자 on·주 단위면
   * 180 이어야 한다 — 하나라도 120 이면 그 지면만 자리보다 값이 좁다.
   */
  const FLOORS: Array<[string, () => SQL]> = [
    ["주별 Top-N (언급)", () => agg.weeklyTopNTrendFloor(true)],
    ["주별 Top-N (인용)", () => agg.weeklyTopNTrendFloor(true, true)],
    [
      "메인 추이 버킷",
      () => agg.trendWindowFloor(undefined, undefined, false, false, agg.trendFloorDays("week")),
    ],
    [
      "인용 정확도 ⑥",
      () => agg.trendWindowFloor(undefined, undefined, false, false, agg.trendFloorDays("week")),
    ],
  ];

  it.each(FLOORS)("%s 의 상수 바닥은 180 이다", (_label, make) => {
    setTrendGridForTests(true);
    const days = roundDateLowerBounds(compile(make()))
      .map(floorDays)
      .filter((d): d is number => d !== null);
    expect(days).toEqual([180]);
  });

  it("일 버킷은 격자를 안 얹으므로 120 그대로다 (W2)", () => {
    setTrendGridForTests(true);
    expect(agg.trendFloorDays("day")).toBe(120);
    expect(agg.trendFloorDays("week")).toBe(180);
  });
});

describe("추출 헬퍼 자체", () => {
  it("창 바닥과 기간 술어를 둘 다 잡는다", () => {
    const text = compile(
      sql`ca.round_date >= hmg_anchor_today() - 120 AND ca2.round_date >= ${S0}::date`,
    );
    expect(roundDateLowerBounds(text)).toHaveLength(2);
  });

  it("하한이 없으면 빈 배열이다 — 공허한 통과를 막는다", () => {
    expect(roundDateLowerBounds("SELECT 1")).toEqual([]);
  });
});
