// Type-only snapshot; no database or server implementation is included.
import { type CitationCategory } from "./taxonomy";
export { CITATION_CATEGORIES, FALLBACK_CATEGORY, isCitationCategory } from "./taxonomy";
export type { CitationCategory } from "./taxonomy";
/**
 * Operator override layer: normalized registrable domain → category.
 * Built by loadCitationOverrides() (./overrides-loader). An empty/absent map
 * means "no overrides" — every code path must behave identically to the
 * pre-override classifier in that case (regression baseline).
 */
export type CitationOverrideMap = ReadonlyMap<string, CitationCategory>;
/** Shared empty map — avoids allocating one per call site. */
export declare const EMPTY_CITATION_OVERRIDES: CitationOverrideMap;
/** Curated seed size — exposed for the curation script / tests. */
export declare const SEED_DOMAIN_COUNT: number;
/**
 * The domain key shape used by seed.json, the override table PK and every
 * lookup here: lowercase registrable domain with a leading `www.` stripped.
 * Exported so writers (the override repository / admin action) can normalize
 * with the exact same function the reader uses — a mismatch would make an
 * override silently inert.
 */
export declare function normalizeCitationDomain(domain: string | null | undefined): string;
/** Curated-seed lookup on an already-normalized domain (null = not seeded). */
export declare function seedCategoryOf(normalizedDomain: string): CitationCategory | null;
/**
 * Category for one citation row, given whatever category the row itself carries.
 *
 * Precedence: **operator override > stored/engine category > local classifier**.
 * The override wins on purpose (제품 결정 2026-08-21) — a human correction is more
 * trustworthy than an engine's automatic label, and putting it below `row.category`
 * would silently disable the whole admin screen the moment scope starts sending
 * categories (mirror sync stores `c?.category ?? null`, and mock rows already carry
 * one). Every citation rollup MUST go through this so live and mirror agree.
 */
export declare function resolveCitationCategory(rowCategory: string | null | undefined, domain: string | null | undefined, overrides?: CitationOverrideMap | null): string;
/**
 * Categorize a cited registrable domain. Total function — unknown domains get
 * FALLBACK_CATEGORY, mirroring the aeorank fallback baseline (Other).
 */
export declare function categorizeDomain(domain: string | null | undefined, overrides?: CitationOverrideMap | null): CitationCategory;
