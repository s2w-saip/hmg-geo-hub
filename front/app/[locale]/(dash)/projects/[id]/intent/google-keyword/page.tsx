import { GoldKeywords } from "@/components/gold-insights";
import { setRequestLocale } from "next-intl/server";

// Data and every calculation come from the API (screen intent/keywords, back/bff/screens/); this page only renders.
export default async function ProjectIntentGoogleKeywordPage({
  params,
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return <GoldKeywords sp={await searchParams} projectId={id} />;
}
