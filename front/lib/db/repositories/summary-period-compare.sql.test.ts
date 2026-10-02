import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { citationHiddenIdsFor, __testables } from "./summary-period-compare";
import type { TrendReadScope } from "./summary-trend-aggregates";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";

// 기간 비교 리더의 **형태**를 고정한다. 값 대조는 `*.int.test.ts` 와 골든의 몫이고,
// 여기는 컴파일된 SQL 문자열만 본다.
//
//   ① 문장은 **2개**이고 창을 넓혀도 늘지 않는다(구간이 2개든 3개든 같은 문장).
//   ② 날짜 경계는 **명시 캐스트**(`::date`)이고 `CASE` 안에 숫자 바인드가 없다
//      (2026-09-16 42883: `CASE` 안 숫자 바인드가 text 로 추론돼 인용 화면 전면 실패).
//   ③ 회차 집합·id 목록은 배열 바인드 1개(인라인 0).
//   ④ 인용 계열이 아닐 때는 숨김 회차 술어가 `TRUE` 라 종전과 바이트 동일이다.

const dialect = new PgDialect();
// 대소문자는 형태의 일부가 아니다 — 소문자로 내려 비교한다(drizzle 은 원문 대소문자를 보존).
const compile = (q: SQL) => {
  const c = dialect.sqlToQuery(q);
  return { text: c.sql.toLowerCase(), raw: c.sql, params: c.params };
};

const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

const ST_FULL = { hidden: true, scope: true };
const ST_NONE = { hidden: false, scope: false };

const GLOBAL_Q = {
  surface: "global" as const,
  projectIds: [UUID(3)],
  from: "2026-08-17",
  to: "2026-09-13",
};

const WEBSITE_Q = {
  surface: "website" as const,
  projectIds: [UUID(3), UUID(4)],
  from: "2026-08-15",
  to: "2026-09-11",
  unitFlags: true,
  excludedUnits: [71, 94, 97],
};

const setOf = (surface: "global" | "website", anchors: string[]): CycleSet => ({
  surface,
  mode: "period",
  cycles: anchors.map((a, i) => ({
    cycleId: UUID(10 + i),
    generationId: UUID(50 + i),
    projectId: UUID(3),
    cycleAnchorAt: `${a}T00:00:00.000Z`,
    cycleWeek: a,
  })),
  cycleKey: "k",
  projectIds: [UUID(3)],
  missingProjectIds: [],
  weeks: anchors,
  anchorCount: anchors.length,
});

const scopeOf = (surface: "global" | "website", anchors: string[]): TrendReadScope => ({
  set: setOf(surface, anchors),
  filters: {} as StandardFilters,
  ownVariant: "ALL",
  ownedBasePrefixes: [],
  ...(surface === "website" ? { unitFlags: true, excludedUnits: [71, 94, 97] } : {}),
});

describe("① 회차 원장 문장", () => {
  it("창 경계는 `::date` 명시 캐스트이고 반개구간이다", () => {
    const { text } = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_FULL));
    expect(text).toContain("::date)::timestamp at time zone 'utc'");
    expect(text).toMatch(/cycle_anchor_at >= \(\(\$\d+::date\)/);
    expect(text).toMatch(/cycle_anchor_at < \(\(\(\$\d+::date\) \+ 1\)/);
  });

  it("`CASE` 안 숫자 바인드가 없다(42883 방어)", () => {
    for (const q of [GLOBAL_Q, WEBSITE_Q]) {
      const { text } = compile(__testables.compareCycleRowsSql(q, ST_FULL));
      expect(text).not.toContain("case");
    }
  });

  it("발행 술어는 노출 게이트 + active_generation_id 다(미러 시간 규칙이 아니다)", () => {
    const { text } = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_FULL));
    expect(text).toContain("view_anchor_at is not null and c.view_anchor_at <= now()");
    expect(text).toContain("c.active_generation_id is not null");
    expect(text).not.toContain("interval");
  });

  it("구조 게이트 프로브는 **발행 회차에만** 걸린다", () => {
    const { text } = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_FULL));
    // `(NOT published OR EXISTS(...))` 형태 — 미발행 회차는 프로브를 통과한다.
    expect(text).toMatch(/\(not \(.*\) or exists \(/s);
  });

  it("`hidden_scope='citations'` 회차는 원장에 **남는다**", () => {
    const { text } = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_FULL));
    expect(text).toContain("hidden_reason is null or c.hidden_scope = 'citations'");
  });

  it("0071 미적용이면 숨김 범위 술어가 사라진다(종전 동작 폴백)", () => {
    const { text } = compile(__testables.compareCycleRowsSql(GLOBAL_Q, { hidden: true, scope: false }));
    expect(text).toContain("c.hidden_reason is null");
    expect(text).not.toContain("hidden_scope");
  });

  it("0070 미적용이면 숨김 술어가 통째로 빠진다", () => {
    const { text } = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_NONE));
    expect(text).not.toContain("hidden_reason");
  });

  it("웹사이트는 fleet_visible + 유닛 게이트를 프로브에 건다", () => {
    const { text, params } = compile(__testables.compareCycleRowsSql(WEBSITE_Q, ST_FULL));
    expect(text).toContain("c.fleet_visible");
    expect(text).toContain("o.report_fs <> 0");
    expect(text).toContain("::int[]");
    expect(params).toContainEqual([71, 94, 97]);
  });

  it("글로벌은 루트 3게이트 + 숨김 국가를 프로브에 건다", () => {
    const { text, params } = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_FULL));
    expect(text).toContain("o.in_root_catalog = 1");
    expect(text).toContain("o.in_tagged_region = 1");
    expect(text).toContain("o.in_full_cycle = 1");
    // 숨김 국가 절은 목록이 있을 때만 붙는다 — 2026-09-28 ID 해제(hmg-geo PR #302)로 비었다.
    if (HIDDEN_STANDARD_REGIONS.length) expect(params).toContainEqual([...HIDDEN_STANDARD_REGIONS]);
    else expect(text).not.toContain("country <> ALL");
    expect(text).not.toContain("report_fs");
  });

  it("전 이력 첫 발행 앵커 `F` 를 **같은 문장**에서 읽는다(구간 한정이 아니다)", () => {
    const { text } = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_FULL));
    expect(text).toContain("first_published_anchor");
    // `F` 서브쿼리에는 창 경계가 없다 — 본문에만 두 번(>=, <) 나온다.
    expect(text.match(/cycle_anchor_at >= /g) ?? []).toHaveLength(1);
    expect(text.match(/cycle_anchor_at < /g) ?? []).toHaveLength(1);
  });

  it("프로젝트 id 는 배열 바인드 1개(인라인 0)", () => {
    const { text, params } = compile(__testables.compareCycleRowsSql(WEBSITE_Q, ST_FULL));
    expect(text).toContain("::uuid[]");
    expect(text).not.toContain(UUID(3));
    // 본문·`F` 프로브가 같은 배열 바인드를 쓴다.
    expect(params.filter((p) => Array.isArray(p) && p.includes(UUID(3)))).toHaveLength(2);
  });
});

describe("② 사실표 합계 문장", () => {
  it("앵커 **일**로 묶는다(구간 배정은 JS — `CASE` 날짜 바인드를 만들지 않는다)", () => {
    const { text } = compile(__testables.compareTotalsSql(scopeOf("global", ["2026-09-08"]), []));
    expect(text).toContain("at time zone 'utc')::date");
    expect(text).toContain("group by 1");
    expect(text).not.toContain("case");
  });

  it("게이트는 `trendWhere` 재사용 — 사본이 아니다", () => {
    const { text } = compile(__testables.compareTotalsSql(scopeOf("global", ["2026-09-08"]), []));
    expect(text).toContain("run_status in ('completed', 'partial_failed')");
    expect(text).toContain("in_root_catalog = 1");
    expect(text).toContain("own_variant = $");
  });

  it("건수형 분모가 될 `monitored` 를 싣고, 회차 수는 분모가 아니다", () => {
    const { text } = compile(__testables.compareTotalsSql(scopeOf("global", ["2026-09-08"]), []));
    expect(text).toContain("sum(monitored)");
    expect(text).not.toMatch(/sum\(own_mentions\)\s*\/\s*count/);
  });

  it("회차를 그룹 키로 세운다 — `count(DISTINCT)` 는 GroupAggregate+정렬을 부른다", () => {
    const { text } = compile(__testables.compareTotalsSql(scopeOf("global", ["2026-09-08"]), []));
    expect(text).toContain("group by 1, 2");
    expect(text).toContain("cycle_id::text");
    // 실측(글로벌 60일): count(DISTINCT) 판본은 19,578행 quicksort 2,298 kB 를 탔다.
    expect(text).not.toContain("count(distinct");
  });

  it("숨김 회차 목록이 비면 술어가 `TRUE` 다(종전과 바이트 동일)", () => {
    const { text } = compile(__testables.compareTotalsSql(scopeOf("global", ["2026-09-08"]), []));
    expect(text).toContain("and true");
  });

  it("인용 계열이면 그 회차를 uuid 배열 하나로 뺀다", () => {
    const { text, params } = compile(
      __testables.compareTotalsSql(scopeOf("global", ["2026-09-08"]), [UUID(99)]),
    );
    expect(text).toContain("cycle_id <> all($");
    expect(params).toContainEqual([UUID(99)]);
  });

  it("창을 2배로 넓혀도 **문장 하나**다(회차가 늘 뿐 문장 수는 그대로)", () => {
    const one = compile(__testables.compareTotalsSql(scopeOf("global", ["2026-09-08"]), []));
    const many = compile(
      __testables.compareTotalsSql(
        scopeOf("global", ["2026-08-18", "2026-08-25", "2026-08-31", "2026-09-08", "2026-09-13"]),
        [],
      ),
    );
    const stmts = (t: string) => t.split(";").filter((s) => s.trim().length > 0).length;
    expect(stmts(one.text)).toBe(1);
    expect(stmts(many.text)).toBe(1);
    // 회차 집합만 커진다(스냅샷 형태 → ANY 형태).
    expect(many.text).toContain("cycle_id = any(");
  });
});

describe("숨김 회차 계열 분기", () => {
  it("언급 계열은 `hidden_scope='citations'` 회차를 **빼지 않는다**", () => {
    // 빼면 글로벌 14일 창의 Δ 가 −1.55 → −5.73 %p 로 4.18 %p 틀어진다(라이브 실측).
    expect(citationHiddenIdsFor("mention", ["a", "b"])).toEqual([]);
  });
  it("인용 계열은 뺀다(중복 제거)", () => {
    expect(citationHiddenIdsFor("citation", ["a", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("지표 매핑", () => {
  const totals = {
    day: "2026-09-08",
    keyRows: 10,
    dataCycles: 2,
    monitored: 75138,
    trackedAnswers: 56033,
    ownMentions: 100,
    compMentions: 200,
    ownPositive: 30,
    ownSignals: 60,
    rankSum: 500,
    rankedAnswers: 200,
    allCitations: 900,
  };

  it("언급 계열은 5종, 인용 계열은 1종만 낸다(두 벌의 ①을 만들지 않는다)", () => {
    const mention = __testables.measuresOf(totals, "mention");
    expect(Object.keys(mention).sort()).toEqual([
      "favorability",
      "mentionsPerAnswer",
      "position",
      "share",
      "visibility",
    ]);
    const citation = __testables.measuresOf(totals, "citation");
    expect(Object.keys(citation)).toEqual(["citationsPerAnswer"]);
  });

  it("건수형의 분모는 `monitored` 이지 `dataCycles` 가 아니다(뮤턴트 T1)", () => {
    const m = __testables.measuresOf(totals, "mention");
    expect(m.mentionsPerAnswer).toEqual({ numerator: 100, denominator: 75138 });
    expect(m.mentionsPerAnswer?.denominator).not.toBe(totals.dataCycles);
    expect(__testables.measuresOf(totals, "citation").citationsPerAnswer).toEqual({
      numerator: 900,
      denominator: 75138,
    });
  });

  it("① 노출률의 분자·분모가 골든과 같은 컬럼에서 온다", () => {
    expect(__testables.measuresOf(totals, "mention").visibility).toEqual({
      numerator: 56033,
      denominator: 75138,
    });
  });
});
