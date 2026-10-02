import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

/**
 * 글로벌 사실표 생성기의 제외 술어가 `scope-aggregates` 표준 경로와 **같은 규칙**인지
 * 고정한다. 생성기는 SA 의 비공개 함수(`rootFullCycleAnswerIds`)를 import 할 수 없어
 * 술어를 한 벌 옮겨 적었다 — 그 옮겨 적기가 드리프트하면 여기가 먼저 깨져야 한다.
 *
 * ⚠️ 두 번째 계약: 술어는 **프로브가 끝난 뒤** 만들어져야 한다. 모듈 상수로 굳히면
 * `regionTagPred` 가 `true` 로 접혀 지역태그 제외가 통째로 빠진다(2026-09-06 실측:
 * in_full_cycle 통과 프롬프트 11,410 → 11,320).
 */
const dialect = new PgDialect();
const compile = (w: SQL) => dialect.sqlToQuery(w).sql;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

const isProbe = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.includes("pg_attribute");
const settle = () => new Promise((r) => setImmediate(r));

async function freshModules(columnPresent: boolean) {
  vi.resetModules();
  execute.mockReset();
  execute.mockImplementation(async (q: unknown) =>
    isProbe(q) ? (columnPresent ? [{ ok: 1 }] : []) : [],
  );
  process.env.SCOPE_ROOT_PROJECT_ID ??= "be28fe15-c743-4a88-abb8-182b25602812";
  const preds = await import("./global-predicates");
  const sa = await import("@/lib/db/repositories/scope-aggregates");
  return { preds, sa };
}

/** SA 표준(루트) 경로의 컴파일 SQL — full-cycle 게이트 전문이 여기 들어 있다. */
function standardWhereText(sa: typeof import("@/lib/db/repositories/scope-aggregates")) {
  return norm(compile(sa.answerWhere({}, undefined)));
}

beforeEach(() => {
  execute.mockReset();
});

describe("글로벌 생성기 제외 술어 — SA 표준 경로와 동치", () => {
  it("한국어 비-KR 제외가 SA 와 문자적으로 같다", async () => {
    const { preds, sa } = await freshModules(true);
    compile(sa.answerWhere({}, undefined)); // 프로브 발사
    preds.koreanNonKrPred(sql`a.prompt_id`, sql`a.region`, sql`a.measured_at`);
    await settle();
    const mine = norm(compile(preds.koreanNonKrPred(sql`a.prompt_id`, sql`a.region`, sql`a.measured_at`)));
    expect(mine).toContain("sp.is_korean");
    // 2026-09-28 태그 우선 — 태그 없음 ∨ 태깅 이전 일 때만 제외한다(양쪽 같은 절).
    expect(mine).toContain("a.measured_at < '2026-08-19T00:00:00Z'::timestamptz");
    expect(mine).toContain("a.prompt_id NOT IN ( SELECT sp.prompt_id FROM scope_prompts sp");
    expect(standardWhereText(sa)).toContain(mine);
  });

  it("지역태그 제외가 SA 와 문자적으로 같다", async () => {
    const { preds, sa } = await freshModules(true);
    compile(sa.answerWhere({}, undefined));
    preds.regionTagPred(sql`a.prompt_id`, sql`a.region`);
    await settle();
    const mine = norm(compile(preds.regionTagPred(sql`a.prompt_id`, sql`a.region`)));
    expect(mine).toContain("cardinality(sp.regions) > 0");
    expect(standardWhereText(sa)).toContain(mine);
  });

  it("숨김 국가 조각이 SA 와 같은 목록을 낸다", async () => {
    const { preds, sa } = await freshModules(true);
    const mine = norm(compile(preds.hiddenRegionsClause(sql`a.region`)));
    // SA 는 같은 목록을 `a.region NOT IN (…)` 로 낸다(rootFullCycleAnswerIds·answerWhere).
    expect(standardWhereText(sa)).toContain(mine.replace(/^AND /, ""));
  });

  // #231(2026-09-09 main) 이 SA 의 full-cycle 게이트를 단일 스캔 CTE(`_fc_base` →
  // `_fc_cells` → `_fc_active` → `_fc_gate`, HAVING count(*) FILTER (WHERE w) >= count(*))
  // 로 재작성했다. 생성기는 같은 게이트를 "회차 창" 으로 재표현한 형태
  // (fc_active + window_cells >= expected_cells)를 유지하므로 **문자적 동치는 더
  // 이상 성립하지 않는다** — 여기서는 두 쪽이 같은 두 조각(모집단 술어 · active 셀
  // 한정 · "창 안 셀이 기대 셀 전부") 을 갖는지만 단언하고, 의미 동치는
  // scripts/summary/verify-global-0831.ts 가 DB 에서 in_full_cycle 을 독립 재계산해 대조한다.
  it("full-cycle 게이트가 SA 와 같은 조각(모집단 술어 · active 셀 한정 · 창 안 셀 ≥ 기대 셀)으로 구성된다", async () => {
    const { preds, sa } = await freshModules(true);
    compile(sa.answerWhere({}, undefined));
    preds.fullCycleCte("be28fe15-c743-4a88-abb8-182b25602812");
    await settle();
    const cte = norm(compile(preds.fullCycleCte("be28fe15-c743-4a88-abb8-182b25602812"))).toLowerCase();
    const standard = standardWhereText(sa).toLowerCase();
    // 공통 모집단 술어
    for (const fragment of ["r.status in ('completed', 'partial_failed')", "a.status = 'completed'"]) {
      expect(cte).toContain(fragment);
      expect(standard).toContain(fragment);
    }
    // SA(#231 단일 스캔): active 셀 = 창 안에 측정이 있는 (target, region), 게이트 = 그 셀 전부가 창 안
    expect(standard).toContain("_fc_active");
    expect(standard).toContain("having count(*) filter (where w) >= count(*)");
    // 생성기: 같은 두 조각의 회차 창 재표현 (2026-09-28 부터 셀 집계 1회 스캔에서 파생)
    expect(cte).toContain("fc_active");
    expect(cte).toContain("select distinct target, region from fc_cells where w");
    expect(cte).toContain("expected_cells");
    expect(cte).toContain("window_cells");
    // 창 끝 이후 첫 셀 제외 — 양쪽이 같은 규칙(창 안 셀 유지 · NULL 보존 · 창 끝 = max(w_last))
    expect(cte).toContain("min(a.measured_at) as first_at");
    expect(standard).toContain("min(measured_at) as first_at"); // SA 는 _fc_base 컬럼(무별칭)
    for (const text of [cte, standard]) {
      expect(text).toContain("first_at is null");
      expect(text).toContain("coalesce(max(w_last), 'infinity'::timestamptz)");
    }
  });
});

/**
 * presence_set(0063) 적재식이 미러의 brandPresence 규칙과 **문자적으로 같은가**.
 *
 * 이 축이 갈렸던 이유가 정확히 "옮겨 적기"였다 — 생성기가 카탈로그 원값 1행만 굳혀
 * `branded` 격자에서 답변 12,776(사실표) vs 20,712(미러)까지 벌어졌다(2026-09-06).
 * 그래서 생성기는 SA 의 `brandPresenceResolvedSqlFor` 를 **import** 해서 쓰고,
 * 여기서는 그것이 SA 의 조회 술어에 실제로 들어가는 식과 같은지를 컴파일 SQL 로 고정한다.
 */
describe("presence_set 적재식 — 미러 brandPresence 규칙과 동치", () => {
  it("SA 조회 술어에 들어가는 유도식과 문자적으로 같다", async () => {
    const { preds, sa } = await freshModules(true);
    // 바인드 번호는 문장 안 위치에 따라 달라진다 — 규칙 대조는 번호를 지우고 본다.
    const deparam = (t: string) => t.replace(/\$\d+/g, "$?");
    const saText = deparam(norm(compile(sa.answerWhere({ brandPresence: ["branded"] }, undefined))));
    // SA 는 무별칭 컬럼(prompts 서브쿼리 안)으로 쓴다.
    const rule = deparam(norm(compile(sa.brandPresenceResolvedSqlFor(sql`brand`, sql`brand_presence`))));
    expect(rule).toContain("COALESCE(brand_presence, CASE WHEN brand =");
    expect(saText).toContain(rule);
    // 생성기는 같은 규칙을 `prompts p` 별칭으로 쓴다 — 집합 집계로 감싸는 것 말고는 같다.
    const mine = deparam(norm(compile(preds.presenceSetExpr(sql`p.brand`, sql`p.brand_presence`))));
    const aliased = deparam(norm(compile(sa.brandPresenceResolvedSqlFor(sql`p.brand`, sql`p.brand_presence`))));
    expect(mine).toContain(`array_agg(DISTINCT ${aliased})`);
    expect(mine).toContain(`FILTER (WHERE ${aliased} IS NOT NULL)`);
    expect(mine).toContain("::text[]");
  });

  it("NULL 유도값은 집합에서 빠지고, 빈 집합은 '{}' 다 (NOT NULL 계약)", async () => {
    const { preds } = await freshModules(true);
    const mine = norm(compile(preds.presenceSetExpr(sql`p.brand`, sql`p.brand_presence`)));
    expect(mine.startsWith("COALESCE(array_agg(DISTINCT")).toBe(true);
    expect(mine).toContain("IS NOT NULL)");
    expect(mine).toContain("'{}'");
  });
});

describe("프로브 계약 — 술어는 상수가 아니라 함수여야 한다", () => {
  it("프로브 전에는 폴백, 프로브 후에는 컬럼 경로로 바뀐다", async () => {
    const { preds } = await freshModules(true);
    const before = compile(preds.regionTagPred(sql`a.prompt_id`, sql`a.region`));
    expect(before.trim()).toBe("true"); // 판정 전 = 제외 없음
    await settle();
    const after = compile(preds.regionTagPred(sql`a.prompt_id`, sql`a.region`));
    expect(after).toContain("sp.regions");
  });

  it("컬럼이 없으면 프로브 후에도 폴백을 유지한다(42703 방지)", async () => {
    const { preds } = await freshModules(false);
    compile(preds.koreanNonKrPred(sql`a.prompt_id`, sql`a.region`, sql`a.measured_at`));
    await settle();
    expect(compile(preds.koreanNonKrPred(sql`a.prompt_id`, sql`a.region`, sql`a.measured_at`))).toContain(
      "sp.text ~ '[가-힣]'",
    );
    expect(compile(preds.regionTagPred(sql`a.prompt_id`, sql`a.region`)).trim()).toBe("true");
  });

  it("in_tagged_region 은 두 술어의 AND 다", async () => {
    const { preds } = await freshModules(true);
    preds.inTaggedRegionExpr(sql`jb.prompt_id`, sql`jb.country`, sql`jb.measured_at`);
    await settle();
    const text = norm(compile(preds.inTaggedRegionExpr(sql`jb.prompt_id`, sql`jb.country`, sql`jb.measured_at`)));
    expect(text).toContain("sp.is_korean");
    expect(text).toContain("cardinality(sp.regions) > 0");
    expect(text.startsWith("(CASE WHEN")).toBe(true);
    expect(text).toContain("THEN 1 ELSE 0 END)");
  });
});
