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

// Read gate. api: the U2 project gate, same error mapping as the page. The first render (page.tsx ->
// loadProjectPromptScreen) shares the full GET /v1/projects/{id} with the layouts and gates once; the
// paged reads the list makes afterwards are server actions alone in their request, so they take the
// light read (GET /v1/projects/{id}?view=gate, B020/B021: no summary statements).
async function requireRead(projectId: string, light = false) {
  const session = await getSession();
  if (!session || !canAccessRoute(session.user.role, `/projects/${projectId}/prompt`, session.user.menuGroups)) throw new UnauthorizedError();
  const isAdmin = session.user.role === "admin";
  if (isProjectsApi()) return requireProjectAccess(await getLocale(), projectId, isAdmin, { light });
  const project = await projectRepository.getById(projectId);
  if (!project) notFound();
  const membership = await projectMemberRepository.findMembership(projectId, session.user.id);
  if (!isAdmin && (!membership || membership.status !== "active")) notFound();
  return { canEdit: isAdmin || membership?.role === "owner" };
}

async function promptRows(projectId: string, input: ProjectPageQuery): Promise<ProjectRowsPage<PromptRow>> {
  const query = projectPageQuery(input);
  if (!isProjectsApi()) return readProjectPromptPage(projectId, query);
  const { data } = await hghPost("/v1/projects/{project_id}/prompts/screen", { pathParams: { project_id: projectId }, body: query });
  return { ...data, ids: data.ids ?? [], values: data.values ?? {}, rows: toPromptRows(data.rows, false) };
}

async function candidateRows(projectId: string, input: ProjectPageQuery): Promise<ProjectRowsPage<CandidateRow>> {
  const query = projectPageQuery(input);
  if (!isProjectsApi()) return readProjectCandidatePage(projectId, query);
  const { data } = await hghPost("/v1/projects/{project_id}/prompt-candidates/screen", { pathParams: { project_id: projectId }, body: query });
  return { ...data, ids: data.ids ?? [], values: data.values ?? {}, rows: data.rows.map(toCandidateRow) };
}

export async function loadProjectPromptRows(projectId: string, input: ProjectPageQuery): Promise<ProjectRowsPage<PromptRow>> {
  await requireRead(projectId, true);
  return promptRows(projectId, input);
}

export async function loadProjectCandidateRows(projectId: string, input: ProjectPageQuery): Promise<ProjectRowsPage<CandidateRow>> {
  await requireRead(projectId, true);
  return candidateRows(projectId, input);
}

export async function loadProjectPromptScreen(projectId: string) {
  const access = await requireRead(projectId);
  const [promptPage, candidatePage, customFields] = await Promise.all([
    promptRows(projectId, {}), candidateRows(projectId, {}),
    // api: valueCount (project-wide value count) stays on the row for the tag-column delete confirmation.
    isProjectsApi()
      ? hghGet("/v1/projects/{project_id}/prompt-fields", { pathParams: { project_id: projectId } }).then(r => r.data.items.map(toCustomFieldRow))
      : projectCustomFieldRepository.listForProject(projectId).then(fields => fields.map(f => ({ id: f.id, label: f.label, archived: f.archived }))),
  ]);
  return { canEdit: access.canEdit, promptPage, candidatePage, customFields };
}

/** Ids per select-all read: the api screen takes up to 5,000 ids per ids_only call (back screen.py IDS_ONLY_MAX); legacy reads 500. */
const IDS_PAGE = { api: 5000, legacy: 500 } as const;

async function loadPromptIdPage(projectId: string, offset: number, limit: number): Promise<ProjectRowsPage<PromptRow>> {
  if (!isProjectsApi()) return loadProjectPromptRows(projectId, { offset, limit, ids_only: true });
  await requireRead(projectId, true);
  // projectPageQuery bounds row reads at 500; the ids-only read takes the larger ids page.
  const body = { ...projectPageQuery({ offset, ids_only: true }), limit };
  const { data } = await hghPost("/v1/projects/{project_id}/prompts/screen", { pathParams: { project_id: projectId }, body });
  return { ...data, ids: data.ids ?? [], values: data.values ?? {}, rows: [] };
}

export async function loadAllProjectPromptIds(projectId: string): Promise<string[]> {
  const size = isProjectsApi() ? IDS_PAGE.api : IDS_PAGE.legacy;
  const ids = new Set<string>();
  let expected: number | undefined;
  for (let offset = 0; ; offset += size) {
    const page = await loadPromptIdPage(projectId, offset, size);
    expected ??= page.total;
    if (page.total !== expected || page.offset !== offset || page.ids.some(id => ids.has(id))) throw new Error("Prompt list changed; retry selection");
    page.ids.forEach(id => ids.add(id));
    if (ids.size === expected) return [...ids];
    if (page.ids.length !== size) throw new Error("Incomplete prompt selection");
  }
}
