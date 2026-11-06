// Customer-facing citation URL label.
//
// Strips the scheme and the URL *fragment* so the raw scroll-to-text directive
// (`#:~:text=…`, appended by AI engines to pinpoint the exact cited passage) and
// any `#anchor` are never shown to customers — they're noise in a URL label.
//
// IMPORTANT: this is for the visible label only. The <a href> keeps the FULL url
// (fragment intact) so the link still deep-links to — and highlights — the exact
// passage the engine cited.
//
// The fragment is cut at the FIRST `#`, unconditionally — by index, not by a
// `/#.*$/` regex whose `.` stops at line breaks (\n, \r, U+2028, U+2029). This
// keeps the label byte-identical to the server search predicate
// `regexp_replace(split_part(url, '#', 1), '^https?://', '')`
// (scope-aggregates `citationDisplayUrlSql`); for inputs without line breaks the
// result is identical to the former regex. Parity table:
// lib/db/repositories/scope-aggregates.citation-url-search.test.ts.
export function displayCitationUrl(url: string): string {
  const noScheme = url.replace(/^https?:\/\//, "");
  const hash = noScheme.indexOf("#");
  return hash === -1 ? noScheme : noScheme.slice(0, hash);
}
