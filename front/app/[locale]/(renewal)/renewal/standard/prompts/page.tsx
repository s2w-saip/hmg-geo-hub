import { setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { throwForPage } from "@/lib/hgh/errors";
import { effectiveScopeCountries } from "@/lib/rhq";
import { loadPromptsScreens } from "@/app/[locale]/(dash)/standard/prompts/_data/server";
import { loadSavedFilters } from "../../_components/saved-filters-server";
import { RnPromptsView } from "./_components/prompts-view";

// Renewal Global prompts (2026-10-20) — the redesigned /standard/prompts, served side by
// side with the original for comparison. Same reads (the screens catalog/prompts-*), same
// filters; only the presentation (left filter panel, picks applied at once, saved filters)
// differs. Keep in step with /standard/prompts/page.tsx.
export default async function RenewalStandardPromptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (same as the original page).
  if (!canAccessRoute(session.user.role, "/renewal/standard/prompts")) redirect(`/${locale}/dashboard`);

  const scope = session.user.scope;
  const { tab } = await searchParams;
  const [{ catalog, header, history }, saved] = await Promise.all([load(), loadSavedFilters("prompts")]);

  async function load() {
    try {
      return await loadPromptsScreens();
    } catch (e) {
      throwForPage(e, locale);
    }
  }

  return (
    <RnPromptsView
      remote={{ initial: catalog }}
      scopeAll={scope.all}
      scopeRole={session.user.role}
      scopeBrands={scope.brands ?? []}
      scopeRegions={scope.regions ?? []}
      // the countries the list keeps (a region account: its regions' countries, as the reader's scope: renewal audit 13-3)
      scopeCountries={effectiveScopeCountries(scope) ?? []}
      period={header.period}
      history={history}
      initialTab={tab === "history" ? "history" : "catalog"}
      savedFilters={{ page: "prompts", userId: session.user.id, initial: saved }}
    />
  );
}
