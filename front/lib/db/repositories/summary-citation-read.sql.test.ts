/**
 * 인용 리더(PR② T7)의 **컴파일된 SQL 형태**와 순수 매핑을 고정한다. DB 접속 없음.
 *
 * 여기서 지키는 계약 넷:
 *   ① 2단 조회는 `group_key = ANY(...)` 로 좁히고 **DISTINCT 두 개**를 한 문장에서 낸다.
 *   ② 2단 조회 문장 자체에는 `JOIN` 이 없다 — 세미조인이 필요하면 호출부의 술어 안이다.
 *   ③ 배열 바인드는 **`sql.param` 한 개**(스칼라 펼침 금지 — 계획 재사용, T4 규율).
 *   ④ 엔진×카테고리 문장은 집계층 표 하나만 읽는다(세부층에 안 내려간다).
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  __testables,
  sourceCompositionFrom,
  CITATION_TOP_DOMAINS,
} from "./summary-citation-read";
import type { TrendDomainRow } from "./summary-trend-aggregates";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const dialect = new PgDialect();
const compile = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(q);
const flat = (s: string) => s.replace(/\s+/g, " ");

const WHERE = sql`cycle_id = ${"11111111-1111-1111-1111-111111111111"}::uuid`;

describe("domainEnrichSql — 2단 조회 (§3-4 19)", () => {
  const q = compile(__testables.domainEnrichSql(WHERE, ["a.com", "b.com"]));
  const text = flat(q.sql);

  it("세부층 표를 읽는다", () => {
    expect(text).toContain("from summary_domain_citations".replace("from", "FROM"));
  });

  it("`group_key = ANY($n::text[])` 로 좁힌다 — 수용 기준 ②의 인덱스 진입점", () => {
    expect(text).toMatch(/group_key = ANY\(\$\d+::text\[\]\)/);
  });

  it("프롬프트·답변 distinct 를 한 문장에서 낸다", () => {
    expect(text).toContain("count(DISTINCT prompt_id)");
    expect(text).toContain("count(DISTINCT job_id)");
  });

  it("문장 자체에 JOIN 이 없다 (조인이 필요하면 호출부 술어 안이다)", () => {
    // WHERE 절은 테스트가 준 단순 술어라 여기서 걸리는 JOIN 은 리더가 만든 것뿐이다.
    expect(text).not.toMatch(/\bJOIN\b/i);
  });

  it("배열은 바인드 한 개 — 스칼라 펼침이 아니다", () => {
    // 술어 1 + 배열 1 = 2. 키가 늘어도 바인드 수는 안 는다.
    expect(q.params).toHaveLength(2);
    expect(q.params[1]).toEqual(["a.com", "b.com"]);
  });

  it("키가 늘어도 문장 텍스트가 같다 (계획 재사용)", () => {
    const more = compile(__testables.domainEnrichSql(WHERE, ["a.com", "b.com", "c.com"]));
    expect(flat(more.sql)).toBe(text);
  });
});

describe("trendEngineCategorySql — 엔진 × 카테고리", () => {
  const set: CycleSet = {
    surface: "global", mode: "snapshot",
    cycles: [{
      cycleId: "22222222-2222-2222-2222-222222222222",
      generationId: "33333333-3333-3333-3333-333333333333",
      projectId: "44444444-4444-4444-4444-444444444444",
      cycleAnchorAt: "2026-08-31T00:00:00.000Z", cycleWeek: "2026-08-31",
    }],
    cycleKey: "k", projectIds: ["44444444-4444-4444-4444-444444444444"],
    missingProjectIds: [], weeks: ["2026-08-31"], anchorCount: 1,
  };
  const text = flat(compile(__testables.trendEngineCategorySql({
    set, filters: {}, ownVariant: "ALL", ownedBasePrefixes: [],
  })).sql);

  it("집계층 표 하나만 읽는다 — 세부층에 안 내려간다", () => {
    expect(text).toContain("FROM summary_trend_domains");
    expect(text).not.toContain("summary_domain_citations");
    expect(text).not.toContain("summary_answers");
  });

  it("(engine, group_key) 로 접는다", () => {
    expect(text).toContain("GROUP BY engine, group_key");
  });
});

describe("categoryOf — 행 단위 category 를 넘기지 않는다", () => {
  it("사실표에 scope category 컬럼이 없으므로 group_key 만으로 분류한다", () => {
    // 도메인 규칙이 분류를 내므로 값 자체가 아니라 "예외 없이 문자열을 돌려준다" 를 본다.
    expect(typeof __testables.categoryOf("some-unknown-domain.example", new Map())).toBe("string");
    // 오버라이드가 있으면 그것이 이긴다 — 미러 `resolveCitationCategory` 와 같은 우선순위.
    const ov = new Map([["override.example", "Official (HMG)"]]) as never;
    expect(__testables.categoryOf("override.example", ov)).toBe("Official (HMG)");
  });
});

describe("sourceCompositionFrom — 출처 도넛", () => {
  const row = (domain: string | null, citations: number, axis: TrendDomainRow["axis"] = "domain"): TrendDomainRow => ({
    axis, isRest: false, restCount: 0, keyRows: 1,
    groupKey: null, domain, country: null,
    citations, citingAnswers: 0, ownedCitations: 0, isOurs: false,
  });

  it("도메인 축만 쓰고 인용 수 내림차순으로 낸다", () => {
    const out = sourceCompositionFrom(
      [row("b.com", 10), row("a.com", 30), row(null, 5, "total"), row("g", 7, "group")],
      null,
    );
    expect(out.map((r) => r.domain)).toEqual(["a.com", "b.com"]);
    // share 는 **도메인 축 합** 기준(40) — total 축 행을 분모에 섞지 않는다.
    expect(out[0].share).toBe(75);
    expect(out[1].share).toBe(25);
  });

  it("`isOurs` 는 도메인 서픽스 정규식 — 서브도메인은 포함, 접미 문자열은 제외", () => {
    const pat = "(^|\\.)(hyundai\\.com)$";
    const out = sourceCompositionFrom(
      [row("hyundai.com", 1), row("kr.hyundai.com", 1), row("nothyundai.com", 1)],
      pat,
    );
    expect(out.map((r) => r.isOurs)).toEqual([true, true, false]);
  });

  it("잔여(is_rest) 행은 이름이 없으므로 도넛에 넣지 않는다", () => {
    const rest: TrendDomainRow = { ...row(null, 99), isRest: true, restCount: 12 };
    expect(sourceCompositionFrom([row("a.com", 1), rest], null)).toHaveLength(1);
  });
});

describe("상수", () => {
  it("top-N 은 미러 드릴다운 캡(CITATION_DRILLDOWN_DOMAINS)과 같은 80 이다", () => {
    expect(CITATION_TOP_DOMAINS).toBe(80);
  });
});
