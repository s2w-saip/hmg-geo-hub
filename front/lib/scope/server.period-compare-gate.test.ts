/**
 * 기간 비교 Δ(GGMD-107) 게이트웨이의 **행동 가드** — WU B1~B3.
 *
 * 고정하는 것 다섯:
 *   ① **off 회귀 0** — 화면 키가 꺼져 있으면 `resolveWindowEnd`·`readComparePeriods` 를
 *      **아예 부르지 않는다**(DB 왕복 0) 그리고 반환이 `null` 이라 페이로드도 안 는다.
 *      `null` 은 "화면은 종전 Δ 경로를 그대로 쓴다" 는 뜻이다.
 *   ② `read_screens='[]'`(전 화면 허용, `screens all`)로도 켜지지 않는다 — 옵트인이다.
 *      성능 스위치가 고객이 보는 숫자를 바꾸면 안 된다.
 *   ③ **기간 미선택**이면 켜져 있어도 `null` — "기본 화면은 값이 바뀌지 않는다"(스펙).
 *   ④ **적용일 게이트**(Q6=b) — `cur.hi < epoch` 면 읽지 않고 `null`. 기발행 리포트 재현.
 *   ⑤ **캐시** — 셀 TTL 600 s(< 공통 7,200) · 키에 해소된 `E` 포함 · 태그 `SUMMARY_TAG`.
 *   ⑥ **셀 반환이 직렬화를 견딘다** — Next Data Cache 는 셀 결과를 JSON 으로 보관한다.
 *      그래서 아래 `unstable_cache` mock 은 **결과를 JSON 라운드트립**시킨다: 초판은
 *      그냥 통과시켜서 `Map` 반환 결함(캐시 HIT 부터 `.get()` 이 터짐)을 못 잡았다.
 *
 * 화면 키가 코드 밖(설정 한 줄)에 있으므로, 이 파일이 없으면 "기본 off" 는 아무
 * 그물도 없이 산다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComparePeriod } from "@/lib/kpi/period-compare";
import type { StandardFilters } from "@/lib/scope/result-adapter";

// react-server 빌드라야 `cache()` 가 실제로 memoize 한다(request-scope 참조).
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

// 셀의 `revalidate` 와 **호출 인자**(= invocation key)를 캡처한다. 이 단언이 없으면
// TTL 을 7,200 으로 되돌리거나 키에서 `E` 를 빼는 뮤턴트가 조용히 산다.
const cacheOpts: Array<{ keys: string[]; revalidate?: number; tags?: string[] }> = [];
const cellCalls: Array<{ keys: string[]; args: unknown[] }> = [];
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(
    fn: (...a: A) => Promise<R>,
    keys: string[],
    opts?: { revalidate?: number; tags?: string[] },
  ) => {
    cacheOpts.push({ keys, revalidate: opts?.revalidate, tags: opts?.tags });
    // 셀 **호출 인자** = `unstable_cache` 의 invocation key(`JSON.stringify(args)`).
    // 여기를 기록해야 "키에 `E` 가 실린다" 를 진짜로 단언할 수 있다.
    return async (...args: A) => {
      cellCalls.push({ keys, args });
      const out = await fn(...args);
      // ⚠️ **실제 Data Cache 의 경계를 여기서 재현한다.** 캐시는 셀 결과를 직렬화해
      //    보관하므로 `Map`·`Set`·`Date` 는 왕복에서 죽는다(`Map` → `{}`). 통과시키면
      //    MISS 경로만 테스트하게 되고, 프로덕션은 **HIT 부터** 터진다.
      //    `undefined` 는 JSON 이 표현하지 못하므로 그대로 둔다(셀은 undefined 를 안 낸다).
      return (out === undefined ? out : JSON.parse(JSON.stringify(out))) as R;
    };
  },
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", role: "admin", scope: { all: true } } }),
}));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {}, auditDataAccess: () => {} }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({
  entityRegistryRepository: { listOwn: async () => [] },
}));
// 웹사이트 표면은 세션 스코프 → 함대 project id 를 DB 에서 읽는다. 여기서는 그 조회만
// 고정한다 — 스코프 좁히기(narrowScopeBrands)와 강제 순서는 실코드 그대로 돈다.
const FLEET = ["ws-1", "ws-2"];
vi.mock("@/lib/db/repositories/website-sites", () => ({
  getProjectIdsForScope: async () => FLEET,
}));
// 자사 base 선언 조회(웹사이트 전용)도 DB 다. 값은 이 테스트의 관심사가 아니다.
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    websiteDeclaredOwnedBases: async () => ({ prefixes: [], universe: undefined }),
  };
});

const ROOT = "mock-root-project"; // `getStandardRootId()` mock 모드 값

let screensRaw: string | null = null;
let epochRaw: string | null = null;
vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readEnabled: async () => true,
    summaryLedgerAvailable: async () => true,
    summaryUnitFlagsAvailable: async () => true,
    websiteExcludedUnits: async () => [],
    readScreensRaw: async () => screensRaw,
    periodCompareEpochRaw: async () => epochRaw,
  };
});

interface WindowEndInfo { end: string | null; fleet: number; distinctAnchors: number }
const resolveWindowEndInfo = vi.fn(
  async (): Promise<WindowEndInfo> => ({ end: "2026-09-13", fleet: 1, distinctAnchors: 1 }),
);
const readComparePeriods = vi.fn(
  async (): Promise<ComparePeriod[] | null> => periods(),
);
vi.mock("@/lib/db/repositories/summary-period-compare", () => ({
  resolveWindowEndInfo: (...a: unknown[]) =>
    (resolveWindowEndInfo as unknown as (...x: unknown[]) => Promise<WindowEndInfo>)(...a),
  readComparePeriods: (...a: unknown[]) =>
    (readComparePeriods as unknown as (
      ...x: unknown[]
    ) => Promise<ComparePeriod[] | null>)(...a),
}));

const { resetSummaryScreensForTests } = await import("@/lib/summary/read/screens");
const { withRequestScope } = await import("@/test/request-scope");
const { fetchPeriodCompare, fetchLatestAnchorDay, PERIOD_COMPARE_CACHE_TTL, MIRROR_CACHE_TTL } =
  await import("./server");

// ── 픽스처 ─────────────────────────────────────────────────────────────────
// 골든 G1(글로벌·무필터·E=2026-09-13·7일 창, design §9): cur 56,033/75,138 = 74.5735 % ·
// prev 24,336/37,570 = 64.7751 % → Δ +9.7984 %p.
const CUR = "2026-09-07..2026-09-13";
const PREV = "2026-08-31..2026-09-06";

function period(key: string, lo: string, hi: string, num: number, den: number, cycles: number): ComparePeriod {
  return {
    key,
    lo,
    hi,
    measures: { visibility: { numerator: num, denominator: den } },
    ledger: {
      plannedUnits: den,
      missingUnits: 0,
      publishedCycles: cycles,
      dataCycles: cycles,
      firstPublishedAnchor: "2026-06-07",
    },
  };
}
function periods(): ComparePeriod[] {
  return [
    period(PREV, "2026-08-31", "2026-09-06", 24_336, 37_570, 1),
    period(CUR, "2026-09-07", "2026-09-13", 56_033, 75_138, 2),
  ];
}

/** 7일 프리셋이 만들어 넣는 날짜쌍(끝점 = E). */
const WEEKLY: StandardFilters = { dateFrom: "2026-09-07", dateTo: "2026-09-13" };

const OPTS = {
  surface: "global" as const,
  family: "mention" as const,
  kind: "window" as const,
  metrics: ["visibility"] as const,
};

const run = (f: StandardFilters = WEEKLY) =>
  withRequestScope(() => fetchPeriodCompare(f, OPTS));

beforeEach(() => {
  vi.clearAllMocks();
  resetSummaryScreensForTests();
  screensRaw = null;
  epochRaw = null;
  resolveWindowEndInfo.mockResolvedValue({ end: "2026-09-13", fleet: 1, distinctAnchors: 1 });
  readComparePeriods.mockResolvedValue(periods());
});

// ── ①·② 스위치: off 에서 회귀 0 ───────────────────────────────────────────
describe("fetchPeriodCompare — 화면 키 게이트 (off 회귀 0)", () => {
  it("설정 행이 없으면(기본) null 이고 읽기가 **한 문장도** 안 돈다", async () => {
    screensRaw = null;
    await expect(run()).resolves.toBeNull();
    expect(readComparePeriods).not.toHaveBeenCalled();
    // 원장(`E`) 조회조차 부르지 않는다 — 게이트가 read 보다 **앞**이다.
    expect(resolveWindowEndInfo).not.toHaveBeenCalled();
  });

  it("`screens all`(= '[]') 로도 켜지지 않는다 — 옵트인 키", async () => {
    screensRaw = "[]";
    await expect(run()).resolves.toBeNull();
    expect(readComparePeriods).not.toHaveBeenCalled();
    expect(resolveWindowEndInfo).not.toHaveBeenCalled();
  });

  it("다른 화면만 켜도 기간 비교는 안 켜진다", async () => {
    screensRaw = '["S1.dashboard","S3.citation"]';
    await expect(run()).resolves.toBeNull();
    expect(readComparePeriods).not.toHaveBeenCalled();
    expect(resolveWindowEndInfo).not.toHaveBeenCalled();
  });

  // 끝점 전달(B4)도 같은 스위치를 탄다 — 한쪽만 켜지면 값의 창과 Δ 의 창이 갈린다.
  it("끝점 전달(fetchLatestAnchorDay)도 off 면 null 이다 → 프리셋은 오늘 폴백", async () => {
    screensRaw = null;
    await expect(withRequestScope(() => fetchLatestAnchorDay("global"))).resolves.toBeNull();
    expect(resolveWindowEndInfo).not.toHaveBeenCalled();
  });

  it("명시하면 켜진다", async () => {
    screensRaw = '["S1.periodCompare"]';
    epochRaw = "2026-09-01"; // 적용일 게이트는 별도 describe 가 본다
    const out = await run();
    expect(readComparePeriods).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.metric).toBe("visibility");
    expect(out?.[0]?.unit).toBe("pp");
    expect(out?.[0]?.suppressed).toBe(false);
    // 골든 G1 — 분자합/분모합끼리의 차(회차별 비율의 평균이 아니다).
    expect(out?.[0]?.delta).toBeCloseTo(9.7984, 3);
    expect(out?.[0]?.cyclesCur).toBe(2);
    expect(out?.[0]?.cyclesPrev).toBe(1);
  });

  it("켜지면 끝점도 해소된다", async () => {
    screensRaw = '["S1.periodCompare"]';
    await expect(withRequestScope(() => fetchLatestAnchorDay("global"))).resolves.toBe("2026-09-13");
    expect(resolveWindowEndInfo).toHaveBeenCalledWith("global", [ROOT]);
  });
});

// ── ③ 기간 미선택: 산식을 바꾸지 않는다 ────────────────────────────────────
describe("fetchPeriodCompare — 기간 미선택 회귀", () => {
  beforeEach(() => {
    screensRaw = '["S1.periodCompare"]';
  });

  it("기간이 없으면 켜져 있어도 null 이고 읽지 않는다", async () => {
    await expect(run({})).resolves.toBeNull();
    expect(readComparePeriods).not.toHaveBeenCalled();
  });

  // 한쪽만 채운 open-ended 구간은 창 길이 N 이 정의되지 않는다 → 종전 Δ.
  it("한쪽 끝만 있는 구간도 null 이다", async () => {
    await expect(run({ dateFrom: "2026-09-07" })).resolves.toBeNull();
    await expect(run({ dateTo: "2026-09-13" })).resolves.toBeNull();
    expect(readComparePeriods).not.toHaveBeenCalled();
  });
});

// ── ④ 적용일 게이트 (Q6=b) ────────────────────────────────────────────────
describe("fetchPeriodCompare — 적용일", () => {
  beforeEach(() => {
    screensRaw = '["S1.periodCompare"]';
  });

  it("적용일 이전 구간은 읽지 않고 null — 기발행 리포트가 재현된다", async () => {
    // 상수 기본값(09-08)은 골든 창(끝 09-13)을 포함하므로, 설정으로 적용일을 뒤로 민다.
    epochRaw = "2026-09-19"; // 창 끝 09-13 < 09-19 → 미달
    await expect(run()).resolves.toBeNull();
    expect(readComparePeriods).not.toHaveBeenCalled();
  });

  it("설정의 적용일이 상수를 이긴다", async () => {
    epochRaw = "2026-09-01"; // 창 끝 09-13 >= 09-01 → 적용
    const out = await run();
    expect(out).toHaveLength(1);
    expect(readComparePeriods).toHaveBeenCalledTimes(1);
  });

  it("경계는 포함이다 (cur.hi === epoch)", async () => {
    epochRaw = "2026-09-13";
    await expect(run()).resolves.not.toBeNull();
  });

  it("하루 모자라면 안 걸린다 (cur.hi === epoch − 1)", async () => {
    epochRaw = "2026-09-14";
    await expect(run()).resolves.toBeNull();
    expect(readComparePeriods).not.toHaveBeenCalled();
  });
});

// ── 창 수식 · 계열 규약이 리더에게 그대로 전달되는가 ────────────────────────
describe("fetchPeriodCompare — 리더에 넘기는 창", () => {
  beforeEach(() => {
    screensRaw = '["S1.periodCompare"]';
    epochRaw = "2026-09-01";
  });

  it("두 창은 길이가 같고 맞닿는다 — 읽기는 **한 번**이다", async () => {
    await run();
    expect(readComparePeriods).toHaveBeenCalledTimes(1);
    const scope = readComparePeriods.mock.calls[0]?.[0] as unknown as {
      surface: string;
      family: string;
      windows: { key: string; lo: string; hi: string }[];
    };
    expect(scope.surface).toBe("global");
    // `family` 는 기본값이 없다 — `hidden_scope='citations'` 회차 규약(design §6-3).
    expect(scope.family).toBe("mention");
    expect(scope.windows).toEqual([
      { key: PREV, lo: "2026-08-31", hi: "2026-09-06" },
      { key: CUR, lo: "2026-09-07", hi: "2026-09-13" },
    ]);
  });

  // 현재 창은 화면이 실제로 집계하는 그 날짜쌍이다 — 값의 창과 Δ 의 현재 창이
  // 갈릴 수 없다는 스펙 불변식을 **구조로** 고정한다.
  it("현재 창 = 필터의 (dateFrom, dateTo)", async () => {
    await run({ dateFrom: "2026-08-15", dateTo: "2026-09-13" }); // 30일
    const scope = readComparePeriods.mock.calls[0]?.[0] as unknown as {
      windows: { lo: string; hi: string }[];
    };
    expect(scope.windows[1]).toMatchObject({ lo: "2026-08-15", hi: "2026-09-13" });
    // 직전 창도 30일이고 맞닿는다.
    expect(scope.windows[0]).toMatchObject({ lo: "2026-07-16", hi: "2026-08-14" });
  });

  // 초판 결함(2026-09-18): 캐시 튜플을 `const [, surface, , ownVariant, …]` 로 풀면서
  // **`projectIds` 자리를 건너뛰어** 리더에 모수가 안 넘어갔다. 그러면 리더가 null 을 내고
  // 전 화면이 `unsupported` 로 억제된다 — 화면에는 "―" 만 보이고 원인은 안 보인다.
  it("모수(projectIds)가 리더에 전달된다", async () => {
    await run();
    const scope = readComparePeriods.mock.calls[0]?.[0] as unknown as {
      projectIds: string[];
      ownVariant: string;
      ownedBasePrefixes: string[];
    };
    expect(scope.projectIds).toEqual([ROOT]);
    // 같은 튜플의 이웃 슬롯도 함께 고정한다 — 구멍은 한 자리만 밀려도 조용히 산다.
    expect(typeof scope.ownVariant).toBe("string");
    expect(Array.isArray(scope.ownedBasePrefixes)).toBe(true);
  });

  it("웹사이트 표면은 함대 projectIds 를 그대로 넘긴다", async () => {
    await withRequestScope(() =>
      fetchPeriodCompare(WEEKLY, { ...OPTS, surface: "website" }),
    );
    const scope = readComparePeriods.mock.calls[0]?.[0] as unknown as {
      surface: string;
      projectIds: string[];
    };
    expect(scope.surface).toBe("website");
    expect(scope.projectIds).toEqual(FLEET);
  });

  it("리더가 null(집계층 불가)이면 억제 결과를 낸다 — null 이 아니다", async () => {
    readComparePeriods.mockResolvedValue(null);
    const out = await run();
    expect(out).toHaveLength(1);
    expect(out?.[0]?.suppressed).toBe(true);
    expect(out?.[0]?.reason).toBe("unsupported");
    expect(out?.[0]?.delta).toBeNull();
  });
});

// ── ⑤ 캐시 ────────────────────────────────────────────────────────────────
describe("기간 비교 셀의 캐시", () => {
  beforeEach(() => {
    screensRaw = '["S1.periodCompare"]';
    epochRaw = "2026-09-01";
  });

  it("TTL 이 공통 미러 TTL 보다 **짧다** — 값이 시계로 바뀐다", async () => {
    // ⚠️ `cacheOpts` 를 비우지 않는다 — `lazyCache` 가 셀당 한 번만 `unstable_cache` 를
    //    만들기 때문에 앞선 테스트가 이미 만들었으면 여기서 비우면 영영 못 본다.
    await run();
    const cell = cacheOpts.find((o) => o.keys.includes("period-compare"));
    expect(cell, "period-compare 셀이 만들어져야 한다").toBeDefined();
    // 숫자를 테스트에 복제하지 않는다 — 상수를 import 해서 **관계**만 단언한다.
    expect(cell?.revalidate).toBe(PERIOD_COMPARE_CACHE_TTL);
    expect(PERIOD_COMPARE_CACHE_TTL).toBeLessThan(MIRROR_CACHE_TTL);
    // 생성 러너의 무효화 계약(`POST /api/internal/summary/published`)이 직접 죽인다.
    expect(cell?.tags).toContain("summary-aggregates");
  });

  // 프리셋이 만든 날짜쌍과 고객이 캘린더로 직접 찍은 같은 날짜쌍은 구분되지 않는다.
  // `E` 가 키에 없으면 회차가 공개돼도 TTL 동안 낡은 창이 남는다(design §8).
  it("해소된 `E` 가 셀 인자(= 캐시 키) 첫 자리에 실린다", async () => {
    cellCalls.length = 0;
    await run();
    expect(resolveWindowEndInfo).toHaveBeenCalledWith("global", [ROOT]);
    const call = cellCalls.find((c) => c.keys.includes("period-compare"));
    expect(call, "period-compare 셀이 호출돼야 한다").toBeDefined();
    expect(call?.args[0]).toBe("2026-09-13");
  });

  it("`E` 가 바뀌면 같은 필터라도 셀 인자가 갈린다", async () => {
    cellCalls.length = 0;
    await run();
    resolveWindowEndInfo.mockResolvedValue({ end: "2026-09-20", fleet: 1, distinctAnchors: 1 });
    await run();
    const keys = cellCalls.filter((c) => c.keys.includes("period-compare")).map((c) => c.args[0]);
    expect(keys).toEqual(["2026-09-13", "2026-09-20"]);
  });
});

// ── Q4 진단: 함대 앵커 불일치 로그 ──────────────────────────────────────────
//
// `E` 는 `max` 다. 함대 전원이 같은 회차일을 공유하는 정상 구간에서는 그것이 곧
// "함대 회차일" 이지만(design §13-4), 앵커가 갈리는 구간에서는 **조용히 큰 값**을 고른다.
// 리더가 내주는 `distinctAnchors` 로 그 순간만 로그를 남긴다 — 정상 구간에서 로그가
// 쌓이면 아무도 안 읽는다.
describe("함대 앵커 불일치 로그", () => {
  beforeEach(() => {
    screensRaw = '["S1.periodCompare"]';
    epochRaw = "2026-09-01";
  });

  it("앵커가 하나면 조용하다", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    resolveWindowEndInfo.mockResolvedValue({ end: "2026-09-13", fleet: 95, distinctAnchors: 1 });
    await withRequestScope(() => fetchLatestAnchorDay("website"));
    expect(spy.mock.calls.flat().join(" ")).not.toContain("fleet-anchor-mismatch");
    spy.mockRestore();
  });

  it("앵커가 갈리면 한 줄 남긴다", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    resolveWindowEndInfo.mockResolvedValue({ end: "2026-09-11", fleet: 95, distinctAnchors: 4 });
    await withRequestScope(() => fetchLatestAnchorDay("website"));
    const line = spy.mock.calls.flat().find((m) => String(m).includes("fleet-anchor-mismatch"));
    expect(line, "불일치 로그가 있어야 한다").toBeDefined();
    expect(String(line)).toContain("E=2026-09-11");
    expect(String(line)).toContain("fleet=95");
    expect(String(line)).toContain("anchors=4");
    spy.mockRestore();
  });

  // 로그는 `requestWindowEnd`(React cache) **안**에 있다 — 한 요청에서 필터 패널과
  // 게이트웨이가 같은 셀을 기다려도 문장 1개당 한 줄이다.
  it("같은 요청에서 두 번 불러도 한 줄이다", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    resolveWindowEndInfo.mockResolvedValue({ end: "2026-09-11", fleet: 95, distinctAnchors: 4 });
    await withRequestScope(async () => {
      await fetchLatestAnchorDay("website");
      await fetchLatestAnchorDay("website");
    });
    const lines = spy.mock.calls
      .flat()
      .filter((m) => String(m).includes("fleet-anchor-mismatch"));
    expect(lines).toHaveLength(1);
    spy.mockRestore();
  });
});

// ── ⑥ 캐시 경계: 셀 반환이 직렬화를 견딘다 ─────────────────────────────────
//
// 2026-09-19 프리뷰 실측 결함의 회귀 그물. 셀이 `Map` 을 돌려주면 Data Cache 왕복에서
// 키가 통째로 사라져(`{}`) **캐시 HIT 부터** 소비부의 `.get()` 이 `undefined` 를 물고,
// `withStandardRoot` 가 그 throw 를 안 잡아 세그먼트 전체가 errorBoundary 로 죽었다.
// MISS 인 첫 요청만 정상이라 "한 번 열어보기" 로는 절대 안 잡힌다.
//
// 위 `unstable_cache` mock 이 결과를 JSON 라운드트립시키므로, 아래 세 지면(글로벌·
// 웹사이트·인용)은 **직렬화를 통과한 값**으로 계산한다. 같은 셀을 셋이 공유한다.
describe("셀 반환의 직렬화 내성 (Data Cache 왕복)", () => {
  beforeEach(() => {
    screensRaw = JSON.stringify(["S1.periodCompare"]);
  });

  it("라운드트립 뒤에도 던지지 않고 골든 G1 을 낸다 (글로벌)", async () => {
    const out = await run();
    expect(out).not.toBeNull();
    const v = out!.find((r) => r.metric === "visibility")!;
    expect(v.suppressed).toBe(false);
    expect(v.delta).toBeCloseTo(9.7984, 3);
  });

  it("같은 인자로 두 번 불러도(= HIT 재현) 결과가 같다", async () => {
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
  });

  it.each([
    ["website", { surface: "website" as const, family: "mention" as const }],
    ["citation", { surface: "global" as const, family: "citation" as const }],
  ])("%s 지면도 같은 셀을 공유하므로 함께 견딘다", async (_label, over) => {
    const out = await withRequestScope(() =>
      fetchPeriodCompare(WEEKLY, { ...OPTS, ...over }),
    );
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(0);
  });

  it("셀이 직렬화로 죽는 형태를 돌려주면 **테스트가 깨진다**(그물이 살아 있다는 증거)", async () => {
    // 리더가 Map 을 돌려주는 옛 형태를 흉내낸다 — 라운드트립 뒤 `{}` 가 되어
    // `periods.map` 이 없으므로 게이트웨이가 던진다.
    readComparePeriods.mockResolvedValue(
      new Map(periods().map((p) => [p.key, p])) as unknown as ComparePeriod[],
    );
    await expect(run()).rejects.toThrow();
  });
});
