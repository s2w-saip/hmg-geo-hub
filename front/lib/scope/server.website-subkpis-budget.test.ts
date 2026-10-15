/**
 * 웹사이트 Sub-KPI 미러 read 의 예산·파트 축소 (PR④ A4).
 *
 * `aggregateSubKpisFromMirror` 는 문장 5개를 한 트랜잭션에서 발행하는데 이 경로에는
 * **상한이 아예 없었다**(라이브 `website:summary-deltas` 6.8~7.0 s). 고정하는 것 넷:
 *
 *   ① 웹사이트 셀이 `extras` 예산(15 s 문장 / 30 s 벽시계)을 넘긴다.
 *   ② S4 배지는 파트를 `answers·mentions·sentiment·citations` 로 좁힌다(Q5 제거).
 *   ③ S5 언급 화면은 **안 좁힌다** — 그쪽은 Q5 를 읽는다.
 *   ④ 좁혀도 `rows` 는 그대로다(배지 값 무변경 — 배지는 `rows` 만 읽는다).
 *
 * 그리고 마지막 하나가 회귀 가드다: `server.ts` 안의 Sub-KPI 미러 호출부 중 **예산이
 * 없는 것**의 집합을 소스로 고정한다(PR⑤ 이월분 명시 허용 목록). 새 무예산 호출부가
 * 생기거나 이월분이 늘면 깨진다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { S4_BADGE_SUB_KPI_PARTS } from "./kpi-tab-budget";
import { readSourceText } from "@/test/source-text";

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
// 집계층 스위치 off → `gate-disabled` → **미러 폴백**.
vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readEnabled: async () => false };
});

const PROJECTS = ["11111111-1111-1111-1111-111111111111"];
vi.mock("@/lib/db/repositories/website-sites", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getProjectIdsForScope: async () => PROJECTS };
});

const aggregateSubKpisFromMirror = vi.fn();
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aggregateSubKpisFromMirror: (...a: unknown[]) => aggregateSubKpisFromMirror(...a),
    websiteDeclaredOwnedBases: async () => ({ prefixes: [], universe: undefined }),
  };
});

const { withRequestScope } = await import("@/test/request-scope");
const { fetchWebsiteSubKpis } = await import("./server");

const ROWS = [
  {
    target: "chatgpt", answers: 100, tracked: 60, multi: 10, top1: 5, top3: 20,
    avgPosition: 2.1, totalMentions: 400, trackedMentions: 120,
    sentMentions: 80, positiveMentions: 50, negativeMentions: 10,
    citTotal: 30, citOwned: 9,
  },
];
/** 파트를 좁히면 리포지터리가 Q5 자리를 `null` 로 낸다(계산 안 함 = "측정 없음"과 동형). */
const NARROWED = { rows: ROWS, promptsWithoutBrand: null, measuredPrompts: null };
const FULL = { rows: ROWS, promptsWithoutBrand: 12, measuredPrompts: 300 };

/** 리포지터리가 받은 `SubKpiOptions`(6번째 인자). */
function optsOf(call = 0) {
  return aggregateSubKpisFromMirror.mock.calls[call]?.[5] as
    | { parts?: readonly string[]; statementTimeoutMs?: number; budgetMs?: number }
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregateSubKpisFromMirror.mockResolvedValue(NARROWED);
});

describe("A4 — 웹사이트 Sub-KPI 미러 예산", () => {
  it("① S4 배지 경로가 `extras` 예산(15/30)을 넘긴다", async () => {
    await withRequestScope(() =>
      fetchWebsiteSubKpis({}, { screen: "S4.subkpi" }));
    expect(optsOf()?.statementTimeoutMs).toBe(15_000);
    expect(optsOf()?.budgetMs).toBe(30_000);
  });

  it("S5 언급 화면도 같은 예산을 받는다 — 무예산 경로가 남지 않는다", async () => {
    aggregateSubKpisFromMirror.mockResolvedValue(FULL);
    await withRequestScope(() => fetchWebsiteSubKpis({}));
    expect(optsOf()?.statementTimeoutMs).toBe(15_000);
    expect(optsOf()?.budgetMs).toBe(30_000);
  });
});

describe("A4 — 파트 축소는 S4 배지에서만", () => {
  it("② S4 배지는 Q5(`prompts`)를 뺀 넷만 요청한다", async () => {
    await withRequestScope(() =>
      fetchWebsiteSubKpis({}, { screen: "S4.subkpi" }));
    expect(optsOf()?.parts).toEqual(["answers", "mentions", "sentiment", "citations"]);
    expect(optsOf()?.parts).not.toContain("prompts");
    expect([...S4_BADGE_SUB_KPI_PARTS]).toEqual([...(optsOf()?.parts ?? [])]);
  });

  it("③ S5 언급 화면은 좁히지 않는다(= 전량)", async () => {
    aggregateSubKpisFromMirror.mockResolvedValue(FULL);
    await withRequestScope(() => fetchWebsiteSubKpis({}));
    expect(optsOf()?.parts).toBeUndefined();
  });

  it("④ 좁혀도 `rows` 는 그대로다 — 배지가 읽는 것은 그것뿐이다", async () => {
    const narrow = await withRequestScope(() =>
      fetchWebsiteSubKpis({}, { screen: "S4.subkpi" }));
    expect(narrow.rows).toEqual(ROWS);
    // 배지가 읽는 9 필드가 전부 살아 있다(`applyEngineConsistency`).
    for (const k of [
      "answers", "tracked", "totalMentions", "trackedMentions",
      "sentMentions", "positiveMentions", "avgPosition", "citTotal", "citOwned",
    ]) {
      expect(narrow.rows[0], k).toHaveProperty(k);
    }
  });

  it("좁힌 셀과 전량 셀은 **캐시 키가 갈린다** — 한 셀을 나눠 쓰면 S5 가 빈다", async () => {
    // 같은 요청 안에서 두 화면 키로 부르면 리포지터리가 **두 번** 불린다
    // (셀이 하나면 두 번째가 첫 번째의 좁힌 결과를 그대로 받는다).
    await withRequestScope(async () => {
      await fetchWebsiteSubKpis({}, { screen: "S4.subkpi" });
      await fetchWebsiteSubKpis({});
    });
    expect(aggregateSubKpisFromMirror).toHaveBeenCalledTimes(2);
    expect(optsOf(0)?.parts).toEqual([...S4_BADGE_SUB_KPI_PARTS]);
    expect(optsOf(1)?.parts).toBeUndefined();
  });
});

// ── 회귀 가드 — 예산 없는 Sub-KPI 미러 호출부의 집합을 고정한다 ─────────────
describe("A4 — 무예산 Sub-KPI 미러 호출부는 명시 이월분뿐이다", () => {
  const server = readSourceText(
    fileURLToPath(new URL("./server.ts", import.meta.url)),
  );

  /**
   * PR⑤ 로 이월한 무예산 호출부. 전부 **표준·프로젝트 표면**이고 PR④ 의 대상 마커
   * (`website:summary-deltas`)를 안 탄다. 늘리려면 근거를 여기 적어야 한다.
   * (플랜 §6 "잔여 미러 예산(H6) … 목록의 나머지는 PR⑤".)
   */
  const DEFERRED_TO_PR5 = new Set([
    "cachedSubKpis",        // 표준 S2/S5 언급 화면 전량
    "cachedSubKpisParts",   // 4-KPI 탭 히어로(파트는 이미 좁다)
    "subKpisPrevImpl",      // 직전 스냅샷 — 표준·프로젝트·웹사이트 공용 구현
    "cachedProjectSubKpis", // 프로젝트 표면
  ]);

  /** 이 오프셋을 감싸는 최상위 선언 이름. */
  function enclosing(offset: number): string {
    const head = server.slice(0, offset);
    const m = [...head.matchAll(/^(?:export )?(?:async function|const) (\w+)/gm)].pop();
    return m?.[1] ?? "(unknown)";
  }

  it("호출부를 전부 잡아낸다(추출기가 죽지 않았는지)", () => {
    const calls = [...server.matchAll(/aggregateSubKpisFromMirror\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("예산이 없는 호출부 = 이월 목록과 정확히 같다", () => {
    const unbudgeted = new Set<string>();
    for (const m of server.matchAll(/aggregateSubKpisFromMirror\(/g)) {
      // 호출 인자 블록 — 다음 빈 줄 전까지로 충분하다(호출부가 전부 짧다).
      const block = server.slice(m.index, server.indexOf("\n\n", m.index));
      if (!/budgetMs/.test(block)) unbudgeted.add(enclosing(m.index));
    }
    expect(unbudgeted).toEqual(DEFERRED_TO_PR5);
    // 웹사이트 셀은 **반드시** 예산을 가진다(A4 의 본체).
    expect(unbudgeted.has("cachedWebsiteSubKpis")).toBe(false);
  });
});
