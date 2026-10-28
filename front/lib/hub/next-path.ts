// Where the HUB login returns to (2026-10-27): a path of this site under the locale, else the renewal dashboard.

export function hubLoginNext(raw: unknown, locale: string): string {
  const fallback = `/${locale}/renewal/dashboard`;
  if (typeof raw !== "string" || raw.length > 2000) return fallback;
  // same-site only: no scheme, no protocol-relative //host, no backslash tricks
  if (!raw.startsWith(`/${locale}/`) || raw.includes("//") || raw.includes("\\")) return fallback;
  return raw;
}
