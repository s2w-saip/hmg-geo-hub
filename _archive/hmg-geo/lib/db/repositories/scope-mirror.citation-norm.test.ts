import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";

// getDb 는 이 테스트에서 쓰이지 않지만(citationValues 는 순수 함수), 모듈 로드
// 시점에 실 커넥션이 만들어지지 않게 막는다.
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const dialect = new PgDialect();
const text = (v: unknown) => dialect.sqlToQuery(v as SQL).sql;

const ROW = {
  jobId: "11111111-1111-1111-1111-111111111111",
  url: "https://www.kia.com/kr/?utm_source=x",
  domain: "kia.com",
  title: null,
  refIndex: 1,
  category: null,
};

beforeEach(() => resetColumnAvailabilityForTests());

describe("미러 인용 삽입 — 정규화 컬럼 충전", () => {
  it("컬럼 미적용(프로브 false)이면 종전 컬럼만 넣는다", async () => {
    const { citationValues } = await import("./scope-mirror");
    const [v] = citationValues([ROW]);
    expect(v).not.toHaveProperty("urlNorm");
    expect(v).toBe(ROW); // 매핑 자체를 건너뛴다
  });

  it("컬럼 적용 후에는 세 컬럼을 SQL 함수로 채운다 (앱 계산 금지)", async () => {
    setColumnAvailabilityForTests("scope_citations", "url_norm", true);
    const { citationValues } = await import("./scope-mirror");
    const [v] = citationValues([ROW]) as Array<Record<string, unknown>>;
    expect(is(v.urlNorm, SQL)).toBe(true);
    expect(text(v.urlNorm)).toBe("citation_url_norm($1::text)");
    expect(text(v.urlHost)).toBe("citation_url_host($1::text)");
    expect(text(v.urlBaseNorm)).toBe("citation_url_base_norm($1::text)");
    // 정규화 식을 TS 로 재구현하지 않는다 — 정의는 DB 함수 하나뿐이어야 한다.
    expect(text(v.urlNorm)).not.toContain("regexp_replace");
  });

  it("url 이 null 이면 null 을 그대로 넘긴다 (함수는 STRICT → NULL)", async () => {
    setColumnAvailabilityForTests("scope_citations", "url_norm", true);
    const { citationValues } = await import("./scope-mirror");
    const [v] = citationValues([{ ...ROW, url: null }]) as Array<
      Record<string, unknown>
    >;
    expect(dialect.sqlToQuery(v.urlNorm as SQL).params).toEqual([null]);
  });
});
