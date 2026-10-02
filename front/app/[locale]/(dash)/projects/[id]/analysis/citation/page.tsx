import { getTranslations, setRequestLocale } from "next-intl/server";
import { DimensionLockChipGroup } from "@/components/dash/dimension-lock-chip";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { readProjectCustomFieldFilters } from "@/components/dash/project-custom-field-filters";
import {
  fetchProjectCitations,
  fetchProjectMeasuredEngines,
  fetchProjectSelectableAnchorDates,
} from "@/lib/scope/server";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import { CitationsView } from "../../../../standard/answer-analysis/_components/citations-view";
import { loadProjectAnalysisContext } from "../_lib/auth-and-locks";
import { throwForPage } from "@/lib/hgh/errors";
import { loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { citationRouteQuery, isCitationsApi, loadCitationsView, type CitationsContext } from "@/lib/hgh/adapters/citations";

// Per-project 인용 분석. Data through the enforced per-project scope seam
// (fetchProjectCitations) — synthetic in mock, the project's real run in live —
// rendered with the same Category→Subcategory→Domain→URL tree as 표준.
//
// Data source (unit U7, D8): HGH_SOURCE_G6 = api -> lib/hgh/adapters/{citations,filters}.ts with
// surface=project (options first: its custom fields read the cf_ URL filters; then domains,
// sources and the calendar, trends and the prompt split after them, D6). The table pages,
// searches, sorts and exports through /api/citations/domains* with the project id, and a row's
// drilldown loads when it opens. legacy (default) -> the readers below, unchanged.
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
  const resolvedSearchParams = await searchParams;
  if (isCitationsApi("project")) {
    return (
      <ProjectCitationApi
        id={id}
        locale={locale}
        sp={resolvedSearchParams}
        locks={locks}
        lockedGroups={lockedGroups}
        title={t("tabs.citations")}
      />
    );
  }
  const [customFieldsRaw, customValuesRaw] = await Promise.all([
    projectCustomFieldRepository.listForProject(id),
    projectCustomFieldRepository.listValuesForProject(id),
  ]);
  // Tags are free text (no fixed option list) — the filter dropdown offers
  // whatever distinct values are actually assigned across the project.
  const distinctValuesByField = new Map<string, Set<string>>();
  for (const v of customValuesRaw) {
    const set = distinctValuesByField.get(v.fieldId) ?? new Set<string>();
    set.add(v.value);
    distinctValuesByField.set(v.fieldId, set);
  }
  const activeCustomFields = customFieldsRaw
    .filter((f) => !f.archived)
    .map((f) => ({
      id: f.id,
      label: f.label,
      options: [...(distinctValuesByField.get(f.id) ?? [])].sort((a, b) =>
        a.localeCompare(b),
      ),
    }));
  const filters = {
    ...readStandardFilters(resolvedSearchParams),
    customFieldFilters: readProjectCustomFieldFilters(resolvedSearchParams, activeCustomFields),
    // 2026-09-04 — 답변분석은 기간 내 누적(사유는 standard 답변분석 주석 참조).
    cumulative: true,
  };
  const [data, catalogRows, engineOptions] = await Promise.all([
    fetchProjectCitations(id, filters),
    // 카탈로그 축 옵션을 이 프로젝트 프롬프트 실제 값으로(죽은 루트 필터 제거).
    listCatalogTaxonomy(id),
    // engine 필터 옵션 = 선택 기간 안에 실제로 수집한 엔진만.
    fetchProjectMeasuredEngines(id, filters),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">
          {t("tabs.citations")}
        </h2>
        <DimensionLockChipGroup locks={locks} className="mt-1" />
      </div>
      <CitationsView
        data={data}
        lockedGroups={lockedGroups}
        dynamicAxes={activeCustomFields}
        catalogRows={catalogRows}
        engineOptions={engineOptions}
        // 앵커 축(스펙 §5.1) — 프로젝트 표면의 인용 지면.
        selectableDates={await fetchProjectSelectableAnchorDates(id, filters, "citations")}
      />
    </div>
  );
}

/** The api source of this page (same CitationsView props; see the header). */
async function ProjectCitationApi({
  id,
  locale,
  sp,
  locks,
  lockedGroups,
  title,
}: {
  id: string;
  locale: string;
  sp: Record<string, string | string[] | undefined>;
  locks: Awaited<ReturnType<typeof loadProjectAnalysisContext>>["locks"];
  lockedGroups: Awaited<ReturnType<typeof loadProjectAnalysisContext>>["lockedGroups"];
  title: string;
}) {
  const base = readStandardFilters(sp);
  try {
    const options = await loadPanelOptions({
      surface: "project",
      projectId: id,
      dateFrom: base.dateFrom,
      dateTo: base.dateTo,
      scope: null,
      filters: base,
    });
    const activeCustomFields = options.dynamicAxes ?? [];
    const filters = {
      ...base,
      customFieldFilters: readProjectCustomFieldFilters(sp, activeCustomFields),
      cumulative: true,
    };
    const ctx: CitationsContext = { surface: "project", projectId: id, scope: null, customFields: filters.customFieldFilters };
    const [view, dates] = await Promise.all([
      loadCitationsView(filters, ctx),
      loadFilterDates({ surface: "project", projectId: id, family: "citations" }),
    ]);
    const tableQuery = citationRouteQuery(sp, {
      surface: "project",
      projectId: id,
      customFieldIds: activeCustomFields.map((f) => f.id),
    });
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">{title}</h2>
          <DimensionLockChipGroup locks={locks} className="mt-1" />
        </div>
        <CitationsView
          data={view.live}
          lockedGroups={lockedGroups}
          dynamicAxes={activeCustomFields}
          catalogRows={options.catalogRows}
          engineOptions={options.engineOptions}
          selectableDates={dates.selectableDates}
          tableSource={view.table ? { query: tableQuery, ...view.table } : null}
        />
      </div>
    );
  } catch (e) {
    throwForPage(e, locale);
  }
}
