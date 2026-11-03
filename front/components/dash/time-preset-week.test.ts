import { describe, expect, it } from "vitest";
import {
  TIME_PRESET_ORDER,
  presetRange,
  resolveTimeRangeView,
  type TimePreset,
} from "@/components/dash/dimension-filter-panel";
import { weekBounds, weekMondayOfDay } from "@/components/dash/selectable-dates";
import { resolveComparePeriodShape, weekMondayOf } from "@/lib/kpi/period-compare-week";

// ════════════════════════════════════════════════════════════════════════════
// 기간 프리셋의 커밋값 + KST 주 경계 헬퍼
// ════════════════════════════════════════════════════════════════════════════
//
// 2026-09-20(제품 결정): 달력 프리셋 넷(이번 달·지난달·이번 주·지난주)을 선택지에서 내렸다.
// 남은 프리셋은 트레일링 창 4종뿐이고, **축 on/off 가 같은 목록**이다.
// 주 경계 헬퍼(`weekMondayOfDay`·`weekBounds`)는 계속 산다: 회차가 없는 창에서 내는
// 이동 제안(`suggestWeekWindow`)이 주 창을 만들기 때문이다.
//
// 기대값은 전부 **손계산 리터럴**이다(계약 §5: 구현과 같은 함수로 기대값을 만들지 않는다).
// 기준 달력:
//   2026-09-14(월) 15 16 17 18 19 2026-09-20(일)
//   그 앞 주 = 2026-09-07(월) ~ 2026-09-13(일)
//   그 앞 = 2026-08-31(월) ~ 2026-09-06(일)
// 2026-09-17 은 목요일, 2026-09-20 은 일요일이다.

const SEP17 = "2026-09-17"; // 목

describe("프리셋 목록: 트레일링 창 4종, 축 on/off 동일", () => {
  it("TIME_PRESET_ORDER 에 달력 프리셋이 없다", () => {
    expect([...TIME_PRESET_ORDER]).toEqual(["weekly", "biweekly", "monthly", "yearly"]);
  });

  it("selectableDates 가 undefined 면 종전 경로이고 목록은 4종이다", () => {
    const view = resolveTimeRangeView({
      value: null,
      minDay: null,
      endDay: null,
      selectableDates: undefined,
      todayKst: SEP17,
      now: new Date("2026-09-17T03:00:00Z"),
    });
    expect(view.anchored).toBe(false);
    expect(view.rounds).toBeNull();
    expect(view.didSnap).toBe(false);
    expect(view.presets.map((p) => p.preset)).toEqual([...TIME_PRESET_ORDER]);
  });

  it("빈 배열도 같은 경로다 — 리더의 '모른다'를 '선택지 없음'으로 읽지 않는다", () => {
    const view = resolveTimeRangeView({
      value: null,
      selectableDates: [],
      todayKst: SEP17,
      now: new Date("2026-09-17T03:00:00Z"),
    });
    expect(view.anchored).toBe(false);
    expect(view.presets.map((p) => p.preset)).toEqual([...TIME_PRESET_ORDER]);
  });

  it("selectableDates 가 있어도 같은 4종이다 (축 on 이 항목을 더하지 않는다)", () => {
    const view = resolveTimeRangeView({
      value: null,
      selectableDates: ["2026-09-07", "2026-09-14"],
      todayKst: SEP17,
      now: new Date("2026-09-17T03:00:00Z"),
    });
    expect(view.anchored).toBe(true);
    expect(view.presets.map((p) => p.preset)).toEqual([...TIME_PRESET_ORDER]);
  });
});

describe("주 경계 — KST 월요일 (손계산)", () => {
  it.each([
    ["2026-09-14", "2026-09-14"], // 월 → 자기
    ["2026-09-17", "2026-09-14"], // 목
    ["2026-09-20", "2026-09-14"], // 일 → 그 주 월요일(ISO)
    ["2026-09-21", "2026-09-21"], // 다음 월
    ["2026-09-01", "2026-08-31"], // 달을 넘는다
  ])("%s → %s", (day, monday) => {
    expect(weekMondayOfDay(day)).toBe(monday);
    // 비교 모듈의 같은 규칙과 한 벌이어야 한다(클라이언트 번들 때문에 두 벌로 산다).
    expect(weekMondayOf(day)).toBe(monday);
  });

  it("weekBounds 는 월~일 7일이다", () => {
    expect(weekBounds("2026-09-14")).toEqual({ lo: "2026-09-14", hi: "2026-09-20" });
    expect(weekBounds("2026-08-31")).toEqual({ lo: "2026-08-31", hi: "2026-09-06" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B1·B2 회귀 — **실제로 커밋되는 URL 값**을 판정기에 먹인다
// ════════════════════════════════════════════════════════════════════════════
//
// 종전 테스트는 스냅 **전** 원본 창(`presetWindowKst`)만 판정기에 먹였다. 화면이 URL 에
// 싣는 것은 스냅 **후** 값이라, 웹사이트(금요일 귀속)에서 주 프리셋이 `금요일 하루` 로
// 커밋되며 WoW 가 통째로 죽는 것을 못 잡았다. 여기서는 뷰 모델이 내는 `encoded`
// (= 커밋값)를 그대로 판정기에 넣는다.

/** 그 표면의 회차 격자. 글로벌 = 월요일, 웹사이트 = 금요일(§9.2). */
const GLOBAL_ROUNDS = ["2026-08-31", "2026-09-07", "2026-09-14"];
const WEBSITE_ROUNDS = ["2026-08-07", "2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18"];

function committed(
  preset: TimePreset,
  dates: readonly string[],
  endDay: string | null,
): { from: string; to: string } | null {
  const v = resolveTimeRangeView({
    value: null,
    endDay,
    selectableDates: dates,
    todayKst: SEP17,
    now: new Date("2026-09-17T03:00:00Z"),
  });
  const enc = v.presets.find((p) => p.preset === preset)?.encoded ?? null;
  if (!enc) return null;
  const [from, to] = enc.split("..");
  return { from, to };
}

describe("N3: 프리셋은 스냅하지 않는다", () => {
  // 스냅을 지운 이유: 달력 경계 리터럴 보존, 웹사이트 "주간" 붕괴, 글로벌 "주간" 의
  // URL 중복 + 누락 임계 뒤집힘. 기간 술어가 `round_date BETWEEN` 이라 원본 창으로도
  // 같은 회차 집합을 고른다.
  it.each([
    // 손계산. 끝점 E = 2026-09-14 → 그 날까지 최근 N일.
    ["weekly", "2026-09-08..2026-09-14"],
    ["biweekly", "2026-09-01..2026-09-14"],
    ["monthly", "2026-08-16..2026-09-14"],
  ] as const)("%s 는 원본 트레일링 창 그대로다", (preset, expected) => {
    const w = committed(preset, GLOBAL_ROUNDS, "2026-09-14");
    expect(`${w!.from}..${w!.to}`).toBe(expected);
  });

  // ⚠️ 이것이 N3 의 요점이다: 스냅이 없으니 **축 on 과 축 off 의 커밋값이 같다.**
  //    커밋값이 같으면 모양 판정도 같으므로, 축을 켜서 새로 생기는 라벨·억제 차이가
  //    구조적으로 없다(종전에는 스냅 때문에 weekly 가 calendarWeek 으로 읽혔다).
  it.each(["weekly", "biweekly", "monthly", "yearly"] as const)(
    "%s 의 커밋값이 축 off 와 같다",
    (preset) => {
      const now = new Date("2026-09-17T03:00:00Z");
      const off = presetRange(preset, "2026-09-14", null, now);
      const on = committed(preset, GLOBAL_ROUNDS, "2026-09-14");
      expect(on).toEqual({ from: off.from, to: off.to });
      expect(resolveComparePeriodShape(on!.from, on!.to).kind).toBe(
        resolveComparePeriodShape(off.from, off.to).kind,
      );
    },
  );

  // N3-a: 종전에는 글로벌에서 weekly 가 월요일 하루로 스냅돼 달력 주 프리셋과 **같은
  //       URL** 이 됐고(체크 두 개), 그 URL 이 calendarWeek 으로 읽혀 누락 30% 임계가
  //       새로 걸렸다. 달력 주 프리셋은 내렸지만 스냅 금지는 그대로 지켜져야 한다.
  it("글로벌에서 weekly 가 월요일 하루로 붕괴하지 않는다", () => {
    const weekly = committed("weekly", GLOBAL_ROUNDS, "2026-09-14");
    expect(weekly).toEqual({ from: "2026-09-08", to: "2026-09-14" });
    expect(resolveComparePeriodShape(weekly!.from, weekly!.to).kind).toBe("window");
  });

  // N3-b: 웹사이트(금요일 귀속)에서 weekly 가 금요일 하루로 붕괴하면 직전 창이 1일이 되고
  //       그날에는 회차가 없어 Δ 가 통째로 억제됐다. 축 off 에서는 7일 창이 정상이었다.
  it("웹사이트에서 weekly 가 하루로 붕괴하지 않는다", () => {
    const w = committed("weekly", WEBSITE_ROUNDS, "2026-09-18");
    expect(w).toEqual({ from: "2026-09-12", to: "2026-09-18" });
    expect(resolveComparePeriodShape(w!.from, w!.to).kind).toBe("window");
  });

  it("창 안에 회차가 없으면 여전히 비활성이다 (고르면 빈 화면)", () => {
    const v = committed("weekly", GLOBAL_ROUNDS, "2026-12-31");
    expect(v).toBeNull();
  });
});

describe("달력 주 비교(WoW)는 직접 선택·옛 공유 URL 로 계속 도달한다", () => {
  // 프리셋은 내렸지만 판정은 **날짜쌍의 모양**이 한다. 고객이 달력에서 월~일을 고르거나
  // 종전 "이번 주"·"지난주" 프리셋으로 공유된 URL 을 열면 그대로 WoW 다.
  it("2026-09-14..2026-09-16 (부분 주) 은 calendarWeek 이고 직전 주 전체와 비교한다", () => {
    const shape = resolveComparePeriodShape("2026-09-14", "2026-09-16");
    expect(shape.kind).toBe("calendarWeek");
    expect(shape.weeks!.cur).toEqual({ lo: "2026-09-14", hi: "2026-09-16" });
    expect(shape.weeks!.prev).toEqual({ lo: "2026-09-07", hi: "2026-09-13" });
  });

  it("2026-09-07..2026-09-13 (완결 주) 도 마찬가지다", () => {
    const shape = resolveComparePeriodShape("2026-09-07", "2026-09-13");
    expect(shape.kind).toBe("calendarWeek");
    expect(shape.weeks!.cur).toEqual({ lo: "2026-09-07", hi: "2026-09-13" });
    expect(shape.weeks!.prev).toEqual({ lo: "2026-08-31", hi: "2026-09-06" });
  });

  it("달력 월 URL 도 그대로 MoM 이다", () => {
    const shape = resolveComparePeriodShape("2026-08-01", "2026-08-31");
    expect(shape.kind).toBe("calendarMonth");
    expect(shape.months!.prev).toEqual({ lo: "2026-07-01", hi: "2026-07-31" });
    expect(shape.days).toBe(31);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 서비스 기준 주(2026-11-02) — 프리셋은 기준 주 끝(maxDay)을 넘지 않는다
// ════════════════════════════════════════════════════════════════════════════
//
// 모든 화면이 기준 주까지만 보이므로 프리셋의 끝점도 그 주를 넘지 않는다. 끝점 E 가 없으면
// (ACR · Website Prompts: 화면이 latestAnchorDay 를 주지 않는다) 마지막 선택 가능 회차, 그것도
// 없으면 기준 주 끝이 끝점이다 — 브라우저의 오늘이 아니다. 기대값은 손계산 리터럴이다.
// 기준 주 = 2026-10-05(월) ~ 2026-10-11(일). 오늘 = 2026-11-02(월).

describe("서비스 기준 주 상한 (maxDay)", () => {
  const TODAY = "2026-11-02";
  const NOW = new Date("2026-11-02T03:00:00Z");
  const enc = (v: ReturnType<typeof resolveTimeRangeView>, preset: TimePreset) => v.presets.find((p) => p.preset === preset)?.encoded ?? null;

  it("끝점 E 가 없으면 마지막 회차가 끝점이다 (브라우저의 오늘 아님) — ACR 의 2026-11-02 결함", () => {
    const v = resolveTimeRangeView({ value: null, selectableDates: ["2026-09-28", "2026-10-05"], todayKst: TODAY, now: NOW });
    expect(enc(v, "weekly")).toBe("2026-09-29..2026-10-05");
    expect(enc(v, "monthly")).toBe("2026-09-06..2026-10-05");
    expect(enc(v, "yearly")).toBe("2025-10-05..2026-10-05");
  });

  it("E 가 기준 주 뒤면(옛 화면 응답) 기준 주 끝에서 멈춘다", () => {
    const v = resolveTimeRangeView({
      value: null,
      endDay: "2026-10-19",
      selectableDates: ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"],
      maxDay: "2026-10-11",
      todayKst: TODAY,
      now: NOW,
    });
    expect(enc(v, "weekly")).toBe("2026-10-05..2026-10-11");
    expect(enc(v, "monthly")).toBe("2026-09-12..2026-10-11");
  });

  it("E 가 기준 주 안이면 그대로다", () => {
    const v = resolveTimeRangeView({ value: null, endDay: "2026-10-09", selectableDates: ["2026-10-02", "2026-10-09"], maxDay: "2026-10-11", todayKst: TODAY, now: NOW });
    expect(enc(v, "weekly")).toBe("2026-10-03..2026-10-09");
  });

  it("회차 목록이 없는 종전 경로도 기준 주 끝이 끝점이다", () => {
    const v = resolveTimeRangeView({ value: null, endDay: null, selectableDates: [], maxDay: "2026-10-11", todayKst: TODAY, now: NOW });
    expect(enc(v, "weekly")).toBe("2026-10-05..2026-10-11");
    expect(enc(v, "biweekly")).toBe("2026-09-28..2026-10-11");
    expect(enc(v, "monthly")).toBe("2026-09-12..2026-10-11");
    expect(enc(v, "yearly")).toBe("2025-10-11..2026-10-11");
    const late = resolveTimeRangeView({ value: null, endDay: "2026-10-30", maxDay: "2026-10-11", todayKst: TODAY, now: NOW });
    expect(enc(late, "weekly")).toBe("2026-10-05..2026-10-11");
  });

  it("어느 경로든 모든 프리셋의 끝이 기준 주 끝 이하다", () => {
    for (const selectableDates of [[], ["2026-10-05", "2026-10-12"]]) {
      const v = resolveTimeRangeView({ value: null, endDay: "2026-10-30", selectableDates, maxDay: "2026-10-11", todayKst: TODAY, now: NOW });
      for (const p of v.presets) if (p.encoded) expect(p.encoded.split("..")[1] <= "2026-10-11").toBe(true);
    }
  });

  it("기준 주를 모르면(공급자 없음 · Project) 종전 경로는 종전대로 오늘이 끝점이다", () => {
    const v = resolveTimeRangeView({ value: null, endDay: null, selectableDates: [], todayKst: TODAY, now: NOW });
    expect(enc(v, "weekly")!.split("..")[1]).toBe(presetRange("weekly", NOW).to);
  });
});

// 서비스 기준 주 — 보이는 범위 `shown`(리뷰 r1-15). BFF(Context.create)는 기준 주 뒤의 `to` 를 기준 주 끝까지만 읽으므로
// 칩 · 직접 선택 · 달력이 보이는 끝도 그 날에서 멈춘다. URL · 커밋값 `range` 는 고른 그대로다(기준 주가 넘어가면 같은
// URL 이 더 보인다). 시작이 기준 주 뒤면 읽을 회차가 없어 고른 그대로 둔다(화면은 '측정 없음' · 회차 0개 안내).
describe("서비스 기준 주 — 보이는 범위 (shown)", () => {
  const TODAY = "2026-11-02";
  const NOW = new Date("2026-11-02T03:00:00Z");
  const view = (value: string, maxDay: string | null, selectableDates: string[] = ["2026-09-28", "2026-10-05"]) =>
    resolveTimeRangeView({ value, selectableDates, maxDay, todayKst: TODAY, now: NOW });

  it("기준 주 뒤의 끝은 기준 주 끝에서 멈추고, 커밋값은 고른 그대로다", () => {
    const v = view("2026-09-28..2026-10-25", "2026-10-11");
    expect(v.shown).toEqual({ from: "2026-09-28", to: "2026-10-11" });
    expect(v.range).toEqual({ from: "2026-09-28", to: "2026-10-25" });
    expect(view("..2026-10-25", "2026-10-11").shown).toEqual({ to: "2026-10-11" });
  });

  it("회차 목록이 없는 종전 경로도 같다", () => {
    expect(view("2026-09-28..2026-10-25", "2026-10-11", []).shown).toEqual({ from: "2026-09-28", to: "2026-10-11" });
  });

  it("기준 주 안의 끝 · 열린 끝 · 기준 주 뒤에서 시작하는 기간은 고른 그대로다", () => {
    expect(view("2026-09-28..2026-10-11", "2026-10-11").shown).toEqual({ from: "2026-09-28", to: "2026-10-11" });
    expect(view("2026-09-28..", "2026-10-11").shown).toEqual({ from: "2026-09-28" });
    expect(view("2026-10-12..2026-11-01", "2026-10-11").shown).toEqual({ from: "2026-10-12", to: "2026-11-01" });
  });

  it("기준 주를 모르면 종전대로 고른 그대로다", () => {
    expect(view("2026-09-28..2026-10-25", null).shown).toEqual({ from: "2026-09-28", to: "2026-10-25" });
  });
});
