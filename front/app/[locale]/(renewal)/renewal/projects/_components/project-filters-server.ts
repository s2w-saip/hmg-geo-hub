import "server-only";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { canAccessRoute } from "@/lib/auth/route-policy";
import type { AllowedScope } from "@/lib/auth/types";
import type { DynamicAxis } from "@/components/dash/dimension-filter-panel";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import type { OverviewFilterProps } from "../../_components/overview-filters";

// The renewal Project tab's pages (2026-11-03): their session gate and filter panel. The panel is the project
// configuration of the shared renewal panel (overview-filter-model surface "project": 기간 · 측정 국가 · AI 엔진 + the
// project's custom tags, 국가 locked when the project was measured in one), its options from projects/filters
// (back/bff/screens/project_dashboard.py).

/** projects/filters */
export interface ProjectFiltersView {
  geographyOptions: string[];
  engineOptions: string[];
  dynamicAxes: DynamicAxis[];
  selectableDates: string[];
  latestAnchorDay: string | null;
  collectionStartDay: string | null;
}

/** The signed-in administrator of a project page (the layout guards it too); anyone else goes to no-access. */
export async function projectPageSession(locale: string) {
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!canAccessRoute(session.user.role, "/renewal/projects")) redirect(`/${locale}/no-access`);
  return session;
}

/** The screen query of a project page: its URL params and the project. */
export const projectQuery = (id: string, sp: Record<string, string | string[] | undefined>): ScreenQuery => ({ ...sp, "ctx.project_id": id });

/** The panel props of a project page (`family`: the calendar's rounds, citations on the Citation page). */
export async function projectFilterProps(
  id: string,
  sp: Record<string, string | string[] | undefined>,
  scope: AllowedScope,
  locale: string,
  stage: OverviewFilterProps["stage"] = "overview",
  family: "mentions" | "citations" = "mentions",
): Promise<OverviewFilterProps> {
  let v: ProjectFiltersView;
  try {
    v = await screenGet<ProjectFiltersView>("projects/filters", { ...projectQuery(id, sp), "ctx.family": family });
  } catch (e) {
    throwForPage(e, locale);
  }
  return {
    stage,
    surface: "project",
    scope,
    geographyOptions: v.geographyOptions,
    engineOptions: v.engineOptions,
    dynamicAxes: v.dynamicAxes,
    selectableDates: v.selectableDates,
    latestAnchorDay: v.latestAnchorDay,
    collectionStartDay: v.collectionStartDay,
  };
}
