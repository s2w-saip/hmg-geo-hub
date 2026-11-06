// Type-only snapshot; no database or server implementation is included.
import type { ScopeClient, ScopeReadOptions } from "./client";
import type { BrandMention, BrandMentionsQuery, BrandScore, BrandScoresQuery, Citation, CitationByDomain, CitationsQuery, CreateProjectInput, CreatePromptInput, HealthStatus, MeasurementJob, MeasurementRunSummary, Paginated, PageQuery, Project, ProjectOverview, ProjectSummary, Prompt, PromptsQuery, QueryRunView, Report, ResultsResponse, RunJobsQuery, ScheduleResponse, ScheduleUpdateInput, UpdateProjectInput, UpdatePromptInput, UsageSummary } from "./types";
export declare class ScopeHttpError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    readonly path: string;
    constructor(status: number, code: string | undefined, message: string, path: string);
}
export declare class HttpScopeClient implements ScopeClient {
    private readonly apiKey;
    private readonly base;
    constructor(baseUrl: string, apiKey: string);
    private headers;
    private qs;
    private request;
    listProjects(query?: PageQuery): Promise<Paginated<ProjectSummary>>;
    getProject(projectId: string): Promise<Project>;
    createProject(input: CreateProjectInput): Promise<Project>;
    updateProject(projectId: string, input: UpdateProjectInput): Promise<Project>;
    deleteProject(projectId: string): Promise<void>;
    listPrompts(projectId: string, query?: PromptsQuery, options?: ScopeReadOptions): Promise<Paginated<Prompt>>;
    createPrompt(projectId: string, input: CreatePromptInput): Promise<Prompt>;
    updatePrompt(projectId: string, promptId: string, input: UpdatePromptInput): Promise<Prompt>;
    deletePrompt(projectId: string, promptId: string): Promise<void>;
    getSchedule(projectId: string): Promise<ScheduleResponse>;
    putSchedule(projectId: string, input: ScheduleUpdateInput): Promise<ScheduleResponse>;
    getOverview(projectId: string, windowDays?: number): Promise<ProjectOverview>;
    listBrandScores(projectId: string, query?: BrandScoresQuery): Promise<Paginated<BrandScore>>;
    listBrandMentions(projectId: string, query?: BrandMentionsQuery): Promise<Paginated<BrandMention>>;
    getBrandMention(projectId: string, brandMentionId: string): Promise<BrandMention>;
    listCitations(projectId: string, query?: CitationsQuery): Promise<Paginated<Citation>>;
    listCitationsByDomain(projectId: string): Promise<Paginated<CitationByDomain>>;
    listReports(projectId: string, query?: PageQuery): Promise<Paginated<Report>>;
    getReport(projectId: string, reportId: string): Promise<Report>;
    listResults(query?: {
        limit?: number;
    }): Promise<ResultsResponse>;
    getQueryRun(jobId: string, options?: ScopeReadOptions): Promise<QueryRunView>;
    getMeasurementRun(projectId: string, runId: string, options?: ScopeReadOptions): Promise<MeasurementRunSummary>;
    listMeasurementRuns(projectId: string, query?: PageQuery, options?: ScopeReadOptions): Promise<Paginated<MeasurementRunSummary>>;
    listRunJobs(projectId: string, runId: string, query?: RunJobsQuery, options?: ScopeReadOptions): Promise<Paginated<MeasurementJob>>;
    getUsage(): Promise<UsageSummary>;
    health(): Promise<HealthStatus>;
}
