import { describe, expect, it } from "vitest";
import { acrRollupRows, dedupeAcrIterationJobs, slimJobForFold } from "./sync";
import {
  BulkSourceChangedError,
  addPlanPage,
  emptyBulkPlan,
  finalizeBulkPlan,
  fingerprintJobs,
  verifyWritePage,
} from "./bulk-plan";
import type { MeasurementJob, Paginated } from "@/lib/scope/types";

const RUN_ID = "run-1";
const row = (entityId: string) => ({
  rollupLevel: "product" as const,
  entityId,
  plannedIterations: 3,
  validTurn1Iterations: 3,
  validAcrIterations: 3,
  appearanceCount: 2,
  choiceCount: 1,
  conditionalChoiceCount: 0,
  appearanceRate: 0.66,
  acr: 0.33,
  overallChoiceShare: 0.33,
  offShortlistChoiceCount: 0,
  unresolvedChoiceCount: 0,
  genericChoiceCount: 0,
});

function job(id: string, patch: Partial<MeasurementJob> = {}): MeasurementJob {
  return {
    job_id: id,
    prompt_id: "prompt-1",
    target: "chatgpt",
    region: "KR",
    status: "completed",
    measured_at: "2026-09-15T00:00:00.000Z",
    ...patch,
  };
}

function acrJob(
  id: string,
  status: string,
  measuredAt: string,
  entityId = "entity-1",
): MeasurementJob {
  return job(id, {
    status,
    measured_at: measuredAt,
    analysis: {
      status: "completed",
      acr_summary: { prompt_run_id: "prompt-run-1", rows: [row(entityId)] },
    },
  });
}

function page(
  data: MeasurementJob[],
  next_cursor: string | null,
): Paginated<MeasurementJob> {
  return { data, next_cursor };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

describe("bulk mirror plan", () => {
  it("collects distributed ACR siblings and matches full collect+dedupe", () => {
    const first = [acrJob("failed-first", "failed", "2026-09-15T00:00:01Z")];
    const second = [
      acrJob("completed-a", "completed", "2026-09-15T00:00:02Z"),
      acrJob("completed-tie", "completed", "2026-09-15T00:00:02Z"),
    ];
    const third = [
      job("name-later", {
        prompt_id: "prompt-2",
        analysis: {
          status: "completed",
          resolved_mentions: [
            {
              entity_id: "entity-1",
              display_name: "Late Name",
              entity_type: "brand",
              rollups: {
                product_entity_id: null,
                brand_entity_id: "entity-1",
                company_entity_id: null,
              },
              surfaces: [],
              mention_count: 1,
            },
          ],
        },
      }),
    ];
    const all = [...first, ...second, ...third];
    let plan = emptyBulkPlan();
    plan = addPlanPage(plan, page(first, "c1"), null);
    plan = addPlanPage(plan, page(second, "c2"), "c1");
    plan = addPlanPage(plan, page(third, null), "c2");

    const out = finalizeBulkPlan(plan, all.length, RUN_ID);
    expect(out.selectedJobIds).toEqual(
      dedupeAcrIterationJobs(all).map((j) => j.job_id),
    );
    expect(out.acrRollups).toEqual(
      acrRollupRows(new Map(plan.snapshots), new Map(plan.names), RUN_ID),
    );
    expect(out.acrRollups[0]).toMatchObject({ brand: "Late Name" });
    expect(
      out.selectedJobIds.filter((id) =>
        ["failed-first", "completed-a", "completed-tie"].includes(id),
      ),
    ).toHaveLength(1);
    expect(out.selectedJobIds).not.toContain("failed-first");
    expect(plan.jobs).toEqual(all.map(slimJobForFold));
  });

  it("survives JSON serialization and resumes with the same result", () => {
    const original = addPlanPage(
      emptyBulkPlan(),
      page([job("a"), job("b")], null),
      null,
    );
    const restored = JSON.parse(JSON.stringify(original));
    expect(finalizeBulkPlan(restored, 2, RUN_ID)).toEqual(
      finalizeBulkPlan(original, 2, RUN_ID),
    );
  });

  it("finalizes an explicitly known zero-job run", () => {
    expect(finalizeBulkPlan(emptyBulkPlan(), 0, RUN_ID)).toEqual({
      selectedJobIds: [],
      acrRollups: [],
    });
  });

  it("does not mutate a frozen plan or page while adding a page", () => {
    const seeded = addPlanPage(
      emptyBulkPlan(),
      page([acrJob("seed", "completed", "2026-09-15T00:00:00Z")], "c1"),
      null,
    );
    const before = JSON.stringify(seeded);
    const original = deepFreeze(seeded);
    const input = deepFreeze(page([job("a")], null));
    const next = addPlanPage(original, input, "c1");
    expect(JSON.stringify(original)).toBe(before);
    expect(input.data[0].job_id).toBe("a");
    expect(next.pages).toHaveLength(2);
    expect(next.jobs.map((j) => j.job_id)).toEqual(["seed", "a"]);
  });

  it("rejects duplicate IDs, non-forward cursors, empty continuation, and count drift", () => {
    const first = addPlanPage(emptyBulkPlan(), page([job("a")], "c1"), null);
    expect(() => addPlanPage(first, page([job("a")], null), "c1")).toThrow(
      BulkSourceChangedError,
    );
    expect(() => addPlanPage(first, page([], "c2"), "c1")).toThrow(
      BulkSourceChangedError,
    );
    const second = addPlanPage(first, page([job("b")], "c2"), "c1");
    expect(() => addPlanPage(second, page([job("c")], "c1"), "c2")).toThrow(
      BulkSourceChangedError,
    );
    expect(() => finalizeBulkPlan(second, 3, RUN_ID)).toThrow(
      BulkSourceChangedError,
    );
  });

  it("rejects missing pages and planning metadata changes during the write pass", () => {
    const plan = addPlanPage(
      emptyBulkPlan(),
      page([job("a"), job("b")], null),
      null,
    );
    expect(() => verifyWritePage(plan, 1, page([], null))).toThrow(
      BulkSourceChangedError,
    );
    expect(() =>
      verifyWritePage(plan, 0, page([job("b"), job("a")], null)),
    ).toThrow(BulkSourceChangedError);
    expect(() =>
      verifyWritePage(
        plan,
        0,
        page([job("a", { status: "failed" }), job("b")], null),
      ),
    ).toThrow(BulkSourceChangedError);
    expect(() =>
      verifyWritePage(
        plan,
        0,
        page(
          [
            job("a", {
              result: {
                answer_text: "changed",
                citations: [],
                measured_at: "now",
              },
            }),
            job("b"),
          ],
          null,
        ),
      ),
    ).not.toThrow();
  });

  it("fingerprints analysis metadata without claiming result/occurrence stability", () => {
    const base = job("a", {
      result: { answer_text: "before", citations: [], measured_at: "now" },
      analysis: {
        status: "completed",
        resolved_mentions: [
          {
            entity_id: "e",
            display_name: "E",
            entity_type: "brand",
            rollups: {
              product_entity_id: null,
              brand_entity_id: "e",
              company_entity_id: null,
            },
            surfaces: [],
            mention_count: 1,
            occurrences: [
              {
                source_start: 1,
                source_end: 2,
                surface_text: "x",
                sentiment: "positive",
                mention_role: null,
                assertion: null,
                context_snippet: null,
                descriptors: [],
                criteria: [],
                turn_index: null,
              },
            ],
          },
        ],
      },
    });
    const changedAnswer = {
      ...base,
      result: { ...base.result!, answer_text: "after" },
    };
    const changedOccurrence = {
      ...base,
      analysis: {
        ...base.analysis!,
        resolved_mentions: [
          {
            ...base.analysis!.resolved_mentions![0],
            occurrences: [
              {
                source_start: 9,
                source_end: 10,
                surface_text: "y",
                sentiment: "positive",
                mention_role: null,
                assertion: null,
                context_snippet: null,
                descriptors: [],
                criteria: [],
                turn_index: null,
              },
            ],
          },
        ],
      },
    };
    expect(fingerprintJobs([base])).toBe(fingerprintJobs([changedAnswer]));
    expect(fingerprintJobs([base])).toBe(fingerprintJobs([changedOccurrence]));
  });
});
