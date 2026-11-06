// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
/**
 * website_sites(별칭 `ws`) 를 조인한 쿼리용. 실 코드는 `ws.country_code`, 가상
 * 브랜드 코드는 `ws.brand` 로 푼다. 빈 배열은 호출부가 먼저 거른다.
 */
export declare function websiteSiteGeoPred(codes: readonly string[]): SQL;
/**
 * 요약 사실표(summary_answers 등: `country` verbatim + `project_id`)용. 가상
 * 브랜드 코드는 그 브랜드 사이트들의 scope_project_id 로 푼다 — 사실표에는 사이트
 * 브랜드 열이 없다.
 */
export declare function summaryCountryGeoPred(codes: readonly string[]): SQL;
