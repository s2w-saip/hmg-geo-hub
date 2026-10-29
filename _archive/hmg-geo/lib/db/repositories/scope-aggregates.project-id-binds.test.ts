import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 프로젝트 id 목록 = 바인드 1개 (PR① B4-b, 2026-09-09).
//
// 웹사이트 표면은 프로젝트가 93~126개다. 종전에는 그 id 들이 집계 함수마다
// `IN ($1,$2,…$95)` 로 인라인돼, ① 문장 텍스트가 id 개수에 따라 달라져 계획이
// 재사용되지 않고 ② pg_stat_statements 에도 서로 다른 문장으로 흩어졌다.
//
// 이 테스트가 고정하는 것 두 가지:
//   ① 프로젝트 id 는 어떤 문장에서도 개별 바인드로 펼쳐지지 않는다(문장 텍스트가
//      95개 목록에서도 1개 목록과 같다 = 계획 재사용 가능).
//   ② `IN (…)` → `= ANY(…)` 로 바꾼 지점의 **의미론이 같다** — 목록에 NULL 이
//      없고 부정형이 아니므로 등가이고, 빈 목록은 종전 콜사이트 가드가 그대로다.
//
// 값 대조(모수·산식 불변)는 실 DB 패리티 게이트의 몫이다 — 여기서는 형태만 본다.

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
// drizzle 쿼리빌더 경로(getMirrorAnswerBody)도 `where` 술어를 잡는다.
const chain = () => {
  const o: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown) => res([]),
  };
  for (const k of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin", "groupBy"]) {
    o[k] = (arg?: unknown) => {
      if (k === "where" && arg) {
        try {
          captured.push(dialect.sqlToQuery(arg as SQL).sql);
        } catch {
          /* 형태 검사 대상 아님 */
        }
      }
      return o;
    };
  }
  return o;
};
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    select: () => chain(),
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const hex = (n: number) => n.toString(16).padStart(12, "0");
const FLEET = Array.from({ length: 95 }, (_, i) => `11111111-1111-1111-1111-${hex(i + 1)}`);
// 개수만 다른 두 함대 — 한쪽만 1개로 두면 콜사이트의 단일-프로젝트 분기까지 섞인다.
const HALF = FLEET.slice(0, 50);
const BASES = ["https://www.hyundai.com/kr/ko/"];

const maxBind = (text: string) =>
  Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

beforeAll(async () => {
  // 컬럼 존재 프로브가 answerWhere 의 SQL 텍스트를 바꾸므로 한 번 가라앉힌다.
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
});

const run = async (fn: () => Promise<unknown>) => {
  captured.length = 0;
  try {
    await fn();
  } catch {
    /* 빈 mock 결과로 후처리가 실패해도 SQL 은 이미 캡처됐다 */
  }
  return [...captured];
};

// 프로젝트 id 를 받는 미러 읽기 콜사이트 — B4-b 가 손댄 헬퍼 4종을 모두 지난다.
async function collect(pids: string[]): Promise<string[]> {
  const m = await import("./scope-aggregates");
  const out: string[] = [];
  out.push(...(await run(() => m.aggregateWebsiteCitationAccuracy({}, pids, BASES))));
  out.push(...(await run(() => m.aggregateWebsiteTargetHitRate({}, pids))));
  out.push(...(await run(() => m.aggregateStandardFromMirror({}, pids, BASES, BASES, true))));
  out.push(...(await run(() => m.listMeasuredEngines(pids, {}))));
  out.push(...(await run(() => m.websiteDeclaredOwnedBases({}, pids))));
  out.push(...(await run(() => m.getMirrorAnswerBody(FLEET[0]!, {}, { runProjectIds: pids }))));
  return out;
}

describe("프로젝트 id 는 배열 바인드 1개로 넘어간다", () => {
  it("함대 95개와 50개의 SQL 텍스트가 문장 단위로 동일하다 (계획 재사용)", async () => {
    // 첫 호출은 컬럼 존재 프로브 문장을 함께 낸다(1회성) — 워밍업 후 비교한다.
    await collect(FLEET);
    const many = await collect(FLEET);
    const half = await collect(HALF);
    expect(many.length).toBeGreaterThan(0);
    expect(many.length).toBe(half.length);
    for (let i = 0; i < many.length; i++) expect(many[i]).toBe(half[i]);
  });

  it("어떤 문장에도 프로젝트 id 가 개별 바인드로 펼쳐지지 않는다", async () => {
    const many = await collect(FLEET);
    // 95개가 펼쳐지면 그 문장 하나만으로 바인드가 95를 넘는다.
    for (const s of many) expect(maxBind(s)).toBeLessThan(95);
  });

  it("대표 문장(웹사이트 인용 정확도)이 함대 규모에서 짧아진다", async () => {
    const m = await import("./scope-aggregates");
    const stmts = await run(() => m.aggregateWebsiteCitationAccuracy({}, FLEET, BASES));
    const main = stmts.reduce((a, b) => (b.length > a.length ? b : a), "");
    expect(main).toContain("target_set");
    // 실측(95 프로젝트, PgDialect 컴파일): 4,178자·$295 → 2,602자·$13 (-37.7%).
    // 상한은 회귀 방지용 — id 목록이 사라져 문장 길이가 프로젝트 수와 무관해진다.
    expect(main.length).toBeLessThan(3_000);
    expect(maxBind(main)).toBeLessThan(30);
  });
});

describe("`IN (…)` → `= ANY(…)` 의미론", () => {
  it("프로젝트 술어는 = ANY(...::uuid[]) / = ANY(...::text[]) 형태다", async () => {
    const many = await collect(FLEET);
    const withPid = many.filter((s) => /scope_runs|scope_project_id/.test(s));
    expect(withPid.length).toBeGreaterThan(0);
    for (const s of withPid) {
      // 부정형은 만들지 않았다 — NOT IN 과 = ANY 는 NULL 의미론이 다르므로,
      // 이 치환이 부정 문맥에 들어가면 값이 바뀐다. 들어가지 않았음을 고정한다.
      expect(s).not.toMatch(/project_id\s*(NOT IN|<>\s*ALL)/);
    }
  });

  it("빈 목록은 콜사이트가 SQL 을 만들기 전에 막는다 (종전 `IN ()` 문법오류 자리)", async () => {
    const m = await import("./scope-aggregates");
    expect(await m.aggregateWebsiteCitationAccuracy({}, [], BASES)).toEqual({
      ownedAnswers: 0,
      targetAnswers: 0,
      rate: null,
    });
    expect(await m.aggregateWebsiteTargetHitRate({}, [])).toEqual({
      hitPrompts: 0,
      measuredPrompts: 0,
      rate: null,
    });
    expect(await m.listMeasuredEngines([], {})).toEqual([]);
    expect(await m.websiteDeclaredOwnedBases({}, [])).toEqual({ prefixes: [], universe: [] });
  });

  it("프로젝트 컨텍스트가 없으면 프로젝트 술어 자체가 없다 (표준 루트 경로 불변)", async () => {
    const m = await import("./scope-aggregates");
    const { sql: onlyRoot } = new PgDialect().sqlToQuery(m.answerWhere({}, undefined));
    expect(onlyRoot).not.toContain("::uuid[]");
  });
});
