import { describe, it, expect, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  G_BRAND_AXES,
  G_BRAND_SERIES_LIMITS,
  G_BRAND_STATEMENT_KEYS,
} from "./summary-global-trend-read";
import { buildTrendStatements, type TrendReadScope } from "./summary-trend-aggregates";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

// 경쟁사 Δ 2단의 **2단 문장 형태**를 고정한다 — PR④ B2 수용 기준 ②·③.
//
//   ② 미러 문장 0 — 이 경로는 집계층 표 하나만 읽는다(세부층 표 이름이 나오면 안 된다).
//   ③ **회차 술어가 세미조인이 아니다** — `job_id IN (SELECT … FROM summary_answers)` 는
//      PR② 이전 세부층 리더의 형태이고, 223 ms → 3,943 ms 를 만든 그 한 줄이다.
//      집계층 키는 `cycle_anchor_at`·`cycle_id`·`generation_id` 를 직접 갖고 있다.
//   + top-N 한정 — 2단의 이득 전부가 `brand_name = ANY(...)` 한 줄에서 나온다.
//     이것이 빠지면 문장은 통과하는데 13회차 브랜드 축 전량(500~800 ms)을 읽는다.

const dialect = new PgDialect();
const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

const cycleAt = (n: number) => ({
  cycleId: UUID(n),
  generationId: UUID(n + 100),
  projectId: UUID(3),
  cycleAnchorAt: `2026-0${n}-01T00:00:00.000Z`,
  cycleWeek: `2026-0${n}-01`,
});

const periodSet: CycleSet = {
  surface: "global",
  mode: "period",
  cycles: [cycleAt(6), cycleAt(7), cycleAt(8)],
  cycleKey: "period-3",
  projectIds: [UUID(3)],
  missingProjectIds: [],
  weeks: ["2026-06-01", "2026-07-01", "2026-08-01"],
  anchorCount: 3,
};

const NAMES = ["Tesla", "Toyota", "BMW", "Mercedes-Benz"];

const seriesScope = (brandNames?: readonly string[]): TrendReadScope => ({
  set: periodSet,
  filters: {},
  ownVariant: OWN_VARIANT_ALL,
  ownedBasePrefixes: [],
  limits: G_BRAND_SERIES_LIMITS,
  axes: G_BRAND_AXES,
  brandNames,
});

const textOf = (scope: TrendReadScope) => {
  const st = buildTrendStatements(scope, { only: G_BRAND_STATEMENT_KEYS });
  expect(st).toHaveLength(1);
  expect(st[0].table).toBe("summary_trend_brands");
  return dialect.sqlToQuery(st[0].sql).sql;
};

describe("경쟁사 Δ 2단 — 회차 축 문장", () => {
  it("문장은 **1개**이고 브랜드 표 하나만 읽는다", () => {
    expect(textOf(seriesScope(NAMES))).toContain("summary_trend_brands");
  });

  it("회차 축(`cycle_anchor_at, brand_name`) grouping set 이 서 있다", () => {
    expect(textOf(seriesScope(NAMES))).toContain("(cycle_anchor_at, brand_name)");
  });

  it("**세미조인이 아니다** — 세부층 표도 `job_id` 도 나오지 않는다", () => {
    const text = textOf(seriesScope(NAMES));
    for (const t of [
      "summary_answers",
      "summary_brand_mentions",
      "summary_domain_citations",
      "summary_cycle_jobs",
      "scope_answers",
    ]) {
      expect(text, t).not.toContain(t);
    }
    expect(text).not.toContain("job_id");
  });

  it("이름으로 좁힌다 — `brand_name = ANY(...)` 이 붙고, 안 넘기면 안 붙는다", () => {
    expect(textOf(seriesScope(NAMES))).toContain("brand_name = ANY(");
    // 음성 대조: 이름을 안 넘기면 그 한 줄이 사라진다(= 전량 스캔). 가드가 상수를
    // 보는 게 아니라 **좁힘 자체**를 보는지 확인한다.
    expect(textOf(seriesScope(undefined))).not.toContain("brand_name = ANY(");
    expect(textOf(seriesScope([]))).not.toContain("brand_name = ANY(");
  });

  // ── 0069 축 (PR④-b F1) ────────────────────────────────────────────────────
  // Δ 는 이 문장이 실어 오는 두 칸으로 계산된다(`toFirstPosition(…, "comp")`).
  // 문장에서 빠지면 리더는 조용히 **0/0 → 빈칸**이 되고, 그 자리에 서수 축을 다시
  // 끼우면 값과 Δ 의 축이 갈린다 — 그 회귀를 여기서 막는다.
  describe("**답변 안 경쟁 순위** 두 칸을 함께 싣는다", () => {
    afterEach(() => { resetColumnAvailabilityForTests(); });

    /**
     * 기반 표를 **직접 훑는 SELECT** 만 잘라 본다. 잔여 행 재집계
     * (`BRAND_MEASURE_REAGG`)는 CTE `r`(= 이미 별칭이 붙은 행)을 합하므로 컬럼 부재와
     * 무관하게 `sum(comp_rank_sum)` 이 늘 나온다 — 거기서 보면 음성 대조가 성립하지 않는다.
     */
    const baseScanOf = (text: string) => text.slice(0, text.indexOf("FROM summary_trend_brands"));

    it("컬럼이 있으면 회차 축 문장이 기반 표에서 두 컬럼을 sum 한다", () => {
      setColumnAvailabilityForTests("summary_trend_brands", "comp_rank_sum", true);
      const base = baseScanOf(textOf(seriesScope(NAMES)));
      expect(base).toContain("sum(comp_rank_sum)");
      expect(base).toContain("sum(comp_ranked_answers)");
      // 서수 축도 그대로 남는다 — GEO 위젯(`toGeoKpi`)이 그 정의를 계속 쓴다.
      expect(base).toContain("sum(rank_sum)");
    });

    it("컬럼이 **없으면** 상수 0 을 내고 컬럼명을 참조하지 않는다(42703 금지)", () => {
      setColumnAvailabilityForTests("summary_trend_brands", "comp_rank_sum", false);
      const text = textOf(seriesScope(NAMES));
      const base = baseScanOf(text);
      expect(base).not.toContain("sum(comp_rank_sum)");
      expect(base).not.toContain("sum(comp_ranked_answers)");
      // 행 모양은 같아야 한다 — 별칭이 살아 있어야 매핑·절단 재집계가 안 갈린다.
      expect(base).toContain("AS comp_rank_sum");
      expect(base).toContain("AS comp_ranked_answers");
      // 그때 리더는 분모 0 을 받아 `avgPosition` 을 **null** 로 낸다(0 나눗셈 금지) —
      // 값 계약은 summary-global-trend-read.test.ts 의 "0069 미적용" 케이스가 고정한다.
      expect(base).toContain("0::double precision");
    });
  });

  it("브랜드 축은 자르지 않는다 — 이미 이름으로 좁혔다", () => {
    // `G_BRAND_SERIES_LIMITS.brand = null`. 절단이 살아 있으면 top-200 이 다시 걸려
    // 잔여(`is_rest`) 행이 생기고, 그 행이 Δ 분모로 새어 들어간다.
    expect(G_BRAND_SERIES_LIMITS.brand).toBeNull();
  });
});
