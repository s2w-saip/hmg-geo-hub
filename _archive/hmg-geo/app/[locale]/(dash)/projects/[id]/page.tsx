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

  // Both are request-scoped memos already warmed by the (dash) layout's SNB
  // project-meta lookup, so these two resolve without hitting the DB again.
  // They are also independent of each other — no reason to serialize them.
  const [project, membership] = await Promise.all([
    cachedProjectById(id),
    cachedMembership(id, session.user.id),
  ]);
  if (!project) notFound();

  const isAdmin = session.user.role === "admin";
  if (!isAdmin && (!membership || membership.status !== "active")) {
    notFound();
  }

  // Header DimensionFilterPanel writes URL params → narrow the live KPI section.
  // 기간 축은 커스텀 태그와 무관하므로 먼저 파싱해 lastMeasuredAt 병렬 로드에 쓴다.
  const stdFilters = readStandardFilters(sp);

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
      prompts={prompts}
      candidates={candidates}
      members={members}
      filters={filters}
      geographyOptions={geographyOptions}
      dynamicAxes={dynamicAxes}
      brand={project.brand}
    />
  );
}
