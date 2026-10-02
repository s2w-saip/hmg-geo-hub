import { describe, expect, it } from "vitest";
import {
  isoDowOf,
  weekMondayOf,
  weekWindowOf,
  regularRoundDateOf,
  resolveCalendarWeeks,
  resolveComparePeriodShape,
  REGULAR_ROUND_DOW,
} from "./period-compare-week";
import {
  CALENDAR_WEEK_DAYS,
  appliesMissingShare,
  computeCompare,
  type CompareLedger,
  type ComparePeriod,
} from "./period-compare";
import { periodCaption, toPeriodDeltaView } from "./period-compare-view";

// 주 단위 비교(WoW). 날짜 기대값은 전부 **손계산 리터럴**이다(달력으로 확인한 요일):
//   2026-09-07 월 · 09-11 금 · 09-13 일 · 09-14 월 · 09-18 금 · 09-19 토 · 09-21 월
//   2026-08-31 월 · 2026-06-01 월

describe("주 경계 — anchor_week 와 같은 월요일", () => {
  it("요일 번호는 ISO(월=1 … 일=7)", () => {
    expect(isoDowOf("2026-09-14")).toBe(1);
    expect(isoDowOf("2026-09-18")).toBe(5);
    expect(isoDowOf("2026-09-19")).toBe(6);
    expect(isoDowOf("2026-09-13")).toBe(7);
  });

  it("그 주의 월요일", () => {
    expect(weekMondayOf("2026-09-14")).toBe("2026-09-14"); // 월요일 자신
    expect(weekMondayOf("2026-09-18")).toBe("2026-09-14");
    expect(weekMondayOf("2026-09-19")).toBe("2026-09-14");
    expect(weekMondayOf("2026-09-13")).toBe("2026-09-07"); // 일요일은 **앞 주**다
    expect(weekMondayOf("2026-09-21")).toBe("2026-09-21");
  });

  it("주 구간은 월~일 7일(양 끝 포함)", () => {
    expect(weekWindowOf("2026-09-14")).toEqual({ lo: "2026-09-14", hi: "2026-09-20" });
    expect(CALENDAR_WEEK_DAYS).toBe(7);
  });
});

describe("정규 요일 귀속 (스펙 §9.2)", () => {
  it("글로벌은 월요일, 웹사이트는 금요일", () => {
    expect(REGULAR_ROUND_DOW).toEqual({ global: 1, website: 5 });
    // 같은 주 안의 어느 날을 넣어도 그 주의 정규 요일로 떨어진다.
    for (const day of ["2026-09-14", "2026-09-16", "2026-09-18", "2026-09-20"]) {
      expect(regularRoundDateOf("global", day), day).toBe("2026-09-14");
      expect(regularRoundDateOf("website", day), day).toBe("2026-09-18");
    }
  });

  it("일요일은 앞 주의 정규 회차로 간다(주 경계와 같은 규칙)", () => {
    expect(regularRoundDateOf("global", "2026-09-13")).toBe("2026-09-07");
    expect(regularRoundDateOf("website", "2026-09-13")).toBe("2026-09-11");
  });

  it("글로벌·웹사이트 귀속일은 **같은 주 버킷**에 들어간다", () => {
    expect(weekMondayOf(regularRoundDateOf("global", "2026-09-17"))).toBe("2026-09-14");
    expect(weekMondayOf(regularRoundDateOf("website", "2026-09-17"))).toBe("2026-09-14");
  });
});

describe("resolveCalendarWeeks", () => {
  it("월요일 시작 + 같은 주 안이면 주 비교다 (진행 중인 주는 부분 주)", () => {
    expect(resolveCalendarWeeks("2026-09-14", "2026-09-18")).toEqual({
      cur: { lo: "2026-09-14", hi: "2026-09-18" },
      prev: { lo: "2026-09-07", hi: "2026-09-13" },
      before: { lo: "2026-08-31", hi: "2026-09-06" },
    });
  });

  it("온전한 주(월~일)도 같은 판정이다", () => {
    const w = resolveCalendarWeeks("2026-09-07", "2026-09-13");
    expect(w?.cur).toEqual({ lo: "2026-09-07", hi: "2026-09-13" });
    expect(w?.prev).toEqual({ lo: "2026-08-31", hi: "2026-09-06" });
  });

  it("시작이 월요일이 아니면 주가 아니다(= 창 비교)", () => {
    expect(resolveCalendarWeeks("2026-09-15", "2026-09-18")).toBeNull();
  });

  it("끝이 그 주를 넘으면 주가 아니다", () => {
    expect(resolveCalendarWeeks("2026-09-14", "2026-09-21")).toBeNull();
  });

  it("한쪽이 비거나 형식이 아니거나 역순이면 null", () => {
    expect(resolveCalendarWeeks("2026-09-14", null)).toBeNull();
    expect(resolveCalendarWeeks(undefined, "2026-09-18")).toBeNull();
    expect(resolveCalendarWeeks("2026-13-01", "2026-13-02")).toBeNull();
    expect(resolveCalendarWeeks("2026-09-18", "2026-09-14")).toBeNull();
  });
});

describe("resolveComparePeriodShape — 월 → 주 → 창", () => {
  it("달력 월이 이긴다 (1일이 월요일인 달의 첫 주)", () => {
    // 2026-06-01 은 월요일이라 주 판정도 참이지만 월이 먼저다.
    const s = resolveComparePeriodShape("2026-06-01", "2026-06-07");
    expect(s.kind).toBe("calendarMonth");
    expect(s.weeks).toBeUndefined();
    expect(s.days).toBe(7);
  });

  it("월이 아니면 주를 본다", () => {
    const s = resolveComparePeriodShape("2026-09-14", "2026-09-18");
    expect(s.kind).toBe("calendarWeek");
    expect(s.weeks?.prev).toEqual({ lo: "2026-09-07", hi: "2026-09-13" });
    expect(s.days).toBe(5);
  });

  it("둘 다 아니면 창이다", () => {
    const s = resolveComparePeriodShape("2026-09-08", "2026-09-14");
    expect(s.kind).toBe("window");
    expect(s.days).toBe(7);
  });

  it("기간 미선택이면 창 + days null", () => {
    expect(resolveComparePeriodShape(null, null)).toEqual({ kind: "window", days: null });
  });
});

// ── 주 비교의 산식 계층 ─────────────────────────────────────────────────────

const LEDGER = (over: Partial<CompareLedger> = {}): CompareLedger => ({
  plannedUnits: 1_000,
  missingUnits: 0,
  publishedCycles: 1,
  dataCycles: 1,
  firstPublishedAnchor: "2026-01-05",
  ...over,
});

const WEEK = (key: string, lo: string, hi: string, l: CompareLedger): ComparePeriod => ({
  key,
  lo,
  hi,
  measures: { visibility: { numerator: 700, denominator: 1_000 } },
  ledger: l,
});

const OPTS = { kind: "calendarWeek" as const, metrics: ["visibility"] as const };

describe("주 비교는 MoM 과 같은 산식 계층을 탄다", () => {
  // 2026-09-20 정정(검증 W6): 주 단위에도 누락 30% 임계를 **적용한다**. 종전에는
  // "한 주에 정규 회차가 하나뿐이라 비중이 0% 아니면 100%" 라는 이유로 껐는데, 원장은
  // (프로젝트 × 회차)마다 한 행이라 함대에서는 연속값이다. 확정 요구사항 A안·계약 §3·
  // 스펙 §5.2 어디에도 주 단위 예외가 없다.
  it("누락 30% 임계를 **적용한다**(월과 같은 정의)", () => {
    expect(appliesMissingShare({ kind: "calendarWeek", days: 7 })).toBe(true);
    expect(appliesMissingShare({ kind: "calendarWeek", days: 365 })).toBe(true);
    const dirty = LEDGER({ plannedUnits: 1_000, missingUnits: 900 }); // 90%
    const r = computeCompare(
      WEEK("2026-09-07", "2026-09-07", "2026-09-13", dirty),
      WEEK("2026-09-14", "2026-09-14", "2026-09-18", LEDGER()),
      OPTS,
    );
    expect(r[0]!.reason).toBe("missing_share");
    expect(r[0]!.suppressed).toBe(true);
  });

  it("회차가 없는 주는 **비교 없음**이다", () => {
    const empty = LEDGER({ plannedUnits: 0, publishedCycles: 0, dataCycles: 0 });
    const r = computeCompare(
      WEEK("2026-09-07", "2026-09-07", "2026-09-13", empty),
      WEEK("2026-09-14", "2026-09-14", "2026-09-18", LEDGER()),
      OPTS,
    );
    expect(r[0]!.reason).toBe("no_prev");
    expect(r[0]!.delta).toBeNull();
    expect(periodCaption(r[0]!, { days: 5, kind: "calendarWeek" })).toEqual({
      key: "reason.noPrevWeek",
      params: {},
    });
  });

  it("직전 주가 측정 시작 구간이면 억제한다(유예는 창 길이가 아니라 7일 기준)", () => {
    // grace(7) = 2 → 09-07 + 2 = 09-09. 첫 발행이 그 뒤면 시작 구간이다.
    const late = LEDGER({ firstPublishedAnchor: "2026-09-10" });
    const r = computeCompare(
      WEEK("2026-09-07", "2026-09-07", "2026-09-13", late),
      WEEK("2026-09-14", "2026-09-14", "2026-09-18", LEDGER()),
      OPTS,
    );
    expect(r[0]!.reason).toBe("start_window");

    const onTime = LEDGER({ firstPublishedAnchor: "2026-09-09" }); // 경계일은 아니다
    expect(
      computeCompare(
        WEEK("2026-09-07", "2026-09-07", "2026-09-13", onTime),
        WEEK("2026-09-14", "2026-09-14", "2026-09-18", LEDGER()),
        OPTS,
      )[0]!.reason,
    ).toBeNull();
  });

  it("달력 주에는 `start_month` 가 발화하지 않는다", () => {
    const r = computeCompare(
      WEEK("2026-09-07", "2026-09-07", "2026-09-13", LEDGER({ firstPublishedAnchor: "2026-09-10" })),
      WEEK("2026-09-14", "2026-09-14", "2026-09-18", LEDGER()),
      OPTS,
    );
    expect(r[0]!.reason).not.toBe("start_month");
  });

  it("라벨은 `지난 7일 대비`(트레일링)가 아니라 `지난주 대비`다", () => {
    const [r] = computeCompare(
      WEEK("2026-09-07", "2026-09-07", "2026-09-13", LEDGER()),
      WEEK("2026-09-14", "2026-09-14", "2026-09-20", LEDGER()),
      OPTS,
    );
    expect(toPeriodDeltaView([r!], { days: 7, kind: "calendarWeek" }).presetKey).toBe("thisWeek");
    // 종류를 안 주면 종전대로 창 프리셋이다(회귀 방지).
    expect(toPeriodDeltaView([r!], { days: 7 }).presetKey).toBe("weekly");
  });
});
