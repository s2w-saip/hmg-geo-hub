// Type-only snapshot; no database or server implementation is included.
import { type CitationOverrideMap } from "./index";
/**
 * Classification layer that decided the category:
 * - `override` — operator correction row in citation_domain_overrides
 * - `owned`    — geo-catalog owned-domain inventory → Official (HMG)
 * - `seed`     — curated seed.json entry
 * - `rule`     — generic rules.ts pass
 * - `fallback` — nothing matched → "Other" (also empty/null domains)
 */
export type ClassificationSource = "override" | "owned" | "seed" | "rule" | "fallback";
export declare function classificationSource(domain: string | null | undefined, overrides?: CitationOverrideMap | null): ClassificationSource;
/**
 * Does an override shadow a verified owned (HMG) domain? The override layer sits
 * above the owned catalog by design, so this is legal — but the screen shows a
 * warning badge because it means the operator is contradicting the canonical
 * inventory. False for every domain when no override exists.
 */
export declare function overrideShadowsOwned(domain: string | null | undefined, overrides?: CitationOverrideMap | null): boolean;
