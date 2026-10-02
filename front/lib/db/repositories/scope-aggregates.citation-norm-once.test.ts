import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// website 인용 계열 3개의 **SQL 형태**를 고정한다 (2026-09-03).
//
// 배경(프로덕션 EXPLAIN ANALYZE, admin 무필터·website 126 프로젝트):
// `cit` 가 비-MATERIALIZED CTE 라 플래너가 정규화 식(regexp_replace 7단)을 조인
// 조건으로 끌어올렸고, `job_id IN (snap)` 이 스캔을 줄이지 못해 scope_citations
// 전체 2,940,483행에 regex 를 돌렸다 — 타겟 URL 인용률 73,910ms 중 72,946ms.
// 정규화를 DISTINCT (url, domain) 당 1회로 접은 뒤:
//   ⑥ 카드 42.1s(프로덕션 평균) → 6.9s · ⑥ 추이 100.4s → 24.9s · 타겟 73.9s → 12.6s
//
// 이 테스트가 고정하는 것은 **수치가 아니라 형태**다. 값 정합은 별도로 프로덕션
// 대조로 확인했다(admin 무필터 18,156/15,604 · Kia KR 244/235, 신구 동일).
// 아래 두 성질이 깨지면 그 플랜 붕괴가 조용히 돌아온다:
//   ① 인용 URL 정규화가 쿼리당 1회만 등장할 것 (행당 5회 인라인 금지)
//   ② 좁히기(c2)·정규화(un)·판정(ub)이 각각 MATERIALIZED 일 것
//      — 합치면 서브쿼리 풀업으로 정규화가 다시 반복 평가된다.

const dialect = new PgDialect();
const captured: string[] = [];
const execute = vi.fn(async (q: SQL) => {
  try {
    captured.push(dialect.sqlToQuery(q).sql);
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

// 인용 URL 정규화 사슬의 지문. `citationTrackedNormSql` 의 첫 단계(lower + 양끝
// 공백 트림)라, 사슬이 한 번 등장할 때마다 정확히 한 번 나온다.
const NORM_CHAIN = /lower\(regexp_replace\(/g;
const count = (sql: string, re: RegExp) => (sql.match(re) ?? []).length;

const PIDS = ["11111111-1111-1111-1111-111111111111"];
const BASES = ["kia.com/kr"];

beforeAll(async () => {
  // 컬럼 존재 프로브(is_korean·regions)가 answerWhere 의 SQL 텍스트를 바꾸므로
  // 파일 전체에서 한 번 가라앉힌다 (shared-answer-set 테스트와 같은 이유).
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
});

describe("website 인용 계열 — 정규화는 DISTINCT url 당 1회", () => {
  it("⑥ 카드(aggregateWebsiteCitationAccuracy)", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteCitationAccuracy({}, PIDS, BASES, BASES);
    const q = captured.at(-1)!;
    expect(q).toContain("snap AS MATERIALIZED");
    expect(q).toContain("c2 AS MATERIALIZED");
    expect(q).toContain("un AS MATERIALIZED");
    expect(q).toContain("ub AS MATERIALIZED");
    // target_set(website_prompts.target_url) 1회 + un(인용 url) 1회 = 2회.
    expect(count(q, NORM_CHAIN)).toBe(2);
    // 인용 테이블은 snap 으로 좁힌 뒤에만 읽는다 (전체 스캔 유도 금지).
    expect(q).toContain("scope_citations c JOIN snap ON snap.job_id = c.job_id");
  });

  it("⑥ 추이(aggregateWebsiteCitationAccuracyTrend)", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteCitationAccuracyTrend({}, "week", PIDS, BASES, BASES);
    const q = captured.at(-1)!;
    expect(q).toContain("snap AS MATERIALIZED");
    expect(q).toContain("c2 AS MATERIALIZED");
    expect(q).toContain("un AS MATERIALIZED");
    expect(q).toContain("ub AS MATERIALIZED");
    expect(count(q, NORM_CHAIN)).toBe(2);
    // 버킷별 스냅샷 규칙(2026-09-01)은 그대로 — 성능 수정이 의미를 바꾸지 않는다.
    expect(q).toContain("DISTINCT ON");
    expect(q).toContain("date_trunc('week'");
  });

  it("프롬프트 기준 인용률 2종(aggregateWebsiteTargetHitRate)", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteTargetHitRate({}, PIDS, BASES, BASES);
    const q = captured.at(-1)!;
    expect(q).toContain("snap AS MATERIALIZED");
    expect(q).toContain("wp AS MATERIALIZED");
    expect(q).toContain("c2 AS MATERIALIZED");
    expect(q).toContain("un AS MATERIALIZED");
    // GGMD-61 — 자사 판정도 DISTINCT (url, domain) 당 1회여야 한다(⑥ 의 ub 와 같은 구조).
    expect(q).toContain("ub AS MATERIALIZED");
    // wp(website_prompts.target_url) 1회 + un(인용 url, tracked) 1회 = 2회.
    // base 정규화는 lower(btrim(…)) 사슬이라 이 지문에 잡히지 않는다 — 아래에서 따로 센다.
    expect(count(q, NORM_CHAIN)).toBe(2);
    // base 정규화(⑤ 와 같은 자사 판정 입력)도 DISTINCT url 당 1회.
    expect(count(q, /lower\(btrim\(/g)).toBe(1);
    expect(q).toContain("scope_citations c JOIN snap ON snap.job_id = c.job_id");
  });

  // GGMD-61 — 두 카드의 분모는 **같은 문장의 같은 식**이어야 한다(수용 기준 A1).
  // 분자만 술어가 다르고, 타겟 술어는 자사 술어에 포함된다(A2).
  it("두 분자는 같은 분모(snap ⋈ wp)를 쓰고, 타겟 술어 ⊂ 자사 술어", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteTargetHitRate({}, PIDS, BASES, BASES);
    const q = captured.at(-1)!;
    // 분모는 한 번만 등장한다 — 두 카드가 같은 열을 읽는다.
    expect(count(q, /count\(DISTINCT snap\.prompt_id\)/g)).toBe(1);
    // 분자 2개는 같은 프롬프트 단위 롤업(pm)에서 나온다: 타겟 / (자사 base OR 타겟).
    expect(q).toContain("pm AS MATERIALIZED");
    expect(q).toContain("SELECT count(*) FROM pm WHERE pm.target_hit");
    expect(q).toContain("SELECT count(*) FROM pm WHERE pm.owned_base_hit OR pm.target_hit");
    // 타겟 일치식(정규화 후 등치)은 **한 번만** 평가된다(행당 재평가 금지).
    // 본문 전체 고정은 lib/scope/url-match.test.ts(컴파일 텍스트 대조)가 맡는다.
    expect(count(q, /ELSE cit\.cnorm = wp\.turl END/g)).toBe(1);
    // 2026-09-17 완화(쿼리 제거·`.html` 동치)의 지문이 남아 있으면 안 된다.
    expect(q).not.toContain("position('?' in wp.turl)");
    // 빈 값 가드(검증자 F-1)가 식 머리에 있다 — JS 쌍둥이와 같은 자리.
    expect(q).toContain("WHEN coalesce(wp.turl, '') = '' OR coalesce(cit.cnorm, '') = '' THEN false");
  });
});

describe("owned 판정 폴백 — 선언 base 가 없으면 domain 정규식", () => {
  it("prefixes 가 비면 ub 가 dk(도메인)로 판정한다", async () => {
    const m = await import("./scope-aggregates");
    await m.aggregateWebsiteCitationAccuracy({}, PIDS, [], undefined);
    const q = captured.at(-1)!;
    expect(q).toContain("nullif(dk, '') ~*");
    // 폴백 경로에서도 인용 url 정규화는 1회뿐이다(target 판정용).
    expect(count(q, NORM_CHAIN)).toBe(2);
  });
});
