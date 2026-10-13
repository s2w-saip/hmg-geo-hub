import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { loadCatalogPage, loadCatalogRows } from "../../../standard/prompts/_page-actions";
import * as api from "@/lib/hgh/adapters/admin";
import { throwForPage } from "@/lib/hgh/errors";
import { StandardPromptList } from "./_components/prompt-list";
import { getStandardMarketVocabulary } from "../_actions";
import { CatalogIo } from "./_components/catalog-io";

// Admin > 표준 관리 > 표준 프롬프트 셋팅 (Task L).
//
// 2026-06-10 rewire: the catalog rows now come from the local DB `prompts`
// table (project_id = STANDARD_ROOT_PROJECT_ID — the v0.4 cutover catalog)
// joined with `scope_prompts` via prompts.scope_prompt_id. The previous
// path called scope live + did a text lookup against the editorial xlsx
// JSON; that bypassed the production catalog which already carries every
// label as a column. Each row already has the seven framework dimensions
// + brand + scope-link → 사용중(linked)/미추적(unlinked) badge derives
// straight from `scopePromptId IS NULL`.
//
// Source (D8, HGH_SOURCE_G7): a bounded catalog page and the market vocabulary are read together.
// A failed vocabulary read retains the existing independent [] fallback; catalog errors propagate.
export default async function AdminStandardPromptsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminStandardPrompts");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!canAccessAdmin(session.user)) redirect(`/${locale}/dashboard`);

  const [catalog, markets] = await Promise.all([
    loadCatalogPage(true, { limit: 200 }),
    api.isAdminApi() ? api.catalogMarketVocabularyForScreen() : getStandardMarketVocabulary(),
  ]).catch(e => throwForPage(e, locale));
  if (!catalog.stats) throw new Error("Catalog statistics missing");

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader title={t("title")} description={t("subtitle")} />
        <CatalogIo />
      </div>
      <SectionCard
        title={t("list.title")}
        description={t("list.description", { count: catalog.count })}
      >
        <StandardPromptList rows={catalog.rows} stats={catalog.stats} markets={markets} remote={{ initial: catalog, load: loadCatalogPage.bind(null, true), rows: loadCatalogRows.bind(null, true) }} />
      </SectionCard>
    </div>
  );
}
