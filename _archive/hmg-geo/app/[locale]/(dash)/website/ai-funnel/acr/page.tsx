import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { listMeasuredRegions } from "@/lib/db/repositories/scope-aggregates";
import { AcrView } from "../../../standard/ai-funnel/_components/acr-view";

// 웹사이트 > AI Agent Funnel > ACR — 표준 AcrView 재사용. ACR 필터는 stage
// 기본 구성(brand 축은 "+ 더보기"에 이미 포함)을 그대로 따른다. 데이터 소스는
// 당분간 표준과 공유(권역 프롬프트 적재 후 교체).
export default async function WebsiteAiFunnelAcrPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiFunnelAcr");

  const session = await getSession();
  const [catalogRows, geographyOptions] = await Promise.all([
    listCatalogTaxonomy(),
    listMeasuredRegions(session?.user.scope),
  ]);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <AcrView
        scope={session?.user.scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
      />
    </div>
  );
}
