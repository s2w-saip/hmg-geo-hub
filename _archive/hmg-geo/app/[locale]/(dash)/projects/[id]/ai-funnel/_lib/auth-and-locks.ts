import "server-only";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";

// Shared by the 3 ai-funnel leaf pages (visibility / acr / conversion).
export async function loadProjectFunnelContext(
  locale: string,
  id: string,
): Promise<{
  locks: { group: DimensionGroup; value: string }[];
  lockedGroups: DimensionGroup[];
  // The project's own (brand, country) — conversion resolves a GA4 property
  // from these (single-property / country-leaf). brand may be null (umbrella).
  brand: string | null;
  country: string;
  // Per-project GA4 property binding (wins over the central catalog). NULL →
  // fall back to resolveProperty(brand, country). Lets out-of-catalog projects
  // connect GA4.
  ga4PropertyId: string | null;
  // Whether this viewer may edit the project's conversion-event selection —
  // admin or the project's active Owner (member Viewers see it read-only).
  canEditConversion: boolean;
}> {
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

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
  return {
    locks,
    lockedGroups: locks.map((l) => l.group),
    brand: project.brand ?? null,
    country: project.country,
    ga4PropertyId: project.ga4PropertyId ?? null,
    canEditConversion:
      isAdmin || (membership?.status === "active" && membership.role === "owner"),
  };
}
