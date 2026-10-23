import { getTranslations } from "next-intl/server";
import { RnCard, RnPageHeader, RnSkeleton } from "@/components/renewal-ui";
import { RnFilterSplit } from "../../_components/filter-split";

// This page reads the catalog, the collection period and the change history before it renders
// (no inner Suspense), so a menu click would show nothing until all three answer. The route's
// own fallback puts the frame — title, filter panel, table — on screen at the first byte.
export default async function Loading() {
  const t = await getTranslations("standardPromptsView");
  return (
    <RnFilterSplit
      header={<RnPageHeader title={t("title")} meta={<RnSkeleton className="h-[26px] w-[420px] max-w-full rounded-full" />} />}
      panel={<RnCard className="h-[480px]" />}
      rail={<RnCard className="h-24" />}
    >
      <RnSkeleton className="h-10 w-56 rounded-[10px]" />
      <RnCard className="flex flex-col gap-3 p-5">
        <RnSkeleton className="h-9 w-full" />
        {Array.from({ length: 6 }, (_, i) => (
          <RnSkeleton key={i} className="h-16 w-full" />
        ))}
      </RnCard>
    </RnFilterSplit>
  );
}
