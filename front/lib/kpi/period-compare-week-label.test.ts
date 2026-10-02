import { describe, expect, it } from "vitest";
import {
  monthLabelKeyOf,
  toPeriodDeltaView,
  weekLabelKeyOf,
} from "@/lib/kpi/period-compare-view";
import type { CompareResult } from "@/lib/kpi/period-compare";

// ════════════════════════════════════════════════════════════════════════════
// 달력 주의 라벨·억제 문구 (검증 W3·W4)
// ════════════════════════════════════════════════════════════════════════════
//
// W4: 종전에는 `calendarWeek` 이면 무조건 "지난주 대비"(`label.thisWeek`)였다. "지난주"
//     프리셋의 비교 대상은 **전전주**라 그 문장은 틀렸고, 사전에 있던 `label.lastWeek`
//     ("전전주 대비")는 호출부가 없어 도달 불가능한 키였다.
// W3: 타일 경로가 `kind` 를 안 받아 "비교할 직전 **1일** 구간의 측정 회차가 없습니다" 를
//     냈다. 실제 비교 구간은 직전 주 7일이고, 신설 키 `noPrevWeek` 은 영영 안 나왔다.
//
// 기준 달력: 2026-09-14(월)~09-20(일) 이 "이번 주", 09-07~09-13 이 "지난주".

const TODAY = "2026-09-17"; // 목요일

describe("W4 — 어느 주인지까지 가른다", () => {
  it.each([
    ["이번 주(월요일)", "2026-09-14", "thisWeek"],
    ["이번 주 안의 다른 날", "2026-09-16", "thisWeek"],
    ["지난주", "2026-09-07", "lastWeek"],
    ["지난주 안의 다른 날", "2026-09-13", "lastWeek"],
  ] as const)("%s → %s", (_label, curLo, expected) => {
    expect(weekLabelKeyOf(curLo, TODAY)).toBe(expected);
  });

  it("더 예전 주는 라벨을 지어내지 않는다(일반 캡션으로 떨어진다)", () => {
    expect(weekLabelKeyOf("2026-08-31", TODAY)).toBeNull();
    expect(weekLabelKeyOf("2026-06-01", TODAY)).toBeNull();
  });

  it("입력이 없으면 종전 동작(thisWeek)", () => {
    expect(weekLabelKeyOf(undefined, TODAY)).toBe("thisWeek");
    expect(weekLabelKeyOf("2026-09-07", undefined)).toBe("thisWeek");
    expect(weekLabelKeyOf("망가진값", TODAY)).toBe("thisWeek");
  });

  it("해를 넘어도 맞다 — 2027-01-04(월)가 이번 주면 그 앞은 지난주", () => {
    expect(weekLabelKeyOf("2027-01-04", "2027-01-06")).toBe("thisWeek");
    expect(weekLabelKeyOf("2026-12-28", "2027-01-06")).toBe("lastWeek");
  });
});

const RESULT = (over: Partial<CompareResult> = {}): CompareResult =>
  ({
    metric: "visibility",
    delta: null,
    suppressed: true,
    reason: "no_prev",
    cyclesPrev: 0,
    cyclesCur: 1,
    ...over,
  }) as CompareResult;

describe("W3 — 종류를 알면 억제 문구가 주 단위로 나온다", () => {
  it("kind 를 넘기면 noPrevWeek 이다", () => {
    const v = toPeriodDeltaView([RESULT()], {
      days: 7,
      kind: "calendarWeek",
      curLo: "2026-09-14",
      todayKst: TODAY,
    });
    expect(v.caption.key).toBe("reason.noPrevWeek");
    expect(v.presetKey).toBe("thisWeek");
  });

  it("kind 를 빼면 종전처럼 '직전 N일' 문구로 떨어진다 (타일이 겪던 형태)", () => {
    const v = toPeriodDeltaView([RESULT()], { days: 1 });
    expect(v.caption.key).toBe("reason.noPrevWindow");
    expect(v.caption.params).toEqual({ days: 1 });
    expect(v.presetKey).toBeNull();
  });

  it("지난주 프리셋의 라벨은 전전주 대비다", () => {
    const v = toPeriodDeltaView([RESULT({ suppressed: false, reason: null })], {
      days: 7,
      kind: "calendarWeek",
      curLo: "2026-09-07",
      todayKst: TODAY,
    });
    expect(v.presetKey).toBe("lastWeek");
  });

  it("달력 월 캡션은 noPrevMonth 다", () => {
    const v = toPeriodDeltaView([RESULT()], {
      days: 31,
      kind: "calendarMonth",
      curLo: "2026-08-01",
      todayKst: TODAY,
    });
    expect(v.caption.key).toBe("reason.noPrevMonth");
  });
});

describe("사전 키가 ko·en 양쪽에 있다", () => {
  it.each(["thisWeek", "lastWeek"] as const)("label.%s", async (k) => {
    const ko = (await import("@/messages/ko.json")).default as Record<string, never>;
    const en = (await import("@/messages/en.json")).default as Record<string, never>;
    const pick = (m: Record<string, never>) =>
      (m as unknown as { periodCompare: { label: Record<string, string> } }).periodCompare
        .label[k];
    expect(pick(ko)).toBeTruthy();
    expect(pick(en)).toBeTruthy();
  });

  it("ko 문구가 서로 다른 비교를 가리킨다", async () => {
    const ko = (await import("@/messages/ko.json")).default as unknown as {
      periodCompare: { label: Record<string, string> };
    };
    expect(ko.periodCompare.label.thisWeek).toBe("지난주 대비");
    expect(ko.periodCompare.label.lastWeek).toBe("전전주 대비");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// N9 — 달력 **월** 라벨도 길이가 아니라 종류·구간에서 파생한다
// ════════════════════════════════════════════════════════════════════════════
//
// 종전에는 길이에서 파생해 "이번 달"(9/1~9/14, 14일)이 `biweekly`("지난 14일 대비")로,
// "지난달"(31일)이 `null`(라벨 없음)로 떨어졌다. 둘 다 실제 비교 대상(직전 달 전체)을
// 가리키지 않는다.
describe("N9 — 달력 월 라벨", () => {
  it.each([
    ["이번 달(월초부터 오늘까지)", "2026-09-01", "thisMonth"],
    ["지난달", "2026-08-01", "lastMonth"],
  ] as const)("%s → %s", (_l, curLo, expected) => {
    expect(monthLabelKeyOf(curLo, TODAY)).toBe(expected);
  });

  it("더 예전 달은 라벨을 지어내지 않는다", () => {
    expect(monthLabelKeyOf("2026-06-01", TODAY)).toBeNull();
  });

  it("해를 넘어도 맞다 — 1월의 직전 달은 작년 12월", () => {
    expect(monthLabelKeyOf("2027-01-01", "2027-01-20")).toBe("thisMonth");
    expect(monthLabelKeyOf("2026-12-01", "2027-01-20")).toBe("lastMonth");
  });

  it("입력이 없으면 라벨을 만들지 않는다(종전 길이 파생으로 떨어진다)", () => {
    expect(monthLabelKeyOf(undefined, TODAY)).toBeNull();
    expect(monthLabelKeyOf("2026-09-01", undefined)).toBeNull();
  });

  it("뷰까지 이어진다 — 14일짜리 '이번 달'이 '지난 14일 대비'로 새지 않는다", () => {
    const v = toPeriodDeltaView([RESULT({ suppressed: false, reason: null })], {
      days: 14,
      kind: "calendarMonth",
      curLo: "2026-09-01",
      todayKst: TODAY,
    });
    expect(v.presetKey).toBe("thisMonth");
  });

  it("'지난달'은 전전달 문구다", () => {
    const v = toPeriodDeltaView([RESULT({ suppressed: false, reason: null })], {
      days: 31,
      kind: "calendarMonth",
      curLo: "2026-08-01",
      todayKst: TODAY,
    });
    expect(v.presetKey).toBe("lastMonth");
  });
});
