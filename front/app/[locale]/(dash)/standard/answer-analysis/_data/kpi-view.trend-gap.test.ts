// KPI 탭 추이 3종(히어로·브랜드·순위)의 갭 마커(0070) — 축 위 판정을 고정한다.
//
// 서버는 후보 키만 준다(`gapBuckets`). 축은 `trendAxis` 가 화면에서 만들고, 마커를
// 찍을지는 여기서 정한다. 잘못 찍으면 **값이 있는 슬롯 위에** "수집되지 않음" 이 뜬다.
import { describe, it, expect } from "vitest";
import {
  brandTrendChart,
  engineKpiSeries,
  favorabilityTrendPoints,
  kpiTrendPoints,
  rankTrendChart,
  trendGapMarkSet,
  typeComboPoints,
} from "./kpi-view";
import { planTrendGaps, rowTrendGap } from "@/lib/viz/trend-gap";

const engineBucket = (bucketStart: string) => ({
  bucketStart,
  engines: [
    { engine: "chatgpt", answers: 100, trackedAnswers: 60, totalMentions: 200, trackedMentions: 80 },
  ],
  measuredDays: 1,
  firstAt: `${bucketStart}T00:00:00.000Z`,
  lastAt: `${bucketStart}T00:00:00.000Z`,
});

describe("trendGapMarkSet", () => {
  const axis = [
    { bucketStart: "2026-08-17", measured: true },
    { bucketStart: "2026-08-24", measured: false },
    { bucketStart: "2026-08-31", measured: true },
  ];

  it("측정이 없는 축 안쪽 슬롯에만 찍는다", () => {
    expect([...trendGapMarkSet(axis, ["2026-08-24"])]).toEqual(["2026-08-24"]);
  });

  it("그 주에 측정이 남아 있으면 안 찍는다", () => {
    const measured = axis.map((a) => ({ ...a, measured: true }));
    expect(trendGapMarkSet(measured, ["2026-08-24"]).size).toBe(0);
  });

  it("후보가 없으면 빈 집합 (0070 미적용·숨김 없음)", () => {
    expect(trendGapMarkSet(axis, undefined).size).toBe(0);
    expect(trendGapMarkSet(axis, []).size).toBe(0);
  });
});

describe("kpiTrendPoints — 히어로 추이", () => {
  const trend = {
    unit: "week" as const,
    engines: ["chatgpt"],
    buckets: [engineBucket("2026-08-17"), engineBucket("2026-08-31")],
    latestBrands: [],
    typeTrend: [],
    latest: [],
    rank: null,
    rankedAnswers: 0,
    mentions: 0,
    windowStartBucket: null,
    windowEndBucket: null,
  };

  it("갭 슬롯은 값 전부 null 이고 gap 마커가 붙는다", () => {
    const pts = kpiTrendPoints({ ...trend, gapBuckets: ["2026-08-24"] }, "exposure");
    const gap = pts.find((p) => p.bucketStart === "2026-08-24")!;
    expect(gap.pct).toBeNull();
    expect(gap.numerator).toBeNull();
    expect(gap.denominator).toBeNull();
    expect(gap.gap).toEqual({ reason: "collection_error" });
  });

  it("gapBuckets 가 없으면 종전 결과와 **완전히 같다** (무변경 증명)", () => {
    const base = kpiTrendPoints(trend, "exposure");
    const same = kpiTrendPoints({ ...trend, gapBuckets: [] }, "exposure");
    expect(same).toEqual(base);
    expect(base.every((p) => p.gap === undefined)).toBe(true);
  });

  it("WoW 는 갭을 건너뛰지 않는다 — 축에서 바로 앞이 결측이면 null (종전 계약 유지)", () => {
    const pts = kpiTrendPoints({ ...trend, gapBuckets: ["2026-08-24"] }, "exposure");
    const after = pts.find((p) => p.bucketStart === "2026-08-31")!;
    expect(after.numeratorWow).toBeNull();
  });
});

describe("brandTrendChart / rankTrendChart", () => {
  const brandBucket = (bucketStart: string) => ({
    bucketStart,
    answers: 100,
    totalMentions: 200,
    measuredDays: 1,
    firstAt: `${bucketStart}T00:00:00.000Z`,
    lastAt: `${bucketStart}T00:00:00.000Z`,
    brands: [
      { brand: "Hyundai", isTracked: true, mentions: 80, answers: 60, exposurePct: 60, sharePct: 40 },
    ],
  });
  const rows = [
    { brand: "Hyundai", isTracked: true, colorIndex: 0 } as never,
  ];

  it("브랜드 라인 — 갭 행은 브랜드 값 전부 null + gap", () => {
    const chart = brandTrendChart(
      rows,
      {
        unit: "week",
        brands: [{ brand: "Hyundai", isTracked: true, mentions: 160 }],
        buckets: [brandBucket("2026-08-17"), brandBucket("2026-08-31")],
        windowStartBucket: null,
        windowEndBucket: null,
        gapBuckets: ["2026-08-24"],
      },
      "exposure",
    );
    const gap = chart.points.find((p) => p.bucketStart === "2026-08-24")!;
    expect(gap["Hyundai"]).toBeNull();
    expect(rowTrendGap(gap)).toEqual({ reason: "collection_error" });
    // 이웃은 값이 그대로 — 갭이 값을 만지지 않는다.
    expect(chart.points.find((p) => p.bucketStart === "2026-08-17")!["Hyundai"]).toBe(60);
  });

  it("순위 라인 — 갭 행은 순위·툴팁 값 전부 null + gap", () => {
    const fpBucket = (bucketStart: string) => ({
      bucketStart,
      measuredDays: 1,
      firstAt: null,
      lastAt: null,
      brands: [{ brand: "Hyundai", isTracked: true, avgPosition: 2, rankedAnswers: 10 }],
    });
    const chart = rankTrendChart(
      {
        unit: "week",
        brands: ["Hyundai"],
        buckets: [fpBucket("2026-08-17"), fpBucket("2026-08-31")] as never,
        latest: [],
        gapBuckets: ["2026-08-24"],
      },
      [{ brand: "Hyundai", isTracked: true, colorIndex: 0 } as never],
    );
    const gap = chart.points.find((p) => p.bucketStart === "2026-08-24")!;
    expect(gap["Hyundai"]).toBeNull();
    expect(rowTrendGap(gap)).toEqual({ reason: "collection_error" });
  });
});

// ── 미배선 생산자 3종 (2026-09-11 전수 감사) ────────────────────────────────
//
// 지문: 언급 화면 "AI 엔진별 노출" 추이가 8/24 자리에서 그냥 끊겨 보였다 —
// 음영·툴팁·이웃 연결이 하나도 없었다. 원인은 차트가 아니라 **생산자**였다:
// `engineKpiSeries`·`favorabilityTrendPoints`·`typeComboPoints` 셋 다 `trendAxis`
// 로 축은 만들면서 `trendGapMarkSet` 을 안 불러 마커를 떨어뜨렸다. 마커가 없으면
// `planTrendGaps` 는 `hasGap:false` 라 차트를 아무리 배선해도 아무것도 안 그린다.
describe("미배선 생산자 — 갭 마커 삽입", () => {
  // 엔진 시계열은 집계가 이미 접어 준 `exposurePct`/`sovPct` 를 읽는다(분자·분모가
  // 아니라) — 히어로 추이 픽스처와 필드가 달라 여기서 따로 만든다.
  const pctBucket = (bucketStart: string) => ({
    ...engineBucket(bucketStart),
    engines: [
      {
        engine: "chatgpt",
        answers: 100, trackedAnswers: 60, totalMentions: 200, trackedMentions: 80,
        exposurePct: 60, sovPct: 40,
        sentSignals: 50, positiveSignals: 30, negativeSignals: 5,
      },
    ],
  });
  const base = {
    unit: "week" as const,
    engines: ["chatgpt"],
    buckets: [pctBucket("2026-08-17"), pctBucket("2026-08-31")],
    latestBrands: [],
    typeTrend: [],
    latest: [],
    rank: null,
    rankedAnswers: 0,
    mentions: 0,
    windowStartBucket: null,
    windowEndBucket: null,
  };
  const gapped = { ...base, gapBuckets: ["2026-08-24"] };

  describe("engineKpiSeries — 엔진별 노출/점유율 추이", () => {
    it("갭 슬롯은 전 엔진 null + gap 마커", () => {
      const s = engineKpiSeries(gapped, "exposure");
      const row = s.points.find((p) => p.bucketStart === "2026-08-24")!;
      expect(row["chatgpt"]).toBeNull();
      expect(rowTrendGap(row)).toEqual({ reason: "collection_error" });
    });

    it("이웃 회차의 값은 그대로 — 갭이 값을 만지지 않는다", () => {
      const s = engineKpiSeries(gapped, "exposure");
      expect(s.points.find((p) => p.bucketStart === "2026-08-17")!["chatgpt"]).toBe(60);
      expect(s.points.find((p) => p.bucketStart === "2026-08-31")!["chatgpt"]).toBe(60);
    });

    it("gapBuckets 가 없으면 종전 결과와 완전히 같다 (무변경 증명)", () => {
      expect(engineKpiSeries({ ...base, gapBuckets: [] }, "exposure")).toEqual(
        engineKpiSeries(base, "exposure"),
      );
      expect(
        engineKpiSeries(base, "exposure").points.every((p) => rowTrendGap(p) === undefined),
      ).toBe(true);
    });

    it("planTrendGaps 가 그 마커로 음영 1 + 보조선 1을 만든다 (차트가 실제로 그릴 수 있다)", () => {
      const s = engineKpiSeries(gapped, "exposure");
      const plan = planTrendGaps(s.points, { xKey: "bucketStart", seriesKeys: s.engines });
      expect(plan.hasGap).toBe(true);
      expect(plan.areas).toHaveLength(1);
      expect([plan.areas[0].x1, plan.areas[0].x2]).toEqual(["2026-08-17", "2026-08-31"]);
      expect(plan.bridges.map((b) => b.seriesKey)).toEqual(["chatgpt"]);
    });
  });

  describe("favorabilityTrendPoints — 우호도 추이", () => {
    it("갭 슬롯은 값 전부 null + gap 마커", () => {
      const pts = favorabilityTrendPoints(gapped);
      const p = pts.find((x) => x.bucketStart === "2026-08-24")!;
      expect(p.positivePct).toBeNull();
      expect(p.negativePct).toBeNull();
      expect(p.total).toBeNull();
      expect(p.gap).toEqual({ reason: "collection_error" });
    });

    it("gapBuckets 가 없으면 종전 결과와 완전히 같다", () => {
      expect(favorabilityTrendPoints({ ...base, gapBuckets: [] })).toEqual(
        favorabilityTrendPoints(base),
      );
      expect(favorabilityTrendPoints(base).every((p) => p.gap === undefined)).toBe(true);
    });
  });

  describe("typeComboPoints — 유형별 콤보", () => {
    it("갭 슬롯에 마커가 실려 온다 (히어로 추이의 마커를 떨어뜨리지 않는다)", () => {
      const pts = typeComboPoints(gapped);
      const p = pts.find((x) => x.bucketStart === "2026-08-24")!;
      expect(p.answers).toBeNull();
      expect(p.exposurePct).toBeNull();
      expect(Object.values(p.byType).every((v) => v === null)).toBe(true);
      expect(p.gap).toEqual({ reason: "collection_error" });
    });

    it("gapBuckets 가 없으면 종전 결과와 완전히 같다", () => {
      expect(typeComboPoints({ ...base, gapBuckets: [] })).toEqual(typeComboPoints(base));
      expect(typeComboPoints(base).every((p) => p.gap === undefined)).toBe(true);
    });
  });
});
