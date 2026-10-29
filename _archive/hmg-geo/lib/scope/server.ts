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
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { listProjectOwnedBases } from "@/lib/db/repositories/project-owned-bases";
import { getProjectIdsForScope } from "@/lib/db/repositories/website-sites";
import {
  resolveWebsiteSummaryRouteBase,
  resolveGlobalSummaryRouteBase,
  applyScreenGate,
  summaryRouteHeaderValue,
  type SummaryReadRoute,
} from "@/lib/summary/read/gate";
import { summaryScreenAllowed, type SummaryScreenKey } from "@/lib/summary/read/screens";
import type { CycleSurface } from "@/lib/db/repositories/summary-cycles";
import { withTrendGapBuckets, trendGapWeekKeys, weeklyGapWeeks } from "@/lib/summary/read/trend-gaps";
import type { TrendGapFamily } from "@/lib/viz/trend-gap";
import { competitorDeltaBrands } from "./competitor-row";
import { countOf, timedRead } from "@/lib/perf/read-timing";
import type {
  SummaryCyclePick,
  WebsiteCyclePick,
} from "@/lib/db/repositories/summary-cycles";
import { summaryUnitFlagsAvailable, websiteExcludedUnits } from "@/lib/db/repositories/summary-settings";
import {
  summaryWebsiteDashboard,
  summaryWebsiteSubKpis,
  summaryWebsitePromptTopics,
  summaryWebsiteSourceComposition,
  summaryWebsiteCitationAccuracy,
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
  type TrendReadScope,
  type TrendStatementKey,
} from "@/lib/db/repositories/summary-trend-aggregates";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import {
  readGlobalTrendCore,
  readGlobalBrandSnapshot,
  readGlobalBrandSeries,
  attachBrandSeries,
  pickSeriesBrands,
  toStandardTrendBuckets,
  toBrandTrend,
  toFirstPosition,
  type GlobalTrendBrandPoint,
  type GlobalTrendSeries,
} from "@/lib/db/repositories/summary-global-trend-read";
import { narrowScopeBrands, ownedBasePrefixesForScope } from "./hmg-brands";
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
  type StandardSubKpis,
  aggregateAcrFromMirror,
  type StandardAcr,
  aggregateSignalPromptsFromMirror,
  type SignalKey,
  listMeasuredEngines,
  // 4-KPI 탭(PR ②) — 회차 집계 3종 + 카탈로그 프롬프트 수.
  websiteDeclaredOwnedBases,
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
  aggregateCitationCategoryTotalsFromMirror,
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
import type { AllowedScope, User } from "@/lib/auth/types";

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
//   scope.all (vendor 제외) → 관리자가 명시 부여한 전체 범위 허용
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
  if (!(await canReadProject(session.user, projectId))) throw new UnauthorizedError();
}

async function canReadProject(user: User, projectId: string, scopeIdOnly = false): Promise<boolean> {
  if (user.role !== "vendor" && user.scope.all) return true;
  if (projectId === getStandardRootId()) {
    return user.role !== "vendor";
  }
  const project =
    (!scopeIdOnly ? await cachedProjectById(projectId) : null) ??
    (await projectRepository.getByScopeProjectId(projectId));
  if (!project) return false;
  const membership = await projectMemberRepository.findMembership(project.id, user.id);
  const activeMember = membership?.status === "active";
  if (user.role === "vendor") return activeMember;
  if (activeMember) return true;
  return projectInScope(
    user.scope,
    { brand: project.brand, country: project.country },
  );
}

// --- Settings: projects ---

export async function listProjects(query?: PageQuery) {
  const { client, user } = await enforce("listProjects");
  if (user.role !== "vendor" && user.scope.all) return client.listProjects(query);

  // Upstream cursors can encode IDs/offsets across the entire workspace. Build
  // pagination over authorized records so hidden projects do not leak through
  // totals, cursors, or empty intermediate pages. Never forward caller cursors.
  const cursor = query?.cursor;
  if (cursor && !/^visible:\d+$/.test(cursor)) throw new UnauthorizedError();
  const offset = cursor ? Number(cursor.slice("visible:".length)) : 0;
  if (!Number.isSafeInteger(offset)) throw new UnauthorizedError();
  const limit = Number.isInteger(query?.limit)
    ? Math.max(1, Math.min(100, query!.limit!))
    : 100;
  const visible = await pageAll(
    async (upstreamCursor) => {
      const page = await client.listProjects({ limit: 100, cursor: upstreamCursor });
      const allowed = await Promise.all(
        page.data.map((project) => canReadProject(user, project.project_id, true)),
      );
      return {
        data: page.data.filter((_, index) => allowed[index]),
        next_cursor: page.next_cursor,
      };
    },
    { maxPages: 50, label: "listProjects: authorized workspace scan" },
  );
  // An incomplete workspace scan cannot truthfully claim the visible set is
  // exhausted. Fail rather than silently dropping authorized later projects.
  if (visible.truncated) throw new Error("Project listing exceeded its page limit");
  const data = visible.items.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    next_cursor: nextOffset < visible.items.length ? `visible:${nextOffset}` : null,
  };
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
  return degradeAware("projectMentions", async () => {
    const result = await withProject(
      "projectMentions",
      localProjectId,
      null,
      (scopeProjectId, f) => cachedProjectMentions(scopeProjectId, f),
      filters,
    );
    // 0070 갭 슬롯 — `fetchProjectTrend` 와 **같은 자세**다(표면 null = 원장의 website·
    // project 를 가리지 않고 그 프로젝트의 숨긴 회차만). 같은 화면(/analysis/mention)의
    // 추이만 갭을 그리고 주별 상위 브랜드는 안 그리면 두 차트가 다른 축이 된다.
    // 빈/미연결 결과면 갭 스코프를 다시 풀지 않는다. 특히 게이트 timeout 때 요청 캐시에
    // 저장된 같은 거절을 보호 밖에서 재관찰하면 degrade 가 throw 로 되돌아간다.
    if (result === null) return null;
    return withWeeklyGaps(result, null, await gapProjectIds(localProjectId), "mention");
  });
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
    const result = await withProject(
      "projectCitations",
      localProjectId,
      null,
      (scopeProjectId, f) => cachedProjectCitations(scopeProjectId, f, ownedBasePrefixes),
      filters,
    );
    // 0070 갭 슬롯 — `fetchProjectMentions`·`fetchProjectTrend` 와 같은 자세.
    if (result === null) return null;
    return withWeeklyGaps(result, null, await gapProjectIds(localProjectId), "citation");
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
const MIRROR_CACHE_TTL = 7200;

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
const MIRROR_CACHE_BASE_GENERATION = "mirror-v4";
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
): (...args: A) => Promise<R> {
  const base = lazyCache(() =>
    unstable_cache(fn, [MIRROR_CACHE_GENERATION, key], {
      revalidate: MIRROR_CACHE_TTL,
      tags: [MIRROR_AGGREGATE_TAG, ...extraTags],
    }),
  );
  // T18 캐시 우회 프로브(lib/perf/nocache-probe.ts). 시크릿 헤더가 맞는 요청에서만
  // 요청별 솔트를 키에 섞어 **지나간다** — 캐시를 지우지 않으므로 다른 사용자의
  // 셀은 그대로다. 게이트가 닫혀 있으면(= 사실상 모든 트래픽) `base` 를 그대로
  // 부르므로 키·TTL·태그가 종전과 완전히 같다.
  return withNoCacheSalt(base, (salt) =>
    unstable_cache(fn, [MIRROR_CACHE_GENERATION, key, salt], {
      revalidate: PERF_PROBE_CACHE_TTL,
      tags: [MIRROR_AGGREGATE_TAG, ...extraTags],
    }),
  );
}

// 자사 명부(entity_registry role='own') 로드 — 모든 미러/퍼블릭 읽기의 당사
// 판정 입력. 캐시(mirror TTL/tag 공유)로 요청마다 DB를 안 때린다. 명부가 비거나
// 테이블 미적용(migration 0023 전)이면 undefined → 판정부가 hmg-brands 시드 폴백.
const cachedOwnRoster = mirrorCache("entity-roster", () =>
  entityRegistryRepository.listOwn(),
);
async function ownEntitiesForJudgment(): Promise<
  { id: string; name: string }[] | undefined
> {
  try {
    const rows = await cachedOwnRoster();
    return rows.length ? rows : undefined;
  } catch {
    return undefined; // 테이블 없음/DB 오류 → 시드 폴백 (판정은 계속 동작)
  }
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
  (filters: StandardFilters) =>
    aggregateStandardFromMirror(filters, undefined, scopeOwnedPrefixes(filters),
      undefined, false, mirrorHeavyBudget("cardsMirror")));

// 표준 mentions는 슬림("none")으로 캐시 — perBrandPrompts(전 브랜드 드릴다운)가
// 페이로드의 99.9%(12.4MB)라 그대로 캐시하면 2MB 한도 초과로 매번 재계산됐다
// (2026-07-08). 드릴다운은 클릭 시 cachedStandardBrandMentionPrompts로 lazy.
// trendDegraded=true(추이 롤업 시간 초과)는 캐시하지 않는다 — kpi-engine-trend 와 같은
// 이유(2026-09-02: degrade 가 30분 캐시에 굳어 하단 "주별 상위 브랜드"가 준비 중으로 남았다).
// S2 의 미러 집계 — **예산 있음**(PR③). 문장 10개·warm exec 16.6 s(최장 9.19 s)로
// S3 다음으로 무겁다. `mirrorHeavyBudget()` 은 캐시 콜백 **안**에서 부른다(마감이 요청
// 시각 기준이어야 하고, 인자로 받으면 `Date.now()` 가 캐시 키에 섞인다).
// 예산 — warm 55.0 s 짜리라 상한이 없으면 대시보드 첫 채움 요청이 Vercel 120 s 를
// 넘긴다(PR③-a). **프로파일이 인자 = 캐시 키**다: 이 셀을 두 지면이 나눠 쓰는데 초과의
// 대가가 달라 예산도 달라야 하고(`MentionsBudgetProfile` 주석), 키에 안 넣으면 먼저
// 채운 쪽의 예산으로 만든 셀을 다른 쪽이 그대로 받는다.
//   · `extras`(15/30) 대시보드 경쟁사 행 — 빠져도 카드 본체는 그려져 있다.
//   · `screen`(22/35) S2 언급 화면 — 이 집계가 화면 본문이라 degrade = 빈 지면.
//     22 s 는 오폴백 방지값이다(최장 문장 warm exec 9.19 s × 콜드 1.7 = 15.6 s > 15 s).
// `mentionsBudgetOf()` 는 **콜백 안**에서 부른다(마감이 요청 시각 기준이어야 한다).
const cachedStandardMentions = mirrorCache("standard-mentions",
  uncachedIfDegraded(
    (r: MentionsLive | null) => r?.trendDegraded === true,
    (filters: StandardFilters, profile: MentionsBudgetProfile) =>
      aggregateMentionsFromMirror(filters, undefined, "none", mentionsBudgetOf(profile)),
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
  (filters: StandardFilters) =>
    aggregateGeoKpiFromMirror(filters, undefined, scopeOwnedPrefixes(filters), {
      statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
      budgetMs: KPI_TAB_SINGLE_BUDGET_MS,
    }));

// 예산(PR③-a) — 대시보드가 이 셀을 **두 번** 부른다(Δ 롤업 day + 화면 추이 week).
// warm 55.6 s(주 버킷) 짜리인데 종전에는 상한이 아예 없었다.
const cachedStandardTrend = mirrorCache("standard-trend",
  (filters: StandardFilters, unit: BucketUnit) =>
    aggregateStandardTrendFromMirror(
      filters, unit, undefined, scopeOwnedPrefixes(filters), undefined, false, mirrorExtrasBudget(),
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
function normalizeFilters(filters: StandardFilters): StandardFilters {
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
    summaryGlobalAggregates(globalSummaryScopeOf(cycle, rootId, f), mirrorHeavyBudget("detail")),
  [SUMMARY_TAG]);

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
): TrendReadScope => ({
  set,
  filters,
  ownVariant,
  ownedBasePrefixes: scopeOwnedPrefixes(filters),
  limits: S1_TREND_LIMITS,
  axes: S1_TREND_AXES,
});

const cachedSummaryGlobalS1 = mirrorCache("summary-global-trend-s1",
  async (
    _cycleKey: string,
    set: CycleSet,
    ownVariant: string,
    filters: StandardFilters,
  ): Promise<GlobalS1Read> => summaryGlobalS1FromTrend(globalS1ScopeOf(set, ownVariant, filters)),
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
): Promise<T> {
  const screen: SummaryScreenKey = "S1.dashboard";
  const rootId = getStandardRootId();
  const route = await globalSummaryRoute(rootId, f, screen);
  if (route.path !== "summary" || !rootId) return onMirror();
  const cycle = route.cycles[0];
  if (!cycle) return onMirror();
  const detail = () => onDetail(route.cycleKey, cycle, rootId, f);
  const plan = planTrendRead({ surface: "global", filters: f });
  if (!plan.ok) {
    console.info(`x-hmg-summary(global ${screen}): fallback:${plan.reason} → detail`);
    return detail();
  }
  // 캐시 키에 **관측값이 들어가지 않게** 순수 CycleSet 만 넘긴다 — `route` 를 그대로
  // 넘기면 `openRuns`(열린 회차 관측, 시간에 따라 뒤집힌다)가 키에 섞여 셀이 갈린다.
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
  // 접힘은 읽기 **전**에 판정한다 — 리더 `empty` 는 캐시 셀 안이라 되돌릴 자리가 없다.
  // 발행은 read 와 **동시**다(A1): 판정 순서·목적지는 종전과 같고 대기만 겹친다.
  const gated = await foldGated(
    cachedGlobalFoldPresent(JSON.stringify(set)),
    () => requestS1(JSON.stringify({ set, v: plan.ownVariant, f })),
  );
  if (!gated.folded) {
    console.info(`x-hmg-summary(global ${screen}): fallback:agg-fold-missing → detail`);
    return detail();
  }
  const read = gated.value;
  if (read.empty) {
    // 접기 미실행·부분 접힘 — 0 으로 그리지 않고 세부층으로 돌린다(플랜 §5-2).
    console.info(`x-hmg-summary(global ${screen}): fallback:agg-empty → detail`);
    return detail();
  }
  const picked = pick(read.value);
  if (picked === null) {
    console.info(`x-hmg-summary(global ${screen}): fallback:agg-widget-empty → detail`);
    return detail();
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
  const plan = planTrendRead({ surface: "global", filters: f });
  if (!plan.ok) {
    console.info(`x-hmg-summary(global ${screen}): fallback:${plan.reason} → detail`);
    return detail();
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
    return detail();
  }
  const out = gated.value;
  if (out.empty) {
    console.info(`x-hmg-summary(global ${screen}): fallback:agg-empty → detail`);
    return detail();
  }
  return out.value;
}

// 요청단위 dedup — 대시보드가 필터바(측정 기준일 슬롯)와 본문(SummarySection →
// getLiveDashboard) 두 <Suspense> 경계에서 같은 read 를 부른다(2026-09-01).
// 값이 같은 필터면 DB 는 1회. (fetchStandardMentions 와 동일한 이유.)
export const fetchStandardAggregates = requestDeduped(
  "fetchStandardAggregates",
  async (filters: StandardFilters = {}): Promise<StandardAggregates | null> =>
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
        () => cachedStandardAggregates(f)), filters)),
);

/**
 * 카드 ①~⑤ 시계열 — 스파크라인·Δ 의 원천.
 *
 * ⚠️ 집계층 경로에서 **`unit` 은 무시된다**. 집계층의 유일한 시간축이 회차 anchor 라
 *    `day` 버킷을 만들 수 없다(리더 `summary-global-trend-read.ts` 머리 주석). `day` 를
 *    넘기는 유일한 호출부는 대시보드 Δ 칩(`DELTA_TREND_BUCKET`)이고, 그 정의는 D-4
 *    해제(운영 2026-09-11)로 **"직전 회차 대비"** 가 됐다. 미러 폴백에서는 종전대로
 *    `unit` 이 그대로 먹는다 — 두 경로의 x축이 다르다는 뜻이고, 그것이 전환의 내용이다.
 */
export async function fetchStandardTrend(
  filters: StandardFilters = {},
  unit: BucketUnit = "week",
): Promise<StandardTrendBucket[]> {
  // 예산 초과(PR③-a)는 **빈 배열**로 내린다 — 화면은 종전의 "추이 없음" 자리를 쓰고,
  // 그것이 "데이터 없음" 인지 "지연" 인지는 `wasDegraded("standardTrend")` 가 가른다.
  // degrade 는 캐시 바깥이라 저장되지 않는다(다음 요청이 재시도).
  // 예산이 감싸는 것은 **미러 폴백**이다 — 집계층 경로(`viaGlobalSeries`)는 회차 read 라
  // 훨씬 싸지만, 게이트가 거부하면 종전 미러로 떨어지고 그쪽이 warm 55.6 s 짜리다.
  const buckets =
    (await degradeAware(`standardTrend:${unit}`, () =>
      withStandardRoot("standardTrend", [] as StandardTrendBucket[],
        (f) => viaGlobalSeries(f, "S1.dashboard", requestGlobalCore, toStandardTrendBuckets,
          () => cachedStandardTrend(f, unit), ["own", "domains"]), filters))) ?? [];
  // 숨긴 회차의 갭 슬롯(0070)은 **캐시 밖**에서 얹는다 — 원장을 고치면 다음 요청부터
  // 바로 반영돼야 하고(캐시 TTL 2시간을 기다리지 않는다), 두 경로(집계층·미러)가 같은
  // 타입으로 나오므로 여기 한 곳이면 둘 다 덮인다.
  return withTrendGapBuckets(buckets, unit, "global", rootProjectIdsForGaps());
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
  ): Promise<StandardSubKpis> =>
    withStandardRoot(
      "standardSubKpis",
      { rows: [], promptsWithoutBrand: null, measuredPrompts: null },
      (f) => cachedSubKpisParts(f, KPI_TAB_SUB_KPI_PARTS[metric]),
      filters,
    ),
);

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
const cachedKpiBrandTrend = mirrorCache("kpi-brand-trend",
  (filters: StandardFilters, trendDays: number, topBrands: number, profile: KpiBudgetProfile) =>
    aggregateBrandTrendFromMirror(filters, undefined, {
      trendDays,
      topBrands,
      ...kpiBudgetOf(profile),
    }));

// ⚠️ trendDegraded=true 는 캐시하지 않는다(uncachedIfDegraded). 2026-09-02 프리뷰
// 실증: 콜드 첫 요청의 degrade 가 30분 캐시에 굳어 수 시간 동안 추이가 비었고,
// 캐시 HIT 라 warn 도 0건이었다 — 근거·규칙은 kpi-tab-budget 의 주석.
const cachedKpiEngineTrend = mirrorCache("kpi-engine-trend",
  uncachedIfDegraded(
    (r: EngineKpiTrend) => r.trendDegraded === true,
    (filters: StandardFilters, trendDays: number) =>
      aggregateEngineKpiTrendFromMirror(filters, undefined, {
        trendDays,
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
const cachedKpiFirstPosition = mirrorCache("kpi-first-position",
  (filters: StandardFilters, trendDays: number, profile: KpiBudgetProfile) =>
    aggregateFirstPositionFromMirror(filters, undefined, {
      trendDays,
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

/** 직전 측정일 스냅샷의 카테고리별 인용 수 — 인용 화면 카테고리 Δ(pp)의 분모. */
const cachedCitationCategoriesPrev = mirrorCache("citation-categories-prev",
  async (filters: StandardFilters): Promise<{ totals: CitationCategoryTotals; asOf: string } | null> => {
    const days = await latestMeasureDays(filters, undefined);
    if (days.length < 2) return null;
    const totals = await aggregateCitationCategoryTotalsFromMirror(
      { ...filters, dateTo: days[1] }, undefined,
      { statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS, budgetMs: KPI_TAB_SINGLE_BUDGET_MS },
    );
    return totals ? { totals, asOf: days[1] } : null;
  });

export async function fetchStandardCitationCategoriesPrev(
  filters: StandardFilters = {},
): Promise<{ totals: CitationCategoryTotals; asOf: string } | null> {
  return kpiDegrade("citationCategoriesPrev", () =>
    withStandardRoot("standardCitationCategoriesPrev",
      null as { totals: CitationCategoryTotals; asOf: string } | null,
      cachedCitationCategoriesPrev, filters),
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
export function globalSeriesFilters(
  f: StandardFilters,
  now: number = Date.now(),
): StandardFilters {
  const floor = new Date(now - G_TREND_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
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
): Promise<SummaryReadRoute> => {
  const route = await applyScreenGate(
    await cachedGlobalPeriodBase(JSON.stringify({ r: rootId, f })),
    screen,
  );
  if (!(route.path === "mirror" && route.reason === "disabled")) {
    console.info(`x-hmg-summary(global ${screen} period): ${summaryRouteHeaderValue(route)}`);
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
    readGlobalTrendCore(globalTrendScopeOf(set, ownVariant, filters)),
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
    value: attachBrandSeries(core.value, new Map(series.value), snap.value),
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
      value: attachBrandSeries(core.value, new Map(series.value), totals),
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
 * 집계층 시계열 → 화면 하나분. 폴백은 **전부 미러**다(추이엔 세부층 쌍둥이가 없다).
 * `pick` 은 순수 매핑이라 실패하지 않는다 — 실패 지점은 전부 이 함수 안에 있다.
 */
async function viaGlobalSeries<T>(
  filters: StandardFilters,
  screen: SummaryScreenKey,
  read: (key: string) => Promise<SummaryTrendRead<GlobalTrendSeries>>,
  pick: (series: GlobalTrendSeries) => T,
  onMirror: () => Promise<T>,
  /** 이 화면이 실제로 읽는 표 — 접기 존재 검사 대상(GG-7). */
  tables: TrendStatementKey[],
  extraKey: Record<string, unknown> = {},
): Promise<T> {
  const rootId = getStandardRootId();
  if (!rootId) return onMirror();
  const f = globalSeriesFilters(filters);
  const route = await globalPeriodRoute(rootId, f, screen);
  if (route.path !== "summary") return onMirror();
  // ② 점이 하나면 시계열이 아니다 — 백필 전까지 미러 유지.
  if (route.anchorCount < G_TREND_MIN_CYCLES) {
    console.info(
      `x-hmg-summary(global ${screen} period): fallback:agg-single-cycle(${route.anchorCount}) → mirror`,
    );
    return onMirror();
  }
  const plan = planTrendRead({ surface: "global", filters });
  if (!plan.ok) {
    console.info(`x-hmg-summary(global ${screen} period): fallback:${plan.reason} → mirror`);
    return onMirror();
  }
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
  return pick(out.value);
}

/**
 * KPI 탭 추이 3종에 **갭 후보 키**를 얹는다(0070). 결과가 null 이면 그대로 null.
 *
 * 캐시 밖에서 얹는 이유는 `fetchStandardTrend` 와 같다 — 원장 한 줄을 고치면 다음
 * 요청부터 반영돼야 한다. 값(숫자)은 하나도 안 바뀐다: 마커 후보 목록만 붙는다.
 */
async function withKpiTrendGaps<T extends { gapBuckets?: string[] }>(
  result: T | null,
  unit: BucketUnit = "week",
): Promise<T | null> {
  if (!result) return result;
  // 계열 = **언급**(0071). 이 헬퍼를 쓰는 셋(브랜드 추이·엔진 KPI·우선 노출도)은
  // 전부 언급 계열이라 `hidden_scope='citations'` 회차에서는 목록이 **빈다** —
  // 그러면 `kpi-view.ts` 의 `gapMarks` 도 저절로 비어 UI 는 한 줄도 안 고친다.
  const gapBuckets = await trendGapWeekKeys(unit, "global", rootProjectIdsForGaps(), "mention");
  return gapBuckets ? { ...result, gapBuckets } : result;
}

/**
 * 주별 Top-N 추이 2종(인용 도메인·유형 · 언급 브랜드)에 갭 슬롯을 얹는다(0070).
 *
 * `trend`·`categoryTrend` 두 자리를 **함께** 덮는다 — 한쪽만 덮으면 같은 화면의 두 차트가
 * 다른 축을 그린다(위/아래가 한 칸 어긋나 보인다).
 */
async function withWeeklyGaps<
  T extends { trend?: WeeklyTrend | null; categoryTrend?: WeeklyTrend | null },
>(
  result: T | null,
  surface: CycleSurface | null,
  projectIds: string[],
  // 계열(0071) — **기본값 없음**. 언급 화면과 인용 화면이 같은 헬퍼를 쓰는데, 계열을
  // 안 주면 언급 화면에 인용만 깨진 회차의 음영이 그대로 덮인다(값은 살아 있는데).
  family: TrendGapFamily,
): Promise<T | null> {
  if (!result) return result;
  if (!result.trend && !result.categoryTrend) return result;
  const gapWeeks = await weeklyGapWeeks(surface, projectIds, family);
  if (gapWeeks.length === 0) return result;
  const trend = applyWeeklyTrendGaps(result.trend ?? null, gapWeeks);
  const categoryTrend = applyWeeklyTrendGaps(result.categoryTrend ?? null, gapWeeks);
  if (trend === (result.trend ?? null) && categoryTrend === (result.categoryTrend ?? null)) {
    return result;
  }
  return {
    ...result,
    ...(result.trend !== undefined ? { trend } : {}),
    ...(result.categoryTrend !== undefined ? { categoryTrend } : {}),
  };
}

/** 경쟁사 스파크라인·주별 브랜드 라인의 원천. null = 이 지면만 degrade. */
export async function fetchStandardKpiBrandTrend(
  filters: StandardFilters = {},
  opts: { trendDays?: number; topBrands?: number; budget?: KpiBudgetProfile } = {},
): Promise<BrandTrendResult | null> {
  const trendDays = opts.trendDays ?? KPI_TAB_SPARK_TREND_DAYS;
  const topBrands = opts.topBrands ?? 10;
  // 기본값은 **종전 예산**(S2 4-KPI 탭). 더 짧은 extras 예산은 대시보드가 명시한다.
  const profile = opts.budget ?? "kpi-tab";
  return withKpiTrendGaps(await degradeAware("brandTrend", () =>
    withStandardRoot("standardKpiBrandTrend", null as BrandTrendResult | null,
      // 프로파일은 **미러 폴백**에만 실린다 — 집계층 경로는 회차 read 라 이 예산의
      // 대상이 아니고, 프로파일은 미러 셀의 캐시 키다(PR③-a: 안 넣으면 먼저 채운
      // 쪽의 예산으로 만든 셀을 다른 호출자가 그대로 받는다).
      (f) => viaGlobalSeries(f, "S1.brandTrend", requestGlobalBrands,
        (series) => toBrandTrend(series, {
          unit: "week", cap: topBrands, trendDays, filters: globalSeriesFilters(f),
        }),
        () => cachedKpiBrandTrend(f, trendDays, topBrands, profile),
        ["own", "domains", "brands"], { cap: topBrands }), filters),
  ));
}

/** 히어로 추이 + 엔진별 섹션의 원천(최신 스칼라는 스냅샷 창). */
export async function fetchStandardKpiEngineTrend(
  filters: StandardFilters = {},
  opts: { trendDays?: number } = {},
): Promise<EngineKpiTrend | null> {
  const trendDays = opts.trendDays ?? KPI_TAB_HERO_TREND_DAYS;
  return withKpiTrendGaps(await kpiDegrade("engineTrend", () =>
    withStandardRoot("standardKpiEngineTrend", null as EngineKpiTrend | null,
      (f) => recoverDegraded(() => cachedKpiEngineTrend(f, trendDays)), filters),
  ));
}

/** 우선 노출도 — 브랜드별 평균 등장 순위(스냅샷 순위표 + 회차 시계열). null = degrade. */
export async function fetchStandardKpiFirstPosition(
  filters: StandardFilters = {},
  opts: { trendDays?: number; budget?: KpiBudgetProfile } = {},
): Promise<FirstPositionResult | null> {
  const trendDays = opts.trendDays ?? KPI_TAB_HERO_TREND_DAYS;
  const profile = opts.budget ?? "kpi-tab";
  return withKpiTrendGaps(await degradeAware("firstPosition", () =>
    withStandardRoot("standardKpiFirstPosition", null as FirstPositionResult | null,
      (f) => viaGlobalSeries(f, "S1.firstPosition", requestGlobalBrands,
        // 축은 **종전 그대로**(본문 서수) — 이 키를 켜는 것은 값 변경이라 승인 대상이고,
        // 0069(경쟁 순위)로 옮기는 것도 그 승인에 포함된다(`screens.ts` 의 이 키 주석).
        (series) => toFirstPosition(series, {
          unit: "week", cap: 10, trendDays, positionAxis: "ordinal",
        }),
        () => cachedKpiFirstPosition(f, trendDays, profile),
        ["own", "domains", "brands"], { cap: 10 }), filters),
  ));
}

// ── 대시보드 경쟁사 Δ — 회차 축 2단 (PR④ B2) ───────────────────────────────
//
// 오늘 이 경계는 `fetchStandardKpiBrandTrend` + `fetchStandardKpiFirstPosition` 을
// 부르고, 둘 다 전역 키(`S1.brandTrend`·`S1.firstPosition`)가 off 라 **미러**로 간다
// (pgss 실측 2026-09-10: mean 9.7 s / 8.9 s · max 35 s). `dashboard:kpi-competitors`
// 16.5 s 중 두 자리를 차지하는 것이 이 둘이다.
//
// 여기서 하는 것은 **경계 교체**이지 전역 전환이 아니다 — 위 두 전역 페처와 그 키는
// 그대로 두고(운영 D3 (1): S2 4-KPI 탭은 종전 유지), 대시보드 경계만 `S1.competitors`
// 아래에서 회차 축을 읽는다. 그래서 값 변경 표면이 이 카드 하나로 갇힌다.
//
// ⚠️ `avgPosition` 은 이 전환에서 **축이 바뀐다**(경쟁 순위 → 텍스트 내 서수).
//    수치·근거·미결 결정은 `lib/summary/read/screens.ts` 의 `S1.competitors` 주석이
//    정본이다 — Δ 는 그 축 위의 차분이므로 부호·크기 모두 종전과 비교할 수 없다.

/** 경쟁사 Δ 두 지면이 공유하는 회차 축 read. 같은 키 → 문장 1벌. */
function competitorSeries<T>(
  filters: StandardFilters,
  names: readonly string[],
  totals: GlobalTrendBrandPoint[],
  pick: (series: GlobalTrendSeries) => T,
  onMirror: () => Promise<T>,
): Promise<T> {
  return viaGlobalSeries(filters, "S1.competitors", requestGlobalCompetitorSeries, pick, onMirror,
    // 읽는 표 셋 — 코어(own·domains) + 브랜드 회차 축. 접기 존재 검사 대상이 곧 이것이다(GG-7).
    ["own", "domains", "brands"], { names: [...names], totals });
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
    fetchStandardCompetitorBrands(filters, { budget: "extras" }),
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
export async function fetchStandardAcr(
  filters: StandardFilters = {},
): Promise<StandardAcr | null> {
  return withStandardRoot("standardAcr", null, cachedStandardAcr, filters);
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
  return cachedCitationAccuracyTrend(
    normalizeFilters(filters),
    [...trackedUrls].sort(),
    unit,
    ownedPrefix,
    scopeProjectId ?? "",
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
  return withProject(
    "projectStandardAggregates",
    localProjectId,
    null,
    (id, f) => cachedProjectAggregates(id, f, ownedBasePrefixes),
    filters,
  );
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
    const buckets = await withProject(
      "projectTrend",
      localProjectId,
      [] as StandardTrendBucket[],
      (id, f) => cachedProjectTrend(id, f, unit, ownedBasePrefixes),
      filters,
    );
    // 프로젝트 표면은 회차 표면이 무엇인지 여기서 단정할 수 없다(원장에 website·project
    // 둘 다 있다) — 표면을 가리지 않고 **그 프로젝트의** 숨긴 회차만 본다.
    return withTrendGapBuckets(buckets, unit, null, await gapProjectIds(localProjectId));
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
  ): Promise<MentionsLive | null> =>
    // 예산에 걸리면 **null** 을 내고 페이지는 그대로 서빙된다(E-2 와 같은 자세).
    // `null` 의 두 뜻("데이터 없음" vs degrade)은 `wasDegraded("standardMentions")` 로 가른다.
    withWeeklyGaps(
      await degradeAware("standardMentions", () =>
        withStandardRoot("standardMentions", null as MentionsLive | null,
          (f) => recoverDegraded(() => cachedStandardMentions(f, opts.budget ?? "screen")),
          filters)),
      "global",
      rootProjectIdsForGaps(),
      "mention",
    ),
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
  // 종전 경로. `MentionsBrandLive` 는 `CompetitorBrandValue` 의 구조적 상위 타입이라
  // 그대로 대입된다 — 화면은 어느 경로로 왔는지 모른다(폴백의 전제).
  const onMirror = async (): Promise<CompetitorBrandValue[] | null> =>
    (await fetchStandardMentions(filters, { budget: opts.budget }))?.brands ?? null;
  if (!(await summaryScreenAllowed("S1.competitors"))) return onMirror();
  // degrade 라벨은 **종전과 같은 것**을 쓴다 — 고지 지면(`COMPETITOR_LABELS`)이 읽는
  // 것이 이 문자열이고, 이 행이 비는 사유는 경로가 바뀌어도 같은 뜻이다.
  return degradeAware("standardMentions", () =>
    withStandardRoot("standardCompetitorBrands", null as CompetitorBrandValue[] | null,
      // 세부층(`onDetail`)에는 이 값의 쌍둥이가 없다 — 세부층 `StandardAggregates.brands`
      // 는 `name`·`mentionCount`·`answerCount`·`isTracked` 넷뿐이라 점유율·순위·감정을
      // 못 낸다. 그래서 `agg-*` 도 `gate-*` 도 목적지가 **미러 하나**다(추이와 같은 2층).
      (f) => viaGlobalS1<CompetitorBrandValue[]>(f, (v) => v.competitors,
        async () => (await onMirror()) ?? [],
        async () => (await onMirror()) ?? []),
      filters));
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
    withWeeklyGaps(
      await degradeAware("standardCitations", () =>
        withStandardRoot("standardCitations", null as CitationsLive | null,
          (f) => cachedStandardCitations(f, "screen"), filters)),
      "global",
      rootProjectIdsForGaps(),
      "citation",
    ),
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
  return withStandardRoot("standardGeoKpi", { brands: [], codes: [] } as GeoKpiResult,
    // ④ GEO 는 PR② 이전에도 미러였다(플랜 §6-1 "S1 GEO → 미러") — 세부층 쌍둥이가
    // 없으므로 `agg-*` 도 미러다. 형제 위젯 혼합 문제는 여기 없다: 이 위젯의 종전
    // 목적지가 이미 미러였고, 카드가 세부층으로 돌아오면 오히려 둘 다 사실표 계열이 된다.
    (f) => viaGlobalS1(f, (v) => v.geo, () => cachedGeoKpi(f), () => cachedGeoKpi(f)), filters);
}

export async function fetchStandardGeoCompetition(
  filters: StandardFilters = {},
): Promise<GeoBrandMention[]> {
  return (await degradeAware("standardGeoCompetition", () =>
    withStandardRoot("standardGeoCompetition", [],
      (f) => viaGlobalSummary(f, "S1.dashboard", cachedSummaryGlobalGeoCompetition,
        () => cachedGeoCompetition(f)), filters))) ?? [];
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

// Common flow: enforce → 세션 scope로 website project IDs 조회 → cached fn.
async function withWebsite<T>(
  action: string,
  empty: T,
  fn: (projectIds: string[], filters: StandardFilters) => Promise<T>,
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
// website 표면은 타겟 URL 집합에 일치하는 인용을 자사로 판정한다(2026-09-06, 운영 결정 —
// 타겟 ⊂ 자사. 규칙·실측은 scope-aggregates websiteTargetOwnedClause 주석). 선언 base
// 유무와 무관하게 켠다 — 카탈로그 폴백 경로에서도 타겟 페이지는 자사다.
const WEBSITE_TARGETS_OWNED = true;

async function websiteOwnedPrefixes(
  projectIds: string[],
  filters: StandardFilters,
): Promise<{ prefixes: string[]; universe: string[] | undefined }> {
  const { prefixes, universe } = await websiteDeclaredOwnedBases(filters, projectIds);
  // 선언이 있으면 형제 모집단도 선언 목록으로 — 카탈로그를 쓰면 같은 사이트의 하위
  // 경로를 남의 자산으로 오인한다. 선언이 없으면 종전 카탈로그 경로 그대로.
  return prefixes.length
    ? { prefixes, universe }
    : { prefixes: scopeOwnedPrefixes(filters), universe: undefined };
}

// S4 카드의 미러 폴백 — S1 과 같은 경계·같은 프로파일(실측 문장 10개·exec 9.7 s).
const cachedWebsiteAggregates = mirrorCache("website-aggregates",
  async (projectIds: string[], filters: StandardFilters) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateStandardFromMirror(filters, projectIds, own.prefixes, own.universe,
      WEBSITE_TARGETS_OWNED, mirrorHeavyBudget("cardsMirror"));
  });

const cachedWebsiteTrend = mirrorCache("website-trend",
  async (projectIds: string[], filters: StandardFilters, unit: BucketUnit) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateStandardTrendFromMirror(filters, unit, projectIds, own.prefixes, own.universe, WEBSITE_TARGETS_OWNED);
  });

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
      });
  });

const cachedWebsitePromptTopics = mirrorCache("website-prompt-topics",
  (projectIds: string[], filters: StandardFilters) =>
    aggregatePromptTopicFromMirror(filters, projectIds));

const cachedWebsiteSourceComposition = mirrorCache("website-source-composition",
  async (projectIds: string[], filters: StandardFilters) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateSourceCompositionFromMirror(filters, projectIds, own.prefixes);
  });

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
      WEBSITE_TARGETS_OWNED, mirrorHeavyBudget("citationsWide"));
  });

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
    return aggregateWebsiteCitationAccuracy(filters, projectIds, own.prefixes, own.universe);
  });

// 타겟 URL 인용률(프롬프트 단위) — website 전용. 반드시 withWebsite 를 거쳐야 한다:
// 브랜드 축은 website 프롬프트가 표준 prompts 카탈로그 밖이라 catalogIn("brand")
// 경로로는 0건이 되고, withWebsite 가 이를 project id 필터로 흡수한 뒤 filters.brand
// 를 제거해 준다. 페이지가 리포지토리를 직접 부르면 brand 선택 시 값이 사라진다
// (2026-08-26 실측: region=GB 75/93 → brand=Genesis 추가 시 0/0).
const cachedWebsiteTargetHitRate = mirrorCache("website-target-hit-rate",
  (projectIds: string[], filters: StandardFilters) =>
    aggregateWebsiteTargetHitRate(filters, projectIds));

const cachedWebsiteCitationAccuracyTrend = mirrorCache("website-citation-accuracy-trend",
  async (projectIds: string[], filters: StandardFilters, unit: BucketUnit) => {
    const own = await websiteOwnedPrefixes(projectIds, filters);
    return aggregateWebsiteCitationAccuracyTrend(filters, unit, projectIds, own.prefixes, own.universe);
  });

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
  const set = cycleSetOf(route);
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
});

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
  // 이번 회차 데이터가 없는 것이지, 옛 값으로 메울 대상이 아니다(운영 2026-09-06).
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
  const route = await websiteSummaryRoute(ids, f, screen);
  if (route.path !== "summary") return onMirror();
  const set = cycleSetOf(route);
  const detail = () => onDetail(route.cycleKey, set, route.projectIds, f);
  const plan = planTrendRead({
    surface: "website",
    filters: f,
    unitFlags: await summaryUnitFlagsAvailable(),
  });
  if (!plan.ok) {
    console.info(`x-hmg-summary(${screen}): fallback:${plan.reason} → detail`);
    return detail();
  }
  // A1 — 프로브·read 동시 발행. 목적지·로그·판정 순서는 종전과 같다.
  const gated = await foldGated(
    cachedWebsiteFoldPresent(JSON.stringify(set)),
    () => onSummary(route.cycleKey, set, route.projectIds, f),
  );
  if (!gated.folded) {
    console.info(`x-hmg-summary(${screen}): fallback:agg-fold-missing → detail`);
    return detail();
  }
  const out = gated.value;
  if (out.empty) {
    console.info(`x-hmg-summary(${screen}): fallback:agg-empty → detail`);
    return detail();
  }
  return out.value;
}

// 요청단위 dedup — 웹사이트도 필터바(측정 기준일 슬롯)와 본문(DashboardBody →
// getLiveWebsiteDashboard)이 같은 read 를 부른다(2026-09-01, 표준과 동일 이유).
export const fetchWebsiteAggregates = requestDeduped(
  "fetchWebsiteAggregates",
  async (filters: StandardFilters = {}): Promise<StandardAggregates | null> =>
    degradeAware("websiteAggregates", () =>
      withWebsite("websiteAggregates", null,
        (ids, f) => viaTrend(ids, f, "S4.dashboard",
          async (...a) => pickRead(await cachedSummaryWebsiteDashboard(...a), (v) => v.aggregates),
          cachedSummaryWebsiteAggregatesDetail,
          () => cachedWebsiteAggregates(ids, f)), filters)),
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
    const set = await websiteTrendSet(ids, f);
    const buckets = set
      ? await cachedSummaryWebsiteTrend(set.cycleKey, set, set.projectIds, f)
      : await cachedWebsiteTrend(ids, f, unit);
    // 갭 슬롯(0070)은 캐시 밖에서 — 글로벌 경로(`fetchStandardTrend`)와 같은 자세.
    // 함대는 프로젝트가 여럿이라 숨긴 회차도 여럿일 수 있다: 같은 주에 여러 사이트가
    // 숨겨졌으면 키가 같으므로 슬롯은 하나다(`insertTrendGapSlots` 가 중복을 접는다).
    return withTrendGapBuckets(buckets, unit, "website", ids);
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
    return subKpisPrevImpl(filters, projectIds, own.prefixes, own.universe, WEBSITE_TARGETS_OWNED);
  });

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
  return (await degradeAware("websiteGeoCompetition", () =>
    withWebsite("websiteGeoCompetition", [],
      (ids, f) => viaTrend(ids, f, "S4.dashboard",
        async (...a) => pickRead(await cachedSummaryWebsiteDashboard(...a), (v) => v.geo),
        cachedSummaryWebsiteGeoCompetitionDetail,
        () => cachedWebsiteGeoCompetition(ids, f)), filters))) ?? [];
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
    const set = await websiteTrendSet(ids, f);
    return set
      ? cachedSummaryWebsiteCitationAccuracyTrend(set.cycleKey, set, set.projectIds, f)
      : cachedWebsiteCitationAccuracyTrend(ids, f, unit);
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
    degradeAware("websiteMentions", () =>
      withWebsite("websiteMentions", null as MentionsLive | null, async (ids, f) =>
        // 갭 슬롯은 degrade 보호 **안**에서, 미러 결과에 얹는다(ids 가 여기서만 보인다).
        withWeeklyGaps(await cachedWebsiteMentions(ids, f), "website", ids, "mention"), filters)),
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
      withWebsite("websiteCitations", null as CitationsLive | null, async (ids, f) =>
        withWeeklyGaps(await cachedWebsiteCitations(ids, f), "website", ids, "citation"), filters)),
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

export async function fetchWebsiteTargetHitRate(
  filters: StandardFilters = {},
): Promise<WebsiteTargetHitRateResult> {
  return withWebsite("websiteTargetHitRate", { hitPrompts: 0, measuredPrompts: 0, rate: null },
    (ids, f) => cachedWebsiteTargetHitRate(ids, f), filters);
}

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
