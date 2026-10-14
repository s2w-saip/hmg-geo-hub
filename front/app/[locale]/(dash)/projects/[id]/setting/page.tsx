import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import type { User } from "@/lib/auth/types";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { diagnoseProjectAnalysisConnection } from "@/lib/scope/server";
import {
  trackedBrandRepository,
  trackedCompetitorRepository,
  trackedVehicleRepository,
} from "@/lib/db/repositories/tracked-entities";
import { listProjectTrackedUrls } from "@/lib/db/repositories/project-tracked-urls";
import { listProjectOwnedBases } from "@/lib/db/repositories/project-owned-bases";
import {
  isProjectsApi,
  loadSettingsPage,
  SCOPE_LINK_ERROR,
  type ScopeLinkDiagnostic,
  type SettingsPageData,
} from "@/lib/hgh/adapters/projects";
import { GeneralForm } from "./_components/general-form";
import { DangerZone } from "./_components/danger-zone";
import { TrackedEntitiesPanel } from "./_components/tracked-entities";
import { TrackedUrlsPanel } from "./_components/tracked-urls";
import { OwnedBasesPanel } from "./_components/owned-bases";
import { AiEnginesPanel } from "./_components/ai-engines-panel";
import { effectiveAiEngines } from "@/lib/scope/engines";
import { canOperateProject } from "@/lib/auth/operator-policy";

type LegacyDiagnostic = Awaited<ReturnType<typeof diagnoseProjectAnalysisConnection>>;
type ProbeView = {
  overall: LegacyDiagnostic["overall"];
  mention: { state: LegacyDiagnostic["mention"]["state"] };
  citation: { state: LegacyDiagnostic["citation"]["state"] };
};

// API 진단 일시 실패: legacy probe 가 호출 오류를 블록 안 오류 상태로 그리던 것과 같은 상태(기존 analysisProbe error 문구).
const PROBE_ERROR: ProbeView = { overall: "error", mention: { state: "error" }, citation: { state: "error" } };

// Project detail > Setting (Task E + D).
// Owner-only edit + delete. Viewer/non-member gets notFound() per the
// "never leak project existence" rule (matches members page).
//
// Data source (D8): HGH_SOURCE_G6=api reads the U2 project gate + GET …/settings,
// …/settings/tracked-urls, …/settings/engines/history (and, admin only, …/settings/scope-link)
// through lib/hgh/adapters/projects.ts; legacy keeps the repository reads. Both fill one
// SettingsPageData, rendered by the same JSX. Only the admin Scope-link diagnostic differs: the API
// gives one link state with job and outbox counts instead of the live mention/citation probes
// (design 3.5 #11, component change C2), so that block has one rendering per source. A transient
// failure of the API diagnostic draws the legacy block's error state (as a failed legacy probe did).
export default async function ProjectSettingPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("projectDetail.setting");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  const isAdmin = session.user.role === "admin";

  let data: SettingsPageData;
  let legacyDiagnostic: ProbeView | null = null;
  let apiDiagnostic: ScopeLinkDiagnostic | null = null;
  if (isProjectsApi()) {
    const loaded = await loadSettingsPage(locale, id, isAdmin);
    data = loaded.data;
    apiDiagnostic = loaded.diagnostic;
    if (apiDiagnostic === SCOPE_LINK_ERROR) {
      legacyDiagnostic = PROBE_ERROR;
      apiDiagnostic = null;
    }
  } else {
    const legacy = await legacySettingsPage(id, session.user, isAdmin);
    data = legacy.data;
    legacyDiagnostic = legacy.diagnostic;
  }
  const { project, canEdit, canEditEngines, ownedBases, trackedUrls, scopeLink } = data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <SectionCard
        title={t("general.title")}
        description={t("general.description")}
      >
        <GeneralForm
          projectId={id}
          initial={{
            name: project.name,
            description: project.description,
            brand: project.brand,
            country: project.country,
            ga4PropertyId: project.ga4PropertyId,
          }}
          disabled={!canEdit}
        />
      </SectionCard>

      <SectionCard
        title={t("aiEngines.title")}
        description={t("aiEngines.description")}
      >
        <AiEnginesPanel
          projectId={id}
          initial={data.engines.initial}
          explicit={data.engines.explicit}
          history={data.engineHistory}
          disabled={!canEditEngines}
        />
      </SectionCard>

      {/* 소유 base URL(분모 — 자사 사이트 범위)과 추적 URL(분자 — 그 안의
          타겟 페이지)은 KPI ⑥의 한 쌍이라 나란히 배치한다. TrackedUrlsPanel의
          힌트(ownedBaseCount)도 바로 위 섹션을 가리키게 된다. */}
      <SectionCard
        title={t("ownedBases.title")}
        description={t("ownedBases.description")}
      >
        <OwnedBasesPanel
          projectId={id}
          rows={ownedBases}
          legacyDomain={project.domain}
          disabled={!canEdit}
        />
      </SectionCard>

      <SectionCard
        title={t("trackedUrls.title")}
        description={t("trackedUrls.description")}
      >
        <TrackedUrlsPanel
          projectId={id}
          rows={trackedUrls}
          ownedBaseCount={ownedBases.length > 0 ? ownedBases.length : project.domain ? 1 : 0}
          disabled={!canEdit}
        />
      </SectionCard>

      <SectionCard
        title={t("tracked.title")}
        description={t("tracked.description")}
      >
        <TrackedEntitiesPanel
          projectId={id}
          projectBrand={project.brand}
          ownBrandAliases={data.ownBrandAliases}
          brands={data.designatedBrands}
          vehicles={data.vehicles}
          disabled={!canEdit}
        />
      </SectionCard>

      <SectionCard
        title={t("scopeLink.title")}
        description={isAdmin ? t("scopeLink.description") : undefined}
      >
        <div className="grid gap-3">
          <dl className="grid gap-2 text-sm">
          <div className="flex items-center gap-3">
            <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("scopeLink.status")}
            </dt>
            <dd
              className={
                scopeLink.status === "root" || scopeLink.status === "linked"
                  ? "font-medium text-emerald-600"
                  : "text-muted-foreground"
              }
            >
              {t(`scopeLink.statusValue.${scopeLink.status}`)}
            </dd>
          </div>
          {isAdmin ? (
            <div className="flex items-center gap-3">
              <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("scopeLink.scopeProjectId")}
              </dt>
              <dd className="font-mono text-xs text-foreground">
                {scopeLink.scopeProjectId ?? "—"}
              </dd>
            </div>
          ) : null}
          </dl>
          {isAdmin && legacyDiagnostic ? (
            <div className="grid gap-2 rounded-md border border-border/70 bg-muted/30 p-3">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("scopeLink.analysisProbe.title")}
              </p>
              <dl className="grid gap-2 text-sm">
                <div className="flex items-center gap-3">
                  <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("scopeLink.analysisProbe.overallLabel")}
                  </dt>
                  <dd className="font-medium text-foreground">
                    {t(`scopeLink.analysisProbe.overall.${legacyDiagnostic.overall}`)}
                  </dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("scopeLink.analysisProbe.mentionLabel")}
                  </dt>
                  <dd className="text-foreground">
                    {t(`scopeLink.analysisProbe.state.${legacyDiagnostic.mention.state}`)}
                  </dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("scopeLink.analysisProbe.citationLabel")}
                  </dt>
                  <dd className="text-foreground">
                    {t(`scopeLink.analysisProbe.state.${legacyDiagnostic.citation.state}`)}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                {t(`scopeLink.analysisProbe.fix.${legacyDiagnostic.overall}`)}
              </p>
            </div>
          ) : null}
          {isAdmin && apiDiagnostic ? (
            // C2: API link state (state + latest round + job and outbox counts, no live probes).
            <div className="grid gap-2 rounded-md border border-border/70 bg-muted/30 p-3">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("scopeLink.linkProbe.title")}
              </p>
              <dl className="grid gap-2 text-sm">
                <div className="flex items-center gap-3">
                  <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("scopeLink.linkProbe.stateLabel")}
                  </dt>
                  <dd className="font-medium text-foreground">
                    {t(`scopeLink.linkProbe.state.${apiDiagnostic.state}`)}
                  </dd>
                </div>
                {apiDiagnostic.latestRound ? (
                  <div className="flex items-center gap-3">
                    <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {t("scopeLink.linkProbe.roundLabel")}
                    </dt>
                    <dd className="text-foreground">
                      {t("scopeLink.linkProbe.round", {
                        date: apiDiagnostic.latestRound.roundDate,
                        status: apiDiagnostic.latestRound.status,
                      })}
                    </dd>
                  </div>
                ) : null}
                {apiDiagnostic.jobs ? (
                  <div className="flex items-center gap-3">
                    <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {t("scopeLink.linkProbe.jobsLabel")}
                    </dt>
                    <dd className="text-foreground tabular-nums">
                      {apiDiagnostic.jobs.servedPct === null
                        ? t("scopeLink.linkProbe.jobsNone")
                        : t("scopeLink.linkProbe.jobs", {
                            served: apiDiagnostic.jobs.served,
                            total: apiDiagnostic.jobs.total,
                            pct: apiDiagnostic.jobs.servedPct,
                            inProgress: apiDiagnostic.jobs.inProgress,
                            failed: apiDiagnostic.jobs.failed,
                          })}
                    </dd>
                  </div>
                ) : null}
                <div className="flex items-center gap-3">
                  <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("scopeLink.linkProbe.outboxLabel")}
                  </dt>
                  <dd className="text-foreground tabular-nums">
                    {t("scopeLink.linkProbe.outbox", {
                      pending: apiDiagnostic.outbox.pending,
                      erroring: apiDiagnostic.outbox.erroring,
                      promptPending: apiDiagnostic.outbox.promptPending,
                    })}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                {t(`scopeLink.linkProbe.fix.${apiDiagnostic.state}`)}
              </p>
            </div>
          ) : null}
        </div>
      </SectionCard>

      {canEdit ? (
        <SectionCard title={t("danger.title")}>
          <DangerZone projectId={id} projectName={project.name} />
        </SectionCard>
      ) : null}
    </div>
  );
}

// Legacy source (the rollback path, D8): the repository reads, unchanged, shaped into
// SettingsPageData.
async function legacySettingsPage(
  id: string,
  user: User,
  isAdmin: boolean,
): Promise<{ data: SettingsPageData; diagnostic: LegacyDiagnostic | null }> {
  const project = await projectRepository.getById(id);
  if (!project) notFound();

  const membership = await projectMemberRepository.findMembership(id, user.id);
  if (!isAdmin && (!membership || membership.status !== "active")) {
    notFound();
  }

  const canEdit = isAdmin || membership?.role === "owner";
  // AI 엔진 변경은 비용 레버라 operator 게이트까지 — 서버 액션(updateProjectEngines)
  // 과 동일 술어. "보이는 것 = 할 수 있는 것".
  const canEditEngines = canEdit && canOperateProject(user, membership);

  const [brandsRaw, designatedBrandsRaw, vehiclesRaw, trackedUrlsRaw, ownedBasesRaw, analysisDiagnostic, engineHistoryRaw] = await Promise.all([
    trackedBrandRepository.listForProject(id),
    trackedCompetitorRepository.listForProject(id),
    trackedVehicleRepository.listForProject(id),
    listProjectTrackedUrls(id),
    listProjectOwnedBases(id),
    isAdmin ? diagnoseProjectAnalysisConnection(id) : Promise.resolve(null),
    projectRepository.listEngineHistory(id),
  ]);
  const brandAliasMap = new Map(
    brandsRaw.map((row) => [row.canonicalName, row.aliases ?? []] as const),
  );

  // Scope mirror 연결 진단 — syncStandardMirror(lib/scope/mirror/sync.ts)는
  // ROOT env 프로젝트뿐 아니라, scope_project_id 가 채워진 모든 로컬 projects
  // 행을 DB에서 직접 읽어(linkedIds) sync 대상에 자동 포함한다(2026-07-02
  // 추적 재정의 작업에서 도입). 즉 이 프로젝트 자신의 scope_project_id 가 있는
  // 한 SCOPE_EXTRA_PROJECT_IDS 등록 여부와 무관하게 이미 동기화 대상이다 —
  // env 매칭을 "비활성" 신호로 쓰던 예전 로직은 그 시점 이후로는 오탐이었다.
  const rootScopeId = process.env.SCOPE_ROOT_PROJECT_ID ?? null;
  const scopeLink: SettingsPageData["scopeLink"] = !project.scopeProjectId
    ? { status: "missing", scopeProjectId: null }
    : project.scopeProjectId === rootScopeId
      ? { status: "root", scopeProjectId: project.scopeProjectId }
      : { status: "linked", scopeProjectId: project.scopeProjectId };

  const data: SettingsPageData = {
    project: {
      name: project.name,
      description: project.description,
      brand: project.brand,
      country: project.country,
      ga4PropertyId: project.ga4PropertyId,
      domain: project.domain,
    },
    canEdit,
    canEditEngines,
    engines: { initial: effectiveAiEngines(project.aiEngines), explicit: project.aiEngines != null },
    engineHistory: engineHistoryRaw.map((h) => ({
      id: h.id,
      engines: h.engines,
      changedAt: h.changedAt.toISOString(),
    })),
    ownedBases: ownedBasesRaw.map((b) => ({
      id: b.id,
      baseUrl: b.baseUrl,
      label: b.label,
    })),
    trackedUrls: trackedUrlsRaw.map((u) => ({
      id: u.id,
      url: u.url,
      label: u.label,
    })),
    ownBrandAliases: project.brand
      ? (brandAliasMap.get(project.brand) ?? []).filter((alias) => alias !== project.brand)
      : [],
    designatedBrands: designatedBrandsRaw.map((c) => ({
      id: c.id,
      brandName: c.brandName,
      aliases: brandAliasMap.get(c.brandName) ?? c.aliases ?? [],
      notes: c.notes,
      isTarget: c.isTarget,
    })),
    vehicles: vehiclesRaw.map((v) => ({
      id: v.id,
      brand: v.brand,
      model: v.model,
      segment: v.segment,
      aliases: v.aliases ?? [],
    })),
    scopeLink,
  };
  return { data, diagnostic: analysisDiagnostic };
}
