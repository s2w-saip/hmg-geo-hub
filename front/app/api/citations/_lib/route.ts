import "server-only";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";
import { hghErrorResponse } from "@/lib/hgh/errors";
import {
  citationRouteFilters,
  citationRouteGate,
  citationRouteTarget,
  isCitationsApi,
  type CitationRouteTarget,
  type CitationRouteUser,
  type CitationsContext,
} from "@/lib/hgh/adapters/citations";
import type { StandardFilters } from "@/lib/scope/result-adapter";

// Shared opening of the citation BFF routes (unit U7): /api/citations/domains (list),
// /api/citations/domains/[skey] (drilldown), /api/citations/domains/export (BG-22 file).
//
// Order, on BOTH sources (a route handler has no (dash) layout above it; U4 verification F1):
//   1. target      projectId (uuid) -> project, surface=website -> website, else global;
//                  a projectId that is not a uuid                           -> 422 invalid_value
//   2. session                                                              -> 401 unauthenticated
//   3. place gate  canReadAnalysis(role, menuGroups, "analysis", surface)   -> 403 forbidden
//   4. project     demo project admin only, then HGH_SOURCE_SESSION=api -> GET /v1/projects/{id},
//                  legacy -> project exists and (admin or active member)   -> 404 not_found
//   5. source      HGH_SOURCE_<G2|G3|G6> must be api: the legacy screens carry every row and its
//                  drilldown inline and never call these routes             -> 404 not_found
// Filters are re-read from the request exactly as the screen's page read its URL
// (citationRouteFilters); scope comes from the session only.

const noStore = { "Cache-Control": "no-store" };

export function routeFail(status: number, code: string): NextResponse {
  return NextResponse.json({ error: { code } }, { status, headers: noStore });
}

export function routeJson(body: unknown): NextResponse {
  return NextResponse.json(body, { headers: noStore });
}

/** The legacy project page gate (analysis/_lib/auth-and-locks.ts): exists and admin or active member. */
async function legacyProjectAllowed(id: string, user: CitationRouteUser): Promise<boolean> {
  const [project, membership] = await Promise.all([cachedProjectById(id), cachedMembership(id, user.id)]);
  if (!project) return false;
  return user.role === "admin" || membership?.status === "active";
}

export interface OpenedCitationRoute {
  target: CitationRouteTarget;
  filters: StandardFilters;
  ctx: CitationsContext;
  competitor: string[];
}

/** Steps 1..5 of the header. Returns the route context, or the error response to send. */
export async function openCitationRoute(q: URLSearchParams): Promise<OpenedCitationRoute | Response> {
  const target = citationRouteTarget(q);
  if (!target) return routeFail(422, "invalid_value");
  const session = await getSession();
  if (!session) return routeFail(401, "unauthenticated");
  const user: CitationRouteUser = {
    id: session.user.id,
    role: session.user.role,
    scope: session.user.scope ?? null,
    menuGroups: session.user.menuGroups ?? null,
  };
  try {
    const gate = await citationRouteGate(user, target.surface, target.projectId, legacyProjectAllowed);
    if (!gate.ok) return routeFail(gate.status, gate.status === 403 ? "forbidden" : "not_found");
  } catch (e) {
    return hghErrorResponse(e);
  }
  if (!isCitationsApi(target.surface)) return routeFail(404, "not_found");
  return { target, ...citationRouteFilters(q, target, user) };
}
