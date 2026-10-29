/**
 * 표준 언급 화면의 **구획 분할이 중복 집계(herd)를 만들지 않는다**는 행동 가드.
 *
 * 2026-09-03 분할: 본문 한 경계(MentionsData)가 언급 집계 + Sub KPI(현재/직전)를
 * Promise.all 로 모으던 것을 세 구획(① 요약 ② 추이 ③ 순위표)으로 쪼갰다. ②③ 은
 * 언급 집계만 소유하므로, 같은 요청 안에서 **같은 필터로 같은 페처가 여러 번**
 * 불린다. 요청단위 dedup 이 이것을 접지 않으면 콜드 키에서 같은 스캔이 N번 돈다 —
 * 분할의 전제조건이 dedup 이라, 그 전제를 여기서 실행으로 확인한다.
 *
 * 구조 단언(어느 구획이 어느 read 를 소유하는가)은 test/streaming-boundaries.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// react-server 빌드로 바꿔야 `cache()` 가 실제로 memoize 한다 (test/request-scope.ts 참조).
// mock 팩토리는 호이스팅되므로 외부 import 를 참조할 수 없다 — 로더를 인라인한다.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

// unstable_cache 는 요청 **간** 캐시 층이다. 여기서 보려는 것은 요청 **안** 의
// dedup 이므로 통과 함수로 둔다 — 그래야 접히지 않은 호출이 그대로 세어진다.
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => fn,
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    // scope.all = true → enforce/assertProjectInScope 가 즉시 통과한다.
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
const { fetchStandardMentions, fetchStandardSubKpis, fetchStandardSubKpisPrev } =
  await import("./server");

const SUB = { rows: [], promptsWithoutBrand: null, measuredPrompts: 10 };

beforeEach(() => {
  process.env.SCOPE_ROOT_PROJECT_ID = "root-1";
  vi.clearAllMocks();
  aggregateMentionsFromMirror.mockResolvedValue({ asOf: "2026-09-01", brands: [] });
  aggregateSubKpisFromMirror.mockResolvedValue(SUB);
  latestMeasureDays.mockResolvedValue(["2026-09-01", "2026-08-25"]);
});

describe("표준 언급 구획 분할 — 요청단위 dedup", () => {
  it("세 구획이 같은 필터로 언급 집계를 불러도 미러 집계는 1회", async () => {
    await withRequestScope(async () =>
      Promise.all([
        // 구획마다 자기 객체 리터럴 — 참조는 다르고 값은 같다(실제 분할과 동일).
        fetchStandardMentions({ region: ["KR"], engine: ["gpt"] }), // ① 요약
        fetchStandardMentions({ engine: ["gpt"], region: ["KR"] }), // ② 추이
        fetchStandardMentions({ region: ["KR"], engine: ["gpt"] }), // ③ 순위표
      ]),
    );
    expect(aggregateMentionsFromMirror).toHaveBeenCalledTimes(1);
  });

  it("Sub KPI(현재/직전)도 접힌다 — 구획이 늘어도 DB 왕복은 각 1회", async () => {
    await withRequestScope(async () =>
      Promise.all([
        fetchStandardSubKpis({ region: ["KR"] }),
        fetchStandardSubKpis({ region: ["KR"] }),
        fetchStandardSubKpisPrev({ region: ["KR"] }),
        fetchStandardSubKpisPrev({ region: ["KR"] }),
      ]),
    );
    // 현재 스냅샷 1회 + 직전 스냅샷 1회 = 2회 (4회가 아니다).
    expect(aggregateSubKpisFromMirror).toHaveBeenCalledTimes(2);
    expect(latestMeasureDays).toHaveBeenCalledTimes(1);
  });

  it("필터 값이 다르면 접히지 않는다 — dedup 이 모집단을 뭉개지 않는다", async () => {
    await withRequestScope(async () =>
      Promise.all([
        fetchStandardMentions({ region: ["KR"] }),
        fetchStandardMentions({ region: ["US"] }),
      ]),
    );
    expect(aggregateMentionsFromMirror).toHaveBeenCalledTimes(2);
  });

  it("요청이 다르면 다시 읽는다 — 요청 간 캐시는 unstable_cache 의 층이다", async () => {
    await withRequestScope(async () => fetchStandardSubKpis({ region: ["KR"] }));
    await withRequestScope(async () => fetchStandardSubKpis({ region: ["KR"] }));
    expect(aggregateSubKpisFromMirror).toHaveBeenCalledTimes(2);
  });
});
