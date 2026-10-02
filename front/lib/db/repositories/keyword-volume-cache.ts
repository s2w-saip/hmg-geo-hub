import "server-only";
import { and, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  keywordVolumeCache,
  type KeywordVolumeCacheRow,
} from "@/lib/db/schema";

// Cache repository for DataForSEO search-volume lookups. Keyed by
// (keyword, location_code, language_code, sort_by). Writes dedupe via
// delete-then-insert (no ON CONFLICT — the natural key includes nullable
// location/language columns, where Postgres unique indexes treat NULLs as
// distinct). Reads filter to non-expired successful rows.
//
// Callers MUST treat these methods as best-effort (lib/keyword/service.ts wraps
// them in try/catch): if the migration hasn't been applied the table is absent
// and every call throws — the service disables caching and falls back to the
// live API rather than surfacing the error.

const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type MonthlySearch = { year: number; month: number; search_volume: number };

export interface VolumeResultForCache {
  keyword: string;
  search_volume: number;
  competition: string;
  competition_index: number;
  cpc: number;
  low_top_of_page_bid: number;
  high_top_of_page_bid: number;
  monthly_searches: MonthlySearch[];
}

// Builds the (location, language, sort) predicate, using IS NULL for unset
// location/language so the key matches how the row was written.
function keyMatch(
  locationCode: number | undefined,
  languageCode: string | undefined,
  sortBy: string,
): SQL[] {
  const conds: SQL[] = [eq(keywordVolumeCache.sortBy, sortBy)];
  conds.push(
    locationCode == null
      ? isNull(keywordVolumeCache.locationCode)
      : eq(keywordVolumeCache.locationCode, locationCode),
  );
  conds.push(
    languageCode == null
      ? isNull(keywordVolumeCache.languageCode)
      : eq(keywordVolumeCache.languageCode, languageCode),
  );
  return conds;
}

export const keywordVolumeCacheRepository = {
  /** Non-expired, successful cache rows for the given keywords + key. */
  async getValid(
    keywords: string[],
    locationCode: number | undefined,
    languageCode: string | undefined,
    sortBy: string,
  ): Promise<KeywordVolumeCacheRow[]> {
    if (keywords.length === 0) return [];
    return getDb()
      .select()
      .from(keywordVolumeCache)
      .where(
        and(
          inArray(keywordVolumeCache.keyword, keywords),
          eq(keywordVolumeCache.success, true),
          gt(keywordVolumeCache.expiresAt, sql`now()`),
          ...keyMatch(locationCode, languageCode, sortBy),
        ),
      );
  },

  /**
   * Replace cache rows for `requestedKeywords` with fresh `results`. Keywords
   * requested but absent from `results` (no measurable volume) are cached as
   * zero-volume successes so they aren't re-fetched — mirrors aeorank's
   * saveEmptyResultsToCache.
   */
  async upsertMany(
    requestedKeywords: string[],
    results: VolumeResultForCache[],
    locationCode: number | undefined,
    languageCode: string | undefined,
    sortBy: string,
  ): Promise<void> {
    if (requestedKeywords.length === 0) return;

    const expiresAt = new Date(Date.now() + SUCCESS_TTL_MS);
    // DataForSEO echoes the `keyword` back lowercased, while requestedKeywords
    // keep their original casing (sanitizeKeywords does not lowercase). Match
    // case-insensitively so a real result is never mis-classified as "empty"
    // and cached as a zero — that would poison the cache for the full TTL
    // (e.g. requested "Genesis GV80" vs returned "genesis gv80").
    const norm = (k: string) => k.trim().toLowerCase();
    const byKeyword = new Map(results.map((r) => [norm(r.keyword), r]));

    const rows = requestedKeywords.map((keyword) => {
      const r = byKeyword.get(norm(keyword));
      if (r) {
        return {
          keyword,
          locationCode: locationCode ?? null,
          languageCode: languageCode ?? null,
          sortBy,
          searchVolume: r.search_volume,
          competition: r.competition,
          competitionIndex: r.competition_index,
          cpc: r.cpc,
          lowTopOfPageBid: r.low_top_of_page_bid,
          highTopOfPageBid: r.high_top_of_page_bid,
          monthlySearches: r.monthly_searches,
          rawData: r as unknown,
          success: true,
          errorMessage: null,
          expiresAt,
        };
      }
      // Empty result — cache a zero so the next lookup is a hit, not a re-fetch.
      return {
        keyword,
        locationCode: locationCode ?? null,
        languageCode: languageCode ?? null,
        sortBy,
        searchVolume: 0,
        competition: null,
        competitionIndex: null,
        cpc: null,
        lowTopOfPageBid: null,
        highTopOfPageBid: null,
        monthlySearches: null,
        rawData: null,
        success: true,
        errorMessage: null,
        expiresAt,
      };
    });

    const db = getDb();
    // Delete-then-insert dedupes the (keyword, key) tuple.
    await db
      .delete(keywordVolumeCache)
      .where(
        and(
          inArray(keywordVolumeCache.keyword, requestedKeywords),
          ...keyMatch(locationCode, languageCode, sortBy),
        ),
      );
    await db.insert(keywordVolumeCache).values(rows);
  },
};
