import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { listMeasuredRegions } from "@/lib/db/repositories/scope-aggregates";
import { isAnalysisApi, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { throwForPage } from "@/lib/hgh/errors";
import { VisibilityView } from "../_components/visibility-view";

// 표준 > AI Agent Funnel > Visibility — Q1=분위수 기반 4분면.
// View component는 표준 + Project 양쪽 공유.
// 본문은 정적 표본(결정 D9 a). 데이터는 필터 옵션뿐이다: HGH_SOURCE_G4=api 면
// GET /v1/filters/options?surface=global 한 번(lib/hgh/adapters/filters.ts, U8).
export default async function AiFunnelVisibilityPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiFunnelVisibility");

  const session = await getSession();
  const [catalogRows, geographyOptions] = isAnalysisApi("funnel", "global")
    ? await loadPanelOptions({ surface: "global", scope: session?.user.scope ?? null, filters: {} })
        .then((o) => [o.catalogRows, o.geographyOptions] as const)
        .catch((e: unknown) => throwForPage(e, locale))
    : await Promise.all([
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
