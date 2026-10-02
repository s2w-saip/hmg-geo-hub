import "server-only";

// Session from GET /v1/auth/me (unit U2, design 1.3), returned in exactly the shape
// lib/auth/session.ts::getSession has always returned (Session{user: User}). Selected by
// the facade in lib/auth/session.ts when HGH_SOURCE_SESSION=api (D8); legacy stays default.
//
// Field map (API SessionData -> lib/auth/types User)
//   user_id          -> user.id          = JWT sub = legacy profiles.id (transition gate, design 1.3)
//   email            -> user.email       account email (legacy: claims.email ?? profile.email)
//   role             -> user.role        same enum
//   operator         -> user.operator    backend already forces vendor -> "none" (core.auth)
//   menu_groups      -> user.menuGroups  legacy normalization: unknown values dropped, null or
//                                        empty -> null (= role default, route-policy)
//   scope.all        -> scope.all        backend: scope_all OR admin (Q16)
//   scope.brands     -> scope.brands     null -> undefined; [] (deny) -> [UMBRELLA_BRAND]  (1)
//   scope.regions    -> scope.regions    null -> undefined; list as is (raw account regions)
//   scope.account_countries             the raw account countries (stored form) -> scope.countries
//                                        when non-empty (2)
//   scope.countries  -> scope.countries  otherwise: null -> undefined; [] (deny) ->
//                                        [SCOPE_DENY_COUNTRY] (1); a list -> undefined when the
//                                        account has no raw countries (regions only), kept as is
//                                        when the backend predates account_countries (2)
//   display_name, is_qa_reviewer        not part of User (dropped)
//   401 (unauthenticated, token_expired, no_account) or no token -> null
//                                        (legacy: no claims / no profile -> null = no access)
//   anything else (5xx, timeout)        thrown (legacy: a DB error was thrown to the boundary)
//
// (1) Empty arrays mean opposite things. Backend: [] = deny. Front (scope-policy isInScope,
//     resolveDimensionState, db/scoped scopeWhere, standard-filters): [] = no restriction
//     (`?.length` checks). Passing [] through would WIDEN every legacy consumer while the
//     other screen groups still read the legacy data layer (D8 mixed period). So deny is
//     written in a form the front predicates already read as deny:
//       brands    -> [UMBRELLA_BRAND] ("HMG"): backend brand_allowed(()) keeps only brand-less
//                    rows; the front treats NULL and the umbrella brand as common, so this keeps
//                    common rows only, and a locked brand chip shows HMG as the legacy
//                    umbrella-only profile did.
//       countries -> ["ZZ"]: ISO 3166 user-assigned "unknown" code. Matches no row, and
//                    Intl.DisplayNames accepts it (the scope chips format country codes with it;
//                    an arbitrary token would throw RangeError).
//     The deny markers must never become a CHOICE or pass a VALIDATION (verification F1).
//     projectCreationOptions (scope-policy) keeps the scope.countries entries that lie in the
//     region-derived country set, but keeps ALL of them when that set is empty, which is what an
//     unresolvable account region yields. So ZZ became a creation country that the legacy
//     creation action accepted (legacy: no country choice, no creation). The backend gives such
//     an account no creation country either (creation_options), so whenever the marker would be
//     offered, the front closes creation: operator -> "none" (canCreateProject gates the creation
//     page and action before options are computed). The scope itself is left alone: dropping the
//     regions to empty the set would open the region filter (UI) of non-region roles, and nothing
//     can fix the case where no allowed brand has an RHQ region (brands deny as well). Side
//     effect, a narrowing for an account the backend denies every global and website read:
//     intent collection and prompt runs close too (canOperateProject). Asserted in
//     lib/auth/session.test.ts ("api only ever narrows", "F1 repro").
// (2) scope.countries (backend) is the Q10 EFFECTIVE list (direct countries uppercased, else
//     the regions expanded); the legacy User carried the RAW account countries (profiles.
//     countries). The front reads the raw form: the dedicated site codes of hmg-geo #326 #328
//     #329 (worldwide, CPO, HYUNDAI-N: scopeForGeoSurface, hasGlobalSurface,
//     effectiveScopeCountries, effectiveWebsiteScopeCountries, websiteScopeBrands and the filter
//     panel's viewScope) match the stored spelling, and a regions-only account had no country
//     list at all. So scope.account_countries (the stored account countries, core 8; null = the
//     account lists none) is the source (sync S1 FA-1):
//       account_countries non-empty -> that list as is (exact legacy value, stored order)
//       otherwise                   -> null countries -> undefined; [] (deny) -> [ZZ] (1);
//                                      a list (regions expanded) -> undefined (legacy: none)
//       account_countries absent    -> a backend before core 8: the effective list is kept, a
//                                      narrowing (the case this note described before FA-1)
//     The data boundary stays on the backend (DataScope.countries, the surface split of BE-6);
//     the raw list only drives what the legacy front consumers show and hide, as it did.
//
// Known remaining differences (asserted in lib/auth/session.test.ts, all narrowing): the
// umbrella brand is dropped from non-empty brand lists (HMG-tagged projects and the HMG option
// leave a [HMG, Kia] account, whose brand chip then pins Kia); an unresolvable account region
// with no raw countries is denied (legacy fell through to no country restriction) and, when
// that would put ZZ among the creation countries, its operator closes to none (F1). Menus,
// landing and route access never differ (menu_groups is the derived value of BE-7, the same
// rule as lib/auth/menu-groups.ts effectiveMenuGroups).
import { projectCreationOptions } from "@/lib/auth/scope-policy";
import type { AllowedScope, MenuGroup, Session, User } from "@/lib/auth/types";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import type { components } from "../api-types";
import { hghGet, type HghAuthMode } from "../client";
import { isHghApiError } from "../errors";

export type SessionData = components["schemas"]["SessionData"];
export type SessionScope = components["schemas"]["SessionScope"];

/** Front form of a backend "deny all countries" scope ([]): matches no row. */
export const SCOPE_DENY_COUNTRY = "ZZ";
/** Front form of a backend "deny all brands" scope ([]): brand-less (common) rows only. */
export const SCOPE_DENY_BRAND = UMBRELLA_BRAND;

const VALID_GROUPS: ReadonlySet<MenuGroup> = new Set<MenuGroup>(["standard", "website", "project", "admin"]);

/** Same rule as the legacy session: keep valid groups; null or empty -> null (role default). */
export function normalizeMenuGroups(groups: readonly string[] | null | undefined): MenuGroup[] | null {
  if (!groups || groups.length === 0) return null;
  const kept = groups.filter((g): g is MenuGroup => VALID_GROUPS.has(g as MenuGroup));
  return kept.length ? kept : null;
}

/** SessionScope (backend) -> AllowedScope (front semantics). See header (1) and (2). */
export function toAllowedScope(s: SessionScope): AllowedScope {
  if (s.all) return { all: true, brands: undefined, regions: undefined, countries: undefined };
  return {
    all: false,
    brands: s.brands === null ? undefined : s.brands.length ? [...s.brands] : [SCOPE_DENY_BRAND],
    regions: s.regions === null || s.regions.length === 0 ? undefined : [...s.regions],
    countries: frontCountries(s),
  };
}

/** scope.countries of the front User: the raw account countries first (header (2)). */
function frontCountries(s: SessionScope): string[] | undefined {
  const raw = s.account_countries;
  if (raw?.length) return [...raw];
  if (s.countries === null) return undefined;
  if (s.countries.length === 0) return [SCOPE_DENY_COUNTRY];
  // No raw countries (null or []): the list is the regions' expansion, which legacy never had.
  // Absent field (backend before core 8): keep the effective list, a narrowing.
  return raw === undefined ? [...s.countries] : undefined;
}

/** True when a deny marker would be offered as a project creation country (header (1), F1). */
export function denyMarkerInCreationChoices(user: User): boolean {
  return projectCreationOptions(user).countries.includes(SCOPE_DENY_COUNTRY);
}

/** SessionData -> the legacy Session shape. */
export function toSession(data: SessionData): Session {
  const user: User = {
    id: data.user_id,
    email: data.email ?? "",
    role: data.role,
    scope: toAllowedScope(data.scope),
    operator: data.role === "vendor" ? "none" : (data.operator ?? "none"),
    menuGroups: normalizeMenuGroups(data.menu_groups),
  };
  // F1: a deny marker must never be a creation choice; close creation instead (header (1)).
  if (user.operator !== "none" && denyMarkerInCreationChoices(user)) user.operator = "none";
  return { user };
}

/**
 * GET /v1/auth/me. null when there is no usable session (no token, or 401 from the
 * backend). Other failures are thrown as HghApiError.
 */
export async function fetchSessionData(auth: HghAuthMode = "session"): Promise<SessionData | null> {
  try {
    const res = await hghGet("/v1/auth/me", { auth });
    return res.data;
  } catch (e) {
    if (isHghApiError(e) && e.status === 401) return null;
    throw e;
  }
}

/** The api-source getSession body (the facade adds the request memo). */
export async function getSessionFromApi(): Promise<Session | null> {
  const data = await fetchSessionData();
  return data ? toSession(data) : null;
}
