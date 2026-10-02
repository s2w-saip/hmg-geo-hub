/**
 * `mirrorCache` 키의 **회차 정체성** — 행동 가드 (2026-09-27).
 *
 * 사고: 프리뷰 웹사이트 카드 36개 중 17개가 "측정 기준일 2026-09-25" 라벨 아래 9/18 값을
 * 냈다. 앵커 수동 적재(04:47~04:51Z)가 `revalidateTag` 를 안 거쳐, 적재 전에 채워진 셀이
 * TTL(7,200초) 동안 그대로 서빙됐다. 키에 회차가 없었기 때문이다.
 *
 * 여기서 `unstable_cache` 를 **진짜처럼 동작하는 가짜**(키 조각 + 인자 → 저장값, JSON
 * 라운드트립)로 갈아 끼우고 공개 페처를 부른다. 그래서 "키가 다르다"가 아니라
 * **"같은 (필터) 호출이 다른 셀로 가서 집계가 다시 돈다"** 를 직접 관찰한다.
 *
 * 지키는 것:
 *   ① 축 on — 회차 조각이 바뀌면 같은 필터 호출이 **다른 셀**로 간다(집계 재실행).
 *      같은 조각으로 돌아오면 그 셀을 다시 쓴다(히트).
 *   ② 축 off — 키 조각·TTL·태그가 종전과 **글자 그대로** 같고, 지문을 묻지도 않는다.
 *      회차 조각이 무엇이든 off 셀은 하나다.
 *   ③ 판정 실패 조각(`cycle-unknown:<버킷>`)은 어떤 지문 셀과도 섞이지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

// 동작하는 가짜 캐시 — 키 조각 + 인자로 저장하고, 저장·반환 모두 JSON 라운드트립이다
// (Next Data Cache 가 하는 직렬화를 재현해 Map·Set 반환을 드러낸다).
type CacheCall = { keyParts: string[]; revalidate: number | undefined; tags: string[] };
const cacheCalls: CacheCall[] = [];
const store = new Map<string, string>();
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(
    fn: (...a: A) => Promise<R>,
    keyParts: string[],
    opts: { revalidate?: number; tags?: string[] },
  ) => {
    cacheCalls.push({ keyParts, revalidate: opts?.revalidate, tags: opts?.tags ?? [] });
    return async (...a: A): Promise<R> => {
      const k = JSON.stringify([keyParts, a]);
      const hit = store.get(k);
      if (hit !== undefined) return JSON.parse(hit) as R;
      const v = JSON.stringify(await fn(...a));
      store.set(k, v);
      return JSON.parse(v) as R;
    };
  },
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", role: "admin", scope: { all: true } } }),
}));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {} }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({
  entityRegistryRepository: { listOwn: async () => [] },
}));

const aggregateMentionsFromMirror = vi.fn();
const aggregateSubKpisFromMirror = vi.fn();
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aggregateMentionsFromMirror: (...a: unknown[]) => aggregateMentionsFromMirror(...a),
    aggregateSubKpisFromMirror: (...a: unknown[]) => aggregateSubKpisFromMirror(...a),
    websiteDeclaredOwnedBases: async () => ({ prefixes: [], universe: undefined }),
    websiteOwnedUnits: async () => [],
  };
});
// 웹사이트 경로: 집계층 스위치 off → 미러 폴백(`website-subkpis` 셀, 유닛 옵트인 셀).
vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readEnabled: async () => false };
});
vi.mock("@/lib/db/repositories/website-sites", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getProjectIdsForScope: async () => ["11111111-1111-1111-1111-111111111111"],
  };
});
let unitOn = false;
vi.mock("@/lib/scope/website-owned-unit-state", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ensureWebsiteOwnedUnit: async () => unitOn,
    websiteOwnedUnitKnownEnabled: () => unitOn,
  };
});

// 축·격자·회차 판정 — 리더가 보는 그 상태를 테스트가 쥔다.
let axisOn = false;
let gridOn = false;
vi.mock("@/lib/period/anchor-axis-state", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureAnchorAxis: async () => axisOn };
});
vi.mock("@/lib/period/trend-grid-flag", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ensureTrendGrid: async () => gridOn,
    trendGridKnownEnabled: () => gridOn,
    preCatalogCacheSlot: () => "",
  };
});
let slot = "cycle:aaaaaaaaaaaaaaaa";
let ledgerSlot = "cycle-l:llllllllllllllll";
const ensureCycleCacheSlot = vi.fn(async (mode: string = "gate") =>
  mode === "ledger" ? ledgerSlot : slot);
vi.mock("@/lib/period/cycle-fingerprint", () => ({
  ensureCycleCacheSlot: (mode?: string) => ensureCycleCacheSlot(mode),
}));

const { withRequestScope } = await import("@/test/request-scope");
const {
  fetchStandardMentions,
  fetchWebsiteSubKpis,
  mirrorCacheForTests,
  MIRROR_AGGREGATE_TAG,
  MIRROR_CACHE_TTL,
  SUMMARY_TAG,
} = await import("./server");

const FILTERS = { region: ["KR"] };

/** 한 요청 = 한 번의 화면 로드. 요청 단위 dedupe 가 섞이지 않게 요청마다 새 스코프. */
async function load(): Promise<void> {
  await withRequestScope(async () => {
    await fetchStandardMentions(FILTERS);
  });
}

function keysFor(cell: string): string[][] {
  return cacheCalls.filter((c) => c.keyParts[1] === cell).map((c) => c.keyParts);
}

beforeEach(() => {
  process.env.SCOPE_ROOT_PROJECT_ID = "root-1";
  store.clear();
  axisOn = false;
  gridOn = false;
  unitOn = false;
  slot = "cycle:aaaaaaaaaaaaaaaa";
  ledgerSlot = "cycle-l:llllllllllllllll";
  aggregateMentionsFromMirror.mockReset();
  aggregateMentionsFromMirror.mockResolvedValue({ asOf: "2026-09-25", brands: [] });
  aggregateSubKpisFromMirror.mockReset();
  aggregateSubKpisFromMirror.mockResolvedValue({
    rows: [], promptsWithoutBrand: null, measuredPrompts: null,
  });
  ensureCycleCacheSlot.mockClear();
});

async function loadWebsiteSubKpis(): Promise<void> {
  await withRequestScope(async () => {
    await fetchWebsiteSubKpis({});
  });
}

describe("① 축 on — 회차 조각이 셀을 가른다", () => {
  it("같은 조각이면 두 번째 로드는 히트다", async () => {
    axisOn = true;
    await load();
    await load();
    expect(aggregateMentionsFromMirror).toHaveBeenCalledTimes(1);
  });

  it("[9/27 재현] 조각이 바뀌면 같은 필터 호출이 **다른 셀**로 가서 집계가 다시 돈다", async () => {
    axisOn = true;
    aggregateMentionsFromMirror.mockResolvedValueOnce({ asOf: "2026-09-18", brands: [] });
    await load(); // 적재 전: 9/18 값이 셀에 들어간다
    slot = "cycle:bbbbbbbbbbbbbbbb"; // 앵커 적재 → 지문 변경
    await load();
    expect(aggregateMentionsFromMirror).toHaveBeenCalledTimes(2);
    const keys = keysFor("standard-mentions");
    expect(keys).toContainEqual([
      expect.any(String),
      "standard-mentions",
      "anchor-axis",
      "cycle:aaaaaaaaaaaaaaaa",
    ]);
    expect(keys).toContainEqual([
      expect.any(String),
      "standard-mentions",
      "anchor-axis",
      "cycle:bbbbbbbbbbbbbbbb",
    ]);
  });

  it("조각이 원래대로 돌아오면 그 셀을 다시 쓴다(새 계산 없음)", async () => {
    axisOn = true;
    await load();
    slot = "cycle:bbbbbbbbbbbbbbbb";
    await load();
    slot = "cycle:aaaaaaaaaaaaaaaa";
    await load();
    expect(aggregateMentionsFromMirror).toHaveBeenCalledTimes(2);
  });

  it("격자 on 이면 회차 조각 **뒤에** 격자 조각이 붙는다", async () => {
    axisOn = true;
    gridOn = true;
    await load();
    expect(keysFor("standard-mentions")).toContainEqual([
      expect.any(String),
      "standard-mentions",
      "anchor-axis",
      "cycle:aaaaaaaaaaaaaaaa",
      "trend-grid",
    ]);
  });

  it("축 on 셀의 TTL·태그는 축 off 셀과 같다", async () => {
    axisOn = true;
    await load();
    const on = cacheCalls.filter(
      (c) => c.keyParts[1] === "standard-mentions" && c.keyParts[2] === "anchor-axis",
    );
    expect(on.length).toBeGreaterThanOrEqual(1);
    for (const c of on) {
      expect(c.revalidate).toBe(MIRROR_CACHE_TTL);
      expect(c.tags).toEqual([MIRROR_AGGREGATE_TAG]);
    }
  });
});

describe("② 축 off — 종전과 글자 그대로", () => {
  it("지문을 묻지 않고, 조각이 바뀌어도 셀은 하나다", async () => {
    axisOn = false;
    await load();
    slot = "cycle:bbbbbbbbbbbbbbbb";
    await load();
    slot = "cycle-unknown:1";
    await load();
    expect(ensureCycleCacheSlot).not.toHaveBeenCalled();
    expect(aggregateMentionsFromMirror).toHaveBeenCalledTimes(1);
  });

  it("off 셀의 키 조각은 [세대, 셀 이름] 둘뿐이고 TTL 7,200·태그 미러 하나다", async () => {
    axisOn = false;
    await load();
    const off = cacheCalls.filter(
      (c) => c.keyParts[1] === "standard-mentions" && c.keyParts.length === 2,
    );
    // 종전 래퍼는 모듈 수명 동안 1회만 만들어진다(lazyCache) — 이 파일에서 정확히 1개.
    expect(off).toHaveLength(1);
    expect(off[0].keyParts[0]).toMatch(/^mirror-v5-/);
    expect(off[0].revalidate).toBe(7200);
    expect(off[0].tags).toEqual(["mirror-aggregates"]);
    // 회차 조각이 off 키에 새지 않았다.
    expect(off[0].keyParts.join("|")).not.toContain("cycle");
  });
});

describe("③ 판정 실패 조각", () => {
  it("실패 버킷 셀은 지문 셀과 섞이지 않는다(실패 중 채운 값이 지문 셀로 새지 않는다)", async () => {
    axisOn = true;
    slot = "cycle-unknown:5898900";
    aggregateMentionsFromMirror.mockResolvedValueOnce({ asOf: "fail-bucket", brands: [] });
    await load();
    slot = "cycle:aaaaaaaaaaaaaaaa";
    await load();
    expect(aggregateMentionsFromMirror).toHaveBeenCalledTimes(2);
    slot = "cycle-unknown:5898901"; // 다음 버킷 = 새 키
    await load();
    expect(aggregateMentionsFromMirror).toHaveBeenCalledTimes(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 검증 반영(2026-09-27) — 유닛 셀·모드·태그
// ════════════════════════════════════════════════════════════════════════════

describe("④ 유닛 옵트인 셀(website-subkpis) — 공개 페처로 관찰", () => {
  it("[M3·M6] 축 off + 유닛 on 이면 키는 [세대, 이름, \"owned-unit\"] 이고 지문을 묻지 않는다", async () => {
    axisOn = false;
    unitOn = true;
    await loadWebsiteSubKpis();
    slot = "cycle:bbbbbbbbbbbbbbbb";
    await loadWebsiteSubKpis();
    expect(ensureCycleCacheSlot).not.toHaveBeenCalled();
    expect(aggregateSubKpisFromMirror).toHaveBeenCalledTimes(1);
    expect(keysFor("website-subkpis")).toContainEqual([
      expect.stringMatching(/^mirror-v5-/),
      "website-subkpis",
      "owned-unit",
    ]);
    // 이 경로로 만들어진 키 중 회차 조각이 실린 것은 없다.
    expect(
      keysFor("website-subkpis").filter((k) => !k.includes("anchor-axis")).flat().join("|"),
    ).not.toContain("cycle");
  });

  it("축 off + 유닛 off 이면 키는 [세대, 이름] 이다", async () => {
    axisOn = false;
    unitOn = false;
    await loadWebsiteSubKpis();
    expect(ensureCycleCacheSlot).not.toHaveBeenCalled();
    expect(keysFor("website-subkpis")).toContainEqual([
      expect.stringMatching(/^mirror-v5-/),
      "website-subkpis",
    ]);
  });

  it("축 on + 유닛 on 이면 [.., \"anchor-axis\", 회차, \"owned-unit\"] 이고 회차가 바뀌면 다른 셀이다", async () => {
    axisOn = true;
    unitOn = true;
    await loadWebsiteSubKpis();
    slot = "cycle:bbbbbbbbbbbbbbbb";
    await loadWebsiteSubKpis();
    expect(aggregateSubKpisFromMirror).toHaveBeenCalledTimes(2);
    expect(keysFor("website-subkpis")).toContainEqual([
      expect.any(String), "website-subkpis", "anchor-axis", "cycle:aaaaaaaaaaaaaaaa", "owned-unit",
    ]);
    expect(ensureCycleCacheSlot).toHaveBeenCalledWith("gate");
  });
});

describe("⑤ 셀 모드 — summary-* 제외 · period-compare ledger", () => {
  // 테스트 전용 셀을 공개 라우팅 그대로 만든다(`mirrorCacheForTests` = `mirrorCache`).
  const hits: string[] = [];
  const summaryCell = mirrorCacheForTests(
    "summary-test-cell",
    async (cycleKey: string) => { hits.push(`s:${cycleKey}`); return { v: cycleKey }; },
    [SUMMARY_TAG],
  );
  const periodCell = mirrorCacheForTests(
    "period-compare",
    async (day: string) => { hits.push(`p:${day}`); return [{ day }]; },
    [SUMMARY_TAG],
    600,
  );
  const plainCell = mirrorCacheForTests(
    "plain-test-cell",
    async (x: string) => { hits.push(`g:${x}`); return { x }; },
  );
  const run = <T,>(f: () => Promise<T>) => withRequestScope(f);

  it("summary-* 셀은 축 on 이어도 회차 조각이 없고 지문을 묻지 않는다(키 첫 인자가 회차 키)", async () => {
    axisOn = true;
    await run(() => summaryCell("cycle-set-1"));
    slot = "cycle:bbbbbbbbbbbbbbbb";
    await run(() => summaryCell("cycle-set-1"));
    expect(hits.filter((h) => h.startsWith("s:"))).toHaveLength(1);
    expect(ensureCycleCacheSlot).not.toHaveBeenCalled();
    expect(keysFor("summary-test-cell")).toContainEqual([
      expect.any(String), "summary-test-cell", "anchor-axis",
    ]);
  });

  it("[M4] 축 on 조각 셀도 SUMMARY_TAG 를 잃지 않는다", async () => {
    axisOn = true;
    await run(() => summaryCell("cycle-set-2"));
    await run(() => periodCell("2026-09-25"));
    const onCalls = cacheCalls.filter(
      (c) => ["summary-test-cell", "period-compare"].includes(c.keyParts[1])
        && c.keyParts[2] === "anchor-axis",
    );
    expect(onCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of onCalls) expect(c.tags).toEqual([MIRROR_AGGREGATE_TAG, SUMMARY_TAG]);
    // 셀별 TTL 도 축 on 래퍼에 그대로 간다.
    const p = onCalls.find((c) => c.keyParts[1] === "period-compare");
    expect(p?.revalidate).toBe(600);
  });

  it("period-compare 는 ledger 조각(cycle-l:)을 싣고, gate 만 바뀌면 같은 셀이다", async () => {
    axisOn = true;
    hits.length = 0;
    await run(() => periodCell("2026-09-26"));
    slot = "cycle:bbbbbbbbbbbbbbbb"; // gate 만 변경
    await run(() => periodCell("2026-09-26"));
    expect(hits).toEqual(["p:2026-09-26"]);
    ledgerSlot = "cycle-l:mmmmmmmmmmmmmmmm"; // ledger 변경
    await run(() => periodCell("2026-09-26"));
    expect(hits).toEqual(["p:2026-09-26", "p:2026-09-26"]);
    expect(ensureCycleCacheSlot).toHaveBeenCalledWith("ledger");
    expect(keysFor("period-compare")).toContainEqual([
      expect.any(String), "period-compare", "anchor-axis", "cycle-l:llllllllllllllll",
    ]);
  });

  it("일반 셀은 gate 조각이고 ledger 만 바뀌면 같은 셀이다", async () => {
    axisOn = true;
    hits.length = 0;
    await run(() => plainCell("x"));
    ledgerSlot = "cycle-l:nnnnnnnnnnnnnnnn";
    await run(() => plainCell("x"));
    expect(hits).toEqual(["g:x"]);
    slot = "cycle:cccccccccccccccc";
    await run(() => plainCell("x"));
    expect(hits).toEqual(["g:x", "g:x"]);
  });
});
