import { describe, expect, it } from "vitest";
import { sparkYDomain } from "./overview-kpi-cards";

// 고객 QA 2차 #1 — 오버뷰 "AI 우선 노출도" 카드 스파크라인의 y 축 과장.
//
// 재현: 순위 카드만 도메인이 `["auto","auto"]` 라 관측 스팬(2.5~3.0 = 0.5위)이 플롯
// 높이 100% 를 쓴다 → 0.5위 변동이 "카드를 관통하는 붕괴"로 읽힌다(고객 원문:
// "그래프 중간이 급격하게 하락한 것으로 보이는데 실제 수치는 3.0위").
//
// 규칙: 순위 카드는 상세 화면 추이 차트와 **같은 앵커**를 쓴다 —
// `[1, Math.max(5, Math.ceil(관측 최대))]` + reversed
// (rank-trend-chart.tsx:83-84 · _data/kpi-view.ts:1186 과 동일 산식).
// 비율 카드 4장은 현행 `[0,100]` 유지(과장 방향을 키우지 않는다).

const pt = (value: number | null) => ({ bucketStart: "2026-08-24", value, wow: null });

describe("sparkYDomain — 카드 스파크라인 y 도메인", () => {
  it("순위: 스크린샷 값(2.5~3.0)에서 [1,5] — 0.5위가 플롯을 다 먹지 않는다", () => {
    expect(sparkYDomain([pt(2.5), pt(2.5), pt(3.0), pt(2.5), pt(2.6)], true)).toEqual([1, 5]);
  });

  it("순위: 5위를 넘는 관측은 관측 최대를 올림해 담는다", () => {
    expect(sparkYDomain([pt(12), pt(23.2), pt(19.9)], true)).toEqual([1, 24]);
    expect(sparkYDomain([pt(19.9), pt(18.3)], true)).toEqual([1, 20]);
  });

  it("순위: 결측(갭)은 건너뛰고, 전부 결측·빈 배열이어도 유효 도메인", () => {
    expect(sparkYDomain([pt(null), pt(3.0), pt(null)], true)).toEqual([1, 5]);
    expect(sparkYDomain([pt(null), pt(null)], true)).toEqual([1, 5]);
    expect(sparkYDomain([], true)).toEqual([1, 5]);
  });

  it("비율: 현행 [0,100] 고정 유지", () => {
    expect(sparkYDomain([pt(19.2), pt(20.1)], false)).toEqual([0, 100]);
    expect(sparkYDomain([], false)).toEqual([0, 100]);
  });

  it("순위 도메인 스팬은 항상 4 이상 — 관측 스팬이 플롯 100% 를 차지할 수 없다", () => {
    for (const vals of [[3], [2.5, 3.0], [1, 1.1], [19.9, 19.8], [0.4]]) {
      const [lo, hi] = sparkYDomain(vals.map(pt), true);
      expect(hi - lo).toBeGreaterThanOrEqual(4);
    }
  });
});
