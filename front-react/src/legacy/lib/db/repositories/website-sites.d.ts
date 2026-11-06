// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
import { type WebsiteSiteRow, type WebsitePromptRow } from "@/lib/db/schema";
import type { AllowedScope } from "@/lib/auth/types";
export declare function effectiveCountries(scope: AllowedScope): string[] | null;
/**
 * 웹사이트 표면의 스코프 국가 조건 — 이 파일의 모든 website_sites 읽기가 공유한다.
 *   - null            = 국가 제한 없음(scope.all, 또는 regions·countries 둘 다 없음)
 *   - `false`         = 허용 국가 0개(빈 교집합·미지의 권역 id) → **0 사이트(fail-closed)**
 *   - IN (…)          = 허용 국가 목록
 * 종전 호출부는 `if (countries?.length)` 로 빈 배열일 때 조건을 **생략**해 브랜드 전
 * 사이트를 열었다(fail-open). 조건 파생을 여기 한 곳에 둬 드롭다운(옵션)과 데이터
 * (project id)가 같은 규칙으로만 좁혀지게 한다.
 */
export declare function websiteScopeCountryCondition(scope: AllowedScope): SQL | null;
/** scope_project_id[] — country 대시보드 집계에 필요한 ID 목록 반환. */
export declare function getProjectIdsForCountry(brand: string, countryCode: string): Promise<string[]>;
/** scope scope에 올라간 프로젝트 ID 전체 — 집계용. scope가 허용하는 브랜드·국가로 필터링. */
export declare function getProjectIdsForScope(scope: AllowedScope): Promise<string[]>;
/**
 * scope 범위 안에서 실제 적재된 사이트 언어 목록 (DISTINCT lang_code).
 * 웹사이트 필터의 언어 축 옵션 소스 — geography 축의 listMeasuredRegions 와
 * 같은 posture(정적 하드코드 대신 실데이터로 드롭다운을 채움).
 */
export declare function listMeasuredLanguages(scope?: AllowedScope): Promise<string[]>;
/**
 * 웹사이트 표면 필터 옵션의 **의존 매트릭스** — (브랜드 × 사이트 국가 × 언어).
 * 표준 쪽 scope-aggregates::listMeasuredScopeMatrix 의 웹사이트판이며 **형태가 같다**
 * (DimensionFilterPanel 이 같은 prop 으로 받아 같은 규칙으로 좁힌다).
 *
 * 왜 — listWebsiteCountries/listMeasuredLanguages 는 서버가 **적용된 스코프** 기준으로
 * 좁혀 내려주는데 국가 선택은 클라이언트 draft 다. 그래서 국가를 고르는 중에는 언어가
 * 따라오지 않고 적용해야 좁혀졌다(2026-09-04 고객 요청: "웹사이트에서도 대한민국
 * 선택 시 영어·한국어만 **바로** 나오게"). 조합표를 통째로 내려 패널이 draft 로 좁힌다.
 *
 * 크기: 프로덕션 실측 139행 — 표준(138행)과 같은 자릿수라 클라이언트로 내려도 무해하다.
 * region 은 website_sites.country_code 라 `worldwide` 같은 가상 코드를 포함한다
 * (표준의 scope_answers.region 과 값 공간이 다르다 — 두 표면은 서로 매트릭스를 섞지 않는다).
 * brand 는 사이트 브랜드라 null 이 없지만, 표준과 계약을 맞추려고 타입은 nullable 로 둔다.
 */
export declare function listWebsiteScopeMatrix(scope?: AllowedScope): Promise<{
    brand: string | null;
    region: string;
    lang: string | null;
}[]>;
/** 웹사이트 geography 필터 옵션 — DISTINCT country_code, scope 필터 적용. */
export declare function listWebsiteCountries(scope?: AllowedScope): Promise<string[]>;
/** scope에 등록된 웹사이트 scope_project_id 전체 — 미러 싱크 대상 목록. */
export declare function getWebsiteScopeProjectIds(): Promise<string[]>;
/** 사이트 목록 — seed/admin용. */
export declare function listWebsiteSites(): Promise<WebsiteSiteRow[]>;
/** 특정 사이트의 프롬프트 — scope 푸시 여부 포함. */
export declare function listWebsitePrompts(siteId: string): Promise<WebsitePromptRow[]>;
export interface WebsitePromptQueryFilters {
    brands?: string[];
    countries?: string[];
    langs?: string[];
    search?: string;
    engines?: string[];
    dateFrom?: string;
    dateTo?: string;
}
export declare const WEBSITE_PROMPT_SORT_KEYS: readonly ["prompt", "brand", "country", "lang", "targetUrl", "answers", "lastMeasuredAt"];
export type WebsitePromptSortKey = (typeof WEBSITE_PROMPT_SORT_KEYS)[number];
export interface WebsitePromptViewRow {
    id: string;
    promptText: string;
    brand: string;
    countryCode: string;
    langCode: string;
    targetUrl: string;
    domain: string;
    answers: number;
    lastMeasuredAt: string | null;
    engines: string[];
}
export interface WebsitePromptPage {
    rows: WebsitePromptViewRow[];
    total: number;
}
/**
 * 웹사이트 프롬프트 목록 — scope 격리 + 행 필터 + 측정 렌즈 + 서버 페이징/정렬.
 *
 * 서버 페이징인 이유: 9,569행이라 표준 프롬프트 화면(2,431행 클라이언트 in-memory
 * 필터)의 패턴을 그대로 쓰면 페이로드도 정렬 비용도 클라이언트로 넘어간다.
 */
/** 행 필터 WHERE — scope ∩ 요청. `ws`/`wp` 별칭을 조인한 쿼리용. */
declare function websitePromptRowWhere(scope: AllowedScope, filters: WebsitePromptQueryFilters): SQL;
/** 측정 렌즈 — scope_answers 집계 범위. 행을 거르지 않는다(함수 머리 주석). */
declare function websitePromptLens(filters: WebsitePromptQueryFilters): SQL;
/** 투영 + 렌즈 조인 — SELECT 본문. ORDER BY / LIMIT 은 호출부가 붙인다. */
declare function websitePromptSelect(W: SQL, L: SQL): SQL;
export declare function listWebsitePromptsScoped(scope: AllowedScope | undefined, filters?: WebsitePromptQueryFilters, opts?: {
    sort?: WebsitePromptSortKey;
    dir?: "asc" | "desc";
    page?: number;
    pageSize?: number;
}): Promise<WebsitePromptPage>;
export declare const WEBSITE_PROMPT_EXPORT_MAX_ROWS = 50000;
/**
 * 내보내기 전용 — 필터에 해당하는 **전량**(페이지 슬라이스 없음).
 *
 * `listWebsitePromptsScoped` 에 큰 pageSize 를 넘기는 대신 함수를 나눈 이유:
 * 200 상한은 대화형 화면이 실수로 전량을 끌어오지 않게 하는 안전장치이고,
 * 옵션으로 뚫을 수 있게 하면 그 안전장치가 사실상 사라진다. 이름으로 의도가
 * 드러나는 별도 경로를 두고 **술어 빌더만 공유**한다.
 */
export declare function listWebsitePromptsForExport(scope: AllowedScope | undefined, filters?: WebsitePromptQueryFilters, opts?: {
    sort?: WebsitePromptSortKey;
    dir?: "asc" | "desc";
}): Promise<{
    rows: WebsitePromptViewRow[];
    truncated: boolean;
}>;
export declare const __testables: {
    websitePromptRowWhere: typeof websitePromptRowWhere;
    websitePromptLens: typeof websitePromptLens;
    websitePromptSelect: typeof websitePromptSelect;
};
/** 웹사이트 브랜드 필터 옵션 — DISTINCT brand, scope 적용. */
export declare function listWebsiteBrands(scope: AllowedScope): Promise<string[]>;
export declare function upsertWebsiteSite(brand: string, countryCode: string): Promise<WebsiteSiteRow>;
export declare function setWebsiteSiteScopeProjectId(siteId: string, scopeProjectId: string): Promise<void>;
export declare function upsertWebsitePrompt(input: {
    siteId: string;
    fileSeq: number;
    domain: string;
    langCode: string;
    seqNo: number;
    targetUrl: string;
    promptText: string;
}): Promise<WebsitePromptRow>;
export declare function setWebsitePromptScopeId(promptId: string, scopePromptId: string): Promise<void>;
/** scope_project_id 로 사이트 1건 — Scope 콘솔 딥링크(/projects/by-scope) 해석용. */
export declare function getSiteByScopeProjectId(scopeProjectId: string): Promise<WebsiteSiteRow | null>;
export {};
