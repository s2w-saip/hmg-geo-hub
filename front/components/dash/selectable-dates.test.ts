import { describe, expect, it } from "vitest";
import {
  addDays,
  addYears,
  countRounds,
  dayDiff,
  daysInMonth,
  kstToday,
  nearestSelectable,
  normalizeSelectableDates,
  presetWindowKst,
  snapPresetWindow,
  snapRange,
  weekdayIndex,
} from "./selectable-dates";

// 기대값은 전부 **손계산 리터럴**이다(구현과 같은 함수로 기대값을 만들지 않는다).
//
// 달력 사실 확인(2026): 09-14 = 월요일 · 09-18 = 금요일 · 09-19 = 토요일.
//   ← 2024-01-01(월)에서 731일 뒤가 2026-01-01(목), 거기서 261일 뒤가 09-19(토).
// 스펙 §9.2 의 정규 요일(글로벌 = 월 · 웹사이트 = 금)과 맞는 날짜를 픽스처로 쓴다.

/** 글로벌 표면 = KST 월요일들. */
const GLOBAL = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"];
/** 웹사이트 표면 = KST 금요일들. */
const WEBSITE = ["2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18"];

describe("kstToday — 시계는 하나(KST)", () => {
  it("UTC 15:00 = KST 다음 날 자정", () => {
    expect(kstToday(new Date("2026-09-18T15:00:00Z"))).toBe("2026-09-19");
  });

  it("그 1초 전은 아직 전날", () => {
    expect(kstToday(new Date("2026-09-18T14:59:59Z"))).toBe("2026-09-18");
  });

  it("KST 정오도 같은 날", () => {
    expect(kstToday(new Date("2026-09-19T03:00:00Z"))).toBe("2026-09-19");
  });

  it("UTC 자정 직후(KST 오전 9시)도 같은 날", () => {
    expect(kstToday(new Date("2026-09-19T00:00:01Z"))).toBe("2026-09-19");
  });
});

describe("날짜 문자열 산술", () => {
  it("달을 넘긴다", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("해를 넘긴다", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("윤년을 센다", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 9)).toBe(30);
  });

  it("1년 전은 같은 월·일, 2/29 는 말일로 클램프", () => {
    expect(addYears("2026-09-18", -1)).toBe("2025-09-18");
    expect(addYears("2024-02-29", -1)).toBe("2023-02-28");
  });

  it("요일 인덱스 (0=일)", () => {
    expect(weekdayIndex("2026-09-14")).toBe(1); // 월
    expect(weekdayIndex("2026-09-18")).toBe(5); // 금
    expect(weekdayIndex("2026-09-19")).toBe(6); // 토
  });

  it("dayDiff 는 일수 차", () => {
    expect(dayDiff("2026-09-14", "2026-09-18")).toBe(4);
    expect(dayDiff("2026-08-31", "2026-09-01")).toBe(1);
  });
});

describe("normalizeSelectableDates", () => {
  it("정렬·중복 제거·형식 검사", () => {
    expect(
      normalizeSelectableDates(["2026-09-14", "2026-08-31", "2026-09-14", "nope", ""]),
    ).toEqual(["2026-08-31", "2026-09-14"]);
  });

  it("빈 목록은 빈 목록", () => {
    expect(normalizeSelectableDates([])).toEqual([]);
  });
});

describe("nearestSelectable", () => {
  it("가까운 쪽으로 붙는다", () => {
    expect(nearestSelectable("2026-09-16", GLOBAL)).toBe("2026-09-14");
    expect(nearestSelectable("2026-09-01", GLOBAL)).toBe("2026-08-31");
  });

  it("목록 밖(양끝 너머)은 끝값", () => {
    expect(nearestSelectable("2026-12-25", GLOBAL)).toBe("2026-09-14");
    expect(nearestSelectable("2026-01-01", GLOBAL)).toBe("2026-08-24");
  });

  it("동점은 tie 인자가 정한다", () => {
    const two = ["2026-09-07", "2026-09-13"];
    expect(nearestSelectable("2026-09-10", two, "earlier")).toBe("2026-09-07");
    expect(nearestSelectable("2026-09-10", two, "later")).toBe("2026-09-13");
  });

  it("목록이 비면 null", () => {
    expect(nearestSelectable("2026-09-10", [])).toBeNull();
  });
});

describe("snapRange — URL 로 들어온 선택 불가 날짜 (요구 2)", () => {
  it("양끝을 가장 가까운 회차로 맞추고 그 사실을 남긴다", () => {
    const r = snapRange({ from: "2026-09-01", to: "2026-09-16" }, GLOBAL);
    expect(r.from).toBe("2026-08-31");
    expect(r.to).toBe("2026-09-14");
    expect(r.snappedFrom).toBe(true);
    expect(r.snappedTo).toBe(true);
    expect(r.requested).toEqual({ from: "2026-09-01", to: "2026-09-16" });
  });

  it("이미 회차 날짜면 건드리지 않는다", () => {
    const r = snapRange({ from: "2026-08-31", to: "2026-09-14" }, GLOBAL);
    expect(r.from).toBe("2026-08-31");
    expect(r.to).toBe("2026-09-14");
    expect(r.snappedFrom).toBe(false);
    expect(r.snappedTo).toBe(false);
  });

  it("한쪽만 어긋나면 그쪽만 표시된다", () => {
    const r = snapRange({ from: "2026-08-31", to: "2026-09-17" }, GLOBAL);
    expect(r.to).toBe("2026-09-14");
    expect(r.snappedFrom).toBe(false);
    expect(r.snappedTo).toBe(true);
  });

  it("open-ended 는 있는 쪽만 스냅한다", () => {
    // 09-05 → 앞 08-31(5일) vs 뒤 09-07(2일) → 09-07.
    const r = snapRange({ from: "2026-09-05" }, GLOBAL);
    expect(r.from).toBe("2026-09-07");
    expect(r.to).toBeUndefined();
    expect(r.snappedTo).toBe(false);
  });

  it("종료일을 먼저 잡아 시작일이 종료일을 넘지 못하게 한다(동점 교차 방지)", () => {
    // 양끝을 따로 스냅하면 from=09-13 · to=09-07 로 뒤집힌다.
    const two = ["2026-09-07", "2026-09-13"];
    const r = snapRange({ from: "2026-09-10", to: "2026-09-10" }, two);
    expect(r.from).toBe("2026-09-07");
    expect(r.to).toBe("2026-09-07");
    expect(r.from! <= r.to!).toBe(true);
  });

  it("목록이 비면 아무것도 바꾸지 않는다(= 모른다)", () => {
    const r = snapRange({ from: "2026-09-01", to: "2026-09-16" }, []);
    expect(r).toEqual({
      from: "2026-09-01",
      to: "2026-09-16",
      snappedFrom: false,
      snappedTo: false,
      requested: { from: "2026-09-01", to: "2026-09-16" },
    });
  });

  it("웹사이트(금요일) 목록에도 같은 규칙", () => {
    const r = snapRange({ from: "2026-09-01", to: "2026-09-19" }, WEBSITE);
    expect(r.from).toBe("2026-09-04");
    expect(r.to).toBe("2026-09-18");
  });
});

describe("countRounds — 창 안의 회차 수", () => {
  it("양 끝 포함", () => {
    expect(countRounds(GLOBAL, "2026-08-31", "2026-09-14")).toBe(3);
    expect(countRounds(GLOBAL, "2026-09-14", "2026-09-14")).toBe(1);
  });

  it("한쪽이 비면 그쪽은 무제한", () => {
    expect(countRounds(GLOBAL, "2026-09-01", undefined)).toBe(2);
    expect(countRounds(GLOBAL, undefined, "2026-08-31")).toBe(2);
    expect(countRounds(GLOBAL)).toBe(4);
  });

  it("회차가 없는 창은 0", () => {
    expect(countRounds(GLOBAL, "2026-09-15", "2026-09-20")).toBe(0);
  });
});

describe("snapPresetWindow — 프리셋 스냅 (요구 3)", () => {
  it("끝점 = 창 안 가장 늦은 회차, 시작점 = 창 안 가장 이른 회차", () => {
    expect(snapPresetWindow({ from: "2026-08-20", to: "2026-09-18" }, GLOBAL)).toEqual({
      from: "2026-08-24",
      to: "2026-09-14",
    });
  });

  it("창 안에 회차가 하나면 시작·끝이 같다", () => {
    expect(snapPresetWindow({ from: "2026-09-12", to: "2026-09-18" }, GLOBAL)).toEqual({
      from: "2026-09-14",
      to: "2026-09-14",
    });
  });

  it("창 안에 회차가 없으면 null (프리셋 비활성)", () => {
    expect(snapPresetWindow({ from: "2026-09-15", to: "2026-09-20" }, GLOBAL)).toBeNull();
    expect(snapPresetWindow({ from: "2026-08-20", to: "2026-09-18" }, [])).toBeNull();
  });
});

describe("presetWindowKst — 프리셋 원본 창 (KST 문자열 산술)", () => {
  it("트레일링 창은 끝점 포함", () => {
    expect(presetWindowKst("weekly", "2026-09-18", null, "2026-09-19")).toEqual({
      from: "2026-09-12",
      to: "2026-09-18",
    });
    expect(presetWindowKst("biweekly", "2026-09-18", null, "2026-09-19")).toEqual({
      from: "2026-09-05",
      to: "2026-09-18",
    });
    expect(presetWindowKst("monthly", "2026-09-18", null, "2026-09-19")).toEqual({
      from: "2026-08-20",
      to: "2026-09-18",
    });
    expect(presetWindowKst("yearly", "2026-09-18", null, "2026-09-19")).toEqual({
      from: "2025-09-18",
      to: "2026-09-18",
    });
  });

  it("끝점 E 가 없으면 **KST 의 오늘**이 끝점이다", () => {
    expect(presetWindowKst("weekly", null, null, "2026-09-19")).toEqual({
      from: "2026-09-13",
      to: "2026-09-19",
    });
  });

  it("KST 자정 경계: UTC 18일 15:00 의 '오늘'은 19일", () => {
    const today = kstToday(new Date("2026-09-18T15:00:00Z"));
    expect(presetWindowKst("weekly", null, null, today)).toEqual({
      from: "2026-09-13",
      to: "2026-09-19",
    });
  });

  it("수집 시작일로 클램프한다", () => {
    expect(presetWindowKst("weekly", "2026-09-18", "2026-09-15", "2026-09-19").from).toBe(
      "2026-09-15",
    );
    // 수집 시작일이 끝점 이후면 클램프하지 않는다(퇴화 범위 방지 — 종전 규칙).
    expect(presetWindowKst("weekly", "2026-09-18", "2026-09-30", "2026-09-19").from).toBe(
      "2026-09-12",
    );
  });
});
