import "server-only";
import { keywordCacheRepository } from "@/lib/db/repositories/keyword-cache";

// Best-effort wrapper over keyword_cache. If the table is missing (migration not
// applied) or any DB op fails, caching disables itself and callers recompute
// live — the feature works with or without the migration.

let cacheDisabled = false;

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (cacheDisabled) return null;
  try {
    return (await keywordCacheRepository.get(key)) as T | null;
  } catch (err) {
    cacheDisabled = true;
    console.warn(
      "[keyword] cache unavailable — recomputing live:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  if (cacheDisabled) return;
  try {
    await keywordCacheRepository.set(key, value, new Date(Date.now() + ttlMs));
  } catch (err) {
    cacheDisabled = true;
    console.warn(
      "[keyword] cache write failed — caching disabled:",
      err instanceof Error ? err.message : err,
    );
  }
}

export const TTL = {
  insight: 24 * 60 * 60 * 1000, // 24h (SERP + prompts change ~daily)
  related: 7 * 24 * 60 * 60 * 1000, // 7d (suggestions change slowly)
};
