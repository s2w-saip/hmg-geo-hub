// 주별 Top-N 추이(인용 도메인·언급 브랜드)의 갭 슬롯(0070) — 생산자 단위 고정.
//
// 이 차트가 8/24 골짜기가 보이던 바로 그 지면이다(인용 화면 "주별 상위 10개 도메인
// 인용 수"). 숨김 뒤에는 그 주 행이 **사라지고**, 여기서 그 자리에 null+gap 을 되돌린다.
import { describe, it, expect } from "vitest";
import { applyWeeklyTrendGaps, buildWeeklyTrend } from "./result-adapter";
import { rowTrendGap } from "@/lib/viz/trend-gap";

const e = (date: string, key: string, count: number) => ({ date, key, count });

describe("buildWeeklyTrend — 갭 주", () => {
  const entries = [
    e("2026-08-18T00:00:00Z", "a.com", 10),
    e("2026-08-18T00:00:00Z", "b.com", 5),
    e("2026-09-01T00:00:00Z", "a.com", 12),
    e("2026-09-01T00:00:00Z", "b.com", 6),
  ];

  it("갭 주가 시리즈 값 전부 null + gap 으로 들어간다", () => {
    const t = buildWeeklyTrend(entries, ["a.com", "b.com"], ["2026-08-24"]);
    expect(t).not.toBeNull();
    expect(t!.points.map((p) => p.week)).toEqual(["2026-08-17", "2026-08-24", "2026-08-31"]);
    const gap = t!.points[1];
    expect(gap["a.com"]).toBeNull();
    expect(gap["b.com"]).toBeNull();
    expect(rowTrendGap(gap)).toEqual({ reason: "collection_error" });
    // 이웃 값은 그대로 — 8/17 과 8/31 이 IDENTICAL 이어야 한다.
    expect(t!.points[0]).toMatchObject({ week: "2026-08-17", "a.com": 10, "b.com": 5 });
    expect(t!.points[2]).toMatchObject({ week: "2026-08-31", "a.com": 12, "b.com": 6 });
  });

  it("갭 주 없이 부르면 종전과 완전히 같다 (무변경 증명)", () => {
    const base = buildWeeklyTrend(entries, ["a.com", "b.com"]);
    const same = buildWeeklyTrend(entries, ["a.com", "b.com"], []);
    expect(same).toEqual(base);
    expect(base!.points.every((p) => rowTrendGap(p) === undefined)).toBe(true);
  });

  it("갭 주는 '2주 이상' 판정에 세지 않는다 — 갭 둘은 선이 아니다", () => {
    const one = [e("2026-08-18T00:00:00Z", "a.com", 10)];
    expect(buildWeeklyTrend(one, ["a.com"], ["2026-08-24", "2026-08-31"])).toBeNull();
  });

  it("그 주에 다른 측정이 남아 있으면 갭을 안 넣는다", () => {
    const withMid = [...entries, e("2026-08-25T00:00:00Z", "a.com", 3)];
    const t = buildWeeklyTrend(withMid, ["a.com", "b.com"], ["2026-08-24"]);
    expect(t!.points.map((p) => p.week)).toEqual(["2026-08-17", "2026-08-24", "2026-08-31"]);
    expect(t!.points[1]["a.com"]).toBe(3); // 값이 남았다 = 구멍이 아니다
    expect(rowTrendGap(t!.points[1])).toBeUndefined();
  });
});

describe("applyWeeklyTrendGaps — 이미 만들어진 추이에 얹기(페처 경계)", () => {
  const trend = {
    series: ["a.com"],
    points: [
      { week: "2026-08-17", "a.com": 10 },
      { week: "2026-08-31", "a.com": 12 },
    ],
  };

  it("null 추이는 그대로 null", () => {
    expect(applyWeeklyTrendGaps(null, ["2026-08-24"])).toBeNull();
  });

  it("갭이 없으면 **참조 동일** — 캐시된 객체를 헛되이 복사하지 않는다", () => {
    expect(applyWeeklyTrendGaps(trend, [])).toBe(trend);
    expect(applyWeeklyTrendGaps(trend, ["2026-07-06"])).toBe(trend); // 축 밖
  });

  it("갭을 얹어도 series 는 그대로다", () => {
    const out = applyWeeklyTrendGaps(trend, ["2026-08-24"])!;
    expect(out.series).toBe(trend.series);
    expect(out.points).toHaveLength(3);
  });
});
