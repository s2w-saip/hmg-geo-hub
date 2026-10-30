import { getTranslations } from "next-intl/server";
import { RnCard, RnPageHeader, RnSkeleton } from "@/components/renewal-ui";
import { RnFilterSplit } from "../../_components/filter-split";

// The page reads the panel's options and saved filters before it renders, so the route's own fallback
// puts the frame — title, filter panel, list — on screen at the first byte (as Global prompts).
export default async function Loading() {
  const t = await getTranslations("website.prompts");
  return (
    <RnFilterSplit header={<RnPageHeader title={t("title")} />} panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
      <RnCard className="flex flex-col gap-3 p-5">
        <RnSkeleton className="h-9 w-full" />
        {Array.from({ length: 8 }, (_, i) => (
          <RnSkeleton key={i} className="h-10 w-full" />
        ))}
      </RnCard>
    </RnFilterSplit>
  );
}
