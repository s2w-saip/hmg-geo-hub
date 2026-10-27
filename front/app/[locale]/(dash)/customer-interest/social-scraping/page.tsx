import { GoldSocial } from "@/components/gold-insights";
import { setRequestLocale } from "next-intl/server";

// Data and every calculation come from the API (screen intent/social, back/bff/screens/); this page only renders.
export default async function CustomerInterestSocialScrapingPage({
  params,
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <GoldSocial sp={await searchParams} />;
}
