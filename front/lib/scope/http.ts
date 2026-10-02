import type { ScopeClient, ScopeReadOptions } from "./client";
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
  ScopeErrorBody,
  UpdateProjectInput,
  UpdatePromptInput,
  UsageSummary,
} from "./types";

// Version prefix for all public endpoints. SCOPE_API_BASE is the bare host
// (e.g. https://scope-api.example.com); this is appended in code so a
// version bump (/api/v2) is a one-line change (design D4).
const API_PREFIX = "/api/v1";

// Thrown on any non-2xx scope response, carrying the parsed error envelope.
export class ScopeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly path: string,
  ) {
    super(`scope ${status} ${code ?? ""} at ${path}: ${message}`.trim());
    this.name = "ScopeHttpError";
  }
}

// Live implementation against scope's public API. Inactive until SCOPE_MODE=live
// and a workspace key are provided. The workspace key lives ONLY here, server-
// side, and never reaches the browser (scope-gateway / access-control specs).
export class HttpScopeClient implements ScopeClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
  ) {
    // Tolerate a trailing slash or an accidentally-included /api/v1 on the env.
    const trimmed = baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    this.base = `${trimmed}${API_PREFIX}`;
  }

  private headers(json: boolean): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  // Drops undefined/empty values so optional filters don't emit blank params.
  private qs(query?: Record<string, unknown>): string {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  private async request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal; acceptEncoding?: "gzip" },
  ): Promise<T> {
    const url = `${this.base}${path}${this.qs(opts?.query)}`;
    const res = await fetch(url, {
      method,
      headers: {
        ...this.headers(opts?.body !== undefined),
        ...(opts?.acceptEncoding ? { "Accept-Encoding": opts.acceptEncoding } : {}),
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      let code: string | undefined;
      let message = res.statusText;
      try {
        const parsed = (await res.json()) as ScopeErrorBody;
        code = parsed?.error?.code;
        message = parsed?.error?.message ?? message;
      } catch {
        // non-JSON error body — keep statusText
      }
      throw new ScopeHttpError(res.status, code, message, path);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // --- Settings: projects ---

  listProjects(query?: PageQuery): Promise<Paginated<ProjectSummary>> {
    return this.request("GET", "/projects", { query: query as Record<string, unknown> });
  }
  getProject(projectId: string): Promise<Project> {
    return this.request("GET", `/projects/${projectId}`);
  }
  createProject(input: CreateProjectInput): Promise<Project> {
    return this.request("POST", "/projects", { body: input });
  }
  updateProject(projectId: string, input: UpdateProjectInput): Promise<Project> {
    return this.request("PATCH", `/projects/${projectId}`, { body: input });
  }
  deleteProject(projectId: string): Promise<void> {
    return this.request("DELETE", `/projects/${projectId}`);
  }

  // --- Settings: prompts ---

  listPrompts(projectId: string, query?: PromptsQuery, options?: ScopeReadOptions): Promise<Paginated<Prompt>> {
    return this.request("GET", `/projects/${projectId}/prompts`, {
      query: query as Record<string, unknown>,
      signal: options?.signal,
    });
  }
  createPrompt(projectId: string, input: CreatePromptInput): Promise<Prompt> {
    return this.request("POST", `/projects/${projectId}/prompts`, { body: input });
  }
  updatePrompt(
    projectId: string,
    promptId: string,
    input: UpdatePromptInput,
  ): Promise<Prompt> {
    return this.request("PATCH", `/projects/${projectId}/prompts/${promptId}`, {
      body: input,
    });
  }
  deletePrompt(projectId: string, promptId: string): Promise<void> {
    return this.request("DELETE", `/projects/${projectId}/prompts/${promptId}`);
  }

  // --- Settings: measurement schedule ---

  getSchedule(projectId: string): Promise<ScheduleResponse> {
    return this.request("GET", `/projects/${projectId}/schedule`);
  }
  putSchedule(
    projectId: string,
    input: ScheduleUpdateInput,
  ): Promise<ScheduleResponse> {
    return this.request("PUT", `/projects/${projectId}/schedule`, { body: input });
  }

  // --- Result reads ---

  getOverview(projectId: string, windowDays?: number): Promise<ProjectOverview> {
    return this.request("GET", `/projects/${projectId}/overview`, {
      query: { window_days: windowDays },
    });
  }
  listBrandScores(
    projectId: string,
    query?: BrandScoresQuery,
  ): Promise<Paginated<BrandScore>> {
    return this.request("GET", `/projects/${projectId}/brand-scores`, {
      query: query as Record<string, unknown>,
    });
  }
  listBrandMentions(
    projectId: string,
    query?: BrandMentionsQuery,
  ): Promise<Paginated<BrandMention>> {
    return this.request("GET", `/projects/${projectId}/brand-mentions`, {
      query: query as Record<string, unknown>,
    });
  }
  getBrandMention(projectId: string, brandMentionId: string): Promise<BrandMention> {
    return this.request(
      "GET",
      `/projects/${projectId}/brand-mentions/${brandMentionId}`,
    );
  }
  listCitations(
    projectId: string,
    query?: CitationsQuery,
  ): Promise<Paginated<Citation>> {
    return this.request("GET", `/projects/${projectId}/citations`, {
      query: query as Record<string, unknown>,
    });
  }
  listCitationsByDomain(projectId: string): Promise<Paginated<CitationByDomain>> {
    return this.request("GET", `/projects/${projectId}/citations/by-domain`);
  }
  listReports(projectId: string, query?: PageQuery): Promise<Paginated<Report>> {
    return this.request("GET", `/projects/${projectId}/reports`, {
      query: query as Record<string, unknown>,
    });
  }
  getReport(projectId: string, reportId: string): Promise<Report> {
    return this.request("GET", `/projects/${projectId}/reports/${reportId}`);
  }

  // --- REAL measurement-result reads ---

  listResults(query?: { limit?: number }): Promise<ResultsResponse> {
    return this.request("GET", "/results", { query });
  }
  getQueryRun(jobId: string, options?: ScopeReadOptions): Promise<QueryRunView> {
    return this.request("GET", `/query/${jobId}`, options);
  }
  getMeasurementRun(projectId: string, runId: string, options?: ScopeReadOptions): Promise<MeasurementRunSummary> {
    return this.request("GET", `/projects/${projectId}/measurements/${runId}`, options);
  }
  listMeasurementRuns(
    projectId: string,
    query?: PageQuery,
    options?: ScopeReadOptions,
  ): Promise<Paginated<MeasurementRunSummary>> {
    return this.request("GET", `/projects/${projectId}/measurements`, {
      query: query as Record<string, unknown>,
      signal: options?.signal,
    });
  }
  listRunJobs(
    projectId: string,
    runId: string,
    query?: RunJobsQuery,
    options?: ScopeReadOptions,
  ): Promise<Paginated<MeasurementJob>> {
    return this.request(
      "GET",
      `/projects/${projectId}/measurements/${runId}/jobs`,
      // Large analysis pages otherwise negotiate Brotli. The existing Scope
      // endpoint spends seconds compressing each page before sending headers;
      // gzip preserves the decoded JSON while avoiding that per-page delay.
      { query: query as Record<string, unknown>, signal: options?.signal, acceptEncoding: "gzip" },
    );
  }

  // --- Workspace ---

  getUsage(): Promise<UsageSummary> {
    return this.request("GET", "/usage");
  }
  health(): Promise<HealthStatus> {
    return this.request("GET", "/health");
  }
}
