import type { GeneratedPrompt } from "@/components/social-scraping/types";

/**
 * The social-scraping catalog's "이미 추가됨" mark (not sendable, hidden when the
 * "추가됨 표시" filter is off). A row is added when its question is in `added` —
 * the page's candidate texts (legacy source) plus the texts sent this session —
 * or when the backend marked it as already in the candidate pool (API source,
 * GeneratedPrompt.inCandidatePool), which spares the page reading the whole pool.
 */
export function isAlreadyAdded(added: ReadonlySet<string>, p: GeneratedPrompt): boolean {
  return added.has(p.question) || p.inCandidatePool === true;
}
