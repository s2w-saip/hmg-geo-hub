import "server-only";
import {
  fetchKeywordVolumesFromApi,
  sanitizeKeywords,
  type KeywordSearchVolume,
} from "./dataforseo";
import {
  keywordVolumeCacheRepository,
  type VolumeResultForCache,
} from "@/lib/db/repositories/keyword-volume-cache";
import type { KeywordVolumeCacheRow } from "@/lib/db/schema";

/**
 * Search-volume service: cache-first read, live DataForSEO for misses, then a
 * cache write-back. Caching is BEST-EFFORT — if the keyword_volume_cache table
 * is absent (migration not applied) or any DB op fails, `cacheDisabled` flips
 * and every subsequent lookup goes straight to the API. The feature works with
 * or without the migration; the cache is purely a cost optimisation.
 */

let cacheDisabled = false;

function rowToVolume(row: KeywordVolumeCacheRow): KeywordSearchVolume {
  return {
    keyword: row.keyword,
    spell: null,
    location_code: row.locationCode,
    language_code: row.languageCode,
    search_partners: false,
    competition: row.competition ?? "LOW",
    competition_index: row.competitionIndex ?? 0,
    search_volume: row.searchVolume ?? 0,
    low_top_of_page_bid: row.lowTopOfPageBid ?? 0,
    high_top_of_page_bid: row.highTopOfPageBid ?? 0,
    cpc: row.cpc ?? 0,
    monthly_searches: Array.isArray(row.monthlySearches)
      ? (row.monthlySearches as KeywordSearchVolume["monthly_searches"])
      : [],
  };
}

export async function getKeywordVolumes(
  rawKeywords: string[],
  locationCode?: number,
  languageCode?: string,
  sortBy: string = "search_volume",
): Promise<KeywordSearchVolume[]> {
  const keywords = Array.from(new Set(sanitizeKeywords(rawKeywords)));
  if (keywords.length === 0) return [];

  // 1. Cache read (best-effort).
  const cached: KeywordSearchVolume[] = [];
  let toFetch = keywords;
  if (!cacheDisabled) {
    try {
      const rows = await keywordVolumeCacheRepository.getValid(
        keywords,
        locationCode,
        languageCode,
        sortBy,
      );
      const hit = new Set(rows.map((r) => r.keyword));
      for (const row of rows) cached.push(rowToVolume(row));
      toFetch = keywords.filter((k) => !hit.has(k));
    } catch (err) {
      cacheDisabled = true;
      console.warn(
        "[keyword] volume cache unavailable — falling back to live API only:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 2. Live fetch for misses.
  let fresh: KeywordSearchVolume[] = [];
  if (toFetch.length > 0) {
    fresh = await fetchKeywordVolumesFromApi(
      toFetch,
      locationCode,
      languageCode,
      sortBy,
    );

    // 3. Cache write-back (best-effort).
    if (!cacheDisabled) {
      try {
        const forCache: VolumeResultForCache[] = fresh.map((v) => ({
          keyword: v.keyword,
          search_volume: v.search_volume ?? 0,
          competition: v.competition ?? "LOW",
          competition_index: v.competition_index ?? 0,
          cpc: v.cpc ?? 0,
          low_top_of_page_bid: v.low_top_of_page_bid ?? 0,
          high_top_of_page_bid: v.high_top_of_page_bid ?? 0,
          monthly_searches: v.monthly_searches ?? [],
        }));
        await keywordVolumeCacheRepository.upsertMany(
          toFetch,
          forCache,
          locationCode,
          languageCode,
          sortBy,
        );
      } catch (err) {
        cacheDisabled = true;
        console.warn(
          "[keyword] volume cache write failed — caching disabled:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const all = [...cached, ...fresh];
  if (sortBy === "search_volume") {
    all.sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0));
  }
  return all;
}
