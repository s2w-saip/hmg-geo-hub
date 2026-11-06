// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
/**
 * 인용 한 행의 **그룹 키** 식 — 공식 소셜 계정이면 `도메인+계정경로`,
 * 아니면 종전과 동일한 `lower(domain)`.
 *
 * 성능: 바깥 `CASE WHEN lower(domain) IN (…)` 게이트가 정규화를 목록에 든 5개
 * 도메인(미러 240만 행 중 약 5.7만 행)에서만 돌게 한다. SQL 의 CASE 는 참인
 * 분기만 평가하므로 나머지 행은 문자열 연산 없이 `lower(domain)` 으로 빠진다 —
 * `citationOwnedBaseSql` 이 owned 후보 도메인에만 URL 정규화를 거는 것과 같은
 * 수법이다(전 행 정규화가 website 창에서 쿼리당 ~5s 를 만들던 전례).
 */
export declare function citationGroupKeySql(domainCol: SQL, urlCol: SQL): SQL;
