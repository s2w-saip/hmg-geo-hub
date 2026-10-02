import "server-only";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { requestDeduped } from "@/lib/request-dedupe";
import {
  PERF_PROBE_CACHE_TTL,
  withNoCacheSalt,
} from "@/lib/perf/nocache-probe";
import { getSession } from "@/lib/auth/session";
import { deriveScopeFilter, projectInScope } from "@/lib/auth/scope-policy";
// 발행 리포트 정본 경로(`X.reportTruth`) — 판정 술어는 순수 함수, 데이터는 리포지토리.
import { reportTruthEnabled } from "@/lib/summary/read/report-truth-flag";
import {
  decidePublishedSelection,
  publishedSubtotal,
  resolveReportTruthRoute,
} from "@/lib/reports/truth-axes";
import { pct1 } from "@/lib/reports/sb-data";
import {
  latestVisibleWebsiteRound,
  loadPublishedWebsiteRound,
  websiteRuntimeClassification,
} from "@/lib/db/repositories/report-publications";
import { auditScopeCall } from "@/lib/audit";
import { UnauthorizedError } from "@/lib/auth/errors";
import {
  KPI_TAB_ENGINE_BUDGET_MS,
  DELTA_TREND_WINDOW_DAYS,
  KPI_TAB_HERO_TREND_DAYS,
  KPI_TAB_SINGLE_BUDGET_MS,
  KPI_TAB_SPARK_TREND_DAYS,
  KPI_TAB_STATEMENT_TIMEOUT_MS,
  KPI_TAB_SUB_KPI_PARTS,
  S4_BADGE_SUB_KPI_PARTS,
  MIRROR_HEAVY_STATEMENT_TIMEOUT_MS,
  MIRROR_EXTRAS_BUDGET_MS,
  mirrorHeavyBudget,
  mirrorExtrasBudget,
  mentionsBudgetOf,
  type MentionsBudgetProfile,
  citationsBudgetOf,
  type CitationsBudgetProfile,
  kpiBudgetOf,
  type KpiBudgetProfile,
  kpiDegrade,
  recoverDegraded,
  uncachedIfDegraded,
} from "./kpi-tab-budget";
import { degradeAware } from "./degrade-registry";
// 화면이 "데이터 없음" 과 "예산 초과" 를 구분할 수 있게 같은 경로로 재수출한다
// (서버 컴포넌트는 이미 `@/lib/scope/server` 를 임포트하고 있다).
export { wasDegraded, degradedLabels } from "./degrade-registry";
export { KPI_TAB_HERO_TREND_DAYS, KPI_TAB_SPARK_TREND_DAYS };
import { getScopeClient, isMockMode } from "./index";
import { ScopeHttpError } from "./http";
import { pageAll, PROMPT_MAX_PAGES } from "./paging";
import { projectRepository } from "@/lib/db/repositories/projects";
import { cachedProjectById } from "@/lib/db/repositories/request-cache";
import { entityRegistryRepository } from "@/lib/db/repositories/entity-registry";
import {
  excludedBrandNames,
  toExcludedBrandSet,
  filterMentionsLive,
  filterCompetitorValues,
  filterAggregatesBrands,
  filterBrandTrend,
  filterFirstPosition,
  filterEngineKpiTrend,
  markExcludedGeo,
  filterAcr,
  type ExcludedBrandSet,
} from "@/lib/scope/excluded-brands";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { listProjectOwnedBases } from "@/lib/db/repositories/project-owned-bases";
import { getProjectIdsForScope } from "@/lib/db/repositories/website-sites";
import {
  resolveWebsiteSummaryRouteBase,
  resolveGlobalSummaryRouteBase,
  applyScreenGate,
  applyScreenGateAligned,
  summaryRouteHeaderValue,
  type ScreenGateAlign,
  type SummaryReadRoute,
} from "@/lib/summary/read/gate";
import { summaryScreenAllowed, type SummaryScreenKey } from "@/lib/summary/read/screens";
import { periodRouteEnabledForScreen } from "@/lib/summary/read/period-route-flag";
import type { CycleSurface } from "@/lib/db/repositories/summary-cycles";
import {
  withTrendGapBuckets,
  trendGapWeekKeys,
  weeklyGapWeeks,
  insertCompletionGapBuckets,
} from "@/lib/summary/read/trend-gaps";
import type { TrendGapFamily } from "@/lib/viz/trend-gap";
import {
  buildTrendGrid,
  trendGridDateFloor,
  withTrendGridWindow,
  type TrendSlot,
} from "@/lib/period/trend-grid";
import {
  trendGridKeyResolver,
  type TrendGridSlotView,
} from "@/lib/period/trend-grid-axis";
import { ensureTrendGrid, preCatalogCacheSlot } from "@/lib/period/trend-grid-flag";
import {
  DELTA_TREND_BUCKET,
  citationShareNumerator,
  deltaTrendFilters,
  overviewCardDelta,
  overviewTrendValues,
  type OverviewCardDelta,
  type OverviewKpiKey,
} from "@/lib/kpi/overview-card-values";
import {
  applyTrendGridToBuckets,
  applyTrendGridToWeeklyTrend,
  restrictToTrendGrid,
  toTrendGridSlotViews,
} from "@/lib/summary/read/trend-grid-buckets";
import { competitorDeltaBrands } from "./competitor-row";
import { RANK_TABLE_TOP_BRANDS } from "@/lib/kpi/first-position-rank";
import { countOf, timedRead } from "@/lib/perf/read-timing";
import type {
  SummaryCyclePick,
  WebsiteCyclePick,
} from "@/lib/db/repositories/summary-cycles";
import {
  summaryUnitFlagsAvailable,
  websiteExcludedUnits,
  periodCompareEpochRaw,
} from "@/lib/db/repositories/summary-settings";
// ── GGMD-107 기간 비교 Δ ────────────────────────────────────────────────────
import { periodCompareEnabled } from "@/lib/summary/read/period-compare-flag";
import {
  PERIOD_COMPARE_EPOCH,
  periodCompareApplies,
  windowsFromRange,
  windowKey,
  windowLength,
  computeCompare,
  type CompareFamily,
  type CompareKind,
  type CompareMetricKey,
  type CompareResult,
  type CompareWindow,
  type ComparePeriod,
} from "@/lib/kpi/period-compare";
import {
  resolveWindowEndInfo,
  readComparePeriods,
  type WindowEndInfo,
} from "@/lib/db/repositories/summary-period-compare";
// 축 판정은 **집계층 리더와 같은 상태**(`anchor-axis-state`)에서 읽는다. 플래그 파일을
// 직접 부르면 그 30초 메모와 리더의 30초 TTL 이 서로 다른 창을 가져, 화면 키를 껐다 켜는
// 순간 한 요청 안에서 달력·비교와 집계층이 **다른 축**을 볼 수 있다(모수가 갈린다).
// `ensureAnchorAxis()` 는 throw 하지 않는다 — 판정 실패의 의미가 "종전 축" 이라 값이
// 틀릴 방향이 없다.
import { ensureAnchorAxis } from "@/lib/period/anchor-axis-state";
// 축 on 캐시 셀의 회차 정체성 조각(2026-09-27). 역시 throw 하지 않는다 — 실패는 직전 칸
// 지문 재사용 또는 5분 버킷. 셀별 모드는 이름으로 정한다.
import { ensureCycleCacheSlot } from "@/lib/period/cycle-fingerprint";
import { mirrorCycleModeOf } from "./mirror-cache-cycle-mode";
import {
  toAnchorSurface,
  type AnchorHiddenFamily,
  type AnchorSurface,
} from "@/lib/db/repositories/scope-answer-anchors";
import { loadSelectableAnchorDates } from "@/lib/calendar/selectable-anchor-dates";
import {
  summaryWebsiteDashboard,
  summaryWebsiteSubKpis,
  summaryWebsitePromptTopics,
  summaryWebsiteSourceComposition,
  summaryWebsiteCitationAccuracy,
  summaryWebsitePromptHitRates,
  summaryWebsiteTrend,
  summaryWebsiteCitationAccuracyTrend,
  summaryWebsiteCitationsFromTrend,
  summaryWebsiteAggregatesDetail,
  summaryWebsiteSubKpisDetail,
  summaryWebsiteSourceCompositionDetail,
  summaryWebsiteGeoCompetitionDetail,
} from "@/lib/db/repositories/summary-website-aggregates";
import { trendFoldPresent } from "@/lib/db/repositories/summary-trend-fold";
import {
  summaryGlobalAggregates,
  summaryGlobalSourceComposition,
  summaryGlobalSubKpis,
  summaryGlobalPromptTopics,
  summaryGlobalGeoCompetition,
  summaryGlobalS1FromTrend,
  summaryGlobalCitationsFromTrend,
  summaryGlobalSourceCompositionFromTrend,
  S1_TREND_AXES,
  S1_TREND_LIMITS,
  type SummaryGlobalS1,
  type SummaryTrendRead,
} from "@/lib/db/repositories/summary-global-aggregates";
import type { CitationTrendRead } from "@/lib/db/repositories/summary-citation-read";
import {
  planTrendRead,
  readSummaryGroupKeyUniverse,
  type TrendReadScope,
  type TrendStatementKey,
} from "@/lib/db/repositories/summary-trend-aggregates";
import { readMirrorCitationKeyUniverse } from "@/lib/db/repositories/citation-key-universe";
import { officialHmgGroupKeys } from "@/lib/kpi/official-hmg-citations";
import {
  CITATION_OVERRIDES_TAG,
  loadCitationOverrides,
} from "@/lib/citation-categorizer/overrides-loader";
import { resolveCitationCategory } from "@/lib/citation-categorizer";
import {
  citationCyclesOf,
  restrictToSlotRepresentative,
  restrictToTrendSlotSet,
  trendGridApplied,
  type CycleSet,
  type TrendSlotRestriction,
} from "@/lib/summary/read/cycle-set";
import {
  readGlobalSlotGroupCitations,
  trendDayKeyOf,
  readGlobalTrendCore,
  readGlobalBrandSnapshot,
  readGlobalBrandSeries,
  attachBrandSeries,
  pickSeriesBrands,
  toStandardTrendBuckets,
  toBrandTrend,
  toFirstPosition,
  withTrendGridKnown,
  type GlobalTrendBrandPoint,
  type GlobalTrendSeries,
} from "@/lib/db/repositories/summary-global-trend-read";
import { narrowScopeBrands, ownedBasePrefixesForScope } from "./hmg-brands";
import type { WebsiteOwnedUnit } from "./website-owned-unit";
import { ensureWebsiteOwnedUnit } from "./website-owned-unit-state";
import { geoCountryCode } from "@/lib/geo-catalog";
import {
  GEO_OWNED_BASES,
  GEO_OWNED_BASE_PREFIXES,
  ownedBasePrefixFromUrl,
} from "@/lib/geo-catalog/owned";
import {
  getRootConfig,
  getStandardRootId,
  STANDARD_FILTER_ARRAY_AXES,
  type StandardFilters,
  type StandardAggregates,
  type CompetitorBrandValue,
  type MentionsLive,
  type MentionsPromptLive,
  type CitationsLive,
  type CitationDomainLive,
  type WeeklyTrend,
  applyWeeklyTrendGaps,
} from "./result-adapter";
import {
  aggregateStandardFromMirror,
  createSnapshotAnswerSetStore,
  withSnapshotAnswerSetScope,
  aggregateStandardTrendFromMirror,
  aggregateSubKpisFromMirror,
  latestMeasureDays,
  measureDayBoundsInRange,
  aggregatePromptTopicFromMirror,
  type PromptTopicSlice,
  aggregateCitationAccuracy,
  aggregateCitationAccuracyTrend,
  aggregateWebsiteCitationAccuracy,
  aggregateWebsiteCitationAccuracyTrend,
  aggregateWebsiteTargetHitRate,
  normalizeUrlForMatch,
  type WebsiteTargetHitRateResult,
  type CitationAccuracyResult,
  type CitationAccuracyTrendBucket,
  aggregateMentionsFromMirror,
  aggregateCitationsFromMirror,
  aggregateSourceCompositionFromMirror,
  aggregateBrandCitationsFromMirror,
  aggregateGeoCompetitionFromMirror,
  getMirrorAnswerBody,
  type GeoBrandMention,
  type SourceDomainSlice,
  type BucketUnit,
  type StandardTrendBucket,
  type TrendWeekSource,
  type StandardSubKpis,
  type OverviewCardValues,
  aggregateAcrFromMirror,
  type StandardAcr,
  aggregateSignalPromptsFromMirror,
  type SignalKey,
  listMeasuredEngines,
  // 4-KPI 탭(PR ②) — 회차 집계 3종 + 카탈로그 프롬프트 수.
  websiteDeclaredOwnedBases,
  websiteOwnedUnits,
  // 4-KPI 탭 — 회차 집계 3종 + 카탈로그 프롬프트 수.
  aggregateBrandTrendFromMirror,
  aggregateEngineKpiTrendFromMirror,
  aggregateFirstPositionFromMirror,
  aggregateGeoKpiFromMirror,
  aggregateCitationOwnedPromptsFromMirror,
  aggregateCitationToneSummaryFromMirror,
  aggregateCitationToneUrlsFromMirror,
  aggregateCitationTypeCategoriesFromMirror,
  aggregateTypeKpiFromMirror,
  aggregateAnswerStanceDistributionFromMirror,
  type AnswerStanceDistribution,
  listUnmeasuredPromptsFromCatalog,
  type CitationCategoryTotals,
  type UnmeasuredPrompt,
  countCatalogPromptsFromCatalog,
  type BrandTrendResult,
  type EngineKpiTrend,
  type FirstPositionResult,
  type GeoKpiResult,
  type CitationOwnedPromptPage,
  type CitationTone,
  type CitationToneSummary,
  type CitationToneUrlPage,
  type CitationTypeCategoryRow,
  type TypeKpi,
  type SubKpiPart,
} from "@/lib/db/repositories/scope-aggregates";
import type {
  BrandMentionsQuery,
  BrandScoresQuery,
  CitationsQuery,
  CreateProjectInput,
  CreatePromptInput,
  PageQuery,
  Prompt,
  PromptsQuery,
  ScheduleUpdateInput,
  UpdateProjectInput,
  UpdatePromptInput,
} from "./types";
import type { AllowedScope } from "@/lib/auth/types";

// The ONLY enforced entry point to scope. Both API route handlers and server
// components call these — never the raw client, never a client component
// (scope-gateway / access-control specs). Each call:
//   1. requires an authenticated session,
//   2. derives the role scope (for audit attribution + future project gating),
//   3. logs per-user attribution,
//   4. then invokes the role-blind ScopeClient.
//
// SCOPE GATING (ENFORCING since 2026-07-02): scope's public reads are
// project-scoped, so role→data isolation means "which projects may this role
// read" — resolved by `assertProjectInScope` (single chokepoint below).

// Re-exported so existing imports (app/api/scope/*) keep working; the canonical
// definition is shared with the DB data-access layer (lib/auth/errors).
export { UnauthorizedError };

async function enforce(action: string) {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const filter = deriveScopeFilter(session.user);
  auditScopeCall(session.user, action, filter);
  return { user: session.user, filter, client: getScopeClient() };
}

// 프로젝트 상세 위젯 1개(fetchProject*)가 assertProjectInScope + resolveScopeProjectId
// + (일부는) ownedBasePrefixesForProject까지 같은 localProjectId 행을 최대 3번
// 중복 조회하고, 위젯이 5~9개라 렌더당 두 자릿수 중복 조회로 누적된다. React
// cache()로 요청 1건당 1회로 접는다 — cachedProjectIdsForScope(website 경로)와
// 동일 패턴.
//
// 2026-07-15: 이 memo가 이 모듈 private이라 (dash) 레이아웃/리프 페이지의 동일
// getById는 캐시를 못 타고 중복됐다. repositories/request-cache로 올려 레이아웃·
// 페이지·scope 게이트웨이가 요청당 같은 memo 1개를 공유한다.

// ENFORCING (2026-07-02 결정: scope + vendor는 멤버십):
//   admin(scope.all)   → 전체 허용
//   표준 루트           → vendor 제외 전 역할 (route-policy와 동일 경계).
//                        website(웹사이트 열람, 2026-07-22)도 통과 — 웹사이트
//                        대시보드가 표준 루트 집계를 공유하기 때문. 값 격리는
//                        여느 역할처럼 profile scope 필터가 담당한다.
//   hq/region/country/website
//                      → 프로젝트 brand×country ∈ 계정 scope, 또는 수락된 멤버십
//                        (명시 초대는 스코프 밖이어도 유효한 권한 부여로 취급)
//   vendor             → 수락된(active) 멤버십만
//   미식별 id           → default-deny
// `projectId`는 호출부에 따라 로컬 projects.id / scope project id가 혼재 — 양쪽
// 다 해소. getSession()은 React cache()라 enforce()와 세션 조회가 중복되지 않는다.
async function assertProjectInScope(_action: string, projectId: string): Promise<void> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const { user } = session;
  if (user.scope.all) return;
  if (projectId === getStandardRootId()) {
    if (user.role === "vendor") throw new UnauthorizedError();
    return;
  }
  const project =
    (await cachedProjectById(projectId)) ??
    (await projectRepository.getByScopeProjectId(projectId));
  if (!project) throw new UnauthorizedError();
  const membership = await projectMemberRepository.findMembership(project.id, user.id);
  const activeMember = membership?.status === "active";
  if (user.role === "vendor") {
    if (!activeMember) throw new UnauthorizedError();
    return;
  }
  if (activeMember) return;
  if (!projectInScope(user.scope, { brand: project.brand, country: project.country })) {
    throw new UnauthorizedError();
  }
}

// --- Settings: projects ---

export async function listProjects(query?: PageQuery) {
  const { client } = await enforce("listProjects");
  return client.listProjects(query);
}

export async function getProject(projectId: string) {
  const { client } = await enforce("getProject");
  await assertProjectInScope("getProject", projectId);
  return client.getProject(projectId);
}

export async function createProject(input: CreateProjectInput) {
  const { client } = await enforce("createProject");
  return client.createProject(input);
}

export async function updateProject(projectId: string, input: UpdateProjectInput) {
  const { client } = await enforce("updateProject");
  await assertProjectInScope("updateProject", projectId);
  return client.updateProject(projectId, input);
}

export async function deleteProject(projectId: string) {
  const { client } = await enforce("deleteProject");
  await assertProjectInScope("deleteProject", projectId);
  return client.deleteProject(projectId);
}

// --- Settings: measurement schedule (1 project = 1 schedule, upsert) ---
// 스케줄 CONFIG 다 — 측정 트리거가 아니다(측정 트리거 /query·/measurements 는
// 이 게이트웨이에 의도적으로 없다). 프로젝트 AI 엔진 선택(lib/scope/engines.ts)이
// `targets` 로 여기까지 흘러 scope 측 수집 엔진을 바꾼다(project-sync.ts).

export async function getSchedule(projectId: string) {
  const { client } = await enforce("getSchedule");
  await assertProjectInScope("getSchedule", projectId);
  return client.getSchedule(projectId);
}

export async function putSchedule(projectId: string, input: ScheduleUpdateInput) {
  const { client } = await enforce("putSchedule");
  await assertProjectInScope("putSchedule", projectId);
  return client.putSchedule(projectId, input);
}

// --- Settings: prompts ---

export async function listPrompts(projectId: string, query?: PromptsQuery) {
  const { client } = await enforce("listPrompts");
  await assertProjectInScope("listPrompts", projectId);
  return client.listPrompts(projectId, query);
}

export async function createPrompt(projectId: string, input: CreatePromptInput) {
  const { client } = await enforce("createPrompt");
  await assertProjectInScope("createPrompt", projectId);
  return client.createPrompt(projectId, input);
}

export async function updatePrompt(
  projectId: string,
  promptId: string,
  input: UpdatePromptInput,
) {
  const { client } = await enforce("updatePrompt");
  await assertProjectInScope("updatePrompt", projectId);
  return client.updatePrompt(projectId, promptId, input);
}

export async function deletePrompt(projectId: string, promptId: string) {
  const { client } = await enforce("deletePrompt");
  await assertProjectInScope("deletePrompt", projectId);
  return client.deletePrompt(projectId, promptId);
}

// --- Standard (표준) prompts = the ROOT project's scope prompts ---
// The admin standard-prompt catalog IS the root project's prompt set in scope
// (what scope measures enterprise-wide). The root projectId is env-fixed inside
// getRootConfig (never a caller argument). Each returns null/false when not in
// live mode / root unset → the admin layer falls back to the local DB.

export async function listRootPrompts(): Promise<Prompt[] | null> {
  const { client } = await enforce("listRootPrompts");
  const root = getRootConfig();
  if (!root) return null;
  await assertProjectInScope("listRootPrompts", root.projectId);
  // 종전에는 여기 상한이 20(= 2,000 프롬프트)이었고 커서가 남아도 조용히 끝났다.
  // 루트가 12,012 인 지금 되살아나면 6분의 1만 돌려준다 — 호출부가 0건이라
  // 라이브 피해는 없었지만, enforce("listRootPrompts") 로 게이트웨이에 노출돼
  // 있으므로 다음 사람이 쓰기 전에 고쳐 둔다(2026-08-30 전수 조사).
  return (
    await pageAll(
      (cursor) => client.listPrompts(root.projectId, { limit: 100, cursor }),
      { maxPages: PROMPT_MAX_PAGES, label: `listRootPrompts(project=${root.projectId})` },
    )
  ).items;
}

export async function createRootPrompt(
  input: CreatePromptInput,
): Promise<Prompt | null> {
  const { client } = await enforce("createRootPrompt");
  const root = getRootConfig();
  if (!root) return null;
  await assertProjectInScope("createRootPrompt", root.projectId);
  return client.createPrompt(root.projectId, input);
}

export async function updateRootPrompt(
  promptId: string,
  input: UpdatePromptInput,
): Promise<Prompt | null> {
  const { client } = await enforce("updateRootPrompt");
  const root = getRootConfig();
  if (!root) return null;
  await assertProjectInScope("updateRootPrompt", root.projectId);
  return client.updatePrompt(root.projectId, promptId, input);
}

export async function deleteRootPrompt(promptId: string): Promise<boolean> {
  const { client } = await enforce("deleteRootPrompt");
  const root = getRootConfig();
  if (!root) return false;
  await assertProjectInScope("deleteRootPrompt", root.projectId);
  await client.deletePrompt(root.projectId, promptId);
  return true;
}

// --- Result reads ---

export async function fetchOverview(projectId: string, windowDays?: number) {
  const { client } = await enforce("overview");
  await assertProjectInScope("overview", projectId);
  return client.getOverview(projectId, windowDays);
}

export async function fetchBrandScores(projectId: string, query?: BrandScoresQuery) {
  const { client } = await enforce("brandScores");
  await assertProjectInScope("brandScores", projectId);
  return client.listBrandScores(projectId, query);
}

export async function fetchBrandMentions(projectId: string, query?: BrandMentionsQuery) {
  const { client } = await enforce("brandMentions");
  await assertProjectInScope("brandMentions", projectId);
  return client.listBrandMentions(projectId, query);
}

export async function fetchCitations(projectId: string, query?: CitationsQuery) {
  const { client } = await enforce("citations");
  await assertProjectInScope("citations", projectId);
  return client.listCitations(projectId, query);
}

export async function fetchCitationsByDomain(projectId: string) {
  const { client } = await enforce("citationsByDomain");
  await assertProjectInScope("citationsByDomain", projectId);
  return client.listCitationsByDomain(projectId);
}

export async function fetchReports(projectId: string, query?: PageQuery) {
  const { client } = await enforce("reports");
  await assertProjectInScope("reports", projectId);
  return client.listReports(projectId, query);
}

// --- Per-PROJECT answer analysis (개별 프로젝트 답변 분석) ---
// A single project's mention/citation detail reads the SAME scope_* mirror
// fetchProjectStandardAggregates uses (see fetchProjectMentions/
// fetchProjectCitations below) — not scope's public /brand-mentions·/citations
// endpoints, which currently 404 regardless of whether the project has data.
//
// `localProjectId` is the hmg-geo project id; resolved to its 1:1 scope project
// via scopeProjectId. In mock mode the client ignores the id (synthetic data),
// so any id resolves; in live mode an un-mirrored project has no scope data yet
// → null (the page shows an EmptyState).
async function resolveScopeProjectId(
  localProjectId: string,
): Promise<string | null> {
  const project = await cachedProjectById(localProjectId);
  if (!project) return null;
  if (project.scopeProjectId) return project.scopeProjectId;
  return isMockMode() ? localProjectId : null;
}

/**
 * 프로젝트 표면의 **갭 원장 스코프** — 숨긴 회차를 그 프로젝트로만 좁힌다(0070).
 *
 * 표면(`CycleSurface`)은 여기서 단정할 수 없다 — 원장에는 website·project 가 둘 다 있고
 * 프로젝트 하나가 어느 쪽으로 숨겨졌는지는 원장이 안다. 그래서 표면은 `null`(가리지 않음)
 * 로 두고 projectIds 로만 좁힌다. 못 풀면 `[]` = 갭 조회 자체를 건너뛴다(종전 화면).
 */
// ── 추이 자리 목록의 **유일한 입구** (검증 C1, 2026-09-20) ──────────────────
//
// 종전에는 지면마다 `buildTrendGrid({...})` 를 직접 불렀고, **버킷 경로 셋만** 기간을
// 넘기고 주별 Top-N 경로는 안 넘겼다. 그 결과 사용자가 2주를 고르면 값은 2행인데 축은
// 최근 13자리가 되어 **11칸이 거짓 결측**이 됐다(프로브 실측). B1 과 같은 실패 계열이다:
// 안 읽은 것을 결측이라 말한다. 리포가 0070 갭 경로에 세워 둔 반대 규칙
// (`insertTrendGapSlots`: "축을 넓히지 않는다")을 새 배선만 어기고 있었다.
//
// 그래서 **입구를 하나로 합친다.** 새 지면이 격자를 타려면 이 함수를 부르는 수밖에 없고,
// 그러면 기간·단위 가드를 빠뜨릴 수가 없다.
interface TrendSlotRequest {
  surface: CycleSurface;
  projectIds: string[];
  /** 숨김 게이트가 보는 계열(앵커 §10.2). 지면 단위다 — 기본값을 두지 않는다. */
  family: AnchorHiddenFamily;
  /** 화면이 고른 기간. 자리를 그 안으로 좁힌다(넓히지는 않는다). */
  filters: StandardFilters;
  /**
   * 버킷 단위. **주가 아니면 자리를 안 만든다** — `day` 의 유일한 호출부는 Δ 칩(30일)과
   * 프로젝트 일 추이이고, 설계가 "Δ 전용 30일은 건드리지 않는다" 로 못 박았다. 자리는
   * 주 격자의 개념이라 일 버킷에 얹으면 없던 날을 만든다.
   */
  unit?: BucketUnit;
}

function trendSlotsFor(req: TrendSlotRequest): Promise<TrendSlot[] | null> {
  if ((req.unit ?? "week") !== "week") return Promise.resolve(null);
  return buildTrendGrid({
    surface: req.surface,
    projectIds: req.projectIds,
    family: req.family,
    from: req.filters.dateFrom ?? null,
    to: req.filters.dateTo ?? null,
  });
}

async function gapProjectIds(localProjectId: string): Promise<string[]> {
  const scopeProjectId = await resolveScopeProjectId(localProjectId);
  return scopeProjectId ? [scopeProjectId] : [];
}

type ProjectAnalysisProbeState =
  | "ok"
  | "empty"
  | "unlinked"
  | "forbidden"
  | "notFound"
  | "error"
  | "mock";

export interface ProjectAnalysisProbe {
  state: ProjectAnalysisProbeState;
  sampleCount: number | null;
  httpStatus?: number;
  errorCode?: string;
}

export interface ProjectAnalysisDiagnostic {
  scopeProjectId: string | null;
  overall: "healthy" | "unlinked" | "workspaceAccess" | "noData" | "partial" | "error" | "mock";
  mention: ProjectAnalysisProbe;
  citation: ProjectAnalysisProbe;
}

async function probeProjectPublicEndpoint(
  read: () => Promise<{ data: unknown[] }>,
): Promise<ProjectAnalysisProbe> {
  try {
    const page = await read();
    return {
      state: page.data.length > 0 ? "ok" : "empty",
      sampleCount: page.data.length,
    };
  } catch (err) {
    if (err instanceof ScopeHttpError) {
      if (err.status === 401 || err.status === 403) {
        return {
          state: "forbidden",
          sampleCount: null,
          httpStatus: err.status,
          errorCode: err.code,
        };
      }
      if (err.status === 404) {
        return {
          state: "notFound",
          sampleCount: null,
          httpStatus: err.status,
          errorCode: err.code,
        };
      }
      return {
        state: "error",
        sampleCount: null,
        httpStatus: err.status,
        errorCode: err.code,
      };
    }
    return { state: "error", sampleCount: null };
  }
}

export async function diagnoseProjectAnalysisConnection(
  localProjectId: string,
): Promise<ProjectAnalysisDiagnostic> {
  const { client } = await enforce("projectAnalysisDiagnostic");
  await assertProjectInScope("projectAnalysisDiagnostic", localProjectId);
  const scopeProjectId = await resolveScopeProjectId(localProjectId);
  if (!scopeProjectId) {
    return {
      scopeProjectId,
      overall: "unlinked",
      mention: { state: "unlinked", sampleCount: null },
      citation: { state: "unlinked", sampleCount: null },
    };
  }
  if (isMockMode()) {
    return {
      scopeProjectId,
      overall: "mock",
      mention: { state: "mock", sampleCount: null },
      citation: { state: "mock", sampleCount: null },
    };
  }

  // The per-project public mention/citation endpoints were retired (404 live —
  // see client.ts): probing them reported a FALSE "공개 API 접근 불가" even for
  // projects scope is actively measuring. The real per-project surface is the
  // measurement-runs feed — a reachable, non-empty runs list means scope is
  // measuring this project (results land in the mirror via run→jobs→getQueryRun).
  // Both rows derive from it since there is no separate public mention/citation
  // read anymore.
  const runsProbe = await probeProjectPublicEndpoint(() =>
    client.listMeasurementRuns(scopeProjectId, { limit: 1 }),
  );
  const mention = runsProbe;
  const citation = runsProbe;

  const states = [mention.state, citation.state];
  const both = (state: ProjectAnalysisProbeState) =>
    mention.state === state && citation.state === state;
  const allIn = (...allowed: ProjectAnalysisProbeState[]) =>
    states.every((state) => allowed.includes(state));
  const anyIn = (...allowed: ProjectAnalysisProbeState[]) =>
    states.some((state) => allowed.includes(state));

  let overall: ProjectAnalysisDiagnostic["overall"] = "error";
  if (both("ok")) overall = "healthy";
  else if (allIn("ok", "empty") && anyIn("ok")) overall = "partial";
  else if (both("empty")) overall = "noData";
  else if (allIn("forbidden", "notFound")) overall = "workspaceAccess";
  else if (anyIn("error")) overall = "error";
  else overall = "partial";

  return { scopeProjectId, overall, mention, citation };
}

// 2026-07-03: routed off the scope PUBLIC surface (client.listBrandMentions /
// listCitations) onto the same mirror read fetchProjectStandardAggregates
// already uses. Those public aggregate endpoints are currently 404ing on
// scope's side regardless of whether the project has data (confirmed via
// verify:scope + a direct probe) — every project degraded to "no data" even
// with completed runs already synced into scope_* locally. The mirror path
// is what the project 현황 KPI tab reads and is already populated by the
// sync-mirror cron, so this fixes the symptom without depending on scope's
// broken endpoint.
// 예산 있음(PR③). 프로젝트 언급은 **JS 경로**("all")라 프로파일이 따로다 — 지배 비용이
// 서버 실행이 아니라 **행 전송**이고(실측: 최장 문장 exec 1.5 s / 왕복 47 s, 답변 201,806건
// 짜리 루트 프로젝트), 전송은 어떤 상한으로도 못 끊는다. 그래서 벽시계를 크게 잡아
// "정상 경로는 자르지 않고 120 s 절단만 막는" 안전망으로 쓴다(`kpi-tab-budget` 표 ⚠️).
const cachedProjectMentions = mirrorCache("project-mentions",
  (scopeProjectId: string, filters: StandardFilters) =>
    aggregateMentionsFromMirror(filters, scopeProjectId, "all", mirrorHeavyBudget("mentionsJs")));

const cachedProjectCitations = mirrorCache("project-citations",
  (scopeProjectId: string, filters: StandardFilters, ownedBasePrefixes: string[]) =>
    aggregateCitationsFromMirror(filters, scopeProjectId, ownedBasePrefixes, undefined, false,
      mirrorHeavyBudget("citationsWide")));

export async function fetchProjectMentions(
  localProjectId: string,
  filters: StandardFilters = {},
): Promise<MentionsLive | null> {
  // 0070 갭 슬롯 + 격자 — `fetchProjectTrend` 와 **같은 자세**다(표면 null = 원장의
  // website·project 를 가리지 않고 그 프로젝트의 숨긴 회차만). 같은 화면
  // (/analysis/mention)의 추이만 갭을 그리고 주별 상위 브랜드는 안 그리면 두 차트가
  // 다른 축이 된다.
  //
  // ⚠️ 헬퍼가 **`withProject` 안**에 있다(검증 B1 수리, 2026-09-20). 읽기 전에 자리
  //    목록을 세워야 하는데, 그것을 `withProject` 밖에서 하면 **`enforce` 전에 원장을
  //    읽는다** — 경계 ①(인가 먼저)을 깨므로 안쪽에 둔다. 스코프 id 도 여기서 이미
  //    풀려 있어 `gapProjectIds` 재조회가 사라진다. "빈 결과면 갭 스코프를 다시 풀지
  //    않는다" 는 종전 보호는 헬퍼의 `if (!result) return result` 가 그대로 이어받는다.
  // 제외 엔티티: 표준 언급과 같은 표시 필터(`filterMentionsLive`).
  return withExcludedBrands(await degradeAware("projectMentions", () =>
    withProject(
      "projectMentions",
      localProjectId,
      null as MentionsLive | null,
      (scopeProjectId, scoped) =>
        withWeeklyTrendGrid({
          surface: null,
          gridSurface: "project",
          projectIds: [scopeProjectId],
          family: "mention",
          filters: scoped,
          read: (f) => cachedProjectMentions(scopeProjectId, f),
        }),
      filters,
    ),
  ), filterMentionsLive);
}

// 이 프로젝트가 기간(filters.dateFrom/dateTo) 안에 답변을 수집한 엔진 —
// /analysis/{mention,citation} 의 engine 필터 옵션(engineOptions). 게이트·기간
// 정규화는 다른 프로젝트 읽기와 동일(withProject). 미러 없으면 [].
export async function fetchProjectMeasuredEngines(
  localProjectId: string,
  filters: StandardFilters = {},
): Promise<string[]> {
  return withProject(
    "projectMeasuredEngines",
    localProjectId,
    [],
    (scopeProjectId, f) => listMeasuredEngines([scopeProjectId], f),
    filters,
  );
}

export async function fetchProjectCitations(
  localProjectId: string,
  filters: StandardFilters = {},
): Promise<CitationsLive | null> {
  return degradeAware("projectCitations", async () => {
    // 공식(당사) 판정을 대시보드 KPI ⑤ 와 같은 프로젝트 사슬로 — 타일·owned 배지·
    // promptSplit 이 KPI ⑤ 분자와 동일 판정이 된다 (2026-08-05, 종전엔 전사
    // 카탈로그라 Hyundai 프로젝트에 kia.com 이 "공식"으로 계상됐다).
    const project = await cachedProjectById(localProjectId);
    const ownedBasePrefixes = await ownedBasePrefixesForProject(project);
    // 0070 갭 슬롯 + 격자 — `fetchProjectMentions`·`fetchProjectTrend` 와 같은 자세.
    return withProject(
      "projectCitations",
      localProjectId,
      null as CitationsLive | null,
      (scopeProjectId, scoped) =>
        withWeeklyTrendGrid({
          surface: null,
          gridSurface: "project",
          projectIds: [scopeProjectId],
          family: "citation",
          filters: scoped,
          read: (f) => cachedProjectCitations(scopeProjectId, f, ownedBasePrefixes),
        }),
      filters,
    );
  });
}

// --- Standard (표준) enterprise dashboard ---

// Filter-combo caching (서버 공유). The mirror aggregations run a DB GROUP BY;
// distinct filter combos are few (KR×ChatGPT×evaluation, …), so we memoize each
// in the Next Data Cache keyed by the filter set. On Vercel that cache is shared
// across instances + persistent — a Redis-like, server-wide cache with no extra
// infra — so a repeated filter combo skips the DB after the first hit. Auth +
// per-user audit (enforce) stay OUTSIDE the cache. The mirror sync busts every
// entry via revalidateTag(MIRROR_AGGREGATE_TAG) so fresh data shows immediately.
export const MIRROR_AGGREGATE_TAG = "mirror-aggregates";
// 사실표(summary_*) 읽기 캐시 태그. 지금 사실표 캐시 셀은 전부 `mirrorCache` 로 감싸 있어
// MIRROR_AGGREGATE_TAG 로도 함께 무효화되지만, 생성 러너의 무효화 계약(내부 라우트
// `/api/internal/summary/published`)이 "미러"가 아니라 "사실표"를 가리키게 하려고 별도 이름을
// 둔다 — 나중에 사실표 캐시를 미러와 분리해도 러너 쪽 계약이 그대로 유지된다.
export const SUMMARY_TAG = "summary-aggregates";
// seconds — 안전망일 뿐, 실제 무효화는 미러 싱크의 revalidateTag 다. 2026-09-06 에
// 30분→2시간으로 늘렸다: 커넥션 풀러(Supavisor 6543)가 CONNECTION_CLOSED 를 뿌린 사고
// (프로덕션 /ko/website, 로그 104건 전부 같은 원인)의 완충 — TTL 이 길수록 DB 왕복이
// 줄어 동시 커넥션 압력이 낮아진다. 신선도는 싱크 태그가 책임지므로 손해가 없다.
export const MIRROR_CACHE_TTL = 7200;

// Lazily build the unstable_cache wrapper on first call, not at module load.
// Some tests replace next/cache with a partial mock (only revalidatePath), so
// calling unstable_cache at import time would crash any test that transitively
// imports this gateway. The wrapper is still created once (memoized).
function lazyCache<A extends unknown[], R>(
  factory: () => (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let fn: ((...args: A) => Promise<R>) | null = null;
  return (...args: A) => (fn ??= factory())(...args);
}

// ── 글로벌 ⑤ 분자: 공식(HMG) 그룹 키 목록 (제품 책임자 2026-09-29) ─────────────────────
//
// ⑤ "AI 인용 점유율" 의 글로벌 분자 = 출처 카테고리 `Official (HMG)` 인용 수. 분류는 JS
// (`lib/kpi/official-hmg-citations.ts` — 인용 탭 카테고리 차트와 같은 함수·오버라이드)이고,
// SQL 은 여기서 고른 키 목록에 대해 `= ANY($keys)` 만 본다(두 번째 분류 어휘를 만들지 않는다).
//
// 목록은 **필터와 무관한 상위집합**이다 — 그 집합이 읽을 수 있는 group_key 전수를 분류한다.
// 그래서 필터 조합마다 다시 세지 않고 한 셀을 나눠 쓴다. 반환은 문자열 배열(직렬화 가능 —
// `unstable_cache` 셀 규약, Map 금지).
//
// 무효화:
//   · 사실표(집계층·세부층) 목록 — 키가 **회차 집합(`cycleKey`)** 이라 새 세대는 새 셀이다.
//     접기 백필처럼 같은 세대가 바뀌는 경우는 `SUMMARY_TAG`(발행 무효화 계약)가 죽인다.
//     미러 태그는 **달지 않는다** — 사실표 목록은 미러 싱크로 바뀌지 않는데, 달면 싱크마다
//     목록을 다시 세서(콜드 +0.2~1.8 s) Overview 첫 로드가 느려진다.
//   · 미러 목록 — 미러 데이터가 바뀌면 후보가 바뀌므로 미러 태그(`mirrorCache` 기본)를 단다.
//   · 둘 다 `CITATION_OVERRIDES_TAG` — 운영자 오버라이드 저장 즉시 분류가 바뀐다.
const cachedOfficialHmgKeysForSet = lazyCache(() =>
  unstable_cache(
    async (_cycleKey: string, set: CycleSet): Promise<string[]> => {
      const [universe, overrides] = await Promise.all([
        readSummaryGroupKeyUniverse(set),
        loadCitationOverrides(),
      ]);
      return officialHmgGroupKeys(universe, overrides);
    },
    [MIRROR_CACHE_GENERATION, "summary-global-official-hmg-keys"],
    { revalidate: MIRROR_CACHE_TTL, tags: [SUMMARY_TAG, CITATION_OVERRIDES_TAG] },
  ),
);

/**
 * 사실표 경로의 공식(HMG) 키 목록. 키 = 인용 계열이 읽는 회차 쌍만(필터·모드·주 목록 등
 * 다른 필드가 달라도 같은 회차면 같은 셀).
 */
async function officialHmgKeysForSet(set: CycleSet): Promise<string[]> {
  const cycles = citationCyclesOf(set);
  const key = cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(",");
  const slim: CycleSet = {
    surface: set.surface,
    mode: set.mode,
    cycles: [...cycles].sort((a, b) => (a.cycleId < b.cycleId ? -1 : a.cycleId > b.cycleId ? 1 : 0)),
    cycleKey: key,
    projectIds: [...set.projectIds].sort(),
    missingProjectIds: [],
    weeks: [],
    anchorCount: 0,
  };
  return cachedOfficialHmgKeysForSet(key, slim);
}

/** 미러 폴백 경로의 공식(HMG) 키 목록 — 미러 인용 그룹 키 전수를 분류한다. */
const cachedOfficialHmgKeysMirror = mirrorCache("mirror-official-hmg-keys",
  async (): Promise<string[]> => {
    const [universe, overrides] = await Promise.all([
      readMirrorCitationKeyUniverse(),
      loadCitationOverrides(),
    ]);
    return officialHmgGroupKeys(universe, overrides);
  },
  [CITATION_OVERRIDES_TAG]);

async function ownedBasePrefixesForProject(
  project: Awaited<ReturnType<typeof projectRepository.getById>>,
) : Promise<string[]> {
  if (!project) return GEO_OWNED_BASE_PREFIXES;
  // 프로젝트 brand×country 의 공식 사이트 루트(카탈로그, 언어별 복수 가능)는
  // 설정 베이스와 **합류**한다 — 폴백이 아니다. 뉴스룸처럼 설정 베이스가 좁은
  // 프로젝트에서 공식 사이트(www.genesis.com/kr/ko/…) 인용이 전부 미인용으로
  // 떨어지던 것의 수정 (2026-08-07 고객 피드백 #5 결정: 브랜드·국가·언어
  // 사이트 루트가 항상 owned 베이스가 되도록).
  const catalog =
    project.brand && project.country
      ? GEO_OWNED_BASES.filter(
          (e) => e.brand === project.brand && geoCountryCode(e.country) === project.country,
        ).map((e) => e.prefix)
      : [];
  const configured = (await listProjectOwnedBases(project.id))
    .map((row) => ownedBasePrefixFromUrl(row.baseUrl))
    .filter(Boolean);
  // 설정 베이스가 없을 때만 project.domain 을 대신 쓴다 (기존 사슬 유지).
  const explicit =
    configured.length === 0 ? [ownedBasePrefixFromUrl(project.domain)].filter(Boolean) : [];
  return [...new Set([...configured, ...explicit, ...catalog])];
}

// 미러 캐시 세대 — 2026-08-29 부터 **소스 파생**이다. 수동 세대("mirror-v2/3/4")
// 시절의 규칙("집계 의미가 바뀌면 세대를 올려라")은 주석만으로는 안 지켜졌다 —
// 2026-08-29 하루에 두 번 실증: #113(tracked 판정·순위 산식·NER 제외)과
// #114(인용 그룹 키 확장) 모두 세대 없이 머지됐고, #113 은 뒤에 온 #116(v3→v4,
// 그것도 틀린 캐시 가설로 나온 상향)이 우연히 덮어줬을 뿐이다.
//
// 판별 기준(코드에서 도출): stale 셀이 틀린 답이 되는 경우 = **래핑된 화살표가
// 호출하는 하류 코드가 같은 입력에 다른 출력을 내게 된 변경**. 나머지 세 축은
// 이미 자동으로 키가 갈린다 —
//   · 미러 데이터 변경 → sync 가 revalidateTag(MIRROR_AGGREGATE_TAG) 로 전면 무효화
//   · 필터/인자 변경 → JSON.stringify(args) 가 invocationKey 에 포함
//   · 화살표 자신의 텍스트 → unstable_cache 가 cb.toString() 을 fixedKey 에 포함
// 남는 사각이 "하류 모듈"이고, 그걸 MIRROR_CACHE_SOURCE_HASH 가 커버한다:
// next.config.ts 가 빌드 시 lib/scope/server.ts 의 리포 내 임포트 클로저(집계
// SQL·분류 사전·그룹 키·브랜드 판정 전부 포함)를 해시해 주입한다. 집계 표면을
// 건드린 배포는 사람이 아무것도 안 해도 전 미러 캐시를 1회 무효화한다.
// (기계: scripts/mirror-cache-generation.mjs · 가드: mirror-cache-generation.test.ts)
//
// 과잉 무효화(주석만 고쳐도 무효화)는 의도된 트레이드오프다 — cold 비용은 필터
// 콤보당 GROUP BY 1회로, TTL(30분) 만료·sync 태그 무효화 때마다 이미 내는 값이다.
// 무효화를 놓치는 비용은 고객 대시보드의 틀린 숫자다.
//
// BASE 를 수동으로 올릴 일은 이제 해시 사각지대뿐이다: 리포 밖 의존성(npm 패키지)
// 의 의미 변경, 또는 코드 무변경으로 캐시된 값의 의미가 바뀌는 예외적 상황.
// (세대 이력: v2 2026-07-29 우호도 정렬 구조 변경 · v3 2026-08-07 Wiki 카테고리
//  · v4 2026-08-29 #114 소셜 그룹 키 — 상세는 git log -L 로.)
// v5 2026-09-29 — 글로벌 ⑤ 분자를 공식(HMG) 카테고리로 바꿨다(제품 결정). 소스 해시도 이 변경을
// 잡지만, 값의 **정의**가 바뀐 것이라 사람이 읽을 수 있는 세대로도 올려 둔다(옛 셀 차단).
const MIRROR_CACHE_BASE_GENERATION = "mirror-v5";
const MIRROR_CACHE_GENERATION = `${MIRROR_CACHE_BASE_GENERATION}-${
  // 빌드/`next dev` 에선 next.config.ts 가 항상 주입(인라인)한다. 이 폴백은
  // next.config 를 안 태우는 러너(vitest)에서만 밟힌다 — 프로덕션 경로 아님.
  process.env.MIRROR_CACHE_SOURCE_HASH ?? "src-unhashed"
}`;

// 요청당 1개의 공유 답변셋 스토어. React `cache()` 는 인자 0개라 참조 동일성
// 문제가 없고(lib/request-dedupe.ts 머리 주석), 이 호출은 게이트웨이 —
// `unstable_cache` **바깥** — 에서만 일어난다.
const snapshotAnswerSetStore = cache(createSnapshotAnswerSetStore);

// Wraps a mirror aggregate fn in lazyCache + unstable_cache with shared TTL/tag.
// Preserves lazyCache so tests that mock only revalidatePath don't crash at import.
//
// `extraTags` — 이 셀에만 추가로 다는 무효화 태그. 사실표(summary_*) 셀은 여기에
// `SUMMARY_TAG` 를 달아, 생성 러너의 무효화 계약(`/api/internal/summary/published`)이
// **미러 태그를 경유하지 않고 직접** 그 셀들을 죽인다. 종전에는 사실표 셀도 미러 태그
// 하나만 달고 있어서, 러너가 `SUMMARY_TAG` 를 revalidate 해도 실제로 죽는 셀이 0개였다
// (지금은 미러 태그가 함께 죽어 결과적으로 동작했을 뿐 — 계약이 배선돼 있지 않았다).
// 태그는 캐시 키에 들어가지 않으므로 셀의 저장 위치·기존 엔트리에 영향이 없다.
function mirrorCache<A extends unknown[], R>(
  key: string,
  fn: (...args: A) => Promise<R>,
  extraTags: readonly string[] = [],
  // 셀별 TTL. 미지정이면 공통 `MIRROR_CACHE_TTL`. 값이 **시계**로 바뀌는데 축 off 에서는
  // 키에 회차 정체성이 없는 셀만 낮춘다(`cachedPeriodCompare` 주석이 근거). 축 on 셀은
  // 아래 회차 조각이 그 몫을 한다.
  revalidate?: number,
  // 이 셀의 **값이 website 자사 판정 단위에 의존하는가**(화면 키 `X.websiteOwnedUnit`).
  // 축·격자와 같은 이유로 키에 실어야 한다 — 키를 켠 직후 최대 TTL(2시간) 동안 카드는
  // 유닛, 옆 타일은 flat 인 상태가 만들어진다. 축·격자와 달리 **옵트인**인 이유: 이 판정은
  // website 표면에서만 값을 바꾸는데, 전 셀에 슬롯을 붙이면 글로벌·프로젝트 셀까지
  // 토글 때마다 콜드가 된다(값은 그대로인데 비용만 낸다).
  ownedUnitAware = false,
): (...args: A) => Promise<R> {
  // ⚠️ 기본값을 **파라미터 기본식(`= MIRROR_CACHE_TTL`)으로 쓰면 안 된다** — `mirrorCache(...)`
  //    호출이 모듈 최상위에서 일어나고 상수가 그 위에 있어도, 셀별 TTL 상수는 이 함수
  //    **아래**에 선언되므로 기본식이 TDZ 로 죽는다(mom 브랜치 실측). lazy 팩토리 안에서 푼다.
  const base = lazyCache(() =>
    unstable_cache(fn, [MIRROR_CACHE_GENERATION, key], {
      revalidate: revalidate ?? MIRROR_CACHE_TTL,
      tags: [MIRROR_AGGREGATE_TAG, ...extraTags],
    }),
  );
  // ── 앵커 축 전용 셀 (검증 W5) ─────────────────────────────────────────────
  //
  // 이 셀들의 **내용**은 축에 따라 달라지는데(리더가 안에서 `ensureAnchorAxis()` 를 본다)
  // 키에는 축이 없었다. `MIRROR_CACHE_GENERATION` 은 소스 해시라 화면 키 토글로는 안
  // 바뀐다 — 그래서 축을 켠 직후 최대 TTL(7,200초 = 2시간) 동안 **카드는 옛 축, 증감
  // 칩과 달력은 새 축**일 수 있었다. 프리뷰에서 "켰는데 숫자가 안 바뀐다" 로 오판하기
  // 딱 좋은 형태다(기간 비교 셀은 이미 축을 키에 담는다).
  //
  // ⚠️ 축 off 의 키는 **한 글자도 바뀌면 안 된다**. 그래서 `false` 를 키에 싣지 않고
  //    켜졌을 때만 **다른 셀**(고정 키 조각 하나 추가)로 라우팅한다. 인자 배열은 양쪽이
  //    같으므로 off 셀의 호출 키는 종전과 동일하다.
  //
  // ── 축 on 셀에는 **회차 지문**이 붙는다 (2026-09-27) ─────────────────────────
  //
  // 축 on 셀의 값은 "지금 노출되는 회차"(앵커 표·원장·시계)에 의존하는데, 키에는 그것이
  // 없었다. 무효화가 미러 싱크의 `revalidateTag` 뿐이라 앵커 수동 적재·시계의 노출일
  // 통과·숨김 스크립트가 TTL(2시간) 동안 가려졌다 — 2026-09-27 프리뷰에서 라벨은 9/25,
  // 카드 17개는 9/18 이었다(`lib/period/cycle-fingerprint.ts` 머리 주석).
  // 그래서 축 조각 바로 뒤에 `ensureCycleCacheSlot(모드)` 조각을 싣는다. 모드는 셀 이름으로
  // 정해진다(`mirror-cache-cycle-mode.ts`): 일반 셀 `cycle:<16hex>`(앵커 축 게이트 입력만),
  // `period-compare` 는 `cycle-l:<16hex>`(원장 status·세대까지), `summary-*` 는 조각 없음
  // (키 첫 인자에 이미 회차 집합 키가 있다). 지문은 벽시계 5분 경계에 정렬돼 경계마다 한 번만
  // 넘어간다. 판정 실패면 직전 칸 지문을 이번 칸 끝까지 쓰고, 그것도 없으면 5분 버킷 조각
  // (`cycle-unknown:<버킷>`)이다.
  //
  // 키 모양(축 on): `[세대, key, "anchor-axis", (회차조각), (격자조각), ("owned-unit")]`.
  // 축 off 는 `[세대, key]`·`[세대, key, "owned-unit"]` 그대로다(지문을 묻지도 않는다).
  // 태그는 모든 래퍼가 `[MIRROR_AGGREGATE_TAG, ...extraTags]` 로 같다 — 사실표 셀의
  // `SUMMARY_TAG` 는 축 on 에서도 살아 있어야 발행 무효화가 닿는다.
  //
  // 셀 래퍼는 조각 조합마다 하나다. 지문·버킷이 바뀔 때마다 새 조합이 생기므로
  // 상한을 넘으면 비운다(래퍼는 가볍고, 저장된 캐시 엔트리와는 무관하다).
  const slotCells = new Map<string, (...args: A) => Promise<R>>();
  const slotCell = (parts: readonly string[]): ((...args: A) => Promise<R>) => {
    const k = parts.join("|");
    let cell = slotCells.get(k);
    if (!cell) {
      if (slotCells.size >= MIRROR_SLOT_CELL_CAP) slotCells.clear();
      cell = unstable_cache(fn, [MIRROR_CACHE_GENERATION, key, ...parts], {
        revalidate: revalidate ?? MIRROR_CACHE_TTL,
        tags: [MIRROR_AGGREGATE_TAG, ...extraTags],
      });
      slotCells.set(k, cell);
    }
    return cell;
  };
  // 격자 셀 — **축 셀 위에 한 조각 더**다(격자는 축이 켜져 있을 때만 켜진다).
  //
  // 왜 필요한가(통합 검증 W1): PR④ 로 **미러 SQL 이 격자 판정에 의존**하게 됐다
  // (`trendAlignedRootPreds`·`trendMirrorJoins`·`trendFloorDays`). 그런데 키에는 격자가
  // 없어 같은 인자가 두 의미를 가졌다. 1차 수리는 `dateFrom = S0` 가 인자에 실리는 것에
  // 기댔는데 그것은 **플래그의 대리 변수**라 구멍이 둘 남았다:
  //   ① 일 버킷 추이 셀은 `trendSlotsFor` 가 `null` 이라 `dateFrom` 이 안 실린다.
  //      그런데 술어는 여전히 격자로 켜진다 → **키는 같은데 값이 다르다.**
  //   ② 사용자가 고른 `dateFrom` 이 우연히 `S0` 와 같으면 격자 off 셀과 키가 충돌한다.
  // 판정을 키에 **명시**하면 둘 다 닫힌다.
  //
  // ⚠️ 축과 같은 규율: **켜졌을 때만** 조각을 붙인다. 격자 off 의 키는 한 글자도 안 바뀐다
  //    (인자 배열은 세 경로가 같으므로 off 셀의 호출 키는 종전과 동일하다).
  //
  // ⚠️ **슬롯에 목록 해시를 싣는다**(2026-09-20 독립 검증 A2-1). 초판은 고정 문자열이라
  //    카탈로그 전 회차 목록이 키에 없었다 — 목록이 달랐던 시점에 계산된 셀이 TTL 동안
  //    그대로 서빙되고, 판정이 한 번 실패한 30초 안에 콜드 셀 하나가 **6월이 닫힌 채**
  //    굳는다. 해시를 실으면 목록이 바뀐 순간 셀이 갈려 그 상태가 만들어지지 않는다.
  //    목록이 비면 조각은 종전과 **같은 문자열**이다(빈 목록 = 종전 게이트 = 종전 값).
  //
  // 축 on 조각 = 축 고정 조각 + (회차 조각). 축을 먼저 확정하고(회차 지문은 축이 켜졌을
  // 때만 묻는다 = 축 off 면 DB 왕복 0), 그 뒤 회차 조각과 격자 판정은 **병렬로** 확정한다
  // (검증 C3 — 메모 만료가 겹칠 때 직렬 await 로 지연이 쌓이지 않게).
  const cycleMode = mirrorCycleModeOf(key);
  const axisOn = async (): Promise<{ axis: string[]; grid: boolean }> => {
    const [cycle, grid] = await Promise.all([
      cycleMode === "none" ? Promise.resolve(null) : ensureCycleCacheSlot(cycleMode),
      ensureTrendGrid(),
    ]);
    return { axis: cycle ? [ANCHOR_AXIS_CACHE_SLOT, cycle] : [ANCHOR_AXIS_CACHE_SLOT], grid };
  };
  // 축·격자 판정은 리더가 이미 보는 그 상태다(30초 메모, 꺼져 있으면 DB 왕복 0).
  // 격자는 축을 선행 조건으로 두므로(`trend-grid-flag.ts`) 축이 꺼지면 묻지 않는다.
  const routed = async (...args: A): Promise<R> => {
    if (!(await ensureAnchorAxis())) return base(...args);
    const { axis, grid } = await axisOn();
    return slotCell(grid ? [...axis, trendGridCacheSlot()] : axis)(...args);
  };
  // ── 유닛 단위 자사 판정 셀 (2026-09-20, 화면 키 `X.websiteOwnedUnit`) ──────
  //
  // 위 세 셀 **위에 한 조각 더**다. 축·격자와 같은 규율을 그대로 따른다:
  //   · 키가 꺼져 있으면 슬롯을 **아예 붙이지 않는다** → off 셀의 키는 한 글자도 안 바뀐다.
  //   · 켜져 있으면 축·격자 조합과 무관하게 항상 마지막 조각으로 붙는다.
  // 축 off 의 유닛 셀(`[세대, key, "owned-unit"]`)은 종전 그대로다.
  const unitRouted = async (...args: A): Promise<R> => {
    if (!(await ensureAnchorAxis())) return slotCell([WEBSITE_OWNED_UNIT_CACHE_SLOT])(...args);
    const { axis, grid } = await axisOn();
    return slotCell(
      grid
        ? [...axis, trendGridCacheSlot(), WEBSITE_OWNED_UNIT_CACHE_SLOT]
        : [...axis, WEBSITE_OWNED_UNIT_CACHE_SLOT],
    )(...args);
  };
  // 판정은 리더가 보는 그 상태다(30초 메모). 옵트인 셀이 아니면 묻지도 않는다.
  const entry = async (...args: A): Promise<R> =>
    ownedUnitAware && (await ensureWebsiteOwnedUnit()) ? unitRouted(...args) : routed(...args);

  // T18 캐시 우회 프로브(lib/perf/nocache-probe.ts). 시크릿 헤더가 맞는 요청에서만
  // 요청별 솔트를 키에 섞어 **지나간다** — 캐시를 지우지 않으므로 다른 사용자의
  // 셀은 그대로다. 게이트가 닫혀 있으면(= 사실상 모든 트래픽) 위 라우팅을 그대로
  // 부르므로 축 off 의 키·TTL·태그가 종전과 완전히 같다.
  return withNoCacheSalt(entry, (salt) =>
    unstable_cache(fn, [MIRROR_CACHE_GENERATION, key, salt], {
      revalidate: PERF_PROBE_CACHE_TTL,
      tags: [MIRROR_AGGREGATE_TAG, ...extraTags],
    }),
  );
}

/**
 * 테스트 전용 — `mirrorCache` 를 그대로 노출한다(라우팅·키·태그를 공개 페처 없이 관찰).
 * 런타임 호출부는 없다.
 */
export const mirrorCacheForTests = mirrorCache;

/**
 * `mirrorCache` 한 셀이 들고 있는 조각 조합별 래퍼 수의 상한. 조합은 (회차 조각 ×
 * 격자 조각 × 유닛 on/off)라 평소 한 자릿수이고, 지문이 바뀌거나 판정 실패 버킷이
 * 넘어갈 때만 늘어난다. 넘으면 비운다 — 래퍼는 `unstable_cache` 호출 한 번이면 다시
 * 생기고, 저장된 캐시 엔트리와 무관하다.
 */
const MIRROR_SLOT_CELL_CAP = 32;

/**
 * 앵커 축 셀의 고정 키 조각. 축이 **켜졌을 때만** 붙는다 — 끄면 종전 셀 그대로다.
 * 값이 바뀌면 전 미러 셀이 1회 미스가 되므로 함부로 고치지 않는다.
 */
const ANCHOR_AXIS_CACHE_SLOT = "anchor-axis" as const;

/**
 * 격자 셀의 고정 키 조각. 격자가 **켜졌을 때만** 붙는다 — 끄면 축 셀(또는 종전 셀)
 * 그대로다. 값이 바뀌면 격자 on 의 전 미러 셀이 1회 미스가 된다.
 */
const TREND_GRID_CACHE_SLOT = "trend-grid" as const;

/**
 * 유닛 단위 자사 판정 셀의 고정 키 조각. **켜졌을 때만** 붙는다 — 끄면 축·격자 셀(또는
 * 종전 셀) 그대로다. 값이 바뀌면 키 on 의 전 미러 셀이 1회 미스가 된다.
 */
const WEBSITE_OWNED_UNIT_CACHE_SLOT = "owned-unit" as const;

/**
 * 격자 셀의 키 조각 — 고정 문자열 + **카탈로그 전 회차 목록의 안정 해시**.
 *
 * 목록이 비면 `"trend-grid"` 그대로다(종전 셀과 키가 같다 = 1회 미스도 없다).
 * 목록이 있으면 `"trend-grid:<sha1 앞 8자>"` 라, 목록이 바뀌면 셀이 갈린다.
 * 정렬 후 해시하므로 순서가 달라도 같은 키다.
 */
function trendGridCacheSlot(): string {
  const h = preCatalogCacheSlot();
  return h ? `${TREND_GRID_CACHE_SLOT}:${h}` : TREND_GRID_CACHE_SLOT;
}

// 명부(entity_registry) 로드: 자사(own) = 모든 미러/퍼블릭 읽기의 당사 판정 입력,
// 제외(excluded) = 순위·목록 표시 필터 입력(2026-09-30). 두 역할을 **한 문장·한 셀**로
// 읽는다(추가 왕복 없음). 캐시(mirror TTL/tag 공유)로 요청마다 DB를 안 때린다: admin
// 명부 저장 액션이 `MIRROR_AGGREGATE_TAG` 를 무효화하므로 다음 요청에 새 명부가 보인다.
// 셀 값은 배열 두 개뿐인 객체다(직렬화 가능: Map·Set 금지). 키를 "entity-roster" 에서
// 바꾼 이유: 종전 셀은 배열을 담고 있어, 같은 키로 새 모양을 읽으면 배포 직후 HIT 가
// 옛 모양을 돌려준다.
// 명부가 비거나 테이블 미적용(migration 0023 전)이면 own=undefined → 판정부가
// hmg-brands 시드 폴백, 제외 = 빈 목록(필터 무동작).
const cachedEntityRoster = mirrorCache("entity-roster-v2", async () => {
  const roster = await entityRegistryRepository.listRoster();
  return { own: roster.own, excludedNames: excludedBrandNames(roster.excluded) };
});
async function ownEntitiesForJudgment(): Promise<
  { id: string; name: string }[] | undefined
> {
  try {
    const rows = (await cachedEntityRoster()).own;
    return rows.length ? rows : undefined;
  } catch {
    return undefined; // 테이블 없음/DB 오류 → 시드 폴백 (판정은 계속 동작)
  }
}

/**
 * 제외 엔티티 표시명 집합: **표시 전용**(순위·목록·경쟁사 선정). KPI 값은 건드리지
 * 않는다(`lib/scope/excluded-brands.ts`). 명부 셀을 자사 판정과 공유한다.
 * 실패하면 빈 집합(= 종전 화면 그대로): 제외 필터는 화면을 깨뜨릴 이유가 없다.
 */
async function excludedBrandsForDisplay(): Promise<ExcludedBrandSet> {
  try {
    return toExcludedBrandSet((await cachedEntityRoster()).excludedNames ?? []);
  } catch {
    return toExcludedBrandSet([]);
  }
}

/** 값이 있으면 제외 필터를 건다. 집합이 비면 입력을 그대로 돌려준다(종전 동작 동일). */
async function withExcludedBrands<T>(
  value: T,
  apply: (v: NonNullable<T>, ex: ExcludedBrandSet) => NonNullable<T>,
): Promise<T> {
  // 빈 값(null·빈 배열 = 인가 실패·degrade·데이터 없음)이면 명부도 읽지 않는다.
  if (value == null || (Array.isArray(value) && value.length === 0)) return value;
  const ex = await excludedBrandsForDisplay();
  return ex.size === 0 ? value : apply(value as NonNullable<T>, ex);
}

// Common flow for every standard (root project) mirror read:
//   enforce → resolve root id → null-guard → assertProjectInScope → cached fn.
async function withStandardRoot<T>(
  action: string,
  empty: T,
  fn: (filters: StandardFilters) => Promise<T>,
  filters: StandardFilters,
): Promise<T> {
  await enforce(action);
  const rootId = getStandardRootId();
  if (!rootId) return empty;
  await assertProjectInScope(action, rootId);
  const ownEntities = await ownEntitiesForJudgment();
  // 요청단위 공유 답변셋 스코프 (2026-09-03) — 이 요청의 표준 스냅샷 읽기들이
  // 같은 W 의 답변셋을 1회만 확정하고 job_id 목록으로 나눠 쓴다. 스토어는 React
  // 요청 캐시(= 요청당 1개)에서 오고, 스코프는 `unstable_cache` 콜백 안쪽까지
  // ALS 로 전파된다 — 계산 자체는 콜백 안(캐시 미스)에서만 일어나므로 캐시
  // 적중 경로에는 비용이 0 이다. 정본: scope-aggregates.ts snapshotAnswerWhere.
  return withSnapshotAnswerSetScope(snapshotAnswerSetStore(), () =>
    fn(normalizeFilters({ ...filters, ownEntities })),
  );
}

// Common flow for every per-project mirror read:
//   enforce → resolve scope project id → null-guard → cached fn.
// 당사 판정 단위 컨텍스트 (2026-07-03 통일 규칙): 프로젝트 단위의 당사 =
// project.brand — 여기서 contextBrand로 주입해 모든 프로젝트 미러 읽기
// (aggregates/subKPI/trend/topics/sourceComposition)가 같은 규칙을 탄다.
// 클라이언트가 보낸 filters에 실려 와도 서버 값으로 덮어쓴다 (신뢰 금지).
async function withProject<T>(
  action: string,
  localProjectId: string,
  empty: T,
  fn: (scopeProjectId: string, filters: StandardFilters) => Promise<T>,
  filters: StandardFilters,
): Promise<T> {
  await enforce(action);
  await assertProjectInScope(action, localProjectId);
  const scopeProjectId = await resolveScopeProjectId(localProjectId);
  if (!scopeProjectId) return empty;
  const project = await cachedProjectById(localProjectId);
  const contextBrand = project?.brand ? [project.brand] : undefined;
  const ownEntities = await ownEntitiesForJudgment();
  // 요청단위 공유 답변셋 스코프 — withStandardRoot 와 동일(프로젝트/웹사이트 표면).
  return withSnapshotAnswerSetScope(snapshotAnswerSetStore(), () =>
    fn(scopeProjectId, normalizeFilters({ ...filters, contextBrand, ownEntities })),
  );
}

// 공식(당사) 인용 판정 베이스 — 축E(활성 brand 필터 ∩ 로스터, 언급 계열 KPI 와
// 동일 입력) 스코프의 카탈로그 베이스 (2026-08-05 통일: "전사 관점" 별도 지표
// 없음 — 무필터 hq/admin 은 3사 전체 = 종전값 그대로). filters 는 이미
// normalizeFilters 를 거쳐 캐시 키에 brand/contextBrand/ownEntities 를 담고
// 있으므로, 캐시된 람다 안에서 파생해도 필터 콤보별 캐시 셀과 정확히 일치한다.
// 프로젝트 표면은 이 헬퍼가 아니라 ownedBasePrefixesForProject(설정 owned bases
// → project.domain → brand×country 사슬)를 쓴다.
// 국가 축도 함께 넘긴다(2026-09-01) — 넘기지 않으면 `?geography=KR&brand=Kia` 처럼
// 국가를 좁힌 화면에서도 자사 베이스가 기아 전 세계 77개가 돼, 다른 나라 자사 사이트
// 인용이 그 나라 ⑤ 로 잡혔다. 표준은 region(= ISO 국가코드), website 는 websiteCountry.
const scopeOwnedPrefixes = (f: StandardFilters): string[] =>
  ownedBasePrefixesForScope(
    f.contextBrand ?? f.brand,
    f.ownEntities,
    f.websiteCountry ?? f.region,
    f.lang,
  );

// S1 카드의 **미러 폴백** — 예산 있음(2026-09-10). 게이트가 summary 경로를 거부했을 때
// 가는 길이고, 여기가 캡이 없는 마지막 경계였다(PR #235 프리뷰 `/ko/dashboard` 콜드 18건
// 중 3건 120.5 s 절단 — 절단 응답은 `dashboard:filters` 만 도착하고 `kpi-cards` 미도착).
// 실측 문장 12개·exec 16.2 s → 프로파일 `cardsMirror`(문장 10 s·경로 30 s, 최악 40 s).
const cachedStandardAggregates = mirrorCache("standard-aggregates",
  async (filters: StandardFilters) =>
    aggregateStandardFromMirror(filters, undefined, scopeOwnedPrefixes(filters),
      undefined, false, mirrorHeavyBudget("cardsMirror"), undefined,
      // 글로벌 ⑤ 분자 = 공식(HMG) 카테고리(제품 책임자 2026-09-29) — 이 셀은 글로벌 전용이다.
      await cachedOfficialHmgKeysMirror()));

// 표준 mentions는 슬림("none")으로 캐시 — perBrandPrompts(전 브랜드 드릴다운)가
// 페이로드의 99.9%(12.4MB)라 그대로 캐시하면 2MB 한도 초과로 매번 재계산됐다
// (2026-07-08). 드릴다운은 클릭 시 cachedStandardBrandMentionPrompts로 lazy.
// trendDegraded=true(추이 롤업 시간 초과)는 캐시하지 않는다 — kpi-engine-trend 와 같은
// 이유(2026-09-02: degrade 가 30분 캐시에 굳어 하단 "주별 상위 브랜드"가 준비 중으로 남았다).
// S2 의 미러 집계 — **예산 있음**(PR③). 문장 10개·warm exec 16.6 s(최장 11.2 s —
// 2026-09-17 재측정, 산정 정본은 `MIRROR_HEAVY_PROFILES.mentions`)로
// S3 다음으로 무겁다. `mirrorHeavyBudget()` 은 캐시 콜백 **안**에서 부른다(마감이 요청
// 시각 기준이어야 하고, 인자로 받으면 `Date.now()` 가 캐시 키에 섞인다).
// 예산 — warm 55.0 s 짜리라 상한이 없으면 대시보드 첫 채움 요청이 Vercel 120 s 를
// 넘긴다(PR③-a). **프로파일이 인자 = 캐시 키**다: 이 셀을 두 지면이 나눠 쓰는데 초과의
// 대가가 달라 예산도 달라야 하고(`MentionsBudgetProfile` 주석), 키에 안 넣으면 먼저
// 채운 쪽의 예산으로 만든 셀을 다른 쪽이 그대로 받는다.
//   · `extras`(15/30) 대시보드 경쟁사 행 — 빠져도 카드 본체는 그려져 있다.
//   · `screen`(25/35) S2 언급 화면 — 이 집계가 화면 본문이라 degrade = 빈 지면.
//     25 s 는 오폴백 방지값이다(최장 문장 warm exec 11.2 s × 콜드 1.7 = 19.1 s > 15 s).
// `mentionsBudgetOf()` 는 **콜백 안**에서 부른다(마감이 요청 시각 기준이어야 한다).
//
// `weekSource`(2026-09-17)도 **캐시 키**다 — 같은 필터의 셀이 주 격자 두 벌을 가질 수
// 있으므로, 키에 안 넣으면 키를 켜고 끄는 사이에 옛 격자 셀이 그대로 서빙된다.
// 값을 정하는 것은 `fetchStandardMentions` 이고 판정은 캐시 **바깥**이다(설정을 고치면
// 다음 요청부터 반영돼야 하는데, 안쪽이면 TTL 만큼 굳는다 — degrade 와 같은 규율).
const cachedStandardMentions = mirrorCache("standard-mentions",
  uncachedIfDegraded(
    (r: MentionsLive | null) => r?.trendDegraded === true,
    (filters: StandardFilters, profile: MentionsBudgetProfile, weekSource: TrendWeekSource) =>
      aggregateMentionsFromMirror(
        filters, undefined, "none", mentionsBudgetOf(profile), weekSource),
  ));

// 드릴다운 lazy — 한 브랜드의 프롬프트 목록만(그 브랜드 것만 채운 perBrandPrompts).
// 브랜드별 별도 캐시 셀이라 각각 2MB 한도 안에 든다.
const cachedStandardBrandMentionPrompts = mirrorCache("standard-brand-mention-prompts",
  async (brand: string, filters: StandardFilters): Promise<MentionsPromptLive[]> => {
    const m = await aggregateMentionsFromMirror(filters, undefined, { onlyBrand: brand });
    return m?.perBrandPrompts[brand] ?? [];
  });

// S3(표준 인용)의 미러 집계 — **예산 있음**(E-2). 문장 10개·warm 25.2 s 짜리라
// 예산이 없으면 콜드에서 Vercel 120 s 를 넘겨 HTML 이 절단됐다(T12 실측).
// `mirrorHeavyBudget()` 은 **콜백 안**에서 부른다 — 마감이 요청 시각 기준이어야 하고,
// 인자로 받으면 `Date.now()` 가 캐시 키에 섞여 셀이 매번 갈린다.
// degrade 는 캐시 **바깥**(`fetchStandardCitations` 의 `kpiDegrade`)이라, 예산에 걸린
// 요청은 예외로 빠져나가 **캐시에 저장되지 않는다** — 다음 요청이 다시 시도한다.
//
// 프로파일은 **캐시 키**다(PR④ A3, 언급 셀과 같은 규약) — S3 화면은 `screen`(15/45,
// 종전 값), 대시보드 경쟁사 행의 폴백은 `extras`(15/30). 기본값을 두지 않는 이유는
// 새 호출부가 예산을 **고르게** 강제하기 위해서다(고르지 않으면 타입이 막는다).
const cachedStandardCitations = mirrorCache("standard-citations",
  (filters: StandardFilters, profile: CitationsBudgetProfile) =>
    aggregateCitationsFromMirror(
      filters, undefined, scopeOwnedPrefixes(filters), undefined, false,
      citationsBudgetOf(profile),
    ));

// SLIM — 도넛 전용. CitationsLive 전체는 2MB 캐시 한도 초과 → 도메인 롤업만 캐시.
const cachedSourceComposition = mirrorCache("source-composition",
  (filters: StandardFilters) =>
    aggregateSourceCompositionFromMirror(filters, undefined, scopeOwnedPrefixes(filters)));

const cachedGeoCompetition = mirrorCache("geo-competition",
  (filters: StandardFilters) =>
    aggregateGeoCompetitionFromMirror(filters, undefined, mirrorHeavyBudget("cardsMirror")));

// Overview 국가별 GEO 현황(2026-09-02) — KPI 5종. 공식(당사) 인용 판정 베이스는
// 인용 집계와 같은 scopeOwnedPrefixes.
const cachedGeoKpi = mirrorCache("geo-kpi",
  async (filters: StandardFilters) =>
    aggregateGeoKpiFromMirror(filters, undefined, scopeOwnedPrefixes(filters), {
      statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
      budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
      // 국가별 ⑤ 도 카드와 같은 공식(HMG) 카테고리 분자(제품 책임자 2026-09-29). 이 셀은 글로벌 전용.
      officialGroupKeys: await cachedOfficialHmgKeysMirror(),
    }));

// 예산(PR③-a) — 대시보드가 이 셀을 **두 번** 부른다(Δ 롤업 day + 화면 추이 week).
// warm 55.6 s(주 버킷) 짜리인데 종전에는 상한이 아예 없었다.
const cachedStandardTrend = mirrorCache("standard-trend",
  async (filters: StandardFilters, unit: BucketUnit) =>
    aggregateStandardTrendFromMirror(
      filters, unit, undefined, scopeOwnedPrefixes(filters), undefined, false, mirrorExtrasBudget(),
      undefined,
      // 글로벌 ⑤ 분자 = 공식(HMG) 카테고리 — 카드 미러 셀과 같은 목록.
      await cachedOfficialHmgKeysMirror(),
    ));

const cachedSubKpis = mirrorCache("sub-kpis",
  (filters: StandardFilters) =>
    aggregateSubKpisFromMirror(filters, undefined, scopeOwnedPrefixes(filters)));

// KPI 탭 히어로 전용 — **그 탭이 읽는 파트만** 계산한다(2026-09-02).
// 파트 표와 그 근거(소비 지점 file:line)는 `./kpi-tab-budget` 의
// KPI_TAB_SUB_KPI_PARTS 가 정본. 캐시 키에 parts 가 들어가므로 전량 셀
// (`sub-kpis`)과 섞이지 않는다 — 전량 호출부는 그대로 전량을 받는다.
const cachedSubKpisParts = mirrorCache("sub-kpis-parts",
  (filters: StandardFilters, parts: readonly SubKpiPart[]) =>
    aggregateSubKpisFromMirror(filters, undefined, scopeOwnedPrefixes(filters), undefined, false, {
      parts,
    }));

// 직전 측정 스냅샷 (2026-08-07, 고객 피드백: Sub KPI 변화 추이·비교 기준 부재).
// 기간 = 기간 내 최신 배치 의미론을 그대로 이용 — 필터 창의 측정일을 최신순
// 2개 뽑아, 두 번째 날을 dateTo 로 넣고 같은 집계를 한 번 더 돌리면 "직전 측정
// 시점" 스냅샷이 나온다. 측정일이 1개뿐이면 null(비교 대상 없음 = 배지 숨김).
export interface PrevSubKpis {
  sub: StandardSubKpis;
  asOf: string; // 비교 기준 측정일 (YYYY-MM-DD) — 화면에 명시
}
async function subKpisPrevImpl(
  filters: StandardFilters,
  projectCtx: string | string[] | undefined,
  ownedBasePrefixes: string[],
  // 형제 모집단(website 선언 base) — main #164. 미지정 = 카탈로그.
  ownedSiblingUniverse?: string[],
  websiteTargetsOwned = false,
  // 미지정 = 전량(종전 동작). KPI 탭 히어로의 Δ 배지만 파트를 좁힌다.
  parts?: readonly SubKpiPart[],
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`) — **현재 값과 같은 정의**여야 한다.
  // 여기만 flat 으로 남으면 Δ 가 "유닛 현재 − flat 직전" 이 되어 전환 당일 증감이 통째로
  // 거짓이 된다(자사 판정이 함대 90.22% → 78.62% 로 움직이는 변경이다).
  ownedUnits?: readonly WebsiteOwnedUnit[],
): Promise<PrevSubKpis | null> {
  // 누적 모드(답변분석, 2026-09-04 기획 수정): 카드가 "기간 내 누적"이므로 비교
  // 기준도 누적 축 위의 점이어야 한다 — 기간 '첫 측정일까지'의 누적을 기준으로
  // 잡으면 Δ = 첫 회차 이후 기간 안에서 늘어난(줄어든) 양이 된다. 기간 내
  // 측정일이 1개뿐이면 비교 대상이 없다 → null (배지·캡션 모두 숨김).
  if (filters.cumulative) {
    const bounds = await measureDayBoundsInRange(filters, projectCtx);
    if (bounds.days < 2 || !bounds.first) return null;
    const sub = await aggregateSubKpisFromMirror(
      { ...filters, dateTo: bounds.first },
      projectCtx,
      ownedBasePrefixes,
      ownedSiblingUniverse,
      websiteTargetsOwned,
      parts ? { parts } : undefined,
      ownedUnits,
    );
    return { sub, asOf: bounds.first };
  }
  // 스냅샷 모드(대시보드·웹사이트 KPI): 기존 그대로 — 직전 측정일 스냅샷 대비.
  const days = await latestMeasureDays(filters, projectCtx);
  if (days.length < 2) return null;
  const sub = await aggregateSubKpisFromMirror(
    { ...filters, dateTo: days[1] },
    projectCtx,
    ownedBasePrefixes,
    ownedSiblingUniverse,
    websiteTargetsOwned,
    parts ? { parts } : undefined,
    ownedUnits,
  );
  return { sub, asOf: days[1] };
}
const cachedSubKpisPrev = mirrorCache("sub-kpis-prev",
  (filters: StandardFilters) =>
    subKpisPrevImpl(filters, undefined, scopeOwnedPrefixes(filters)));

const cachedSubKpisPrevParts = mirrorCache("sub-kpis-prev-parts",
  (filters: StandardFilters, parts: readonly SubKpiPart[]) =>
    subKpisPrevImpl(filters, undefined, scopeOwnedPrefixes(filters), undefined, false, parts));

const cachedPromptTopics = mirrorCache("prompt-topics",
  (filters: StandardFilters) => aggregatePromptTopicFromMirror(filters));

const cachedStandardAcr = mirrorCache("standard-acr",
  (filters: StandardFilters) => aggregateAcrFromMirror(filters));

// Every StandardFilters axis that must survive normalizeFilters so it reaches
// the SQL aggregate / in-memory gate. Derived from the single manifest in
// result-adapter.ts (STANDARD_FILTER_ARRAY_AXES) instead of a second
// hand-maintained list — brandPresence, then lang/websiteCountry, then
// sourceCategory were each silently dropped in turn (2026-07-03~07-06) because
// this list and the manifest drifted independently. Add a new axis in exactly
// one place now: STANDARD_FILTER_ARRAY_AXES.
const FILTER_AXES = STANDARD_FILTER_ARRAY_AXES;

// Normalize to only defined keys so equivalent filter sets share one cache entry
// (the filters object is part of the unstable_cache key). Each axis is sorted so
// equivalent selections produce the same cache key regardless of click order
// ([US,KR] === [KR,US]).
// export 이유: 캐시 키 동등성을 테스트가 **실제 함수로** 확인한다(소스 grep 금지,
// 2026-09-20 독립 검증 B4). 런타임 동작은 안 바뀐다.
export function normalizeFilters(filters: StandardFilters): StandardFilters {
  const norm: StandardFilters = {};
  for (const axis of FILTER_AXES) {
    const values = filters[axis];
    if (values?.length) norm[axis] = [...values].sort();
  }
  // 기간 축(스칼라) — 값 자체가 캐시 키의 일부가 되도록 정의된 것만 복사.
  if (filters.dateFrom) norm.dateFrom = filters.dateFrom;
  if (filters.dateTo) norm.dateTo = filters.dateTo;
  // 기간 의미론(스냅샷 vs 기간 내 누적) — 같은 필터라도 결과가 다르므로 반드시
  // 캐시 키에 포함한다(빠뜨리면 답변분석 누적 값이 대시보드 스냅샷 셀을 덮어쓴다).
  if (filters.cumulative) norm.cumulative = true;
  // 당사 판정 단위 컨텍스트 — withProject가 주입(project.brand). 캐시 키 포함 필수.
  if (filters.contextBrand?.length) norm.contextBrand = [...filters.contextBrand].sort();
  // 자사 명부 — 게이트웨이 주입. 명부 내용이 곧 판정이라 캐시 키에 포함되어야
  // admin이 역할을 바꿨을 때 stale 셀이 재사용되지 않는다 (id 기준 정렬).
  if (filters.ownEntities?.length) {
    norm.ownEntities = [...filters.ownEntities].sort((a, b) => a.id.localeCompare(b.id));
  }
  // 프로젝트 커스텀 필드 필터 — Record라 FILTER_AXES(string[] 전용) 루프에 안
  // 걸린다. 여기서 빠뜨리면 서로 다른 커스텀 필터 선택이 같은 캐시 항목을
  // 공유해버리는 stale-cache 버그가 난다(키 순서도 고정해 클릭 순서 무관하게
  // 같은 캐시 키가 나오도록 정렬).
  if (filters.customFieldFilters) {
    // 값 목록도 정렬해 클릭/입력 순서 무관하게 같은 캐시 키가 나오도록 한다
    // (빈 배열은 제외 — []는 truthy라 안 거르면 스며든다).
    const entries = Object.entries(filters.customFieldFilters)
      .filter(([, v]) => v && v.length > 0)
      .map(([k, v]) => [k, [...v].sort()] as const);
    if (entries.length > 0) {
      norm.customFieldFilters = Object.fromEntries(
        entries.sort(([a], [b]) => a.localeCompare(b)),
      );
    }
  }
  return norm;
}

// ── 사실표(summary_*) 경로 — 글로벌 대시보드 S1 (설계 v4.1 §8) ───────────────
//
// 웹사이트(S4) 경로와 같은 배선이다(아래 "사실표 경로 — 웹사이트 대시보드 S4"
// 블록의 쌍둥이): 게이트는 **캐시 밖**에서 돌고(§8-4 — 경로가 캐시 키의 일부라
// 캐시 안에서 판정하면 킬스위치를 내려도 hit 결과가 TTL 30분 동안 서빙된다),
// 요청 안에서 여러 위젯이 같은 필터로 게이트를 부르므로 React cache 로 접는다.
//
// 캐시는 **2층**이다(PR① R2, 2026-09-10):
//   ① 판정 셀 — 키 `{r,f}`. **화면이 들어가지 않는다.** 한 렌더가 같은 필터로
//      S1/S2/S3 세 화면 키를 부르므로, 화면을 키에 넣으면 같은 판정이 3번 돌고
//      원장·회차 프로브 왕복이 그만큼 늘어난다(A5 도입 때 들어온 회귀).
//   ② 화면 셀 — 키 `{r,f,s}`. ①의 결과에 화면 검사만 얹는다(`applyScreenGate`).
//      스위치 원문 읽기는 30초 메모라 DB 를 다시 보지 않는다. 이 층을 두는 이유는
//      로그 1줄을 화면당 1회로 유지하기 위해서다.
const cachedGlobalSummaryBase = cache(async (key: string): Promise<SummaryReadRoute> => {
  const { r, f } = JSON.parse(key) as { r: string | null; f: StandardFilters };
  return resolveGlobalSummaryRouteBase(r, f);
});
const cachedGlobalSummaryRoute = cache(async (key: string): Promise<SummaryReadRoute> => {
  const { r, f, s } = JSON.parse(key) as {
    r: string | null;
    f: StandardFilters;
    s: SummaryScreenKey;
  };
  const route = await applyScreenGate(
    await cachedGlobalSummaryBase(JSON.stringify({ r, f })),
    s,
  );
  // 헤더를 붙일 수 있는 자리가 아니라(서버 컴포넌트 read) 로그로 실증한다.
  // 값은 **후처리 결과** 기준이다(= 화면 검사까지 반영된 최종 판정).
  // 스위치가 꺼져 있는 동안(= 기본 상태)은 찍지 않는다 — 모든 요청에 같은 줄이
  // 쌓여 신호가 죽는다.
  if (!(route.path === "mirror" && route.reason === "disabled")) {
    console.info(`x-hmg-summary(global ${s}): ${summaryRouteHeaderValue(route)}`);
  }
  return route;
});
const globalSummaryRoute = (rootId: string | null, f: StandardFilters, s: SummaryScreenKey) =>
  cachedGlobalSummaryRoute(JSON.stringify({ r: rootId, f, s }));

// 캐시 셀은 미러 경로와 **완전히 분리**된다: 키 문자열이 다르고("summary-global-…"),
// 회차 id·generation id 가 인자(= invocation key)에 들어간다.
type GlobalSummaryArgs = [cycleKey: string, cycle: SummaryCyclePick, rootId: string, filters: StandardFilters];
const globalSummaryScopeOf = (
  cycle: SummaryCyclePick,
  rootProjectId: string,
  filters: StandardFilters,
) => ({
  cycle,
  rootProjectId,
  filters,
  // $sel — 미러 경로와 **같은 함수·같은 입력**(축E ∩ 국가 ∩ 언어). 사실표는
  // matched_base 를 굳혀 두었으므로 여기서는 집합 비교 대상으로만 쓰인다.
  ownedBasePrefixes: scopeOwnedPrefixes(filters),
});

// 세부층 사실표 셀(PR② 이전 경로) — **집계층만 거부됐을 때의 폴백 목적지**다
// (T11 기준 6 수리). PR② T6 은 S1 카드를 집계층 3문장으로 옮기면서 폴백도 미러로
// 보냈는데, 같은 화면의 형제 위젯(주제 도넛·GEO 경쟁)은 세부층에 남아 있어
// `?depth2=` 같은 거부 축에서 한 화면에 두 원천이 섞였다. 목적지를 되돌린다.
const cachedSummaryGlobalAggregatesDetail = mirrorCache("summary-global-aggregates-detail",
  async (...[, cycle, rootId, f]: GlobalSummaryArgs) =>
    summaryGlobalAggregates(globalSummaryScopeOf(cycle, rootId, f), mirrorHeavyBudget("detail"),
      // 글로벌 ⑤ 분자 — 집계층 경로와 **같은 목록 함수**(이 회차 하나의 group_key 전수).
      await officialHmgKeysForSet(singleCycleSet(cycle, rootId))),
  [SUMMARY_TAG]);

/** 세부층(단일 회차) 경로가 키 목록을 얻기 위한 최소 집합 — `cycleScope` 가 읽는 필드만. */
function singleCycleSet(cycle: SummaryCyclePick, rootId: string): CycleSet {
  return {
    surface: "global",
    mode: "snapshot",
    cycles: [cycle],
    cycleKey: `${cycle.cycleId}:${cycle.generationId}`,
    projectIds: [rootId],
    missingProjectIds: [],
    weeks: [cycle.cycleWeek],
    anchorCount: 1,
  };
}

const cachedSummaryGlobalSourceCompositionDetail = mirrorCache("summary-global-source-detail",
  async (...[, cycle, rootId, f]: GlobalSummaryArgs) =>
    summaryGlobalSourceComposition(globalSummaryScopeOf(cycle, rootId, f), mirrorHeavyBudget("detail")),
  [SUMMARY_TAG]);

const cachedSummaryGlobalSubKpis = mirrorCache("summary-global-subkpis",
  async (...[, cycle, rootId, f]: GlobalSummaryArgs) =>
    summaryGlobalSubKpis(globalSummaryScopeOf(cycle, rootId, f)),
  [SUMMARY_TAG]);

const cachedSummaryGlobalPromptTopics = mirrorCache("summary-global-prompt-topics",
  async (...[, cycle, rootId, f]: GlobalSummaryArgs) =>
    summaryGlobalPromptTopics(globalSummaryScopeOf(cycle, rootId, f)),
  [SUMMARY_TAG]);

// ⚠️ `summaryGlobalSourceComposition`(세부층 1문장 + job 세미조인)도 **화면에서 떼어냈다**
// (PR② T7) — 출처 도넛은 집계층 1문장(`cachedSummaryGlobalSourceCompositionTrend`)이 낸다.
// 리더 자체는 지우지 않는다: 패리티 하네스(`scripts/summary/parity-citations.ts`)의
// 기대값이고, 집계층 값이 어긋났을 때 대조할 사실표 기준선이다.

const cachedSummaryGlobalGeoCompetition = mirrorCache("summary-global-geo-competition",
  async (...[, cycle, rootId, f]: GlobalSummaryArgs) =>
    summaryGlobalGeoCompetition(globalSummaryScopeOf(cycle, rootId, f)),
  [SUMMARY_TAG]);

// 사실표 hit 이면 사실표 읽기를, 아니면 종전 미러 읽기를 그대로 부른다.
// 반환 타입이 같으므로 호출부(화면)는 경로를 모른다.
async function viaGlobalSummary<T>(
  f: StandardFilters,
  screen: SummaryScreenKey,
  onSummary: (...args: GlobalSummaryArgs) => Promise<T>,
  onMirror: () => Promise<T>,
): Promise<T> {
  const rootId = getStandardRootId();
  const route = await globalSummaryRoute(rootId, f, screen);
  if (route.path !== "summary" || !rootId) return onMirror();
  // 글로벌은 회차가 1개다(§6-1 규칙 1) — 게이트가 hit 을 냈다면 cycles[0] 가 그것이다.
  const cycle = route.cycles[0];
  if (!cycle) return onMirror();
  return onSummary(route.cycleKey, cycle, rootId, f);
}

// ── 집계층(키 그레인) 경로 — S1 대시보드 (PR② T6 · 라운드 2) ───────────────
//
// 위 `viaGlobalSummary` 와 게이트·캐시 자세가 같고, 두 가지가 더 있다:
//   ① **미지원 축 판정**(`planTrendRead`) — 집계층 키로 표현 못 하는 필터
//      (depth2/depth3 · `own_variant` 밖 admin 브랜드 다중 선택 = E4)면 미러로 돌린다.
//      게이트(`gate.ts`)의 `unsupported*FilterReason` 과 **다른 층**이다: 그쪽은
//      "사실표(세부층)로 표현 가능한가", 이쪽은 "집계층으로 표현 가능한가".
//   ② **빈 집계층 = 폴백**(플랜 §5-2) — `SummaryTrendRead.empty` 를 미러 폴백으로 바꾼다.
// 두 사유 모두 관측 로그로 남긴다(서버 컴포넌트 read 라 헤더를 붙일 자리가 없다).
//
// ── 라운드 2: **위젯 둘이 read 하나를 쓴다** ────────────────────────────────
//
// ① KPI 카드와 ④ GEO 는 서로 다른 `<Suspense>` 경계이고 페처도 다르지만, 필요한 값이
// 같은 3문장(`own`·`brands`·`domains`)의 서로 다른 grouping set 에서 나온다. 라운드 1은
// 둘이 따로 읽어 `summary_trend_brands` 를 **두 번 스캔**했다(실측 250.8 + 234.6 ms).
// 지금은 한 셀(`summary-global-trend-s1`)을 공유한다:
//   · **30분 캐시** — `mirrorCache` 키가 같아 두 페처가 같은 셀을 본다.
//   · **요청 안** — 콜드 키에서 두 페처가 동시에 미스하면 DB 를 두 번 친다. `requestS1`
//     (React `cache`, 문자열 키)이 그것을 접는다. 인자 객체는 매번 새로 만들어지므로
//     `cache` 를 인자에 직접 걸 수 없어 JSON 키를 쓴다(`cachedGlobalSummaryRoute` 와 같은 형태).

type GlobalS1Read = SummaryTrendRead<SummaryGlobalS1>;

/**
 * `$sel`·`$fbRe` 원본 — 미러·세부층 경로와 **같은 함수·같은 입력**이다.
 * 글로벌 ⑤ 분자·`is_ours` 의 정본이 `trend_domains` 의 이 술어다(리더 라운드 2).
 * 축·절단은 리포지터리 상수를 그대로 쓴다 — 카드/GEO 공용이라 한 곳에만 둔다.
 */
const globalS1ScopeOf = (
  set: CycleSet,
  ownVariant: string,
  filters: StandardFilters,
): TrendReadScope => {
  const base: TrendReadScope = {
    set,
    filters,
    ownVariant,
    ownedBasePrefixes: scopeOwnedPrefixes(filters),
    limits: S1_TREND_LIMITS,
    axes: S1_TREND_AXES,
  };
  // ── 기간 모드의 카드는 **추이와 같은 게이트**를 쓴다 (2026-09-20 제품 책임자 방침) ──
  //
  // 격자 판본은 `in_full_cycle` 하나를 뺀다(설계 §4-A). 종전에는 추이만 그랬고 카드는
  // 걸었으므로, 같은 자리에서 **카드와 추이의 분모가 달랐다** — 메인 실측 2026-08-17
  // 자리의 회차 `608a1e7b`: 인용 분모 3,602(게이트 있음) vs 18,284(격자 판본, 4.6배).
  // "카드 값 == 상세 값 == 추이의 해당 자리 값" 을 만들려면 이 한 칸이 같아야 한다.
  //
  // 판정을 **집합에서** 읽는 이유(상태가 아니라): 이 함수는 캐시 셀 **안**에서 불리고
  // 그 셀의 키에는 `set` 이 통째로 들어간다. 집합이 판정을 말하면 키와 문장이 항상
  // 같은 입력에서 나오고, 같은 키의 셀이 서로 다른 게이트로 채워지는 창이 없다.
  //   · `mode === "period"`  — 스냅샷 카드는 종전 그대로(설계 §4-2 의 경계).
  //   · `trendGridApplied`   — 격자 키가 꺼져 있으면 완결성이 안 실려 있다 = 종전 그대로.
  if (set.mode !== "period" || !trendGridApplied(set)) return base;
  return withTrendGridKnown(base);
};

const cachedSummaryGlobalS1 = mirrorCache("summary-global-trend-s1",
  async (
    _cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
  ): Promise<GlobalS1Read> =>
    summaryGlobalS1FromTrend({
      ...globalS1ScopeOf(set, ownVariant, filters),
      // GEO 국가별 ⑤ 분자(공식(HMG)) — 도메인 문장의 국가 축 행에 열 하나로 실린다.
      // 카드 값은 `group` 축 JS 분류로 내므로(같은 분류 함수) 이 목록과 무관하게 같다.
      officialGroupKeys: await officialHmgKeysForSet(set),
    }),
  [SUMMARY_TAG]);

const requestS1 = cache(async (key: string): Promise<GlobalS1Read> => {
  const { set, v, f } = JSON.parse(key) as {
    set: CycleSet;
    v: string;
    f: StandardFilters;
  };
  return cachedSummaryGlobalS1(set.cycleKey, set, v, f);
});

// ── 게이트 프로브 계측 (PR⑤ U3, 2026-09-11) ────────────────────────────────
//
// **왜 게이트도 read 와 같은 등급으로 재는가.** A0 계측(`timedRead`)은 read 프로미스만
// 감쌌고, 접힘 프로브는 `foldGated` 의 **첫 인자**라 `x-hmg-read` 줄이 한 번도 안 남았다.
// 그 사이 이 문장 하나가 대시보드 요청 DB 버퍼의 46%(54,618/117,000)를 먹고 경쟁사 경계
// 2단을 통째로 지배하고 있었는데(pgss mean 461 ms · calls 249), PR④ 의 EXPLAIN 대상은
// "카드 3문장"이었고 마커는 경계의 최댓값만 주므로 **두 PR 이 그것을 지나쳤다**.
// U1 이 그 문장을 고쳤다. 이 계측은 그것이 **다시 자라는 것**을 로그에서 보이게 한다.
//
// 규율: 요청마다 무조건 DB 를 치는 게이트 프로브는 read 와 같은 계측·EXPLAIN 대상이다.
//
// ⚠️ 계측은 **캐시 셀 안**에 둔다(`foldGated` 호출부가 아니라). 프로브는 React `cache()`
//    라 한 요청에서 여러 호출부가 같은 셀을 기다리는데, 호출부마다 감싸면 문장 1개에
//    로그가 여러 줄 남고 두 번째부터는 0 ms 로 찍혀 귀속이 거꾸로 흐려진다. 셀 안에
//    두면 **문장 1개당 정확히 1줄**이다.
//
// ⚠️ 이름은 **문자열 리터럴**이어야 한다(`lib/perf/read-timing.test.ts` 호출부 스캐너).
//    그래서 표 조합마다 분기로 고정한다 — 새 조합이 생기면 리터럴을 하나 더 넣는다.
//    `+` 는 `READ_TIMING_LINE` 문법에 없는 문자라 구분자는 `-` 를 쓴다.
function timedFoldProbe(
  surface: CycleSet["surface"],
  tables: readonly TrendStatementKey[],
  probe: Promise<boolean>,
): Promise<boolean> {
  // 프로브의 산출은 boolean 하나다 — 행 수 개념이 없으므로 `rows:0` 으로 닫는다
  // (판정 자체는 `x-hmg-summary(… fallback:agg-fold-missing)` 줄이 이미 남긴다).
  if (surface === "website") return timedRead("fold/website.own", null, probe, () => 0);
  if (tables.includes("brands")) {
    return timedRead("fold/global.own-domains-brands", null, probe, () => 0);
  }
  if (tables.includes("domains")) {
    return timedRead("fold/global.own-domains", null, probe, () => 0);
  }
  return timedRead("fold/global.own", null, probe, () => 0);
}

/**
 * 글로벌 접힘 프로브 — 회차 집합당 1회(React cache). 웹사이트와 같은 함수를 쓴다.
 * 읽기 **전**·캐시 셀 **밖**이라는 자리가 요점이다(리더 `empty` 는 셀 안이라 늦다).
 */
const cachedGlobalFoldPresent = cache(async (key: string): Promise<boolean> =>
  timedFoldProbe("global", ["own"], trendFoldPresent("global", JSON.parse(key) as CycleSet)));

// ── 접힘 프로브 병렬화 (PR④ A1, 2026-09-10) ────────────────────────────────
//
// 프로브는 문장 1개인데 **read 앞에 `await`** 로 직렬이었다 — pgss mean 303 ms(calls 28,
// 2026-09-10 라이브). 네 게이트가 전부 같은 모양이라 카드·extras 경계에 그 시간이
// 그대로 얹혔다. 프로브와 read 는 **서로의 입력이 아니므로** 동시에 보낼 수 있다.
//
// 판정은 종전과 **완전히 같다**: 프로브가 false 면 read 결과를 **버리고** 종전 폴백
// 목적지로 간다. 프로브가 던지면(= 실패) `trendFoldPresent` 가 `false` 를 내므로
// ("던지지 않는다" 규약, `summary-trend-fold.ts:74-99`) 그것도 폴백이다.
//
// ── 버려지는 read 의 값 (검증자 질문 셋) ────────────────────────────────────
//
// ① **값 오염 없음.** 버린 결과는 반환 경로에 닿지 않는다. 남는 흔적은 캐시 셀뿐이고,
//    그 셀은 같은 키에 같은 입력이라 **오늘도 프로브가 true 였다면 만들어졌을 값**이다.
// ② **부분 접힘 셀이 뒤에 살아남지 않는다.** 접기 러너가 스왑을 마치면 내부 라우트
//    (`/api/internal/summary/published`)가 `MIRROR_AGGREGATE_TAG`·`SUMMARY_TAG` 를
//    함께 revalidate 한다 — 즉 "프로브 false 였던 시점의 셀"은 프로브가 true 로
//    바뀌는 바로 그 사건에 무효화된다. TTL(7,200 s)을 기다리지 않는다.
// ③ **커넥션 점유는 늘 수 있다.** 프로브 false 인 요청에서 집계층 read 가 한 번 더
//    돈다(취소는 못 한다 — postgres.js 는 발행된 문장을 되부르지 못하고, 예산의
//    `deadlineAt` 도 "다음 문장 발행 전"에만 본다). 그 대신 그 read 는 **집계층**
//    문장이고(pgss 244~669 ms · `summaryRead` 예산 15 s/20 s), 폴백이 향하는 세부층·
//    미러 문장보다 한 자릿수 싸다. 프로브 false 는 접기 미실행 구간(배포·백필 직후)
//    에 한정되고 정상 운영에서는 발생하지 않는다.
// ④ **unhandled rejection 없음.** 버릴 프로미스의 거부를 **발행 즉시** 흡수한다.
//    안 하면 Node 가 프로세스를 죽인다(`page.tsx` 의 `handled` 헬퍼와 같은 계약).
//
// ── 남는 경계 두 개 (PR④ 검증자 소견 — 코드 변경 없음, 알고 쓰는 조건) ─────────
//
// ⑤ **스냅샷 역전 창.** read 는 T0 에 발행되고 프로브는 T1(> T0)에 판정한다 — 둘은
//    같은 스냅샷을 보지 않는다. 그래서 **이미 published 인 회차를 사후에 접는 백필**
//    (`lib/summary/generate/fold.ts::applyFoldTx`)이 도는 동안, "접히기 전"에 발행된
//    read(부분 모수)가 "접힌 뒤"의 프로브 true 를 만나 **채택**될 수 있다. 그 값은
//    `cachedSummaryGlobalS1` 셀(`mirrorCache` TTL 7,200 s)에 남는다.
//    · 정규 스왑에서는 **닫혀 있다** — `lib/summary/generate/swap.ts::swapGeneration` 이
//      drift 검사 → retire → 접기 → 스왑을 **한 트랜잭션**에 넣으므로, 어느 시점의 read 든
//      "접히기 전 세대" 아니면 "접힌 뒤 세대" 하나를 통째로 본다(부분 접힘 상태가 커밋되어
//      보이는 구간이 없다).
//    · ②의 자동 무효화도 정규 경로 전제다 — 그 revalidate 를 부르는 것은 접기 러너다.
//    · **운영 규칙: 사후 백필 뒤에는 `POST /api/internal/summary/published` revalidate 를
//      반드시 호출한다**(러너가 부르지 않으면 운영자가). 안 부르면 TTL 7,200 s 동안
//      부분 모수 셀이 서빙된다. 이것이 지금 이 창을 닫는 유일한 수단이다.
//    · PR⑤ 이월(근본 해결): 접힘 플래그를 **read 문장 안에** 실어 같은 스냅샷에서 읽는다 —
//      그러면 프로브라는 별도 시점 자체가 사라진다.
//
// ⑥ **프로브 false 요청은 4 게이트가 동시에 버리는 read 를 낸다.** ③ 은 문장 단가를
//    말하지만 **동시 점유 폭**은 따로다: S1 read 1회 = 문장 **3개**(`S1_STATEMENT_KEYS`
//    own·brands·domains)가 `readTrendAggregates`(`summary-trend-aggregates.ts:1350`
//    `Promise.all`)로 **병렬** 발행되고, 문장마다 자기 트랜잭션이라 **최대 3 커넥션 ×
//    15 s**(`summaryRead` statement_timeout)를 잡는다. 네 게이트가 같은 요청에서 프로브
//    false 면 그만큼이 겹친다. `DB_POOL_MAX`(`lib/db/index.ts:38`, 기본 10) 에 여유가
//    있다는 것이 이 병렬화의 전제다 — 풀을 줄이거나 게이트를 늘리기 전에 이 곱을 다시 센다.
async function foldGated<T>(
  probe: Promise<boolean>,
  read: () => Promise<T>,
): Promise<{ folded: false } | { folded: true; value: T }> {
  const pending = read().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!(await probe)) return { folded: false };
  const settled = await pending;
  // 프로브가 true 인 경로에서는 종전과 동일하게 **던진다** — 예산·degrade 판정이
  // 상위(`degradeAware`)에 있으므로 여기서 삼키면 실패가 "데이터 없음"으로 위장된다.
  if (!settled.ok) throw settled.error;
  return { folded: true, value: settled.value };
}

/**
 * S1 집계층 read → 위젯 하나분. `pick` 이 `null` 을 내면 **그 위젯만** 세부층으로 간다
 * (예: GEO 축이 안 섰지만 카드는 유효한 경우).
 */
async function viaGlobalS1<T>(
  f: StandardFilters,
  pick: (v: SummaryGlobalS1) => T | null,
  /** 집계층만 거부됐을 때(= `agg-*`) 갈 곳 — PR② 이전 경로인 세부층 사실표. */
  onDetail: (...args: GlobalSummaryArgs) => Promise<T>,
  /** 게이트가 summary 경로 자체를 거부했을 때(= `gate-*`) 갈 곳. */
  onMirror: () => Promise<T>,
  /**
   * 창의 **모든 자리가 완결성 갭**이라 읽을 회차가 없을 때 낼 값(2026-09-20 독립 검증 C).
   *
   * 기본값은 종전 폴백(`aggFallback`)이지만, **그것은 정의가 갈리는 경로다**: 방금
   * "이 자리는 반쯤만 측정돼 값을 내지 않는다" 고 판정해 놓고 미러의 수를 내면, 같은
   * 화면의 추이는 그 자리를 갭(음영)으로 그리는데 카드에는 수가 선다. 프로덕션에 그
   * 모양이 실재한다(설계 문서가 못 박은 06-08 `completion_ratio = 0.499`).
   * 그래서 값을 내는 지면(카드 집계)은 **없음**을 넘긴다 — 추이와 같은 쪽이다.
   */
  onSlotGap?: () => Promise<T>,
): Promise<T> {
  const screen: SummaryScreenKey = "S1.dashboard";
  const rootId = getStandardRootId();
  // 기간이 걸린 요청은 **회차 집합 모드**로 판정한다(옵트인 `S1.periodRoute` 또는
  // 프리뷰 전용 env). 키·env 가 꺼져 있거나 기간이 없으면 종전 스냅샷 판정 그대로다:
  // `periodRouteEnabled` 의 첫 줄(`hasPeriod`)이 그 회귀 0 을 보장한다.
  const route = (await periodRouteEnabledForScreen(screen, f))
    ? await globalPeriodRoute(rootId, f, screen)
    : await globalSummaryRoute(rootId, f, screen);
  if (route.path !== "summary" || !rootId) return onMirror();
  const cycle = route.cycles[0];
  if (!cycle) return onMirror();
  const detail = () => onDetail(route.cycleKey, cycle, rootId, f);
  // ⚠️ **기간 모드의 `agg-*` 폴백 목적지는 미러다**(설계 §6-3). 세부층 리더는 단일
  //    회차만 읽으므로, 기간 모드에서 `detail()` 로 가면 "2026-08-20..09-18" 라벨
  //    아래 **1회차 값**이 조용히 실린다: 빈 화면보다 나쁘다(틀린 숫자는 아무도
  //    못 잡는다). 세부층을 기간으로 넓히는 것은 이 변경의 범위 밖이고, 추이 경로
  //    (`viaGlobalSeries`·`websiteTrendSet`)가 이미 같은 이유로 미러만 본다.
  const period = route.mode === "period";
  const aggFallback = period ? onMirror : detail;
  const tag = period ? `global ${screen} period` : `global ${screen}`;
  const dest = period ? "mirror" : "detail";
  const plan = planTrendRead({ surface: "global", filters: f });
  if (!plan.ok) {
    console.info(`x-hmg-summary(${tag}): fallback:${plan.reason} → ${dest}`);
    return aggFallback();
  }
  // 캐시 키에 **관측값이 들어가지 않게** 순수 CycleSet 만 넘긴다 — `route` 를 그대로
  // 넘기면 `openRuns`(열린 회차 관측, 시간에 따라 뒤집힌다)가 키에 섞여 셀이 갈린다.
  const routeSet: CycleSet = globalCycleSetOf(route);
  // ── 카드도 **한 자리 = 한 회차**로 읽는다 (2026-09-20 제품 책임자 방침) ────────────
  //
  // 종전에는 기간 모드의 카드가 창 안 회차를 **전부 합산**했다. 자리(round_date)에
  // 회차가 둘 걸린 날에는 그 합이 곧 이중 계상이고, 같은 화면의 추이·상세는 대표
  // 하나만 읽으므로 **같은 지표가 두 수**로 갈렸다(메인 실측 2026-08-17 자리: 카드
  // 14.0% = 2,479/17,709 = 함대 노출 회차 3,602 + **노출 꺼진 회차** 14,107,
  // 상세 6.5% = 1,073/16,426). 함대 노출이 꺼진 회차가 글로벌 화면 값에 들어가면
  // 안 된다는 것이 방침이므로, 카드도 추이와 **같은 함수**로 좁힌다.
  //
  // 격자 키(`X.trendGrid`)가 꺼져 있으면 회차에 완결성이 안 실려 있어
  // `trendGridApplied` 가 false 다 → 아래 전체가 건너뛰어지고 `set === routeSet`
  // (같은 객체)이라 캐시 키·문장·값이 한 글자도 안 바뀐다.
  //
  // 스냅샷 모드는 애초에 회차를 하나만 고르므로(`pickGlobalCycle`) 타지 않는다 —
  // "스냅샷 카드는 그대로" 라는 설계 §4-2 의 경계도 그대로 남는다.
  let set = routeSet;
  if (period && trendGridApplied(routeSet)) {
    const restricted = restrictToTrendSlotSet(routeSet);
    logTrendSlotRestriction(tag, restricted);
    set = restricted.set;
    // 창의 모든 자리가 완결성 미달이면 읽을 회차가 없다 — 0 으로 그리지도, 미러의
    // 다른 정의로 메우지도 않는다. 추이가 그 자리에 갭 슬롯을 끼우는 것과 같은 쪽이다
    // (`onSlotGap` 머리 주석). 지면이 없음을 못 내면 종전 폴백으로 간다.
    if (set.cycles.length === 0) {
      const gapDest = onSlotGap ? "slot-gap" : dest;
      console.info(`x-hmg-summary(${tag}): fallback:agg-no-slot-cycle → ${gapDest}`);
      return onSlotGap ? onSlotGap() : aggFallback();
    }
  }
  // 접힘은 읽기 **전**에 판정한다 — 리더 `empty` 는 캐시 셀 안이라 되돌릴 자리가 없다.
  // 발행은 read 와 **동시**다(A1): 판정 순서·목적지는 종전과 같고 대기만 겹친다.
  const gated = await foldGated(
    cachedGlobalFoldPresent(JSON.stringify(set)),
    () => requestS1(JSON.stringify({ set, v: plan.ownVariant, f })),
  );
  if (!gated.folded) {
    console.info(`x-hmg-summary(${tag}): fallback:agg-fold-missing → ${dest}`);
    return aggFallback();
  }
  const read = gated.value;
  if (read.empty) {
    // 접기 미실행·부분 접힘: 0 으로 그리지 않고 종전 경로로 돌린다(플랜 §5-2).
    console.info(`x-hmg-summary(${tag}): fallback:agg-empty → ${dest}`);
    return aggFallback();
  }
  const picked = pick(read.value);
  if (picked === null) {
    console.info(`x-hmg-summary(${tag}): fallback:agg-widget-empty → ${dest}`);
    return aggFallback();
  }
  return picked;
}


// ── 집계층 경로 — S3 인용 (PR② T7) ─────────────────────────────────────────
//
// `viaGlobalS1` 와 게이트 자세가 같고 리더만 다르다. 다른 것은 **소비자 게이트**
// 하나다: 이 경로가 내는 `CitationsLive` 는 **롤업만** 갖는다(드릴다운 `urls`·
// `promptList`·`promptSplit`, 주 단위 `trend`/`categoryTrend` 는 사실표 밖 = PR③,
// `summary-citation-read.ts` 머리 주석). 그래서 전량 `fetchStandardCitations` 를
// 이 경로로 돌리지 않고, **롤업만 쓰는 호출부**에 전용 페처를 준다.
//
// 오늘 그 호출부는 하나다 — 대시보드 KPI 카드 하단의 "인용 점유율 경쟁사" 행
// (`dashboard/page.tsx` → `competitorCitationShares`)이고, `domain`·`share`·
// `category` 만 읽는다. 인용 화면(S3)·프롬프트 탭은 종전 미러 그대로다:
//   · 인용 화면은 `cumulative: true` 를 걸어(`citation/page.tsx:66`) 게이트가
//     이미 미러로 돌린다(`gate.ts::commonUnsupportedReason` → `unsupported:cumulative`).
//     플랜 §6-2 는 이 화면을 "스냅샷 의미론 유지" 로 적었지만 **코드가 이긴다** —
//     누적 → 회차 집합 SUM 은 T8(S2/S5)과 같은 성격의 화면 변경이라 PR② 밖이다.
//   · `citation/prompts/page.tsx` 는 `cumulative` 없이 `promptSplit` 을 읽는다.
//     그 화면을 이 경로로 돌리면 탭 카운트가 사라진다 — 전용 페처가 그것을 막는다.

const cachedSummaryGlobalCitations = mirrorCache("summary-global-trend-citations",
  async (
    _cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
  ): Promise<CitationTrendRead> =>
    summaryGlobalCitationsFromTrend(globalTrendScopeOf(set, ownVariant, filters)),
  [SUMMARY_TAG]);

const cachedSummaryGlobalSourceCompositionTrend = mirrorCache("summary-global-trend-source",
  async (
    _cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
  ): Promise<SummaryTrendRead<SourceDomainSlice[]>> =>
    summaryGlobalSourceCompositionFromTrend(globalTrendScopeOf(set, ownVariant, filters)),
  [SUMMARY_TAG]);

/**
 * `$sel`·축 없는 기본 집계층 스코프. 절단은 **리더가 화면별 상수로 얹는다**
 * (`S3_CITATION_LIMITS`·`S3_SOURCE_LIMITS`) — 여기서 정하면 두 화면이 같은 값을 쓴다.
 */
const globalTrendScopeOf = (
  set: CycleSet,
  ownVariant: string,
  filters: StandardFilters,
): TrendReadScope => ({
  set,
  filters,
  ownVariant,
  ownedBasePrefixes: scopeOwnedPrefixes(filters),
});

/**
 * 화면 키를 받는 일반 집계층 게이트. `viaGlobalS1` 의 화면 고정(S1)을 푼 것이고
 * 판정 순서·로그 문구는 같다: 회차 게이트 → `planTrendRead` → `empty` 폴백.
 */
async function viaGlobalTrend<T>(
  f: StandardFilters,
  screen: SummaryScreenKey,
  read: (
    cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
  ) => Promise<SummaryTrendRead<T>>,
  /** 집계층만 거부됐을 때(= `agg-*`) 갈 곳. 세부층 쌍둥이가 없으면 미러와 같은 것을 넘긴다. */
  onDetail: (...args: GlobalSummaryArgs) => Promise<T>,
  onMirror: () => Promise<T>,
): Promise<T> {
  const rootId = getStandardRootId();
  const route = await globalSummaryRoute(rootId, f, screen);
  if (route.path !== "summary" || !rootId) return onMirror();
  const cycle0 = route.cycles[0];
  if (!cycle0) return onMirror();
  const detail = () => onDetail(route.cycleKey, cycle0, rootId, f);
  // 기간 모드의 `agg-*` 폴백 목적지는 **미러**다(`viaGlobalS1` 의 ⚠️ 와 같은 규칙).
  // 이 게이트는 오늘 스냅샷 판정만 받으므로 값은 종전과 같다: 규칙을 코드로 박아
  // 다음에 기간 모드를 물릴 때 세부층으로 새지 않게 한다.
  const period = route.mode === "period";
  const aggFallback = period ? onMirror : detail;
  const plan = planTrendRead({ surface: "global", filters: f });
  if (!plan.ok) {
    console.info(`x-hmg-summary(global ${screen}): fallback:${plan.reason} → detail`);
    return aggFallback();
  }
  // 관측값(`openRuns`)이 캐시 키에 섞이지 않게 순수 CycleSet 만 넘긴다(viaGlobalS1 과 동일).
  const set: CycleSet = {
    surface: route.surface,
    mode: route.mode,
    cycles: route.cycles,
    cycleKey: route.cycleKey,
    projectIds: route.projectIds,
    missingProjectIds: route.missingProjectIds,
    weeks: route.weeks,
    anchorCount: route.anchorCount,
  };
  // A1 — 프로브·read 동시 발행. 목적지·로그·판정 순서는 종전과 같다.
  const gated = await foldGated(
    cachedGlobalFoldPresent(JSON.stringify(set)),
    () => read(set.cycleKey, set, plan.ownVariant, f),
  );
  if (!gated.folded) {
    console.info(`x-hmg-summary(global ${screen}): fallback:agg-fold-missing → detail`);
    return aggFallback();
  }
  const out = gated.value;
  if (out.empty) {
    console.info(`x-hmg-summary(global ${screen}): fallback:agg-empty → detail`);
    return aggFallback();
  }
  return out.value;
}

// 요청단위 dedup — 대시보드가 필터바(측정 기준일 슬롯)와 본문(SummarySection →
// getLiveDashboard) 두 <Suspense> 경계에서 같은 read 를 부른다(2026-09-01).
// 값이 같은 필터면 DB 는 1회. (fetchStandardMentions 와 동일한 이유.)
export const fetchStandardAggregates = requestDeduped(
  "fetchStandardAggregates",
  async (filters: StandardFilters = {}): Promise<StandardAggregates | null> =>
    // 제외 엔티티(명부 excluded)는 `brands` 에서만 뺀다: 카드 값은 자사 합·스칼라라 그대로,
    // 바뀌는 것은 KPI #16 의 SOV 1위 경쟁사 자동 선정뿐이다(`excluded-brands.ts`).
    withExcludedBrands(await
    // 예산에 걸리면 null 을 내고 페이지는 그대로 서빙된다(2026-09-10). `null` 의 두 뜻
    // ("데이터 없음" vs degrade)은 `wasDegraded("standardAggregates")` 로 가르고,
    // 대시보드 카드 자리가 그 표식으로 문구를 바꾼다.
    degradeAware("standardAggregates", () =>
    withStandardRoot("standardAggregates", null,
      // PR② T6: 세부층(`summaryGlobalAggregates`, 6문장·job 조인)에서 **집계층 3문장**으로.
      // 그 3문장은 ④ GEO 와 공유한다(라운드 2). 집계층이 비었거나(접기 미실행) 필터가
      // 집계층 키 밖이면 **세부층**으로 돌아간다 — 미러는 게이트가 거부할 때만이다
      // (T11 기준 6: 형제 위젯이 세부층이라 미러로 가면 한 화면에 두 원천이 섞였다).
      (f) => viaGlobalS1(f, (v) => v.aggregates,
        cachedSummaryGlobalAggregatesDetail,
        () => cachedStandardAggregates(f),
        // 자리가 전부 완결성 갭이면 **값을 내지 않는다** — 화면은 "데이터 없음" 이고,
        // 같은 화면의 추이가 그 자리를 갭으로 그리는 것과 같은 쪽이다(독립 검증 C).
        async () => null), filters)), filterAggregatesBrands),
);

/**
 * 카드 ①~⑤ 시계열 — 스파크라인·Δ 의 원천.
 *
 * ⚠️ 집계층 경로에서 **`unit` 은 무시된다**. 집계층의 유일한 시간축이 회차 anchor 라
 *    `day` 버킷을 만들 수 없다(리더 `summary-global-trend-read.ts` 머리 주석). `day` 를
 *    넘기는 유일한 호출부는 대시보드 Δ 칩(`DELTA_TREND_BUCKET`)이고, 그 정의는 D-4
 *    해제(제품 책임자 2026-09-11)로 **"직전 회차 대비"** 가 됐다. 미러 폴백에서는 종전대로
 *    `unit` 이 그대로 먹는다 — 두 경로의 x축이 다르다는 뜻이고, 그것이 전환의 내용이다.
 */
export const fetchStandardTrend = requestDeduped(
  "fetchStandardTrend",
  fetchStandardTrendImpl,
);

/**
 * ⚠️ **요청 단위 dedup 을 씌운다**(2026-09-20 독립 검증 M3). 언급 화면이 신설한 읽기
 * 셋(카드 집계 · 주 격자 추이 · Δ 롤업) 중 뒤 둘이 이 함수이고, 우선 노출도 탭은 같은
 * 셋을 또 부른다. 인자가 같으면 한 요청에 한 번만 돌게 한다 — `fetchStandardAggregates`
 * 가 이미 같은 규약이라(그쪽 주석) 셋이 한 벌로 맞춰진다.
 */
async function fetchStandardTrendImpl(
  filters: StandardFilters = {},
  unit: BucketUnit = "week",
): Promise<StandardTrendBucket[]> {
  // 공용 격자(D5) — 키 off 면 `null` 이고 아래 전부가 종전 그대로다(DB 왕복도 0).
  // 자리 목록을 **읽기 전에** 세우는 이유: 창(`dateFrom`)이 자리에서 나오기 때문이다.
  //
  // ⚠️ `day` 단위에는 안 건다. 그 호출부는 Δ 칩 하나뿐이고(`DELTA_TREND_BUCKET`, 30일),
  //    설계가 "Δ 전용 30일은 건드리지 않는다"로 못 박았다. 자리는 주 격자의 개념이라
  //    일 버킷에 얹으면 없던 날을 만든다.
  const slots = await trendSlotsFor({
    surface: "global",
    projectIds: rootProjectIdsForGaps(),
    family: "all",
    filters,
    unit,
  });
  filters = withTrendGridWindow(filters, slots);
  // 예산 초과(PR③-a)는 **빈 배열**로 내린다 — 화면은 종전의 "추이 없음" 자리를 쓰고,
  // 그것이 "데이터 없음" 인지 "지연" 인지는 `wasDegraded("standardTrend")` 가 가른다.
  // degrade 는 캐시 바깥이라 저장되지 않는다(다음 요청이 재시도).
  // 예산이 감싸는 것은 **미러 폴백**이다 — 집계층 경로(`viaGlobalSeries`)는 회차 read 라
  // 훨씬 싸지만, 게이트가 거부하면 종전 미러로 떨어지고 그쪽이 warm 55.6 s 짜리다.
  const buckets =
    (await degradeAware(`standardTrend:${unit}`, () =>
      withStandardRoot("standardTrend", [] as StandardTrendBucket[],
        (f) => viaGlobalSeries(f, "S1.dashboard", requestGlobalCore,
          // 완결성 미달 자리는 **값 없는 슬롯**으로 남긴다(설계 §4-A). 격자 키가 꺼져
          // 있으면 `gapDays` 가 비어 입력 배열이 참조까지 그대로 돌아온다.
          (series, gapDays) =>
            insertCompletionGapBuckets(toStandardTrendBuckets(series), gapDays),
          () => cachedStandardTrend(f, unit), ["own", "domains"], {},
          trendGridDateFloor(slots)), filters))) ?? [];
  // 숨긴 회차의 갭 슬롯(0070)은 **캐시 밖**에서 얹는다 — 원장을 고치면 다음 요청부터
  // 바로 반영돼야 하고(캐시 TTL 2시간을 기다리지 않는다), 두 경로(집계층·미러)가 같은
  // 타입으로 나오므로 여기 한 곳이면 둘 다 덮인다.
  //
  // ⚠️ 격자는 **그 뒤**다 — 인용 계열 마커(② 패스)가 붙은 버킷 위에 자리를 얹어야
  //    숨긴 인용 회차의 음영이 살아남는다(`trend-grid-buckets.ts` 머리 주석).
  return applyTrendGridToBuckets(
    await withTrendGapBuckets(buckets, unit, "global", rootProjectIdsForGaps()),
    slots,
  );
}

/**
 * 갭 슬롯 조회의 **글로벌 스코프** — 회차 원장의 `project_id` 는 표준 루트 하나다
 * (`pickGlobalCycle` 이 쓰는 것과 같은 id). 루트가 없으면 빈 목록 = 갭 없음.
 */
function rootProjectIdsForGaps(): string[] {
  const rootId = getStandardRootId();
  return rootId ? [rootId] : [];
}

// 요청단위 dedup — 답변분석>언급 화면에서 이 두 read 는 **세 경계**가 부른다:
// 측정 개요 카드(측정 프롬프트 수) · KPI 탭 히어로 · 기존 언급 본문. 2026-09-02
// 에 KPI 탭을 섹션별 경계로 쪼개면서 호출 지점이 더 늘었고, 2026-09-03 에 표준
// 언급 본문이 구획 단위 <Suspense> 로 쪼개지며 또 늘었다. 같은 스냅샷 집계가
// 콜드 키에서 중복 계산되지 않도록 접는다(fetchStandardMentions 와 동일).
// 이름은 키 네임스페이스라 모듈 안에서 유일해야 한다.
// 요청단위 dedup (2026-09-03) — 표준 언급 화면이 본문을 구획 단위 <Suspense> 로
// 쪼개면서, 같은 요청 안에서 두 구획 이상이 같은 Sub KPI 집계를 부를 수 있게
// 됐다(현재는 ① 요약 구획만 부르지만, 구획이 늘어나도 DB 왕복이 늘지 않도록
// 분할의 전제조건인 dedup 을 지금 씌운다). 값이 같은 필터면 DB 는 1회.
export const fetchStandardSubKpis = requestDeduped(
  "fetchStandardSubKpis",
  async (filters: StandardFilters = {}): Promise<StandardSubKpis> =>
    withStandardRoot("standardSubKpis", { rows: [], promptsWithoutBrand: null, measuredPrompts: null },
      (f) => viaGlobalSummary(f, "S2.mention", cachedSummaryGlobalSubKpis, () => cachedSubKpis(f)), filters),
);

export const fetchStandardSubKpisPrev = requestDeduped(
  "fetchStandardSubKpisPrev",
  async (filters: StandardFilters = {}): Promise<PrevSubKpis | null> =>
    withStandardRoot("standardSubKpisPrev", null, cachedSubKpisPrev, filters),
);

// ── KPI 탭 히어로 전용 Sub KPI (2026-09-02) ────────────────────────────────
//
// 왜 별도 페처인가: 위 두 개는 **전량**이 필요한 지면(언급 본문 buildMentionSubKpis
// = 감정·프롬프트까지, 측정 개요 카드 = measuredPrompts)이 쓴다. KPI 탭 히어로는
// `kpiHero` 하나만 읽으므로 파트가 1~2개다. 같은 페처를 공유하면 히어로가 자기가
// 안 쓰는 문장 3~4개를 기다린다 — 그것이 히어로 31.0s 의 정체였다.
//
// dedup: 파트가 다르면 캐시 키도 다르므로 전량 셀과 접히지 않는다. 즉 같은 요청에
// 전량 호출이 함께 있으면 **트랜잭션이 하나 더 는다**(전량 8문장 + 부분 4~5문장).
// 그 대가로 히어로는 전량을 기다리지 않는다. 전량 쪽을 좁히지 않는 이유는 그 두
// 지면이 실제로 나머지 파트를 읽기 때문이다(위 목록) — 좁히면 화면이 조용히 빈다.
export const fetchStandardKpiHeroSubKpis = requestDeduped(
  "fetchStandardKpiHeroSubKpis",
  async (
    filters: StandardFilters = {},
    metric: keyof typeof KPI_TAB_SUB_KPI_PARTS = "exposure",
  ): Promise<StandardSubKpis> => {
    const sub = await withStandardRoot(
      "standardSubKpis",
      { rows: [], promptsWithoutBrand: null, measuredPrompts: null },
      (f) => cachedSubKpisParts(f, KPI_TAB_SUB_KPI_PARTS[metric]),
      filters,
    );
    return withOverviewCards(sub, filters);
  },
);

/**
 * 언급 히어로의 **AI 노출률 카드**를 Overview 카드와 같은 함수에 붙인다
 * (제품 책임자 2026-09-20 지시 ② — "Overview 와 멘션의 값은 완전 같아야 해").
 *
 * 붙이는 값은 `fetchStandardAggregates` 가 낸 것 그대로다. 그 함수가 **Overview 카드의
 * 원천**이고, 인자도 `exposureReadFilters` 로 같은 값이 되므로(B1-a 수리) 같은 필터
 * 상태에서 **같은 셀**을 읽는다.
 *
 * ⚠️ 보장 범위를 정확히 적는다(2026-09-20 독립 검증 A2·B1-a): "구조적으로 불가능"
 *    같은 말을 쓰지 않는다. 보장되는 것은 **같은 함수·같은 인자·같은 캐시 키**까지이고,
 *    그 위에서 두 화면이 갈릴 수 있는 잔여 경로는 둘이다:
 *      · 카탈로그 전 회차 목록 판정이 실패한 요청(그때는 **두 경로 다** 빈 목록 =
 *        둘 다 닫힘이라 값이 갈리지는 않는다. `trend-grid-flag.ts` 의 `preCatalog: null`)
 *      · 두 화면이 서로 다른 필터 상태를 가질 때(사용자가 각 화면에서 다르게 고른 경우)
 *
 * **캐시 밖**에서 얹는다(`withTrendGapBuckets` 와 같은 이유): 두 원천의 무효화 주기가
 * 다르므로 미러 셀 안에 사실표 값을 굳히면 한쪽만 낡는다.
 *
 * 격자(`X.trendGrid`)가 꺼져 있으면 **입력 객체를 그대로** 돌려준다 — 왕복도 0이다.
 */
/**
 * **Overview 원천을 읽는 지면의 필터 정규화** — Overview 와 같은 인자를 만든다
 * (2026-09-20 독립 검증 B1-a 차단 수리).
 *
 * ── 무엇이 갈렸나 ──────────────────────────────────────────────────────────
 *
 * 두 화면이 같은 함수(`fetchStandardAggregates`)를 부르는데 **인자가 달랐고, 그 인자가
 * 라우팅을 갈랐다**:
 *   · 언급   `app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx` — `cumulative: true` **상시**
 *   · 대시보드 `app/[locale]/(dash)/dashboard/page.tsx` — `cumulative: Boolean(dateFrom || dateTo)`
 * 기본 화면(기간 미선택)에서 `unsupportedGlobalFilterReason({cumulative:true}, "snapshot")`
 * 가 `"cumulative"` 라(`lib/summary/read/gate.ts`), **언급 카드만** 미러 스냅샷으로
 * 떨어지고 Overview 카드는 사실표를 읽었다. 두 경로는 `in_full_cycle` 하나만으로도
 * 모집단이 갈릴 수 있다 — 오늘 두 값이 같아 보이는 것은 우연이지 보장이 아니다.
 *
 * ── 무엇을 하는가 ──────────────────────────────────────────────────────────
 *
 * 노출률 read 에 한해 `cumulative` 를 **대시보드와 같은 식**으로 다시 계산한다. 산식이
 * 아니라 **라우팅 축**이라 그래도 되는 이유는 대시보드 쪽 주석이 이미 적어 두었다
 * (그 화면도 같은 이유로 상시 `true` 를 쓰지 않는다).
 *
 * ⚠️ **Overview 원천을 읽는 read 에만 쓴다.** 언급 화면의 나머지 read(유형·프롬프트
 *    목록·엔진 분해행 등)는 "기간 내 누적" 의미론이 제품 정의이므로(2026-09-04 기획)
 *    원본 `filters` 를 그대로 쓴다.
 *
 * 같은 필터 상태에서 두 화면의 인자가 **깊은 동등**이므로 `normalizeFilters` 가 만드는
 * 캐시 키도 같다 = 한 요청에 Overview 와 언급이 함께 있으면 셀이 하나다.
 */
export function overviewReadFilters(filters: StandardFilters): StandardFilters {
  const cumulative = Boolean(filters.dateFrom || filters.dateTo);
  // 값이 이미 같으면 **같은 객체**를 돌려준다 — `requestDeduped` 키가 갈리지 않게.
  if (filters.cumulative === cumulative) return filters;
  return { ...filters, cumulative };
}

/**
 * 경쟁사 **값 read 의 인자 한 벌** (제품 책임자 2026-09-20 지시 ①).
 *
 * 두 지면이 이 함수 **하나로** 인자를 만든다 — 대시보드 경쟁사 줄
 * (`fetchStandardCompetitorSources`)과 언급 화면(`fetchStandardMentionCompetitorBrands`).
 * 인자를 각자 적으면 "같은 함수를 다른 인자로 부르는" 결함이 다시 생긴다(B1-a 가 정확히
 * 그 모양이었다).
 *
 * 두 조각이 왜 이 값인가:
 *   · 필터 — `overviewReadFilters` 로 `cumulative` 축을 대시보드 식으로 맞춘다. 이 축이
 *     라우팅을 가른다(`gate.ts`: `cumulative` + 스냅샷 = 미지원 → 미러). 맞추지 않으면
 *     언급만 미러로 떨어져 **모집단이 갈린다**.
 *   · 예산 — `extras`. 대시보드 경계가 쓰는 값이고, 예산은 **미러 폴백 셀의 캐시 키**다.
 *     언급 화면 예산(`screen`)을 쓰면 폴백에서 셀이 갈려 두 화면이 다른 수를 낼 수 있다.
 *     짧은 예산이라 언급 화면에서 degrade 확률이 올라가지만, 그때 값은 `null` 이고
 *     화면은 종전 미러 값을 그대로 쓴다(값이 틀리는 방향이 아니다).
 */
export function competitorValueReadArgs(
  filters: StandardFilters,
): [StandardFilters, { budget: MentionsBudgetProfile }] {
  return [overviewReadFilters(filters), { budget: "extras" }];
}

/**
 * **Overview 카드 Δ 를 다른 지면이 그대로 읽는 통로** (제품 책임자 2026-09-20 "같은 지표는
 * 완전히 같아야 한다").
 *
 * 산식도 입력도 Overview 와 같다:
 *   · 입력 — Δ 전용 롤업(`DELTA_TREND_BUCKET` 버킷 · `deltaTrendFilters` 창). 그것이
 *     대시보드 카드 Δ 의 원천이고(`dashboard/page.tsx`), 그 규칙이 제품 결정 사항이다.
 *   · 필터 — `overviewReadFilters` 로 `cumulative` 축을 대시보드 식으로 맞춘다. 이 축이
 *     라우팅을 가르므로(`gate.ts`) 안 맞추면 두 화면이 **다른 모집단**을 읽는다.
 *   · 산식 — `overviewCardDelta`(중립 모듈). 여기서 다시 계산하지 않는다.
 *
 * ── 반환 계약 ──────────────────────────────────────────────────────────────
 *
 * `null` 이면 호출 화면은 **종전 Δ 를 그대로** 쓴다. `null` 의 뜻은 셋:
 *   · 격자 키(`X.trendGrid`)가 꺼져 있다 → 이 변경 전체가 꺼진 상태(왕복도 0).
 *   · 값이 있는 자리가 2개 미만이다(Δ 정의 불가 — Overview 도 같은 자리에서 배지를 감춘다).
 *   · 조회 실패. **삼키되 조용하지 않다**(`console.error`) —
 *     `fetchStandardMentionCompetitorBrands` 와 같은 계약이다: 이 값은 장식적 보강이고,
 *     실패가 지면 전체를 내리는 것은 비대칭이다.
 */
export async function fetchStandardOverviewCardDelta(
  filters: StandardFilters = {},
  key: OverviewKpiKey = "citationShare",
): Promise<OverviewCardDelta | null> {
  if (!(await ensureTrendGrid())) return null;
  try {
    const f = overviewReadFilters(filters);
    return overviewCardDelta(
      await fetchStandardTrend(deltaTrendFilters(f), DELTA_TREND_BUCKET),
      key,
    );
  } catch (e) {
    console.error(
      "[kpi-cards] standardOverviewCardDelta failed (page still served, previous delta kept):",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

async function withOverviewCards(
  sub: StandardSubKpis,
  filters: StandardFilters,
): Promise<StandardSubKpis> {
  if (!(await ensureTrendGrid())) return sub;
  const agg = await fetchStandardAggregates(overviewReadFilters(filters));
  if (!agg) return sub;
  return { ...sub, overviewCards: overviewCardValues(agg) };
}

/**
 * `StandardAggregates` → Overview 카드 다섯 값. **`buildMirrorKpis` 와 같은 식**이다
 * (`app/[locale]/(dash)/dashboard/_data/live.ts`) — 옮겨 적은 것이 아니라 같은 입력에서
 * 같은 분자·분모를 뽑는다. 화면은 이 값을 **그대로** 쓰고 재계산하지 않는다.
 */
function overviewCardValues(agg: StandardAggregates): OverviewCardValues {
  const trackedMentions = agg.brands
    .filter((b) => b.isTracked)
    .reduce((acc, b) => acc + b.mentionCount, 0);
  return {
    visibility: { numerator: agg.trackedAnswerCount, denominator: agg.totalAnswers },
    shareOfVoice: { numerator: trackedMentions, denominator: agg.totalMentions },
    sentiment: {
      numerator: agg.sentiment.positiveMentions,
      denominator: agg.sentiment.sampledMentions,
    },
    position: {
      avgPosition: agg.position.avgPosition,
      sampledAnswers: agg.position.sampledAnswers,
    },
    // 분자는 표면별(글로벌 = 공식(HMG) 카테고리) — `buildMirrorKpis` 와 같은 선택 함수.
    citationShare: {
      numerator: citationShareNumerator(agg.citations),
      denominator: agg.citations.totalCitations,
    },
  };
}

export const fetchStandardKpiHeroSubKpisPrev = requestDeduped(
  "fetchStandardKpiHeroSubKpisPrev",
  async (
    filters: StandardFilters = {},
    metric: keyof typeof KPI_TAB_SUB_KPI_PARTS = "exposure",
  ): Promise<PrevSubKpis | null> =>
    withStandardRoot(
      "standardSubKpisPrev",
      null,
      (f) => cachedSubKpisPrevParts(f, KPI_TAB_SUB_KPI_PARTS[metric]),
      filters,
    ),
);

export async function fetchStandardPromptTopics(
  filters: StandardFilters = {},
): Promise<PromptTopicSlice[]> {
  return withStandardRoot("standardPromptTopics", [],
    (f) => viaGlobalSummary(f, "S1.dashboard", cachedSummaryGlobalPromptTopics, () => cachedPromptTopics(f)), filters);
}

// ─── 4-KPI 탭 (답변분석 > 언급) ───────────────────────────────────────────
//
// 소비 규약(예산·창·degrade 판정)의 정본은 `./kpi-tab-budget` 이다 — 정책을
// 값과 함께 테스트로 고정하기 위해 떼어냈다. 여기는 배선만 한다.

// ⚠️ `profile` 은 **캐시 키의 일부**다(마지막 인자). 같은 집계를 S1 대시보드와 S2 4-KPI
// 탭이 함께 쓰는데 예산이 달라서, 키에 안 넣으면 먼저 채운 쪽의 예산으로 만들어진 셀을
// 다른 쪽이 그대로 받는다(= 예산 분리가 무의미해진다). 근거는 kpi-tab-budget 의 예산 지도.
//
// `weekSource`(2026-09-18)도 같은 이유로 **캐시 키**다 — 같은 필터의 셀이 주 격자 두 벌을
// 가질 수 있으므로, 키에 안 넣으면 화면 키를 켜고 끄는 사이에 옛 격자 셀이 그대로 서빙된다
// (`cachedStandardMentions` 와 같은 규율).
const cachedKpiBrandTrend = mirrorCache("kpi-brand-trend",
  (filters: StandardFilters, win: KpiTrendWindow, topBrands: number, profile: KpiBudgetProfile,
   weekSource: TrendWeekSource) =>
    aggregateBrandTrendFromMirror(filters, undefined, {
      trendDays: kpiWindowDays(win),
      topBrands,
      weekSource,
      ...kpiBudgetOf(profile),
    }));

// ⚠️ trendDegraded=true 는 캐시하지 않는다(uncachedIfDegraded). 2026-09-02 프리뷰
// 실증: 콜드 첫 요청의 degrade 가 30분 캐시에 굳어 수 시간 동안 추이가 비었고,
// 캐시 HIT 라 warn 도 0건이었다 — 근거·규칙은 kpi-tab-budget 의 주석.
const cachedKpiEngineTrend = mirrorCache("kpi-engine-trend",
  uncachedIfDegraded(
    (r: EngineKpiTrend) => r.trendDegraded === true,
    // `weekSource` 는 **캐시 키**다(`cachedKpiBrandTrend` 주석과 같은 이유).
    (filters: StandardFilters, win: KpiTrendWindow, weekSource: TrendWeekSource) =>
      aggregateEngineKpiTrendFromMirror(filters, undefined, {
        trendDays: kpiWindowDays(win),
        weekSource,
        statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
        // 두 단계(스냅샷 + 추이)가 이 마감 하나를 공유한다. 추이 단계만 실패하면
        // 집계가 던지지 않고 trendDegraded=true 로 내려온다 — 엔진 바는 살아남는다.
        budgetMs: KPI_TAB_ENGINE_BUDGET_MS,
      }),
  ));

// 답변 단위 브랜드 스탠스 분포(0072) — 우호도 탭의 **답변 축** 카드.
// 문장 1개짜리 집계지만 예산은 **형제 집계와 같은 프로파일**로 준다(F7): 없으면 느린
// 필터 조합에서 문장 상한도 마감도 없어 `kpiDegrade` 가 못 삼키고, 카드 하나가 아니라
// 우호도 탭 전체가 에러가 된다. 캐시 키·TTL·태그는 다른 미러 집계와 동일.
const cachedKpiStanceDist = mirrorCache("kpi-stance-dist",
  (filters: StandardFilters) =>
    aggregateAnswerStanceDistributionFromMirror(filters, undefined, {
      statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
      budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
    }));

const cachedKpiTypes = mirrorCache("kpi-types",
  (filters: StandardFilters) =>
    aggregateTypeKpiFromMirror(filters, undefined, {
      statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
      budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
    }));

// 우선 노출도 탭(PR ③, 2026-09-02). 스냅샷 순위표 + 회차 시계열 두 단계가 마감
// 하나를 공유한다(엔진 추이와 같은 규약). 무필터 warm 실측 1.4s + 5.3s(집계 주석).
// ⚠️ S2 탭의 우선노출도는 실측 **14.8~15.2 s** 라 extras 의 15 s 문장 상한에서
// degrade 문턱에 걸린다 — 그래서 호출자별 프로파일이다(`cachedKpiBrandTrend` 주석 참조).
// 셀 이름에 축을 박는다(2026-09-28, 서수 축에서 경쟁 순위 축으로 교체). 종전 이름
// `kpi-first-position` 은 프로덕션 main 이 **서수 값**으로 계속 채운다: 같은 이름을 쓰면
// 배포가 섞이는 동안 한쪽 값이 다른 쪽 셀에 남는다. 값은 직렬화 가능한 객체뿐이다(Map 없음).
// `topBrands` 는 **제외 엔티티가 있을 때만** 넘긴다(순위표 캡 + 제외 수, 2026-09-30). 안 넘기면
// 인자 배열이 종전과 같아 캐시 키도 바이트 동일하다(미러 기본 캡 = RANK_TABLE_TOP_BRANDS).
const cachedKpiFirstPosition = mirrorCache("kpi-first-position-comp",
  (filters: StandardFilters, win: KpiTrendWindow, profile: KpiBudgetProfile, topBrands?: number) =>
    aggregateFirstPositionFromMirror(filters, undefined, {
      trendDays: kpiWindowDays(win),
      ...(topBrands != null ? { topBrands } : {}),
      ...kpiBudgetOf(profile),
    }));

// ─── Citation 개편 (PR ④, 2026-09-02) ─────────────────────────────────────
// 요약·구성 집계는 캐시(필터 콤보당 1회), 하위 페이지 목록(페이지·검색 인자)은
// 캐시하지 않는다 — 자유 텍스트 검색어가 캐시 키에 들어가면 셀이 무한히 늘어난다.
const cachedCitationTypeCategories = mirrorCache("citation-type-categories",
  (filters: StandardFilters) =>
    aggregateCitationTypeCategoriesFromMirror(filters, undefined, {
      statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
      budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
    }));
const cachedCitationToneSummary = mirrorCache("citation-tone-summary",
  (filters: StandardFilters) =>
    aggregateCitationToneSummaryFromMirror(filters, undefined, {
      statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
      budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
    }));

const cachedKpiAppliedPrompts = mirrorCache("kpi-applied-prompts",
  (filters: StandardFilters) => countCatalogPromptsFromCatalog(filters, undefined));

// ── 인용 탭 카테고리 Δ 의 기준점 = **직전 회차 자리** (제품 책임자 2026-09-29) ──────────────
//
// 종전 셀(`citation-categories-prev`)은 기준점을 **직전 측정일**(`latestMeasureDays` →
// `dateTo = days[1]`, measured_at 날짜)로 잡았다. 회차는 며칠에 걸쳐 드레인되므로 그것은
// 같은 회차의 부분 데이터였고, 카테고리 막대 Δ 가 카드 Δ 와 **방향까지** 갈렸다
// (프리뷰 7df9118 · Kia/KR · 9/28 회차: 카드 ↘4.0pp · 막대 공식(HMG) ↗3.9pp).
//
// 이제 기준점은 Overview 카드 Δ(`overviewCardDelta`)가 쓰는 **바로 그 자리**다:
//   · 필터   — `overviewReadFilters` → `deltaTrendFilters`(카드 Δ 와 같은 인자)
//   · 자리   — 그 추이 배열에서 ⑤ 값이 있는 마지막 두 자리 중 **앞 자리**
//   · 회차   — 그 자리의 회차들(추이 경로와 같은 회차 집합·자리 규칙·인용 계열 회차)
//   · 값     — 그 회차들의 group_key 인용 수를 카테고리 차트와 같은 분류로 합산
// 그래서 공식(HMG) 막대의 Δ = 인용 현황 카드 Δ = Overview 카드 Δ 이고, 딜러·다른 카테고리도
// 같은 직전 회차 기준이다. measured_at 날짜는 쓰지 않는다.
//
// 집계층 추이가 아니면(미러 폴백 — 버킷에 회차 표식이 없다) **기준점이 없다**(`null` =
// 카테고리 Δ 생략). 측정일 스냅샷으로 되돌아가지 않는다 — 그것이 이 결함이다.

type PrevCategories = { totals: CitationCategoryTotals; asOf: string };

/** 한 자리 회차들의 group_key 인용 수 → 카테고리 합계. 셀 반환은 직렬화 가능한 값만. */
const cachedCitationCategoriesPrevRound = mirrorCache("citation-categories-prev-round",
  async (
    _cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
  ): Promise<CitationCategoryTotals | null> => {
    const [read, overrides] = await Promise.all([
      readGlobalSlotGroupCitations(globalTrendScopeOf(set, ownVariant, filters)),
      loadCitationOverrides(),
    ]);
    if (read.empty) return null;
    const byCategory: Record<string, number> = {};
    for (const [key, n] of read.value.groups) {
      const cat = resolveCitationCategory(null, key, overrides);
      byCategory[cat] = (byCategory[cat] ?? 0) + n;
    }
    return { total: read.value.total, byCategory };
  },
  [SUMMARY_TAG, CITATION_OVERRIDES_TAG]);

async function citationCategoriesPrevRound(filters: StandardFilters): Promise<PrevCategories | null> {
  const rootId = getStandardRootId();
  if (!rootId) return null;
  // ① 카드 Δ 와 **같은 배열**(`fetchStandardOverviewCardDelta` 와 같은 인자 — 요청 dedup 적중).
  const f = overviewReadFilters(filters);
  const df = deltaTrendFilters(f);
  const buckets = await fetchStandardTrend(df, DELTA_TREND_BUCKET);
  const valued = buckets.filter((b) => typeof overviewTrendValues(b).citationShare === "number");
  if (valued.length < 2) return null;
  const prev = valued[valued.length - 2];
  if (!prev.cycleAnchorAt) return null; // 미러 폴백 — 회차 자리가 없다(위 주석)
  const slotKey = prev.roundDate ?? prev.bucketStart;
  // ② 그 배열을 만든 **같은 회차 집합**(`fetchStandardTrendImpl` → `viaGlobalSeries` 와 같은 순서).
  const slots = await trendSlotsFor({
    surface: "global", projectIds: rootProjectIdsForGaps(), family: "all",
    filters: df, unit: DELTA_TREND_BUCKET,
  });
  const sf = globalSeriesFilters(withTrendGridWindow(df, slots), Date.now(), trendGridDateFloor(slots));
  const route = await globalPeriodRoute(rootId, sf, "S1.dashboard");
  if (route.path !== "summary") return null;
  const { set } = restrictToTrendSlotSet(globalCycleSetOf(route));
  const plan = planTrendRead({ surface: "global", filters: df });
  if (!plan.ok) return null;
  // ③ 그 자리의 회차 — 버킷 키 함수도 추이와 같은 것(`trendDayKeyOf`, 축 on = 귀속 날짜).
  //    인용 계열이 읽는 회차 목록에서 고른다(도메인 문장과 같은 스코프).
  const dayKey = trendDayKeyOf(set);
  const cycles = citationCyclesOf(set).filter((c) => dayKey(c.cycleAnchorAt) === slotKey);
  if (cycles.length === 0) return null;
  const slotSet: CycleSet = {
    surface: set.surface,
    mode: set.mode,
    cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: set.projectIds,
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: cycles.length,
  };
  const totals = await cachedCitationCategoriesPrevRound(slotSet.cycleKey, slotSet, plan.ownVariant, sf);
  if (!totals) return null;
  // 같은 자리·같은 게이트면 분모가 추이 버킷과 같아야 한다 — 어긋나면 조용히 넘기지 않는다.
  if (totals.total !== prev.totalCitations) {
    console.error(
      `[citation-categories-prev-round] slot ${slotKey} total ${totals.total} ≠ trend bucket ${prev.totalCitations}`,
    );
  }
  return { totals, asOf: slotKey };
}

export async function fetchStandardCitationCategoriesPrev(
  filters: StandardFilters = {},
): Promise<PrevCategories | null> {
  return kpiDegrade("citationCategoriesPrev", () =>
    withStandardRoot("standardCitationCategoriesPrev",
      null as PrevCategories | null,
      citationCategoriesPrevRound, filters),
  );
}

const cachedUnmeasuredPrompts = mirrorCache("kpi-unmeasured-prompts",
  (filters: StandardFilters) =>
    listUnmeasuredPromptsFromCatalog(filters, undefined, {
      statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
      budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
    }));

/** 측정 개요 카드 "미측정" 모달의 목록(글로벌). null = 스코프 없음 또는 degrade. */
export async function fetchStandardUnmeasuredPrompts(
  filters: StandardFilters = {},
): Promise<{ total: number; rows: UnmeasuredPrompt[] } | null> {
  return kpiDegrade("unmeasuredPrompts", () =>
    withStandardRoot("standardUnmeasuredPrompts",
      null as { total: number; rows: UnmeasuredPrompt[] } | null,
      cachedUnmeasuredPrompts, filters),
  );
}

// ── 집계층 경로 — 글로벌 **추이 3종** (PR③) ─────────────────────────────────
//
// `fetchStandardTrend`(카드 시계열·스파크·Δ) · `fetchStandardKpiBrandTrend`(브랜드 라인) ·
// `fetchStandardKpiFirstPosition`(우선노출도)을 **한 read 3문장**으로 낸다. 프로덕션
// 실측(2026-09-11, 게이트 ON): 카드·GEO 1.30 s 도착 뒤 이 셋이 **37~38 s** 를 더 썼다.
//
// 위 `viaGlobalTrend` 와 다른 것 셋:
//   ① **기간 모드**다(`opts.mode = "period"`). 스냅샷 게이트는 회차 1개만 고르므로
//      시계열이 될 수 없다. 기간 판정의 폴백 사유는 `cycle-set.ts` 머리 주석.
//   ② **회차 ≥ 2 가 아니면 미러**다. 점 하나짜리 차트는 차트가 아니고, Δ 는 값 2개
//      미만이면 통째로 사라진다(`applyTrendDeltas`). 2026-09-11 실측으로 노출 가능한
//      글로벌 회차는 8/31 **하나**다 — 과거 회차가 백필되면 이 조건이 저절로 참이 되어
//      켜진다(코드 재수정 없음).
//   ③ 폴백 목적지가 **미러 하나**다. 추이에는 세부층 쌍둥이가 없다(사실표는 스냅샷
//      표면이다) — `viaGlobalTrend` 의 3층(게이트→세부층→미러)이 여기서는 2층이다.
//
// 창은 **13주 하나**를 읽고 화면별 `trendDays` 로 JS 에서 자른다. 창을 화면마다 다르게
// 잡으면 회차 집합이 갈려 read 가 3벌이 된다 — 그게 extras 가 느렸던 구조다.

/** 집계층 추이가 읽는 창(일). 13주 — 미러의 120일 안전창보다 좁고 회차 13개를 덮는다. */
export const G_TREND_WINDOW_DAYS = 91;

/** 시계열이 되려면 점이 둘 이상이어야 한다. 미만이면 미러 유지. */
export const G_TREND_MIN_CYCLES = 2;

/**
 * 읽기 창 = 화면 기간 ∩ 13주. 세 화면이 **같은 창**을 읽어야 read 가 한 벌이다.
 *
 * ⚠️ **Δ 전용 창(`deltaTrendFilters`, 최근 30일)을 그대로 쓰면 안 된다**(검증자 GG-4).
 *    그 창은 미러의 전 이력 스캔을 상수화하려고 붙인 것이고, 집계층에서는 창이 다르면
 *    **회차 집합·라우트 셀·코어 read 가 통째로 갈린다** — 이 파일이 스스로 경고한
 *    "창을 화면마다 다르게 잡으면 read 가 여러 벌" 이 바로 그것이다. 그래서 사용자가
 *    기간을 지정하지 않은 경우(= `deltaTrendFilters` 가 30일을 얹는 유일한 경우)에는
 *    **그 30일 바닥을 걷어내고 13주로 되돌린다**. Δ 는 `applyTrendDeltas` 가 값 있는
 *    마지막 두 점을 보므로 창이 넓어져도 "직전 회차 대비" 라는 의미는 그대로다.
 */
/**
 * ⚠️ **격자(D5)가 켜지면 바닥은 상수가 아니라 자리에서 온다**(검증 B1, 2026-09-20).
 *
 * 초판 주석은 "격자 13자리는 최대 84일 폭이라 91일이 항상 덮는다" 였고 **틀렸다.**
 * 84일은 첫 자리와 **끝 자리** 사이 간격인데 바닥은 **`now`** 기준이다. 그래서 조건은
 * `now - firstSlot > 91` ⟺ **`now > lastSlot + 7일`** 이고, 그때 가장 오래된 자리가
 * 회차 집합에서 빠져 **없던 결측이 화면에 뜬다**(실측 자리 06-22…09-14 에 now=09-22 면
 * 바닥 06-23 > 06-22). 회차가 한 주만 늦어도 매주 1~2일은 이 상태가 되고, 케이던스가
 * 멈추면 **멈춘 주 수만큼 오래된 자리가 동시에** 거짓 갭이 된다(끝의 미발행 자리는
 * `trimTrailingUnpublished` 가 잘라 내므로 끝 자리가 과거에 고정되기 때문이다).
 *
 * 그래서 `gridFloor` 가 오면 **그것이 바닥**이다. 91일 상수는 격자가 없을 때의 값으로만
 * 남는다(자리 목록 자체는 `TREND_GRID_MAX_DAYS` 180일 상한 안에서 만들어진다).
 * 사용자가 더 좁은 기간을 고른 경우는 종전대로 아래 `raw > floor` 가지가 이긴다.
 */
export function globalSeriesFilters(
  f: StandardFilters,
  now: number = Date.now(),
  /** 가장 오래된 자리의 날짜(`YYYY-MM-DD`). 격자가 없으면 `null`. */
  gridFloor: string | null = null,
): StandardFilters {
  const floor =
    gridFloor ?? new Date(now - G_TREND_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const deltaFloor = new Date(now - DELTA_TREND_WINDOW_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  // Δ 페처가 얹은 30일 바닥은 화면 기간이 아니다 — 지우고 13주로 통일한다.
  const raw = f.dateFrom === deltaFloor && !f.dateTo ? undefined : f.dateFrom;
  const from = raw && raw > floor ? raw : floor;
  return { ...f, dateFrom: from };
}

/**
 * 기간 판정 — **화면 키가 캐시 키에 없다**(PR① R2 규율, 검증자 GG-3).
 *
 * 한 렌더가 같은 필터로 화면 키를 셋(`S1.dashboard`·`S1.brandTrend`·`S1.firstPosition`)
 * 부르므로, 화면을 키에 넣으면 **같은 판정이 3번** 돌고 원장·회차 프로브 왕복이 그만큼
 * 늘어난다. 화면 검사는 판정 **밖**에서 얹는다(`applyScreenGate`) — hit 을 폴백으로
 * 낮출 뿐 폴백 사유를 바꾸지 않는다.
 */
const cachedGlobalPeriodBase = cache(async (key: string): Promise<SummaryReadRoute> => {
  const { r, f } = JSON.parse(key) as { r: string | null; f: StandardFilters };
  return resolveGlobalSummaryRouteBase(r, f, { mode: "period" });
});

const globalPeriodRoute = async (
  rootId: string | null,
  f: StandardFilters,
  screen: SummaryScreenKey,
  /**
   * 카드 정렬 우회(`applyScreenGateAligned`). `null`(기본) = 종전 `applyScreenGate` 와
   * 같은 결과·같은 로그다. 유일한 사용처는 `fetchStandardKpiBrandTrend` 의 KPI 탭 + 격자 on.
   */
  align: ScreenGateAlign | null = null,
): Promise<SummaryReadRoute> => {
  const { route, aligned } = await applyScreenGateAligned(
    await cachedGlobalPeriodBase(JSON.stringify({ r: rootId, f })),
    screen,
    align,
  );
  if (!(route.path === "mirror" && route.reason === "disabled")) {
    // 우회했으면 **화면 키는 그대로 두고** 꼬리표로 말한다 — 이 줄만 보고도 "옵트인은
    // 꺼져 있는데 카드 키로 hit 했다" 가 읽혀야 한다.
    const via = aligned && align
      ? ` opt-in-bypass:${align.reason}(${screen} off, gate=${align.screen})`
      : "";
    console.info(
      `x-hmg-summary(global ${screen} period): ${summaryRouteHeaderValue(route)}${via}`,
    );
  }
  return route;
};

// ── 셀 3개: 코어(2문장) · 브랜드 스냅샷(1문장) · 브랜드 회차축(1문장) ──────────
// 셋 다 `SUMMARY_TAG` 를 단다(러너 스왑이 한 번에 무효화한다).

const cachedGlobalSeriesCore = mirrorCache("summary-global-trend-core",
  async (
    _cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
  ): Promise<SummaryTrendRead<GlobalTrendSeries>> =>
    readGlobalTrendCore({
      ...globalTrendScopeOf(set, ownVariant, filters),
      // 글로벌 ⑤ 분자(공식(HMG) 카테고리) — 회차별 값이 도메인 문장의 한 열로 나온다
      // (추가 문장·추가 행 0). 카드(S1 `group` 축 JS 분류)와 같은 분류 함수다.
      officialGroupKeys: await officialHmgKeysForSet(set),
    }),
  [SUMMARY_TAG]);

const cachedGlobalBrandSnapshot = mirrorCache("summary-global-trend-brand-snapshot",
  async (
    _cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
  ): Promise<SummaryTrendRead<GlobalTrendBrandPoint[]>> =>
    readGlobalBrandSnapshot(globalTrendScopeOf(set, ownVariant, filters)),
  [SUMMARY_TAG]);

const cachedGlobalBrandSeries = mirrorCache("summary-global-trend-brand-series",
  async (
    _cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
    brandNames: string[],
  ): Promise<SummaryTrendRead<Array<[string, GlobalTrendBrandPoint[]]>>> => {
    const out = await readGlobalBrandSeries(globalTrendScopeOf(set, ownVariant, filters), brandNames);
    // `Map` 은 캐시 직렬화를 통과하지 못한다 — 엔트리 배열로 저장하고 호출부가 되살린다.
    return out.empty ? out : { empty: false, value: [...out.value] };
  },
  [SUMMARY_TAG]);

/** 요청 안에서 페처들이 같은 read 를 쓴다(콜드 키에서 DB 를 여러 번 치지 않게). */
const requestGlobalCore = cache(async (key: string): Promise<SummaryTrendRead<GlobalTrendSeries>> => {
  const { set, v, f } = JSON.parse(key) as { set: CycleSet; v: string; f: StandardFilters };
  return cachedGlobalSeriesCore(set.cycleKey, set, v, f);
});

/**
 * 브랜드 2단 — 스냅샷 회차(집합의 **마지막 회차**)에서 top-N 을 고르고, 그 이름으로만
 * 회차 축을 읽는다. 두 화면(브랜드 추이·우선노출도)이 같은 결과를 나눠 쓴다.
 */
const requestGlobalBrands = cache(async (key: string): Promise<SummaryTrendRead<GlobalTrendSeries>> => {
  const { set, v, f, cap } = JSON.parse(key) as {
    set: CycleSet; v: string; f: StandardFilters; cap: number;
  };
  const core = await requestGlobalCore(JSON.stringify({ set, v, f }));
  if (core.empty) return core;
  // 1단 — 마지막 회차만 담은 집합으로 스냅샷을 읽는다(브랜드 표 1회차 스캔).
  const lastAnchor = set.cycles.reduce((a, b) => (a.cycleAnchorAt > b.cycleAnchorAt ? a : b));
  const snapSet: CycleSet = {
    ...set,
    mode: "snapshot",
    cycles: [lastAnchor],
    cycleKey: `${lastAnchor.cycleId}:${lastAnchor.generationId}`,
    weeks: [lastAnchor.cycleWeek],
    anchorCount: 1,
  };
  const snap = await cachedGlobalBrandSnapshot(snapSet.cycleKey, snapSet, v, f);
  if (snap.empty) return { empty: true };
  const names = pickSeriesBrands(snap.value, cap).map((b) => b.brand);
  // 2단 — 고른 이름으로만 회차 축.
  const series = await cachedGlobalBrandSeries(set.cycleKey, set, v, f, names);
  if (series.empty) return { empty: true };
  return {
    empty: false,
    // 코어 버킷과 **같은 키 함수**를 쓰도록 집합을 넘긴다(축 on = 귀속 날짜).
    value: attachBrandSeries(core.value, new Map(series.value), snap.value, set),
  };
});

/**
 * 경쟁사 Δ 전용 2단 — **1단이 없다**(PR④ B2).
 *
 * `requestGlobalBrands`(위)는 스냅샷 회차를 한 번 더 읽어 top-N 을 고른다. 경쟁사 행은
 * 그 선정이 **이미 값 행에서 끝나 있다** — B1 이 카드 셀에서 받아 온 브랜드 축으로
 * 화면 규칙(`competitorDeltaBrands`)을 적용해 이름을 정하기 때문이다. 그래서 여기서는
 * 1단(스냅샷 문장 1개)을 통째로 건너뛰고 **회차 축 문장 1개**만 낸다.
 *
 * 그 결과 이 경로가 내는 문장은 **코어 2개(own·domains) + 브랜드 회차 축 1개**이고,
 * 코어 2개는 `fetchStandardTrend`(카드 스파크·Δ)와 **같은 셀**이다(같은 창·같은 필터
 * → `requestGlobalCore` 요청 캐시 적중). 즉 이 경계가 실제로 더 내는 문장은 1개다.
 *
 * ⚠️ `totals`(시리즈 모집단)도 밖에서 받는다 — 여기서 다시 고르면 화면이 그리는 4개와
 *    어긋난다. `pickSeriesBrands` 가 이 모집단 위에서 cap 을 적용하므로, 넘기는 순서가
 *    곧 시리즈 순서다(`competitorDeltaBrands` 가 결정적으로 정렬한다).
 */
const requestGlobalCompetitorSeries = cache(
  async (key: string): Promise<SummaryTrendRead<GlobalTrendSeries>> => {
    const { set, v, f, names, totals } = JSON.parse(key) as {
      set: CycleSet; v: string; f: StandardFilters;
      names: string[]; totals: GlobalTrendBrandPoint[];
    };
    const core = await requestGlobalCore(JSON.stringify({ set, v, f }));
    if (core.empty) return core;
    // 그릴 브랜드가 없으면 회차 축을 읽지 않는다 — 빈 시리즈는 빈 Δ 이고, 그것이 맞다
    // (경쟁사 행 자체가 비어 있다는 뜻). `empty:true`(= 미러 폴백)로 올리면 안 된다.
    if (names.length === 0) {
      return { empty: false, value: { buckets: core.value.buckets, brandTotals: [] } };
    }
    const series = await cachedGlobalBrandSeries(set.cycleKey, set, v, f, names);
    if (series.empty) return { empty: true };
    return {
      empty: false,
      // 위와 같은 이유로 집합을 넘긴다.
      value: attachBrandSeries(core.value, new Map(series.value), totals, set),
    };
  },
);

/** 화면이 고른 경쟁사 행 → 시리즈 모집단. `mentions` 만 cap 정렬에 쓰인다. */
function competitorSeriesTotals(
  brands: CompetitorBrandValue[],
  names: readonly string[],
): GlobalTrendBrandPoint[] {
  const by = new Map(brands.map((b) => [b.brand, b]));
  return names.map((name) => {
    const b = by.get(name);
    return {
      brand: name,
      isTracked: b?.isTracked === true,
      mentions: b?.mentions ?? 0,
      // 나머지는 **버킷에서 온다** — 모집단 행의 값은 cap 정렬에만 쓰이고 그려지지
      // 않는다(`toBrandTrend`/`toFirstPosition` 은 버킷의 `byBrand` 를 본다).
      // ⚠️ 예외 하나: `toFirstPosition` 의 `latest` 는 **최신 회차 버킷**을 보되, 창 밖
      //    브랜드는 여기 행이 `mentions: 0` 으로 등록될 뿐이라 순위는 여전히 버킷 값이다.
      answers: 0,
      rankSum: 0,
      rankedAnswers: 0,
      compRankSum: 0,
      compRankedAnswers: 0,
    };
  });
}

/**
 * 창 안 회차 **전부**가 접혀 있는가 — 검사 대상 표는 그 화면이 실제로 읽는 것만이다
 * (검증자 GG-7). `fetchStandardTrend` 는 `brands` 를 안 읽으므로 그 표의 접기 누락을
 * 이유로 카드 추이를 미러로 돌리면 근거 없는 폴백이 된다.
 */
const cachedGlobalSeriesFoldPresent = cache(async (key: string): Promise<boolean> => {
  const { set, tables } = JSON.parse(key) as {
    set: CycleSet;
    tables: TrendStatementKey[];
  };
  return timedFoldProbe("global", tables, trendFoldPresent("global", set, tables));
});

/**
 * 판정 경로에서 **글로벌 회차 집합만** 벗겨낸다(웹사이트 쪽 `cycleSetOf` 의 쌍둥이).
 * 관측값(`openRuns`)이 캐시 키에 섞이지 않게 순수 `CycleSet` 필드만 옮긴다.
 */
const globalCycleSetOf = (
  route: Extract<SummaryReadRoute, { path: "summary" }>,
): CycleSet => ({
  surface: route.surface,
  mode: route.mode,
  cycles: route.cycles,
  cycleKey: route.cycleKey,
  projectIds: route.projectIds,
  missingProjectIds: route.missingProjectIds,
  weeks: route.weeks,
  anchorCount: route.anchorCount,
  // ⚠️ **인용 제외 목록은 격자 키가 켜졌을 때만 싣는다**(2026-09-20).
  //
  // 종전 세 게이트(`viaGlobalSeries`·`viaGlobalS1`·웹사이트 `cycleSetOf`)는 이 필드를
  // 손으로 열거한 8칸에서 **빠뜨렸다**. 그래서 0071(`hidden_scope='citations'`) 규칙이
  // 집계층 경로에 한 번도 도달하지 않았고, 그것에 기대는 두 판정이 같이 죽어 있었다:
  //   · `restrictToSlotRepresentative` 의 "그 계열에서 숨김이 아닌 회차가 대표다"
  //   · 리더의 인용 회차 스코프(`citationCyclesOf` → `summary-trend-aggregates.ts:621`)
  // 자리 대표를 고르기 시작하면 이 구멍이 값으로 드러난다 — 8/24 자리처럼 정상 회차와
  // 인용 숨김 회차가 같이 걸린 자리에서 **숨김 회차가 대표로 뽑힌다**.
  //
  // 싣는 것을 격자 키 뒤에 두는 이유: 이 필드는 리더의 인용 분자·분모를 직접 바꾸는데
  // (`summary-trend-aggregates.ts:614·738`) 그 소비는 격자와 무관하다. 무조건 실으면
  // **키를 꺼도 값이 바뀐다**. 격자 on 의 신호는 `completionRatio` 하나다(`trendGridApplied`).
  ...(trendGridApplied(route) && route.citationExcludedCycleIds
    ? { citationExcludedCycleIds: route.citationExcludedCycleIds }
    : {}),
});

/**
 * 자리 거르기의 **관측 로그 한 벌**. 추이와 카드가 같은 문구를 내야 "두 경로가 같은
 * 집합을 읽는다" 를 로그만으로 대조할 수 있다(`tag` 만 다르다).
 *
 * `hit cycles:<n>` 헤더는 거르기 **전** 수라, 이 줄들이 없으면 점 개수·모수가 안 맞는
 * 이유를 로그만 보고는 알 수 없다(`skipped:` 를 붙인 것과 같은 이유).
 */
function logTrendSlotRestriction(tag: string, r: TrendSlotRestriction): void {
  if (r.mergedSlots.length > 0) {
    console.info(
      `x-hmg-summary(${tag}): slot-merged:${r.mergedSlots.join(",")} → cycles:${r.repAnchorCount}`,
    );
  }
  if (r.familySplitSlots.length > 0) {
    // 계열별 대표가 갈린 자리(N3) — 그 자리에서 언급과 인용이 **다른 회차**를 읽는다.
    // 값이 틀린 것이 아니라 모집단이 계열마다 다른 것이라, 로그가 없으면 나중에
    // "왜 이 자리만 인용 분모가 다르지" 를 추적할 길이 없다.
    console.info(`x-hmg-summary(${tag}): family-split:${r.familySplitSlots.join(",")}`);
  }
  if (r.gapDays.length > 0) {
    console.info(
      `x-hmg-summary(${tag}): completion-gap:${r.gapDays.join(",")} → cycles:${r.set.anchorCount}`,
    );
  }
  if (r.fleetHidden > 0) {
    console.info(
      `x-hmg-summary(${tag}): fleet-hidden:${r.fleetHidden} → cycles:${r.set.anchorCount}`,
    );
  }
}

/**
 * 집계층 시계열 → 화면 하나분. 폴백은 **전부 미러**다(추이엔 세부층 쌍둥이가 없다).
 * `pick` 은 순수 매핑이라 실패하지 않는다 — 실패 지점은 전부 이 함수 안에 있다.
 */
async function viaGlobalSeries<T>(
  filters: StandardFilters,
  screen: SummaryScreenKey,
  read: (key: string) => Promise<SummaryTrendRead<GlobalTrendSeries>>,
  /**
   * `gapDays` = 완결성 미달로 **값에서 뺀 자리**(설계 §4-A, `X.trendGrid` 가 꺼져 있으면
   * 항상 빈 배열). 카드 시계열만 그 자리에 갭 슬롯을 끼우고, 나머지 pick 은 무시한다 —
   * 브랜드·우선노출도 차트의 갭 표현은 격자 모듈(PR②)이 통일할 자리다.
   */
  pick: (series: GlobalTrendSeries, gapDays: readonly string[]) => T,
  onMirror: () => Promise<T>,
  /** 이 화면이 실제로 읽는 표 — 접기 존재 검사 대상(GG-7). */
  tables: TrendStatementKey[],
  extraKey: Record<string, unknown> = {},
  /**
   * 가장 오래된 자리의 날짜(검증 B1). 주면 **회차 집합의 바닥**이 그것이 된다 —
   * `now - 91일` 상수는 `now > lastSlot + 7일` 인 순간 그 자리를 잘라 거짓 결측을
   * 만든다. 격자가 없으면 `null` = 종전 상수.
   */
  gridFloor: string | null = null,
  /**
   * 카드 정렬 우회(`globalPeriodRoute` → `applyScreenGateAligned`). `null`(기본) = 종전.
   * 우회는 **화면 검사 한 단계**만 건너뛴다 — 아래 폴백(회차 1개·plan·접기·빈 결과)은
   * 전부 그대로 미러로 간다.
   */
  align: ScreenGateAlign | null = null,
): Promise<T> {
  const rootId = getStandardRootId();
  if (!rootId) return onMirror();
  const f = globalSeriesFilters(filters, Date.now(), gridFloor);
  const route = await globalPeriodRoute(rootId, f, screen, align);
  if (route.path !== "summary") return onMirror();
  // ① 자리 규칙 **한 벌**(`cycle-set.ts::restrictToTrendSlotSet`): 함대 대표 → 자리
  //    대표 → 완결성. 판정·캐시 키·회차 하한이 전부 **거른 뒤 집합**을 봐야 하므로
  //    가장 먼저 좁힌다. 누적·스냅샷은 이 규칙을 타지 않는다.
  //    ⚠️ 카드 게이트(`viaGlobalS1`)도 **같은 함수**를 부른다 — 한 화면의 카드와 추이가
  //       같은 자리에서 다른 회차 집합을 읽던 결함(2026-09-20 메인 실측 8/17 자리
  //       14.0% vs 6.5%)이 규칙을 두 벌로 둔 데서 나왔다.
  const restricted = restrictToTrendSlotSet(globalCycleSetOf(route));
  const { set, gapDays } = restricted;
  logTrendSlotRestriction(`global ${screen} period`, restricted);
  // ② 점이 하나면 시계열이 아니다 — 백필 전까지 미러 유지.
  if (set.anchorCount < G_TREND_MIN_CYCLES) {
    console.info(
      `x-hmg-summary(global ${screen} period): fallback:agg-single-cycle(${set.anchorCount}) → mirror`,
    );
    return onMirror();
  }
  const plan = planTrendRead({ surface: "global", filters });
  if (!plan.ok) {
    console.info(`x-hmg-summary(global ${screen} period): fallback:${plan.reason} → mirror`);
    return onMirror();
  }
  // 창 안의 회차 **전부**가 접혀 있어야 한다. 하나라도 비면 시계열에 구멍이 생기고,
  // 구멍은 "그 회차에 성과가 0" 으로 읽힌다. 발행은 read 와 동시다(A1).
  const gated = await foldGated(
    cachedGlobalSeriesFoldPresent(JSON.stringify({ set, tables })),
    () => read(JSON.stringify({ set, v: plan.ownVariant, f, ...extraKey })),
  );
  if (!gated.folded) {
    console.info(`x-hmg-summary(global ${screen} period): fallback:agg-fold-missing → mirror`);
    return onMirror();
  }
  const out = gated.value;
  if (out.empty) {
    console.info(`x-hmg-summary(global ${screen} period): fallback:agg-empty → mirror`);
    return onMirror();
  }
  return pick(out.value, gapDays);
}

/**
 * KPI 탭 추이가 보는 **지면 스코프**. 오늘 이 탭의 페처는 글로벌 하나뿐이지만
 * (`fetchStandardKpi*`), 값을 **인자로** 받는다 — website·프로젝트에 같은 탭이 생겼을 때
 * 글로벌 자리를 조용히 상속하면 그 화면만 축이 월요일로 서고(website 자리는 금요일)
 * 아무도 못 잡는다.
 */
interface KpiTrendScope {
  surface: CycleSurface;
  projectIds: string[];
  family: "mentions" | "citations";
  /**
   * 화면이 고른 기간(검증 C1). 이 탭의 값도 기간 술어를 타므로(`kpiTabTrendWhere` →
   * `detailAnswerWhere` 의 앵커 기간 조각) 자리도 같은 기간 안이어야 한다.
   */
  filters: StandardFilters;
}

/** 글로벌 4-KPI 탭 — Overview(`fetchStandardTrend`)와 **같은 표면·같은 스코프**. */
const globalKpiTrendScope = (
  filters: StandardFilters,
  family: "mentions" | "citations" = "mentions",
): KpiTrendScope => ({
  surface: "global",
  projectIds: rootProjectIdsForGaps(),
  family,
  filters,
});

/**
 * KPI 탭 추이가 쓰는 **자리 목록**. 인자가 스코프 하나뿐이라 `buildTrendGrid` 의
 * 요청 단위 dedup(`cachedSlotRows`)이 그대로 먹는다 — 한 렌더가 이 함수를 네 번 불러도
 * 원장 왕복은 1회다.
 *
 * ⚠️ 글로벌 스코프는 **Overview 와 같은 인자여야 한다**(surface·projectIds). 이것이
 *    "같은 회차는 어느 화면에서나 같은 자리" 의 기계적 근거다. 다른 것은 계열뿐이고,
 *    계열은 숨김 판정에만 쓰인다(0071).
 */
function kpiTabTrendGrid(scope: KpiTrendScope): Promise<TrendSlot[] | null> {
  return trendSlotsFor(scope);
}

/**
 * KPI 탭 추이의 창 — **캐시 키이므로 날짜만 담는다**(검증 N4).
 *
 * 초판은 `trendGridWindowDays`(now 기준 일수)를 그대로 캐시 인자로 넘겼다. 그 값은
 * **UTC 자정마다 1 씩 는다**(실측 09-20T23:59Z → 92 · 09-21T00:01Z → 93). 그래서 키 on
 * 이면 매일 자정에 KPI 탭 추이 셀 3종이 전부 콜드가 됐다 — 종전 상수 84 는 안 갈렸고,
 * 같은 화면의 Overview 는 `dateFrom`(날짜 문자열)이라 주 단위로만 갈린다. 한 화면 안에서
 * **두 경로의 키 입도가 달랐다.**
 *
 * 그래서 키에는 **자리 목록의 첫·끝 날짜**를 넣고, 미러가 쓰는 일수는 셀 안에서 만든다.
 * `last` 는 값에 안 쓰이지만 키에는 넣는다 — 새 회차가 열려 끝 자리가 움직이면 셀이
 * 갈려야 하고, 그것이 원장 변경이 화면에 반영되는 경로다.
 */
interface KpiTrendWindow {
  /** 가장 오래된 자리(`YYYY-MM-DD`). 격자가 없으면 `null` = 종전 상수를 쓴다. */
  floor: string | null;
  /** 가장 최신 자리. 키 전용. */
  last: string | null;
  /** 격자가 없을 때의 일수(84·28). */
  fallbackDays: number;
}

/** 창 → 미러가 쓰는 일수. 바닥이 있으면 그 날짜까지(양 끝 포함), 없으면 종전 상수. */
function kpiWindowDays(w: KpiTrendWindow, now: number = Date.now()): number {
  if (!w.floor) return w.fallbackDays;
  const days = Math.ceil((now - Date.parse(`${w.floor}T00:00:00Z`)) / 86_400_000) + 1;
  return days > 0 ? days : w.fallbackDays;
}

/** 격자에서 창을 만든다. 격자가 없으면 날짜가 둘 다 `null` 이라 종전 동작과 같다. */
async function kpiTabTrendWindow(
  fallbackDays: number,
  scope: KpiTrendScope,
): Promise<KpiTrendWindow> {
  const slots = await kpiTabTrendGrid(scope);
  return {
    floor: trendGridDateFloor(slots),
    last: slots && slots.length > 0 ? slots[slots.length - 1].roundDate : null,
    fallbackDays,
  };
}

/**
 * KPI 탭 추이 3종에 **갭 후보 키**를 얹는다(0070). 결과가 null 이면 그대로 null.
 *
 * 캐시 밖에서 얹는 이유는 `fetchStandardTrend` 와 같다 — 원장 한 줄을 고치면 다음
 * 요청부터 반영돼야 한다. 값(숫자)은 하나도 안 바뀐다: 마커 후보 목록만 붙는다.
 */
async function withKpiTrendGaps<
  T extends {
    gapBuckets?: string[];
    trendGrid?: TrendGridSlotView[];
    buckets?: Array<{ bucketStart: string }>;
    typeTrend?: Array<{ bucketStart: string }>;
  },
>(
  result: T | null,
  unit: BucketUnit = "week",
  /**
   * 이 탭이 보는 지면 스코프. **표면·프로젝트·계열 셋이 한 덩어리**다 — 계열만 인자로
   * 받고 표면을 글로벌로 박아 두면 website 탭이 생겼을 때 금요일 자리 대신 월요일 자리를
   * 조용히 상속한다(계열(0071·앵커 §10.2)도 지면 단위다: 인용 지면이 `"mentions"` 로
   * 남으면 `hidden_scope='citations'` 회차를 **점으로** 그린다 — 값은 깨졌는데).
   */
  scope: KpiTrendScope,
  /**
   * 이 호출이 **격자 축을 쓰는 지면인가**. `false` 면 갭 후보 키만 얹고 자리 목록은 안
   * 싣는다(= 종전 축).
   *
   * 왜 스위치가 필요한가: 이 헬퍼를 쓰는 셋 중 브랜드 추이(`fetchStandardKpiBrandTrend`)
   * 는 **두 지면이 공유**한다 — 4-KPI 탭의 브랜드 라인차트(13자리 축)와 대시보드 경쟁사
   * 행의 **스파크라인**(28일, 직전 4회차)이다. 뒤쪽에 13자리 격자를 얹으면 4점짜리
   * 스파크가 13자리로 늘고 그중 9개가 `no-value` 갭이 된다 — 값이 없는 것이 아니라
   * **안 읽은 것**인데 화면은 결측으로 말한다. 지면 구분은 이미 있는 `weekAxis` 가 한다.
   */
  attachGrid = true,
): Promise<T | null> {
  if (!result) return result;
  // 숨긴 회차의 갭 후보 키 — 자리 목록과 **같은 스코프**를 본다(둘이 갈리면 축에 없는
  // 키에 마커가 붙거나, 남의 지면 숨김이 이 축에 찍힌다).
  const gapBuckets = await trendGapWeekKeys(
    unit,
    scope.surface,
    scope.projectIds,
    scope.family === "citations" ? "citation" : "mention",
  );
  // 공용 격자(D5) — 자리 목록을 화면까지 나른다. 키 off 면 `undefined` 라 `trendAxis`
  // 가 종전 `fillTrendGaps` 축을 만든다(바이트 무변경).
  //
  // ⚠️ **표면·자리 집합이 그 지면의 Overview 와 같아야 한다.** 글로벌 탭이 지금
  //    84일 창에 주 격자를 기계적으로 채우고 Overview 는 91일 창에 안 채워서, 같은
  //    회차가 두 화면에서 다른 x축에 서 있었다(설계 §1). 같은 인자 = 같은 격자다.
  const trendGrid = attachGrid
    ? toTrendGridSlotViews(await kpiTabTrendGrid(scope))
    : undefined;
  if (!gapBuckets && !trendGrid) return result;
  return {
    ...result,
    ...(gapBuckets ? { gapBuckets } : {}),
    ...(trendGrid ? { trendGrid } : {}),
    // 버킷 키를 자리 키로 맞추고 자리 밖 값을 버린다(`restrictToTrendGrid`). `typeTrend` 도 같은 축을
    // 쓴다고 그 타입이 선언하므로("buckets 와 같은 축") 함께 옮긴다 — 한쪽만 옮기면
    // 같은 탭의 유형 추이가 본문 추이와 한 칸 어긋난다.
    ...(trendGrid && result.buckets
      ? { buckets: restrictToTrendGrid([...result.buckets], trendGrid) }
      : {}),
    ...(trendGrid && result.typeTrend
      ? { typeTrend: restrictToTrendGrid([...result.typeTrend], trendGrid) }
      : {}),
  };
}

/**
 * 주별 Top-N 추이 2종(인용 도메인·유형 · 언급 브랜드)에 갭 슬롯(0070)을 얹고, 격자 키가
 * 켜져 있으면 **공용 자리 목록**(D5)으로 축을 다시 세운다.
 *
 * `trend`·`categoryTrend` 두 자리를 **함께** 덮는다 — 한쪽만 덮으면 같은 화면의 두 차트가
 * 다른 축을 그린다(위/아래가 한 칸 어긋나 보인다).
 *
 * ── 표면 인자가 **둘**인 이유 ──────────────────────────────────────────────
 *
 * 같은 함수 안에서 두 조회가 **반대 요구**를 한다.
 *   · 숨긴 회차 조회(`surface`) — 프로젝트 지면은 `null` 이다. 원장에 그 프로젝트의
 *     website 회차와 project 회차가 섞여 있고, 숨김은 둘 다 봐야 한다.
 *   · 자리 목록(`gridSurface`) — **반드시 가린다.** 안 가리면 금요일 자리(website)와
 *     앵커 일자 자리(project)가 같은 축에 서서 요일이 갈린다.
 * 그래서 둘을 한 인자로 합치지 않는다. 기본값도 두지 않는다(`family` 와 같은 규율) —
 * 새 콜사이트가 조용히 글로벌 자리를 상속하면 그 화면만 축이 다른 상태가 된다.
 */
interface WeeklyTrendGridRequest<T> {
  /** 숨김 회차 조회의 표면. 프로젝트 지면은 `null`(머리 주석). */
  surface: CycleSurface | null;
  /** 자리 목록의 표면 — 숨김 조회의 `surface` 와 **다른 값일 수 있다**(머리 주석). */
  gridSurface: CycleSurface;
  projectIds: string[];
  /** 계열(0071) — 기본값 없음. 지면이 정한다. */
  family: TrendGapFamily;
  /** 화면이 고른 기간(검증 C1). 기본값 없음. */
  filters: StandardFilters;
  /**
   * 값을 읽는다. **인자로 오는 필터를 써야 한다** — 그것이 자리 창으로 좁혀진 필터다
   * (검증 B1). 바깥 `filters` 를 클로저로 다시 읽으면 창이 갈린다.
   */
  read: (filters: StandardFilters) => Promise<T | null>;
}

async function withWeeklyTrendGrid<
  T extends { trend?: WeeklyTrend | null; categoryTrend?: WeeklyTrend | null },
>(req: WeeklyTrendGridRequest<T>): Promise<T | null> {
  const { surface, gridSurface, projectIds, family, filters } = req;
  // ── ⚠️ 읽기 필터를 **건드리지 않는다** (2026-09-20 회귀 수리) ──────────────
  //
  // 한 번 `withTrendGridWindow(filters, slots)` 로 좁혀서 넘긴 적이 있다. 그것이
  // **라이브 회귀**를 냈다: 이 페처들은 추이만 읽는 것이 아니라 **지면 전체**를 읽는다
  // (카드 스칼라·도메인 표·유형 분포·프롬프트 수). `dateFrom = slots[0]` 를 심으면 그
  // 본문 집계까지 13주 누적 창을 읽어, 기간 미선택 기본 화면(= 최신 회차)이 누적 모드로
  // 떨어지고 문장이 예산을 넘겼다. 고객 보고(제품 책임자, 통합 프리뷰 `/standard/answer-analysis/
  // citation`): "이 구간의 집계가 시간 안에 끝나지 않아 표시하지 않습니다" 반복 ·
  // 런타임 로그 `[kpi-tabs] standardCitations timed out` 60분에 10회 ·
  // `x-hmg-summary(global S3.citation): fallback:cumulative` · 실패 문장의 스냅샷
  // 서브쿼리에 `ca.round_date >= '2026-06-22'`(= S0). 언급 화면도 같은 구조였다.
  //
  // **자리 창은 추이에만 걸어야 한다.** 그 일은 이미 리더 쪽에서 한다:
  // `readMentionBrandDayCounts`·`readCitationDomainDayCounts` 가 `onTrendGrid` 를 받아
  // 자기 창 바닥만 자리 상한(`TREND_GRID_FLOOR_DAYS` 180)으로 넓힌다. 자리 목록 자체가
  // 180일 안에서 만들어지므로(`TREND_GRID_MAX_DAYS`) **모든 자리가 그 읽기 창 안**이고,
  // B1(121~180일 자리가 거짓 갭)은 그것으로 닫힌다. 축이 기간 밖으로 넓어지는 문제(C1)는
  // `trendSlotsFor` 가 `from`/`to` 로 자리를 좁혀서 닫는다. 즉 읽기 필터를 좁힐 이유가 없다.
  //
  // 캐시 키도 이 편이 옳다: 본문 값은 격자 on/off 에 같아야 하므로 자리 창이 키에 실리면
  // 불필요한 콜드만 는다. 격자 토글로 셀을 가르는 것은 `TREND_GRID_CACHE_SLOT` 이 한다.
  const slots = await trendSlotsFor({
    surface: gridSurface,
    projectIds,
    // 계열 어휘가 둘이다 — viz 쪽은 단수(`mention`), 앵커 쪽은 복수형이다.
    family: family === "citation" ? "citations" : "mentions",
    filters,
  });
  // **사용자의 원래 필터**로 읽는다(위 주석).
  const result = await req.read(filters);
  if (!result) return result;
  if (!result.trend && !result.categoryTrend) return result;
  const gapWeeks = await weeklyGapWeeks(surface, projectIds, family);
  const views = toTrendGridSlotViews(slots);
  if (gapWeeks.length === 0 && views === undefined) return result;
  const apply = (w: WeeklyTrend | null): WeeklyTrend | null =>
    // 순서는 버킷 경로와 같다: 0070 마커가 먼저, 격자가 나중. 반대로 하면 마커를 얹을
    // 행이 아직 없다.
    applyTrendGridToWeeklyTrend(applyWeeklyTrendGaps(w, gapWeeks), views ?? null);
  const trend = apply(result.trend ?? null);
  const categoryTrend = apply(result.categoryTrend ?? null);
  if (trend === (result.trend ?? null) && categoryTrend === (result.categoryTrend ?? null)) {
    return result;
  }
  return {
    ...result,
    ...(result.trend !== undefined ? { trend } : {}),
    ...(result.categoryTrend !== undefined ? { categoryTrend } : {}),
  };
}

// ── 4-KPI 탭 추이의 **주 격자 축** (2026-09-18) ────────────────────────────
//
// 화면 키 `S2.mentionTrend` 를 재사용한다 — 새 키를 두지 않는 이유가 이 PR 의 핵심이다.
// 그 키는 이미 같은 탭의 "주별 브랜드 언급 수" 추이(`fetchStandardMentions`)를 원장 회차
// 주로 옮겼고 **프로덕션에서 켜져 있다**. 새 키를 만들면 기본 off 로 나가므로, 같은
// 화면에서 언급 수 추이만 회차 주이고 나머지 추이 3종은 측정시각 주인 상태 —
// 정확히 이 PR 이 고치려는 결함 — 가 배포 직후 다시 생긴다. 키 하나 = 탭 하나의 축 하나.
// (`screens.ts` 의 그 키 블록도 대상을 "언급 탭 추이 차트"로 적고 있다. 단수가 아니다.)
//
// **판정은 캐시 바깥**이다(`fetchStandardMentions` 와 같은 규율) — 설정을 고치면 다음
// 요청부터 반영돼야 하는데 안쪽이면 TTL 만큼 굳는다. `summaryScreenAllowed` 는
// `summary_settings` 원문을 30초 메모로 읽으므로 DB 왕복이 늘지 않는다.
async function kpiTabWeekSource(axis: KpiTabWeekAxis | undefined): Promise<TrendWeekSource> {
  if (axis !== "S2.mentionTrend") return "measured";
  return (await summaryScreenAllowed("S2.mentionTrend")) ? "cycle" : "measured";
}

/**
 * 추이 주 격자 축의 결정권 — **호출 표면이 정한다**.
 *
 * · 생략/`"measured"`(기본) — 종전 `date_trunc('week', measured_at)`.
 *   **대시보드 경쟁사 행**(`fetchStandardCompetitorSources`)이 이 기본값을 쓴다.
 *   그 지면은 카드 ①~⑤·경쟁사 값이 자기 축(`S1.competitors` 회차 스냅샷)을 갖고
 *   있어 여기서 같이 옮기면 범위가 이 PR 밖으로 샌다.
 * · `"S2.mentionTrend"` — 그 화면 키가 정한다(on 이면 원장 회차 주).
 *   **글로벌 답변분석 > 언급 KPI 탭 전용.** 값을 키 이름으로 둔 것은 일부러다 —
 *   grep 하면 "어느 키가 이 축을 켜는가" 가 호출부에서 바로 보인다.
 */
export type KpiTabWeekAxis = "measured" | "S2.mentionTrend";

/** 경쟁사 스파크라인·주별 브랜드 라인의 원천. null = 이 지면만 degrade. */
export async function fetchStandardKpiBrandTrend(
  filters: StandardFilters = {},
  opts: {
    trendDays?: number; topBrands?: number; budget?: KpiBudgetProfile;
    weekAxis?: KpiTabWeekAxis;
  } = {},
): Promise<BrandTrendResult | null> {
  // 격자 축은 **4-KPI 탭 호출에만** 건다(`withKpiTrendGaps` 의 `attachGrid` 주석).
  // 대시보드 경쟁사 스파크는 같은 페처를 28일 창으로 쓰므로 종전 축을 유지한다.
  const onKpiTab = opts.weekAxis === "S2.mentionTrend";
  const win: KpiTrendWindow = onKpiTab
    ? await kpiTabTrendWindow(
        opts.trendDays ?? KPI_TAB_SPARK_TREND_DAYS,
        globalKpiTrendScope(filters),
      )
    : { floor: null, last: null, fallbackDays: opts.trendDays ?? KPI_TAB_SPARK_TREND_DAYS };
  const trendDays = kpiWindowDays(win);
  // 화면에 그리는 상위 N. 읽기 캡(`topBrands`, 아래 콜백 안)은 제외 엔티티 수만큼 더 크다.
  const shownTopBrands = opts.topBrands ?? 10;
  // 기본값은 **종전 예산**(S2 4-KPI 탭). 더 짧은 extras 예산은 대시보드가 명시한다.
  const profile = opts.budget ?? "kpi-tab";
  const weekSource = await kpiTabWeekSource(opts.weekAxis);
  // ── 카드 정렬 (2026-09-29 제품 책임자 A안) ──────────────────────────────────────
  //
  // 같은 히어로의 **카드**(`withOverviewCards` → 집계층 회차 스냅샷)와 이 **추이**가
  // 다른 원천을 읽었다: `S1.brandTrend` 는 옵트인이고 운영 `read_screens` 에 없어 이
  // 추이는 항상 미러였다. 실측(통합 프리뷰, Kia·IN, 9/28 자리): 카드 29.6% · 추이
  // 29.9%(미러 답변 414 vs 집계층 416). 같은 필터로 집계층 시계열을 읽으면 9/28 점이
  // 카드와 정확히 같다. Overview 카드 값이 정본이므로(제품 책임자 2026-09-20) 추이가 따라간다.
  //
  // 조건은 **카드가 집계층을 읽는 조건과 같다**: 격자 on(`withOverviewCards` 의
  // `ensureTrendGrid()`) + 카드 화면 키(`S1.dashboard`) 허용. 후자는 게이트가 본다
  // (`applyScreenGateAligned`). 격자 off(= 오늘의 프로덕션)면 `null` 이라 SQL·캐시 키·
  // 라우팅이 종전과 바이트 동일하다. 대시보드 경쟁사 스파크(`weekAxis` 없음)는
  // `onKpiTab` 이 거짓이라 격자 on 이어도 **판정조차 안 한다**(단락 평가).
  const align: ScreenGateAlign | null =
    onKpiTab && (await ensureTrendGrid()) ? KPI_BRAND_TREND_CARD_ALIGN : null;
  return withKpiTrendGaps(await degradeAware("brandTrend", () =>
    withStandardRoot("standardKpiBrandTrend", null as BrandTrendResult | null,
      // 프로파일은 **미러 폴백**에만 실린다 — 집계층 경로는 회차 read 라 이 예산의
      // 대상이 아니고, 프로파일은 미러 셀의 캐시 키다(PR③-a: 안 넣으면 먼저 채운
      // 쪽의 예산으로 만든 셀을 다른 호출자가 그대로 받는다).
      async (f) => {
        // 제외 엔티티(명부 excluded)가 있으면 캡을 **제외 수만큼 넉넉히** 읽고, 거른 뒤
        // 원래 캡으로 다시 줄인다(`filterBrandTrend` → `recapBrands`). 제외 행이 상위 N
        // 안에 있었어도 다음 브랜드가 그 자리를 채운다. 제외가 없으면 캡·캐시 키가 종전과
        // 바이트 동일하다. 명부는 `enforce` 뒤(이 콜백 안)에서만 읽는다.
        const ex = await excludedBrandsForDisplay();
        const topBrands = shownTopBrands + ex.size;
        const out = await viaGlobalSeries(f, "S1.brandTrend", requestGlobalBrands,
          (series) => toBrandTrend(series, {
            unit: "week", cap: topBrands, trendDays,
            filters: globalSeriesFilters(f, Date.now(), win.floor),
          }),
          () => cachedKpiBrandTrend(f, win, topBrands, profile, weekSource),
          ["own", "domains", "brands"], { cap: topBrands }, win.floor, align);
        return out && ex.size > 0 ? filterBrandTrend(out, ex, shownTopBrands) : out;
      }, filters),
  ), "week", globalKpiTrendScope(filters, "mentions"), onKpiTab);
}

/**
 * KPI 탭 브랜드 추이가 따라가는 카드 게이트 — 히어로 카드(`withOverviewCards` →
 * `fetchStandardAggregates` → `viaGlobalS1`)의 화면 키가 `S1.dashboard` 다.
 */
const KPI_BRAND_TREND_CARD_ALIGN: ScreenGateAlign = {
  screen: "S1.dashboard",
  reason: "kpi-card-align",
};

/**
 * 히어로 추이 + 엔진별 섹션 + **유형별 노출 추이**(`typeTrend`)의 원천.
 * 최신 스칼라(`latest`·`latestBrands`)는 스냅샷 창이라 주 격자와 무관하다.
 *
 * 호출부는 글로벌 언급 KPI 탭 하나뿐이지만(노출률·점유율·우호도 탭이 공유), `weekAxis`
 * 를 **명시 인자로** 둔다 — 브랜드 추이와 같은 형태여야 새 표면이 생겼을 때 축을 조용히
 * 상속하지 않는다.
 */
export async function fetchStandardKpiEngineTrend(
  filters: StandardFilters = {},
  opts: { trendDays?: number; weekAxis?: KpiTabWeekAxis } = {},
): Promise<EngineKpiTrend | null> {
  // 격자 on 이면 창은 **자리 13개**다(설계 §7-2 A) — 84일 상수는 그 폴백으로 남는다.
  const win = await kpiTabTrendWindow(
    opts.trendDays ?? KPI_TAB_HERO_TREND_DAYS,
    globalKpiTrendScope(filters),
  );
  const weekSource = await kpiTabWeekSource(opts.weekAxis);
  // 제외 엔티티는 엔진×브랜드 스냅샷(경쟁사 선택·경쟁사 평균 막대의 모수)에서만 뺀다.
  const trend = await withExcludedBrands(await withKpiTrendGaps(await kpiDegrade("engineTrend", () =>
    withStandardRoot("standardKpiEngineTrend", null as EngineKpiTrend | null,
      (f) => recoverDegraded(() => cachedKpiEngineTrend(f, win, weekSource)), filters),
  ), "week", globalKpiTrendScope(filters)), filterEngineKpiTrend);
  return withOverviewSlots(trend, filters);
}

/**
 * 언급 히어로의 **AI 노출률 추이**를 Overview 추이와 같은 함수에 붙인다
 * (제품 책임자 2026-09-20 지시 ②). 붙이는 배열은 `fetchStandardTrend` 가 낸 것 **그대로**다.
 *
 * 이 한 줄이 닫는 차이 넷(메인 실측 2026-09-20 Overview/언급: 08-17 75.0/78.6 ·
 * 08-24 72.2/68.7 · 08-31 64.8/65.2 · 09-07 72.9/72.8):
 *   ① 원천 — 언급은 미러 전용이었다(`aggregateEngineKpiTrendFromMirror`). 이제 둘 다
 *      `fetchStandardTrend` 의 판정(사실표 우선·미러 폴백)을 공유한다.
 *   ② 게이트 — `in_full_cycle`·루트 지역 스코핑·카탈로그 전 회차 판정이 한 벌이 된다.
 *   ③ 자리 귀속 — 자리 키가 `round_date` 로 같아지고, 한 자리 두 회차는 대표 하나다
 *      (`restrictToSlotRepresentative`, 08-24 자리의 차이가 여기서 닫힌다).
 *   ④ 대표 답변 — 접힌 `measured_at` 정렬이냐 `measured_at_orig` 냐의 차이가 사라진다
 *      (같은 배열을 쓰므로 선택이 한 번만 일어난다).
 *
 * ⚠️ **언급 화면에서 닫는 지표는 노출률뿐이다** — `sov`·우호도·엔진별 라인은
 *    `buckets`(미러) 그대로다(사실표에 그 축이 없다, `EngineKpiTrend.exposureSlots` 주석).
 *
 * ⚠️ **다만 변경 범위는 이 화면보다 넓다**(2026-09-20 독립 검증 B2-d). 자리 대표 선택
 *    (`restrictToSlotRepresentative`)은 `viaGlobalSeries` 안에 있으므로 그 함수를 쓰는
 *    **모든 소비자**에 걸린다: `S1.dashboard`(Overview 카드 추이)·`S1.brandTrend`·
 *    `S1.firstPosition`·`S1.competitors`. 한 자리에 회차가 둘인 곳(08-24)에서는
 *    **Overview 추이의 분모 자체가 바뀐다**(합산 → 대표 회차 하나). 의도된 변경이고,
 *    고객이 보던 과거 값이 움직이므로 릴리스 고지 대상이다.
 *
 * 추이가 degrade 되어 `null` 이면 붙일 대상이 없다 — 화면은 "표시 불가" 를 그대로 낸다.
 */
async function withOverviewSlots(
  trend: EngineKpiTrend | null,
  filters: StandardFilters,
): Promise<EngineKpiTrend | null> {
  if (!trend) return trend;
  if (!(await ensureTrendGrid())) return trend;
  const f = overviewReadFilters(filters);
  const [slots, deltaSlots] = await Promise.all([
    // 추이 차트의 축·값 — 13자리 주 격자.
    fetchStandardTrend(f, "week"),
    // 카드 Δ 의 입력 — **Overview 가 쓰는 바로 그 롤업**(N2). 두 배열을 합치지 않는
    // 이유는 `EngineKpiTrend.overviewDeltaSlots` 머리 주석.
    fetchStandardTrend(deltaTrendFilters(f), DELTA_TREND_BUCKET),
  ]);
  if (!slots.length && !deltaSlots.length) return trend;
  return {
    ...trend,
    ...(slots.length ? { overviewSlots: slots } : {}),
    ...(deltaSlots.length ? { overviewDeltaSlots: deltaSlots } : {}),
  };
}

/** 우선 노출도 — 브랜드별 평균 등장 순위(스냅샷 순위표 + 회차 시계열). null = degrade. */
export async function fetchStandardKpiFirstPosition(
  filters: StandardFilters = {},
  opts: { trendDays?: number; budget?: KpiBudgetProfile } = {},
): Promise<FirstPositionResult | null> {
  // 격자 on 이면 창은 **자리 13개**다(엔진 추이와 같은 격자 = 같은 x축).
  const win = await kpiTabTrendWindow(
    opts.trendDays ?? KPI_TAB_HERO_TREND_DAYS,
    globalKpiTrendScope(filters),
  );
  const trendDays = kpiWindowDays(win);
  const profile = opts.budget ?? "kpi-tab";
  const out = await withKpiTrendGaps(await degradeAware("firstPosition", () =>
    withStandardRoot("standardKpiFirstPosition", null as FirstPositionResult | null,
      async (f) => {
        // 제외 엔티티(명부 excluded): 순위표 모집단(언급 상위 N)을 **제외 수만큼 넉넉히**
        // 읽고, 거른 뒤 N 으로 다시 줄이고 순위 열을 다시 매긴다(`filterFirstPosition`).
        // 제외가 없으면 캡·인자·캐시 키가 종전과 같다. 명부는 `enforce` 뒤에서만 읽는다.
        const ex = await excludedBrandsForDisplay();
        const res = await viaGlobalSeries(f, "S1.firstPosition", requestGlobalBrands,
          // 축 = **경쟁 순위**(0069 comp, 2026-09-28 제품 책임자 A안). 폴백인 미러 셀도 같은 축이라
          // 키를 켜도 축은 안 바뀐다. 키를 켜는 것(모집단이 스냅샷 창에서 회차로 바뀐다)은
          // 여전히 운영 결정이다(`screens.ts` 의 이 키 주석).
          (series) => toFirstPosition(series, {
            unit: "week", cap: RANK_TABLE_TOP_BRANDS + ex.size, trendDays, positionAxis: "comp",
          }),
          () => ex.size > 0
            ? cachedKpiFirstPosition(f, win, profile, RANK_TABLE_TOP_BRANDS + ex.size)
            : cachedKpiFirstPosition(f, win, profile),
          ["own", "domains", "brands"], { cap: RANK_TABLE_TOP_BRANDS + ex.size }, win.floor);
        return res && ex.size > 0 ? filterFirstPosition(res, ex, RANK_TABLE_TOP_BRANDS) : res;
      }, filters),
  ), "week", globalKpiTrendScope(filters));
  return withOverviewFirstPosition(out, filters);
}

/**
 * 우선 노출도 탭의 **카드 값과 Δ** 를 Overview 카드와 같은 원천에 붙인다
 * (제품 책임자 2026-09-20). 이 탭은 `engineTrend` 를 안 받으므로 카드·Δ 입력을 결과 객체에
 * 함께 싣는다 — 붙이는 두 값은 다른 세 탭이 쓰는 것과 **같은 두 함수**에서 온다.
 */
async function withOverviewFirstPosition(
  fp: FirstPositionResult | null,
  filters: StandardFilters,
): Promise<FirstPositionResult | null> {
  if (!fp) return fp;
  if (!(await ensureTrendGrid())) return fp;
  const f = overviewReadFilters(filters);
  const [agg, slots, deltaSlots] = await Promise.all([
    fetchStandardAggregates(f),
    fetchStandardTrend(f, "week"),
    fetchStandardTrend(deltaTrendFilters(f), DELTA_TREND_BUCKET),
  ]);
  if (!agg) return fp;
  return {
    ...fp,
    overviewCards: overviewCardValues(agg),
    ...(slots.length ? { overviewSlots: slots } : {}),
    ...(deltaSlots.length ? { overviewDeltaSlots: deltaSlots } : {}),
  };
}

// ── 대시보드 경쟁사 Δ — 회차 축 2단 (PR④ B2) ───────────────────────────────
//
// 오늘 이 경계는 `fetchStandardKpiBrandTrend` + `fetchStandardKpiFirstPosition` 을
// 부르고, 둘 다 전역 키(`S1.brandTrend`·`S1.firstPosition`)가 off 라 **미러**로 간다
// (pgss 실측 2026-09-10: mean 9.7 s / 8.9 s · max 35 s). `dashboard:kpi-competitors`
// 16.5 s 중 두 자리를 차지하는 것이 이 둘이다.
//
// 여기서 하는 것은 **경계 교체**이지 전역 전환이 아니다 — 위 두 전역 페처와 그 키는
// 그대로 두고(제품 책임자 D3 (1): S2 4-KPI 탭은 종전 유지), 대시보드 경계만 `S1.competitors`
// 아래에서 회차 축을 읽는다. 그래서 값 변경 표면이 이 카드 하나로 갇힌다.
//
// ⚠️ `avgPosition` 은 이 전환에서 **축이 바뀐다**(경쟁 순위 → 텍스트 내 서수).
//    수치·근거·미결 결정은 `lib/summary/read/screens.ts` 의 `S1.competitors` 주석이
//    정본이다 — Δ 는 그 축 위의 차분이므로 부호·크기 모두 종전과 비교할 수 없다.

/**
 * 경쟁사 Δ 두 지면이 공유하는 회차 축 read. 같은 키 → 문장 1벌.
 *
 * ── 왜 **축은 안 바꾸면서 바닥만** 맞추는가 (검증 C4, 2026-09-20) ──────────
 *
 * 이 지면은 28일 스파크라 격자 축을 안 쓴다(의도된 제외). 그런데 이 경로가 타는
 * `requestGlobalCompetitorSeries` → `requestGlobalCore` → `readGlobalTrendCore` 는
 * `withTrendGrid` 를 지나 **`in_full_cycle` 게이트가 빠진 값**을 낸다. 즉 키를 켜면
 * 값은 새 게이트인데 회차 집합만 `now - 91일` 이라, B1 수정으로 다른 추이가 자리 바닥으로
 * 옮겨 간 뒤에는 **이 지면만 회차 집합이 한 자리 어긋날 수 있는** 상태가 된다. 같은 화면의
 * 카드 Δ 와 KPI 탭 값이 다른 모수로 계산되는 것이다.
 *
 * 그래서 `gridFloor` 만 넘긴다: 회차 집합은 다른 추이와 같아지고, 축(28일 스파크)과
 * `trendDays` 는 종전 그대로다. 격자가 꺼져 있으면 `null` 이라 91일 바닥 그대로다.
 */
async function competitorSeries<T>(
  filters: StandardFilters,
  names: readonly string[],
  totals: GlobalTrendBrandPoint[],
  pick: (series: GlobalTrendSeries) => T,
  onMirror: () => Promise<T>,
): Promise<T> {
  const gridFloor = trendGridDateFloor(
    await trendSlotsFor({
      surface: "global",
      projectIds: rootProjectIdsForGaps(),
      family: "all",
      filters,
    }),
  );
  return viaGlobalSeries(filters, "S1.competitors", requestGlobalCompetitorSeries, pick, onMirror,
    // 읽는 표 셋 — 코어(own·domains) + 브랜드 회차 축. 접기 존재 검사 대상이 곧 이것이다(GG-7).
    ["own", "domains", "brands"], { names: [...names], totals }, gridFloor);
}

/** 경쟁사 스파크·노출률/점유율 Δ 의 원천. null = 이 지면만 degrade. */
async function fetchStandardCompetitorBrandTrend(
  filters: StandardFilters,
  names: readonly string[],
  totals: GlobalTrendBrandPoint[],
  opts: { budget: KpiBudgetProfile },
): Promise<BrandTrendResult | null> {
  const trendDays = KPI_TAB_SPARK_TREND_DAYS;
  return degradeAware("brandTrend", () =>
    withStandardRoot("standardCompetitorBrandTrend", null as BrandTrendResult | null,
      (f) => competitorSeries(f, names, totals,
        (series) => toBrandTrend(series, {
          unit: "week", cap: names.length, trendDays, filters: globalSeriesFilters(f),
        }),
        // 폴백은 **종전 그대로**다(전역 페처 = 미러 셀 + extras 예산 + 자기 degrade 라벨).
        () => fetchStandardKpiBrandTrend(filters, { budget: opts.budget }),
      ), filters),
  );
}

/** 경쟁사 우선노출도 Δ 의 원천. null = 이 지면만 degrade. */
async function fetchStandardCompetitorFirstPosition(
  filters: StandardFilters,
  names: readonly string[],
  totals: GlobalTrendBrandPoint[],
  opts: { budget: KpiBudgetProfile },
): Promise<FirstPositionResult | null> {
  const trendDays = KPI_TAB_HERO_TREND_DAYS;
  return degradeAware("firstPosition", () =>
    withStandardRoot("standardCompetitorFirstPosition", null as FirstPositionResult | null,
      (f) => competitorSeries(f, names, totals,
        // **값과 같은 축**(0069 경쟁 순위) — 값은 B1(`toCompetitorBrands`)이 `comp_rank_sum`
        // 으로 내고, Δ 는 이 시계열의 마지막 두 점 차다. 서수 축으로 두면 같은 행에서
        // 값(4.2)과 Δ(+4.5)의 단위가 갈린다(PR④-b 검증자 F1).
        (series) => toFirstPosition(series, {
          unit: "week", cap: names.length, trendDays, positionAxis: "comp",
        }),
        () => fetchStandardKpiFirstPosition(filters, { budget: opts.budget }),
      ), filters),
  );
}

/** 대시보드 카드 하단 경쟁사 행이 기다리는 전부 — 값 + Δ 둘 + 인용 도메인. */
export interface StandardCompetitorSources {
  brands: CompetitorBrandValue[];
  brandTrend: BrandTrendResult | null;
  firstPosition: FirstPositionResult | null;
  citationDomains: CitationDomainLive[] | null;
}

/**
 * 경쟁사 행 경계 한 벌 — **키에 따라 모양이 다르다.**
 *
 *   · off → 종전 그대로 **넷을 한 번에** 발행한다. Δ 는 이름을 필요로 하지 않으므로
 *     값 read 를 기다릴 이유가 없다(기다리면 16.5 s 경계가 25 s 가 된다).
 *   · on  → **2단**이다. 값 read 가 이름을 정하고 그 이름으로만 회차 축을 읽는다.
 *     값 read 는 카드 셀 공유라 사실상 무비용이므로 직렬 한 홉이 싸다.
 *
 * 게이트 판정은 **맨 앞에서 한 번**만 하고, 그 사이 값·인용 read 는 이미 날아간다 —
 * 두 경로가 공유하는 둘이라 어느 쪽이든 낭비가 아니다.
 */
export async function fetchStandardCompetitorSources(
  filters: StandardFilters = {},
): Promise<StandardCompetitorSources> {
  // 경계 예산은 **짧은 쪽**(`extras` 15/30)이다 — 이 행이 빠져도 카드 본체는 이미
  // 그려져 있다. 프로파일은 미러 셀의 캐시 키라 S2 탭과 섞이지 않는다.
  //
  // A0 계측(`timedRead`)은 **여기**에 산다 — 조립이 페이지에서 읽기 계층으로 내려오면서
  // 같이 내려왔다. 마커(`dashboard:kpi-competitors`)는 이 경계의 **최댓값**이라
  // "16.5 s 가 누구 것인가"·"degrade 로 빠졌는가"를 못 말해 주고, 그 귀속은 분기마다
  // 다르다(off = 넷 병렬 / on = 값 read → 회차 축 2단). 두 분기 **모두** read 마다 한
  // 줄이 남아야 두 모양을 같은 로그로 비교할 수 있다.
  //
  // `timedRead` 는 **이미 만들어진 프로미스**를 받는다(thunk 가 아니다) — 아래 두 read 는
  // 종전과 같은 줄에서 발행되고, 게이트 판정을 기다리지 않는다(관측만 추가).
  // 이름은 **종전 그대로**다. 경로(미러 언급 ↔ 집계층 경쟁사 값)는 `S1.competitors` 로
  // 갈리지만 이 read 가 채우는 자리는 하나이고, 이름이 바뀌면 로그의 시계열이 끊긴다.
  // ⚠️ `timedRead(` 와 인자 사이에 주석을 끼우지 않는다 — 호출부 대조 테스트가 첫 인자를
  //    정규식으로 뽑는다(`lib/perf/read-timing.test.ts`).
  const brandsPromise = timedRead(
    "kpi-competitors/mentions",
    "standardMentions",
    fetchStandardCompetitorBrands(...competitorValueReadArgs(filters)),
    countOf.array,
  );
  // A3 가 이 read 에 `degradeAware("standardCitationDomains")` 를 붙였다(`COMPETITOR_LABELS`
  // 에도 등재). 그래서 라벨이 `null`(= `degraded:na`, "보호가 없는 read")이 아니라 실제
  // 라벨이다 — `null` 로 두면 로그가 "고지할 것이 없다" 고 거짓말한다.
  const citationsPromise = timedRead(
    "kpi-competitors/citationDomains",
    "standardCitationDomains",
    fetchStandardCitationDomains(filters),
    countOf.array,
  );
  // on 분기는 `await brandsPromise` 가 던지면 아래 `Promise.all` 에 닿기 전에 빠져나간다 —
  // 그때 `citationsPromise` 에 소비자가 없어 unhandledRejection 이 된다(V3 권한 레드팀 실증:
  // on + brands 실패 + citations 실패 조합). 종전 page.tsx 는 넷을 한 `Promise.all` 로 잡았다.
  // 거부를 흡수만 하고(값은 아래에서 그대로 기다린다) 예외는 본 경로가 다시 던진다.
  citationsPromise.catch(() => {});
  const on = await summaryScreenAllowed("S1.competitors");
  if (!on) {
    const [brands, brandTrend, firstPosition, citationDomains] = await Promise.all([
      brandsPromise,
      // 대시보드는 한 경계에서 넷이 함께 도므로 **더 짧은 extras 예산**을 명시한다.
      // 기본값(4-KPI 탭 예산)을 그대로 쓰면 이 경계의 실효 최악이 50 s 로 돌아간다.
      // 프로파일은 캐시 키에 들어가므로 S2 탭과 셀을 공유하지 않는다(의도).
      timedRead(
        "kpi-competitors/brandTrend",
        "brandTrend",
        fetchStandardKpiBrandTrend(filters, { budget: "extras" }),
        countOf.brands,
      ),
      timedRead(
        "kpi-competitors/firstPosition",
        "firstPosition",
        fetchStandardKpiFirstPosition(filters, { budget: "extras" }),
        countOf.brands,
      ),
      citationsPromise,
    ]);
    return { brands: brands ?? [], brandTrend, firstPosition, citationDomains };
  }
  const brands = (await brandsPromise) ?? [];
  // 이름 선정은 **화면 규칙**이다(코어 모듈이 정본) — 여기서 다시 정하면 그리는 4개와
  // 읽는 4개가 어긋난다.
  const names = competitorDeltaBrands(brands);
  const totals = competitorSeriesTotals(brands, names);
  // on 분기의 두 read 는 **다른 이름**을 쓴다 — 같은 자리를 채우지만 문장도(회차 축 1개)
  // 예산도 폴백도 다르다. off 이름을 재사용하면 로그에서 두 모양이 섞여, 정작 비교하려던
  // "2단이 실제로 빨라졌는가"를 못 읽는다. `timedRead` 는 `.then` 하나라 값 read 를
  // 기다린 뒤 발행하는 이 경로의 직렬 한 홉을 늘리지 않는다.
  const [brandTrend, firstPosition, citationDomains] = await Promise.all([
    timedRead(
      "kpi-competitors/competitorBrandTrend",
      "brandTrend",
      fetchStandardCompetitorBrandTrend(filters, names, totals, { budget: "extras" }),
      countOf.brands,
    ),
    timedRead(
      "kpi-competitors/competitorFirstPosition",
      "firstPosition",
      fetchStandardCompetitorFirstPosition(filters, names, totals, { budget: "extras" }),
      countOf.brands,
    ),
    citationsPromise,
  ]);
  return { brands, brandTrend, firstPosition, citationDomains };
}

/** 멘션 유형별 출처 카테고리 구성. null = degrade. */
export async function fetchStandardCitationTypeCategories(
  filters: StandardFilters = {},
): Promise<CitationTypeCategoryRow[] | null> {
  return kpiDegrade("citationTypeCategories", () =>
    withStandardRoot("standardCitationTypeCategories", null as CitationTypeCategoryRow[] | null,
      cachedCitationTypeCategories, filters),
  );
}

/** 긍정/부정 답변 인용 요약(타일 카운트). null = degrade. */
export async function fetchStandardCitationToneSummary(
  filters: StandardFilters = {},
): Promise<CitationToneSummary | null> {
  return kpiDegrade("citationToneSummary", () =>
    withStandardRoot("standardCitationToneSummary", null as CitationToneSummary | null,
      cachedCitationToneSummary, filters),
  );
}

/** 긍정/부정 답변에 인용된 URL 목록(하위 페이지) — 페이지·검색, 비캐시. */
export async function fetchStandardCitationToneUrls(
  filters: StandardFilters = {},
  opts: { tone: CitationTone; page?: number; pageSize?: number; q?: string; groupBy?: "url" | "domain" },
): Promise<CitationToneUrlPage | null> {
  return kpiDegrade("citationToneUrls", () =>
    withStandardRoot("standardCitationToneUrls", null as CitationToneUrlPage | null,
      (f) => aggregateCitationToneUrlsFromMirror(f, undefined, {
        ...opts,
        statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
        budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
      }), filters),
  );
}

/** 공식(당사) URL 인용/미인용 프롬프트 전량 목록(하위 페이지) — 페이지·검색, 비캐시. */
export async function fetchStandardCitationOwnedPrompts(
  filters: StandardFilters = {},
  opts: { owned: boolean; page?: number; pageSize?: number; q?: string },
): Promise<CitationOwnedPromptPage | null> {
  return kpiDegrade("citationOwnedPrompts", () =>
    withStandardRoot("standardCitationOwnedPrompts", null as CitationOwnedPromptPage | null,
      (f) => aggregateCitationOwnedPromptsFromMirror(f, undefined, scopeOwnedPrefixes(f), {
        ...opts,
        statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
        budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
      }), filters),
  );
}

/** 멘션 유형 5종 × 브랜드군 + 유형×감정(근사) 매트릭스. */
export async function fetchStandardKpiTypes(
  filters: StandardFilters = {},
): Promise<TypeKpi | null> {
  return kpiDegrade("typeKpi", () =>
    withStandardRoot("standardKpiTypes", null as TypeKpi | null, cachedKpiTypes, filters),
  );
}

/**
 * 답변 단위 브랜드 스탠스 분포 — 우호도 탭 "브랜드 태도 분포" 카드.
 * null = 스탠스 축이 이 배포·회차에 없다(테이블 미적용·코어 미배포·degrade).
 * **발생 감성으로 폴백하지 않는다** — 화면이 "수집 대기"를 말한다(스펙 FR10).
 */
export async function fetchStandardKpiStanceDist(
  filters: StandardFilters = {},
): Promise<AnswerStanceDistribution | null> {
  return kpiDegrade("stanceDist", () =>
    withStandardRoot("standardKpiStanceDist", null as AnswerStanceDistribution | null,
      cachedKpiStanceDist, filters),
  );
}

/** 측정 개요 카드의 "적용 프롬프트" — 카탈로그 카운트(미러 아님). */
export async function fetchStandardAppliedPromptCount(
  filters: StandardFilters = {},
): Promise<number | null> {
  return kpiDegrade("appliedPrompts", () =>
    withStandardRoot("standardAppliedPrompts", null as number | null,
      cachedKpiAppliedPrompts, filters),
  );
}

// ACR (AI's Choice Rate) — scope 2턴 선택 측정의 미러 집계. rollup이 없으면
// measured=false (ACR 프롬프트 미지정 또는 측정 대기) → 뷰가 대기 상태 렌더.
//
// ── 공용 추이 격자(D5)를 **안 건다** (2026-09-20, 설계 §7-1 의 열거에서 유일한 예외) ──
//
// 설계는 ACR 을 격자 대상으로 열거하지만, 이 지면의 추이는 **자리에 얹을 수 있는 모양이
// 아니다**. 확인한 것 셋(`scope-aggregates.ts::aggregateAcrFromMirror` Q3):
//
//   ① 버킷 키가 `date_trunc('day', x.measured_at)` 다 — **실제 측정 시각의 날**이고
//      회차 귀속 날짜가 아니다. 기간 술어(`acrWhere` 의 `anchorRunClause`)만 앵커 축을
//      타고 **버킷은 안 탄다**.
//   ② 타입에 자리 키가 없다 — `AcrTrendBucket = { date, series }` 로 `bucketStart`·
//      `week`·`roundDate` 중 아무것도 없다.
//   ③ 지면 의미가 **일별**이다("일별 선택률"). 회차 하나가 여러 날에 걸쳐 드레인되므로
//      자리로 접으면 그 날짜 분해가 통째로 사라진다 — 모양이 아니라 **값의 변경**이다.
//
// 이으려면 필요한 것: 집계 SQL 이 `scope_acr_rollups.run_id` 로 앵커 표를 조인해
// `ca.round_date` 로 버킷을 잡고(롤업에는 `job_id` 가 없어 run 축이다 — `acrWhere` 가
// 이미 쓰는 준-조인과 같은 형태), `AcrTrendBucket` 에 자리 키를 싣고, 화면의 x축 라벨과
// "일별" 문구를 함께 고치는 것. 값이 바뀌므로 **데이터 층(W5·W7)의 일이고 옵트인 키가
// 따로 필요하다.** 이 PR(화면 배선)의 범위가 아니다.
export async function fetchStandardAcr(
  filters: StandardFilters = {},
): Promise<StandardAcr | null> {
  // 제외 엔티티는 ACR 브랜드 목록(선택 점유율 표)에서만 뺀다: 값은 서버 계산 그대로.
  return withExcludedBrands(
    await withStandardRoot("standardAcr", null, cachedStandardAcr, filters), filterAcr);
}

// KPI ⑥ AI 타겟 URL 인용률 — 프로젝트별 라벨링된 추적 URL 기준. 라벨 0개면
// rate=null → 카드에 '측정 대기' 칩 유지. 캐시 키는 (filters, urls) — URL 추가/
// 삭제 시 즉시 다음 호출에서 새 셀이 됨(revalidate 없이 자연 만료까지 기다리지
// 않아도 됨, 키 자체가 달라지므로). 같은 URL 셋이면 캐시 hit.
export async function fetchProjectCitationAccuracy(
  localProjectId: string,
  filters: StandardFilters,
  trackedUrls: string[],
  ownedDomain?: string | null,
): Promise<CitationAccuracyResult> {
  await enforce("projectCitationAccuracy");
  // tracked URLs 가 0개면 mirror 호출 자체를 건너뛴다(표면적 fast-path).
  if (trackedUrls.length === 0) {
    return { ownedAnswers: 0, targetAnswers: 0, rate: null };
  }
  // Per-project scope: numerator/denominator count only THIS project's answers,
  // not the whole standard mirror (was a brand/country stand-in). Null scope id
  // (unlinked project / mock) → falls back to the mirror-wide count, so the
  // number degrades gracefully rather than blanking until the mirror is scoped.
  const scopeProjectId = (await resolveScopeProjectId(localProjectId)) ?? undefined;
  // 분모(자사 도메인)는 프로젝트가 설정한 도메인을 따른다. 정규화한 형태를
  // 캐시 키에 넣어 도메인 변경 시 다음 호출에서 새 셀이 되게 한다(빈 값이면
  // aggregate 가 글로벌 catalog 로 fallback).
  const ownedPrefix = normalizeUrlForMatch(ownedDomain);
  return cachedCitationAccuracy(
    normalizeFilters(filters),
    [...trackedUrls].sort(),
    ownedPrefix,
    scopeProjectId ?? "",
  );
}

// scopeProjectId is part of the cache key ("" = mirror-wide fallback) so two
// same-brand/country projects don't collide on one cached cell.
const cachedCitationAccuracy = mirrorCache("citation-accuracy",
  (filters: StandardFilters, urls: string[], ownedPrefix: string, scopeProjectId: string) =>
    aggregateCitationAccuracy(filters, urls, ownedPrefix, scopeProjectId || undefined));

const cachedCitationAccuracyTrend = mirrorCache("citation-accuracy-trend",
  (
    filters: StandardFilters,
    urls: string[],
    unit: BucketUnit,
    ownedPrefix: string,
    scopeProjectId: string,
  ) =>
    aggregateCitationAccuracyTrend(
      filters,
      urls,
      unit,
      ownedPrefix,
      scopeProjectId || undefined,
    ));

export async function fetchProjectCitationAccuracyTrend(
  localProjectId: string,
  filters: StandardFilters,
  trackedUrls: string[],
  unit: BucketUnit = "week",
  ownedDomain?: string | null,
): Promise<CitationAccuracyTrendBucket[]> {
  await enforce("projectCitationAccuracyTrend");
  if (trackedUrls.length === 0) return [];
  const scopeProjectId = (await resolveScopeProjectId(localProjectId)) ?? undefined;
  const ownedPrefix = normalizeUrlForMatch(ownedDomain);
  // ⑥ 도 프로젝트 메인 추이와 **같은 자리**에 선다(검증 B4). 여기서 안 가두면
  // `mergeProjectTrendAccuracy` 가 격자에 없는 버킷을 **점으로 새로 만들어** 추이에
  // 끼워 넣는다 — 설계 §7-1 ③("원장에 자리가 없으면 아무것도 그리지 않는다") 위반이다.
  const slots = await trendSlotsFor({
    surface: "project",
    projectIds: scopeProjectId ? [scopeProjectId] : [],
    family: "citations",
    filters,
    unit,
  });
  const scoped = withTrendGridWindow(filters, slots);
  return restrictToTrendGrid(
    await cachedCitationAccuracyTrend(
      normalizeFilters(scoped),
      [...trackedUrls].sort(),
      unit,
      ownedPrefix,
      scopeProjectId ?? "",
    ),
    toTrendGridSlotViews(slots) ?? null,
  );
}

// ── Per-project mirror reads — same aggregate fns as standard, scoped to one project's runs.
// Dedicated cache namespaces prevent cross-project cache collisions.
// Unlinked / 미측정 project → empty value (caller shows "측정 대기").

const cachedProjectAggregates = mirrorCache("project-aggregates",
  (scopeProjectId: string, filters: StandardFilters, ownedBasePrefixes: string[]) =>
    aggregateStandardFromMirror(filters, scopeProjectId, ownedBasePrefixes));

// 요청단위 dedup — 프로젝트 대시보드도 필터바(측정 기준일 슬롯)와 KPI 섹션
// (getProjectDashboard)이 같은 read 를 부른다(2026-09-01, 표준·웹사이트와 동일).
export const fetchProjectStandardAggregates = requestDeduped(
  "fetchProjectStandardAggregates",
  async (
  localProjectId: string,
  filters: StandardFilters = {},
): Promise<StandardAggregates | null> => {
  const project = await cachedProjectById(localProjectId);
  const ownedBasePrefixes = await ownedBasePrefixesForProject(project);
  // 제외 엔티티: 표준 카드와 같다(`brands` 에서만, KPI #16 경쟁사 자동 선정 입력).
  return withExcludedBrands(await withProject(
    "projectStandardAggregates",
    localProjectId,
    null,
    (id, f) => cachedProjectAggregates(id, f, ownedBasePrefixes),
    filters,
  ), filterAggregatesBrands);
});

const cachedProjectSubKpis = mirrorCache("project-subkpis",
  (scopeProjectId: string, filters: StandardFilters, ownedBasePrefixes: string[]) =>
    aggregateSubKpisFromMirror(filters, scopeProjectId, ownedBasePrefixes));

export async function fetchProjectSubKpis(
  localProjectId: string,
  filters: StandardFilters = {},
): Promise<StandardSubKpis> {
  const project = await cachedProjectById(localProjectId);
  const ownedBasePrefixes = await ownedBasePrefixesForProject(project);
  return withProject(
    "projectSubKpis",
    localProjectId,
    { rows: [], promptsWithoutBrand: null, measuredPrompts: null },
    (id, f) => cachedProjectSubKpis(id, f, ownedBasePrefixes),
    filters,
  );
}

const cachedProjectSubKpisPrev = mirrorCache("project-subkpis-prev",
  (scopeProjectId: string, filters: StandardFilters, ownedBasePrefixes: string[]) =>
    subKpisPrevImpl(filters, scopeProjectId, ownedBasePrefixes));

export async function fetchProjectSubKpisPrev(
  localProjectId: string,
  filters: StandardFilters = {},
): Promise<PrevSubKpis | null> {
  const project = await cachedProjectById(localProjectId);
  const ownedBasePrefixes = await ownedBasePrefixesForProject(project);
  return withProject(
    "projectSubKpisPrev",
    localProjectId,
    null,
    (id, f) => cachedProjectSubKpisPrev(id, f, ownedBasePrefixes),
    filters,
  );
}

const cachedProjectTrend = mirrorCache("project-trend",
  (scopeProjectId: string, filters: StandardFilters, unit: BucketUnit, ownedBasePrefixes: string[]) =>
    aggregateStandardTrendFromMirror(filters, unit, scopeProjectId, ownedBasePrefixes));

export async function fetchProjectTrend(
  localProjectId: string,
  filters: StandardFilters = {},
  unit: BucketUnit = "week",
): Promise<StandardTrendBucket[] | null> {
  // 라벨을 **단위별로** 가른다(`fetchStandardTrend` 의 `standardTrend:${unit}` 와 같은
  // 규율). 프로젝트 대시보드는 이 페처를 한 요청에서 두 번 부른다 — 차트용 `bucket`
  // 과 KPI Δ 칩용 `day`. 라벨이 하나면 Δ 쪽만 예산에 걸려도 표식이 서고, 멀쩡히 그려진
  // 주별 차트가 "지연" 고지로 덮인다. 어느 슬롯이 걸렸는지 화면이 구분할 수 있어야 한다.
  return degradeAware(`projectTrend:${unit}`, async () => {
    const project = await cachedProjectById(localProjectId);
    const ownedBasePrefixes = await ownedBasePrefixesForProject(project);
    const scopeIds = await gapProjectIds(localProjectId);
    // 공용 격자(D5) — **표면은 `project`** 다. 갭 슬롯 조회는 표면을 안 가리지만
    // (아래 `withTrendGapBuckets(…, null, …)`) 자리 목록은 가려야 한다: 표면이 null 이면
    // 원장의 website 회차까지 같은 축에 섞여 **자리가 두 요일로 선다**. 프로젝트 표면은
    // 정규 요일이 없어(설계 §9.2) 자리 키가 앵커 KST 일자 그대로다.
    const slots = await trendSlotsFor({
      surface: "project",
      projectIds: scopeIds,
      family: "all",
      filters,
      unit,
    });
    filters = withTrendGridWindow(filters, slots);
    const buckets = await withProject(
      "projectTrend",
      localProjectId,
      [] as StandardTrendBucket[],
      (id, f) => cachedProjectTrend(id, f, unit, ownedBasePrefixes),
      filters,
    );
    // 프로젝트 표면은 회차 표면이 무엇인지 여기서 단정할 수 없다(원장에 website·project
    // 둘 다 있다) — 표면을 가리지 않고 **그 프로젝트의** 숨긴 회차만 본다.
    return applyTrendGridToBuckets(
      await withTrendGapBuckets(buckets, unit, null, scopeIds),
      slots,
    );
  });
}

const cachedProjectPromptTopics = mirrorCache("project-prompt-topics",
  (scopeProjectId: string, filters: StandardFilters) => aggregatePromptTopicFromMirror(filters, scopeProjectId));

export async function fetchProjectPromptTopics(
  localProjectId: string,
  filters: StandardFilters = {},
): Promise<PromptTopicSlice[]> {
  return withProject("projectPromptTopics", localProjectId, [], cachedProjectPromptTopics, filters);
}

const cachedProjectSourceComposition = mirrorCache("project-source-composition",
  (scopeProjectId: string, filters: StandardFilters, ownedBasePrefixes: string[]) =>
    aggregateSourceCompositionFromMirror(filters, scopeProjectId, ownedBasePrefixes));

export async function fetchProjectSourceComposition(
  localProjectId: string,
  filters: StandardFilters = {},
): Promise<SourceDomainSlice[]> {
  // 도넛 isOurs 배지도 KPI ⑤/인용 탭과 같은 프로젝트 사슬 판정 (도메인 단위라
  // 베이스의 registrable 도메인 서픽스 매칭 — aggregateSourceComposition 참조).
  const project = await cachedProjectById(localProjectId);
  const ownedBasePrefixes = await ownedBasePrefixesForProject(project);
  return withProject("projectSourceComposition", localProjectId, [],
    (id, f) => cachedProjectSourceComposition(id, f, ownedBasePrefixes), filters);
}

// 요청단위 dedup — 답변분석>언급 화면이 필터바(측정 기준일 슬롯)와 본문 두
// <Suspense> 경계에서 같은 read 를 부른다. 값이 같은 필터면 DB 는 1회.
// (unstable_cache 는 요청 간 층, 이건 요청 안 층 — lib/request-dedupe.ts 참조.)
export const fetchStandardMentions = requestDeduped(
  "fetchStandardMentions",
  // 기본값은 **보수적인 쪽**(S2 언급 화면 = `screen`, 22/35). 새 호출부가 옵션을 잊어도
  // 화면이 죽지 않는 방향으로 틀리게 둔다 — 짧은 `extras` 는 대시보드가 명시한다.
  // 프로파일은 `requestDeduped` 키에도 들어가므로 두 지면이 같은 요청에서 만나도 섞이지 않는다.
  async (
    filters: StandardFilters = {},
    opts: { budget?: MentionsBudgetProfile } = {},
  ): Promise<MentionsLive | null> => {
    // 추이 주 격자 키(2026-09-17) — 화면 키 `S2.mentionTrend` 가 정한다. off 면 종전
    // `date_trunc('week', measured_at)`, on 이면 원장 `cycle_week`. 값·술어·dedup 규칙은
    // 양쪽이 같고 **주 배정만** 다르다(`scope-aggregates.ts::trendWeekKey` 가 정본).
    //
    // 판정은 여기 한 번뿐이고 DB 왕복을 **늘리지 않는다** — `summaryScreenAllowed` 는
    // `summary_settings` 원문을 30초 메모로 읽고(`readScreensRaw`), 같은 요청의 다른
    // 위젯(`S1.competitors` 등)이 이미 부른다. 회차 원장·게이트 문장은 안 탄다.
    const weekSource: TrendWeekSource =
      (await summaryScreenAllowed("S2.mentionTrend")) ? "cycle" : "measured";
    // 예산에 걸리면 **null** 을 내고 페이지는 그대로 서빙된다(E-2 와 같은 자세).
    // `null` 의 두 뜻("데이터 없음" vs degrade)은 `wasDegraded("standardMentions")` 로 가른다.
    // 헬퍼가 `withStandardRoot` **안**이다(B1 수리) — 읽기 전에 자리를 세워야 하는데
    // 밖에서 하면 `enforce` 전에 원장을 읽는다. 부수 효과로 갭·자리 조회가 degrade
    // 보호 안으로 들어온다(website 지면이 이미 그 형태다 — 실패가 500 이 아니라 null 이다).
    // 제외 엔티티(명부 excluded)는 순위표·유형×브랜드·추이 시리즈에서만 뺀다: 요약·분모는
    // 그대로(`excluded-brands.ts::filterMentionsLive`). 캐시 **밖**에서 거르므로 셀은 종전과 같다.
    return withExcludedBrands(await degradeAware("standardMentions", () =>
      withStandardRoot("standardMentions", null as MentionsLive | null,
        (scoped) =>
          withWeeklyTrendGrid({
            surface: "global",
            gridSurface: "global",
            projectIds: rootProjectIdsForGaps(),
            family: "mention",
            filters: scoped,
            read: (f) => recoverDegraded(
              () => cachedStandardMentions(f, opts.budget ?? "screen", weekSource)),
          }),
        filters)), filterMentionsLive);
  },
);

// ── 대시보드 카드 하단 **경쟁사 행** — 값 슬림 read (PR④ B1) ────────────────
//
// 이 행이 소비하는 것은 `MentionsLive.brands` 의 **브랜드당 6값**뿐이다
// (`overview-kpi-cards.tsx::competitorMinis`). 그런데 오늘 그 6값을 얻으려고
// `fetchStandardMentions` 를 통째로 부르고, 그 경로에는 **집계층 대응이 아예 없어**
// 언제나 미러다(프로덕션 실측 2026-09-10: `dashboard:kpi-competitors` 16.4~16.8 s).
//
// 결정적 사실은 **그 6값이 이미 카드 read 안에 있다**는 것이다 — S1 카드 read
// (`summaryGlobalS1FromTrend`, `S1_STATEMENT_KEYS = ["own","brands","domains"]`)가
// `summary_trend_brands` 의 브랜드 축을 전량 싣고 오는데 매핑이 네 필드만 뽑고
// 나머지(`rank_sum`·`ranked_answers`·감정 4계열)를 버리고 있었다. 그래서 이 페처는
// **DB 문장을 0개 더 내지 않는다** — 같은 요청 캐시(`requestS1`)에 이미 있는 값을
// 다른 매핑으로 한 번 더 읽을 뿐이다.
//
// ⚠️ 그래서 게이트가 **두 겹**이다:
//   ① `S1.competitors`(옵트인) — 값이 바뀌므로 운영 스위치 없이는 안 켜진다.
//   ② `viaGlobalS1` 안의 `S1.dashboard` — 문장을 **공유**하기 위한 조건이다. 카드가
//      집계층이 아닌데 이 행만 집계층이면 셀이 따로 서서 문장 수가 늘고(수용 기준 ③
//      위반), 한 카드 안에서 값의 축이 또 갈린다. ②가 거부하면 종전 미러로 간다.
//
// 값의 변화(창·모수·`avgPosition` 정의)는 `lib/summary/read/screens.ts` 의
// `S1.competitors` 주석이 정본이다.
export async function fetchStandardCompetitorBrands(
  filters: StandardFilters = {},
  // 기본값을 두지 않는다 — 이 페처의 호출부는 대시보드 경계 하나뿐이고, 예산은
  // 그 경계가 명시한다(`degrade-labels.test.ts` 가 기본값 규율을 고정한다).
  opts: { budget: MentionsBudgetProfile },
): Promise<CompetitorBrandValue[] | null> {
  // 제외 엔티티(명부 excluded)는 **두 경로 모두** 빠진다: 이 목록이 Overview 경쟁사 4개·
  // 경쟁사 Δ 이름(`competitorDeltaBrands`)·언급 탭 경쟁사 값의 선정 입력이다. 종전 경로는
  // `fetchStandardMentions` 가 이미 거른 `brands` 를 받고, 집계층 경로는 아래에서 거른다.
  //
  // 종전 경로. `MentionsBrandLive` 는 `CompetitorBrandValue` 의 구조적 상위 타입이라
  // 그대로 대입된다 — 화면은 어느 경로로 왔는지 모른다(폴백의 전제).
  const onMirror = async (): Promise<CompetitorBrandValue[] | null> =>
    (await fetchStandardMentions(filters, { budget: opts.budget }))?.brands ?? null;
  if (!(await summaryScreenAllowed("S1.competitors"))) return onMirror();
  // degrade 라벨은 **종전과 같은 것**을 쓴다 — 고지 지면(`COMPETITOR_LABELS`)이 읽는
  // 것이 이 문자열이고, 이 행이 비는 사유는 경로가 바뀌어도 같은 뜻이다.
  return withExcludedBrands(await degradeAware("standardMentions", () =>
    withStandardRoot("standardCompetitorBrands", null as CompetitorBrandValue[] | null,
      // 세부층(`onDetail`)에는 이 값의 쌍둥이가 없다 — 세부층 `StandardAggregates.brands`
      // 는 `name`·`mentionCount`·`answerCount`·`isTracked` 넷뿐이라 점유율·순위·감정을
      // 못 낸다. 그래서 `agg-*` 도 `gate-*` 도 목적지가 **미러 하나**다(추이와 같은 2층).
      (f) => viaGlobalS1<CompetitorBrandValue[]>(f, (v) => v.competitors,
        async () => (await onMirror()) ?? [],
        async () => (await onMirror()) ?? []),
      filters)), filterCompetitorValues);
}

/**
 * 언급 화면의 **브랜드별 값** — Overview 경쟁사 줄과 같은 리더·같은 인자·같은 캐시 키
 * (제품 책임자 2026-09-20 지시 ①: "Overview 와 멘션의 값은 완전 같아야 해").
 *
 * ── 무엇이 갈렸나 (프리뷰 실측 2026-09-20, 기준 회차 09-14, 필터 없음) ────────
 *
 *   | 브랜드 | Overview 점유율 | 언급 화면 점유율 |
 *   | --- | --- | --- |
 *   | Toyota | 6.6 | 6.1 |
 *   | Tesla  | 6.5 | 5.8 |
 *   | BMW    | 5.5 | 6.1 |
 *
 * 원인은 스키마가 아니라 **리더 비대칭**이었다: Overview 경쟁사 줄은
 * `fetchStandardCompetitorBrands`(= `S1.competitors` 게이트 · 사실표 회차 스냅샷)를
 * 쓰는데, 언급 화면은 `fetchStandardMentions().brands`(= 미러 누적 창)를 쓴다.
 * 같은 브랜드의 같은 지표가 한쪽은 사실표, 다른 쪽은 미러였다. 당사 3사 개별 행도
 * 같다(실측 Hyundai 사실표 53.3 vs 미러 49.0).
 *
 * ── 무엇을 하는가 ──────────────────────────────────────────────────────────
 *
 * **같은 리더를 같은 인자로 한 번 더 부른다.** 인자는 `competitorValueReadArgs` 한
 * 곳에서 나오므로 두 화면이 갈릴 수 없고, 한 요청 안에 두 지면이 같이 있으면
 * `viaGlobalS1` 의 `requestS1` 요청 캐시가 적중해 **DB 문장이 늘지 않는다**.
 *
 * ── 반환 계약 ──────────────────────────────────────────────────────────────
 *
 * `null` 이면 화면은 **종전 미러 값을 그대로** 쓴다(오버레이 미적용). `null` 의 뜻은 셋:
 *   · 격자 키(`X.trendGrid`)가 꺼져 있다 → 이 PR 의 새 동작 전체가 꺼진 상태.
 *   · 리더가 degrade 됐다(예산 초과).
 *   · 스코프가 없다.
 * **폴백(사실표 → 미러)은 `null` 이 아니다** — 그때 리더는 Overview 와 **같은 미러 셀**을
 * 돌려주므로 두 화면이 함께 미러 값으로 간다(지시 ⑦ 폴백 대칭). 한쪽만 폴백하는 필터
 * 상태가 없다는 것은 인자가 같다는 사실에서 나온다.
 *
 * ── 실패 격리 (2026-09-20 검증자 N-d) ──────────────────────────────────────
 *
 * **어떤 오류든 `null` 로 떨어진다.** 종전에는 `kpiDegrade` 가 타임아웃만 삼키고
 * (`kpi-tab-budget.ts::kpiDegrade` — `if (!isTimeoutFailure(e)) throw e`) SQL·커넥션
 * 오류는 그대로 던졌다. 이 프로미스는 페이지가 **컴포넌트 prop 으로** 넘기므로
 * (`mention/page.tsx`), 던지면 그 KPI 탭 경계가 통째로 에러가 된다. 이 read 는
 * **장식적 보강**이다 — 없으면 종전 미러 값이 그대로 나오고 화면은 성립한다. 실패가
 * 지면 전체를 내리는 것은 비대칭이다.
 *
 * ⚠️ 삼키되 **조용하지 않다** — `console.error` 로 남긴다. 값이 조용히 옛것으로 돌아가는
 *    상태가 로그에 안 남으면 아무도 못 잡는다(`kpiDegrade` 가 warn 을 남기는 것과 같은 이유).
 *    다른 prop 들에는 이 보호를 걸지 않는다 — 그것들은 없으면 화면이 성립하지 않는 값이다.
 */
export async function fetchStandardMentionCompetitorBrands(
  filters: StandardFilters = {},
): Promise<CompetitorBrandValue[] | null> {
  // 격자가 꺼져 있으면 왕복도 0 이다 — 격자 off 무변경의 기계적 근거.
  if (!(await ensureTrendGrid())) return null;
  try {
    return await fetchStandardCompetitorBrands(...competitorValueReadArgs(filters));
  } catch (e) {
    console.error(
      "[kpi-tabs] standardMentionCompetitorBrands failed (page still served, mirror values kept):",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

// 멘션 드릴다운 "프롬프트" 탭 lazy fetch (표준 루트) — 브랜드 행 클릭 시 그 브랜드의
// 프롬프트 목록만. brand-citations와 동일 lazy 패턴(캐시 슬림화 대응, 2026-07-08).
export async function fetchStandardBrandMentionPrompts(
  brand: string,
  filters: StandardFilters = {},
): Promise<MentionsPromptLive[]> {
  return withStandardRoot("standardBrandMentionPrompts", [],
    (f) => cachedStandardBrandMentionPrompts(brand, f), filters);
}

// 요청단위 dedup — fetchStandardMentions 와 같은 이유(필터바 슬롯 + 본문).
//
// `kpiDegrade` 로 감싼다(E-2): 예산(45 s)에 걸리면 **null** 을 내고 페이지는 그대로
// 서빙된다. 종전에는 예산이 없어 함수 120 s 를 넘겼고, 그러면 degrade 조차 못 하고
// **HTML 이 잘린 채** 응답됐다(1,519 KB → 319 KB). 삼키는 것은 시간 초과 두 가지뿐이고
// (`57014`·`AnswerSetDeadlineError`) 권한·연결·문법 실패는 그대로 던진다.
//
// ⚠️ `null` 은 이 페처에서 **두 뜻**이다 — "스코프 없음/데이터 없음"과 "degrade".
//    화면이 둘을 구분하려면 `wasDegraded("standardCitations")` 를 보면 된다
//    (`lib/scope/degrade-registry.ts` — 요청 스코프, 추가 조회 없음).
export const fetchStandardCitations = requestDeduped(
  "fetchStandardCitations",
  async (filters: StandardFilters = {}): Promise<CitationsLive | null> =>
    degradeAware("standardCitations", () =>
      withStandardRoot("standardCitations", null as CitationsLive | null,
        (scoped) =>
          withWeeklyTrendGrid({
            surface: "global",
            gridSurface: "global",
            projectIds: rootProjectIdsForGaps(),
            family: "citation",
            filters: scoped,
            read: (f) => cachedStandardCitations(f, "screen"),
          }),
        filters)),
);

// 감정·유형 신호 드릴다운 (2026-08-07) — 카드 세그먼트 클릭 시 그 신호가 발생한
// 프롬프트 목록만 lazy fetch. 표준/웹사이트/프로젝트 3표면 각각의 컨텍스트로.
const cachedStandardSignalPrompts = mirrorCache("standard-signal-prompts",
  (signal: SignalKey, filters: StandardFilters) =>
    aggregateSignalPromptsFromMirror(signal, filters));
const cachedWebsiteSignalPrompts = mirrorCache("website-signal-prompts",
  (projectIds: string[], signal: SignalKey, filters: StandardFilters) =>
    aggregateSignalPromptsFromMirror(signal, filters, projectIds));
const cachedProjectSignalPrompts = mirrorCache("project-signal-prompts",
  (scopeProjectId: string, signal: SignalKey, filters: StandardFilters) =>
    aggregateSignalPromptsFromMirror(signal, filters, scopeProjectId));

export async function fetchStandardSignalPrompts(
  signal: SignalKey,
  filters: StandardFilters = {},
): Promise<MentionsPromptLive[]> {
  return withStandardRoot("standardSignalPrompts", [],
    (f) => cachedStandardSignalPrompts(signal, f), filters);
}

export async function fetchWebsiteSignalPrompts(
  signal: SignalKey,
  filters: StandardFilters = {},
): Promise<MentionsPromptLive[]> {
  return withWebsite("websiteSignalPrompts", [],
    (ids, f) => cachedWebsiteSignalPrompts(ids, signal, f), filters);
}

export async function fetchProjectSignalPrompts(
  localProjectId: string,
  signal: SignalKey,
  filters: StandardFilters = {},
): Promise<MentionsPromptLive[]> {
  return withProject("projectSignalPrompts", localProjectId, [],
    (id, f) => cachedProjectSignalPrompts(id, signal, f), filters);
}

// SLIM — 도넛 전용. 전체 CitationsLive는 2MB 캐시 한도 초과 → 도메인 롤업만.
//
// PR② T7: 세부층(`summaryGlobalSourceComposition`, job 세미조인)에서 **집계층 1문장**으로.
// 집계층이 비었거나(접기 미실행) 필터가 집계층 키 밖이면 **세부층**으로 돌아간다
// (T11 기준 6 수리 — 종전엔 미러였고 형제 위젯과 원천이 갈렸다). 미러는 게이트가
// summary 경로 자체를 거부할 때만이다.
export async function fetchStandardSourceComposition(
  filters: StandardFilters = {},
): Promise<SourceDomainSlice[]> {
  // 세부층 예산(R2)이 걸린 경로라 degrade 를 받을 자리가 필요하다 — 빈 배열이 화면의
  // "데이터 없음" 이고, degrade 여부는 `wasDegraded("standardSourceComposition")` 로 가른다.
  return (await degradeAware("standardSourceComposition", () =>
    withStandardRoot("standardSourceComposition", [],
      (f) => viaGlobalTrend(f, "S3.citation", cachedSummaryGlobalSourceCompositionTrend,
        cachedSummaryGlobalSourceCompositionDetail,
        () => cachedSourceComposition(f)), filters))) ?? [];
}

/**
 * 대시보드 KPI 카드의 "인용 점유율 경쟁사" 행 — **인용 도메인 롤업만**(PR② T7).
 *
 * `fetchStandardCitations` 와 갈라 놓은 이유는 계약이다: 집계층 경로는 드릴다운
 * (`urls`·`promptList`·`promptSplit`)과 주 단위 추이를 **내지 못한다**(사실표 밖,
 * PR③). 그 필드를 읽는 화면이 실수로 이 경로를 타지 못하게 반환 타입 자체를
 * 도메인 배열로 좁힌다 — 주석보다 강한 방어다(리더 머리 주석과 같은 자세).
 *
 * 폴백은 종전 미러 인용 집계의 `domains` 다. 예산은 **`extras`**(15/30) — 이 경계의
 * 형제 셋과 같은 프로파일이라 실효 최악이 45 s 로 묶인다(PR④ A3). 종전에는 S3 화면과
 * 셀을 공유해 왕복이 안 늘었지만, 그 대가가 이 경계에 60 s 짜리 read 를 끼우는 것이라
 * 뒤집었다 — 프로파일이 캐시 키라 이제 셀은 갈린다.
 *
 * ── 왜 `degradeAware` 가 필요한가 (PR④ A3) ──────────────────────────────────
 *
 * 경쟁사 경계의 네 read 중 **이것만 무보호**였다. `withStandardRoot` 는 예외를 잡지
 * 않으므로, 미러 폴백이 상한에 걸리면(`57014`) 예외가 `Promise.all`(`page.tsx:279-297`)
 * 을 거부시키고 `use(competitors)`(`overview-kpi-cards.tsx`)에서 **렌더 예외**가 된다 —
 * 경쟁사 행만 빠지는 게 아니라 카드 지면이 통째로 에러 바운더리로 떨어진다.
 * 종전에는 이 경로에 예산이 아예 없어 "상한에 안 걸리니 안 터진다"였고, 예산을 붙이는
 * 바로 그 변경이 붕괴 경로를 여는 셈이라 둘을 **같은 커밋**에 둔다.
 *
 * `null` 은 여기서도 두 뜻이다("데이터 없음" vs degrade) — 화면은
 * `wasDegraded("standardCitationDomains")` 로 가른다(`COMPETITOR_LABELS` 에 등재).
 */
export async function fetchStandardCitationDomains(
  filters: StandardFilters = {},
): Promise<CitationDomainLive[] | null> {
  // ⚠️ 예산·degrade 는 캐시 **바깥**이다 — 안쪽이면 degrade 결과가 TTL 동안 굳는다
  //    (`degrade-registry.ts` 머리 주석).
  return degradeAware("standardCitationDomains", () =>
    withStandardRoot("standardCitationDomains", null,
      (f) => viaGlobalTrend<CitationDomainLive[] | null>(f, "S3.citation",
        async (...a) => {
          const read = await cachedSummaryGlobalCitations(...a);
          return read.empty ? { empty: true } : { empty: false, value: read.value.domains };
        },
        // 이 페처는 PR② 에서 새로 생겼다 — 세부층 쌍둥이가 없으므로 `agg-*` 도 미러다.
        async () => (await cachedStandardCitations(f, "extras"))?.domains ?? null,
        async () => (await cachedStandardCitations(f, "extras"))?.domains ?? null), filters));
}

/** Overview 국가별 GEO 현황 — KPI 5종 원자료. 빈 결과 = 측정 없음. */
/**
 * PR② T6 · R5 — 오늘까지 이 화면만 **미러 전용**이었다(사실표 쌍둥이
 * `summaryGlobalGeoCompetition` 은 언급 수만 내서 KPI 5종에 못 붙었다). 집계층은
 * 국가별 모수·① 분자·인용을 전부 키에 갖고 있어 **2문장**으로 끝난다.
 *
 * 국가 축은 **절단하지 않는다** — `marketStats` 의 분모가 그 시장의 전 브랜드 언급
 * 합이라, top-N 밖을 이름 없는 잔여 행으로 접으면 SoV 가 틀리거나 순위표에 이름 없는
 * 경쟁사가 뜬다(`summaryGlobalGeoKpiFromTrend` 주석).
 */
export async function fetchStandardGeoKpi(
  filters: StandardFilters = {},
): Promise<GeoKpiResult> {
  // 제외 엔티티는 행을 빼지 않고 `excluded` 표식만 단다: 시장 SOV 분모가 이 행들의 합이라
  // 빼면 값이 바뀐다. 최대 경쟁사·순위 모수만 표식을 건너뛴다(`live.ts::marketStats`).
  return withExcludedBrands(await withStandardRoot("standardGeoKpi", { brands: [], codes: [] } as GeoKpiResult,
    // ④ GEO 는 PR② 이전에도 미러였다(플랜 §6-1 "S1 GEO → 미러") — 세부층 쌍둥이가
    // 없으므로 `agg-*` 도 미러다. 형제 위젯 혼합 문제는 여기 없다: 이 위젯의 종전
    // 목적지가 이미 미러였고, 카드가 세부층으로 돌아오면 오히려 둘 다 사실표 계열이 된다.
    (f) => viaGlobalS1(f, (v) => v.geo, () => cachedGeoKpi(f), () => cachedGeoKpi(f)), filters),
    (g, ex) => {
      const brands = markExcludedGeo(g.brands, ex);
      return brands === g.brands ? g : { ...g, brands };
    });
}

export async function fetchStandardGeoCompetition(
  filters: StandardFilters = {},
): Promise<GeoBrandMention[]> {
  return withExcludedBrands((await degradeAware("standardGeoCompetition", () =>
    withStandardRoot("standardGeoCompetition", [],
      (f) => viaGlobalSummary(f, "S1.dashboard", cachedSummaryGlobalGeoCompetition,
        () => cachedGeoCompetition(f)), filters))) ?? [], markExcludedGeo);
}

const cachedBrandCitations = mirrorCache("brand-citations",
  (brandName: string, filters: StandardFilters) => aggregateBrandCitationsFromMirror(brandName, filters));

// Per-brand citation domains for the mention drilldown 인용출처 tab.
export async function fetchBrandCitations(
  brandName: string,
  filters: StandardFilters = {},
): Promise<CitationDomainLive[]> {
  return withStandardRoot("brandCitations", [], (f) => cachedBrandCitations(brandName, f), filters);
}

// Lazy per-click answer body for the mention answer modal, keyed by job_id (the
// id each MentionAnswerLive ref already carries). Answer text comes from the
// scope_* mirror, so dev/mock resolves it too; returns null when the root is
// unaddressable; { available: false } when the job has no answer body (not
// completed). Every measured job resolves — the mirror has no sample cap.
export async function fetchStandardAnswerBody(
  jobId: string,
  // 당사 배지 단위 컨텍스트 (route가 현재 화면의 필터 + 프로젝트 컨텍스트를
  // 전달). 명부(ownEntities)는 여기서 주입 — KPI 판정과 동일 규칙.
  filters: StandardFilters = {},
): Promise<import("@/lib/db/repositories/scope-aggregates").MirrorAnswerDetail | null> {
  await enforce("standardAnswerBody");
  const rootId = getStandardRootId();
  if (!rootId) return null;
  await assertProjectInScope("standardAnswerBody", rootId);
  const ownEntities = await ownEntitiesForJudgment();
  return getMirrorAnswerBody(jobId, { ...filters, ownEntities });
}

// 프로젝트/웹사이트 표면의 답변 모달 — 이 표면들의 프롬프트는 표준 카탈로그
// (prompts.brand) 밖(brand NULL)이라 getMirrorAnswerBody 의 brand 게이트가
// 비admin 계정을 전부 오차단했다 (2026-08-06 고객 피드백: AI 답변 화면 깨짐).
// 접근 검증을 표면에 맞게 대체한다: 프로젝트 = assertProjectInScope(withProject)
// + 그 프로젝트 run 소속 답변만, 웹사이트 = 스코프의 website project id 집합
// (withWebsite) run 소속 답변만. contextBrand/ownEntities 주입도 각 헬퍼가 KPI 와
// 동일 규칙으로 수행한다.
export async function fetchProjectAnswerBody(
  localProjectId: string,
  jobId: string,
  filters: StandardFilters = {},
): Promise<import("@/lib/db/repositories/scope-aggregates").MirrorAnswerDetail | null> {
  return withProject(
    "projectAnswerBody",
    localProjectId,
    null,
    (scopeProjectId, f) => getMirrorAnswerBody(jobId, f, { runProjectIds: scopeProjectId }),
    filters,
  );
}

export async function fetchWebsiteAnswerBody(
  jobId: string,
  filters: StandardFilters = {},
): Promise<import("@/lib/db/repositories/scope-aggregates").MirrorAnswerDetail | null> {
  return withWebsite(
    "websiteAnswerBody",
    null,
    (projectIds, f) => getMirrorAnswerBody(jobId, f, { runProjectIds: projectIds }),
    filters,
  );
}

// --- Website (공식 사이트 인용 현황) ---
// 표준 루트 프로젝트 대신 website_sites.scope_project_id 목록을 집계 컨텍스트로
// 사용한다. 각 (brand×country) 사이트는 독립된 scope 프로젝트이며 answerWhere의
// multi-project 경로(DISTINCT ON per project_id)로 처리된다. scope_project_id가
// 하나도 채워지지 않았으면 빈 결과 → page에서 "측정 대기" EmptyState 표시.

// 한 페이지 렌더에서 withWebsite가 6개 위젯(aggregates/trend/subKpis/
// promptTopics/sourceComposition/geoCompetition) 각각을 호출 — 매번 동일한
// (user, filters.brand)로 이 DB 조회가 반복된다. React cache()로 요청 1건당
// 1회로 접어준다. 인자를 객체(AllowedScope) 대신 문자열 키로 받는 이유: cache()는
// 인자를 참조 동일성으로 비교해 매 호출 새로 만드는 effectiveScope 객체로는
// 절대 캐시 히트가 안 남 — JSON 직렬화로 값 동일성 비교로 바꾼다.
const cachedProjectIdsForScope = cache((scopeKey: string): Promise<string[]> =>
  getProjectIdsForScope(JSON.parse(scopeKey) as AllowedScope),
);

/**
 * `withWebsite` 콜백이 추가로 받는 맥락.
 *
 * 왜 필요한가: `withWebsite` 는 브랜드 축을 project id 로 **흡수하고 `filters.brand` 를
 * 지운다.** 라이브 집계에는 그것이 맞지만(브랜드 좁히기가 project 단계에서 끝난다),
 * 발행값 경로는 "권한(런타임 어휘)" 과 "사용자가 고른 필터(발행물 어휘)" 를 갈라야
 * 하므로 **지워지기 전의 브랜드 선택**과 **필터로 좁히기 전의 계정 스코프**가 둘 다
 * 필요하다. 기존 콜백은 인자를 덜 받으므로 이 추가는 하위 호환이다.
 */
type WebsiteCallContext = {
  /** 사용자의 계정 스코프 — UI 필터로 좁히기 **전**. 권한 게이트의 입력. */
  accountScope: AllowedScope;
  /** `filters.brand` 원본(흡수·삭제되기 전). 발행물 어휘로 해석할 필터 선택. */
  selectedBrands?: string[];
};

// Common flow: enforce → 세션 scope로 website project IDs 조회 → cached fn.
async function withWebsite<T>(
  action: string,
  empty: T,
  fn: (
    projectIds: string[],
    filters: StandardFilters,
    ctx: WebsiteCallContext,
  ) => Promise<T>,
  filters: StandardFilters,
): Promise<T> {
  const { user } = await enforce(action);
  // UI의 브랜드 축(admin 전용 — hq 이하는 스코프가 이미 단일 브랜드라 안 씀)을
  // website_sites.brand 서브셋으로 반영한다. catalogIn("brand")는 여전히 0건만
  // 반환하므로(website_prompts가 표준 prompts 카탈로그 밖) filters.brand를 그대로
  // 흘리지 않고, 여기서 scope 단계의 project id 필터로 변환한다. 규칙은
  // narrowScopeBrands(hmg-brands.ts) — 필터 드롭다운 옵션 소스와 공유.
  const effectiveScope: AllowedScope = narrowScopeBrands(user.scope, filters.brand);
  // 서로 무관한 테이블(website_sites vs entity_registry) 조회라 병렬화 — 후자는
  // 이미 unstable_cache라 흔한 경로(캐시 히트)에서는 사실상 공짜.
  const [projectIds, ownEntities] = await Promise.all([
    cachedProjectIdsForScope(JSON.stringify(effectiveScope)),
    ownEntitiesForJudgment(),
  ]);
  if (!projectIds.length) return empty;
  // brand는 위에서 이미 project id 필터로 반영했으니 catalogIn 경로(0건)로 다시
  // 새지 않도록 계속 제거.
  //
  // ⚠️ 다만 brand 를 지우면 **당사 판정 입력까지 비어버린다**(GEO-1).
  // 판정은 `scope-aggregates.ts` 의 `contextBrand ?? brand` 를 읽는데, 웹사이트
  // 경로는 contextBrand 를 안 채웠으므로 둘 다 없어 3사 합산으로 폴백했다 —
  // 브랜드=Hyundai 로 좁혀도 "'당사'는 Hyundai · Kia · Genesis 합산"이 뜨고
  // 집계 자체도 3사였다. 표준 표면은 브랜드 락이 판정까지 전달되므로 **두 표면의
  // 규칙이 어긋난 상태**였다.
  //
  // contextBrand 는 **당사 판정 전용**이라 카탈로그 술어(catalogIn)에 개입하지
  // 않는다 — brand 를 지우는 위 목적과 충돌하지 않는다. 캐시 키에도 이미 들어간다
  // (normalizeFilters). admin 무필터(scope.all)는 종전대로 3사 합산이다.
  //
  // 함께 바뀌는 것: 공식(당사) 인용 판정도 같은 값에서 파생된다
  // (`ownedBasePrefixesForScope(f.contextBrand ?? f.brand, …)`) — 의도된 정합이다.
  return fn(
    projectIds,
    normalizeFilters({
      ...filters,
      brand: undefined,
      contextBrand: effectiveScope.all ? undefined : effectiveScope.brands,
      ownEntities,
    }),
    { accountScope: user.scope, selectedBrands: filters.brand },
  );
}

// website 의 공식(당사) 판정: withWebsite 가 filters.brand 를 project id 필터로
// 흡수해 제거하므로 scopeOwnedPrefixes 는 3사 전체 — 같은 표면의 당사 언급 판정
// (역시 brand 미주입 = 3사)과 동일 스코프라 화면 내 판정이 일치하고, 종전값
// (전사 카탈로그)과도 같다. website 당사 판정에 brand 를 주입하는 후속 변경이
// 오면 이 헬퍼가 자동으로 따라간다.
// 웹사이트 표면의 자사(owned) base — 선언이 있으면 그것을, 없으면 카탈로그를 쓴다.
// 이 배선은 KPI 고도화 리베이스에서 한 번 유실됐다(verifier 2026-09-02 결함 A) —
// 아래 구조 테스트가 고정한다.
// website 표면의 자사 base — 측정 유닛이 선언한 값(website_prompts.owned_base_url)을
// 우선하고, 선언이 없으면 종전 카탈로그 경로로 폴백한다(2026-09-01, migration 0049).
//
// 카탈로그(브랜드×국가)로는 실제 측정 유닛을 표현할 수 없다: 의사 국가코드
// (MIDDLEEAST·worldwide·CN-BJ·CPO)와 카탈로그 밖 도메인 때문에 19곳이 base 를 못 잡아
// **브랜드 전 세계 사이트를 자사로 세고 있었고**(현대 중동 ⑤ 31.94% vs 실제 0.73%),
// 언어별로 base 가 다른 사이트 13곳과 언어가 같은데 base 가 셋인 Genesis/SA 도 담기지
// 않는다. 선언 값은 리포트 파이프라인과 같은 규칙으로 도출돼, 두 표면의 ⑤ 가 일치한다.
// website 표면은 타겟 URL 집합에 일치하는 인용을 자사로 판정한다(2026-09-06, 제품 결정 —
// 타겟 ⊂ 자사. 규칙·실측은 scope-aggregates websiteTargetOwnedClause 주석). 선언 base
// 유무와 무관하게 켠다 — 카탈로그 폴백 경로에서도 타겟 페이지는 자사다.
const WEBSITE_TARGETS_OWNED = true;

async function websiteOwnedPrefixes(
  projectIds: string[],
  filters: StandardFilters,
): Promise<{
  prefixes: string[];
  universe: string[] | undefined;
  /**
   * 유닛 단위 자사 판정의 입력(화면 키 `X.websiteOwnedUnit`). 키가 꺼져 있으면
   * `undefined` — 그러면 집계의 SQL 이 글자 그대로 종전과 같다.
   *
   * ⚠️ **필터를 넘기지 않는다.** 유닛 base 는 유닛 고유값이라 화면 축과 무관해야
   * 한다 — flat 경로의 결함이 "필터에 따라 자사 집합이 달라져 같은 프롬프트의 판정이
   * 바뀐다" 였다. 그 성질을 `website-owned-unit.filter-invariance.test.ts` 가 고정한다.
   */
  units: WebsiteOwnedUnit[] | undefined;
}> {
  const [{ prefixes, universe }, unitOn] = await Promise.all([
    websiteDeclaredOwnedBases(filters, projectIds),
    ensureWebsiteOwnedUnit(),
  ]);
  const units = unitOn ? await websiteOwnedUnits() : undefined;
  // 선언이 있으면 형제 모집단도 선언 목록으로 — 카탈로그를 쓰면 같은 사이트의 하위
  // 경로를 남의 자산으로 오인한다. 선언이 없으면 종전 카탈로그 경로 그대로.
  return prefixes.length
    ? { prefixes, universe, units }
    : { prefixes: scopeOwnedPrefixes(filters), universe: undefined, units };
}

// S4 카드의 미러 폴백 — S1 과 같은 경계·같은 프로파일(실측 문장 10개·exec 9.7 s).
const cachedWebsiteAggregates = mirrorCache("website-aggregates",
  async (projectIds: string[], filters: StandardFilters) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateStandardFromMirror(filters, projectIds, own.prefixes, own.universe,
      WEBSITE_TARGETS_OWNED, mirrorHeavyBudget("cardsMirror"), own.units);
  }, [], undefined, true);

const cachedWebsiteTrend = mirrorCache("website-trend",
  async (projectIds: string[], filters: StandardFilters, unit: BucketUnit) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateStandardTrendFromMirror(filters, unit, projectIds, own.prefixes, own.universe,
      WEBSITE_TARGETS_OWNED, undefined, own.units);
  }, [], undefined, true);

// 예산 있음(PR④ A4 · `extras` 값) — 종전에는 **상한이 아예 없었다**. 라이브 실측
// `website:summary-deltas` 6.8~7.0 s(문장 5개 한 트랜잭션). 실효 최악 = 30 + 15 = 45 s.
//
// ⚠️ 이 상한은 **두 화면에 다 걸린다** — S4 배지(`S4.subkpi`)만이 아니라 S5 웹사이트
//    언급 화면(`S5.mention`, 미러 경로)에도 새로 적용된다. parts 축소는 S4 배지 전용이지만
//    예산은 이 셀의 성질이라 화면 키를 가리지 않는다. 초과 시 그 지면은 던지지 않고
//    `degradeAware("websiteSubKpis")` 가 **빈 결과**로 닫는다(호출부 `fetchWebsiteSubKpis`
//    의 `empty`) — 화면에서는 "데이터 없음" 과 같아 보이므로 degrade 표식으로 가른다.
// 예산은 길이로 넘긴다(`SubKpiOptions.budgetMs`) — 마감을 넘기면 `Date.now()` 가
// 캐시 키에 섞인다. `mirrorExtrasBudget()` 을 못 쓰는 이유가 그것이다.
//
// `parts` 는 **캐시 키**다: S4 배지(좁힘)와 S5 언급 화면(전량)이 셀을 공유하지 않는다.
// 자리를 필수로 둔 이유는 새 호출부가 "무엇을 읽는지" 를 고르게 강제하기 위해서다.
const cachedWebsiteSubKpis = mirrorCache("website-subkpis",
  async (
    projectIds: string[],
    filters: StandardFilters,
    parts: readonly SubKpiPart[] | undefined,
  ) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateSubKpisFromMirror(filters, projectIds, own.prefixes, own.universe,
      WEBSITE_TARGETS_OWNED, {
        parts,
        statementTimeoutMs: MIRROR_HEAVY_STATEMENT_TIMEOUT_MS,
        budgetMs: MIRROR_EXTRAS_BUDGET_MS,
      }, own.units);
  }, [], undefined, true);

const cachedWebsitePromptTopics = mirrorCache("website-prompt-topics",
  (projectIds: string[], filters: StandardFilters) =>
    aggregatePromptTopicFromMirror(filters, projectIds));

const cachedWebsiteSourceComposition = mirrorCache("website-source-composition",
  async (projectIds: string[], filters: StandardFilters) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateSourceCompositionFromMirror(filters, projectIds, own.prefixes, own.units);
  }, [], undefined, true);

const cachedWebsiteGeoCompetition = mirrorCache("website-geo-competition",
  (projectIds: string[], filters: StandardFilters) =>
    aggregateGeoCompetitionFromMirror(filters, projectIds, mirrorHeavyBudget("cardsMirror")));

// 답변 분석(언급/인용) — website Overview와 동일한 project id 집합을 쓴다.
// 이전엔 fetchStandardMentions/fetchStandardCitations(표준 루트)를 그대로
// 빌려써서 website의 "총 답변"(Overview, 자기 프로젝트 기준)과 "측정 프롬프트
// 수"(언급, 표준 루트 기준)가 서로 다른 모집단을 세고 있었다(2026-07-06 발견).
// 표준과 동일하게 슬림 캐시 — website mentions도 perBrandPrompts가 2MB 초과(13.7MB
// 실측, 2026-07-08). 드릴다운은 cachedWebsiteBrandMentionPrompts로 lazy.
// 예산 있음(PR③ · `mentions` 프로파일) — S2 와 같은 SQL 헤드라인 경로다(실측 exec 7.8 s).
const cachedWebsiteMentions = mirrorCache("website-mentions",
  (projectIds: string[], filters: StandardFilters) =>
    aggregateMentionsFromMirror(filters, projectIds, "none", mirrorHeavyBudget("mentions")));

const cachedWebsiteBrandMentionPrompts = mirrorCache("website-brand-mention-prompts",
  async (projectIds: string[], brand: string, filters: StandardFilters): Promise<MentionsPromptLive[]> => {
    const m = await aggregateMentionsFromMirror(filters, projectIds, { onlyBrand: brand });
    return m?.perBrandPrompts[brand] ?? [];
  });

// 예산 있음(PR③ · `citationsWide` 프로파일) — 126 프로젝트 모수라 S3 보다 문장이 길다
// (실측 exec 합 26.0 s · 최장 8.89 s). 인용 화면은 `cumulative` 라 게이트가 미러로 돌린다.
const cachedWebsiteCitations = mirrorCache("website-citations",
  async (projectIds: string[], filters: StandardFilters) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateCitationsFromMirror(filters, projectIds, own.prefixes, own.universe,
      WEBSITE_TARGETS_OWNED, mirrorHeavyBudget("citationsWide"), own.units);
  }, [], undefined, true);

// KPI ⑥ website 타겟 인용률 — website_prompts.target_url(공식 사이트 기대 페이지)을
// flat 타겟 셋으로. project 판정 규칙(소유 base 2개↑ 숨김)은 website에 적용 안 함:
// website는 태생적으로 다도메인이라 scope 내 전 공식 사이트 인용을 합산해 노출한다.
const cachedSummaryWebsiteCitations = mirrorCache("summary-website-trend-citations",
  async (...[, set, ids, f]: SummaryArgs): Promise<CitationTrendRead> =>
    summaryWebsiteCitationsFromTrend(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

const cachedWebsiteCitationAccuracy = mirrorCache("website-citation-accuracy",
  async (projectIds: string[], filters: StandardFilters) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateWebsiteCitationAccuracy(filters, projectIds, own.prefixes, own.universe,
      own.units);
  }, [], undefined, true);

// 타겟 URL 인용률(프롬프트 단위) — website 전용. 반드시 withWebsite 를 거쳐야 한다:
// 브랜드 축은 website 프롬프트가 표준 prompts 카탈로그 밖이라 catalogIn("brand")
// 경로로는 0건이 되고, withWebsite 가 이를 project id 필터로 흡수한 뒤 filters.brand
// 를 제거해 준다. 페이지가 리포지토리를 직접 부르면 brand 선택 시 값이 사라진다
// (2026-08-26 실측: region=GB 75/93 → brand=Genesis 추가 시 0/0).
//
// GGMD-61(2026-09-17) — 같은 문장이 **자사 URL 인용률**(프롬프트 기준)도 함께 낸다.
// 자사 판정이 ⑤ 와 같은 선언 base 를 쓰므로 `websiteOwnedPrefixes` 를 여기서 넘긴다
// (⑤·⑥ 와 같은 배선). 캐시 키는 종전과 같다 — prefixes 는 (projectIds, filters) 의
// 순수 함수라 키에 더해도 갈라지지 않는다.
const cachedWebsiteTargetHitRate = mirrorCache("website-target-hit-rate",
  async (projectIds: string[], filters: StandardFilters) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateWebsiteTargetHitRate(filters, projectIds, own.prefixes, own.universe,
      own.units);
  }, [], undefined, true);

const cachedWebsiteCitationAccuracyTrend = mirrorCache("website-citation-accuracy-trend",
  async (projectIds: string[], filters: StandardFilters, unit: BucketUnit) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateWebsiteCitationAccuracyTrend(filters, unit, projectIds, own.prefixes,
      own.universe, own.units);
  }, [], undefined, true);

// ── 사실표(summary_*) 경로 — 웹사이트 대시보드 S4 (설계 v4.1 §8) ─────────────
//
// 게이트는 **캐시 밖**에서 돈다(§8-4): 경로가 캐시 키의 일부라, 캐시 안에서
// 판정하면 킬스위치를 내려도 hit 결과가 TTL(30분) 동안 서빙된다. 요청당 여러
// 위젯이 같은 (projectIds, filters) 로 게이트를 부르므로 React cache 로 접는다.
// 2층 구조·화면 키를 뺀 이유는 글로벌 쪽 주석과 같다(PR① R2).
const cachedWebsiteSummaryBase = cache(async (key: string): Promise<SummaryReadRoute> => {
  const { p, f } = JSON.parse(key) as { p: string[]; f: StandardFilters };
  return resolveWebsiteSummaryRouteBase(p, f);
});
const cachedWebsiteSummaryRoute = cache(async (key: string): Promise<SummaryReadRoute> => {
  const { p, f, s } = JSON.parse(key) as {
    p: string[];
    f: StandardFilters;
    s: SummaryScreenKey;
  };
  const route = await applyScreenGate(
    await cachedWebsiteSummaryBase(JSON.stringify({ p, f })),
    s,
  );
  // 헤더를 붙일 수 있는 자리가 아니라(서버 컴포넌트 read) 로그로 실증한다 —
  // 값 형태는 §8-3 의 `x-hmg-summary` 와 동일(화면 검사까지 반영한 최종 판정).
  // 스위치가 꺼져 있는 동안(= 기본 상태)은 찍지 않는다: 모든 요청에 같은 줄이
  // 쌓여 신호가 죽는다.
  if (!(route.path === "mirror" && route.reason === "disabled")) {
    console.info(`x-hmg-summary(${s}): ${summaryRouteHeaderValue(route)}`);
  }
  return route;
});
const websiteSummaryRoute = (ids: string[], f: StandardFilters, s: SummaryScreenKey) =>
  cachedWebsiteSummaryRoute(JSON.stringify({ p: ids, f, s }));

// ── 추이 전용 판정 — **기간 모드**(PR③) ────────────────────────────────────
//
// 위의 스냅샷 판정과 별개의 셀이다. 회차를 **여럿** 읽는 것이 추이의 정의이고, 그
// 판정에는 스냅샷에 없는 폴백 사유가 붙는다(`unpublished-cycle-in-range` ·
// `duplicate-cycle-in-week` · `missing-cycles-in-range`, §6-3).
//
// ── 창(window) ─────────────────────────────────────────────────────────────
// 사용자가 기간을 안 골랐으면 **최근 13주**로 바운드한다. 무한 범위를 그대로 두면
// `pickCyclesInRange` 가 전 이력 회차를 집합에 넣고, 세부층(⑥)은 13주 파티션만
// 보존하므로 그 밖 회차는 조용히 0 이 된다. 13주 = 세부층 보존 창(0059 머리 주석).
// **미러 폴백에는 이 창을 넘기지 않는다** — 미러는 자기 창(TREND_WINDOW_DAYS=120일)을 쓴다.
const TREND_CYCLE_WEEKS = 13;
/**
 * 회차가 이만큼 없으면 **미러 유지**. 점 하나짜리 시계열은 차트도 Δ 도 못 만든다
 * (`WebsiteTrendSection` 이 `points.length >= 2` 를 요구한다) — 그때 회차 축으로 갈아타면
 * 종전에 보이던 주 버킷 추이가 통째로 사라진다.
 *
 * ⚠️ 세는 단위는 `anchorCount` 가 **아니라 `weeks.length`** 다. 웹사이트 함대 회차의 유일성
 *    정본이 `(project_id, cycle_week)` 이고(`cycle-set.ts::judgeCycleRange`), 프로젝트마다
 *    anchor 가 다를 수 있어(2026-09-10 실측: open 9/07주 66회차 = distinct anchor 66개)
 *    `anchorCount` 는 **한 회차를 여러 개로 센다**. 그 값을 하한에 쓰면 함대 앵커가 UTC
 *    자정을 걸친 **단일 회차**가 하한을 통과해 반쪽짜리 점 2개로 그려진다.
 *    `CycleSet.anchorCount` 주석도 같은 말을 한다("정확한 주 수는 `weeks.length`").
 *
 * 2026-09-11 실측(F3 정정 — "한 개" 는 백필 전 값이라 낡았다): 웹사이트 집계층
 * (`summary_trend_own` surface='website')에 접힌 회차 주는 **8주 · 7,244행**이고
 * 원장의 published 회차는 **509**다. 주 하한은 이미 충족됐고, 남은 것은 창 안
 * 미생성 회차(`closed` 163)의 백필이다 — 그것이 끝날 때까지는 기간 게이트가
 * `unpublished-cycle-in-range` 로 폴백한다(F1 의 skipped 면제는 **분석 갭 초과**
 * 회차에만 걸린다. 웹 163건은 갭이 아니라 백필 대기라 구멍이 맞다).
 * 백필이 끝나면 코드 변경 없이 회차 축으로 전환된다.
 */
const TREND_MIN_CYCLES = 2;

/** 기간 판정에만 쓰는 필터 — 값 필터가 아니라 **회차 범위**다(집계층 술어에는 안 들어간다). */
function trendPeriodFilters(f: StandardFilters, now: number = Date.now()): StandardFilters {
  if (f.dateFrom) return f;
  return {
    ...f,
    dateFrom: new Date(now - TREND_CYCLE_WEEKS * 7 * 86_400_000).toISOString().slice(0, 10),
  };
}

const cachedWebsiteTrendBase = cache(async (key: string): Promise<SummaryReadRoute> => {
  const { p, f } = JSON.parse(key) as { p: string[]; f: StandardFilters };
  return resolveWebsiteSummaryRouteBase(p, f, { mode: "period" });
});

/**
 * 웹사이트 **카드 계열**의 기간 판정: 추이(`cachedWebsiteTrendSet`)와 같은 판정 셀을
 * 쓰지만 필터가 다르다: 추이는 창이 없으면 13주를 얹고(`trendPeriodFilters`), 카드는
 * 화면이 실제로 고른 기간만 본다(기간이 없으면 애초에 이 함수에 오지 않는다).
 * 글로벌 쪽 `globalPeriodRoute` 와 같은 자세: 화면 검사는 판정 **밖**에서 얹는다.
 */
const websitePeriodRoute = async (
  ids: string[],
  f: StandardFilters,
  s: SummaryScreenKey,
): Promise<SummaryReadRoute> => {
  const route = await applyScreenGate(
    await cachedWebsiteTrendBase(JSON.stringify({ p: ids, f })),
    s,
  );
  if (!(route.path === "mirror" && route.reason === "disabled")) {
    console.info(`x-hmg-summary(${s} period): ${summaryRouteHeaderValue(route)}`);
  }
  return route;
};

/**
 * 추이 2종이 **함께** 보는 단일 판정. 둘이 갈리면 안 되기 때문에 한 곳으로 묶었다 —
 * ⑥ 추이는 ① 추이의 `bucketStart` 에 병합되므로(`getLiveWebsiteTrend`), 한쪽만 회차
 * 버킷으로 넘어가면 키가 어긋나 **⑥ 선이 조용히 사라진다**.
 *
 * `null` = 미러. 판정은 스냅샷 경로와 같은 층위다(게이트 → `planTrendRead` → 접힘 프로브)
 * + 회차 수 하한 하나. 세부층 쌍둥이가 없으므로 `agg-*` 도 미러로 간다.
 */
const cachedWebsiteTrendSet = cache(async (key: string): Promise<CycleSet | null> => {
  const { p, f } = JSON.parse(key) as { p: string[]; f: StandardFilters };
  const screen: SummaryScreenKey = "S4.dashboard";
  const route = await applyScreenGate(
    await cachedWebsiteTrendBase(JSON.stringify({ p, f: trendPeriodFilters(f) })),
    screen,
  );
  if (route.path !== "summary") {
    if (route.reason !== "disabled") {
      console.info(`x-hmg-summary(${screen}.trend): ${summaryRouteHeaderValue(route)}`);
    }
    return null;
  }
  // 한 자리 = 한 회차(프로젝트별). 격자 off 면 같은 객체라 종전과 바이트 동일이고,
  // 하한·캐시 키·접힘 프로브가 전부 **거른 뒤 집합**을 본다(글로벌과 같은 규율).
  const set = websiteSlotRestrictedSet(cycleSetOf(route), `${screen}.trend`);
  if (set.weeks.length < TREND_MIN_CYCLES) {
    console.info(`x-hmg-summary(${screen}.trend): fallback:agg-single-cycle weeks:${set.weeks.length} anchors:${set.anchorCount}`);
    return null;
  }
  const plan = planTrendRead({
    surface: "website",
    filters: f,
    unitFlags: await summaryUnitFlagsAvailable(),
  });
  if (!plan.ok) {
    console.info(`x-hmg-summary(${screen}.trend): fallback:${plan.reason}`);
    return null;
  }
  if (!(await cachedWebsiteFoldPresent(JSON.stringify(set)))) {
    console.info(`x-hmg-summary(${screen}.trend): fallback:agg-fold-missing`);
    return null;
  }
  console.info(`x-hmg-summary(${screen}.trend): ${summaryRouteHeaderValue(route)}`);
  return set;
});

const websiteTrendSet = (ids: string[], f: StandardFilters) =>
  cachedWebsiteTrendSet(JSON.stringify({ p: ids, f }));

// 캐시 셀은 미러 경로와 **완전히 분리**된다: 키 문자열이 다르고("summary-…"),
// 회차 id·generation id 가 인자(=invocation key)에 들어간다.
//
// 2번째 인자가 `WebsiteCyclePick[]` → `CycleSet`(T9) 으로 넓어졌다 — 집계층 리더가
// surface·projectIds·anchor 범위를 함께 요구한다. 판정값(`path`·`openRuns`)은 벗겨서
// 넘긴다: `openRuns` 는 관측 전용인데 invocation key 에 들어가면 열린 회차가 생길 때마다
// 전 캐시 셀이 갈린다.
type SummaryArgs = [cycleKey: string, set: CycleSet, projectIds: string[], filters: StandardFilters];

/** 판정 경로에서 회차 집합만 벗겨낸다(캐시 키 안정). */
const cycleSetOf = (r: Extract<SummaryReadRoute, { path: "summary" }>): CycleSet => ({
  surface: r.surface,
  mode: r.mode,
  cycles: r.cycles,
  cycleKey: r.cycleKey,
  projectIds: r.projectIds,
  missingProjectIds: r.missingProjectIds,
  weeks: r.weeks,
  anchorCount: r.anchorCount,
  // 글로벌 쪽 `globalCycleSetOf` 의 ⚠️ 와 같은 규칙·같은 이유(격자 키 뒤).
  ...(trendGridApplied(r) && r.citationExcludedCycleIds
    ? { citationExcludedCycleIds: r.citationExcludedCycleIds }
    : {}),
});

/**
 * 함대 표면의 **한 자리 = 한 회차**(2026-09-20). 글로벌과 같은 결함이 구조적으로
 * 가능하다: 회차 귀속 날짜는 `scope_cycle_rounds(project_id, anchor_date → round_date)`
 * 매핑이 정하므로, **같은 프로젝트의 서로 다른 주 회차 둘이 한 `round_date` 로** 접힐 수
 * 있다(글로벌 2026-08-17 자리가 정확히 그 모양이다 — 주 08-10 회차 + 주 08-17 회차).
 * 그러면 카드·추이가 그 자리를 두 번 센다.
 *
 * 글로벌과 다른 점 둘:
 *   · 대표를 **(프로젝트, 자리)** 마다 고른다(`perProject`). 날짜만으로 묶으면 그 자리의
 *     사이트 수십 개가 회차 하나로 접힌다 — 값이 틀리는 방향이다.
 *   · 함대 대표(`restrictToFleetVisible`)·완결성(`restrictToCompleteCycles`)은 걸지
 *     않는다. 전자는 게이트가 이미 `duplicate-cycle-in-week` 로 막아 무의미하고, 후자는
 *     자리 판정 단위가 함대 전체라 의미론이 따로 정해져야 한다(이 변경의 범위 밖).
 *
 * 격자 키가 꺼져 있으면 `restrictToSlotRepresentative` 가 **입력 객체 그대로**를 내므로
 * 캐시 키·문장·값이 한 글자도 안 바뀐다.
 */
function websiteSlotRestrictedSet(set: CycleSet, tag: string): CycleSet {
  if (set.mode !== "period" || !trendGridApplied(set)) return set;
  const { set: repSet, mergedSlots, familySplitSlots } = restrictToSlotRepresentative(
    set,
    { perProject: true },
  );
  if (mergedSlots.length > 0) {
    console.info(
      `x-hmg-summary(${tag}): slot-merged:${mergedSlots.join(",")} → cycles:${repSet.anchorCount}`,
    );
  }
  if (familySplitSlots.length > 0) {
    console.info(`x-hmg-summary(${tag}): family-split:${familySplitSlots.join(",")}`);
  }
  return repSet;
}

/**
 * **한 화면에 두 정의가 남는 조합을 소리 내게 한다** (2026-09-20 검증 B 수리).
 *
 * website 표면에는 자사 판정 경로가 둘이고 **스위치가 서로 다르다**:
 *   · 미러 집계  — 화면 키 `X.websiteOwnedUnit`
 *   · 사실표(`summary_*`)·기간 비교 — `summaryUnitFlagsAvailable()`
 *     (= `summary_answers.unit_owned` 컬럼 존재, migration 0060.
 *      판정 지점: `summary-website-aggregates.ts::ownedCitationsSum` ·
 *      `summary-trend-aggregates.ts::ownedCitationsAgg`)
 *
 * 둘이 같은 방향이면 두 경로가 정합한다. 그런데 **키 on + `unitFlags` false** 면
 * 미러 타일만 유닛으로 내려가고 사실표·기간비교 타일은 flat 로 남는다 — 이 트랙이
 * 막으려던 상태가 경로 경계에서 그대로 재현된다. 코드로 막을 수는 없다(컬럼이 없으면
 * 사실표에 유닛 값이 **존재하지 않는다**). 그래서 **관측 가능하게** 만든다.
 *
 * 프로세스당 한 번만 찍는다 — 요청마다 같은 줄이 쌓이면 신호가 죽는다.
 */
let ownedUnitSplitWarned = false;
function warnIfOwnedUnitDefinitionSplit(unitFlags: boolean, where: string): void {
  if (unitFlags || ownedUnitSplitWarned) return;
  ownedUnitSplitWarned = true;
  console.warn(
    `[website-owned-unit] 키는 켜졌는데 summary_answers.unit_owned(0060) 가 없다(${where}) — ` +
      "미러 타일은 유닛 판정, 사실표·기간 비교 타일은 flat 이다. 한 화면에 두 정의가 남는다. " +
      "확인: SELECT 1 FROM information_schema.columns WHERE table_name='summary_answers' AND column_name='unit_owned'",
  );
}

const summaryScopeOf = async (
  set: CycleSet,
  projectIds: string[],
  filters: StandardFilters,
) => {
  // 유닛 플래그(0060) 프로브는 캐시 안에서 돌아도 된다 — 값이 바뀌는 방향이 한쪽
  // (없음→있음)이고, 프로브 자체가 프로세스당 1회 + 짧은 TTL 재판정이다.
  const [own, unitFlags, excludedUnits] = await Promise.all([
    websiteOwnedPrefixes(projectIds, filters),
    summaryUnitFlagsAvailable(),
    websiteExcludedUnits(),
  ]);
  if (own.units) warnIfOwnedUnitDefinitionSplit(unitFlags, "summary");
  return {
    set,
    cycles: set.cycles as WebsiteCyclePick[],
    projectIds,
    filters,
    ownedBasePrefixes: own.prefixes,
    unitFlags,
    excludedUnits,
  };
};

// 카드(①~⑤·도넛)와 GEO 는 **한 셀·한 read** 다(T5 라운드 2). `trend_brands` 의
// GROUPING SETS 가 브랜드 축과 국가 축을 한 스캔에서 내므로 두 위젯이 그 표를 두 번
// 스캔할 이유가 없다 — 라운드 1은 위젯마다 리더를 불러 렌더당 12문장이었고 지금은
// 카드+GEO 3문장 · 출처 1문장이다.
// 셀을 더 합치지 않는 이유는 페이로드다(2026-09-10 함대 실측: 카드 664 KB + GEO 288 KB
// = 952 KB, 출처 405 KB. 셋을 한 셀에 담으면 1,358 KB 로 Next Data Cache 상한 2 MB 에
// 근접한다).
const cachedSummaryWebsiteDashboard = mirrorCache("summary-website-dashboard",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteDashboard(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

// ── 세부층 사실표 셀(PR② 이전 경로) — `agg-*` 폴백 목적지 ───────────────────
// 집계층 셀과 **키가 다르므로**(문자열 접두가 다르다) 값이 섞이지 않는다.
const cachedSummaryWebsiteAggregatesDetail = mirrorCache("summary-website-aggregates-detail",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteAggregatesDetail(await summaryScopeOf(set, ids, f), mirrorHeavyBudget("detail")),
  [SUMMARY_TAG]);

// 세부층에도 예산(R2) — `mirrorHeavyBudget("detail")`. 초과하면 **미러가 아니라**
// degrade 다: 세부층이 거부됐다고 미러로 내려가면 한 화면에 두 원천이 섞인다
// (T11 기준 6). 예외는 캐시 밖 `degradeAware` 가 받는다.
const cachedSummaryWebsiteSubKpisDetail = mirrorCache("summary-website-subkpis-detail",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteSubKpisDetail(await summaryScopeOf(set, ids, f), mirrorHeavyBudget("detail")),
  [SUMMARY_TAG]);

const cachedSummaryWebsiteSourceCompositionDetail = mirrorCache("summary-website-source-detail",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteSourceCompositionDetail(await summaryScopeOf(set, ids, f), mirrorHeavyBudget("detail")),
  [SUMMARY_TAG]);

const cachedSummaryWebsiteGeoCompetitionDetail = mirrorCache("summary-website-geo-detail",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteGeoCompetitionDetail(await summaryScopeOf(set, ids, f), mirrorHeavyBudget("detail")),
  [SUMMARY_TAG]);

const cachedSummaryWebsiteSubKpis = mirrorCache("summary-website-subkpis",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteSubKpis(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

const cachedSummaryWebsitePromptTopics = mirrorCache("summary-website-prompt-topics",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsitePromptTopics(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

const cachedSummaryWebsiteSourceComposition = mirrorCache("summary-website-source-composition",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteSourceComposition(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

const cachedSummaryWebsiteCitationAccuracy = mirrorCache("summary-website-citation-accuracy",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteCitationAccuracy(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

// 자사·타겟 URL 인용률(GGMD-61): 사실표 `summary_url_hits`(0081). 커버리지 미달이면
// **null** 이고(리더 머리 주석), 호출부가 미러로 간다. null 도 셀에 **그대로 캐시된다.**
// 키의 `cycleKey`(= cycle:generation 쌍)는 **재생성**(새 generation)이면 바뀌지만,
// 백필(`generate-cycle --url-hits`)은 generation 을 안 바꾸므로 키가 같다: 무효화 없이
// 백필하면 캐시된 null(= 미러 폴백)이 셀 TTL(최대 2시간) 동안 서빙된다. 그래서 백필 CLI 는
// `--yes` 에서 revalidate 가 **기본**이다(`--no-revalidate` 로만 끄고, `--revalidate-only` 로
// 따로 부른다).
// ⚠️ 무효화는 `HMG_INTERNAL_BASE_URL` 이 가리키는 **배포 하나**에만 걸린다(Data Cache 는
//    배포별). 프리뷰를 비우려면 프리뷰 URL + 프리뷰의 `CRON_SECRET` + 보호 우회
//    (`HMG_INTERNAL_BYPASS_SECRET`)가 필요하다. 프로덕션을 가리키면 라우트가
//    `MIRROR_AGGREGATE_TAG` 도 무효화해 **프로덕션 미러 캐시 전체가 콜드**가 된다.
const cachedSummaryWebsitePromptHitRates = mirrorCache("summary-website-prompt-hit-rates",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsitePromptHitRates(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

// 추이 2종(PR③) — 회차 집합이 invocation key 에 들어가므로 스냅샷 셀과 섞이지 않는다.
// `unit` 은 키에 넣지 않는다: 회차 버킷은 주/일 선택과 무관하다(축 자체가 회차다).
const cachedSummaryWebsiteTrend = mirrorCache("summary-website-trend",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteTrend(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

const cachedSummaryWebsiteCitationAccuracyTrend = mirrorCache("summary-website-citation-accuracy-trend",
  async (...[, set, ids, f]: SummaryArgs) =>
    summaryWebsiteCitationAccuracyTrend(await summaryScopeOf(set, ids, f)),
  [SUMMARY_TAG]);

// 사실표 hit 이면 사실표 읽기를, 아니면 종전 미러 읽기를 그대로 부른다.
// 반환 타입이 같으므로 호출부(화면)는 경로를 모른다.
async function viaSummary<T>(
  ids: string[],
  f: StandardFilters,
  screen: SummaryScreenKey,
  onSummary: (...args: SummaryArgs) => Promise<T>,
  onMirror: () => Promise<T>,
): Promise<T> {
  const route = await websiteSummaryRoute(ids, f, screen);
  // 사실표 경로는 **회차가 있는 프로젝트만** 모수로 삼는다 — 회차 없는 사이트는
  // 이번 회차 데이터가 없는 것이지, 옛 값으로 메울 대상이 아니다(제품 책임자 2026-09-06).
  // 자사 base($sel)·타겟 키($tk)도 같은 좁힌 집합에서 파생돼야 판정 스코프가 맞는다.
  return route.path === "summary"
    ? onSummary(route.cycleKey, cycleSetOf(route), route.projectIds, f)
    : onMirror();
}

// ── 집계층(summary_trend_*) 경로 판정 — PR② T5 · 폴백 목적지 수리(T11 기준 6) ──
//
// 폴백은 **두 갈래**다. 어디로 떨어지느냐가 값의 정합을 가른다.
//
//   ┌ 게이트가 summary 경로 자체를 거부 ─────────────→ **미러**(종전 SQL)
//   │   회차 없음 · 화면 allowlist 밖 · `cumulative` · 원장 미적용 · 스위치 off
//   │   = 사실표(세부층)도 못 읽는 상태다. 사유는 `gate.ts` 가 낸다.
//   └ 집계층만 거부 ────────────────────────────────→ **세부층 사실표**
//       `planTrendRead` 미지원 축(depth2/3 · own_variant 밖) · 접힘 미실행 · 리더 `empty`
//
// 아래 갈래를 미러로 보내던 것이 T11 기준 6의 실패였다. 같은 화면의 형제 위젯
// (주제 도넛 `summaryWebsitePromptTopics`·⑥)은 세부층에 남아 있어서, `?depth2=` 나
// admin 브랜드 다중 선택 같은 축에서 **한 화면에 미러(카드)와 사실표(형제)가 섞였다** —
// 회차 창이 다르니 모수·언급이 어긋난다(글로벌 실측 카드 3,080 vs 형제 2,992).
// PR② 이전에는 이 자리가 세부층이었다(`viaSummary`) — 그 목적지를 돌려놓는다.
//
// 프로브는 회차 집합당 1회로 접는다(React cache) — 한 렌더에서 여러 위젯이 부른다.
const cachedWebsiteFoldPresent = cache(async (key: string): Promise<boolean> =>
  timedFoldProbe("website", ["own"], trendFoldPresent("website", JSON.parse(key) as CycleSet)));

/**
 * 리더 read 에서 위젯 하나분을 뽑는다 — 폴백 신호(`empty`)는 **그대로 흘린다**.
 * 한 셀(카드+GEO)을 두 위젯이 나눠 쓰는 자리에서 쓴다.
 */
const pickRead = <T, U>(
  r: SummaryTrendRead<T>,
  pick: (v: T) => U,
): SummaryTrendRead<U> => (r.empty ? r : { empty: false, value: pick(r.value) });

async function viaTrend<T>(
  ids: string[],
  f: StandardFilters,
  screen: SummaryScreenKey,
  /**
   * 집계층 리더. **폴백 신호를 값과 함께** 낸다 — `empty` 면 세부층으로 간다
   * (PR③ R3: 종전에는 이 자리가 값만 받아 `agg-empty` 분기가 없었고, 모수가 안 접힌
   * 슬라이스가 화면에 0 으로 그려질 수 있었다. `viaGlobalTrend` 와 같은 모양이다).
   */
  onSummary: (...args: SummaryArgs) => Promise<SummaryTrendRead<T>>,
  /** 집계층만 거부됐을 때(= `agg-*`) 갈 곳. PR② 이전 경로인 세부층 사실표. */
  onDetail: (...args: SummaryArgs) => Promise<T>,
  /** 게이트가 summary 경로 자체를 거부했을 때(= `gate-*`) 갈 곳. */
  onMirror: () => Promise<T>,
): Promise<T> {
  // 기간이 걸린 요청은 **회차 집합 모드**로 판정한다(옵트인 `S4.periodRoute` 또는
  // 프리뷰 전용 env). 글로벌 쪽 `viaGlobalS1` 과 같은 계약이고, 키·env 가 꺼져 있거나
  // 기간이 없으면 종전 스냅샷 판정 그대로다.
  //
  // ⚠️ 판정 입력은 **화면 키**다(F2). 이 게이트는 카드 말고 언급(S5)·인용(S6) 계열도
  //    부르는데, 그 둘은 전환 파급이 커서 별도 승인 대상이다. `periodRouteEnabledForScreen`
  //    의 매핑에 없는 화면은 스위치가 켜져 있어도 종전 경로 그대로다.
  const route = (await periodRouteEnabledForScreen(screen, f))
    ? await websitePeriodRoute(ids, f, screen)
    : await websiteSummaryRoute(ids, f, screen);
  if (route.path !== "summary") return onMirror();
  // 카드도 **한 자리 = 한 회차**로 읽는다(글로벌 `viaGlobalS1` 과 같은 방침).
  // 스냅샷 모드·격자 off 에서는 같은 객체가 돌아오므로 `set.cycleKey === route.cycleKey`
  // 이고 아래 두 호출의 인자가 종전과 바이트 동일이다.
  const set = websiteSlotRestrictedSet(cycleSetOf(route), screen);
  // 키 조각은 **거른 뒤 집합**의 것으로 통일한다(아래 `onSummary` 와 같은 이유).
  // 스냅샷 모드·격자 off 에서는 `set === cycleSetOf(route)` 라 값이 같다.
  const detail = () => onDetail(set.cycleKey, set, route.projectIds, f);
  // ⚠️ 기간 모드의 `agg-*` 폴백 목적지는 **미러**다(`viaGlobalS1` 의 ⚠️ 와 같은 규칙):
  //    세부층은 단일 회차만 읽으므로 "30일" 라벨 아래 1회차 값이 조용히 실린다.
  const period = route.mode === "period";
  const aggFallback = period ? onMirror : detail;
  const tag = period ? `${screen} period` : `${screen}`;
  const dest = period ? "mirror" : "detail";
  const plan = planTrendRead({
    surface: "website",
    filters: f,
    unitFlags: await summaryUnitFlagsAvailable(),
  });
  if (!plan.ok) {
    console.info(`x-hmg-summary(${tag}): fallback:${plan.reason} → ${dest}`);
    return aggFallback();
  }
  // A1 — 프로브·read 동시 발행. 목적지·로그·판정 순서는 종전과 같다.
  const gated = await foldGated(
    cachedWebsiteFoldPresent(JSON.stringify(set)),
    // 캐시 키 조각은 **거른 뒤 집합**의 것이어야 한다 — `route.cycleKey` 를 쓰면 좁히기
    // 전 키로 셀이 서는데 내용은 새 집합이라 두 집합이 한 셀을 공유한다(글로벌 쪽
    // `server.global-trend-fleet-visible.test.ts` ② 가드와 같은 규율).
    () => onSummary(set.cycleKey, set, route.projectIds, f),
  );
  if (!gated.folded) {
    console.info(`x-hmg-summary(${tag}): fallback:agg-fold-missing → ${dest}`);
    return aggFallback();
  }
  const out = gated.value;
  if (out.empty) {
    console.info(`x-hmg-summary(${tag}): fallback:agg-empty → ${dest}`);
    return aggFallback();
  }
  return out.value;
}

// 요청단위 dedup — 웹사이트도 필터바(측정 기준일 슬롯)와 본문(DashboardBody →
// getLiveWebsiteDashboard)이 같은 read 를 부른다(2026-09-01, 표준과 동일 이유).
export const fetchWebsiteAggregates = requestDeduped(
  "fetchWebsiteAggregates",
  async (filters: StandardFilters = {}): Promise<StandardAggregates | null> =>
    // 제외 엔티티: 표준 카드와 같다(`brands` 에서만, KPI #16 경쟁사 자동 선정 입력).
    withExcludedBrands(await degradeAware("websiteAggregates", () =>
      withWebsite("websiteAggregates", null,
        (ids, f) => viaTrend(ids, f, "S4.dashboard",
          async (...a) => pickRead(await cachedSummaryWebsiteDashboard(...a), (v) => v.aggregates),
          cachedSummaryWebsiteAggregatesDetail,
          () => cachedWebsiteAggregates(ids, f)), filters)), filterAggregatesBrands),
);

// ── 추이 2종 = **회차 버킷**(PR③, D-4(1) 해제) ──────────────────────────────
//
// PR② T5 는 이 둘을 미러에 남겼다. 남긴 이유가 능력 부족이 아니라 **화면 의미**
// (x축이 주 → 회차로 바뀌고 Δ 정의가 따라 바뀐다)였고, 그 결정을 PR③ 에서 뒤집는다.
// 라이브 실측(2026-09-10 04:20Z, 게이트 ON): `website:trend` **27.8~28.6 s** = P1.
//
// 두 페처가 같은 판정(`websiteTrendSet`)을 본다 — 한쪽만 회차 버킷으로 넘어가면
// ⑥ 병합 키(`bucketStart`)가 어긋나 ⑥ 선이 조용히 사라진다.
// 폴백은 **미러 한 곳**이다: 세부층 쌍둥이(주 버킷 추이)가 애초에 없다.
export async function fetchWebsiteTrend(
  filters: StandardFilters = {},
  unit: BucketUnit = "week",
): Promise<StandardTrendBucket[]> {
  return withWebsite("websiteTrend", [] as StandardTrendBucket[], async (ids, f) => {
    // 공용 격자(D5). website 자리는 **금요일**이고 07-31 은 결번이다(W0 실측) —
    // 종전 `fillGaps` 가 금요일 격자를 기계적으로 메워 만들던 그 빈 슬롯이 사라진다.
    const slots = await trendSlotsFor({
      surface: "website",
      projectIds: ids,
      family: "all",
      filters: f,
      unit,
    });
    f = withTrendGridWindow(f, slots);
    const set = await websiteTrendSet(ids, f);
    const buckets = set
      ? await cachedSummaryWebsiteTrend(set.cycleKey, set, set.projectIds, f)
      : await cachedWebsiteTrend(ids, f, unit);
    // 갭 슬롯(0070)은 캐시 밖에서 — 글로벌 경로(`fetchStandardTrend`)와 같은 자세.
    // 함대는 프로젝트가 여럿이라 숨긴 회차도 여럿일 수 있다: 같은 주에 여러 사이트가
    // 숨겨졌으면 키가 같으므로 슬롯은 하나다(`insertTrendGapSlots` 가 중복을 접는다).
    return applyTrendGridToBuckets(
      await withTrendGapBuckets(buckets, unit, "website", ids),
      slots,
    );
  }, filters);
}

/**
 * 웹사이트 Sub-KPI — 두 화면이 부르고 **화면 키가 다르다**(PR③-a B6).
 *
 *   S5 언급 화면(기본값)  `S5.mention` — 화면 전체가 미러 누적 의미론. T8·GGMD 전까지 off.
 *   S4 대시보드 배지      `S4.subkpi`  — 같은 카드의 ①~⑤ 가 회차 스냅샷이라 배지도 회차여야 한다.
 *
 * 왜 갈랐나: `S5.mention` 이 프로덕션 `read_screens` 에 없어 **S4 카드의 배지까지 미러**로
 * 떨어졌고, 그것이 `website:summary` 11.5~13.5 s 의 원인이었다(프로덕션 진짜 콜드 실측).
 * 두 키의 의미론 차이·미러 vs 집계층 실측 표는 `lib/summary/read/screens.ts` 의 예외 블록.
 *
 * ⚠️ `S4.subkpi` 는 **off 로 머지**한다 — 켜면 배지 숫자가 바뀐다(미러 ≠ 집계층, 정수 0
 *    오차 아님). 성능 변경이 아니라 고객이 보는 값의 변경이라 승인 대상이다.
 */
export async function fetchWebsiteSubKpis(
  filters: StandardFilters = {},
  opts: { screen?: SummaryScreenKey } = {},
): Promise<StandardSubKpis> {
  const screen = opts.screen ?? "S5.mention";
  const empty: StandardSubKpis = { rows: [], promptsWithoutBrand: null, measuredPrompts: null };
  // 미러 폴백의 파트 축소(PR④ A4) — **S4 배지에서만**. 그 지면은 `sub.rows` 만 읽고
  // Q5(`prompts`)가 채우는 두 필드를 안 읽는다(`S4_BADGE_SUB_KPI_PARTS` 의 전수 표).
  // S5 언급 화면은 `undefined` = 전량이라 종전과 완전히 같은 산출이다.
  //
  // ⚠️ 좁히는 것은 **미러 경로뿐**이다. 집계층·세부층 리더는 자기 리더가 내는 것을
  //    그대로 낸다 — 그쪽에는 파트 축이 없다.
  const parts = screen === "S4.subkpi" ? S4_BADGE_SUB_KPI_PARTS : undefined;
  // 세부층 폴백에도 예산이 있으므로(PR③ 위생 A · `detail` 프로파일) 시간 초과를 받을
  // 자리가 필요하다 — 빈 형태가 화면의 "데이터 없음" 이고 degrade 여부는 표식이 가른다.
  return (await degradeAware("websiteSubKpis", () =>
    withWebsite("websiteSubKpis", empty,
      // Sub-KPI 는 PR② 라운드 2에서 집계층으로 옮겼다 — `viaSummary` 로 두면 거부 축에서
      // 리포지터리가 throw 한다(`trendScopeOf`). `viaTrend` 로 세부층 폴백을 준다.
      (ids, f) => viaTrend(ids, f, screen, cachedSummaryWebsiteSubKpis,
        cachedSummaryWebsiteSubKpisDetail,
        () => cachedWebsiteSubKpis(ids, f, parts)), filters))) ?? empty;
}

const cachedWebsiteSubKpisPrev = mirrorCache("website-subkpis-prev",
  async (projectIds: string[], filters: StandardFilters) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return subKpisPrevImpl(filters, projectIds, own.prefixes, own.universe, WEBSITE_TARGETS_OWNED,
      undefined, own.units);
  }, [], undefined, true);

export async function fetchWebsiteSubKpisPrev(
  filters: StandardFilters = {},
): Promise<PrevSubKpis | null> {
  return withWebsite("websiteSubKpisPrev", null,
    (ids, f) => cachedWebsiteSubKpisPrev(ids, f), filters);
}

export async function fetchWebsitePromptTopics(
  filters: StandardFilters = {},
): Promise<PromptTopicSlice[]> {
  return withWebsite("websitePromptTopics", [],
    (ids, f) => viaSummary(ids, f, "S4.dashboard", cachedSummaryWebsitePromptTopics,
      () => cachedWebsitePromptTopics(ids, f)), filters);
}

export async function fetchWebsiteSourceComposition(
  filters: StandardFilters = {},
): Promise<SourceDomainSlice[]> {
  return (await degradeAware("websiteSourceComposition", () =>
    withWebsite("websiteSourceComposition", [],
      (ids, f) => viaTrend(ids, f, "S6.citation", cachedSummaryWebsiteSourceComposition,
        cachedSummaryWebsiteSourceCompositionDetail,
        () => cachedWebsiteSourceComposition(ids, f)), filters))) ?? [];
}

export async function fetchWebsiteGeoCompetition(
  filters: StandardFilters = {},
): Promise<GeoBrandMention[]> {
  // 표준 GEO 와 같다: 행은 두고 `excluded` 표식만(시장 SOV 분모 보존).
  return withExcludedBrands((await degradeAware("websiteGeoCompetition", () =>
    withWebsite("websiteGeoCompetition", [],
      (ids, f) => viaTrend(ids, f, "S4.dashboard",
        async (...a) => pickRead(await cachedSummaryWebsiteDashboard(...a), (v) => v.geo),
        cachedSummaryWebsiteGeoCompetitionDetail,
        () => cachedWebsiteGeoCompetition(ids, f)), filters))) ?? [], markExcludedGeo);
}

export async function fetchWebsiteCitationAccuracy(
  filters: StandardFilters = {},
): Promise<CitationAccuracyResult> {
  return withWebsite("websiteCitationAccuracy", { ownedAnswers: 0, targetAnswers: 0, rate: null },
    (ids, f) => viaSummary(ids, f, "S6.citation", cachedSummaryWebsiteCitationAccuracy,
      () => cachedWebsiteCitationAccuracy(ids, f)), filters);
}

/** ⑥ 추이 — 집계층 밖(세부층 1문장, 회차 축). 경로 판정은 ① 추이와 **같은 셀**이다. */
export async function fetchWebsiteCitationAccuracyTrend(
  filters: StandardFilters = {},
  unit: BucketUnit = "week",
): Promise<CitationAccuracyTrendBucket[]> {
  return withWebsite("websiteCitationAccuracyTrend", [], async (ids, f) => {
    // ⑥ 도 **같은 자리**에 선다(검증 B4). 메인 추이만 격자를 타면 원장에 없는 주
    // (website 07-31)가 ⑥ 한 차트에만 남고, 프로젝트 지면의 병합
    // (`mergeProjectTrendAccuracy`)은 그 자리를 **점으로 새로 만든다**.
    const slots = await trendSlotsFor({
      surface: "website",
      projectIds: ids,
      family: "citations",
      filters: f,
      unit,
    });
    f = withTrendGridWindow(f, slots);
    const set = await websiteTrendSet(ids, f);
    const buckets = set
      ? await cachedSummaryWebsiteCitationAccuracyTrend(set.cycleKey, set, set.projectIds, f)
      : await cachedWebsiteCitationAccuracyTrend(ids, f, unit);
    // **가두기만** 한다 — 갭 행은 메인 추이가 만든다. ⑥ 은 그 위에 얹히는 선이라
    // 없는 자리에 점을 찍으면 음영 위에 점이 얹힌다.
    return restrictToTrendGrid(buckets, toTrendGridSlotViews(slots) ?? null);
  }, filters);
}

// 요청단위 dedup — 웹사이트 언급 화면의 필터바 슬롯 + 본문 공유 read.
export const fetchWebsiteMentions = requestDeduped(
  "fetchWebsiteMentions",
  // ⚠️ 중첩 순서는 **`degradeAware` 가 바깥**이다(표준 표면과 같은 자세).
  //    `withWebsite` 안에는 `enforce`·`cachedProjectIdsForScope`·`ownEntitiesForJudgment`
  //    가 있어, 이것이 뒤집히면 그 세 단계의 57014(예산 초과)가 degrade(null) 가 아니라
  //    **throw** 가 된다 — 지면이 비는 대신 500 이 난다.
  async (filters: StandardFilters = {}): Promise<MentionsLive | null> =>
    // 제외 엔티티: 표준 언급과 같은 표시 필터(`filterMentionsLive`).
    withExcludedBrands(await degradeAware("websiteMentions", () =>
      withWebsite("websiteMentions", null as MentionsLive | null, async (ids, scoped) =>
        // 갭 슬롯은 degrade 보호 **안**에서, 미러 결과에 얹는다(ids 가 여기서만 보인다).
        withWeeklyTrendGrid({
          surface: "website", gridSurface: "website", projectIds: ids,
          family: "mention", filters: scoped,
          read: (f) => cachedWebsiteMentions(ids, f),
        }), filters)), filterMentionsLive),
);

// 웹사이트 멘션 드릴다운 "프롬프트" 탭 lazy fetch — brand-citations의 website 경로와
// 동일 (surface=website).
export async function fetchWebsiteBrandMentionPrompts(
  brand: string,
  filters: StandardFilters = {},
): Promise<MentionsPromptLive[]> {
  return withWebsite("websiteBrandMentionPrompts", [],
    (ids, f) => cachedWebsiteBrandMentionPrompts(ids, brand, f), filters);
}

// 요청단위 dedup — 웹사이트 인용 화면의 필터바 슬롯 + 본문 공유 read.
export const fetchWebsiteCitations = requestDeduped(
  "fetchWebsiteCitations",
  // 중첩 순서는 `fetchWebsiteMentions` 와 같다(`degradeAware` 가 바깥).
  async (filters: StandardFilters = {}): Promise<CitationsLive | null> =>
    degradeAware("websiteCitations", () =>
      withWebsite("websiteCitations", null as CitationsLive | null, async (ids, scoped) =>
        withWeeklyTrendGrid({
          surface: "website", gridSurface: "website", projectIds: ids,
          family: "citation", filters: scoped,
          read: (f) => cachedWebsiteCitations(ids, f),
        }), filters)),
);

/**
 * 웹사이트 인용 도메인 롤업 — 글로벌 `fetchStandardCitationDomains` 의 대응(PR② T7).
 *
 * ⚠️ **오늘 이 경로를 타는 화면은 없다.** 웹사이트 인용 화면은 `cumulative: true` 를
 *    걸어(`website/answer-analysis/citation/page.tsx:63`) 게이트가 미러로 돌리고,
 *    웹사이트 대시보드는 인용 도메인을 안 그린다. 그래도 두는 이유는 두 표면의
 *    리더가 **같은 조립 코드**를 쓰는지 패리티 하네스가 확인해야 하기 때문이고,
 *    누적 표면이 회차 집합 SUM 으로 옮겨질 때(PR③) 배선이 한 줄이 되기 때문이다.
 */
export async function fetchWebsiteCitationDomains(
  filters: StandardFilters = {},
): Promise<CitationDomainLive[] | null> {
  return withWebsite("websiteCitationDomains", null,
    (ids, f) => viaTrend<CitationDomainLive[] | null>(ids, f, "S6.citation",
      async (...a) => {
        // 셀 **안**의 `empty` 를 이제는 게이트로 되돌린다(PR③ R3) — `viaTrend` 가
        // `agg-empty → detail` 을 갖게 됐으므로 여기서 미러를 직접 부를 이유가 없다.
        // 이 페처의 `onDetail` 이 곧 그 미러라 결과 값도 종전과 같다.
        const read = await cachedSummaryWebsiteCitations(...a);
        return read.empty
          ? { empty: true as const }
          : { empty: false as const, value: read.value.domains };
      },
      // 이 페처는 PR② 에서 새로 생겼다 — 세부층 쌍둥이가 없으므로 `agg-*` 도 미러다.
      async () => (await cachedWebsiteCitations(ids, f))?.domains ?? null,
      async () => (await cachedWebsiteCitations(ids, f))?.domains ?? null), filters);
}

// ── 발행 리포트를 정본으로 (`X.reportTruth`, 2026-09-20) ─────────────────────
//
// 발행 회차의 두 카드(타겟 URL 인용률 · 자사 URL 인용률)는 라이브 집계 대신 **고객이
// 실제로 받은 리포트의 정수 쌍**을 읽는다. 값이 라이브에서 파생되지 않으므로 미러
// 재싱크·재분석·늦은 도착에도 흔들리지 않는다(스펙 I-4).
//
// 발행값으로 답할 수 없는 조합은 **라이브로 폴백하되 `source` 표식을 바꾼다** — 조용히
// 섞지 않는다(I-5). 판정 술어는 `lib/reports/truth-axes.ts` 한 곳에 모여 있다.

/** 카드가 받는 값. 기본 필드는 종전 그대로이고 출처 표식만 덧붙는다. */
export interface WebsitePromptHitRates extends WebsiteTargetHitRateResult {
  /**
   * 값의 출처. **키가 꺼져 있으면 아예 없다** — 종전 객체와 바이트 단위로 같게 두려는
   * 것이다(off 회귀 테스트가 이 부재를 단언한다).
   */
  source?: "published" | "live";
  publication?: {
    slug: string;
    cycleLabel: string | null;
    cycleLabelEn: string | null;
    roundDate: string;
    /** 이 값에 실제로 들어간 발행 사이트 수(모수 표시용). */
    siteCount: number;
    /** 헤드라인 풀 규칙이 실제로 유닛을 뺐는가. */
    headlinePoolApplied: boolean;
    manifestVerified: boolean;
  };
  /**
   * 직전 회차의 **같은 발행물 안** 정수 쌍(q6·qo). 증감을 발행값끼리 뺄 수 있게 둔다 —
   * 한쪽만 발행값이고 한쪽이 라이브면 증감이 시점 차이를 흡수해 버린다.
   * ⚠️ 이 카드는 현재 증감을 **렌더하지 않는다**. 소비자가 생기는 후속 change 에서
   *    쓰라고 값만 실어 둔다(그래서 지금 섞여 빠질 자리가 없다).
   */
  prev?: { hitPrompts: number; ownedPrompts: number; measuredPrompts: number };
}

/**
 * 발행값으로 답할 수 있으면 그 값을, 아니면 `null`(→ 라이브 폴백)을 돌려준다.
 * 스펙 §E 의 술어가 여기서 전부 소진된다:
 *   ① 표면 = website · 소비자 = 이 카드              (호출부가 보장)
 *   ② 조회 회차에 `status='active'` 발행물이 있다     (`loadPublishedWebsiteRound`)
 *   ③ 켜진 필터가 발행 가능 축뿐                     (`resolveReportTruthRoute`)
 *   ④ 권한이 발행 모집단을 덮고 · 어휘가 갈리지 않고 ·
 *      선택이 공집합이 아니다                        (`decidePublishedSelection`)
 *
 * ⚠️ **권한은 게이트이지 좁히기가 아니다.** 종전 판은 런타임 어휘의 file_seq 집합과
 *    발행 사이트를 교집합해 버려서, 브랜드 = Hyundai 가 42개가 아니라 40개가 됐다
 *    (fs 40·41 이 런타임에서 `Hyundai N`). 근거는 `truth-axes.ts::decidePublishedSelection`
 *    머리 주석.
 */
async function websiteTargetHitRateFromPublication(
  projectIds: string[],
  f: StandardFilters,
  ctx: WebsiteCallContext,
): Promise<WebsitePromptHitRates | null> {
  // 브랜드 축은 `withWebsite` 가 지웠으므로 **원본 선택**을 넘긴다.
  const route = resolveReportTruthRoute(f, ctx.selectedBrands);
  if (route.source === "live") return null;

  // 기간 필터가 없으면 화면은 "가장 최근 노출 회차" 를 본다. 그 회차를 미러에서 읽으므로
  // 새 회차(예: 9/18)가 들어오는 순간 발행물이 없어 자동으로 라이브로 돌아간다.
  let roundDate = route.roundDate;
  if (!roundDate) {
    const latest = await latestVisibleWebsiteRound(projectIds);
    if ("anchorAxisOff" in latest) {
      // 조용히 라이브로 떨어지지 않게 **소리를 낸다** — 프리뷰에서 `REPORT_TRUTH_FORCE=1`
      // 만 켜고 `ANSWER_ANCHOR_FORCE=1` 을 빠뜨리는 것이 흔한 실수다.
      console.warn(
        "[reportTruth] X.answerAnchor 가 꺼져 있어 회차 축이 없다 — 발행값 경로를 건너뛰고 라이브로 간다. " +
          "프리뷰에서 켜려면 ANSWER_ANCHOR_FORCE=1 도 함께 설정할 것.",
      );
      return null;
    }
    roundDate = latest.roundDate;
  }
  if (!roundDate) return null;

  const pub = await loadPublishedWebsiteRound(roundDate);
  if (!pub) return null;

  // 권한 게이트의 입력은 **계정 스코프**다(UI 필터로 좁히기 전). 필터로 좁힌
  // projectIds 를 쓰면 브랜드 선택이 권한처럼 작동해 어휘가 섞인다.
  const accountProjectIds = await cachedProjectIdsForScope(JSON.stringify(ctx.accountScope));
  const runtime = await websiteRuntimeClassification(accountProjectIds);
  const decision = decidePublishedSelection({ published: pub.sites, runtime, axes: route.axes });
  if (!decision.ok) return null;
  const sub = publishedSubtotal(decision.selected);
  if (!sub) return null;

  return {
    hitPrompts: sub.hitPrompts,
    ownedPrompts: sub.ownedPrompts,
    measuredPrompts: sub.measuredPrompts,
    // 표시는 정수 쌍에서 파생한다 — 백분율을 저장해 비교하지 않는다(스펙 I-2).
    rate: pct1(sub.hitPrompts, sub.measuredPrompts),
    ownedRate: pct1(sub.ownedPrompts, sub.measuredPrompts),
    source: "published",
    publication: {
      slug: pub.slug,
      cycleLabel: pub.cycleLabel,
      cycleLabelEn: pub.cycleLabelEn,
      roundDate: pub.roundDate,
      siteCount: sub.siteCount,
      headlinePoolApplied: sub.headlinePoolApplied,
      manifestVerified: pub.manifestVerified,
    },
    prev: sub.prev,
  };
}

/**
 * 라이브(비발행) 값의 경로: **사실표 우선, 미러 폴백**(2026-09-27, GGMD-61 서머리 편입).
 *
 * 왜: 이 카드 2종만 KPI 카드 Promise.all 안에서 미러를 라이브로 집계했다. 형제 카드
 * (①~⑤·⑥)는 사실표라 수십 ms 인데 이 문장이 함대 무필터 11 s · Kia×MX 87 s(라이브
 * EXPLAIN 2026-09-27)라 카드 섹션 전체가 이것을 기다렸다.
 *
 * 사실표로 가는 조건 셋: 하나라도 아니면 **종전 미러 경로 그대로**(값·SQL·캐시 키 불변):
 *   ① 유닛 자사 판정(`X.websiteOwnedUnit`)이 켜져 있다. 사실표는 유닛 판정으로 굳혔다
 *      (`websitePromptUrlHitJobFlagsSql` ⚠️): flat 판정은 필터의 함수라 굳힐 수 없다.
 *   ② 형제 카드와 같은 게이트(`S4.dashboard`)가 사실표 경로를 준다. 그래서 이 카드는
 *      형제 카드와 **같은 회차 집합**을 본다(미러 경로는 앵커 표 갱신이 늦은 사이트에서
 *      직전 회차를 봐 같은 화면의 카드끼리 회차가 갈렸다: 2026-09-27 Kia MX 실측).
 *   ③ 고른 회차의 generation 이 전부 `summary_url_hit_generations` 에 있다(리더가 판정).
 */
async function websiteTargetHitRateLive(
  ids: string[],
  f: StandardFilters,
): Promise<WebsiteTargetHitRateResult> {
  if (await ensureWebsiteOwnedUnit()) {
    const route = await websiteSummaryRoute(ids, f, "S4.dashboard");
    if (route.path === "summary") {
      const v = await cachedSummaryWebsitePromptHitRates(
        route.cycleKey, cycleSetOf(route), route.projectIds, f,
      );
      if (v) return v;
      console.info("x-hmg-summary(S4.urlRates): fallback:url-hits-uncovered → mirror");
    }
  }
  return cachedWebsiteTargetHitRate(ids, f);
}

export async function fetchWebsiteTargetHitRate(
  filters: StandardFilters = {},
): Promise<WebsitePromptHitRates> {
  return withWebsite("websiteTargetHitRate", EMPTY_WEBSITE_PROMPT_HIT_RATES,
    async (ids, f, ctx) => {
      // ⚠️ 키가 꺼져 있으면 **종전 경로 그대로** 반환한다 — `source` 필드조차 붙이지
      //    않는다. off 에서 값·SQL·객체 모양이 전부 불변이라는 것이 롤아웃의 전제다.
      // 발행값(reportTruth)이 **항상 먼저**다: 라이브 값의 경로만 사실표로 바뀐다.
      if (!(await reportTruthEnabled())) return websiteTargetHitRateLive(ids, f);
      const published = await websiteTargetHitRateFromPublication(ids, f, ctx);
      if (published) return published;
      return { ...(await websiteTargetHitRateLive(ids, f)), source: "live" as const };
    }, filters);
}

/** 분모 0(측정 대기) 상수 — 카드 2종이 같은 빈 값을 쓰도록 한 곳에서 낸다. */
export const EMPTY_WEBSITE_PROMPT_HIT_RATES: WebsiteTargetHitRateResult = {
  hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null,
};

const cachedWebsiteBrandCitations = mirrorCache("website-brand-citations",
  (projectIds: string[], brandName: string, filters: StandardFilters) =>
    aggregateBrandCitationsFromMirror(brandName, filters, projectIds));

// Mention 드릴다운의 인용출처 탭 — website 버전. fetchBrandCitations(표준 루트)의
// website 대응.
export async function fetchWebsiteBrandCitations(
  brandName: string,
  filters: StandardFilters = {},
): Promise<CitationDomainLive[]> {
  return withWebsite("websiteBrandCitations", [],
    (ids, f) => cachedWebsiteBrandCitations(ids, brandName, f), filters);
}

// --- Workspace ---

export async function fetchUsage() {
  const { client } = await enforce("usage");
  return client.getUsage();
}

// ════════════════════════════════════════════════════════════════════════════
// 기간 비교 Δ (GGMD-107) — 게이트웨이 · 캐시 · 적용일
// ════════════════════════════════════════════════════════════════════════════
//
// 스펙 정본: `openspec/changes/2026-09-18-period-comparison-delta/`
// (proposal · design §1·§8·§14·§15 · specs/period-comparison-delta/spec.md).
//
// 여기가 하는 일은 넷뿐이다. 산식은 `lib/kpi/period-compare.ts`(순수), 읽기는
// `lib/db/repositories/summary-period-compare.ts` 가 쥔다.
//
//   ① **스위치** — `periodCompareEnabled()`(화면 키 `S1.periodCompare`, 기본 off).
//      off 면 `null` 을 돌려주고 화면은 **종전 Δ 경로**를 그대로 쓴다.
//   ② **적용일 게이트** — `cur.hi >= epoch` 이 아니면 `null`. **분기는 이 한 곳뿐**이다
//      (design §14-2). 지면 12개에 분기가 퍼지지 않는 이유.
//   ③ **창 해소** — 현재 창은 **화면이 실제로 집계하는 그 `(dateFrom, dateTo)`** 다.
//      값의 창과 Δ 의 현재 창이 같은 날짜쌍에서 나온다는 스펙 불변식을 구조로 보장한다.
//   ④ **캐시** — TTL 600 s · 태그 `SUMMARY_TAG` · 키에 해소된 `E`.
//
// ── 권한: 새 경로가 3축을 우회하지 않는다 ──────────────────────────────────
//
// 읽기는 전부 `withStandardRoot` / `withWebsite` 안에서 일어난다 — 기존 fetch* 와
// **완전히 같은 진입 순서**다(enforce → 감사 → 스코프 주입 → 캐시 셀). 즉
//   · scope(값)  — `withWebsite` 의 `narrowScopeBrands(user.scope, …)` → projectIds,
//                  `withStandardRoot` 의 `assertProjectInScope(루트)`.
//   · route(URL) — 이 게이트웨이는 라우트를 판정하지 않는다(`route-policy.ts` 담당).
//   · operator   — 비용 액션이 아니다(읽기 전용, 측정 트리거 없음).
// 클라이언트가 보낸 날짜는 **필터의 일부**로만 쓰이고(종전 `standard-filters.ts` 파서와
// 같은 값), 스코프 판정에는 한 글자도 개입하지 않는다.

/**
 * **이 셀만 TTL 이 짧다**(600 s, design §8).
 *
 * 사실표 셀은 캐시 키에 `cycleKey`(회차 정체성)가 들어가 새 회차가 열리면 키가 바뀐다.
 * 기간 비교는 창(날짜쌍)으로 읽으므로 키에 회차 정체성이 없고, 게다가 "발행됐다" 의 판정이
 * `view_anchor_at <= now()` 라 **아무도 아무것도 안 써도 시계만으로** 값이 바뀐다.
 * 공통 TTL 7,200 초를 그대로 쓰면 새 회차가 공개된 뒤 최대 2시간 동안 낡은 Δ 가 보인다.
 * (2026-09-27 정정: 종전 문구는 "다른 미러 셀"도 `cycleKey` 를 싣는다고 적었지만 미러 셀
 *  키에는 회차가 없었다. 지금은 축 on 의 전 미러 셀이 `mirrorCache` 에서 회차 지문 조각을
 *  받는다 — 이 셀 포함. 축 off 경로를 위해 짧은 TTL 은 그대로 둔다.)
 */
export const PERIOD_COMPARE_CACHE_TTL = 600;

/** 기간 비교 읽기 스코프 — 셀 인자(= 캐시 키)로 그대로 들어간다. */
type PeriodCompareCellArgs = [
  /**
   * 해소된 `E`. **값 계산에는 안 쓰이고 키에만 쓰인다**(design §8).
   * 창은 필터의 날짜쌍에서 오는데, 프리셋이 만든 날짜쌍과 고객이 캘린더로 직접 찍은
   * 같은 날짜쌍은 구분되지 않는다. `E` 를 키에 실어 **회차 공개 시점에 키가 갈리게** 한다.
   */
  anchorDay: string,
  surface: "global" | "website",
  projectIds: string[],
  ownVariant: string,
  ownedBasePrefixes: string[],
  family: CompareFamily,
  windows: readonly { key: string; lo: string; hi: string }[],
  unitFlags: boolean,
  excludedUnits: number[],
  filters: StandardFilters,
  /**
   * 앵커 축(0077) — **켜졌을 때만 붙는 11번째 슬롯**이다(`true` 외의 값은 없다).
   *
   * `unstable_cache` 의 호출 키는 `JSON.stringify(arguments)` 라, 이 자리에 `false` 를
   * 넘기면 **축이 꺼진 배포의 키까지 바뀐다**(`…,{}]` → `…,{},false]`) — 기존 셀이
   * 통째로 미스가 되고 "off 는 종전 동작"이 캐시 층에서 깨진다. 그래서 off 에서는
   * 슬롯을 **아예 넘기지 않는다**(인자 10개 = 종전과 바이트 동일한 키).
   * 고정: `lib/kpi/period-compare-cell-args.test.ts`.
   */
  anchorAxis?: true,
];

const cachedPeriodCompare = mirrorCache(
  "period-compare",
  // ⚠️ 슬롯을 **하나도 건너뛰지 않고** 전부 이름을 붙인다. 초판은 `const [, surface, ,
  //    ownVariant, …]` 로 `projectIds` 자리를 구멍(`,`)으로 건너뛰었고, 그래서 리더에
  //    `projectIds` 가 **안 넘어갔다**(= 모수 0 → 리더 null → 전 화면이 `unsupported`
  //    억제). 위치 기반 구멍은 눈으로 안 잡힌다 — 안 쓰는 슬롯도 `_` 접두 이름을 준다.
  //
  // ⚠️ 반환은 **배열**이다. 셀 결과는 Next Data Cache 가 직렬화해 보관하므로 `Map` 은
  //    왕복에서 `{}` 로 죽고, **캐시 HIT 부터** 소비부의 `.get()` 이 터진다(MISS 인 첫
  //    요청만 정상이라 개발 중에는 안 보인다). 2026-09-19 프리뷰 실측: 같은 URL 1회
  //    정상·2·3회 0카드, `withStandardRoot` 가 그 throw 를 안 잡아 대시보드 세그먼트가
  //    통째로 errorBoundary 로 내려갔다. Map 화는 **캐시 경계 밖**(`run`)에서 한다.
  //    server.ts 의 다른 78개 셀은 전부 plain object/배열을 돌려준다 — 예외를 만들지 말 것.
  async (
    ...args: PeriodCompareCellArgs
  ): Promise<ComparePeriod[] | null> => {
    const [
      _anchorDay, // 캐시 키 전용(design §8) — 읽기 입력이 아니다.
      surface,
      projectIds,
      ownVariant,
      ownedBasePrefixes,
      family,
      windows,
      unitFlags,
      excludedUnits,
      filters,
      anchorAxis,
    ] = args;
    return readComparePeriods(
      {
        surface,
        projectIds,
        filters,
        ownVariant,
        ownedBasePrefixes,
        unitFlags,
        excludedUnits,
        family,
        windows,
      },
      // 옵션 객체도 **켜졌을 때만** 만든다 — 리더는 `opts?.anchorAxis === true` 로만
      // 보지만, 객체를 항상 넘기면 리더의 기본 예산(`budget`) 분기를 지나는 경로가
      // 달라 보인다. off 는 종전과 같은 호출(인자 1개)이어야 읽는 사람이 헷갈리지 않는다.
      anchorAxis ? { anchorAxis: true } : undefined,
    );
  },
  [SUMMARY_TAG],
  PERIOD_COMPARE_CACHE_TTL,
);

/**
 * 적용일 — 상수가 기본이고 `summary_settings.period_compare_epoch` 가 있으면 **그것이 이긴다**
 * (design §14-1). 상수는 `lib/kpi/period-compare.ts` **한 곳**이다.
 */
async function periodCompareEpoch(): Promise<string> {
  try {
    return (await periodCompareEpochRaw()) ?? PERIOD_COMPARE_EPOCH;
  } catch {
    return PERIOD_COMPARE_EPOCH;
  }
}

/**
 * `E` 해소 — **요청당 1회**(React cache). 필터 패널(B4)과 이 게이트웨이가 같은 값을 본다.
 *
 * ⚠️ `unstable_cache` 에 넣지 않는다. `E` 는 `view_anchor_at <= now()` 라 **시계로** 바뀌는
 *    값이라, 오래 캐시하면 새 회차가 공개돼도 창이 안 따라온다. 문장은 `max()` 1행이다.
 */
const requestWindowEnd = cache(
  async (key: string): Promise<WindowEndInfo> => {
    const { s, p } = JSON.parse(key) as { s: "global" | "website"; p: string[] };
    try {
      const info = await resolveWindowEndInfo(s, p);
      logFleetAnchor(s, info);
      return info;
    } catch {
      // 원장 미적용·DB 오류 → null. 프리셋은 **오늘 기준 트레일링**으로 폴백한다(= 종전 동작).
      return { end: null, fleet: 0, distinctAnchors: 0 };
    }
  },
);

/**
 * Q4 진단 — 웹사이트 `E` 는 "여러 프로젝트 앵커의 최대값" 이 아니라 **"함대가 공유하는
 * 회차일"** 이어야 한다(design §13-4, 제품 책임자 원문 "전체 프로젝트가 회차일거라서").
 * 최근 4회차(08-21·08-28·09-04·09-11)는 95개 프로젝트 전원이 같은 앵커일을 공유한다.
 *
 * 구현은 `max` 다. 그 전제가 깨지는 구간(7월분처럼 앵커가 프로젝트마다 갈리는 때)에는
 * **조용히 큰 값을 고르게** 되므로, 리더가 함께 내주는 `distinctAnchors`(= 프로젝트별
 * 최신 앵커일의 가짓수)가 1을 넘으면 로그 한 줄을 남긴다. `1` 이면 함대가 한 회차일을
 * 공유한다는 뜻이라 조용하다 — 정상 구간에서 로그가 쌓이지 않는 것이 이 술어의 요점이다.
 *
 * `requestWindowEnd`(React cache) **안**에서 부른다 — 한 요청에서 필터 패널(B4)과
 * 게이트웨이가 같은 셀을 기다리므로, 호출부마다 찍으면 문장 1개에 로그가 여러 줄 남는다.
 */
function logFleetAnchor(surface: "global" | "website", info: WindowEndInfo): void {
  if (info.distinctAnchors <= 1) return;
  console.info(
    `x-hmg-period-compare(${surface}): fleet-anchor-mismatch E=${info.end ?? "none"} ` +
      `fleet=${info.fleet} anchors=${info.distinctAnchors}`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 달력의 **선택 가능한 회차 날짜** — 앵커 축(0077) 옵트인 (스펙 §5.1)
// ════════════════════════════════════════════════════════════════════════════
//
// 배선은 `fetchLatestAnchorDay` 와 같은 모양이다: 서버 페이지가 이 값을
// `DimensionFilterPanel` 의 `selectableDates` prop 으로 내린다.
//
// ── `undefined` 가 "종전 동작" 이다 ────────────────────────────────────────
//
// 축이 꺼져 있으면(화면 키 off · env 미설정 · 0077 미적용) **`undefined`** 를 낸다 —
// 패널의 prop 계약이 `undefined` = 네이티브 날짜 입력 + 전 날짜 활성이기 때문이다
// (`dimension-filter-panel.tsx` 의 `selectableDates` 주석). 빈 배열도 같은 경로로
// 가지만, 켜짐/꺼짐을 값으로 구분할 수 있게 off 는 `undefined` 로 못박는다.
//
// ── 필터를 **넘기지 않는** 이유 ──────────────────────────────────────────
//
// `SelectableAnchorDateFilters` 는 `from/to/engines/countries` 를 받지만 여기서는
// 하나도 채우지 않는다:
//   · `from`/`to` — 지금 고른 기간으로 좁히면 **그 기간 밖으로 나갈 수가 없다**.
//     달력은 기간을 바꾸는 도구다.
//   · `engines`/`countries` — 채우면 `scope_answers` 조인이 붙고, 필터를 바꿀 때마다
//     달력의 칠해진 날짜가 흔들린다. 범위 판정은 표면·프로젝트까지가 계약이다
//     (통합 지시 "표면별로 surface·project 범위가 맞는 날짜만 넘긴다").
// 상한은 리더가 쥔다(`MAX_DATES` 400, 최신부터 자름).
//
// 노출 게이트(`anchorViewableSql` + `anchorNotHiddenSql('all')`)는 리더 안에 있다.

/** 축 off 이거나 범위를 못 잡으면 `undefined` = 종전 달력. */
async function selectableDatesFor(
  surface: AnchorSurface,
  projectIds: string[],
  family: AnchorHiddenFamily,
): Promise<string[] | undefined> {
  if (projectIds.length === 0) return undefined;
  return loadSelectableAnchorDates(surface, projectIds, {}, family);
}

/**
 * 글로벌(`'standard'`)·웹사이트 표면의 선택 가능한 회차 날짜.
 *
 * 표면 어휘는 원장 쪽(`'global'`)으로 받고 앵커 테이블 쪽(`'standard'`)으로 바꿔
 * 넘긴다 — 지면은 이미 `fetchLatestAnchorDay` 에 `'global'` 을 주고 있어 두 배선이
 * 같은 낱말을 쓰게 한다(계약 §2 의 표면 어휘 두 벌).
 */
export async function fetchSelectableAnchorDates(
  surface: "global" | "website",
  filters: StandardFilters = {},
  /**
   * 그 **지면의 지표 계열**. 기본은 집계층 `DEFAULT_HIDDEN_FAMILY` 와 같은
   * 느슨한 `'mentions'` 이고, 인용 지면만 `'citations'` 을 넘긴다 — 달력이 그
   * 화면의 카드·기준 회차와 같은 회차 집합을 보게 하는 유일한 배선이다.
   */
  family: AnchorHiddenFamily = "mentions",
): Promise<string[] | undefined> {
  if (!(await ensureAnchorAxis())) return undefined;
  const anchorSurface = toAnchorSurface(surface);
  if (surface === "website") {
    return withWebsite(
      "selectableAnchorDates",
      undefined,
      (ids) => selectableDatesFor(anchorSurface, ids, family),
      filters,
    );
  }
  return withStandardRoot(
    "selectableAnchorDates",
    undefined,
    async () => {
      const rootId = getStandardRootId();
      return rootId ? selectableDatesFor(anchorSurface, [rootId], family) : undefined;
    },
    filters,
  );
}

/** 프로젝트 표면 — 귀속 날짜가 곧 `anchor_date` 라 임의 날짜가 들어온다(§9.2). */
export async function fetchProjectSelectableAnchorDates(
  localProjectId: string,
  filters: StandardFilters = {},
  /** 지면의 계열 — 프로젝트 대시보드 카드는 7 KPI 묶음이라 `'all'` 이다. */
  family: AnchorHiddenFamily = "mentions",
): Promise<string[] | undefined> {
  if (!(await ensureAnchorAxis())) return undefined;
  return withProject(
    "selectableAnchorDates",
    localProjectId,
    undefined,
    (scopeProjectId) => selectableDatesFor("project", [scopeProjectId], family),
    filters,
  );
}

/**
 * 표면별 **최신 노출 회차 앵커일** `E` — 기간 프리셋의 끝점(B4).
 *
 * 전달 경로는 이미 있는 `collectionStartDay → minDay` 와 **같은 배선**이다: 서버 페이지가
 * 이 값을 `DimensionFilterPanel` 의 `endDay` 로 내리고, 패널의 `presetRange(preset, endDay,
 * minDay)` 가 창을 만든다. `null` 이면 패널은 **오늘로 폴백**한다(= 종전 동작).
 *
 * `null` 을 내는 경우: 스위치 off(기본) · 루트 프로젝트/함대 없음 · 노출 회차 0 ·
 * 원장 미적용·DB 오류. 전부 "종전 동작" 으로 수렴한다.
 */
export async function fetchLatestAnchorDay(
  surface: "global" | "website",
  filters: StandardFilters = {},
): Promise<string | null> {
  if (!(await periodCompareEnabled())) return null;
  const resolve = async (projectIds: string[]): Promise<string | null> =>
    (await requestWindowEnd(JSON.stringify({ s: surface, p: projectIds }))).end;
  if (surface === "website") {
    return withWebsite("periodCompareAnchor", null, (ids) => resolve(ids), filters);
  }
  return withStandardRoot("periodCompareAnchor", null, async () => {
    const rootId = getStandardRootId();
    return rootId ? resolve([rootId]) : null;
  }, filters);
}

/** 현재 창 — 화면이 실제로 집계하는 날짜쌍. 둘 다 없으면 **기간 미선택**이다. */
function selectedWindow(f: StandardFilters): CompareWindow | null {
  const lo = f.dateFrom;
  const hi = f.dateTo;
  // 한쪽만 채운 open-ended 구간은 길이 N 이 정의되지 않는다 → 종전 Δ.
  if (!lo || !hi || lo > hi) return null;
  return { lo, hi };
}

export interface PeriodCompareOptions {
  surface: "global" | "website";
  /** `hidden_scope='citations'` 회차 규약 — **기본값 없음**(design §6-3). */
  family: CompareFamily;
  kind: CompareKind;
  /** 이 지면이 요청한 지표. 결과는 이 순서를 따른다. */
  metrics: readonly CompareMetricKey[];
  /**
   * 달력 월(`kind:"calendarMonth"`) 전용 — 호출부가 KST 월 경계에서 해소한 세 구간.
   * 창 비교(`kind:"window"`)에서는 쓰지 않는다(게이트웨이가 필터에서 직접 해소한다).
   */
  months?: { before: CompareWindow; prev: CompareWindow; cur: CompareWindow };
  /**
   * 달력 주(`kind:"calendarWeek"`) 전용 — 월~일 구간 둘(`cur`·`prev`).
   *
   * `before`(전전주)는 **넘기지 않아도 된다**: 달력 주의 시작 구간 판정은 창 비교와
   * 같은 `judgeStartWindow` 라(`period-compare.ts` 의 `calendarWeek` 분기) 전전주
   * 구간이 필요 없다. 안 넘기면 읽는 구간이 셋이 아니라 둘이다.
   */
  weeks?: { prev: CompareWindow; cur: CompareWindow };
}

/**
 * 기간 비교 Δ. **`null` = 종전 Δ 를 그려라.**
 *
 * `null` 을 내는 경우(전부 "화면은 오늘과 똑같이 동작한다" 로 수렴한다):
 *   · 스위치 off (기본)
 *   · **기간 미선택**(`dateFrom`·`dateTo` 가 둘 다 있지 않다) — 스펙 "기간 미선택 기본
 *     화면은 값이 바뀌지 않는다" 를 **구조로** 보장한다: 계산 자체를 시작하지 않는다.
 *   · **적용일 이전**(`cur.hi < epoch`) — 기발행 리포트가 그대로 재현된다(Q6=b)
 *   · 루트 프로젝트/함대 없음
 *   · 집계층으로 표현 불가(`planTrendRead` `ok:false`) 또는 리더가 `null` —
 *     이때는 `unsupported` **억제 결과**를 돌려준다(칩은 "―"). `null` 이 아니다.
 */
export async function fetchPeriodCompare(
  filters: StandardFilters,
  opts: PeriodCompareOptions,
): Promise<CompareResult[] | null> {
  // ① 스위치. 꺼져 있으면 원장·사실표를 **한 문장도** 읽지 않는다.
  //
  // ⚠️ 스위치가 `enforce`(세션·감사) **앞**이다. 의도한 순서다 — off 에서 `enforce` 를
  //    돌리면 요청마다 `bff_audit_logs` 에 행이 하나씩 쌓여 "off 회귀 0"(왕복·부수효과
  //    불변)이 깨진다. 여기서 세션을 안 보는 것이 안전한 이유는 **이 분기가 데이터를
  //    한 바이트도 만들지 않기** 때문이다: `null` 은 "종전 Δ 를 그려라" 라는 상수이고,
  //    필터·스코프·회차 어느 것도 읽지 않는다. 켜진 뒤의 모든 읽기는 아래
  //    `withStandardRoot`/`withWebsite` 안, 즉 종전 fetch* 와 같은 강제 경로에 있다.
  //    (다른 옵트인 화면 키 게이트와 같은 자세 — `lib/summary/read/screens.ts`.)
  if (!(await periodCompareEnabled())) return null;

  // ② 창 해소. 달력 월·달력 주는 호출부가 KST 경계에서 해소한 구간을 준다.
  //
  // ⚠️ 달력 주(`calendarWeek`)는 **앵커 축에서만** 도달한다 — 지면의 형태 판정이
  //    축 on 에서만 `resolveComparePeriodShape`(주 판정 포함)를 쓰기 때문이다
  //    (`resolveRequestComparePeriodShape`). 축 off 에서 월~일 구간은 종전대로
  //    `kind:"window"` 이고, 따라서 이 분기는 off 경로를 한 줄도 건드리지 않는다.
  const isMonth = opts.kind === "calendarMonth";
  const isWeek = opts.kind === "calendarWeek";
  const months = opts.months;
  const weeks = opts.weeks;
  if (isMonth && !months) return null;
  if (isWeek && !weeks) return null;
  const cur = isMonth ? months!.cur : isWeek ? weeks!.cur : selectedWindow(filters);
  if (!cur) return null;
  const prev = isMonth
    ? months!.prev
    : isWeek
      ? weeks!.prev
      : windowsFromRange(cur.lo, cur.hi).prev;
  const days = windowLength(cur);

  // ③ 적용일 게이트 — **이 한 줄이 Q6=b 의 전부**다(design §14-2).
  //    미달이면 `null` → 화면은 종전 Δ 경로. 억제 칩("―")은 그리지 않는다.
  if (!periodCompareApplies(cur.hi, await periodCompareEpoch())) return null;

  // ④ 앵커 축 — **요청당 한 번** 확정해 아래로 내린다(`ensureAnchorAxis` 주석의
  //    "한 요청 안에서 같은 값" 규율). 값 경로가 둘로 갈리지 않도록 캐시 키와 리더
  //    옵션에 **같은 불리언**이 들어간다.
  const anchorAxis = await ensureAnchorAxis();

  const windows = [
    { key: windowKey(prev), lo: prev.lo, hi: prev.hi },
    { key: windowKey(cur), lo: cur.lo, hi: cur.hi },
    ...(isMonth
      ? [{ key: windowKey(months!.before), lo: months!.before.lo, hi: months!.before.hi }]
      : []),
  ];

  const run = async (
    projectIds: string[],
    f: StandardFilters,
    extras: { unitFlags: boolean; excludedUnits: number[]; ownedBasePrefixes: string[] },
  ): Promise<CompareResult[] | null> => {
    const plan = planTrendRead({
      surface: opts.surface,
      filters: f,
      unitFlags: extras.unitFlags,
    });
    // 집계층으로 표현 못 하는 축(depth2·depth3·admin 임의 다중 브랜드)은 **억제**다 —
    // 미러로 두 창을 각각 집계하는 경로는 만들지 않는다(스펙 SHALL NOT).
    if (!plan.ok) {
      console.info(`x-hmg-period-compare(${opts.surface}): unsupported:${plan.reason}`);
      return emptyCompare(prev, cur, opts, days);
    }
    const anchorDay =
      (await requestWindowEnd(JSON.stringify({ s: opts.surface, p: projectIds }))).end ?? "";
    // 종전 10개 슬롯. 축이 켜졌을 때만 11번째(`true`)가 붙는다 — off 의 캐시 키는
    // 문자 하나 안 바뀐다(`PeriodCompareCellArgs` 의 `anchorAxis` 주석).
    const cellArgs = [
      anchorDay,
      opts.surface,
      projectIds,
      plan.ownVariant,
      extras.ownedBasePrefixes,
      opts.family,
      windows,
      extras.unitFlags,
      extras.excludedUnits,
      f,
    ] as const;
    const periods = anchorAxis
      ? await cachedPeriodCompare(...cellArgs, true)
      : await cachedPeriodCompare(...cellArgs);
    if (!periods) return emptyCompare(prev, cur, opts, days);
    // 캐시 **경계 밖**에서 Map 화한다(위 셀 주석 참조). 원소가 `key` 를 들고 있다.
    const byKey = new Map(periods.map((x) => [x.key, x]));
    const p = byKey.get(windowKey(prev));
    const c = byKey.get(windowKey(cur));
    if (!p || !c) return emptyCompare(prev, cur, opts, days);
    return computeCompare(p, c, {
      kind: opts.kind,
      days,
      before: isMonth ? byKey.get(windowKey(months!.before)) : undefined,
      metrics: opts.metrics,
    });
  };

  if (opts.surface === "website") {
    return withWebsite("periodCompare", null, async (ids, f) => {
      const [own, unitFlags, excludedUnits] = await Promise.all([
        websiteOwnedPrefixes(ids, f),
        summaryUnitFlagsAvailable(),
        websiteExcludedUnits(),
      ]);
      // 기간 비교 Δ 의 자사 계열은 **이미 유닛 경로가 있다** — `summary-trend-aggregates.ts
      // ::ownedCitationsAgg` 가 `surface === "website" && unitFlags` 에서
      // `sum(unit_owned_citations)`(0060 이 굳힌 유닛 판정)을 쓴다. 즉 스위치가 화면 키가
      // 아니라 `unitFlags` 일 뿐 정의는 리포트 쪽이다. 두 스위치가 어긋나는 조합만 알린다.
      if (own.units) warnIfOwnedUnitDefinitionSplit(unitFlags, "periodCompare");
      return run(ids, f, {
        unitFlags,
        excludedUnits,
        ownedBasePrefixes: own.prefixes,
      });
    }, filters);
  }
  return withStandardRoot("periodCompare", null, async (f) => {
    const rootId = getStandardRootId();
    if (!rootId) return null;
    return run([rootId], f, {
      unitFlags: false,
      excludedUnits: [],
      ownedBasePrefixes: scopeOwnedPrefixes(f),
    });
  }, filters);
}

/**
 * 읽기가 성립하지 않을 때의 **억제 결과**(`unsupported`). `null`(= 종전 Δ)과 다르다:
 * 화면은 "―" 와 "이 필터 조합에서는 기간 비교를 제공하지 않습니다" 캡션을 그린다.
 *
 * 산식·우선순위를 여기서 다시 쓰지 않는다 — 빈 구간 둘을 만들어 `computeCompare` 에
 * 그대로 태운다. 사유 판정은 `lib/kpi/period-compare.ts` 한 곳이다.
 */
function emptyCompare(
  prev: CompareWindow,
  cur: CompareWindow,
  opts: PeriodCompareOptions,
  days: number,
): CompareResult[] {
  const blank = (w: CompareWindow): ComparePeriod => ({
    key: windowKey(w),
    lo: w.lo,
    hi: w.hi,
    measures: {},
    ledger: {
      plannedUnits: 0,
      missingUnits: 0,
      publishedCycles: 0,
      dataCycles: 0,
      firstPublishedAnchor: null,
    },
  });
  return computeCompare(blank(prev), blank(cur), {
    kind: opts.kind,
    days,
    metrics: opts.metrics,
    unsupported: true,
  });
}
