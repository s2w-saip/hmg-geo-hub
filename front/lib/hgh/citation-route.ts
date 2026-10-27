import "server-only";
import type { AllowedScope, MenuGroup, Role } from "@/lib/auth/types";
import { isDemoProject } from "@/lib/demo";
import { hghSource } from "./client";
import { errorKindOf, isHghApiError } from "./errors";
import type { Surface } from "./query";
import { canReadAnalysis, isAnalysisApi } from "./analysis-access";
import { fetchProjectGate, isProjectId } from "./adapters/project-gate";

// Access rules and request parsing of the citation BFF routes (/api/citations/domains, /[skey],
// /export). The data and every calculation come from the citation screens (back/bff/screens).

/** Rows of a domains page (design 3.3: limit=200, the backend maximum). */
export const DOMAIN_PAGE = 200;

/** BG-21 sort keys. */
export type DomainSort = "citations" | "share" | "coverage" | "prompts" | "skey";
export const DOMAIN_SORTS: ReadonlySet<string> = new Set<DomainSort>(["citations", "share", "coverage", "prompts", "skey"]);

/** Screen and route source: HGH_SOURCE_<group of (analysis, surface)> (G2 global, G3 website, G6 project). */
export function isCitationsApi(surface: Surface, env?: Record<string, string | undefined>): boolean {
  return isAnalysisApi("analysis", surface, env);
}

export interface CitationRouteUser {
  id: string;
  role: Role;
  scope: AllowedScope | null;
  menuGroups?: readonly MenuGroup[] | null;
}

export type LegacyProjectAllowed = (projectId: string, user: CitationRouteUser) => Promise<boolean>;
export type RouteGate = { ok: true } | { ok: false; status: 403 | 404 };

/**
 * The route gate, applied before any read (U4 F1): the (dash) place gate of the screen family
 * (canReadAnalysis, 403), then on project the project page gate (demo project admin only;
 * HGH_SOURCE_SESSION=api -> the project gate read, else the injected repository check; 404). A 401
 * or 5xx of the project gate is thrown.
 */
export async function citationRouteGate(
  user: CitationRouteUser,
  surface: Surface,
  projectId: string | undefined,
  legacyProjectAllowed: LegacyProjectAllowed,
): Promise<RouteGate> {
  if (!canReadAnalysis(user, "analysis", surface)) return { ok: false, status: 403 };
  if (surface === "project") {
    const id = projectId ?? "";
    if (!isProjectId(id)) return { ok: false, status: 404 };
    if (isDemoProject(id) && user.role !== "admin") return { ok: false, status: 404 };
    if (hghSource("SESSION") === "api") {
      try {
        return (await fetchProjectGate(id, { light: true })) ? { ok: true } : { ok: false, status: 404 };
      } catch (e) {
        if (isHghApiError(e) && e.status === 403) {
          return { ok: false, status: errorKindOf(e.status, e.code) === "forbidden" ? 403 : 404 };
        }
        throw e;
      }
    }
    if (!(await legacyProjectAllowed(id, user))) return { ok: false, status: 404 };
  }
  return { ok: true };
}

export interface CitationRouteTarget {
  surface: Surface;
  projectId?: string;
}

/** surface / projectId of a route request: projectId (uuid) -> project, surface=website -> website, else global. */
export function citationRouteTarget(q: URLSearchParams): CitationRouteTarget | null {
  const projectId = q.get("projectId");
  if (projectId !== null) return isProjectId(projectId) ? { surface: "project", projectId } : null;
  return { surface: q.get("surface") === "website" ? "website" : "global" };
}

/** base64url of a UTF-8 string (skey in a path segment: "/" of social keys never reaches the router). */
export function encodeSkey(skey: string): string {
  return Buffer.from(skey, "utf8").toString("base64url");
}

/** The skey of a path segment, or null when it is not a canonical base64url of printable text. */
export function decodeSkey(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(segment)) return null;
  const s = Buffer.from(segment, "base64url").toString("utf8");
  return s && encodeSkey(s) === segment && !/[\x00-\x1f\x7f]/.test(s) ? s : null;
}
