import { describe, it, expect, vi } from "vitest";
import type {
  SummaryCyclePick,
  CycleRangeRow,
  CycleRangeQuery,
  WebsiteCyclePickResult,
} from "@/lib/db/repositories/summary-cycles";
import {
  TREND_COMPLETION_MIN,
  completionRatioFromUnits,
  slotIsIncomplete,
} from "./cycle-completion";

// 회차 완결성 갭 — 설계 §4-A 의 **뒷문장**("임계 미만이면 그 자리를 갭으로").
//
// 여기서 고정하는 것 넷:
//   ① 임계 경계 — 0.8999 는 갭, 0.9 는 점.
//   ② 자리에 회차가 여럿이면 **최대값**이다(합산 자리에서 완주 회차가 이긴다).
//   ③ 모르면(카운터 없음) 갭이 아니다 — 갭은 고객이 보던 점을 지운다.
//   ④ 격자가 꺼져 있으면 `restrictToCompleteCycles` 가 **같은 객체**를 돌려준다
//      (캐시 키가 `JSON.stringify(set)` 이라 필드 하나만 늘어도 전 셀이 미스다).

const pickWebsiteCycles = vi.fn<[string[]], Promise<WebsiteCyclePickResult | null>>();
const pickGlobalCycle = vi.fn<[string], Promise<SummaryCyclePick | null>>();
const pickCyclesInRange = vi.fn<[CycleRangeQuery], Promise<CycleRangeRow[] | null>>();

vi.mock("@/lib/db/repositories/summary-cycles", () => ({
  pickWebsiteCycles: (ids: string[]) => pickWebsiteCycles(ids),
  pickGlobalCycle: (root: string) => pickGlobalCycle(root),
  pickCyclesInRange: (q: CycleRangeQuery) => pickCyclesInRange(q),
}));

const { judgeCycleRange, restrictToCompleteCycles } = await import("./cycle-set");

const P1 = "11111111-1111-1111-1111-111111111111";

const row = (over: Partial<CycleRangeRow> = {}): CycleRangeRow => ({
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: P1,
  cycleAnchorAt: "2026-09-04T00:00:00.000Z",
  cycleWeek: "2026-08-31",
  status: "published",
  renderable: true,
  pending: false,
  analysisGapRatio: 0,
  expectedUnits: 100,
  completedUnits: 100,
  hidden: false,
  hiddenScope: "all",
  fleetVisible: true,
  ...over,
});

const pick = (over: Partial<SummaryCyclePick> = {}): SummaryCyclePick => ({
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: P1,
  cycleAnchorAt: "2026-09-04T00:00:00.000Z",
  cycleWeek: "2026-08-31",
  ...over,
});

const setOf = (cycles: SummaryCyclePick[]) => ({
  surface: "global" as const,
  mode: "period" as const,
  cycles,
  cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
  projectIds: [...new Set(cycles.map((c) => c.projectId))],
  missingProjectIds: [],
  weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
  anchorCount: new Set(cycles.map((c) => c.roundDate ?? c.cycleAnchorAt.slice(0, 10))).size,
});

describe("completionRatioFromUnits — 원장 정의의 되계산", () => {
  it("expected > 0 이면 completed/expected", () => {
    expect(completionRatioFromUnits(100, 50)).toBe(0.5);
    expect(completionRatioFromUnits(38600, 38568)).toBeCloseTo(0.99917, 5);
  });

  // 원장 SQL 이 `CASE WHEN expected > 0 THEN … END` 라 그 밖은 NULL 이다.
  it("expected 가 0·null 이거나 completed 가 null 이면 null(=모른다)", () => {
    expect(completionRatioFromUnits(0, 0)).toBeNull();
    expect(completionRatioFromUnits(null, 10)).toBeNull();
    expect(completionRatioFromUnits(100, null)).toBeNull();
    expect(completionRatioFromUnits(undefined, undefined)).toBeNull();
  });
});

describe("slotIsIncomplete — 임계 경계", () => {
  it("임계 상수는 0.9 다 (W0 실측: 0.499 와 0.927 사이)", () => {
    expect(TREND_COMPLETION_MIN).toBe(0.9);
  });

  it("0.8999 는 갭, 0.9 는 점", () => {
    expect(slotIsIncomplete([0.8999])).toBe(true);
    expect(slotIsIncomplete([0.9])).toBe(false);
    expect(slotIsIncomplete([0.90001])).toBe(false);
  });

  // W0 실측 분포가 이 임계에서 **06-08 하나만** 갭이 되는 것을 고정한다.
  it("W0 실측 분포: 0.499 만 갭이고 0.927·0.957·0.99917 은 점이다", () => {
    expect(slotIsIncomplete([0.49933])).toBe(true);
    expect(slotIsIncomplete([0.92706])).toBe(false);
    expect(slotIsIncomplete([0.957])).toBe(false);
    expect(slotIsIncomplete([0.99917])).toBe(false);
  });

  // 자리의 값은 그 자리 회차들의 **합**이다 — 완주 회차 하나가 덮으면 갭이 아니다.
  // (08-17 자리: 대표 9,068유닛 완주 + 패자 906유닛 부분 → 갭이면 안 된다.)
  it("자리에 회차가 여럿이면 최대값이 이긴다", () => {
    expect(slotIsIncomplete([1.0, 0.3])).toBe(false);
    expect(slotIsIncomplete([0.3, 0.4])).toBe(true);
  });

  it("모르면(전부 null) 갭이 아니다", () => {
    expect(slotIsIncomplete([null, undefined])).toBe(false);
    expect(slotIsIncomplete([])).toBe(false);
    // 아는 값이 하나라도 있으면 그것으로 판정한다.
    expect(slotIsIncomplete([null, 0.2])).toBe(true);
  });
});

describe("judgeCycleRange — 완결성은 격자가 켜졌을 때만 실린다", () => {
  it("꺼져 있으면 픽에 completionRatio 키가 **없다**(캐시 키 불변)", () => {
    const out = judgeCycleRange("global", [P1], [row()], { anchorAxis: true });
    if (!out.ok) throw new Error(out.reason);
    expect(Object.hasOwn(out.set.cycles[0], "completionRatio")).toBe(false);
    // 키 문자열로도 고정한다 — 캐시 키는 이 직렬화다.
    expect(JSON.stringify(out.set.cycles[0])).not.toContain("completionRatio");
  });

  it("켜면 원장 카운터에서 되계산한 값이 실린다", () => {
    const out = judgeCycleRange(
      "global",
      [P1],
      [row({ expectedUnits: 1000, completedUnits: 499 })],
      { anchorAxis: true, trendGrid: true },
    );
    if (!out.ok) throw new Error(out.reason);
    expect(out.set.cycles[0].completionRatio).toBe(0.499);
  });

  it("카운터가 없으면 null 로 실린다(=모른다, 갭 아님)", () => {
    const out = judgeCycleRange(
      "global",
      [P1],
      [row({ expectedUnits: null, completedUnits: null })],
      { trendGrid: true },
    );
    if (!out.ok) throw new Error(out.reason);
    expect(out.set.cycles[0].completionRatio).toBeNull();
  });
});

describe("restrictToCompleteCycles", () => {
  it("격자 off(필드 없음) → **같은 객체**를 돌려주고 갭도 없다", () => {
    const set = setOf([pick({ roundDate: "2026-09-07" })]);
    const out = restrictToCompleteCycles(set);
    expect(out.set).toBe(set);
    expect(out.gapDays).toEqual([]);
  });

  it("전부 완결이면 같은 객체다(파생값 재계산 없음)", () => {
    const set = setOf([pick({ roundDate: "2026-09-07", completionRatio: 1 })]);
    const out = restrictToCompleteCycles(set);
    expect(out.set).toBe(set);
    expect(out.gapDays).toEqual([]);
  });

  it("미달 자리는 빠지고 그 자리 키가 갭으로 나온다", () => {
    const set = setOf([
      pick({ cycleId: "c1", roundDate: "2026-06-08", completionRatio: 0.499 }),
      pick({ cycleId: "c2", roundDate: "2026-06-15", completionRatio: 0.927 }),
    ]);
    const out = restrictToCompleteCycles(set);
    expect(out.gapDays).toEqual(["2026-06-08"]);
    expect(out.set.cycles.map((c) => c.cycleId)).toEqual(["c2"]);
    // 파생값이 거른 뒤 집합으로 다시 계산된다 — 캐시 키·회차 하한이 이 값을 본다.
    expect(out.set.anchorCount).toBe(1);
    expect(out.set.cycleKey).not.toBe(set.cycleKey);
  });

  it("한 자리에 회차가 둘이면 **자리 단위**로 판정한다(완주 회차가 덮으면 남는다)", () => {
    const set = setOf([
      pick({ cycleId: "rep", roundDate: "2026-08-17", completionRatio: 1 }),
      pick({ cycleId: "loser", roundDate: "2026-08-17", completionRatio: 0.1 }),
    ]);
    const out = restrictToCompleteCycles(set);
    expect(out.gapDays).toEqual([]);
    expect(out.set).toBe(set);
  });

  it("자리 전체가 미달이면 그 자리 회차가 **통째로** 빠진다", () => {
    const set = setOf([
      pick({ cycleId: "a", roundDate: "2026-08-17", completionRatio: 0.3 }),
      pick({ cycleId: "b", roundDate: "2026-08-17", completionRatio: 0.4 }),
      pick({ cycleId: "c", roundDate: "2026-08-24", completionRatio: 1 }),
    ]);
    const out = restrictToCompleteCycles(set);
    expect(out.gapDays).toEqual(["2026-08-17"]);
    expect(out.set.cycles.map((c) => c.cycleId)).toEqual(["c"]);
  });

  // 인용 제외 목록에 남은 id 가 있으면 리더 FILTER 가 없는 회차를 빼려 한다.
  it("인용 제외 목록도 함께 좁히고, 비면 필드를 싣지 않는다", () => {
    const base = setOf([
      pick({ cycleId: "a", roundDate: "2026-08-17", completionRatio: 0.3 }),
      pick({ cycleId: "c", roundDate: "2026-08-24", completionRatio: 1 }),
    ]);
    const out = restrictToCompleteCycles({ ...base, citationExcludedCycleIds: ["a"] });
    expect(Object.hasOwn(out.set, "citationExcludedCycleIds")).toBe(false);

    const kept = restrictToCompleteCycles({ ...base, citationExcludedCycleIds: ["a", "c"] });
    expect(kept.set.citationExcludedCycleIds).toEqual(["c"]);
  });

  // 축이 꺼진 집합(roundDate 없음)에서도 동작해야 한다 — 그때 자리 키는 앵커 UTC 일이다.
  it("축 off 집합에서는 자리 키가 앵커의 UTC 일이다", () => {
    const set = setOf([
      pick({ cycleId: "a", cycleAnchorAt: "2026-08-17T10:00:00.000Z", completionRatio: 0.2 }),
      pick({ cycleId: "b", cycleAnchorAt: "2026-08-24T10:00:00.000Z", completionRatio: 1 }),
    ]);
    const out = restrictToCompleteCycles(set);
    expect(out.gapDays).toEqual(["2026-08-17"]);
  });
});
