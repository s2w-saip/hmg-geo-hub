// 프롬프트 분리 패널(promptSplit) — 실 DB(read-only) 불변식 검증.
// DATABASE_URL이 있을 때만 실행 (CI 무DB skip). 로컬:
//   DATABASE_URL=... npx vitest run lib/db/repositories/scope-aggregates.citation-split.int.test.ts
//
// 왜 필요한가 — 이 쿼리에는 실행 테스트가 없었다. 2026-09-08 실측: SQL 을 도메인
// 단위 접기(`downed` CTE)로 되돌려도 유닛 테스트 1,730개가 전부 통과했다. 픽스처
// 테스트는 SQL 을 실행하지 않으므로 이 형태의 회귀는 실 DB 로만 잡힌다.
//
// 불변식: `promptSplit.ownedCount` = **인용 행 단위** owned 판정을 프롬프트로 올린 수.
// 도메인 단위로 접으면(genesis.com 한 도메인이 자사면 그 도메인을 인용한 프롬프트
// 전부 자사) 공유 호스트 유닛에서 값이 커진다.
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  aggregateCitationsFromMirror,
  websiteDeclaredOwnedBases,
  detailAnswerWhere,
  citationOwnedClause,
  citationOwnedBaseSql,
} from "./scope-aggregates";
import { citationGroupKeySql } from "./citation-group-key";
import { setColumnAvailabilityForTests } from "@/lib/db/column-availability";

const hasDb = !!process.env.DATABASE_URL;

// 정규화 소스를 인라인 식으로 고정한다. 마이그레이션 0052 의 컬럼/함수 경로와 값이
// **정의상 같고**(citationBaseNormSql ≡ citation_url_base_norm — citation-norm-columns
// 테스트가 강제), 이 테스트가 보는 것은 정규화가 아니라 owned 판정을 프롬프트로
// 올리는 방식이다. 고정하지 않으면 읽기 롤에 `citation_url_base_norm` EXECUTE 권한이
// 없는 환경에서 판정과 무관한 이유로 죽는다.
setColumnAvailabilityForTests("scope_citations", "url_norm", false);
setColumnAvailabilityForTests("scope_citations", "url_base_norm", false);
const WEBSITE_TARGETS_OWNED = true;

describe.skipIf(!hasDb)("promptSplit — 행 단위 자사 판정 (live mirror)", { timeout: 300_000 }, () => {
  it("공유 호스트(경로로 국가를 가르는) 유닛에서 SQL 분할 = 독립 재계산", async () => {
    const db = getDb();
    // 경로가 있는 base = 한 호스트를 국가/언어 경로로 가르는 사이트 (genesis.com/us/en 등).
    // 도메인 단위 접기와 행 단위 판정이 갈리는 형태가 여기에 몰려 있다.
    const picks = (await db.execute(sql`
      SELECT DISTINCT ws.scope_project_id AS pid
      FROM website_sites ws JOIN website_prompts wp ON wp.site_id = ws.id
      WHERE wp.owned_base_url LIKE '%/%'
      ORDER BY 1 LIMIT 5
    `)) as unknown as Array<{ pid: string }>;
    if (picks.length === 0) return; // 미러 비어 있음

    for (const { pid } of picks) {
      const own = await websiteDeclaredOwnedBases({}, [pid]);
      if (!own.prefixes.length) continue;

      const live = await aggregateCitationsFromMirror(
        {}, [pid], own.prefixes, own.universe, WEBSITE_TARGETS_OWNED,
      );
      if (!live?.promptSplit) continue; // 자사 인용 0 → 섹션 숨김

      // 독립 재계산 — 프로덕션 쿼리와 같은 술어를 쓰되 구조는 따로 짠다.
      const W = detailAnswerWhere({}, [pid]);
      const ownedBase = citationOwnedBaseSql(own.prefixes);
      const owned = citationOwnedClause(own.prefixes, own.universe, {
        projectCtx: [pid], filters: {}, enabled: WEBSITE_TARGETS_OWNED,
      });
      const groupKey = citationGroupKeySql(sql`c.domain`, sql`c.url`);
      const rows = (await db.execute(sql`
        WITH c2 AS MATERIALIZED (
          SELECT a.prompt_id, ${groupKey} AS domain, ${ownedBase} AS base
          FROM scope_citations c JOIN scope_answers a ON a.job_id = c.job_id
          WHERE ${W} AND c.domain IS NOT NULL AND a.prompt_id IS NOT NULL
        ), pr AS (
          SELECT prompt_id, COALESCE(bool_or(${owned}), false) AS owned FROM c2 GROUP BY prompt_id
        )
        SELECT count(*) FILTER (WHERE owned)::int AS owned_count,
               count(*) FILTER (WHERE NOT owned)::int AS uncited_count
        FROM pr
      `)) as unknown as Array<{ owned_count: number; uncited_count: number }>;
      const expected = rows[0];

      // eslint-disable-next-line no-console
      console.log(`[${pid}] ${own.prefixes.join(",")} — SQL ${live.promptSplit.ownedCount}/${live.promptSplit.uncitedCount} · 재계산 ${expected.owned_count}/${expected.uncited_count}`);
      expect(live.promptSplit.ownedCount).toBe(expected.owned_count);
      expect(live.promptSplit.uncitedCount).toBe(expected.uncited_count);
    }
  });

  it("도메인 표의 promptList 는 프롬프트별 owned 인용수를 싣는다 (도메인 상속 아님)", async () => {
    const db = getDb();
    const picks = (await db.execute(sql`
      SELECT DISTINCT ws.scope_project_id AS pid
      FROM website_sites ws JOIN website_prompts wp ON wp.site_id = ws.id
      WHERE wp.owned_base_url LIKE '%/%'
      ORDER BY 1 LIMIT 3
    `)) as unknown as Array<{ pid: string }>;
    for (const { pid } of picks) {
      const own = await websiteDeclaredOwnedBases({}, [pid]);
      if (!own.prefixes.length) continue;
      const live = await aggregateCitationsFromMirror(
        {}, [pid], own.prefixes, own.universe, WEBSITE_TARGETS_OWNED,
      );
      for (const d of live?.domains ?? []) {
        for (const p of d.promptList) {
          expect(p.ownedCitations).toBeTypeOf("number");
          // owned 인용수는 그 도메인에서 온 이 프롬프트의 전체 인용수를 넘을 수 없다.
          expect(p.ownedCitations!).toBeLessThanOrEqual(p.citations);
          // 도메인이 자사가 아니면 행 단위 owned 도 0 이어야 한다(역은 성립 안 함).
          if (!d.isOurs) expect(p.ownedCitations).toBe(0);
        }
      }
    }
  });
});
