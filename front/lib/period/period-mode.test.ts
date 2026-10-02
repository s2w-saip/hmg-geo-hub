import { describe, it, expect } from "vitest";
import {
  hasPeriod,
  isCumulativePeriod,
  resolvePeriodMode,
  type PeriodFilterLike,
} from "./period-mode";

// 네 벌이던 판정을 한 리졸버로 모았다. 여기서 고정하는 것은 **진리표** 다 —
// 호출부(scope-aggregates::cumulativeMode · gate::mirrorCumulative ·
// period-route-flag::hasPeriod · website 페이지)가 각자 종전 인자를 그대로 넘기므로
// 이 표가 같으면 값이 안 바뀐 것이다.

const FROM = "2026-08-20";
const TO = "2026-09-04";

const CASES: Array<[string, PeriodFilterLike]> = [
  ["빈 필터", {}],
  ["dateFrom 만", { dateFrom: FROM }],
  ["dateTo 만", { dateTo: TO }],
  ["기간", { dateFrom: FROM, dateTo: TO }],
  ["cumulative 만", { cumulative: true }],
  ["cumulative + dateFrom", { cumulative: true, dateFrom: FROM }],
  ["cumulative + 기간", { cumulative: true, dateFrom: FROM, dateTo: TO }],
  ["cumulative:false + 기간", { cumulative: false, dateFrom: FROM, dateTo: TO }],
  ["null 날짜", { dateFrom: null, dateTo: null }],
  ["빈 문자열 날짜", { dateFrom: "", dateTo: "" }],
];

describe("기간 모드 리졸버 — 진리표", () => {
  it.each(CASES)("%s", (_name, f) => {
    // 종전 세 식을 그대로 재현한 기준값(리팩터 전 소스에서 옮김).
    const legacyHasPeriod = Boolean(f.dateFrom || f.dateTo);
    const legacyMirrorCumulative = f.cumulative === true && legacyHasPeriod;
    const legacyCumulativeMode = (allRuns?: boolean) =>
      f.cumulative === true && allRuns !== true && (!!f.dateFrom || !!f.dateTo);

    expect(hasPeriod(f)).toBe(legacyHasPeriod);
    expect(isCumulativePeriod(f)).toBe(legacyMirrorCumulative);
    expect(isCumulativePeriod(f, { allRuns: true })).toBe(legacyCumulativeMode(true));
    expect(isCumulativePeriod(f, { allRuns: false })).toBe(legacyCumulativeMode(false));
  });

  it("추이(allRuns)는 누적·스냅샷과 다른 모드다", () => {
    const f = { cumulative: true, dateFrom: FROM, dateTo: TO };
    expect(resolvePeriodMode(f)).toBe("cumulative");
    expect(resolvePeriodMode(f, { allRuns: true })).toBe("trend");
    expect(resolvePeriodMode({ cumulative: true })).toBe("snapshot");
    expect(resolvePeriodMode({ dateFrom: FROM })).toBe("snapshot");
  });
});
