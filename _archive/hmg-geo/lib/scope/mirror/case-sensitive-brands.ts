import type { ResolvedMention } from "@/lib/scope/types";

// scope's mention NER is case-insensitive, so a brand whose name collides
// with a common word gets over-counted from ordinary-noun usage. Verified
// 2026-07-03 against the full scope_mentions mirror: brand="SEAT" had 2855
// rows / 5401 total mention_count, but only ~8 mentions were the real
// Spanish automaker — the rest were "rear seat" / "seat comfort" / "Seat
// Protectors" (markdown-bold noun usage) etc. Across the whole answer corpus,
// every genuine SEAT-brand reference scope produced ("SEAT Ibiza", "VW, Audi,
// Škoda, SEAT", entity["brand","SEAT",...]) was rendered fully uppercase, and
// zero genuine brand mentions were found in lowercase/title-case form — so a
// strict case-sensitive whole-word recount on the raw answer text reliably
// separates the two without needing semantic classification.
//
// key = lowercased brand display_name scope assigns; value = the exact-case
// surface form that counts as a genuine mention of that brand.
const CASE_SENSITIVE_BRANDS: Record<string, string> = {
  seat: "SEAT",
};

function countExactSurface(answerText: string, surface: string): number {
  const re = new RegExp(`\\b${surface}\\b`, "g");
  return [...answerText.matchAll(re)].length;
}

// Applied per (job, Brand-entity) mention at mirror-sync time, before the row
// is written to scope_mentions. Returns the mention unchanged for brands not
// in the collision list, the mention with a corrected mention_count/surfaces
// when at least one genuine exact-case occurrence is found, or null when the
// mirror should drop the row entirely (zero genuine occurrences — the
// original count was 100% noun noise).
export function correctCaseSensitiveBrandMention(
  mention: ResolvedMention,
  answerText: string | null | undefined,
): ResolvedMention | null {
  if (mention.entity_type !== "Brand") return mention;
  const displayName = mention.display_name?.trim();
  if (!displayName) return mention;
  const requiredSurface = CASE_SENSITIVE_BRANDS[displayName.toLowerCase()];
  if (!requiredSurface) return mention;
  if (!answerText) return null;
  const count = countExactSurface(answerText, requiredSurface);
  if (count === 0) return null;
  return { ...mention, mention_count: count, surfaces: [requiredSurface] };
}
