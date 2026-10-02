import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { encodeTimeRange } from "./filter-encoding";
import { countRounds, dayDiff, weekdayIndex } from "./selectable-dates";
import {
  DimensionFilterPanel,
  TIME_PRESET_ORDER,
  presetRange,
  resolveTimeRangeView,
  type DimensionGroup,
} from "./dimension-filter-panel";

// CALENDAR 스트림 — 기간 필터의 달력이 **회차가 있는 날짜만** 고를 수 있게 한다
// (스펙 `hmg-geo-answer-anchor-table-spec-2026-09-19` §5.1·§9.2).
//
// ⚠️ 라딕스 드롭다운은 **닫혀 있으면 내용을 렌더하지 않는다** — 정적 마크업
// (`renderToStaticMarkup`, 이 리포의 컴포넌트 테스트 관례)에는 트리거 칩만 남는다.
// 그래서 드롭다운 안쪽 분기(프리셋 스냅·비활성·회차 수·스냅 안내)는 순수 뷰 모델
// `resolveTimeRangeView` 로 고정하고, 마크업으로는 칩에 나타나는 것만 본다.
// 실제로 펼쳤을 때의 모습은 브라우저 확인 목록으로 넘긴다(보고서).
//
// 기대값은 손계산 리터럴이다. 달력 사실(2026): 09-14 = 월 · 09-18 = 금.

let SEARCH = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/dashboard",
  useSearchParams: () => new URLSearchParams(SEARCH),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const ONLY: DimensionGroup[] = ["time"];
/** 글로벌 표면 = KST 월요일들. */
const GLOBAL = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"];
const TODAY = "2026-09-19";
const NOW = new Date("2026-09-19T03:00:00Z"); // KST 09-19 정오

function view(over: Partial<Parameters<typeof resolveTimeRangeView>[0]> = {}) {
  return resolveTimeRangeView({
    value: null,
    minDay: null,
    endDay: "2026-09-18",
    todayKst: TODAY,
    now: NOW,
    ...over,
  });
}

const encodedOf = (v: ReturnType<typeof view>, preset: string) =>
  v.presets.find((p) => p.preset === preset)?.encoded ?? null;

function panel(props: Partial<React.ComponentProps<typeof DimensionFilterPanel>> = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <DimensionFilterPanel
        stage="overview"
        onlyGroups={ONLY}
        primaryGroups={ONLY}
        compact
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

/** 기간 축 트리거 칩의 여는 태그. */
const chip = (html: string) => /<button[^>]*facet-chip[^>]*>/.exec(html)?.[0] ?? "";

describe("selectableDates 미전달 = 종전 동작 (수용 기준 1)", () => {
  it("범위를 건드리지 않고 회차 수도 세지 않는다", () => {
    const v = view({ value: "2026-09-01..2026-09-16" });
    expect(v.range).toEqual({ from: "2026-09-01", to: "2026-09-16" });
    expect(v.didSnap).toBe(false);
    expect(v.anchored).toBe(false);
    expect(v.rounds).toBeNull();
  });

  it("빈 배열도 `undefined` 와 같은 경로다(리더의 '모른다')", () => {
    expect(view({ value: "2026-09-01..2026-09-16", selectableDates: [] })).toEqual(
      view({ value: "2026-09-01..2026-09-16" }),
    );
  });

  it("프리셋은 종전 `presetRange` 그대로다", () => {
    const v = view();
    for (const preset of TIME_PRESET_ORDER) {
      expect(encodedOf(v, preset)).toBe(
        encodeTimeRange(presetRange(preset, "2026-09-18", null)),
      );
    }
    // 손계산 리터럴로도 한 번 더 못박는다(최근 7일, 끝점 포함).
    expect(encodedOf(v, "weekly")).toBe("2026-09-12..2026-09-18");
  });

  it("프리셋이 비활성되는 일이 없다", () => {
    expect(view().presets.every((p) => p.encoded !== null)).toBe(true);
  });

  it("칩에 스냅 표식이 붙지 않고 네이티브 날짜 입력이 남는다", () => {
    SEARCH = "time=2026-09-01..2026-09-16";
    const html = panel();
    expect(chip(html)).not.toContain("data-time-snapped");
    expect(html).toContain("2026-09-01 ~ 2026-09-16");
  });

  it("`undefined` 와 빈 배열의 렌더 결과가 바이트 단위로 같다", () => {
    SEARCH = "time=2026-09-01..2026-09-16";
    expect(panel({ selectableDates: [] })).toBe(panel());
  });
});

// ── 2026-09-20 계약 변경(검증 B1·B2·W2) ──────────────────────────────────
// 스냅은 **제안**이다. 실효 범위·칩 표시·커밋값은 URL 원 범위 그대로다.
// 이유: 서버 술어(`round_date BETWEEN`)가 원 범위로 돌므로 스냅값을 보여 주면
// "고르지도 않은 회차가 선택된 것처럼" 읽히고, 달력 월·주 프리셋을 스냅하면
// 비교 모양 판정이 MoM·WoW 를 못 읽는다.
describe("selectableDates 전달 = 회차 날짜를 **제안**한다 (요구 2)", () => {
  // N4: 제안은 **회차가 0개일 때만** 한다. 회차가 하나라도 걸리면 화면은 정상이므로
  // 말을 걸지 않는다(종전에는 달력 월 프리셋마다 배너가 떴고, 그 버튼을 누르면
  // 방금 고른 MoM 이 창 비교로 떨어졌다).
  it("회차가 걸리는 범위에는 제안하지 않는다", () => {
    const v = view({ value: "2026-09-01..2026-09-16", selectableDates: GLOBAL });
    expect(v.range).toEqual({ from: "2026-09-01", to: "2026-09-16" });
    expect(v.rounds).toBeGreaterThan(0);
    expect(v.didSnap).toBe(false);
    expect(v.suggested).toBeNull();
  });

  it("달력 월 프리셋 직후에도 배너가 안 뜬다 (MoM 을 깨뜨리지 않는다)", () => {
    const v = view({ value: "2026-08-01..2026-08-31", selectableDates: GLOBAL });
    expect(v.rounds).toBeGreaterThan(0);
    expect(v.suggested).toBeNull();
  });

  it("이미 회차 날짜면 제안이 없다", () => {
    const v = view({ value: "2026-08-31..2026-09-14", selectableDates: GLOBAL });
    expect(v.didSnap).toBe(false);
    expect(v.suggested).toBeNull();
    expect(v.range).toEqual({ from: "2026-08-31", to: "2026-09-14" });
  });

  it("회차가 하나도 없는 범위는 `rounds` 0 이고 칩이 그것을 말한다", () => {
    const v = view({ value: "2026-09-09..2026-09-10", selectableDates: GLOBAL });
    expect(v.rounds).toBe(0);
    expect(v.range).toEqual({ from: "2026-09-09", to: "2026-09-10" });
    SEARCH = "time=2026-09-09..2026-09-10";
    const html = panel({ selectableDates: GLOBAL });
    expect(chip(html)).toContain('data-time-empty="1"');
    // 칩은 사용자가 **실제로 조회한** 범위를 말한다.
    expect(html).toContain("2026-09-09 ~ 2026-09-10");
    expect(html).toContain("이 기간에는 측정 회차가 없습니다");
  });

  // 제안 버튼은 드롭다운 **안**이라 닫힌 패널의 정적 마크업에는 없다(라딕스가
  // 닫혀 있으면 내용을 렌더하지 않는다). 그래서 여기서는 뷰 모델까지 고정하고,
  // 실제 클릭은 프리뷰 확인 목록으로 넘긴다.
  // ⚠️ 제안은 **하루가 아니라 그 회차가 속한 주**다(2026-09-20 프리뷰 실측).
  //    하루 창(`2026-09-07..2026-09-07`)을 적용하면 직전 구간도 하루가 되어 카드 5개의
  //    증감이 전부 억제된다. 주 창이면 `calendarWeek` 으로 읽혀 WoW 가 산다.
  //    기대값은 손계산이다 — 2026-09-07 은 월요일이므로 그 주는 09-07(월)~09-13(일).
  it("가까운 회차가 속한 **주**로 가는 동작을 제안한다(자동 적용이 아니다)", () => {
    // 회차가 0개인 범위에서만 제안이 붙는다.
    const v = view({ value: "2026-09-09..2026-09-10", selectableDates: GLOBAL });
    expect(v.rounds).toBe(0);
    expect(v.suggested).toEqual({ from: "2026-09-07", to: "2026-09-13" });
    // 제안일 뿐이므로 실효 범위는 그대로다.
    expect(v.range).toEqual({ from: "2026-09-09", to: "2026-09-10" });
  });

  it("제안 창은 그 회차를 반드시 포함한다 (적용하면 빈 화면이 아니다)", () => {
    const v = view({ value: "2026-09-09..2026-09-10", selectableDates: GLOBAL });
    const s = v.suggested!;
    expect(countRounds(GLOBAL, s.from, s.to)).toBeGreaterThan(0);
  });

  it("제안 창은 월~일 7일이라 달력 주로 읽힌다 (WoW 가 산다)", () => {
    const v = view({ value: "2026-09-09..2026-09-10", selectableDates: GLOBAL });
    const s = v.suggested!;
    expect(weekdayIndex(s.from!)).toBe(1); // 월요일
    expect(weekdayIndex(s.to!)).toBe(0); // 일요일
    expect(dayDiff(s.from!, s.to!)).toBe(6);
  });

  // website 표면은 회차가 **금요일**이다. 그 금요일이 속한 월~일이 나와야 한다
  // (손계산: 2026-09-11 = 금 → 그 주 월요일 09-07, 일요일 09-13).
  it("website(금요일 귀속)도 그 금요일이 속한 월~일이 된다", () => {
    const WEBSITE = ["2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18"];
    const v = view({ value: "2026-09-09..2026-09-10", selectableDates: WEBSITE });
    expect(v.rounds).toBe(0);
    expect(v.suggested).toEqual({ from: "2026-09-07", to: "2026-09-13" });
    expect(countRounds(WEBSITE, "2026-09-07", "2026-09-13")).toBe(1);
  });

  it("한쪽만 열린 요청도 닫힌 주 창으로 제안한다", () => {
    // 목록 최신(09-14)보다 뒤에서 시작하는 열린 창 = 회차 0개.
    const v = view({ value: "2026-09-16..", selectableDates: GLOBAL });
    expect(v.rounds).toBe(0);
    expect(v.suggested).toEqual({ from: "2026-09-14", to: "2026-09-20" });
  });

  it("고른 범위 안의 회차 수를 센다", () => {
    expect(view({ value: "2026-08-31..2026-09-14", selectableDates: GLOBAL }).rounds).toBe(3);
    expect(view({ value: "2026-09-14..2026-09-14", selectableDates: GLOBAL }).rounds).toBe(1);
    expect(view({ selectableDates: GLOBAL }).rounds).toBe(4); // 미선택 = 전체
  });

  it("회차가 걸리면 칩에 표식이 없고 원 범위가 보인다", () => {
    SEARCH = "time=2026-09-01..2026-09-16";
    const html = panel({ selectableDates: GLOBAL });
    expect(chip(html)).not.toContain("data-time-snapped");
    expect(chip(html)).not.toContain("data-time-empty");
    expect(html).toContain("2026-09-01 ~ 2026-09-16");
  });

  it("회차가 0개일 때만 칩에 표식이 붙는다", () => {
    SEARCH = "time=2026-09-09..2026-09-10";
    const c = chip(panel({ selectableDates: GLOBAL }));
    expect(c).toContain("data-time-snapped");
    expect(c).toContain('data-time-empty="1"');
  });
});

describe("프리셋 원본 창과 비활성 (요구 3)", () => {
  // N3: 스냅은 프리셋에서 완전히 빠졌다. 트레일링도 원본 창 그대로다.
  it("**트레일링** 프리셋도 원본 창 그대로다", () => {
    const v = view({ selectableDates: GLOBAL });
    expect(encodedOf(v, "weekly")).toBe("2026-09-12..2026-09-18"); // E=09-18 까지 7일
    expect(encodedOf(v, "biweekly")).toBe("2026-09-05..2026-09-18");
    expect(encodedOf(v, "monthly")).toBe("2026-08-20..2026-09-18");
  });

  it("창 안에 회차가 없으면 `null`(= 비활성 + 사유 툴팁)", () => {
    // 최신 회차가 09-14 인데 끝점이 12-31 이면 '주간'(12-25~12-31) 창은 빈다.
    const v = view({ selectableDates: GLOBAL, endDay: "2026-12-31" });
    expect(encodedOf(v, "weekly")).toBeNull();
    expect(encodedOf(v, "biweekly")).toBeNull();
    // 연간(2025-12-31~2026-12-31)에는 회차가 있으므로 살아 있고, 창은 원본이다.
    expect(encodedOf(v, "yearly")).toBe("2025-12-31..2026-12-31");
  });

  it("수집 시작일 클램프가 프리셋 창에도 걸린다", () => {
    const v = view({ selectableDates: GLOBAL, minDay: "2026-09-01" });
    // 월간 창의 시작이 09-01 로 잘린다(끝점은 E=09-18).
    expect(encodedOf(v, "monthly")).toBe("2026-09-01..2026-09-18");
  });
});

describe("달력 그리드 배선", () => {
  it("selectableDates 가 있으면 기간 축이 앵커 경로로 간다", () => {
    expect(view({ selectableDates: GLOBAL }).anchored).toBe(true);
    expect(view().anchored).toBe(false);
  });

  it("사전 키가 새지 않는다", () => {
    SEARCH = "time=2026-09-01..2026-09-16";
    expect(panel({ selectableDates: GLOBAL })).not.toMatch(/timeRange\./);
  });
});
