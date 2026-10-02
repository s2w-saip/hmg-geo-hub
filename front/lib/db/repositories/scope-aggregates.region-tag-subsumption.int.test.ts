/**
 * 시장 태그 술어(H3)가 종전 언어 휴리스틱을 **포섭**하는지 실 DB 로 확인한다.
 * DATABASE_URL 이 있을 때만 실행 (무DB skip). 로컬:
 *   DATABASE_URL=... npx vitest run lib/db/repositories/scope-aggregates.region-tag-subsumption.int.test.ts
 *
 * 왜 실 DB 인가 — 이건 SQL 의 *모양*이 아니라 **데이터의 성질**에 대한 주장이다:
 * "한국어 프롬프트는 전부 KR 을 시장으로 태깅하고 있다". 그 성질이 참인 동안에만
 * 두 술어를 AND 로 겹쳐 두는 것이 무해하다(결과 = 신 술어 단독). 성질이 깨지면
 * 겹침이 조용히 데이터를 더 깎기 시작하고, 그건 SQL 을 아무리 읽어도 안 보인다.
 *
 * 2026-08-30 프로덕션 미러 실측 (루트 completed 답변 104,163건):
 *   구만 제외 now_only     = 0        ← 이 테스트가 지키는 값
 *   양쪽 다 제외 both      = 28,371
 *   신만 제외 next_only    = 1,216    ← 태그 밖에서 측정된 셀 (교체의 이득)
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { STANDARD_ROOT_PROJECT_ID } from "@/lib/db/repositories/standards";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("시장 태그 술어 — 언어 휴리스틱 포섭 (실 DB)", { timeout: 120_000 }, () => {
  it("구 술어가 제외하는 답변은 신 술어도 전부 제외한다 (now_only = 0)", async () => {
    const rows = (await getDb().execute(sql`
      WITH ans AS (
        SELECT a.job_id, a.prompt_id, a.region
        FROM scope_answers a
        JOIN scope_runs r ON r.run_id = a.run_id
        WHERE r.status IN ('completed', 'partial_failed')
          AND a.status = 'completed'
          AND r.project_id = (
            SELECT scope_project_id FROM projects WHERE id = ${STANDARD_ROOT_PROJECT_ID}
          )
      ),
      tagged AS (
        SELECT sp.prompt_id FROM scope_prompts sp
        WHERE sp.prompt_id IS NOT NULL
          AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
      ),
      pair AS (
        SELECT sp.prompt_id, r AS region FROM scope_prompts sp, unnest(sp.regions) AS r
        WHERE sp.prompt_id IS NOT NULL
          AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
      ),
      flags AS (
        SELECT
          (a.region <> 'KR' AND a.prompt_id IS NOT NULL
             AND a.prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE is_korean)) AS old_excl,
          (a.prompt_id IS NOT NULL
             AND a.prompt_id IN (SELECT prompt_id FROM tagged)
             AND (a.prompt_id, a.region) NOT IN (SELECT prompt_id, region FROM pair)) AS new_excl
        FROM ans a
      )
      SELECT
        count(*) FILTER (WHERE old_excl AND NOT new_excl) AS now_only,
        count(*) FILTER (WHERE old_excl AND new_excl)     AS both,
        count(*) FILTER (WHERE NOT old_excl AND new_excl) AS next_only,
        count(*) AS total
      FROM flags
    `)) as unknown as Array<Record<string, unknown>>;

    const r = rows[0];
    expect(r, "루트 프로젝트의 답변이 하나도 없다 — 미러가 비었거나 루트 id 가 틀렸다").toBeDefined();
    const n = (k: string) => Number(r[k]);

    // 모수가 0 이면 이 테스트는 아무것도 증명하지 못한다. 조용한 통과를 막는다.
    expect(n("total")).toBeGreaterThan(0);

    // ★ 본 단언. 이 값이 0 이 아니게 되면 두 술어를 겹쳐 두는 것이 더 이상
    //   무해하지 않다 — 구 술어만 제외하는 답변이 생겼다는 뜻이고, 그건
    //   "한국어 프롬프트가 KR 밖 시장을 태깅했다"는 데이터 변화다.
    //   그때 할 일은 이 테스트를 고치는 게 아니라 어느 쪽이 옳은지 정하는 것이다.
    expect(n("now_only")).toBe(0);
  });
});
