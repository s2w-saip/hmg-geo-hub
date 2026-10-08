"use server";

import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import { readProjectCandidatePage, readProjectPromptPage } from "@/lib/db/repositories/project-prompt-page";
import { isProjectsApi, requireProjectAccess, toCandidateRow, toCustomFieldRow, toPromptRows } from "@/lib/hgh/adapters/projects";
import { hghGet, hghPost } from "@/lib/hgh/client";
import { projectPageQuery, type ProjectPageQuery, type ProjectRowsPage } from "@/lib/projects/prompt-page";
import type { CandidateRow } from "./_components/candidate-list";
import type { PromptRow } from "./_components/prompt-list";

async function requireRead(projectId: string) {
  const session = await getSession();
  if (!session || !canAccessRoute(session.user.role, `/projects/${projectId}/prompt`, session.user.menuGroups)) throw new UnauthorizedError();
  const isAdmin = session.user.role === "admin";
  if (isProjectsApi()) return requireProjectAccess(await getLocale(), projectId, isAdmin);
  const project = await projectRepository.getById(projectId);
  if (!project) notFound();
  const membership = await projectMemberRepository.findMembership(projectId, session.user.id);
  if (!isAdmin && (!membership || membership.status !== "active")) notFound();
  return { canEdit: isAdmin || membership?.role === "owner" };
}

export async function loadProjectPromptRows(projectId: string, input: ProjectPageQuery): Promise<ProjectRowsPage<PromptRow>> {
  await requireRead(projectId);
  const query = projectPageQuery(input);
  if (!isProjectsApi()) return readProjectPromptPage(projectId, query);
  const { data } = await hghPost("/v1/projects/{project_id}/prompts/screen", { pathParams: { project_id: projectId }, body: query });
  return { ...data, ids: data.ids ?? [], values: data.values ?? {}, rows: toPromptRows(data.rows, false) };
}

export async function loadProjectCandidateRows(projectId: string, input: ProjectPageQuery): Promise<ProjectRowsPage<CandidateRow>> {
  await requireRead(projectId);
  const query = projectPageQuery(input);
  if (!isProjectsApi()) return readProjectCandidatePage(projectId, query);
  const { data } = await hghPost("/v1/projects/{project_id}/prompt-candidates/screen", { pathParams: { project_id: projectId }, body: query });
  return { ...data, ids: data.ids ?? [], values: data.values ?? {}, rows: data.rows.map(toCandidateRow) };
}

export async function loadProjectPromptScreen(projectId: string) {
  const access = await requireRead(projectId);
  const [promptPage, candidatePage, fields] = await Promise.all([
    loadProjectPromptRows(projectId, {}), loadProjectCandidateRows(projectId, {}),
    isProjectsApi()
      ? hghGet("/v1/projects/{project_id}/prompt-fields", { pathParams: { project_id: projectId } }).then(r => r.data.items.map(toCustomFieldRow))
      : projectCustomFieldRepository.listForProject(projectId),
  ]);
  return { canEdit: access.canEdit, promptPage, candidatePage, customFields: fields.map(f => ({ id: f.id, label: f.label, archived: f.archived })) };
}

export async function loadAllProjectPromptIds(projectId: string): Promise<string[]> {
  const ids = new Set<string>();
  let expected: number | undefined;
  for (let offset = 0; ; offset += 500) {
    const page = await loadProjectPromptRows(projectId, { offset, limit: 500, ids_only: true });
    expected ??= page.total;
    if (page.total !== expected || page.offset !== offset || page.ids.some(id => ids.has(id))) throw new Error("Prompt list changed; retry selection");
    page.ids.forEach(id => ids.add(id));
    if (ids.size === expected) return [...ids];
    if (page.ids.length !== 500) throw new Error("Incomplete prompt selection");
  }
}
