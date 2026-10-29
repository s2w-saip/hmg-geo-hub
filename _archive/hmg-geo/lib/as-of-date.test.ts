import { describe, expect, it } from "vitest";
import { DISPLAY_TIME_ZONE, formatAsOfDate } from "./as-of-date";

describe("formatAsOfDate — 측정 기준일은 KST 달력 날짜", () => {
  it("표시 시간대는 next-intl 과 같은 Asia/Seoul", () => {
    expect(DISPLAY_TIME_ZONE).toBe("Asia/Seoul");
  });

  it("글로벌 회차 8 앵커(2026-09-13T15:48:44Z)는 09-14 로 보인다 — 2026-09-16 운영 피드백", () => {
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
