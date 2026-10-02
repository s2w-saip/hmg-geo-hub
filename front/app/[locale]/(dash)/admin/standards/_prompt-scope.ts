import type { PromptType } from "@/lib/db/repositories/prompts";

// Maps the HMG standard-prompt fields (promptType / category / brand) onto a
// scope prompt's `keywords` bag and back. scope's Prompt has only
// text/funnel_stage/keywords/active, so the HMG-specific taxonomy rides in
// keywords under an `hmg:` prefix (scope already uses keywords as a metadata
// bag — e.g. "depth1:...", "funnel:..."). text↔text and enabled↔active map
// natively; funnel_stage is left untouched by the admin UI.

const PROMPT_TYPES: PromptType[] = [
  "comparison",
  "recommendation",
  "information",
  "other",
];

const TYPE_PREFIX = "hmg:type:";
const CATEGORY_PREFIX = "hmg:category:";
const BRAND_PREFIX = "hmg:brand:";

export interface StandardPromptFields {
  promptType: PromptType | null;
  category: string | null;
  brand: string | null;
}

// Build the keyword tags for a new/updated scope prompt from the HMG fields.
export function encodeStandardKeywords(f: StandardPromptFields): string[] {
  const out: string[] = [];
  if (f.promptType) out.push(`${TYPE_PREFIX}${f.promptType}`);
  if (f.category) out.push(`${CATEGORY_PREFIX}${f.category}`);
  if (f.brand) out.push(`${BRAND_PREFIX}${f.brand}`);
  return out;
}

// Recover the HMG fields from a scope prompt's keywords. Unknown keywords
// (e.g. the seeded "depth1:..." tags) are ignored → those columns show "—".
export function decodeStandardKeywords(
  keywords?: string[] | null,
): StandardPromptFields {
  let promptType: PromptType | null = null;
  let category: string | null = null;
  let brand: string | null = null;
  for (const kw of keywords ?? []) {
    if (kw.startsWith(TYPE_PREFIX)) {
      const v = kw.slice(TYPE_PREFIX.length);
      if ((PROMPT_TYPES as string[]).includes(v)) promptType = v as PromptType;
    } else if (kw.startsWith(CATEGORY_PREFIX)) {
      category = kw.slice(CATEGORY_PREFIX.length) || null;
    } else if (kw.startsWith(BRAND_PREFIX)) {
      brand = kw.slice(BRAND_PREFIX.length) || null;
    }
  }
  return { promptType, category, brand };
}
