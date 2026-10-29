import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CompetitorKpiRow } from "../../_data/kpi-view";

// 검증자 뮤테이션 A(2026-09-10) — `onSelectedChange(next.slice(0, 1))` 을 **되돌려도**
// 83/83 이 초록이었다. 형제 테스트가 전부 `selected` prop 과 초기값 seam 만 쓰고
// 드롭다운의 쓰기 경로(`toggle` → `commit` → `onSelectedChange`)를 한 번도 안 밟기
// 때문이다. 고객이 신고한 #4a 의 직접 원인이 바로 그 경계라, 그 경계를 지나는 테스트를
// 따로 둔다.
//
// ⚠️ 이 리포에는 jsdom·@testing-library 가 없다(설치도 이 작업의 경계 밖). 그리고 radix
// `DropdownMenuContent` 는 **닫힌 상태**라 SSR 마크업에 항목이 아예 나오지 않는다.
// 그래서 드롭다운을 얇은 stub 으로 갈아끼워, 항목이 렌더 중에 받은 `onCheckedChange`
// (= 실제 컴포넌트의 `toggle` 클로저)를 채집해 직접 호출한다. 호출되는 코드는 stub 이
// 아니라 컴포넌트의 진짜 쓰기 경로다.

const dd = vi.hoisted(() => ({
  items: [] as Array<{ brand: string; checked: boolean; onCheckedChange: () => void }>,
  selectAll: [] as Array<(e: { preventDefault: () => void }) => void>,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ data, children }: { data: Array<{ name: string }>; children?: React.ReactNode }) => (
    <div>
      {data.map((d, i) => (
        <span key={i} data-slice={d.name} />
      ))}
      {children}
    </div>
  ),
  Cell: () => <span />,
  Tooltip: () => <div />,
}));

vi.mock("@/components/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      onSelect,
    }: {
      children?: React.ReactNode;
      onSelect?: (e: { preventDefault: () => void }) => void;
    }) => {
      if (onSelect) dd.selectAll.push(onSelect);
      return <div>{children}</div>;
    },
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      onCheckedChange,
    }: {
      children?: React.ReactNode;
      checked?: boolean;
      onCheckedChange?: () => void;
    }) => {
      dd.items.push({
        brand: String(children),
        checked: Boolean(checked),
        onCheckedChange: onCheckedChange ?? (() => {}),
      });
      return <div data-item={String(children)} data-checked={checked ? "1" : "0"} />;
    },
  };
});

const { CompetitorKpiTable } = await import("./competitor-kpi-table");

function row(brand: string, over: Partial<CompetitorKpiRow> = {}): CompetitorKpiRow {
  return {
    brand,
    isTracked: false,
    pct: 10,
    mentions: 10,
    spark: [1, 2],
    wowPp: 0,
    gapPp: null,
    inTrendSeries: true,
    ...over,
  };
}

const ROWS: CompetitorKpiRow[] = [
  row("Hyundai", { isTracked: true, pct: 58.3 }),
  row("Toyota", { pct: 30 }),
  row("BMW", { pct: 25 }),
  row("Tesla", { pct: 20 }),
  row("Volvo", { pct: 15 }),
];

const slices = (html: string) => [...html.matchAll(/data-slice="([^"]*)"/g)].map((m) => m[1]);

/** 한 번 렌더하고, 그 렌더에서 드롭다운 항목들이 받은 핸들러를 돌려준다. */
function draw(selected: string[], onSelectedChange: (brands: string[]) => void) {
  dd.items.length = 0;
  dd.selectAll.length = 0;
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <CompetitorKpiTable
        metric="exposure"
        rows={ROWS}
        ownPct={58.3}
        coverage={{ cycles: 3, measuredCycles: 2, missingCycles: 1 }}
        selected={selected}
        onSelectedChange={onSelectedChange}
      />
    </NextIntlClientProvider>,
  );
  return { html, items: [...dd.items], selectAll: [...dd.selectAll] };
}

describe("CompetitorKpiTable — 드롭다운 쓰기 경로 (뮤테이션 A 가드)", () => {
  it("hands the whole selection upward when four boxes are checked", () => {
    // 고객 재현 그대로: 체크 4번. 종전 `onPick(next[0] ?? null)` 이면 매번 길이 1 이 올라간다.
    const spy = vi.fn<(brands: string[]) => void>();
    let selected: string[] = [];
    for (const brand of ["Toyota", "BMW", "Tesla", "Volvo"]) {
      const { items } = draw(selected, (next) => {
        spy(next);
        selected = next;
      });
      const item = items.find((i) => i.brand === brand);
      expect(item, `${brand} 항목이 드롭다운에 없다`).toBeDefined();
      expect(item!.checked).toBe(false);
      item!.onCheckedChange();
    }
    expect(spy).toHaveBeenCalledTimes(4);
    // 절단이 있으면 [1, 1, 1, 1] 이 된다.
    expect(spy.mock.calls.map((c) => c[0].length)).toEqual([1, 2, 3, 4]);
    expect(selected).toEqual(["Toyota", "BMW", "Tesla", "Volvo"]);

    // 그 선택으로 다시 그리면 도넛은 당사 + 4 + 그 외 = 6조각이다.
    const { html, items } = draw(selected, () => {});
    expect(slices(html)).toHaveLength(6);
    expect(items.filter((i) => i.checked).map((i) => i.brand)).toEqual([
      "Toyota",
      "BMW",
      "Tesla",
      "Volvo",
    ]);
  });

  it("unchecks only the box that was clicked", () => {
    const spy = vi.fn<(brands: string[]) => void>();
    const { items } = draw(["Toyota", "BMW", "Tesla"], spy);
    items.find((i) => i.brand === "BMW")!.onCheckedChange();
    expect(spy).toHaveBeenCalledWith(["Toyota", "Tesla"]);
  });

  it("clears the selection through the '전체' item", () => {
    const spy = vi.fn<(brands: string[]) => void>();
    const { selectAll } = draw(["Toyota", "BMW"], spy);
    expect(selectAll).toHaveLength(1);
    selectAll[0]({ preventDefault: () => {} });
    expect(spy).toHaveBeenCalledWith([]);
  });
});
