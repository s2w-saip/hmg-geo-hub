import "server-only";
import { cache } from "react";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { hghSource } from "@/lib/hgh/client";
import { getSessionFromApi } from "@/lib/hgh/adapters/session";
import { effectiveMenuGroups } from "./menu-groups";
import type { AllowedScope, Session, User } from "./types";
import { localReadOnly } from "@/lib/local-readonly";
import { hubAdminUser } from "@/lib/hub/session";

// Resolves the authenticated user into our domain Session.
//
// Two sources behind one signature (D8 flag HGH_SOURCE_SESSION = api | legacy, default
// legacy; read per request so a flag flip needs no code change):
//   - api:    GET /v1/auth/me with the Supabase access token (lib/hgh/adapters/session.ts,
//             field map in its header). The backend verifies the JWT against JWKS and owns
//             role, operator, scope and menu groups.
//   - legacy: identity from Supabase Auth, role + allowed scope from the server-controlled
//             `profiles` table (NOT user_metadata). Kept unchanged as the rollback path until
//             the closing clean-up (design 4.4).
// Either way this is the single source feeding the route guard, the SNB and every scope
// check, and "no session" is null (the (dash) layout sends it to /login).
//
// Wrapped in React cache(): within a single request the DashLayout, the page it
// renders, and any nested layout each call getSession(). cache() collapses them
// into ONE verification + ONE profile query (or ONE /v1/auth/me) per request.
export const getSession = cache(async (): Promise<Session | null> => {
  if (localReadOnly()) {
    // Only the HUB login (lib/hub/session.ts) opens the local mode (2026-10-28): without one there is no
    // session, and the layouts send the page to /login.
    const admin = await hubAdminUser();
    return admin ? { user: admin } : null;
  }
  return hghSource("SESSION") === "api" ? getSessionFromApi() : getSessionLegacy();
});

// Legacy source (unchanged body of the previous getSession).
//
// Identity is verified via getClaims() rather than getUser(): with asymmetric
// JWT signing keys the access token is validated locally (WebCrypto, no network);
// only a legacy symmetric secret falls back to an Auth-server round-trip (same
// cost as the old getUser()). Either way the JWT is securely verified: getClaims
// is Supabase's recommended server-side verification, equivalent to getUser.
async function getSessionLegacy(): Promise<Session | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;

  // Authenticated but no profile = no role assigned → no access.
  const profile = await profileRepository.getByUserId(claims.sub);
  if (!profile) return null;

  const scope: AllowedScope = {
    all: profile.scopeAll,
    brands: profile.brands ?? undefined,
    regions: profile.regions ?? undefined,
    countries: profile.countries ?? undefined,
  };

  // vendor (외부 수행사) is operator-OFF permanently (scenario 3-2): normalize
  // here regardless of the stored value so a mis-set profile can never grant a
  // vendor cost-action authority. Defense-in-depth alongside the admin action's
  // write-time guard.
  const operator =
    profile.role === "vendor" ? "none" : profile.operator ?? "none";

  // 메뉴 그룹 화이트리스트(좁히기 전용) — 로그인 착지(actions.ts)와 같은 함수.
  const menuGroups = effectiveMenuGroups(profile.menuGroups, scope);

  const appUser: User = {
    id: claims.sub,
    email: claims.email ?? profile.email ?? "",
    role: profile.role,
    scope,
    operator,
    menuGroups,
  };
  return { user: appUser };
}
