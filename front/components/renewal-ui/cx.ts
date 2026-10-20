// Class joiner for the renewal library. Deliberately NOT tailwind-merge: merge does not
// know the rn-* font-size tokens (text-rn-13) and would treat them as colours, silently
// dropping one of `text-rn-13 text-rn-navy`. Components here never pass conflicting
// utilities, so a plain join is enough.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
