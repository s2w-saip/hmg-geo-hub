import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { displayCitationUrl } from "@/lib/url-display";
import { resolveColumnAvailabilityForTests } from "@/lib/db/column-availability";
import { citationGroupKeySql } from "./citation-group-key";

// 2026-09-17 GGMD QA — 긍정/부정 URL 하위 페이지에서 "you" 를 검색하면 화면 URL 에
// "you" 가 없는 행(carchex.com/content/genesis-warranty/ 등 Gemini 인용)이 섞여 나왔다.
// 원인: 검색 술어가 원본 URL 전체에 걸려 `#:~:text=If%20you%20are…` 조각에서 매칭.
// 계약: url 모드 검색은 **화면에 보이는 URL**(displayCitationUrl)과 같은 문자열에 건다.

// 실행되는 SQL 을 전부 모은다 — 집계 함수를 실제로 태워 배선까지 확인한다(검증자 D1).
const db = vi.hoisted(() => {
  const executed: SQL[] = [];
  const execute = async (q: SQL) => {
    executed.push(q);
    return [];
  };
  return { executed, execute };
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: db.execute,
    transaction: async (cb: (tx: { execute: typeof db.execute }) => Promise<unknown>) => cb({ execute: db.execute }),
  }),
}));
vi.mock("@/lib/citation-categorizer/overrides-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/citation-categorizer/overrides-loader")>()),
  loadCitationOverrides: async () => new Map(),
}));

const dialect = new PgDialect();

const DISPLAY_SQL = "regexp_replace(split_part(c.url, '#', 1), '^https?://', '')";

/**
 * SQL 식 `regexp_replace(split_part(url, '#', 1), '^https?://', '')` 의 JS 쌍둥이.
 * - split_part(s, '#', 1): 첫 `#` 앞(없으면 전체).
 * - regexp_replace(…, '^https?://', ''): 플래그 없음 = 대소문자 구분·첫 매칭 1회.
 * 컴파일된 SQL 이 DISPLAY_SQL 과 글자 그대로 같다는 단언과 짝을 이룬다 — SQL 을
 * 바꾸면 그 단언이 깨지고, 이 쌍둥이를 함께 고치게 된다.
 */
function sqlDisplayTwin(url: string): string {
  const beforeHash = url.split("#")[0];
  return beforeHash.replace(/^https?:\/\//, "");
}
/** ILIKE '%q%' 의 JS 쌍둥이(와일드카드 이스케이프는 범위 밖 — 테스트 q 에 %/_ 없음). */
const ilikeContains = (hay: string, q: string) => hay.toLowerCase().includes(q.toLowerCase());

type Case = { name: string; url: string; display: string; q: string; hit: boolean };
const CASES: Case[] = [
  {
    name: "Gemini #:~:text= 조각 안에만 q 가 있으면 안 걸린다(고객 재현)",
    url: "https://www.carchex.com/content/genesis-warranty/#:~:text=If%20you%20are%20buying",
    display: "www.carchex.com/content/genesis-warranty/",
    q: "you",
    hit: false,
  },
  {
    name: "경로에 q 가 있으면 걸린다",
    url: "https://www.youtube.com/watch?v=abc#:~:text=review",
    display: "www.youtube.com/watch?v=abc",
    q: "you",
    hit: true,
  },
  {
    name: "쿼리스트링(utm_source)은 화면에 보이므로 걸린다",
    url: "https://kiafinance.ca/kmf/faq?utm_source=youpartner#:~:text=you",
    display: "kiafinance.ca/kmf/faq?utm_source=youpartner",
    q: "you",
    hit: true,
  },
  {
    name: "http 스킴도 제거된다 — 스킴 문자열로는 안 걸린다",
    url: "http://moneygeek.com/insurance/",
    display: "moneygeek.com/insurance/",
    q: "http",
    hit: false,
  },
  {
    name: "# 없는 URL 은 스킴만 빠진다",
    url: "https://rayskillmanavon.com/genesis-service",
    display: "rayskillmanavon.com/genesis-service",
    q: "SKILLMAN",
    hit: true,
  },
  {
    name: "일반 #anchor 도 화면에서 빠지므로 안 걸린다",
    url: "https://example.com/page#section-you",
    display: "example.com/page",
    q: "section",
    hit: false,
  },
  {
    name: "줄바꿈(\\n) 뒤에 있어도 첫 # 이후는 전부 잘린다(PG split_part 와 동일, 검증자 D3)",
    url: "https://a.com/p#:~:text=x\nyou",
    display: "a.com/p",
    q: "you",
    hit: false,
  },
  {
    name: "\\r·U+2028·U+2029 도 첫 # 에서 자르기를 막지 못한다",
    url: "https://a.com/p#frag\r\u2028\u2029you",
    display: "a.com/p",
    q: "you",
    hit: false,
  },
  {
    name: "# 앞의 줄바꿈은 화면 문자열에 남는다(자르지 않는다)",
    url: "https://a.com/x\nyou#frag",
    display: "a.com/x\nyou",
    q: "you",
    hit: true,
  },
  {
    name: "대문자 스킴은 JS 도 SQL 도 남긴다(동일)",
    url: "HTTPS://Example.com/x",
    display: "HTTPS://Example.com/x",
    q: "https",
    hit: true,
  },
];

describe("인용 URL 검색 — 화면 URL 과 같은 문자열에 건다", () => {
  it.each(CASES)("$name", ({ url, display, q, hit }) => {
    expect(displayCitationUrl(url)).toBe(display);
    expect(sqlDisplayTwin(url)).toBe(display);
    expect(ilikeContains(sqlDisplayTwin(url), q)).toBe(hit);
  });

  it("citationDisplayUrlSql 은 쌍둥이가 가정하는 식 그대로 컴파일된다", async () => {
    const { citationDisplayUrlSql } = await import("./scope-aggregates");
    expect(dialect.sqlToQuery(citationDisplayUrlSql(sql`c.url`)).sql).toBe(DISPLAY_SQL);
  });

  it("url 모드: 원본 c.url 이 아니라 화면 URL 식에 ILIKE 를 건다", async () => {
    const { citationToneUrlSearchSql } = await import("./scope-aggregates");
    const q = dialect.sqlToQuery(citationToneUrlSearchSql("you", false, sql`gk`, sql`c.url`));
    expect(q.sql).toBe(`AND ${DISPLAY_SQL} ILIKE $1`);
    expect(q.sql).not.toMatch(/AND c\.url ILIKE/);
    expect(q.params).toEqual(["%you%"]);
  });

  it("domain 모드: 그룹 키 ILIKE 그대로(무변경)", async () => {
    const { citationToneUrlSearchSql } = await import("./scope-aggregates");
    const q = dialect.sqlToQuery(citationToneUrlSearchSql("hyundai", true, sql`gk`, sql`c.url`));
    expect(q.sql).toBe("AND gk ILIKE $1");
    expect(q.params).toEqual(["%hyundai%"]);
  });

  it("줄바꿈 없는 입력에서는 종전 정규식 구현과 바이트 동일하다(시드 고정 무작위 2만 건)", () => {
    // D3 수정이 기존 호출부 결과를 바꾸지 않는다는 근거. 알파벳은 스킴·# 조합을 자주 만들게 고른다.
    const legacy = (u: string) => u.replace(/^https?:\/\//, "").replace(/#.*$/, "");
    const alphabet = ["h", "t", "p", "s", ":", "/", "#", "~", "=", "?", "a", "%", "2", "0", "H", "."];
    let seed = 20260917;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 20_000; i++) {
      const prefix = ["", "http://", "https://", "HTTPS://", "https:/"][Math.floor(rnd() * 5)];
      let body = "";
      const len = Math.floor(rnd() * 24);
      for (let j = 0; j < len; j++) body += alphabet[Math.floor(rnd() * alphabet.length)];
      const u = prefix + body;
      expect(displayCitationUrl(u)).toBe(legacy(u));
    }
  });

  it("빈 q 는 술어가 없다", async () => {
    const { citationToneUrlSearchSql } = await import("./scope-aggregates");
    expect(dialect.sqlToQuery(citationToneUrlSearchSql("", false, sql`gk`, sql`c.url`)).sql).toBe("");
    expect(dialect.sqlToQuery(citationToneUrlSearchSql("", true, sql`gk`, sql`c.url`)).sql).toBe("");
  });
});

describe("aggregateCitationToneUrlsFromMirror — 실행 SQL 에 검색 술어가 배선된다 (검증자 D1)", () => {
  beforeEach(() => {
    resolveColumnAvailabilityForTests();
    db.executed.length = 0;
  });

  /** 집계 본문(scope_citations 를 읽는 문장)만 골라 컴파일한다. */
  async function runAggregate(opts: { q: string; groupBy?: "url" | "domain" }) {
    const mod = await import("./scope-aggregates");
    await mod.aggregateCitationToneUrlsFromMirror({}, "11111111-1111-1111-1111-111111111111", {
      tone: "positive",
      q: opts.q,
      groupBy: opts.groupBy,
    });
    const main = db.executed.map((q) => dialect.sqlToQuery(q)).filter((q) => q.sql.includes("FROM scope_citations c"));
    expect(main).toHaveLength(1);
    return main[0];
  }

  it("url 모드: 표시 URL 식에 ILIKE, 원본 c.url ILIKE 는 없다", async () => {
    const q = await runAggregate({ q: "you" });
    expect(q.sql).toContain(`AND ${DISPLAY_SQL} ILIKE $`);
    expect(q.sql).not.toMatch(/c\.url\s+ILIKE/);
    expect(q.params).toContain("%you%");
  });

  it("domain 모드: 종전 그룹 키 술어가 들어간다", async () => {
    const q = await runAggregate({ q: "hyundai", groupBy: "domain" });
    // 그룹 키 식에도 바인드가 있어 번호가 문맥마다 달라진다 — $n 을 지워 비교한다.
    const bare = (t: string) => t.replace(/\$\d+/g, "$");
    const groupKey = bare(dialect.sqlToQuery(citationGroupKeySql(sql`c.domain`, sql`c.url`)).sql);
    expect(bare(q.sql)).toContain(`AND ${groupKey} ILIKE $`);
    expect(q.sql).not.toContain(`${DISPLAY_SQL} ILIKE`);
    expect(q.sql).not.toMatch(/c\.url\s+ILIKE/);
    expect(q.params).toContain("%hyundai%");
  });

  it("빈 q: 어떤 검색 ILIKE 도 없다", async () => {
    const q = await runAggregate({ q: "" });
    expect(q.sql).not.toMatch(/ILIKE/);
  });
});
