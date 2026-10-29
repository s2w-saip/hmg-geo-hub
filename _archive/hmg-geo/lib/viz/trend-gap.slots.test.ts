// 갭 슬롯 계산부(0070)의 규칙 셋을 고정한다 — 이 규칙이 깨지면 화면이 **없던 점**을
// 만들거나(축 확장) **있는 값 위에** "수집되지 않음" 을 찍는다(계약 위반).
import { describe, it, expect } from "vitest";
import {
  COLLECTION_ERROR_GAP,
  insertTrendGapSlots,
  rowTrendGap,
  trendGapKeyInAxis,
  trendGapKeysToMark,
} from "./trend-gap";

type Row = { week: string; v: number | null; gap?: typeof COLLECTION_ERROR_GAP };
const row = (week: string, v: number | null): Row => ({ week, v });
const gapRow = (week: string): Row => ({ week, v: null, gap: COLLECTION_ERROR_GAP });
const keyOf = (r: Row) => r.week;

describe("insertTrendGapSlots — 슬롯이 없을 때 끼워 넣기", () => {
  it("이웃 사이의 갭 주를 값 전부 null + gap 으로 끼운다", () => {
    const rows = [row("2026-08-17", 10), row("2026-08-31", 12)];
    const out = insertTrendGapSlots(rows, ["2026-08-24"], keyOf, gapRow);
    expect(out.map(keyOf)).toEqual(["2026-08-17", "2026-08-24", "2026-08-31"]);
    expect(out[1].v).toBeNull();
    expect(rowTrendGap(out[1])).toEqual({ reason: "collection_error" });
    // 이웃 값은 그대로 — 갭이 값을 만지지 않는다.
    expect(out[0].v).toBe(10);
    expect(out[2].v).toBe(12);
  });

  it("축 밖(첫 점 앞·마지막 점 뒤)의 갭은 넣지 않는다 — 축을 넓히지 않는다", () => {
    const rows = [row("2026-08-17", 10), row("2026-08-31", 12)];
    const out = insertTrendGapSlots(rows, ["2026-08-10", "2026-09-07"], keyOf, gapRow);
    expect(out).toBe(rows); // 참조 동일 = 변한 것이 없다
  });

  it("이미 그 주에 값이 있으면 넣지 않는다 — 같은 주가 둘이 되지 않는다", () => {
    const rows = [row("2026-08-17", 10), row("2026-08-24", 3), row("2026-08-31", 12)];
    const out = insertTrendGapSlots(rows, ["2026-08-24"], keyOf, gapRow);
    expect(out).toBe(rows);
  });

  it("갭이 여러 개여도 순서를 지킨다", () => {
    const rows = [row("2026-08-03", 1), row("2026-08-31", 2)];
    const out = insertTrendGapSlots(rows, ["2026-08-17", "2026-08-10"], keyOf, gapRow);
    expect(out.map(keyOf)).toEqual(["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-31"]);
  });

  it("점이 1개 이하면 아무것도 안 한다 — 이을 이웃이 없다", () => {
    const one = [row("2026-08-17", 10)];
    expect(insertTrendGapSlots(one, ["2026-08-24"], keyOf, gapRow)).toBe(one);
    const none: Row[] = [];
    expect(insertTrendGapSlots(none, ["2026-08-24"], keyOf, gapRow)).toBe(none);
  });

  it("갭 목록이 비면 입력을 그대로 돌려준다(참조 동일)", () => {
    const rows = [row("2026-08-17", 10), row("2026-08-31", 12)];
    expect(insertTrendGapSlots(rows, [], keyOf, gapRow)).toBe(rows);
  });
});

describe("trendGapKeysToMark — 슬롯이 이미 있을 때 마커만", () => {
  const axis = ["2026-08-17", "2026-08-24", "2026-08-31"];

  it("빈 슬롯에만 마커를 찍는다", () => {
    const marks = trendGapKeysToMark(axis, ["2026-08-24"], (k) => k !== "2026-08-24");
    expect([...marks]).toEqual(["2026-08-24"]);
  });

  it("그 주에 측정이 남아 있으면 마커를 안 찍는다 (계약: 갭 슬롯의 값은 전부 null)", () => {
    const marks = trendGapKeysToMark(axis, ["2026-08-24"], () => true);
    expect(marks.size).toBe(0);
  });

  it("축 끝(첫·마지막)에는 안 찍는다 — 이을 이웃이 없다", () => {
    const marks = trendGapKeysToMark(axis, ["2026-08-17", "2026-08-31"], () => false);
    expect(marks.size).toBe(0);
  });

  it("축에 없는 키는 무시한다", () => {
    const marks = trendGapKeysToMark(axis, ["2026-08-25"], () => false);
    expect(marks.size).toBe(0);
  });
});

describe("trendGapKeyInAxis", () => {
  it("경계는 배타적이다", () => {
    expect(trendGapKeyInAxis("b", "a", "c")).toBe(true);
    expect(trendGapKeyInAxis("a", "a", "c")).toBe(false);
    expect(trendGapKeyInAxis("c", "a", "c")).toBe(false);
    expect(trendGapKeyInAxis("b", undefined, undefined)).toBe(false);
  });
});
