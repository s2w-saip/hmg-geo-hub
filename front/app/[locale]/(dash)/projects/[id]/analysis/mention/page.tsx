import { getTranslations, setRequestLocale } from "next-intl/server";
import { DimensionLockChipGroup } from "@/components/dash/dimension-lock-chip";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { readProjectCustomFieldFilters } from "@/components/dash/project-custom-field-filters";
import {
  fetchProjectMeasuredEngines,
  fetchProjectMentions,
  fetchProjectSubKpis,
  fetchProjectSubKpisPrev,

  fetchProjectSelectableAnchorDates,
} from "@/lib/scope/server";
import { trackedCompetitorRepository } from "@/lib/db/repositories/tracked-entities";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import { MentionsView } from "../../../../standard/answer-analysis/_components/mentions-view";
import { buildMentionSubKpis } from "../../../../standard/answer-analysis/_data/sub-kpis";
import { loadProjectAnalysisContext } from "../_lib/auth-and-locks";
import { throwForPage } from "@/lib/hgh/errors";
import { isAnalysisApi, loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import {
  loadDesignatedTargetBrand,
  loadMentionsLive,
  loadSubKpis,
  loadSubKpisPrev,
  mentionsDegraded,
  type MentionsContext,
} from "@/lib/hgh/adapters/mentions";

// /projects/[id]/analysis/mention — 4depth split from the legacy Analysis
// two-tab page. Same MentionsView component as the standard 답변 분석,
// scoped via F4 dimension locks (project's brand/country). Data comes through
// the enforced per-project scope seam (fetchProjectMentions): synthetic in mock
// mode, the project's real run in live mode — no page-level fixtures.
//
// Data source (unit U6, D8): HGH_SOURCE_G6 = api -> lib/hgh/adapters/{mentions,filters}.ts with
// surface=project (options: catalog rows, measured engines, custom fields; the designated brand
// from GET /v1/projects/{id} target_brand, BG-38). The brand drilldown turns lazy on the api
// source (3.5 #4: one call per opened brand instead of every brand up front); the drilldown and
// its citation tab carry the project id. legacy (default) -> the readers below, unchanged.
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
  const resolvedSearchParams = await searchParams;
  if (isAnalysisApi("analysis", "project")) {
    return (
      <ProjectMentionApi
        id={id}
        locale={locale}
        sp={resolvedSearchParams}
        locks={locks}
        lockedGroups={lockedGroups}
        title={t("tabs.mentions")}
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
  const [data, subKpis, prevSubKpis, designatedTargetBrand, catalogRows, engineOptions] = await Promise.all([
    fetchProjectMentions(id, filters),
    // Sub KPI — 이 프로젝트의 답변만(withProject 게이팅 경유), 언급 집계와 동일 필터.
    fetchProjectSubKpis(id, filters),
    fetchProjectSubKpisPrev(id, filters),
    trackedCompetitorRepository.getTargetBrand(id),
    // 카탈로그 축(brandPresence/listType/depth) 옵션을 이 프로젝트 프롬프트의
    // 실제 값으로 — 루트 정적 옵션이 죽은 필터로 뜨던 문제 해소(패널이 빈 축 숨김).
    listCatalogTaxonomy(id),
    // engine 필터 옵션 = 이 프로젝트가 선택 기간 안에 실제로 수집한 엔진만
    // (엔진 설정 변경 후 기간 내 수집 없는 엔진은 노출하지 않는다).
    fetchProjectMeasuredEngines(id, filters),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">
          {t("tabs.mentions")}
        </h2>
        <DimensionLockChipGroup locks={locks} className="mt-1" />
      </div>
      <MentionsView
        data={data}
        subKpis={buildMentionSubKpis(subKpis)}
        prevSubKpis={prevSubKpis ? buildMentionSubKpis(prevSubKpis.sub) : null}
        prevBasisDate={prevSubKpis?.asOf ?? null}
        lockedGroups={lockedGroups}
        dynamicAxes={activeCustomFields}
        catalogRows={catalogRows}
        engineOptions={engineOptions}
        designatedTargetBrand={designatedTargetBrand}
        // 앵커 축(스펙 §5.1) — 프로젝트 표면의 언급 지면.
        selectableDates={await fetchProjectSelectableAnchorDates(id, filters, "mentions")}
      />
    </div>
  );
}

/** The api source of this page (same MentionsView props; see the header). */
async function ProjectMentionApi({
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
    // Custom fields come with the options (needed to read the cf_ URL filters), so it goes first.
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
    const ctx: MentionsContext = {
      surface: "project",
      projectId: id,
      scope: null,
      customFields: filters.customFieldFilters,
    };
    const [data, subKpis, prevSubKpis, designatedTargetBrand, dates] = await Promise.all([
      loadMentionsLive(filters, ctx),
      loadSubKpis(filters, ctx),
      loadSubKpisPrev(filters, ctx),
      loadDesignatedTargetBrand(id),
      loadFilterDates({ surface: "project", projectId: id, family: "mentions" }),
    ]);
    // B035: 일시 실패 표식 — 위 집계가 끝난 뒤에 읽는다(빈 자리에 "데이터 없음" 대신 기존 degraded 문구).
    const degraded = mentionsDegraded(ctx);
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">{title}</h2>
          <DimensionLockChipGroup locks={locks} className="mt-1" />
        </div>
        <MentionsView
          data={data}
          subKpis={buildMentionSubKpis(subKpis)}
          prevSubKpis={prevSubKpis ? buildMentionSubKpis(prevSubKpis.sub) : null}
          prevBasisDate={prevSubKpis?.asOf ?? null}
          degraded={degraded}
          lockedGroups={lockedGroups}
          dynamicAxes={activeCustomFields}
          catalogRows={options.catalogRows}
          engineOptions={options.engineOptions}
          designatedTargetBrand={designatedTargetBrand}
          selectableDates={dates.selectableDates}
          lazyPrompts
        />
      </div>
    );
  } catch (e) {
    throwForPage(e, locale);
  }
}
