import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";

/**
 * 미러 **쓰기** 경로의 콜드 프로세스 결함을 닫는다 (2026-09-10).
 *
 * `citationValues()` 는 동기 판정(`citationNormColumnsAvailable`)을 읽는다. 읽기 경로의
 * 폴백은 "값이 같은 다른 식"(coalesce + 같은 SQL 함수)이라 숫자가 안 흔들리지만, **쓰기
 * 폴백은 컬럼을 안 채우는 것**이다 — 판정 전에 들어온 run 의 인용은 url_norm/url_host/
 * url_base_norm 이 NULL 로 적재된다. cron 은 매번 콜드 프로세스로 뜨므로 그 **첫 run** 이
 * 늘 여기 걸렸다(라이브 실측: scope_citations 3,236,313 행 중 NULL 3,629 = 0.11%).
 * 백필이 회수하긴 하지만 폴백이 없는 소비자(qa-review 의 url_host 표시)는 그 동안 빈칸이다.
 *
 * 그래서 `replaceRun` 은 트랜잭션 **전에** `ensureColumnAvailability()` 를 await 한다.
 * 이 파일은 그 배선을 관찰한다 — 순수 함수(citationValues)만 보는 테스트는
 * "부르는 줄을 통째로 지우는" 회귀를 하나도 못 잡기 때문이다(anchor-registry 와 같은 이유).
 */

const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as SQL);
const isProbe = (q: unknown) => render(q).sql.includes("pg_attribute");

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) => String(s).includes("Name"));
  return sym ? String((t as Record<symbol, unknown>)[sym]) : "?";
}

/** 컬럼이 전부 있는 DB 를 흉내내는 가짜 드라이버 — 배치 프로브 응답까지 답한다. */
function makeFakeDb(present: boolean) {
  const citationRows: Array<Record<string, unknown>> = [];
  const probes: unknown[] = [];
  const execute = vi.fn(async (q: unknown) => {
    if (!isProbe(q)) return [];
    probes.push(q);
    if (!present) return [];
    const params = render(q).params.filter((p): p is string => typeof p === "string");
    const rows: Array<{ tbl: string; col: string }> = [];
    for (let i = 0; i + 1 < params.length; i += 2) rows.push({ tbl: params[i], col: params[i + 1] });
    return rows;
  });
  const builder = (table: unknown) => ({
    where: async () => undefined,
    values: (rows: Array<Record<string, unknown>>) => {
      if (tableName(table) === "scope_citations") citationRows.push(...rows);
      return Object.assign(Promise.resolve(undefined), {
        onConflictDoUpdate: async () => undefined,
      });
    },
  });
  const tx = { delete: builder, insert: builder, execute };
  const db = {
    execute,
    transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  };
  return { db, citationRows, probes };
}

const h = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: h.getDb }));

const RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RUN = {
  runId: RUN_ID,
  projectId: "22222222-2222-2222-2222-222222222222",
  status: "completed",
  startedAt: null,
  completedAt: null,
  totalJobs: 1,
};
const CITATION = {
  jobId: "11111111-1111-1111-1111-111111111111",
  url: "https://www.kia.com/kr/?utm_source=x",
  domain: "kia.com",
  title: null,
  refIndex: 1,
  category: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("replaceRun — 콜드 프로세스의 첫 run 도 정규화 컬럼을 채운다", () => {
  it("판정을 미리 하지 않은 새 프로세스에서도 url_norm 을 SQL 함수로 채운다", async () => {
    const { db, citationRows, probes } = makeFakeDb(true);
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    // 콜드 = 프로브 이력 없음. 종전에는 이 첫 run 이 통째로 NULL 로 적재됐다.
    await scopeMirrorRepository.replaceRun(RUN, [], [], [CITATION]);

    expect(probes.length).toBeGreaterThan(0); // 판정을 실제로 물었다
    expect(citationRows).toHaveLength(1);
    const row = citationRows[0];
    expect(is(row.urlNorm, SQL)).toBe(true);
    expect(render(row.urlNorm).sql).toBe("citation_url_norm($1::text)");
    expect(render(row.urlHost).sql).toBe("citation_url_host($1::text)");
    expect(render(row.urlBaseNorm).sql).toBe("citation_url_base_norm($1::text)");
  });

  it("컬럼이 실제로 없으면 종전대로 컬럼 없이 적재한다 (42703 내성 유지)", async () => {
    const { db, citationRows } = makeFakeDb(false);
    h.getDb.mockReturnValue(db);
    const { scopeMirrorRepository } = await import("./scope-mirror");

    await scopeMirrorRepository.replaceRun(RUN, [], [], [CITATION]);
    expect(citationRows).toHaveLength(1);
    expect(citationRows[0]).not.toHaveProperty("urlNorm");
  });

  it("판정 확정은 트랜잭션 **밖**에서 일어난다 (트랜잭션 중 추가 커넥션 금지)", async () => {
    const src = (
      await import("node:fs")
    ).readFileSync(new URL("./scope-mirror.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("async replaceRun("));
    const ensure = body.indexOf("await ensureColumnAvailability()");
    const begin = body.indexOf("db.transaction(");
    expect(ensure).toBeGreaterThan(0);
    expect(ensure).toBeLessThan(begin);
  });
});
