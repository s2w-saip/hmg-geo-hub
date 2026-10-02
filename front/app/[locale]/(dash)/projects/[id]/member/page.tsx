import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { memberAuditLogRepository } from "@/lib/db/repositories/member-audit-logs";
import { isProjectsApi, loadMemberPage, type MemberPageData } from "@/lib/hgh/adapters/projects";
import { InviteForm } from "./_components/invite-form";
import {
  MemberList,
  type MemberRow,
} from "./_components/member-list";
import { AuditLog, type AuditLogEntry } from "./_components/audit-log";

// Project detail > 멤버 (GGMD v22 user flow #4).
// Owner sees the invite form + member list with cancel/remove actions.
// Viewer sees the same list but the form and per-row buttons are hidden
// (read-only — matches the v22 매트릭스: "멤버: Owner CRUD / Viewer R만").
export default async function ProjectMembersPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("projectDetail.member");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const isAdmin = session.user.role === "admin";
  // Data source (D8): HGH_SOURCE_G6=api = the U2 project gate (GET /v1/projects/{id}: admin or
  // active member, else notFound) + GET …/members + GET …/member-audit?limit=20; legacy below.
  const { canEdit, members, audit: auditEntries } = isProjectsApi()
    ? await loadMemberPage(locale, id, isAdmin)
    : await legacyMemberPage(id, session.user.id, isAdmin);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {canEdit ? (
        <SectionCard
          title={t("invite.title")}
          description={t("invite.description")}
        >
          <InviteForm projectId={id} />
        </SectionCard>
      ) : null}

      <SectionCard
        title={t("list.title")}
        description={t("list.description", { count: members.length })}
      >
        <MemberList projectId={id} members={members} canEdit={canEdit} />
      </SectionCard>

      <SectionCard
        title={t("audit.title")}
        description={t("audit.description", { count: auditEntries.length })}
      >
        <AuditLog entries={auditEntries} />
      </SectionCard>
    </div>
  );
}

// Legacy source (the rollback path, D8).
async function legacyMemberPage(id: string, userId: string, isAdmin: boolean): Promise<MemberPageData> {
  const project = await projectRepository.getById(id);
  if (!project) notFound();

  const membership = await projectMemberRepository.findMembership(id, userId);
  // admin = developer superuser (resolved 2026-06-02): can view + edit
  // every project's members regardless of membership. Non-admin non-members
  // get notFound() — never leak that a project with this id exists.
  if (!isAdmin && (!membership || membership.status !== "active")) {
    notFound();
  }

  const canEdit = isAdmin || membership?.role === "owner";
  const [raw, auditRaw] = await Promise.all([
    projectMemberRepository.listForProject(id),
    memberAuditLogRepository.listForProject(id, 20),
  ]);
  const members: MemberRow[] = raw.map((m) => ({
    id: m.id,
    email: m.email,
    role: m.role,
    status: m.status,
    invitedAt: m.invitedAt.toISOString(),
  }));
  const audit: AuditLogEntry[] = auditRaw.map((e) => ({
    id: e.id,
    actorEmail: e.actorEmail,
    targetEmail: e.targetEmail,
    action: e.action,
    context: e.context,
    createdAt: e.createdAt.toISOString(),
  }));
  return { canEdit, members, audit };
}
