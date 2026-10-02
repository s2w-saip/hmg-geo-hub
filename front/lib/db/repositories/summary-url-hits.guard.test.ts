// 0081 미적용 DB 에서 리더가 **문장을 내지 않고 null** 을 돌려주는가(2026-09-27).
//
// 이 리포는 머지 ≠ 마이그레이션이다: 코드가 `db:apply -- 0081` 보다 먼저 배포되는 창이 있다.
// 그 창에서 리더가 `summary_url_hit_generations` 를 읽으면 42P01 로 카드 셀이 통째로 죽는다.
// null 이면 호출부(`websiteTargetHitRateLive`)가 종전 미러로 간다.
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const seen = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    // 컬럼 프로브(pg_attribute)는 0행 = 표 없음. 그 밖의 문장은 오면 안 된다.
    execute: async (q: SQL) => {
      const t = new PgDialect().sqlToQuery(q).sql;
      seen.list.push(t);
      if (t.includes("pg_attribute")) return [];
      throw new Error(`0081 미적용인데 문장이 나갔다: ${t.slice(0, 80)}`);
    },
  }),
}));

describe("summaryWebsitePromptHitRates: 0081 미적용", () => {
  it("표가 없으면 null · 프로브 외 문장 0", async () => {
    const { summaryWebsitePromptHitRates } = await import("./summary-website-aggregates");
    const scope = {
      cycles: [{
        cycleId: "11111111-1111-4111-8111-111111111111",
        generationId: "22222222-2222-4222-8222-222222222222",
        projectId: "33333333-3333-4333-8333-333333333333",
        cycleAnchorAt: "2026-09-25T00:00:00.000Z",
        cycleWeek: "2026-09-21",
      }],
      projectIds: ["33333333-3333-4333-8333-333333333333"],
      filters: {},
      ownedBasePrefixes: [],
      unitFlags: true,
    };
    expect(await summaryWebsitePromptHitRates(scope as never)).toBeNull();
    expect(seen.list.length).toBeGreaterThan(0);
    expect(seen.list.every((t) => t.includes("pg_attribute"))).toBe(true);
  });
});
