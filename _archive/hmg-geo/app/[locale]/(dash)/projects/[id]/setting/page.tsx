import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
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
import { GeneralForm } from "./_components/general-form";
import { DangerZone } from "./_components/danger-zone";
import { TrackedEntitiesPanel } from "./_components/tracked-entities";
import { TrackedUrlsPanel } from "./_components/tracked-urls";
import { OwnedBasesPanel } from "./_components/owned-bases";
import { AiEnginesPanel } from "./_components/ai-engines-panel";
import { effectiveAiEngines } from "@/lib/scope/engines";
import { canOperateProject } from "@/lib/auth/operator-policy";

// Project detail > Setting (Task E + D).
// Owner-only edit + delete. Viewer/non-member gets notFound() per the
// "never leak project existence" rule (matches members page).
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

  const project = await projectRepository.getById(id);
  if (!project) notFound();

  const membership = await projectMemberRepository.findMembership(
    id,
    session.user.id,
  );
  const isAdmin = session.user.role === "admin";
  if (!isAdmin && (!membership || membership.status !== "active")) {
    notFound();
  }

  const canEdit = isAdmin || membership?.role === "owner";
  // AI 엔진 변경은 비용 레버라 operator 게이트까지 — 서버 액션(updateProjectEngines)
  // 과 동일 술어. "보이는 것 = 할 수 있는 것".
  const canEditEngines = canEdit && canOperateProject(session.user, membership);

  const [brandsRaw, designatedBrandsRaw, vehiclesRaw, trackedUrlsRaw, ownedBasesRaw, analysisDiagnostic, engineHistoryRaw] = await Promise.all([
    trackedBrandRepository.listForProject(id),
    trackedCompetitorRepository.listForProject(id),
    trackedVehicleRepository.listForProject(id),
    listProjectTrackedUrls(id),
    listProjectOwnedBases(id),
    isAdmin ? diagnoseProjectAnalysisConnection(id) : Promise.resolve(null),
    projectRepository.listEngineHistory(id),
  ]);
  const engineHistory = engineHistoryRaw.map((h) => ({
    id: h.id,
    engines: h.engines,
    changedAt: h.changedAt.toISOString(),
  }));
  const ownedBases = ownedBasesRaw.map((b) => ({
    id: b.id,
    baseUrl: b.baseUrl,
    label: b.label,
  }));
  const brandAliasMap = new Map(
    brandsRaw.map((row) => [row.canonicalName, row.aliases ?? []] as const),
  );
  const trackedUrls = trackedUrlsRaw.map((u) => ({
    id: u.id,
    url: u.url,
    label: u.label,
  }));

  // Scope mirror 연결 진단 — syncStandardMirror(lib/scope/mirror/sync.ts)는
  // ROOT env 프로젝트뿐 아니라, scope_project_id 가 채워진 모든 로컬 projects
  // 행을 DB에서 직접 읽어(linkedIds) sync 대상에 자동 포함한다(2026-07-02
  // 추적 재정의 작업에서 도입). 즉 이 프로젝트 자신의 scope_project_id 가 있는
  // 한 SCOPE_EXTRA_PROJECT_IDS 등록 여부와 무관하게 이미 동기화 대상이다 —
  // env 매칭을 "비활성" 신호로 쓰던 예전 로직은 그 시점 이후로는 오탐이었다.
  const rootScopeId = process.env.SCOPE_ROOT_PROJECT_ID ?? null;
  const scopeLink: {
    status: "missing" | "root" | "linked";
    scopeProjectId: string | null;
  } = !project.scopeProjectId
    ? { status: "missing", scopeProjectId: null }
    : project.scopeProjectId === rootScopeId
      ? { status: "root", scopeProjectId: project.scopeProjectId }
      : { status: "linked", scopeProjectId: project.scopeProjectId };
  const designatedBrands = designatedBrandsRaw.map((c) => ({
    id: c.id,
    brandName: c.brandName,
    aliases: brandAliasMap.get(c.brandName) ?? c.aliases ?? [],
    notes: c.notes,
    isTarget: c.isTarget,
  }));
  const vehicles = vehiclesRaw.map((v) => ({
    id: v.id,
    brand: v.brand,
    model: v.model,
    segment: v.segment,
    aliases: v.aliases ?? [],
  }));

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
          initial={effectiveAiEngines(project.aiEngines)}
          explicit={project.aiEngines != null}
          history={engineHistory}
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
          ownBrandAliases={
            project.brand
              ? (brandAliasMap.get(project.brand) ?? []).filter(
                  (alias) => alias !== project.brand,
                )
              : []
          }
          brands={designatedBrands}
          vehicles={vehicles}
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
          {isAdmin && analysisDiagnostic ? (
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
                    {t(`scopeLink.analysisProbe.overall.${analysisDiagnostic.overall}`)}
                  </dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("scopeLink.analysisProbe.mentionLabel")}
                  </dt>
                  <dd className="text-foreground">
                    {t(`scopeLink.analysisProbe.state.${analysisDiagnostic.mention.state}`)}
                  </dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="w-28 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("scopeLink.analysisProbe.citationLabel")}
                  </dt>
                  <dd className="text-foreground">
                    {t(`scopeLink.analysisProbe.state.${analysisDiagnostic.citation.state}`)}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                {t(`scopeLink.analysisProbe.fix.${analysisDiagnostic.overall}`)}
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
