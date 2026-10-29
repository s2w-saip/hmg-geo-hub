import { describe, it, expect } from "vitest";
import { globalSeriesFilters, G_TREND_WINDOW_DAYS, G_TREND_MIN_CYCLES } from "./server";
import { DELTA_TREND_WINDOW_DAYS } from "./kpi-tab-budget";

// 글로벌 추이 게이트의 **순수 규칙**을 고정한다 — PR③ 검증자 GG-4.
//
// `viaGlobalSeries` 자체는 세션·DB·설정을 태워야 하므로 여기서는 창 계산만 본다.
// 창이 화면마다 갈리면 회차 집합·라우트 셀·코어 read 가 통째로 갈린다 — 이 파일이
// 막는 것이 그 갈림이다(리더 머리 주석의 "read 가 여러 벌" 경고).

const NOW = Date.parse("2026-09-11T00:00:00.000Z");
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 10);

describe("globalSeriesFilters — 세 화면이 같은 창을 본다", () => {
  it("기간 미지정이면 13주 바닥", () => {
    expect(globalSeriesFilters({}, NOW).dateFrom).toBe(day(G_TREND_WINDOW_DAYS));
  });

  it("**Δ 전용 30일 바닥은 걷어내고 13주로 되돌린다**", () => {
    // `deltaTrendFilters` 가 얹은 값 그대로. 그대로 두면 Δ 호출만 회차 집합이 달라져
    // 라우트 셀·코어 read 가 한 벌 더 생긴다.
    const delta = { dateFrom: day(DELTA_TREND_WINDOW_DAYS) };
    expect(globalSeriesFilters(delta, NOW).dateFrom).toBe(day(G_TREND_WINDOW_DAYS));
    // 스파크라인(무필터)과 **같은 창** → 같은 캐시 키 → read 한 벌.
    expect(globalSeriesFilters(delta, NOW)).toEqual(globalSeriesFilters({}, NOW));
  });

  it("사용자가 고른 기간은 존중한다 — 13주보다 좁으면 그쪽이 이긴다", () => {
    expect(globalSeriesFilters({ dateFrom: "2026-09-01" }, NOW).dateFrom).toBe("2026-09-01");
  });

  it("13주보다 넓은 사용자 기간은 13주로 클램프된다", () => {
    expect(globalSeriesFilters({ dateFrom: "2026-01-01" }, NOW).dateFrom)
      .toBe(day(G_TREND_WINDOW_DAYS));
  });

  it("`dateTo` 가 함께 있으면 30일 바닥을 **걷어내지 않는다** — 사용자 기간이다", () => {
    // `deltaTrendFilters` 는 `dateFrom`·`dateTo` 중 하나라도 있으면 필터를 그대로 돌려준다
    // (`live.ts`). 그러므로 `dateTo` 가 있는데 바닥이 30일과 같다면 그것은 우연이 아니라
    // 사용자가 고른 기간이다.
    const f = { dateFrom: day(DELTA_TREND_WINDOW_DAYS), dateTo: "2026-09-10" };
    expect(globalSeriesFilters(f, NOW).dateFrom).toBe(day(DELTA_TREND_WINDOW_DAYS));
  });

  it("다른 축(필터)은 그대로 통과한다", () => {
    const out = globalSeriesFilters({ region: ["KR"], engine: ["chatgpt"] }, NOW);
    expect(out.region).toEqual(["KR"]);
    expect(out.engine).toEqual(["chatgpt"]);
  });
});

describe("점화 조건 상수", () => {
  it("시계열이 되려면 회차가 둘 이상", () => {
    expect(G_TREND_MIN_CYCLES).toBe(2);
  });
  it("읽기 창은 13주", () => {
    expect(G_TREND_WINDOW_DAYS).toBe(91);
  });
});
