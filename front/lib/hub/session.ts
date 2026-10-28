import "server-only";
import { cookies } from "next/headers";
import type { User } from "@/lib/auth/types";
import { describeHghError, isHghApiError } from "@/lib/hgh/errors";
import { hubMe, type HubUser } from "./client";
import { HUB_SESSION_COOKIE } from "./cookie";

// The local mode's signed-in top-level administrator (HUB login, 2026-10-27). Since 2026-10-28 every page
// needs it: the local session is this administrator, or none (lib/auth/session.ts).

export async function hubToken(): Promise<string | null> {
  return (await cookies()).get(HUB_SESSION_COOKIE)?.value || null;
}

export function hubSessionUser(u: HubUser): User {
  // operator none: the legacy cost actions (project create, runs) stay closed; scope: everything, as the local reader.
  return { id: u.id, email: u.email ?? u.login, role: "admin", scope: { all: true }, operator: "none", menuGroups: null };
}

/** The administrator behind the cookie, or null (no cookie, or a refused, expired or revoked one). */
export async function hubAdminUser(): Promise<User | null> {
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
