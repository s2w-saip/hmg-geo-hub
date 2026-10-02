import { describe, expect, it } from "vitest";
import { orderRankRows } from "./first-rank-row-order";

// GGMD 고객 요구 #1(2026-09-20): "순위별 보기"를 끄면 **당사가 최상위**, 그 아래 타사.
// 종전에는 토글이 래더 그래프만 숨기고 표 순서는 두 상태가 같았다.
//
// 픽스처는 집계가 내려주는 형태 그대로다: 평균 위치 오름차순, 측정 없음(null)은 뒤.

const ROWS = [
  { brand: "Tesla", isTracked: false, avgPosition: 17.5 },
  { brand: "Hyundai", isTracked: true, avgPosition: 18.3 },
  { brand: "BMW", isTracked: false, avgPosition: 19.0 },
  { brand: "Kia", isTracked: true, avgPosition: 19.7 },
  { brand: "Audi", isTracked: false, avgPosition: 19.7 },
  { brand: "Genesis", isTracked: true, avgPosition: 21.0 },
  { brand: "Lucid", isTracked: false, avgPosition: null },
];

const names = (rows: ReadonlyArray<{ brand: string }>) => rows.map((r) => r.brand);

describe("orderRankRows: 순위별 보기 토글이 가르는 두 순서", () => {
  it("토글 ON(ownFirst=false)은 집계 순서를 그대로 쓴다 = 평균 위치 오름차순", () => {
    expect(names(orderRankRows(ROWS, { ownFirst: false }))).toEqual(names(ROWS));
  });

  it("토글 OFF(ownFirst=true)는 당사가 전부 위, 그 아래 타사", () => {
    const out = orderRankRows(ROWS, { ownFirst: true });
    expect(names(out)).toEqual(["Hyundai", "Kia", "Genesis", "Tesla", "BMW", "Audi", "Lucid"]);
    // 당사 묶음이 끊기지 않는다. 타사가 하나라도 사이에 끼면 요구가 깨진 것이다.
    const lastOwn = out.map((r) => r.isTracked).lastIndexOf(true);
    expect(out.slice(0, lastOwn + 1).every((r) => r.isTracked)).toBe(true);
  });

  it("각 묶음 안은 평균 위치 오름차순이고 측정 없음은 묶음의 끝", () => {
    const out = orderRankRows(
      [
        { brand: "NoData", isTracked: false, avgPosition: null },
        { brand: "Genesis", isTracked: true, avgPosition: 21.0 },
        { brand: "Hyundai", isTracked: true, avgPosition: 18.3 },
        { brand: "OwnNoData", isTracked: true, avgPosition: null },
        { brand: "Tesla", isTracked: false, avgPosition: 17.5 },
      ],
      { ownFirst: true },
    );
    expect(names(out)).toEqual(["Hyundai", "Genesis", "OwnNoData", "Tesla", "NoData"]);
  });

  it("동률은 입력 순서를 지킨다(안정 정렬). 회차마다 자리가 흔들리지 않는다", () => {
    const out = orderRankRows(
      [
        { brand: "Kia", isTracked: true, avgPosition: 19.7 },
        { brand: "Genesis", isTracked: true, avgPosition: 19.7 },
        { brand: "Hyundai", isTracked: true, avgPosition: 19.7 },
      ],
      { ownFirst: true },
    );
    expect(names(out)).toEqual(["Kia", "Genesis", "Hyundai"]);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const input = [...ROWS];
    orderRankRows(input, { ownFirst: true });
    expect(names(input)).toEqual(names(ROWS));
  });
});
