import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  projectOwnedBases,
  type ProjectOwnedBaseRow,
} from "@/lib/db/schema";

export interface NewProjectOwnedBase {
  projectId: string;
  baseUrl: string;
  label: string | null;
  createdBy: string;
}

export async function listProjectOwnedBases(
  projectId: string,
): Promise<ProjectOwnedBaseRow[]> {
  const db = getDb();
  try {
    return await db
      .select()
      .from(projectOwnedBases)
      .where(eq(projectOwnedBases.projectId, projectId))
      .orderBy(asc(projectOwnedBases.createdAt), asc(projectOwnedBases.baseUrl));
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string } | null)
      ?.cause?.code ?? (err as { code?: string } | null)?.code;
    if (code === "42P01") {
      console.warn(
        "[project_owned_bases] table not found — returning empty list (migration 0021 not applied?)",
      );
      return [];
    }
    throw err;
  }
}

export async function addProjectOwnedBase(
  row: NewProjectOwnedBase,
): Promise<ProjectOwnedBaseRow> {
  const [created] = await getDb()
    .insert(projectOwnedBases)
    .values({
      projectId: row.projectId,
      baseUrl: row.baseUrl,
      label: row.label,
      createdBy: row.createdBy,
    })
    .returning();
  if (!created) throw new Error("addProjectOwnedBase: no row returned");
  return created;
}

export async function removeProjectOwnedBase(
  id: string,
  projectId: string,
): Promise<void> {
  await getDb()
    .delete(projectOwnedBases)
    .where(
      and(
        eq(projectOwnedBases.id, id),
        eq(projectOwnedBases.projectId, projectId),
      ),
    );
}

export async function latestProjectOwnedBase(
  projectId: string,
): Promise<ProjectOwnedBaseRow | null> {
  const rows = await getDb()
    .select()
    .from(projectOwnedBases)
    .where(eq(projectOwnedBases.projectId, projectId))
    .orderBy(desc(projectOwnedBases.createdAt), desc(projectOwnedBases.baseUrl))
    .limit(1);
  return rows[0] ?? null;
}
