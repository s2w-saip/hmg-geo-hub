import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { keywordCache } from "@/lib/db/schema";

// Generic payload cache for the Google Keyword intent view (insight + related).
// Callers MUST treat these as best-effort (lib/keyword/cache.ts wraps them): if
// the migration hasn't been applied the table is absent and calls throw — the
// wrapper then disables caching and recomputes live.

export const keywordCacheRepository = {
  /** Non-expired payload for the key, or null. */
  async get(cacheKey: string): Promise<unknown | null> {
    const rows = await getDb()
      .select({ payload: keywordCache.payload })
      .from(keywordCache)
      .where(
        and(
          eq(keywordCache.cacheKey, cacheKey),
          gt(keywordCache.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    return rows[0]?.payload ?? null;
  },

  /** Upsert a payload with an absolute expiry. */
  async set(cacheKey: string, payload: unknown, expiresAt: Date): Promise<void> {
    await getDb()
      .insert(keywordCache)
      .values({ cacheKey, payload, expiresAt })
      .onConflictDoUpdate({
        target: keywordCache.cacheKey,
        set: { payload, expiresAt },
      });
  },
};
