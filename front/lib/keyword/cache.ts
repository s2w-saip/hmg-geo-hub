import "server-only";
import { keywordCacheRepository } from "@/lib/db/repositories/keyword-cache";

// Best-effort wrapper over keyword_cache. If the table is missing (migration not
// applied) or a DB op fails, callers recompute live during a short cooldown.
// Probe again after cooldown so a transient outage does not disable caching forever.

const RETRY_AFTER_MS = 30_000;
let retryAt = 0;
let probing = false;

function canTry(): boolean {
  if (Date.now() < retryAt || probing) return false;
  if (retryAt) probing = true;
  return true;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!canTry()) return null;
  try {
    const value = (await keywordCacheRepository.get(key)) as T | null;
    retryAt = 0;
    return value;
  } catch (err) {
    retryAt = Date.now() + RETRY_AFTER_MS;
    console.warn(
      "[keyword] cache unavailable — recomputing live:",
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    probing = false;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  if (!canTry()) return;
  try {
    await keywordCacheRepository.set(key, value, new Date(Date.now() + ttlMs));
    retryAt = 0;
  } catch (err) {
    retryAt = Date.now() + RETRY_AFTER_MS;
    console.warn(
      "[keyword] cache write failed — retrying after cooldown:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    probing = false;
  }
}

export const TTL = {
  insight: 24 * 60 * 60 * 1000, // 24h (SERP + prompts change ~daily)
  related: 7 * 24 * 60 * 60 * 1000, // 7d (suggestions change slowly)
};
