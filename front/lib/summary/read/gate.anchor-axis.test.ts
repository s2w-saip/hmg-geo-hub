import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * **게이트 → 회차 집합 → 측정 기준일**을 한 줄로 태우는 통합 단언 (검증 B2).
 *
 * 종전 `cycle-set.as-of.test.ts` 는 `roundDate` 를 **손으로 넣은** 입력만 봐서,
 * "게이트가 축을 확정하지 않아 `round_date` 가 애초에 안 실린다" 는 결함을 못 잡았다.
 * 여기서는 아무것도 손으로 넣지 않는다 — 게이트가 축을 확정하고, 그 값이
 * `resolveCycleSet` 을 지나 회차 행에 `roundDate` 를 싣고, `cycleSetAsOf` 가 그것을
 * 읽는 경로 전체를 돌린다.
 *
 * 회차 조회(`pickGlobalCycle`)는 **실제 SQL 의 계약을 흉내 낸 mock** 이다:
 * `opts.anchorAxis` 가 참일 때만 `round_date` 를 싣는다(`summary-cycles.ts` 의
 * `roundDateSelectFrag` 가 축이 꺼지면 열 자체를 안 붙이는 것과 같다).
 *
 * DB 접속 0 — 조회는 전부 mock 이고 축 판정은 `setAnchorAxisForTests` 로 고정한다.
 */

/** 손계산 기준값. 앵커는 KST 로 09-14 00:48, 귀속(월요일)은 09-14. */
const ANCHOR = "2026-09-13T15:48:44.000Z";
const ROUND = "2026-09-14";
const ROOT = "11111111-1111-4111-8111-111111111111";

/** 회차 픽스처 — 테스트마다 앵커·귀속 날짜를 갈아 끼운다. */
let fixture = { anchorAt: ANCHOR, roundDate: ROUND };

const pickGlobalCycle = vi.fn(
  async (_projectId: string, opts: { anchorAxis?: boolean } = {}) => ({
    cycleId: "aaaaaaaa-0000-4000-8000-000000000001",
    generationId: "bbbbbbbb-0000-4000-8000-000000000001",
    projectId: ROOT,
    cycleAnchorAt: fixture.anchorAt,
    cycleWeek: "2026-09-14",
    // SQL 계약: 축이 켜졌을 때만 열이 붙는다.
    ...(opts.anchorAxis ? { roundDate: fixture.roundDate } : {}),
  }),
);

vi.mock("@/lib/db/repositories/summary-cycles", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pickGlobalCycle: (...a: Parameters<typeof pickGlobalCycle>) => pickGlobalCycle(...a),
    pickCyclesInRange: async () => [],
    hasOpenCycle: async () => false,
  };
});

vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readEnabled: async () => true,
    summaryLedgerAvailable: async () => true,
    readScreensRaw: async () => "[]",
  };
});

const { resolveGlobalSummaryRouteBase } = await import("./gate");
const { cycleSetAsOf } = await import("./cycle-set");
const { setAnchorAxisForTests, resetAnchorAxisForTests } = await import(
  "@/lib/period/anchor-axis-state"
);

beforeEach(() => {
  vi.clearAllMocks();
  fixture = { anchorAt: ANCHOR, roundDate: ROUND };
});
afterEach(() => resetAnchorAxisForTests());

/** 게이트를 돌려 그 회차 집합의 측정 기준일을 낸다 — 중간에 손을 대지 않는다. */
async function asOfThroughGate(): Promise<string | null> {
  const route = await resolveGlobalSummaryRouteBase(ROOT, {});
  expect(route.path, `게이트가 폴백했다: ${JSON.stringify(route)}`).toBe("summary");
  if (route.path !== "summary") return null;
  return cycleSetAsOf(route.cycles);
}

describe("게이트 → asOf (기간 미지정 = 기본 화면)", () => {
  it("축 on — 회차에 round_date 가 실리고 asOf 가 귀속 날짜가 된다", async () => {
    setAnchorAxisForTests(true);
    expect(await asOfThroughGate()).toBe("2026-09-14");
    // 축이 실제로 회차 조회까지 내려갔는지 확인 — 값만 보면 폴백과 구분이 안 된다.
    expect(pickGlobalCycle).toHaveBeenCalledWith(ROOT, { anchorAxis: true });
  });

  it("축 off — 종전 그대로 앵커 ISO 이고 인자 자체가 안 실린다", async () => {
    setAnchorAxisForTests(false);
    expect(await asOfThroughGate()).toBe("2026-09-13T15:48:44.000Z");
    expect(pickGlobalCycle).toHaveBeenCalledWith(ROOT);
  });

  it("귀속 날짜가 앵커일과 다른 회차에서 화면 날짜가 실제로 갈린다", async () => {
    const { formatAsOfDate } = await import("@/lib/as-of-date");
    // §9.2 정규 요일 귀속: 앵커 09-17(목)인 잔여 회차가 09-18(금) 자리에 배정된 형태.
    // 손계산: 2026-09-17 01:00Z + 9h = 09-17 10:00 KST → 앵커 기준 화면 날짜는 09-17.
    fixture = { anchorAt: "2026-09-17T01:00:00.000Z", roundDate: "2026-09-18" };

    setAnchorAxisForTests(true);
    const on = formatAsOfDate((await asOfThroughGate())!);
    resetAnchorAxisForTests();
    setAnchorAxisForTests(false);
    const off = formatAsOfDate((await asOfThroughGate())!);

    expect(on).toBe("2026-09-18"); // 달력에서 고른 날짜(= 기간 술어의 키)
    expect(off).toBe("2026-09-17"); // 종전 축 = run 앵커
    expect(on).not.toBe(off);
  });
});

describe("게이트는 기간 유무와 무관하게 축을 확정한다", () => {
  it("기간이 걸린 요청에서도 같은 축이다", async () => {
    setAnchorAxisForTests(true);
    const route = await resolveGlobalSummaryRouteBase(ROOT, {
      dateFrom: "2026-09-14",
      dateTo: "2026-09-14",
    });
    expect(route.path).toBe("summary");
    expect(pickGlobalCycle).toHaveBeenCalledWith(ROOT, { anchorAxis: true });
  });
});
