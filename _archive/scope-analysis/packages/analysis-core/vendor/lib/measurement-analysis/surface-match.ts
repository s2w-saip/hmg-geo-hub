// Shared surface-matching rule for customer-configured text surfaces
// (tracked-brand names in the risk index, attribute aliases in attribute
// affinity — changes risk-priority-index / attribute-affinity).
//
// Case-insensitive substring, EXCEPT ASCII surfaces of ≤3 characters which
// require word boundaries — "T" must never match inside "베스트"/"LTE".

export type SurfaceMatcher = (lowerHay: string) => boolean;

export function buildSurfaceMatcher(surfaces: string[]): SurfaceMatcher {
  const substrings: string[] = [];
  const boundaryRes: RegExp[] = [];
  for (const raw of surfaces) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    if (/^[a-z0-9]{1,3}$/.test(s)) {
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      boundaryRes.push(new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`));
    } else {
      substrings.push(s);
    }
  }
  return (lowerHay: string) =>
    substrings.some((s) => lowerHay.includes(s)) ||
    boundaryRes.some((re) => re.test(lowerHay));
}

export interface SurfaceLocation {
  /** char offset in the ORIGINAL (non-lowercased) hay */
  start: number;
  end: number;
  /** the surface (from `surfaces`) that matched, original case */
  surface: string;
}

/**
 * Earliest occurrence of ANY surface in `hay`, under the SAME rule as
 * `buildSurfaceMatcher` (case-insensitive; ASCII surfaces of ≤3 chars require
 * word boundaries so "LG" never matches inside "블로그"/"aLGo"). Offsets index
 * the original `hay` (case preserved) so a caller can slice the verbatim
 * surface and record an honest char-span. Returns null when nothing matches.
 *
 * Single-sources the tracked-brand presence rule with `buildSurfaceMatcher`
 * (changes capture-tracked-brand-factual-mentions).
 */
export function locateSurfaceMatch(
  hay: string,
  surfaces: string[],
): SurfaceLocation | null {
  let best: SurfaceLocation | null = null;
  const consider = (start: number, length: number, surface: string): void => {
    if (start < 0) return;
    if (best === null || start < best.start) {
      best = { start, end: start + length, surface };
    }
  };
  // Match case-insensitively against the ORIGINAL hay (regex `i` flag) rather
  // than a lowercased copy: `String.toLowerCase()` can change length (Turkish
  // İ→i̇, ﬁ ligatures), which drifts offsets computed on the lowered copy when
  // applied back to the original — a corrupt span with `source_verified:true`.
  // The `i` flag folds ASCII case (length-preserving), so offsets and the
  // matched-substring length are always in original coordinates.
  for (const raw of surfaces) {
    const s = raw.trim();
    if (!s) continue;
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/^[a-z0-9]{1,3}$/i.test(s)) {
      // Word-boundary search: same boundary rule as buildSurfaceMatcher — the
      // `i` flag also case-folds the [a-z0-9] boundary class so an uppercase
      // neighbor still counts as alphanumeric. Short ASCII tokens ("LG") never
      // match inside longer words.
      const re = new RegExp(`(^|[^a-z0-9])(${esc})($|[^a-z0-9])`, "i");
      const m = re.exec(hay);
      if (m) consider(m.index + m[1]!.length, m[2]!.length, s);
    } else {
      const re = new RegExp(esc, "i");
      const m = re.exec(hay);
      if (m) consider(m.index, m[0].length, s);
    }
  }
  return best;
}
