// 갭 **범위** 계약(0071) — 순수 계산부.
//
// 이 계약이 깨지는 방식은 둘이고, 둘 다 화면만 봐서는 안 보인다:
//   · `scope` 를 모르는 소비자가 `citations` 마커를 갭으로 읽으면 → 언급 차트에
//     음영이 남는다(값은 살아났는데 "수집되지 않음" 이라고 말한다).
//   · `scope` 없는 옛 마커를 `citations` 로 읽으면 → 회차 전체가 깨진 주의 인용 외
//     4 KPI 가 값 없이 음영도 없이 그려진다(그 주가 없었던 것처럼 보인다).
// 그래서 기본값은 **넓은 쪽(`all`)** 이고, 계열은 소비자가 **명시**해야 좁아진다.
import { describe, expect, it } from "vitest";
import {
  CITATIONS_COLLECTION_ERROR_GAP,
  COLLECTION_ERROR_GAP,
  collectionErrorGap,
  isTrendGap,
  planTrendGaps,
  rowTrendGap,
  trendGapApplies,
  trendGapScopeOf,
} from "./trend-gap";

describe("범위 기본값 — undefined = all", () => {
  it("옛 마커(범위 없음)는 all 이다", () => {
    expect(trendGapScopeOf(COLLECTION_ERROR_GAP)).toBe("all");
    expect(COLLECTION_ERROR_GAP).not.toHaveProperty("scope");
  });

  it("citations 마커는 citations 다", () => {
    expect(trendGapScopeOf(CITATIONS_COLLECTION_ERROR_GAP)).toBe("citations");
    expect(collectionErrorGap("citations")).toBe(CITATIONS_COLLECTION_ERROR_GAP);
    expect(collectionErrorGap("all")).toBe(COLLECTION_ERROR_GAP);
  });

  it("`isTrendGap`·`rowTrendGap` 은 범위가 붙어도 그대로 인식한다 (기존 소비자 무변경)", () => {
    expect(isTrendGap(CITATIONS_COLLECTION_ERROR_GAP)).toBe(true);
    expect(rowTrendGap({ gap: CITATIONS_COLLECTION_ERROR_GAP })).toBe(
      CITATIONS_COLLECTION_ERROR_GAP,
    );
  });
});

describe("trendGapApplies — 이 계열이 이 갭을 갭으로 보는가", () => {
  it("인용 계열은 범위와 무관하게 전부 갭", () => {
    expect(trendGapApplies(COLLECTION_ERROR_GAP, "citation")).toBe(true);
    expect(trendGapApplies(CITATIONS_COLLECTION_ERROR_GAP, "citation")).toBe(true);
  });

  it("언급 계열은 all 만 갭 — citations 는 값이 살아 있다", () => {
    expect(trendGapApplies(COLLECTION_ERROR_GAP, "mention")).toBe(true);
    expect(trendGapApplies(CITATIONS_COLLECTION_ERROR_GAP, "mention")).toBe(false);
  });

  it("갭이 없으면 언제나 false", () => {
    expect(trendGapApplies(undefined, "mention")).toBe(false);
    expect(trendGapApplies(null, "citation")).toBe(false);
  });
});

describe("planTrendGaps — family 는 선택 인자다(유닛 1 은 계약만 넣는다)", () => {
  const rows = [
    { x: "2026-08-17", a: 10 },
    { x: "2026-08-24", a: 20, gap: CITATIONS_COLLECTION_ERROR_GAP },
    { x: "2026-08-31", a: 30 },
  ];

  it("생략하면 **종전 동작** — 범위를 무시하고 전부 갭", () => {
    const plan = planTrendGaps(rows, { xKey: "x", seriesKeys: ["a"] });
    expect(plan.hasGap).toBe(true);
    expect(plan.areas).toHaveLength(1);
    expect(plan.bridges.map((b) => b.seriesKey)).toEqual(["a"]);
  });

  it("family=citation 이면 갭으로 본다", () => {
    const plan = planTrendGaps(rows, { xKey: "x", seriesKeys: ["a"], family: "citation" });
    expect(plan.hasGap).toBe(true);
    expect(plan.areas).toHaveLength(1);
  });

  it("family=mention 이면 갭이 아니다 — 음영·보조 라인이 없고 행이 참조 동일", () => {
    const plan = planTrendGaps(rows, { xKey: "x", seriesKeys: ["a"], family: "mention" });
    expect(plan.hasGap).toBe(false);
    expect(plan.areas).toHaveLength(0);
    expect(plan.bridges).toHaveLength(0);
    expect(plan.rows).toBe(rows);
  });

  it("범위 없는(=all) 마커는 family=mention 에서도 갭이다", () => {
    const allRows = [rows[0], { ...rows[1], gap: COLLECTION_ERROR_GAP }, rows[2]];
    const plan = planTrendGaps(allRows, { xKey: "x", seriesKeys: ["a"], family: "mention" });
    expect(plan.hasGap).toBe(true);
    expect(plan.areas).toHaveLength(1);
  });

  it("혼합 — 두 갭 중 언급 계열이 보는 것은 all 하나뿐이다", () => {
    const mixed = [
      { x: "2026-08-10", a: 5 },
      { x: "2026-08-17", a: 10, gap: COLLECTION_ERROR_GAP },
      { x: "2026-08-24", a: 20, gap: CITATIONS_COLLECTION_ERROR_GAP },
      { x: "2026-08-31", a: 30 },
    ];
    const cit = planTrendGaps(mixed, { xKey: "x", seriesKeys: ["a"], family: "citation" });
    // 두 갭이 **연속**이므로 한 덩어리 음영이다(겹친 ReferenceArea 방지 규칙).
    expect(cit.areas).toHaveLength(1);
    expect(cit.areas[0]).toMatchObject({ x1: "2026-08-10", x2: "2026-08-31" });

    const men = planTrendGaps(mixed, { xKey: "x", seriesKeys: ["a"], family: "mention" });
    expect(men.areas).toHaveLength(1);
    expect(men.areas[0]).toMatchObject({ x1: "2026-08-10", x2: "2026-08-24" });
  });
});
