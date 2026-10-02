import { describe, expect, it } from "vitest";
import {
  excludedBrandNames,
  filterBrandTrend,
  filterCompetitorValues,
  filterFirstPosition,
  filterMentionsLive,
  isExcludedBrand,
  markExcludedGeo,
  toExcludedBrandSet,
} from "./excluded-brands";
import { marketMetrics } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import type { MentionsLive } from "./result-adapter";
import type {
  BrandTrendResult,
  FirstPositionResult,
  GeoBrandKpiRow,
} from "@/lib/db/repositories/scope-aggregates";

const EX = toExcludedBrandSet(excludedBrandNames([
  { id: "b58565f7", name: "LG전자", rankName: "LG전자" },
  { id: "bd823782", name: "Facebook", rankName: null },
  // 표시명 사전으로 정본화된 키: 순위 행은 '폭스바겐'이 아니라 'Volkswagen' 으로 뜬다.
  { id: "x1", name: "폭스바겐", rankName: "폭스바겐" },
]));
const NONE = toExcludedBrandSet([]);

const types = (n: number) => ({ mention: n, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 });

describe("excludedBrandNames / isExcludedBrand", () => {
  it("대표 표기를 정본 표시명으로 접고, 대표 표기가 없으면 명부 이름을 쓴다", () => {
    expect([...EX].sort()).toEqual(["Facebook", "LG전자", "Volkswagen"]);
  });
  it("자사(isTracked) 행은 이름이 겹쳐도 절대 빼지 않는다", () => {
    const own = toExcludedBrandSet(["Kia"]);
    expect(isExcludedBrand(own, "Kia", true)).toBe(false);
    expect(isExcludedBrand(own, " Kia ", false)).toBe(true);
  });
});

describe("filterMentionsLive: 순위·목록만 빼고 분모·요약은 그대로", () => {
  const live: MentionsLive = {
    summary: { total: 100, uniqueBrands: 4, totalPrompts: 9, totalAnswers: 40 },
    asOf: null,
    brands: [
      { brand: "Kia", mentions: 50, prompts: 5, share: 50, mentionRate: 60, avgPosition: 1.2, isTracked: true },
      { brand: "LG전자", mentions: 20, prompts: 2, share: 20, mentionRate: 10, avgPosition: 2, isTracked: false },
      { brand: "Toyota", mentions: 20, prompts: 3, share: 20, mentionRate: 20, avgPosition: 2.5, isTracked: false },
      { brand: "Facebook", mentions: 10, prompts: 1, share: 10, mentionRate: 5, avgPosition: 3, isTracked: false },
    ],
    perBrandPrompts: { Kia: [], "LG전자": [], Toyota: [] },
    sentimentTotals: null,
    typeTotals: null,
    typesByBrand: {
      totals: types(100),
      brands: [
        { brand: "Kia", isTracked: true, types: types(50) },
        { brand: "LG전자", isTracked: false, types: types(20) },
        { brand: "Toyota", isTracked: false, types: types(20) },
      ],
    },
    hasPosition: true,
    trend: { series: ["Kia", "LG전자", "Toyota"], points: [{ week: "2026-09-21", Kia: 5, "LG전자": 2, Toyota: 2 }] },
  };

  it("제외 행을 순위표·유형×브랜드·추이 시리즈·드릴다운 키에서 뺀다", () => {
    const out = filterMentionsLive(live, EX);
    expect(out.brands.map((b) => b.brand)).toEqual(["Kia", "Toyota"]);
    expect(out.typesByBrand?.brands.map((b) => b.brand)).toEqual(["Kia", "Toyota"]);
    expect(out.trend?.series).toEqual(["Kia", "Toyota"]);
    expect(Object.keys(out.perBrandPrompts)).toEqual(["Kia", "Toyota"]);
  });
  it("분모·요약·행 값(점유율)은 바꾸지 않는다", () => {
    const out = filterMentionsLive(live, EX);
    expect(out.summary).toEqual(live.summary);
    expect(out.typesByBrand?.totals).toEqual(live.typesByBrand?.totals);
    expect(out.brands.find((b) => b.brand === "Toyota")?.share).toBe(20);
    expect(live.brands).toHaveLength(4); // 입력 불변
  });
  it("제외 집합이 비면 같은 객체를 돌려준다", () => {
    expect(filterMentionsLive(live, NONE)).toBe(live);
  });
});

describe("filterCompetitorValues: Overview 경쟁사 선정 입력", () => {
  it("제외 행을 빼면 다음 경쟁사가 선정 후보가 된다", () => {
    const rows = [
      { brand: "LG전자", mentions: 30, share: 30, mentionRate: 20, avgPosition: 2, isTracked: false },
      { brand: "Toyota", mentions: 20, share: 20, mentionRate: 15, avgPosition: 3, isTracked: false },
    ];
    expect(filterCompetitorValues(rows, EX).map((r) => r.brand)).toEqual(["Toyota"]);
  });
});

describe("filterBrandTrend: 캡을 넉넉히 읽고 제외 후 원래 캡으로 줄인다", () => {
  const pt = (brand: string, isTracked: boolean) => ({
    brand, isTracked, mentions: 1, answers: 1, exposurePct: 10, sharePct: 10,
  });
  const res: BrandTrendResult = {
    unit: "week",
    windowStartBucket: null,
    windowEndBucket: null,
    brands: [
      { brand: "Kia", isTracked: true, mentions: 90 },
      { brand: "LG전자", isTracked: false, mentions: 80 },
      { brand: "Toyota", isTracked: false, mentions: 70 },
      { brand: "BMW", isTracked: false, mentions: 60 },
      { brand: "Honda", isTracked: false, mentions: 50 },
    ],
    buckets: [{
      bucketStart: "2026-09-21", answers: 10, totalMentions: 350, measuredDays: 1,
      firstAt: null, lastAt: null,
      brands: ["Kia", "LG전자", "Toyota", "BMW", "Honda"].map((b) => pt(b, b === "Kia")),
    }],
  };
  it("제외 행 자리를 다음 브랜드가 채우고 분모(totalMentions)는 그대로다", () => {
    const out = filterBrandTrend(res, EX, 3);
    expect(out.brands.map((b) => b.brand)).toEqual(["Kia", "Toyota", "BMW"]);
    expect(out.buckets[0].brands.map((b) => b.brand)).toEqual(["Kia", "Toyota", "BMW"]);
    expect(out.buckets[0].totalMentions).toBe(350);
  });
});

describe("filterFirstPosition: 순위표에서 빼고 순위 열을 다시 매긴다", () => {
  const row = (brand: string, avgPosition: number, isTracked = false) => ({
    brand, isTracked, avgPosition, rank: null as number | null, rankedAnswers: 5, mentions: 10,
  });
  const res: FirstPositionResult = {
    unit: "week",
    brands: ["Kia", "LG전자", "Toyota"],
    buckets: [],
    latest: [
      { ...row("LG전자", 1.1), rank: 1 },
      { ...row("Kia", 1.5, true), rank: 2 },
      { ...row("Toyota", 2.0), rank: 3 },
    ],
  };
  it("LG전자 가 빠지면 Kia 가 1위, Toyota 가 2위가 된다(avgPosition 값은 그대로)", () => {
    const out = filterFirstPosition(res, EX, 10);
    expect(out.brands).toEqual(["Kia", "Toyota"]);
    expect(out.latest.map((r) => [r.brand, r.rank, r.avgPosition])).toEqual([
      ["Kia", 1, 1.5],
      ["Toyota", 2, 2.0],
    ]);
  });
});

describe("markExcludedGeo + marketMetrics: 최대 경쟁사만 바뀌고 SOV 분모는 그대로", () => {
  const geo = (brand: string, mentions: number, isTracked = false): GeoBrandKpiRow => ({
    code: "IN", brand, mentions, isTracked, answers: 1, posSum: 0, posCnt: 0, sentPositive: 0, sentTotal: 0,
  });
  const rows = [geo("Kia", 50, true), geo("LG전자", 30), geo("Toyota", 20)];
  const totals = { answers: 10, ownAnswers: 5, citTotal: 0, citOwned: 0 };
  it("제외 행은 표식만 달리고 남는다", () => {
    const marked = markExcludedGeo(rows, EX);
    expect(marked).toHaveLength(3);
    expect(marked.find((r) => r.brand === "LG전자")?.excluded).toBe(true);
  });
  it("rival 은 제외 행을 건너뛰고, 당사 SOV 는 제외 행 포함 분모(100) 그대로다", () => {
    const before = marketMetrics(rows, totals, null);
    const after = marketMetrics(markExcludedGeo(rows, EX), totals, null);
    expect(before.shareOfVoice.rival?.name).toBe("LG전자");
    expect(after.shareOfVoice.rival?.name).toBe("Toyota");
    expect(after.shareOfVoice.ours).toBe(before.shareOfVoice.ours);
    expect(after.shareOfVoice.ours).toBe(50);
  });
});
