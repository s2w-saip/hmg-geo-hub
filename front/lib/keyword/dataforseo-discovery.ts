import "server-only";
import { DataForSeoError } from "./dataforseo";

/**
 * DataForSEO "discovery" endpoints that power the Google Keyword intent view:
 *   - SERP organic results          (serp/google/organic/live/advanced)
 *   - keyword suggestions (related)  (dataforseo_labs/google/keyword_suggestions/live)
 *
 * Server-only HTTP wrappers (Basic auth), ported/adapted from aeorank. No DB,
 * no caching here — the assembler in lib/keyword/insight.ts composes these.
 *
 * NB: the interest trend uses Google Ads `monthly_searches` (via lib/keyword/
 * service.ts), NOT Google Trends — the latter's 0-100 series is mostly null for
 * long-tail keywords, producing an empty/jagged chart.
 */

const SERP_URL = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const SUGGESTIONS_URL =
  "https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live";

function authHeader(): Record<string, string> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new DataForSeoError(
      "DataForSEO credentials missing (set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD).",
    );
  }
  return {
    Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
}

// One task's `result[0]`, after the standard 20000 status checks.
async function postTaskResult<T>(
  url: string,
  body: unknown,
): Promise<T | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DataForSeoError(`DataForSEO HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    status_code: number;
    status_message: string;
    tasks?: { status_code: number; status_message: string; result?: T[] | null }[];
  };
  if (data.status_code !== 20000) {
    throw new DataForSeoError(`DataForSEO error: ${data.status_message}`);
  }
  const task = data.tasks?.[0];
  if (!task) throw new DataForSeoError("DataForSEO returned no tasks.");
  if (task.status_code !== 20000) {
    throw new DataForSeoError(`DataForSEO task error: ${task.status_message}`);
  }
  return task.result?.[0] ?? null;
}

// ── SERP organic ──────────────────────────────────────────────────────────────

export type SerpResult = {
  rank: number;
  title: string;
  url: string; // scheme-stripped display URL
  snippet: string;
  domain: string;
};

type SerpItem = {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  domain?: string | null;
};

export async function fetchSerpOrganic(
  keyword: string,
  locationCode: number,
  languageCode: string,
  depth: number = 10,
): Promise<SerpResult[]> {
  const result = await postTaskResult<{ items?: SerpItem[] | null }>(SERP_URL, [
    { keyword, location_code: locationCode, language_code: languageCode, depth },
  ]);
  const items = result?.items ?? [];
  return items
    .filter((it) => it.type === "organic" && it.url)
    .map((it) => ({
      rank: it.rank_group ?? it.rank_absolute ?? 0,
      title: it.title ?? "",
      url: (it.url ?? "").replace(/^https?:\/\//, ""),
      snippet: it.description ?? "",
      domain: it.domain ?? "",
    }));
}

// ── Keyword suggestions (관련 검색어) ─────────────────────────────────────────

export type SearchIntent =
  | "informational"
  | "navigational"
  | "transactional"
  | "commercial";

export type SuggestionResult = {
  keyword: string;
  volume: number;
  intent: SearchIntent;
};

type SuggestionItem = {
  keyword: string;
  keyword_info?: { search_volume?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
};

const INTENTS: ReadonlySet<string> = new Set([
  "informational",
  "navigational",
  "transactional",
  "commercial",
]);

function normalizeIntent(raw: string | null | undefined): SearchIntent {
  return raw && INTENTS.has(raw) ? (raw as SearchIntent) : "informational";
}

export async function fetchKeywordSuggestions(
  keyword: string,
  locationCode: number,
  languageCode: string,
  limit: number = 50,
  opts?: { includeSeedKeyword?: boolean },
): Promise<{ items: SuggestionResult[]; totalCount: number }> {
  const result = await postTaskResult<{
    total_count?: number;
    items?: SuggestionItem[] | null;
  }>(SUGGESTIONS_URL, [
    {
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      include_seed_keyword: opts?.includeSeedKeyword ?? false,
      include_serp_info: false,
      ignore_synonyms: false,
      include_clickstream_data: false,
      exact_match: false,
      limit,
    },
  ]);
  const items = (result?.items ?? [])
    .map((it) => ({
      keyword: it.keyword,
      volume: it.keyword_info?.search_volume ?? 0,
      intent: normalizeIntent(it.search_intent_info?.main_intent),
    }))
    .sort((a, b) => b.volume - a.volume);
  return { items, totalCount: result?.total_count ?? items.length };
}
