import "server-only";
import { cache } from "react";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { profileRepository } from "@/lib/db/repositories/profiles";
import type { AllowedScope, MenuGroup, Session, User } from "./types";

function assignedValues(values: string[] | null): string[] | undefined {
  const assigned = values?.map((value) => value.trim()).filter(Boolean);
  return assigned?.length ? assigned : undefined;
}

// An entirely unassigned profile is not an unrestricted grant. Preserve
// administrator-assigned scopeAll and existing partial/multi-brand scopes:
// role-based requirements for specific dimensions are a separate policy.
function hasAssignedScope(scope: AllowedScope): boolean {
  return scope.all || Boolean(scope.brands?.length || scope.regions?.length || scope.countries?.length);
}

// Resolves the authenticated user into our domain Session: identity comes from
// Supabase Auth, role + allowed scope come from the server-controlled `profiles`
// table (NOT user_metadata). This is the single source feeding both the scope
// gateway (lib/scope/server) and DB scope enforcement.
//
// Wrapped in React cache(): within a single request the DashLayout, the page it
// renders, and any nested layout each call getSession(). cache() collapses them
// into ONE verification + ONE profile query per request — previously each caller
// paid a fresh Auth round-trip + DB hit, the dominant per-navigation latency.
//
// Identity is verified via getClaims() rather than getUser(): with asymmetric
// JWT signing keys the access token is validated locally (WebCrypto, no network);
// only a legacy symmetric secret falls back to an Auth-server round-trip (same
// cost as the old getUser()). Either way the JWT is securely verified — getClaims
// is Supabase's recommended server-side verification, equivalent to getUser.
export const getSession = cache(async (): Promise<Session | null> => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;

  // Authenticated but no profile = no role assigned → no access.
  const profile = await profileRepository.getByUserId(claims.sub);
  if (!profile) return null;

  const scope: AllowedScope = {
    all: profile.role !== "vendor" && profile.scopeAll,
    brands: assignedValues(profile.brands),
    regions: assignedValues(profile.regions),
    countries: assignedValues(profile.countries),
  };
  // Vendors are membership-only, so they can authenticate without scope axes.
  if (profile.role !== "vendor" && !hasAssignedScope(scope)) return null;

  // vendor (외부 수행사) is operator-OFF permanently (scenario 3-2): normalize
  // here regardless of the stored value so a mis-set profile can never grant a
  // vendor cost-action authority. Defense-in-depth alongside the admin action's
  // write-time guard.
  const operator =
    profile.role === "vendor" ? "none" : profile.operator ?? "none";

  // 메뉴 그룹 화이트리스트(좁히기 전용) — 빈 배열은 null 과 동일하게 "제한 없음"
  // 취급(route-policy). 유효 그룹만 통과시켜 오타/레거시 값이 축소를 깨지 않게 한다.
  const VALID_GROUPS = new Set<MenuGroup>(["standard", "website", "project", "admin"]);
  const menuGroups =
    profile.menuGroups && profile.menuGroups.length
      ? (profile.menuGroups.filter((g): g is MenuGroup =>
          VALID_GROUPS.has(g as MenuGroup),
        ) as MenuGroup[])
      : null;

  const appUser: User = {
    id: claims.sub,
    email: claims.email ?? profile.email ?? "",
    role: profile.role,
    scope,
    operator,
    menuGroups: menuGroups && menuGroups.length ? menuGroups : null,
  };
  return { user: appUser };
});
