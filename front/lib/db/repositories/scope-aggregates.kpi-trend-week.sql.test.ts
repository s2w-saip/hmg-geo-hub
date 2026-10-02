// 4-KPI 탭 추이 3종의 **주 격자 키**를 컴파일된 SQL 로 고정한다 (2026-09-18).
//
// 고치는 결함(#272 의 나머지 절반): 같은 화면인데 축이 둘이었다. "주별 브랜드 언급 수"
// 추이는 원장 회차 주(`S2.mentionTrend`)로 옮겼는데, 같은 탭의 경쟁사 추이·엔진 추이·
// 유형 추이는 여전히 `date_trunc('week', a.measured_at)` 라 드레인이 주 경계를 넘는
// 회차가 두 주로 쪼개졌다(09-13 앵커 회차 → 9/14 주 + 9/7 주, 그리고 9/7 주에서는
// 셀 스냅샷 `DISTINCT ON` 이 09-08 회차를 통째로 밀어냈다).
//
// 이 탭의 추이 3종은 답변셋을 만드는 **한 자리**(`kpiTabTrendCols`)에서 버킷을 정하고,
// 셀 스냅샷(`KPI_TAB_CELL_SNAPSHOT`)과 모든 `GROUP BY` 가 그 **컬럼**을 읽는다. 그래서
// 언급 화면처럼 세 자리를 맞출 필요가 없고, 대신 이 파일이 "그 한 자리가 맞는가" 와
// "조인이 같은 문장에 함께 나가는가" 를 본다.
//
// 이 파일이 잡는 뮤테이션:
//   ① `cycle` 인데 조인이 빠진다 → `_cw` 참조가 FROM 절에 없는 테이블이 된다
//      (**42P01** `missing FROM-clause entry for table "_cw"` — 컬럼 오류 42703 이 아니다).
//   ② 버킷 컬럼은 회차 주인데 셀 스냅샷이 식을 다시 인라인한다 → dedup 격자와 표시
//      격자가 갈려 한 셀이 두 점에 실린다.
//   ③ 기본값이 `cycle` 로 바뀐다 → 대시보드 경쟁사 행·우선 노출도까지 조용히 따라간다.
//   ④ 원장 미적용(0059 전) 환경에서 조인이 그대로 나간다 → 없는 표를 참조한다.
//   ⑤ `measured` 경로의 문장이 종전과 달라진다 → pg_stat_statements 정규화 텍스트가
//      갈려 배포 전후 비교가 성립하지 않는다.
//   ⑥ 엔진 KPI 의 **스냅샷** 답변셋까지 원장을 조인한다 → 버킷도 없는 문장이 비싸진다.
//   ⑦ `day` 축에 회차 주(월요일 격자)를 얹는다 → 없던 날을 만든다.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const ledgerAvailable = vi.fn<[], Promise<boolean>>();
vi.mock("@/lib/db/repositories/summary-settings", () => ({
  summaryLedgerAvailable: () => ledgerAvailable(),
}));

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

const PIDS = ["11111111-1111-1111-1111-111111111111"];

/** 회차 주 키 — 세 집계가 **같은 문자열**을 써야 한다(복제되면 한쪽만 고쳐진다). */
const CYCLE_KEY = "COALESCE(_cw.cycle_week, (date_trunc('week', a.measured_at))::date)";
const CYCLE_JOIN_HEAD = "FROM scope_answers a LEFT JOIN (";
const CYCLE_JOIN_TAIL = ") _cw ON _cw.run_id = a.run_id";

beforeAll(async () => {
  // 컬럼 존재 프로브가 answerWhere 의 SQL 텍스트를 바꾸므로 한 번 가라앉힌다.
  ledgerAvailable.mockResolvedValue(true);
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
  ledgerAvailable.mockResolvedValue(true);
});

/** 빈 mock 결과로 후처리가 실패해도 SQL 은 이미 캡처됐다. */
const run = async (fn: () => Promise<unknown>): Promise<string[]> => {
  captured.length = 0;
  try {
    await fn();
  } catch {
    /* noop */
  }
  return [...captured];
};

const answerSets = (stmts: string[]) =>
  stmts.filter((s) => /CREATE TEMP TABLE _answer_set/.test(s));
/** 버킷 컬럼이 있는 답변셋 = 추이 단계. 없는 것이 스냅샷 단계다. */
const trendSet = (stmts: string[]) => {
  const hit = answerSets(stmts).filter((s) => /AS bucket/.test(s));
  expect(hit).toHaveLength(1);
  return hit[0];
};

/**
 * 바인드 번호를 지운다. `measured` 는 `date_trunc($1, …)` 로 단위를 **바인드**로 넘기고
 * `cycle` 은 그 자리가 사라지므로, 뒤따르는 파라미터 번호가 통째로 한 칸 밀린다.
 * 번호를 지워야 "주 키와 조인 말고는 같다" 를 문자열로 비교할 수 있다.
 */
const norm = (s: string) => s.replace(/\$\d+/g, "$?");

describe("브랜드 추이 — 답변셋의 버킷 컬럼", () => {
  it("기본값은 종전 격자다 · 조인 없음 (뮤테이션 ③⑤)", async () => {
    const m = await import("./scope-aggregates");
    const set = trendSet(await run(() => m.aggregateBrandTrendFromMirror({}, PIDS, {})));
    expect(set).toContain("date_trunc($1, a.measured_at) AS bucket");
    expect(set).toContain("FROM scope_answers a WHERE");
    expect(set).not.toContain("_cw");
  });

  it("`cycle` 은 원장 회차 주 + 조인을 같은 문장에 낸다 (뮤테이션 ①)", async () => {
    const m = await import("./scope-aggregates");
    const set = trendSet(
      await run(() => m.aggregateBrandTrendFromMirror({}, PIDS, { weekSource: "cycle" })),
    );
    expect(set).toContain(`${CYCLE_KEY} AS bucket`);
    expect(set).toContain(CYCLE_JOIN_HEAD);
    expect(set).toContain(
      "FROM summary_cycle_runs cr JOIN summary_cycles c ON c.cycle_id = cr.cycle_id",
    );
    // 조인은 `WHERE` **앞**이어야 한다(뒤로 가면 문법이 깨진다).
    expect(set.indexOf(CYCLE_JOIN_TAIL)).toBeLessThan(set.indexOf(" WHERE "));
    // `trendWeekKey` 가 접어 주는 조인은 **하나**다(해시 빌드 1회).
    expect(set.match(/LEFT JOIN \(/g)).toHaveLength(1);
  });

  it("두 문장의 차이는 **주 키와 조인뿐**이다 — 술어·창·컬럼은 그대로", async () => {
    const m = await import("./scope-aggregates");
    const measured = trendSet(await run(() => m.aggregateBrandTrendFromMirror({}, PIDS, {})));
    const cycle = trendSet(
      await run(() => m.aggregateBrandTrendFromMirror({}, PIDS, { weekSource: "cycle" })),
    );
    const join = cycle.slice(
      cycle.indexOf(CYCLE_JOIN_HEAD) + "FROM scope_answers a".length,
      cycle.indexOf(CYCLE_JOIN_TAIL) + CYCLE_JOIN_TAIL.length,
    );
    const rewritten = norm(cycle)
      .split(CYCLE_KEY).join("date_trunc($?, a.measured_at)")
      .split(join).join("");
    expect(rewritten).toBe(norm(measured));
  });

  it("셀 스냅샷은 **컬럼**을 읽는다 — 식이 인라인되지 않는다 (뮤테이션 ②)", async () => {
    const m = await import("./scope-aggregates");
    for (const weekSource of ["measured", "cycle"] as const) {
      const stmts = await run(() =>
        m.aggregateBrandTrendFromMirror({}, PIDS, { weekSource }),
      );
      const snaps = stmts.filter((s) => /DISTINCT ON \(prompt_id/.test(s));
      expect(snaps.length).toBeGreaterThan(0);
      for (const s of snaps) {
        expect(s).toContain("DISTINCT ON (prompt_id, target, region, bucket)");
        expect(s).toContain("ORDER BY prompt_id, target, region, bucket, measured_at DESC");
        // 스냅샷 CTE 는 `_answer_set` 만 읽는다 — 원장도 date_trunc 도 여기 없다.
        expect(s.slice(0, s.indexOf("FROM _answer_set"))).not.toContain("cycle_week");
      }
    }
  });

  it("원장 미적용(0059 전)이면 `cycle` 을 요청해도 종전 격자다 (뮤테이션 ④)", async () => {
    const m = await import("./scope-aggregates");
    ledgerAvailable.mockResolvedValue(false);
    const set = trendSet(
      await run(() => m.aggregateBrandTrendFromMirror({}, PIDS, { weekSource: "cycle" })),
    );
    expect(set).toContain("date_trunc($1, a.measured_at) AS bucket");
    expect(set).not.toContain("_cw");
  });

  it("`day` 축에는 회차 주를 얹지 않는다 (뮤테이션 ⑦)", async () => {
    const m = await import("./scope-aggregates");
    const set = trendSet(
      await run(() =>
        m.aggregateBrandTrendFromMirror({}, PIDS, { unit: "day", weekSource: "cycle" }),
      ),
    );
    expect(set).toContain("date_trunc($1, a.measured_at) AS bucket");
    expect(set).not.toContain("_cw");
  });
});

describe("엔진 KPI 추이 — 추이 단계에만 붙는다", () => {
  it("`cycle` 이면 추이 답변셋만 원장을 조인한다 (뮤테이션 ⑥)", async () => {
    const m = await import("./scope-aggregates");
    const stmts = await run(() =>
      m.aggregateEngineKpiTrendFromMirror({}, PIDS, { weekSource: "cycle" }),
    );
    const sets = answerSets(stmts);
    // 이 집계는 답변셋을 둘 연다: 스냅샷(latest) + 추이.
    expect(sets.length).toBe(2);
    const trend = sets.filter((s) => /AS bucket/.test(s));
    const snap = sets.filter((s) => !/AS bucket/.test(s));
    expect(trend).toHaveLength(1);
    expect(snap).toHaveLength(1);
    expect(trend[0]).toContain(`${CYCLE_KEY} AS bucket`);
    expect(trend[0]).toContain(CYCLE_JOIN_TAIL);
    expect(snap[0]).not.toContain("_cw");
  });

  it("기본값은 종전 격자다 (뮤테이션 ③)", async () => {
    const m = await import("./scope-aggregates");
    const stmts = await run(() => m.aggregateEngineKpiTrendFromMirror({}, PIDS, {}));
    expect(trendSet(stmts)).toContain("date_trunc($1, a.measured_at) AS bucket");
    expect(stmts.some((s) => s.includes("_cw"))).toBe(false);
  });

  it("유형 추이(`typeTrend`)도 **같은 답변셋**을 읽는다 — 축이 갈릴 자리가 없다", async () => {
    const m = await import("./scope-aggregates");
    const stmts = await run(() =>
      m.aggregateEngineKpiTrendFromMirror({}, PIDS, { weekSource: "cycle" }),
    );
    // 유형 문장의 지문 = `t_final_choice`. 버킷은 `ans.bucket`(= 답변셋 컬럼)이어야 한다.
    const type = stmts.filter((s) => /AS t_final_choice/.test(s));
    expect(type).toHaveLength(1);
    expect(type[0]).toContain("SELECT ans.bucket AS bucket");
    expect(type[0]).toContain("DISTINCT ON (prompt_id, target, region, bucket)");
    expect(type[0]).not.toContain("cycle_week");
  });
});

describe("이 PR 밖 표면은 종전 격자다 (뮤테이션 ③)", () => {
  it("우선 노출도 추이는 `weekSource` 를 받지 않는다 — 항상 측정시각 주", async () => {
    const m = await import("./scope-aggregates");
    const stmts = await run(() => m.aggregateFirstPositionFromMirror({}, PIDS, {}));
    expect(trendSet(stmts)).toContain("date_trunc($1, a.measured_at) AS bucket");
    expect(stmts.some((s) => s.includes("_cw"))).toBe(false);
  });
});
