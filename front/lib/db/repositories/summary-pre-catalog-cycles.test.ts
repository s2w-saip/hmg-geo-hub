import { describe, it, expect, afterEach } from "vitest";

// ── 카탈로그 도입 전 회차 판정 — 규칙과 두 소비처의 **동치** (제품 책임자 2026-09-20 ①) ──
//
// 이 파일이 지키는 것 셋:
//   ① 판정 SQL 이 "행이 있고(EXISTS) 카탈로그 행이 없다(NOT EXISTS)" 두 조건을 **둘 다**
//      건다. `EXISTS` 를 빼면 접기가 안 돈 회차가 "카탈로그 전" 으로 오판돼 게이트가
//      통째로 풀린다(값이 부푸는 방향).
//   ② 사실표 술어와 미러 술어가 **같은 목록**을 읽는다 — 하나만 열리면 "미러에서만
//      6월이 보이는" 상태가 되고, 그것이 이 트랙이 없애려는 형태다.
//   ③ 목록이 비면 두 술어 텍스트가 **종전과 바이트 동일**이다.

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { preCatalogCyclesSql } from "./summary-pre-catalog-cycles";
import {
  preCatalogCacheSlot,
  preCatalogCycleIdsKnown,
  resetTrendGridForTests,
  setTrendGridForTests,
} from "@/lib/period/trend-grid-flag";
import { trendWhere, type TrendReadScope } from "./summary-trend-aggregates";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const dialect = new PgDialect();
const compileSql = (q: SQL) => dialect.sqlToQuery(q);

const CYCLE_A = "11111111-1111-4111-8111-111111111111";
const CYCLE_B = "22222222-2222-4222-8222-222222222222";

const set = (): CycleSet => ({
  surface: "global",
  mode: "period",
  cycles: [
    {
      cycleId: CYCLE_A,
      generationId: "aaaaaaaa-1111-4111-8111-111111111111",
      projectId: "be28fe15-c743-4a88-abb8-182b25602812",
      cycleWeek: "2026-06-22",
      cycleAnchorAt: "2026-06-18T15:00:00.000Z",
    },
  ] as unknown as CycleSet["cycles"],
  cycleKey: "k",
  projectIds: ["be28fe15-c743-4a88-abb8-182b25602812"],
  missingProjectIds: [],
  weeks: ["2026-06-22"],
  anchorCount: 1,
});

const scopeOf = (over: Partial<TrendReadScope> = {}): TrendReadScope => ({
  set: set(),
  filters: {},
  ownVariant: "ALL",
  ownedBasePrefixes: [],
  ...over,
});

afterEach(() => resetTrendGridForTests());

describe("판정 SQL — 규칙이 데이터에 있고 날짜에 없다", () => {
  const text = compileSql(preCatalogCyclesSql("be28fe15-c743-4a88-abb8-182b25602812")).sql;

  it("날짜 리터럴을 쓰지 않는다 (6월을 이름으로 고르지 않는다)", () => {
    expect(text).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(text).not.toMatch(/interval/i);
  });

  it("행이 있고(EXISTS) 카탈로그 행이 없다(NOT EXISTS) 를 **둘 다** 건다", () => {
    expect(text).toContain("AND EXISTS (");
    expect(text).toContain("AND NOT EXISTS (");
    expect(text).toContain("t.in_root_catalog = 1");
  });

  it("활성 세대의 사실표 행만 본다 (표는 모수 표 `answers`)", () => {
    // A1-c 수리: `own` 은 own_variant 축이라 행 존재 범위가 `answers` 의 부분집합이다.
    expect(text).toContain("summary_trend_answers");
    expect(text).not.toContain("summary_trend_own");
    expect(text).toContain("t.generation_id = sc.active_generation_id");
    expect(text).toContain("sc.surface = 'global'");
  });

  it("판정 모집단 = 게이트 모집단 (A1-d 수리)", () => {
    // 게이트가 거르는 두 축을 판정도 본다 — 안 보면 "판정은 카탈로그 전 아님인데
    // 게이트 결과는 0행" 인 자리가 조용히 빈다.
    expect((text.match(/t\.run_status IN \('completed', 'partial_failed'\)/g) ?? []).length).toBe(2);
    expect((text.match(/t\.country <> ALL\(/g) ?? []).length).toBe(2);
  });

  it("루트가 없으면 프로젝트 술어를 안 건다", () => {
    expect(compileSql(preCatalogCyclesSql(null)).sql).not.toContain("sc.project_id");
  });
});

describe("사실표 술어 — 목록이 있을 때만 게이트가 열린다", () => {
  it("격자 on + 목록 있음 → 그 회차만 두 게이트를 건너뛴다", () => {
    const text = compileSql(
      trendWhere(scopeOf({ trendGrid: true, preCatalogCycleIds: [CYCLE_A] })),
    ).sql;
    expect(text).toContain("cycle_id = ANY(");
    expect(text).toContain("in_root_catalog = 1 AND in_tagged_region = 1");
    // 셋째 게이트는 격자 on 이면 그대로 빠진다(PR①).
    expect(text).not.toContain("in_full_cycle = 1");
  });

  it("목록이 비면 **종전 텍스트 그대로**(바이트 동일)", () => {
    const off = compileSql(trendWhere(scopeOf({ trendGrid: true }))).sql;
    const empty = compileSql(
      trendWhere(scopeOf({ trendGrid: true, preCatalogCycleIds: [] })),
    ).sql;
    expect(empty).toBe(off);
    expect(off).toContain("in_root_catalog = 1");
    expect(off).not.toContain("cycle_id = ANY(");
  });

  it("격자 off 면 목록이 있어도 무시한다 (키 뒤에만 새 동작)", () => {
    const text = compileSql(trendWhere(scopeOf({ preCatalogCycleIds: [CYCLE_A] }))).sql;
    expect(text).not.toContain("cycle_id = ANY(");
    expect(text).toContain("in_full_cycle = 1");
  });

  it("혼합 회차는 목록에 없으므로 게이트가 그대로 걸린다", () => {
    // 목록에 없는 회차(CYCLE_B)만 집합에 있어도 술어 모양은 같다 — 판정은 **행 단위**
    // `cycle_id = ANY(...)` 이므로, 목록 밖 회차의 행은 여전히 등호 게이트를 통과해야 한다.
    const text = compileSql(
      trendWhere(scopeOf({ trendGrid: true, preCatalogCycleIds: [CYCLE_B] })),
    ).sql;
    expect(text).toContain("OR (in_root_catalog = 1 AND in_tagged_region = 1)");
  });
});

describe("두 소비처가 같은 목록을 읽는다", () => {
  it("격자 state 에 심은 목록을 동기 접근자가 그대로 돌려준다", () => {
    setTrendGridForTests(true, [CYCLE_A, CYCLE_B]);
    expect(preCatalogCycleIdsKnown()).toEqual([CYCLE_A, CYCLE_B]);
  });

  it("미확정이면 빈 목록 = 종전 게이트", () => {
    resetTrendGridForTests();
    expect(preCatalogCycleIdsKnown()).toEqual([]);
  });

  // A2-3 수리: 목록과 격자 판정이 **한 state·한 만료**다. 따로 들면 목록이 먼저
  // 만료된 구간에서 격자만 켜진 채 목록이 비어 값이 갈린다.
  it("목록과 격자 판정이 같은 state 다 (만료가 하나)", () => {
    setTrendGridForTests(true, [CYCLE_A]);
    expect(preCatalogCycleIdsKnown()).toEqual([CYCLE_A]);
    resetTrendGridForTests();
    // 격자 state 를 비우면 목록도 함께 비어야 한다 — 남아 있으면 만료가 둘이다.
    expect(preCatalogCycleIdsKnown()).toEqual([]);
  });

  // A2-1 수리: 캐시 슬롯에 목록의 안정 해시가 실린다.
  it("캐시 슬롯이 목록에 따라 갈리고, 순서에는 안 갈린다", () => {
    setTrendGridForTests(true, [CYCLE_A, CYCLE_B]);
    const a = preCatalogCacheSlot();
    setTrendGridForTests(true, [CYCLE_B, CYCLE_A]);
    expect(preCatalogCacheSlot()).toBe(a);
    setTrendGridForTests(true, [CYCLE_A]);
    expect(preCatalogCacheSlot()).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("목록이 비면 슬롯 조각이 **빈 문자열** = 종전 키 그대로", () => {
    setTrendGridForTests(true, []);
    expect(preCatalogCacheSlot()).toBe("");
  });

  it("미러 술어도 같은 접근자를 읽는다 (소스 가드)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
      "utf8",
    );
    // 미러 쪽 탈출구는 **한 함수**에만 있고, 그 함수가 접근자를 읽는다.
    expect((src.match(/function withPreCatalogEscape\(/g) ?? []).length).toBe(1);
    expect(src).toContain("const pre = preCatalogCycleIdsKnown();");
    // 두 경로(조인 판본·semi-join 판본)가 **둘 다** 그 탈출구를 통과한다.
    expect((src.match(/withPreCatalogEscape\(/g) ?? []).length).toBe(3);
    // 판정을 자기가 다시 하지 않는다 — dim 으로 재판정하면 사실표와 갈린다.
    expect(src).not.toContain("preCatalogCyclesSql(");
    // 목록은 격자 판정과 **같은 모듈**에서 온다(만료가 하나).
    expect(src).toContain('from "@/lib/period/trend-grid-flag"');
  });
});

describe("빈 목록에서 미러 술어 텍스트가 안 바뀐다", () => {
  it("탈출구는 입력 술어를 그대로 돌려준다", () => {
    // `withPreCatalogEscape` 는 비공개라 동치 성질을 같은 형태로 재현해 고정한다.
    const gated = sql`d.in_root_catalog = 1`;
    const wrapped = preCatalogCycleIdsKnown().length
      ? sql`(ca.cycle_id = ANY(${sql.param([])}::uuid[]) OR ${gated})`
      : gated;
    expect(compileSql(wrapped).sql).toBe(compileSql(gated).sql);
  });
});

// ── N1(2026-09-20 독립 검증): 한 요청 안에서 값이 하나다 ─────────────────────
//
// 실패를 캐시하지 않게 바꾼 대가: 재시도를 호출마다 하면 한 요청 안에서 소비처 A 는
// 빈 목록, B 는 목록을 보는 분기가 생긴다(`mirrorCache` 의 `routed` 가 셀마다
// `ensureTrendGrid()` 를 부른다). React `cache` 로 요청당 한 번만 해소한다.
describe("요청 단위 확정 — 소비처들이 같은 값을 본다", () => {
  it("`ensureTrendGrid` 가 React `cache` 로 감싸여 있다 (소스 가드)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const FLAG = readFileSync(
      fileURLToPath(new URL("../../period/trend-grid-flag.ts", import.meta.url)),
      "utf8",
    );
    expect(FLAG).toContain('import { cache } from "react";');
    expect(FLAG).toContain("const requestState = cache(async (): Promise<boolean> =>");
    expect(FLAG).toContain("return requestState();");
    // 해소 본문은 따로 있고, ensure 는 그것을 직접 부르지 않는다(부르면 메모가 새 나간다).
    expect(FLAG).toContain("async function resolveTrendGrid(): Promise<boolean>");
    expect((FLAG.match(/resolveTrendGrid\(\)/g) ?? []).length).toBe(2);
  });

  it("확정 뒤 여러 번 읽어도 같은 목록이다", async () => {
    setTrendGridForTests(true, [CYCLE_A]);
    const first = preCatalogCycleIdsKnown();
    const second = preCatalogCycleIdsKnown();
    expect(second).toEqual(first);
    expect(second).toEqual([CYCLE_A]);
  });
});
