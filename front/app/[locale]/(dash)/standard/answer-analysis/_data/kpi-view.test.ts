import { describe, expect, it } from "vitest";
import type {
  BrandTrendResult,
  EngineKpiTrend,
  StandardSubKpis,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";
import type { MentionsBrandLive, MentionTypesByBrand } from "@/lib/scope/result-adapter";
import { KPI_TAB_SUB_KPI_PARTS } from "@/lib/scope/kpi-tab-budget";
import {
  competitorKpiRows,
  coverageEntries,
  deltaPp,
  engineKpiBars,
  engineKpiSeries,
  fillTrendGaps,
  kpiHero,
  kpiTrendPoints,
  nextBucketKey,
  ownShareDonut,
  hasAnswerOnlyAxes,
  promptCoverage,
  trendAxis,
  brandTrendChart,
  trendCoverage,
  typeKpiBars,
  wowPct,
} from "./kpi-view";

// ── fixtures ──────────────────────────────────────────────────────────────

function engineRow(over: Partial<StandardSubKpis["rows"][number]>) {
  return {
    engine: "chatgpt",
    answers: 0,
    tracked: 0,
    multi: 0,
    top1: 0,
    top3: 0,
    avgPosition: null,
    totalMentions: 0,
    trackedMentions: 0,
    sentMentions: 0,
    positiveMentions: 0,
    negativeMentions: 0,
    citTotal: 0,
    citOwned: 0,
    ...over,
  };
}

const SUB: StandardSubKpis = {
  rows: [
    engineRow({ engine: "chatgpt", answers: 100, tracked: 80, totalMentions: 400, trackedMentions: 100 }),
    engineRow({ engine: "gemini", answers: 100, tracked: 40, totalMentions: 600, trackedMentions: 50 }),
  ],
  promptsWithoutBrand: 3,
  measuredPrompts: 230,
};

function enginePoint(engine: string, over: Partial<EngineKpiTrend["latest"][number]> = {}) {
  return {
    engine,
    answers: 0,
    trackedAnswers: 0,
    exposurePct: null,
    totalMentions: 0,
    trackedMentions: 0,
    sovPct: null,
    ...over,
  };
}

// 2026-07-06 과 2026-07-20 두 회차 — 그 사이 07-13 은 **측정이 없다**(갭).
const ENGINE_TREND: EngineKpiTrend = {
  unit: "week",
  trendDegraded: false,
  windowStartBucket: "2026-07-06",
  windowEndBucket: "2026-07-20",
  engines: ["chatgpt", "gemini"],
  buckets: [
    {
      bucketStart: "2026-07-06",
      measuredDays: 7,
      firstAt: "2026-07-06T00:00:00.000Z",
      lastAt: "2026-07-12T00:00:00.000Z",
      engines: [
        enginePoint("chatgpt", { answers: 50, trackedAnswers: 25, totalMentions: 200, trackedMentions: 40 }),
        enginePoint("gemini", { answers: 50, trackedAnswers: 25, totalMentions: 200, trackedMentions: 60 }),
      ],
    },
    {
      bucketStart: "2026-07-20",
      measuredDays: 3,
      firstAt: "2026-07-20T00:00:00.000Z",
      lastAt: "2026-07-22T00:00:00.000Z",
      engines: [
        enginePoint("chatgpt", { answers: 100, trackedAnswers: 80, totalMentions: 400, trackedMentions: 100 }),
        enginePoint("gemini", { answers: 100, trackedAnswers: 40, totalMentions: 600, trackedMentions: 50 }),
      ],
    },
  ],
  latest: [
    enginePoint("chatgpt", { answers: 100, trackedAnswers: 80, exposurePct: 80, totalMentions: 400, trackedMentions: 100, sovPct: 25 }),
    enginePoint("gemini", { answers: 100, trackedAnswers: 40, exposurePct: 40, totalMentions: 600, trackedMentions: 50, sovPct: 8.3 }),
  ],
  latestMeasuredAt: "2026-07-22T00:00:00.000Z",
};

const BRAND_TREND: BrandTrendResult = {
  unit: "week",
  windowStartBucket: "2026-07-06",
  windowEndBucket: "2026-07-20",
  brands: [
    { brand: "Hyundai", isTracked: true, mentions: 100 },
    { brand: "Kia", isTracked: false, mentions: 60 },
  ],
  buckets: [
    {
      bucketStart: "2026-07-06",
      answers: 100,
      totalMentions: 400,
      measuredDays: 7,
      firstAt: null,
      lastAt: null,
      brands: [
        { brand: "Hyundai", isTracked: true, mentions: 40, answers: 30, exposurePct: 30, sharePct: 10 },
        { brand: "Kia", isTracked: false, mentions: 20, answers: 10, exposurePct: 10, sharePct: 5 },
      ],
    },
    {
      bucketStart: "2026-07-20",
      answers: 200,
      totalMentions: 1000,
      measuredDays: 3,
      firstAt: null,
      lastAt: null,
      brands: [
        { brand: "Hyundai", isTracked: true, mentions: 60, answers: 80, exposurePct: 40, sharePct: 15 },
        // Kia 는 이 회차에 등장하지 않았다 → 집계가 0 으로 내려준다(측정은 있었음).
        { brand: "Kia", isTracked: false, mentions: 0, answers: 0, exposurePct: 0, sharePct: 0 },
      ],
    },
  ],
};

const BRANDS: MentionsBrandLive[] = [
  { brand: "Kia", mentions: 60, prompts: 20, share: 12, mentionRate: 30, avgPosition: 2, isTracked: false },
  { brand: "Hyundai", mentions: 100, prompts: 40, share: 20, mentionRate: 60, avgPosition: 1.5, isTracked: true },
  { brand: "Ghost", mentions: 0, prompts: 0, share: 0, mentionRate: 0, avgPosition: null, isTracked: false },
];

// ── 히어로 ────────────────────────────────────────────────────────────────

describe("kpiHero", () => {
  // 공용 컴포넌트가 metric prop 하나로 갈리는 지점 — 분기가 여기 한 곳에만 있어야
  // 두 탭이 조용히 갈라지지 않는다.
  it("uses answer-level counts for exposure and mention counts for sov", () => {
    expect(kpiHero(SUB, "exposure")).toEqual({ pct: 60, numerator: 120, denominator: 200 });
    expect(kpiHero(SUB, "sov")).toEqual({ pct: 15, numerator: 150, denominator: 1000 });
  });

  // 분모 0 → null. "0%" 로 그리면 측정이 있었는데 노출이 없었다는 뜻이 된다.
  it("returns null (not 0) when there is no denominator", () => {
    const empty: StandardSubKpis = { rows: [], promptsWithoutBrand: null, measuredPrompts: null };
    expect(kpiHero(empty, "exposure").pct).toBeNull();
    expect(kpiHero(null, "sov").pct).toBeNull();
  });
});

// ── 파트 좁히기 동치성 (2026-09-02) ────────────────────────────────────────
//
// 서버는 KPI 탭 히어로에 `KPI_TAB_SUB_KPI_PARTS[metric]` 의 문장만 발행한다
// (히어로 31.0s 의 원인이 "탭과 무관하게 5문장 전부"였다). 계산하지 않은 파트의
// 필드는 **0/null 로 내려온다** — 즉 "측정 없음"과 구분되지 않는다. 그래서 이
// 테스트가 지키는 명제는 하나다:
//
//   좁힌 입력의 kpiHero == 전량 입력의 kpiHero  (metric 별)
//
// kpiHero 가 새 필드를 읽기 시작하면(예: 분모를 sentiment 로) 이 테스트가 먼저
// 깨진다 → 파트 표를 같이 고치라는 신호다. 필드→파트 대응은 집계 jsdoc
// (SUB_KPI_PARTS)의 표를 **독립적으로 다시 적은 것**이라, 둘이 어긋나면 드러난다.
describe("kpiHero — KPI_TAB_SUB_KPI_PARTS 동치성", () => {
  const FIELDS_BY_PART: Record<string, Array<keyof StandardSubKpis["rows"][number]>> = {
    answers: ["answers", "tracked", "multi", "top1", "top3", "avgPosition"],
    mentions: ["totalMentions", "trackedMentions"],
    sentiment: ["sentMentions", "positiveMentions", "negativeMentions"],
    citations: ["citTotal", "citOwned"],
  };

  /** 서버가 그 파트를 안 돌렸을 때 실제로 내려오는 모양(행 필드 0, prompts null). */
  function narrowed(full: StandardSubKpis, parts: readonly string[]): StandardSubKpis {
    const drop = Object.entries(FIELDS_BY_PART)
      .filter(([part]) => !parts.includes(part))
      .flatMap(([, fields]) => fields);
    return {
      rows: full.rows.map((r) => {
        const row = { ...r };
        for (const f of drop) {
          (row as Record<string, unknown>)[f] = f === "avgPosition" ? null : 0;
        }
        return row;
      }),
      promptsWithoutBrand: parts.includes("prompts") ? full.promptsWithoutBrand : null,
      measuredPrompts: parts.includes("prompts") ? full.measuredPrompts : null,
    };
  }

  it.each(["exposure", "sov"] as const)("%s: 좁힌 결과가 전량과 같다", (metric) => {
    const parts = KPI_TAB_SUB_KPI_PARTS[metric];
    expect(kpiHero(narrowed(SUB, parts), metric)).toEqual(kpiHero(SUB, metric));
  });

  // 반증: 파트를 더 좁히면 실제로 깨져야 한다 — 안 깨지면 위 테스트가 아무것도
  // 지키지 않는다는 뜻이다(항진명제 방지).
  it("파트를 하나 더 빼면 값이 달라진다", () => {
    expect(kpiHero(narrowed(SUB, []), "exposure")).not.toEqual(kpiHero(SUB, "exposure"));
    expect(kpiHero(narrowed(SUB, ["answers"]), "sov")).not.toEqual(kpiHero(SUB, "sov"));
  });
});

describe("deltaPp / wowPct", () => {
  it("returns null when either side is missing", () => {
    expect(deltaPp(10, null)).toBeNull();
    expect(deltaPp(null, 10)).toBeNull();
    expect(wowPct(10, null)).toBeNull();
  });
  it("pp is a subtraction, wow is a ratio", () => {
    expect(deltaPp(75.8, 80.2)).toBe(-4.4);
    expect(wowPct(110, 100)).toBe(10);
  });
  // 0 으로 나누면 Infinity 가 화면에 뜬다.
  it("guards a zero previous value for wow", () => {
    expect(wowPct(5, 0)).toBeNull();
  });
});

// ── 추이·갭 ───────────────────────────────────────────────────────────────

describe("nextBucketKey / fillTrendGaps", () => {
  it("steps a week or a day", () => {
    expect(nextBucketKey("2026-07-06", "week")).toBe("2026-07-13");
    expect(nextBucketKey("2026-07-06", "day")).toBe("2026-07-07");
  });

  // 스펙 SHALL: 측정 없는 회차는 갭으로 남긴다. 집계는 측정된 버킷만 주므로
  // 그대로 그리면 결측 구간이 짧아 보이고 선은 매끈하게 이어진다(= 보간).
  it("inserts an explicit gap point for a missing cycle", () => {
    const filled = fillTrendGaps(
      [{ bucketStart: "2026-07-06", v: 1 }, { bucketStart: "2026-07-20", v: 2 }],
      "week",
      (bucketStart) => ({ bucketStart, v: null as number | null }),
    );
    expect(filled.map((p) => p.bucketStart)).toEqual([
      "2026-07-06",
      "2026-07-13",
      "2026-07-20",
    ]);
    expect(filled[1].v).toBeNull();
  });

  it("leaves a single point alone", () => {
    expect(fillTrendGaps([{ bucketStart: "2026-07-06" }], "week", (b) => ({ bucketStart: b })))
      .toHaveLength(1);
  });
});

describe("kpiTrendPoints", () => {
  it("sums engines per bucket and fills the missing cycle with null", () => {
    const pts = kpiTrendPoints(ENGINE_TREND, "exposure");
    expect(pts.map((p) => [p.bucketStart, p.pct])).toEqual([
      ["2026-07-06", 50],
      ["2026-07-13", null],
      ["2026-07-20", 60],
    ]);
  });

  it("switches numerator/denominator with the metric", () => {
    const pts = kpiTrendPoints(ENGINE_TREND, "sov");
    expect(pts[0]).toMatchObject({ numerator: 100, denominator: 400, pct: 25 });
    expect(pts[2]).toMatchObject({ numerator: 150, denominator: 1000, pct: 15 });
  });

  // 툴팁의 WoW 는 **축에서 바로 앞 버킷** 대비 — 갭이 끼면 null 이 되어 "비교
  // 불가"가 드러난다. 갭을 건너뛰고 이어 붙이면 2주 변화가 WoW 로 위장된다.
  it("computes WoW against the immediately preceding bucket, gap included", () => {
    const pts = kpiTrendPoints(ENGINE_TREND, "exposure");
    expect(pts[1].numeratorWow).toBeNull(); // 갭 자신
    expect(pts[2].numeratorWow).toBeNull(); // 앞이 갭이라 비교 불가
  });

  it("computes WoW normally when consecutive cycles are measured", () => {
    const consecutive: EngineKpiTrend = {
      ...ENGINE_TREND,
      windowStartBucket: "2026-07-06",
      windowEndBucket: "2026-07-13",
      buckets: [
        ENGINE_TREND.buckets[0],
        { ...ENGINE_TREND.buckets[1], bucketStart: "2026-07-13" },
      ],
    };
    const pts = kpiTrendPoints(consecutive, "exposure");
    expect(pts).toHaveLength(2);
    expect(pts[1].numeratorWow).toBe(140); // 50 → 120
  });

  it("returns an empty series when the aggregate degraded to null", () => {
    expect(kpiTrendPoints(null, "exposure")).toEqual([]);
  });
});

describe("coverageEntries", () => {
  // 커버리지 라벨은 **측정이 있었던** 회차만 — 채워 넣은 갭 점이 "0일 측정"으로
  // 라벨에 새면 결측이 측정처럼 보인다.
  it("skips the filled gap buckets", () => {
    expect(coverageEntries(kpiTrendPoints(ENGINE_TREND, "exposure"))).toEqual([
      { bucketStart: "2026-07-06", measuredDays: 7 },
      { bucketStart: "2026-07-20", measuredDays: 3 },
    ]);
  });
});

// ── 경쟁사 테이블 ─────────────────────────────────────────────────────────

describe("competitorKpiRows", () => {
  it("puts tracked brands first, then others by value", () => {
    const rows = competitorKpiRows({ brands: BRANDS, trend: BRAND_TREND, metric: "exposure", ownPct: 60 });
    expect(rows.map((r) => r.brand)).toEqual(["Hyundai", "Kia", "Ghost"]);
  });

  it("takes the value column from the snapshot, per metric", () => {
    const exp = competitorKpiRows({ brands: BRANDS, trend: BRAND_TREND, metric: "exposure", ownPct: 60 });
    expect(exp.find((r) => r.brand === "Kia")?.pct).toBe(30); // mentionRate
    const sov = competitorKpiRows({ brands: BRANDS, trend: BRAND_TREND, metric: "sov", ownPct: 15 });
    expect(sov.find((r) => r.brand === "Kia")?.pct).toBe(12); // share
  });

  // 언급 0건 브랜드는 0% 가 아니라 "측정 없음"(null) — 스펙의 null 전파 규약.
  it("reports null (not 0%) for a brand with no mentions", () => {
    const rows = competitorKpiRows({ brands: BRANDS, trend: BRAND_TREND, metric: "exposure", ownPct: 60 });
    expect(rows.find((r) => r.brand === "Ghost")?.pct).toBeNull();
  });

  // 픽스처의 두 버킷은 07-06 / 07-20 — 사이의 07-13 은 측정이 없다. 스파크라인은
  // 히어로 추이와 **같은 축**을 써야 하므로 그 자리에 null 이 들어간다.
  it("carries the sparkline on the gap-filled axis, not just measured buckets", () => {
    const rows = competitorKpiRows({ brands: BRANDS, trend: BRAND_TREND, metric: "exposure", ownPct: 60 });
    expect(rows.find((r) => r.brand === "Hyundai")?.spark).toEqual([30, null, 40]);
  });

  // 축에서 바로 앞이 갭이면 "직전 회차 대비"는 성립하지 않는다.
  it("returns a null WoW when the preceding axis slot is a gap", () => {
    const rows = competitorKpiRows({ brands: BRANDS, trend: BRAND_TREND, metric: "exposure", ownPct: 60 });
    expect(rows.find((r) => r.brand === "Hyundai")?.wowPp).toBeNull();
  });

  // 당사 행의 Gap 은 자기 자신과의 차 → 표에서 "—".
  it("leaves the gap empty for tracked rows and fills it for competitors", () => {
    const rows = competitorKpiRows({ brands: BRANDS, trend: BRAND_TREND, metric: "exposure", ownPct: 60 });
    expect(rows.find((r) => r.brand === "Hyundai")?.gapPp).toBeNull();
    expect(rows.find((r) => r.brand === "Kia")?.gapPp).toBe(-30);
  });

  it("keeps tracked brands even past the cap", () => {
    const rows = competitorKpiRows({
      brands: BRANDS,
      trend: BRAND_TREND,
      metric: "exposure",
      ownPct: 60,
      limit: 1,
    });
    expect(rows.map((r) => r.brand)).toEqual(["Hyundai"]);
  });

  it("survives a degraded trend aggregate (no sparkline, no WoW)", () => {
    const rows = competitorKpiRows({ brands: BRANDS, trend: null, metric: "exposure", ownPct: 60 });
    expect(rows[0].spark).toEqual([]);
    expect(rows[0].wowPp).toBeNull();
    expect(rows[0].pct).toBe(60);
  });
});

describe("ownShareDonut", () => {
  it("splits into own and the remainder", () => {
    expect(ownShareDonut(75.8)).toEqual({ own: 75.8, rest: 24.2 });
  });
  it("returns null when there is no value (no donut, not an empty one)", () => {
    expect(ownShareDonut(null)).toBeNull();
  });
});

// ── 엔진 섹션 ─────────────────────────────────────────────────────────────

describe("engineKpiBars / engineKpiSeries", () => {
  // 좌측 바는 **최신 스칼라**(스냅샷 창) — 마지막 버킷이 아니다.
  it("reads the bars from the snapshot scalars", () => {
    expect(engineKpiBars(ENGINE_TREND, "exposure")).toEqual([
      { engine: "chatgpt", pct: 80, numerator: 80, denominator: 100 },
      { engine: "gemini", pct: 40, numerator: 40, denominator: 100 },
    ]);
    expect(engineKpiBars(ENGINE_TREND, "sov")[0].pct).toBe(25);
  });

  it("emits one key per engine per bucket, with null in the gap", () => {
    const { engines, points } = engineKpiSeries(ENGINE_TREND, "exposure");
    expect(engines).toEqual(["chatgpt", "gemini"]);
    expect(points.map((p) => p.bucketStart)).toEqual([
      "2026-07-06",
      "2026-07-13",
      "2026-07-20",
    ]);
    expect(points[1].chatgpt).toBeNull();
    expect(points[1].gemini).toBeNull();
  });

  it("degrades to empty when the aggregate is null", () => {
    expect(engineKpiBars(null, "sov")).toEqual([]);
    expect(engineKpiSeries(null, "sov")).toEqual({ engines: [], points: [] });
  });
});

// ── 유형 섹션 ─────────────────────────────────────────────────────────────

const TYPE_KPI: TypeKpi = {
  totalAnswers: 200,
  totalMentions: 300,
  ownMentions: 100,
  rows: [
    { type: "mention", ownMentions: 60, otherMentions: 120, totalMentions: 180, ownAnswers: 100, otherAnswers: 150, ownExposurePct: 50, otherExposurePct: 75, ownSharePct: 33.3 },
    { type: "recommendation", ownMentions: 40, otherMentions: 80, totalMentions: 120, ownAnswers: 40, otherAnswers: 60, ownExposurePct: 20, otherExposurePct: 30, ownSharePct: 33.3 },
    { type: "comparison", ownMentions: 0, otherMentions: 0, totalMentions: 0, ownAnswers: 0, otherAnswers: 0, ownExposurePct: 0, otherExposurePct: 0, ownSharePct: null },
    { type: "definition", ownMentions: 0, otherMentions: 0, totalMentions: 0, ownAnswers: 0, otherAnswers: 0, ownExposurePct: 0, otherExposurePct: 0, ownSharePct: null },
    { type: "final_choice", ownMentions: 0, otherMentions: 0, totalMentions: 0, ownAnswers: 0, otherAnswers: 0, ownExposurePct: 0, otherExposurePct: 0, ownSharePct: null },
  ],
  sentimentMatrix: { own: [], all: [] },
};

// 브랜드별 유형 신호 — 유형 스택의 원천. totals 는 캡 이전 전량이라
// `기타 = totals − 당사 − 선택 경쟁사` 가 정확하다.
const TYPES_BY_BRAND: MentionTypesByBrand = {
  totals: { mention: 180, recommendation: 120, comparison: 0, definition: 0, final_choice: 0 },
  brands: [
    {
      brand: "Hyundai", isTracked: true,
      types: { mention: 40, recommendation: 30, comparison: 0, definition: 0, final_choice: 0 },
    },
    {
      brand: "Kia", isTracked: true,
      types: { mention: 20, recommendation: 10, comparison: 0, definition: 0, final_choice: 0 },
    },
    {
      brand: "BMW", isTracked: false,
      types: { mention: 45, recommendation: 20, comparison: 0, definition: 0, final_choice: 0 },
    },
    {
      brand: "Toyota", isTracked: false,
      types: { mention: 75, recommendation: 60, comparison: 0, definition: 0, final_choice: 0 },
    },
  ],
};

const bars = (over: Partial<Parameters<typeof typeKpiBars>[0]> = {}) =>
  typeKpiBars({
    kpi: TYPE_KPI, typesByBrand: TYPES_BY_BRAND, metric: "sov", scope: "own",
    competitor: null, ...over,
  });

describe("typeKpiBars", () => {
  // 스펙 시나리오 "유형별 토글": 자사만은 단일 값, 타사 포함은 100% 구성비.
  it("exposure — ours only keeps the all-answers denominator", () => {
    const own = bars({ metric: "exposure", scope: "own" });
    expect(own[0]).toMatchObject({
      type: "mention", ownPct: 50, competitorPct: null, otherPct: null,
    });
  });

  it("sov — ours only is composition across our types", () => {
    const own = bars({ metric: "sov", scope: "own" });
    // 60 / 100 (당사 유형 신호 합)
    expect(own[0].ownPct).toBe(60);
    expect(own[1].ownPct).toBe(40);
  });

  // ★ 디자인 327:369 — 타사 포함은 `당사 · 선택 경쟁사 · 기타` 3분할이다.
  it("splits into ours / the picked competitor / the rest", () => {
    const all = bars({ metric: "sov", scope: "all", competitor: "BMW" });
    // mention: 당사 60/180, BMW 45/180, 기타 75/180
    expect(all[0]).toMatchObject({
      ownPct: 33.3, competitorPct: 25, ownSignals: 60, competitorSignals: 45, otherSignals: 75,
    });
    expect(all[0].otherPct).toBeCloseTo(41.7, 5);
  });

  it("falls back to ours / rest when no competitor is picked", () => {
    const all = bars({ metric: "sov", scope: "all", competitor: null });
    expect(all[0].competitorPct).toBeNull();
    expect(all[0].otherPct).toBeCloseTo(66.7, 5);
  });

  // ⚠️ 이 수는 유형 신호 합이지 언급 수가 아니다 — 필드명이 그렇게 읽히도록
  // ownSignals/otherSignals 다("언급 수" 라벨 금지, 집계 jsdoc 제약).
  it("exposes the type signal sums under signal-named fields", () => {
    expect(bars({ metric: "sov", scope: "own" })[0]).toMatchObject({
      ownSignals: 60,
      otherSignals: 120,
    });
  });

  it("degrades to empty when the aggregate is null", () => {
    expect(bars({ kpi: null })).toEqual([]);
  });

  // typesByBrand 가 없어도(캐시 구버전·집계 degrade) 스택은 정직해야 한다 —
  // 경쟁사 세그먼트만 사라지고 당사/기타 2분할로 100% 를 지킨다.
  it("keeps a 100% composition without the per-brand aggregate", () => {
    const all = typeKpiBars({
      kpi: TYPE_KPI, typesByBrand: null, metric: "exposure", scope: "all", competitor: "BMW",
    });
    expect(all[0].competitorPct).toBeNull();
    expect((all[0].ownPct ?? 0) + (all[0].otherPct ?? 0)).toBeCloseTo(100, 5);
  });
});

// ── 측정 개요 ─────────────────────────────────────────────────────────────

describe("promptCoverage", () => {
  it("subtracts measured from applied", () => {
    expect(promptCoverage(233, 230)).toEqual({
      applied: 233,
      measured: 230,
      unmeasured: 3,
      conditional: false,
    });
  });

  // 한쪽이라도 없으면 뺄셈하지 않는다 — 0 으로 위장하면 "다 측정됐다"로 읽힌다.
  it("keeps unmeasured null when either side is missing", () => {
    expect(promptCoverage(233, null).unmeasured).toBeNull();
    expect(promptCoverage(null, 230).unmeasured).toBeNull();
    expect(promptCoverage(undefined, undefined).unmeasured).toBeNull();
  });

  // 카탈로그와 미러는 다른 테이블이라 동기화 지연으로 측정 > 적용이 될 수 있다.
  it("clamps a negative difference to zero", () => {
    expect(promptCoverage(200, 230).unmeasured).toBe(0);
  });
});

// ── 회귀 — 2026-09-01 독립 검증에서 실측된 반례 그대로 ────────────────────
//
// 아래 픽스처는 검증자가 재현에 쓴 것과 같은 형태다(4회차 창의 3번째가 결측,
// cap 밖 브랜드, 3사 tracked, 노출률 타사 포함). 각 테스트는 "그때 이런 값이
// 나왔다"를 고정해, 같은 결함이 다시 들어오면 값 자체로 드러나게 한다.

// 07-06 / 07-13 / (07-20 결측) / 07-27 — 검증자 F1 재현 픽스처.
const GAPPED_TREND: BrandTrendResult = {
  unit: "week",
  windowStartBucket: "2026-07-06",
  windowEndBucket: "2026-07-27",
  brands: [
    { brand: "Hyundai", isTracked: true, mentions: 300 },
    { brand: "BMW", isTracked: false, mentions: 90 },
  ],
  buckets: [
    {
      bucketStart: "2026-07-06", answers: 100, totalMentions: 400, measuredDays: 7,
      firstAt: null, lastAt: null,
      brands: [
        { brand: "Hyundai", isTracked: true, mentions: 40, answers: 30, exposurePct: 30, sharePct: 10 },
        { brand: "BMW", isTracked: false, mentions: 20, answers: 10, exposurePct: 10, sharePct: 5 },
      ],
    },
    {
      bucketStart: "2026-07-13", answers: 100, totalMentions: 400, measuredDays: 7,
      firstAt: null, lastAt: null,
      brands: [
        { brand: "Hyundai", isTracked: true, mentions: 50, answers: 40, exposurePct: 40, sharePct: 12 },
        { brand: "BMW", isTracked: false, mentions: 30, answers: 20, exposurePct: 20, sharePct: 8 },
      ],
    },
    // 2026-07-20 은 측정 없음 — 집계가 버킷 자체를 안 내려준다.
    {
      bucketStart: "2026-07-27", answers: 200, totalMentions: 1000, measuredDays: 3,
      firstAt: null, lastAt: null,
      brands: [
        { brand: "Hyundai", isTracked: true, mentions: 90, answers: 160, exposurePct: 80, sharePct: 20 },
        { brand: "BMW", isTracked: false, mentions: 40, answers: 120, exposurePct: 60, sharePct: 15 },
      ],
    },
  ],
};

const GAPPED_BRANDS: MentionsBrandLive[] = [
  { brand: "Hyundai", mentions: 300, prompts: 40, share: 20, mentionRate: 80, avgPosition: 1.5, isTracked: true },
  { brand: "Kia", mentions: 120, prompts: 30, share: 10, mentionRate: 50, avgPosition: 2, isTracked: true },
  { brand: "Genesis", mentions: 60, prompts: 20, share: 5, mentionRate: 25, avgPosition: 3, isTracked: true },
  { brand: "BMW", mentions: 90, prompts: 25, share: 8, mentionRate: 60, avgPosition: 2.5, isTracked: false },
  // cap 밖(추이 시리즈에 없음)인데 스냅샷 값은 있다 — F5 의 반례.
  { brand: "Peugeot", mentions: 12, prompts: 5, share: 1.2, mentionRate: 4, avgPosition: 6, isTracked: false },
];

describe("regression F1 — 경쟁사 스파크라인이 결측 회차를 삭제하지 않는다", () => {
  const rows = competitorKpiRows({
    brands: GAPPED_BRANDS, trend: GAPPED_TREND, metric: "exposure", ownPct: 80,
  });
  const bmw = rows.find((r) => r.brand === "BMW")!;

  // 반례: 종전엔 [10,20,60] 3점이라 4회차 창의 결측이 통째로 사라졌고,
  // polyline 이 하나로 이어져 **선이 안 끊겼다**.
  it("keeps the missing cycle as a null slot (was [10,20,60])", () => {
    expect(bmw.spark).toEqual([10, 20, null, 60]);
  });

  // 반례: 종전 wowPp = +40.0pp 는 07-27 vs 07-13(2주 차)인데 열 이름은 "증감",
  // 툴팁은 "직전 회차 대비"였다 — 히어로에서 금지한 위장이 표에서 났다.
  it("does not report a 2-cycle delta as a 1-cycle change (was +40.0pp)", () => {
    expect(bmw.wowPp).toBeNull();
  });

  // 히어로 추이와 같은 축인지 — 두 규약이 한 화면에 공존하지 않는다.
  it("uses the same axis as the hero trend", () => {
    const axis = trendAxis(GAPPED_TREND.buckets, GAPPED_TREND.unit);
    expect(axis.map((a) => a.bucketStart)).toEqual([
      "2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27",
    ]);
    expect(axis.map((a) => a.measured)).toEqual([true, true, false, true]);
    expect(bmw.spark).toHaveLength(axis.length);
  });

  it("reports the gap in the coverage summary", () => {
    expect(trendCoverage(trendAxis(GAPPED_TREND.buckets, GAPPED_TREND.unit))).toEqual({
      cycles: 4, measuredCycles: 3, missingCycles: 1,
    });
  });

  it("still computes WoW when the two last cycles are both measured", () => {
    const consecutive: BrandTrendResult = {
      ...GAPPED_TREND,
      windowEndBucket: "2026-07-13",
      buckets: [GAPPED_TREND.buckets[0], GAPPED_TREND.buckets[1]],
    };
    const r = competitorKpiRows({
      brands: GAPPED_BRANDS, trend: consecutive, metric: "exposure", ownPct: 80,
    }).find((x) => x.brand === "BMW")!;
    expect(r.spark).toEqual([10, 20]);
    expect(r.wowPp).toBe(10);
  });
});

// ── 히어로 우측 다중 브랜드 추이 (디자인 327:550) ─────────────────────────

describe("brandTrendChart", () => {
  const rows = competitorKpiRows({
    brands: GAPPED_BRANDS, trend: GAPPED_TREND, metric: "sov", ownPct: 80,
  });

  it("emits one series per trend brand, ordered and coloured like the table", () => {
    const chart = brandTrendChart(rows, GAPPED_TREND, "sov");
    expect(chart.series.map((s) => s.brand)).toEqual(["Hyundai", "BMW"]);
    // 색 인덱스 = 표의 행 위치. 시리즈 밖 브랜드가 잘려도 당겨지지 않는다.
    expect(chart.series.map((s) => s.colorIndex)).toEqual([
      rows.findIndex((r) => r.brand === "Hyundai"),
      rows.findIndex((r) => r.brand === "BMW"),
    ]);
  });

  it("keeps the missing cycle as null on every series (no interpolation)", () => {
    const chart = brandTrendChart(rows, GAPPED_TREND, "sov");
    const gap = chart.points.find((p) => p.bucketStart === "2026-07-20");
    expect(gap).toBeDefined();
    expect(gap!.Hyundai).toBeNull();
    expect(gap!.BMW).toBeNull();
    // 측정된 회차는 값이 있다 — 갭만 null 이어야 한다.
    const measured = chart.points.find((p) => p.bucketStart === "2026-07-27");
    expect(measured!.Hyundai).toBe(20);
    expect(measured!.BMW).toBe(15);
  });

  it("switches the plotted measure with the metric", () => {
    const exposure = brandTrendChart(rows, GAPPED_TREND, "exposure");
    expect(exposure.points.find((p) => p.bucketStart === "2026-07-27")!.Hyundai).toBe(80);
  });

  it("reports coverage from measured buckets only", () => {
    const chart = brandTrendChart(rows, GAPPED_TREND, "sov");
    expect(chart.coverage.map((c) => c.bucketStart)).toEqual([
      "2026-07-06", "2026-07-13", "2026-07-27",
    ]);
  });

  it("caps the number of lines", () => {
    expect(brandTrendChart(rows, GAPPED_TREND, "sov", { maxSeries: 1 }).series).toHaveLength(1);
  });

  it("degrades to an empty chart when the trend aggregate is missing", () => {
    expect(brandTrendChart(rows, null, "sov")).toEqual({ series: [], points: [], coverage: [] });
  });
});

describe("regression F5 — 시리즈 밖과 측정 없음을 구분한다", () => {
  const rows = competitorKpiRows({
    brands: GAPPED_BRANDS, trend: GAPPED_TREND, metric: "exposure", ownPct: 80,
  });

  // 반례: Peugeot spark = [null,null,null] 이라 화면엔 "—"(측정 없음)이 떴는데
  // 값 열엔 4.0% 가 있었다. 이제 플래그로 구분되고 화면은 "추이 미산출"을 쓴다.
  it("flags a cap-outside brand instead of faking an all-null sparkline", () => {
    const peugeot = rows.find((r) => r.brand === "Peugeot")!;
    expect(peugeot.inTrendSeries).toBe(false);
    expect(peugeot.spark).toEqual([]);
    expect(peugeot.pct).toBe(4); // 측정은 있다
  });

  it("marks series members as in-series", () => {
    expect(rows.find((r) => r.brand === "BMW")!.inTrendSeries).toBe(true);
  });
});

describe("regression F8 — 언급 0 브랜드의 Gap 은 계산하지 않는다", () => {
  // 반례: 값 열은 "—"(null)인데 Gap 열은 0% 로 계산돼 -60.0pp 가 찍혔다.
  it("keeps the gap null when the row has no value", () => {
    const ghost = competitorKpiRows({
      brands: BRANDS, trend: BRAND_TREND, metric: "exposure", ownPct: 60,
    }).find((r) => r.brand === "Ghost")!;
    expect(ghost.pct).toBeNull();
    expect(ghost.gapPp).toBeNull();
  });
});

describe("regression F4 — 타사 포함 스택은 언제나 100% 다", () => {
  // 반례: {ownPct:50, otherPct:75} = 125% 를 스택으로 그리고 컨테이너가
  // overflow-hidden 이라 타사 세그먼트가 잘려 "구성비"처럼 보였다. 원인은
  // own/other 분모가 둘 다 "전체 답변 수" 였던 것 — 분모를 그 유형의 전 브랜드
  // 신호 합으로 바꿔 스택을 복원했다(디자인 327:369 의 `당사 · BMW · 기타`).
  const sum = (b: ReturnType<typeof typeKpiBars>[number]) =>
    (b.ownPct ?? 0) + (b.competitorPct ?? 0) + (b.otherPct ?? 0);

  it.each(["exposure", "sov"] as const)(
    "composes to exactly 100%% on the %s tab (with a competitor picked)",
    (metric) => {
      for (const b of bars({ metric, scope: "all", competitor: "BMW" })) {
        // 신호가 없는 유형(합계 0)은 세그먼트 자체가 없다 — 0% 를 주장하지 않는다.
        if (b.ownPct == null && b.otherPct == null) continue;
        expect(sum(b)).toBeCloseTo(100, 5);
      }
    },
  );

  it.each(["exposure", "sov"] as const)(
    "composes to exactly 100%% on the %s tab (no competitor picked)",
    (metric) => {
      for (const b of bars({ metric, scope: "all", competitor: null })) {
        if (b.ownPct == null && b.otherPct == null) continue;
        expect(sum(b)).toBeCloseTo(100, 5);
      }
    },
  );

  it("leaves an unmeasured type without segments rather than claiming 0%", () => {
    const [, , comparison] = bars({ metric: "sov", scope: "all", competitor: "BMW" });
    expect(comparison.type).toBe("comparison");
    expect(comparison.ownPct).toBeNull();
    expect(comparison.otherPct).toBeNull();
  });
});

describe("regression F2 — 답변 축이 걸리면 미측정을 세지 않는다", () => {
  it("detects answer-only axes", () => {
    expect(hasAnswerOnlyAxes({})).toBe(false);
    // 프롬프트 축(카탈로그)만 걸린 상태는 답변 축이 아니다 — 뺄셈을 계속한다.
    expect(hasAnswerOnlyAxes({ region: [], engine: [] })).toBe(false);
    expect(hasAnswerOnlyAxes({ region: ["KR"] })).toBe(true);
    expect(hasAnswerOnlyAxes({ engine: ["chatgpt"] })).toBe(true);
    expect(hasAnswerOnlyAxes({ dateFrom: "2026-07-01" })).toBe(true);
    expect(hasAnswerOnlyAxes({ dateTo: "2026-08-01" })).toBe(true);
  });

  // 반례: 국가를 고르면 "측정"만 줄어 "미측정"이 부풀려졌다. 이제 뺄셈을 멈춘다.
  it("suppresses the subtraction under an answer-only filter", () => {
    const c = promptCoverage(233, 120, { conditional: true });
    expect(c.unmeasured).toBeNull();
    expect(c.conditional).toBe(true);
    expect(c.measured).toBe(120);
  });
});

describe("regression F9 — 갭 예산은 갭마다 따로 준다", () => {
  // 반례: 전역 카운터라 앞쪽 큰 갭이 예산을 소진하면 뒤쪽 갭이 조용히 안 채워졌다.
  // 앞 갭이 **전역 예산을 넘길 만큼** 커야 반례가 성립한다 — 2016→2026 ≈ 548주.
  // (종전 픽스처는 2020 시작 ≈ 339주라 400 상한에 안 걸려 뮤테이션이 생존했다.)
  it("fills a later gap even after an earlier one larger than the whole budget", () => {
    const points = [
      { bucketStart: "2016-01-04" }, // 앞쪽 ~548주 갭 (전역 400 예산을 초과)
      { bucketStart: "2026-07-06" },
      { bucketStart: "2026-07-20" }, // 뒤쪽 1주 갭 — 반드시 채워져야 한다
    ];
    const filled = fillTrendGaps(points, "week", (bucketStart) => ({ bucketStart }));
    expect(filled.map((p) => p.bucketStart)).toContain("2026-07-13");
    expect(filled[filled.length - 1].bucketStart).toBe("2026-07-20");
  });

  // 갭 하나가 축을 통째로 삼키지 않도록 갭당 상한이 따로 있다.
  it("caps a single hole so one huge gap cannot flood the axis", () => {
    const filled = fillTrendGaps(
      [{ bucketStart: "2016-01-04" }, { bucketStart: "2026-07-06" }],
      "week",
      (bucketStart) => ({ bucketStart }),
    );
    // 앵커 2 + 갭당 상한 200.
    expect(filled).toHaveLength(202);
  });
});


// ── 회귀 C3 (2026-09-01 재검증) — 축이 창 경계까지 간다 ─────────────────────
//
// 반례: `fillTrendGaps` 는 측정된 버킷 **사이만** 채우므로 축이 첫/마지막 측정에
// 갇혔다. 첫 회차 결측·마지막 회차 결측 케이스에서 축이 3회차로 줄고 커버리지가
// `missingCycles: 0` — "미측정 0"이라고 **적극적으로 거짓 주장**했다. 특히
// 최신 회차 결측 = 측정이 멈춤은 운영 지면이 반드시 드러내야 할 신호다.

describe("regression C3 — trendAxis 는 창 경계까지 축을 세운다", () => {
  const measured = [{ bucketStart: "2026-07-13" }, { bucketStart: "2026-07-20" }];

  it("extends the axis backwards to the window start (leading gap)", () => {
    const axis = trendAxis(measured, "week", {
      windowStartBucket: "2026-07-06",
      windowEndBucket: "2026-07-20",
    });
    expect(axis.map((a) => a.bucketStart)).toEqual([
      "2026-07-06", "2026-07-13", "2026-07-20",
    ]);
    expect(axis[0].measured).toBe(false);
    expect(trendCoverage(axis).missingCycles).toBe(1);
  });

  // 최신 회차 결측 — 측정이 멈춘 신호. 축이 여기서 잘리면 화면이 침묵한다.
  it("extends the axis forwards to the window end (trailing gap)", () => {
    const axis = trendAxis(measured, "week", {
      windowStartBucket: "2026-07-13",
      windowEndBucket: "2026-08-03",
    });
    expect(axis.map((a) => a.bucketStart)).toEqual([
      "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03",
    ]);
    expect(axis.map((a) => a.measured)).toEqual([true, true, false, false]);
    expect(trendCoverage(axis)).toEqual({
      cycles: 4, measuredCycles: 2, missingCycles: 2,
    });
  });

  it("never marks a window anchor as measured", () => {
    const axis = trendAxis([], "week", {
      windowStartBucket: "2026-07-06",
      windowEndBucket: "2026-07-20",
    });
    expect(axis.every((a) => !a.measured)).toBe(true);
    expect(trendCoverage(axis)).toEqual({ cycles: 3, measuredCycles: 0, missingCycles: 3 });
  });

  it("keeps the old behaviour when no bounds are supplied (stale cache entries)", () => {
    expect(trendAxis(measured, "week").map((a) => a.bucketStart)).toEqual([
      "2026-07-13", "2026-07-20",
    ]);
  });

  it("does not duplicate a bound that coincides with a measured bucket", () => {
    const axis = trendAxis(measured, "week", {
      windowStartBucket: "2026-07-13",
      windowEndBucket: "2026-07-20",
    });
    expect(axis).toEqual([
      { bucketStart: "2026-07-13", measured: true },
      { bucketStart: "2026-07-20", measured: true },
    ]);
  });

  // 시리즈가 통째로 비면 원인은 "cap 밖"이 아니라 "측정 없음"이다.
  it("treats an empty trend series as unknown, not as cap-excluded", () => {
    const empty: BrandTrendResult = {
      unit: "week", brands: [], buckets: [],
      windowStartBucket: "2026-07-06", windowEndBucket: "2026-07-20",
    };
    const rows = competitorKpiRows({
      brands: BRANDS, trend: empty, metric: "exposure", ownPct: 60,
    });
    expect(rows.every((r) => r.inTrendSeries)).toBe(true);
    expect(rows[0].spark).toEqual([null, null, null]);
  });

  it("carries the window bounds into the hero trend axis too", () => {
    const trailing: EngineKpiTrend = {
      ...ENGINE_TREND,
      windowEndBucket: "2026-08-03",
    };
    const pts = kpiTrendPoints(trailing, "exposure");
    expect(pts.map((p) => p.bucketStart)).toEqual([
      "2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03",
    ]);
    expect(pts[4].pct).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PR ③ (2026-09-02) — 우호도 · 우선 노출도 뷰모델
// ═══════════════════════════════════════════════════════════════════════════
import type { FirstPositionResult } from "@/lib/db/repositories/scope-aggregates";
import {
  favorabilityHero,
  favorabilityTrendPoints,
  firstRankCompetitorCards,
  firstRankHero,
  ownPositionSeries,
  rankLadder,
  rankTableRows,
  rankTrendChart,
  sentimentSegments,
  stanceSegments,
  stancePairs,
  typeSentimentRows,
} from "./kpi-view";

describe("favorabilityHero — Sub KPI sentiment 파트 합", () => {
  it("sums engines and divides by total signals; null when no signals", () => {
    const sub: StandardSubKpis = {
      rows: [
        engineRow({ engine: "chatgpt", sentMentions: 100, positiveMentions: 60, negativeMentions: 10 }),
        engineRow({ engine: "gemini", sentMentions: 100, positiveMentions: 40, negativeMentions: 30 }),
      ],
      promptsWithoutBrand: null,
      measuredPrompts: null,
    };
    expect(favorabilityHero(sub)).toEqual({ positivePct: 50, negativePct: 20, positive: 100, negative: 40, total: 200 });
    expect(favorabilityHero(null).positivePct).toBeNull();
    expect(favorabilityHero({ rows: [engineRow({})], promptsWithoutBrand: null, measuredPrompts: null }).negativePct).toBeNull();
  });

  // 서버가 이 탭에 발행하는 파트가 히어로가 읽는 필드를 덮는가 — kpiHero 와 같은 규약.
  it("reads only fields the favorability part table promises", () => {
    expect(KPI_TAB_SUB_KPI_PARTS.favorability).toContain("sentiment");
  });
});

describe("favorabilityTrendPoints — 갭 유지 · WoW 는 바로 앞 버킷", () => {
  const trend: EngineKpiTrend = {
    unit: "week",
    trendDegraded: false,
    windowStartBucket: "2026-07-06",
    windowEndBucket: "2026-07-27",
    engines: ["chatgpt"],
    latest: [],
    latestMeasuredAt: null,
    buckets: [
      { bucketStart: "2026-07-06", measuredDays: 7, firstAt: null, lastAt: null,
        engines: [{ engine: "chatgpt", answers: 10, trackedAnswers: 5, exposurePct: 50, totalMentions: 10, trackedMentions: 5, sovPct: 50, sentSignals: 100, positiveSignals: 50, negativeSignals: 10 }] },
      // 07-13 결측
      { bucketStart: "2026-07-20", measuredDays: 3, firstAt: null, lastAt: null,
        engines: [{ engine: "chatgpt", answers: 10, trackedAnswers: 5, exposurePct: 50, totalMentions: 10, trackedMentions: 5, sovPct: 50, sentSignals: 200, positiveSignals: 120, negativeSignals: 20 }] },
    ],
  };
  it("fills the missing cycle with nulls and computes WoW only across adjacent measured cycles", () => {
    const pts = favorabilityTrendPoints(trend);
    expect(pts.map((p) => p.bucketStart)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]);
    expect(pts[0].positivePct).toBe(50);
    expect(pts[0].negativePct).toBe(10);
    expect(pts[1].positivePct).toBeNull();
    expect(pts[2].positivePct).toBe(60);
    // 앞 칸(07-13)이 결측이라 WoW 는 null — 2주 변화를 WoW 로 위장하지 않는다.
    expect(pts[2].positiveWow).toBeNull();
    expect(pts[3].total).toBeNull();
  });
  it("treats legacy cache cells without sentiment fields as zero signals (null pct), not a crash", () => {
    const legacy = {
      ...trend,
      buckets: [{ ...trend.buckets[0], engines: [{ engine: "chatgpt", answers: 1, trackedAnswers: 1, exposurePct: 100, totalMentions: 1, trackedMentions: 1, sovPct: 100 } as EngineKpiTrend["latest"][number]] }],
    };
    expect(favorabilityTrendPoints(legacy)[0].positivePct).toBeNull();
  });
});

// ── 답변 축 스탠스 (0072 · WU8 AC3) ─────────────────────────────────────────
// 이 describe 가 고정하는 명제: **4계열 합 = (답변 × 브랜드) 쌍 수**.
// 발생 축(sentimentSegments)의 합은 언급 발생 수라 같은 회차에서도 값이 다르다 —
// 두 카드를 나란히 놓는 이상, 합이 무엇을 세는지가 축마다 달라야 한다.
describe("stanceSegments — 답변 축", () => {
  it("계열 순서·구성비가 발생 축과 같은 규약이고, 합이 pairs 와 일치한다", () => {
    const dist = { positive: 40, neutral: 5, mixed: 30, negative: 25, pairs: 100 };
    const segs = stanceSegments(dist);
    expect(segs.map((s) => s.key)).toEqual(["positive", "neutral", "mixed", "negative"]);
    expect(segs.map((s) => s.pct)).toEqual([40, 5, 30, 25]);
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(dist.pairs);
    expect(stancePairs(dist)).toBe(100);
  });

  it("축이 없으면(null) 빈 배열 — pairs 도 null(‘0건’과 구분된다)", () => {
    expect(stanceSegments(null)).toEqual([]);
    expect(stancePairs(null)).toBeNull();
  });

  it("축은 있는데 행이 0 이면 구성비는 null 이고 pairs 는 0", () => {
    const empty = { positive: 0, neutral: 0, mixed: 0, negative: 0, pairs: 0 };
    expect(stanceSegments(empty).every((s) => s.pct === null)).toBe(true);
    expect(stancePairs(empty)).toBe(0);
  });

  it("발생 축 합과 답변 축 합은 서로 다른 모수다 — 섞어 쓰지 않는다", () => {
    // 같은 회차: 발생 신호 240개 · 답변×브랜드 쌍 100개. 어느 쪽 합도 상대의 분모가 아니다.
    const occ = sentimentSegments({ positive: 120, neutral: 60, mixed: 30, negative: 30 });
    const ans = stanceSegments({ positive: 40, neutral: 5, mixed: 30, negative: 25, pairs: 100 });
    expect(occ.reduce((n, s) => n + s.count, 0)).toBe(240);
    expect(ans.reduce((n, s) => n + s.count, 0)).toBe(100);
  });
});

describe("sentimentSegments / typeSentimentRows", () => {
  it("orders positive·neutral·mixed·negative and shares sum to ~100", () => {
    const segs = sentimentSegments({ positive: 50, neutral: 30, mixed: 10, negative: 10 });
    expect(segs.map((s) => s.key)).toEqual(["positive", "neutral", "mixed", "negative"]);
    expect(segs.map((s) => s.pct)).toEqual([50, 30, 10, 10]);
    expect(sentimentSegments(null)).toEqual([]);
    expect(sentimentSegments({ positive: 0, neutral: 0, mixed: 0, negative: 0 })[0].pct).toBeNull();
  });
  it("prepends an 'all' row that sums the five types and exposes positive share", () => {
    const kpi: TypeKpi = {
      totalAnswers: 0, totalMentions: 0, ownMentions: 0, rows: [],
      sentimentMatrix: {
        own: [
          { type: "mention", rows: 0, positive: 8, neutral: 1, negative: 1, mixed: 0 },
          { type: "recommendation", rows: 0, positive: 2, neutral: 0, negative: 2, mixed: 0 },
        ],
        all: [],
      },
    };
    const rows = typeSentimentRows(kpi, "own");
    expect(rows[0].type).toBe("all");
    expect(rows[0].total).toBe(14);
    expect(rows[0].positivePct).toBe(71.4);
    expect(rows[1].positivePct).toBe(80);
    expect(rows[2].positivePct).toBe(50);
    expect(typeSentimentRows(kpi, "all")).toEqual([]);
    expect(typeSentimentRows(null)).toEqual([]);
  });
});

const FP: FirstPositionResult = {
  unit: "week",
  brands: ["Hyundai", "Kia", "Tesla", "BMW"],
  buckets: [
    { bucketStart: "2026-07-06", measuredDays: 7, firstAt: null, lastAt: null, brands: [
      { brand: "Hyundai", isTracked: true, avgPosition: 4, rankedAnswers: 10 },
      { brand: "Kia", isTracked: true, avgPosition: 6, rankedAnswers: 10 },
      { brand: "Tesla", isTracked: false, avgPosition: 2, rankedAnswers: 5 },
      { brand: "BMW", isTracked: false, avgPosition: null, rankedAnswers: 0 },
    ] },
    // 07-13 결측
    { bucketStart: "2026-07-20", measuredDays: 5, firstAt: null, lastAt: null, brands: [
      { brand: "Hyundai", isTracked: true, avgPosition: 3, rankedAnswers: 30 },
      { brand: "Kia", isTracked: true, avgPosition: 5, rankedAnswers: 10 },
      { brand: "Tesla", isTracked: false, avgPosition: 2.5, rankedAnswers: 5 },
      { brand: "BMW", isTracked: false, avgPosition: 9, rankedAnswers: 1 },
    ] },
  ],
  latest: [
    { brand: "Tesla", isTracked: false, avgPosition: 2.5, rank: 1, rankedAnswers: 5, mentions: 5 },
    { brand: "Hyundai", isTracked: true, avgPosition: 3, rank: 2, rankedAnswers: 30, mentions: 40 },
    { brand: "Kia", isTracked: true, avgPosition: 5, rank: 3, rankedAnswers: 10, mentions: 12 },
    { brand: "BMW", isTracked: false, avgPosition: null, rank: null, rankedAnswers: 0, mentions: 0 },
  ],
};

describe("firstRankHero — 당사 가중 평균 · Δ 는 회차 마지막 두 칸", () => {
  it("weights tracked brands by ranked answers and takes the best own rank", () => {
    const h = firstRankHero(FP);
    expect(h.avgPosition).toBe(3.5); // (3×30 + 5×10) / 40
    expect(h.rank).toBe(2);
    expect(h.rankedAnswers).toBe(40);
    expect(h.brands).toEqual(["Hyundai", "Kia"]);
  });
  it("leaves Δ null when the cycle right before the last is a gap", () => {
    // 축 = 07-06 · 07-13(결측) · 07-20 → 마지막 두 칸 = (07-13 null, 07-20 3.5) → null
    expect(ownPositionSeries(FP)).toEqual([5, null, 3.5]);
    expect(firstRankHero(FP).delta).toBeNull();
  });
  it("computes Δ in rank units (negative = improved) across adjacent measured cycles", () => {
    const contiguous: FirstPositionResult = {
      ...FP,
      buckets: [FP.buckets[0], { ...FP.buckets[1], bucketStart: "2026-07-13" }],
    };
    expect(firstRankHero(contiguous).delta).toBe(-1.5); // 5 → 3.5
  });
  it("returns nulls (not zeros) for a missing aggregate", () => {
    expect(firstRankHero(null)).toEqual({ avgPosition: null, rank: null, rankedAnswers: 0, delta: null, brands: [] });
  });
});

describe("rankTableRows / cards / chart / ladder", () => {
  it("keeps the aggregate's rank order, sparks over the last cycles with gaps, and never turns no-data into 0", () => {
    const rows = rankTableRows(FP, { sparkCycles: 4 });
    expect(rows.map((r) => r.brand)).toEqual(["Tesla", "Hyundai", "Kia", "BMW"]);
    // 축 3칸(07-06·07-13 결측·07-20) → 스파크도 3칸, 가운데 null
    expect(rows[1].spark).toEqual([4, null, 3]);
    expect(rows[1].wow).toBeNull(); // 앞 칸 결측
    expect(rows[3].rank).toBeNull();
    expect(rows[3].avgPosition).toBeNull();
    expect(rows[3].spark).toEqual([null, null, 9]);
  });
  it("cards = top competitors with a rank, excluding own brands", () => {
    const cards = firstRankCompetitorCards(rankTableRows(FP));
    expect(cards.map((c) => c.brand)).toEqual(["Tesla"]); // BMW 는 rank null → 제외
  });
  it("chart keeps own brands first, axis with gap, and a y-max from observed positions (min 5)", () => {
    const rows = rankTableRows(FP);
    const chart = rankTrendChart(FP, rows);
    expect(chart.series.map((s) => s.brand)).toEqual(["Hyundai", "Kia", "Tesla", "BMW"]);
    expect(chart.points.map((p) => p.bucketStart)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
    expect(chart.points[1].Hyundai).toBeNull();
    expect(chart.yMax).toBe(9);
    expect(rankTrendChart(null, rows).series).toEqual([]);
  });
  it("ladder places the best observed at 0% and the worst at 100%, skipping unranked brands", () => {
    const marks = rankLadder(rankTableRows(FP));
    expect(marks.map((m) => m.brand)).toEqual(["Tesla", "Hyundai", "Kia"]);
    expect(marks[0].offsetPct).toBe(0);
    expect(marks[2].offsetPct).toBe(100);
    expect(marks[1].offsetPct).toBe(20); // (3−2.5)/(5−2.5)
  });
});
