import { describe, expect, it } from "vitest";
import { formatRows, missingRequestedRunIds, parseCliArgs, parseSnapshot, planAnchorAudit } from "./anchor-audit";

const base = {
  workspaceId: "w1",
  snapshotConsistencyId: "snap-1",
  parents: [{ runId: "r1", workspaceId: "w1", projectId: "p1", cycleAnchorAt: "2026-09-14T00:00:44.507123Z", startedAt: "2026-09-14T01:50:57.504Z", sourceRevision: "v1", snapshotId: "snap-1", expectedChildCount: 1 }],
  children: [{ runId: "r1", childId: "q1", workspaceId: "w1", projectId: "p1", cycleAnchorAt: "2026-09-14T00:00:44.507999Z", status: "completed", ticketStatus: null, sourceRevision: "v1", snapshotId: "snap-1" }],
  mirrors: [{ runId: "r1", projectId: "p1", cycleAnchorAt: "2026-09-14T00:00:44.507Z", status: "completed", syncedAt: "2026-09-15T15:59:00Z", sourceRevision: "v1", snapshotId: "snap-1", completenessVerified: true, diagnosticEvidenceId: "diag-1" }],
  cycles: [{ runId: "r1", cycleId: "c1", projectId: "p1", cycleAnchorAt: "2026-09-14T00:00:44.507Z", status: "open", viewAnchorAt: null, activeGenerationId: null, generationStatus: null, sourceRevision: "v1", snapshotId: "snap-1" }],
};

describe("planAnchorAudit", () => {
  it("treats sub-millisecond values as the same API millisecond", () => {
    expect(planAnchorAudit(base)[0]).toMatchObject({ decision: "MATCH", parentAnchorMs: "2026-09-14T00:00:44.507Z" });
  });

  it("blocks mixed child anchors", () => {
    const input = { ...base, children: [...base.children, { ...base.children[0], childId: "q2", cycleAnchorAt: "2026-09-15T00:00:00.000Z" }] };
    expect(planAnchorAudit(input)[0]).toMatchObject({ decision: "BLOCK", reasons: expect.arrayContaining(["MIXED_CHILD_ANCHORS"]) });
  });

  it("blocks an empty child set and null parent", () => {
    const input = { ...base, parents: [{ ...base.parents[0], cycleAnchorAt: null }], children: [] };
    expect(planAnchorAudit(input)[0]).toMatchObject({ decision: "BLOCK", reasons: expect.arrayContaining(["EMPTY_CHILD_ROWS", "NULL_PARENT_ANCHOR"]) });
  });

  it("recommends a unanimous child anchor only when the parent is non-null", () => {
    const input = { ...base, parents: [{ ...base.parents[0], cycleAnchorAt: "2026-09-13T00:00:00.000Z" }], children: [{ ...base.children[0], cycleAnchorAt: "2026-09-14T00:00:44.507Z" }], cycles: [{ ...base.cycles[0], cycleAnchorAt: "2026-09-14T00:00:44.507Z" }] };
    expect(planAnchorAudit(input)[0]).toMatchObject({ decision: "RECOMMEND_PARENT_ANCHOR", recommendedAnchorAt: "2026-09-14T00:00:44.507Z" });
  });

  it("blocks generated membership before recommending a parent change", () => {
    const input = { ...base, parents: [{ ...base.parents[0], cycleAnchorAt: "2026-09-13T00:00:00.000Z" }], cycles: [{ ...base.cycles[0], cycleAnchorAt: "2026-09-14T00:00:44.507Z", status: "published", activeGenerationId: "g1" }] };
    expect(planAnchorAudit(input)[0]).toMatchObject({ decision: "BLOCK", reasons: expect.arrayContaining(["GENERATED_OR_CLOSED_CYCLE", "STALE_OR_ACTIVE_GENERATION"]) });
  });

  it("blocks mutable children, archived parents, and snapshot drift", () => {
    const input = { ...base, parents: [{ ...base.parents[0], archivedAt: "2026-09-15T00:00:00Z" }], children: [{ ...base.children[0], status: "running", snapshotId: "snap-2" }] };
    expect(planAnchorAudit(input)[0]).toMatchObject({ decision: "BLOCK", reasons: expect.arrayContaining(["PARENT_ARCHIVED_OR_DELETED", "MUTABLE_CHILD_STATUS", "SNAPSHOT_CONSISTENCY_MISMATCH"]) });
  });

  it("blocks mirror conflict and cycle membership conflict", () => {
    const input = { ...base, parents: [{ ...base.parents[0], cycleAnchorAt: "2026-09-13T00:00:00.000Z" }], mirrors: [{ ...base.mirrors[0], cycleAnchorAt: "2026-09-12T00:00:00.000Z" }], cycles: [{ ...base.cycles[0], cycleAnchorAt: "2026-09-13T00:00:00.000Z" }] };
    expect(planAnchorAudit(input)[0]).toMatchObject({ decision: "BLOCK", reasons: expect.arrayContaining(["MIRROR_CONFLICT", "CYCLE_ANCHOR_CONFLICT"]) });
  });

  it("blocks missing or duplicate mirror rows and invalid cycle anchors", () => {
    const noMirror = { ...base, mirrors: [] };
    expect(planAnchorAudit(noMirror)[0].reasons).toEqual(expect.arrayContaining(["MISSING_MIRROR_ROW"]));
    const duplicate = { ...base, mirrors: [...base.mirrors, { ...base.mirrors[0] }] };
    expect(planAnchorAudit(duplicate)[0].reasons).toEqual(expect.arrayContaining(["DUPLICATE_MIRROR_ROWS"]));
    const invalidCycle = { ...base, cycles: [{ ...base.cycles[0], cycleAnchorAt: "2026-02-30T00:00:00Z" }] };
    expect(planAnchorAudit(invalidCycle)[0].reasons).toEqual(expect.arrayContaining(["INVALID_CYCLE_ANCHOR"]));
  });

  it("blocks incomplete status/identity observations and duplicate parents", () => {
    const incomplete = {
      ...base,
      parents: [{ ...base.parents[0], startedAt: null }, { ...base.parents[0] }],
      children: [{ ...base.children[0], status: null, snapshotId: null }],
      cycles: [{ ...base.cycles[0], status: null, snapshotId: null }],
    };
    const row = planAnchorAudit(incomplete)[0];
    expect(row).toMatchObject({ decision: "BLOCK", reasons: expect.arrayContaining([
      "DUPLICATE_PARENT_RUN_ID", "MISSING_PARENT_STARTED_AT", "MISSING_OR_INVALID_CHILD_STATUS",
      "CHILD_SNAPSHOT_ID_MISSING", "MISSING_OR_INVALID_CYCLE_STATUS", "CYCLE_SNAPSHOT_ID_MISSING",
    ]) });
  });

  it("blocks omitted nullable observations while accepting explicit null", () => {
    const omitted = JSON.parse(JSON.stringify(base));
    delete omitted.children[0].ticketStatus;
    delete omitted.cycles[0].viewAnchorAt;
    delete omitted.cycles[0].activeGenerationId;
    delete omitted.cycles[0].generationStatus;
    const row = planAnchorAudit(omitted)[0];
    expect(row).toMatchObject({ decision: "BLOCK", reasons: expect.arrayContaining([
      "CHILD_TICKET_STATUS_OBSERVATION_MISSING", "CYCLE_GENERATION_OBSERVATION_MISSING",
    ]) });
    expect(planAnchorAudit(base)[0].decision).toBe("MATCH");
  });

  it("requires every row snapshot id even when a top-level id exists", () => {
    const input = { ...base, mirrors: [{ ...base.mirrors[0], snapshotId: null }] };
    expect(planAnchorAudit(input)[0].reasons).toEqual(expect.arrayContaining(["MIRROR_SNAPSHOT_ID_MISSING"]));
  });

  it("blocks unrecognized ticket/generation states and a nonterminal mirror", () => {
    expect(planAnchorAudit({ ...base, children: [{ ...base.children[0], ticketStatus: "unknown" }] })[0].decision).toBe("BLOCK");
    expect(planAnchorAudit({ ...base, cycles: [{ ...base.cycles[0], generationStatus: "unknown" }] })[0].decision).toBe("BLOCK");
    expect(planAnchorAudit({ ...base, mirrors: [{ ...base.mirrors[0], status: "running" }] })[0].decision).toBe("BLOCK");
  });

  it("parses options independent of positional order and rejects unknown or invalid options", () => {
    expect(parseCliArgs(["--format", "csv", "snapshot.json", "--run-id", "r1"])).toMatchObject({ path: "snapshot.json", format: "csv", runIds: ["r1"] });
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(() => parseCliArgs(["snapshot.json", "--unknown"])).toThrow(/unknown option/);
    expect(() => parseCliArgs(["snapshot.json", "--format"])).toThrow(/requires a value/);
    expect(() => parseCliArgs(["snapshot.json", "--observed-after", "2026-09-15T00:00:00"])).toThrow(/timezone/);
  });

  it("auto-detects JSON input while allowing CSV output", () => {
    const json = JSON.stringify(base);
    const rows = planAnchorAudit(parseSnapshot(json));
    expect(formatRows(rows, parseCliArgs(["--format", "csv", "snapshot.json"]).format)).toContain("run_id,decision");
  });

  it("rejects an unrecognized CSV boolean instead of treating it as false", () => {
    const csv = [
      "kind,run_id,mirror_status,completeness_verified",
      "mirror,r1,completed,maybe",
    ].join("\n");
    expect(() => parseSnapshot(csv, "csv")).toThrow(/invalid boolean/);
  });

  it("requires nullable observation headers in CSV and preserves blank cells as null", () => {
    expect(() => parseSnapshot("kind,run_id,child_status,ticket_status\nchild,r1,completed", "csv")).toThrow(/field count/);
    expect(() => parseSnapshot([
      "kind,run_id,child_status",
      "child,r1,completed",
    ].join("\n"), "csv")).toThrow(/child\.ticket_status/);
    expect(() => parseSnapshot([
      "kind,run_id,cycle_status",
      "cycle,r1,open",
    ].join("\n"), "csv")).toThrow(/cycle\.view_anchor_at/);
    const parsed = parseSnapshot([
      "kind,run_id,child_status,ticket_status",
      "child,r1,completed,",
    ].join("\n"), "csv");
    expect(parsed.children[0]).toHaveProperty("ticketStatus", null);
  });

  it("parses the documented compact CSV and emits metadata-only CSV", () => {
    const csv = [
      "kind,workspace_id,run_id,project_id,parent_anchor_at,started_at,expected_child_count,child_id,child_anchor_at,child_status,cycle_id,cycle_status,cycle_anchor_at,mirror_anchor_at,mirror_status,completeness_verified,diagnostic_evidence_id,snapshot_id,ticket_status,view_anchor_at,active_generation_id,generation_status",
      ["parent", "w1", "r1", "p1", "2026-09-14T00:00:44.507Z", "2026-09-14T01:50:57.504Z", "1", "", "", "", "", "", "", "", "", "", "", "snap-1", "", "", "", ""].join(","),
      ["child", "w1", "r1", "p1", "", "", "1", "q1", "2026-09-14T00:00:44.507Z", "completed", "", "", "", "", "", "", "", "snap-1", "", "", "", ""].join(","),
      ["cycle", "w1", "r1", "p1", "", "", "", "", "", "", "c1", "open", "2026-09-14T00:00:44.507Z", "", "", "", "", "snap-1", "", "", "", ""].join(","),
      ["mirror", "w1", "r1", "p1", "", "", "", "", "", "", "", "", "", "2026-09-14T00:00:44.507Z", "completed", "true", "diag-1", "snap-1", "", "", "", ""].join(","),
    ].join("\n");
    const rows = planAnchorAudit(parseSnapshot(csv, "csv"));
    expect(rows[0].decision).toBe("MATCH");
    expect(formatRows(rows, "csv")).toContain("run_id,decision");
    expect(formatRows(rows, "csv")).not.toContain("answer_text");
  });

  it("does not turn a missing requested run into a successful empty audit", () => {
    expect(missingRequestedRunIds([], ["missing-run"])).toEqual(["missing-run"]);
  });

  it("blocks mirror completeness when neither an explicit verification nor evidence exists", () => {
    const input = { ...base, mirrors: [{ ...base.mirrors[0], completenessVerified: null, diagnosticEvidenceId: null }] };
    expect(planAnchorAudit(input)[0].reasons).toEqual(expect.arrayContaining(["MIRROR_COMPLETENESS_UNKNOWN"]));
  });
});
