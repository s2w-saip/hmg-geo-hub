import "server-only";

/**
 * DataForSEO Google Ads "search volume" client — server-only transport.
 * Ported from aeorank (app/api/analysis/data-for-seo/keywords-volume.ts), with
 * the Supabase cache lifted out into lib/keyword/service.ts so this module is a
 * pure HTTP wrapper (no DB, no auth, no session).
 *
 * A single DataForSEO account opens billable lookups, so this must never run in
 * the browser — callers reach it through /api/keyword/* (session-gated) only.
 *
 * Auth: HTTP Basic with login:password (NOT a bearer key).
 */

const DATAFORSEO_BASE_URL =
  "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live";

// DataForSEO accepts ~1000 keywords/request; 250 keeps the POST body well under
// any URI/body limits while minimising round-trips (aeorank used 250).
const DATAFORSEO_BATCH_SIZE = 250;

export type KeywordSearchVolume = {
  keyword: string;
  spell: string | null;
  location_code: number | null;
  language_code: string | null;
  search_partners: boolean;
  competition: string; // "LOW" | "MEDIUM" | "HIGH"
  competition_index: number;
  search_volume: number;
  low_top_of_page_bid: number;
  high_top_of_page_bid: number;
  cpc: number;
  monthly_searches: {
    year: number;
    month: number;
    search_volume: number;
  }[];
};

type SearchVolumeResponse = {
  version: string;
  status_code: number;
  status_message: string;
  tasks_count: number;
  tasks_error: number;
  tasks: {
    id: string;
    status_code: number;
    status_message: string;
    result_count: number;
    result: KeywordSearchVolume[] | null;
  }[];
};

export class DataForSeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataForSeoError";
  }
}

/**
 * Strip characters DataForSEO rejects and drop empty / over-long entries.
 * Mirrors aeorank's sanitizer so cache keys line up across the two apps.
 */
export function sanitizeKeywords(keywords: string[]): string[] {
  return keywords
    .map((kw) => {
      if (!kw || typeof kw !== "string") return "";
      return kw
        .trim()
        .replace(/[()[\]{}]/g, "") // parentheses + brackets
        .replace(/,/g, "") // commas
        .replace(/\n/g, " ") // newlines
        .replace(/\s+/g, " ") // collapse whitespace
        .trim();
    })
    .filter((kw) => kw.length > 0 && kw.length < 100);
}

/**
 * Fetch live search volumes for the given (already-sanitized) keywords. Splits
 * into batches, calls DataForSEO per batch, and returns the flattened results
 * sorted by descending search volume. No caching — see service.ts.
 */
export async function fetchKeywordVolumesFromApi(
  keywords: string[],
  locationCode?: number,
  languageCode?: string,
  sortBy: string = "search_volume",
): Promise<KeywordSearchVolume[]> {
  if (keywords.length === 0) return [];

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new DataForSeoError(
      "DataForSEO credentials missing (set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD).",
    );
  }
  const credentials = Buffer.from(`${login}:${password}`).toString("base64");

  const batches: string[][] = [];
  for (let i = 0; i < keywords.length; i += DATAFORSEO_BATCH_SIZE) {
    batches.push(keywords.slice(i, i + DATAFORSEO_BATCH_SIZE));
  }

  const all: KeywordSearchVolume[] = [];
  for (const batch of batches) {
    const requestBody = [
      {
        keywords: batch,
        ...(locationCode ? { location_code: locationCode } : {}),
        ...(languageCode ? { language_code: languageCode } : {}),
        sort_by: sortBy,
      },
    ];

    const response = await fetch(DATAFORSEO_BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new DataForSeoError(
        `DataForSEO HTTP ${response.status}: ${errorText.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as SearchVolumeResponse;

    // Wrapper-level status (20000 = ok).
    if (data.status_code !== 20000) {
      throw new DataForSeoError(`DataForSEO error: ${data.status_message}`);
    }
    if (!data.tasks || data.tasks.length === 0) {
      throw new DataForSeoError("DataForSEO returned no tasks.");
    }

    const task = data.tasks[0];
    if (task.status_code !== 20000) {
      throw new DataForSeoError(`DataForSEO task error: ${task.status_message}`);
    }

    if (task.result && task.result.length > 0) {
      all.push(...task.result);
    }
    // Empty result = keywords with no measurable volume; just skip them.
  }

  if (sortBy === "search_volume") {
    all.sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0));
  }
  return all;
}

/** Roll up a volume result set into the headline summary cards. */
export function summarizeKeywordSearchVolume(keywords: KeywordSearchVolume[]) {
  if (keywords.length === 0) {
    return {
      totalKeywords: 0,
      averageSearchVolume: 0,
      totalSearchVolume: 0,
      highVolumeCount: 0,
      mediumVolumeCount: 0,
      lowVolumeCount: 0,
      averageCompetitionIndex: 0,
      averageCPC: 0,
    };
  }

  const totalSearchVolume = keywords.reduce(
    (sum, k) => sum + (k.search_volume ?? 0),
    0,
  );
  const averageSearchVolume = Math.round(totalSearchVolume / keywords.length);
  const highVolumeCount = keywords.filter(
    (k) => (k.search_volume ?? 0) >= 100000,
  ).length;
  const mediumVolumeCount = keywords.filter(
    (k) => (k.search_volume ?? 0) >= 10000 && (k.search_volume ?? 0) < 100000,
  ).length;
  const lowVolumeCount = keywords.filter(
    (k) => (k.search_volume ?? 0) < 10000,
  ).length;
  const averageCompetitionIndex = Math.round(
    keywords.reduce((sum, k) => sum + (k.competition_index ?? 0), 0) /
      keywords.length,
  );
  const averageCPC =
    Math.round(
      (keywords.reduce((sum, k) => sum + (k.cpc ?? 0), 0) / keywords.length) *
        100,
    ) / 100;

  return {
    totalKeywords: keywords.length,
    averageSearchVolume,
    totalSearchVolume,
    highVolumeCount,
    mediumVolumeCount,
    lowVolumeCount,
    averageCompetitionIndex,
    averageCPC,
  };
}
