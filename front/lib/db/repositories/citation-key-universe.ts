import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { OFFICIAL_SOCIAL_ACCOUNTS } from "@/lib/citation-categorizer/official-social";
import { budgetedMirrorDb } from "@/lib/db/repositories/scope-aggregates";
import { mirrorHeavyBudget } from "@/lib/scope/kpi-tab-budget";

// ════════════════════════════════════════════════════════════════════════════
// 미러 인용 **그룹 키 전수** — 글로벌 ⑤ 분자(공식(HMG) 카테고리)의 미러 폴백용 후보
// ════════════════════════════════════════════════════════════════════════════
//
// 미러의 인용 그룹 키(`citationGroupKeySql`)는 두 종류뿐이다:
//   · 공식 소셜 계정 행 → `OFFICIAL_SOCIAL_ACCOUNTS[].key`(유한 목록, 코드에 있다)
//   · 그 외 전부       → `lower(scope_citations.domain)`
// 그래서 전수 = "distinct lower(domain)" ∪ "소셜 계정 키" 다. 필터와 무관한 **상위집합**이고,
// 분자 FILTER 는 "목록에 있는 키만 센다" 이므로 상위집합이면 정확하다.
//
// distinct 는 `scope_citations_lower_domain_idx (lower(domain), job_id)` 위의 **재귀 skip
// scan** 으로 센다 — 590만 행을 훑지 않고 distinct 값 수(≈6.9만)만큼 인덱스를 내려간다
// (2026-09-29 라이브 EXPLAIN ANALYZE 1,859 ms, shared hit 268k).
//
// 이 목록은 필터와 무관하므로 호출부(`lib/scope/server.ts`)가 **한 셀**에 캐시한다.

export function mirrorCitationDomainUniverseSql(): SQL {
  return sql`
    WITH RECURSIVE t AS (
      (SELECT lower(domain) AS d FROM scope_citations
        WHERE lower(domain) IS NOT NULL ORDER BY lower(domain) LIMIT 1)
      UNION ALL
      SELECT (SELECT lower(domain) FROM scope_citations
               WHERE lower(domain) > t.d ORDER BY lower(domain) LIMIT 1)
        FROM t WHERE t.d IS NOT NULL
    )
    SELECT d FROM t WHERE d IS NOT NULL`;
}

export async function readMirrorCitationKeyUniverse(): Promise<string[]> {
  const db = budgetedMirrorDb(getDb(), mirrorHeavyBudget("summaryRead"));
  const rows = (await db.execute(mirrorCitationDomainUniverseSql())) as unknown as Array<{
    d: string | null;
  }>;
  const out = new Set<string>();
  for (const r of rows) if (r.d) out.add(r.d);
  for (const acc of OFFICIAL_SOCIAL_ACCOUNTS) out.add(acc.key);
  return [...out];
}
