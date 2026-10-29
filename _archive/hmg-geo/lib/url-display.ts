// Customer-facing citation URL label.
//
// Strips the scheme and the URL *fragment* so the raw scroll-to-text directive
// (`#:~:text=…`, appended by AI engines to pinpoint the exact cited passage) and
// any `#anchor` are never shown to customers — they're noise in a URL label.
//
// IMPORTANT: this is for the visible label only. The <a href> keeps the FULL url
// (fragment intact) so the link still deep-links to — and highlights — the exact
// passage the engine cited.
export function displayCitationUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/#.*$/, "");
}
