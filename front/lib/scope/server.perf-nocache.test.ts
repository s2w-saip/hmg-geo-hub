/**
 * T18 캐시 우회 프로브 게이트 — `mirrorCache` 키 동작의 행동 가드.
 *
 * 지켜야 할 것 셋:
 *  1. **fail-closed** — 헤더 없음·불일치·`CRON_SECRET` 미설정이면 캐시 키가 종전과
 *     **완전히 동일**하다(솔트 조각이 아예 붙지 않는다). 게이트가 실사용자 캐시를
 *     조용히 무력화하면 프로덕션이 상시 콜드가 된다.
 *  2. **일치하면 우회** — 키에 요청별 솔트가 붙어 아무도 안 쓰는 새 셀을 만든다.
 *     (기존 셀은 건드리지 않는다 = revalidateTag 를 부르지 않는다.)
 *  3. **요청당 솔트 1개** — 한 요청 안의 서로 다른 캐시 셀들이 **같은** 솔트를 받는다.
 *     셀마다 새 uuid 를 뽑으면 우회는 되지만, 한 요청 안에서 같은 집계를 두 섹션이
 *     부를 때 중복 계산이 생겨 측정값이 실제 콜드 렌더보다 부풀려진다.
 *
 * 구조는 server.mention-sections.dedupe.test.ts 와 같다 — `cache()` 가 실제로
 * memoize 하려면 react-server 빌드 + 요청 스코프가 필요하다(test/request-scope.ts).
 */
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";

// mock 팩토리는 호이스팅되므로 외부 import 를 참조할 수 없다 — 로더를 인라인한다.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

// 캐시 키를 관찰하려고 `unstable_cache` 를 통과 함수 + 기록기로 바꾼다.
const cacheCalls: { keyParts: string[]; revalidate: number | undefined }[] = [];
const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(
    fn: (...a: A) => Promise<R>,
    keyParts: string[],
    opts: { revalidate?: number },
  ) => {
    cacheCalls.push({ keyParts, revalidate: opts?.revalidate });
    return fn;
  },
  revalidateTag: (...a: unknown[]) => revalidateTag(...a),
  revalidatePath: () => {},
}));

let headerValue: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => (name === "x-hmg-perf-nocache" ? headerValue : null),
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", role: "admin", scope: { all: true } },
  }),
}));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {} }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({
  entityRegistryRepository: { listOwn: async () => [] },
}));

const aggregateMentionsFromMirror = vi.fn();
const aggregateSubKpisFromMirror = vi.fn();
const latestMeasureDays = vi.fn();
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aggregateMentionsFromMirror: (...a: unknown[]) => aggregateMentionsFromMirror(...a),
    aggregateSubKpisFromMirror: (...a: unknown[]) => aggregateSubKpisFromMirror(...a),
    latestMeasureDays: (...a: unknown[]) => latestMeasureDays(...a),
  };
});

const { withRequestScope } = await import("@/test/request-scope");
const { fetchStandardMentions, fetchStandardSubKpis } = await import("./server");

const SECRET = "probe-secret-value";
const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.SCOPE_ROOT_PROJECT_ID = "root-1";
  process.env.CRON_SECRET = SECRET;
  headerValue = null;
  cacheCalls.length = 0;
  vi.clearAllMocks();
  aggregateMentionsFromMirror.mockResolvedValue({ asOf: "2026-09-01", brands: [] });
  aggregateSubKpisFromMirror.mockResolvedValue({
    rows: [],
    promptsWithoutBrand: null,
    measuredPrompts: 10,
  });
  latestMeasureDays.mockResolvedValue(["2026-09-01", "2026-08-25"]);
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

/** 관심 있는 셀의 키 조각(= [세대, 셀 이름, (솔트)]). */
function keysFor(cell: string): string[][] {
  return cacheCalls.filter((c) => c.keyParts[1] === cell).map((c) => c.keyParts);
}

/** 이 실행에서 만들어진 솔트 키(길이 3) 전부. 게이트가 닫히면 0개여야 한다. */
function saltedKeys(): string[][] {
  return cacheCalls.filter((c) => c.keyParts.length === 3).map((c) => c.keyParts);
}

// ⚠️ 게이트 off 를 "길이 2 키가 기록됐다"로 보면 안 된다 — 기본 래퍼는
// `lazyCache` 로 모듈 수명 동안 1회만 만들어져서, 두 번째 테스트부터는 아예
// 기록되지 않는다. 판정은 "솔트 키가 0개" + "집계가 실제로 불렸다"(= 경로가
// 돌긴 했다) 두 가지로 한다.

async function readTwoCells() {
  await withRequestScope(async () => {
    await fetchStandardMentions({ region: ["KR"] });
    await fetchStandardSubKpis({ region: ["KR"] });
  });
}

describe("T18 프로브 게이트 — mirrorCache 캐시 키", () => {
  it("헤더가 없으면 키가 종전 그대로다 (솔트 조각 없음)", async () => {
    await readTwoCells();
    expect(aggregateMentionsFromMirror).toHaveBeenCalled();
    expect(saltedKeys()).toHaveLength(0);
  });

  it("헤더 값이 틀리면 무시한다 — 우회하지 않는다", async () => {
    headerValue = "not-the-secret";
    await readTwoCells();
    expect(aggregateMentionsFromMirror).toHaveBeenCalled();
    expect(saltedKeys()).toHaveLength(0);
  });

  it("길이가 같고 값만 다른 헤더도 통과하지 못한다", async () => {
    headerValue = "x".repeat(SECRET.length);
    await readTwoCells();
    expect(saltedKeys()).toHaveLength(0);
  });

  it("CRON_SECRET 미설정이면 어떤 헤더로도 우회하지 않는다", async () => {
    delete process.env.CRON_SECRET;
    headerValue = "";
    await readTwoCells();
    expect(saltedKeys()).toHaveLength(0);
    headerValue = SECRET;
    await readTwoCells();
    expect(saltedKeys()).toHaveLength(0);
  });

  it("헤더가 맞으면 키에 솔트가 붙고, 같은 요청의 다른 셀도 **같은** 솔트를 쓴다", async () => {
    headerValue = SECRET;
    await readTwoCells();
    const mention = keysFor("standard-mentions");
    const sub = keysFor("sub-kpis");
    expect(mention.length).toBeGreaterThanOrEqual(1);
    expect(sub.length).toBeGreaterThanOrEqual(1);
    const salts = new Set([...mention, ...sub].map((k) => k[2]));
    expect([...salts]).toHaveLength(1);
    expect([...salts][0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // 세대·셀 이름은 그대로 — 솔트는 **덧붙는다**(기존 키 조각을 갈아치우지 않는다).
    expect(mention[0][0]).toBe(sub[0][0]);
    expect(mention[0][1]).toBe("standard-mentions");
    expect(sub[0][1]).toBe("sub-kpis");
  });

  it("요청이 다르면 솔트도 다르다 — 프로브 2회차가 1회차 셀을 재사용하지 않는다", async () => {
    headerValue = SECRET;
    await withRequestScope(async () => fetchStandardMentions({ region: ["KR"] }));
    const first = keysFor("standard-mentions")[0][2];
    cacheCalls.length = 0;
    await withRequestScope(async () => fetchStandardMentions({ region: ["KR"] }));
    const second = keysFor("standard-mentions")[0][2];
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("우회는 캐시를 지우지 않는다 — revalidateTag 를 부르지 않는다", async () => {
    headerValue = SECRET;
    await readTwoCells();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("솔트 셀은 본 TTL(7200s)을 물려받지 않는다 — 죽은 셀이 2시간 남지 않게", async () => {
    headerValue = SECRET;
    await readTwoCells();
    const salted = cacheCalls.filter((c) => c.keyParts.length === 3);
    expect(salted.length).toBeGreaterThanOrEqual(1);
    for (const c of salted) expect(c.revalidate).toBe(60);
  });
});
