import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * 시장 태그 술어(H3)의 계약을 고정한다 — `scope_prompts.regions` 기반으로
 * "프롬프트가 태깅한 시장 밖에서 측정된 셀"을 제외한다.
 *
 * 종전 술어(언어 휴리스틱 = 한국어면 KR 전용)는 **대용물**이었다. 이 파일이
 * 지키는 것은 그 교체가 만든 세 가지 계약이다:
 *
 *  ① **컬럼 부재 내성.** 이 리포는 머지 = 무인 배포이고 migrate 단계가 없다
 *     (`build` = `next build`). `regions` 없는 DB 에 코드가 먼저 가면 42703 으로
 *     표준(글로벌) 계열 전 화면이 죽는다 — 0046/is_korean 때 세운 것과 같은 방어.
 *  ② **비상관 유지.** `a.*` 를 참조하는 상관 서브쿼리로 쓰면 플래너가 스캔 행마다
 *     재평가한다(2026-08-27 성능 수정으로 708→450ms 를 얻은 그 지점).
 *  ③ **구 술어를 지우지 않는다.** 신 술어는 `regions` 가 충전돼야만 제외를 낸다 —
 *     미충전 DB 에서 단독으로 두면 무제외로 퇴화해 2026-08-20 사고가 재발한다.
 */

const dialect = new PgDialect();
const compile = (w: SQL) => dialect.sqlToQuery(w).sql;

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

const isProbe = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.includes("pg_attribute");
/** 백그라운드 프로브가 상태를 갱신할 틈을 준다. */
const settle = () => new Promise((r) => setImmediate(r));

type Mod = typeof import("./scope-aggregates");

/**
 * 컬럼별 존재 여부를 지정해 모듈을 새로 적재한다. 프로브는 `attname = $n` 으로
 * 컬럼명을 바인딩하므로, 파라미터를 읽어 컬럼마다 다른 답을 준다 — 이게 있어야
 * "regions 만 없는 DB"(0046 은 붙고 0048 은 아직)를 재현할 수 있다.
 */
async function freshModule(present: Record<string, boolean>): Promise<Mod> {
  vi.resetModules();
  execute.mockReset();
  execute.mockImplementation(async (q: unknown) => {
    if (!isProbe(q)) return [];
    const params = dialect.sqlToQuery(q as SQL).params as unknown[];
    const col = params.find((p) => typeof p === "string") as string | undefined;
    return col && present[col] ? [{ ok: 1 }] : [];
  });
  return import("./scope-aggregates");
}

/** 스냅샷 경로(rootFullCycleAnswerIds)를 타는 호출 — 기존 korean-predicate
 *  테스트가 세운 진입점과 같다(snapshotRunFilter 는 export 되지 않는다). */
function rootSql(mod: Mod): string {
  return compile(mod.detailAnswerWhere({}, undefined));
}

beforeEach(() => {
  execute.mockReset();
});

describe("시장 태그 술어 — 컬럼 부재 내성", () => {
  it("판정 전 첫 호출은 술어를 내지 않는다 (블로킹 없음)", async () => {
    const mod = await freshModule({ regions: true, is_korean: true });
    expect(rootSql(mod)).not.toContain("unnest(sp.regions)");
  });

  it("프로브가 컬럼 존재를 확인한 뒤에는 술어를 낸다", async () => {
    const mod = await freshModule({ regions: true, is_korean: true });
    rootSql(mod); // 프로브 발사
    await settle();
    expect(rootSql(mod)).toContain("unnest(sp.regions)");
  });

  it("regions 가 없으면 술어를 내지 않는다 (42703 장애 방지)", async () => {
    const mod = await freshModule({ regions: false, is_korean: true });
    rootSql(mod);
    await settle();
    const text = rootSql(mod);
    expect(text).not.toContain("sp.regions");
    // 그래도 구 술어는 살아 있어야 한다 — 이게 ③의 안전망이다.
    expect(text).toContain("sp.is_korean");
  });

  it("is_korean 과 regions 는 서로 독립으로 판정된다", async () => {
    // 0048 만 붙고 0046 은 아직인 DB. 컬럼별 프로브가 한 전역을 공유하면
    // (일반화 전의 모양) 한쪽 판정이 다른 쪽을 덮어써 이 케이스가 깨진다.
    const mod = await freshModule({ regions: true, is_korean: false });
    rootSql(mod);
    await settle();
    const text = rootSql(mod);
    expect(text).toContain("unnest(sp.regions)");
    expect(text).toContain("[가-힣]"); // is_korean 없음 → 정규식 폴백
    expect(text).not.toContain("sp.is_korean");
  });

  it("프로브가 실패해도 술어 없이 견딘다", async () => {
    vi.resetModules();
    execute.mockReset();
    execute.mockImplementation(async () => {
      throw new Error("boom");
    });
    const mod = (await import("./scope-aggregates")) as Mod;
    rootSql(mod);
    await settle();
    expect(() => rootSql(mod)).not.toThrow();
    expect(rootSql(mod)).not.toContain("sp.regions");
  });
});

describe("시장 태그 술어 — 형태 계약", () => {
  async function ready(): Promise<string> {
    const mod = await freshModule({ regions: true, is_korean: true });
    rootSql(mod);
    await settle();
    return rootSql(mod);
  }

  it("비상관이다 — 서브쿼리가 a.* 를 참조하지 않는다", async () => {
    const text = await ready();
    // `unnest(sp.regions) AS r` 서브쿼리 안에 `a.` 가 있으면 상관이 된다.
    const sub = text.slice(text.indexOf("unnest(sp.regions)"));
    const body = sub.slice(0, sub.indexOf(")\n") + 1);
    expect(body).not.toContain("a.");
    // 상관형의 대표 모양도 명시적으로 금지한다.
    expect(text).not.toContain("a.region = ANY(sp.regions)");
    expect(text).not.toContain("ANY(sp.regions)");
  });

  it("NOT IN 의 NULL 전파를 닫는다", async () => {
    const text = await ready();
    expect(text).toContain("sp.prompt_id IS NOT NULL");
  });

  it("태그 없음(NULL·빈 배열)은 제외 대상이 아니다 — 상속", async () => {
    const text = await ready();
    expect(text).toContain("sp.regions IS NOT NULL");
    expect(text).toContain("cardinality(sp.regions) > 0");
    // prompt_id 가 NULL 인 답변도 통과해야 한다(제외 대상 아님).
    expect(text).toContain("a.prompt_id IS NULL");
  });

  it("expected 와 window 양쪽에 대칭으로 걸린다 (공유 CTE 로 구조 보장)", async () => {
    const text = await ready();
    // 지키는 것: 한쪽에만 걸리면 full-cycle 게이트가 expected > window 로 전
    // 프롬프트를 떨어뜨린다(2026-08-20 사고의 정확한 기전).
    //
    // 2026-09-01 단일 스캔 리팩터 전에는 술어를 두 벌 적어야 했고(cell_counts +
    // 창 선별), 그래서 이 테스트가 "정확히 2번 나온다"로 대칭을 지켰다. 지금은
    // 술어가 공유 CTE `_fc_base` 에 **한 번만** 있고 게이트(`_fc_gate`)와 창
    // 선별이 둘 다 그 CTE 를 읽으므로, 비대칭이 애초에 표현 불가능하다.
    // 계약을 "횟수"가 아니라 "어디에 있고 누가 읽는가"로 옮긴다 — 후자가 원래
    // 지키려던 성질이고, 술어를 한 벌만 적는 형태에서도 회귀를 잡는다.
    const hits = text.split("unnest(sp.regions)").length - 1;
    expect(hits).toBe(1);

    // ① 술어는 공유 CTE 정의 안에 있다 — 게이트/창 선별보다 앞선다.
    const baseAt = text.indexOf("_fc_base AS (");
    const gateAt = text.indexOf("_fc_gate AS (");
    const predAt = text.indexOf("unnest(sp.regions)");
    expect(baseAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(baseAt);
    expect(predAt).toBeGreaterThan(baseAt);
    expect(predAt).toBeLessThan(gateAt);

    // ② 게이트도 창 선별도 원본 테이블이 아니라 그 CTE 를 읽는다. 어느 한쪽이
    //    `scope_answers` 로 되돌아가면 술어를 다시 놓칠 수 있으므로 금지한다.
    // ③ 창 안에 한 건도 안 돈 셀을 기대치에서 빼는 active-cells 보정(#188)도
    //    같은 CTE 에서 파생한다 — 원안의 `scope_answers` 재스캔을 쓰지 않으므로
    //    술어가 한 벌로 유지된다.
    expect(text).toContain("_fc_active AS (");
    expect(text).toContain("SELECT DISTINCT target, region FROM _fc_cells WHERE w");

    const afterBase = text.slice(gateAt);
    expect(afterBase).not.toContain("scope_answers");
    expect(afterBase).toContain("FROM _fc_base");
    // 게이트 판정식 자체(expected 대비 window)도 고정한다.
    expect(text).toContain("HAVING count(*) FILTER (WHERE w) >= count(*)");
  });

  it("구 술어(언어 휴리스틱)를 지우지 않았다", async () => {
    const text = await ready();
    // regions 미충전 DB 의 안전망. 지우려면 미러 충전이 상시 보장돼야 한다 —
    // scope-aggregates.ts::regionTagExclusion 주석의 '제거 조건' 참조.
    expect(text).toContain("sp.is_korean");
    expect(text).toContain("a.region <> 'KR'");
  });
});

// ── B1 회귀: 앵커 축이 이 술어들을 떼어 가지 않는다 ─────────────────────────
//
// 축 on 의 루트 분기는 `rootFullCycleAnswerIds`(= 이 파일이 지켜 온 술어들의 집)를
// 우회한다. 축이 대체하는 것은 **full-cycle 게이트** 하나뿐이고, 지역 스코핑 술어
// 둘은 회차를 어떻게 세든 그대로 걸려야 한다. 한 번 빠진 적이 있다(검증 B1).
describe("시장 태그 술어 — 앵커 축에서도 유지된다", () => {
  async function anchorRootSql(): Promise<string> {
    const mod = await freshModule({ regions: true, is_korean: true });
    // 컬럼 프로브를 먼저 확정시킨다(축 off 상태에서 한 번 발사).
    rootSql(mod);
    await settle();
    const state = await import("@/lib/period/anchor-axis-state");
    state.setAnchorAxisForTests(true);
    try {
      return compile(mod.answerWhere({}, undefined));
    } finally {
      state.resetAnchorAxisForTests();
    }
  }

  it("축 on 루트에 시장 태그 술어가 있다", async () => {
    const text = await anchorRootSql();
    expect(text).toContain("scope_answer_cycle_anchors"); // 축이 실제로 켜졌는지 확인
    expect(text).toContain("unnest(sp.regions)");
    expect(text).toContain("cardinality(sp.regions) > 0");
  });

  it("축 on 루트에 구 술어(한국어 휴리스틱)도 남아 있다", async () => {
    const text = await anchorRootSql();
    expect(text).toContain("sp.is_korean");
    expect(text).toContain("a.region <> 'KR'");
  });

  it("축 on 루트에서도 비상관이다 — 서브쿼리가 a.* 를 참조하지 않는다", async () => {
    const text = await anchorRootSql();
    const sub = text.slice(text.indexOf("unnest(sp.regions)"));
    const body = sub.slice(0, sub.indexOf(")\n") + 1);
    expect(body).not.toContain("a.");
  });
});
