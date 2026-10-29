import { getTranslations, setRequestLocale } from "next-intl/server";
import { DimensionLockChipGroup } from "@/components/dash/dimension-lock-chip";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { readProjectCustomFieldFilters } from "@/components/dash/project-custom-field-filters";
import { fetchProjectCitations, fetchProjectMeasuredEngines } from "@/lib/scope/server";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import { CitationsView } from "../../../../standard/answer-analysis/_components/citations-view";
import { loadProjectAnalysisContext } from "../_lib/auth-and-locks";

// Per-project 인용 분석. Data through the enforced per-project scope seam
// (fetchProjectCitations) — synthetic in mock, the project's real run in live —
// rendered with the same Category→Subcategory→Domain→URL tree as 표준.
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
      />
    </div>
  );
}
