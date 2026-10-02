import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  WebsiteCyclePick,
  WebsiteCyclePickResult,
  CycleRangeRow,
  CycleRangeQuery,
} from "@/lib/db/repositories/summary-cycles";
import { planTrendRead } from "@/lib/db/repositories/summary-trend-aggregates";

// S4 집계층 경로(PR② T5)의 **폴백 3층**을 고정한다. server.ts 의 `viaTrend` 가 이
// 순서로 검사한다: ① 회차·화면 게이트 → ② `planTrendRead`(집계층 키 표현 가능성)
// → ③ 접기 존재(`websiteTrendFoldPresent`). 어느 하나라도 아니면 미러다.
// (③ 은 DB 문장이라 실DB 하네스가 본다 — 여기서는 ①②.)

const readEnabled = vi.fn<[], Promise<boolean>>();
const summaryLedgerAvailable = vi.fn<[], Promise<boolean>>();
const pickWebsiteCycles = vi.fn<[string[]], Promise<WebsiteCyclePickResult | null>>();
const pickGlobalCycle = vi.fn<[string], Promise<WebsiteCyclePick | null>>();
const hasOpenCycle = vi.fn<[string[]], Promise<boolean>>();
const pickCyclesInRange = vi.fn<[CycleRangeQuery], Promise<CycleRangeRow[] | null>>();
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

const { resolveWebsiteSummaryRoute, summaryRouteHeaderValue } = await import("./gate");

const PROJECTS = ["11111111-1111-1111-1111-111111111111"];
const CYCLE: WebsiteCyclePick = {
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: PROJECTS[0],
  cycleAnchorAt: "2026-09-04T00:00:00.000Z",
  cycleWeek: "2026-08-31",
};

beforeEach(() => {
  vi.clearAllMocks();
  readEnabled.mockResolvedValue(true);
  summaryLedgerAvailable.mockResolvedValue(true);
  pickWebsiteCycles.mockResolvedValue({ cycles: [CYCLE], missingProjectIds: [] });
  hasOpenCycle.mockResolvedValue(false);
  summaryScreenAllowed.mockResolvedValue(true);
});

describe("① read_screens — S4.dashboard 가 allowlist 밖이면 미러", () => {
  it("허용되면 hit, 빠지면 fallback:screen-not-allowed (값은 미러가 낸다)", async () => {
    expect(
      summaryRouteHeaderValue(await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard")),
    ).toBe("hit");

    // S6 만 허용 — 같은 요청·같은 회차인데 S4 만 미러로 내려간다.
    const allowed = new Set(["S6.citation"]);
    summaryScreenAllowed.mockImplementation((s) => Promise.resolve(allowed.has(s)));
    const s4 = await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard");
    expect(s4.path).toBe("mirror");
    expect(summaryRouteHeaderValue(s4)).toBe("fallback:screen-not-allowed");
    expect(
      (await resolveWebsiteSummaryRoute(PROJECTS, {}, "S6.citation")).path,
    ).toBe("summary");
  });
});

describe("② planTrendRead — 집계층 키로 표현 못 하는 축은 미러", () => {
  const plan = (filters: Parameters<typeof planTrendRead>[0]["filters"]) =>
    planTrendRead({ surface: "website", filters, unitFlags: true });

  it("기본 경로(무필터·국가·언어·엔진)는 통과하고 변형은 ALL", () => {
    for (const f of [{}, { websiteCountry: ["NO"] }, { lang: ["no"] }, { engine: ["chatgpt"] }]) {
      const p = plan(f);
      expect(p.ok).toBe(true);
      if (p.ok) expect(p.ownVariant).toBe("ALL");
    }
  });

  it("depth2·depth3 는 집계층 키 밖 → 폴백 사유", () => {
    expect(plan({ depth2: ["x"] })).toEqual({ ok: false, reason: "unsupported-agg:depth2" });
    expect(plan({ depth3: ["x"] })).toEqual({ ok: false, reason: "unsupported-agg:depth3" });
  });

  it("브랜드 하나로 좁히면 그 변형, 두 개 이상(admin 임의 조합)은 E4 폴백", () => {
    const one = plan({ brand: ["Kia"] });
    expect(one.ok && one.ownVariant).toBe("Kia");
    expect(plan({ brand: ["Kia", "Genesis"] })).toEqual({
      ok: false,
      reason: "unsupported-agg:own-variant",
    });
  });

  it("게이트가 이미 막는 축은 여기까지 오지 않는다 — cumulative 는 회차 판정이 먼저다", async () => {
    const route = await resolveWebsiteSummaryRoute(PROJECTS, { cumulative: true }, "S4.dashboard");
    expect(summaryRouteHeaderValue(route)).toBe("fallback:cumulative");
  });
});

// ── B6: Sub-KPI 화면 키 분리 (PR③-a) ───────────────────────────────────────
//
// 종전에는 S4 카드의 엔진 일관성 배지가 `S5.mention` 키에 묶여 있었다. 그 키는
// 프로덕션 `read_screens` 에 없어(§6-2 가 T8·GGMD 까지 off) 배지가 **미러**로 떨어졌고,
// 그것이 `website:summary` 11.5~13.5 s 의 원인이었다. 이제 배지는 `S4.subkpi` 를 쓴다.
describe("③ S4.subkpi — S5 와 독립으로 켜고 끈다", () => {
  const PROD = new Set(["S4.dashboard", "S1.dashboard", "S3.citation", "S6.citation"]);

  it("프로덕션 현행값에서는 **둘 다 미러** — 이 PR 은 값을 안 바꾼다", async () => {
    summaryScreenAllowed.mockImplementation((k) => Promise.resolve(PROD.has(k)));
    for (const k of ["S4.subkpi", "S5.mention"] as const) {
      const r = await resolveWebsiteSummaryRoute(PROJECTS, {}, k);
      expect(r.path, k).toBe("mirror");
      expect(summaryRouteHeaderValue(r), k).toBe("fallback:screen-not-allowed");
    }
    // 같은 요청에서 카드(S4.dashboard)는 그대로 hit — 배지만 미러다.
    expect((await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.dashboard")).path).toBe("summary");
  });

  it("S4.subkpi 만 켜면 배지는 집계층, S5 언급 화면은 그대로 미러", async () => {
    const next = new Set([...PROD, "S4.subkpi"]);
    summaryScreenAllowed.mockImplementation((k) => Promise.resolve(next.has(k)));
    expect((await resolveWebsiteSummaryRoute(PROJECTS, {}, "S4.subkpi")).path).toBe("summary");
    expect((await resolveWebsiteSummaryRoute(PROJECTS, {}, "S5.mention")).path).toBe("mirror");
  });
});
