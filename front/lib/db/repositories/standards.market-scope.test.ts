import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

import { catalogMarketScopeCondition } from "./standards";
import { marketInScope } from "@/lib/standards/prompt-markets";

/**
 * SQL 술어(B1)의 **형태 계약**을 고정한다. 순수 규칙은
 * `lib/standards/prompt-markets.scope.test.ts` 가 지키고, 여기는 그 규칙이 SQL
 * 로 옮겨질 때 조용히 어긋나는 세 지점을 막는다:
 *
 *  ① **상속(전 시장) 분기가 살아 있는가.** `regions IS NULL` 과 "실국가 태그 없음"
 *     두 갈래가 빠지면 미지정 행이 전 계정에서 사라진다.
 *  ② **의사코드를 국가로 펼치지 않는가.** `x:` 항목이 실국가 비교에 섞이면
 *     열람이 태깅되지 않은 시장까지 넓어진다(default-deny 반대 방향).
 *  ③ **정규화가 양쪽에서 같은가.** 옵션 목록(JS)은 trim+upper 하는데 술어가
 *     원문을 보면 "필터에 뜨는데 고르면 0행"이 된다.
 */

const dialect = new PgDialect();
const compile = (s: SQL) => dialect.sqlToQuery(s);

describe("catalogMarketScopeCondition — SQL 형태 계약", () => {
  it("허용 국가를 파라미터로 바인딩한다 (문자열 삽입 금지)", () => {
    const q = compile(catalogMarketScopeCondition(["KR"])!);
    expect(q.params).toContain("KR");
    expect(q.sql).not.toContain("'KR'");
  });

  it("상속 분기 2갈래를 모두 낸다 (NULL · 실국가 태그 없음)", () => {
    const sqlText = compile(catalogMarketScopeCondition(["KR"])!).sql.toLowerCase();
    expect(sqlText).toContain("is null");
    expect(sqlText).toContain("not exists");
  });

  it("의사코드를 실국가 비교에서 제외한다 (x: 접두 가드)", () => {
    const sqlText = compile(catalogMarketScopeCondition(["KR"])!).sql.toLowerCase();
    // 두 서브쿼리(상속 판정·겹침 판정) 모두에 가드가 있어야 한다.
    const hits = sqlText.split("like 'x:%'").length - 1;
    expect(hits).toBe(2);
  });

  it("비교 전에 trim + upper 로 정규화한다 (JS normalizeMarket 과 동일)", () => {
    const sqlText = compile(catalogMarketScopeCondition(["KR"])!).sql;
    expect(sqlText).toContain("upper(btrim(r))");
    expect(sqlText).toContain("lower(btrim(r))");
  });

  it("허용 국가를 정규화·중복제거해 바인딩한다", () => {
    const q = compile(catalogMarketScopeCondition([" kr ", "KR", "us"])!);
    const bound = q.params.filter((p) => typeof p === "string");
    expect(bound).toEqual(["KR", "US"]);
  });

  it("의사코드가 허용 국가에 섞여 들어와도 바인딩하지 않는다", () => {
    const q = compile(catalogMarketScopeCondition(["KR", "x:WW"])!);
    expect(q.params).not.toContain("x:WW");
  });

  it("유효한 허용 국가가 없으면 술어를 만들지 않는다 (JS 쪽 fail-open 과 일치)", () => {
    expect(catalogMarketScopeCondition(["  "])).toBeNull();
    expect(marketInScope(["CL"], ["  "])).toBe(true);
  });
});
