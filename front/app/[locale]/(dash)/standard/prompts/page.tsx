import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { listStandardCatalogScoped } from "@/lib/db/repositories/standards";
import { promptAuditLogRepository } from "@/lib/db/repositories/prompt-audit-logs";
import { standardCollectionDates } from "@/lib/db/repositories/scope-aggregates";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { listGlobalAuditApi, listStandardCatalogApi, standardCollectionPeriodApi } from "@/lib/hgh/adapters/catalog";
import { throwForPage } from "@/lib/hgh/errors";
import { StandardPromptReadonlyList } from "./_components/prompt-list-readonly";
import { AuditHistoryView } from "./_components/audit-history-view";
import { scopeForGeoSurface } from "@/lib/scope/website-virtual-geo";

// 표준 — 표준 프롬프트 (열람 전용). The read-only twin of the admin standard
// prompt catalog: same root source (listStandardCatalog* on the `prompts` root
// project) but BRAND-SCOPED to the caller's account and stripped of all CRUD /
// scope-link operational chrome. Scope is derived server-side from the session
// (never the client); there is no scope filter UI — the visible set varies by
// account. Multi-brand "잘못" rows are hidden by the backend exclusion list.
export default async function StandardPromptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("standardPromptsView");
  const tAudit = await getTranslations("promptAudit.history");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the DashLayout server guard.
  if (!canAccessRoute(session.user.role, "/standard/prompts")) {
    redirect(`/${locale}/dashboard`);
  }

  const scope = session.user.scope;
  const { tab } = await searchParams;
  const { rows, from, to, auditRows } = isAnalysisApi("prompts", "global")
    ? await loadApi()
    : await loadLegacy();

  // Backend API source (HGH_SOURCE_G5=api, unit U8, lib/hgh/adapters/catalog.ts): three calls
  // in parallel (D6): GET /v1/prompts?surface=global&all=true (BG-34, the whole scoped root
  // catalog), GET /v1/filters/dates (collection period header: first measured round .. latest
  // round, known_diff U8-N10/DC-07) and GET /v1/prompts/history (90-day window, first 500).
  async function loadApi() {
    try {
      const [catalog, period, audit] = await Promise.all([
        listStandardCatalogApi(),
        standardCollectionPeriodApi(),
        listGlobalAuditApi(),
      ]);
      return { rows: catalog.rows, from: period.from, to: period.to, auditRows: audit };
    } catch (e) {
      throwForPage(e, locale);
    }
  }

  async function loadLegacy() {
    // 변경 이력(catalog-prompt-audit)은 뷰어와 같은 브랜드 스코프 술어로 90일 창.
    const AUDIT_WINDOW_DAYS = 90;
    const [{ rows }, collection, auditRows] = await Promise.all([
      listStandardCatalogScoped(scope),
      standardCollectionDates(scope),
      promptAuditLogRepository.listGlobalScoped({
        scope,
        from: new Date(Date.now() - AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000),
      }),
    ]);
    // 수집 기간 헤더 (2026-07-23 피드백 ③): 계정 scope 범위의 completed 답변
    // measured_at min~max. UTC 달력일 — 측정 타임스탬프 저장 기준과 동일.
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return { rows, from: day(collection.firstMeasuredAt), to: day(collection.lastMeasuredAt), auditRows };
  }

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        meta={
          from && to ? (
            <span>
              {t("collectionPeriod", { from, to })}
              <span className="mx-1.5 text-border">·</span>
              {t("lastCollectedAt", { date: to })}
            </span>
          ) : null
        }
      />
      <Tabs defaultValue={tab === "history" ? "history" : "catalog"} className="gap-5">
        <TabsList>
          <TabsTrigger value="catalog">{tAudit("tabCatalog")}</TabsTrigger>
          <TabsTrigger value="history">{tAudit("tabHistory")}</TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" className="mt-0">
          <SectionCard title={t("count", { count: rows.length })}>
            <StandardPromptReadonlyList
              rows={rows}
              scopeAll={scope.all}
              scopeRole={session.user.role}
              scopeBrands={scope.brands ?? []}
              scopeRegions={scope.regions ?? []}
              // 글로벌 표면 기준 — 전용 사이트 계정은 그 사이트의 글로벌 시장(N = US·KR).
              scopeCountries={scopeForGeoSurface(scope, "standard").countries ?? []}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="history" className="mt-0">
          <SectionCard title={tAudit("sectionTitle")} description={tAudit("sectionDescription")}>
            <AuditHistoryView initialRows={auditRows} />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
