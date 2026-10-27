import { GoldSocial } from "@/components/gold-insights";
import { setRequestLocale } from "next-intl/server";

export const maxDuration = 120;

// Data and every calculation come from the API (screen intent/social, back/bff/screens/); this page only renders.
export default async function ProjectIntentSocialScrapingPage({
  params,
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return <GoldSocial sp={await searchParams} projectId={id} />;
}
