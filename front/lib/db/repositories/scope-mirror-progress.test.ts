import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeMirrorProgressRow } from "@/lib/db/schema";

const h = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: h.getDb }));

const PROJECT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

function chain<T>(value: T) {
  const result = Promise.resolve(value) as Promise<T> & Record<string, (...args: never[]) => unknown>;
  result.from = () => result;
  result.where = () => result;
  result.limit = () => result;
  result.orderBy = () => result;
  result.for = () => result;
  return result;
}

function row(patch: Partial<ScopeMirrorProgressRow> = {}): ScopeMirrorProgressRow {
  return {
    projectId: PROJECT,
    runId: RUN,
    phase: "plan",
    cursor: null,
    state: {},
    revision: 0,
    createdAt: new Date("2026-09-15T00:00:00Z"),
    updatedAt: new Date("2026-09-15T00:00:00Z"),
    lastError: null,
    ...patch,
  };
}

function fakeDb(current: ScopeMirrorProgressRow | null, inserted: ScopeMirrorProgressRow[] = []) {
  const writes: string[] = [];
  const tx = {
    execute: vi.fn(async () => { writes.push("lock"); return []; }),
    select: vi.fn(() => chain(current ? [current] : [])),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(async () => inserted) })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: unknown) => {
        // Drizzle SQL expressions are circular table metadata; the unit fake
        // only needs to record that an update was issued.
        void patch;
        writes.push("update");
        return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...current!, ...patch }]) })) };
      }),
    })),
  };
  const db = {
    execute: vi.fn(async () => [{ table_name: "scope_mirror_progress" }]),
    transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
    insert: tx.insert,
    select: tx.select,
  };
  return { db, tx, writes };
}

beforeEach(() => {
  vi.resetModules();
  h.getDb.mockReset();
});

describe("scope mirror progress repository", () => {
  it("creates once and returns the existing row on an idempotent retry", async () => {
    const existing = row();
    const first = fakeDb(null, [existing]);
    h.getDb.mockReturnValue(first.db);
    const repo = await import("./scope-mirror-progress");
    expect((await repo.createIfAbsent({ projectId: PROJECT, runId: RUN, cursor: "summary", state: { total: 3 } })).phase).toBe("plan");
    expect(first.tx.execute).toHaveBeenCalled();

    const retry = fakeDb(existing, []);
    h.getDb.mockReturnValue(retry.db);
    expect(await repo.createIfAbsent({ projectId: PROJECT, runId: RUN })).toEqual(existing);
  });

  it("locks, runs the writer, then advances state and revision atomically", async () => {
    const current = row();
    const f = fakeDb(current);
    h.getDb.mockReturnValue(f.db);
    const repo = await import("./scope-mirror-progress");
    const next = await repo.advance(current, { phase: "write", cursor: "c1", state: { jobs: 3 } }, async (tx) => {
      expect(f.writes).toEqual(["lock"]);
      await tx.execute({});
      f.writes.push("writer");
    });
    expect(f.writes[0]).toBe("lock");
    expect(f.writes).toContain("writer");
    expect(next.revision).toBe(1);
    expect(next.phase).toBe("write");
  });

  it("preserves the nested plan while merging checkpoint metadata", async () => {
    const current = row({
      state: { plan: { jobs: ["job-1"] }, metadata: { pages: 1 } },
    });
    const f = fakeDb(current);
    h.getDb.mockReturnValue(f.db);
    const repo = await import("./scope-mirror-progress");
    const next = await repo.advance(current, {
      phase: "write",
      stateMerge: { metadata: { pages: 2 }, checkpoint: "page-2" },
    });
    expect(next.state).toEqual({
      plan: { jobs: ["job-1"] },
      metadata: { pages: 2 },
      checkpoint: "page-2",
    });
    expect(next.revision).toBe(1);
  });

  it("rejects sending a full state and a merge patch together", async () => {
    const current = row();
    const f = fakeDb(current);
    h.getDb.mockReturnValue(f.db);
    const repo = await import("./scope-mirror-progress");
    await expect(repo.advance(current, {
      state: { replaced: true },
      stateMerge: { checkpoint: 1 },
    })).rejects.toThrow("mutually exclusive");
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects stale revision or phase before the callback and update", async () => {
    const f = fakeDb(row({ revision: 2, phase: "write" }));
    h.getDb.mockReturnValue(f.db);
    const repo = await import("./scope-mirror-progress");
    await expect(repo.advance(row(), { phase: "finalize" }, async () => {
      throw new Error("writer must not run");
    })).rejects.toBeInstanceOf(repo.ScopeMirrorProgressStaleError);
    expect(f.tx.update).not.toHaveBeenCalled();
  });

  it("rejects arbitrary changes to completed state and rolls back a failed writer", async () => {
    const done = row({ phase: "complete", revision: 4 });
    const completed = fakeDb(done);
    h.getDb.mockReturnValue(completed.db);
    const repo = await import("./scope-mirror-progress");
    await expect(repo.advance(done, { state: { tampered: true } })).rejects.toBeInstanceOf(repo.ScopeMirrorProgressCompletedError);
    expect(completed.tx.update).not.toHaveBeenCalled();

    const f = fakeDb(row());
    h.getDb.mockReturnValue(f.db);
    await expect(repo.advance(row(), { phase: "write" }, async () => { throw new Error("db work failed"); })).rejects.toThrow("db work failed");
    expect(f.tx.update).not.toHaveBeenCalled();
  });

  it("fails clearly when the opt-in table is absent", async () => {
    const f = fakeDb(null);
    f.db.execute.mockResolvedValue([]);
    h.getDb.mockReturnValue(f.db);
    const repo = await import("./scope-mirror-progress");
    await expect(repo.get(PROJECT, RUN)).rejects.toBeInstanceOf(repo.ScopeMirrorProgressUnavailableError);
  });
});
