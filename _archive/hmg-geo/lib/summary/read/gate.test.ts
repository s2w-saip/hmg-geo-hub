import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  WebsiteCyclePick,
  WebsiteCyclePickResult,
  CycleRangeRow,
  CycleRangeQuery,
} from "@/lib/db/repositories/summary-cycles";

// 게이트 판정 — 설계 v4.1 §8-3·§8-4.
// 기본값이 항상 폴백인지, 그리고 폴백 사유가 구분 가능한지(`x-hmg-summary`)를 고정한다.
// DB 는 여기서 보지 않는다: 원장 조회 두 개와 스위치를 모킹하고 **판정만** 본다.

const readEnabled = vi.fn<[], Promise<boolean>>();
const summaryLedgerAvailable = vi.fn<[], Promise<boolean>>();
const pickWebsiteCycles = vi.fn<[string[]], Promise<WebsiteCyclePickResult | null>>();
const pickGlobalCycle = vi.fn<[string], Promise<WebsiteCyclePick | null>>();
const hasOpenCycle = vi.fn<[string[]], Promise<boolean>>();
// PR② T9 — 기간 모드의 회차 집합 조회(§6-3). 스냅샷 경로는 이것을 부르지 않는다.
const pickCyclesInRange = vi.fn<[CycleRangeQuery], Promise<CycleRangeRow[] | null>>();
// A5(PR①) — 화면 단위 스위치. 기본은 전 화면 허용(`read_screens='[]'` = 현 프로덕션
// 상태)이라 아래 기존 판정은 전부 A5 도입 전과 같아야 한다.
const summaryScreenAllowed = vi.fn<[string], Promise<boolean>>();

vi.mock("@/lib/db/repositories/summary-settings", () => ({
  readEnabled: () => readEnabled(),
  summaryLedgerAvailable: () => summaryLedgerAvailable(),
}));
vi.mock("./screens", () => ({
  summaryScreenAllowed: (s: string) => summaryScreenAllowed(s),
}));
vi.mock("@/lib/db/repositories/summary-cycles", () => ({
  pickWebsiteCycles: (ids: string[]) => pickWebsiteCycles(ids),
  pickGlobalCycle: (root: string) => pickGlobalCycle(root),
  hasOpenCycle: (p: string[]) => hasOpenCycle(p),
  pickCyclesInRange: (q: CycleRangeQuery) => pickCyclesInRange(q),
}));

const {
  resolveWebsiteSummaryRoute,
  resolveGlobalSummaryRoute,
  resolveWebsiteSummaryRouteBase,
  resolveGlobalSummaryRouteBase,
  applyScreenGate,
  summaryRouteHeaderValue,
  summaryCacheTag,
  unsupportedWebsiteFilterReason,
  unsupportedGlobalFilterReason,
  dateRangeReason,
} = await import("./gate");

const PROJECTS = ["11111111-1111-1111-1111-111111111111"];
const cycle = (over: Partial<WebsiteCyclePick> = {}): WebsiteCyclePick => ({
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: PROJECTS[0],
  cycleAnchorAt: "2026-09-04T00:00:00.000Z",
  cycleWeek: "2026-08-31",
  ...over,
});

// 글로벌(S1) — 루트 프로젝트 1개, 회차 1개(8/31 anchor).
const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
const globalCycle = (over: Partial<WebsiteCyclePick> = {}): WebsiteCyclePick => ({
  cycleId: "cccccccc-0000-0000-0000-000000000001",
  generationId: "dddddddd-0000-0000-0000-000000000001",
  projectId: ROOT,
  cycleAnchorAt: "2026-08-31T00:00:00.000Z",
  cycleWeek: "2026-08-31",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  readEnabled.mockResolvedValue(true);
  summaryLedgerAvailable.mockResolvedValue(true);
  pickWebsiteCycles.mockResolvedValue({ cycles: [cycle()], missingProjectIds: [] });
  pickGlobalCycle.mockResolvedValue(globalCycle());
  hasOpenCycle.mockResolvedValue(false);
  summaryScreenAllowed.mockResolvedValue(true);
  pickCyclesInRange.mockResolvedValue([rangeRow()]);
});

// 기간 모드 조회 한 행(§6-3). 기본은 노출 가능한 published 회차.
const rangeRow = (over: Partial<CycleRangeRow> = {}): CycleRangeRow => ({
  cycleId: "cccccccc-0000-0000-0000-000000000001",
  generationId: "dddddddd-0000-0000-0000-000000000001",
  projectId: ROOT,
  cycleAnchorAt: "2026-08-31T00:00:00.000Z",
  cycleWeek: "2026-08-31",
  status: "published",
  renderable: true,
  pending: false,
  // 분석 갭 0 = 생성기 게이트 **안**. `null`/`undefined` 로 두면 "갭을 모른다" 라
  // F1 의 skipped 면제가 안 걸리는데, 그 경계는 `cycle-set.test.ts` 가 따로 본다.
  analysisGapRatio: 0,
  expectedUnits: 100,
  completedUnits: 100,
  ...over,
});

describe("resolveWebsiteSummaryRoute", () => {
  it("스위치·원장·회차가 다 갖춰지면 hit", async () => {
    const route = await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard");
    expect(route.path).toBe("summary");
    expect(summaryRouteHeaderValue(route)).toBe("hit");
    // 캐시 태그에 회차·generation 이 들어간다(§8-4 캐시 키 분리).
    expect(summaryCacheTag(route)).toContain("aaaaaaaa-0000-0000-0000-000000000001");
    expect(summaryCacheTag(route)).toContain("bbbbbbbb-0000-0000-0000-000000000001");
  });

  it("킬스위치가 꺼져 있으면 폴백 (기본값)", async () => {
    readEnabled.mockResolvedValue(false);
    const route = await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:disabled");
    // 스위치가 꺼져 있으면 원장 조회 자체를 하지 않는다.
    expect(pickWebsiteCycles).not.toHaveBeenCalled();
  });

  it("원장 미적용(마이그레이션 전 배포)이면 폴백", async () => {
    summaryLedgerAvailable.mockResolvedValue(false);
    const route = await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:ledger-unavailable");
  });

  it("회차가 하나도 없으면 요청 전체 폴백", async () => {
    pickWebsiteCycles.mockResolvedValue(null);
    const route = await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:missing-cycles");
  });

  it("열린 회차 관측이 실패해도 hit — 관측은 판정에 영향이 0이다 (배지 제거 후)", async () => {
    // 종전(배지 시절)엔 판정 불가가 `fallback:open-cycle-unavailable` 이었다.
    // 배지가 사라져 이 값은 화면에 안 나가므로, 못 읽었다고 폴백할 이유가 없다.
    hasOpenCycle.mockRejectedValue(new Error("boom"));
    await expect(resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard")).rejects.toThrow();
    // 리포지터리는 스스로 catch 해 false 를 돌려준다(summary-cycles.test.ts) —
    // 게이트가 보는 것은 언제나 boolean 이고, false 면 그냥 hit 이다.
    hasOpenCycle.mockResolvedValue(false);
    expect(summaryRouteHeaderValue(await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard"))).toBe("hit");
  });

  it("회차 anchor 밖 기간을 고르면 폴백", async () => {
    const route = await resolveWebsiteSummaryRoute(PROJECTS, {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-07",
    }, "S4.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:range-outside-cycle");
  });

  it("회차 anchor 를 감싸는 기간은 hit (기간 = 기간 내 최신 회차 1개)", async () => {
    const route = await resolveWebsiteSummaryRoute(PROJECTS, {
      dateFrom: "2026-09-01",
      dateTo: "2026-09-06",
    }, "S4.dashboard");
    expect(route.path).toBe("summary");
  });

  it("기간 안에 회차 anchor 가 둘이면 폴백", async () => {
    pickWebsiteCycles.mockResolvedValue({
      cycles: [
        cycle(),
        cycle({
          cycleId: "aaaaaaaa-0000-0000-0000-000000000002",
          projectId: "22222222-2222-2222-2222-222222222222",
          cycleAnchorAt: "2026-09-03T00:00:00.000Z",
        }),
      ],
      missingProjectIds: [],
    });
    const route = await resolveWebsiteSummaryRoute(PROJECTS, {
      dateFrom: "2026-09-01",
      dateTo: "2026-09-06",
    }, "S4.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:range-multi-cycle");
  });

  it("일부 프로젝트에 이번 회차가 없어도 hit — 그 프로젝트는 모수에서 빠진다", async () => {
    // 운영 결정 2026-09-06: 케이던스가 멈춘 사이트를 7월 stale 값으로 메우지 않는다.
    pickWebsiteCycles.mockResolvedValue({
      cycles: [cycle()],
      missingProjectIds: ["33333333-3333-3333-3333-333333333333"],
    });
    const route = await resolveWebsiteSummaryRoute(
      [...PROJECTS, "33333333-3333-3333-3333-333333333333"],
      {},
      "S4.dashboard",
    );
    expect(route.path).toBe("summary");
    // 로그·헤더에 부분 커버리지를 남긴다.
    expect(summaryRouteHeaderValue(route)).toBe("hit partial:1/2");
    if (route.path !== "summary") throw new Error("expected summary route");
    // 사실표 조회 모수는 회차가 있는 프로젝트만.
    expect(route.projectIds).toEqual(PROJECTS);
    expect(route.missingProjectIds).toEqual(["33333333-3333-3333-3333-333333333333"]);
  });

  it("열린 회차 관측은 회차가 있는 프로젝트에 대해서만 돈다", async () => {
    pickWebsiteCycles.mockResolvedValue({
      cycles: [cycle()],
      missingProjectIds: ["33333333-3333-3333-3333-333333333333"],
    });
    await resolveWebsiteSummaryRoute(
      [...PROJECTS, "33333333-3333-3333-3333-333333333333"],
      {},
      "S4.dashboard",
    );
    // 관측 대상은 **회차가 있는 프로젝트**뿐이다 — 제외된 프로젝트가 섞이면
    // "그 프로젝트의 열린 회차" 때문에 관측이 켜져 무의미해진다.
    expect(hasOpenCycle).toHaveBeenCalledWith(PROJECTS);
  });

  it("누적 모드(S2/S5 의미론)는 폴백 — 1차 롤아웃은 단일 회차 스냅샷만", async () => {
    const route = await resolveWebsiteSummaryRoute(PROJECTS, { cumulative: true }, "S4.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:cumulative");
  });

  it("프로젝트가 없으면 폴백", async () => {
    const route = await resolveWebsiteSummaryRoute([], {}, "S4.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:no-projects");
  });
});

describe("unsupportedWebsiteFilterReason", () => {
  it("사실표에 굳히지 않은 축은 전부 폴백 사유", () => {
    expect(unsupportedWebsiteFilterReason({})).toBeNull();
    expect(unsupportedWebsiteFilterReason({ cumulative: true })).toBe("cumulative");
    expect(unsupportedWebsiteFilterReason({ region: ["KR"] })).toBe("unsupported-filter:region");
    expect(unsupportedWebsiteFilterReason({ sourceCategory: ["news"] })).toBe(
      "unsupported-filter:source-category",
    );
    expect(unsupportedWebsiteFilterReason({ customFieldFilters: { f1: ["v"] } })).toBe(
      "unsupported-filter:custom-field",
    );
    // 빈 값은 필터가 아니다.
    expect(unsupportedWebsiteFilterReason({ customFieldFilters: { f1: [] } })).toBeNull();
  });
});

describe("unsupportedGlobalFilterReason", () => {
  it("글로벌은 region 이 **지원 축**이다 (웹사이트와 반대)", () => {
    expect(unsupportedGlobalFilterReason({ region: ["KR", "US"] })).toBeNull();
  });
  it("표준 화면이 안 쓰는 websiteCountry 가 오면 폴백 (가상 코드가 country 에 없다)", () => {
    expect(unsupportedGlobalFilterReason({ websiteCountry: ["worldwide"] })).toBe(
      "unsupported-filter:website-country",
    );
  });
  it("공통 축(누적·출처 카테고리·커스텀 필드)은 두 표면이 같다", () => {
    expect(unsupportedGlobalFilterReason({})).toBeNull();
    expect(unsupportedGlobalFilterReason({ cumulative: true })).toBe("cumulative");
    expect(unsupportedGlobalFilterReason({ sourceCategory: ["news"] })).toBe(
      "unsupported-filter:source-category",
    );
    expect(unsupportedGlobalFilterReason({ customFieldFilters: { f1: ["v"] } })).toBe(
      "unsupported-filter:custom-field",
    );
    expect(unsupportedGlobalFilterReason({ customFieldFilters: { f1: [] } })).toBeNull();
  });
});

describe("resolveGlobalSummaryRoute", () => {
  it("스위치·원장·회차가 다 갖춰지면 hit — 회차는 항상 1개", async () => {
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    expect(route.path).toBe("summary");
    if (route.path !== "summary") throw new Error("expected summary route");
    expect(route.cycles).toHaveLength(1);
    expect(route.projectIds).toEqual([ROOT]);
    // 글로벌엔 partial 이 없다 — 프로젝트가 하나라 hit 아니면 폴백.
    expect(route.missingProjectIds).toEqual([]);
    expect(summaryRouteHeaderValue(route)).toBe("hit");
    expect(summaryCacheTag(route)).toContain("cccccccc-0000-0000-0000-000000000001");
    expect(summaryCacheTag(route)).toContain("dddddddd-0000-0000-0000-000000000001");
  });

  it("루트가 없으면(mock 모드·env 미설정) 폴백 — 원장 조회 안 함", async () => {
    const route = await resolveGlobalSummaryRoute(null, {}, "S1.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:no-root");
    expect(pickGlobalCycle).not.toHaveBeenCalled();
  });

  it("킬스위치가 꺼져 있으면 폴백 (기본값)", async () => {
    readEnabled.mockResolvedValue(false);
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:disabled");
    expect(pickGlobalCycle).not.toHaveBeenCalled();
  });

  it("원장 미적용(마이그레이션 전 배포)이면 폴백", async () => {
    summaryLedgerAvailable.mockResolvedValue(false);
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:ledger-unavailable");
  });

  it("루트 회차가 없으면 폴백", async () => {
    pickGlobalCycle.mockResolvedValue(null);
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:missing-cycle");
  });

  it("회차 anchor 밖 기간을 고르면 폴백", async () => {
    const route = await resolveGlobalSummaryRoute(ROOT, {
      dateFrom: "2026-09-01",
      dateTo: "2026-09-06",
    }, "S1.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:range-outside-cycle");
  });

  it("회차 anchor 를 감싸는 기간은 hit (기간 = 기간 내 최신 회차 1개)", async () => {
    const route = await resolveGlobalSummaryRoute(ROOT, {
      dateFrom: "2026-08-25",
      dateTo: "2026-09-06",
    }, "S1.dashboard");
    expect(route.path).toBe("summary");
  });

  it("열린 회차 관측 인자는 고른 회차의 프로젝트 — 결과와 무관하게 hit", async () => {
    hasOpenCycle.mockResolvedValue(true);
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("hit open-cycle");
    expect(hasOpenCycle).toHaveBeenCalledWith([ROOT]);
  });

  it("누적 모드(S2 의미론)는 폴백 — 1차 롤아웃은 단일 회차 스냅샷만", async () => {
    const route = await resolveGlobalSummaryRoute(ROOT, { cumulative: true }, "S1.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:cumulative");
  });

  it("국가(region) 필터가 걸려도 hit — 사실표 country 로 좁힌다", async () => {
    const route = await resolveGlobalSummaryRoute(ROOT, { region: ["KR"] }, "S1.dashboard");
    expect(route.path).toBe("summary");
  });
});

describe("dateRangeReason", () => {
  it("기간 미지정은 항상 통과 (최신 회차 1개)", () => {
    expect(dateRangeReason({}, [cycle()])).toBeNull();
  });
  it("경계일 포함", () => {
    expect(dateRangeReason({ dateFrom: "2026-09-04", dateTo: "2026-09-04" }, [cycle()])).toBeNull();
  });
});

// ── A5: 화면 단위 스위치 (PR① T4) ──────────────────────────────────────────
// 여기서 보는 것은 **게이트의 판정과 순서**뿐이다. `read_screens` 원문이 어떤
// allowlist 가 되는지(빈 배열·잘못된 JSON·미지 키)는 screens.test.ts 가 본다.
describe("read_screens (A5)", () => {
  it("허용 목록에 없는 화면은 fallback:screen-not-allowed", async () => {
    const allowed = new Set(["S4.dashboard"]);
    summaryScreenAllowed.mockImplementation((s) => Promise.resolve(allowed.has(s)));

    const global = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    expect(summaryRouteHeaderValue(global)).toBe("fallback:screen-not-allowed");

    // 같은 설정에서 허용된 화면은 그대로 hit — 한 화면만 끄는 것이 목적이다.
    const website = await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard");
    expect(website.path).toBe("summary");
    expect(summaryRouteHeaderValue(website)).toBe("hit");
  });

  it("판정 순서: 화면 검사는 **맨 뒤**다 — hit 을 낮출 뿐 사유를 덮지 않는다 (R2)", async () => {
    // ① 전역 스위치가 화면 스위치를 이긴다(종전과 동일).
    readEnabled.mockResolvedValue(false);
    summaryScreenAllowed.mockResolvedValue(false);
    expect(summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard"))).toBe(
      "fallback:disabled",
    );
    expect(summaryScreenAllowed).not.toHaveBeenCalled();

    // ② 원장 미적용이 화면 스위치를 이긴다 — **종전과 반대**(2026-09-10 R2).
    //    판정을 화면 무관으로 만들어 캐시 셀을 화면들이 공유하게 한 결과다.
    //    둘 다 폴백이라 값은 같고, 바뀌는 것은 로그 사유 문자열뿐이다.
    readEnabled.mockResolvedValue(true);
    summaryLedgerAvailable.mockResolvedValue(false);
    expect(summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard"))).toBe(
      "fallback:ledger-unavailable",
    );
    // 이미 폴백이면 화면 검사 자체를 하지 않는다(낮출 것이 없다).
    expect(summaryScreenAllowed).not.toHaveBeenCalled();
  });

  it("웹사이트도 같은 자리에서 판정한다", async () => {
    summaryScreenAllowed.mockResolvedValue(false);
    const route = await resolveWebsiteSummaryRoute(PROJECTS, {}, "S5.mention");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:screen-not-allowed");
  });

  it("판정(base)은 화면을 모른다 — 캐시 키에서 화면을 뺄 수 있는 근거 (R2)", async () => {
    summaryScreenAllowed.mockResolvedValue(false);
    // base 는 화면 스위치를 보지 않는다.
    expect(summaryRouteHeaderValue(await resolveGlobalSummaryRouteBase(ROOT, {}))).toBe("hit");
    expect(summaryRouteHeaderValue(await resolveWebsiteSummaryRouteBase(PROJECTS, {}))).toBe("hit");
    expect(summaryScreenAllowed).not.toHaveBeenCalled();

    // 같은 base 결과를 화면 둘에 각각 얹으면 서로 다른 결과가 나온다 —
    // server.ts 가 판정 셀 1개를 화면 셀 여러 개가 공유하는 방식 그대로.
    const base = await resolveGlobalSummaryRouteBase(ROOT, {});
    summaryScreenAllowed.mockImplementation((s) => Promise.resolve(s === "S1.dashboard"));
    expect(summaryRouteHeaderValue(await applyScreenGate(base, "S1.dashboard"))).toBe("hit");
    expect(summaryRouteHeaderValue(await applyScreenGate(base, "S2.mention"))).toBe(
      "fallback:screen-not-allowed",
    );
    // base 객체는 그대로다(후처리가 원본을 건드리지 않는다).
    expect(base.path).toBe("summary");
  });

  it("이미 폴백인 경로는 화면 검사가 사유를 바꾸지 않는다", async () => {
    summaryScreenAllowed.mockResolvedValue(false);
    const fallback = await resolveGlobalSummaryRouteBase(null, {});
    expect(summaryRouteHeaderValue(await applyScreenGate(fallback, "S1.dashboard"))).toBe(
      "fallback:no-root",
    );
  });
});

// ── D-1(2): 열린 회차 (PR① T5, 배지는 2026-09-10 제거) ────────────────────
// 종전엔 이 상황이 통째로 `fallback:newer-runs` 였고, 루트에 미귀속 run 이 상시
// 6,600개 이상이라 글로벌 대시보드가 **항상** 폴백했다(2026-09-09 실측).
// 지금 남은 것은 관측 꼬리표 하나뿐이다 — 화면에는 아무것도 나가지 않는다.
describe("열린 회차 (D-1(2))", () => {
  it("열린 회차가 있어도 경로는 hit — 사실표는 직전 published 회차를 그대로 낸다", async () => {
    hasOpenCycle.mockResolvedValue(true);
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    expect(route.path).toBe("summary");
    if (route.path !== "summary") throw new Error("expected summary route");
    // 회차 선택은 바뀌지 않는다 — 열린 회차의 데이터를 섞지 않는다.
    expect(route.cycles).toHaveLength(1);
    expect(route.cycles[0]?.cycleId).toBe("cccccccc-0000-0000-0000-000000000001");
    expect(route.openRuns).toBe(true);
    expect(summaryRouteHeaderValue(route)).toBe("hit open-cycle");
  });

  it("열린 회차가 없으면 꼬리표도 없다 (hit 그대로)", async () => {
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    if (route.path !== "summary") throw new Error("expected summary route");
    expect(route.openRuns).toBe(false);
    expect(summaryRouteHeaderValue(route)).toBe("hit");
  });

  it("웹사이트는 partial 과 함께 표기된다", async () => {
    pickWebsiteCycles.mockResolvedValue({
      cycles: [cycle()],
      missingProjectIds: ["33333333-3333-3333-3333-333333333333"],
    });
    hasOpenCycle.mockResolvedValue(true);
    const route = await resolveWebsiteSummaryRoute(
      [...PROJECTS, "33333333-3333-3333-3333-333333333333"],
      {},
      "S4.dashboard",
    );
    expect(summaryRouteHeaderValue(route)).toBe("hit partial:1/2 open-cycle");
  });

  it("`newer-runs`·`open-cycle-unavailable` 사유는 코드에서 사라졌다", async () => {
    for (const open of [true, false]) {
      hasOpenCycle.mockResolvedValue(open);
      const g = summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard"));
      const w = summaryRouteHeaderValue(
        await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard"),
      );
      for (const v of [g, w]) {
        expect(v).not.toContain("newer-runs");
        expect(v).not.toContain("open-cycle-unavailable");
        expect(v.startsWith("hit")).toBe(true);
      }
    }
  });

  it("진척 비율은 더 이상 헤더에 없다 (배지 제거, 운영 2026-09-10)", async () => {
    hasOpenCycle.mockResolvedValue(true);
    expect(
      summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard")),
    ).not.toMatch(/measuring|%/);
  });
});

// ── PR② T9: 기간 모드 회차 집합 (플랜 §6-3) ────────────────────────────────
//
// 여기서 고정하는 것은 **게이트에서 보이는 것**이다 — 사유가 관측 헤더에 나오는가,
// 판정 불가가 폴백인가, 그리고 회차 수가 헤더에 실리는가(운영 확정 D-2 (2):
// 상한 없음 → 수를 노출). 판정 자체의 경우 나누기는 cycle-set.test.ts 가 본다.
describe("기간 모드 (T9 / §6-3)", () => {
  const PERIOD = { mode: "period" } as const;

  it("모드를 안 주면 종전 스냅샷 — 범위 조회를 부르지 않는다", async () => {
    await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    expect(pickCyclesInRange).not.toHaveBeenCalled();
    expect(pickGlobalCycle).toHaveBeenCalled();
  });

  it("기간 모드 hit 은 회차 수를 헤더에 싣는다 — 상한 대신 관측(D-2 (2))", async () => {
    pickCyclesInRange.mockResolvedValue([
      rangeRow(),
      rangeRow({
        cycleId: "cccccccc-0000-0000-0000-000000000002",
        cycleAnchorAt: "2026-09-07T00:00:00.000Z",
        cycleWeek: "2026-09-07",
      }),
    ]);
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard", PERIOD);
    expect(route.path).toBe("summary");
    expect(summaryRouteHeaderValue(route)).toBe("hit cycles:2");
    if (route.path !== "summary") throw new Error("expected summary route");
    expect(route.mode).toBe("period");
    expect(route.weeks).toEqual(["2026-08-31", "2026-09-07"]);
  });

  it("회차 수에 상한이 없다 — 13회차도 폴백하지 않는다(`too-many-cycles` 미구현)", async () => {
    pickCyclesInRange.mockResolvedValue(
      Array.from({ length: 13 }, (_, i) =>
        rangeRow({
          cycleId: `cccccccc-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
          cycleAnchorAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          cycleWeek: `2026-06-${String(i + 1).padStart(2, "0")}`,
        }),
      ),
    );
    const v = summaryRouteHeaderValue(
      await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard", PERIOD),
    );
    expect(v).toBe("hit cycles:13");
    expect(v).not.toContain("too-many-cycles");
  });

  // 관측 조각 — `hit` 인데 점이 기대보다 적은 이유가 이 수다. 없으면 "왜 7/07 점이
  // 없나" 를 로그만 보고는 알 수 없다(F1).
  it("창에서 뺀 미발행 확정 회차는 헤더에 `skipped:<n>` 으로 나온다", async () => {
    pickCyclesInRange.mockResolvedValue([
      rangeRow(),
      rangeRow({ cycleId: "s1", generationId: null, status: "closed", renderable: false, analysisGapRatio: 0.31 }),
      // 유령 회차(갭 null · 멤버 0)도 같은 자리에서 세어진다.
      rangeRow({
        cycleId: "s2", generationId: null, status: "closed", renderable: false,
        analysisGapRatio: null, expectedUnits: null, completedUnits: 0,
      }),
    ]);
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard", PERIOD);
    expect(summaryRouteHeaderValue(route)).toContain("skipped:2");
    expect(summaryRouteHeaderValue(route)).toMatch(/^hit /);
    // 제외가 0 이면 조각 자체가 안 붙는다(프로덕션 헤더가 이유 없이 길어지지 않게).
    pickCyclesInRange.mockResolvedValue([rangeRow()]);
    expect(
      summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard", PERIOD)),
    ).not.toContain("skipped:");
  });

  it("폴백 사유 3종이 관측 헤더에 그대로 나온다", async () => {
    // (a′) 판정 불가 = 폴백 (fail-closed).
    pickCyclesInRange.mockResolvedValue(null);
    expect(
      summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard", PERIOD)),
    ).toBe("fallback:cycle-set-unavailable");

    // (b) 범위 안 비-published 혼입. ⚠️ `generating` 은 2026-09-11(F4)에 구멍에서
    //     빠졌다 — 재생성 스왑 전 순간이 전 화면을 플랩시키면 안 된다. `closed` 로 바꾼다
    //     (갭 0 = 백필 대기라 여전히 구멍이다. 갭 초과는 F1 의 skipped 면제 대상).
    pickCyclesInRange.mockResolvedValue([
      rangeRow(),
      rangeRow({ cycleId: "x", generationId: null, status: "closed", renderable: false }),
    ]);
    expect(
      summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard", PERIOD)),
    ).toBe("fallback:unpublished-cycle-in-range");

    // (c) 웹사이트 주당 프로젝트 회차 1개 위반.
    pickCyclesInRange.mockResolvedValue([
      rangeRow({ projectId: PROJECTS[0] }),
      rangeRow({ cycleId: "y", projectId: PROJECTS[0], cycleAnchorAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    expect(
      summaryRouteHeaderValue(
        await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard", PERIOD),
      ),
    ).toBe("fallback:duplicate-cycle-in-week");
  });

  it("범위에 노출 가능 회차가 없으면 폴백(빈 집합도 fail-closed)", async () => {
    pickCyclesInRange.mockResolvedValue([]);
    expect(
      summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard", PERIOD)),
    ).toBe("fallback:missing-cycles-in-range");
  });

  it("누적(cumulative)은 기간 모드에서 미지원 축이 아니다 — 그것이 이 모드의 목적", async () => {
    // 스냅샷에서는 종전대로 폴백.
    expect(
      summaryRouteHeaderValue(
        await resolveGlobalSummaryRoute(ROOT, { cumulative: true }, "S1.dashboard"),
      ),
    ).toBe("fallback:cumulative");
    // 기간 모드에서는 통과한다(T8 이 켤 경로).
    expect(
      summaryRouteHeaderValue(
        await resolveGlobalSummaryRoute(ROOT, { cumulative: true }, "S1.dashboard", PERIOD),
      ),
    ).toBe("hit cycles:1");
  });

  it("다른 축의 미지원 판정은 모드와 무관하다", async () => {
    expect(unsupportedGlobalFilterReason({ sourceCategory: ["news"] }, "period")).toBe(
      "unsupported-filter:source-category",
    );
    expect(unsupportedWebsiteFilterReason({ region: ["KR"] }, "period")).toBe(
      "unsupported-filter:region",
    );
    // 누적만 모드에 따라 갈린다.
    expect(unsupportedGlobalFilterReason({ cumulative: true }, "period")).toBeNull();
    expect(unsupportedGlobalFilterReason({ cumulative: true }, "snapshot")).toBe("cumulative");
  });

  it("헤더 조각 순서: partial → cycles → open-cycle", async () => {
    pickCyclesInRange.mockResolvedValue([
      rangeRow({ projectId: PROJECTS[0] }),
      rangeRow({
        cycleId: "z",
        projectId: PROJECTS[0],
        cycleAnchorAt: "2026-09-07T00:00:00.000Z",
        cycleWeek: "2026-09-07",
      }),
    ]);
    hasOpenCycle.mockResolvedValue(true);
    const route = await resolveWebsiteSummaryRoute(
      [...PROJECTS, "33333333-3333-3333-3333-333333333333"],
      {},
      "S4.dashboard",
      { mode: "period" },
    );
    expect(summaryRouteHeaderValue(route)).toBe("hit partial:1/2 cycles:2 open-cycle");
  });

  it("스위치·화면 게이트는 기간 모드에서도 먼저·나중 자리를 지킨다", async () => {
    readEnabled.mockResolvedValue(false);
    expect(
      summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard", PERIOD)),
    ).toBe("fallback:disabled");
    expect(pickCyclesInRange).not.toHaveBeenCalled();

    readEnabled.mockResolvedValue(true);
    summaryScreenAllowed.mockResolvedValue(false);
    expect(
      summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, {}, "S2.mention", PERIOD)),
    ).toBe("fallback:screen-not-allowed");
  });
});
