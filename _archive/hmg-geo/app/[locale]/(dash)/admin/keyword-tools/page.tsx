import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { KeywordTools } from "@/components/keyword/keyword-tools";

// Admin — 키워드 도구. DataForSEO search-volume lookup + OpenRouter keyword→
// prompt generation, ported from aeorank. Admin-only because both back onto
// PAID external APIs; the /api/keyword/* routes enforce the same gate.
export default async function KeywordToolsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("keywordTools");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the DashLayout server guard.
  if (!canAccessRoute(session.user.role, "/admin/keyword-tools")) {
    redirect(`/${locale}/no-access`);
  }

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("subtitle")}
      />
      <SectionCard title={t("title")}>
        <KeywordTools />
      </SectionCard>
    </div>
  );
}
