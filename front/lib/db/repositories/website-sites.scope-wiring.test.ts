import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { AllowedScope } from "@/lib/auth/types";

// 호출부 배선 가드 — `websiteScopeCountryCondition` 자체의 단위 테스트
// (website-sites.effective-countries.test.ts)는 **호출부가 그 함수를 쓰는지**를
// 지키지 못한다. 2026-09-29 독립 검증에서 getProjectIdsForScope 를 옛
// `if (countries?.length)` 패턴으로 되돌리는 변이가 website 테스트 전부를 통과했다
// (server.* 테스트는 이 함수를 mock 한다). 그래서 getDb 를 가로채 각 읽기가 실제로
// 렌더하는 WHERE 절을 단언한다:
//   - 빈 교집합 계정 → `false` 가 들어간다(브랜드 조건만 남는 fail-open 금지)
//   - CPO 계정      → country_code IN (… 'CPO' …) — 전용 사이트 코드라 US 는 빠진다(2026-09-29)
const captured: SQL[] = [];
const executed: SQL[] = [];

function builder() {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    innerJoin: () => b,
    $dynamic: () => b,
    where: (c: SQL) => {
      captured.push(c);
      return b;
    },
    orderBy: () => Promise.resolve([]),
    then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve([]).then(res, rej),
  });
  return b;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => builder(),
    selectDistinct: () => builder(),
    execute: (s: SQL) => {
      executed.push(s);
      const isCount = new PgDialect().sqlToQuery(s).sql.includes("count(*)::int AS n");
      return Promise.resolve(isCount ? [{ n: 0 }] : []);
    },
  }),
}));

import {
  getProjectIdsForScope,
  listMeasuredLanguages,
  listWebsiteCountries,
  listWebsitePromptsForExport,
  listWebsitePromptsScoped,
  listWebsiteScopeMatrix,
} from "./website-sites";

const dialect = new PgDialect();

/** 빌더 경로(.where) 로 들어간 조건을 렌더. 조건이 없으면 null. */
function whereOf(): { sql: string; params: unknown[] } | null {
  const w = captured[0];
  if (!w) return null;
  const q = dialect.sqlToQuery(w);
  return { sql: q.sql.replace(/\s+/g, " "), params: q.params };
}

/**
 * raw execute 경로(listWebsitePromptsScoped 등)의 website_prompts 질의 WHERE 이후를 렌더.
 * 첫 execute 를 집지 않는다 — 앵커 축 판정 같은 선행 질의가 먼저 나갈 수 있다.
 */
function executeWhere(): { sql: string; params: unknown[] } {
  const hit = executed
    .map((s) => dialect.sqlToQuery(s))
    .find((q) => /website_prompts wp\s+JOIN website_sites ws/.test(q.sql));
  if (!hit) throw new Error("website_prompts 질의가 실행되지 않았다");
  const flat = hit.sql.replace(/\s+/g, " ");
  return { sql: flat.slice(flat.indexOf("WHERE")), params: hit.params };
}

const EMPTY_INTERSECTION: AllowedScope = {
  all: false,
  brands: ["Hyundai"],
  regions: ["hyundai-north-america"],
  countries: ["KR"], // KR 은 북미 밖 → 허용 국가 0
};
const CPO: AllowedScope = {
  all: false,
  brands: ["Hyundai"],
  regions: ["hyundai-north-america"],
  countries: ["CPO", "US"],
};

const BUILDER_READERS: Array<[string, (s: AllowedScope) => Promise<unknown>]> = [
  ["getProjectIdsForScope", getProjectIdsForScope],
  ["listMeasuredLanguages", listMeasuredLanguages],
  ["listWebsiteScopeMatrix", listWebsiteScopeMatrix],
  ["listWebsiteCountries", listWebsiteCountries],
];

beforeEach(() => {
  captured.length = 0;
  executed.length = 0;
});

describe("website_sites readers — scope country condition wiring", () => {
  it.each(BUILDER_READERS)("%s: empty intersection renders `false` (fail-closed)", async (_n, read) => {
    await read(EMPTY_INTERSECTION);
    const w = whereOf();
    expect(w, "국가 조건이 통째로 빠지면 브랜드 전 사이트가 열린다").not.toBeNull();
    expect(w!.sql).toMatch(/\bfalse\b/);
    expect(w!.params).not.toContain("KR");
  });

  it.each(BUILDER_READERS)("%s: CPO account renders country_code IN (… CPO …)", async (_n, read) => {
    await read(CPO);
    const w = whereOf();
    expect(w).not.toBeNull();
    expect(w!.sql).toContain('"country_code" in');
    expect(w!.params).toEqual(expect.arrayContaining(["CPO"]));
    // US 는 글로벌 전용(전용 사이트 코드 규칙) — 웹사이트에서 미국 사이트를 열지 않는다.
    expect(w!.params).not.toContain("US");
    expect(w!.sql).not.toMatch(/\bfalse\b/);
  });

  it("listWebsitePromptsScoped: empty intersection renders `false`", async () => {
    await listWebsitePromptsScoped(EMPTY_INTERSECTION, {}, {});
    const w = executeWhere();
    expect(w.sql).toMatch(/\bfalse\b/);
    expect(w.params).not.toContain("KR");
  });

  it("listWebsitePromptsScoped: CPO account keeps CPO in the country IN list", async () => {
    await listWebsitePromptsScoped(CPO, {}, {});
    const w = executeWhere();
    expect(w.sql).toContain("ws.country_code IN");
    expect(w.params).toEqual(expect.arrayContaining(["CPO"]));
  });

  // export 는 목록과 같은 websitePromptRowWhere 를 쓴다 — 둘이 갈라지면 화면엔 없는
  // 행이 CSV 로 나가거나 그 반대가 된다.
  it("listWebsitePromptsForExport: empty intersection renders `false`", async () => {
    await listWebsitePromptsForExport(EMPTY_INTERSECTION, {}, {});
    const w = executeWhere();
    expect(w.sql).toMatch(/\bfalse\b/);
    expect(w.params).not.toContain("KR");
  });

  it("listWebsitePromptsForExport: CPO account keeps CPO in the country IN list", async () => {
    await listWebsitePromptsForExport(CPO, {}, {});
    const w = executeWhere();
    expect(w.sql).toContain("ws.country_code IN");
    expect(w.params).toEqual(expect.arrayContaining(["CPO"]));
  });
});
