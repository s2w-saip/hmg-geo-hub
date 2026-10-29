import { describe, expect, it } from "vitest";
import type { MirrorSyncResult } from "@/lib/scope/mirror/sync";
import { localResyncReport, parseLocalResyncOptions } from "./local-resync-options";

const since = "2026-09-13T15:00:00Z";
const until = "2026-09-13T16:00:00Z";
const now = new Date("2026-09-15T00:00:00Z");
const project = "be28fe15-c743-4a88-abb8-182b25602812";

export function completeResult(): MirrorSyncResult {
  return {
    runs: 50, answers: 100, skipped: 0, resyncSkipped: 0, recheckCapHits: [],
    usedFallback: false, catalogUpdated: 0, deferred: 0, pageCapHits: [],
    oversizedRuns: [], truncatedRuns: [], budgetStoppedProjects: [],
    projectIdsNotFound: [], perProject: [], runLimitHits: [],
  };
}

describe("local resync argument contract", () => {
  it("accepts a larger bounded pass and a stable campaign cutoff for restart", () => {
    const first = parseLocalResyncOptions([since, until, project, "--max-runs", "400"], {}, now);
    expect(first.maxRuns).toBe(400);
    expect(first.resyncBefore).toEqual(now);
    const next = parseLocalResyncOptions([since, until, project, `--resync-before=${first.resyncBefore.toISOString()}`], {}, new Date(now.getTime() + 60_000));
    expect(next.resyncBefore).toEqual(first.resyncBefore);
    expect(next.projectIds).toEqual([project]);
  });

  it("honors env options and gives explicit flags precedence", () => {
    const env = { MIRROR_RESYNC_MAX_RUNS: "200", MIRROR_LOCAL_BUDGET_MS: "3600000" };
    expect(parseLocalResyncOptions([since, until], env, now)).toMatchObject({ maxRuns: 200, budgetMs: 3600000 });
    expect(parseLocalResyncOptions([since, until, "--max-runs=400"], env, now).maxRuns).toBe(400);
  });

  it.each(["0", "-1", "NaN", "Infinity", "1.5", "9007199254740992", ""])("rejects invalid maxRuns=%s before any sync", (value) => {
    expect(() => parseLocalResyncOptions([since, until], { MIRROR_RESYNC_MAX_RUNS: value }, now)).toThrow();
  });

  it.each([[until, since], [since, since], ["2026-09-13T15:00:00", until], [since, until, "not-a-uuid"], [since, until, "--unknown"], [since, until, "--max-runs"], [since, until, "--max-runs=5", "--max-runs=6"]])("rejects invalid arguments %j", (...args) => {
    expect(() => parseLocalResyncOptions(args, {}, now)).toThrow();
  });

  it("rejects a future cutoff and invalid local budget", () => {
    expect(() => parseLocalResyncOptions([since, until, "--resync-before=2099-01-01T00:00:00Z"], {}, now)).toThrow("future");
    expect(() => parseLocalResyncOptions([since, until], { MIRROR_LOCAL_BUDGET_MS: "0" }, now)).toThrow();
  });

  it.each(["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-09-13T24:00:00Z"])("rejects silently normalized timestamps: %s", (value) => {
    expect(() => parseLocalResyncOptions([value, until], {}, now)).toThrow("calendar");
    expect(() => parseLocalResyncOptions([since, until, "--resync-before", value], {}, now)).toThrow("calendar");
  });

  it("accepts leap days and preserves explicit timezone instants", () => {
    expect(parseLocalResyncOptions(["2024-02-29T09:00:00+09:00", until], {}, now).runsSince.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("passes an explicit prompt update window without silently narrowing it", () => {
    const options = parseLocalResyncOptions([since, until, "--prompts-updated-from", since, "--prompts-updated-to", until], {}, now);
    expect(options.promptsUpdatedFrom).toBe(new Date(since).toISOString());
    expect(options.promptsUpdatedTo).toBe(new Date(until).toISOString());
    expect(() => parseLocalResyncOptions([since, until, "--prompts-updated-from", until, "--prompts-updated-to", since], {}, now)).toThrow();
  });
});

describe("local resync completeness", () => {
  it("accepts an exactly full pass when no eligible run remains", () => {
    expect(localResyncReport(completeResult(), now)).toMatchObject({ complete: true, exitCode: 0, runs: 50 });
  });

  it.each([
    { budgetStoppedProjects: [project] },
    { perProject: [{ projectId: project, error: "failed" }] },
    { runLimitHits: [{ projectId: project, nextRunId: "next-run" }] },
    { deferred: 1 },
    { pageCapHits: [{ projectId: project, kind: "runs" }] },
    { oversizedRuns: [{ projectId: project, runId: "big", totalJobs: 66144 }] },
    { truncatedRuns: [{ projectId: project, runId: "partial" }] },
    { projectIdsNotFound: [project] },
    { recheckCapHits: [project] },
  ])("fails a partial pass: %j", (patch) => {
    expect(localResyncReport({ ...completeResult(), ...patch }, now)).toMatchObject({ complete: false, exitCode: 3 });
  });
});
