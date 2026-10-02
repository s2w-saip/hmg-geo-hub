import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";

// 컬럼이 **있을 때**의 SQL 형태를 고정한다 (2026-09-03, migration 0052).
// 컬럼이 없을 때의 형태(= 종전 #178 형태)는 citation-norm-once.test.ts 가 이미
// 고정하고 있으므로, 여기서는 세 가지만 본다:
//   ① 인용 URL 정규화 사슬(regexp_replace 7단)이 인용 쪽에서 사라졌는가
//   ② 미충전(NULL) 행의 폴백이 남아 있는가 — 백필 완료 전에도 값이 정확해야 한다
//   ③ 되붙이기 조인이 1:1 인가 — 백필 진행 중 같은 url 이 (NULL, 값) 두 형태로
//      존재할 수 있어 DISTINCT 로는 키당 2행이 되고 count(*) 가 부풀어 오른다

const dialect = new PgDialect();
const captured: string[] = [];
const execute = vi.fn(async (q: SQL) => {
  try {
    captured.push(dialect.sqlToQuery(q).sql);
  } catch {
    /* raw SET 등 */
  }
  return [] as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

// 인용 URL 정규화 사슬의 지문 (citation-norm-once.test.ts 와 같은 것).
const NORM_CHAIN = /lower\(regexp_replace\(/g;
// KPI⑤ base 정규화 사슬의 지문 (citationBaseNormSql 의 첫 단계).
const BASE_CHAIN = /lower\(btrim\(/g;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const PIDS = ["11111111-1111-1111-1111-111111111111"];
const BASES = ["kia.com/kr"];

beforeAll(async () => {
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
  resetColumnAvailabilityForTests();
  setColumnAvailabilityForTests("scope_citations", "url_norm", true);
});

describe("정규화 컬럼이 있을 때 — 인용 쪽 regex 가 사라진다", () => {
  it("⑥ 카드(aggregateWebsiteCitationAccuracy)", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteCitationAccuracy({}, PIDS, BASES, BASES);
    const q = captured.at(-1)!;
    // 인용 쪽 사슬 소멸 — 남은 1회는 website_prompts.target_url (다른 테이블·다른
    // 모수 12,685행이라 병목이 아니다. #178 §3 참조).
    expect(count(q, NORM_CHAIN)).toBe(1);
    expect(q).toContain("c.url_norm AS nk");
    expect(q).toContain("coalesce(nk, citation_url_norm(nullif(uk, '')))");
    // 되붙이기 1:1 — DISTINCT 가 아니라 GROUP BY + max.
    expect(q).toContain("max(nk) AS nk FROM c2 GROUP BY uk, dk");
    expect(q).not.toContain("SELECT DISTINCT uk, dk FROM c2");
    // 좁히기·정규화·판정을 각각 굳히는 성질은 그대로여야 한다.
    for (const cte of ["snap AS MATERIALIZED", "c2 AS MATERIALIZED", "un AS MATERIALIZED", "ub AS MATERIALIZED"])
      expect(q).toContain(cte);
  });

  it("⑥ 추이(aggregateWebsiteCitationAccuracyTrend)", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteCitationAccuracyTrend({}, "week", PIDS, BASES, BASES);
    const q = captured.at(-1)!;
    expect(count(q, NORM_CHAIN)).toBe(1);
    expect(q).toContain("coalesce(nk, citation_url_norm(nullif(uk, '')))");
    expect(q).toContain("max(nk) AS nk FROM c2 GROUP BY uk, dk");
  });

  it("프롬프트 기준 인용률 2종(aggregateWebsiteTargetHitRate)", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteTargetHitRate({}, PIDS, BASES, BASES);
    const q = captured.at(-1)!;
    // 남은 1회는 wp(website_prompts.target_url).
    expect(count(q, NORM_CHAIN)).toBe(1);
    expect(q).toContain("coalesce(nk, citation_url_norm(url))");
    // GGMD-61 — 자사 판정 입력(base 정규화)도 컬럼으로 받는다. 컬럼이 있으면
    // lower(btrim(…)) 사슬 자체가 사라져야 한다(인용 쪽 regex 0회).
    expect(q).toContain("coalesce(bk, citation_url_base_norm(url))");
    expect(count(q, /lower\(btrim\(/g)).toBe(0);
    expect(q).toContain("c.url_base_norm AS bk");
    // 되붙이기 1:1 — DISTINCT 가 아니라 GROUP BY + max.
    expect(q).toContain("max(nk) AS nk, max(bk) AS bk FROM c2 GROUP BY url, dk");
    expect(q).not.toContain("SELECT DISTINCT url, dk FROM c2");
  });

  it("프로젝트판 ⑥(aggregateCitationAccuracy) — EXISTS 안의 사슬도 컬럼으로", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateCitationAccuracy({}, ["https://www.kia.com/kr/x"], "kia.com/kr");
    const q = captured.at(-1)!;
    expect(count(q, NORM_CHAIN)).toBe(0);
    expect(q).toContain("coalesce(c.url_norm, citation_url_norm(c.url))");
  });
});

describe("KPI⑤ owned 판정 — DISTINCT url 당 1회, 되붙이기 1:1", () => {
  it("컬럼이 있으면 base 컬럼을 읽고 GROUP BY + max 로 접는다", async () => {
    const m = await import("./scope-aggregates");
    const q = dialect.sqlToQuery(
      m.citationOwnedByUrlSelect(sql`c2`, sql`base = 'kia.com/kr'`),
    ).sql;
    expect(q).toContain("coalesce(bk, citation_url_base_norm(url))");
    expect(q).toContain("max(bk) AS bk FROM c2 GROUP BY url");
    expect(count(q, BASE_CHAIN)).toBe(0);
  });

  it("컬럼이 없으면 종전 형태(DISTINCT + 인라인 식) 그대로", async () => {
    resetColumnAvailabilityForTests();
    setColumnAvailabilityForTests("scope_citations", "url_norm", false);
    const m = await import("./scope-aggregates");
    const q = dialect.sqlToQuery(
      m.citationOwnedByUrlSelect(sql`c2`, sql`base = 'kia.com/kr'`),
    ).sql;
    expect(q).toContain("SELECT DISTINCT url FROM c2");
    expect(q).not.toContain("citation_url_base_norm");
    expect(count(q, BASE_CHAIN)).toBe(1);
  });
});
