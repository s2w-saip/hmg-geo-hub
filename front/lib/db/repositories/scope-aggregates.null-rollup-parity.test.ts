import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

// 2026-08-29 회귀 가드 (PR #113 사후 검증 결함 ①: NULL 롤업 비대칭).
//
// #113 이 canonRollupSql 의 **표기 접두 CASE 를 id CASE 앞**으로 옮기면서
// `brand_rollup_entity_id IS NULL` 인 행도 표기만으로 당사(tracked)가 됐다.
// 브랜드 롤업 표들은 `WHERE m.brand_rollup_entity_id IS NOT NULL` 을 유지했고
// ③ 우호도만 그 가드가 없어, 어느 브랜드 표에도 안 나오는 언급이 **우호도
// 분모에만** 들어갔다(프로덕션 실측: 527행·956 언급·956 감정신호).
//
// 수리 방향 = canonRollupSql 을 **NULL 보존 함수**로 만든다:
//     canonRollupSql(x) IS NULL  ⟺  x.brand_rollup_entity_id IS NULL
// 그러면 `IN (…)` 이 NULL(거짓)로 떨어져 14개 호출부가 자동으로 같은 답을 낸다.
//
// ── 왜 소스 grep 이 아니라 컴파일된 SQL 을 보는가 ────────────────────────────
// 기존 tracked-parity.test 는 **소스 텍스트**를 본다. 줄바꿈·별칭 변수·포맷만
// 바뀌어도 뚫리고, "행동"은 보지 않는다(검증자 지적). 이 파일은 drizzle 이
// 실제로 만들어 DB 로 보내는 **SQL 문자열과 바인드 파라미터**를 본다 — 포맷·
// 변수명 변경에 면역이고, 술어가 실제로 어떤 조건을 담는지를 단언한다.
const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q);

// 접두 CASE 는 브랜드마다 정규식 패턴 하나를 **바인드 파라미터**로 넣는다.
// 이 파라미터 개수 = 그 문에 전개된 canonRollupSql 인스턴스 수 × 3(3사).
const isPrefixPattern = (p: unknown) =>
  typeof p === "string" && /^\^\[[^\]]*\]\*\((Genesis|Hyundai|Kia)[|)]/.test(p);
// NULL 보존 가드가 남기는 컴파일 흔적(별칭은 sql.raw 라 따옴표가 붙지 않는다).
const NULL_GUARD = /CASE WHEN [a-z_]+\.brand_rollup_entity_id IS NULL THEN/gi;

/** 한 문(statement) 안에서 접두 CASE 개수와 NULL 가드 개수가 같은가. */
function guardsMatchPrefixCases(q: { sql: string; params: unknown[] }): {
  prefixCases: number;
  guards: number;
} {
  const prefixCases = q.params.filter(isPrefixPattern).length / 3;
  const guards = (q.sql.match(NULL_GUARD) ?? []).length;
  return { prefixCases, guards };
}

type Mod = typeof import("./scope-aggregates");
async function load(): Promise<Mod> {
  return import("./scope-aggregates");
}

describe("canonRollupSql — NULL 롤업 보존 (당사 판정 비대칭 방지)", () => {
  it("접두 CASE 앞에 rollup IS NULL 단락(short-circuit)이 있다", async () => {
    const { canonRollupSql } = await load();
    const q = compile(canonRollupSql({}));
    const guardAt = q.sql.search(NULL_GUARD);
    const firstPrefixAt = q.sql.indexOf("~*");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(firstPrefixAt).toBeGreaterThanOrEqual(0);
    // 단락이 접두 판정보다 **먼저** 와야 NULL 이 표기로 되살아나지 않는다.
    expect(guardAt).toBeLessThan(firstPrefixAt);
  });

  it("별칭을 바꿔도 그 별칭의 컬럼으로 가드가 붙는다 (ACR 경로 x.*)", async () => {
    const { canonRollupSql } = await load();
    const q = compile(canonRollupSql({}, "x"));
    expect(q.sql).toContain("CASE WHEN x.brand_rollup_entity_id IS NULL THEN");
    expect(guardsMatchPrefixCases(q)).toEqual({ prefixCases: 1, guards: 1 });
  });

  it("tracked 술어는 canonRollupSql 을 통과하므로 가드를 물려받는다", async () => {
    const { trackedRollupPredicate, canonRollupSql } = await load();
    const pred = compile(trackedRollupPredicate({}));
    // 술어 안에 canon 식이 통째로 들어 있어야 한다(raw 비교로 되돌아가면 깨짐).
    expect(pred.sql).toContain(compile(canonRollupSql({})).sql);
    expect(guardsMatchPrefixCases(pred)).toEqual({ prefixCases: 1, guards: 1 });
  });

  it("비경쟁 제외 술어는 JS 쌍둥이와 같은 문자 집합으로 트림한다", async () => {
    const { excludeNonCompetitorBrandsSql } = await load();
    const { JS_TRIM_CHARS } = await import("@/lib/scope/text-trim");
    const q = compile(
      excludeNonCompetitorBrandsSql(sql`m.brand`, sql`m.brand`),
    );
    expect(q.sql).toContain("btrim(");
    expect(q.params.filter((p) => p === JS_TRIM_CHARS).length).toBeGreaterThanOrEqual(2);
  });
});

// ── 호출부 전수: 집계가 실제로 발행하는 모든 문에 가드가 붙는가 ───────────────
// 단일 함수 단언만으로는 "새 집계가 raw 비교를 다시 쓰는" 재발을 못 잡는다.
// 여기서는 db 를 스텁으로 바꿔 aggregateStandardFromMirror 가 **발행한 SQL 전부**
// 를 수집하고, 접두 CASE 가 나타나는 모든 문에서 NULL 가드 수가 같은지 본다.
describe("집계 발행 SQL 전수 — 접두 CASE 마다 NULL 가드", () => {
  it("aggregateStandardFromMirror 가 내는 문 전부가 균형을 지킨다", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn(async (q: unknown) => {
      const compiled = compile(q as SQL);
      statements.push(compiled);
      // 첫 answer-level 질의만 결과를 준다 — totalAnswers===0 이면 조기 반환한다.
      if (/GROUP BY region/i.test(compiled.sql)) {
        return [{ region: "KR", answers: 1, tracked: 1 }];
      }
      return [];
    });
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        execute,
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ execute }),
      }),
    }));
    const mod = await import("./scope-aggregates");
    await mod.aggregateStandardFromMirror({}, "p1", []);
    vi.doUnmock("@/lib/db");

    const withPrefix = statements.filter((s) => s.params.some(isPrefixPattern));
    expect(withPrefix.length).toBeGreaterThanOrEqual(4);
    const offenders = withPrefix
      .map((s) => ({ ...guardsMatchPrefixCases(s), sql: s.sql.slice(0, 120) }))
      .filter((r) => r.prefixCases !== r.guards);
    expect(offenders).toEqual([]);
  });
});
