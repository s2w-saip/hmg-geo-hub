// Curated exclusion list for the read-only 표준 프롬프트 viewer (/standard/prompts).
//
// Multi-brand "잘못" prompts — a single prompt naming 2+ HMG marques in one
// sentence (e.g. "현대 vs 기아 vs 제네시스 중 …") — break per-brand GEO
// measurement and are hidden from the viewer. The standard catalog is a FIXED
// set, so this is a HAND-CURATED list judged by operators: there is no admin UI
// and no runtime text heuristic (decision 2026-06-15, see
// docs/snb-standard-prompt-viewer-plan.md §4.4).
//
// Empty to start: the demo seed has no multi-brand prompts. As the live catalog
// is judged, add the offending prompt ids (preferred — stable) or exact texts.
export const EXCLUDED_STANDARD_PROMPT_IDS: readonly string[] = [];
export const EXCLUDED_STANDARD_PROMPT_TEXTS: readonly string[] = [];

const EXCLUDED_TEXT_SET = new Set(
  EXCLUDED_STANDARD_PROMPT_TEXTS.map((t) => t.trim()),
);
const EXCLUDED_ID_SET = new Set(EXCLUDED_STANDARD_PROMPT_IDS);

// True → hide this catalog row from the read-only viewer. Matched by id first
// (stable), then by exact trimmed text (fallback when only the text is known).
export function isExcludedStandardPrompt(row: {
  id: string;
  text: string;
}): boolean {
  return EXCLUDED_ID_SET.has(row.id) || EXCLUDED_TEXT_SET.has(row.text.trim());
}
