import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { columnAvailable, columnKnownAvailable } from "@/lib/db/column-availability";

// 사실표 조회의 brandPresence 술어 — 글로벌(S1)·웹사이트(S4) 두 읽기 경로가 공유한다.
//
// 정본은 미러 경로(`scope-aggregates.ts::brandPresencePredicate`)이고 그쪽은 두 겹이다:
//   ① 값 자체가 **유도값**이다 — `COALESCE(brand_presence, brand='HMG'?unbranded:branded)`
//   ② 한 프롬프트에 카탈로그 행이 여럿이면 **any-match** 다(세미조인이므로 하나만 맞아도 통과)
// 사실표는 이 둘을 `presence_set text[]`(0061) 한 컬럼으로 굳혔다 — 그 프롬프트의 모든
// 카탈로그 행에서 ①로 유도한 distinct 집합이다. 그래서 조회는 교집합 하나로 환원된다:
//   `presence_set && ARRAY['branded']`  ≡  미러의 any-match
//
// 규칙(§6-2 분기표, 대시보드 열): **양쪽 선택 = 무필터**(0개 선택과 같다). 미러도 같다
// (`brandPresencePredicate` 가 wantBranded === wantUnbranded 이면 null 을 돌려준다).
// 인용 상세 경로의 `IS NOT NULL` 규칙은 이 함수의 소관이 아니다 — 그쪽은 상세 SQL 이
// 따로 들고 있고, 이번 범위(대시보드)에 들어오지 않는다.
//
// ⚠️ 배열은 반드시 `sql.param(...)` 으로 바인딩한다. 템플릿에 JS 배열을 그대로 넣으면
// record 로 바인딩돼 실 DB 에서 `cannot cast type record to text[]` 로 죽는다 —
// 단위 테스트는 컴파일 텍스트만 보므로 못 잡는다(2026-09-06 website `report_fs` 전례).

/** 0061 적용 여부(비동기 프로브). 술어를 만들기 전에 한 번 await 해 캐시를 덥힌다. */
export function presenceSetColumnAvailable(): Promise<boolean> {
  return columnAvailable("summary_answers", "presence_set");
}

/**
 * `brandPresence` 필터 술어. 반환 null = 무필터(양쪽 선택 또는 0개 선택).
 *
 * 0061 미적용(또는 프로브 미완)이면 종전 술어(`brand_presence_resolved = …`)로 폴백한다 —
 * 마이그레이션 적용과 배포의 선후가 어느 쪽이든 500 이 나지 않게. 폴백은 값이 종전과
 * 같다는 뜻이지 옳다는 뜻이 아니다(그것이 이 컬럼을 만든 이유다).
 */
export function summaryPresencePredicate(selected: readonly string[]): SQL | null {
  const wantBranded = selected.includes("branded");
  const wantUnbranded = selected.includes("unbranded");
  if (wantBranded === wantUnbranded) return null;
  const want = wantUnbranded ? "unbranded" : "branded";
  if (!columnKnownAvailable("summary_answers", "presence_set")) {
    return sql`brand_presence_resolved = ${want}`;
  }
  return sql`presence_set && ${sql.param([want])}::text[]`;
}
