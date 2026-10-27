import "server-only";

// The one project gate (unit U2, design 1.3 and appendix E "공용: 대시 레이아웃·프로젝트
// 레이아웃"): GET /v1/projects/{project_id} decides, the front only maps the answer.
// Light read (B020): GET /v1/projects/{project_id}?view=gate, the same access decision and 404s
// without the detail summary statements (prompt counts, recent prompts, default engines); every field
// this gate maps is in it. Defaults (B020 follow-up):
//   fetchProjectGate     light. Its callers are gates that run alone in their request (route
//                        handlers: filters/options, citations, intent keyword routes), so the summary
//                        statements are pure cost there.
//   requireProjectPage,  full. In a page render they share ONE in-request call with the (dash) and
//   projectMetaForSnb    project layouts and with the pages that read the full detail themselves (home
//                        tiles dashboard.ts fetchProjectDetail, setting projects.ts projectDetail,
//                        mention mentions.ts loadDesignatedTargetBrand). The layouts cannot tell which
//                        leaf renders, so a light read there would add a second call on those pages.
//                        A page gate that runs alone (prompt tab server actions) passes { light: true }.
// Selected by its callers when HGH_SOURCE_SESSION=api (D8); the legacy repository gates
// stay in those files as the rollback path.
//
// Who may pass: backend core.auth.resolve_project(level="active_member"), i.e. admin or an
// ACTIVE member. Everyone else (missing project, standard root, out-of-scope, in-scope
// non-member, pending or removed member) gets 404, the IDOR-hiding contract. That is exactly
// the legacy page gate of every /projects/[id]/* leaf (page.tsx, member, setting, prompt,
// intent/*, analysis/*, ai-funnel/*: `!isAdmin && membership?.status !== "active"` ->
// notFound()), and PJ-3 (project prompt reads) is active-member only as well (main decision
// 2026-09-28). In-scope NON-members keep what current scope-policy gives them on the DATA
// side: the analytics endpoints with surface=project use resolve_project(level="member")
// (backend core/filters.py), mirroring lib/scope/server.ts::assertProjectInScope. This gate
// is only for the project PAGES.
//
// Field map (ProjectDetail -> GateProject; legacy source in brackets)
//   project_id       -> id             [projects.id]
//   name             -> name           [projects.name]
//   description      -> description    [projects.description], undefined -> null
//   created_at       -> createdAt      [projects.createdAt.toISOString()]: re-serialized with
//                                      Date#toISOString so the string is identical (ms, Z)
//   brand_code       -> brand          [projects.brand], undefined -> null (umbrella project)
//   country_code     -> country        [projects.country]
//   ga4_property_id  -> ga4PropertyId  [projects.ga4PropertyId], undefined -> null
//   my_role          -> myRole         [project_members.role when status = active], null for
//                                      admin without membership
//
// Error map (pages; same outcome as the legacy gates):
//   404, or an id that is not a uuid (never sent)  -> notFound()
//   401 (no token, expired, no_account)            -> redirect /{locale}/login
//   403 role_forbidden / menu_forbidden            -> redirect /{locale}/no-access
//   403 other                                      -> notFound() (project pages hide existence)
//   5xx, timeout                                   -> thrown to the (dash) error boundary
import { notFound } from "next/navigation";
import { localReadOnly } from "@/lib/local-readonly";
import { screenGet } from "@/lib/screen";
import type { ProjectMetaForSnb } from "@/components/dash/project-meta-broadcast";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import type { components } from "../api-types";
import { hghGet } from "../client";
import { describeHghError, errorKindOf, isHghApiError, throwForPage } from "../errors";

export type ProjectDetail = components["schemas"]["ProjectDetail"];

/** Query of the light gate read (view=gate). Other gate-only reads pass the same object so the in-request dedupe shares the call. */
export const GATE_QUERY = { view: "gate" } as const;

export interface GateReadOptions {
  /**
   * view=gate: same decision, no summary statements. Default true for fetchProjectGate (gates that run
   * alone in their request), false for requireProjectPage (page renders share the full call).
   */
  light?: boolean;
  /** Retry once after a 401 token refresh (route handlers, server actions). Not part of the dedupe key. */
  retryOn401?: boolean;
}

export interface GateProject {
  id: string;
  name: string;
  description: string | null;
  /** ISO string in Date#toISOString form (what the legacy gate produced). */
  createdAt: string | null;
  brand: string | null;
  country: string;
  ga4PropertyId: string | null;
  /** Active membership role of the viewer; null for admin without membership. */
  myRole: "owner" | "viewer" | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Project ids are uuids; anything else is a sibling segment or a bad URL (never sent). */
export function isProjectId(id: string): boolean {
  return UUID_RE.test(id);
}

function isoLikeLegacy(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

export function toGateProject(d: ProjectDetail): GateProject {
  return {
    id: d.project_id,
    name: d.name,
    description: d.description ?? null,
    createdAt: isoLikeLegacy(d.created_at),
    brand: d.brand_code ?? null,
    country: d.country_code,
    ga4PropertyId: d.ga4_property_id ?? null,
    myRole: d.my_role ?? null,
  };
}

/**
 * GET /v1/projects/{id}?view=gate (light, the default; { light: false } = the full read) for the current
 * session. null when the backend hides the project (404) or the id is not a uuid. Every other failure is
 * thrown as HghApiError. In-request dedupe (client) makes reads of the same view share one call.
 */
export async function fetchProjectGate(id: string, opts: GateReadOptions = {}): Promise<GateProject | null> {
  if (!isProjectId(id)) return null;
  if (localReadOnly()) {
    // The gate shape (name = id, country only for a single region, 404 -> null) is built by the API.
    return (await screenGet<{ project: GateProject | null }>("shared/project-gate", { project_id: id })).project;
  }
  const light = opts.light ?? true;
  try {
    const res = await hghGet("/v1/projects/{project_id}", {
      pathParams: { project_id: id },
      ...(light ? { query: GATE_QUERY } : {}),
      ...(opts.retryOn401 ? { retryOn401: true } : {}),
    });
    return toGateProject(res.data);
  } catch (e) {
    if (isHghApiError(e) && e.status === 404) return null;
    throw e;
  }
}

/**
 * Page gate: the project, or the same redirect / notFound the legacy page gates produced. Full read by
 * default (shared with the layouts and the page's own detail reads); { light: true } when it runs alone.
 */
export async function requireProjectPage(locale: string, id: string, opts: GateReadOptions = {}): Promise<GateProject> {
  let project: GateProject | null;
  try {
    project = await fetchProjectGate(id, { ...opts, light: opts.light ?? false });
  } catch (e) {
    throwForPage(e, locale, { permission: "not-found" });
  }
  if (!project) notFound();
  return project;
}

export function toSnbMeta(p: GateProject): ProjectMetaForSnb {
  return { id: p.id, name: p.name, description: p.description, createdAt: p.createdAt };
}

/**
 * SNB project header for the (dash) layout. null when the viewer may not see the project
 * (legacy: admin or active member only) or the id is not a uuid. 401 and 403 behave exactly
 * like requireProjectPage (login; no-access for role/menu 403; notFound for any other 403).
 * A transient failure (5xx, timeout) degrades to no header with one log
 * line: the project layout below makes the same (deduped) call and raises it inside the
 * (dash) error boundary, with the navigation chrome still rendered.
 */
export async function projectMetaForSnb(id: string, locale: string): Promise<ProjectMetaForSnb | null> {
  try {
    // Full read: the same in-request call as the project layout and the leaf page gate (see header).
    const project = await fetchProjectGate(id, { light: false });
    return project ? toSnbMeta(project) : null;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    const kind = errorKindOf(e.status, e.code);
    // Same mapping as requireProjectPage: another 403 must hide the project (notFound), never
    // /no-access, or a parallel render could confirm that the id exists.
    if (kind === "session" || kind === "forbidden" || kind === "permission") {
      throwForPage(e, locale, { permission: "not-found" });
    }
    console.warn(describeHghError(e));
    return null;
  }
}

/** F4 dimension locks of the project analysis and funnel pages (country only, since 2026-06-04). */
export function projectLocks(p: GateProject): {
  locks: { group: DimensionGroup; value: string }[];
  lockedGroups: DimensionGroup[];
} {
  const locks: { group: DimensionGroup; value: string }[] = [];
  if (p.country) locks.push({ group: "geography", value: p.country });
  return { locks, lockedGroups: locks.map((l) => l.group) };
}

/** Conversion-event editing: admin or the project's active Owner (legacy ai-funnel gate). */
export function canEditConversion(p: GateProject, isAdmin: boolean): boolean {
  return isAdmin || p.myRole === "owner";
}
