import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildTrendStatements, type TrendReadScope } from "./summary-trend-aggregates";
import { citationCyclesOf, judgeCycleRange, type CycleSet } from "@/lib/summary/read/cycle-set";
import type { CycleRangeRow } from "./summary-cycles";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";

// ── 인용 계열 회차 스코프 (0071 `hidden_scope='citations'`) ──────────────────
//
// 그 회차는 **언급은 정상이고 인용만 깨진** 회차다. 그래서 집합에는 남기되
// (`blocked` 가 `!== "citations"` 인 이유) 인용 계열 합산에서는 빼야 한다.
// 종전에는 뺄 수단이 없어서 기간 모드 카드가 그 회차의 인용을 그대로 더했다
// (2026-09-18 실측: 30일 창 총 인용 622,471 중 18,891 이 그 회차 몫).
//
// 이 파일이 고정하는 것 셋:
//   ① 판정이 그 회차를 **집합에는 남기고** 인용 제외 목록에 싣는가
//   ② 인용 계열 문장이 실제로 그 회차를 빼는가 (own 은 FILTER, domains 는 스코프)
//   ③ 뺄 회차가 없으면 **SQL 이 바이트 단위로 종전과 같은가** (회귀 0)

const dialect = new PgDialect();
const textOf = (q: SQL) => dialect.sqlToQuery(q).sql;
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

const row = (over: Partial<CycleRangeRow> = {}): CycleRangeRow => ({
  cycleId: U(1),
  generationId: U(2),
  projectId: U(3),
  cycleAnchorAt: "2026-08-31T00:00:00.000Z",
  cycleWeek: "2026-08-31",
  status: "published",
  renderable: true,
  pending: false,
  hidden: false,
  hiddenScope: null,
  analysisGapRatio: 0,
  expectedUnits: 100,
  completedUnits: 100,
  ...over,
} as CycleRangeRow);

const scopeOf = (set: CycleSet): TrendReadScope => ({
  set,
  filters: {},
  ownVariant: OWN_VARIANT_ALL,
  ownedBasePrefixes: ["hyundai.com"],
});

function setOf(rows: CycleRangeRow[]): CycleSet {
  const judged = judgeCycleRange("global", [U(3)], rows);
  if (!judged.ok) throw new Error(`판정이 폴백이다: ${judged.reason}`);
  return judged.set;
}

describe("① 판정: 인용만 깨진 회차는 집합에 남고 제외 목록에 실린다", () => {
  const rows = [
    row(),
    row({
      cycleId: U(11), generationId: U(12), projectId: U(3),
      cycleAnchorAt: "2026-08-25T00:00:00.000Z", cycleWeek: "2026-08-24",
      hidden: true, hiddenScope: "citations",
    }),
  ];

  it("회차 2개가 다 집합에 있고, 인용 제외는 그중 하나다", () => {
    const set = setOf(rows);
    expect(set.cycles.map((c) => c.cycleId).sort()).toEqual([U(1), U(11)].sort());
    expect(set.citationExcludedCycleIds).toEqual([U(11)]);
    // 언급 계열은 집합 전체, 인용 계열은 하나 뺀 것.
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual([U(1)]);
  });

  it("`hidden_scope='all'` 은 종전대로 집합에서 통째로 빠진다(제외 목록이 아니다)", () => {
    const set = setOf([
      row(),
      row({ cycleId: U(21), generationId: U(22), hidden: true, hiddenScope: "all" }),
    ]);
    expect(set.cycles.map((c) => c.cycleId)).toEqual([U(1)]);
    expect(set.citationExcludedCycleIds).toBeUndefined();
  });

  it("뺄 회차가 없으면 필드 자체가 없다: 캐시 키가 이유 없이 갈리지 않게", () => {
    const set = setOf([row()]);
    expect(set.citationExcludedCycleIds).toBeUndefined();
    expect(JSON.stringify(set)).not.toContain("citationExcluded");
    // 같은 배열 **참조**를 돌려준다(호출부가 동일성으로 무변경을 판정한다).
    expect(citationCyclesOf(set)).toBe(set.cycles);
  });
});

describe("② 문장: 인용 계열만 그 회차를 뺀다", () => {
  const set = setOf([
    row(),
    row({
      cycleId: U(11), generationId: U(12), projectId: U(3),
      cycleAnchorAt: "2026-08-25T00:00:00.000Z", cycleWeek: "2026-08-24",
      hidden: true, hiddenScope: "citations",
    }),
  ]);
  const st = buildTrendStatements(scopeOf(set));
  const byKey = new Map(st.map((s) => [s.key, textOf(s.sql)]));

  it("own: 인용 4열에만 FILTER 가 붙고, 언급 열에는 안 붙는다", () => {
    const own = byKey.get("own") as string;
    for (const col of ["all_citations", "own_citations", "own_fallback_citations", "citing_answers"]) {
      expect(own, col).toMatch(new RegExp(`sum\\(${col}\\) FILTER \\(WHERE cycle_id <> ALL`));
    }
    for (const col of ["monitored", "tracked_answers", "own_mentions", "tile_own_mentions", "comp_mentions"]) {
      expect(own, col).toMatch(new RegExp(`sum\\(${col}\\), 0\\)`));
    }
  });

  it("own: 인용 **분모**(cit_monitored)를 따로 낸다", () => {
    const own = byKey.get("own") as string;
    expect(own).toMatch(/sum\(monitored\) FILTER \(WHERE cycle_id <> ALL[^)]*\)\), 0\)::bigint\s+AS cit_monitored/);
  });

  it("domains: 표 전체가 인용 계열이라 **회차 스코프**가 좁아진다", () => {
    const dom = byKey.get("domains") as string;
    // 회차가 하나만 남으므로 기간 모드의 `ANY x ANY` 가 아니라 상수 등치로 접힌다.
    expect(dom).toContain("cycle_id = $");
    expect(dom).not.toContain("cycle_id = ANY(");
    // 그리고 그 문장에는 FILTER 를 겹쳐 걸지 않는다(이중 제외 금지).
    expect(dom).not.toContain("FILTER (WHERE cycle_id");
  });

  it("brands: 언급 계열이라 아무것도 안 바뀐다", () => {
    const brands = byKey.get("brands") as string;
    expect(brands).not.toContain("FILTER (WHERE cycle_id");
    expect(brands).toContain("cycle_id = ANY(");
  });
});

describe("③ 회귀 0: 뺄 회차가 없으면 SQL 이 종전과 바이트 동일", () => {
  const plain = setOf([
    row(),
    row({
      cycleId: U(31), generationId: U(32), projectId: U(3),
      cycleAnchorAt: "2026-09-07T00:00:00.000Z", cycleWeek: "2026-09-07",
    }),
  ]);

  it("제외 목록이 없는 집합의 4문장에 FILTER·cit_monitored 가 없다", () => {
    for (const s of buildTrendStatements(scopeOf(plain))) {
      const t = textOf(s.sql);
      expect(t, s.key).not.toContain("FILTER (WHERE cycle_id");
      expect(t, s.key).not.toContain("cit_monitored");
    }
  });

  it("같은 회차 목록이면 제외 필드 유무와 무관하게 언급 계열 문장이 같다", () => {
    const withField: CycleSet = { ...plain, citationExcludedCycleIds: [] };
    const a = new Map(buildTrendStatements(scopeOf(plain)).map((s) => [s.key, textOf(s.sql)]));
    const b = new Map(buildTrendStatements(scopeOf(withField)).map((s) => [s.key, textOf(s.sql)]));
    for (const k of a.keys()) expect(b.get(k), k).toBe(a.get(k));
  });
});

// ── 웹사이트 표면도 **같은 규칙**이다 (합성 픽스처) ─────────────────────────
//
// 오늘 라이브 창에는 `hidden_scope='citations'` 인 웹사이트 회차가 0건이라(2026-09-18
// 프로브 실측: 숨김 0) 실측으로는 못 본다. 규칙이 표면에 딸려 있지 않다는 것을
// 픽스처로 고정한다: 판정도, 문장도 글로벌과 같은 코드 경로다.
describe("웹사이트 표면: 함대 회차 중 하나만 인용 제외", () => {
  const P = (n: number) => U(100 + n);
  const rows = [0, 1].map((i) =>
    row({
      cycleId: U(40 + i), generationId: U(60 + i), projectId: P(i),
      cycleAnchorAt: "2026-09-04T00:00:00.000Z", cycleWeek: "2026-08-31",
      ...(i === 1 ? { hidden: true, hiddenScope: "citations" } : {}),
    }),
  );
  const judged = judgeCycleRange("website", [P(0), P(1)], rows);
  if (!judged.ok) throw new Error(judged.reason);
  const set: CycleSet = { ...judged.set, surface: "website" };

  it("함대 회차 둘 다 집합에 남고 인용 제외는 하나다", () => {
    expect(set.cycles).toHaveLength(2);
    expect(set.citationExcludedCycleIds).toEqual([U(41)]);
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual([U(40)]);
  });

  it("own 은 FILTER + cit_monitored, domains 는 좁힌 스코프 (글로벌과 같은 코드)", () => {
    const byKey = new Map(
      buildTrendStatements(scopeOf(set)).map((x) => [x.key, textOf(x.sql)]),
    );
    expect(byKey.get("own")).toContain("FILTER (WHERE cycle_id <> ALL");
    expect(byKey.get("own")).toContain("AS cit_monitored");
    // 남은 회차가 하나라 상수 등치로 접힌다(= 그 회차만 읽는다).
    expect(byKey.get("domains")).toContain("cycle_id = $");
    expect(byKey.get("domains")).not.toContain("cycle_id = ANY(");
    // 주 중복 판정은 웹사이트 전용이고, 여기서는 프로젝트가 달라 통과한다.
    expect(byKey.get("brands")).toContain("cycle_id = ANY(");
  });
});

describe("경계: 창 안 회차가 전부 인용 제외면 인용 문장은 공집합을 읽는다", () => {
  it("domains 가 던지지 않고 `false` 술어로 닫힌다", () => {
    const set = setOf([
      row({ hidden: true, hiddenScope: "citations" }),
    ]);
    expect(set.citationExcludedCycleIds).toEqual([U(1)]);
    const dom = textOf(buildTrendStatements(scopeOf(set)).find((s) => s.key === "domains")!.sql);
    expect(dom).toContain("false");
    expect(dom).not.toContain("cycle_id = ANY(");
  });
});
