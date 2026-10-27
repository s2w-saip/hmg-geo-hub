import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { throwForPage } from "@/lib/hgh/errors";
import { scopeForGeoSurface } from "@/lib/scope/website-virtual-geo";
import { loadPromptsScreens } from "./_data/server";
import { StandardPromptReadonlyList } from "./_components/prompt-list-readonly";
import { AuditHistoryView } from "./_components/audit-history-view";

// 표준 — 표준 프롬프트 (열람 전용). The read-only twin of the admin standard
// prompt catalog, scoped to the caller's account and stripped of all CRUD /
// scope-link operational chrome; there is no scope filter UI.
// Rows, options, order, pages, the collection period and the change history come
// from the screens catalog/prompts-* (back/bff/screens/standard_prompts.py); this page renders them.
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
  const { catalog, header, history } = await load();

  // The first catalog page, the header period and the 90-day history are read independently.
  async function load() {
    try {
      return await loadPromptsScreens();
    } catch (e) {
      throwForPage(e, locale);
    }
  }

  const period = header.period;
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        meta={
          period ? (
            <span>
              {t("collectionPeriod", { from: period.from, to: period.to })}
              <span className="mx-1.5 text-border">·</span>
              {t("lastCollectedAt", { date: period.to })}
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
          <SectionCard title={t("count", { count: catalog.count })}>
            <StandardPromptReadonlyList
              remote={{ initial: catalog }}
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
            <AuditHistoryView initial={history} />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
