// Single source of truth for turning an ISO 3166-1 alpha-2 country code
// (as it flows out of scope / the DB / scope-policy) into a locale-specific
// full country name for display. Wraps the browser/Node Intl.DisplayNames
// "region" type so we never surface a bare code (e.g. "IT", "KR") in the UI.
//
// Use this instead of inlining `new Intl.DisplayNames(...)` so every rendering
// site localizes codes the same way and falls back identically. `.of()` expects
// a canonical (upper-case) region subtag, so we normalize first; unknown codes
// fall back to the code itself.

import { pseudoCountryLabel } from "./pseudo-country";

const cache = new Map<string, Intl.DisplayNames>();

function formatter(locale: string): Intl.DisplayNames {
  let f = cache.get(locale);
  if (!f) {
    f = new Intl.DisplayNames([locale], { type: "region" });
    cache.set(locale, f);
  }
  return f;
}

/** Localized full country name for an ISO alpha-2 code, or the code if unknown. */
export function countryName(code: string | null | undefined, locale: string): string {
  if (!code) return "";
  // 의사 코드(SA-Dammam·CN-BJ …)는 Intl 이 모른다 — 정본 라벨을 먼저 본다.
  const pseudo = pseudoCountryLabel(code.trim(), locale);
  if (pseudo) return pseudo;
  const normalized = code.trim().toUpperCase();
  try {
    return formatter(locale).of(normalized) ?? code;
  } catch {
    // Invalid/non-region input → never throw in render; show the raw code.
    return code;
  }
}
