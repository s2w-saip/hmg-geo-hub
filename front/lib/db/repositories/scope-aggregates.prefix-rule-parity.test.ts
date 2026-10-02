import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { HMG_BRAND_ENTITY_IDS, HMG_BRAND_NAME_PREFIXES } from "@/lib/scope/hmg-brands";

// ── 표기 접두 규칙(canonRollupSql 의 HMG 접두 CASE) 발화 가드 ─────────────────
//
// 왜 이 파일이 있는가. PR #113 은 접두 규칙을 도입하면서 **AE/Genesis 슬라이스
// 하나**로 표면 간 정합을 검증했다. 사후 검증이 밝힌 것: 그 슬라이스에서는
// 규칙 on/off 가 **완전히 같은 값**을 냈다(총계 2,046 · Genesis 182). 즉 그
// 검증은 규칙을 한 번도 실행시키지 않고 통과했다 — **공허하게(vacuously) 통과**.
//
// 여기서 배운 것은 "슬라이스를 잘 고르자"가 아니다. 슬라이스는 데이터가 굴러가면
// 조용해진다(표준 스냅샷은 7일 full-cycle 창이라 특히). 배워야 할 규율은:
//
//     **검증은 공허하게 통과할 수 있으면 안 된다.**
//     규칙이 실제로 발화했음을 먼저 단언하고, 그 다음에 값을 비교한다.
//
// 이 파일은 그 규율의 **DB 없이 도는 절반**이다: 접두 규칙이 브랜드 귀속을
// 결정하는 **모든 발행 문에 실제로 실려 나가는지**를 컴파일된 SQL 로 본다.
// 나머지 절반(실 데이터에서 규칙이 값을 바꾸는가)은 DATABASE_URL 이 있을 때 도는
// scope-aggregates.prefix-rule-slice.int.test.ts 가 본다.
//
// ⚠️ 이 리포는 PR CI 가 없다(.github/workflows 부재). 그래서 "테스트를 추가했다"
//    가 "다음 사람이 돌린다"를 뜻하지 않는다. 그 제약 때문에 **주 가드를 DB 없이
//    `npm test` 로 도는 이 파일에 둔다** — 게이트를 돌리는 사람이면 무조건 걸린다.
const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q);

const TRACKED_IDS = new Set<string>(Object.values(HMG_BRAND_ENTITY_IDS));
// 접두 CASE 가 브랜드마다 넣는 정규식 바인드 파라미터.
const isPrefixPattern = (p: unknown) =>
  typeof p === "string" && /^\^\[[^\]]*\]\*\((Genesis|Hyundai|Kia)[|)]/.test(p);

type Stmt = { sql: string; params: unknown[] };

/** 그 문이 "당사 귀속"을 판정하는가 = tracked id 목록으로 rollup 을 비교하는가. */
const decidesAttribution = (s: Stmt) =>
  s.sql.includes("brand_rollup_entity_id") &&
  s.params.some((p) => typeof p === "string" && TRACKED_IDS.has(p));

/** 발행된 문을 전부 수집한다 (db 스텁). */
async function collect(
  run: (mod: typeof import("./scope-aggregates")) => Promise<unknown>,
): Promise<Stmt[]> {
  const statements: Stmt[] = [];
  const execute = vi.fn(async (q: unknown) => {
    const compiled = compile(q as SQL);
    statements.push(compiled);
    // 조기 반환(모수 0)으로 잘려나가지 않게 헤드라인/answer-level 질의에 행을 준다.
    if (/AS answers/.test(compiled.sql)) {
      return [{ answers: 1, prompts: 1, as_of: "2026-09-15T00:00:00.000Z" }];
    }
    if (/GROUP BY region/i.test(compiled.sql)) {
      return [{ region: "KR", answers: 1, tracked: 1 }];
    }
    return [];
  });
  vi.resetModules();
  vi.doMock("@/lib/db", () => ({
    getDb: () => ({
      execute,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }),
    }),
  }));
  const mod = await import("./scope-aggregates");
  try {
    await run(mod);
  } catch {
    // 스텁이 빈 결과를 주면 일부 경로가 중도 종료할 수 있다 — 그때까지 발행된
    // 문만으로도 가드는 성립한다(수집된 문에 대해서만 단언한다).
  }
  vi.doUnmock("@/lib/db");
  return statements;
}

describe("접두 규칙이 붙어 나가는 상수 계약", () => {
  it("접두 목록은 라틴·한국어·아랍어·히브리어 표기를 모두 덮는다", () => {
    // #113 이 회수한 3,884 언급의 대부분이 비라틴 표기였다. 하나라도 빠지면
    // 그 표기의 당사 언급이 조용히 경쟁사로 남는다.
    expect(HMG_BRAND_NAME_PREFIXES.Genesis).toContain("제네시스");
    expect(HMG_BRAND_NAME_PREFIXES.Hyundai).toContain("현대");
    expect(HMG_BRAND_NAME_PREFIXES.Hyundai).toContain("هيونداي");
    expect(HMG_BRAND_NAME_PREFIXES.Kia).toContain("기아");
    expect(HMG_BRAND_NAME_PREFIXES.Kia).toContain("קיה");
    // 평가 순서: Genesis 가 Hyundai 보다 먼저여야 'Genesis …' 가 새지 않는다.
    const order = Object.keys(HMG_BRAND_NAME_PREFIXES);
    expect(order.indexOf("Genesis")).toBeLessThan(order.indexOf("Hyundai"));
    // '현대자동차' 가 '현대' 보다 먼저(긴 것 우선) — 짧은 것이 먼저 맞으면 가려진다.
    const h = HMG_BRAND_NAME_PREFIXES.Hyundai;
    expect(h.indexOf("현대자동차")).toBeLessThan(h.indexOf("현대"));
  });

  it("canonRollupSql 은 브랜드당 접두 패턴 1개를 바인드로 낸다", async () => {
    const { canonRollupSql } = await import("./scope-aggregates");
    const q = compile(canonRollupSql({}));
    expect(q.params.filter(isPrefixPattern)).toHaveLength(3);
  });
});

// ── 호출부 전수: 귀속을 판정하는 문은 예외 없이 접두 규칙을 싣는다 ────────────
// 기존 null-rollup-parity 의 전수 가드는 **접두 CASE 가 이미 있는 문만** 골라
// NULL 가드 수를 대조한다. 어떤 호출부가 pre-#113 의 raw 비교
// (`m.brand_rollup_entity_id IN (tracked)`)로 되돌아가면 그 문은 필터에서
// 빠질 뿐 아무것도 깨지지 않는다 — 그게 #113 이 만든 종류의 구멍이다.
// 여기서는 반대로 **귀속을 판정하는 문 전부**를 모수로 잡고 규칙을 요구한다.
describe("교차 표면 전수 — 귀속 판정 문에 접두 규칙이 빠진 곳이 없다", () => {
  const SURFACES: Array<[name: string, run: (m: typeof import("./scope-aggregates")) => Promise<unknown>]> = [
    ["대시보드(aggregateStandardFromMirror)", (m) => m.aggregateStandardFromMirror({}, "p1", [])],
    ["Sub KPI(aggregateSubKpisFromMirror)", (m) => m.aggregateSubKpisFromMirror({}, "p1", [])],
    ["언급탭(aggregateMentionsFromMirror)", (m) => m.aggregateMentionsFromMirror({}, "p1", "none")],
    ["GEO 경쟁(aggregateGeoCompetitionFromMirror)", (m) => m.aggregateGeoCompetitionFromMirror({}, "p1", [])],
  ];

  for (const [name, run] of SURFACES) {
    it(`${name} — 모든 귀속 판정 문이 접두 CASE 를 싣는다`, async () => {
      const statements = await collect(run);
      const attributing = statements.filter(decidesAttribution);
      // 공허 통과 방지: 모수가 비면 그것 자체가 실패다(스텁이 경로를 막았거나
      // 호출부가 사라졌다는 뜻 — 어느 쪽이든 이 가드는 무효가 된다).
      expect(attributing.length).toBeGreaterThan(0);
      const offenders = attributing
        .filter((s) => !s.params.some(isPrefixPattern))
        .map((s) => s.sql.replace(/\s+/g, " ").slice(0, 160));
      expect(offenders).toEqual([]);
    });
  }
});
