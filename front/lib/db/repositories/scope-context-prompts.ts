import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { scopeContextPromptCache } from "@/lib/db/schema";
import type { GeneratedPrompt } from "@/components/social-scraping/types";

// Per-project cache of the context-map → candidate prompts (decision B). Like
// keywordCacheRepository, these are best-effort: if migration 0028 hasn't been
// applied the table is absent and calls throw — the caller
// (lib/social-scraping/context-prompts.ts) catches and regenerates live.
//
// ─── Concurrency (2026-07-15, migration 0030) ───────────────────────────────
// The whole prompt set is ONE jsonb blob keyed by project. Both writers —
// "더 생성" (append) and "선택 삭제" (mark removed) — are read-modify-write:
// get() → mutate in JS → set() overwrites everything. With no guard, two
// overlapping edits silently lose one. The user-visible symptom is a deleted
// prompt reappearing, or a generated batch vanishing.
//
// So reads carry a `version` token and writes require it to still match,
// bumping it on success. A caller that loses the race gets `false` and can
// re-read + retry rather than clobbering.
//
// Why a blob at all: production tops out at ~84 rows / 10.5KB per project, and
// generation is bounded. Normalising buys nothing here — but the blob is
// exactly why the lock is needed.

/** Cached prompts plus the token needed to write them back. */
export interface CachedPrompts {
  prompts: GeneratedPrompt[];
  /** Pass to `setIfUnchanged`. Opaque — do not compute or compare on it. */
  version: number;
}

export const scopeContextPromptRepository = {
  /** Cached prompts for the project, or null if none generated yet. */
  async get(projectId: string): Promise<CachedPrompts | null> {
    const rows = await getDb()
      .select({
        prompts: scopeContextPromptCache.prompts,
        version: scopeContextPromptCache.version,
      })
      .from(scopeContextPromptCache)
      .where(eq(scopeContextPromptCache.projectId, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { prompts: (row.prompts as GeneratedPrompt[]) ?? [], version: row.version };
  },

  /**
   * Write the prompt set back, but only if nobody else has written since the
   * read that produced `expectedVersion`.
   *
   * @param expectedVersion the token from `get()`, or `null` when the read saw
   *        no row at all (first generation for this project).
   * @returns `false` when the write was refused because the row changed under
   *          us — the caller must re-read and decide, never blind-retry.
   */
  async setIfUnchanged(
    projectId: string,
    prompts: GeneratedPrompt[],
    model: string,
    expectedVersion: number | null,
  ): Promise<boolean> {
    const db = getDb();

    if (expectedVersion === null) {
      // We read no row. Insert — but another request may have inserted in the
      // gap, so DO NOTHING on conflict rather than overwriting their work.
      const inserted = await db
        .insert(scopeContextPromptCache)
        .values({ projectId, prompts, model, version: 1 })
        .onConflictDoNothing({ target: scopeContextPromptCache.projectId })
        .returning({ projectId: scopeContextPromptCache.projectId });
      return inserted.length > 0;
    }

    const updated = await db
      .update(scopeContextPromptCache)
      .set({
        prompts,
        model,
        generatedAt: new Date(),
        version: expectedVersion + 1,
      })
      .where(
        and(
          eq(scopeContextPromptCache.projectId, projectId),
          eq(scopeContextPromptCache.version, expectedVersion),
        ),
      )
      .returning({ projectId: scopeContextPromptCache.projectId });
    return updated.length > 0;
  },
};
