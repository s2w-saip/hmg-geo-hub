import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { splitWebsiteGeo } from "@/lib/scope/website-virtual-geo";

// `filters.websiteCountry` → SQL 술어. 정본 한 곳 — 가상 브랜드 코드(HYUNDAI-N)의
// 해석 규칙은 lib/scope/website-virtual-geo 머리 주석 참조.

const inList = (vals: readonly string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);

function orJoin(parts: SQL[]): SQL {
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * website_sites(별칭 `ws`) 를 조인한 쿼리용. 실 코드는 `ws.country_code`, 가상
 * 브랜드 코드는 `ws.brand` 로 푼다. 빈 배열은 호출부가 먼저 거른다.
 */
export function websiteSiteGeoPred(codes: readonly string[]): SQL {
  const { countries, brands } = splitWebsiteGeo(codes);
  const parts: SQL[] = [];
  if (countries.length) parts.push(sql`ws.country_code IN (${inList(countries)})`);
  if (brands.length) parts.push(sql`ws.brand IN (${inList(brands)})`);
  return orJoin(parts);
}

/**
 * 요약 사실표(summary_answers 등: `country` verbatim + `project_id`)용. 가상
 * 브랜드 코드는 그 브랜드 사이트들의 scope_project_id 로 푼다 — 사실표에는 사이트
 * 브랜드 열이 없다.
 */
export function summaryCountryGeoPred(codes: readonly string[]): SQL {
  const { countries, brands } = splitWebsiteGeo(codes);
  const parts: SQL[] = [];
  if (countries.length) parts.push(sql`country IN (${inList(countries)})`);
  if (brands.length)
    parts.push(
      sql`project_id IN (SELECT scope_project_id::uuid FROM website_sites WHERE brand IN (${inList(brands)}) AND scope_project_id IS NOT NULL)`,
    );
  return orJoin(parts);
}
