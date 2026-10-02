import { describe, it, expect } from "vitest";
import {
  engineKpiSeries,
  engineSeriesUsesSlots,
  engineTrendSeriesAvailable,
  heroTrendAvailable,
  kpiTrendPoints,
} from "./kpi-view";
import type {
  EngineKpiTrend,
  StandardTrendBucket,
} from "@/lib/db/repositories/scope-aggregates";

// ════════════════════════════════════════════════════════════════════════════
// 추이 가용성 = 그리는 원천의 가용성 (2026-09-29 운영 회귀 수리)
// ════════════════════════════════════════════════════════════════════════════
//
// 증상: 운영 언급 화면 "AI 노출률" 히어로 추이가 매 요청 "시간 안에 끝나지 않아 표시하지
// 않습니다". 원인: 미러 추이 단계가 30 s 공유 마감에 걸려 `trendDegraded: true` 가 되는데,
// 격자 on 에서 히어로 점은 미러 버킷이 아니라 `overviewSlots` 에서 온다. 그리는 데 필요한
// 값이 다 있는데 미러 표식이 패널을 막았다.
//
// 이 파일이 고정하는 것:
//   ① `overviewSlots` 가 있으면 미러 degrade 와 무관하게 히어로를 그린다.
//   ② 그때 점은 degrade 여부와 **같은 값**이다(값 불변).
//   ③ `overviewSlots` 가 없으면 종전 판정 그대로(degrade = 표시 불가).
//   ④ 엔진 라인은 사실표 경로(`engineSeriesUsesSlots`)일 때만 degrade 를 무시한다.

const eng = (engine: string, tracked: number, answers: number) => ({
  engine,
  answers,
  trackedAnswers: tracked,
  totalMentions: answers,
  trackedMentions: tracked,
  sentSignals: 0,
  positiveSignals: 0,
  negativeSignals: 0,
});

const slot = (
  bucketStart: string,
  trackedAnswers: number,
  answers: number,
  over: Partial<StandardTrendBucket> = {},
): StandardTrendBucket =>
  ({
    bucketStart,
    roundDate: bucketStart,
    answers,
    trackedAnswers,
    totalMentions: answers,
    trackedMentions: trackedAnswers,
    sentMentions: 0,
    positiveMentions: 0,
    avgPosition: null,
    totalCitations: 0,
    ownedCitations: 0,
    measuredDays: 1,
    firstAt: `${bucketStart}T00:00:00.000Z`,
    lastAt: `${bucketStart}T00:00:00.000Z`,
    ...over,
  }) as unknown as StandardTrendBucket;

/** 미러 추이 단계가 마감에 걸린 모양: 스냅샷은 살아 있고 버킷은 비어 있다. */
const degradedMirror = {
  unit: "week",
  engines: [],
  buckets: [],
  latest: [],
  latestBrands: [],
  typeTrend: [],
  latestMeasuredAt: null,
  trendDegraded: true,
  windowStartBucket: null,
  windowEndBucket: null,
};

const SLOTS = [slot("2026-09-14", 30, 40), slot("2026-09-21", 33, 40)];

const withSlots = (
  slots: StandardTrendBucket[] | undefined,
  trendDegraded: boolean,
): EngineKpiTrend =>
  ({
    ...degradedMirror,
    trendDegraded,
    ...(slots ? { overviewSlots: slots } : {}),
  }) as unknown as EngineKpiTrend;

describe("heroTrendAvailable", () => {
  it("① 사실표 배열이 있으면 미러 추이가 degrade 돼도 그린다", () => {
    expect(heroTrendAvailable(withSlots(SLOTS, true))).toBe(true);
  });

  it("② 그때 점은 degrade 여부와 같은 값이다(값 불변)", () => {
    for (const metric of ["exposure", "sov"] as const) {
      const degraded = kpiTrendPoints(withSlots(SLOTS, true), metric);
      const healthy = kpiTrendPoints(withSlots(SLOTS, false), metric);
      expect(degraded).toEqual(healthy);
      expect(degraded.map((p) => p.pct)).toEqual([75, 82.5]);
    }
  });

  it("③ 사실표 배열이 없으면 종전 판정 그대로", () => {
    expect(heroTrendAvailable(withSlots(undefined, true))).toBe(false);
    expect(heroTrendAvailable(withSlots(undefined, false))).toBe(true);
    expect(heroTrendAvailable(null)).toBe(false);
  });
});

describe("engineTrendSeriesAvailable", () => {
  const withEngines = SLOTS.map((s) =>
    slot(s.bucketStart, s.trackedAnswers, s.answers, {
      engines: [eng("chatgpt", s.trackedAnswers, s.answers)],
    }),
  );

  it("④ 엔진 분해가 자리마다 있으면 degrade 와 무관하게 그리고, 값도 같다", () => {
    expect(engineSeriesUsesSlots(withSlots(withEngines, true))).toBe(true);
    expect(engineTrendSeriesAvailable(withSlots(withEngines, true))).toBe(true);
    expect(engineKpiSeries(withSlots(withEngines, true), "exposure")).toEqual(
      engineKpiSeries(withSlots(withEngines, false), "exposure"),
    );
  });

  it("④ 엔진 분해가 없으면(미러 라인) degrade 는 표시 불가다", () => {
    expect(engineSeriesUsesSlots(withSlots(SLOTS, true))).toBe(false);
    expect(engineTrendSeriesAvailable(withSlots(SLOTS, true))).toBe(false);
    expect(engineTrendSeriesAvailable(withSlots(SLOTS, false))).toBe(true);
    expect(engineTrendSeriesAvailable(null)).toBe(false);
  });
});
