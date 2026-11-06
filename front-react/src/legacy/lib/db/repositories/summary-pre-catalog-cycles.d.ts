// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
/**
 * 판정 SQL. **읽기 전용 단일 문장**이고 하네스가 그대로 붙여 넣을 수 있게 export 한다.
 *
 * @param rootProjectId `summary_cycles.project_id` 스코프. `null` 이면 안 건다
 *        (`trendDimJoinSql` 과 같은 자세 — 루트 설정이 없는 배포에서 표면만으로 판정).
 */
export declare function preCatalogCyclesSql(rootProjectId: string | null): SQL;
/**
 * 목록을 한 번 읽는다. **실패는 던진다** — 호출부가 "실패를 캐시하지 않는다" 를
 * 결정해야 하기 때문이다(초판은 여기서 빈 목록을 30초 캐시했고, 그것이 A2 의
 * 두 번째 구멍이었다).
 */
export declare function readPreCatalogCycleIds(): Promise<readonly string[]>;
