import { getTranslations, setRequestLocale } from "next-intl/server";
import { DimensionLockChipGroup } from "@/components/dash/dimension-lock-chip";
import { VisibilityView } from "../../../../standard/ai-funnel/_components/visibility-view";
import { loadProjectFunnelContext } from "../_lib/auth-and-locks";

export default async function ProjectAiFunnelVisibilityPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiFunnelVisibility");
  const { locks, lockedGroups } = await loadProjectFunnelContext(locale, id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        <DimensionLockChipGroup locks={locks} className="mt-1" />
      </div>
      <VisibilityView lockedGroups={lockedGroups} />
    </div>
  );
}
