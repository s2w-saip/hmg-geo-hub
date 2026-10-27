import { getTranslations, setRequestLocale } from "next-intl/server";
import { DimensionLockChipGroup } from "@/components/dash/dimension-lock-chip";
import { screenGet } from "@/lib/screen";
import { MentionsView } from "../../../../standard/answer-analysis/_components/mentions-view";
import type { MentionViewScreen } from "../../../../standard/answer-analysis/_data/mention-screen";
import { loadProjectAnalysisContext } from "../_lib/auth-and-locks";
import { throwForPage } from "@/lib/hgh/errors";

// Data: the mention screen of the API (back/bff/screens/mention_surfaces.py `mention/view` with
// ctx.surface=project): the project's filter options (custom fields), the mentions, the Sub KPI and
// its previous window and the calendar in one view model; MentionsView draws its own filter panel.

export default async function ProjectAnalysisMentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("projectDetail.analysis");
  const { locks, lockedGroups } = await loadProjectAnalysisContext(locale, id);
  const sp = await searchParams;
  let vm: MentionViewScreen;
  try {
    vm = await screenGet<MentionViewScreen>("mention/view", { ...sp, "ctx.surface": "project", "ctx.project_id": id });
  } catch (e) {
    throwForPage(e, locale);
  }
  const panel = vm.panel;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">{t("tabs.mentions")}</h2>
        <DimensionLockChipGroup locks={locks} className="mt-1" />
      </div>
      <MentionsView
        vm={vm}
        compareSource={{ surface: "project", projectId: id }}
        lockedGroups={lockedGroups}
        dynamicAxes={panel?.dynamicAxes ?? []}
        catalogRows={panel?.catalogRows}
        engineOptions={panel?.engineOptions}
        selectableDates={panel?.selectableDates ?? undefined}
        lazyPrompts
      />
    </div>
  );
}
