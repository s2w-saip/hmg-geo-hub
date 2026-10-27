// View defaults contain no generated research or measurement data.
import type { ContextMatrix, GeneratedPrompt } from "./types";
export const RESEARCH_PURPOSES = [
  { id: "purchase-context", rows: 8, default: true },
  { id: "competitor-voc", rows: 6, default: false },
  { id: "feature-demand", rows: 6, default: false },
  { id: "custom", rows: 4, default: false },
] as const;
export type ResearchPurposeId = (typeof RESEARCH_PURPOSES)[number]["id"];
export type ResearchLocale = "ko" | "en";
export function getSeedKeywords(_locale: string): string[] { return []; }
export function getEmptyMatrix(_locale: string): ContextMatrix { return { keyword: "", themes: [], contexts: [], categories: [], conditions: [], drives: [], combinations: [], stats: { contexts: 0, conditions: 0, relationships: 0, sources: 0, workers: 0, cost: 0 } }; }
export function getGeneratedPrompts(_locale: string): GeneratedPrompt[] { return []; }
