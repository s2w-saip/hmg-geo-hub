import type { AllowedScope, Role, User } from "./types";
import type { ScopeFilter } from "@/lib/scope/types";
import { type FilterDimension } from "@/lib/scope/dimensions";
import { GEO_BRANDS } from "@/lib/geo-catalog";
import {
  ALL_RHQ_COUNTRIES,
  ALL_RHQ_REGION_IDS,
  countriesForRhq,
  rhqRegionIdsForBrand,
} from "@/lib/rhq";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";

// Valid-value universe per filter dimension (replaces the hand-stubbed
// DIMENSION_OPTIONS). brand = catalog brands; region = every RHQ 권역 id across
// brands; country = every ISO the RHQ map covers. Used only to validate an
// editable dimension's requested value and to seed the unrestricted dropdown —
// the brand-aware narrowing (e.g. Genesis has no 중남미) is applied client-side
// from the selected brand (rhqRegionsForBrand), per the filter UI policy.
const DIMENSION_UNIVERSE: Record<FilterDimension, readonly string[]> = {
  brand: GEO_BRANDS,
  region: ALL_RHQ_REGION_IDS,
  country: ALL_RHQ_COUNTRIES,
};

// SINGLE SOURCE OF TRUTH: role → allowed data scope (access-control spec).
// Every scope call's region/country filter is derived here, server-side, from
// the authenticated user. Client-sent location params are never trusted.
//
// Reflects the GGMD planning Use Case matrix (page 4981000, v16):
//   admin (시스템 관리자, 이노션) → All Brands × All RHQ × All Country (scope.all)
//   HQ                            → Own Brand × All RHQ × All Country
//   region (권역/법인 담당자)     → Own Brand × Own RHQ × All Country
//   country (국가 실행 담당자)    → Own Brand × Own RHQ × Own Country
// Profiles encode Own-* dimensions as singleton scope arrays; the singleton is
// what makes the corresponding dashboard filter render disabled.
export function deriveScopeFilter(user: User): ScopeFilter {
  if (user.scope.all) {
    // Admin only: full access, no restriction injected.
    return {};
  }
  return {
    brands: user.scope.brands,
    regions: user.scope.regions,
    countries: user.scope.countries,
  };
}

export function canAccessAdmin(user: User): boolean {
  return user.role === "admin";
}

export interface ScopedRow {
  brand?: string | null;
  region?: string | null;
  country?: string | null;
}

// Pure predicate: is a row within the allowed scope? This is the rule that the
// DB-level `scopeWhere` (lib/db/scoped.ts) mirrors in SQL. Kept pure so it can be
// unit-tested as the compensating control for not having RLS (data-access-security).
//
// 2026-06-10 (D5): brand=null rows are TREATED AS COMMON — visible to every
// brand-scoped user (Genesis HQ sees Genesis-tagged + common-tagged). region /
// country still require explicit match because they're tightly scoped surveying
// axes; brand-common semantics are unique to the standard catalog (Brand Message
// prompts that ask "best car brand?" apply to everyone).
export function isInScope(scope: AllowedScope, row: ScopedRow): boolean {
  if (scope.all) return true;
  if (scope.brands?.length && row.brand && !scope.brands.includes(row.brand)) {
    return false;
  }
  if (scope.regions?.length && (!row.region || !scope.regions.includes(row.region))) {
    return false;
  }
  if (
    scope.countries?.length &&
    (!row.country || !scope.countries.includes(row.country))
  ) {
    return false;
  }
  return true;
}

// projects에는 region 컬럼이 없어 scope.regions(RHQ 버킷)를 country로 풀어야
// 판정할 수 있다. region id는 브랜드 프리픽스라 브랜드별로 풀어야 정확함
// (projectCreationOptions와 동일 알고리즘 — 2026-06-02 "프로젝트 생성은 부여받은
// 권역에서만" 결정을 생성뿐 아니라 조회에도 대칭 적용, 2026-07-06 QA-STD-016
// 감사에서 비대칭 발견·수정). 이 브랜드에 대한 region 제한이 없으면(계정이 이
// 브랜드의 region을 하나도 안 가짐) null — 제한 없음.
function regionCountriesForBrand(scope: AllowedScope, brand: string): string[] | null {
  if (!scope.regions?.length) return null;
  const brandRegionIds = rhqRegionIdsForBrand(brand);
  const regionIds = scope.regions.filter((r) => brandRegionIds.includes(r));
  if (!regionIds.length) return null;
  return [...new Set(regionIds.flatMap((r) => countriesForRhq(r)))];
}

// Role→project gating (2026-07-02 결정: scope + vendor는 멤버십): a project is
// readable when its brand×country sits inside the account scope. brand=null is
// COMMON (D5와 동일 — 모든 브랜드 계정 가시, region 판정도 브랜드를 특정 못 하니
// 같이 스킵); country=null도 통과(스키마상 필수지만 방어적). Pure so the gate
// (lib/scope/server.ts::assertProjectInScope) stays unit-testable.
export function projectInScope(
  scope: AllowedScope,
  project: { brand?: string | null; country?: string | null },
): boolean {
  if (scope.all) return true;
  if (scope.brands?.length && project.brand && !scope.brands.includes(project.brand)) {
    return false;
  }
  if (project.brand && project.country) {
    const regionCountries = regionCountriesForBrand(scope, project.brand);
    if (regionCountries && !regionCountries.includes(project.country)) return false;
  }
  if (
    scope.countries?.length &&
    project.country &&
    !scope.countries.includes(project.country)
  ) {
    return false;
  }
  return true;
}

// Standard prompt catalog visibility for the read-only viewer (/standard/prompts).
//
// Unlike the scoped domain tables, the root standard catalog (`prompts` under
// STANDARD_ROOT_PROJECT_ID) tags brand-agnostic ("공통") prompts with the
// umbrella brand 'HMG' — NOT null (verified 2026-06-11: all rows are HMG or a
// marque, none null). So BOTH null and the umbrella brand count as common and
// stay visible to every brand-scoped user; a marque-tagged prompt is visible
// only to users whose brand scope includes that marque. region/country don't
// apply — the catalog carries no such columns. Mirrors the SQL brand condition
// in lib/db/repositories/standards.ts::listStandardCatalogScoped.
export function standardPromptInScope(
  scope: AllowedScope,
  brand: string | null | undefined,
): boolean {
  if (scope.all) return true;
  if (brand == null || brand === UMBRELLA_BRAND) return true; // 공통
  if (scope.brands?.length) return scope.brands.includes(brand);
  return true; // no brand scope set → unrestricted
}

// --- Dashboard filter UI policy ---------------------------------------------
// Per GGMD planning Use Case (page 4981000, v16), the dashboard filter row
// renders brand/region/country only — 차종(model) is excluded from the
// standard KPI / intent dashboard scope (it lives in project creation).
// Filters the user cannot change render as disabled with the pinned scope
// value visible; the spec is explicit that locked dimensions stay visible so
// the user can see *why* the data is narrowed.

const SCOPE_KEY: Record<FilterDimension, "brands" | "regions" | "countries"> = {
  brand: "brands",
  region: "regions",
  country: "countries",
};

// Authority gate from the planning's Use Case matrix (page 4981000, v16).
// `true` = the role is not allowed to pick this dimension (renders disabled).
//
// Matrix (Overview / 통합 대시보드):
//   admin   → All Brands × All RHQ × All Country  → no lock
//   hq      → Own Brand × All RHQ × All Country   → brand locked
//   region  → Own Brand × Own RHQ × All Country   → brand + region locked
//   country → Own Brand × Own RHQ × Own Country   → all three locked
//
// Defense in depth on top of the singleton check in resolveDimensionState: even
// if a profile happens to leave a dimension unconstrained (brands undefined),
// the role's authority limit still pins the UI. The data layer must still be
// configured with the matching singleton scope — this is UI policy, not data
// enforcement.
export function isDimensionLockedByRole(
  role: Role,
  dim: FilterDimension,
): boolean {
  if (role === "admin") return false;
  if (dim === "brand") return true; // every non-admin role has Own Brand
  if (role === "hq") return false;
  if (role === "region") return dim === "region";
  if (role === "country") return dim === "region" || dim === "country";
  // vendor / website: no role-level lock beyond brand — their region/country
  // narrowing is profile-driven (a singleton scope pins the dimension via
  // resolveDimensionState), so a country-scoped website account still renders
  // its country pinned without a role rule here.
  return false;
}

export interface DimensionState {
  // Whether the user may change this filter. False = render as disabled.
  editable: boolean;
  // Options the user may select. When `editable` is false this is the single
  // pinned value (or empty); when true it's the user's allowed subset, or the
  // full DIMENSION_UNIVERSE if the dimension is unconstrained.
  options: readonly string[];
  // Currently-resolved value: pinned when locked, validated `requested` when
  // editable, otherwise undefined (meaning "no narrowing on this dimension").
  value: string | undefined;
}

export function resolveDimensionState(
  user: User,
  dim: FilterDimension,
  requested?: string,
): DimensionState {
  const scope = user.scope;
  const allowed = scope[SCOPE_KEY[dim]];
  const scopePins = !scope.all && allowed && allowed.length === 1;
  const lockedByRole = isDimensionLockedByRole(user.role, dim);

  if (lockedByRole) {
    // Role can't choose this dimension. If scope happens to pin a value, show
    // it; otherwise show empty (placeholder) — still disabled.
    return {
      editable: false,
      options: allowed && allowed.length ? allowed : [],
      value: scopePins ? allowed![0] : undefined,
    };
  }

  // `scope.all` and `undefined`/empty allowed-array both mean unrestricted —
  // matches how deriveScopeFilter passes undefined through to the data layer.
  const unrestricted = scope.all || !allowed || allowed.length === 0;
  if (unrestricted) {
    const options = DIMENSION_UNIVERSE[dim];
    return {
      editable: true,
      options,
      value: requested && options.includes(requested) ? requested : undefined,
    };
  }
  if (allowed.length === 1) {
    return { editable: false, options: allowed, value: allowed[0] };
  }
  return {
    editable: true,
    options: allowed,
    value: requested && allowed.includes(requested) ? requested : undefined,
  };
}

export interface DashboardFilterRequest {
  brand?: string;
  region?: string;
  country?: string;
}

// --- Overview-specific helpers --------------------------------------------
// The dashboard's GEO snapshot (권역별 가시성 비교) is only meaningful for
// users who have access to more than one region. Region/country-scoped
// users already have their region pinned by the filter row, so the card
// would just show one bar — hide it for them. Decision 2026-06-02 (Q3-v2).
export function showsGeoSnapshot(user: User): boolean {
  if (user.scope.all) return true;
  const regions = user.scope.regions ?? [];
  return regions.length === 0 || regions.length > 1;
}

// The GEO map view (시장 지도 — choropleth + the snapshot table beside it) is a
// market-positioning lens for HQ-and-above: 본사(hq)는 전 권역, 권역 담당(region/
// RHQ)은 자기 권역으로 자동 줌(데이터가 이미 scope로 좁혀져 옴), admin은 전체.
// 국가 담당(country)은 단일 국가라 지도가 한 칸으로 무의미 → 제외. vendor 역시 제외
// (표준 대시보드 비노출). Decision 2026-06-22 (HQ·RHQ·Admin 지도 노출).
export function showsGeoMap(user: User): boolean {
  if (user.scope.all) return true; // admin / 무제한 스코프
  return user.role === "hq" || user.role === "region";
}

// --- Project creation option scoping --------------------------------------
// "프로젝트 생성은 부여받은 권역에서만 생성할 수 있도록" (resolved 2026-06-02).
// The /projects/new form's brand + country selects show only the values
// the calling user has authority over — derived from the RHQ 정본 (brand ×
// 권역 → ISO country), which is brand-specific (e.g. Mexico is 북아메리카 for
// Hyundai but 중남미 for Kia):
//   - brands    = scope.brands (or GEO_BRANDS if scope.all / undefined)
//   - countries = ∪{ countriesForRhq(regionId) : brand ∈ allowedBrands,
//                    regionId ∈ that brand's allowed 권역 } ∩ scope.countries
// Returning empty arrays effectively blocks creation — vendor accounts
// without any scope assignment fall here, which matches the spec ("admin
// assigns scope on vendor creation").
export interface ProjectCreationOptions {
  brands: readonly string[];
  countries: readonly string[];
}

export function projectCreationOptions(user: User): ProjectCreationOptions {
  const scope = user.scope;
  const allBrands = scope.all || !scope.brands || scope.brands.length === 0;
  const allowedBrands = allBrands ? GEO_BRANDS : (scope.brands ?? []);

  const allRegions = scope.all || !scope.regions || scope.regions.length === 0;

  // For each allowed brand, take its allowed 권역 (all of the brand's RHQ
  // regions when region scope is unrestricted, else the scoped region ids that
  // belong to that brand) and union their ISO countries. Region ids are
  // brand-prefixed so the per-brand filter naturally drops other brands' ids.
  const fromRegions = new Set<string>();
  for (const brand of allowedBrands) {
    const brandRegionIds = rhqRegionIdsForBrand(brand);
    const regionIds = allRegions
      ? brandRegionIds
      : (scope.regions ?? []).filter((r) => brandRegionIds.includes(r));
    for (const rid of regionIds) {
      for (const c of countriesForRhq(rid)) fromRegions.add(c);
    }
  }
  const byRegion = [...fromRegions];

  // Intersect with country scope if explicitly set; otherwise use the
  // region-derived list.
  const allCountries = scope.all || !scope.countries || scope.countries.length === 0;
  const allowedCountries = allCountries
    ? byRegion
    : (scope.countries ?? []).filter((c) => byRegion.length === 0 || byRegion.includes(c));

  return {
    brands: allowedBrands,
    countries: allowedCountries,
  };
}

// Intersect the user's URL-supplied selection with the server-derived scope.
// A selection outside the user's allowed values is silently dropped — never
// trust client params to widen access (scope-gateway / access-control).
export function resolveEffectiveFilter(
  user: User,
  request: DashboardFilterRequest,
): ScopeFilter {
  const base = deriveScopeFilter(user);
  const out: ScopeFilter = {};
  for (const dim of ["brand", "region", "country"] as const) {
    const state = resolveDimensionState(user, dim, request[dim]);
    const key = SCOPE_KEY[dim];
    if (state.value) {
      out[key] = [state.value];
    } else if (base[key]) {
      out[key] = base[key];
    }
  }
  return out;
}
