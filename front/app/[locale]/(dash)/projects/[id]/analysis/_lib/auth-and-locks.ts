import "server-only";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { hghSource } from "@/lib/hgh/client";
import { projectLocks, requireProjectPage } from "@/lib/hgh/adapters/project-gate";

// Shared auth gate + F4 dimension lock derivation for /analysis/mention and
// /analysis/citation. Both pages need the exact same project lookup +
// brand/country lock chips, so factor it out so the two leaf pages stay
// thin.
//
// Source (D8, HGH_SOURCE_SESSION): api = the one project gate
// (lib/hgh/adapters/project-gate.ts, GET /v1/projects/{id}: admin or active member,
// everyone else 404 -> notFound); legacy = the repository gate below (rollback path).
export async function loadProjectAnalysisContext(
  locale: string,
  id: string,
): Promise<{
  locks: { group: DimensionGroup; value: string }[];
  lockedGroups: DimensionGroup[];
}> {
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  if (hghSource("SESSION") === "api") {
    return projectLocks(await requireProjectPage(locale, id));
  }

  const project = await projectRepository.getById(id);
  if (!project) notFound();

  const membership = await projectMemberRepository.findMembership(
    id,
    session.user.id,
  );
  const isAdmin = session.user.role === "admin";
  if (!isAdmin && (!membership || membership.status !== "active")) notFound();

  // `vehicle` group dropped from the filter panel (2026-06-04). Project
  // brand still surfaces as a header chip elsewhere; only country still
  // round-trips through the filter lock mechanism.
  const locks: { group: DimensionGroup; value: string }[] = [];
  if (project.country) locks.push({ group: "geography", value: project.country });
  return { locks, lockedGroups: locks.map((l) => l.group) };
}
