import { describe, expect, it } from "vitest";
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
