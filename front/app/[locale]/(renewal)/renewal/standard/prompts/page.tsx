import { setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { promptAuditLogRepository } from "@/lib/db/repositories/prompt-audit-logs";
import { standardCollectionDates } from "@/lib/db/repositories/scope-aggregates";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { listGlobalAuditApi, standardCollectionPeriodApi } from "@/lib/hgh/adapters/catalog";
import { throwForPage } from "@/lib/hgh/errors";
import { scopeForGeoSurface } from "@/lib/scope/website-virtual-geo";
import { loadCatalogPage, loadCatalogRows } from "@/app/[locale]/(dash)/standard/prompts/_page-actions";
import { RnPromptsView } from "./_components/prompts-view";

// Renewal Global prompts (2026-10-20) — the redesigned /standard/prompts, served side by
// side with the original for comparison. Same reads (legacy and HGH api paths), same
// catalog actions and the same filters; only the presentation (left filter panel,
// picks applied at once, saved filters) differs. Keep in step with /standard/prompts/page.tsx.
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
  // Defense in depth on top of the DashLayout server guard (same as the original page).
  if (!canAccessRoute(session.user.role, "/renewal/standard/prompts")) redirect(`/${locale}/dashboard`);

  const scope = session.user.scope;
  const { tab } = await searchParams;
  const { catalog, from, to, auditRows } = isAnalysisApi("prompts", "global") ? await loadApi() : await loadLegacy();

  async function loadApi() {
    try {
      const [catalog, period, audit] = await Promise.all([loadCatalogPage(false, {}), standardCollectionPeriodApi(), listGlobalAuditApi()]);
      return { catalog, from: period.from, to: period.to, auditRows: audit };
    } catch (e) {
      throwForPage(e, locale);
    }
  }

  async function loadLegacy() {
    const AUDIT_WINDOW_DAYS = 90;
    const [catalog, collection, auditRows] = await Promise.all([
      loadCatalogPage(false, {}),
      standardCollectionDates(scope),
      promptAuditLogRepository.listGlobalScoped({ scope, from: new Date(Date.now() - AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000) }),
    ]);
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return { catalog, from: day(collection.firstMeasuredAt), to: day(collection.lastMeasuredAt), auditRows };
  }

  return (
    <RnPromptsView
      remote={{ initial: catalog, load: loadCatalogPage.bind(null, false), rows: loadCatalogRows.bind(null, false) }}
      scopeAll={scope.all}
      scopeRole={session.user.role}
      scopeBrands={scope.brands ?? []}
      scopeRegions={scope.regions ?? []}
      scopeCountries={scopeForGeoSurface(scope, "standard").countries ?? []}
      period={from && to ? { from, to } : null}
      auditRows={auditRows}
      initialTab={tab === "history" ? "history" : "catalog"}
      storageKey={`rn:saved-filters:v1:prompts:${session.user.id}`}
    />
  );
}
