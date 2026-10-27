import "server-only";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";
import { hghErrorResponse } from "@/lib/hgh/errors";
import {
  citationRouteGate,
  citationRouteTarget,
  isCitationsApi,
  type CitationRouteTarget,
  type CitationRouteUser,
} from "@/lib/hgh/citation-route";

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
//   5. source      HGH_SOURCE_<G2|G3|G6> must be api                        -> 404 not_found
// Then each route is a thin proxy to its screen (back/bff/screens/citation.py): the request's
// params as they came (the server re-reads the filters exactly as the screen's page read its URL)
// plus the route context (ctx.surface, ctx.project_id, ctx.role).

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

export type CitationScreenQuery = Record<string, string | string[] | null | undefined>;

export interface OpenedCitationRoute {
  target: CitationRouteTarget;
  /** The screen query: the request's params (a repeated key as a list) + the route context. */
  query: CitationScreenQuery;
}

/** Steps 1..5 of the header. Returns the screen query, or the error response to send. */
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
  const query: CitationScreenQuery = {};
  for (const key of new Set(q.keys())) {
    const all = q.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }
  query["ctx.surface"] = target.surface;
  query["ctx.project_id"] = target.projectId ?? null;
  query["ctx.role"] = user.role;
  return { target, query };
}
