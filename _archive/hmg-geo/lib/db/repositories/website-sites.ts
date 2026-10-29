import "server-only";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  websiteSites,
  websitePrompts,
  type WebsiteSiteRow,
  type WebsitePromptRow,
} from "@/lib/db/schema";
import type { AllowedScope } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import { countriesForRhq } from "@/lib/rhq";
import { withPseudoCountries } from "@/lib/geo-catalog/pseudo-country";
import { websiteBrandGeoCodesFor, withWebsiteBrandGeoCombos } from "@/lib/scope/website-virtual-geo";

// website_sites에는 region 컬럼이 없다(brand + country_code만). scope.regions(RHQ
// 버킷)를 country_code로 풀어서 적용 — 안 풀면 region 전용 계정(seed의
// region@hmg.test 등: brands만 있고 countries는 비어있음)이 자기 권역 밖 국가까지
// 다 보게 된다. scope.countries가 함께 설정된 경우(예: country 역할: regions=권역,
// countries=권역 내 특정국) isInScope의 AND 의미론과 맞추기 위해 교집합을 취한다.
export function effectiveCountries(scope: AllowedScope): string[] | null {
  const fromRegions = scope.regions?.length
    ? scope.regions.flatMap((r) => countriesForRhq(r))
    : null;
  const explicit = scope.countries?.length ? scope.countries : null;
  const base = !fromRegions
    ? explicit
    : !explicit
      ? fromRegions
      : explicit.filter((c) => fromRegions.includes(c));
  // 도시 단위 의사 코드(SA-Dammam 등)는 모국(SA)을 허용하는 스코프가 함께 본다 —
  // RHQ 맵·계정 스코프는 ISO 만 알기 때문에 여기서 덧붙이지 않으면 중동 권역 계정이
  // 사우디 도시 사이트를 전부 잃는다. 어떤 코드가 딸려오는지는 pseudo-country 정본.
  return base ? withPseudoCountries(base) : base;
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
    if (scope.brands?.length) conditions.push(inArray(websiteSites.brand, scope.brands));
    const countries = effectiveCountries(scope);
    if (countries?.length) conditions.push(inArray(websiteSites.countryCode, countries));
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
    if (scope.brands?.length) conditions.push(inArray(websiteSites.brand, scope.brands));
    // 데이터 읽기(getProjectIdsForScope)와 동일하게 effectiveCountries로 국가를
    // 파생 — regions만 있는 region 계정도 권역 국가로 옵션이 좁혀진다(이전엔
    // scope.countries만 봐서 권한 밖 국가/언어가 드롭다운에 노출됐다).
    const countries = effectiveCountries(scope);
    if (countries?.length) conditions.push(inArray(websiteSites.countryCode, countries));
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
    if (scope.brands?.length) conditions.push(inArray(websiteSites.brand, scope.brands));
    const countries = effectiveCountries(scope);
    if (countries?.length) conditions.push(inArray(websiteSites.countryCode, countries));
    if (conditions.length) q = q.where(and(...conditions));
  }

  const rows = await q.orderBy(websiteSites.countryCode, websitePrompts.langCode);
  // 브랜드 가상 코드(HYUNDAI-N) 행을 덧붙인다 — 패널은 매트릭스가 있으면 이것으로
  // 국가 목록을 만들어 listWebsiteCountries 의 가상 코드가 무시된다(2026-09-06 실측).
  return withWebsiteBrandGeoCombos(
    rows.map((r) => ({ brand: r.brand ?? null, region: r.region, lang: r.lang ?? null })),
  );
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
    if (scope.brands?.length) conditions.push(inArray(websiteSites.brand, scope.brands));
    // effectiveCountries로 regions→국가 확장(위 listMeasuredLanguages와 동일 사유).
    const countries = effectiveCountries(scope);
    if (countries?.length) conditions.push(inArray(websiteSites.countryCode, countries));
    if (conditions.length) q = q.where(and(...conditions));
  }

  const rows = await q.orderBy(websiteSites.countryCode);
  const codes = [...new Set(rows.map((r) => r.countryCode))];
  // 브랜드 가상 코드(HYUNDAI-N 등) — 그 브랜드 사이트가 스코프 안에 있을 때만 덧붙인다.
  // 데이터 술어(website-geo-pred)와 같은 규칙이라 옵션에 뜨면 반드시 데이터가 있다.
  return [...codes, ...websiteBrandGeoCodesFor(rows.map((r) => r.brand))];
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

  const db = getDb();

  // ── 행 필터: scope ∩ 요청 ────────────────────────────────────────────────
  const scopeBrands = scope.all ? null : (scope.brands?.length ? scope.brands : null);
  const scopeCountries = scope.all ? null : effectiveCountries(scope);
  const brands = narrowToScope(scopeBrands, filters.brands);
  const countries = narrowToScope(scopeCountries, filters.countries);

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
    where.push(
      countries.length
        ? sql`ws.country_code IN (${sql.join(countries.map((c) => sql`${c}`), sql`, `)})`
        : sql`false`,
    );
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
  const W = where.length ? sql.join(where, sql` AND `) : sql`true`;

  // ── 측정 렌즈: scope_answers 집계 범위 ───────────────────────────────────
  // 0031 인덱스(target, measured_at, prompt_id) WHERE status='completed' 가
  // 이 WHERE 절 모양에 맞춰져 있다. 조건을 바꾸면 인덱스도 같이 봐야 한다.
  const lens: SQL[] = [sql`a.status = 'completed'`];
  if (filters.engines?.length) {
    lens.push(
      sql`a.target IN (${sql.join(filters.engines.map((e) => sql`${e}`), sql`, `)})`,
    );
  }
  if (filters.dateFrom) lens.push(sql`a.measured_at >= ${filters.dateFrom}::date`);
  // dateTo 는 포함 — 그 날 하루를 통째로 넣으려면 +1일 미만으로 잡는다.
  if (filters.dateTo) lens.push(sql`a.measured_at < (${filters.dateTo}::date + 1)`);
  const L = sql.join(lens, sql` AND `);

  const sortKey = opts.sort ?? "lastMeasuredAt";
  const dir = opts.dir ?? "desc";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const dirSql = dir === "asc" ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
  const orderBy = sql`${SORT_EXPR[sortKey]} ${dirSql}, wp.id ASC`;

  // total 은 행 필터만 반영한다 — 렌즈는 행을 거르지 않으므로 개수에 영향이 없다.
  const totalRows = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM website_prompts wp
    JOIN website_sites ws ON ws.id = wp.site_id
    WHERE ${W}
  `)) as unknown as Array<{ n: number }>;

  const rows = (await db.execute(sql`
    WITH lens AS (
      SELECT a.prompt_id,
             count(*)::int AS answers,
             -- 마지막 측정일 = **회차(cycle) 기준**. 웹사이트 대시보드 asOf·추이 눈금이
             -- 이미 COALESCE(r.cycle_anchor_at, a.measured_at) 축이라(#209,
             -- scope-aggregates.ts) 이 열만 원본 measured_at 을 쓰면 같은 화면에서
             -- 유닛마다 날짜가 갈린다 — 2026-09-08 실증: 제네시스/US 를 회차 밖(9/7)에
             -- 개별 측정하자 이 열만 9/7 로 뜨고 나머지 Genesis 유닛은 9/4 였다.
             -- 측정 이월은 상시 현상이라 예외가 아니라 축을 맞추는 것이 맞다.
             max(COALESCE(r.cycle_anchor_at, a.measured_at)) AS last_measured_at,
             array_agg(DISTINCT a.target) AS engines
      FROM scope_answers a
      LEFT JOIN scope_runs r ON r.run_id = a.run_id
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
    WHERE ${W}
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${offset}
  `)) as unknown as Array<{
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
  }>;

  return {
    total: totalRows[0]?.n ?? 0,
    rows: rows.map((r) => ({
      id: r.id,
      promptText: r.prompt_text,
      targetUrl: r.target_url,
      domain: r.domain,
      langCode: r.lang_code,
      brand: r.brand,
      countryCode: r.country_code,
      answers: r.answers,
      lastMeasuredAt: r.last_measured_at
        ? new Date(r.last_measured_at).toISOString()
        : null,
      engines: [...r.engines].sort(),
    })),
  };
}

/** 웹사이트 브랜드 필터 옵션 — DISTINCT brand, scope 적용. */
export async function listWebsiteBrands(scope: AllowedScope): Promise<string[]> {
  const db = getDb();
  let q = db.selectDistinct({ brand: websiteSites.brand }).from(websiteSites).$dynamic();
  if (!scope.all && scope.brands?.length) {
    q = q.where(inArray(websiteSites.brand, scope.brands));
  }
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
