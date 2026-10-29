import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 타겟 페이지 = 자사 (2026-09-06). website 유닛이 지정한 타겟 URL 은 정의상 자사 페이지인데,
// 자사 판정이 선언 base 의 prefix 매칭이라 base 밖 타겟(베이징현대 차종 서브도메인 31건 ·
// 현대캐나다 /newsroom 1건 · 기아캐나다 루트 5건, 2026-09-04 회차)이 "타겟 도달인데 자사
// 아님"으로 갈렸다. 이 테스트는 **SQL 형태**를 고정한다:
//   ① website 표면(projectCtx=string[] + 플래그)에서 ⑤ 계열 자사 판정에 타겟 집합 OR 분기가
//      붙고, 그 집합은 base 정규화(비교 상대 `base` 와 동종)·화면 축(lang)으로 좁혀진다.
//   ② 플래그가 없으면(표준·프로젝트 표면) SQL 에 website_prompts 가 등장하지 않는다 — 종전과 동일.
//   ③ ⑥ 계열은 이미 선언된 target_set 을 자사 판정에 재사용한다(정규화 사슬 증가 없음).

const dialect = new PgDialect();
const captured: string[] = [];
const params: unknown[][] = [];
// 답변 수 0 이면 aggregateStandardFromMirror 가 ⑤ 쿼리 전에 null 로 끝나므로, 지역 롤업
// 문장에는 답변 1건짜리 행을 돌려 인용 문장까지 흐르게 한다. 나머지는 빈 결과.
const execute = vi.fn(async (q: SQL) => {
  try {
    const built = dialect.sqlToQuery(q);
    captured.push(built.sql);
    params.push(built.params);
    if (/AS answers,/.test(built.sql) && /GROUP BY region/.test(built.sql)) {
      return [{ region: "CN-BJ", answers: 1, tracked: 1 }] as unknown as never;
    }
  } catch {
    /* raw SET 등 — 형태 검사 대상 아님 */
  }
  return [] as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const PIDS = ["11111111-1111-1111-1111-111111111111"];
const BASES = ["beijing-hyundai.com.cn"];
const TARGET_SET = /FROM website_prompts wp\s+JOIN website_sites ws ON ws\.id = wp\.site_id/;

beforeAll(async () => {
  // 컬럼 존재 프로브가 answerWhere 의 SQL 텍스트를 바꾸므로 한 번 가라앉힌다.
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
  params.length = 0;
});

const run = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch {
    /* 빈 mock 결과로 후처리가 실패해도 SQL 은 이미 캡처됐다 */
  }
};

describe("타겟 페이지 = 자사 — ⑤ 계열(website 표면)", () => {
  it("플래그 on: 자사 판정에 `base IN (타겟 집합)` OR 분기가 붙고, 집합은 base 정규화·lang 축으로 좁힌다", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateStandardFromMirror({ lang: ["zh"] }, PIDS, BASES, BASES, true));
    const withTarget = captured.filter((s) => TARGET_SET.test(s));
    expect(withTarget.length).toBeGreaterThan(0);
    for (const s of withTarget) {
      expect(s).toMatch(/OR base IN \(\s*SELECT DISTINCT/);
      // base 정규화 지문(btrim → split_part '?' → rtrim '/')이 타겟 URL 에 걸려 있다
      expect(s).toMatch(/rtrim\(split_part\(split_part\(regexp_replace\(regexp_replace\(lower\(btrim\(wp\.target_url/);
      expect(s).toMatch(/wp\.lang_code IN/);
      expect(s).toMatch(/wp\.target_url <> ''/);
    }
  });

  it("플래그 off(기본): website_prompts 가 어디에도 등장하지 않는다 — 표준·프로젝트 표면 불변", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateStandardFromMirror({}, "p1", BASES));
    await run(() => m.aggregateSubKpisFromMirror({}, "p1", BASES));
    await run(() => m.aggregateStandardTrendFromMirror({}, "week", "p1", BASES));
    await run(() => m.aggregateCitationsFromMirror({}, "p1", BASES));
    expect(captured.some((s) => /website_prompts/.test(s))).toBe(false);
  });

  it("플래그 on 이어도 projectCtx 가 배열이 아니면 붙지 않는다(website 전용)", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateSubKpisFromMirror({}, "p1", BASES, undefined, true));
    expect(captured.some((s) => /website_prompts/.test(s))).toBe(false);
  });

  it("엔진별·추이·인용분석도 같은 분기를 낸다", async () => {
    const m = await import("./scope-aggregates");
    for (const fn of [
      () => m.aggregateSubKpisFromMirror({}, PIDS, BASES, BASES, true),
      () => m.aggregateStandardTrendFromMirror({}, "week", PIDS, BASES, BASES, true),
      () => m.aggregateCitationsFromMirror({}, PIDS, BASES, BASES, true),
    ]) {
      captured.length = 0;
      await run(fn);
      expect(captured.some((s) => TARGET_SET.test(s) && /OR base IN \(/.test(s))).toBe(true);
    }
  });
});

describe("타겟 페이지 = 자사 — ⑥ 계열은 선언된 target_set 을 재사용", () => {
  it("⑥ 카드·추이의 owned 식에 `OR n IN (SELECT turl FROM target_set)` 이 붙고 target_set 은 1회만 정의된다", async () => {
    const m = await import("./scope-aggregates");
    for (const fn of [
      () => m.aggregateWebsiteCitationAccuracy({}, PIDS, BASES, BASES),
      () => m.aggregateWebsiteCitationAccuracyTrend({}, "week", PIDS, BASES, BASES),
    ]) {
      captured.length = 0;
      await run(fn);
      const q = captured.find((s) => /target_set AS MATERIALIZED/.test(s));
      expect(q).toBeDefined();
      expect(q!).toMatch(/OR n IN \(SELECT turl FROM target_set\)\) AS owned/);
      // 자사 판정이 타겟 집합을 다시 정의하지 않는다(정규화 사슬 증가 없음)
      expect((q!.match(TARGET_SET) ?? []).length).toBe(1);
    }
  });
});

describe("사이트 루트 홈 = 자사 (2026-09-06)", () => {
  it("SQL: 언어 경로 base(kia.ca/fr)라도 호스트 루트 홈 분기가 붙고, 공유 글로벌 호스트(kia.com/kr)엔 붙지 않는다", async () => {
    const m = await import("./scope-aggregates");
    captured.length = 0;
    await run(() => m.aggregateSubKpisFromMirror({}, PIDS, ["kia.ca/fr"], ["kia.ca/en", "kia.ca/fr"], true));
    const q = captured.find((s) => /LIKE ANY/.test(s));
    expect(q).toBeDefined();
    expect(q!).toMatch(/OR rtrim\(split_part\(base, '\?', 1\), '\/'\) = ANY\(/);
    captured.length = 0;
    await run(() => m.aggregateSubKpisFromMirror({}, PIDS, ["kia.com/kr"], undefined, true));
    const q2 = captured.find((s) => /LIKE ANY/.test(s));
    expect(q2).toBeDefined();
    expect(q2!).not.toMatch(/rtrim\(split_part\(base, '\?', 1\)/);
  });

  it("JS 쌍둥이 isSiteRootHome: 루트·끝 슬래시·쿼리 변형은 홈, 하위 경로·공유 호스트는 아님", async () => {
    const { isSiteRootHome } = await import("@/lib/geo-catalog/owned");
    expect(isSiteRootHome("kia.ca", "kia.ca")).toBe(true);
    expect(isSiteRootHome("kia.ca/", "kia.ca")).toBe(true);
    expect(isSiteRootHome("kia.ca/?isCL=1&location=1877-2020-2023-2021.html", "kia.ca")).toBe(true);
    expect(isSiteRootHome("kia.ca/en", "kia.ca")).toBe(false);
    expect(isSiteRootHome("kia.com", "kia.com")).toBe(false);
    expect(isSiteRootHome("hyundai.com/", "hyundai.com")).toBe(false);
  });
});
