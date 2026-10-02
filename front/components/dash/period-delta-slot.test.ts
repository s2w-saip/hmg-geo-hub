import { describe, expect, it } from "vitest";
import { selectPeriodResult } from "./period-delta-slot";
import {
  KPI_KEY_TO_COMPARE_METRIC,
  PRESET_DAYS,
  compareMetricForKpiKey,
  compareMetricForKpiTab,
  windowDaysOf,
} from "./period-delta-metrics";
import type { CompareResult } from "@/lib/kpi/period-compare";

// C4 의 "분기 1곳" 규율을 값으로 고정한다. 슬롯 컴포넌트의 렌더는
// `delta-chip.render.test.tsx` 와 off 패리티 골든이 덮는다.

const r = (metric: CompareResult["metric"]): CompareResult => ({
  metric,
  unit: "pp",
  prev: 1,
  cur: 2,
  delta: 1,
  suppressed: false,
  reason: null,
  cyclesPrev: 1,
  cyclesCur: 1,
  plannedPrev: 10,
  plannedCur: 10,
  missingSharePrev: 0,
  missingShareCur: 0,
});

describe("selectPeriodResult — 켜짐 판정", () => {
  it("결과가 없으면 null (= 종전 Δ 경로)", () => {
    expect(selectPeriodResult(null, "visibility")).toBeNull();
    expect(selectPeriodResult(undefined, "visibility")).toBeNull();
    expect(selectPeriodResult([], "visibility")).toBeNull();
  });

  it("지표가 null 이면 null — 계약 6지표 밖 카드는 종전 Δ 를 그린다", () => {
    expect(selectPeriodResult([r("visibility")], null)).toBeNull();
    expect(selectPeriodResult([r("visibility")], undefined)).toBeNull();
  });

  it("목록에 그 지표가 없으면 null", () => {
    expect(selectPeriodResult([r("visibility")], "position")).toBeNull();
  });

  it("있으면 그 결과를 고른다", () => {
    expect(selectPeriodResult([r("visibility"), r("position")], "position")?.metric).toBe("position");
  });
});

describe("지표 대응표", () => {
  it("대시보드·웹사이트 타일의 4개 코어 KPI 만 매핑된다", () => {
    expect(compareMetricForKpiKey("visibility")).toBe("visibility");
    expect(compareMetricForKpiKey("shareOfVoice")).toBe("share");
    expect(compareMetricForKpiKey("sentiment")).toBe("favorability");
    expect(compareMetricForKpiKey("position")).toBe("position");
  });

  it("⑤ AI 인용 점유율은 **범위 밖**이다 (design §6-2: 집계층과 화면 정본이 다르다)", () => {
    expect(compareMetricForKpiKey("citationShare")).toBeNull();
  });

  it("웹사이트 새 카드 2종·전환율은 범위 밖이다 (기간 미지정일 때만 Δ 현행 유지)", () => {
    for (const k of ["ownedUrlRate", "targetUrlRate", "citationAccuracy", "trafficConversion"]) {
      expect(compareMetricForKpiKey(k), k).toBeNull();
    }
  });

  it("모르는 키는 null 로 닫힌다 (기본값이 '비교함' 이면 안 된다)", () => {
    expect(compareMetricForKpiKey("nope")).toBeNull();
    expect(compareMetricForKpiTab("nope")).toBeNull();
  });

  it("4KPI 탭 히어로: exposure→visibility · sov→share", () => {
    expect(compareMetricForKpiTab("exposure")).toBe("visibility");
    expect(compareMetricForKpiTab("sov")).toBe("share");
  });

  it("대응표의 값은 전부 계약의 지표이거나 null 이다", () => {
    const allowed = new Set([
      "visibility",
      "share",
      "favorability",
      "position",
      "mentionsPerAnswer",
      "citationsPerAnswer",
      null,
    ]);
    for (const v of Object.values(KPI_KEY_TO_COMPARE_METRIC)) expect(allowed.has(v)).toBe(true);
  });
});

describe("windowDaysOf — 프리셋이든 캘린더 직접 지정이든 같은 규칙", () => {
  it("양 끝 포함 길이다 (N = hi − lo + 1)", () => {
    expect(windowDaysOf("2026-09-07", "2026-09-13")).toBe(7);
    expect(windowDaysOf("2026-08-31", "2026-09-13")).toBe(14);
    expect(windowDaysOf("2026-08-15", "2026-09-13")).toBe(30);
    expect(windowDaysOf("2026-09-13", "2026-09-13")).toBe(1);
  });

  it("프리셋 길이와 일치한다", () => {
    expect(windowDaysOf("2026-09-07", "2026-09-13")).toBe(PRESET_DAYS.weekly);
    expect(windowDaysOf("2026-08-31", "2026-09-13")).toBe(PRESET_DAYS.biweekly);
    expect(windowDaysOf("2026-08-15", "2026-09-13")).toBe(PRESET_DAYS.monthly);
  });

  it("한쪽만 채운 open-ended·역순·깨진 값은 null 이다", () => {
    expect(windowDaysOf("2026-09-07", null)).toBeNull();
    expect(windowDaysOf(null, "2026-09-13")).toBeNull();
    expect(windowDaysOf("2026-09-13", "2026-09-07")).toBeNull();
    expect(windowDaysOf("nope", "2026-09-13")).toBeNull();
  });

  it("월·연 경계를 UTC 로 넘는다", () => {
    expect(windowDaysOf("2025-12-26", "2026-01-01")).toBe(7);
    expect(windowDaysOf("2028-02-28", "2028-03-01")).toBe(3); // 윤년
  });
});
