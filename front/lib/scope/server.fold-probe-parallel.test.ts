/**
 * 접힘 프로브 병렬화(PR④ A1)의 **행동 가드**.
 *
 * A1 은 네 게이트(`viaGlobalS1`·`viaGlobalTrend`·`viaGlobalSeries`·`viaTrend`)에서
 * `trendFoldPresent` 를 read 앞의 `await` 에서 떼어내 **동시 발행**으로 바꾼다.
 * 값이 바뀌지 않는 변경이므로, 여기서 실행으로 고정하는 것은 넷이다:
 *
 *   ① 프로브가 끝나기 **전에** 집계층 read 가 이미 발행돼 있다(= 직렬이 아니다).
 *   ② 프로브가 false 면 read 결과를 버리고 **종전 폴백 목적지**(세부층)로 간다.
 *   ③ 버려지는 read 가 거부돼도 폴백은 그대로고, 그 거부가 새어나가지 않는다
 *      (unhandled rejection = Node 프로세스 사망).
 *   ④ 프로브가 **실패**해도 폴백이다 — `summary-trend-fold.ts` 의 "던지지 않는다"
 *      규약(DB 오류 → `false`)과 A1 의 합성이 종전과 같은 목적지를 낸다.
 *
 * 대상 경로는 `viaTrend`(웹사이트 S4 카드)다. 네 게이트의 배선이 같은 모양임은
 * `server.fallback-destination.test.ts` 가 소스 형태로 따로 고정한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SummaryCyclePick } from "@/lib/db/repositories/summary-cycles";

// react-server 빌드라야 `cache()` 가 실제로 memoize 한다(request-scope 참조).
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => fn,
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", role: "admin", scope: { all: true } } }),
}));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {} }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({
  entityRegistryRepository: { listOwn: async () => [] },
}));

const PROJECTS = ["11111111-1111-1111-1111-111111111111"];
vi.mock("@/lib/db/repositories/website-sites", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getProjectIdsForScope: async () => PROJECTS };
});

const CYCLE: SummaryCyclePick = {
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: PROJECTS[0],
  cycleAnchorAt: "2026-09-04T00:00:00.000Z",
  cycleWeek: "2026-08-31",
};
vi.mock("@/lib/db/repositories/summary-cycles", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pickCyclesInRange: async () => [],
    pickWebsiteCycles: async () => ({ cycles: [CYCLE], missingProjectIds: [] }),
    hasOpenCycle: async () => false,
  };
});
vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readEnabled: async () => true,
    summaryLedgerAvailable: async () => true,
    summaryUnitFlagsAvailable: async () => true,
    websiteExcludedUnits: async () => [],
    readScreensRaw: async () => "[]", // 빈 배열 = 전 화면 허용(screens.ts 계약)
  };
});

// ── 프로브는 **실물**을 쓴다 ────────────────────────────────────────────────
// `trendFoldPresent` 를 통째로 바꿔치면 ④(실패 → false → 폴백)를 검증할 수 없다.
// 대신 그 아래 `getDb().execute` 만 조종해 세 상태(접힘 있음/없음/DB 실패)를 만든다.
type ProbeMode = "present" | "absent" | "fail";
let probeMode: ProbeMode = "present";
/** 프로브 문장을 **붙잡아 두는** 걸쇠 — ① 동시 발행 관찰용. */
let probeGate: Promise<void> = Promise.resolve();
const probeCalls = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: async () => {
      probeCalls();
      await probeGate;
      if (probeMode === "fail") throw new Error("probe boom");
      // `trendFoldPresent` 는 (tbl, n) 행을 표 수만큼 기대한다. 기본 표는 `own` 하나.
      return [{ tbl: "own", n: probeMode === "present" ? 1 : 0 }];
    },
  }),
}));

// 리더 계약: `SummaryTrendRead<T>` = `{ empty:false, value }` (폴백 신호를 값과 함께).
const aggRead = vi.fn(async () => ({ empty: false, value: { aggregates: { src: "agg" } } }));
const detailRead = vi.fn(async () => ({ src: "detail" }));
vi.mock("@/lib/db/repositories/summary-website-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    summaryWebsiteDashboard: () => aggRead(),
    summaryWebsiteAggregatesDetail: () => detailRead(),
  };
});

const mirrorRead = vi.fn(async () => ({ src: "mirror" }));
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aggregateStandardFromMirror: () => mirrorRead(),
    websiteDeclaredOwnedBases: async () => ({ prefixes: [], universe: undefined }),
  };
});

const { withRequestScope } = await import("@/test/request-scope");
const { fetchWebsiteAggregates } = await import("./server");

beforeEach(() => {
  vi.clearAllMocks();
  probeMode = "present";
  probeGate = Promise.resolve();
  aggRead.mockImplementation(async () => ({ empty: false, value: { aggregates: { src: "agg" } } }));
});

describe("A1 — 접힘 프로브와 집계층 read 는 동시에 발행된다", () => {
  it("① 프로브가 아직 안 끝났는데 read 는 이미 나가 있다", async () => {
    let openGate = () => {};
    probeGate = new Promise<void>((r) => { openGate = r; });

    const done = withRequestScope(() => fetchWebsiteAggregates({}));
    // 프로브 문장이 발행될 때까지 이벤트 루프를 몇 바퀴 돌린다.
    //
    // ⚠️ 이 수는 **계약이 아니라 예산**이다. 게이트 앞단에 `await` 가 하나 늘 때마다
    //    필요한 틱이 늘어난다(2026-09-18 기간 경로 스위치가 그랬다: 20틱이 모자라
    //    "프로브 미발행" 으로 오판했다). 넉넉히 준다: 이 루프가 재는 것은 "언제" 가
    //    아니라 "프로브보다 read 가 먼저/함께 나갔는가" 이고, 그 판정은 **아래 두 번째
    //    루프 + 닫힌 걸쇠**가 한다. 예산을 늘려도 동시성 단언은 조금도 약해지지 않는다.
    for (let i = 0; i < 200 && probeCalls.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(probeCalls, "프로브 문장이 발행됐다").toHaveBeenCalled();
    // 프로브가 **아직 미결인 상태에서** 집계층 read 가 이미 시작돼 있어야 한다.
    // 직렬(종전)이면 이 시점의 호출 수는 0 이다.
    for (let i = 0; i < 200 && aggRead.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(aggRead, "프로브 미결 상태의 집계층 read").toHaveBeenCalledTimes(1);

    openGate();
    await done;
  });

  it("접힘이 있으면 종전대로 집계층 값을 쓴다(세부층·미러 미호출)", async () => {
    const out = await withRequestScope(() => fetchWebsiteAggregates({}));
    expect(out).toEqual({ src: "agg" });
    expect(detailRead).not.toHaveBeenCalled();
    expect(mirrorRead).not.toHaveBeenCalled();
  });
});

describe("A1 — 프로브가 false 면 read 를 버리고 종전 목적지로 간다", () => {
  it("② 접힘 없음 → 세부층(미러 아님). 값도 세부층 것이다", async () => {
    probeMode = "absent";
    const out = await withRequestScope(() => fetchWebsiteAggregates({}));
    expect(out).toEqual({ src: "detail" });
    expect(detailRead).toHaveBeenCalledTimes(1);
    expect(mirrorRead).not.toHaveBeenCalled();
    // 병렬화의 대가 — 버려지는 read 는 발행된다(커넥션 점유 1회분).
    expect(aggRead).toHaveBeenCalledTimes(1);
  });

  it("③ 버려지는 read 가 거부돼도 폴백은 그대로다 — 거부가 새지 않는다", async () => {
    probeMode = "absent";
    aggRead.mockImplementation(async () => { throw new Error("discarded read boom"); });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const out = await withRequestScope(() => fetchWebsiteAggregates({}));
      expect(out).toEqual({ src: "detail" });
      // 거부가 흡수됐는지 확인 — 이벤트 루프를 한 바퀴 더 돌려 본다.
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("④ 프로브 문장이 실패해도 폴백이다 — 던지지 않는다 규약과의 합성", async () => {
    probeMode = "fail";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await withRequestScope(() => fetchWebsiteAggregates({}));
      expect(out).toEqual({ src: "detail" });
      expect(String(warn.mock.calls[0]?.[0])).toContain("trendFoldPresent");
    } finally {
      warn.mockRestore();
    }
  });
});
