import { getTranslations, setRequestLocale } from "next-intl/server";
import { DimensionLockChipGroup } from "@/components/dash/dimension-lock-chip";
import { CitationsView } from "../../../../standard/answer-analysis/_components/citations-view";
import { loadProjectAnalysisContext } from "../_lib/auth-and-locks";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { ProjectCitationScreen } from "../../../../standard/answer-analysis/_data/citation-view";

// Per-project 인용 분석 — rendered with the same CitationsView (Category→Domain→URL) as 표준.
//
// Data (BFF): `citation/project` with the project id and the page's URL params: the project's
// filter options first on the server (its custom fields read the cf_ URL filters), then the
// citation read and the calendar; CitationsView props and their numbers. The table pages,
// searches, sorts and exports through /api/citations/domains* with the project id, and a row's
// drilldown loads when it opens.
export default async function ProjectAnalysisCitationPage({
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
  let s: ProjectCitationScreen;
  try {
    s = await screenGet<ProjectCitationScreen>("citation/project", { ...sp, "ctx.project_id": id });
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">{t("tabs.citations")}</h2>
        <DimensionLockChipGroup locks={locks} className="mt-1" />
      </div>
      <CitationsView
        data={s.live}
        vm={s.vm}
        lockedGroups={lockedGroups}
        dynamicAxes={s.options.dynamicAxes}
        catalogRows={s.options.catalogRows}
        engineOptions={s.options.engineOptions}
        selectableDates={s.selectableDates}
        tableSource={s.tableSource}
        // P6 B042: 이 요청의 degrade 표식(5xx·시간 초과) — 그 블록은 기존 지연 안내를 낸다.
        dataDegraded={s.dataDegraded}
        degradedSections={s.degradedSections}
      />
    </div>
  );
}
