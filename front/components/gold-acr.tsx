import { PageHeader } from "@/components/page-header";
import { screenGet } from "@/lib/screen";
import { AcrLiveView } from "@/app/[locale]/(dash)/standard/ai-funnel/_components/acr-live-view";
import type { AcrScreen } from "@/app/[locale]/(dash)/standard/ai-funnel/_data/acr-screen";
import type { SearchValues } from "@/components/source-data-ui";

// Website / project ACR in local read-only mode: screen acr/gold (back/bff/screens/acr.py) reads
// /v1/funnel/acr with the page's URL params and computes the view.
export async function GoldAcr({ sp = {}, projectId }: { sp?: SearchValues; projectId?: string }) {
  const { panel, view } = await screenGet<AcrScreen>("acr/gold", { ...sp, "ctx.project_id": projectId });
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title="AI 최종 추천 선택률 · ACR" description="측정된 최종 추천 선택과 후보 모델 현황"/>
    <AcrLiveView vm={view} {...panel} />
  </div>;
}
