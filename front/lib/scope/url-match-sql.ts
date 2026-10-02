import { sql, type SQL } from "drizzle-orm";

// ── 타겟 URL 일치 판정 · SQL 쌍둥이 ─────────────────────────────────────────
//
// JS 정본 = `./url-match.ts::matchesTargetUrlNorm` (규칙·근거는 그 주석).
// 두 인자는 **추적 정규화가 끝난 식**이어야 한다(`citationTrackedNormSql` 결과
// 또는 저장 컬럼 `url_norm`). 정규화가 끝난 두 값의 **등치**가 곧 일치다.
//
// ⚠️ 왜 `lib/db/repositories/scope-aggregates.ts` 가 아니라 여기 있는가 —
// 그 파일은 `import "server-only"` 라 tsx 스크립트에서 import 하면 던진다. 패리티
// 검증 스크립트(`scripts/scope/verify-url-match.ts`)가 **이 함수 자체**를 컴파일해
// 실행해야 SQL↔JS 일치가 진짜로 강제된다. 종전에는 스크립트가 같은 식을 문자열로
// 손수 복사했고, 그래서 이 함수를 고쳐도 `npm test`·`verify:url-match` 가 둘 다
// 초록이었다(2026-09-17 검증자 F-2).
//
// 성능: 인자로는 **이미 굳은 컬럼 참조**(MATERIALIZED CTE 의 열)를 넘길 것.
// 정규화 식을 그대로 넘기면 여기서 재평가되어 2026-09-03 의 73.9s 플랜
// 붕괴(scope-aggregates::websiteCitationJudgmentCtes 머리 주석)를 다시 부른다.

export function targetMatchSql(cited: SQL, target: SQL): SQL {
  // 빈 값 가드는 **JS 쌍둥이와 같은 위치**에 둔다. 없으면 빈 타겟과 빈 인용이
  // 서로 맞는다(SQL true / JS false). 프로덕션 쿼리는 `wp.turl` 을 nullif 로 비워
  // 두므로 도달하지 않지만, 쌍둥이가 갈리면 검증이 의미를 잃는다.
  return sql`CASE
      WHEN coalesce(${target}, '') = '' OR coalesce(${cited}, '') = '' THEN false
      ELSE ${cited} = ${target} END`;
}
