// Branded vs unbranded prompt classification, derived from the catalog brand tag.
//
// The HMG standard framework tags every prompt with a brand. Brand-agnostic
// prompts ("What car brand is innovative?") carry the umbrella tag 'HMG';
// prompts that name a specific marque ("How does Hyundai compare on EV range?")
// carry that marque. Verified against the root catalog (2026-06-11): all 82
// HMG-tagged prompts name no marque, and all 168 marque-tagged prompts name
// their marque — so `brand === 'HMG'` ⟺ the prompt does NOT name a brand.
// NOTE (2026-07-02): the prompts table now also holds brand=NULL rows from
// OTHER projects (per-project prompt imports). null stays outside this
// classification (presence null → excluded by an active filter) — the rule
// above holds for the root standard catalog only.
//
// Client-safe (no "server-only"): the admin prompt list (a client component)
// also derives the column label from this, and the dashboard filter wires the
// same canonical values. Keep this the single source of the rule.
export const UMBRELLA_BRAND = "HMG";

// Canonical URL/filter values (locale-independent). i18n labels live under
// dashboard.filters.value.{branded,unbranded}.
export type BrandPresence = "branded" | "unbranded";

// Resolve a catalog row's presence class.
//
// `explicit` = prompts.brand_presence (migration 0032) — the editorial 정본,
// loaded from the 3사 framework 엑셀 `brand 유무` 컬럼. Prefer it whenever set:
// brand-inclusion is a property of the prompt TEXT, which the `brand` tag
// (= which brand catalog the row belongs to) cannot express. Root catalog rows
// all carry it, so they no longer fall through to the tag heuristic.
//
// Fallback (explicit null) keeps the pre-0032 rule for catalogs that have no
// such column populated (website prompts 등) — brand='HMG'(umbrella) = unbranded.
// null brand AND null explicit → null (unknown; excluded by an active filter,
// same policy as the other catalog axes).
export function brandPresenceOf(
  brand: string | null | undefined,
  explicit?: string | null,
): BrandPresence | null {
  if (explicit === "branded" || explicit === "unbranded") return explicit;
  if (brand == null) return null;
  return brand === UMBRELLA_BRAND ? "unbranded" : "branded";
}
