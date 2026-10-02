import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin, resolveDimensionState } from "@/lib/auth/scope-policy";
import {
  standardKeywordRepository,
  standardSourceRepository,
} from "@/lib/db/repositories/standards";
import { SocialScrapingFlow } from "@/components/social-scraping/social-scraping-flow";
import * as api from "@/lib/hgh/adapters/admin";
import { throwForPage } from "@/lib/hgh/errors";
import { StandardKeywordList } from "./_components/keyword-list";
import { StandardSourceList } from "./_components/source-list";

// Admin > 표준 관리 > 고객 관심 데이터 셋팅 (Task L).
// Admin-only catalog of:
//   1. standard keywords — search terms seeding Intent (Google Keyword + community VoC)
//   2. standard sources — URL allowlist for the community-VoC scraper, by channel
// Two separate tables because the unit is different (term vs URL).
// Source (D8, HGH_SOURCE_G7): api reads GET /v1/admin/interest/keywords + /sources together
// (lib/hgh/adapters/admin.ts); the research card stays the sample fixture on both sources.
export default async function AdminStandardCustomerInterestPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminStandardCustomerInterest");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!canAccessAdmin(session.user)) redirect(`/${locale}/dashboard`);

  const allowedCountries = resolveDimensionState(session.user, "country").options;

  const { keywords, sources } = api.isAdminApi()
    ? await api.listInterest().catch((e) => throwForPage(e, locale))
    : await legacyInterest();

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <SectionCard
        title={t("research.title")}
        description={t("research.description")}
      >
        <SocialScrapingFlow mode="admin" allowedCountries={allowedCountries} />
      </SectionCard>
      <SectionCard
        title={t("list.title")}
        description={t("list.description", { count: keywords.length })}
      >
        <StandardKeywordList rows={keywords} />
      </SectionCard>
      <SectionCard
        title={t("sources.title")}
        description={t("sources.description", { count: sources.length })}
      >
        <StandardSourceList rows={sources} />
      </SectionCard>
    </div>
  );
}

async function legacyInterest() {
  const [keywordsRaw, sourcesRaw] = await Promise.all([
    standardKeywordRepository.list(),
    standardSourceRepository.list(),
  ]);

  const keywords = keywordsRaw.map((r) => ({
    id: r.id,
    term: r.term,
    sourceType: r.sourceType,
    brand: r.brand,
    notes: r.notes,
    enabled: r.enabled,
  }));
  const sources = sourcesRaw.map((r) => ({
    id: r.id,
    url: r.url,
    channel: r.channel,
    brand: r.brand,
    notes: r.notes,
    enabled: r.enabled,
  }));
  return { keywords, sources };
}
