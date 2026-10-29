import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { listMeasuredRegions } from "@/lib/db/repositories/scope-aggregates";
import { VisibilityView } from "../_components/visibility-view";

// 표준 > AI Agent Funnel > Visibility — Q1=분위수 기반 4분면.
// View component는 표준 + Project 양쪽 공유.
export default async function AiFunnelVisibilityPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiFunnelVisibility");

  const session = await getSession();
  const [catalogRows, geographyOptions] = await Promise.all([
    listCatalogTaxonomy(),
    listMeasuredRegions(session?.user.scope, undefined, true),
  ]);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <VisibilityView
        scope={session?.user.scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
      />
    </div>
  );
}
