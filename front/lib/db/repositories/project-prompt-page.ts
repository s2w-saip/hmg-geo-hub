import "server-only";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { promptCandidates, prompts, projectCustomFields, promptCustomFieldValues } from "@/lib/db/schema";
import { projectPageQuery, type ProjectPageQuery, type ProjectRowsPage } from "@/lib/projects/prompt-page";
import type { CandidateRow } from "@/app/[locale]/(dash)/projects/[id]/prompt/_components/candidate-list";
import type { PromptRow } from "@/app/[locale]/(dash)/projects/[id]/prompt/_components/prompt-list";

/** The caller authenticates project membership before entering this repository. */
export async function readProjectPromptPage(id: string, input: ProjectPageQuery): Promise<ProjectRowsPage<PromptRow>> {
  const q = projectPageQuery(input), db = getDb();
  // Retains the legacy feed's row population; the API source retains its own soft-delete contract.
  const where = eq(prompts.projectId, id);
  const [meta] = await db.select({ total: sql<number>`count(*)::int`, show_brand: sql<boolean>`coalesce(bool_or(${prompts.brand} IS NOT NULL AND ${prompts.brand} <> ''), false)`,
    show_category: sql<boolean>`coalesce(bool_or(${prompts.category} IS NOT NULL AND ${prompts.category} <> ''), false)`,
    draft_count: sql<number>`count(*) FILTER (WHERE ${prompts.status} = 'draft' OR (${prompts.status} = 'queued' AND ${prompts.scopePromptId} IS NULL))::int` }).from(prompts).where(where);
  const offset = Math.min(q.offset, Math.max(0, Math.floor((meta.total - 1) / q.limit) * q.limit));
  const order: SQL[] = [asc(prompts.createdAt), asc(prompts.id)];
  if (q.direction) {
    const direction = q.direction === "asc" ? sql`ASC` : sql`DESC`;
    if (q.sort === "status") {
      order.unshift(sql`CASE ${prompts.status} WHEN 'draft' THEN 0 WHEN 'queued' THEN 1 WHEN 'running' THEN 2 WHEN 'done' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END ${direction}`);
    } else {
      const core = { text: prompts.text, brand: prompts.brand, category: prompts.category };
      let value: SQL;
      if (q.sort in core) value = sql`lower(coalesce(${core[q.sort as keyof typeof core]}, ''))`;
      else {
        if (!/^[0-9a-f-]{36}$/i.test(q.sort)) throw new Error("Invalid sort field");
        const field = await db.select({ id: projectCustomFields.id }).from(projectCustomFields).where(and(eq(projectCustomFields.id, q.sort), eq(projectCustomFields.projectId, id))).limit(1);
        if (!field.length) throw new Error("Field not found");
        value = sql`lower(coalesce((SELECT ${promptCustomFieldValues.value} FROM ${promptCustomFieldValues} WHERE ${promptCustomFieldValues.promptId} = ${prompts.id} AND ${promptCustomFieldValues.fieldId} = ${q.sort}), ''))`;
      }
      order.unshift(sql`(${value} = '') ASC`, sql`${value} COLLATE "C" ${direction}`);
    }
  }
  if (q.ids_only) {
    const ids = await db.select({ id: prompts.id }).from(prompts).where(where).orderBy(...order).limit(q.limit).offset(offset);
    return { ...meta, rows: [], ids: ids.map(r => r.id), offset, limit: q.limit, values: {} };
  }
  const rows = await db.select({ id: prompts.id, text: prompts.text, promptType: prompts.promptType, brand: prompts.brand,
    category: prompts.category, status: prompts.status, scopePromptId: prompts.scopePromptId }).from(prompts).where(where).orderBy(...order).limit(q.limit).offset(offset);
  const tags = rows.length ? await db.select({ promptId: promptCustomFieldValues.promptId, fieldId: promptCustomFieldValues.fieldId, value: promptCustomFieldValues.value })
    .from(promptCustomFieldValues).innerJoin(projectCustomFields, eq(projectCustomFields.id, promptCustomFieldValues.fieldId))
    .where(and(eq(projectCustomFields.projectId, id), inArray(promptCustomFieldValues.promptId, rows.map(r => r.id)))) : [];
  const tagMap = new Map<string, Record<string, string>>();
  for (const tag of tags) { const values = tagMap.get(tag.promptId) ?? {}; values[tag.fieldId] = tag.value; tagMap.set(tag.promptId, values); }
  // Project-wide tag value suggestions: skipped when the list already holds them (include_values=false).
  const suggestions = !q.include_values ? [] : await db.select({ fieldId: promptCustomFieldValues.fieldId, values: sql<string[]>`array_agg(DISTINCT ${promptCustomFieldValues.value}) FILTER (WHERE ${promptCustomFieldValues.value} <> '')` })
    .from(promptCustomFieldValues).innerJoin(projectCustomFields, eq(projectCustomFields.id, promptCustomFieldValues.fieldId))
    .innerJoin(prompts, eq(prompts.id, promptCustomFieldValues.promptId)).where(and(where, eq(projectCustomFields.projectId, id))).groupBy(promptCustomFieldValues.fieldId);
  return { ...meta, rows: rows.map(row => ({ ...row, customValues: tagMap.get(row.id) ?? {} })), ids: [], offset, limit: q.limit,
    values: Object.fromEntries(suggestions.map(s => [s.fieldId, s.values ?? []])) };
}

export async function readProjectCandidatePage(id: string, input: ProjectPageQuery): Promise<ProjectRowsPage<CandidateRow>> {
  const q = projectPageQuery(input), db = getDb();
  if (!["", "newest", "oldest", "text", "source"].includes(q.sort)) throw new Error("Invalid candidate sort");
  const where = eq(promptCandidates.projectId, id);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(promptCandidates).where(where);
  const offset = Math.min(q.offset, Math.max(0, Math.floor((total - 1) / q.limit) * q.limit));
  const order: SQL[] = [desc(promptCandidates.createdAt), desc(promptCandidates.id)];
  if (q.sort === "oldest") order.unshift(asc(promptCandidates.createdAt));
  if (["text", "source"].includes(q.sort)) order.unshift(sql`${q.sort === "text" ? promptCandidates.text : promptCandidates.source} ${q.collation === "ko" ? sql`COLLATE "ko-x-icu"` : sql`COLLATE "en-x-icu"`} ASC`);
  const rows = await db.select({ id: promptCandidates.id, text: promptCandidates.text, source: promptCandidates.source,
    sourceKeyword: promptCandidates.sourceKeyword, createdAt: promptCandidates.createdAt })
    .from(promptCandidates).where(where).orderBy(...order).limit(q.limit).offset(offset);
  return { rows: rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), ids: [], total, offset, limit: q.limit, show_brand: false, show_category: false, draft_count: 0, values: {} };
}
