import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { resolveColumnAvailabilityForTests } from "@/lib/db/column-availability";
import { setAnchorAxisForTests } from "@/lib/period/anchor-axis-state";
import type { SQL } from "drizzle-orm";

// website 자사 판정의 형제 모집단(universe)은 화면 축·계정 스코프로 좁히지 않는다
// (2026-09-05). Hyundai N 은 KO=`KR`·EN=`worldwide` 로 website_sites 행이 둘이라,
// 국가로 좁힌 모집단에는 `hyundai-n.com/ko` 가 없고 EN 의 `hyundai-n.com` 이 /ko 인용을
// 삼켰다(자사 273 중 39건). 모집단은 선택된 base 와 호스트가 같은 선언 전부여야 한다.

const dialect = new PgDialect();
const captured: string[] = [];
const params: unknown[][] = [];
let answers: Array<Array<{ base: string }>> = [];
const execute = vi.fn(async (q: SQL) => {
  const built = dialect.sqlToQuery(q);
  captured.push(built.sql);
  params.push(built.params);
  return (answers.shift() ?? []) as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const PIDS = ["164dd533-8e78-4f04-9351-1056f096328a"];

beforeEach(() => {
  // 컬럼 존재 판정 확정(웜 프로세스) — 미확정이면 ensure 프로브가 `answers` 큐를
  // 먼저 소비해 버린다.
  resolveColumnAvailabilityForTests();
  // 앵커 축 판정도 확정해 둔다 — 미확정이면 진입점의 `await ensureAnchorAxis()` 가
  // 0077 테이블 프로브를 한 문장 더 쏴서 이 파일의 문장 순서·호출 횟수 단언이 흔들린다.
  setAnchorAxisForTests(false);
  execute.mockClear();
  captured.length = 0;
  params.length = 0;
  answers = [];
});

describe("websiteDeclaredOwnedBases — 형제 모집단은 호스트 기준", () => {
  it("prefixes 는 화면 축으로 좁히고, universe 는 같은 호스트의 선언 전부를 읽는다", async () => {
    const m = await import("./scope-aggregates");
    answers = [[{ base: "hyundai-n.com" }], [{ base: "hyundai-n.com" }, { base: "hyundai-n.com/ko" }]];
    const r = await m.websiteDeclaredOwnedBases({ websiteCountry: ["worldwide"], lang: ["en"] }, PIDS);
    expect(r.prefixes).toEqual(["hyundai-n.com"]);
    expect(r.universe).toEqual(["hyundai-n.com", "hyundai-n.com/ko"]);
    expect(captured).toHaveLength(2);
    // ① prefixes 쿼리: 스코프·국가·언어로 좁힌다
    expect(captured[0]).toMatch(/scope_project_id/);
    expect(captured[0]).toMatch(/country_code/);
    expect(captured[0]).toMatch(/lang_code/);
    // ② universe 쿼리: 스코프·국가·언어 어느 것도 없고, 호스트로만 거른다
    expect(captured[1]).not.toMatch(/scope_project_id/);
    expect(captured[1]).not.toMatch(/country_code/);
    expect(captured[1]).not.toMatch(/lang_code/);
    expect(captured[1]).toMatch(/split_part\(wp\.owned_base_url, '\/', 1\) IN/);
  });

  it("선언이 없으면 universe 쿼리를 내지 않는다(카탈로그 폴백 경로)", async () => {
    const m = await import("./scope-aggregates");
    answers = [[]];
    const r = await m.websiteDeclaredOwnedBases({}, PIDS);
    expect(r).toEqual({ prefixes: [], universe: [] });
    expect(captured).toHaveLength(1);
  });

  it("호스트가 같은 더 긴 형제가 모집단에 있으면 ⑥ 판정 SQL 이 그 경로를 제외한다", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteCitationAccuracy({}, PIDS, ["hyundai-n.com"], ["hyundai-n.com", "hyundai-n.com/ko"]);
    // 바인딩 파라미터에 형제 접두(`hyundai-n.com/ko/%`)가 제외 절로 들어간다
    expect(params.at(-1)).toContain("hyundai-n.com/ko/%");
    // 모집단에 형제가 없으면 제외 절이 붙지 않는다 — 종전(누수) 형태
    params.length = 0;
    await m.aggregateWebsiteCitationAccuracy({}, PIDS, ["hyundai-n.com"], ["hyundai-n.com"]);
    expect(params.at(-1)).not.toContain("hyundai-n.com/ko/%");
  });
});
