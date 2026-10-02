import { beforeEach, describe, expect, it, vi } from "vitest";

// Batch methods backing the /projects list page (N+1 removal, 2026-07-22):
//   projectRepository.getNamesByIds
//   projectMemberRepository.getRolesForProjects / countActiveMembersByProject
//   promptRepository.countByProject
//
// These tests mock getDb with a chainable-thenable stub — no real SQL runs.
// What they pin down is the repository-side contract the page relies on:
//   1. empty-id guard: inArray([]) is invalid SQL, so [] must short-circuit
//      BEFORE touching the DB;
//   2. count(*) normalisation: postgres-js returns bigint counts as strings —
//      the repository must hand callers real numbers (sums on the page);
//   3. missing-schema fallback: project_members methods return [] on
//      42P01/42703 like their per-project siblings (migration-0002 safety).

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db";
import { projectRepository } from "./projects";
import { projectMemberRepository } from "./project-members";
import { promptRepository } from "./prompts";

type Row = Record<string, unknown>;

// Minimal drizzle-shaped stub: every builder method returns the chain, and
// awaiting the chain resolves to `rows` (or rejects with `error`).
function stubDb(outcome: { rows?: Row[]; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "select",
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "groupBy",
    "orderBy",
    "limit",
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (
    onFulfilled?: (v: Row[]) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) =>
    (outcome.error !== undefined
      ? Promise.reject(outcome.error)
      : Promise.resolve(outcome.rows ?? [])
    ).then(onFulfilled, onRejected);
  return chain;
}

function useDb(outcome: { rows?: Row[]; error?: unknown }) {
  vi.mocked(getDb).mockReturnValue(stubDb(outcome) as never);
}

const missingSchemaError = () =>
  Object.assign(new Error('relation "project_members" does not exist'), {
    code: "42P01",
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("projectRepository.getNamesByIds", () => {
  it("returns [] for empty ids without touching the DB", async () => {
    await expect(projectRepository.getNamesByIds([])).resolves.toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("resolves names via a single query", async () => {
    useDb({
      rows: [
        { id: "p1", name: "Ioniq Launch" },
        { id: "p2", name: "Kia EV" },
      ],
    });
    const rows = await projectRepository.getNamesByIds(["p1", "p2", "gone"]);
    expect(rows).toEqual([
      { id: "p1", name: "Ioniq Launch" },
      { id: "p2", name: "Kia EV" },
    ]);
    expect(getDb).toHaveBeenCalledTimes(1);
  });
});

describe("projectMemberRepository.getRolesForProjects", () => {
  it("returns [] for empty projectIds without touching the DB", async () => {
    await expect(
      projectMemberRepository.getRolesForProjects("u1", []),
    ).resolves.toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("returns (projectId, role) pairs from a single query", async () => {
    useDb({
      rows: [
        { projectId: "p1", role: "owner" },
        { projectId: "p2", role: "viewer" },
      ],
    });
    const rows = await projectMemberRepository.getRolesForProjects("u1", [
      "p1",
      "p2",
      "p3", // no membership → absent, caller defaults to viewer
    ]);
    expect(rows).toEqual([
      { projectId: "p1", role: "owner" },
      { projectId: "p2", role: "viewer" },
    ]);
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it("falls back to [] when the project_members schema is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useDb({ error: missingSchemaError() });
    await expect(
      projectMemberRepository.getRolesForProjects("u1", ["p1"]),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rethrows non-schema errors", async () => {
    useDb({ error: new Error("connection refused") });
    await expect(
      projectMemberRepository.getRolesForProjects("u1", ["p1"]),
    ).rejects.toThrow("connection refused");
  });
});

describe("projectMemberRepository.countActiveMembersByProject", () => {
  it("returns [] for empty projectIds without touching the DB", async () => {
    await expect(
      projectMemberRepository.countActiveMembersByProject([]),
    ).resolves.toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("normalises bigint string counts to numbers", async () => {
    useDb({
      rows: [
        { projectId: "p1", activeMembers: "3" }, // postgres-js bigint → string
        { projectId: "p2", activeMembers: "1" },
      ],
    });
    const rows = await projectMemberRepository.countActiveMembersByProject([
      "p1",
      "p2",
    ]);
    expect(rows).toEqual([
      { projectId: "p1", activeMembers: 3 },
      { projectId: "p2", activeMembers: 1 },
    ]);
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it("falls back to [] when the project_members schema is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useDb({ error: missingSchemaError() });
    await expect(
      projectMemberRepository.countActiveMembersByProject(["p1"]),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("promptRepository.countByProject", () => {
  it("returns [] for empty projectIds without touching the DB", async () => {
    await expect(promptRepository.countByProject([])).resolves.toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("normalises bigint string counts (total + queuedOrRunning) to numbers", async () => {
    useDb({
      rows: [
        { projectId: "p1", total: "12", queuedOrRunning: "4" },
        { projectId: "p2", total: "0", queuedOrRunning: "0" },
      ],
    });
    const rows = await promptRepository.countByProject(["p1", "p2"]);
    expect(rows).toEqual([
      { projectId: "p1", total: 12, queuedOrRunning: 4 },
      { projectId: "p2", total: 0, queuedOrRunning: 0 },
    ]);
    expect(getDb).toHaveBeenCalledTimes(1);
  });
});
