import { describe, expect, it } from "vitest";
import {
  DISPLAY_TIME_ZONE,
  formatAsOfDate,
  formatTrendBucketMD,
  trendBucketDisplayDay,
  trendBucketDisplays,
} from "./as-of-date";

describe("formatAsOfDate — 측정 기준일은 KST 달력 날짜", () => {
  it("표시 시간대는 next-intl 과 같은 Asia/Seoul", () => {
    expect(DISPLAY_TIME_ZONE).toBe("Asia/Seoul");
  });

  it("글로벌 회차 8 앵커(2026-09-13T15:48:44Z)는 09-14 로 보인다 — 2026-09-16 제품 책임자 지적", () => {
    expect(formatAsOfDate("2026-09-13T15:48:44.276Z")).toBe("2026-09-14");
  });

  it("KST 자정 경계 — 14:59:59Z 까지는 같은 날, 15:00:00Z 부터 다음 날", () => {
    expect(formatAsOfDate("2026-09-13T14:59:59.999Z")).toBe("2026-09-13");
    expect(formatAsOfDate("2026-09-13T15:00:00.000Z")).toBe("2026-09-14");
  });

  it("과거 회차 앵커 표시는 바뀌지 않는다(회귀 고정: 회차 7·6·5)", () => {
    expect(formatAsOfDate("2026-09-08T01:10:00.000Z")).toBe("2026-09-08");
    expect(formatAsOfDate("2026-08-31T00:00:00.000Z")).toBe("2026-08-31");
    expect(formatAsOfDate("2026-08-25T12:50:00.000Z")).toBe("2026-08-25");
  });

  it("연말 경계도 KST 로 넘어간다", () => {
    expect(formatAsOfDate("2026-12-31T15:00:00.000Z")).toBe("2027-01-01");
  });

  it("이미 날짜(YYYY-MM-DD)면 그대로 — 테스트 픽스처·과거 호출부 호환", () => {
    expect(formatAsOfDate("2026-09-01")).toBe("2026-09-01");
  });

  it("파싱 불가 문자열은 종전 동작(앞 10자)으로 폴백해 화면이 비지 않는다", () => {
    expect(formatAsOfDate("not-a-date-at-all")).toBe("not-a-date");
  });
});

describe("추이 x축 라벨 — 회차 버킷은 앵커의 KST 일, 키는 그대로", () => {
  // 2026-09-28 현대 필리핀 계정 실측 축: 키(UTC 일) → 기대 라벨(KST 일).
  const cycles = [
    { bucketStart: "2026-08-31", cycleAnchorAt: "2026-08-31T00:00:00.000Z" },
    { bucketStart: "2026-09-08", cycleAnchorAt: "2026-09-08T01:10:00.000Z" },
    { bucketStart: "2026-09-13", cycleAnchorAt: "2026-09-13T15:48:44.276Z" },
    { bucketStart: "2026-09-20", cycleAnchorAt: "2026-09-20T15:50:51.000Z" },
  ];

  it("실측 축: 8. 31. / 9. 8. / 9. 13. / 9. 20. → 8. 31. / 9. 8. / 9. 14. / 9. 21.", () => {
    const d = trendBucketDisplays(cycles);
    expect(cycles.map((c) => formatTrendBucketMD(d.get(c.bucketStart)!))).toEqual([
      "8. 31.", "9. 8.", "9. 14.", "9. 21.",
    ]);
  });

  it("키는 바뀌지 않는다 — 맵의 키가 곧 입력의 bucketStart", () => {
    expect([...trendBucketDisplays(cycles).keys()]).toEqual(cycles.map((c) => c.bucketStart));
  });

  it("KST 자정 경계 — 앵커 14:59:59Z 는 같은 날, 15:00:00Z 는 다음 날", () => {
    expect(trendBucketDisplayDay({ bucketStart: "2026-09-13", cycleAnchorAt: "2026-09-13T14:59:59.999Z" })).toBe("2026-09-13");
    expect(trendBucketDisplayDay({ bucketStart: "2026-09-13", cycleAnchorAt: "2026-09-13T15:00:00.000Z" })).toBe("2026-09-14");
  });

  it("KST 자정 직전·직후(14:59Z/15:01Z 는 KST 23:59/00:01)", () => {
    expect(trendBucketDisplayDay({ bucketStart: "2026-09-20", cycleAnchorAt: "2026-09-20T14:59:00.000Z" })).toBe("2026-09-20");
    expect(trendBucketDisplayDay({ bucketStart: "2026-09-20", cycleAnchorAt: "2026-09-20T15:01:00.000Z" })).toBe("2026-09-21");
  });

  it("앵커가 없는 버킷(미러 주/일 격자)은 종전 그대로 키를 쓴다", () => {
    const d = trendBucketDisplays([{ bucketStart: "2026-09-07" }, { bucketStart: "2026-09-14", cycleAnchorAt: null }]);
    expect(d.get("2026-09-07")).toEqual({ day: "2026-09-07", time: null });
    expect(d.get("2026-09-14")).toEqual({ day: "2026-09-14", time: null });
  });

  it("같은 KST 날에 키가 둘이면 충돌한 점에만 KST 시각을 붙인다 — 점은 접지 않는다", () => {
    const d = trendBucketDisplays([
      { bucketStart: "2026-09-06", cycleAnchorAt: "2026-09-06T15:48:00.000Z" }, // 단독
      { bucketStart: "2026-09-13", cycleAnchorAt: "2026-09-13T15:48:44.000Z" }, // KST 9/14 00:48
      { bucketStart: "2026-09-14", cycleAnchorAt: "2026-09-14T03:00:00.000Z" }, // KST 9/14 12:00
    ]);
    expect(d.size).toBe(3);
    expect(formatTrendBucketMD(d.get("2026-09-06")!)).toBe("9. 7.");
    expect(formatTrendBucketMD(d.get("2026-09-13")!)).toBe("9. 14. 00:48");
    expect(formatTrendBucketMD(d.get("2026-09-14")!)).toBe("9. 14. 12:00");
  });

  it("같은 키가 여러 번 와도(분할 입력) 한 점 — 시각이 붙지 않는다", () => {
    const d = trendBucketDisplays([
      { bucketStart: "2026-09-13", cycleAnchorAt: "2026-09-13T15:48:44.000Z" },
      { bucketStart: "2026-09-13", cycleAnchorAt: "2026-09-13T15:48:44.000Z" },
    ]);
    expect(d.get("2026-09-13")).toEqual({ day: "2026-09-14", time: null });
  });

  it("파싱 불가 표시일은 원문 그대로(화면이 비지 않는다)", () => {
    expect(formatTrendBucketMD({ day: "not-a-day", time: null })).toBe("not-a-day");
  });
});
