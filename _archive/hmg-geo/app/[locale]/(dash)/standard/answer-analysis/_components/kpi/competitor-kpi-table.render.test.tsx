import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { CompetitorKpiRow, KpiMetric } from "../../_data/kpi-view";

// QA 2차 #4 — 경쟁사 분석(노출률) 도넛.
//
// ⚠️ recharts 는 `renderToStaticMarkup` 에서 아무것도 내지 않는다(2026-09-10 실측:
// ResponsiveContainer 가 빈 `.recharts-wrapper` div 만 남긴다). 그래서 조각 수·툴팁
// 배선을 **마크업으로** 고정하려면 recharts 를 얇은 stub 으로 갈아끼워 이 컴포넌트가
// 실제로 넘기는 자식·props 를 드러내야 한다. 값 계약은 순수 함수(`donutSlices`)가
// 따로 소유한다.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-rc>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div data-piechart>{children}</div>,
  Pie: ({
    data,
    children,
  }: {
    data: Array<{ name: string; value: number }>;
    children?: React.ReactNode;
  }) => (
    <div data-pie>
      {data.map((d, i) => (
        <span key={i} data-slice={d.name}>
          {String(d.value)}
        </span>
      ))}
      {children}
    </div>
  ),
  Cell: ({ fill }: { fill: string }) => <span data-cell={fill} />,
  Tooltip: (props: { formatter?: unknown }) => (
    <div data-tooltip={typeof props.formatter === "function" ? "fn" : "none"} />
  ),
}));

const { CompetitorKpiTable, donutSlices } = await import("./competitor-kpi-table");

function row(over: Partial<CompetitorKpiRow> & { brand: string }): CompetitorKpiRow {
  return {
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

// 노출률 탭의 지문: 브랜드별 "등장 답변 비율"이라 브랜드 간 합이 100 을 넘는다.
const ROWS: CompetitorKpiRow[] = [
  row({ brand: "Hyundai", isTracked: true, pct: 58.3 }),
  row({ brand: "Toyota", pct: 30 }),
  row({ brand: "BMW", pct: 25 }),
  row({ brand: "Tesla", pct: 20 }),
  row({ brand: "Volvo", pct: 15 }),
];

function render(
  over: {
    metric?: KpiMetric;
    rows?: CompetitorKpiRow[];
    ownPct?: number | null;
    selected?: string[];
  } = {},
  locale: "ko" | "en" = "ko",
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <CompetitorKpiTable
        metric={over.metric ?? "exposure"}
        rows={over.rows ?? ROWS}
        ownPct={over.ownPct === undefined ? 58.3 : over.ownPct}
        coverage={{ cycles: 3, measuredCycles: 2, missingCycles: 1 }}
        selected={over.selected ?? []}
        onSelectedChange={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

const slices = (html: string) => [...html.matchAll(/data-slice="([^"]*)"/g)].map((m) => m[1]);
const legendDots = (html: string) =>
  (html.match(/class="h-2 w-2 rounded-full"/g) ?? []).length;

describe("CompetitorKpiTable — 도넛 다중 선택(QA 2차 #4a)", () => {
  it("draws one slice per selected competitor plus ours and the remainder", () => {
    // 고객 재현: 드롭다운 "4개 선택" 인데 도넛은 당사 + 첫 1개뿐이었다.
    const html = render({ selected: ["Toyota", "BMW", "Tesla", "Volvo"] });
    const names = slices(html);
    expect(names).toHaveLength(6); // 당사 + 4 + 그 외
    expect(names).toContain("Toyota");
    expect(names).toContain("BMW");
    expect(names).toContain("Tesla");
    expect(names).toContain("Volvo");
  });

  it("lists every selected competitor in the legend (remainder excluded)", () => {
    expect(legendDots(render({ selected: ["Toyota", "BMW", "Tesla"] }))).toBe(4); // 당사 + 3
    expect(legendDots(render({ selected: [] }))).toBe(1); // 당사만
  });

  it("keeps the two-slice donut and the own-set centre label when nothing is picked", () => {
    const html = render({ selected: [] });
    expect(slices(html)).toHaveLength(2);
    expect(html).toContain("58.3%");
  });

  it("colours a brand the same regardless of how many are picked", () => {
    const one = render({ selected: ["BMW"] });
    const many = render({ selected: ["Toyota", "BMW"] });
    const cellOf = (html: string, name: string) => {
      const at = html.indexOf(`data-slice="${name}"`);
      expect(at).toBeGreaterThan(-1);
      // Cell 은 조각과 같은 순서로 나열된다 — 인덱스로 짝을 짓는다.
      const idx = slices(html).indexOf(name);
      return [...html.matchAll(/data-cell="([^"]*)"/g)].map((m) => m[1])[idx];
    };
    expect(cellOf(one, "BMW")).toBe(cellOf(many, "BMW"));
  });
});

// 검증자 B5(2026-09-10) — 라이브 행 구성은 당사 3 + 경쟁사 9 = 12행이다. 색 인덱스가
// 행 인덱스이므로 팔레트가 8색이면 idx 3 과 idx 11 이 같은 색을 받는다. 종전에는 도넛
// 조각이 당사+1개뿐이라 구조적으로 드러날 수 없었고, QA 2차 #4(선택 전부를 조각으로)
// 이후 한 도넛 안에 같은 녹색 두 조각(Tesla·Volvo #0d6e2f)이 실제로 나왔다.
const LIVE_SHAPE: CompetitorKpiRow[] = [
  row({ brand: "Hyundai", isTracked: true, pct: 40 }),
  row({ brand: "Kia", isTracked: true, pct: 20 }),
  row({ brand: "Genesis", isTracked: true, pct: 10 }),
  // 경쟁사 9 — idx 3 … idx 11.
  ...["Tesla", "Toyota", "BMW", "Audi", "Ford", "Honda", "Nissan", "Porsche", "Volvo"].map((b, i) =>
    row({ brand: b, pct: 9 - i }),
  ),
];

describe("CompetitorKpiTable — 한 도넛 안 색 충돌(검증자 B5)", () => {
  const cells = (html: string) => [...html.matchAll(/data-cell="([^"]*)"/g)].map((m) => m[1]);

  it("never gives two slices in one donut the same colour", () => {
    // 실측 재현 그대로: 색 인덱스 3(Tesla)·11(Volvo)을 동시에 고른다.
    const html = render({ rows: LIVE_SHAPE, selected: ["Tesla", "Volvo"] });
    const names = slices(html);
    expect(names.slice(1)).toEqual(["Tesla", "Volvo", ko.answerAnalysis.mentions.kpi.competitor.restLegend]);
    const fills = cells(html);
    expect(fills).toHaveLength(names.length);
    expect(new Set(fills).size).toBe(fills.length);
  });

  it("keeps every colour distinct even when all nine competitors are picked", () => {
    const picked = LIVE_SHAPE.filter((r) => !r.isTracked).map((r) => r.brand);
    const fills = cells(render({ rows: LIVE_SHAPE, selected: picked }));
    expect(fills).toHaveLength(11); // 당사 합산 + 9 + 그 외
    expect(new Set(fills).size).toBe(11);
  });

  it("shows one legend dot per distinct colour (범례에도 같은 점이 두 번 찍히지 않는다)", () => {
    const html = render({ rows: LIVE_SHAPE, selected: ["Tesla", "Volvo"] });
    // 범례는 '그 외'를 뺀 나머지 — 색이 겹치면 같은 점이 두 번 찍힌다.
    expect(legendDots(html)).toBe(3);
    expect(new Set(cells(html).slice(0, -1)).size).toBe(3);
  });
});

describe("CompetitorKpiTable — 조각 호버 툴팁(QA 2차 #4b)", () => {
  it("wires a recharts Tooltip with a percent formatter into the pie chart", () => {
    const html = render({ selected: ["Toyota"] });
    expect(html).toContain('data-tooltip="fn"');
    // 툴팁은 반드시 <PieChart> 안에 있어야 조각 호버를 잡는다.
    const chartAt = html.indexOf("data-piechart");
    const tipAt = html.indexOf("data-tooltip");
    expect(chartAt).toBeGreaterThan(-1);
    expect(tipAt).toBeGreaterThan(chartAt);
  });

  it("never leaks the raw 'rest' key into a slice name", () => {
    const html = render({ selected: ["Toyota", "BMW"] });
    expect(html).not.toContain('data-slice="rest"');
    expect(slices(html).at(-1)).toBe(ko.answerAnalysis.mentions.kpi.competitor.restLegend);
    expect(slices(render({ selected: ["Toyota"] }, "en")).at(-1)).toBe(
      en.answerAnalysis.mentions.kpi.competitor.restLegend,
    );
  });
});

describe("CompetitorKpiTable — 상대 비중 각주(운영 D3)", () => {
  it("footnotes that exposure slices are relative weights once a competitor is picked", () => {
    expect(render({ selected: ["Toyota"] })).toContain(
      ko.answerAnalysis.mentions.kpi.competitor.donutRelativeNote,
    );
    expect(render({ selected: [] })).not.toContain(
      ko.answerAnalysis.mentions.kpi.competitor.donutRelativeNote,
    );
    // 점유율은 구성비라 합이 100 이다 — 각주가 붙으면 오히려 거짓말이 된다.
    expect(render({ metric: "sov", selected: ["Toyota"] })).not.toContain(
      ko.answerAnalysis.mentions.kpi.competitor.donutRelativeNote,
    );
  });

  it("carries the note in both dictionaries", () => {
    expect(render({ selected: ["Toyota"] }, "en")).toContain(
      en.answerAnalysis.mentions.kpi.competitor.donutRelativeNote,
    );
    expect(render({ selected: ["Toyota"] }, "en")).not.toContain(
      "answerAnalysis.mentions.kpi",
    );
  });
});

describe("donutSlices — 값 계약", () => {
  const args = (selected: string[]) => ({
    rows: ROWS,
    ownPct: 58.3,
    selected,
    ownLabel: "당사 1사 합산",
    restLabel: "그 외",
    colorIndex: new Map(ROWS.map((r, i) => [r.brand, i])),
  });

  it("keeps ours + rest summing to 100 when nothing is picked", () => {
    const s = donutSlices(args([]))!;
    expect(s.map((x) => x.value)).toEqual([58.3, 41.7]);
  });

  it("clamps the remainder at zero instead of going negative", () => {
    // 58.3 + 30 + 25 + 20 + 15 = 148.3 → 나머지는 0(음수 조각은 그릴 수 없다).
    const s = donutSlices(args(["Toyota", "BMW", "Tesla", "Volvo"]))!;
    expect(s).toHaveLength(6);
    expect(s.at(-1)!.value).toBe(0);
    expect(s.slice(1, -1).map((x) => x.name)).toEqual(["Toyota", "BMW", "Tesla", "Volvo"]);
  });

  it("orders slices by the table's row order, not by click order", () => {
    const s = donutSlices(args(["Volvo", "Toyota"]))!;
    expect(s.slice(1, -1).map((x) => x.name)).toEqual(["Toyota", "Volvo"]);
  });

  it("ignores picks that are not competitor rows and rows with no value", () => {
    const s = donutSlices({
      ...args(["Hyundai", "Ghost", "Toyota"]),
      rows: [...ROWS, row({ brand: "Ghost", pct: null })],
    })!;
    expect(s.map((x) => x.name)).toEqual(["당사 1사 합산", "Toyota", "그 외"]);
  });

  it("returns null when there is no own value to anchor the donut", () => {
    expect(donutSlices({ ...args(["Toyota"]), ownPct: null })).toBeNull();
  });

  it("gives every slice a unique react key", () => {
    const s = donutSlices(args(["Toyota", "BMW"]))!;
    expect(new Set(s.map((x) => x.key)).size).toBe(s.length);
  });
});
