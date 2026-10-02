import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SocialScrapingTabs } from "@/components/social-scraping/social-scraping-tabs";

// 고객 관심 > 커뮤니티 수집 (Social Research).
// Two visualizations of the same fake "패밀리 SUV" fixture, switched by tab:
//   • 테이블 뷰     — the existing sortable inventory (SocialScrapingFlow)
//   • 컨텍스트 맵 뷰 — aeorank's social-scraping node graph, ported as-is
export default async function CustomerInterestSocialScrapingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("customerInterestSocialScraping");
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <SocialScrapingTabs />
    </div>
  );
}
