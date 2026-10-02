import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import {
  MessageSquareText,
  Sparkles,
  Users,
  Clock,
  ArrowRight,
  Search,
  UserPlus,
  PlayCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/section-card";
import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  type DynamicAxis,
} from "@/components/dash/dimension-filter-panel";
import { KpiTilesSkeleton } from "@/components/dash/section-skeleton";
import { MeasurementBasisControl } from "@/components/dash/measurement-basis-control";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { PromptRow, PromptCandidateRow } from "@/lib/db/schema";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import {
  loadDashboardAsOf,
  loadEssentialFilterDates,
  orNullOnTransient,
  type ProjectOverview,
} from "@/lib/hgh/adapters/dashboard";
import { SummaryTiles } from "../../../dashboard/_components/summary-tiles";
import { LiveTrendChart } from "../../../dashboard/_components/live-trend-chart";
import { CompositionPanel } from "../../../dashboard/_components/composition-panel";
import { getProjectDashboard } from "../_data/live";
import {
  fetchProjectStandardAggregates,
  fetchProjectSelectableAnchorDates as fetchProjectSelectableAnchorDatesLegacy,
} from "@/lib/scope/server";
import { AsOfChip, AsOfChipSkeleton } from "@/components/dash/as-of-chip";

// Per-project Dashboard — replaces the bare /projects/[id] redirect.
// Renders:
//   - 4 summary tiles (prompts / candidates / members / last AI call)
//   - prompt status breakdown (horizontal bar)
//   - recent candidates / prompts / members panels
//   - quick action links to Intent / Prompt / Member
//
// Reads from existing repositories — no new DB shape required. Server
// component so the data is fetched on the server and tiles render instantly.
//
// 2026-09-29 (U5): 타일·패널은 `overview`(두 원천 공통 view-model, 페이지가 만든다)를 그린다.
// 종전에는 drizzle 행 3종 전량을 받아 여기서 셌다(설계 3.5 #2). legacy 원천은 같은 계산을
// `_data/live.ts buildProjectOverview` 로 옮겼고, api 원천(HGH_SOURCE_G6)은 ProjectDetail 요약
// 필드(BG-38)로 만든다. 측정 기준일·달력도 원천 스위치를 따른다.

type PromptStatus = PromptRow["status"];

const STATUS_ORDER: PromptStatus[] = [
  "draft",
  "queued",
  "running",
  "done",
  "failed",
  "paused",
];

const STATUS_BAR_COLOR: Record<PromptStatus, string> = {
  draft: "bg-muted-foreground/40",
  queued: "bg-amber-500",
  running: "bg-sky-500",
  done: "bg-emerald-600",
  failed: "bg-destructive",
  paused: "bg-slate-400",
};

const CANDIDATE_SOURCE_LABEL: Record<PromptCandidateRow["source"], string> = {
  google_keyword: "구글 키워드",
  social_scraping: "커뮤니티 수집",
  manual: "수동 추가",
};

export async function ProjectDashboard({
  locale,
  projectId,
  overview,
  filters,
  geographyOptions,
  dynamicAxes,
  brand,
}: {
  locale: string;
  projectId: string;
  overview: ProjectOverview;
  filters: StandardFilters;
  geographyOptions?: string[];
  dynamicAxes?: DynamicAxis[];
  brand?: string | null;
}) {
  const t = await getTranslations("projectDetail.dashboard");
  const tStatus = await getTranslations("projectDetail.prompt.list.status");
  const api = isAnalysisApi("dashboard", "project");

  const lastAi = overview.lastAi;
  const statusCounts = STATUS_ORDER.map(
    (s) => overview.statusCounts.find((c) => c.status === s) ?? { status: s, count: 0 },
  );
  const totalForBar = Math.max(overview.promptCount, 1);
  // 측정이 끝난(완료) 프롬프트가 하나라도 있으면, 아직 집계가 안 잡혔을 때
  // "측정 전"이 아니라 "측정 완료·집계 반영 대기"로 안내한다(프롬프트 상태와 정합).
  const hasMeasuredPrompts = overview.hasMeasuredPrompts;

  const recentCandidates = overview.recentCandidates;
  const recentPrompts = overview.recentPrompts;
  const apiCtx = { surface: "project" as const, projectId, scope: null, customFields: filters.customFieldFilters };
  // 달력(앵커 축 회차 날짜): api 는 GET /v1/filters/dates(family=all). D6 필수 호출의 보관 프로미스를
  // 그대로 읽어 요청 안 1회다(실패해도 셸이 다시 보내지 않는다, U5 검증 D3).
  // legacy 는 종전 리더. 같은 이름으로 골라 두어 패널 배선(selectableDates)은 한 줄 그대로다.
  const fetchProjectSelectableAnchorDates = api
    ? async (pid: string, _f: StandardFilters, _family: "all") =>
        (await loadEssentialFilterDates({ surface: "project", projectId: pid, scope: null }))?.selectableDates
    : fetchProjectSelectableAnchorDatesLegacy;

  return (
    <FilterTransitionProvider>
      <div className="flex flex-col gap-6">
      {/* Global filter bar — top of content (directly under the project
          header), the single data driver for the KPI cards below. Stays mounted
          while the KPI section reloads (shared FilterTransitionProvider). */}
      <DimensionFilterPanel
        stage="overview"
        // 측정 기준일 — KPI 섹션과 **같은 집계의 asOf**. 종전엔
        // getLatestMeasuredAt 이라 ① 필터(국가·엔진·기간)를 무시하고 ② 답변/런
        // status 도 안 봐서 **실패 답변의 measured_at 까지 최신으로 집었다**
        // (2026-09-01 실측: 웹사이트 프로젝트들의 completed 최신 08-29 vs failed
        // 최신 08-31 — 화면마다 이틀 차이). 같은 read 라 dedup 으로 접힌다.
        asOfSlot={
          <Suspense fallback={<AsOfChipSkeleton />}>
            <AsOfSlot
              asOf={
                api
                  ? orNullOnTransient(loadDashboardAsOf(filters, apiCtx))
                  : fetchProjectStandardAggregates(projectId, filters).then(
                      (d) => d?.asOf ?? null,
                    )
              }
            />
          </Suspense>
        }
        basis={<MeasurementBasisControl />}
        // 앵커 축(스펙 §5.1) — 프로젝트 표면은 정규 요일이 없어 임의 날짜가 온다
        // (귀속 날짜 = anchor_date, §9.2). 축 off 면 undefined = 종전 달력.
        selectableDates={await fetchProjectSelectableAnchorDates(projectId, filters, "all")}
        onlyGroups={["time", "geography", "engine", "promptContext"]}
        geographyOptions={geographyOptions}
        regionBrand={brand ?? undefined}
        dynamicAxes={dynamicAxes}
        sections={FILTER_SECTIONS}
        sticky
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          icon={MessageSquareText}
          label={t("tiles.prompts")}
          value={overview.promptCount}
          href={`/${locale}/projects/${projectId}/prompt`}
        />
        <Tile
          icon={Sparkles}
          label={t("tiles.candidates")}
          value={overview.candidateCount}
          href={`/${locale}/projects/${projectId}/intent`}
        />
        <Tile
          icon={Users}
          label={t("tiles.members")}
          value={overview.activeMemberCount}
          href={`/${locale}/projects/${projectId}/member`}
        />
        <Tile
          icon={Clock}
          label={t("tiles.lastAi")}
          value={lastAi ? formatRelative(lastAi, locale) : "—"}
        />
      </div>

      {/* 프로젝트 측정 대시보드 — 표준과 동일 산식/컴포넌트, 모집단만 이 프로젝트로.
          KPI(subKPI 포함) · 추이 · 구성 · 랭킹을 한 번의 scope 집계에서 렌더. filter
          apply 시 이전 값은 dim 유지(FilterContentDim), narrowing 재집계는 뒤에서. */}
      <FilterContentDim>
        <Suspense fallback={<KpiTilesSkeleton count={7} />}>
          <ProjectMeasurementSections
            projectId={projectId}
            filters={filters}
            hasMeasuredPrompts={hasMeasuredPrompts}
          />
        </Suspense>
      </FilterContentDim>

      <SectionCard
        title={t("status.title")}
        description={t("status.description", { count: overview.promptCount })}
      >
        {overview.promptCount === 0 ? (
          <p className="text-sm text-muted-foreground">{t("status.empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
              {statusCounts.map(({ status, count }) =>
                count === 0 ? null : (
                  <div
                    key={status}
                    className={STATUS_BAR_COLOR[status]}
                    style={{ width: `${(count / totalForBar) * 100}%` }}
                    aria-label={`${tStatus(status)} ${count}`}
                  />
                ),
              )}
            </div>
            <ul className="flex flex-wrap gap-3 text-xs">
              {statusCounts.map(({ status, count }) => (
                <li key={status} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_BAR_COLOR[status]}`}
                  />
                  <span className="font-medium text-foreground">{tStatus(status)}</span>
                  <span className="tabular-nums text-muted-foreground">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={t("recentCandidates.title")}
          description={t("recentCandidates.description")}
        >
          {recentCandidates.length === 0 ? (
            <EmptyHint
              label={t("recentCandidates.empty")}
              href={`/${locale}/projects/${projectId}/intent`}
              cta={t("recentCandidates.cta")}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {recentCandidates.map((c) => (
                <li
                  key={c.id}
                  className="flex items-start justify-between gap-3 rounded border border-border bg-card px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-sm text-foreground line-clamp-2">{c.text}</p>
                    {c.sourceKeyword ? (
                      <span className="text-[10px] text-muted-foreground">
                        ↳ {c.sourceKeyword}
                      </span>
                    ) : null}
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {CANDIDATE_SOURCE_LABEL[c.source]}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title={t("recentPrompts.title")}
          description={t("recentPrompts.description")}
        >
          {recentPrompts.length === 0 ? (
            <EmptyHint
              label={t("recentPrompts.empty")}
              href={`/${locale}/projects/${projectId}/prompt`}
              cta={t("recentPrompts.cta")}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {recentPrompts.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start justify-between gap-3 rounded border border-border bg-card px-3 py-2"
                >
                  <p className="line-clamp-2 text-sm text-foreground">{p.text}</p>
                  <Badge
                    variant={p.status === "done" ? "default" : "secondary"}
                    className="shrink-0 text-[10px] uppercase"
                  >
                    {tStatus(p.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title={t("quickActions.title")}
        description={t("quickActions.description")}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <QuickAction
            icon={Search}
            label={t("quickActions.intent")}
            href={`/${locale}/projects/${projectId}/intent`}
          />
          <QuickAction
            icon={PlayCircle}
            label={t("quickActions.prompt")}
            href={`/${locale}/projects/${projectId}/prompt`}
          />
          <QuickAction
            icon={UserPlus}
            label={t("quickActions.member")}
            href={`/${locale}/projects/${projectId}/member`}
          />
        </div>
      </SectionCard>
      </div>
    </FilterTransitionProvider>
  );
}

// Live per-project 측정 대시보드 — 표준과 같은 컴포넌트, 데이터는 project-scoped
// 집계(getProjectDashboard). LIVE-ONLY: null → 측정 대기 pending. perturb={false}.
// KPI(subKPI 포함) → 추이 → 구성(주제·출처) → 랭킹. GEO는 1차 제외(단일국).
// export 는 렌더 테스트 seam (`project-dashboard.render.test.tsx`) — 페이지는 아래
// `ProjectDashboard` 를 통해서만 쓴다.
export async function ProjectMeasurementSections({
  projectId,
  filters,
  hasMeasuredPrompts,
}: {
  projectId: string;
  filters: StandardFilters;
  hasMeasuredPrompts: boolean;
}) {
  const t = await getTranslations("projectDetail.dashboard");
  const tDash = await getTranslations("dashboard");
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  const data = await getProjectDashboard(projectId, filters);
  if (!data) {
    // 집계가 아직 0건일 때 두 상황을 구분해 안내한다:
    //  - 완료된 프롬프트가 있으면 = 측정은 끝났고 집계 반영을 기다리는 중(정기 동기화).
    //    프롬프트 "완료" 배지와 대시보드 문구가 어긋나 보이던 혼란을 해소.
    //  - 완료 프롬프트가 없으면 = 아직 측정 자체가 안 됨(기존 문구 유지).
    return (
      <div className="flex items-center justify-center rounded-md border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-xs text-muted-foreground">
        {hasMeasuredPrompts ? t("kpi.pendingAggregation") : t("kpi.pending")}
      </div>
    );
  }
  const {
    kpis,
    trend,
    trendDegraded,
    composition,
    citationAccuracyNotice,
  } = data;
  return (
    <div className="flex flex-col gap-6">
      <SectionCard title={t("kpi.title")} description={t("kpi.description")}>
        {citationAccuracyNotice ? (
          <div className="mb-4 rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {t(`kpi.notice.${citationAccuracyNotice}`)}
          </div>
        ) : null}
        <SummaryTiles items={kpis} perturb={false} />
      </SectionCard>

      {/* 추이 — 측정 버킷(주) KPI 시계열. 버킷 1개뿐이면 차트 대신 안내.
          ⚠️ `trend === null` 의 **두 뜻**을 가른다(`mentions-prompts-section.tsx` 와 같은 자세):
            ① 예산 초과(57014) → `trendDegraded` → "시간 안에 끝나지 않았습니다"
            ② 측정 버킷 2개 미만 → 종전의 "집계 중"
          ①을 ②로 그리면 사용자는 지연을 "데이터가 쌓이는 중"으로 오독한다. degrade 가
          먼저다 — ①에서도 ⑥ 인용률 선만 남아 `trend` 가 non-null 일 수 있어서, 그
          반쪽짜리 차트보다 고지가 맞다. 문구는 4-KPI 탭이 이미 쓰는 것을 재사용한다
          (`degrade-notice.tsx` 와 같은 근거 — 새 문자열을 만들지 않는다). */}
      <SectionCard title={tDash("trend.title")} description={tDash("trend.description")}>
        {trendDegraded ? (
          <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            {tKpi("degraded")}
          </div>
        ) : trend && trend.points.length >= 2 ? (
          <LiveTrendChart trend={trend} />
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            {tDash("trend.accruing")}
          </div>
        )}
      </SectionCard>

      {/* 구성 — #21 프롬프트 주제별 / #22 출처별 구성비. 둘 다 없으면 생략. */}
      {composition.topics.length > 0 || composition.sources.length > 0 ? (
        <SectionCard
          title={tDash("composition.title")}
          description={tDash("composition.description")}
        >
          <CompositionPanel topics={composition.topics} sources={composition.sources} />
        </SectionCard>
      ) : null}

    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  href?: string;
}) {
  const content = (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-brand-700/40">
      <Icon className="h-5 w-5 text-brand-700" aria-hidden />
      <div className="flex min-w-0 flex-col">
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <span className="font-head text-xl font-semibold tracking-tight tabular-nums text-foreground">
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}

function EmptyHint({
  label,
  href,
  cta,
}: {
  label: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="flex items-center justify-between rounded border border-dashed border-border px-3 py-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
      >
        {cta}
        <ArrowRight className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  );
}

function QuickAction({
  icon: Icon,
  label,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-3 text-sm transition-colors hover:border-brand-700/40 hover:bg-muted/40"
    >
      <span className="flex items-center gap-2 font-medium text-foreground">
        <Icon className="h-4 w-4 text-brand-700" aria-hidden />
        {label}
      </span>
      <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
    </Link>
  );
}

// Compact relative time without Date.now() at module load (server-render
// time). Server runs of this component get a fresh Date at request time, so
// the formatter is safe; the helper accepts the reference now explicitly.
function formatRelative(d: Date, locale: string): string {
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale === "ko" ? "ko" : "en", {
    numeric: "auto",
  });
  if (diffMin < 1) return locale === "ko" ? "방금 전" : "just now";
  if (diffMin < 60) return rtf.format(-diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return rtf.format(-diffHr, "hour");
  const diffDay = Math.round(diffHr / 24);
  return rtf.format(-diffDay, "day");
}

// 프로미스를 여기서만 await 한다 — 이 컴포넌트만 서스펜드하고 필터바는 이미 떠 있다.
async function AsOfSlot({ asOf }: { asOf: Promise<string | null> }) {
  const date = await asOf;
  return date ? <AsOfChip date={date} /> : null;
}
