import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SummaryCyclePick,
  CycleRangeRow,
  WebsiteCyclePickResult,
  CycleRangeQuery,
} from "@/lib/db/repositories/summary-cycles";

// ════════════════════════════════════════════════════════════════════════════
// 앵커 축(0077) — **집계층 게이트**의 회차 집합 판정 (DB 없이)
// ════════════════════════════════════════════════════════════════════════════
//
// 계약: `notes/hmg-anchor-table/streams/CONTRACT.md` §3.
//
// 고정하는 것 넷:
//   ① 축이 꺼져 있으면 판정도 **호출 모양도** 종전과 같다(인자를 싣지 않는다).
//   ② 축이 켜지면 기간 판정이 `round_date`(회차 귀속 날짜, KST)를 본다 — 앵커의
//      UTC 일자가 아니다. 둘이 갈리는 회차에서 판정이 실제로 뒤집히는 것을 본다.
//   ③ 한 `round_date` 에 회차가 둘 합쳐진 자리는 **한 회차**로 센다(`anchorCount`).
//   ④ 매핑이 안 실린 회차(`roundDate` 없음)는 종전 축으로 접힌다.
//
// 날짜 기대값은 손계산 리터럴이다.
//   · `2026-09-10T22:35:00Z` = KST 2026-09-11 07:35 → 앵커 KST 일자 09-11,
//     UTC 일자 09-10. 매핑이 글로벌 정규 요일(월)인 09-07 로 앉혔다고 본다.

const pickWebsiteCycles =
  vi.fn<[string[], { anchorAxis?: boolean }?], Promise<WebsiteCyclePickResult | null>>();
const pickGlobalCycle =
  vi.fn<[string, { anchorAxis?: boolean }?], Promise<SummaryCyclePick | null>>();
const pickCyclesInRange = vi.fn<[CycleRangeQuery], Promise<CycleRangeRow[] | null>>();

// ⚠️ 인자를 **펼쳐서** 넘긴다. `(a, o) => spy(a, o)` 로 쓰면 호출부가 인자를 하나만
// 줘도 스파이는 `undefined` 를 두 번째로 받아 "호출 모양이 종전과 같다" 는 단언이
// 모킹 방식 때문에 깨진다(구현이 아니라 테스트의 결함이 된다).
vi.mock("@/lib/db/repositories/summary-cycles", () => ({
  pickWebsiteCycles: (...a: [string[], { anchorAxis?: boolean }?]) => pickWebsiteCycles(...a),
  pickGlobalCycle: (...a: [string, { anchorAxis?: boolean }?]) => pickGlobalCycle(...a),
  pickCyclesInRange: (q: CycleRangeQuery) => pickCyclesInRange(q),
}));

const { resolveCycleSet, judgeCycleRange, dateRangeReason, cycleDayOf, restrictToFleetVisible } =
  await import("./cycle-set");

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

const pick = (over: Partial<SummaryCyclePick> = {}): SummaryCyclePick => ({
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: P1,
  // KST 09-11 07:35 / UTC 09-10 — 두 축이 갈리는 시각이다.
  cycleAnchorAt: "2026-09-10T22:35:00.000Z",
  cycleWeek: "2026-09-07",
  ...over,
});

const row = (over: Partial<CycleRangeRow> = {}): CycleRangeRow => ({
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: P1,
  cycleAnchorAt: "2026-09-10T22:35:00.000Z",
  cycleWeek: "2026-09-07",
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

beforeEach(() => {
  pickWebsiteCycles.mockReset();
  pickGlobalCycle.mockReset();
  pickCyclesInRange.mockReset();
});

describe("cycleDayOf — 축 라우터", () => {
  it("종전 축은 앵커의 UTC 일자, 앵커 축은 귀속 날짜", () => {
    const c = { cycleAnchorAt: "2026-09-10T22:35:00.000Z", roundDate: "2026-09-07" };
    expect(cycleDayOf(c)).toBe("2026-09-10");
    expect(cycleDayOf(c, true)).toBe("2026-09-07");
  });

  it("귀속 날짜가 안 실렸으면 앵커 축이어도 종전 축으로 접힌다", () => {
    expect(cycleDayOf({ cycleAnchorAt: "2026-09-10T22:35:00.000Z" }, true)).toBe("2026-09-10");
    expect(cycleDayOf({ cycleAnchorAt: "2026-09-10T22:35:00.000Z", roundDate: null }, true)).toBe(
      "2026-09-10",
    );
  });
});

describe("dateRangeReason — 스냅샷의 '회차 하나' 판정", () => {
  const cycles = [pick({ roundDate: "2026-09-07" })];

  it("종전 축: 09-10(UTC 앵커일)만 범위 안이다", () => {
    expect(dateRangeReason({ dateFrom: "2026-09-10", dateTo: "2026-09-10" }, cycles)).toBeNull();
    expect(dateRangeReason({ dateFrom: "2026-09-07", dateTo: "2026-09-07" }, cycles)).toBe(
      "range-outside-cycle",
    );
  });

  it("앵커 축: 같은 회차가 09-07(귀속 날짜)로 뒤집힌다", () => {
    const o = { anchorAxis: true };
    expect(dateRangeReason({ dateFrom: "2026-09-07", dateTo: "2026-09-07" }, cycles, o)).toBeNull();
    expect(dateRangeReason({ dateFrom: "2026-09-10", dateTo: "2026-09-10" }, cycles, o)).toBe(
      "range-outside-cycle",
    );
  });

  it("앵커 축: 한 귀속 날짜에 합쳐진 회차 둘은 `range-multi-cycle` 이 아니다", () => {
    const merged = [
      pick({ cycleId: "c-1", roundDate: "2026-09-07", cycleAnchorAt: "2026-09-06T22:00:00.000Z" }),
      pick({ cycleId: "c-2", roundDate: "2026-09-07", cycleAnchorAt: "2026-09-10T22:35:00.000Z" }),
    ];
    // 종전 축에서는 UTC 일자가 09-06 · 09-10 둘이라 폴백이었다.
    expect(dateRangeReason({ dateFrom: "2026-09-01", dateTo: "2026-09-30" }, merged)).toBe(
      "range-multi-cycle",
    );
    expect(
      dateRangeReason({ dateFrom: "2026-09-01", dateTo: "2026-09-30" }, merged, {
        anchorAxis: true,
      }),
    ).toBeNull();
  });
});

describe("judgeCycleRange — 회차 수(anchorCount) 단위", () => {
  it("앵커 축: 합쳐진 자리는 한 회차 · 종전 축: 두 회차", () => {
    const rows = [
      row({ cycleId: "c-1", roundDate: "2026-09-07", cycleAnchorAt: "2026-09-06T22:00:00.000Z" }),
      row({ cycleId: "c-2", roundDate: "2026-09-07", cycleAnchorAt: "2026-09-10T22:35:00.000Z" }),
    ];
    const off = judgeCycleRange("global", [P1], rows);
    const on = judgeCycleRange("global", [P1], rows, { anchorAxis: true });
    expect(off.ok && off.set.anchorCount).toBe(2);
    expect(on.ok && on.set.anchorCount).toBe(1);
    // 회차 자체는 둘 다 남는다 — 세는 단위만 바뀐다(합산은 회차 단위 그대로다).
    expect(on.ok && on.set.cycles.length).toBe(2);
    // 파티션 키는 축과 무관하게 `cycle_week` 다.
    expect(on.ok && on.set.weeks).toEqual(["2026-09-07"]);
  });

  it("판정(구멍·주 중복·빈 집합)은 축과 무관하다", () => {
    const hole = [row({ renderable: false, status: "closed", analysisGapRatio: 0 })];
    expect(judgeCycleRange("global", [P1], hole).ok).toBe(false);
    expect(judgeCycleRange("global", [P1], hole, { anchorAxis: true }).ok).toBe(false);

    const dupWeek = [
      row({ cycleId: "c-1", roundDate: "2026-09-07" }),
      row({ cycleId: "c-2", roundDate: "2026-09-11" }),
    ];
    expect(judgeCycleRange("website", [P1], dupWeek, { anchorAxis: true }).ok).toBe(false);
  });

  it("귀속 날짜는 회차에 실려 나간다(집계층이 같은 값을 본다)", () => {
    const res = judgeCycleRange("global", [P1], [row({ roundDate: "2026-09-07" })], {
      anchorAxis: true,
    });
    expect(res.ok && res.set.cycles[0]?.roundDate).toBe("2026-09-07");
    // 안 실렸으면 필드 자체가 없다 — 캐시 키가 이유 없이 갈리지 않게.
    const plain = judgeCycleRange("global", [P1], [row()]);
    expect(plain.ok && "roundDate" in plain.set.cycles[0]!).toBe(false);
  });
});

describe("restrictToFleetVisible — 거른 뒤에도 회차 수 단위가 유지된다", () => {
  it("남은 회차가 귀속 날짜를 실었으면 anchorCount 도 그 단위다", () => {
    const set = judgeCycleRange(
      "global",
      [P1],
      [
        row({ cycleId: "c-1", roundDate: "2026-09-07", fleetVisible: true }),
        row({
          cycleId: "c-2",
          roundDate: "2026-09-07",
          cycleAnchorAt: "2026-09-11T02:00:00.000Z",
          fleetVisible: false,
        }),
      ],
      { anchorAxis: true },
    );
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const kept = restrictToFleetVisible(set.set);
    expect(kept.cycles.map((c) => c.cycleId)).toEqual(["c-1"]);
    expect(kept.anchorCount).toBe(1);
  });
});

describe("resolveCycleSet — 축 인자 전달", () => {
  it("꺼져 있으면 리포지터리 호출 모양이 종전 그대로다(인자 없음)", async () => {
    pickCyclesInRange.mockResolvedValue([row()]);
    await resolveCycleSet({
      surface: "website",
      mode: "period",
      projectIds: [P1, P2],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
    });
    expect(pickCyclesInRange).toHaveBeenCalledWith({
      surface: "website",
      projectIds: [P1, P2],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
    });

    pickGlobalCycle.mockResolvedValue(pick());
    await resolveCycleSet({ surface: "global", mode: "snapshot", projectIds: [ROOT] });
    expect(pickGlobalCycle).toHaveBeenCalledWith(ROOT);

    pickWebsiteCycles.mockResolvedValue({ cycles: [pick()], missingProjectIds: [] });
    await resolveCycleSet({ surface: "website", mode: "snapshot", projectIds: [P1] });
    expect(pickWebsiteCycles).toHaveBeenCalledWith([P1]);
  });

  it("켜져 있으면 `anchorAxis: true` 가 리포지터리까지 내려간다", async () => {
    pickCyclesInRange.mockResolvedValue([row({ roundDate: "2026-09-07" })]);
    const res = await resolveCycleSet({
      surface: "global",
      mode: "period",
      projectIds: [ROOT],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      anchorAxis: true,
    });
    expect(pickCyclesInRange).toHaveBeenCalledWith({
      surface: "global",
      projectIds: [ROOT],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      anchorAxis: true,
    });
    expect(res.ok && res.set.anchorCount).toBe(1);

    pickGlobalCycle.mockResolvedValue(pick({ roundDate: "2026-09-07" }));
    await resolveCycleSet({
      surface: "global",
      mode: "snapshot",
      projectIds: [ROOT],
      anchorAxis: true,
    });
    expect(pickGlobalCycle).toHaveBeenCalledWith(ROOT, { anchorAxis: true });
  });

  it("스냅샷 기간 판정이 귀속 날짜로 간다 — 종전 축이면 폴백인 요청이 통과한다", async () => {
    pickGlobalCycle.mockResolvedValue(pick({ roundDate: "2026-09-07" }));
    const off = await resolveCycleSet({
      surface: "global",
      mode: "snapshot",
      projectIds: [ROOT],
      dateFrom: "2026-09-07",
      dateTo: "2026-09-07",
    });
    expect(off.ok).toBe(false);
    expect(!off.ok && off.reason).toBe("range-outside-cycle");

    const on = await resolveCycleSet({
      surface: "global",
      mode: "snapshot",
      projectIds: [ROOT],
      dateFrom: "2026-09-07",
      dateTo: "2026-09-07",
      anchorAxis: true,
    });
    expect(on.ok).toBe(true);
  });
});
