import "server-only";
import {
  fetchKeywordSuggestions,
  fetchSerpOrganic,
  type SearchIntent,
} from "./dataforseo-discovery";
import { getKeywordVolumes } from "./service";
import { generateNaturalQuestions } from "./keyword-to-prompt";
import { cacheGet, cacheSet, TTL } from "./cache";

/**
 * Assembles the live data that powers the Google Keyword intent view, replacing
 * the static sample fixtures:
 *   - getKeywordInsight  → 12-month search-volume trend + SERP rows, each with
 *                          an LLM-drafted "suggested prompt".
 *   - getRelatedKeywords → keyword suggestions (term + volume + intent).
 *
 * The trend uses DataForSEO Google Ads `monthly_searches` (12 dense monthly
 * points) — NOT Google Trends, whose 0-100 interest series is mostly null for
 * long-tail keywords (sparse/jagged). The client normalizes + slices per range.
 *
 * Both functions cache their full payload in keyword_cache (best-effort) so a
 * page refresh is a cache hit, not a re-paid DataForSEO + OpenRouter round-trip.
 */

export type SerpRow = {
  id: string;
  rank: number;
  url: string;
  title: string;
  snippet: string;
  suggestedPrompt: string;
};

// `primary` is the RAW monthly search volume; the client normalizes the visible
// window to 0-100 for the interest chart + average gauge.
export type TrendPoint = { week: string; primary: number };

export type KeywordInsight = {
  label: string;
  trend: TrendPoint[];
  serp: SerpRow[];
};

export type RelatedItem = {
  id: string;
  term: string;
  volume: number;
  intent: SearchIntent;
};

const MAX_SERP_ROWS = 8;

function cacheKey(kind: string, term: string, loc: number, lang: string): string {
  return `${kind}|${term.trim().toLowerCase()}|${loc}|${lang}`;
}

// 12-month volume series → chronological {label, rawVolume} points.
function buildMonthlyTrend(
  monthly: { year: number; month: number; search_volume: number }[],
): TrendPoint[] {
  return [...monthly]
    .sort((a, b) => a.year * 100 + a.month - (b.year * 100 + b.month))
    .map((m) => ({
      week: `${String(m.year).slice(2)}.${m.month}`,
      primary: m.search_volume ?? 0,
    }));
}

// Build one natural-language prompt per SERP row via the keyword→prompt LLM.
// Uses the "[keyword]-Title - Snippet" format generateNaturalQuestions already
// understands. Falls back to the keyword itself if the LLM call fails.
async function draftPrompts(
  term: string,
  rows: { title: string; snippet: string }[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const inputs = rows.map(
    (r) => `[${term}]-${r.title} - ${r.snippet}`.slice(0, 400),
  );
  try {
    const questions = await generateNaturalQuestions(inputs, inputs.length);
    const byInput = new Map(questions.map((q) => [q.originalInput, q.question]));
    return inputs.map(
      (input, i) => byInput.get(input) ?? questions[i]?.question ?? term,
    );
  } catch {
    return rows.map(() => term);
  }
}

async function computeKeywordInsight(
  term: string,
  locationCode: number,
  languageCode: string,
): Promise<KeywordInsight> {
  // Volume (cached → monthly_searches) + SERP in parallel; SERP feeds the LLM.
  const [volumes, serpRaw] = await Promise.all([
    getKeywordVolumes([term], locationCode, languageCode),
    fetchSerpOrganic(term, locationCode, languageCode, 10),
  ]);

  const monthly = volumes[0]?.monthly_searches ?? [];
  const trend = buildMonthlyTrend(monthly);

  const serpTop = serpRaw.slice(0, MAX_SERP_ROWS);
  const prompts = await draftPrompts(term, serpTop);
  const serp: SerpRow[] = serpTop.map((r, i) => ({
    id: `serp-${i}-${r.rank}`,
    rank: r.rank,
    url: r.url,
    title: r.title,
    snippet: r.snippet,
    suggestedPrompt: prompts[i] ?? term,
  }));

  return { label: term, trend, serp };
}

export async function getKeywordInsight(
  term: string,
  locationCode: number,
  languageCode: string,
  opts?: { fresh?: boolean },
): Promise<KeywordInsight> {
  const key = cacheKey("insight", term, locationCode, languageCode);
  // `fresh` (the "재생성" button) bypasses the read but still refreshes the cache.
  if (!opts?.fresh) {
    const cached = await cacheGet<KeywordInsight>(key);
    if (cached) return cached;
  }
  const result = await computeKeywordInsight(term, locationCode, languageCode);
  await cacheSet(key, result, TTL.insight);
  return result;
}

async function computeRelatedKeywords(
  term: string,
  locationCode: number,
  languageCode: string,
): Promise<{ foundCount: number; items: RelatedItem[] }> {
  const { items, totalCount } = await fetchKeywordSuggestions(
    term,
    locationCode,
    languageCode,
    30,
  );
  return {
    foundCount: totalCount,
    items: items.map((it, i) => ({
      id: `rel-${i}`,
      term: it.keyword,
      volume: it.volume,
      intent: it.intent,
    })),
  };
}

export async function getRelatedKeywords(
  term: string,
  locationCode: number,
  languageCode: string,
): Promise<{ foundCount: number; items: RelatedItem[] }> {
  const key = cacheKey("related", term, locationCode, languageCode);
  const cached = await cacheGet<{ foundCount: number; items: RelatedItem[] }>(key);
  if (cached) return cached;
  const result = await computeRelatedKeywords(term, locationCode, languageCode);
  await cacheSet(key, result, TTL.related);
  return result;
}

// Multi-keyword search for the empty-state Google Keyword flow (no tracked
// keywords yet): each searched term gets its OWN volume/intent — via
// include_seed_keyword, unlike getRelatedKeywords which deliberately omits the
// seed — plus its related terms, so a fresh project can search "a, b, c" and
// pick what to track in one pass.
export type KeywordSearchGroup = {
  term: string;
  volume: number;
  intent: SearchIntent;
  foundCount: number;
  related: RelatedItem[];
};

async function computeKeywordSearchGroup(
  term: string,
  locationCode: number,
  languageCode: string,
): Promise<KeywordSearchGroup> {
  const { items, totalCount } = await fetchKeywordSuggestions(
    term,
    locationCode,
    languageCode,
    30,
    { includeSeedKeyword: true },
  );
  const seedIndex = items.findIndex(
    (it) => it.keyword.trim().toLowerCase() === term.trim().toLowerCase(),
  );
  const seed = seedIndex >= 0 ? items[seedIndex] : null;
  const related = items.filter((_, i) => i !== seedIndex);
  return {
    term,
    volume: seed?.volume ?? 0,
    intent: seed?.intent ?? "informational",
    foundCount: totalCount,
    related: related.map((it, i) => ({
      id: `rel-${i}`,
      term: it.keyword,
      volume: it.volume,
      intent: it.intent,
    })),
  };
}

export async function getKeywordSearchGroups(
  terms: string[],
  locationCode: number,
  languageCode: string,
): Promise<KeywordSearchGroup[]> {
  const unique = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  return Promise.all(
    unique.map(async (term) => {
      const key = cacheKey("searchgroup", term, locationCode, languageCode);
      const cached = await cacheGet<KeywordSearchGroup>(key);
      if (cached) return cached;
      const result = await computeKeywordSearchGroup(term, locationCode, languageCode);
      await cacheSet(key, result, TTL.related);
      return result;
    }),
  );
}
