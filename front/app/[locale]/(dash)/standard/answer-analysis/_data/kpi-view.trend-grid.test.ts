import { describe, expect, it } from "vitest";
import { ownPositionSeries, rankTableRows, trendAxis, trendCoverage } from "./kpi-view";
import type { TrendGridSlotView } from "@/lib/period/trend-grid-axis";
import { applyTrendGridToBuckets } from "@/lib/summary/read/trend-grid-buckets";
import type { TrendSlot } from "@/lib/period/trend-grid";
import type { StandardTrendBucket } from "@/lib/db/repositories/scope-aggregates";

// ════════════════════════════════════════════════════════════════════════════
// 언급(4-KPI 탭)과 Overview 가 **같은 자리 집합**을 쓰는가
// ════════════════════════════════════════════════════════════════════════════
//
// 설계 §1 이 고치려는 것이 정확히 이 어긋남이다: 언급은 84일 창에 주 격자를 기계적으로
// 채웠고(13점 중 5점이 빈 슬롯) Overview 는 91일 창에 안 채웠다(5점). 같은 회차가 두
// 화면에서 다른 x축에 서 있었다.
//
// 두 화면은 **다른 코드 경로**로 축을 만든다 — Overview 는 버킷 배열
// (`applyTrendGridToBuckets`), 언급 탭은 축 엔트리(`trendAxis`)다. 같은 자리 목록을
// 넣었을 때 두 경로의 키 배열이 같다는 것을 여기서 박는다.

/** W0 실측 글로벌 13자리(창 안). 07-13·07-20·07-27 은 회차가 미발행이다. */
const GLOBAL_SLOTS: TrendGridSlotView[] = [
  "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20",
  "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24",
  "2026-08-31", "2026-09-07", "2026-09-14",
].map((d) => ({
  roundDate: d,
  anchorWeek: d, // 글로벌 자리는 월요일이라 둘이 같다.
  gapReason: ["2026-07-13", "2026-07-20", "2026-07-27"].includes(d)
    ? ("not-published" as const)
    : null,
}));

/** 값이 있는 자리 = 갭이 아닌 10자리. */
const MEASURED = GLOBAL_SLOTS.filter((s) => s.gapReason === null).map((s) => s.roundDate);

describe("trendAxis — 격자가 주어지면 축은 자리 목록 그대로다", () => {
  it("13자리 전부가 축이 된다 — 값이 10개뿐이어도 축은 안 줄어든다", () => {
    const axis = trendAxis(
      MEASURED.map((d) => ({ bucketStart: d })),
      "week",
      { trendGrid: GLOBAL_SLOTS },
    );
    expect(axis.map((a) => a.bucketStart)).toEqual(GLOBAL_SLOTS.map((s) => s.roundDate));
    expect(axis.filter((a) => !a.measured).map((a) => a.bucketStart)).toEqual([
      "2026-07-13", "2026-07-20", "2026-07-27",
    ]);
  });

  it("커버리지 라벨이 결측 3을 드러낸다", () => {
    const axis = trendAxis(
      MEASURED.map((d) => ({ bucketStart: d })),
      "week",
      { trendGrid: GLOBAL_SLOTS },
    );
    expect(trendCoverage(axis)).toEqual({
      cycles: 13,
      measuredCycles: 10,
      missingCycles: 3,
    });
  });

  it("갭 자리에 값이 실려 와도 측정으로 세지 않는다 — 원장 판정이 값보다 위다", () => {
    const axis = trendAxis(
      [...MEASURED, "2026-07-13"].map((d) => ({ bucketStart: d })),
      "week",
      { trendGrid: GLOBAL_SLOTS },
    );
    expect(axis.find((a) => a.bucketStart === "2026-07-13")?.measured).toBe(false);
  });

  it("자리 밖 값은 축을 넓히지 않는다", () => {
    const axis = trendAxis([{ bucketStart: "2026-05-04" }], "week", {
      trendGrid: GLOBAL_SLOTS,
    });
    expect(axis).toHaveLength(13);
    expect(axis.every((a) => !a.measured)).toBe(true);
  });

  it("창 경계(windowStartBucket/EndBucket)는 무시된다 — 자리를 정하는 것은 원장이다", () => {
    const axis = trendAxis(
      MEASURED.map((d) => ({ bucketStart: d })),
      "week",
      {
        trendGrid: GLOBAL_SLOTS,
        windowStartBucket: "2026-01-01",
        windowEndBucket: "2026-12-31",
      },
    );
    expect(axis[0].bucketStart).toBe("2026-06-22");
    expect(axis[axis.length - 1].bucketStart).toBe("2026-09-14");
  });

  // 기간을 좁혀 자리가 0개면 축도 비어야 한다. 13자리로 되돌아가면 사용자가 고른
  // 기간과 다른 데이터를 보여 주게 된다(메인 추가 규칙 4).
  it("자리가 0개면 축도 비고, 종전 채움으로 되돌아가지 않는다", () => {
    const axis = trendAxis(
      [{ bucketStart: "2026-08-31" }, { bucketStart: "2026-09-14" }],
      "week",
      { trendGrid: [] },
    );
    expect(axis).toEqual([]);
    expect(trendCoverage(axis)).toEqual({ cycles: 0, measuredCycles: 0, missingCycles: 0 });
  });

  it("격자가 없으면(키 off) 종전 채움 축이다", () => {
    const axis = trendAxis(
      [{ bucketStart: "2026-08-31" }, { bucketStart: "2026-09-14" }],
      "week",
    );
    // 채움이 중간 주를 만든다 — 이것이 키 off 의 종전 동작이다.
    expect(axis.map((a) => a.bucketStart)).toEqual([
      "2026-08-31", "2026-09-07", "2026-09-14",
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 검증 B3 — 우선 노출도도 **같은 축**을 쓴다
// ════════════════════════════════════════════════════════════════════════════
//
// 소비자 셋이 `trendAxis(fp.buckets, fp.unit)` 를 3번째 인자 없이 불렀다. 그러면 서버가
// `trendGrid` 를 싣고도 그 축이 **종전 채움**으로 만들어진다. 오늘 글로벌 데이터에서는
// 채움 축과 격자 축이 우연히 같아 안 드러나지만, **자리가 하나라도 빠지면** 같은 탭에서
// 우선 노출도만 x축이 한 칸 길어진다(운영 숨김만 있는 주는 자리가 지워진다).
describe("우선 노출도 — 자리가 빠져도 같은 탭 안에서 축이 안 갈린다", () => {
  /** 08-10 자리가 원장에서 빠진 격자(운영 숨김만 있는 주). 12자리. */
  const HOLED: TrendGridSlotView[] = GLOBAL_SLOTS.filter(
    (s) => s.roundDate !== "2026-08-10",
  );

  const fpBucket = (bucketStart: string) => ({
    bucketStart,
    measuredDays: 1,
    firstAt: null,
    lastAt: null,
    brands: [{ brand: "HYUNDAI", isTracked: true, posSum: 2, posCnt: 1, mentions: 3 }],
  });

  const fp = {
    unit: "week" as const,
    brands: ["HYUNDAI"],
    // 값은 **원래 13자리 전부** 있다 — 축만 12자리여야 한다.
    buckets: MEASURED.map(fpBucket),
    latest: [
      { brand: "HYUNDAI", isTracked: true, avgPosition: 2, rank: 1, rankedAnswers: 1, mentions: 3 },
    ],
    trendGrid: HOLED,
  };

  it("우선 노출도 축 = 격자 자리(12개). 종전 채움이면 13개가 된다", () => {
    const axis = trendAxis(fp.buckets, fp.unit, fp);
    expect(axis).toHaveLength(12);
    expect(axis.some((a) => a.bucketStart === "2026-08-10")).toBe(false);
  });

  it("같은 탭의 히어로 축과 **키 배열이 같다**", () => {
    const hero = trendAxis(
      MEASURED.map((d) => ({ bucketStart: d })),
      "week",
      { trendGrid: HOLED },
    );
    const first = trendAxis(fp.buckets, fp.unit, fp);
    expect(first.map((a) => a.bucketStart)).toEqual(hero.map((a) => a.bucketStart));
  });

  it("소비자 셋이 그 축 위에서 계산한다 — 시리즈 길이가 축 길이와 같다", () => {
    expect(ownPositionSeries(fp)).toHaveLength(12);
    // 스파크는 축의 꼬리 4칸이다(`axis.slice(-cycles)`).
    const rows = rankTableRows(fp, { sparkCycles: 4 });
    expect(rows[0].spark).toHaveLength(4);
  });

  it("격자가 없으면(키 off) 종전 채움 축 그대로 — 13자리", () => {
    const off = { ...fp, trendGrid: undefined };
    expect(trendAxis(off.buckets, off.unit, off)).toHaveLength(13);
  });
});

describe("Overview(버킷 경로)와 언급(축 경로)이 같은 키 배열을 낸다", () => {
  const asSlot = (v: TrendGridSlotView): TrendSlot => ({
    ...v,
    cycleIds: [`c-${v.roundDate}`],
    renderable: v.gapReason === null,
    gapReason: v.gapReason === "no-value" ? null : v.gapReason,
    completionRatio: v.gapReason === null ? 1 : null,
  });

  const measuredBucket = (key: string): StandardTrendBucket => ({
    bucketStart: key,
    roundDate: key,
    cycleAnchorAt: `${key}T00:00:00.000Z`,
    answers: 10, trackedAnswers: 7, totalMentions: 5, trackedMentions: 2,
    sentMentions: 1, positiveMentions: 1, avgPosition: 1, totalCitations: 1,
    ownedCitations: 1, measuredDays: 1,
    firstAt: `${key}T00:00:00.000Z`, lastAt: `${key}T00:00:00.000Z`,
  });

  it("13자리 · 같은 순서 · 같은 갭 위치", () => {
    const overview = applyTrendGridToBuckets(
      MEASURED.map(measuredBucket),
      GLOBAL_SLOTS.map(asSlot),
    );
    const mention = trendAxis(
      MEASURED.map((d) => ({ bucketStart: d })),
      "week",
      { trendGrid: GLOBAL_SLOTS },
    );
    expect(mention.map((a) => a.bucketStart)).toEqual(overview.map((b) => b.bucketStart));
    expect(mention.map((a) => a.measured)).toEqual(overview.map((b) => !b.gap));
  });
});
