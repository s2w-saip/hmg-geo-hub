import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

/**
 * **필터 옵션 창 = 데이터 창** (검증 B3).
 *
 * `optionWindowPredicate` 머리 주석의 계약이 "규칙은 데이터 경로와 1:1"이다. 축이
 * 켜지면 데이터는 "노출 가능한 최신 `round_date` 한 회차"(또는 기간의 회차들)인데
 * 옵션만 `r.started_at >= now() - 7d` 로 남아 있던 것을 고쳤다. 양방향으로 틀린다:
 * 옵션이 넓으면 죽은 옵션, 좁으면 `next_empty` 배정에서 데이터가 있는데 옵션이 없다.
 *
 * DB 접속 0 — `getDb().execute` 를 가로채 **발행된 문장 텍스트**만 본다.
 */

const dialect = new PgDialect();
const execute = vi.fn(async () => [] as unknown[]);
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute, select: () => {} }) }));

const mod = await import("./scope-aggregates");
const { setAnchorAxisForTests, resetAnchorAxisForTests } = await import(
  "@/lib/period/anchor-axis-state"
);
const { resolveColumnAvailabilityForTests, resetColumnAvailabilityForTests } =
  await import("@/lib/db/column-availability");

/** 이 호출이 발행한 마지막 문장의 SQL 텍스트. */
function lastSql(): string {
  const q = execute.mock.calls.at(-1)?.[0];
  return dialect.sqlToQuery(q as unknown as SQL).sql;
}

beforeEach(() => {
  execute.mockClear();
  resolveColumnAvailabilityForTests(true);
});
afterEach(() => {
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
});

const ANCHOR_TABLE = "scope_answer_cycle_anchors";
const LEGACY_WINDOW = "r.started_at >= now() - interval '7 days'";
const PERIOD = { dateFrom: "2026-09-14", dateTo: "2026-09-18" };

/** 옵션 리스터 4종 — 이름, 호출, 창 술어가 붙는 컬럼. */
const LISTERS = [
  {
    name: "listMeasuredRegions(루트)",
    call: (range?: { dateFrom?: string; dateTo?: string }) =>
      mod.listMeasuredRegions({ all: true }, undefined, true, range),
    legacy: LEGACY_WINDOW,
  },
  {
    name: "listMeasuredScopeMatrix",
    call: (range?: { dateFrom?: string; dateTo?: string }) =>
      mod.listMeasuredScopeMatrix({ all: true }, range),
    legacy: LEGACY_WINDOW,
  },
  {
    name: "listMeasuredStandardLanguages",
    call: (range?: { dateFrom?: string; dateTo?: string }) =>
      mod.listMeasuredStandardLanguages({ all: true }, undefined, range),
    legacy: LEGACY_WINDOW,
  },
] as const;

describe("옵션 창 — 축 off 는 종전 run 창 그대로", () => {
  beforeEach(() => setAnchorAxisForTests(false));

  it.each(LISTERS.map((l) => [l.name, l] as const))(
    "%s 은 앵커 표를 건드리지 않는다",
    async (_n, l) => {
      await l.call();
      const t = lastSql();
      expect(t).not.toContain(ANCHOR_TABLE);
      expect(t).toContain(l.legacy);
    },
  );

  it("listMeasuredAcrLanguages 는 창 자체가 없다(종전)", async () => {
    await mod.listMeasuredAcrLanguages({ all: true });
    expect(lastSql()).not.toContain(ANCHOR_TABLE);
  });
});

describe("옵션 창 — 축 on 은 회차 축", () => {
  beforeEach(() => setAnchorAxisForTests(true));

  it.each(LISTERS.map((l) => [l.name, l] as const))(
    "%s · 기간 없음 → 노출 가능한 최신 회차 하나",
    async (_n, l) => {
      await l.call();
      const t = lastSql();
      expect(t).toContain(`IN (SELECT ca.job_id FROM ${ANCHOR_TABLE} ca WHERE`);
      expect(t).toContain("ca.round_date = (SELECT max(ca2.round_date)");
      // 종전 run 창은 사라져야 한다 — 남으면 두 축이 AND 되어 옵션이 더 좁아진다.
      expect(t).not.toContain(l.legacy);
    },
  );

  it.each(LISTERS.map((l) => [l.name, l] as const))(
    "%s · 기간 있음 → 그 기간의 round_date",
    async (_n, l) => {
      await l.call(PERIOD);
      const t = lastSql();
      expect(t).toContain("ca.round_date >=");
      expect(t).toContain("ca.round_date <=");
      expect(t).not.toContain("ca.round_date = (SELECT max(");
    },
  );

  it("노출 시간 게이트가 옵션에도 걸린다 — 아직 안 열린 회차가 옵션을 만들면 안 된다", async () => {
    await mod.listMeasuredScopeMatrix({ all: true });
    const t = lastSql();
    expect(t).toContain("ca.view_anchor_date IS NOT NULL");
    expect(t).toContain("ca.view_anchor_date <= hmg_anchor_today()");
  });

  it("옵션 semi-join 은 비상관이다 — 바깥 별칭을 참조하지 않는다", async () => {
    await mod.listMeasuredScopeMatrix({ all: true });
    const m = new RegExp(
      `IN \\(SELECT ca\\.job_id FROM ${ANCHOR_TABLE} ca WHERE ([^)]*)`,
      "i",
    ).exec(lastSql());
    expect(m, "앵커 semi-join 을 찾지 못했다").not.toBeNull();
    expect(m![1], `상관 참조: ${m![1]}`).not.toMatch(/(^|[^c])a\./);
  });

  it("ACR 옵션은 run 축 앵커 절을 쓴다 — 데이터 경로(acrWhere)와 같은 축", async () => {
    await mod.listMeasuredAcrLanguages({ all: true });
    const t = lastSql();
    expect(t).toContain(`x.run_id IN (SELECT ca.run_id FROM ${ANCHOR_TABLE} ca WHERE`);
    expect(t).toContain("ca.round_date = (SELECT max(ca2.round_date)");
  });
});

describe("옵션과 데이터가 같은 회차를 본다", () => {
  beforeEach(() => setAnchorAxisForTests(true));

  /**
   * `(SELECT max(ca2.round_date) … )` 를 **괄호 균형**으로 잘라낸다.
   *
   * 종전에는 `WHERE [^)]*` 정규식이었는데 그것은 `hmg_anchor_today()` 의 여는
   * 괄호에서 멈춰 **숨김 게이트를 비교하지 않았다**(검증 P5). 이름이 주장하는
   * "같은 회차를 본다"보다 좁은 단언이었다.
   */
  function latestRoundSubquery(t: string): string | null {
    const at = t.indexOf("(SELECT max(ca2.round_date)");
    if (at < 0) return null;
    let depth = 0;
    for (let i = at; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") {
        depth--;
        if (depth === 0) return t.slice(at, i + 1);
      }
    }
    return null;
  }

  it("옵션의 최신 회차 서브쿼리가 데이터 경로의 것과 **절 전체** 일치한다", async () => {
    await mod.listMeasuredScopeMatrix({ all: true });
    const option = latestRoundSubquery(lastSql());
    const data = latestRoundSubquery(dialect.sqlToQuery(mod.answerWhere({})).sql);
    expect(option, "옵션 쪽 최신 회차 서브쿼리를 찾지 못했다").toBeTruthy();
    expect(data, "데이터 쪽 최신 회차 서브쿼리를 찾지 못했다").toBeTruthy();
    // 절단되지 않았는지 — 잘린 정규식은 여기서 끝나 버렸다.
    expect(option!.endsWith(")")).toBe(true);
    expect(option!).toContain("hmg_anchor_today()");
    expect(option).toBe(data);
  });

  it("추출이 숨김 게이트까지 포함한다 — 비교 범위가 이름값을 한다", async () => {
    setAnchorAxisForTests(true, { ca2: sql.raw("NH_ca2_marker") });
    await mod.listMeasuredScopeMatrix({ all: true });
    const option = latestRoundSubquery(lastSql());
    expect(option).toContain("NH_ca2_marker");
    const data = latestRoundSubquery(dialect.sqlToQuery(mod.answerWhere({})).sql);
    expect(data).toContain("NH_ca2_marker");
    expect(option).toBe(data);
  });
});

// ── B4: "측정일" 리더의 축 ──────────────────────────────────────────────────
//
// `latestMeasureDays` / `measureDayBoundsInRange` 가 내는 값은 그대로 `dateTo` 로
// 되먹여진다. 축 on 의 기간 술어가 `ca.round_date <= dateTo` 인데 값이 측정일이면
// 두 방향으로 틀린다(머리 주석 `measureDayAxis` 참조).
describe("측정일 리더 — 되먹임 값과 술어 키가 같은 축이다", () => {
  it("축 off — 종전 date_trunc(measured_at) 그대로", async () => {
    setAnchorAxisForTests(false);
    await mod.latestMeasureDays({}, ["11111111-1111-4111-8111-111111111111"]);
    const t = lastSql();
    expect(t).toContain("to_char(date_trunc('day', a.measured_at), 'YYYY-MM-DD') AS day");
    expect(t).toContain("WHERE a.measured_at IS NOT NULL AND");
    expect(t).not.toContain(ANCHOR_TABLE);
  });

  it("축 on — 회차 귀속 날짜를 낸다", async () => {
    setAnchorAxisForTests(true);
    await mod.latestMeasureDays({}, ["11111111-1111-4111-8111-111111111111"]);
    const t = lastSql();
    expect(t).toContain("to_char(ca.round_date, 'YYYY-MM-DD') AS day");
    expect(t).toContain(`FROM scope_answers a JOIN ${ANCHOR_TABLE} ca ON ca.job_id = a.job_id`);
    expect(t).not.toContain("date_trunc('day', a.measured_at)");
  });

  it("축 on — 아직 안 열렸거나 숨긴 회차의 날짜는 내지 않는다", async () => {
    setAnchorAxisForTests(true);
    await mod.latestMeasureDays({}, ["11111111-1111-4111-8111-111111111111"]);
    const t = lastSql();
    // 안 걸면 그 날짜로 다시 집계한 비교 스냅샷이 통째로 빈다.
    expect(t).toContain("ca.view_anchor_date IS NOT NULL");
    expect(t).toContain("ca.view_anchor_date <= hmg_anchor_today()");
  });

  it("measureDayBoundsInRange 도 같은 축이다", async () => {
    setAnchorAxisForTests(true);
    await mod.measureDayBoundsInRange(
      { dateFrom: "2026-09-14", dateTo: "2026-09-18" },
      ["11111111-1111-4111-8111-111111111111"],
    );
    const t = lastSql();
    expect(t).toContain("SELECT ca.round_date AS d");
    expect(t).toContain("to_char(min(d), 'YYYY-MM-DD') AS first_day");
  });

  it("축 off 의 measureDayBoundsInRange 는 종전 텍스트다", async () => {
    setAnchorAxisForTests(false);
    await mod.measureDayBoundsInRange(
      { dateFrom: "2026-09-14", dateTo: "2026-09-18" },
      ["11111111-1111-4111-8111-111111111111"],
    );
    const t = lastSql();
    expect(t).toContain("SELECT date_trunc('day', a.measured_at) AS d");
    expect(t).not.toContain(ANCHOR_TABLE);
  });
});

// ── B4 의 값 계약 — 손계산 리터럴로 두 방향을 고정한다 ──────────────────────
//
// SQL 텍스트만으로는 "값이 맞는가"를 못 본다. 여기서는 리더가 낸 날짜를 그대로
// `dateTo` 로 되먹였을 때 **그 회차가 술어에 걸리는가**를 두 배정 형태로 본다.
describe("되먹임 시나리오 — round_date 와 측정일이 갈리는 두 경우", () => {
  beforeEach(() => setAnchorAxisForTests(true));

  /** 리더가 낸 날짜를 `dateTo` 로 넣었을 때 기간 술어가 쓰는 상한 바인드. */
  function upperBoundFor(day: string): string {
    const q = dialect.sqlToQuery(mod.answerWhere({ dateFrom: day, dateTo: day }));
    const upper = (q.params as unknown[]).filter((p) => p === day);
    return upper.length ? day : "";
  }

  it("next_empty — 앵커 09-14 인 회차가 09-18 에 귀속되면 09-18 로 걸린다", () => {
    // 손계산: 리더는 round_date(=09-18)를 낸다. 측정일(09-14)을 냈다면
    // `ca.round_date <= '2026-09-14'` 라 그 회차가 통째로 빠진다.
    expect(upperBoundFor("2026-09-18")).toBe("2026-09-18");
    const t = dialect.sqlToQuery(
      mod.answerWhere({ dateFrom: "2026-09-18", dateTo: "2026-09-18" }),
    ).sql;
    expect(t).toContain("ca.round_date >=");
    expect(t).toContain("ca.round_date <=");
    expect(t).not.toContain("date_trunc('day', a.measured_at) <=");
  });

  it("round_date < 측정일 — 이틀에 걸친 한 회차가 날짜 하나로 접힌다", async () => {
    // `merged`·`prev_empty` 배정. 리더가 측정일을 내면 09-17·09-18 두 날이 뽑혀
    // "현재 vs 직전"이 같은 회차 대 같은 회차가 되고 증감이 0 이 된다.
    // 축 on 리더는 회차당 한 날짜만 낸다 — GROUP BY 키가 round_date 이기 때문이다.
    await mod.latestMeasureDays({}, ["11111111-1111-4111-8111-111111111111"]);
    const t = lastSql();
    expect(t).toContain("to_char(ca.round_date, 'YYYY-MM-DD') AS day");
    expect(t).toContain("GROUP BY 1");
    // 측정 시각이 키에 섞이면 한 회차가 여러 날로 쪼개진다.
    expect(t).not.toContain("a.measured_at");
  });
});

describe("추이 창 바닥도 같은 축이다 (B4 잔존 경로)", () => {
  // ⚠️ 2026-09-20 계약 추가: 창 바닥뿐 아니라 **노출·함대 게이트**도 함께 건다.
  //    종전에는 바닥만 걸어, 원장이 아직 발행하지 않은 회차가 추이에만 점으로 섰다
  //    (website 마지막 점이 미발행 09-18 회차라 카드 기준일 09-11 과 어긋났다).
  //    게이트 조각 자체는 `setAnchorAxisForTests` 가 주입한 값이라 여기서는
  //    "세 술어가 AND 로 함께 나간다" 만 고정한다.
  it("축 on — 창 바닥이 round_date 이고 노출·함대 게이트가 함께 걸린다", () => {
    setAnchorAxisForTests(true, undefined, undefined, {
      ca: sql`FLEET_GATE`,
      ca2: sql`FLEET_GATE2`,
    });
    const t = dialect.sqlToQuery(mod.__testables.trendWindowFloor()).sql;
    expect(t).toContain(`SELECT ca.job_id FROM ${ANCHOR_TABLE} ca WHERE`);
    expect(t).toContain("ca.round_date >= hmg_anchor_today() - 120");
    // 노출일 게이트 — 아직 안 열린 회차를 추이에서도 뺀다.
    expect(t).toContain("ca.view_anchor_date");
    // 함대 게이트 — 카드·달력이 못 보는 회차는 추이에도 없다.
    expect(t).toContain("FLEET_GATE");
    expect(t).not.toContain("FLEET_GATE2");
  });

  it("축 off — 종전 텍스트 그대로", () => {
    setAnchorAxisForTests(false);
    expect(dialect.sqlToQuery(mod.__testables.trendWindowFloor()).sql).toBe(
      "a.measured_at >= now() - interval '120 days'",
    );
  });
});
