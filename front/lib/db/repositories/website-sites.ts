import "server-only";
import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  anchorRoundAxis,
  answerMeasuredAxis,
  periodBounds,
} from "@/lib/period/period-bounds";
import { anchorJoinSql, anchorRoundDateSql } from "@/lib/period/anchor-axis";
import { anchorViewableSql } from "./scope-answer-anchors";
import {
  anchorAxisKnownEnabled,
  ensureAnchorAxis,
} from "@/lib/period/anchor-axis-state";
import {
  websiteSites,
  websitePrompts,
  type WebsiteSiteRow,
  type WebsitePromptRow,
} from "@/lib/db/schema";
import type { AllowedScope } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import { ALL_RHQ_COUNTRIES, countriesForRhq } from "@/lib/rhq";
import { withPseudoCountries } from "@/lib/geo-catalog/pseudo-country";
import {
  WEBSITE_BRAND_GEO_CODES,
  WEBSITE_SITE_BRAND_PARENT,
  isWebsiteBrandGeoCode,
  splitWebsiteGeo,
  websiteBrandGeoCodesFor,
  websiteDedicatedCodes,
  websiteScopeBrands,
  withWebsiteBrandGeoCombos,
} from "@/lib/scope/website-virtual-geo";
import { websiteSiteGeoPred } from "@/lib/db/repositories/website-geo-pred";

// website_sites에는 region 컬럼이 없다(brand + country_code만). scope.regions(RHQ
// 버킷)를 country_code로 풀어서 적용 — 안 풀면 region 전용 계정(seed의
// region@hmg.test 등: brands만 있고 countries는 비어있음)이 자기 권역 밖 국가까지
// 다 보게 된다. scope.countries가 함께 설정된 경우(예: country 역할: regions=권역,
// countries=권역 내 특정국) isInScope의 AND 의미론과 맞추기 위해 교집합을 취한다.
//
// 단, 교집합은 **ISO 국가에만** 건다. `website_sites.country_code` 에는 사이트 단위
// 가상코드(CPO·MIDDLEEAST·EU·CN-BJ·worldwide·SA-* 등)가 있고, 이 값들은 RHQ 권역의
// ISO 목록에 들어갈 수 없어 교집합을 태우면 **항상** 탈락한다 — hyundai-cpo 계정
// ([CPO, US] + 북미)이 CPO 사이트를 통째로 잃은 결함(2026-09-29). 가상코드는 관리자가
// 계정에 명시적으로 부여한 값이므로 그대로 통과시킨다. 판정은 하드코딩 목록이 아니라
// RHQ ISO 유니버스(ALL_RHQ_COUNTRIES, scope-policy 의 country 축 검증 유니버스와 같은
// 정본)의 여집합 — `EU` 는 2글자 대문자라 형태로는 ISO 와 구별되지 않고, 목록은 새
// 가상코드가 생길 때마다 같은 결함을 재발시킨다.
const RHQ_ISO_COUNTRIES: ReadonlySet<string> = new Set(ALL_RHQ_COUNTRIES);

// 교집합을 건너뛰는 사이트 가상코드인가. 브랜드 가상코드(HYUNDAI-N 등)는 제외한다 —
// country_code 가 아니라 브랜드를 가리켜 경로마다 해석이 갈린다(목록·export 는 ws.brand,
// project id 게이트는 country_code). ISO 처럼 교집합을 거쳐 탈락 = 이 규칙 도입 전과 동일.
function isSiteVirtualCode(code: string): boolean {
  return !RHQ_ISO_COUNTRIES.has(code) && !isWebsiteBrandGeoCode(code);
}

export function effectiveCountries(scope: AllowedScope): string[] | null {
  // 전용 사이트 계정(worldwide·CPO·HYUNDAI-N) — 웹사이트에서는 그 사이트만 본다. 같은
  // 배열의 ISO 는 글로벌 전용이고(N = HYUNDAI-N·KR 의 KR 이 현대 본사 KR 사이트를 열지
  // 않게), 전부 가상 코드라 권역 교집합·도시 의사 코드 전개 대상도 아니다.
  // 규칙 정본 = lib/scope/website-virtual-geo 머리 주석(2026-09-29).
  const dedicated = websiteDedicatedCodes(scope.countries);
  if (dedicated.length) return dedicated;
  const fromRegions = scope.regions?.length
    ? scope.regions.flatMap((r) => countriesForRhq(r))
    : null;
  const explicit = scope.countries?.length ? scope.countries : null;
  const base = !fromRegions
    ? explicit
    : !explicit
      ? fromRegions
      : [
          // ISO: 권역 교집합(권역 밖 ISO 는 탈락 — aa57bda 의 AND 의미론 유지).
          ...explicit.filter((c) => RHQ_ISO_COUNTRIES.has(c) && fromRegions.includes(c)),
          // 사이트 가상코드: 교집합 없이 통과(브랜드 가상코드는 위 교집합에서 탈락).
          ...explicit.filter(isSiteVirtualCode),
        ];
  // 도시 단위 의사 코드(SA-Dammam 등)는 모국(SA)을 허용하는 스코프가 함께 본다 —
  // RHQ 맵·계정 스코프는 ISO 만 알기 때문에 여기서 덧붙이지 않으면 중동 권역 계정이
  // 사우디 도시 사이트를 전부 잃는다. 어떤 코드가 딸려오는지는 pseudo-country 정본.
  return base ? withPseudoCountries(base) : base;
}

/**
 * 웹사이트 표면의 스코프 국가 조건 — 이 파일의 모든 website_sites 읽기가 공유한다.
 *   - null            = 국가 제한 없음(scope.all, 또는 regions·countries 둘 다 없음)
 *   - `false`         = 허용 국가 0개(빈 교집합·미지의 권역 id) → **0 사이트(fail-closed)**
 *   - IN (…)          = 허용 국가 목록
 * 종전 호출부는 `if (countries?.length)` 로 빈 배열일 때 조건을 **생략**해 브랜드 전
 * 사이트를 열었다(fail-open). 조건 파생을 여기 한 곳에 둬 드롭다운(옵션)과 데이터
 * (project id)가 같은 규칙으로만 좁혀지게 한다.
 */
export function websiteScopeCountryCondition(scope: AllowedScope): SQL | null {
  if (scope.all) return null;
  const countries = effectiveCountries(scope);
  if (countries === null) return null;
  if (!countries.length) return sql`false`;
  // 브랜드 가상 코드(HYUNDAI-N)는 country_code 가 아니라 사이트 브랜드다 — 술어 정본
  // website-geo-pred 와 같은 해석(그쪽은 `ws` 별칭 raw SQL, 여기는 drizzle 컬럼).
  const { countries: codes, brands } = splitWebsiteGeo(countries);
  const parts: SQL[] = [];
  if (codes.length) parts.push(inArray(websiteSites.countryCode, codes));
  if (brands.length) parts.push(inArray(websiteSites.brand, brands));
  return parts.length === 1 ? parts[0] : or(...parts)!;
}

/**
 * 웹사이트 표면의 계정 브랜드 허용 목록. null = 제한 없음. 계정 brands(3사 어휘)에
 * 전용 브랜드 코드(HYUNDAI-N)가 여는 사이트 브랜드('Hyundai N')를 더한다 — 안 더하면
 * N 계정의 `brand IN ('Hyundai')` 가 N 사이트를 통째로 거른다.
 */
function websiteBrandAllow(scope: AllowedScope): string[] | null {
  if (scope.all || !scope.brands?.length) return null;
  return websiteScopeBrands(scope.brands, scope.countries);
}

function websiteBrandCondition(scope: AllowedScope): SQL | null {
  const brands = websiteBrandAllow(scope);
  return brands ? inArray(websiteSites.brand, brands) : null;
}

// ─── 읽기 ────────────────────────────────────────────────────────────────────

/** scope_project_id[] — country 대시보드 집계에 필요한 ID 목록 반환. */
export async function getProjectIdsForCountry(
  brand: string,
  countryCode: string,
): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ scopeProjectId: websiteSites.scopeProjectId })
    .from(websiteSites)
    .where(
      and(
        eq(websiteSites.brand, brand),
        eq(websiteSites.countryCode, countryCode),
      ),
    );
  return rows.flatMap((r) => (r.scopeProjectId ? [r.scopeProjectId] : []));
}

/** scope scope에 올라간 프로젝트 ID 전체 — 집계용. scope가 허용하는 브랜드·국가로 필터링. */
export async function getProjectIdsForScope(scope: AllowedScope): Promise<string[]> {
  const db = getDb();
  let q = db
    .select({ scopeProjectId: websiteSites.scopeProjectId })
    .from(websiteSites)
    .$dynamic();

  if (!scope.all) {
    const conditions = [];
    const brandCond = websiteBrandCondition(scope);
    if (brandCond) conditions.push(brandCond);
    const countryCond = websiteScopeCountryCondition(scope);
    if (countryCond) conditions.push(countryCond);
    if (conditions.length) q = q.where(and(...conditions));
  }

  const rows = await q;
  // 정렬: 이 배열은 website 미러 집계의 unstable_cache 키 인자로 그대로 들어간다
  // (cachedWebsiteCitations(ids, filters) 등). ORDER BY 없는 셀렉트의 행 순서는
  // 보장이 없어(힙/플랜 의존) 순서가 흔들리면 같은 스코프가 요청마다 다른 캐시
  // 키를 만들어 조용한 상시 미스가 된다 — 값 정렬로 키를 결정론화한다(2026-07-22).
  // 도시별 사이트(제네시스 사우디 3곳)가 scope 프로젝트 하나를 공유하므로 중복 제거.
  return [...new Set(rows.flatMap((r) => (r.scopeProjectId ? [r.scopeProjectId] : [])))].sort();
}

/**
 * scope 범위 안에서 실제 적재된 사이트 언어 목록 (DISTINCT lang_code).
 * 웹사이트 필터의 언어 축 옵션 소스 — geography 축의 listMeasuredRegions 와
 * 같은 posture(정적 하드코드 대신 실데이터로 드롭다운을 채움).
 */
export async function listMeasuredLanguages(scope?: AllowedScope): Promise<string[]> {
  const db = getDb();
  let q = db
    .selectDistinct({ langCode: websitePrompts.langCode })
    .from(websitePrompts)
    .innerJoin(websiteSites, eq(websitePrompts.siteId, websiteSites.id))
    .$dynamic();

  if (scope && !scope.all) {
    const conditions = [];
    const brandCond = websiteBrandCondition(scope);
    if (brandCond) conditions.push(brandCond);
    // 데이터 읽기(getProjectIdsForScope)와 동일하게 websiteScopeCountryCondition으로 국가를
    // 파생 — regions만 있는 region 계정도 권역 국가로 옵션이 좁혀진다(이전엔
    // scope.countries만 봐서 권한 밖 국가/언어가 드롭다운에 노출됐다).
    const countryCond = websiteScopeCountryCondition(scope);
    if (countryCond) conditions.push(countryCond);
    if (conditions.length) q = q.where(and(...conditions));
  }

  const rows = await q.orderBy(websitePrompts.langCode);
  return rows.map((r) => r.langCode);
}

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
export async function listWebsiteScopeMatrix(
  scope?: AllowedScope,
): Promise<{ brand: string | null; region: string; lang: string | null }[]> {
  const db = getDb();
  let q = db
    .selectDistinct({
      brand: websiteSites.brand,
      region: websiteSites.countryCode,
      lang: websitePrompts.langCode,
    })
    .from(websitePrompts)
    .innerJoin(websiteSites, eq(websitePrompts.siteId, websiteSites.id))
    .$dynamic();

  if (scope && !scope.all) {
    // 좁히는 규칙은 형제 옵션 함수들과 동일 — 권한은 그대로 걸고 **사용자 선택
    // (브랜드·국가)만** 안 좁힌다.
    const conditions = [];
    const brandCond = websiteBrandCondition(scope);
    if (brandCond) conditions.push(brandCond);
    const countryCond = websiteScopeCountryCondition(scope);
    if (countryCond) conditions.push(countryCond);
    if (conditions.length) q = q.where(and(...conditions));
  }

  const rows = await q.orderBy(websiteSites.countryCode, websitePrompts.langCode);
  // 브랜드 가상 코드(HYUNDAI-N) 행을 덧붙인다 — 패널은 매트릭스가 있으면 이것으로
  // 국가 목록을 만들어 listWebsiteCountries 의 가상 코드가 무시된다(2026-09-06 실측).
  const combos = withWebsiteBrandGeoCombos(
    rows.map((r) => ({ brand: r.brand ?? null, region: r.region, lang: r.lang ?? null })),
  );
  const dedicated = scope && !scope.all ? websiteDedicatedCodes(scope.countries) : [];
  if (!dedicated.length) return combos;
  // 전용 사이트 계정 — 국가 옵션은 그 사이트 코드만. 사이트 브랜드('Hyundai N')는 모
  // 브랜드로 적는다: 패널은 비-admin 이면 계정 단일 브랜드(Hyundai)로 행을 거르므로
  // 그대로 두면 N 계정의 언어 옵션까지 비어 버린다(dimension-filter-panel
  // matrixBrandFilter).
  return combos
    .filter((r) => dedicated.includes(r.region))
    .map((r) => ({ ...r, brand: (r.brand && WEBSITE_SITE_BRAND_PARENT[r.brand]) ?? r.brand }));
}

/** 웹사이트 geography 필터 옵션 — DISTINCT country_code, scope 필터 적용. */
export async function listWebsiteCountries(scope?: AllowedScope): Promise<string[]> {
  const db = getDb();
  let q = db
    .selectDistinct({ countryCode: websiteSites.countryCode, brand: websiteSites.brand })
    .from(websiteSites)
    .$dynamic();

  if (scope && !scope.all) {
    const conditions = [];
    const brandCond = websiteBrandCondition(scope);
    if (brandCond) conditions.push(brandCond);
    // websiteScopeCountryCondition으로 regions→국가 확장(위 listMeasuredLanguages와 동일 사유).
    const countryCond = websiteScopeCountryCondition(scope);
    if (countryCond) conditions.push(countryCond);
    if (conditions.length) q = q.where(and(...conditions));
  }

  const rows = await q.orderBy(websiteSites.countryCode);
  const codes = [...new Set(rows.map((r) => r.countryCode))];
  // 브랜드 가상 코드(HYUNDAI-N 등) — 그 브랜드 사이트가 스코프 안에 있을 때만 덧붙인다.
  // 데이터 술어(website-geo-pred)와 같은 규칙이라 옵션에 뜨면 반드시 데이터가 있다.
  const out = [...codes, ...websiteBrandGeoCodesFor(rows.map((r) => r.brand))];
  // 전용 사이트 계정은 그 사이트 코드만(N 사이트 행의 KR·worldwide 는 옵션이 아니다).
  const dedicated = scope && !scope.all ? websiteDedicatedCodes(scope.countries) : [];
  return dedicated.length ? out.filter((c) => dedicated.includes(c)) : out;
}

/** scope에 등록된 웹사이트 scope_project_id 전체 — 미러 싱크 대상 목록. */
export async function getWebsiteScopeProjectIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ scopeProjectId: websiteSites.scopeProjectId })
    .from(websiteSites)
    .where(isNotNull(websiteSites.scopeProjectId));
  // 사이트 여러 곳이 프로젝트 하나를 공유할 수 있다(제네시스 사우디 도시 3곳) — 중복 제거.
  return [...new Set(rows.flatMap((r) => (r.scopeProjectId ? [r.scopeProjectId] : [])))];
}

/** 사이트 목록 — seed/admin용. */
export async function listWebsiteSites(): Promise<WebsiteSiteRow[]> {
  const db = getDb();
  return db.select().from(websiteSites).orderBy(websiteSites.brand, websiteSites.countryCode);
}

/** 특정 사이트의 프롬프트 — scope 푸시 여부 포함. */
export async function listWebsitePrompts(siteId: string): Promise<WebsitePromptRow[]> {
  const db = getDb();
  return db
    .select()
    .from(websitePrompts)
    .where(eq(websitePrompts.siteId, siteId))
    .orderBy(websitePrompts.fileSeq, websitePrompts.seqNo);
}

// ─── /website/prompts 조회 (열람 전용) ───────────────────────────────────────
//
// 축이 두 종류라는 게 이 함수의 핵심이다:
//   행 필터 (브랜드·국가·언어·검색) — website_sites/website_prompts 의 실제 컬럼.
//     행을 걸러낸다.
//   측정 렌즈 (엔진·기간) — scope_answers 의 컬럼. 프롬프트의 속성이 아니라
//     측정 실행의 속성이라 행을 거르지 않는다. 대신 각 행의 answers/lastMeasuredAt/
//     engines 를 "그 엔진·그 기간 안에서" 계산하는 범위가 된다.
//
// 왜 렌즈인가: website_prompts 9,569행이 전부 chatgpt·gemini 두 엔진 모두에서
// 측정된다(예외 0건, 2026-07-16 실측). 엔진을 행 필터로 두면 무엇을 골라도 9,569행
// 그대로라 아무것도 거르지 못한다. 기간을 행 필터로 두면 "그 날 돌린 프롬프트"가
// 되어 측정 스케줄 편차(07-05=1행, 07-13=42행)를 카탈로그인 양 보여준다.
// 렌즈로 두면 목록은 카탈로그 전체를 유지하고 "이 프롬프트가 chatgpt 로 최근 언제
// 돌았나"를 정렬해서 볼 수 있다 — 화면의 질문("어떤 프롬프트로 측정하는가")과 맞는다.

export interface WebsitePromptQueryFilters {
  // 행 필터
  brands?: string[];
  countries?: string[];
  langs?: string[];
  search?: string;
  // 측정 렌즈
  engines?: string[];
  dateFrom?: string; // YYYY-MM-DD, 포함
  dateTo?: string; // YYYY-MM-DD, 포함
}

export const WEBSITE_PROMPT_SORT_KEYS = [
  "prompt",
  "brand",
  "country",
  "lang",
  "targetUrl",
  "answers",
  "lastMeasuredAt",
] as const;
export type WebsitePromptSortKey = (typeof WEBSITE_PROMPT_SORT_KEYS)[number];

export interface WebsitePromptViewRow {
  id: string;
  promptText: string;
  brand: string;
  countryCode: string;
  langCode: string;
  targetUrl: string;
  domain: string;
  // ↓ 렌즈 범위 안에서만 계산된 값 (범위 밖 측정은 포함되지 않는다)
  answers: number;
  lastMeasuredAt: string | null;
  engines: string[];
}

export interface WebsitePromptPage {
  rows: WebsitePromptViewRow[];
  total: number;
}

// scope 가 허용하는 값과 사용자가 요청한 값의 교집합. scope 는 하드락 —
// 요청이 scope 를 넓히는 방향으로는 절대 못 간다(readStandardFilters 의 D4 브랜드
// 하드락과 같은 규약). null = 제약 없음.
function narrowToScope(
  allowed: string[] | null,
  requested: string[] | undefined,
): string[] | null {
  if (!requested?.length) return allowed;
  if (!allowed) return requested;
  return requested.filter((v) => allowed.includes(v));
}

// 지역 축 전용 narrow — 웹사이트 지역 값에는 **브랜드 가상 코드**(HYUNDAI-N)가
// 섞인다(lib/scope/website-virtual-geo). 그 코드는 국가 집합에 없으므로 위
// narrowToScope 를 그대로 쓰면 교집합이 비어 `false` 술어가 되고, 정작 그 브랜드
// 계정에서만 0건이 된다. readStandardFilters(components/dash/standard-filters.ts
// :75-86)가 URL 단계에서 쓰는 것과 **같은 규칙**으로 통과시킨다 — 그쪽만 고치고
// 여기를 안 고치면 두 번째 좁히기에서 다시 죽는다.
function narrowGeoToScope(
  scope: AllowedScope,
  allowed: string[] | null,
  requested: string[] | undefined,
): string[] | null {
  if (!requested?.length) return allowed;
  if (!allowed) return requested;
  const scopeBrands = new Set(websiteScopeBrands(scope.brands, scope.countries));
  return requested.filter(
    (v) =>
      allowed.includes(v) ||
      (isWebsiteBrandGeoCode(v) && scopeBrands.has(WEBSITE_BRAND_GEO_CODES[v])),
  );
}

// 정렬 키 → SQL. 화이트리스트로만 매핑한다(사용자 입력이 SQL 로 새지 않게).
// 2차 키로 항상 wp.id 를 붙인다 — 동점 행의 순서가 페이지마다 흔들리면 페이징이
// 행을 건너뛰거나 중복해서 보여준다.
const SORT_EXPR: Record<WebsitePromptSortKey, SQL> = {
  prompt: sql`wp.prompt_text`,
  brand: sql`ws.brand`,
  country: sql`ws.country_code`,
  lang: sql`wp.lang_code`,
  targetUrl: sql`wp.target_url`,
  answers: sql`answers`,
  lastMeasuredAt: sql`last_measured_at`,
};

/**
 * 웹사이트 프롬프트 목록 — scope 격리 + 행 필터 + 측정 렌즈 + 서버 페이징/정렬.
 *
 * 서버 페이징인 이유: 9,569행이라 표준 프롬프트 화면(2,431행 클라이언트 in-memory
 * 필터)의 패턴을 그대로 쓰면 페이로드도 정렬 비용도 클라이언트로 넘어간다.
 */
// ── 술어 빌더 (목록·내보내기 공유) ─────────────────────────────────────────
//
// 목록(listWebsitePromptsScoped)과 내보내기(listWebsitePromptsForExport)가 **같은
// 행 집합**을 봐야 한다. 두 함수가 WHERE 를 각자 조립하면 한쪽만 고쳐지는 날
// "화면엔 300건인데 엑셀은 다른 300건"이 조용히 생긴다 — 술어는 여기 한 벌뿐이고
// 두 함수는 페이징·상한만 다르다. (정적 가드: website-prompts-query.test.ts)

/** 행 필터 WHERE — scope ∩ 요청. `ws`/`wp` 별칭을 조인한 쿼리용. */
function websitePromptRowWhere(
  scope: AllowedScope,
  filters: WebsitePromptQueryFilters,
): SQL {
  const scopeBrands = websiteBrandAllow(scope);
  const scopeCountries = scope.all ? null : effectiveCountries(scope);
  const brands = narrowToScope(scopeBrands, filters.brands);
  const countries = narrowGeoToScope(scope, scopeCountries, filters.countries);

  const where: SQL[] = [];
  // 빈 배열 = "허용된 값이 하나도 없음"(예: 권역 밖 국가를 요청) → 행 0개.
  // 조건을 빼면 전체가 열리므로 명시적으로 막는다.
  if (brands) {
    where.push(
      brands.length
        ? sql`ws.brand IN (${sql.join(brands.map((b) => sql`${b}`), sql`, `)})`
        : sql`false`,
    );
  }
  if (countries) {
    // 가상 브랜드 코드(HYUNDAI-N)는 country_code 가 아니라 brand 로 푼다 —
    // 직접 `ws.country_code IN` 을 쓰면 그 코드에서만 조용히 0건이 된다
    // (2026-09-06 도입분이 이 경로에만 누락돼 admin 포함 전 계정이 0건이었다).
    // 술어 정본은 website-geo-pred.ts, 회귀 가드는 website-virtual-geo.test.ts.
    where.push(countries.length ? websiteSiteGeoPred(countries) : sql`false`);
  }
  // 언어는 scope 축이 아니다(계정 권한에 언어 개념이 없음) — 요청값만 적용.
  if (filters.langs?.length) {
    where.push(
      sql`wp.lang_code IN (${sql.join(filters.langs.map((l) => sql`${l}`), sql`, `)})`,
    );
  }
  const search = filters.search?.trim();
  if (search) {
    // ILIKE 이스케이프 — %/_ 를 사용자가 넣어도 와일드카드가 되지 않게.
    const escaped = search.replace(/[\\%_]/g, (m) => `\\${m}`);
    const pattern = `%${escaped}%`;
    where.push(sql`(wp.prompt_text ILIKE ${pattern} OR wp.target_url ILIKE ${pattern})`);
  }
  return where.length ? sql.join(where, sql` AND `) : sql`true`;
}

/** 측정 렌즈 — scope_answers 집계 범위. 행을 거르지 않는다(함수 머리 주석). */
function websitePromptLens(filters: WebsitePromptQueryFilters): SQL {
  // 0031 인덱스(target, measured_at, prompt_id) WHERE status='completed' 가
  // 이 WHERE 절 모양에 맞춰져 있다. 조건을 바꾸면 인덱스도 같이 봐야 한다.
  const lens: SQL[] = [sql`a.status = 'completed'`];
  if (filters.engines?.length) {
    lens.push(
      sql`a.target IN (${sql.join(filters.engines.map((e) => sql`${e}`), sql`, `)})`,
    );
  }
  // 경계 술어·축의 정본은 `lib/period/period-bounds.ts`.
  //
  // off: 축이 **둘**이다 — 기간은 행 축(`a.measured_at`), 같은 표의 '마지막 측정일'
  //      열은 앵커 축(`COALESCE(r.cycle_anchor_at, a.measured_at)`). 알려진 불일치다.
  // on : 둘 다 `ca.round_date` 로 **한 축**이 된다(계약 §3 · 스펙 §5).
  //      노출 시간 게이트도 같은 조인 위에서 함께 건다.
  if (anchorAxisKnownEnabled()) {
    lens.push(...periodBounds(filters, anchorRoundAxis()));
    lens.push(anchorViewableSql());
  } else {
    lens.push(...periodBounds(filters, answerMeasuredAxis(sql`a.measured_at`)));
  }
  return sql.join(lens, sql` AND `);
}

type WebsitePromptRawRow = {
  id: string;
  prompt_text: string;
  target_url: string;
  domain: string;
  lang_code: string;
  brand: string;
  country_code: string;
  answers: number;
  last_measured_at: Date | string | null;
  engines: string[];
};

/** 투영 + 렌즈 조인 — SELECT 본문. ORDER BY / LIMIT 은 호출부가 붙인다. */
function websitePromptSelect(W: SQL, L: SQL): SQL {
  const anchorOn = anchorAxisKnownEnabled();
  // 앵커 축(옵트인)에서는 이 자리가 max(ca.round_date) 로 바뀌어 같은 표의 기간
  // 술어와 한 축이 된다(위 렌즈 주석).
  //
  // ⚠️ 아래 SQL 안의 `--` 주석 블록은 **발행되는 텍스트의 일부**다. 밖으로 빼거나
  // 줄을 더하면 off 경로의 바이트 동일성이 깨진다(스냅샷이 그것을 잡는다).
  // 축 on 은 **텍스트로 잘라서** 낸다(검증 F-2). `date` 를 그대로 내리면 postgres.js
  // 가 `new Date(x)` 로 파싱하고(`node_modules/postgres/src/types.js`) 아래 mapper 가
  // `toISOString()` 해서 `2026-09-11T00:00:00.000Z` 라는 **없는 시각**이 붙는다 —
  // 같은 화면군의 기준일이 ISO·날짜·이 세 번째 형식으로 갈린다.
  // 정렬은 `SORT_EXPR.lastMeasuredAt` 이 이 열을 그대로 보는데, `YYYY-MM-DD` 는
  // 사전식 = 시간순이라 순서가 바뀌지 않는다.
  const lastMeasured = anchorOn
    ? sql`to_char(max(${anchorRoundDateSql()}), 'YYYY-MM-DD')`
    : sql`max(COALESCE(r.cycle_anchor_at, a.measured_at))`;
  return sql`
    WITH lens AS (
      SELECT a.prompt_id,
             count(*)::int AS answers,
             -- 마지막 측정일 = **회차(cycle) 기준**. 웹사이트 대시보드 asOf·추이 눈금이
             -- 이미 COALESCE(r.cycle_anchor_at, a.measured_at) 축이라(#209,
             -- scope-aggregates.ts) 이 열만 원본 measured_at 을 쓰면 같은 화면에서
             -- 유닛마다 날짜가 갈린다 — 2026-09-08 실증: 제네시스/US 를 회차 밖(9/7)에
             -- 개별 측정하자 이 열만 9/7 로 뜨고 나머지 Genesis 유닛은 9/4 였다.
             -- 측정 이월은 상시 현상이라 예외가 아니라 축을 맞추는 것이 맞다.
             ${lastMeasured} AS last_measured_at,
             array_agg(DISTINCT a.target) AS engines
      FROM scope_answers a
      LEFT JOIN scope_runs r ON r.run_id = a.run_id${
        anchorOn ? anchorJoinSql(sql.raw("a.job_id")) : sql``
      }
      WHERE ${L}
      GROUP BY a.prompt_id
    )
    SELECT wp.id,
           wp.prompt_text,
           wp.target_url,
           wp.domain,
           wp.lang_code,
           ws.brand,
           ws.country_code,
           COALESCE(l.answers, 0) AS answers,
           l.last_measured_at,
           COALESCE(l.engines, ARRAY[]::text[]) AS engines
    FROM website_prompts wp
    JOIN website_sites ws ON ws.id = wp.site_id
    LEFT JOIN lens l ON l.prompt_id::text = wp.scope_prompt_id
    WHERE ${W}`;
}

/** 날짜(`YYYY-MM-DD`)면 그대로, 시각이면 ISO. 두 축의 출력이 섞이지 않게 한다. */
const DATE_ONLY_ROW = /^\d{4}-\d{2}-\d{2}$/;
function normalizeMeasuredAt(v: Date | string | null): string | null {
  if (v == null) return null;
  if (typeof v === "string" && DATE_ONLY_ROW.test(v)) return v;
  return new Date(v).toISOString();
}

function mapWebsitePromptRow(r: WebsitePromptRawRow): WebsitePromptViewRow {
  return {
    id: r.id,
    promptText: r.prompt_text,
    targetUrl: r.target_url,
    domain: r.domain,
    langCode: r.lang_code,
    brand: r.brand,
    countryCode: r.country_code,
    answers: r.answers,
    // 축 on 은 이미 `YYYY-MM-DD` 다 — 다시 파싱해 ISO 로 만들면 없는 시각이 붙는다.
    lastMeasuredAt: normalizeMeasuredAt(r.last_measured_at),
    engines: [...r.engines].sort(),
  };
}

function websitePromptOrderBy(
  sort: WebsitePromptSortKey | undefined,
  dir: "asc" | "desc" | undefined,
): SQL {
  const dirSql = (dir ?? "desc") === "asc" ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
  return sql`${SORT_EXPR[sort ?? "lastMeasuredAt"]} ${dirSql}, wp.id ASC`;
}

export async function listWebsitePromptsScoped(
  scope: AllowedScope | undefined,
  filters: WebsitePromptQueryFilters = {},
  opts: {
    sort?: WebsitePromptSortKey;
    dir?: "asc" | "desc";
    page?: number;
    pageSize?: number;
  } = {},
): Promise<WebsitePromptPage> {
  // default-deny — scopeWhere 와 같은 규약. scope 없이 부르면 전 브랜드가 열린다.
  if (!scope) throw new UnauthorizedError("scope required");

  // SQL 을 만들기 전에 앵커 축 판정을 확정한다(anchor-axis-state 계약 ①).
  await ensureAnchorAxis();
  const db = getDb();
  const W = websitePromptRowWhere(scope, filters);
  const L = websitePromptLens(filters);

  const sortKey = opts.sort ?? "lastMeasuredAt";
  const dir = opts.dir ?? "desc";
  // pageSize 상한 200 은 **대화형 페이징의 안전장치다** — 내보내기가 이 상한을
  // 옵션으로 뚫는 대신 별도 함수(listWebsitePromptsForExport)를 쓴다.
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const orderBy = websitePromptOrderBy(sortKey, dir);

  // total 은 행 필터만 반영한다 — 렌즈는 행을 거르지 않으므로 개수에 영향이 없다.
  const totalRows = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM website_prompts wp
    JOIN website_sites ws ON ws.id = wp.site_id
    WHERE ${W}
  `)) as unknown as Array<{ n: number }>;

  const rows = (await db.execute(sql`
    ${websitePromptSelect(W, L)}
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${offset}
  `)) as unknown as WebsitePromptRawRow[];

  return {
    total: totalRows[0]?.n ?? 0,
    rows: rows.map(mapWebsitePromptRow),
  };
}

// 내보내기 상한 — 대화형 페이징의 200 과는 성격이 다른 **메모리 안전장치**다.
//
// 모집단: 2026-09-16 프로덕션 읽기 전용 확인 = `website_prompts` **12,685행**
// (sites 128). 상한은 그 3.9배다. ⚠️ 이 파일 곳곳의 "9,569행"은 2026-07-16
// 시점 수치이며(이 파일 위쪽 렌즈 주석) 그 뒤 적재로 이미 낡았다 — 상한 근거로
// 쓰지 말 것. 상한을 다시 볼 때는 반드시 그때의 실카운트를 다시 뜬다.
// 도달하면 조용히 자르지 않고 truncated 로 알린다(라우트가 헤더로 노출 —
// 다만 사용자 가시 경로는 아니다. route.ts 의 해당 주석 참조).
export const WEBSITE_PROMPT_EXPORT_MAX_ROWS = 50_000;

/**
 * 내보내기 전용 — 필터에 해당하는 **전량**(페이지 슬라이스 없음).
 *
 * `listWebsitePromptsScoped` 에 큰 pageSize 를 넘기는 대신 함수를 나눈 이유:
 * 200 상한은 대화형 화면이 실수로 전량을 끌어오지 않게 하는 안전장치이고,
 * 옵션으로 뚫을 수 있게 하면 그 안전장치가 사실상 사라진다. 이름으로 의도가
 * 드러나는 별도 경로를 두고 **술어 빌더만 공유**한다.
 */
export async function listWebsitePromptsForExport(
  scope: AllowedScope | undefined,
  filters: WebsitePromptQueryFilters = {},
  opts: { sort?: WebsitePromptSortKey; dir?: "asc" | "desc" } = {},
): Promise<{ rows: WebsitePromptViewRow[]; truncated: boolean }> {
  if (!scope) throw new UnauthorizedError("scope required");

  // SQL 을 만들기 전에 앵커 축 판정을 확정한다(anchor-axis-state 계약 ①).
  await ensureAnchorAxis();
  const db = getDb();
  const W = websitePromptRowWhere(scope, filters);
  const L = websitePromptLens(filters);
  const orderBy = websitePromptOrderBy(opts.sort, opts.dir);

  const rows = (await db.execute(sql`
    ${websitePromptSelect(W, L)}
    ORDER BY ${orderBy}
    LIMIT ${WEBSITE_PROMPT_EXPORT_MAX_ROWS}
  `)) as unknown as WebsitePromptRawRow[];

  return {
    rows: rows.map(mapWebsitePromptRow),
    truncated: rows.length >= WEBSITE_PROMPT_EXPORT_MAX_ROWS,
  };
}

// SQL 형태 고정용(website-sites.sql.test.ts). DB 없이 술어를 컴파일해 본다 —
// 이 파일의 결함은 "0건인데 아무도 에러를 안 낸다" 형태라 형태 검사가 유일한 그물이다.
export const __testables = { websitePromptRowWhere, websitePromptLens, websitePromptSelect };

/** 웹사이트 브랜드 필터 옵션 — DISTINCT brand, scope 적용. */
export async function listWebsiteBrands(scope: AllowedScope): Promise<string[]> {
  const db = getDb();
  let q = db.selectDistinct({ brand: websiteSites.brand }).from(websiteSites).$dynamic();
  const brandCond = websiteBrandCondition(scope);
  if (brandCond) q = q.where(brandCond);
  const rows = await q.orderBy(websiteSites.brand);
  return rows.map((r) => r.brand);
}

// ─── 쓰기 (seed / refresh 전용 — app/api 레이어에서 직접 호출 금지) ──────────

export async function upsertWebsiteSite(
  brand: string,
  countryCode: string,
): Promise<WebsiteSiteRow> {
  const db = getDb();
  const [row] = await db
    .insert(websiteSites)
    .values({ brand, countryCode })
    .onConflictDoUpdate({
      target: [websiteSites.brand, websiteSites.countryCode],
      set: { updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function setWebsiteSiteScopeProjectId(
  siteId: string,
  scopeProjectId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(websiteSites)
    .set({ scopeProjectId, updatedAt: new Date() })
    .where(eq(websiteSites.id, siteId));
}

export async function upsertWebsitePrompt(input: {
  siteId: string;
  fileSeq: number;
  domain: string;
  langCode: string;
  seqNo: number;
  targetUrl: string;
  promptText: string;
}): Promise<WebsitePromptRow> {
  const db = getDb();
  const [row] = await db
    .insert(websitePrompts)
    .values(input)
    .onConflictDoUpdate({
      target: [websitePrompts.siteId, websitePrompts.fileSeq, websitePrompts.seqNo],
      set: {
        targetUrl: input.targetUrl,
        promptText: input.promptText,
        domain: input.domain,
        langCode: input.langCode,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function setWebsitePromptScopeId(
  promptId: string,
  scopePromptId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(websitePrompts)
    .set({ scopePromptId, updatedAt: new Date() })
    .where(eq(websitePrompts.id, promptId));
}

/** scope_project_id 로 사이트 1건 — Scope 콘솔 딥링크(/projects/by-scope) 해석용. */
export async function getSiteByScopeProjectId(
  scopeProjectId: string,
): Promise<WebsiteSiteRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(websiteSites)
    .where(eq(websiteSites.scopeProjectId, scopeProjectId))
    .limit(1);
  return rows[0] ?? null;
}
