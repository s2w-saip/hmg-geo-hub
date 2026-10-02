import { describe, expect, it } from "vitest";
import {
  applyTrendDeltas,
  deltaTrendFilters,
  DELTA_TREND_BUCKET,
  DELTA_TREND_WINDOW_DAYS,
  type LiveTrend,
  type LiveTrendPoint,
} from "./live";
import type { KpiSummary } from "./sample";

// KPI 카드 Δ 의 **출처 계약**을 고정한다 (2026-09-03).
//
// 왜 이 테스트가 있나: 대시보드는 추이 롤업을 두 번 부른다 — TREND 구획이 화면
// 버킷(week)으로, SUMMARY 구획이 Δ 전용으로 day·최근 30일. 감사 로그 7일 실측
// standardTrend 1,289 vs standardAggregates 652 ≈ 1.98배가 그 2회다.
// "화면 추이에서 Δ 를 파생하면 1회로 준다"는 최적화는 **Δ 숫자를 바꾼다**
// (주간 Δ ≠ 일간 Δ). 그 변경이 조용히 들어오지 못하게 현 규칙을 못 박는다.
//
// 표면별 현황(코드 대조): /website 는 이미 자기가 그리는 추이에서 Δ 를 뽑고
// (website/page.tsx: applyTrendDeltas(live.kpis, trend)), /dashboard·/projects 는
// 별도 day 롤업을 쓴다. 통합은 산식 변경이라 제품 결정 사항.

const pt = (
  bucketStart: string,
  values: LiveTrendPoint["values"],
): LiveTrendPoint => ({
  bucketStart,
  firstAt: `${bucketStart}T00:00:00.000Z`,
  values,
  measuredDays: 1,
  answers: 10,
  lastAt: `${bucketStart}T23:59:59.000Z`,
});

const trendOf = (unit: LiveTrend["unit"], points: LiveTrendPoint[]): LiveTrend => ({
  unit,
  points,
  lastMeasuredAt: points[points.length - 1]?.lastAt ?? null,
  totalAnswers: points.reduce((s, p) => s + p.answers, 0),
});

const kpi = (key: string): KpiSummary =>
  ({ key, value: 0, delta: null, direction: "flat" } as unknown as KpiSummary);

describe("deltaTrendFilters — Δ 전용 롤업의 창", () => {
  const NOW = Date.parse("2026-09-03T04:00:00.000Z");

  it("기간 필터가 없으면 최근 30일로 바운드한다", () => {
    const out = deltaTrendFilters({ region: ["KR"] }, NOW);
    expect(DELTA_TREND_WINDOW_DAYS).toBe(30);
    expect(out.dateFrom).toBe("2026-08-04");
    expect(out.dateTo).toBeUndefined();
    expect(out.region).toEqual(["KR"]);
  });

  it("사용자 기간(dateFrom)이 있으면 **같은 객체를** 그대로 쓴다", () => {
    const f = { dateFrom: "2026-08-01" };
    expect(deltaTrendFilters(f, NOW)).toBe(f);
  });

  it("dateTo 만 있어도 주입하지 않는다 (기간 의미론 보존)", () => {
    const f = { dateTo: "2026-08-31" };
    expect(deltaTrendFilters(f, NOW)).toBe(f);
  });

  it("Δ 롤업의 버킷은 day 다 — 화면 버킷(week)과 별개", () => {
    expect(DELTA_TREND_BUCKET).toBe("day");
  });
});

describe("applyTrendDeltas — '값이 있는 마지막 두 버킷'", () => {
  it("빈 버킷(값 없음)을 건너뛰고 값이 있는 마지막 둘을 비교한다", () => {
    const trend = trendOf("day", [
      pt("2026-08-30", { visibility: 40 }),
      pt("2026-08-31", {}), // 측정 없음 placeholder
      pt("2026-09-01", { visibility: 46.2 }),
    ]);
    const [out] = applyTrendDeltas([kpi("visibility")], trend);
    expect(out.delta).toBe(6.2);
    expect(out.direction).toBe("up");
  });

  it("KPI 키마다 '마지막 두 값'이 다를 수 있다 (키별로 독립 탐색)", () => {
    const trend = trendOf("day", [
      pt("2026-08-30", { visibility: 40, citationShare: 10 }),
      pt("2026-08-31", { visibility: 41 }), // 인용 없는 날 → citationShare 없음
      pt("2026-09-01", { visibility: 43, citationShare: 12.5 }),
    ]);
    const out = applyTrendDeltas([kpi("visibility"), kpi("citationShare")], trend);
    expect(out[0].delta).toBe(2); // 43 - 41
    expect(out[1].delta).toBe(2.5); // 12.5 - 10 (하루 건너뜀)
  });

  it("값이 1개뿐이면 delta 를 넣지 않는다 (칩 숨김)", () => {
    const trend = trendOf("day", [pt("2026-09-01", { visibility: 43 })]);
    const [out] = applyTrendDeltas([kpi("visibility")], trend);
    expect(out.delta).toBeNull();
  });

  it("반올림 후 ±0.05 미만은 flat", () => {
    const trend = trendOf("day", [
      pt("2026-08-31", { visibility: 40.02 }),
      pt("2026-09-01", { visibility: 40.03 }),
    ]);
    const [out] = applyTrendDeltas([kpi("visibility")], trend);
    expect(out.direction).toBe("flat");
  });

  it("trend 가 null 이면 원본을 그대로 돌려준다", () => {
    const items = [kpi("visibility")];
    expect(applyTrendDeltas(items, null)).toBe(items);
  });
});

describe("2회→1회 통합은 Δ 를 바꾼다 (조용한 치환 방지)", () => {
  // 같은 실측을 day 로 접으면 마지막 두 '날', week 로 접으면 마지막 두 '주'다.
  // 프로덕션 실측(2026-09-03, 표준 루트)에서 마지막 두 측정일은
  // 09-01(6 답변)과 08-31(61,112 답변)이라 day Δ 는 6-답변 하루를 6만-답변 하루와
  // 비교한다 — 주간 Δ 와 같은 값이 나올 이유가 없다.
  it("day 롤업의 Δ 와 week 롤업의 Δ 는 같지 않다", () => {
    const daily = trendOf("day", [
      pt("2026-08-25", { visibility: 30 }),
      pt("2026-08-31", { visibility: 50 }),
      pt("2026-09-01", { visibility: 52 }),
    ]);
    const weekly = trendOf("week", [
      pt("2026-08-24", { visibility: 30 }),
      pt("2026-08-31", { visibility: 51 }), // 08-31+09-01 이 한 주로 접힘
    ]);
    const dayDelta = applyTrendDeltas([kpi("visibility")], daily)[0].delta;
    const weekDelta = applyTrendDeltas([kpi("visibility")], weekly)[0].delta;
    expect(dayDelta).toBe(2);
    expect(weekDelta).toBe(21);
    expect(dayDelta).not.toBe(weekDelta);
  });
});
