import { describe, it, expect } from "vitest";
import { aggregateMentions, aggregateCitations } from "./result-adapter";
import type { ScopeClient } from "./client";
import type {
  MeasurementJob,
  MeasurementRunSummary,
  Prompt,
  QueryRunView,
  ResolvedMention,
} from "./types";

// Behavioral coverage for the StandardFilters wiring on the 표준 답변 분석 pages
// (mentions/citations). These aggregators take a ScopeClient directly, so we
// feed a tiny stub and assert that each filter axis narrows the rollup exactly
// like the dashboard's aggregateStandard — and that the documented gap (region
// can't narrow citations, since /results carries no region) holds.

function brandMention(name: string, count: number): ResolvedMention {
  return {
    entity_id: `e-${name}`,
    entity_type: "Brand",
    display_name: name,
    rollups: { product_entity_id: null, brand_entity_id: null, company_entity_id: null },
    surfaces: [name],
    mention_count: count,
  };
}

function job(
  id: string,
  opts: { target: string; region: string | null; promptId: string | null; brand: string; count: number },
): MeasurementJob {
  return {
    job_id: id,
    prompt_id: opts.promptId,
    target: opts.target,
    region: opts.region,
    status: "completed",
    measured_at: "2026-01-01T00:00:00Z",
    analysis: { status: "completed", resolved_mentions: [brandMention(opts.brand, opts.count)] },
  };
}

function prompt(id: string, funnel: Prompt["funnel_stage"]): Prompt {
  return {
    prompt_id: id,
    project_id: "root",
    text: `prompt ${id}`,
    funnel_stage: funnel,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function result(jobId: string, target: string, url: string): QueryRunView {
  return {
    job_id: jobId,
    target,
    status: "completed",
    result: {
      answer_text: "answer",
      citations: [{ url }],
      measured_at: "2026-01-01T00:00:00Z",
    },
  };
}

// chatgpt/US/discovery → Hyundai; gemini/KR/evaluation → Toyota.
const JOBS: MeasurementJob[] = [
  job("j-cg", { target: "chatgpt", region: "US", promptId: "p-disc", brand: "Hyundai", count: 3 }),
  job("j-gm", { target: "gemini", region: "KR", promptId: "p-eval", brand: "Toyota", count: 2 }),
];
const PROMPTS: Prompt[] = [prompt("p-disc", "discovery"), prompt("p-eval", "evaluation")];
const RESULTS: QueryRunView[] = [
  result("j-cg", "chatgpt", "https://www.hyundai.com/ioniq"),
  result("j-gm", "gemini", "https://www.toyota.com/prius"),
];

// A project with no measurement runs at all → fetchAllJobs/listResults empty.
function makeEmptyClient(): ScopeClient {
  return {
    listMeasurementRuns: async () => ({ data: [] }),
    listRunJobs: async () => ({ data: [] }),
    listPrompts: async () => ({ data: [] }),
    listResults: async () => ({ results: [] }),
  } as unknown as ScopeClient;
}

function makeClient(): ScopeClient {
  const runs: MeasurementRunSummary[] = [
    {
      measurement_run_id: "run-1",
      project_id: "root",
      trigger: "manual",
      status: "completed",
      targets: ["chatgpt", "gemini"],
      regions: ["US", "KR"],
      total_jobs: JOBS.length,
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T01:00:00Z",
    },
  ];
  return {
    listMeasurementRuns: async () => ({ data: runs }),
    listRunJobs: async () => ({ data: JOBS }),
    listPrompts: async () => ({ data: PROMPTS }),
    listResults: async () => ({ results: RESULTS }),
  } as unknown as ScopeClient;
}

function brandNames(m: Awaited<ReturnType<typeof aggregateMentions>>): string[] {
  return (m?.brands ?? []).map((b) => b.brand).sort();
}
function domainNames(c: Awaited<ReturnType<typeof aggregateCitations>>): string[] {
  return (c?.domains ?? []).map((d) => d.domain).sort();
}

describe("aggregateMentions — StandardFilters", () => {
  it("no filter → both brands", async () => {
    const m = await aggregateMentions(makeClient(), "root");
    expect(brandNames(m)).toEqual(["Hyundai", "Toyota"]);
    expect(m?.summary.total).toBe(5);
  });

  it("engine narrows by job.target", async () => {
    const m = await aggregateMentions(makeClient(), "root", { engine: ["chatgpt"] });
    expect(brandNames(m)).toEqual(["Hyundai"]);
    expect(m?.summary.total).toBe(3);
  });

  it("geography narrows by job.region", async () => {
    const m = await aggregateMentions(makeClient(), "root", { region: ["KR"] });
    expect(brandNames(m)).toEqual(["Toyota"]);
  });

  it("multi-select within an axis is OR (engine [chatgpt,gemini] → both)", async () => {
    const m = await aggregateMentions(makeClient(), "root", {
      engine: ["chatgpt", "gemini"],
    });
    expect(brandNames(m)).toEqual(["Hyundai", "Toyota"]);
    expect(m?.summary.total).toBe(5);
  });

  it("axes combine with AND (engine chatgpt + region KR → empty)", async () => {
    const m = await aggregateMentions(makeClient(), "root", {
      engine: ["chatgpt"],
      region: ["KR"],
    });
    expect(brandNames(m)).toEqual([]);
  });

  it("funnelStage narrows by prompt.funnel_stage", async () => {
    const m = await aggregateMentions(makeClient(), "root", { funnelStage: ["discovery"] });
    expect(brandNames(m)).toEqual(["Hyundai"]);
  });

  it("filter matching nothing → empty (NOT null) so the panel stays mounted", async () => {
    const m = await aggregateMentions(makeClient(), "root", { engine: ["perplexity"] });
    expect(m).not.toBeNull();
    expect(m?.brands).toEqual([]);
    expect(m?.summary).toEqual({ total: 0, uniqueBrands: 0, totalPrompts: 0 });
  });

  it("genuinely empty project (no analyzed jobs) → null", async () => {
    expect(await aggregateMentions(makeEmptyClient(), "root")).toBeNull();
  });
});

describe("aggregateCitations — StandardFilters", () => {
  it("no filter → both domains", async () => {
    const c = await aggregateCitations(makeClient(), "root");
    expect(domainNames(c)).toEqual(["hyundai.com", "toyota.com"]);
  });

  it("engine narrows by result.target", async () => {
    const c = await aggregateCitations(makeClient(), "root", { engine: ["chatgpt"] });
    expect(domainNames(c)).toEqual(["hyundai.com"]);
  });

  it("funnelStage narrows via job_id → prompt join", async () => {
    const c = await aggregateCitations(makeClient(), "root", { funnelStage: ["discovery"] });
    expect(domainNames(c)).toEqual(["hyundai.com"]);
  });

  it("region narrows citations via each result's job (mirror jobs carry region)", async () => {
    // US → only j-cg (Hyundai/chatgpt); j-gm is KR so toyota.com drops out.
    const c = await aggregateCitations(makeClient(), "root", { region: ["US"] });
    expect(domainNames(c)).toEqual(["hyundai.com"]);
  });

  it("domain promptList carries citing prompts + answer refs (the prompt drilldown)", async () => {
    const c = await aggregateCitations(makeClient(), "root", {});
    const hy = c?.domains.find((d) => d.domain === "hyundai.com");
    expect(hy?.promptList.length).toBe(1);
    const p = hy?.promptList[0];
    expect(p?.id).toBe("p-disc");
    expect(p?.promptText).toBe("prompt p-disc");
    // each prompt row opens the answer modal by its job_id refs
    expect(p?.answers.map((a) => a.jobId)).toEqual(["j-cg"]);
  });

  it("filter matching nothing → empty (NOT null) so the panel stays mounted", async () => {
    const c = await aggregateCitations(makeClient(), "root", { engine: ["perplexity"] });
    expect(c).not.toBeNull();
    expect(c?.domains).toEqual([]);
    expect(c?.summary).toEqual({ total: 0, uniqueDomains: 0 });
  });

  it("genuinely citation-less project → null", async () => {
    expect(await aggregateCitations(makeEmptyClient(), "root")).toBeNull();
  });
});
