import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import { isDemoProject } from "@/lib/demo";
import { hghSource } from "@/lib/hgh/client";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { fetchProjectGate } from "@/lib/hgh/adapters/project-gate";
import {
  canReadAnalysis,
  isAnalysisApi,
  loadPanelOptions,
  type AnalysisArea,
  type PanelFilterOptions,
} from "@/lib/hgh/adapters/filters";
import type { Surface } from "@/lib/hgh/query";
import { fetchProjectMeasuredEngines } from "@/lib/scope/server";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import {
  listMeasuredRegions,
  listMeasuredScopeMatrix,
  listMeasuredStandardLanguages,
} from "@/lib/db/repositories/scope-aggregates";
import {
  listMeasuredLanguages,
  listWebsiteCountries,
  listWebsiteScopeMatrix,
} from "@/lib/db/repositories/website-sites";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";

// BFF: filter panel options loaded when the panel opens (decision D4, Q7; unit U4).
//
//   GET /api/filters/options?area=<dashboard|analysis|funnel|prompts>&surface=<global|website|
//       project>[&project_id=<uuid>][&time=<A..B>][&brand=<A~B>][&engine=<A~B>]
//   200 {options: PanelFilterOptions}   (the option props the server pages used to pass)
//
// Gates, in this order, on BOTH sources (a route handler has no (dash) layout above it):
//   1. validation   area and surface known; project_id a UUID on every non-global surface
//                   (required on project)                                  -> 422 invalid_value
//   2. session                                                             -> 401 unauthenticated
//   3. place gate   canReadAnalysis(role, menuGroups, area, surface): the ROUTES rule of the
//                   screen family ((dash)/layout.tsx:146, website/prompts/export/route.ts:49)
//                                                                          -> 403 forbidden
//   4. project      the project pages' gate: demo project admin-only (project layout), then
//                   HGH_SOURCE_SESSION=api -> GET /v1/projects/{id} (404 for all but admin and
//                   active members), legacy -> project exists and (admin or active member), the
//                   leaf page gate                                         -> 404 not_found
// The panel sends the applied URL values that shape the options (time: the options window =
// the data window; brand: the legacy lists were narrowed by the applied brand; engine, project
// only: the legacy project engine list depends on it, see legacyOptions). Scope comes from the
// session only, never from the request.
//
// Source (D8): HGH_SOURCE_<sourceGroupFor(area, surface)>.
//   api    -> GET /v1/filters/options (lib/hgh/adapters/filters.ts loadPanelOptions).
//   legacy -> the same repository readers each surface's page called, unchanged:
//             global  = dashboard/page.tsx composition, website = website/page.tsx composition,
//             project = projects/[id] page + analysis pages.
// Errors from the backend: hghErrorResponse (status kept, body {error:{code}}).
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
  if (hghSource("SESSION") === "api") return (await fetchProjectGate(id)) !== null;
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

  // Only the parameters that shape options are read.
  const sp: Record<string, string> = {};
  for (const key of surface === "project" ? ["time", "brand", "engine"] : ["time", "brand"]) {
    const v = q.get(key);
    if (v) sp[key] = v;
  }
  const filters = surface === "project" ? readStandardFilters(sp) : readStandardFilters(sp, user.scope);

  try {
    if (surface === "project" && !(await projectPageAllowed(projectId!, user))) return fail(404, "not_found");
    const options = isAnalysisApi(area as AnalysisArea, surface as Surface)
      ? await loadPanelOptions({
          surface: surface as Surface,
          projectId,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          scope: user.scope,
          filters,
        })
      : await legacyOptions(surface as Surface, projectId, user, filters);
    return NextResponse.json({ options }, { headers: noStore });
  } catch (e) {
    return hghErrorResponse(e);
  }
}

async function legacyOptions(
  surface: Surface,
  projectId: string | undefined,
  user: SessionUser,
  filters: ReturnType<typeof readStandardFilters>,
): Promise<PanelFilterOptions> {
  const scope = user.scope;
  const dateRange = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  if (surface === "global") {
    // dashboard/page.tsx OverviewFiltersSection
    const optionScope = narrowScopeBrands(scope, filters.brand);
    const [catalogRows, geographyOptions, languageOptions, optionMatrix] = await Promise.all([
      listCatalogTaxonomy(),
      listMeasuredRegions(optionScope, undefined, true, dateRange),
      listMeasuredStandardLanguages(optionScope, undefined, dateRange),
      listMeasuredScopeMatrix(scope, dateRange),
    ]);
    return { catalogRows, geographyOptions, languageOptions, optionMatrix };
  }
  if (surface === "website") {
    // website/page.tsx WebsiteFiltersSection (site-level project_id does not narrow the legacy lists)
    const optionScope = narrowScopeBrands(scope, filters.brand);
    const [catalogRows, geographyOptions, languageOptions, optionMatrix] = await Promise.all([
      listCatalogTaxonomy(),
      listWebsiteCountries(optionScope),
      listMeasuredLanguages(optionScope),
      listWebsiteScopeMatrix(optionScope),
    ]);
    return { catalogRows, geographyOptions, languageOptions, optionMatrix };
  }
  // project: projects/[id]/page.tsx:73-97 and analysis/mention/page.tsx:37-78 readers. The
  // engine list takes the page's filter object (readStandardFilters(URL) + cumulative). Its
  // reader (fetchProjectMeasuredEngines -> listMeasuredEngines -> snapshotAnswerIds,
  // scope-aggregates.ts:7789, :4551) reads only dateFrom/dateTo (periodBounds / dateBoundClause)
  // and engine (anchorDefaultEngineScope: no engine chosen = default engine only), so the
  // time and engine URL values are all the route needs to give the same answer.
  const id = projectId!;
  const pageFilters = { ...filters, cumulative: true };
  const [catalogRows, geographyOptions, engineOptions, fields, values] = await Promise.all([
    listCatalogTaxonomy(id),
    listMeasuredRegions(scope),
    fetchProjectMeasuredEngines(id, pageFilters),
    projectCustomFieldRepository.listForProject(id),
    projectCustomFieldRepository.listValuesForProject(id),
  ]);
  const byField = new Map<string, Set<string>>();
  for (const v of values) {
    const set = byField.get(v.fieldId) ?? new Set<string>();
    set.add(v.value);
    byField.set(v.fieldId, set);
  }
  const dynamicAxes = fields
    .filter((f) => !f.archived)
    .map((f) => ({
      id: f.id,
      label: f.label,
      options: [...(byField.get(f.id) ?? [])].sort((a, b) => a.localeCompare(b)),
    }));
  return { catalogRows, geographyOptions, engineOptions, dynamicAxes };
}
