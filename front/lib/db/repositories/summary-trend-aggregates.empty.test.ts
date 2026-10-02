import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import type { StandardFilters } from "@/lib/scope/result-adapter";

// `empty` 는 **값이 아니라 폴백 신호**다(플랜 §5-2). 판정 규칙만 본다 — SQL 은 안 돈다.
const execute = vi.fn<[unknown], Promise<unknown>>();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: (q: unknown) => execute(q) }) }));

const { readTrendAggregates } = await import("./summary-trend-aggregates");
const { resolveColumnAvailabilityForTests } = await import("@/lib/db/column-availability");

const SET: CycleSet = {
  surface: "global",
  mode: "snapshot",
  cycles: [{
    cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
    generationId: "bbbbbbbb-0000-0000-0000-000000000001",
    projectId: "11111111-1111-1111-1111-111111111111",
    cycleAnchorAt: "2026-08-31T00:00:00.000Z",
    cycleWeek: "2026-08-31",
  }],
  cycleKey: "k",
  projectIds: ["11111111-1111-1111-1111-111111111111"],
  missingProjectIds: [],
  weeks: ["2026-08-31"],
  anchorCount: 1,
};
const scope = (filters: StandardFilters = {}) => ({
  set: SET, filters, ownVariant: "ALL", ownedBasePrefixes: [] as string[],
});

// 이 파일은 **판정 규칙**만 본다 — 기본 예산(`summaryRead`)이 켜지면 문장마다 자기
// 트랜잭션이 열려 모의 `execute` 호출 순서가 바뀐다. `budget: null` 이 그 탈출구다.
const opts = (o: { only?: readonly ("own"|"answers"|"brands"|"domains")[] } = {}) =>
  ({ ...o, budget: null } as const);

/** `()` 그룹핑 셋이 내는 합계 행 — 입력이 0행이어도 **행 자체는 나온다**. */
const totalRow = (keyRows: number) => ({ axis: "total", bucket: null, cycle_anchor_at: null, key_rows: keyRows });
const brandRow = () => ({ axis: "brand", country: null, engine: null, brand_name: "Kia", is_rest: 0, rest_count: 0, key_rows: 1 });

// 중괄호 필수 — `mockReset()` 은 mock 자신(함수)을 돌려주고, 훅이 함수를 반환하면
// vitest 가 teardown 으로 보고 매 테스트 뒤에 한 번 더 호출한다.
// `readTrendAggregates` 는 문장을 만들기 전에 `ensureColumnAvailability()` 를 await 한다
// (0069 `comp_rank_sum` 동기 판정). 판정이 미확정이면 그 프로브가 모의 `execute` 를 한 번
// 더 써서 **아래 feed 순서가 통째로 한 칸 밀린다**. 웜 프로세스(=프로덕션의 두 번째 요청
// 이후)와 같은 상태로 고정한다.
beforeEach(() => { execute.mockReset(); resolveColumnAvailabilityForTests(true); });

/** 발행 순서 = own · answers · brands · domains 중 `only` 로 걸러진 것. */
const feed = (...results: unknown[][]) => {
  let i = 0;
  execute.mockImplementation(() => Promise.resolve(results[i++] ?? []));
};

describe("empty — **모수 표**(own·answers)가 비면 true", () => {
  it("전부 차 있으면 false", async () => {
    feed([totalRow(10)], [totalRow(10)], [brandRow()], [totalRow(10)]);
    expect((await readTrendAggregates(scope(), opts())).empty).toBe(false);
  });

  it("전부 비면 true — 접기 미실행", async () => {
    feed([totalRow(0)], [totalRow(0)], [], [totalRow(0)]);
    expect((await readTrendAggregates(scope(), opts())).empty).toBe(true);
  });

  it("모수 표 중 **하나만** 비어도 true", async () => {
    feed([totalRow(0)], [totalRow(10)], [brandRow()], [totalRow(10)]);
    expect((await readTrendAggregates(scope(), opts())).empty).toBe(true);
    feed([totalRow(10)], [totalRow(0)], [brandRow()], [totalRow(10)]);
    expect((await readTrendAggregates(scope(), opts())).empty).toBe(true);
  });

  // R1(2026-09-10): 실측 오폴백 3셀(BE/IT × depth1 — 인용이 정말 0건)을 없앤다.
  it("domains 가 비어도 false — 인용 0건은 **정당한 0** 이다", async () => {
    feed([totalRow(10)], [totalRow(10)], [brandRow()], [totalRow(0)]);
    expect((await readTrendAggregates(scope(), opts())).empty).toBe(false);
  });

  it("brands 가 비어도 false — 언급 0건은 정당한 0 이다", async () => {
    feed([totalRow(10)], [totalRow(10)], [], [totalRow(10)]);
    expect((await readTrendAggregates(scope(), opts())).empty).toBe(false);
  });

  it("`only` 로 안 부른 표는 판정에 안 들어간다", async () => {
    // 출처 도넛(domains 만 발행) — 모수 표가 없으므로 이 신호를 낼 수 없다.
    // 그 경로의 접힘 판정은 읽기 전 `trendFoldPresent` 프로브가 전담한다.
    feed([totalRow(7)]);
    expect((await readTrendAggregates(scope(), opts({ only: ["domains"] }))).empty).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);

    feed([totalRow(0)]);
    expect((await readTrendAggregates(scope(), opts({ only: ["domains"] }))).empty).toBe(false);
  });

  it("`only:[own,brands]` — 모수 표(own)만 판정한다", async () => {
    feed([totalRow(10)], []);
    expect((await readTrendAggregates(scope(), opts({ only: ["own", "brands"] }))).empty).toBe(false);
    feed([totalRow(0)], [brandRow()]);
    expect((await readTrendAggregates(scope(), opts({ only: ["own", "brands"] }))).empty).toBe(true);
  });
});
