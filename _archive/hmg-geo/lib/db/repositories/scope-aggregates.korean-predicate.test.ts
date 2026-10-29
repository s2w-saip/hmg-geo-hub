import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 한글 판별 술어의 계약을 고정한다.
//
//  ① 성능 이득의 본체 = 상관 EXISTS → **비상관 서브리스트**. 컬럼 유무와
//     무관하게 항상 이 형태여야 한다(프로덕션 실측 708→450ms).
//  ② scope_prompts.is_korean(migration 0046)은 **확인된 경우에만** 쓴다.
//     이 리포는 머지 = 무인 배포이고 migrate 단계가 없어(`build`=`next build`),
//     컬럼 없는 DB 에 코드가 먼저 가면 42703 으로 표준 계열 전 화면이 죽는다.
//  ③ 판정 자체는 여전히 **동기 읽기 + 백그라운드 프로브**다(SQL 빌더가 동기라
//     블로킹할 자리가 없다). 다만 2026-09-10 부터 **진입점이 먼저 확정한다** —
//     `await ensureColumnAvailability()`(scope-aggregates 의 export 된 async 함수
//     전부). 그래서 "첫 호출은 폴백"은 이제 **동기 빌더를 진입점 없이 직접 부른
//     경우**의 계약이고, 실제 화면·미러 쓰기 경로에는 나타나지 않는다. 그 확정
//     계약은 scope-aggregates.column-availability.test.ts 가 지킨다.

const dialect = new PgDialect();
const compile = (w: SQL) => dialect.sqlToQuery(w).sql;

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

const isProbe = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.includes("pg_attribute");
const probeCount = () => execute.mock.calls.filter((c) => isProbe(c[0])).length;
/** 백그라운드 프로브가 상태를 갱신할 틈을 준다. */
const settle = () => new Promise((r) => setImmediate(r));

type Mod = typeof import("./scope-aggregates");
async function freshModule(columnPresent: boolean): Promise<Mod> {
  vi.resetModules();
  execute.mockReset();
  execute.mockImplementation(async (q: unknown) =>
    isProbe(q) ? (columnPresent ? [{ ok: 1 }] : []) : [],
  );
  return import("./scope-aggregates");
}

beforeEach(() => {
  execute.mockReset();
});

describe("한글 판별 술어 — 비상관 전환 + 컬럼 부재 내성", () => {
  it("판정 전 첫 호출은 종전 인라인 정규식으로 낸다 (블로킹 없음)", async () => {
    const mod = await freshModule(true);
    const text = compile(mod.detailAnswerWhere({}, undefined));
    expect(text).toContain("sp.text ~ '[가-힣]'");
    expect(text).not.toContain("sp.is_korean");
  });

  it("프로브가 컬럼 존재를 확인한 뒤에는 저장 컬럼으로 낸다", async () => {
    const mod = await freshModule(true);
    compile(mod.detailAnswerWhere({}, undefined)); // 프로브 발사
    await settle();
    const text = compile(mod.detailAnswerWhere({}, undefined));
    expect(text).toContain("sp.is_korean");
    expect(text).not.toContain("[가-힣]");
  });

  it("컬럼이 없으면 프로브 후에도 정규식을 유지한다 (42703 장애 방지)", async () => {
    const mod = await freshModule(false);
    compile(mod.detailAnswerWhere({}, undefined));
    await settle();
    const text = compile(mod.detailAnswerWhere({}, undefined));
    expect(text).toContain("sp.text ~ '[가-힣]'");
    expect(text).not.toContain("sp.is_korean");
  });

  it("프로브가 실패해도 정규식으로 견딘다", async () => {
    vi.resetModules();
    execute.mockReset();
    execute.mockImplementation(async () => {
      throw new Error("boom");
    });
    const mod = await import("./scope-aggregates");
    compile(mod.detailAnswerWhere({}, undefined));
    await settle();
    const text = compile(mod.detailAnswerWhere({}, undefined));
    expect(text).toContain("sp.text ~ '[가-힣]'");
  });

  it("어느 분기에서도 비상관 서브리스트 + NULL 가드다 (성능 이득의 본체)", async () => {
    for (const present of [false, true]) {
      const mod = await freshModule(present);
      compile(mod.detailAnswerWhere({}, undefined));
      await settle();
      const text = compile(mod.detailAnswerWhere({}, undefined));
      expect(text).toMatch(/a\.prompt_id IN \(SELECT sp\.prompt_id FROM scope_prompts sp/);
      expect(text).toContain("a.prompt_id IS NOT NULL");
      // 상관 EXISTS 형태는 어느 분기에도 남지 않는다 — 남으면 회귀다.
      expect(text).not.toMatch(/EXISTS \(SELECT 1 FROM scope_prompts/);
    }
  });

  // 2026-08-30(H3): 프로브가 컬럼명으로 일반화되면서 `regions` 프로브가 하나 더
  // 생겼다. 지켜야 할 계약은 총 발사 횟수가 아니라 **컬럼당 1회**다 — 총계로
  // 고정해 두면 컬럼이 늘 때마다 테스트가 깨지면서 정작 중복 발사 회귀는 못 잡는다.
  it("프로브는 컬럼당 한 번만 발사한다 (연속 호출로 늘지 않는다)", async () => {
    const mod = await freshModule(true);
    compile(mod.detailAnswerWhere({}, undefined));
    compile(mod.detailAnswerWhere({}, "p1"));
    compile(mod.detailAnswerWhere({}, "p2"));
    await settle();
    const byColumn = new Map<string, number>();
    for (const call of execute.mock.calls) {
      if (!isProbe(call[0])) continue;
      const params = dialect.sqlToQuery(call[0] as SQL).params as unknown[];
      const col = String(params.find((p) => typeof p === "string") ?? "?");
      byColumn.set(col, (byColumn.get(col) ?? 0) + 1);
    }
    expect([...byColumn.values()].every((n) => n === 1)).toBe(true);
    expect(byColumn.get("is_korean")).toBe(1);
  });
});
