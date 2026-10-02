/**
 * 뷰 앵커 **V-1** — 스왑이 `view_anchor_at` 을 어떻게 찍는가 (PR② T14).
 *
 * 고정하는 것 셋:
 *   ① `GREATEST(cycle_anchor_at + <표면 지연>, now())` — 지연은 **표면 상수**다
 *      (글로벌 2일 · 웹사이트 1일, 제품 확정 2026-09-10).
 *   ② `COALESCE(view_anchor_at, …)` — 첫 스왑에서만 정한다(재생성 불변).
 *   ③ 이 문장이 `view_anchor_at` 을 쓰는 **유일한 곳**이다.
 *
 * 왜 형태 테스트인가: 값은 DB 가 계산한다(`now()`·`cycle_anchor_at` 둘 다 서버 쪽).
 * JS 에서 시각을 만들어 넣으면 러너 시계와 DB 시계가 갈라지므로, 검증할 수 있는 것은
 * **어떤 식이 발행되는가** 뿐이다. 값 쪽 판정은 실 DB int 테스트가 맡는다
 * (`lib/db/repositories/summary-cycles.view-anchor.int.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { publishCycleSql, swapGeneration, VIEW_ANCHOR_DELAY } from "./swap";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const CYCLE = "11111111-1111-4111-8111-111111111111";
const GEN = "22222222-2222-4222-8222-222222222222";
const text = (q: SQL) => dialect.sqlToQuery(q).sql.replace(/\s+/g, " ").trim();

describe("V-1 · publishCycleSql — 표면별 노출 지연", () => {
  it("지연 상수는 글로벌 2일 · 웹사이트 1일", () => {
    expect(VIEW_ANCHOR_DELAY).toEqual({ global: "2 days", website: "1 day" });
  });

  it("글로벌은 interval '2 days' 를 GREATEST 로 건다", () => {
    const t = text(publishCycleSql(CYCLE, GEN, "global"));
    expect(t).toContain(
      "view_anchor_at = COALESCE(view_anchor_at, GREATEST(cycle_anchor_at + interval '2 days', now()))",
    );
    expect(t).not.toContain("interval '1 day'");
  });

  it("웹사이트는 interval '1 day' 를 GREATEST 로 건다", () => {
    const t = text(publishCycleSql(CYCLE, GEN, "website"));
    expect(t).toContain(
      "view_anchor_at = COALESCE(view_anchor_at, GREATEST(cycle_anchor_at + interval '1 day', now()))",
    );
    expect(t).not.toContain("interval '2 days'");
  });

  it("재생성 불변 — COALESCE 가 살아 있고 무조건 대입 형태가 아니다", () => {
    for (const surface of ["global", "website"] as const) {
      const t = text(publishCycleSql(CYCLE, GEN, surface));
      expect(t).toContain("view_anchor_at = COALESCE(view_anchor_at,");
      // `= now()` 나 `= GREATEST(` 로 바로 대입하면 재생성이 노출일을 민다.
      expect(t).not.toContain("view_anchor_at = now()");
      expect(t).not.toContain("view_anchor_at = GREATEST(");
    }
  });

  it("나머지 SET 절은 종전 그대로 (status·stale_since·active_generation_id)", () => {
    const t = text(publishCycleSql(CYCLE, GEN, "global"));
    expect(t).toContain("UPDATE summary_cycles SET active_generation_id = $1::uuid");
    expect(t).toContain("status = 'published'");
    expect(t).toContain("stale_since = NULL");
    expect(t).toContain("WHERE cycle_id = $2::uuid");
  });
});

describe("V-1 · swapGeneration 이 표면을 그대로 흘린다", () => {
  /** 접기 없이 스왑만 돌려 발행 문장을 받는다. */
  async function publishStatement(surface: "global" | "website"): Promise<string> {
    const log: string[] = [];
    const run = async (q: SQL) => {
      const t = dialect.sqlToQuery(q).sql;
      log.push(t);
      if (t.includes("AS drift")) return [{ drift: 0 }];
      return [];
    };
    const rt = {
      db: { execute: run, transaction: async <T>(fn: (tx: { execute: typeof run }) => Promise<T>) => fn({ execute: run }) },
      time: async <T>(_k: string, fn: () => Promise<T>) => fn(),
    };
    expect(await swapGeneration(rt, CYCLE, GEN, surface)).toBe(true);
    const publish = log.find((t) => t.includes("SET active_generation_id"));
    expect(publish, "publish 문장").toBeTruthy();
    return (publish as string).replace(/\s+/g, " ");
  }

  it("global 스왑 → 2 days", async () => {
    expect(await publishStatement("global")).toContain("interval '2 days'");
  });

  it("website 스왑 → 1 day", async () => {
    expect(await publishStatement("website")).toContain("interval '1 day'");
  });
});
