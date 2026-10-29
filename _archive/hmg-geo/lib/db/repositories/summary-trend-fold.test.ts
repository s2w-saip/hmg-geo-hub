import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

// 프로브는 문장 하나뿐이라 SQL 은 실 DB 하네스가 본다. 여기서 고정하는 것은 **판정 규약**:
// "판정할 수 없으면 폴백"(= false)이고 **절대 던지지 않는다**.
const execute = vi.fn<[unknown], Promise<unknown>>();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: (q: unknown) => execute(q) }) }));

const { trendFoldPresent } = await import("./summary-trend-fold");

const setOf = (n: number): CycleSet => ({
  surface: "website",
  mode: "snapshot",
  cycles: Array.from({ length: n }, (_, i) => ({
    cycleId: `aaaaaaaa-0000-0000-0000-00000000000${i}`,
    generationId: `bbbbbbbb-0000-0000-0000-00000000000${i}`,
    projectId: `11111111-1111-1111-1111-11111111111${i}`,
    cycleAnchorAt: "2026-09-04T00:00:00.000Z",
    cycleWeek: "2026-08-31",
  })),
  cycleKey: "k",
  projectIds: [],
  missingProjectIds: [],
  weeks: ["2026-08-31"],
  anchorCount: 1,
});

// ⚠️ 중괄호 필수 — `mockReset()` 은 **mock 자신**(함수)을 돌려주고, 훅이 함수를 반환하면
// vitest 는 그것을 teardown 으로 보고 매 테스트 뒤에 호출한다. 그러면 예외를 던지도록
// 꾸민 mock 이 teardown 에서 한 번 더 불려, 통과한 테스트가 그 예외로 실패한다.
beforeEach(() => { execute.mockReset(); });

describe("trendFoldPresent — 접힘 프로브", () => {
  it("요청한 쌍이 전부 있으면 true", async () => {
    execute.mockResolvedValue([{ tbl: "own", n: 3 }]);
    expect(await trendFoldPresent("website", setOf(3))).toBe(true);
  });

  it("**부분 접힘**(3개 중 1개)이면 false — '하나라도 있으면' 이 아니다", async () => {
    execute.mockResolvedValue([{ tbl: "own", n: 1 }]);
    expect(await trendFoldPresent("website", setOf(3))).toBe(false);
  });

  it("회차가 없으면 DB 를 보지 않고 false", async () => {
    expect(await trendFoldPresent("global", setOf(0))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  // ── 이 파일의 존재 이유 (2026-09-10) ────────────────────────────────────────
  // 다른 게이트 프로브(`pickCyclesInRange`·`readEnabled`·`summaryLedgerAvailable`·
  // `websiteExcludedUnits`)는 전부 실패를 삼키고 미러로 떨어지는데 이것만 던졌다.
  // 호출부가 React `cache()` 셀이라, 던지면 거부된 프로미스가 그 요청 내내 캐시되고
  // 그 셀을 기다리는 섹션이 통째로 에러 바운더리로 떨어진다(하위 `.catch(() => [])`
  // 로는 못 막는다 — 예외가 그보다 위에서 난다).
  it("DB 가 실패해도 **던지지 않고** false — 판정 불능은 폴백이다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 동기 throw 로 흉내낸다 — 거부 프로미스를 모의 결과로 남기면 vitest 가 그것을
    // 미처리 거부로 세어 통과한 테스트를 실패로 만든다(`await` 로 이미 소비했는데도).
    execute.mockImplementation(() => { throw new Error("relation does not exist"); });
    expect(await trendFoldPresent("website", setOf(2))).toBe(false);
    // 조용히 넘기지 않는다 — 프로브가 계속 실패하면 화면은 "느리지만 정상"이라 로그가
    // 유일한 신호다.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("trendFoldPresent");
    warn.mockRestore();
  });

  it("반환 행 수가 요청 표 수와 다르면 false(형태 이상도 폴백)", async () => {
    execute.mockResolvedValue([{ tbl: "own", n: 2 }]);
    expect(await trendFoldPresent("website", setOf(2), ["own", "domains"])).toBe(false);
  });
});

// ── 픽스처 3세트 — 프로덕션 동치성 실측과 같은 격자 (PR⑤ U1) ────────────────
//
// `summary-trend-fold.int.test.ts` 가 라이브 DB 로 같은 3세트를 대조하고, 여기서는
// DB 없이 **판정 규약**만 같은 격자로 고정한다. 세 세트는 프로덕션 실측(2026-09-11,
// 읽기 전용 세션)에서 뽑은 실제 모양이다:
//
//   A 전부 접힘   global 13쌍(91일 published 전수)  → n=13 → true
//   B 부분 접힘   global 12쌍(60일, closed 섞음)    → n=9  → **false**(폴백)
//   C 대량        website 618쌍(91일 전수)          → n=618 → true
//
// B 가 이 프로브의 존재 이유다 — "하나라도 있으면 true" 로 느슨해지면 나머지 회차의
// 모수가 조용히 빠진 채 화면이 그려진다(2026-09-10 웹사이트 1/95).
describe("trendFoldPresent — 픽스처 3세트(프로덕션 동치성 격자)", () => {
  it("A 전부 접힘 · 13쌍 → true", async () => {
    execute.mockResolvedValue([
      { tbl: "own", n: 13 },
      { tbl: "domains", n: 13 },
      { tbl: "brands", n: 13 },
    ]);
    expect(
      await trendFoldPresent("global", setOf(13), ["own", "domains", "brands"]),
    ).toBe(true);
  });

  it("B 부분 접힘 · 12쌍 중 9 → false (표 하나만 모자라도 폴백)", async () => {
    execute.mockResolvedValue([
      { tbl: "own", n: 9 },
      { tbl: "domains", n: 9 },
      { tbl: "brands", n: 9 },
    ]);
    expect(
      await trendFoldPresent("global", setOf(12), ["own", "domains", "brands"]),
    ).toBe(false);

    execute.mockResolvedValue([
      { tbl: "own", n: 12 },
      { tbl: "domains", n: 12 },
      { tbl: "brands", n: 11 },
    ]);
    expect(
      await trendFoldPresent("global", setOf(12), ["own", "domains", "brands"]),
    ).toBe(false);
  });

  it("C 대량 · 618쌍 → true (쌍이 늘어도 판정 규약은 같다)", async () => {
    execute.mockResolvedValue([{ tbl: "own", n: 618 }]);
    expect(await trendFoldPresent("website", setOf(618))).toBe(true);
  });

  it("중복 쌍이 섞여도 분모는 **고유 쌍 수**다 — 부풀린 count 로 오판하지 않는다", async () => {
    // 요청 배열은 5개지만 고유 쌍은 3개. SQL 은 dedup 한 3쌍을 세므로 n=3 이 전부다.
    const dup: CycleSet = { ...setOf(3), cycles: [...setOf(3).cycles, ...setOf(2).cycles] };
    expect(dup.cycles).toHaveLength(5);
    execute.mockResolvedValue([{ tbl: "own", n: 3 }]);
    expect(await trendFoldPresent("global", dup)).toBe(true);
  });
});
