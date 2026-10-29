import "server-only";
import type { AllowedScope, User } from "@/lib/auth/types";
import { describeHghError, isHghApiError } from "@/lib/hgh/errors";
import { hubMe, type HubUser } from "./client";
import { hubRequestToken } from "./token";

// The local mode's signed-in HUB account (HUB login, 2026-10-27; every role since 2026-10-29). Every page needs
// it: the local session is this account, or none (lib/auth/session.ts). Its role and scope come from the BFF on
// every request, so a change on the Admin screen applies at the next page.

export async function hubToken(): Promise<string | null> {
  return hubRequestToken();
}

/** The front's scope shape: axes the account does not narrow are left out. */
function scopeOf(u: HubUser): AllowedScope {
  if (u.scope.all) return { all: true };
  const some = (v?: string[]) => (v && v.length ? v : undefined);
  return { all: false, brands: some(u.scope.brands), regions: some(u.scope.regions), countries: some(u.scope.countries) };
}

export function hubSessionUser(u: HubUser): User {
  // operator none: the legacy cost actions (project create, runs) stay closed for every HUB account.
  return {
    id: u.id,
    email: u.email ?? u.login,
    role: u.role,
    scope: scopeOf(u),
    operator: "none",
    menuGroups: null,
    ...(u.mustChangePassword ? { mustChangePassword: true } : {}),
  };
}

/** The account behind the cookie, or null (no cookie, or a refused, expired or revoked one). */
export async function hubUser(): Promise<User | null> {
  const token = await hubToken();
  if (!token) return null;
  try {
    const user = await hubMe(token);
    return user ? hubSessionUser(user) : null;
  } catch (e) {
    // The BFF is unreachable: no session, so the page goes to the login (which reports the failure).
    console.warn("[hub] session check failed", isHghApiError(e) ? describeHghError(e) : e instanceof Error ? e.name : typeof e);
    return null;
  }
}
