// Which layer produced a domain's citation category — UI badge only.
//
// categorizeDomain() collapses the precedence chain into a single value; the
// admin curation screen needs to show *why* a domain is classified the way it
// is (and warn when an operator override shadows a verified owned domain). This
// module re-walks the SAME chain in the SAME order and reports the winning
// layer. It must stay in lockstep with categorizeDomain() — the parity test
// (source.test.ts) asserts that the reported layer's category equals what
// categorizeDomain() returns for every probe domain.

import { ownedBrandOf } from "@/lib/geo-catalog/owned";
import { ruleCategory } from "./rules";
import { normalizeCitationDomain, seedCategoryOf, type CitationOverrideMap } from "./index";

/**
 * Classification layer that decided the category:
 * - `override` — operator correction row in citation_domain_overrides
 * - `owned`    — geo-catalog owned-domain inventory → Official (HMG)
 * - `seed`     — curated seed.json entry
 * - `rule`     — generic rules.ts pass
 * - `fallback` — nothing matched → "Other" (also empty/null domains)
 */
export type ClassificationSource = "override" | "owned" | "seed" | "rule" | "fallback";

export function classificationSource(
  domain: string | null | undefined,
  overrides?: CitationOverrideMap | null,
): ClassificationSource {
  const d = normalizeCitationDomain(domain);
  if (!d) return "fallback";
  if (overrides?.get(d)) return "override";
  if (ownedBrandOf(d) !== null) return "owned";
  if (seedCategoryOf(d) !== null) return "seed";
  if (ruleCategory(d) !== null) return "rule";
  return "fallback";
}

/**
 * Does an override shadow a verified owned (HMG) domain? The override layer sits
 * above the owned catalog by design, so this is legal — but the screen shows a
 * warning badge because it means the operator is contradicting the canonical
 * inventory. False for every domain when no override exists.
 */
export function overrideShadowsOwned(
  domain: string | null | undefined,
  overrides?: CitationOverrideMap | null,
): boolean {
  const d = normalizeCitationDomain(domain);
  if (!d) return false;
  return Boolean(overrides?.get(d)) && ownedBrandOf(d) !== null;
}
