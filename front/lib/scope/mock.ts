import type { ScopeClient } from "./client";
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
  FunnelStage,
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
  Report,
  QueryRunView,
  ResultsResponse,
  ScheduleResponse,
  ScheduleUpdateInput,
  UpdateProjectInput,
  UpdatePromptInput,
  UsageSummary,
} from "./types";

// In-memory mock of scope's public surface. Default when SCOPE_MODE is unset,
// so the app runs with no key. Faithful to the contract shapes; CRUD mutates a
// per-instance store so a create is visible in the subsequent list. Result-read
// endpoints return representative samples (scope returns empty arrays until
// measurement runs, so empty is also valid — see EmptyState handling).

const WORKSPACE = "00000000-0000-0000-0000-0000000000hmg";

function seedProjects(): Project[] {
  return [
    {
      project_id: "11111111-1111-1111-1111-111111111111",
      workspace_id: WORKSPACE,
      name: "현대차 GEO 모니터링",
      domain: "hyundai.com",
      tracked_brands: [{ brand_name: "현대" }, { brand_name: "기아" }],
      regions: ["KR", "US"],
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-20T00:00:00.000Z",
    },
    {
      project_id: "22222222-2222-2222-2222-222222222222",
      workspace_id: WORKSPACE,
      name: "Genesis EU monitoring",
      domain: "genesis.com",
      tracked_brands: [{ brand_name: "Genesis" }],
      regions: ["DE", "UK"],
      created_at: "2026-05-03T00:00:00.000Z",
      updated_at: "2026-05-21T00:00:00.000Z",
    },
  ];
}

function summary(p: Project): ProjectSummary {
  return {
    project_id: p.project_id,
    name: p.name,
    domain: p.domain,
    tracked_brands_count: p.tracked_brands.length,
    regions: p.regions,
    prompts_count: 0,
    last_measurement_at: null,
    created_at: p.created_at,
  };
}

// Deterministic-ish id without Date.now()/Math.random() (kept testable).
let counter = 1000;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

// ── Synthetic per-project measurement (answer-analysis demo) ──────────────────
// dev can't trigger a real RUN, so the per-project 답변 분석 (mention/citation)
// would be empty. Rather than fake data in the page (anti-pattern), the mock
// scope client returns this deterministic measurement for ANY project id, so
// /projects/[id]/analysis renders mentions + citations + the Category→Subcategory
// tree through the SAME enforced seam that live mode uses. Live mode swaps in the
// HTTP client and reads the project's real run — no page change.
const SYNTH_ENGINES = ["chatgpt", "gemini"] as const;
const SYNTH_RUN_SUFFIX = "::synthetic-run";

interface SynthPromptDef {
  idSuffix: string;
  text: string;
  funnel: FunnelStage;
  region: string;
  brands: { name: string; count: number; pos: number; tone: "pos" | "neu" | "neg" }[];
  citations: { host: string; path: string; title: string; category: string; subcategory: string }[];
  // kind='acr' 합성 프롬프트 — 브랜드별 (1턴 등장 횟수, 2턴 선택 횟수).
  // 반복 10회 기준. 없으면 single 프롬프트 (acr_summary 미포함).
  acr?: { name: string; appearance: number; choice: number }[];
}

const SYNTH_PROMPTS: SynthPromptDef[] = [
  {
    idSuffix: "p1",
    text: "가족이 함께 탈 SUV 추천해줘",
    funnel: "discovery",
    region: "KR",
    brands: [
      { name: "Hyundai", count: 3, pos: 1, tone: "pos" },
      { name: "Kia", count: 2, pos: 2, tone: "pos" },
      { name: "Toyota", count: 1, pos: 3, tone: "neu" },
    ],
    citations: [
      { host: "hyundai.com", path: "/kr/suv", title: "현대 SUV 라인업", category: "Official (HMG)", subcategory: "공식 사이트" },
      { host: "motorgraph.com", path: "/news/suv-2026", title: "2026 패밀리 SUV 총정리", category: "에디토리얼", subcategory: "뉴스" },
      { host: "bobaedream.co.kr", path: "/view/1", title: "패밀리 SUV 실사용 후기", category: "커뮤니티", subcategory: "포럼" },
    ],
  },
  {
    idSuffix: "p2",
    text: "전기 SUV 비교해줘",
    funnel: "evaluation",
    region: "KR",
    brands: [
      { name: "Kia", count: 2, pos: 1, tone: "pos" },
      { name: "Tesla", count: 2, pos: 2, tone: "neu" },
      { name: "Hyundai", count: 1, pos: 3, tone: "pos" },
    ],
    citations: [
      { host: "kia.com", path: "/kr/ev", title: "기아 EV 라인업", category: "Official (HMG)", subcategory: "공식 사이트" },
      { host: "youtube.com", path: "/watch?v=ev", title: "전기 SUV 비교 영상", category: "소셜", subcategory: "동영상" },
      { host: "motorgraph.com", path: "/news/ev-2026", title: "전기 SUV 비교 기사", category: "에디토리얼", subcategory: "뉴스" },
    ],
    acr: [
      { name: "Kia", appearance: 9, choice: 4 },
      { name: "Tesla", appearance: 10, choice: 5 },
      { name: "Hyundai", appearance: 7, choice: 1 },
    ],
  },
  {
    idSuffix: "p3",
    text: "현대차 보증 정책은 어때?",
    funnel: "transactional",
    region: "US",
    brands: [
      { name: "Hyundai", count: 3, pos: 1, tone: "pos" },
      { name: "Genesis", count: 1, pos: 2, tone: "pos" },
    ],
    citations: [
      { host: "hyundaiusa.com", path: "/warranty", title: "Hyundai Warranty", category: "Official (HMG)", subcategory: "공식 사이트" },
      { host: "reddit.com", path: "/r/Hyundai/warranty", title: "Warranty experiences", category: "커뮤니티", subcategory: "포럼" },
    ],
  },
];

function synthSentiment(tone: "pos" | "neu" | "neg") {
  return {
    positive: tone === "pos" ? 1 : 0,
    neutral: tone === "neu" ? 1 : 0,
    negative: tone === "neg" ? 1 : 0,
    mixed: 0,
  };
}

function synthPrompts(projectId: string): Prompt[] {
  return SYNTH_PROMPTS.map((d) => ({
    prompt_id: `${projectId}-${d.idSuffix}`,
    project_id: projectId,
    text: d.text,
    funnel_stage: d.funnel,
    keywords: [],
    kind: d.acr ? ("acr" as const) : ("single" as const),
    active: true,
    enabled: true,
    // 언어·시장은 합성 시드에 축이 없다 — null = 미지정(상속)으로 명시한다.
    // 미러 싱크가 이 필드를 읽으므로(sync.ts::upsertPrompts) 모양을 비워두지
    // 않고 계약대로 채워 둔다.
    lang: null,
    regions: null,
    created_at: "2026-06-01T00:00:00.000Z",
  }));
}

// Public-surface rows (brand-mentions / citations) for the per-project answer
// analysis — the path the app actually uses now (aggregate*FromPublic). Derived
// from the same SYNTH_PROMPTS so mock mentions/citations stay coherent with the
// (now unused) jobs feed.
function synthBrandMentions(projectId: string): BrandMention[] {
  const rows: BrandMention[] = [];
  for (const d of SYNTH_PROMPTS) {
    for (const engine of SYNTH_ENGINES) {
      const jobId = `${projectId}-${d.idSuffix}-${engine}`;
      for (const b of d.brands) {
        // one row per mention occurrence (mention_count of them) so the adapter
        // counts mentions by rows.
        for (let n = 0; n < b.count; n++) {
          rows.push({
            brand_mention_id: `${jobId}-${b.name}-${n}`,
            brand_name: b.name,
            mention_position: b.pos,
            total_brands_mentioned: d.brands.length,
            mention_type: b.tone === "pos" ? "recommendation" : "mention",
            brand_sentiment: b.tone === "pos" ? "positive" : b.tone === "neg" ? "negative" : "neutral",
            co_mentioned_brands: d.brands.filter((x) => x.name !== b.name).map((x) => x.name),
            region: d.region,
            target: engine,
            measured_at: "2026-06-15T09:00:00.000Z",
            prompt_id: `${projectId}-${d.idSuffix}`,
            prompt_text: d.text,
            query_run_id: jobId,
            measurement_run_id: `${projectId}${SYNTH_RUN_SUFFIX}`,
            is_tracked: ["Hyundai", "Kia", "Genesis"].includes(b.name),
          });
        }
      }
    }
  }
  return rows;
}

function synthCitations(projectId: string): Citation[] {
  const rows: Citation[] = [];
  for (const d of SYNTH_PROMPTS) {
    for (const engine of SYNTH_ENGINES) {
      const jobId = `${projectId}-${d.idSuffix}-${engine}`;
      for (const c of d.citations) {
        rows.push({
          url: `https://${c.host}${c.path}`,
          domain: c.host,
          title: c.title,
          category: c.category,
          subcategory: c.subcategory,
          mention_count: 1,
          brands_mentioned: d.brands.map((b) => b.name),
          target: engine,
          region: d.region,
          query_run_id: jobId,
          measured_at: "2026-06-15T09:00:00.000Z",
        });
      }
    }
  }
  return rows;
}

function synthJobs(projectId: string, includeResult: boolean): MeasurementJob[] {
  const jobs: MeasurementJob[] = [];
  for (const d of SYNTH_PROMPTS) {
    for (const engine of SYNTH_ENGINES) {
      const job: MeasurementJob = {
        job_id: `${projectId}-${d.idSuffix}-${engine}`,
        prompt_id: `${projectId}-${d.idSuffix}`,
        target: engine,
        region: d.region,
        status: "completed",
        measured_at: "2026-06-15T09:00:00.000Z",
        analysis: {
          status: "completed",
          resolved_mentions: d.brands.map((b) => ({
            entity_id: `${projectId}-${b.name}`,
            entity_type: "Brand",
            display_name: b.name,
            rollups: { product_entity_id: null, brand_entity_id: null, company_entity_id: null },
            surfaces: [b.name],
            mention_count: b.count,
            sentiment: synthSentiment(b.tone),
            avg_position: b.pos,
            type_breakdown: {
              mention: 1,
              recommendation: b.tone === "pos" ? 1 : 0,
              comparison: 0,
              definition: 0,
              final_choice: 0,
            },
          })),
        },
      };
      if (d.acr) {
        // ACR 프롬프트의 prompt-run 롤업 — 실제 scope처럼 같은 prompt-run의
        // 모든 반복 job이 동일 rows를 반복 반환한다 (mock은 셀당 job 1개).
        job.analysis!.acr_summary = {
          prompt_run_id: `${projectId}-${d.idSuffix}-${engine}-pr`,
          rows: d.acr.map((b) => ({
            rollupLevel: "brand" as const,
            entityId: `${projectId}-${b.name}`,
            plannedIterations: 10,
            validTurn1Iterations: 10,
            validAcrIterations: 10,
            appearanceCount: b.appearance,
            choiceCount: b.choice,
            conditionalChoiceCount: 0,
            appearanceRate: b.appearance / 10,
            acr: b.appearance > 0 ? b.choice / b.appearance : null,
            overallChoiceShare: b.choice / 10,
            offShortlistChoiceCount: 0,
            unresolvedChoiceCount: 0,
            genericChoiceCount: 0,
            choiceOutcomeBreakdown: { single_entity: b.choice },
          })),
        };
      }
      if (includeResult) {
        job.result = {
          answer_text: `[mock] ${d.text}`,
          measured_at: "2026-06-15T09:00:00.000Z",
          citations: d.citations.map((c, i) => ({
            url: `https://${c.host}${c.path}`,
            title: c.title,
            domain: c.host,
            host: c.host,
            refIndex: i + 1,
            category: c.category,
            subcategory: c.subcategory,
          })),
        };
      }
      jobs.push(job);
    }
  }
  return jobs;
}

export class MockScopeClient implements ScopeClient {
  private projects: Project[] = seedProjects();
  private prompts = new Map<string, Prompt[]>();

  private find(projectId: string): Project {
    const p = this.projects.find((x) => x.project_id === projectId);
    if (!p) throw new Error(`mock: project ${projectId} not found`);
    return p;
  }

  // --- projects ---

  async listProjects(_query?: PageQuery): Promise<Paginated<ProjectSummary>> {
    return { data: this.projects.map(summary), next_cursor: null };
  }
  async getProject(projectId: string): Promise<Project> {
    return this.find(projectId);
  }
  async createProject(input: CreateProjectInput): Promise<Project> {
    const now = "2026-06-01T00:00:00.000Z";
    const project: Project = {
      project_id: nextId("proj"),
      workspace_id: WORKSPACE,
      name: input.name,
      domain: input.domain,
      tracked_brands: input.tracked_brands,
      regions: input.regions,
      created_at: now,
      updated_at: now,
    };
    this.projects.push(project);
    return project;
  }
  async updateProject(projectId: string, input: UpdateProjectInput): Promise<Project> {
    const p = this.find(projectId);
    Object.assign(p, input);
    return p;
  }
  async deleteProject(projectId: string): Promise<void> {
    this.projects = this.projects.filter((x) => x.project_id !== projectId);
    this.prompts.delete(projectId);
  }

  // --- prompts ---

  async listPrompts(projectId: string, _query?: PromptsQuery): Promise<Paginated<Prompt>> {
    // Synthetic prompts (so the per-project answer-analysis promptMap resolves
    // text/funnel) merged with any created in this mock instance.
    return {
      data: [...synthPrompts(projectId), ...(this.prompts.get(projectId) ?? [])],
      next_cursor: null,
    };
  }
  async createPrompt(projectId: string, input: CreatePromptInput): Promise<Prompt> {
    this.find(projectId);
    const prompt: Prompt = {
      prompt_id: nextId("prompt"),
      project_id: projectId,
      text: input.text,
      funnel_stage: input.funnel_stage ?? null,
      keywords: input.keywords ?? [],
      kind: input.kind ?? "single",
      active: true,
      // 미전송 = null = 상속. 입력을 보존해야 mock 왕복(create → list)에서
      // 필드가 조용히 증발하지 않는다.
      lang: input.lang ?? null,
      regions: input.regions ?? null,
      created_at: "2026-06-01T00:00:00.000Z",
    };
    const list = this.prompts.get(projectId) ?? [];
    list.push(prompt);
    this.prompts.set(projectId, list);
    return prompt;
  }
  async updatePrompt(
    projectId: string,
    promptId: string,
    input: UpdatePromptInput,
  ): Promise<Prompt> {
    const list = this.prompts.get(projectId) ?? [];
    const prompt = list.find((x) => x.prompt_id === promptId);
    if (!prompt) throw new Error(`mock: prompt ${promptId} not found`);
    Object.assign(prompt, input);
    return prompt;
  }
  async deletePrompt(projectId: string, promptId: string): Promise<void> {
    const list = this.prompts.get(projectId) ?? [];
    this.prompts.set(
      projectId,
      list.filter((x) => x.prompt_id !== promptId),
    );
  }

  // --- measurement schedule (upsert; default mirrors scope's no-row GET) ---

  private schedules = new Map<string, ScheduleResponse>();

  async getSchedule(projectId: string): Promise<ScheduleResponse> {
    this.find(projectId);
    return (
      this.schedules.get(projectId) ?? {
        enabled: false,
        interval_days: 1,
        targets: [],
        regions: [],
        prompt_ids: null,
        last_run_at: null,
        last_run_status: null,
        next_run_at: null,
        created_at: null,
        updated_at: null,
      }
    );
  }
  async putSchedule(
    projectId: string,
    input: ScheduleUpdateInput,
  ): Promise<ScheduleResponse> {
    this.find(projectId);
    const now = "2026-06-01T00:00:00.000Z";
    const sched: ScheduleResponse = {
      enabled: input.enabled,
      interval_days: input.interval_days,
      targets: input.targets,
      regions: input.regions,
      prompt_ids: input.prompt_ids ?? null,
      last_run_at: null,
      last_run_status: null,
      next_run_at: input.enabled ? now : null,
      created_at: now,
      updated_at: now,
    };
    this.schedules.set(projectId, sched);
    return sched;
  }

  // --- result reads (representative sample) ---

  async getOverview(projectId: string, _windowDays?: number): Promise<ProjectOverview> {
    const p = this.find(projectId);
    return {
      project_name: p.name,
      tracked_brands: p.tracked_brands,
      regions: p.regions,
      last_measurement_at: "2026-05-21T09:12:00.000Z",
      top_brands_by_score: [
        { brand_name: p.tracked_brands[0]?.brand_name, comprehensive_score: 72.4, mention_rank: 1 },
      ],
      competitive_landscape: { tracked_brand_position: 1, top_co_mentioned: [] },
      daily_trend: [{ date: "2026-05-21", our_brand_score: 72.4 }],
    };
  }
  async listBrandScores(
    _projectId: string,
    _query?: BrandScoresQuery,
  ): Promise<Paginated<BrandScore>> {
    return {
      data: [
        {
          brand_name: "현대",
          metric_date: "2026-05-21",
          region: "KR",
          target: "chatgpt",
          presence_score: 80,
          prominence_score: 65,
          sentiment_score: 67,
          intent_score: 55,
          comprehensive_score: 72.4,
          mention_rank: 1,
          share_of_voice: 41.2,
          computed_at: "2026-05-21T10:00:00.000Z",
        },
      ],
      next_cursor: null,
    };
  }
  async listBrandMentions(
    projectId: string,
    _query?: BrandMentionsQuery,
  ): Promise<Paginated<BrandMention>> {
    // Rich synthetic rows so the per-project 답변 분석(멘션) renders through the
    // PUBLIC path (aggregateMentionsFromPublic). Deterministic per projectId.
    return { data: synthBrandMentions(projectId), next_cursor: null };
  }
  async getBrandMention(_projectId: string, brandMentionId: string): Promise<BrandMention> {
    return {
      brand_mention_id: brandMentionId,
      brand_name: "현대",
      mention_position: 1,
      mention_type: "recommendation",
      brand_sentiment: "positive",
      co_mentioned_brands: ["Toyota"],
      region: "KR",
      target: "chatgpt",
    };
  }
  async listCitations(
    projectId: string,
    _query?: CitationsQuery,
  ): Promise<Paginated<Citation>> {
    // Rich synthetic rows so the per-project 인용 분석 renders through the PUBLIC
    // path (aggregateCitationsFromPublic). Deterministic per projectId.
    return { data: synthCitations(projectId), next_cursor: null };
  }
  async listCitationsByDomain(_projectId: string): Promise<Paginated<CitationByDomain>> {
    return {
      data: [{ domain: "example.com", citation_count: 3, brand_count: 2, avg_mention_position: 1.5 }],
      next_cursor: null,
    };
  }
  async listReports(_projectId: string, _query?: PageQuery): Promise<Paginated<Report>> {
    return { data: [], next_cursor: null };
  }
  async getReport(_projectId: string, reportId: string): Promise<Report> {
    return { report_id: reportId, title: "[mock] narrative report", created_at: "2026-05-21T00:00:00.000Z" };
  }

  // --- REAL measurement-result reads (empty in mock → dashboard uses sample) ---

  async listResults(_query?: { limit?: number }): Promise<ResultsResponse> {
    return { results: [] };
  }
  async getQueryRun(jobId: string): Promise<QueryRunView> {
    // Mock has no real query runs; the standard pages short-circuit before this
    // (root is null in mock), so this only satisfies the contract.
    return { job_id: jobId, target: "chatgpt", status: "failed" };
  }
  async listMeasurementRuns(
    projectId: string,
    _query?: PageQuery,
  ): Promise<Paginated<MeasurementRunSummary>> {
    // One synthetic completed run per project so the answer-analysis aggregators
    // have a run to enumerate jobs from (live mode reads the project's real runs).
    return {
      data: [
        {
          measurement_run_id: `${projectId}${SYNTH_RUN_SUFFIX}`,
          project_id: projectId,
          trigger: "manual",
          status: "completed",
          targets: [...SYNTH_ENGINES],
          regions: ["KR", "US"],
          total_jobs: SYNTH_PROMPTS.length * SYNTH_ENGINES.length,
          started_at: "2026-06-15T08:50:00.000Z",
          completed_at: "2026-06-15T09:10:00.000Z",
        },
      ],
      next_cursor: null,
    };
  }
  async getMeasurementRun(projectId: string, runId: string): Promise<MeasurementRunSummary> {
    const page = await this.listMeasurementRuns(projectId);
    const run = page.data.find((row) => row.measurement_run_id === runId);
    if (!run) throw new Error("Measurement run not found");
    return run;
  }
  async listRunJobs(
    projectId: string,
    _runId: string,
    query?: import("./types").RunJobsQuery,
  ): Promise<Paginated<MeasurementJob>> {
    // result (answer body + citations) only when ?include=result is requested —
    // faithful to the scope contract (the citation path asks for it; mentions don't).
    return {
      data: synthJobs(projectId, query?.include?.split(",").includes("result") ?? false)
        .filter((job) => !query?.status || job.status === query.status),
      next_cursor: null,
    };
  }

  // --- workspace ---

  async getUsage(): Promise<UsageSummary> {
    return {
      workspace_id: WORKSPACE,
      billing_period: "2026-05",
      queries_used: 1280,
      queries_quota: 5000,
      cost_usd: 64.2,
      rate_limit: { per_minute: 60, per_hour: 1000 },
    };
  }
  async health(): Promise<HealthStatus> {
    return { status: "ok", version: "mock" };
  }
}
