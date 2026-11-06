// Type-only snapshot; no database or server implementation is included.
import type { CitationCategory } from "./taxonomy";
/**
 * Generic (non-seed) rules over a normalized registrable domain.
 * Returns null when no rule fires — the caller decides the fallback.
 */
export declare function ruleCategory(domain: string): CitationCategory | null;
