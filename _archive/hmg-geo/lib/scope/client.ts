import type {
  BrandMention,
  BrandMentionsQuery,
  BrandScore,
  BrandScoresQuery,
  Citation,
  CitationByDomain,
  CitationsQuery,
  CreateProjectInput,
  CreatePromptInput,
  HealthStatus,
  MeasurementJob,
  MeasurementRunSummary,
  Paginated,
  PageQuery,
  Project,
  ProjectOverview,
  ProjectSummary,
  Prompt,
  PromptsQuery,
  QueryRunView,
  Report,
  ResultsResponse,
  RunJobsQuery,
  ScheduleResponse,
  ScheduleUpdateInput,
  UpdateProjectInput,
  UpdatePromptInput,
  UsageSummary,
} from "./types";

// The single contract every server-side scope caller depends on. Implementations
// (mock | http) are interchangeable; callers are unaware of the origin
// (scope-gateway spec).
//
// This is a ROLE-BLIND transport contract: it faithfully mirrors scope's public
// API surface (/api/v1/*) and nothing more. It does NOT take a ScopeFilter —
// scope's public reads are project-scoped aggregates with no value filters, so
// there is nowhere to put one. Role→access gating is the enforcement layer's
// job (lib/scope/server.ts), never the transport's.
//
// Measurement triggers (/query, /measurements) and the internal /results feed
// are scope-internal and are deliberately NOT part of this contract.
/** Request-local cancellation, separate from API query parameters. */
export interface ScopeReadOptions {
  signal?: AbortSignal;
}

export interface ScopeClient {
  // --- Settings: projects (CRUD) ---
  listProjects(query?: PageQuery): Promise<Paginated<ProjectSummary>>;
  getProject(projectId: string): Promise<Project>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(projectId: string, input: UpdateProjectInput): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;

  // --- Settings: prompts (CRUD) ---
  listPrompts(projectId: string, query?: PromptsQuery, options?: ScopeReadOptions): Promise<Paginated<Prompt>>;
  createPrompt(projectId: string, input: CreatePromptInput): Promise<Prompt>;
  updatePrompt(
    projectId: string,
    promptId: string,
    input: UpdatePromptInput,
  ): Promise<Prompt>;
  deletePrompt(projectId: string, promptId: string): Promise<void>;

  // --- Settings: measurement schedule (1 project = 1 schedule, upsert) ---
  // Controls scope's cadence interval per project (interval_days × 24h
  // freshness window). This is schedule CONFIG, not a measurement trigger —
  // the trigger surfaces stay deliberately out of this contract.
  getSchedule(projectId: string): Promise<ScheduleResponse>;
  putSchedule(
    projectId: string,
    input: ScheduleUpdateInput,
  ): Promise<ScheduleResponse>;

  // --- Result reads (scope fills via measurement; HMG reads) ---
  getOverview(projectId: string, windowDays?: number): Promise<ProjectOverview>;
  listBrandScores(
    projectId: string,
    query?: BrandScoresQuery,
  ): Promise<Paginated<BrandScore>>;
  listBrandMentions(
    projectId: string,
    query?: BrandMentionsQuery,
  ): Promise<Paginated<BrandMention>>;
  getBrandMention(projectId: string, brandMentionId: string): Promise<BrandMention>;
  listCitations(
    projectId: string,
    query?: CitationsQuery,
  ): Promise<Paginated<Citation>>;
  listCitationsByDomain(projectId: string): Promise<Paginated<CitationByDomain>>;
  // reports endpoint is pending scope redeploy (currently 404) — contract is
  // declared so callers/tests can target it; live calls 404 until republished.
  listReports(projectId: string, query?: PageQuery): Promise<Paginated<Report>>;
  getReport(projectId: string, reportId: string): Promise<Report>;

  // --- REAL measurement-result reads (the surface scope actually exposes) ---
  // Used by the result adapter to feed the standard dashboard. The named
  // result methods above hit non-existent endpoints (404 live) and are kept
  // only until that Phase-0 cleanup lands; these are the live ones.
  listResults(query?: { limit?: number }): Promise<ResultsResponse>;
  // Single query-run (job) by id — the full answer body + citations + analysis,
  // for ANY job (not just the capped /results sample). Backs the lazy per-click
  // answer fetch in the mention answer modal.
  getQueryRun(jobId: string, options?: ScopeReadOptions): Promise<QueryRunView>;
  getMeasurementRun(projectId: string, runId: string, options?: ScopeReadOptions): Promise<MeasurementRunSummary>;
  listMeasurementRuns(
    projectId: string,
    query?: PageQuery,
    options?: ScopeReadOptions,
  ): Promise<Paginated<MeasurementRunSummary>>;
  listRunJobs(
    projectId: string,
    runId: string,
    query?: RunJobsQuery,
    options?: ScopeReadOptions,
  ): Promise<Paginated<MeasurementJob>>;

  // --- Workspace ---
  getUsage(): Promise<UsageSummary>;
  health(): Promise<HealthStatus>;
}
