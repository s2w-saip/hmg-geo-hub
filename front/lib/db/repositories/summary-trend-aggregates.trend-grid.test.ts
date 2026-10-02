import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  buildTrendStatements,
  trendWhere,
  type TrendReadScope,
} from "./summary-trend-aggregates";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";

// ════════════════════════════════════════════════════════════════════════════
// 추이 격자(`X.trendGrid`)의 **SQL 효과는 한 줄**이다 (설계 §4-A · W1)
// ════════════════════════════════════════════════════════════════════════════
//
// 설계 §0 이 "코드 변경은 추이 리더의 게이트 한 줄" 이라고 적었다. 그 주장을 여기서
// 기계로 고정한다: 켠 문장은 끈 문장에서 **` AND in_full_cycle = 1` 만 빠진 것**이고,
// 다른 글자는 하나도 다르지 않다. 바인드도 같다.
//
// 이것이 성립하는 이유는 사실표가 게이트를 **키 컬럼**으로 들고 있기 때문이다
// (`fold.ts::AGG_DIMS` 의 `in_full_cycle`, 생성기는 `CASE … THEN 1 ELSE 0 END` 로
// 0 행도 굳힌다 — `surface-global.ts:545`). 즉 재생성 없이 리더에서 고를 수 있다.

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q);

const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

const globalSet: CycleSet = {
  surface: "global",
  mode: "period",
  cycles: [1, 4].map((n) => ({
    cycleId: UUID(n),
    generationId: UUID(n + 1),
    projectId: UUID(3),
    cycleAnchorAt: n === 1 ? "2026-08-31T00:00:00.000Z" : "2026-09-07T00:00:00.000Z",
    cycleWeek: n === 1 ? "2026-08-31" : "2026-09-07",
  })),
  cycleKey: "k",
  projectIds: [UUID(3)],
  missingProjectIds: [],
  weeks: ["2026-08-31", "2026-09-07"],
  anchorCount: 2,
};

const websiteSet: CycleSet = { ...globalSet, surface: "website" };

const scopeOf = (set: CycleSet, filters: StandardFilters = {}): TrendReadScope => ({
  set,
  filters,
  ownVariant: OWN_VARIANT_ALL,
  ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/"],
  unitFlags: set.surface === "website",
});

const HEAVY: StandardFilters = {
  region: ["KR", "US"],
  lang: ["ko"],
  engine: ["chatgpt"],
  funnelStage: ["인지"],
  listType: ["single"],
  depth1: ["구매"],
  brand: ["Hyundai"],
  brandPresence: ["branded"],
};

describe("trendWhere — 글로벌 게이트 한 줄", () => {
  it("끄면 `in_full_cycle = 1` 이 있다(종전)", () => {
    expect(compile(trendWhere(scopeOf(globalSet))).sql).toContain("in_full_cycle = 1");
  });

  it("켜면 그 조건만 빠진다 — 나머지는 바이트 동일", () => {
    const off = compile(trendWhere(scopeOf(globalSet, HEAVY)));
    const on = compile(trendWhere({ ...scopeOf(globalSet, HEAVY), trendGrid: true }));
    expect(on.sql).not.toContain("in_full_cycle");
    expect(on.sql).toBe(off.sql.replace(" AND in_full_cycle = 1", ""));
    expect(on.params).toEqual(off.params);
  });

  it("나머지 두 게이트는 **그대로다** — 제품 정의라 뺄 수 없다", () => {
    const on = compile(trendWhere({ ...scopeOf(globalSet), trendGrid: true })).sql;
    expect(on).toContain("in_root_catalog = 1");
    expect(on).toContain("in_tagged_region = 1");
    // 숨김 국가 제외도 그대로 — 단 목록이 있을 때만 붙는다(2026-09-28 ID 해제, hmg-geo PR #302).
    if (HIDDEN_STANDARD_REGIONS.length) expect(on).toContain("country <> ");
    else expect(on).not.toContain("country <> ");
  });

  // 웹사이트는 생성기가 `in_full_cycle = 1` 고정으로 굳히고(surface-website.ts:386)
  // 조회도 글로벌 분기에서만 건다 — 이 키가 켜져도 문장이 안 바뀌어야 한다.
  it("웹사이트 문장은 on/off 가 바이트 동일하다", () => {
    const off = compile(trendWhere(scopeOf(websiteSet)));
    const on = compile(trendWhere({ ...scopeOf(websiteSet), trendGrid: true }));
    expect(on.sql).toBe(off.sql);
    expect(on.params).toEqual(off.params);
    expect(off.sql).not.toContain("in_full_cycle");
  });
});

describe("발행 문장 4종 — 격자 on 에서도 형태가 같다", () => {
  const keys = ["own", "answers", "brands", "domains"] as const;

  it("문장 수·표·바인드 수가 같고, 차이는 게이트 한 줄뿐이다", () => {
    const off = buildTrendStatements(scopeOf(globalSet, HEAVY));
    const on = buildTrendStatements({ ...scopeOf(globalSet, HEAVY), trendGrid: true });
    expect(on.map((s) => s.key)).toEqual(off.map((s) => s.key));
    expect(on.map((s) => s.table)).toEqual(off.map((s) => s.table));
    for (let i = 0; i < off.length; i += 1) {
      const a = compile(off[i].sql);
      const b = compile(on[i].sql);
      expect(a.sql, off[i].key).toContain("in_full_cycle = 1");
      expect(b.sql, on[i].key).not.toContain("in_full_cycle");
      // 게이트가 조건 배열의 같은 자리에서만 빠진다(`replaceAll` — 문장당 WHERE 는 하나지만
      // CTE 를 쓰는 answers 문장은 안쪽에도 같은 술어가 들어간다).
      expect(b.sql, on[i].key).toBe(a.sql.replaceAll(" AND in_full_cycle = 1", ""));
      expect(b.params, on[i].key).toEqual(a.params);
    }
    expect(off.map((s) => s.key)).toEqual([...keys]);
  });

  it("문장 수는 여전히 ≤ 4 다(수용 기준 ①)", () => {
    expect(buildTrendStatements({ ...scopeOf(globalSet), trendGrid: true })).toHaveLength(4);
  });
});
