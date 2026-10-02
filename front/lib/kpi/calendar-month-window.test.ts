import { describe, expect, it } from "vitest";
import {
  monthWindow,
  resolveCalendarMonths,
  resolvePeriodCompareShape,
  selectedWindowDays,
} from "./calendar-month-window";

describe("monthWindow — 말일은 달력이 센다", () => {
  it.each([
    [2026, 1, "2026-01-01", "2026-01-31"],
    [2026, 2, "2026-02-01", "2026-02-28"],
    [2028, 2, "2028-02-01", "2028-02-29"], // 윤년
    [2026, 4, "2026-04-01", "2026-04-30"],
    [2026, 9, "2026-09-01", "2026-09-30"],
    [2026, 12, "2026-12-01", "2026-12-31"],
  ])("%i-%i → %s ~ %s", (y, m, lo, hi) => {
    expect(monthWindow(y, m)).toEqual({ lo, hi });
  });

  it("월 번호가 범위를 넘으면 연도로 넘긴다", () => {
    expect(monthWindow(2027, 0)).toEqual({ lo: "2026-12-01", hi: "2026-12-31" });
    expect(monthWindow(2027, -1)).toEqual({ lo: "2026-11-01", hi: "2026-11-30" });
    expect(monthWindow(2026, 13)).toEqual({ lo: "2027-01-01", hi: "2027-01-31" });
  });
});

describe("resolveCalendarMonths — 날짜쌍의 모양으로 판정한다", () => {
  it("이번 달(진행 중): cur 은 부분 월, prev·before 는 전체 월", () => {
    // "이번 달" 프리셋 = KST 이번 달 1일 ~ E
    expect(resolveCalendarMonths("2026-09-01", "2026-09-13")).toEqual({
      cur: { lo: "2026-09-01", hi: "2026-09-13" },
      prev: { lo: "2026-08-01", hi: "2026-08-31" },
      before: { lo: "2026-07-01", hi: "2026-07-31" },
    });
  });

  it("지난달(완결): cur 도 전체 월이다", () => {
    expect(resolveCalendarMonths("2026-08-01", "2026-08-31")).toEqual({
      cur: { lo: "2026-08-01", hi: "2026-08-31" },
      prev: { lo: "2026-07-01", hi: "2026-07-31" },
      before: { lo: "2026-06-01", hi: "2026-06-30" },
    });
  });

  it("연 경계를 넘는다 — 1월의 직전은 전년 12·11월", () => {
    expect(resolveCalendarMonths("2027-01-01", "2027-01-31")).toEqual({
      cur: { lo: "2027-01-01", hi: "2027-01-31" },
      prev: { lo: "2026-12-01", hi: "2026-12-31" },
      before: { lo: "2026-11-01", hi: "2026-11-30" },
    });
  });

  it("월초 하루만 지난 상태도 달력 월이다 (E 가 아직 지난달이면 화면은 no_data 로 닫는다)", () => {
    expect(resolveCalendarMonths("2026-10-01", "2026-10-02")?.cur).toEqual({
      lo: "2026-10-01",
      hi: "2026-10-02",
    });
  });

  it("시작일이 1일이 아니면 창 비교다", () => {
    expect(resolveCalendarMonths("2026-09-02", "2026-09-30")).toBeNull();
    // 30일 트레일링 프리셋이 달력 월로 오인되지 않는다.
    expect(resolveCalendarMonths("2026-08-15", "2026-09-13")).toBeNull();
  });

  it("끝일이 다른 달이면 창 비교다", () => {
    expect(resolveCalendarMonths("2026-09-01", "2026-10-01")).toBeNull();
    // 정확히 1년(1/1 ~ 12/31)도 달력 '월'이 아니다.
    expect(resolveCalendarMonths("2026-01-01", "2026-12-31")).toBeNull();
  });

  it("말일을 넘는 날짜는 그 달이 아니다", () => {
    expect(resolveCalendarMonths("2026-02-01", "2026-02-30")).toBeNull();
  });

  it("한쪽만 채운 open-ended·형식 오류는 null 이다", () => {
    expect(resolveCalendarMonths("2026-09-01", null)).toBeNull();
    expect(resolveCalendarMonths(null, "2026-09-30")).toBeNull();
    expect(resolveCalendarMonths(undefined, undefined)).toBeNull();
    expect(resolveCalendarMonths("nope", "2026-09-30")).toBeNull();
    expect(resolveCalendarMonths("2026-13-01", "2026-13-31")).toBeNull();
  });

  it("세 구간은 서로 겹치지 않고 시간순이다", () => {
    const m = resolveCalendarMonths("2026-09-01", "2026-09-13")!;
    expect(m.before.hi < m.prev.lo).toBe(true);
    expect(m.prev.hi < m.cur.lo).toBe(true);
  });

  // 끝점이 어디든 "1일부터 그 달 안"이면 달력 월이다. 달력 프리셋(이번 달·지난달)이
  // 2026-09-20 에 선택지에서 내려간 뒤로는 이 경로가 **사용자가 달력에서 직접 고른
  // 범위**와 그렇게 공유된 옛 URL 을 받는다. MoM 이 창 비교로 떨어지면 안 된다.
  it.each(["2026-09-14", "2026-09-18", "2026-09-20", "2026-09-30"])(
    "2026-09-01..%s 는 calendarMonth 다 (직접 선택·옛 공유 URL)",
    (to) => {
      const m = resolveCalendarMonths("2026-09-01", to);
      expect(m, `${to} 가 달력 월로 안 읽힌다`).not.toBeNull();
      expect(m!.cur).toEqual({ lo: "2026-09-01", hi: to });
      expect(m!.prev).toEqual({ lo: "2026-08-01", hi: "2026-08-31" });
    },
  );
});

// ── 4지면 공통 판정 (2026-09-19 프리뷰 실측 결함의 회귀 그물) ───────────────
//
// 대시보드만 `kind:"window"` 를 하드코딩해서, 같은 URL 이 화면마다 다른 수를 냈다:
// `?time=2026-09-01..2026-09-13` → 대시보드 13일 트레일링(+8.6pp) vs 언급 달력 월(+6.5pp).
// 스펙「달력 월 프리셋은 확정 MoM 정책을 따른다」(spec.md:242-250) SHALL 위반.
//
// 지면별로 따로 고정하는 이유: "같은 함수를 쓴다" 는 grep 으로 증명되지 않는다 —
// 네 지면이 **같은 날짜쌍에서 같은 kind** 를 받는다는 명제를 값으로 박는다.
describe("resolvePeriodCompareShape — 4지면이 같은 날짜쌍에서 같은 kind 를 받는다", () => {
  const SURFACES = ["dashboard", "website", "mention", "citation"] as const;

  it.each(SURFACES)("%s: 달력 월 URL 은 calendarMonth 다", () => {
    const shape = resolvePeriodCompareShape("2026-09-01", "2026-09-13");
    expect(shape.kind).toBe("calendarMonth");
    expect(shape.months).toEqual({
      cur: { lo: "2026-09-01", hi: "2026-09-13" },
      prev: { lo: "2026-08-01", hi: "2026-08-31" },
      before: { lo: "2026-07-01", hi: "2026-07-31" },
    });
    expect(shape.days).toBe(13);
  });

  it.each(SURFACES)("%s: 트레일링 창 URL 은 window 이고 months 가 없다", () => {
    const shape = resolvePeriodCompareShape("2026-08-15", "2026-09-13");
    expect(shape.kind).toBe("window");
    expect(shape.months).toBeUndefined();
    expect(shape.days).toBe(30);
  });

  it("지난달(완결 월)도 calendarMonth 다", () => {
    const shape = resolvePeriodCompareShape("2026-08-01", "2026-08-31");
    expect(shape.kind).toBe("calendarMonth");
    expect(shape.months?.prev).toEqual({ lo: "2026-07-01", hi: "2026-07-31" });
    expect(shape.days).toBe(31);
  });

  it("기간 미선택·open-ended 는 window + days null (게이트웨이가 null 로 닫는다)", () => {
    for (const [a, b] of [
      [null, null],
      ["2026-09-01", null],
      [null, "2026-09-30"],
    ] as Array<[string | null, string | null]>) {
      const shape = resolvePeriodCompareShape(a, b);
      expect(shape.kind).toBe("window");
      expect(shape.days).toBeNull();
      expect(shape.months).toBeUndefined();
    }
  });

  it("프리셋 4종의 날짜쌍은 전부 window 다 (달력 월로 새지 않는다)", () => {
    // E = 2026-09-13 기준 weekly·biweekly·monthly·yearly
    for (const [lo, hi, days] of [
      ["2026-09-07", "2026-09-13", 7],
      ["2026-08-31", "2026-09-13", 14],
      ["2026-08-15", "2026-09-13", 30],
      ["2025-09-13", "2026-09-13", 366],
    ] as Array<[string, string, number]>) {
      const shape = resolvePeriodCompareShape(lo, hi);
      expect(shape.kind, `${lo}..${hi}`).toBe("window");
      expect(shape.days).toBe(days);
    }
  });
});

describe("selectedWindowDays — 양 끝 포함", () => {
  it.each([
    ["2026-09-07", "2026-09-13", 7],
    ["2026-09-13", "2026-09-13", 1],
    ["2025-12-26", "2026-01-01", 7],
    ["2028-02-28", "2028-03-01", 3],
  ])("%s ~ %s = %i일", (lo, hi, n) => {
    expect(selectedWindowDays(lo, hi)).toBe(n);
  });

  it("역순·깨진 값·한쪽만은 null", () => {
    expect(selectedWindowDays("2026-09-13", "2026-09-07")).toBeNull();
    expect(selectedWindowDays("nope", "2026-09-13")).toBeNull();
    expect(selectedWindowDays("2026-09-07", null)).toBeNull();
  });
});
