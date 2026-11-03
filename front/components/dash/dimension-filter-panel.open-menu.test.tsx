import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";

// ════════════════════════════════════════════════════════════════════════════
// **열린** 기간 드롭다운의 내용 (프리뷰 차단 결함 2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 3bad250 프리뷰에서 기간 칩을 누르면 radix 메뉴가 열리는데 **자식 0개 · 256x8px ·
// 텍스트 0** 이었다. 프리셋도 달력도 날짜 입력도 없었다.
//
// 원인은 JSX 중첩이다: 빈 결과 안내를 맨 위로 옮기면서 닫는 태그 두 줄
// (`</div>` + `) : null}`)이 **옛 자리에 남았다**. 그래서 프리셋·직접 선택·달력이
// 통째로 `{emptyWindow ? … }` 안으로 빨려 들어갔고, `emptyWindow` 는 보통 false 라
// (기간 미지정이거나 회차가 걸리는 기간) 메뉴가 비었다. 축 off 에서도 `anchored`
// 가 false → `emptyWindow` false 라 **똑같이 비었다**.
//
// ⚠️ **기존 패널 테스트가 이걸 못 잡은 이유**: radix 는 닫힌 `DropdownMenuContent` 를
//    렌더하지 않는다. `renderToStaticMarkup(<DimensionFilterPanel/>)` 은 트리거(칩)만
//    그린다 — 칩에 붙는 `data-time-empty` 단언은 전부 통과했다.
//    그래서 여기서는 드롭다운 프리미티브를 **항상 자식을 그리는 통과 컴포넌트**로
//    갈아 끼워 콘텐츠 트리를 실제로 렌더한다.

vi.mock("@/components/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Item = ({
    children,
    checked,
    disabled,
    onCheckedChange: _onCheckedChange,
    onSelect: _onSelect,
    ...rest
  }: {
    children?: ReactNode;
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (v: boolean) => void;
    onSelect?: (e: unknown) => void;
  } & Record<string, unknown>) => (
    <div
      role="menuitemcheckbox"
      aria-checked={checked ? "true" : "false"}
      aria-disabled={disabled ? "true" : undefined}
      {...rest}
    >
      {children}
    </div>
  );
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
      <div data-testid="menu-content" role="menu">
        {children}
      </div>
    ),
    DropdownMenuCheckboxItem: Item,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuLabel: Pass,
    DropdownMenuGroup: Pass,
    DropdownMenuItem: Item,
    DropdownMenuPortal: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuRadioGroup: Pass,
    DropdownMenuRadioItem: Item,
    DropdownMenuShortcut: Pass,
  };
});

let SEARCH = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/dashboard",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { DimensionFilterPanel } = await import("@/components/dash/dimension-filter-panel");

/** 글로벌(월요일 귀속) 회차 격자. */
const GLOBAL = ["2026-08-31", "2026-09-07", "2026-09-14"];

function render(over: { selectableDates?: string[]; latestAnchorDay?: string } = {}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <DimensionFilterPanel onlyGroups={["time"]} {...over} />
    </NextIntlClientProvider>,
  );
}

/** 열린 메뉴 콘텐츠 안쪽 마크업. */
function content(html: string): string {
  const at = html.indexOf('data-testid="menu-content"');
  expect(at, "메뉴 콘텐츠가 렌더되지 않았다").toBeGreaterThan(-1);
  return html.slice(at);
}

const countPresets = (html: string) =>
  (html.match(/data-preset="/g) ?? []).length;

beforeEach(() => {
  SEARCH = "";
});

// ── 재현 조합 — 어떤 입력에서도 메뉴가 비면 안 된다 ────────────────────────
const CASES: ReadonlyArray<[label: string, dates: string[] | undefined, search: string]> = [
  ["축 off (목록 미전달) · 기간 미지정", undefined, ""],
  ["축 off (목록 미전달) · 기간 지정", undefined, "time=2026-09-01..2026-09-16"],
  ["축 on · 기간 미지정", GLOBAL, ""],
  ["축 on · 회차가 걸리는 기간", GLOBAL, "time=2026-09-01..2026-09-16"],
  ["축 on · 회차 0개 기간(emptyWindow)", GLOBAL, "time=2026-09-09..2026-09-10"],
  ["축 on · 빈 목록(로더 실패·미적용)", [], ""],
  ["축 on · 빈 목록 + 기간 지정", [], "time=2026-09-01..2026-09-16"],
];

describe("열린 기간 메뉴는 **어떤 입력에서도** 비지 않는다", () => {
  it.each(CASES)("%s", (_label, dates, search) => {
    SEARCH = search;
    const c = content(render(dates === undefined ? {} : { selectableDates: dates }));
    // ① 프리셋 4종(트레일링 창)이 전부 있다.
    expect(countPresets(c)).toBe(4);
    // ② "직접 선택" 구역이 있다.
    expect(c).toContain(ko.dashboard.filters.timeRange.custom);
    // ③ 텍스트가 비어 있지 않다.
    expect(c.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
  });
});

describe("축 off · 빈 목록 = 종전 입력으로 내려앉는다", () => {
  it.each([
    ["목록 미전달", undefined],
    ["빈 배열", [] as string[]],
  ])("%s 이면 네이티브 날짜 입력 2개", (_l, dates) => {
    const c = content(render(dates === undefined ? {} : { selectableDates: dates }));
    expect((c.match(/type="date"/g) ?? []).length).toBe(2);
    // 달력 그리드는 안 뜬다.
    expect(c).not.toContain("data-anchor-calendar");
    expect(countPresets(c)).toBe(4);
  });

  it("빈 배열과 미전달의 콘텐츠가 바이트 동일하다", () => {
    expect(content(render({ selectableDates: [] }))).toBe(content(render()));
  });
});

describe("축 on · 정상 목록", () => {
  const c = () => content(render({ selectableDates: GLOBAL }));

  it("프리셋이 4개(축 off 와 같은 목록)이고 달력 그리드가 뜬다", () => {
    expect(countPresets(c())).toBe(4);
    expect(c()).toContain("data-anchor-calendar");
    // 네이티브 입력은 대체된다.
    expect(c()).not.toContain('type="date"');
  });

  it("기간 미지정이면 기본 회차 표식이 달력에 있다", () => {
    expect(c()).toContain('data-default-round="1"');
  });
});

describe("축 on · 회차 0개 기간", () => {
  it("안내와 이동 버튼이 **프리셋보다 먼저** 나온다", () => {
    SEARCH = "time=2026-09-09..2026-09-10";
    const c = content(render({ selectableDates: GLOBAL }));
    const notice = c.indexOf("data-time-empty-notice");
    const apply = c.indexOf("data-time-snap-apply");
    const firstPreset = c.indexOf('data-preset="');
    expect(notice).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(-1);
    // 달력 그리드 뒤에 두면 팝오버를 스크롤해야 보인다(그 형태로 관찰됐다).
    expect(notice).toBeLessThan(firstPreset);
    expect(apply).toBeLessThan(firstPreset);
  });

  it("그래도 프리셋·달력은 그대로 있다 (안내가 콘텐츠를 삼키지 않는다)", () => {
    SEARCH = "time=2026-09-09..2026-09-10";
    const c = content(render({ selectableDates: GLOBAL }));
    expect(countPresets(c)).toBe(4);
    expect(c).toContain("data-anchor-calendar");
  });
});

describe("비활성 프리셋의 사유가 접근 이름에 실린다", () => {
  it("창에 회차가 없는 프리셋은 aria-label 에 사유가 붙는다", () => {
    // 회차가 01-05 뿐인데 끝점 E 가 03-01 → '주간'(02-23~03-01) 창에 회차가 없다.
    // (종전에는 E 없이 '오늘' 끝점으로 이 상태를 만들었다. 서비스 기준 주(2026-11-02)부터 E 가 없으면
    //  마지막 회차가 끝점이라 그 창에는 늘 회차가 있다 — time-preset-week.test.ts.)
    const c = content(render({ selectableDates: ["2026-01-05"], latestAnchorDay: "2026-03-01" }));
    expect(c).toMatch(/aria-label="[^"]*이 기간에는 측정 회차가 없습니다[^"]*"/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 프로젝트 지면 조합 (2026-09-20 통합 프리뷰 §9-2 "프로젝트 지면에 달력이 안 보인다")
// ════════════════════════════════════════════════════════════════════════════
//
// 관찰: `/ko/projects/{id}` 에서 달력 월 라벨 `null` · 활성 날짜 0 · 기본 표식 `[]` ·
// 카드 기준일 `null`. 다른 4지면은 같은 코드로 읽혔다.
//
// 이 블록이 가르는 것은 **배선이냐 데이터냐** 다:
//   · 목록이 **비어 있지 않으면** 프로젝트 지면 조합에서도 달력이 그려진다(아래 ①).
//     즉 `DimensionFilterPanel` 쪽 배선 누락이 아니다.
//   · 목록이 **비거나 `undefined` 면** 관찰된 화면과 정확히 같아진다(아래 ②) —
//     월 라벨 없음 · 활성 날짜 0 · 기본 표식 없음. 그러면 원인은 로더가 0행을 내는
//     쪽이고, 확인은 미러 SQL(`axis-on-sql/12-calendar-project.sql`) 몫이다.
//
// 프로젝트 표면은 정규 요일이 없다(귀속 날짜 = `anchor_date`, §9.2) — 그래서 픽스처
// 날짜도 요일이 제각각이다. 손계산: 2026-09-08 화 · 09-15 화 · 09-17 목.
const PROJECT_DATES = ["2026-09-08", "2026-09-15", "2026-09-17"];
/** 프로젝트 대시보드가 실제로 넘기는 그룹(`project-dashboard.tsx`). */
const PROJECT_GROUPS = ["time", "geography", "engine", "promptContext"] as const;

function renderProject(over: { selectableDates?: string[] } = {}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <DimensionFilterPanel
        stage="overview"
        onlyGroups={[...PROJECT_GROUPS]}
        {...over}
      />
    </NextIntlClientProvider>,
  );
}

describe("프로젝트 지면 조합 — 달력 배선", () => {
  it("① 목록이 있으면 프로젝트 지면에서도 달력·프리셋이 그려진다", () => {
    const c = content(renderProject({ selectableDates: PROJECT_DATES }));
    expect(c).toContain("data-anchor-calendar");
    expect(countPresets(c)).toBe(4);
    // 기간 미지정이면 목록의 마지막(최신) 날짜가 기본 회차 표식이다.
    expect(c).toContain('data-default-round="1"');
    expect(c).not.toContain('type="date"');
  });

  it("① 정규 요일이 아닌 날짜도 그대로 활성이다 (프로젝트 표면 계약)", () => {
    const c = content(renderProject({ selectableDates: PROJECT_DATES }));
    for (const d of PROJECT_DATES) expect(c).toContain(d);
  });

  it("② 목록이 비면 관찰된 화면과 같아진다 — 달력 없음·네이티브 입력", () => {
    for (const dates of [undefined, [] as string[]]) {
      const c = content(renderProject(dates === undefined ? {} : { selectableDates: dates }));
      expect(c).not.toContain("data-anchor-calendar");
      expect(c).not.toContain("data-default-round");
      expect((c.match(/type="date"/g) ?? []).length).toBe(2);
    }
  });

  it("② 다른 지면과 **같은 달력 내용**이다 (지면별 분기가 없다)", () => {
    // 달력의 의미 있는 출력만 뽑아 비교한다 — 프로젝트 지면은 뒤에 축이 셋 더 붙어
    // 메뉴 전체나 마크업 꼬리를 통째로 비교할 수 없다.
    const cells = (html: string): string[] => {
      const c = content(html);
      const month = /data-anchor-calendar-month="">([^<]*)</.exec(c)?.[1] ?? "";
      const days = c.match(/data-day="[^"]+"[^>]*/g) ?? [];
      expect(days.length, "달력 날짜 칸이 없다").toBeGreaterThan(0);
      return [month, ...days];
    };
    expect(cells(renderProject({ selectableDates: GLOBAL }))).toEqual(
      cells(render({ selectableDates: GLOBAL })),
    );
  });
});

// 서비스 기준 주(2026-11-02): 회차 목록이 없는 종전 경로의 날짜 입력은 아무 날이나 고를 수 있었다. 이제 기준 주 끝을
// 넘지 않는다(시작일은 고른 종료일도 넘지 않는다). 기준 주를 모르면(셸 공급자 없음) 종전 그대로다.
describe("서비스 기준 주 — (dash) 날짜 입력의 상한", () => {
  const WEEK = { state: "ok" as const, week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 }, delay: null, checkedAt: null, recordedAt: null, notes: [] };
  const dateInputs = (html: string) => [...content(html).matchAll(/<input[^>]*type="date"[^>]*>/g)].map((m) => m[0]);

  it("기준 주 끝이 두 입력의 상한이다", async () => {
    const ServiceWeekContext = (await import("@/components/service-week/provider")).serviceWeekContext();
    SEARCH = "";
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <ServiceWeekContext.Provider value={{ initial: Promise.resolve(WEEK), latest: WEEK, applies: true, surface: "global" }}>
          <DimensionFilterPanel onlyGroups={["time"]} />
        </ServiceWeekContext.Provider>
      </NextIntlClientProvider>,
    );
    const inputs = dateInputs(html);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input).toContain('max="2026-10-11"');
  });

  it("기준 주를 모르면 종전대로 상한이 없다", () => {
    SEARCH = "";
    for (const input of dateInputs(render())) expect(input).not.toContain("max=");
  });
});

// 서비스 기준 주 — 칩 · 직접 선택이 보이는 기간(리뷰 r1-15). BFF 는 기준 주 뒤의 `to` 를 기준 주 끝까지만 읽고(Context.create)
// 머리글도 그렇게 말하는데, 칩과 직접 선택은 URL 원 범위(2026-09-28 ~ 2026-10-25)를 찍었다. 이제 읽는 기간을 찍고
// 고른 기간은 title 에 싣는다. URL 은 고른 그대로다(기준 주가 넘어가면 같은 링크가 더 보인다).
describe("서비스 기준 주 — (dash) 칩 · 직접 선택이 보이는 기간", () => {
  const WEEK = { state: "ok" as const, week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 }, delay: null, checkedAt: null, recordedAt: null, notes: [] };
  const CUT_TITLE = "고른 기간 2026-09-28 ~ 2026-10-25 중 서비스 기준 주의 끝(2026-10-11)까지 보입니다.";
  const textOf = (html: string) => html.replace(/<[^>]*>/g, "");
  async function renderWeek(search: string, over: { selectableDates?: string[] } = {}): Promise<string> {
    const ServiceWeekContext = (await import("@/components/service-week/provider")).serviceWeekContext();
    SEARCH = search;
    return renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <ServiceWeekContext.Provider value={{ initial: Promise.resolve(WEEK), latest: WEEK, applies: true, surface: "global" }}>
          <DimensionFilterPanel onlyGroups={["time"]} {...over} />
        </ServiceWeekContext.Provider>
      </NextIntlClientProvider>,
    );
  }
  /** 기간 칩(트리거 버튼) 하나. */
  const chipOf = (html: string) => /<button[^>]*class="facet-chip[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";

  it("칩은 읽는 기간을 찍고 고른 기간을 title 에 싣는다", async () => {
    const chip = chipOf(await renderWeek("time=2026-09-28..2026-10-25"));
    expect(textOf(chip)).toContain("2026-09-28 ~ 2026-10-11");
    expect(textOf(chip)).not.toContain("2026-10-25");
    expect(chip).toContain(`title="${CUT_TITLE}"`);
  });

  it("종료일 입력은 읽는 날을 담는다(제 상한을 넘는 값이 없다)", async () => {
    const to = [...content(await renderWeek("time=2026-09-28..2026-10-25")).matchAll(/<input[^>]*type="date"[^>]*>/g)].map((m) => m[0])[1];
    expect(to).toContain('value="2026-10-11"');
    expect(to).toContain('max="2026-10-11"');
  });

  it("축 on: 직접 선택 범위와 달력의 끝도 읽는 기간이다", async () => {
    const c = content(await renderWeek("time=2026-09-28..2026-10-25", { selectableDates: ["2026-09-28", "2026-10-05"] }));
    const custom = /<div class="flex items-center gap-2 text-\[11px\] tabular-nums text-muted-foreground"[^>]*>[\s\S]*?<\/div>/.exec(c)?.[0] ?? "";
    expect(textOf(custom)).toBe("2026-09-28~2026-10-11");
    expect(custom).toContain(`title="${CUT_TITLE}"`);
    expect(c).toMatch(/<button[^>]*data-day="2026-10-11"[^>]*aria-pressed="true"/);
    expect(c).toMatch(/<button[^>]*data-day="2026-10-25"[^>]*aria-pressed="false"/);
  });

  it("기준 주 안의 기간 · 기준 주 뒤에서 시작하는 기간은 고른 그대로, title 없음", async () => {
    for (const [search, shown] of [
      ["time=2026-09-28..2026-10-09", "2026-09-28 ~ 2026-10-09"],
      ["time=2026-10-12..2026-11-01", "2026-10-12 ~ 2026-11-01"],
    ]) {
      const chip = chipOf(await renderWeek(search));
      expect(textOf(chip)).toContain(shown);
      expect(chip).not.toContain("서비스 기준 주의 끝");
    }
  });

  it("기준 주를 모르면(셸 공급자 없음) 종전대로 고른 그대로다", () => {
    SEARCH = "time=2026-09-28..2026-10-25";
    const chip = chipOf(render());
    expect(textOf(chip)).toContain("2026-09-28 ~ 2026-10-25");
    expect(chip).not.toContain("서비스 기준 주의 끝");
  });

  // 첫 그림(리뷰 r3-6, 2026-11-03): 셸은 첫 effect 에서야 기준 주를 안다. 그래서 서버 렌더와 브라우저의 첫 렌더에서 칩이
  // URL 기간(… ~ 10-25)을 찍었다 — 같은 화면의 머리글은 기준 주까지 읽은 기간인데. 칩은 그때 레이아웃이 읽은 기준 주로
  // 자르고(페이지와 함께 흘러 들어온다), 그 읽기를 아직 모르면 고른 그대로 찍는다. 칩만 그 읽기를 기다린다.
  it("첫 그림(서버 렌더)도 레이아웃이 읽은 기준 주로 자른다 — 모르면 고른 그대로", async () => {
    const { RnServiceWeekProvider } = await import("@/components/service-week/provider");
    const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
    const first = (week: Promise<typeof WEEK | null>) => {
      SEARCH = "time=2026-09-28..2026-10-25";
      return chipOf(
        renderToStaticMarkup(
          <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
            <RnServiceWeekProvider week={week}>
              <DimensionFilterPanel onlyGroups={["time"]} />
            </RnServiceWeekProvider>
          </NextIntlClientProvider>,
        ),
      );
    };
    const chip = first(settled(WEEK));
    expect(textOf(chip)).toContain("2026-09-28 ~ 2026-10-11");
    expect(textOf(chip)).not.toContain("2026-10-25");
    expect(chip).toContain(`title="${CUT_TITLE}"`);
    for (const week of [new Promise<typeof WEEK | null>(() => {}), settled(null)]) {
      expect(textOf(first(week))).toContain("2026-09-28 ~ 2026-10-25");
      expect(first(week)).not.toContain("서비스 기준 주의 끝");
    }
  });
});

// 기준 주에 묶이지 않는 화면(리뷰 r3-8, 2026-11-03): GA4 화면은 GA4 의 마지막 날까지 읽는다. 셸은 거기서도 기준 주를
// 알지만(`latest`) 그 끝을 날짜 선택에 주지 않는 것은 `applies` 하나뿐인데, 그것을 지키는 시험이 없었다.
describe("서비스 기준 주 — (dash) 기준 주에 묶이지 않는 화면(GA4)은 제 끝을 쓴다", () => {
  const WEEK = { state: "ok" as const, week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 }, delay: null, checkedAt: null, recordedAt: null, notes: [] };
  const textOf = (html: string) => html.replace(/<[^>]*>/g, "");
  const chipOf = (html: string) => /<button[^>]*class="facet-chip[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
  async function renderGa4(search: string): Promise<string> {
    const ServiceWeekContext = (await import("@/components/service-week/provider")).serviceWeekContext();
    SEARCH = search;
    return renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <ServiceWeekContext.Provider value={{ initial: Promise.resolve(WEEK), latest: WEEK, applies: false, surface: null }}>
          <DimensionFilterPanel onlyGroups={["time"]} latestAnchorDay="2026-10-25" />
        </ServiceWeekContext.Provider>
      </NextIntlClientProvider>,
    );
  }

  it("날짜 입력에 기준 주 상한이 없고, 주간은 화면의 마지막 날(10-25)에서 끝난다", async () => {
    // 주간 = 10-19 ~ 10-25(기준 주의 10-05 ~ 10-11 이 아니다)
    const c = content(await renderGa4("time=2026-10-19..2026-10-25"));
    expect(c).toMatch(/data-preset="weekly"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-preset="weekly"/);
    for (const input of c.match(/<input[^>]*type="date"[^>]*>/g) ?? []) expect(input).not.toContain('max="2026-10-11"');
  });

  it("기준 주 뒤의 기간은 칩과 종료일 입력에 고른 그대로다", async () => {
    const html = await renderGa4("time=2026-10-01..2026-10-31");
    expect(textOf(chipOf(html))).toContain("2026-10-01 ~ 2026-10-31");
    expect(html).not.toContain("서비스 기준 주의 끝");
    const to = (content(html).match(/<input[^>]*type="date"[^>]*>/g) ?? [])[1];
    expect(to).toContain('value="2026-10-31"');
    expect(to).not.toContain("max=");
  });
});
