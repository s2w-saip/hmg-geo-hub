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

function render(over: { selectableDates?: string[] } = {}): string {
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
    // 최신 회차가 09-14 뿐인 목록 → '주간' 창(오늘 기준)에 회차가 없다.
    const c = content(render({ selectableDates: ["2026-01-05"] }));
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
