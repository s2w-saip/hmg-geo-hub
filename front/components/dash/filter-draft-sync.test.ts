import { describe, expect, it } from "vitest";
import { isYearScaleWindow, periodCaption } from "@/lib/kpi/period-compare-view";
import { selectedWindowDays } from "@/lib/kpi/calendar-month-window";
import {
  ALL_GROUPS,
  mergeAppliedDraft,
  presetRange,
  pruneToOptions,
  type DimensionGroup,
} from "./dimension-filter-panel";

// GGMD "KPI 고도화 QA"(2026-09-08) #4(국가 해제 후 재노출) · #12(칩 선택 후 적용 불가) ·
// #19(연간 프리셋) · #20(수집 시작일 이전 선택) 회귀 고정.
//
// 패널 자체는 상호작용 테스트 셋업이 없다(렌더 테스트가 renderToStaticMarkup) —
// rhq-region-toggle.ts 선례대로 상태 전이를 순수 함수로 뽑아 고정한다.

const G = ALL_GROUPS as readonly DimensionGroup[];

describe("mergeAppliedDraft — 외부 URL 변경이 미적용 draft 를 삼키지 않는다 (QA #4·#12)", () => {
  it("URL 이 안 바뀐 축의 draft 는 그대로 둔다 — 해제한 국가가 되살아나지 않는다", () => {
    // 시나리오(#4): 권역 중동을 눌러 국가가 AE·SA 로 채워지고 적용됨 → 사용자가
    // 드롭다운에서 SA 를 해제(draft 만 변경) → 그 사이 패널 밖에서 URL 이 바뀐다
    // (축 목록 도착, 칩 클릭 등). 종전에는 draft 를 URL 값으로 통째로 되돌려
    // **해제한 SA 가 다시 선택된 채** 돌아왔다.
    const applied = { geography: ["AE", "SA"] };
    const draft = { geography: ["AE"] };
    const next = { geography: ["AE", "SA"], source: ["Official (Competitor)"] };
    expect(mergeAppliedDraft(draft, applied, next, G)).toEqual({
      geography: ["AE"],
      source: ["Official (Competitor)"],
    });
  });

  it("인용 칩이 ?source= 만 바꾸면 고르던 국가·엔진 선택이 살아남는다 (#12)", () => {
    const applied = {};
    const draft = { geography: ["KR"], engine: ["chatgpt"] };
    const next = { source: ["Dealer & Marketplace"] };
    expect(mergeAppliedDraft(draft, applied, next, G)).toEqual({
      geography: ["KR"],
      engine: ["chatgpt"],
      source: ["Dealer & Marketplace"],
    });
  });

  it("실제로 바뀐 축은 URL 값을 받는다 (적용·뒤로가기·초기화)", () => {
    const applied = { geography: ["KR"] };
    const draft = { geography: ["KR", "US"] };
    expect(mergeAppliedDraft(draft, applied, { geography: ["JP"] }, G)).toEqual({
      geography: ["JP"],
    });
    // 전체 초기화 = 모든 축이 비워진 URL → draft 도 비워진다.
    expect(mergeAppliedDraft(draft, applied, {}, G)).toEqual({});
  });

  it("클릭 순서만 다른 같은 선택은 변경으로 보지 않는다", () => {
    const draft = { geography: ["US", "KR"], engine: ["gemini"] };
    const merged = mergeAppliedDraft(draft, { geography: ["KR", "US"] }, { geography: ["US", "KR"] }, G);
    expect(merged).toBe(draft); // 같은 객체 = 리렌더 없음
  });
});

describe("pruneToOptions — 국가 축도 옵션 목록 안으로 좁힌다 (QA #4)", () => {
  it("현재 브랜드가 측정하지 않은 국가는 draft 에서 빠진다", () => {
    // Hyundai 중동 = AE·SA / Kia 중동 = AE·IL (2026-09-04 실측). 브랜드를 바꾸면
    // 목록에 없는 국가가 draft 에 남아 해제할 방법이 없었다.
    expect(pruneToOptions({ geography: ["AE", "SA"] }, "geography", ["AE", "IL"])).toEqual({
      geography: ["AE"],
    });
    // 남는 것이 없으면 축 자체를 지운다.
    expect(pruneToOptions({ geography: ["SA"] }, "geography", ["AE", "IL"])).toEqual({});
    // 옵션을 모르면(서버 목록 미도착) 건드리지 않는다.
    const d = { geography: ["SA"] };
    expect(pruneToOptions(d, "geography", null)).toBe(d);
  });
});

describe("presetRange — 기간 프리셋과 수집 시작일 클램프 (QA #19·#20)", () => {
  const today = new Date(2026, 8, 8); // 2026-09-08 (로컬 캘린더)

  it("연간은 시작일이 1년 전이다 — 종료일과 같아지지 않는다", () => {
    expect(presetRange("yearly", today)).toEqual({ from: "2025-09-08", to: "2026-09-08" });
  });

  it("주간·월간은 각각 7일·30일 창", () => {
    expect(presetRange("weekly", today)).toEqual({ from: "2026-09-02", to: "2026-09-08" });
    expect(presetRange("monthly", today)).toEqual({ from: "2026-08-10", to: "2026-09-08" });
  });

  // GGMD-54 — 2주간 = 오늘 포함 최근 14일(주간 7일·월간 30일과 같은 트레일링 규칙).
  it("2주간은 14일 창 — 주간의 두 배이고 월간보다 좁다", () => {
    expect(presetRange("biweekly", today)).toEqual({ from: "2026-08-26", to: "2026-09-08" });
    // 월말 경계를 넘어도 달력이 맞다(9/8 − 13일 = 8/26).
    expect(presetRange("biweekly", new Date(2026, 9, 3))).toEqual({ from: "2026-09-20", to: "2026-10-03" });
    // 수집 시작일 클램프도 같은 규칙.
    expect(presetRange("biweekly", today, "2026-09-01").from).toBe("2026-09-01");
  });

  it("수집 시작일 이전이면 시작일로 클램프한다", () => {
    expect(presetRange("yearly", today, "2026-06-07")).toEqual({
      from: "2026-06-07",
      to: "2026-09-08",
    });
    // 이미 수집 시작일 이후인 프리셋은 건드리지 않는다.
    expect(presetRange("weekly", today, "2026-06-07").from).toBe("2026-09-02");
  });

  it("수집 시작일이 오늘이면 클램프하지 않는다 — 시작=종료 퇴화 방지", () => {
    expect(presetRange("yearly", today, "2026-09-08").from).toBe("2025-09-08");
    expect(presetRange("yearly", today, "2026-10-01").from).toBe("2025-09-08");
  });
});

// ── GGMD-107 C2 — 끝점은 오늘이 아니라 최신 노출 회차 앵커일 `E` ─────────────
//
// 스펙 `period-comparison-delta`「기간 비교 창은 최신 노출 회차 앵커일을 끝점으로
// 삼는다」. 여기서 고정하는 것은 **프리셋이 만드는 날짜쌍**이고, Δ 의 두 창은
// 순수 계층(`lib/kpi/period-compare.test.ts::resolveWindows`)이 따로 고정한다.
describe("presetRange — 끝점 E (GGMD-107 C2)", () => {
  const today = new Date(2026, 8, 18); // 2026-09-18

  it("E 가 주어지면 창이 E 에서 끝난다 — 오늘이 아니다 (스펙 시나리오 그대로)", () => {
    // GIVEN 글로벌 최신 노출 회차 앵커 2026-09-13, 오늘 2026-09-18
    expect(presetRange("weekly", "2026-09-13")).toEqual({
      from: "2026-09-07",
      to: "2026-09-13",
    });
    // THEN 09-12 ~ 09-18 이 **아니다**
    expect(presetRange("weekly", today)).toEqual({ from: "2026-09-12", to: "2026-09-18" });
  });

  it("E 기준 창이 design §1·골든 G1~G3 의 현재 창과 같다", () => {
    expect(presetRange("weekly", "2026-09-13").from).toBe("2026-09-07"); // G1 cur
    expect(presetRange("biweekly", "2026-09-13").from).toBe("2026-08-31"); // G2 cur
    expect(presetRange("monthly", "2026-09-13").from).toBe("2026-08-15"); // G3 cur
  });

  it("E 가 null·undefined 면 오늘로 폴백한다 = 종전 동작", () => {
    const base = presetRange("weekly", today);
    // 폴백 경로는 `end ?? new Date()` 라 '오늘' 자체를 고정할 수 없다 — 대신 Date 를
    // 넘긴 경로와 **같은 함수**를 타는지만 본다(null 은 분기만 갈린다).
    expect(presetRange("weekly", null)).toEqual(presetRange("weekly", new Date()));
    expect(presetRange("weekly", undefined)).toEqual(presetRange("weekly", new Date()));
    expect(base.to).toBe("2026-09-18");
  });

  it("문자열 E 는 **로컬 캘린더**로 읽는다 — `new Date('2026-09-13')` 의 UTC 파싱 함정", () => {
    // KST 에서 `new Date("2026-09-13")` 은 09-13 09:00 KST 이지만, 음수 오프셋
    // 로케일(예: UTC−5)에서는 09-12 로 접힌다. 끝점이 하루 밀리면 창 전체가 밀린다.
    expect(presetRange("weekly", "2026-09-13").to).toBe("2026-09-13");
    expect(presetRange("weekly", "2026-01-01").to).toBe("2026-01-01");
    expect(presetRange("weekly", "2026-01-01").from).toBe("2025-12-26");
  });

  it("수집 시작일 클램프는 E 기준에서도 그대로다", () => {
    expect(presetRange("yearly", "2026-09-13", "2026-06-07")).toEqual({
      from: "2026-06-07",
      to: "2026-09-13",
    });
    expect(presetRange("weekly", "2026-09-13", "2026-06-07").from).toBe("2026-09-07");
  });

  it("형식이 아닌 문자열은 오늘 폴백이다(깨진 값이 창을 무너뜨리지 않는다)", () => {
    expect(presetRange("weekly", "not-a-day")).toEqual(presetRange("weekly", new Date()));
  });
});

// ── yearly 프리셋 × 수집 시작일 클램프 — 캡션이 "1년" 이 아닌 구간 (2026-09-19 관찰) ──
//
// 관찰: `presetRange("yearly", E, minDay)` 는 시작일을 수집 시작일로 **클램프**한다
// (QA #19·#20). 그래서 수집 이력이 1년 미만인 동안 URL 은 `[수집시작일, E]` 가 되고,
// 게이트웨이의 `windowsFromRange` 는 그 길이(N < 365)를 그대로 읽는다 → 억제 캡션이
// `noPrevYear` 가 아니라 `noPrevWindow`(실제 N)로 떨어진다.
//
// **고치지 않기로 한다.** 근거 셋:
//   ① 문장이 **참**이다. 그 화면이 실제로 계산한 창은 99일이고, 직전 99일 구간에 회차가
//      0인 것도 사실이다. 틀린 수를 보여 주는 결함이 아니라 문안이 덜 구체적인 것이다.
//   ② 대안이 더 비싸다. 클램프를 풀면 **값의 창**이 함께 움직인다(카드 집계 구간이
//      `[E−1년, E]` 로). 값은 같게 나오지만(수집 전 구간에 데이터가 없으므로) QA #19·#20
//      이 고친 "수집 이전 구간을 고를 수 있는 것 자체가 오해" 를 되돌리고, 위 테스트가
//      고정한 동작을 깬다. 프리셋 이름은 URL 에 없으므로 "yearly 였다" 를 서버가 알 길도 없다.
//   ③ **전이적이고 자가 치유된다.** 수집 이력이 1년을 넘는 순간 클램프가 더 이상 안 걸려
//      N = 366 이 되고 `noPrevYear` 가 **코드 변경 없이** 나온다 — 스펙
//      「1년 프리셋은 …」의 "데이터가 쌓이면 코드 변경 없이" 요구와 같은 성질이다.
//
// 아래 두 케이스를 값으로 고정해 다음 사람이 이 판단을 다시 하지 않게 한다.
describe("yearly 프리셋의 캡션 — 클램프가 걸린 동안과 풀린 뒤", () => {
  const E = "2026-09-13";
  const suppressed = { reason: "no_prev" as const, cyclesPrev: 0, cyclesCur: 2 };

  it("수집 이력 1년 미만: 창이 클램프돼 `noPrevWindow`(실제 N) 다", () => {
    const r = presetRange("yearly", E, "2026-06-07");
    expect(r).toEqual({ from: "2026-06-07", to: E });
    const days = selectedWindowDays(r.from, r.to)!;
    expect(days).toBe(99);
    expect(isYearScaleWindow(days)).toBe(false);
    expect(periodCaption(suppressed, { days })).toEqual({
      key: "reason.noPrevWindow",
      params: { days: 99 },
    });
  });

  it("수집 이력 1년 초과: 클램프가 안 걸리고 `noPrevYear` 가 코드 변경 없이 나온다", () => {
    const r = presetRange("yearly", E, "2025-01-01");
    expect(r).toEqual({ from: "2025-09-13", to: E });
    const days = selectedWindowDays(r.from, r.to)!;
    expect(days).toBe(366); // 365 가 아니다 — 1년 전 같은 날부터 양 끝 포함
    expect(isYearScaleWindow(days)).toBe(true);
    expect(periodCaption(suppressed, { days })).toEqual({ key: "reason.noPrevYear", params: {} });
  });
});
