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

// ════════════════════════════════════════════════════════════════════════════
// 격자 on 의 바닥 — **자리에서 온다** (검증 B1, 2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 91일 상수는 `now` 기준이고 자리 13개의 84일은 첫 자리와 **끝 자리** 사이 간격이다.
// 그래서 `now > lastSlot + 7일` 이 되는 순간 가장 오래된 자리가 바닥에 잘려 **없던
// 결측**이 뜬다. 케이던스가 멈추면 멈춘 주 수만큼 동시에 잘린다.
describe("globalSeriesFilters — 격자 바닥", () => {
  /** 미러 실측 자리(13개, 월요일): 06-22 … 09-14. */
  const FIRST = "2026-06-22";
  const LAST = "2026-09-14";

  // 손계산: 09-14 + 21일 = 2026-10-05. 거기서 91일을 빼면 2026-07-06 이고, 그것은
  // 첫 자리 06-22 보다 **14일 뒤**다 → 06-22·06-29 두 자리가 회차 집합에서 빠진다.
  const NOW_PLUS_21 = Date.parse(`${LAST}T00:00:00.000Z`) + 21 * 86_400_000;

  it("상수 바닥은 끝 자리 + 21일에서 **첫 자리를 자른다**(이것이 B1 결함)", () => {
    expect(globalSeriesFilters({ dateFrom: FIRST }, NOW_PLUS_21).dateFrom).toBe("2026-07-06");
  });

  it("자리 바닥을 주면 13자리 전부가 창 안이다", () => {
    const out = globalSeriesFilters({ dateFrom: FIRST }, NOW_PLUS_21, FIRST);
    expect(out.dateFrom).toBe(FIRST);
    // 자리 13개가 전부 바닥 이상 = 값이 붙을 수 있다.
    const slots = Array.from({ length: 13 }, (_, i) =>
      new Date(Date.parse(`${FIRST}T00:00:00.000Z`) + i * 7 * 86_400_000)
        .toISOString().slice(0, 10),
    );
    expect(slots[12]).toBe(LAST);
    expect(slots.every((d) => d >= (out.dateFrom as string))).toBe(true);
  });

  it("케이던스가 3주 멈춰도(끝 자리 + 28일) 자리 바닥은 안 밀린다", () => {
    const now = Date.parse(`${LAST}T00:00:00.000Z`) + 28 * 86_400_000;
    expect(globalSeriesFilters({ dateFrom: FIRST }, now, FIRST).dateFrom).toBe(FIRST);
    // 상수 바닥이었으면 07-13 까지 밀려 자리 셋이 잘린다.
    expect(globalSeriesFilters({ dateFrom: FIRST }, now).dateFrom).toBe("2026-07-13");
  });

  it("사용자가 자리보다 좁은 기간을 고르면 그쪽이 이긴다", () => {
    expect(
      globalSeriesFilters({ dateFrom: "2026-08-31" }, NOW_PLUS_21, FIRST).dateFrom,
    ).toBe("2026-08-31");
  });

  it("자리 바닥이 null 이면 종전 상수 그대로 — 키 off 무변경", () => {
    expect(globalSeriesFilters({}, NOW, null)).toEqual(globalSeriesFilters({}, NOW));
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
