// 격자 자리 바닥 ↔ 미러 추이 창 바닥의 **정합** (2026-09-20 통합 병합에서 발견).
//
// 결함: 격자는 "가장 오래된 자리"를 `dateFrom` 으로 넘기는데(`withTrendGridWindow` ·
// `globalSeriesFilters`), 미러 추이 리더는 그 위에 `round_date >= 오늘 − 120` 을 **한 겹 더**
// 건다. 자리 목록 자체는 `TREND_GRID_MAX_DAYS`(180일) 안에서 만들어지므로, 케이던스가
// 멈춰 `trimTrailingUnpublished` 가 끝 자리를 과거에 고정하면 가장 오래된 자리들이
// 120일 밖으로 밀리고 **없던 갭**이 화면에 뜬다. 사실표 경로에는 이 바닥이 없어
// 121~180일 구간에서 두 층이 어긋난다 = 단일 원천 위반.
//
// 여기서 고정하는 것 셋:
//   ① 두 상수가 같다(모듈이 갈라져 있어 import 로는 못 묶는다).
//   ② 격자 on 이면 바닥이 180, off 면 **120 그대로**(바이트 동일).
//   ③ 바깥 바닥과 dim 안쪽 바닥이 **같은 일수**다 — 안쪽이 좁으면 셀이 폴백으로 샌다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { answerWhere, TREND_WINDOW_DAYS, __testables as agg } from "./scope-aggregates";
import { TREND_GRID_MAX_DAYS, TREND_GRID_SLOTS } from "@/lib/period/trend-grid";
import {
  setAnchorAxisForTests,
  resetAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import { setTrendGridForTests, resetTrendGridForTests } from "@/lib/period/trend-grid-flag";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
  resetColumnAvailabilityForTests,
} from "@/lib/db/column-availability";

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q).sql;

function fix(grid: boolean): void {
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, true);
  setAnchorAxisForTests(true, undefined, undefined, { ca: sql`true`, ca2: sql`true` });
  setTrendGridForTests(grid);
}

beforeEach(() => {
  resetTrendGridForTests();
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
});
afterEach(() => {
  resetTrendGridForTests();
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
});

describe("격자 자리 상한과 미러 창 바닥", () => {
  it("① 미러의 격자 바닥 상수 = `TREND_GRID_MAX_DAYS`", () => {
    fix(true);
    expect(agg.trendFloorDays()).toBe(TREND_GRID_MAX_DAYS);
  });

  it("② 격자가 꺼지면 종전 상수 그대로다", () => {
    fix(false);
    expect(agg.trendFloorDays()).toBe(TREND_WINDOW_DAYS);
    expect(compile(agg.trendWindowFloor(undefined, undefined, true, false, agg.trendFloorDays())))
      .toBe(compile(agg.trendWindowFloor(undefined, undefined, true)));
  });

  it("② 격자가 켜지면 180 으로 넓어진다", () => {
    fix(true);
    const t = compile(agg.trendWindowFloor(undefined, undefined, true, false, agg.trendFloorDays()));
    expect(t).toContain(`hmg_anchor_today() - ${TREND_GRID_MAX_DAYS}`);
    expect(t).not.toContain(`hmg_anchor_today() - ${TREND_WINDOW_DAYS}`);
  });

  it("③ dim 안쪽 바닥이 바깥과 같은 일수다 (기간 미고지)", () => {
    fix(true);
    const inner = compile(answerWhere({}, undefined, { allRuns: true, trendRoundFloor: true }));
    expect(inner).toContain(`ca2.round_date >= hmg_anchor_today() - ${TREND_GRID_MAX_DAYS}`);
    // 격자 off 면 dim 경로 자체가 없다 — 안쪽 바닥도 없다(종전 텍스트).
    fix(false);
    expect(compile(answerWhere({}, undefined, { allRuns: true, trendRoundFloor: true })))
      .not.toContain("ca2.round_date");
  });

  it("③ 기간을 고지하면 안쪽 바닥은 그 날짜다 (양쪽 같은 값)", () => {
    fix(true);
    const t = compile(answerWhere({ dateFrom: "2026-05-01" }, undefined, { allRuns: true }));
    expect(t).toContain("ca2.round_date >=");
    expect(t).not.toContain(`ca2.round_date >= hmg_anchor_today() - ${TREND_GRID_MAX_DAYS}`);
  });

  it("자리 개수 × 7일이 상한 안이다 (정상 케이던스에서는 바닥이 안 걸린다)", () => {
    expect(TREND_GRID_SLOTS * 7).toBeLessThan(TREND_WINDOW_DAYS);
    expect(TREND_GRID_MAX_DAYS).toBeGreaterThan(TREND_WINDOW_DAYS);
  });
});
