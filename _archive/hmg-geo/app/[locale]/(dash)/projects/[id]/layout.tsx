import type { ReactNode } from "react";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { projectRepository } from "@/lib/db/repositories/projects";
import { getSession } from "@/lib/auth/session";
import { isDemoProject } from "@/lib/demo";
import { ProjectMetaBroadcast } from "@/components/dash/project-meta-broadcast";

// Project detail wrapper. Per the 2026-06-04 GNB reorg the project meta
// header (name / created date / description) now lives in the SNB column,
// not in the content area. This layout:
//   1. notFound() when the project doesn't exist (auth/visibility gating
//      stays on the individual leaf pages — Dashboard, Intent, etc.)
//   2. Broadcasts the project meta to the SNB header. This layout — unlike
//      the (dash) layout that renders the SNB — re-renders on client-side
//      navigation, so it's the only reliable source for the header on soft
//      nav (list → detail without a hard load).
//   3. {children} passthrough with the fade-in container.
// The back link also moves out — it's pinned at the bottom of the SNB.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const project = await projectRepository.getById(id);
  if (!project) notFound();

  // The demo project shows fabricated numbers for manual/screenshot captures —
  // admin-only so it never reads as a real customer project to a scoped account.
  // notFound() (not redirect) so the URL doesn't even confirm the project exists.
  if (isDemoProject(id)) {
    const session = await getSession();
    if (session?.user.role !== "admin") notFound();
  }

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <ProjectMetaBroadcast
        meta={{
          id: project.id,
          name: project.name,
          description: project.description,
          createdAt: project.createdAt.toISOString(),
        }}
      />
      {children}
    </div>
  );
}
