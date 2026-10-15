import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { answerWhere, detailAnswerWhere, __testables as agg } from "./scope-aggregates";
import {
  floorDaysOf,
  measuredAtLowerBounds,
  roundDateLowerBounds,
} from "./__fixtures__/sql-bounds";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import {
  setAnchorAxisForTests,
  resetAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import {
  setTrendGridForTests,
  resetTrendGridForTests,
} from "@/lib/period/trend-grid-flag";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
  resetColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import { readSourceText } from "@/test/source-text";

// ════════════════════════════════════════════════════════════════════════════
// 회귀: 자리 창(S0)이 **본문 집계로 샜다** (2026-09-20 고객 보고)
// ════════════════════════════════════════════════════════════════════════════
//
// `withWeeklyTrendGrid` 가 `withTrendGridWindow(filters, slots)` 로 좁힌 필터를 페처의
// 읽기에 통째로 넘겼다. 그런데 그 페처들은 추이만 읽는 것이 아니라 **지면 전체**를 읽는다
// (카드 스칼라·도메인 표·유형 분포·프롬프트 수). 그래서 기간 미선택 기본 화면(= 최신 회차)의
// 본문 집계가 13주 누적 창을 읽고 예산을 넘겼다:
//
//   [kpi-tabs] standardCitations timed out (page still served)   60분에 10회
//   x-hmg-summary(global S3.citation): fallback:cumulative
//   실패 문장의 스냅샷 서브쿼리에 ca.round_date >= '2026-06-22' (= S0)
//
// 여기서 고정하는 것 둘:
//   ① **본문**은 격자 on/off 에서 같은 문장이다(자리 창 하한이 없다).
//   ② **추이**의 창 바닥은 자리 상한을 덮는다(= 모든 자리가 읽기 창 안이라 거짓 갭이 없다).

const dialect = new PgDialect();
const compile = (q: SQL): string => dialect.sqlToQuery(q).sql;
const params = (q: SQL): unknown[] => dialect.sqlToQuery(q).params;
const SRC = readSourceText(`${process.cwd()}/lib/scope/server.ts`);

/** 기간 미선택 = 기본 화면. 이 상태에서 본문이 누적 창으로 떨어지면 안 된다. */
const NO_PERIOD: StandardFilters = {};
/** 회귀 당시 심어졌던 자리 바닥. */
const S0 = "2026-06-22";

beforeEach(() => {
  setColumnAvailabilityForTests(
    Object.fromEntries(SYNC_PROBED_COLUMNS.map((c) => [c, true])) as never,
  );
  setAnchorAxisForTests(true);
});
afterEach(() => {
  resetColumnAvailabilityForTests();
  resetAnchorAxisForTests();
  resetTrendGridForTests();
});

describe("본문 집계는 격자 on/off 에서 **같은 문장**이다", () => {
  // 6지면의 본문이 쓰는 술어 둘. 글로벌(루트)·프로젝트·website 스코프를 다 돈다.
  const CTX: Array<[string, string | string[] | undefined]> = [
    ["글로벌(루트)", undefined],
    ["프로젝트", "11111111-1111-4111-8111-111111111111"],
    ["website(함대)", ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]],
  ];

  it.each(CTX)("%s — 본문 스냅샷 술어가 격자 on/off 에서 같다", (_label, ctx) => {
    setTrendGridForTests(false);
    const off = compile(detailAnswerWhere(NO_PERIOD, ctx, {}));
    setTrendGridForTests(true);
    const on = compile(detailAnswerWhere(NO_PERIOD, ctx, {}));
    expect(on, "격자가 본문 술어를 바꿨다").toBe(off);
  });

  it.each(CTX)("%s — 본문에 자리 창 하한(S0)이 없다", (_label, ctx) => {
    setTrendGridForTests(true);
    const text = compile(detailAnswerWhere(NO_PERIOD, ctx, {}));
    // 회귀 때는 여기에 `ca.round_date >= '2026-06-22'` 가 실려 있었다.
    const q = detailAnswerWhere(NO_PERIOD, ctx, {});
    // 회귀 때는 여기에 `ca.round_date >= '2026-06-22'`(= S0) 가 바인드로 실려 있었다.
    expect(params(q), "본문 파라미터에 자리 바닥이 실렸다").not.toContain(S0);
    expect(text).not.toContain(S0);
    // 상수 하한만 남아야 한다(날짜 하한 0개).
    const bounds = [...roundDateLowerBounds(text), ...measuredAtLowerBounds(text)];
    expect(bounds.filter((b) => /\$\d+/.test(b)), "본문에 바인드 날짜 하한이 있다").toEqual([]);
  });

  it("기간을 **고르면** 그 기간은 본문에 그대로 걸린다 (좁히기가 죽은 게 아니다)", () => {
    setTrendGridForTests(true);
    const q = detailAnswerWhere({ dateFrom: "2026-09-01" }, undefined, {});
    // 날짜는 바인드로 나간다 — 텍스트가 아니라 파라미터를 본다.
    expect(params(q)).toContain("2026-09-01");
  });
});

describe("추이 문장의 창 바닥은 자리 상한을 덮는다", () => {
  it("격자 on 의 추이 바닥(180)이 자리 상한(TREND_GRID_MAX_DAYS)과 같거나 넓다", async () => {
    setTrendGridForTests(true);
    const { TREND_GRID_MAX_DAYS } = await import("@/lib/period/trend-grid");
    const days = floorDaysOf(roundDateLowerBounds(compile(agg.weeklyTopNTrendFloor(true))));
    expect(days).toEqual([180]);
    // 자리는 이 상한 안에서만 만들어지므로 **모든 자리가 읽기 창 안**이다 = 거짓 갭 0.
    expect(Math.max(...days)).toBeGreaterThanOrEqual(TREND_GRID_MAX_DAYS);
  });

  it("격자 off 면 추이 바닥이 120 이다 — 본문과 함께 종전 그대로", () => {
    setTrendGridForTests(false);
    const days = floorDaysOf(roundDateLowerBounds(compile(agg.weeklyTopNTrendFloor(true))));
    expect(days).toEqual([120]);
  });

  it("본문 술어(`answerWhere`)는 그 바닥을 **안 본다** — 추이 전용이다", () => {
    setTrendGridForTests(true);
    const body = compile(answerWhere(NO_PERIOD, undefined, {}));
    expect(body).not.toContain("hmg_anchor_today() - 180");
  });
});

describe("배선 — 헬퍼가 읽기 필터를 건드리지 않는다", () => {
  const helper = (() => {
    const i = SRC.indexOf("async function withWeeklyTrendGrid<");
    expect(i).toBeGreaterThan(0);
    return SRC.slice(i, SRC.indexOf("\n}\n", i));
  })();

  it("`req.read(filters)` — 사용자의 원래 필터를 그대로 넘긴다", () => {
    expect(helper).toContain("const result = await req.read(filters);");
  });

  it("헬퍼 안에서 `withTrendGridWindow` 를 쓰지 않는다 (회귀의 직접 원인)", () => {
    const code = helper
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("withTrendGridWindow(");
  });

  // 자리 창을 거는 나머지 다섯은 **추이만 내는 페처**다(반환 타입이 추이 배열 하나).
  it("자리 창을 거는 페처는 추이 전용이다", () => {
    const TREND_ONLY: Array<[string, string]> = [
      ["async function fetchStandardTrendImpl(", "Promise<StandardTrendBucket[]>"],
      ["export async function fetchProjectTrend(", "Promise<StandardTrendBucket[] | null>"],
      ["export async function fetchWebsiteTrend(", "Promise<StandardTrendBucket[]>"],
      [
        "export async function fetchProjectCitationAccuracyTrend(",
        "Promise<CitationAccuracyTrendBucket[]>",
      ],
      [
        "export async function fetchWebsiteCitationAccuracyTrend(",
        "Promise<CitationAccuracyTrendBucket[]>",
      ],
    ];
    for (const [decl, ret] of TREND_ONLY) {
      const i = SRC.indexOf(decl);
      expect(i, `${decl} 를 못 찾았다`).toBeGreaterThan(0);
      const head = SRC.slice(i, SRC.indexOf("{", SRC.indexOf("): ", i)));
      expect(head, `${decl} 가 추이 말고 다른 것도 낸다 — 자리 창이 샌다`).toContain(ret);
    }
    // 그리고 그 다섯만 건다(6지면 헬퍼는 안 건다).
    const code = SRC.split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect([...code.matchAll(/withTrendGridWindow\(/g)]).toHaveLength(5);
  });
});
