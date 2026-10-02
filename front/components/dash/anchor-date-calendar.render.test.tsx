import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { AnchorDateCalendar } from "./anchor-date-calendar";
import { resolveTimeRangeView } from "./dimension-filter-panel";
import { kstToday } from "./selectable-dates";
import type { TimeRangeValue } from "./filter-encoding";

// 이 리포의 컴포넌트 테스트 관례 = `renderToStaticMarkup` 정적 마크업 검사
// (DOM·이벤트 루프 없음). 그래서 "클릭할 수 없다"는 **클릭을 시뮬레이션해서**가
// 아니라 마크업이 그 상태를 표현하는지로 고정한다: `disabled` · `aria-disabled` ·
// `tabIndex=-1` · 사유 `title` 넷이 함께 붙어 있어야 한다.
// 실제 포인터·키보드 동작은 브라우저 확인 목록으로 넘긴다(보고서).

/** 2026-09 의 KST 월요일들(글로벌 표면 정규 요일). */
const GLOBAL = ["2026-08-31", "2026-09-07", "2026-09-14"];

function render(node: React.ReactNode, locale: "ko" | "en" = "ko"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

function cal(over: Partial<React.ComponentProps<typeof AnchorDateCalendar>> = {}, locale: "ko" | "en" = "ko") {
  const value: TimeRangeValue = {};
  return render(
    <AnchorDateCalendar
      selectableDates={GLOBAL}
      value={value}
      onChange={() => {}}
      todayKst="2026-09-19"
      {...over}
    />,
    locale,
  );
}

/** `data-day="…"` 인 버튼 하나의 여는 태그를 뽑는다. */
function cell(html: string, day: string): string {
  const m = new RegExp(`<button[^>]*data-day="${day}"[^>]*>`).exec(html);
  if (!m) throw new Error(`cell ${day} not rendered`);
  return m[0];
}

describe("AnchorDateCalendar — 선택 가능/불가", () => {
  const html = cal();

  // 그리드는 한 달만 그린다(기본 = 목록의 최신 회차가 있는 달 = 2026-09).
  it("회차가 있는 날짜는 활성", () => {
    for (const d of ["2026-09-07", "2026-09-14"]) {
      const c = cell(html, d);
      expect(c).toContain('data-selectable="1"');
      expect(c).not.toContain("disabled");
      expect(c).not.toContain("aria-disabled");
    }
  });

  it("회차가 없는 날짜는 disabled + aria-disabled + tabIndex -1 + 사유 툴팁", () => {
    const c = cell(html, "2026-09-15");
    expect(c).toContain('data-selectable="0"');
    expect(c).toContain("disabled");
    expect(c).toContain('aria-disabled="true"');
    expect(c).toContain('tabindex="-1"');
    expect(c).toContain("이 날짜에는 측정 회차가 없습니다");
  });

  it("활성 날짜는 키보드 포커스를 받는다", () => {
    expect(cell(html, "2026-09-14")).toContain('tabindex="0"');
  });

  it("그 달의 모든 날이 그려진다(9월 30일)", () => {
    expect(cell(html, "2026-09-01")).toBeTruthy();
    expect(cell(html, "2026-09-30")).toBeTruthy();
    expect(html).not.toContain('data-day="2026-09-31"');
  });

  it("수집 시작일 이전은 비활성", () => {
    const h = cal({ minDay: "2026-09-07", value: { to: "2026-09-14" } });
    expect(cell(h, "2026-09-07")).toContain('data-selectable="1"');
    // 08-31 은 회차지만 수집 시작일 이전 → 비활성. 8월 달력을 열어 확인한다.
    const aug = cal({ minDay: "2026-09-07", value: { to: "2026-08-31" } });
    expect(cell(aug, "2026-08-31")).toContain('data-selectable="0"');
  });
});

describe("AnchorDateCalendar — 범위 표시", () => {
  it("시작·끝은 눌린 상태, 사이는 범위 표시", () => {
    const html = cal({ value: { from: "2026-09-07", to: "2026-09-14" } });
    expect(cell(html, "2026-09-07")).toContain('aria-pressed="true"');
    expect(cell(html, "2026-09-14")).toContain('aria-pressed="true"');
    expect(cell(html, "2026-09-10")).toContain('data-in-range="1"');
    expect(cell(html, "2026-09-18")).not.toContain('data-in-range="1"');
  });

  it("선택이 없으면 눌린 칸도 없다", () => {
    expect(cal()).not.toContain('aria-pressed="true"');
  });
});

describe("AnchorDateCalendar — '오늘'은 KST 로 판정한다", () => {
  it("UTC 2026-09-18T15:00Z 는 KST 09-19 → 09-19 가 오늘", () => {
    const today = kstToday(new Date("2026-09-18T15:00:00Z"));
    expect(today).toBe("2026-09-19");
    const html = cal({ todayKst: today });
    expect(cell(html, "2026-09-19")).toContain('data-today="1"');
    expect(cell(html, "2026-09-18")).not.toContain('data-today="1"');
  });

  it("그 1초 전(UTC 14:59:59Z)이면 09-18 이 오늘", () => {
    const today = kstToday(new Date("2026-09-18T14:59:59Z"));
    expect(today).toBe("2026-09-18");
    const html = cal({ todayKst: today });
    expect(cell(html, "2026-09-18")).toContain('data-today="1"');
    expect(cell(html, "2026-09-19")).not.toContain('data-today="1"');
  });
});

describe("AnchorDateCalendar — i18n", () => {
  it("사전 키가 새지 않는다(ko·en)", () => {
    for (const locale of ["ko", "en"] as const) {
      const html = cal({}, locale);
      expect(html).not.toMatch(/timeRange\./);
      expect(html).not.toContain("dashboard.filters");
    }
  });

  it("영문 사전에서는 영문 사유가 나온다", () => {
    expect(cell(cal({}, "en"), "2026-09-15")).toContain(
      "No measurement round on this date",
    );
  });

  it("달 이동 버튼에 접근 가능한 이름이 붙는다", () => {
    // 기대값은 사전에서 읽는다(문구 리터럴을 테스트에 박으면 사전과 두 벌이 된다).
    const dict = ko.dashboard.filters.timeRange;
    expect(cal()).toContain(`aria-label="${dict.prevMonth}"`);
    expect(cal()).toContain(`aria-label="${dict.nextMonth}"`);
  });
});

// ── 기본 회차 표시 (기간 미선택, 앵커 축) ───────────────────────────────────
//
// 축이 켜지면 기간 없는 기본 화면은 **노출 가능한 가장 최신 회차 하나**다(집계층
// `anchorLatestRoundClause`). 달력이 그 날을 안 그리면 고객은 "아무것도 안 골랐으니
// 전 기간"으로 읽고 카드의 숫자와 어긋난다. 아래 기대값은 실제 렌더 마크업 관찰로
// 확정했다(2026-09-20).
describe("AnchorDateCalendar — 기본 회차 표시", () => {
  it("선택이 없으면 최신 회차에 표식·사유가 붙는다 (선택은 아니다)", () => {
    const html = cal({ defaultDay: "2026-09-14" });
    const c = cell(html, "2026-09-14");
    expect(c).toContain('data-default-round="1"');
    expect(c).toContain("기간 미선택 시 이 회차를 봅니다");
    // 표시이지 선택이 아니다 — 누른 상태로 읽히면 안 된다.
    expect(c).toContain('aria-pressed="false"');
    expect(c).not.toContain('data-in-range="1"');
    // 선택 색(bg-brand-700)과 구분되는 연한 채우기.
    expect(c).toContain("bg-brand-700/20");
    expect(c).not.toContain("text-white");
  });

  it("다른 회차에는 안 붙는다", () => {
    const html = cal({ defaultDay: "2026-09-14" });
    expect(cell(html, "2026-09-07")).not.toContain("data-default-round");
  });

  it("선택이 하나라도 있으면 표식이 사라진다", () => {
    const html = cal({ defaultDay: "2026-09-14", value: { from: "2026-09-07", to: "2026-09-07" } });
    expect(cell(html, "2026-09-14")).not.toContain("data-default-round");
    // 고른 날은 종전대로 선택 표시.
    expect(cell(html, "2026-09-07")).toContain('aria-pressed="true"');
  });

  it("defaultDay 를 안 주면 마크업이 종전과 같다 (종전 호출부 불변)", () => {
    expect(cal({ defaultDay: null })).toBe(cal());
    expect(cal()).not.toContain("data-default-round");
  });

  it("en 로케일에도 사유 문구가 있다", () => {
    expect(cal({ defaultDay: "2026-09-14" }, "en")).toContain(
      "Shown by default when no period is selected",
    );
  });
});

// ── 뷰 모델이 그 값을 정한다 ────────────────────────────────────────────────
describe("resolveTimeRangeView — defaultDay", () => {
  it("축 on·선택 없음 → 목록의 최신 날짜", () => {
    const v = resolveTimeRangeViewForTest({ value: null, dates: GLOBAL });
    expect(v.defaultDay).toBe("2026-09-14");
  });

  it("선택이 있으면 null", () => {
    const v = resolveTimeRangeViewForTest({
      value: "2026-09-07..2026-09-07",
      dates: GLOBAL,
    });
    expect(v.defaultDay).toBeNull();
  });

  it("축 off(목록 없음)면 null — 기본 화면의 정의가 다르다(run 창)", () => {
    expect(resolveTimeRangeViewForTest({ value: null, dates: [] }).defaultDay).toBeNull();
  });
});

function resolveTimeRangeViewForTest(args: { value: string | null; dates: readonly string[] }) {
  return resolveTimeRangeView({
    value: args.value,
    selectableDates: args.dates,
    todayKst: "2026-09-19",
    now: new Date("2026-09-19T03:00:00Z"),
  });
}
