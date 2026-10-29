import { beforeAll, afterAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { sql as dsql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.MIRROR_PROGRESS_TEST_DATABASE_URL;
let localDatabase = false;
try {
  if (databaseUrl) {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname;
    localDatabase =
      (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
      parsed.pathname === "/mirror_resume_test";
  }
} catch {
  localDatabase = false;
}

const PROJECT = "33333333-3333-3333-3333-333333333333";
const RUN = "44444444-4444-4444-4444-444444444444";
const RUN_AFTER_RESPONSE_LOSS = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!localDatabase)("scope mirror progress (isolated Postgres)", () => {
  let connection: Sql;
  let repository: typeof import("./scope-mirror-progress");

  beforeAll(async () => {
    // This suite is opt-in and accepts only an explicitly named localhost URL;
    // it never falls back to DATABASE_URL.
    connection = postgres(databaseUrl!, { prepare: false, connect_timeout: 5 });
    await connection`SET client_min_messages TO warning`;
    await connection.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
    `);
    const migrationPath = fileURLToPath(new URL("../migrations/0073_scope_mirror_progress.sql", import.meta.url));
    const migration = readFileSync(migrationPath, "utf8");
    await connection.unsafe(migration);
    await connection.unsafe(migration); // idempotent re-application
    await connection`TRUNCATE TABLE scope_mirror_progress`;
    process.env.DATABASE_URL = databaseUrl;
    repository = await import("./scope-mirror-progress");
  });

  afterAll(async () => {
    await connection`TRUNCATE TABLE scope_mirror_progress`;
    await connection.end({ timeout: 5 });
  });

  it("creates with initial state/cursor and remains idempotent", async () => {
    const first = await repository.createIfAbsent({
      projectId: PROJECT,
      runId: RUN,
      cursor: "page-1",
      state: { totalJobs: 6 },
    });
    const retry = await repository.createIfAbsent({
      projectId: PROJECT,
      runId: RUN,
      cursor: "different",
      state: { totalJobs: 99 },
    });
    expect(first).toMatchObject({ phase: "plan", cursor: "page-1", state: { totalJobs: 6 }, revision: 0 });
    expect(retry).toEqual(first);
    expect(await repository.scopeMirrorProgressRepository.getForRegistration(PROJECT, RUN)).toMatchObject({ phase: "plan", state: {} });
    expect((await repository.get(PROJECT, RUN))?.state).toEqual({ totalJobs: 6 });
  });

  it("runs the writer in the same locked transaction before the checkpoint commit", async () => {
    const current = (await repository.get(PROJECT, RUN))!;
    let observedRevision: number | undefined;
    const next = await repository.advance(current, { phase: "write", cursor: "page-2" }, async (tx) => {
      const rows = await tx.execute(dsql`SELECT revision FROM scope_mirror_progress WHERE project_id = ${PROJECT} AND run_id = ${RUN}`) as unknown as Array<{ revision: number }>;
      observedRevision = Number(rows[0]?.revision);
    });
    expect(observedRevision).toBe(0);
    expect(next).toMatchObject({ phase: "write", cursor: "page-2", revision: 1 });
  });

  it("rejects a concurrent stale advance after advisory lock serialization", async () => {
    const current = (await repository.get(PROJECT, RUN))!;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const hold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = repository.advance(current, { phase: "finalize" }, async () => {
      firstStarted();
      await hold;
    });
    await started;
    const second = repository.advance(current, { phase: "blocked", lastError: "stale worker" });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ phase: "finalize", revision: 2 });
    await expect(second).rejects.toBeInstanceOf(repository.ScopeMirrorProgressStaleError);
    expect((await repository.get(PROJECT, RUN))?.phase).toBe("finalize");
  });

  it("merges metadata in place, preserves the nested plan, and keeps CAS", async () => {
    const current = (await repository.get(PROJECT, RUN))!;
    const seeded = await repository.advance(current, {
      state: { plan: { jobs: ["job-1"] }, metadata: { page: 1 } },
    });
    const merged = await repository.advance(seeded, {
      stateMerge: { metadata: { page: 2 }, checkpoint: "page-2" },
    });
    expect(merged.state).toEqual({
      plan: { jobs: ["job-1"] },
      metadata: { page: 2 },
      checkpoint: "page-2",
    });
    await expect(repository.advance(
      { ...merged, revision: merged.revision - 1 },
      { stateMerge: { checkpoint: "stale" } },
    )).rejects.toBeInstanceOf(repository.ScopeMirrorProgressStaleError);
    expect((await repository.get(PROJECT, RUN))?.state).toEqual(merged.state);
  });

  it("rolls back writer failure and rejects arbitrary completed changes", async () => {
    const current = (await repository.get(PROJECT, RUN))!;
    await expect(repository.advance(current, { phase: "write", stateMerge: { checkpoint: "uncommitted" } }, async () => {
      throw new Error("writer failed");
    })).rejects.toThrow("writer failed");
    expect(await repository.get(PROJECT, RUN)).toEqual(current);

    const done = await repository.advance(current, { phase: "complete" });
    await expect(repository.advance(done, { state: { tampered: true } })).rejects.toBeInstanceOf(repository.ScopeMirrorProgressCompletedError);
    expect(await repository.get(PROJECT, RUN)).toEqual(done);
  });

  it("treats a lost post-commit response as stale on retry", async () => {
    const committed = await repository.createIfAbsent({ projectId: PROJECT, runId: RUN_AFTER_RESPONSE_LOSS });
    const response = await repository.advance(committed, { lastError: null });
    expect(response.revision).toBe(committed.revision + 1);
    await expect(repository.advance(committed, { phase: "write" })).rejects.toBeInstanceOf(repository.ScopeMirrorProgressStaleError);
    expect((await repository.get(PROJECT, RUN_AFTER_RESPONSE_LOSS))?.revision).toBe(response.revision);
  });

  it("persists completed recheck cursors with CAS without changing the data watermark or publication phase", async () => {
    const repo = repository.scopeMirrorProgressRepository;
    const current = (await repository.get(PROJECT, RUN))!;
    const recheck = {
      version: 1, groups: [{ status: "failed", count: 2, digest: "baseline" }],
      nextCheckAt: "2026-01-01T00:00:00.000Z", changedAt: null, cursor: "next-page",
    };
    const saved = await repo.saveRecheck(current, recheck);
    const reread = (await repository.get(PROJECT, RUN))!;
    expect(reread).toEqual(saved);
    expect((await repo.getForRegistration(PROJECT, RUN))?.state.recheck).toEqual(recheck);
    expect(reread.updatedAt).toEqual(current.updatedAt);
    expect(reread.phase).toBe("complete");
    expect(reread.revision).toBe(current.revision + 1);
    expect((await repo.listRecheckable())[0].runId).toBe(RUN);
    await expect(repo.saveRecheck(current, recheck)).rejects.toBeInstanceOf(repository.ScopeMirrorProgressStaleError);
    const changed = await repo.saveRecheck(saved, { ...recheck, changedAt: new Date().toISOString() });
    expect((await repo.listRecheckable())[0].state.recheck).toMatchObject({ changedAt: expect.any(String) });
    const restarted = await repo.restart(changed, { source: {}, step: "plan" });
    await expect(repo.saveRecheck(changed, recheck)).rejects.toBeInstanceOf(repository.ScopeMirrorProgressStaleError);
    expect((await repository.get(PROJECT, RUN))?.phase).toBe(restarted.phase);
    expect(await repo.listRecheckable()).toEqual([]);
  });
});
