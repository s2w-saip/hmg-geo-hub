import { SourceAnalytics } from "@/components/source-analytics";
import { setRequestLocale } from "next-intl/server";

// Data and every calculation come from the API (screen sources/analytics, back/bff/screens/); this page only renders.
export default async function ProjectAiFunnelConversionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return <SourceAnalytics kind="conversion" sp={await searchParams} projectId={id} />;
}
