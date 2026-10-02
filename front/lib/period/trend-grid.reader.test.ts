import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { TrendGridSlotRow } from "@/lib/db/repositories/trend-grid-slots";

// ════════════════════════════════════════════════════════════════════════════
// 리더 어댑터 — **키 off 면 DB 를 건드리지 않는다**
// ════════════════════════════════════════════════════════════════════════════
//
// "끄면 바이트 단위 무변경" 의 실체가 여기다: 어댑터가 판정을 하지 않고 호출부에
// 아무 값도 주지 않는다(`null`). 문장이 안 나가는 것을 **호출 횟수로** 고정한다 —
// 안 그러면 "꺼져 있는데 왕복만 는" 상태가 화면에는 안 보인다.

const row = (roundDate: string, servable = 1): TrendGridSlotRow => ({
  roundDate,
  // 글로벌 자리는 월요일이라 자리 날짜가 곧 주 월요일이다(`hmg_anchor_week(round_date)`).
  anchorWeek: roundDate,
  cycleIds: [`c-${roundDate}`],
  totalCycles: 1,
  assignedCycles: 1,
  servableCycles: servable,
  collectionErrorCycles: 0,
  operatorCycles: 0,
  completionRatio: 1,
});

/** W0 실측의 글로벌 15자리(전부 월요일). */
const MON = [
  "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06",
  "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10",
  "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14",
];

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

describe("buildTrendGrid", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function load(enabled: boolean, rows: TrendGridSlotRow[] | null = MON.map((d) => row(d))) {
    const readSpy = vi.fn(async () => rows);
    vi.doMock("@/lib/db/repositories/trend-grid-slots", () => ({ trendGridSlotRows: readSpy }));
    vi.doMock("./trend-grid-flag", () => ({ ensureTrendGrid: async () => enabled }));
    const mod = await import("./trend-grid");
    return { mod, readSpy };
  }

  it("키가 꺼져 있으면 null 이고 **원장 문장이 나가지 않는다**", async () => {
    const { mod, readSpy } = await load(false);
    expect(await mod.buildTrendGrid({ surface: "global", projectIds: [ROOT], family: "all" })).toBeNull();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("키가 켜지면 최신 13자리를 낸다", async () => {
    const { mod, readSpy } = await load(true);
    const slots = await mod.buildTrendGrid({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
    });
    expect(slots).not.toBeNull();
    expect(slots).toHaveLength(13);
    expect(slots?.[0].roundDate).toBe("2026-06-22");
    expect(slots?.[12].roundDate).toBe("2026-09-14");
    expect(readSpy).toHaveBeenCalledWith({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
      maxDays: mod.TREND_GRID_MAX_DAYS,
    });
  });

  // 판정 불가(표 없음·DB 오류)는 빈 배열("자리가 없다")과 다른 명제다 — 섞지 않는다.
  it("원장 조회가 판정 불가(null)면 격자도 null 이다", async () => {
    const { mod } = await load(true, null);
    expect(
      await mod.buildTrendGrid({ surface: "website", projectIds: [ROOT], family: "all" }),
    ).toBeNull();
  });

  it("원장이 **자리가 없다고 답하면** 빈 배열이다(null 이 아니다)", async () => {
    const { mod } = await load(true, []);
    expect(
      await mod.buildTrendGrid({ surface: "website", projectIds: [ROOT], family: "all" }),
    ).toEqual([]);
  });

  it("프로젝트 목록은 정렬·중복 제거된 캐시 키로 접힌다", async () => {
    const other = "11111111-2222-4333-8444-555555555555";
    const { mod, readSpy } = await load(true);
    await mod.buildTrendGrid({ surface: "website", projectIds: [other, ROOT, other], family: "mentions" });
    expect(readSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectIds: [ROOT, other].sort(), family: "mentions" }),
    );
  });
});

