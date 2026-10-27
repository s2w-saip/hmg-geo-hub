/**
 * 갭 보조선 **배선·렌더 가드** — 7개 소비 차트 전수.
 *
 * 종전 테스트들은 "recharts 는 `renderToStaticMarkup` 에서 SVG 를 안 낸다"는 제약 때문에
 * 계획(순수 함수)과 소스 문자열 대조로만 고정돼 있었다. 실제로 확인해 보니(2026-09-11)
 * recharts 3.8 은 폭·높이를 명시해도 SSR 에서 `<div class="recharts-wrapper">` 만 내고
 * 끝난다 — 크기 보고가 effect 라서다.
 *
 * 그래서 여기서는 **recharts 만** 얇은 스텁으로 바꾼다(children 을 그대로 통과시키고,
 * 축 스케일 훅은 결정적 가짜 스케일을 준다). 그러면 우리 코드가 그리는 보조선 `<path>` 는
 * **진짜로 렌더되고**, 그 `d` 를 눈으로 검산할 수 있다. 나머지(i18n·데이터 매핑·styleOf)는
 * 전부 실제 구현이 돈다.
 *
 * z-order 는 스텁으로도 **구조**까지는 고정한다 — 보조선 path 가 recharts 의
 * `ZIndexLayer`(포털 층) 안에 들어가는지, 그 층 번호가 본선(`DefaultZIndexes.line`)과
 * 같은지. 실제 픽셀 위아래는 프리뷰 실측(검증자)의 몫이다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import {
  bridgeLayers,
  bridgePaths as bridges,
  STUB_PLOT_AREA,
  tooltipBody,
  type RechartsStubState,
} from "@/test/recharts-stub";

/** 스텁이 읽는 가변 상태 — 각 테스트가 렌더 직전에 채운다. */
const axis = vi.hoisted(() => ({ xs: [] as Array<string | number> }) as RechartsStubState);

vi.mock("recharts", async () => {
  const { makeRechartsStub } = await import("@/test/recharts-stub");
  return makeRechartsStub({
    actual: await vi.importActual<Record<string, unknown>>("recharts"),
    state: axis,
  });
});

import { DefaultZIndexes } from "recharts";
import type { TrendGap, TrendGapRow } from "@/lib/viz/trend-gap";
import type { CitationTrend, MentionTrend } from "@/lib/scope/result-adapter";
import type { BrandTrendChartData, RankTrendChartData } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/mention-screen";
import type { SparkPointView, TrendChartView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { CitationTrendChart } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/citations-view";
import { MentionTrendChart } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/mentions-view";
import { BrandTrendChart } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/kpi/brand-trend-chart";
import { RankTrendChart } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/kpi/rank-trend-chart";
import { KpiTrendChart } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/kpi/kpi-trend-chart";
import { SparkAreaView } from "@/app/[locale]/(dash)/dashboard/_components/overview-kpi-cards";
import {
  LiveTrendChartView,
  trendBucketLabelFormatter,
} from "@/app/[locale]/(dash)/dashboard/_components/live-trend-chart";

const GAP: TrendGap = { reason: "collection_error" };

function wrap(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

/** 3차 베지어 한 개짜리 path 인가 — 직선(`L`)이 아니고 제어점이 있다. */
function isSmoothCubic(d: string): boolean {
  if (!/^M[-\d.,]+C[-\d.,]+$/.test(d)) return false;
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  if (n.length !== 8) return false;
  const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = n;
  const on = (x: number) => y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
  // 곡률 = 제어점이 끝점 직선에서 떨어져 있다. 둘 다 붙어 있으면 사실상 직선이다.
  return Math.abs(c1y - on(c1x)) > 0.5 || Math.abs(c2y - on(c2x)) > 0.5;
}

// ── 주별 축(week) 차트 두 종 ────────────────────────────────────────────────

const WEEK_AXIS = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07"];
const WEEK_CLEAN: TrendGapRow[] = [
  { week: "2026-08-10", "hyundai.com": 10, "kia.com": 8 },
  { week: "2026-08-17", "hyundai.com": 30, "kia.com": 12 },
  { week: "2026-08-31", "hyundai.com": 70, "kia.com": 30 },
  { week: "2026-09-07", "hyundai.com": 76, "kia.com": 33 },
];
const WEEK_GAP: TrendGapRow[] = [
  WEEK_CLEAN[0],
  WEEK_CLEAN[1],
  { week: "2026-08-24", "hyundai.com": null, "kia.com": null, gap: GAP },
  WEEK_CLEAN[2],
  WEEK_CLEAN[3],
];
const DOMAINS = ["hyundai.com", "kia.com"];

describe("CitationTrendChart (인용 · 주별 도메인)", () => {
  it("갭 창을 부드러운 3차 곡선으로 잇는다 — 시리즈마다 하나씩", () => {
    axis.xs = WEEK_AXIS;
    const trend: CitationTrend = { series: DOMAINS, points: WEEK_GAP };
    const drawn = bridges(wrap(<CitationTrendChart title="T" trend={trend} />));
    expect(drawn).toHaveLength(2);
    for (const b of drawn) {
      expect(isSmoothCubic(b.d), `직선이다: ${b.d}`).toBe(true);
      // 8/17(x 40) → 8/31(x 120) — 갭 창 밖으로 새지 않는다.
      expect(b.d.startsWith("M40,")).toBe(true);
      expect(b.d.endsWith(",120,60") || b.d.endsWith(",120,140")).toBe(true);
    }
  });

  it("갭이 없으면 보조선이 하나도 안 생긴다 — 회귀 0", () => {
    axis.xs = WEEK_AXIS;
    const trend: CitationTrend = { series: DOMAINS, points: WEEK_CLEAN };
    const html = wrap(<CitationTrendChart title="T" trend={trend} />);
    expect(bridges(html)).toEqual([]);
    expect(html).not.toContain("recharts-trend-gap-bridge");
  });
});

describe("MentionTrendChart (언급 · 당사/경쟁사)", () => {
  const points: TrendGapRow[] = [
    { week: "2026-08-10", Hyundai: 10, BMW: 8 },
    { week: "2026-08-17", Hyundai: 30, BMW: 12 },
    { week: "2026-08-24", Hyundai: null, BMW: null, gap: GAP },
    { week: "2026-08-31", Hyundai: 70, BMW: 30 },
    { week: "2026-09-07", Hyundai: 76, BMW: 33 },
  ];
  const trend: MentionTrend = { series: ["Hyundai", "BMW"], points };

  it("경쟁사 보조선만 점선·투명도를 유지한다(당사는 실선)", () => {
    axis.xs = WEEK_AXIS;
    const drawn = bridges(
      wrap(<MentionTrendChart title="M" trend={trend} series={{ own: ["Hyundai"], competitors: ["BMW"] }} />),
    );
    expect(drawn).toHaveLength(2);
    const own = drawn[0];
    const rival = drawn[1];
    expect(own["stroke-dasharray"]).toBeUndefined();
    expect(own["stroke-opacity"]).toBeUndefined();
    expect(own["stroke-width"]).toBe("3");
    expect(rival["stroke-dasharray"]).toBe("4 3");
    expect(rival["stroke-opacity"]).toBe("0.55");
    expect(rival["stroke-width"]).toBe("1.5");
    expect(isSmoothCubic(own.d)).toBe(true);
    expect(isSmoothCubic(rival.d)).toBe(true);
  });

  it("점선 보조선은 갭 창 [8/17, 8/31] 안에서 시작하고 끝난다", () => {
    axis.xs = WEEK_AXIS;
    const drawn = bridges(
      wrap(<MentionTrendChart title="M" trend={trend} series={{ own: ["Hyundai"], competitors: ["BMW"] }} />),
    );
    for (const b of drawn) {
      const n = b.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect(n[0]).toBe(40); // 8/17
      expect(n[6]).toBe(120); // 8/31
    }
  });
});

// ── 버킷 축(bucketStart) 차트 세 종 ─────────────────────────────────────────

const BUCKET_POINTS: TrendGapRow[] = [
  { bucketStart: "2026-08-10", Hyundai: 10, BMW: 8 },
  { bucketStart: "2026-08-17", Hyundai: 30, BMW: 12 },
  { bucketStart: "2026-08-24", Hyundai: null, BMW: null, gap: GAP },
  { bucketStart: "2026-08-31", Hyundai: 70, BMW: 30 },
  { bucketStart: "2026-09-07", Hyundai: 76, BMW: 33 },
];
const BRAND_SERIES = [
  { brand: "Hyundai", isTracked: true, colorIndex: 0 },
  { brand: "BMW", isTracked: false, colorIndex: 2 },
];

describe("BrandTrendChart / RankTrendChart (4-KPI 히어로)", () => {
  it("BrandTrendChart 가 브랜드마다 곡선 보조선을 낸다", () => {
    axis.xs = WEEK_AXIS;
    const data: BrandTrendChartData = {
      series: BRAND_SERIES,
      points: BUCKET_POINTS,
      coverage: [{ bucketStart: "2026-08-17", measuredDays: 7 }],
    };
    const drawn = bridges(wrap(<BrandTrendChart metric="sov" data={data} />));
    expect(drawn).toHaveLength(2);
    expect(drawn.every((b) => isSmoothCubic(b.d))).toBe(true);
  });

  it("RankTrendChart(역방향 축)도 같은 자세다", () => {
    axis.xs = WEEK_AXIS;
    const data: RankTrendChartData = {
      series: BRAND_SERIES,
      points: BUCKET_POINTS,
      coverage: [{ bucketStart: "2026-08-17", measuredDays: 7 }],
      yMax: 5,
    };
    const drawn = bridges(wrap(<RankTrendChart data={data} />));
    expect(drawn).toHaveLength(2);
    expect(drawn.every((b) => isSmoothCubic(b.d))).toBe(true);
  });
});

const KPI_POINTS = [
  { bucketStart: "2026-08-10", pct: 10, numerator: 1, denominator: 10, measuredDays: 7 },
  { bucketStart: "2026-08-17", pct: 30, numerator: 3, denominator: 10, measuredDays: 7 },
  { bucketStart: "2026-08-24", pct: null, numerator: null, denominator: null, measuredDays: 0, gap: GAP },
  { bucketStart: "2026-08-31", pct: 70, numerator: 7, denominator: 10, measuredDays: 7 },
  { bucketStart: "2026-09-07", pct: 76, numerator: 8, denominator: 10, measuredDays: 7 },
];

describe("KpiTrendChart (4-KPI 탭 히어로)", () => {
  const points = KPI_POINTS;

  it("단일 시리즈 보조선 하나를 곡선으로 낸다", () => {
    axis.xs = WEEK_AXIS;
    const drawn = bridges(
      // 데이터 타입은 화면 쪽 KpiTrendPoint — 픽스처는 그 모양을 그대로 흉내낸다.
      wrap(<KpiTrendChart metric="sov" points={points as never} coverage={[]} />),
    );
    expect(drawn).toHaveLength(1);
    expect(isSmoothCubic(drawn[0].d)).toBe(true);
    expect(drawn[0].stroke).toBe("var(--color-brand-700)");
    expect(drawn[0].stroke).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("갭 없는 데이터에서는 아무것도 더하지 않는다", () => {
    axis.xs = WEEK_AXIS;
    const clean = points.filter((p) => !("gap" in p && p.gap));
    expect(bridges(wrap(<KpiTrendChart metric="sov" points={clean as never} coverage={[]} />))).toEqual([]);
  });
});

// ── 대시보드 두 종 ──────────────────────────────────────────────────────────

/** website/trend rows (gap marker per gap family; a gap without scope applies to both). */
const LIVE_ROWS: TrendChartView["rows"] = [
  { key: "2026-08-10", day: "2026-08-10", measuredDays: 7, answers: 10, values: { visibility: 10, shareOfVoice: 5 }, gap: { mention: null, citation: null } },
  { key: "2026-08-17", day: "2026-08-17", measuredDays: 7, answers: 10, values: { visibility: 30, shareOfVoice: 12 }, gap: { mention: null, citation: null } },
  { key: "2026-08-24", day: "2026-08-24", measuredDays: 0, answers: 0, values: {}, gap: { mention: GAP, citation: GAP } },
  { key: "2026-08-31", day: "2026-08-31", measuredDays: 7, answers: 12, values: { visibility: 70, shareOfVoice: 30 }, gap: { mention: null, citation: null } },
  { key: "2026-09-07", day: "2026-09-07", measuredDays: 7, answers: 12, values: { visibility: 76, shareOfVoice: 33 }, gap: { mention: null, citation: null } },
];
const LIVE_VIEW: TrendChartView = { rows: LIVE_ROWS, availableSeries: ["visibility", "shareOfVoice"] };
/** x labels as the chart formats the row days. */
const liveLabels = (rows: TrendChartView["rows"]) => {
  const fmt = trendBucketLabelFormatter("ko");
  return rows.map((r) => fmt.format(new Date(r.day)));
};

/** overview/card-trend sparkline points of the visibility card (Δ vs the previous valued point). */
const SPARK_POINTS: SparkPointView[] = [
  { bucketStart: "2026-08-10", value: 10, wow: null },
  { bucketStart: "2026-08-17", value: 30, wow: 20 },
  { bucketStart: "2026-08-24", value: null, wow: null, gap: GAP },
  { bucketStart: "2026-08-31", value: 70, wow: null },
  { bucketStart: "2026-09-07", value: 76, wow: 6 },
];
const SPARK_DAYS = SPARK_POINTS.map((p) => p.bucketStart);
const Spark = ({ points }: { points: SparkPointView[] }) => (
  <SparkAreaView points={points} domain={[0, 100]} hasValue kpiKey="visibility" isRank={false} fmt={(v) => String(v)} />
);

describe("LiveTrendChartView (대시보드 히어로 추이)", () => {
  it("보이는 시리즈만 곡선 보조선을 얻는다 (기본 노출률·SoV 2개)", () => {
    // x축은 포맷된 라벨이다 — 차트가 쓰는 것과 같은 포매터로 만든다.
    axis.xs = liveLabels(LIVE_ROWS);
    const drawn = bridges(wrap(<LiveTrendChartView view={LIVE_VIEW} />));
    expect(drawn).toHaveLength(2);
    expect(drawn.every((b) => isSmoothCubic(b.d))).toBe(true);
    // 8/17(x 40) → 8/31(x 120).
    for (const b of drawn) {
      const n = b.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect([n[0], n[6]]).toEqual([40, 120]);
    }
  });

  it("갭 없는 추이는 보조선이 없다", () => {
    const clean = LIVE_ROWS.filter((r) => !r.gap.mention);
    axis.xs = liveLabels(clean);
    expect(bridges(wrap(<LiveTrendChartView view={{ ...LIVE_VIEW, rows: clean }} />))).toEqual([]);
  });
});

describe("SparkAreaView (오버뷰 KPI 카드 스파크라인)", () => {
  it("스파크라인에도 곡선 보조선이 걸린다", () => {
    axis.xs = SPARK_DAYS;
    const drawn = bridges(wrap(<Spark points={SPARK_POINTS} />));
    expect(drawn).toHaveLength(1);
    expect(isSmoothCubic(drawn[0].d)).toBe(true);
    expect(drawn[0].stroke).toBe("var(--color-brand-700)");
  });

  it("갭이 없으면 보조선이 없다", () => {
    axis.xs = SPARK_DAYS;
    const clean = SPARK_POINTS.filter((p) => !p.gap);
    expect(bridges(wrap(<Spark points={clean} />))).toEqual([]);
  });
});


// ── 갭 슬롯 툴팁 = **없음** (2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘") ─────
//
// 종전에는 갭 슬롯에 "오류로 인해 수집되지 않음" 문구 박스가 떴다. 지금 계약은
// **아무것도 안 뜬다**(빈 박스도 금지)이다. 소스 대조(trend-gap-wiring.test.ts)만으로는
// "본문이 정말 아무것도 안 내는가"를 못 본다 — 특히 자기 툴팁 본문을 가진 차트는
// 본문 함수가 export 되지 않아 직접 부를 수도 없다. 그래서 recharts 스텁의 Tooltip 이
// recharts 와 같은 식으로(`cloneElement(content, { active, payload })`) 본문을 렌더하게
// 하고, 그 마크업을 본다.
//
// 대조군(측정된 슬롯)을 같이 재서 **비어 있음이 배선 실수가 아님**을 고정한다.
describe("갭 슬롯 툴팁 — 차트를 통과시켜 렌더로 확인", () => {
  afterEach(() => {
    axis.tooltipPayload = undefined;
  });

  /** payload 한 벌 — recharts 가 content 에 넘기는 모양 그대로. */
  const tip = (row: unknown, value: number | null, key = "series") =>
    [{ value, name: key, dataKey: key, payload: row, graphicalItemId: "g" }] as Array<
      Record<string, unknown>
    >;

  type Case = {
    label: string;
    render: () => string;
    gap: Array<Record<string, unknown>>;
    measured: Array<Record<string, unknown>>;
    setup: () => void;
  };

  const CASES: Case[] = [
    {
      label: "CitationTrendChart",
      setup: () => {
        axis.xs = WEEK_AXIS;
      },
      render: () =>
        wrap(<CitationTrendChart title="T" trend={{ series: DOMAINS, points: WEEK_GAP }} />),
      gap: tip(WEEK_GAP[2], null, "hyundai.com"),
      measured: tip(WEEK_GAP[1], 30, "hyundai.com"),
    },
    {
      label: "MentionTrendChart",
      setup: () => {
        axis.xs = WEEK_AXIS;
      },
      render: () =>
        wrap(
          <MentionTrendChart
            title="M"
            trend={{
              series: ["Hyundai", "BMW"],
              points: [
                { week: "2026-08-17", Hyundai: 30, BMW: 12 },
                { week: "2026-08-24", Hyundai: null, BMW: null, gap: GAP },
                { week: "2026-08-31", Hyundai: 70, BMW: 30 },
              ],
            }}
            series={{ own: ["Hyundai"], competitors: ["BMW"] }}
          />,
        ),
      gap: tip({ week: "2026-08-24", Hyundai: null, BMW: null, gap: GAP }, null, "Hyundai"),
      measured: tip({ week: "2026-08-17", Hyundai: 30, BMW: 12 }, 30, "Hyundai"),
    },
    {
      label: "BrandTrendChart (자기 툴팁 본문)",
      setup: () => {
        axis.xs = WEEK_AXIS;
      },
      render: () =>
        wrap(
          <BrandTrendChart
            metric="sov"
            data={{
              series: BRAND_SERIES,
              points: BUCKET_POINTS,
              coverage: [{ bucketStart: "2026-08-17", measuredDays: 7 }],
            }}
          />,
        ),
      gap: tip(BUCKET_POINTS[2], null, "Hyundai"),
      measured: tip(BUCKET_POINTS[1], 30, "Hyundai"),
    },
    {
      label: "RankTrendChart (자기 툴팁 본문)",
      setup: () => {
        axis.xs = WEEK_AXIS;
      },
      render: () =>
        wrap(
          <RankTrendChart
            data={{
              series: BRAND_SERIES,
              points: BUCKET_POINTS,
              coverage: [{ bucketStart: "2026-08-17", measuredDays: 7 }],
              yMax: 5,
            }}
          />,
        ),
      gap: tip(BUCKET_POINTS[2], null, "Hyundai"),
      measured: tip(BUCKET_POINTS[1], 30, "Hyundai"),
    },
    {
      label: "KpiTrendChart (자기 툴팁 본문)",
      setup: () => {
        axis.xs = WEEK_AXIS;
      },
      render: () => wrap(<KpiTrendChart metric="sov" points={KPI_POINTS as never} coverage={[]} />),
      gap: tip(KPI_POINTS[2], null, "pct"),
      measured: tip(KPI_POINTS[1], 30, "pct"),
    },
    {
      label: "LiveTrendChartView",
      setup: () => {
        axis.xs = liveLabels(LIVE_ROWS);
      },
      render: () => wrap(<LiveTrendChartView view={LIVE_VIEW} />),
      gap: tip({ label: "8/24", gap: GAP, visibility: null }, null, "visibility"),
      measured: tip({ label: "8/17", visibility: 30 }, 30, "visibility"),
    },
    {
      label: "SparkAreaView (오버뷰 카드)",
      setup: () => {
        axis.xs = SPARK_DAYS;
      },
      render: () => wrap(<Spark points={SPARK_POINTS} />),
      gap: tip({ bucketStart: "2026-08-24", value: null, wow: null, gap: GAP }, null, "value"),
      measured: tip({ bucketStart: "2026-08-17", value: 30, wow: 20 }, 30, "value"),
    },
  ];

  it.each(CASES)("$label — 갭 슬롯에서는 본문이 비어 있다", (c) => {
    c.setup();
    axis.tooltipPayload = c.gap;
    const body = tooltipBody(c.render());
    expect(body, "툴팁 자체가 안 그려졌다 — 스텁 배선을 확인할 것").not.toBeNull();
    expect(body).toBe("");
  });

  it.each(CASES)("$label — 측정된 슬롯에서는 본문이 나온다(대조군)", (c) => {
    c.setup();
    axis.tooltipPayload = c.measured;
    const body = tooltipBody(c.render());
    // null(툴팁 미렌더)도 실패다 — 안 그러면 위 "비어 있다"가 공허하게 통과한다.
    expect(body, "툴팁 자체가 안 그려졌다").not.toBeNull();
    expect(body).not.toBe("");
  });
});

// ── z-order ────────────────────────────────────────────────────────────────

describe("보조선 z-order — 갭 음영 위에 그린다", () => {
  /**
   * 종전 보조선은 recharts `<Line>` 이라 그래픽 층(`DefaultZIndexes.line`)에
   * 들어갔고, 갭 음영(`ReferenceArea` = `DefaultZIndexes.area`)보다 위였다.
   * 곡선 path 로 바꾸면서 층 밖에 남으면 음영 **아래**로 내려가 색이 덧칠된다
   * (2026-09-11 프리뷰 실측: rgb(0,44,95) → rgb(76,101,130), 경쟁사 0.55 는 한 번 더).
   */
  it("음영 층(area)이 본선 층(line)보다 아래라는 recharts 전제를 고정한다", () => {
    expect(DefaultZIndexes.area).toBeLessThan(DefaultZIndexes.line);
  });

  it("보조선 path 가 전부 line 층 안에 있다 — 인용 차트", () => {
    axis.xs = WEEK_AXIS;
    const trend: CitationTrend = { series: DOMAINS, points: WEEK_GAP };
    const html = wrap(<CitationTrendChart title="T" trend={trend} />);
    const layers = bridgeLayers(html);
    expect(layers).toHaveLength(bridges(html).length);
    expect(layers).toHaveLength(2);
    expect(new Set(layers)).toEqual(new Set([String(DefaultZIndexes.line)]));
  });

  it("yAxisId 를 쓰는 차트(LiveTrendChartView)에서도 층에 들어간다", () => {
    axis.xs = liveLabels(LIVE_ROWS);
    const html = wrap(<LiveTrendChartView view={LIVE_VIEW} />);
    expect(bridgeLayers(html)).toEqual([
      String(DefaultZIndexes.line),
      String(DefaultZIndexes.line),
    ]);
  });

  it("스파크라인(축 id 없음)도 마찬가지다", () => {
    axis.xs = SPARK_DAYS;
    const html = wrap(<Spark points={SPARK_POINTS} />);
    expect(bridgeLayers(html)).toEqual([String(DefaultZIndexes.line)]);
  });
});

// ── 오버슛 리미터 기준(plotSpan) 배선 ───────────────────────────────────────

describe("보조선 오버슛 기준은 플롯 높이(usePlotArea)에서 온다", () => {
  /**
   * 재검증자 M6: `usePlotArea` 를 `() => undefined` 로 스텁하면 제품이
   * `{ plotSpan: plotArea?.height }` 를 통째로 안 넘겨도 테스트가 못 잡는다.
   * 그래서 실값 스텁(`STUB_PLOT_AREA`)을 쓰고, **거의 평평한 시리즈**로 그 차이를
   * 드러낸다 — 끝점 스팬이 0 이라 plotSpan 이 없으면 허용치가 0 이 되고, 오버슛
   * 리미터가 접선을 0 까지 깎아 **직선**을 만든다.
   */
  const FLAT: TrendGapRow[] = [
    { week: "2026-08-10", "hyundai.com": 45 },
    { week: "2026-08-17", "hyundai.com": 50 },
    { week: "2026-08-24", "hyundai.com": null, gap: GAP },
    { week: "2026-08-31", "hyundai.com": 50 },
    { week: "2026-09-07", "hyundai.com": 55 },
  ];
  const trend: CitationTrend = { series: ["hyundai.com"], points: FLAT };

  it("플롯 높이가 있으면 굴곡을 남긴다 (plotSpan 전달 확인)", () => {
    axis.xs = WEEK_AXIS;
    axis.plotArea = { ...STUB_PLOT_AREA };
    const drawn = bridges(wrap(<CitationTrendChart title="T" trend={trend} />));
    axis.plotArea = undefined;
    expect(drawn).toHaveLength(1);
    // 허용치 = 0.05 × 200 = 10px > 실제 오버슛 1.93px → 접선을 그대로 쓴다.
    expect(drawn[0].d).toBe("M40,100C66.667,93.333,93.333,106.667,120,100");
    expect(isSmoothCubic(drawn[0].d)).toBe(true);
  });

  it("레이아웃 전(플롯 높이 없음)에는 같은 데이터가 직선으로 눌린다", () => {
    axis.xs = WEEK_AXIS;
    axis.plotArea = null;
    const drawn = bridges(wrap(<CitationTrendChart title="T" trend={trend} />));
    axis.plotArea = undefined;
    expect(drawn).toHaveLength(1);
    expect(drawn[0].d).toBe("M40,100C66.667,100,93.333,100,120,100");
    expect(isSmoothCubic(drawn[0].d)).toBe(false);
  });
});
