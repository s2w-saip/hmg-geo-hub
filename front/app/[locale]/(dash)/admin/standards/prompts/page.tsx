import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import {
  listStandardCatalog,
  type StandardCatalogRow,
  type StandardCatalogStats,
} from "@/lib/db/repositories/standards";
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
// Source (D8, HGH_SOURCE_G7): api reads GET /v1/admin/catalog/prompts?include_deleted=true (cursor
// to the end) and GET /v1/admin/catalog/markets, issued together (lib/hgh/adapters/admin.ts). A
// failed vocabulary read degrades to [] on its own (as legacy); only the list errors the page.
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

  let rows: StandardCatalogRow[];
  let stats: StandardCatalogStats;
  let markets: string[];
  if (api.isAdminApi()) {
    [{ rows, stats }, markets] = await Promise.all([api.listAdminCatalog(), api.catalogMarketVocabularyForScreen()]).catch((e) =>
      throwForPage(e, locale),
    );
  } else {
    // includeDeleted: admin은 "삭제됨" 뷰에서 soft-delete 행을 보고 복원할 수 있다.
    ({ rows, stats } = await listStandardCatalog({ includeDeleted: true }));
    // 시장 어휘는 하드코딩하지 않고 **루트 프로젝트 실황**에서 온다 — scope 의
    // 검증(어휘 밖 400)과 같은 상한이라 화면과 서버 검증이 갈리지 않는다.
    markets = await getStandardMarketVocabulary();
  }

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader title={t("title")} description={t("subtitle")} />
        <CatalogIo />
      </div>
      <SectionCard
        title={t("list.title")}
        description={t("list.description", { count: rows.length })}
      >
        <StandardPromptList rows={rows} stats={stats} markets={markets} />
      </SectionCard>
    </div>
  );
}
