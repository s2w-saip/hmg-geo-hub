import "server-only";
import type { MenuGroup, Role } from "@/lib/auth/types";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { hghSource, sourceGroupFor, type HghArea, type HghSource } from "./client";
import type { Surface } from "./query";

// Access rules of the analysis BFF routes and actions: the source switch of an analysis screen and
// the (dash) place gate a route handler must apply itself.
//
// Source switch (D8). The screens branch per request:
//   isAnalysisApi(area, surface)  -> HGH_SOURCE_<sourceGroupFor(area, surface)> === "api"
//   global: dashboard G1, analysis (mentions, citations, answers) G2, funnel G4, prompts G5;
//   website surface G3 and project surface G6 for every area.
//
// Route gate. A route handler has no (dash) layout above it, so it must apply the same place gate the
// layout applies to pages ((dash)/layout.tsx canAccessRoute(role, pathname, menuGroups)) BEFORE
// reading anything, on both sources (the backend's require_surface only guards the api source). The
// representative page of an (area, surface) is the screen family the data feeds.

/** Analysis areas (dashboard, mentions/citations, funnel, prompts). */
export type AnalysisArea = Extract<HghArea, "dashboard" | "analysis" | "funnel" | "prompts">;

/** HGH_SOURCE_<group> for an analysis screen (sourceGroupFor: website G3, project G6). */
export function analysisSource(area: AnalysisArea, surface: Surface, env?: Record<string, string | undefined>): HghSource {
  return hghSource(sourceGroupFor(area, surface), env);
}

/** True when the screen's group flag is "api" (default legacy). */
export function isAnalysisApi(area: AnalysisArea, surface: Surface, env?: Record<string, string | undefined>): boolean {
  return analysisSource(area, surface, env) === "api";
}

/** Representative page per (surface, area): the ROUTES entry whose role/menu rule applies. */
export const ANALYSIS_ROUTE_PATHS: Readonly<Record<Surface, Readonly<Record<AnalysisArea, string>>>> = {
  global: {
    dashboard: "/dashboard",
    analysis: "/standard/answer-analysis",
    funnel: "/standard/ai-funnel",
    prompts: "/standard/prompts",
  },
  website: {
    dashboard: "/website",
    analysis: "/website/answer-analysis",
    funnel: "/website/ai-funnel",
    prompts: "/website/prompts",
  },
  project: {
    dashboard: "/projects",
    analysis: "/projects",
    funnel: "/projects",
    prompts: "/projects",
  },
};

export function analysisRoutePath(area: AnalysisArea, surface: Surface): string {
  return ANALYSIS_ROUTE_PATHS[surface][area];
}

/**
 * The (dash) place gate for an analysis BFF route: role and the account's menu-group
 * whitelist (the third argument is mandatory: without it canAccessRoute ignores menuGroups).
 */
export function canReadAnalysis(
  user: { role: Role; menuGroups?: readonly MenuGroup[] | null },
  area: AnalysisArea,
  surface: Surface,
): boolean {
  return canAccessRoute(user.role, analysisRoutePath(area, surface), user.menuGroups ?? null);
}
