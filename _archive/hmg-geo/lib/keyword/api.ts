import "server-only";
import { getSession } from "@/lib/auth/session";
import type { User } from "@/lib/auth/types";

// Shared guard for the /api/keyword/* routes. These hit PAID external APIs
// (DataForSEO + OpenRouter) and back the admin-only /admin/keyword-tools page,
// so the routes must enforce the same gate the DashLayout applies to the page —
// a direct POST from a non-admin (or anonymous) caller is rejected here.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function requireAdminUser(): Promise<User> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "unauthorized");
  if (session.user.role !== "admin") throw new HttpError(403, "forbidden");
  return session.user;
}

// Any authenticated user. Backs the Google Keyword intent view, which is
// reachable by NON_VENDOR roles (표준 surface) and project members (project
// surface) — both already auth-gated, so a valid session is the right bar.
// (The DataForSEO calls are interactive and low-cost: ~$0.002–0.011 each.)
export async function requireUser(): Promise<User> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "unauthorized");
  return session.user;
}
