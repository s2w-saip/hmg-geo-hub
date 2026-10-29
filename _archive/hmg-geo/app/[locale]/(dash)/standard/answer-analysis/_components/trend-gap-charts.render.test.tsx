import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { planTrendGaps, type TrendGap, type TrendGapRow } from "@/lib/viz/trend-gap";
import type { CitationTrend, MentionTrend } from "@/lib/scope/result-adapter";
import type { BrandTrendChartData, RankTrendChartData } from "../_data/kpi-view";
import { CitationTrendChart } from "./citations-view";
import { MentionTrendChart } from "./mentions-view";
import { BrandTrendChart } from "./kpi/brand-trend-chart";
import { RankTrendChart } from "./kpi/rank-trend-chart";

// 수집 오류 회차(2026-09-10 운영) — 인용 화면 "주별 상위 10개 도메인 인용 수" 에서
// 8/24 주가 골짜기로 찍히던 건이 이 픽스처다. 글로벌 8/25 앵커 회차가 정원의 1/4 만
// 수집돼 값이 낮게 나온 것이라, 값이 아니라 **음영 + 안내 문구**로 나가야 한다.
//
// ⚠️ recharts 는 SSR 에서 SVG 를 내지 않는다(brand-trend-chart.render.test.tsx 헤더).
// 마크업으로는 "차트가 그려졌는가"만 보고, 음영·보조 라인·툴팁 분기는 순수 seam
// (planTrendGaps / trend-gap-overlay 테스트)이 고정한다.

const GAP: TrendGap = { reason: "collection_error" };

function wrap(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

const WEEKS_CLEAN: TrendGapRow[] = [
  { week: "2026-08-10", "hyundai.com": 40, "kia.com": 22 },
  { week: "2026-08-17", "hyundai.com": 44, "kia.com": 25 },
  { week: "2026-08-31", "hyundai.com": 46, "kia.com": 24 },
];
const WEEKS_GAP: TrendGapRow[] = [
  WEEKS_CLEAN[0],
  WEEKS_CLEAN[1],
  { week: "2026-08-24", "hyundai.com": null, "kia.com": null, gap: GAP },
  WEEKS_CLEAN[2],
];
const DOMAIN_SERIES = ["hyundai.com", "kia.com"];

describe("CitationTrendChart", () => {
  it("keeps the markup byte-identical when the data carries no gap", () => {
    const trend: CitationTrend = { series: DOMAIN_SERIES, points: WEEKS_CLEAN };
    const plan = planTrendGaps(trend.points, { xKey: "week", seriesKeys: trend.series });
    // 갭이 없으면 계획은 아무것도 만들지 않고 행 배열도 그대로다 → 종전 렌더와 동일.
    expect(plan.hasGap).toBe(false);
    expect(plan.rows).toBe(trend.points);
    expect(plan.areas).toEqual([]);
    expect(wrap(<CitationTrendChart title="T" trend={trend} />)).toContain("T");
  });

  it("renders the gap week without throwing and without leaking a raw i18n key", () => {
    const trend: CitationTrend = { series: DOMAIN_SERIES, points: WEEKS_GAP };
    const html = wrap(<CitationTrendChart title="T" trend={trend} />);
    expect(html).not.toContain("trend.gap");
  });

  it("plans one shaded slot and one bridge per domain for the 8/24 week", () => {
    const plan = planTrendGaps(WEEKS_GAP, { xKey: "week", seriesKeys: DOMAIN_SERIES });
    expect(plan.areas).toHaveLength(1);
    expect([plan.areas[0].x1, plan.areas[0].x2]).toEqual(["2026-08-17", "2026-08-31"]);
    expect(plan.bridges.map((b) => b.seriesKey)).toEqual(DOMAIN_SERIES);
  });
});

describe("MentionTrendChart", () => {
  const tracked = new Set(["Hyundai"]);
  const series = ["Hyundai", "BMW"];
  const points: TrendGapRow[] = [
    { week: "2026-08-17", Hyundai: 30, BMW: 12 },
    { week: "2026-08-24", Hyundai: null, BMW: null, gap: GAP },
    { week: "2026-08-31", Hyundai: 33, BMW: 11 },
  ];

  it("renders the gap week", () => {
    const trend: MentionTrend = { series, points };
    const html = wrap(<MentionTrendChart title="M" trend={trend} trackedBrands={tracked} />);
    expect(html).toContain("M");
    expect(html).not.toContain("trend.gap");
  });

  it("bridges our brand and the competitor separately", () => {
    const plan = planTrendGaps(points, { xKey: "week", seriesKeys: series });
    expect(plan.bridges.map((b) => b.seriesKey)).toEqual(series);
  });
});

describe("BrandTrendChart / RankTrendChart", () => {
  const bucketPoints: TrendGapRow[] = [
    { bucketStart: "2026-08-17", Hyundai: 12.5, BMW: 8 },
    { bucketStart: "2026-08-24", Hyundai: null, BMW: null, gap: GAP },
    { bucketStart: "2026-08-31", Hyundai: 13.1, BMW: 7.5 },
  ];
  const series = [
    { brand: "Hyundai", isTracked: true, colorIndex: 0 },
    { brand: "BMW", isTracked: false, colorIndex: 2 },
  ];

  it("keeps the coverage label limited to measured cycles", () => {
    const data: BrandTrendChartData = {
      series,
      points: bucketPoints,
      // 커버리지는 측정된 회차만 — 갭 회차는 애초에 항목이 없다.
      coverage: [
        { bucketStart: "2026-08-17", measuredDays: 7 },
        { bucketStart: "2026-08-31", measuredDays: 7 },
      ],
    };
    const html = wrap(<BrandTrendChart metric="sov" data={data} />);
    expect(html.match(/일 측정/g) ?? []).toHaveLength(2);
    expect(html).not.toContain("trend.gap");
  });

  it("renders the reversed-axis rank chart across a gap", () => {
    const data: RankTrendChartData = {
      series,
      points: bucketPoints,
      coverage: [{ bucketStart: "2026-08-17", measuredDays: 7 }],
      yMax: 5,
    };
    const html = wrap(<RankTrendChart data={data} />);
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.firstRank.chartAxis);
    expect(html).not.toContain("trend.gap");
  });

  it("plans the same slot/bridge shape on the bucketStart axis", () => {
    const plan = planTrendGaps(bucketPoints, {
      xKey: "bucketStart",
      seriesKeys: series.map((s) => s.brand),
    });
    expect([plan.areas[0].x1, plan.areas[0].x2]).toEqual(["2026-08-17", "2026-08-31"]);
    expect(plan.bridges).toHaveLength(2);
  });
});
