import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { RnAccountGate } from "../../_components/account-gate";
import { RnPageFrame } from "../../_components/filter-split";
import { KeywordSample } from "./_components/keyword-sample";

// Renewal Admin › 키워드 도구 (2026-11-02): DataForSEO search volume and OpenRouter keyword → prompt generation. The keys are
// not handed over yet (⛔D: Admin step 5 starts with its scope check once they are), so the page shows what the tools
// give on sample data under the "account needed" veil (user). It reads nothing and calls no paid API.
export default async function RenewalKeywordToolsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("keywordTools");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (admin only).
  if (!canAccessRoute(session.user.role, "/renewal/admin/keyword-tools")) redirect(`/${locale}/no-access`);
  return (
    <RnPageFrame header={<RnPageHeader title={t("title")} meta={<span>{t("subtitle")}</span>} />}>
      <RnAccountGate account="dataforseo">
        <div className="flex flex-col gap-2.5">
          <KeywordSample />
        </div>
      </RnAccountGate>
    </RnPageFrame>
  );
}
