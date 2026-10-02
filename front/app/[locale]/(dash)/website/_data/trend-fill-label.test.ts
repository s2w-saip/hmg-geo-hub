// 갭 채움 버킷의 **라벨**도 정규 요일이어야 한다 (2026-09-20 관찰 잔여 1건).
//
// 관찰: website 추이 11점 `7. 3. · 7. 10. · 7. 17. · 7. 24. · **7. 27.** · 8. 7. …`
// 에서 `7. 27.` 만 월요일이고 그 자리에 데이터 점(dot)이 없었다(틱 11 · dot 10 ·
// 음영 rect 0). 그 구간에 website 숨김 회차는 없다 — 숨김 슬롯이 아니라
// **07-24 와 08-07 사이의 결측 주**(07-31 금요일 회차 없음)를 갭 채우기가 버킷 키
// (`anchor_week` = 월요일 07-27)로 만든 것이고, 채운 버킷에는 `round_date` 가 없어
// 라벨이 버킷 키로 폴백했다.
//
// 수리: 축 on 에서 채운 버킷의 라벨을 그 표면의 **정규 요일**로 맞춘다.
// 요일 상수 정본은 `REGULAR_ROUND_DOW`(DB `hmg_round_canonical_dow` 와 같은 값)
// 한 곳이고, 여기서는 그것에서 파생된 `regularRoundDateOf` 를 경유만 한다.
//
// 기대값은 손계산 리터럴이다. 달력 사실(2026): 07-24 금 · 07-27 월 · 07-31 금 · 08-07 금.
import { describe, it, expect } from "vitest";
import { regularRoundDateOf, REGULAR_ROUND_DOW } from "@/lib/kpi/period-compare-week";
import { trendBucketLabelFormatter, trendBucketLabel } from "../../dashboard/_components/live-trend-chart";
import type { LiveTrendPoint } from "../../dashboard/_data/live";

const fmt = trendBucketLabelFormatter("ko");
const md = (iso: string) =>
  new Intl.DateTimeFormat("ko", { month: "numeric", day: "numeric", timeZone: "UTC" })
    .format(new Date(iso));

/** 결측 주를 채운 버킷 — 회차가 없으므로 값도 `firstAt` 도 없다. */
const filled = (bucketStart: string, roundDate?: string): LiveTrendPoint => ({
  bucketStart,
  ...(roundDate ? { roundDate } : {}),
  firstAt: null, values: {}, measuredDays: 0, answers: 0, lastAt: null,
});

describe("정규 요일 상수는 한 곳에서 온다", () => {
  it("website = 금(5) · global = 월(1)", () => {
    expect(REGULAR_ROUND_DOW.website).toBe(5);
    expect(REGULAR_ROUND_DOW.global).toBe(1);
  });

  it("버킷 월요일 → website 는 +4일, global 은 그대로", () => {
    expect(regularRoundDateOf("website", "2026-07-27")).toBe("2026-07-31");
    expect(regularRoundDateOf("global", "2026-07-27")).toBe("2026-07-27");
  });
});

describe("채운 버킷의 라벨 (축 on)", () => {
  it("website 결측 주 07-27 버킷 → 라벨 **2026-07-31**(금)", () => {
    expect(trendBucketLabel(fmt, filled("2026-07-27", "2026-07-31"), "week", "anchor")).toBe(
      md("2026-07-31T00:00:00Z"),
    );
  });

  it("관찰된 11점 열이 **전부 금요일·7일 간격·유일**이 된다", () => {
    // 실측 버킷(주 월요일) 열 — 07-27 만 데이터가 없는 채움 버킷이다.
    const buckets = [
      "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20",
      "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17",
      "2026-08-24", "2026-08-31", "2026-09-07",
    ];
    const points = buckets.map((b) => filled(b, regularRoundDateOf("website", b)));
    const days = points.map((p) => p.roundDate!);
    expect(days).toEqual([
      "2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24",
      "2026-07-31", "2026-08-07", "2026-08-14", "2026-08-21",
      "2026-08-28", "2026-09-04", "2026-09-11",
    ]);
    // 전부 금요일(UTC 기준 getUTCDay() === 5) · 유일 · 7일 간격.
    for (const d of days) expect(new Date(`${d}T00:00:00Z`).getUTCDay()).toBe(5);
    expect(new Set(days).size).toBe(days.length);
    for (let i = 1; i < days.length; i += 1) {
      const gap =
        (Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)) / 86_400_000;
      expect(gap).toBe(7);
    }
    // 라벨도 같은 열이다.
    expect(points.map((p) => trendBucketLabel(fmt, p, "week", "anchor"))).toEqual(
      days.map((d) => md(`${d}T00:00:00Z`)),
    );
  });

  it("글로벌은 무변화 — 채운 버킷 라벨이 버킷 키와 같다", () => {
    const b = "2026-08-31";
    expect(
      trendBucketLabel(fmt, filled(b, regularRoundDateOf("global", b)), "week", "anchor"),
    ).toBe(trendBucketLabel(fmt, filled(b), "week", "anchor"));
  });

  it("프로젝트 표면(정규 요일 없음)은 버킷 키 그대로다", () => {
    expect(trendBucketLabel(fmt, filled("2026-07-27"), "week", "anchor")).toBe(
      md("2026-07-27T00:00:00Z"),
    );
  });

  it("축 off 는 무변경 — `roundDate` 가 실려 있어도 안 쓴다", () => {
    // 채운 버킷은 `firstAt` 이 null 이라 종전 규칙도 `bucketStart` 로 떨어진다.
    expect(trendBucketLabel(fmt, filled("2026-07-27", "2026-07-31"), "week")).toBe(
      md("2026-07-27T00:00:00Z"),
    );
  });
});
