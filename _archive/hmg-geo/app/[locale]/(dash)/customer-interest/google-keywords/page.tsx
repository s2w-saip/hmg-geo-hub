import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { resolveDimensionState } from "@/lib/auth/scope-policy";
import { GoogleKeywordView } from "../../projects/[id]/intent/_components/google-keyword-view";
import { DEFAULT_KEYWORD_TERMS } from "../../projects/[id]/intent/_data/sample";

// 표준 > 구글 키워드 — read-only on this surface (no project context to add
// candidates to or persist keywords against). canEdit={false} disables the
// "프롬프트 후보 추가" + keyword add/delete affordances; the keyword tabs are
// seeded from the shared sample fixtures so the trend / SERP / gauge render.
export default async function CustomerInterestGoogleKeywordsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("customerInterest");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  const allowedCountries = resolveDimensionState(session.user, "country").options;

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("tabs.keywords.title")} />
      <GoogleKeywordView
        projectId=""
        canEdit={false}
        projectCountry="KR"
        allowedCountries={allowedCountries}
        initialKeywords={DEFAULT_KEYWORD_TERMS.map((term) => ({
          id: `kw:${term}`,
          label: term,
        }))}
      />
    </div>
  );
}
