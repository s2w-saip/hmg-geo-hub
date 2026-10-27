import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isDemoProject } from "@/lib/demo";
import { hghSource } from "@/lib/hgh/client";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { fetchProjectGate } from "@/lib/hgh/adapters/project-gate";
import { canReadAnalysis, type AnalysisArea } from "@/lib/hgh/analysis-access";
import type { PanelFilterOptions } from "@/lib/hgh/filter-types";
import type { Surface } from "@/lib/hgh/query";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";
import { screenGet } from "@/lib/screen";

// BFF: filter panel options loaded when the panel opens (decision D4, Q7; unit U4).
//
//   GET /api/filters/options?area=<dashboard|analysis|funnel|prompts>&surface=<global|website|
//       project>[&project_id=<uuid>][&time=<A..B>][&brand=<A~B>][&engine=<A~B>]
//   200 {options: PanelFilterOptions}   (the option props the server pages pass)
//
// Gates, in this order (a route handler has no (dash) layout above it):
//   1. validation   area and surface known; project_id a UUID on every non-global surface
//                   (required on project)                                  -> 422 invalid_value
//   2. session                                                             -> 401 unauthenticated
//   3. place gate   canReadAnalysis(role, menuGroups, area, surface)       -> 403 forbidden
//   4. project      the project pages' gate: demo project admin-only, then the project gate read
//                   (HGH_SOURCE_SESSION=api) or project exists and (admin or active member)
//                                                                          -> 404 not_found
// Then a thin proxy to the screen shared/panel-options (back/bff/screens/shared.py), which reads
// the applied URL values that shape the options (time, brand; engine on project).
export const dynamic = "force-dynamic";

const AREAS: ReadonlySet<string> = new Set<AnalysisArea>(["dashboard", "analysis", "funnel", "prompts"]);
const SURFACES: ReadonlySet<string> = new Set<Surface>(["global", "website", "project"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, code: string) =>
  NextResponse.json({ error: { code } }, { status, headers: noStore });

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSession>>>["user"];

/** The project pages' gate (see header 4). */
async function projectPageAllowed(id: string, user: SessionUser): Promise<boolean> {
  if (isDemoProject(id) && user.role !== "admin") return false;
  // The gate runs alone in this request: the light read (no detail summary statements).
  if (hghSource("SESSION") === "api") return (await fetchProjectGate(id, { light: true })) !== null;
  const [project, membership] = await Promise.all([cachedProjectById(id), cachedMembership(id, user.id)]);
  if (!project) return false;
  return user.role === "admin" || membership?.status === "active";
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const area = q.get("area") ?? "";
  const surface = q.get("surface") ?? "";
  const rawProjectId = q.get("project_id");
  if (!AREAS.has(area) || !SURFACES.has(surface)) return fail(422, "invalid_value");
  if (surface !== "global" && rawProjectId !== null && !UUID_RE.test(rawProjectId)) return fail(422, "invalid_value");
  if (surface === "project" && rawProjectId === null) return fail(422, "invalid_value");
  const projectId = surface === "global" ? undefined : (rawProjectId ?? undefined);

  const session = await getSession();
  if (!session) return fail(401, "unauthenticated");
  const user = session.user;
  if (!canReadAnalysis(user, area as AnalysisArea, surface as Surface)) return fail(403, "forbidden");

  // Only the parameters that shape options are passed on.
  const sp: Record<string, string> = {};
  for (const key of surface === "project" ? ["time", "brand", "engine"] : ["time", "brand"]) {
    const v = q.get(key);
    if (v) sp[key] = v;
  }

  try {
    if (surface === "project" && !(await projectPageAllowed(projectId!, user))) return fail(404, "not_found");
    const options = await screenGet<PanelFilterOptions>("shared/panel-options", { ...sp, surface, project_id: projectId });
    return NextResponse.json({ options }, { headers: noStore });
  } catch (e) {
    return hghErrorResponse(e);
  }
}
