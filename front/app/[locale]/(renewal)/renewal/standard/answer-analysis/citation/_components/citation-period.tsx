import { getTranslations } from "next-intl/server";

// The Citation pages' header period (Global and Website, 2026-11-02). The pill printed the URL's own range, so a URL
// or a saved filter past the service week — 2026-10-01..2026-10-31 with the week ending 10-11 — read as data up to
// 10-31 while every read stopped at 10-11. It prints the period the BFF answers in citation/renewal-header instead: no
// Gold read, so it prints at once as the Mention and ACR pills do (review r2-13: from citation/as-of it waited for the
// citation read, 1.4–12.7 s cold).

/** citation/renewal-header: the URL range held to the service week by the BFF, null without a period or with nothing left to show. */
export type RnCitationHeader = { period: { from: string | null; to: string | null } | null };

/** The header pill's period text; "—" when there is nothing to show (a range wholly after the week, a failed read). */
export async function RnCitationPeriodText({ head }: { head: Promise<RnCitationHeader> }) {
  const t = await getTranslations("renewal.citation");
  const p = (await head.catch(() => null))?.period ?? null;
  if (!p || !(p.from || p.to) || (p.from && p.to && p.from > p.to)) return <>—</>;
  return <>{t("periodRange", { from: p.from ?? "…", to: p.to ?? "…" })}</>;
}
