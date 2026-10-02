// 언급 추이의 **주 격자 키**를 컴파일된 SQL 로 고정한다 (2026-09-17).
//
// 고치는 결함: 드레인이 여러 날에 걸친 회차가 `date_trunc('week', a.measured_at)` 격자에서
// 두 주로 쪼개졌다. 09-13 15:48Z 회차(드레인 9/13~9/16)가 9/7 주와 9/14 주로 갈렸고,
// 9/7 주에서는 `DISTINCT ON` 이 셀당 최신 1건만 남기느라 09-08 회차를 통째로 밀어냈다.
//
// 이 파일이 잡는 뮤테이션:
//   ① `cycle` 인데 조인이 빠진다 → `_cwc.cycle_week` 가 미정의 컬럼(42703)이 된다.
//   ② 세 자리(`DISTINCT ON` · 선택 리스트 · `ORDER BY`) 중 **하나만** 바뀐다 →
//      dedup 격자와 표시 격자가 갈려 한 셀이 두 점에 실리거나 문법이 깨진다.
//   ③ 기본값이 `cycle` 로 바뀐다 → 웹사이트·프로젝트·드릴다운 표면까지 조용히 따라간다.
//   ④ 원장 미적용(0059 전) 환경에서 조인이 그대로 나간다 → 없는 표를 참조한다.
//   ⑤ `measured` 경로의 문장이 종전과 달라진다 → pg_stat_statements 정규화 텍스트가
//      갈려 배포 전후 비교가 성립하지 않는다(그 창의 성능 근거가 통째로 무효).
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const ledgerAvailable = vi.fn<[], Promise<boolean>>();
vi.mock("@/lib/db/repositories/summary-settings", () => ({
  summaryLedgerAvailable: () => ledgerAvailable(),
}));

const dialect = new PgDialect();
const execute = vi.fn(async () => [] as unknown as never);
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

beforeAll(async () => {
  ledgerAvailable.mockResolvedValue(true);
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  ledgerAvailable.mockResolvedValue(true);
});

const buildKey = async (source: "measured" | "cycle") => {
  const m = await import("./scope-aggregates");
  const { sql } = await import("drizzle-orm");
  const wk = await m.trendWeekKey(source);
  return {
    wk,
    join: dialect.sqlToQuery(sql`SELECT 1 FROM scope_answers a${wk.join}`).sql,
    key: dialect.sqlToQuery(sql`SELECT ${wk.key}`).sql,
  };
};

/** 문장 전체 — 리더가 실제로 발행하는 형태(상수 조각만 더미로 바꾼다). */
const buildQuery = async (source: "measured" | "cycle") => {
  const m = await import("./scope-aggregates");
  const { sql } = await import("drizzle-orm");
  const wk = await m.trendWeekKey(source);
  return dialect.sqlToQuery(
    m.mentionBrandDayCountsQuery({
      filters: {},
      wk,
      trendFloor: sql`a.measured_at >= now() - interval '120 days'`,
      answerWhere: sql`true`,
      notHidden: sql`true`,
      seriesClause: sql``,
    }),
  ).sql;
};

describe("trendWeekKey — 주 격자 키 조각", () => {
  it("`measured` 는 종전 식 그대로이고 조인이 없다 (뮤테이션 ⑤)", async () => {
    const { wk, join, key } = await buildKey("measured");
    expect(wk.applied).toBe("measured");
    expect(key).toContain("date_trunc('week', a.measured_at)");
    expect(key).not.toContain("cycle_week");
    expect(join).toBe("SELECT 1 FROM scope_answers a");
  });

  it("`cycle` 은 원장 `cycle_week` 를 쓰고 조인을 함께 낸다 (뮤테이션 ①)", async () => {
    const { wk, join, key } = await buildKey("cycle");
    expect(wk.applied).toBe("cycle");
    // 조인은 **하나**다 — `summary_cycle_runs ⋈ summary_cycles` 를 미리 접어 해시 빌드를
    // 한 번만 만든다. 두 개로 풀면 프로덕션 EXPLAIN 에서 +1,080 ms(접으면 +953 ms)였다.
    expect(join).toContain("LEFT JOIN (");
    expect(join).toContain(
      "FROM summary_cycle_runs cr JOIN summary_cycles c ON c.cycle_id = cr.cycle_id",
    );
    expect(join).toContain(") _cw ON _cw.run_id = a.run_id");
    expect(join.match(/LEFT JOIN/g)).toHaveLength(1);
    // 폴백은 **종전 식**이다 — 원장에 없는 run 은 종전 그대로 찍힌다.
    expect(key).toBe("SELECT COALESCE(_cw.cycle_week, (date_trunc('week', a.measured_at))::date)");
  });

  it("원장 미적용(0059 전)이면 `cycle` 을 요청해도 종전 격자다 (뮤테이션 ④)", async () => {
    ledgerAvailable.mockResolvedValue(false);
    const { wk, join, key } = await buildKey("cycle");
    expect(wk.applied).toBe("measured");
    expect(join).toBe("SELECT 1 FROM scope_answers a");
    expect(key).not.toContain("summary_cycle");
  });
});

describe("언급 추이 문장 — 키가 세 자리에 같이 들어간다", () => {
  it("`measured`: 종전 키가 DISTINCT ON · 선택 · ORDER BY 셋에 (뮤테이션 ②⑤)", async () => {
    const q = await buildQuery("measured");
    expect(q).toMatch(
      /DISTINCT ON \(a\.prompt_id, a\.target, a\.region, date_trunc\('week', a\.measured_at\)\)/,
    );
    expect(q).toMatch(/a\.job_id, date_trunc\('week', a\.measured_at\) AS wk/);
    expect(q).toMatch(
      /ORDER BY a\.prompt_id, a\.target, a\.region, date_trunc\('week', a\.measured_at\),\s*a\.measured_at DESC/,
    );
    expect(q).not.toContain("summary_cycle_runs");
  });

  it("`cycle`: 회차 주 키가 **같은 세 자리**에 (뮤테이션 ②)", async () => {
    const q = await buildQuery("cycle");
    const KEY = "COALESCE(_cw.cycle_week, (date_trunc('week', a.measured_at))::date)";
    // 세 자리 전부 같은 식. 하나라도 빠지면 개수가 어긋난다.
    expect(q.split(KEY).length - 1).toBe(3);
    expect(q).toContain(`DISTINCT ON (a.prompt_id, a.target, a.region, ${KEY})`);
    expect(q).toContain(`a.job_id, ${KEY} AS wk`);
    expect(q).toContain(`ORDER BY a.prompt_id, a.target, a.region, ${KEY}`);
    // 조인은 `scope_answers a` 바로 뒤 — 필터(WHERE) 앞이어야 한다.
    expect(q).toMatch(/FROM scope_answers a\s+LEFT JOIN \(/);
    expect(q.indexOf(") _cw ON _cw.run_id = a.run_id"))
      .toBeLessThan(q.indexOf("WHERE a.measured_at IS NOT NULL"));
  });

  it("두 문장의 차이는 **주 키와 조인뿐**이다 — 값·술어·dedup 은 그대로", async () => {
    const m = await import("./scope-aggregates");
    const { sql } = await import("drizzle-orm");
    const KEY = "COALESCE(_cw.cycle_week, (date_trunc('week', a.measured_at))::date)";
    const join = dialect.sqlToQuery(sql`${(await m.trendWeekKey("cycle")).join}`).sql;
    const cycle = (await buildQuery("cycle"))
      .split(KEY).join("date_trunc('week', a.measured_at)")
      .split(join).join("");
    expect(cycle).toBe(await buildQuery("measured"));
  });
});

describe("기본값은 종전 격자다 (뮤테이션 ③)", () => {
  it("`trendWeekKey()` 의 `measured` 가 다른 표면의 기본값과 같은 문자열", async () => {
    // 웹사이트·프로젝트·드릴다운은 인자를 안 넘긴다 → `measured` 로 떨어진다.
    const { key } = await buildKey("measured");
    expect(key).toBe("SELECT date_trunc('week', a.measured_at)");
  });
});
