import { describe, it, expect } from "vitest";
import {
  attachBrandSeries,
  toSeries,
  toStandardTrendBuckets,
  toBrandTrend,
  toFirstPosition,
  pickSeriesBrands,
  rankByPosition,
  bucketsSince,
  windowBounds,
  G_TREND_MAX_SERIES,
  type GlobalTrendSeries,
} from "./summary-global-trend-read";
import type {
  TrendAggregates,
  TrendBrandRow,
  TrendDomainRow,
  TrendOwnRow,
} from "./summary-trend-aggregates";
import type { FirstPositionRow } from "./scope-aggregates";

// 글로벌 추이 3종의 **매핑 규칙**을 고정한다 — PR③.
// 라이브 원장에는 아직 노출 가능한 글로벌 회차가 **1개**뿐이라(2026-09-11 실측),
// "회차 ≥ 2" 시나리오는 여기 픽스처가 유일한 검증 수단이다. 값 대조(겹치는 회차)는
// `scripts/summary/parity-global-trend.ts` 가 라이브 DB 에서 한다.

const A1 = "2026-08-24T00:00:00.000Z";
const A2 = "2026-08-31T00:00:00.000Z";

const own = (p: Partial<TrendOwnRow>): TrendOwnRow => ({
  axis: "cycle", bucket: null, cycleAnchorAt: null, keyRows: 1,
  monitored: 0, trackedAnswers: 0, multiAnswers: 0, top1Answers: 0, top3Answers: 0,
  rankSum: 0, rankedAnswers: 0, ownMentions: 0, ownPositive: 0, ownSignals: 0,
  compMentions: 0, allCitations: 0, ownCitations: 0, ownFallbackCitations: 0,
  tileOwnMentions: 0, citingAnswers: 0, ...p,
});
const brand = (p: Partial<TrendBrandRow>): TrendBrandRow => ({
  axis: "cycle-brand", country: null, engine: null, cycleAnchorAt: null,
  brandName: "X", isRest: false, restCount: 0, keyRows: 1, isTracked: false,
  mentions: 0, answers: 0, rankSum: 0, rankedAnswers: 0,
  compRankSum: 0, compRankedAnswers: 0, top3Answers: 0,
  positive: 0, neutral: 0, negative: 0, mixed: 0, typeMention: 0,
  typeRecommendation: 0, typeComparison: 0, typeDefinition: 0, typeFinalChoice: 0, ...p,
});
const domain = (p: Partial<TrendDomainRow>): TrendDomainRow => ({
  axis: "cycle", isRest: false, restCount: 0, keyRows: 1, groupKey: null, domain: null,
  country: null, cycleAnchorAt: null, citations: 0, citingAnswers: 0,
  ownedCitations: 0, isOurs: false, ...p,
});

/** 회차 2개 · 브랜드 3개(당사 1) 짜리 최소 픽스처. */
const AGG: TrendAggregates = {
  empty: false,
  answers: [],
  own: [
    own({ axis: "total", monitored: 300, compMentions: 100 }),
    // 일부러 **내림차순**으로 넣는다 — `toSeries` 가 anchor 오름차순으로 정렬해야 한다.
    own({
      cycleAnchorAt: A2, monitored: 200, trackedAnswers: 80, ownMentions: 30,
      compMentions: 60, ownPositive: 6, ownSignals: 12, rankSum: 24, rankedAnswers: 10,
    }),
    own({
      cycleAnchorAt: A1, monitored: 100, trackedAnswers: 30, ownMentions: 10,
      compMentions: 40, ownPositive: 2, ownSignals: 8, rankSum: 15, rankedAnswers: 10,
    }),
  ],
  brands: [
    brand({ axis: "brand", brandName: "Hyundai", isTracked: true, mentions: 40, answers: 22 }),
    brand({ axis: "brand", brandName: "Toyota", mentions: 50, answers: 30 }),
    brand({ axis: "brand", brandName: "Tesla", mentions: 10, answers: 5 }),
    // ⚠️ 서수(`rankSum`)와 경쟁 순위(`compRankSum`)를 **일부러 다른 값**으로 둔다 —
    //    한쪽 축만 읽는 결함이 값으로 드러나야 한다(PR④-b F1).
    brand({ cycleAnchorAt: A1, brandName: "Hyundai", isTracked: true, mentions: 10, answers: 6, rankSum: 12, rankedAnswers: 6, compRankSum: 6, compRankedAnswers: 4 }),
    brand({ cycleAnchorAt: A1, brandName: "Toyota", mentions: 30, answers: 18, rankSum: 18, rankedAnswers: 9, compRankSum: 12, compRankedAnswers: 6 }),
    brand({ cycleAnchorAt: A2, brandName: "Hyundai", isTracked: true, mentions: 30, answers: 16, rankSum: 16, rankedAnswers: 8, compRankSum: 15, compRankedAnswers: 10 }),
    brand({ cycleAnchorAt: A2, brandName: "Toyota", mentions: 20, answers: 12, rankSum: 30, rankedAnswers: 10, compRankSum: 26, compRankedAnswers: 8 }),
    brand({ cycleAnchorAt: A2, brandName: "Tesla", mentions: 10, answers: 5 }),
  ],
  domains: [
    domain({ axis: "total", citations: 900, ownedCitations: 90 }),
    domain({ cycleAnchorAt: A1, citations: 300, ownedCitations: 30 }),
    domain({ cycleAnchorAt: A2, citations: 600, ownedCitations: 60 }),
  ],
};

const SERIES: GlobalTrendSeries = toSeries(AGG);

describe("toSeries — 회차 축 조립", () => {
  it("버킷은 anchor **오름차순**이다(입력 순서와 무관)", () => {
    expect(SERIES.buckets.map((b) => b.bucketStart)).toEqual(["2026-08-24", "2026-08-31"]);
  });

  it("도메인 회차 행이 ⑤ 분모·분자를 준다(`trend_own.own_citations` 아님)", () => {
    expect(SERIES.buckets[1].allCitations).toBe(600);
    expect(SERIES.buckets[1].ownedCitations).toBe(60);
  });

  it("`total` 축은 버킷이 되지 않는다(전체 합계가 회차로 섞이면 안 된다)", () => {
    expect(SERIES.buckets).toHaveLength(2);
    expect(SERIES.buckets.some((b) => b.monitored === 300)).toBe(false);
  });

  it("brandTotals 는 `brand` 축에서만 온다", () => {
    expect(SERIES.brandTotals.map((b) => b.brand).sort()).toEqual(["Hyundai", "Tesla", "Toyota"]);
  });
});

describe("toStandardTrendBuckets — 카드 ①~⑤ 시계열", () => {
  const out = toStandardTrendBuckets(SERIES);

  it("②의 분모는 `compMentions`(is_competitor 총언급)다", () => {
    expect(out[1].totalMentions).toBe(60);
    expect(out[1].trackedMentions).toBe(30);
  });

  it("④는 Σ서수/순위있는답변 이고 순위 데이터가 없으면 null", () => {
    expect(out[0].avgPosition).toBe(1.5);
    expect(out[1].avgPosition).toBe(2.4);
    const none = toStandardTrendBuckets(
      toSeries({ ...AGG, own: [own({ cycleAnchorAt: A1, monitored: 5 })] }),
    );
    expect(none[0].avgPosition).toBeNull();
  });

  it("coverage 3필드는 회차 그레인 — measuredDays=1, first/lastAt = anchor", () => {
    expect(out[1].measuredDays).toBe(1);
    expect(out[1].firstAt).toBe(A2);
    expect(out[1].lastAt).toBe(A2);
  });

  it("bucketStart 는 anchor 의 UTC 일이다(화면 버킷 키)", () => {
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-08-24", "2026-08-31"]);
  });
});

describe("pickSeriesBrands — 미러 `capBrandSeries` 와 같은 루프", () => {
  const totals = [
    { brand: "A", isTracked: false, mentions: 100, answers: 0, rankSum: 0, rankedAnswers: 0 },
    { brand: "B", isTracked: false, mentions: 90, answers: 0, rankSum: 0, rankedAnswers: 0 },
    { brand: "Own", isTracked: true, mentions: 5, answers: 0, rankSum: 0, rankedAnswers: 0 },
    { brand: "C", isTracked: false, mentions: 4, answers: 0, rankSum: 0, rankedAnswers: 0 },
  ];

  it("당사는 cap 밖이어도 남는다", () => {
    expect(pickSeriesBrands(totals, 2).map((b) => b.brand)).toEqual(["A", "B", "Own"]);
  });

  it("**당사도 cap 슬롯을 소비한다** — cap=3 이면 C 가 들어오지 못한다", () => {
    // 미러 루프: A(1) B(2) Own(3, isTracked) → C 는 picked.length(3) < 3 이 거짓이라 탈락.
    expect(pickSeriesBrands(totals, 3).map((b) => b.brand)).toEqual(["A", "B", "Own"]);
  });

  it("언급 동률은 이름 오름차순(결정적)", () => {
    const tie = [
      { brand: "Z", isTracked: false, mentions: 7, answers: 0, rankSum: 0, rankedAnswers: 0 },
      { brand: "Y", isTracked: false, mentions: 7, answers: 0, rankSum: 0, rankedAnswers: 0 },
    ];
    expect(pickSeriesBrands(tie, 5).map((b) => b.brand)).toEqual(["Y", "Z"]);
  });

  it("잔여 합계 행(이름 없음)은 시리즈가 될 수 없다", () => {
    const withRest = [
      ...totals,
      { brand: null, isTracked: false, mentions: 999, answers: 0, rankSum: 0, rankedAnswers: 0 },
    ];
    expect(pickSeriesBrands(withRest, 10).every((b) => b.brand !== null)).toBe(true);
  });

  it("하드 상한 50 을 넘지 않는다", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      brand: `B${String(i).padStart(3, "0")}`, isTracked: true,
      mentions: 100 - i, answers: 0, rankSum: 0, rankedAnswers: 0,
    }));
    expect(pickSeriesBrands(many, 10)).toHaveLength(G_TREND_MAX_SERIES);
  });
});

describe("toBrandTrend — 브랜드 라인차트", () => {
  const bt = toBrandTrend(SERIES, { unit: "week", cap: 10 });

  it("시리즈는 창 전체 합에서 뽑고 버킷마다 다시 뽑지 않는다", () => {
    expect(bt.brands.map((b) => b.brand)).toEqual(["Toyota", "Hyundai", "Tesla"]);
    for (const b of bt.buckets) expect(b.brands.map((x) => x.brand)).toEqual(bt.brands.map((x) => x.brand));
  });

  it("그 회차에 언급이 없으면 **0**이다(갭이 아니다)", () => {
    const first = bt.buckets[0].brands.find((b) => b.brand === "Tesla");
    expect(first).toMatchObject({ mentions: 0, answers: 0, exposurePct: 0, sharePct: 0 });
  });

  it("sharePct 의 분모는 cap 밖 브랜드를 포함한 회차 총언급이다", () => {
    // A2: Hyundai 30 / compMentions 60 = 50.0
    const h = bt.buckets[1].brands.find((b) => b.brand === "Hyundai");
    expect(h?.sharePct).toBe(50);
    expect(bt.buckets[1].totalMentions).toBe(60);
  });

  it("exposurePct 의 분모는 회차 모수다", () => {
    const h = bt.buckets[1].brands.find((b) => b.brand === "Hyundai");
    expect(h?.exposurePct).toBe(8); // 16 / 200
  });

  it("isTracked 는 **창 전체** 값이다(버킷값이 아니다)", () => {
    for (const b of bt.buckets) {
      expect(b.brands.find((x) => x.brand === "Hyundai")?.isTracked).toBe(true);
    }
  });

  it("trendDays 로 창을 자른다 — 한 read 를 화면들이 나눠 쓴다", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const cut = toBrandTrend(SERIES, { unit: "week", cap: 10, trendDays: 3, now });
    expect(cut.buckets.map((b) => b.bucketStart)).toEqual(["2026-08-31"]);
  });
});

describe("toFirstPosition — 우선노출도", () => {
  const fp = toFirstPosition(SERIES, { unit: "week", cap: 10, positionAxis: "ordinal" });

  it("latest 의 모집단은 **마지막 회차**다(카드와 같은 회차)", () => {
    const h = fp.latest.find((r) => r.brand === "Hyundai");
    expect(h).toMatchObject({ avgPosition: 2, rankedAnswers: 8, mentions: 30 });
  });

  it("순위는 avgPosition 오름차순 — 낮을수록 상위", () => {
    expect(fp.latest.filter((r) => r.rank !== null).map((r) => [r.brand, r.rank])).toEqual([
      ["Hyundai", 1],
      ["Toyota", 2],
    ]);
  });

  it("순위 데이터가 없으면 avgPosition·rank 가 **null**(0 이 아니다)", () => {
    const t = fp.latest.find((r) => r.brand === "Tesla");
    expect(t?.avgPosition).toBeNull();
    expect(t?.rank).toBeNull();
  });

  it("rank null 은 항상 뒤로 간다", () => {
    expect(fp.latest[fp.latest.length - 1].brand).toBe("Tesla");
  });

  it("버킷은 시리즈 브랜드마다 1점 — 없으면 null", () => {
    const b0 = fp.buckets[0].brands;
    expect(b0.map((x) => x.brand).sort()).toEqual(["Hyundai", "Tesla", "Toyota"]);
    expect(b0.find((x) => x.brand === "Tesla")?.avgPosition).toBeNull();
    expect(b0.find((x) => x.brand === "Hyundai")?.avgPosition).toBe(2);
  });

  it("마지막 회차에만 있는 브랜드도 시리즈에 남는다(측정 없음 표기용)", () => {
    const onlyLast: GlobalTrendSeries = {
      buckets: SERIES.buckets,
      brandTotals: SERIES.brandTotals.filter((b) => b.brand !== "Tesla"),
    };
    const out = toFirstPosition(onlyLast, { unit: "week", cap: 10, positionAxis: "ordinal" });
    expect(out.brands).toContain("Tesla");
  });
});

describe("toFirstPosition — **축 선택**(0069 경쟁 순위 / 본문 서수, PR④-b F1)", () => {
  const comp = toFirstPosition(SERIES, { unit: "week", cap: 10, positionAxis: "comp" });
  const ord = toFirstPosition(SERIES, { unit: "week", cap: 10, positionAxis: "ordinal" });

  it("`comp` 는 `compRankSum / compRankedAnswers` 로 나눈다 — 서수 칸을 보지 않는다", () => {
    // 마지막 회차 A2 Hyundai: comp 15/10 = 1.5 · 서수 16/8 = 2.
    expect(comp.latest.find((r) => r.brand === "Hyundai")?.avgPosition).toBe(1.5);
    expect(ord.latest.find((r) => r.brand === "Hyundai")?.avgPosition).toBe(2);
    // Toyota: comp 26/8 = 3.25 → 3.3 · 서수 30/10 = 3.
    expect(comp.latest.find((r) => r.brand === "Toyota")?.avgPosition).toBe(3.3);
    expect(ord.latest.find((r) => r.brand === "Toyota")?.avgPosition).toBe(3);
  });

  it("표본 수(`rankedAnswers`)도 **그 축의 분모**다 — 값과 n 이 갈리면 안 된다", () => {
    expect(comp.latest.find((r) => r.brand === "Hyundai")?.rankedAnswers).toBe(10);
    expect(ord.latest.find((r) => r.brand === "Hyundai")?.rankedAnswers).toBe(8);
  });

  it("**버킷도 같은 축**이다 — Δ 는 여기 마지막 두 점의 차다", () => {
    // A1 Hyundai comp 6/4 = 1.5 → A2 1.5 (Δ 0). 서수 축이면 2 → 2.
    const at = (fp: typeof comp, i: number, brand: string) =>
      fp.buckets[i].brands.find((x) => x.brand === brand)?.avgPosition;
    expect([at(comp, 0, "Toyota"), at(comp, 1, "Toyota")]).toEqual([2, 3.3]);
    expect([at(ord, 0, "Toyota"), at(ord, 1, "Toyota")]).toEqual([2, 3]);
    // 같은 축이면 값(3.3)과 Δ(+1.3)가 같은 단위다. 축이 갈리면 값 3.3 옆에 Δ +1 이 선다.
    expect(at(comp, 1, "Toyota")).toBe(comp.latest.find((r) => r.brand === "Toyota")?.avgPosition);
  });

  it("0069 미적용·refold 전 = `compRankedAnswers` 0 → **null**(0 나눗셈 금지)", () => {
    // 회차 축 문장이 컬럼 부재로 상수 0 을 낼 때의 모양(`SYNC_PROBED_COLUMNS` 규약).
    const zeroed: GlobalTrendSeries = {
      brandTotals: SERIES.brandTotals.map((b) => ({ ...b, compRankSum: 0, compRankedAnswers: 0 })),
      buckets: SERIES.buckets.map((bk) => ({
        ...bk,
        brands: bk.brands.map((b) => ({ ...b, compRankSum: 0, compRankedAnswers: 0 })),
      })),
    };
    const out = toFirstPosition(zeroed, { unit: "week", cap: 10, positionAxis: "comp" });
    for (const r of out.latest) {
      expect(r.avgPosition, r.brand).toBeNull();
      expect(r.rank, r.brand).toBeNull();
    }
    for (const bk of out.buckets) {
      for (const b of bk.brands) expect(b.avgPosition, b.brand).toBeNull();
    }
    // 같은 시리즈라도 서수 축은 여전히 값이 나온다 — 빈칸의 원인이 축이지 데이터가 아니다.
    expect(
      toFirstPosition(zeroed, { unit: "week", cap: 10, positionAxis: "ordinal" })
        .latest.find((r) => r.brand === "Hyundai")?.avgPosition,
    ).toBe(2);
  });
});

describe("rankByPosition — 동률 공동·다음 순위 건너뜀", () => {
  const row = (brand: string, avgPosition: number | null, mentions = 0): FirstPositionRow =>
    ({ brand, isTracked: false, avgPosition, rank: null, rankedAnswers: 1, mentions });

  it("1, 1, 3 형태", () => {
    const out = rankByPosition([row("A", 2), row("B", 2), row("C", 5)]);
    expect(out.map((r) => [r.brand, r.rank])).toEqual([["A", 1], ["B", 1], ["C", 3]]);
  });

  it("null 은 rank 없이 뒤로, 그 안에서는 언급 내림차순", () => {
    const out = rankByPosition([row("N1", null, 3), row("A", 1), row("N2", null, 9)]);
    expect(out.map((r) => r.brand)).toEqual(["A", "N2", "N1"]);
    expect(out[1].rank).toBeNull();
  });
});

describe("windowBounds — 측정 min/max 가 아니라 **요청한 창**", () => {
  const now = Date.parse("2026-09-11T00:00:00.000Z");

  it("trendDays 만 있으면 now-N .. now", () => {
    expect(windowBounds({}, 28, now)).toEqual({
      windowStartBucket: "2026-08-14",
      windowEndBucket: "2026-09-11",
    });
  });

  it("화면 기간이 더 좁으면 그쪽이 이긴다", () => {
    expect(windowBounds({ dateFrom: "2026-09-01", dateTo: "2026-09-05" }, 28, now)).toEqual({
      windowStartBucket: "2026-09-01",
      windowEndBucket: "2026-09-05",
    });
  });
});

describe("bucketsSince", () => {
  it("trendDays 없으면 전량", () => {
    expect(bucketsSince(SERIES.buckets, undefined)).toHaveLength(2);
  });
  it("0·음수도 전량(자르지 않는다)", () => {
    expect(bucketsSince(SERIES.buckets, 0)).toHaveLength(2);
  });
});

describe("2단 조회 — 코어와 브랜드 read 를 합치는 지점", () => {
  // 코어 read 는 브랜드 표를 읽지 않는다(`only: ["own","domains"]`) → 버킷의 brands 는 빈다.
  const core = toSeries({ ...AGG, brands: [] });

  it("코어만으로는 버킷에 브랜드가 없다", () => {
    expect(core.buckets.every((b) => b.brands.length === 0)).toBe(true);
    expect(core.brandTotals).toEqual([]);
  });

  it("attachBrandSeries 가 회차별 브랜드와 스냅샷 totals 를 얹는다", () => {
    const byAnchor = new Map([
      [A2, [{ brand: "Hyundai", isTracked: true, mentions: 30, answers: 16, rankSum: 16, rankedAnswers: 8 }]],
    ]);
    const totals = [
      { brand: "Hyundai", isTracked: true, mentions: 30, answers: 16, rankSum: 16, rankedAnswers: 8 },
    ];
    const merged = attachBrandSeries(core, byAnchor, totals);
    expect(merged.buckets[0].brands).toEqual([]); // A1 은 2단 결과에 없다
    expect(merged.buckets[1].brands.map((b) => b.brand)).toEqual(["Hyundai"]);
    expect(merged.brandTotals).toEqual(totals);
    // 코어의 카드 값은 건드리지 않는다.
    expect(merged.buckets[1].monitored).toBe(200);
    expect(merged.buckets[1].compMentions).toBe(60);
  });

  it("2단 결과가 없는 회차는 브랜드가 빈 배열 — 점유율 분모는 코어에서 온다", () => {
    const merged = attachBrandSeries(core, new Map(), []);
    const bt = toBrandTrend(merged, { unit: "week", cap: 10 });
    // 시리즈가 비어도 버킷의 분모(totalMentions)는 `trend_own.comp_mentions` 다.
    expect(bt.buckets.map((b) => b.totalMentions)).toEqual([40, 60]);
    expect(bt.brands).toEqual([]);
  });
});

describe("회차 축 신호 — 화면이 `fillTrendGaps` 를 건너뛰는 근거", () => {
  it("모든 버킷이 `cycleAnchorAt` 를 갖는다(웹사이트 추이와 같은 필드·같은 타입)", () => {
    for (const b of toStandardTrendBuckets(SERIES)) {
      expect(b.cycleAnchorAt).toBeTypeOf("string");
      expect(b.cycleAnchorAt?.slice(0, 10)).toBe(b.bucketStart);
    }
  });
});

// ── GG-5: 같은 UTC 일 anchor 둘은 **한 점**으로 합산한다 ────────────────────
// 글로벌 게이트에는 `duplicate-cycle-in-week` 가 의도적으로 없다(한 주 두 회차는 정당).
// 하지만 같은 **날**에 anchor 가 둘이면 화면 키가 같아 recharts 가 같은 x 에 두 값을
// 그린다 — 접어서 합산하는 것이 유일하게 맞는 동작이다.
describe("같은 UTC 일 anchor 둘 — 한 점으로 합산", () => {
  const D1 = "2026-09-08T01:00:00.000Z";
  const D2 = "2026-09-08T22:00:00.000Z";
  const agg: TrendAggregates = {
    empty: false, answers: [],
    own: [
      own({ cycleAnchorAt: D2, monitored: 60, trackedAnswers: 30, compMentions: 40, rankSum: 20, rankedAnswers: 10 }),
      own({ cycleAnchorAt: D1, monitored: 40, trackedAnswers: 10, compMentions: 20, rankSum: 10, rankedAnswers: 10 }),
    ],
    brands: [
      brand({ cycleAnchorAt: D1, brandName: "Hyundai", isTracked: true, mentions: 4, answers: 3, rankSum: 6, rankedAnswers: 3 }),
      brand({ cycleAnchorAt: D2, brandName: "Hyundai", mentions: 6, answers: 5, rankSum: 10, rankedAnswers: 5 }),
      brand({ cycleAnchorAt: D2, brandName: "Toyota", mentions: 9, answers: 7 }),
    ],
    domains: [
      domain({ cycleAnchorAt: D1, citations: 100, ownedCitations: 10 }),
      domain({ cycleAnchorAt: D2, citations: 200, ownedCitations: 30 }),
    ],
  };
  const merged = toSeries(agg);

  it("점은 하나이고 분자·분모가 각각 더해진다(평균의 평균 금지)", () => {
    expect(merged.buckets).toHaveLength(1);
    const b = merged.buckets[0];
    expect(b.bucketStart).toBe("2026-09-08");
    expect(b.monitored).toBe(100);
    expect(b.trackedAnswers).toBe(40);
    expect(b.compMentions).toBe(60);
    expect(b.allCitations).toBe(300);
    expect(b.ownedCitations).toBe(40);
    // ④ 는 Σ서수/Σ개수 = 30/20 = 1.5 (1.0 과 2.0 의 평균 1.5 와 우연히 같지만 산식이 다르다)
    expect(toStandardTrendBuckets(merged)[0].avgPosition).toBe(1.5);
  });

  it("anchor 는 그 날의 **최소** anchor(대표값)", () => {
    expect(merged.buckets[0].anchor).toBe(D1);
  });

  it("브랜드 점도 이름으로 합산된다", () => {
    const h = merged.buckets[0].brands.find((x) => x.brand === "Hyundai");
    expect(h).toMatchObject({ mentions: 10, answers: 8, rankSum: 16, rankedAnswers: 8 });
    // 한쪽에서만 tracked 여도 tracked 다.
    expect(h?.isTracked).toBe(true);
    expect(merged.buckets[0].brands.find((x) => x.brand === "Toyota")?.mentions).toBe(9);
  });

  it("2단 결과도 **UTC 일**로 조인된다 — anchor 로 조인하면 한쪽이 통째로 빠진다", () => {
    const core = toSeries({ ...agg, brands: [] });
    const attached = attachBrandSeries(core, new Map([
      [D1, [{ brand: "Hyundai", isTracked: true, mentions: 4, answers: 3, rankSum: 6, rankedAnswers: 3, compRankSum: 3, compRankedAnswers: 2 }]],
      [D2, [{ brand: "Hyundai", isTracked: false, mentions: 6, answers: 5, rankSum: 10, rankedAnswers: 5, compRankSum: 7, compRankedAnswers: 4 }]],
    ]), []);
    expect(attached.buckets).toHaveLength(1);
    expect(attached.buckets[0].brands).toEqual([
      {
        brand: "Hyundai", isTracked: true, mentions: 10, answers: 8,
        rankSum: 16, rankedAnswers: 8, compRankSum: 10, compRankedAnswers: 6,
      },
    ]);
  });
});

// ── 엔진 축 매퍼 — 이름이 **빈 문자열**인 엔진 (2026-09-20 수리) ─────────────
//
// 종전 거르기는 `!r.bucket` 이라 `engine = ''` 인 행을 NULL 과 같이 버렸다. 그러면 그
// 자리의 엔진 분해가 조용히 한 줄 빠지고, 엔진별 라인의 합이 히어로 값과 안 맞는다
// (화면에는 "그 엔진이 없었다" 로 보인다 — 원인을 반대로 말한다).
// 판정은 값이 아니라 **NULL 여부**다: `r.bucket == null`.
describe("toSeries — 엔진 이름이 빈 문자열인 행", () => {
  const A = "2026-09-07T00:00:00.000Z";
  const agg: TrendAggregates = {
    empty: false,
    answers: [],
    own: [
      own({ cycleAnchorAt: A, monitored: 100, trackedAnswers: 40 }),
      own({ axis: "cycle-engine", bucket: "chatgpt", cycleAnchorAt: A, monitored: 60, trackedAnswers: 25 }),
      // 이름이 빈 엔진 — "엔진 없음" 이 아니라 **라벨이 빈 엔진**이다.
      own({ axis: "cycle-engine", bucket: "", cycleAnchorAt: A, monitored: 40, trackedAnswers: 15 }),
      // NULL 은 그 축의 행이 아니다 — 계속 버린다.
      own({ axis: "cycle-engine", bucket: null, cycleAnchorAt: A, monitored: 999, trackedAnswers: 999 }),
    ],
    brands: [],
    domains: [],
  };

  const engines = toSeries(agg).buckets[0].engines;

  it("빈 이름 엔진도 점이 된다", () => {
    expect(engines.map((e) => e.engine).sort()).toEqual(["", "chatgpt"]);
  });

  it("엔진 분해의 모수 합이 자리 모수와 맞는다(한 줄이 조용히 빠지지 않는다)", () => {
    expect(engines.reduce((s, e) => s + e.monitored, 0)).toBe(100);
    expect(engines.reduce((s, e) => s + e.trackedAnswers, 0)).toBe(40);
  });

  it("`bucket === null` 행은 여전히 빠진다", () => {
    expect(engines.some((e) => e.monitored === 999)).toBe(false);
  });
});
