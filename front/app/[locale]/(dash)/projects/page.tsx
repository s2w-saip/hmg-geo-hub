import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { canCreateProject } from "@/lib/auth/operator-policy";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { promptRepository } from "@/lib/db/repositories/prompts";
import { isProjectsApi, loadProjectsList, type ProjectsListView } from "@/lib/hgh/adapters/projects";
import { PendingInvitesPanel, type PendingRow } from "./_components/pending-invites";
import { ProjectsOverview } from "./_components/projects-overview";
import { ProjectList } from "./_components/project-list";

// Project — Overview (project list). Per GGMD v22 user flow #1, the list
// shows every project the user is an active member of (Owner or Viewer)
// with a role badge. PENDING invites the user has received are surfaced
// at the top as the "Project list 상단 알림" from v22 user flow #4-2.B
// (accept / reject inline; see PendingInvitesPanel).
export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("projects");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  // Data source (D8): HGH_SOURCE_G6=api reads GET /v1/projects (cursor to the end) + GET
  // /v1/me/project-invites (lib/hgh/adapters/projects.ts); legacy keeps the repository reads below.
  const view = isProjectsApi()
    ? await loadProjectsList(locale)
    : await legacyProjectsList(session.user.id, session.user.role === "admin");
  const { projects: projectList, cards: projectsWithRole, pending, totalActiveMembers, totalQueuedPrompts } = view;

  // Project creation is a cost action gated by operator authority (global |
  // admin) — hide the entry point for everyone else so menu == capability.
  const canCreate = canCreateProject(session.user);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        meta={`${projectsWithRole.length.toLocaleString()}개 프로젝트`}
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/projects/new">
                <Plus className="h-4 w-4" aria-hidden />
                {t("addProject")}
              </Link>
            </Button>
          ) : null
        }
      />

      {pending.length > 0 ? <PendingInvitesPanel pending={pending} /> : null}

      <ProjectsOverview
        projects={projectList}
        totalActiveMembers={totalActiveMembers}
        totalQueuedPrompts={totalQueuedPrompts}
      />

      {projectsWithRole.length === 0 ? (
        <EmptyState
          variant="pending"
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={
            canCreate ? (
              <Button asChild variant="outline">
                <Link href="/projects/new">{t("addProject")}</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ProjectList
          projects={projectsWithRole}
        />
      )}
    </div>
  );
}

// Legacy source (the rollback path, D8): the repository reads, unchanged.
async function legacyProjectsList(userId: string, isAdmin: boolean): Promise<ProjectsListView> {
  // admin = developer superuser (resolved 2026-06-02): sees every project
  // even without membership rows. Pending invites only apply to the user's
  // own membership rows, so they stay scoped regardless of role.
  const [projectList, pendingRaw] = await Promise.all([
    isAdmin ? projectRepository.listAll() : projectRepository.listForUser(userId),
    projectMemberRepository.pendingForUser(userId),
  ]);

  // Everything below is deliberately batched: with per-project round-trips
  // (one getById per pending invite + three queries per project) 21 projects
  // meant 60+ queries, and the DB sits a region away from the Vercel
  // function, so round-trip count converts directly into page latency.
  // Four IN/GROUP BY queries in one parallel wave replace all of it — the
  // UI only consumes role badges + counts, never the full member/prompt rows.
  const projectIds = projectList.map((p) => p.id);
  const pendingProjectIds = [...new Set(pendingRaw.map((p) => p.projectId))];
  const [pendingProjectNames, memberships, memberCounts, promptCounts] =
    await Promise.all([
      projectRepository.getNamesByIds(pendingProjectIds),
      projectMemberRepository.getRolesForProjects(userId, projectIds),
      projectMemberRepository.countActiveMembersByProject(projectIds),
      promptRepository.countByProject(projectIds),
    ]);

  // Pending-invite panel rows — "Sample project에 초대되셨습니다" needs the
  // project name, resolved via the single IN query above.
  const pendingNameById = new Map(pendingProjectNames.map((p) => [p.id, p.name]));
  const pending: PendingRow[] = pendingRaw.map((p) => ({
    membershipId: p.id,
    projectId: p.projectId,
    projectName: pendingNameById.get(p.projectId) ?? "(unknown project)",
    invitedAt: p.invitedAt.toISOString(),
  }));

  // Owner/Viewer badge + per-card counts. Projects absent from a batch
  // result mean "no row" — same fallbacks as the old per-project queries
  // (viewer badge, zero counts).
  const roleByProject = new Map(memberships.map((m) => [m.projectId, m.role]));
  const activeMembersByProject = new Map(
    memberCounts.map((m) => [m.projectId, m.activeMembers]),
  );
  const promptCountsByProject = new Map(
    promptCounts.map((c) => [c.projectId, c]),
  );
  const cards = projectList.map((p) => ({
    id: p.id,
    name: p.name,
    domain: p.domain,
    role: roleByProject.get(p.id) ?? ("viewer" as const),
    promptCount: promptCountsByProject.get(p.id)?.total ?? 0,
    activeMembers: activeMembersByProject.get(p.id) ?? 0,
    createdAt: p.createdAt.toISOString(),
  }));

  return {
    projects: projectList,
    cards,
    pending,
    totalActiveMembers: memberCounts.reduce((sum, m) => sum + m.activeMembers, 0),
    totalQueuedPrompts: promptCounts.reduce((sum, c) => sum + c.queuedOrRunning, 0),
  };
}
