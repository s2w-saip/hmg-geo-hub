import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { listMeasuredRegions } from "@/lib/db/repositories/scope-aggregates";
import { isAnalysisApi, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { throwForPage } from "@/lib/hgh/errors";
import { AcrView } from "../../../standard/ai-funnel/_components/acr-view";

// 웹사이트 > AI Agent Funnel > ACR — 표준 AcrView 재사용. ACR 필터는 stage
// 기본 구성(brand 축은 "+ 더보기"에 이미 포함)을 그대로 따른다. 데이터 소스는
// 당분간 표준과 공유(권역 프롬프트 적재 후 교체).
// 본문은 정적 표본(결정 D9 a, 메뉴 비노출). 데이터는 필터 옵션뿐이다: HGH_SOURCE_G3=api 면
// GET /v1/filters/options?surface=website 한 번(U8). 웹사이트 표면은 카탈로그 택소노미가
// 없어(catalog null) catalogRows 를 [] 로 넘겨 카탈로그 축을 숨긴다(설계 부록 D, 표준
// 모집단 혼입 해소: known_diff U8-N15).
export default async function WebsiteAiFunnelAcrPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiFunnelAcr");

  const session = await getSession();
  const [catalogRows, geographyOptions] = isAnalysisApi("funnel", "website")
    ? await loadPanelOptions({ surface: "website", scope: session?.user.scope ?? null, filters: {} })
        .then((o) => [o.catalogRows ?? [], o.geographyOptions] as const)
        .catch((e: unknown) => throwForPage(e, locale))
    : await Promise.all([
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
