import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  projectCustomFields,
  promptCustomFieldValues,
  prompts,
  type ProjectCustomFieldRow,
  type PromptCustomFieldValueRow,
} from "@/lib/db/schema";

export interface NewProjectCustomField {
  projectId: string;
  label: string;
  createdBy: string;
}

export const projectCustomFieldRepository = {
  async listForProject(projectId: string): Promise<ProjectCustomFieldRow[]> {
    return getDb()
      .select()
      .from(projectCustomFields)
      .where(eq(projectCustomFields.projectId, projectId))
      .orderBy(projectCustomFields.createdAt);
  },

  async getById(id: string): Promise<ProjectCustomFieldRow | null> {
    const rows = await getDb()
      .select()
      .from(projectCustomFields)
      .where(eq(projectCustomFields.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async insert(input: NewProjectCustomField): Promise<ProjectCustomFieldRow> {
    const [created] = await getDb()
      .insert(projectCustomFields)
      .values({
        projectId: input.projectId,
        label: input.label,
        createdBy: input.createdBy,
      })
      .returning();
    if (!created) throw new Error("projectCustomFieldRepository.insert: no row returned");
    return created;
  },

  async archive(id: string): Promise<void> {
    await getDb()
      .update(projectCustomFields)
      .set({ archived: true })
      .where(eq(projectCustomFields.id, id));
  },

  async restore(id: string): Promise<void> {
    await getDb()
      .update(projectCustomFields)
      .set({ archived: false })
      .where(eq(projectCustomFields.id, id));
  },

  // Hard delete = drop the field AND every assigned value (열+값 일괄 삭제).
  // No FK cascade in DDL (schema portability stance), so we remove the values
  // explicitly first, in one transaction, to avoid orphaned rows.
  async delete(id: string): Promise<void> {
    await getDb().transaction(async (tx) => {
      await tx
        .delete(promptCustomFieldValues)
        .where(eq(promptCustomFieldValues.fieldId, id));
      await tx.delete(projectCustomFields).where(eq(projectCustomFields.id, id));
    });
  },

  // Values are stored without a project_id column — join through prompts so a
  // caller can never leak another project's assignments.
  async listValuesForProject(projectId: string): Promise<PromptCustomFieldValueRow[]> {
    return getDb()
      .select({
        promptId: promptCustomFieldValues.promptId,
        fieldId: promptCustomFieldValues.fieldId,
        value: promptCustomFieldValues.value,
      })
      .from(promptCustomFieldValues)
      .innerJoin(prompts, eq(prompts.id, promptCustomFieldValues.promptId))
      .where(eq(prompts.projectId, projectId));
  },

  async setValue(promptId: string, fieldId: string, value: string): Promise<void> {
    await getDb()
      .insert(promptCustomFieldValues)
      .values({ promptId, fieldId, value })
      .onConflictDoUpdate({
        target: [promptCustomFieldValues.promptId, promptCustomFieldValues.fieldId],
        set: { value },
      });
  },

  // Bulk variant of setValue — assigns the same value to many prompts in one
  // upsert (일괄 태깅). Callers must have already validated each prompt belongs
  // to the project (IDOR) — this method takes ids at face value.
  async setValueBulk(promptIds: string[], fieldId: string, value: string): Promise<void> {
    if (promptIds.length === 0) return;
    await getDb()
      .insert(promptCustomFieldValues)
      .values(promptIds.map((promptId) => ({ promptId, fieldId, value })))
      .onConflictDoUpdate({
        target: [promptCustomFieldValues.promptId, promptCustomFieldValues.fieldId],
        set: { value },
      });
  },

  async clearValue(promptId: string, fieldId: string): Promise<void> {
    await getDb()
      .delete(promptCustomFieldValues)
      .where(
        and(
          eq(promptCustomFieldValues.promptId, promptId),
          eq(promptCustomFieldValues.fieldId, fieldId),
        ),
      );
  },

  // Used by the hard-delete guard — a field with any assigned value can only
  // be archived, never deleted outright (no silent data loss).
  async countFieldUsage(fieldId: string): Promise<number> {
    const rows = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(promptCustomFieldValues)
      .where(eq(promptCustomFieldValues.fieldId, fieldId));
    return rows[0]?.count ?? 0;
  },
};
