import { SourceAnalytics } from "@/components/source-analytics";
import { setRequestLocale } from "next-intl/server";

// Data and every calculation come from the API (screen sources/analytics, back/bff/screens/); this page only renders.
export default async function ProjectAiFunnelVisibilityPage({
  params,
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return <SourceAnalytics kind="visibility" sp={await searchParams} projectId={id} />;
}
