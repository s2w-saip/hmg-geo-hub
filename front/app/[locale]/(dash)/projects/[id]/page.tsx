import { setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import {
  cachedProjectById,
  cachedMembership,
} from "@/lib/db/repositories/request-cache";
import {
  promptRepository,
  promptCandidateRepository,
} from "@/lib/db/repositories/prompts";
import {
  listMeasuredRegions,
} from "@/lib/db/repositories/scope-aggregates";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { readProjectCustomFieldFilters } from "@/components/dash/project-custom-field-filters";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import { ProjectDashboard } from "./_components/project-dashboard";
import { buildProjectOverview } from "./_data/live";
import { hghSource } from "@/lib/hgh/client";
import { requireProjectPage } from "@/lib/hgh/adapters/project-gate";
import { isAnalysisApi, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { afterFirstRender, loadProjectOverview, type DashboardCtx } from "@/lib/hgh/adapters/dashboard";
import { throwForPage } from "@/lib/hgh/errors";

// Project detail root = per-project Dashboard. v23 user flow originally
// redirected to /intent on the bare /projects/[id] URL; we replaced that
// with an actual landing page so deep links show a project home with KPIs
// + recent activity + quick actions instead of a blank shell.
export default async function ProjectDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  // 페이지 게이트(U2): HGH_SOURCE_SESSION=api 면 GET /v1/projects/{id} 한 번(레이아웃과 요청 안
  // 합치기로 공유)이 admin·활성 멤버 외 전부를 404 로 숨긴다. legacy 는 종전 두 조회 그대로.
  const projectBrand = await projectPageBrand(locale, id, session.user.id, session.user.role === "admin");

  // Header DimensionFilterPanel writes URL params → narrow the live KPI section.
  // 기간 축은 커스텀 태그와 무관하므로 먼저 파싱해 lastMeasuredAt 병렬 로드에 쓴다.
  // 기간 의미론 — 확정 기획(제품 책임자 2026-09-16): 필터 없음 = 최신 1회차 스냅샷,
  // 기간 설정 = 그 기간 회차 전부 누적. 산식 판정 정본은 `cumulativeMode`
  // (lib/db/repositories/scope-aggregates.ts:1087) 하나다.
  //
  // ⚠️ 여기서 `true` 를 상시로 넘기지 않고 **기간 유무로 가르는** 이유는 산식이
  // 아니라 **리더 라우팅** 때문이다 — `lib/summary/read/gate.ts:140` 이
  // `mode === "snapshot" && cumulative === true` 를 미지원 축으로 보고 사실표
  // 리더를 포기하고 미러로 폴백한다. 상시 `true` 면 기간을 안 건 기본 화면까지
  // 매번 미러로 떨어져, 산식은 그대로인데 서빙 경로만 느려진다.
  // #225 가 `website/page.tsx:111` 에 세운 형태와 같다.
  const rawStdFilters = readStandardFilters(sp);
  const stdFilters = {
    ...rawStdFilters,
    cumulative: Boolean(rawStdFilters.dateFrom || rawStdFilters.dateTo),
  };

  // 원천 스위치(D8, 단위 U5): HGH_SOURCE_G6=api 면 타일·패널(ProjectDetail 요약 필드 + 후보 첫 페이지)과
  // 필터 옵션(지역 = 프로젝트 측정국, U4-N10 · 커스텀 필드 축)을 새 백엔드에서 읽는다. 이 넷(프로젝트·
  // 후보·옵션·달력)이 D6 첫 렌더 호출이고, KPI 섹션은 그 뒤에 흐른다.
  if (isAnalysisApi("dashboard", "project")) {
    const ctx: DashboardCtx = { surface: "project", projectId: id, scope: null };
    let overview: Awaited<ReturnType<typeof loadProjectOverview>>;
    let options: Awaited<ReturnType<typeof loadPanelOptions>>;
    try {
      [overview, options] = await Promise.all([
        afterFirstRender(stdFilters, ctx, () => loadProjectOverview(id)),
        loadPanelOptions({
          surface: "project",
          projectId: id,
          scope: null,
          filters: stdFilters,
          dateFrom: stdFilters.dateFrom,
          dateTo: stdFilters.dateTo,
        }),
      ]);
    } catch (e) {
      throwForPage(e, locale, { permission: "not-found" });
    }
    const dynamicAxes = options.dynamicAxes ?? [];
    return (
      <ProjectDashboard
        locale={locale}
        projectId={id}
        overview={overview}
        filters={{ ...stdFilters, customFieldFilters: readProjectCustomFieldFilters(sp, dynamicAxes) }}
        geographyOptions={options.geographyOptions}
        dynamicAxes={dynamicAxes}
        brand={projectBrand}
      />
    );
  }

  const [prompts, candidates, members, geographyOptions, customFieldsRaw, customValuesRaw] =
    await Promise.all([
      promptRepository.listForProject(id),
      promptCandidateRepository.listForProject(id),
      projectMemberRepository.listForProject(id),
      listMeasuredRegions(session.user.scope),
      projectCustomFieldRepository.listForProject(id),
      projectCustomFieldRepository.listValuesForProject(id),
    ]);

  // 커스텀 태그 → 필터 패널 동적 축(옵션 = 실제 배정된 distinct 값). 답변 분석과
  // 동일하게 값 필터도 KPI 집계에 반영한다(customFieldFilters).
  const distinctValuesByField = new Map<string, Set<string>>();
  for (const v of customValuesRaw) {
    const set = distinctValuesByField.get(v.fieldId) ?? new Set<string>();
    set.add(v.value);
    distinctValuesByField.set(v.fieldId, set);
  }
  const dynamicAxes = customFieldsRaw
    .filter((f) => !f.archived)
    .map((f) => ({
      id: f.id,
      label: f.label,
      options: [...(distinctValuesByField.get(f.id) ?? [])].sort((a, b) =>
        a.localeCompare(b),
      ),
    }));
  const filters = {
    ...stdFilters,
    customFieldFilters: readProjectCustomFieldFilters(sp, dynamicAxes),
  };

  return (
    <ProjectDashboard
      locale={locale}
      projectId={id}
      overview={buildProjectOverview(prompts, candidates, members)}
      filters={filters}
      geographyOptions={geographyOptions}
      dynamicAxes={dynamicAxes}
      brand={projectBrand}
    />
  );
}

/**
 * The project page gate on either session source, returning the project brand (the region
 * filter's brand). api: requireProjectPage (U2, 404 for all but admin and active members);
 * legacy: the request-scoped memos the (dash) layout already warmed, same rule.
 */
async function projectPageBrand(locale: string, id: string, userId: string, isAdmin: boolean): Promise<string | null> {
  if (hghSource("SESSION") === "api") return (await requireProjectPage(locale, id)).brand;
  // Both are request-scoped memos already warmed by the (dash) layout's SNB
  // project-meta lookup, so these two resolve without hitting the DB again.
  // They are also independent of each other, no reason to serialize them.
  const [project, membership] = await Promise.all([cachedProjectById(id), cachedMembership(id, userId)]);
  if (!project) notFound();
  if (!isAdmin && (!membership || membership.status !== "active")) notFound();
  return project.brand;
}
