import "server-only";
import type { GeneratedPrompt } from "@/components/social-scraping/types";

/**
 * Lightweight lexical similarity for the social-scraping catalog — flags
 * generated prompts that are close to what the project already has (registered
 * prompts / candidate pool), so the user can skip near-duplicates.
 *
 * Character-bigram cosine over normalized text: deterministic, zero-infra
 * (no embeddings/pgvector), and adequate for short Korean consumer questions
 * where shared vocabulary (차종/조건 표현) dominates. Computed on the fly at
 * read time — never persisted, since the comparison set (existing prompts)
 * keeps changing.
 */

function normalize(text: string): string {
  return text
    .toLowerCase()
    // strip everything except letters/digits across scripts (Hangul included)
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const g = text.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/** Cosine similarity of two texts' character-bigram frequency vectors, 0..1. */
export function textSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let dot = 0;
  for (const [g, ca] of ga) {
    const cb = gb.get(g);
    if (cb) dot += ca * cb;
  }
  if (dot === 0) return 0;
  let magA = 0;
  for (const c of ga.values()) magA += c * c;
  let magB = 0;
  for (const c of gb.values()) magB += c * c;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface ExistingPromptRef {
  text: string;
  /** where the existing text lives — registered prompt vs candidate pool. */
  kind: "prompt" | "candidate";
}

// Show the badge only for genuinely-similar pairs. 0.5 on bigram cosine is a
// strong overlap for short Korean questions; boilerplate endings alone
// (…추천해줘 / …알려줘) stay well below it.
export const SIMILARITY_THRESHOLD = 0.5;

/**
 * Annotate each generated prompt with its most similar existing text (if any
 * clears the threshold). Exact matches are the "이미 추가됨" state, handled
 * separately — they are skipped here to avoid a redundant 100% badge.
 */
export function annotateSimilar(
  prompts: GeneratedPrompt[],
  existing: ExistingPromptRef[],
): GeneratedPrompt[] {
  if (existing.length === 0) return prompts;
  return prompts.map((p) => {
    let best: { text: string; score: number; kind: "prompt" | "candidate" } | null =
      null;
    for (const e of existing) {
      if (e.text === p.question) continue; // exact match = 추가됨, not 유사
      const score = textSimilarity(p.question, e.text);
      if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
        best = { text: e.text, score, kind: e.kind };
      }
    }
    return best ? { ...p, similarTo: best } : p;
  });
}
