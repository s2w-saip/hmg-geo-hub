import { beforeAll, afterAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb } from "@/lib/db";

const databaseUrl = process.env.MIRROR_WRITER_TEST_DATABASE_URL;
let localDatabase = false;
try {
  if (databaseUrl) {
    const parsed = new URL(databaseUrl);
    localDatabase =
      ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) &&
      parsed.pathname === "/mirror_writer_test";
  }
} catch {
  localDatabase = false;
}

const PROJECT = "66666666-6666-6666-6666-666666666666";
const RUN = "77777777-7777-7777-7777-777777777777";
const OTHER_RUN = "88888888-8888-8888-8888-888888888888";
const OLD_JOB = "99999999-9999-4999-8999-999999999991";
const PAGE_ONE_JOB = "99999999-9999-4999-8999-999999999992";
const PAGE_TWO_JOB = "99999999-9999-4999-8999-999999999993";

const migrationPath = fileURLToPath(new URL("../migrations/0073_scope_mirror_progress.sql", import.meta.url));

describe.skipIf(!localDatabase)("mirror writer and progress atomicity (isolated Postgres)", () => {
  let connection: Sql;
  let progress: typeof import("./scope-mirror-progress");
  let mirror: typeof import("./scope-mirror");
  let bulkRun: typeof import("../../scope/mirror/bulk-run");

  beforeAll(async () => {
    connection = postgres(databaseUrl!, { prepare: false, connect_timeout: 5 });
    await connection.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
      DROP TABLE IF EXISTS scope_mirror_progress, scope_answer_stances, scope_acr_rollups,
        scope_citations, scope_mentions, scope_answers, scope_runs CASCADE;
      CREATE TABLE scope_runs (
        run_id uuid PRIMARY KEY, project_id uuid, status text,
        started_at timestamptz, completed_at timestamptz,
        cycle_anchor_at timestamptz, total_jobs integer,
        synced_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE scope_answers (
        job_id uuid PRIMARY KEY, run_id uuid NOT NULL, prompt_id uuid,
        target text NOT NULL, region text, status text,
        measured_at timestamptz, model_slug text, answer_text text
      );
      CREATE TABLE scope_answer_stances (
        job_id uuid NOT NULL, turn_index integer NOT NULL DEFAULT 0,
        entity_id uuid NOT NULL, brand_label text,
        is_tracked boolean NOT NULL DEFAULT false, stance text NOT NULL,
        confidence real, evidence_text text, evidence_start integer,
        evidence_end integer, reason text, model_slug text,
        PRIMARY KEY (job_id, turn_index, entity_id)
      );
      CREATE TABLE scope_mentions (
        job_id uuid NOT NULL, entity_id uuid NOT NULL, brand text,
        entity_type text, mention_count integer NOT NULL DEFAULT 0,
        sentiment_positive integer NOT NULL DEFAULT 0,
        sentiment_neutral integer NOT NULL DEFAULT 0,
        sentiment_negative integer NOT NULL DEFAULT 0,
        sentiment_mixed integer NOT NULL DEFAULT 0,
        avg_position real, surfaces text[], brand_rollup_entity_id uuid,
        type_mention integer NOT NULL DEFAULT 0,
        type_recommendation integer NOT NULL DEFAULT 0,
        type_comparison integer NOT NULL DEFAULT 0,
        type_definition integer NOT NULL DEFAULT 0,
        type_final_choice integer NOT NULL DEFAULT 0,
        PRIMARY KEY (job_id, entity_id)
      );
      CREATE TABLE scope_citations (
        id bigserial PRIMARY KEY, job_id uuid NOT NULL, url text,
        domain text, title text, ref_index integer, category text
      );
      CREATE TABLE scope_acr_rollups (
        prompt_run_id uuid NOT NULL, entity_id uuid NOT NULL, run_id uuid NOT NULL,
        PRIMARY KEY (prompt_run_id, entity_id)
      );
      CREATE TABLE scope_answer_drops (
        job_id uuid PRIMARY KEY, source_measured_at timestamptz,
        dropped_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL
      );
    `);
    const migration = readFileSync(migrationPath, "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await connection.unsafe(statement);
    }
    process.env.DATABASE_URL = databaseUrl;
    progress = await import("./scope-mirror-progress");
    mirror = await import("./scope-mirror");
    bulkRun = await import("../../scope/mirror/bulk-run");
  });

  afterAll(async () => {
    await connection.unsafe("DROP TABLE IF EXISTS scope_mirror_progress, scope_answer_drops, scope_answer_stances, scope_acr_rollups, scope_citations, scope_mentions, scope_answers, scope_runs CASCADE");
    await connection.end({ timeout: 5 });
  });

  it("resets old children, appends the next page, and rolls back a failed page with its cursor", async () => {
    await connection.unsafe(`
      INSERT INTO scope_answers (job_id, run_id, target, status) VALUES
        ('${OLD_JOB}', '${RUN}', 'chatgpt', 'completed');
      INSERT INTO scope_mentions (job_id, entity_id, brand) VALUES
        ('${OLD_JOB}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'old');
      INSERT INTO scope_citations (job_id, url) VALUES ('${OLD_JOB}', 'https://old.example');
      INSERT INTO scope_answer_stances (job_id, entity_id, stance, reason)
      VALUES ('${OLD_JOB}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'negative', 'old');
    `);
    const current = await progress.createIfAbsent({ projectId: PROJECT, runId: RUN, state: { plan: { pages: 3 } } });
    const run = {
      runId: RUN,
      projectId: PROJECT,
      status: "completed",
      startedAt: new Date("2026-09-15T00:00:00Z"),
      completedAt: new Date("2026-09-15T00:01:00Z"),
      totalJobs: 2,
    } as const;
    const capabilities = { anchors: false, drops: false, occAvailable: false, stances: true };
    const answer = (jobId: string) => ({
      jobId, runId: RUN, promptId: null, target: "chatgpt", region: "KR",
      status: "completed", measuredAt: new Date("2026-09-15T00:00:00Z"),
      modelSlug: null, answerText: `answer-${jobId}`,
    });
    const stance = (jobId: string, entityId: string, value: string) => ({
      jobId, entityId, stance: value, reason: `stance-${jobId}`,
    });

    const pageOne = await progress.advance(current, { phase: "write", cursor: "page-1" }, async (tx) => {
      await mirror.writeMirrorChunk(tx, run, [answer(PAGE_ONE_JOB)], [], [], [], [], [stance(PAGE_ONE_JOB, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "positive")], capabilities, {
        append: false, finalize: false, reset: true,
      });
    });
    expect(pageOne.cursor).toBe("page-1");
    expect((await connection.unsafe("SELECT job_id FROM scope_answers WHERE run_id = $1 ORDER BY job_id", [RUN])).map((r) => r.job_id)).toEqual([PAGE_ONE_JOB]);
    expect((await connection.unsafe("SELECT count(*)::int AS n FROM scope_mentions WHERE job_id = $1", [OLD_JOB]))[0].n).toBe(0);
    expect((await connection.unsafe("SELECT job_id, stance FROM scope_answer_stances WHERE job_id = $1", [PAGE_ONE_JOB]))).toEqual([
      { job_id: PAGE_ONE_JOB, stance: "positive" },
    ]);
    expect((await connection.unsafe("SELECT count(*)::int AS n FROM scope_answer_stances WHERE job_id = $1", [OLD_JOB]))[0].n).toBe(0);

    const pageTwo = await progress.advance(pageOne, { phase: "write", cursor: "page-2" }, async (tx) => {
      await mirror.writeMirrorChunk(tx, run, [answer(PAGE_TWO_JOB)], [], [], [], [], [stance(PAGE_TWO_JOB, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "mixed")], capabilities, {
        append: true, finalize: false,
      });
    });
    expect(pageTwo.cursor).toBe("page-2");
    expect((await connection.unsafe("SELECT count(*)::int AS n FROM scope_answers WHERE run_id = $1", [RUN]))[0].n).toBe(2);
    expect((await connection.unsafe("SELECT stance FROM scope_answer_stances WHERE job_id = $1", [PAGE_TWO_JOB]))[0].stance).toBe("mixed");

    await expect(progress.advance(pageTwo, { phase: "write", cursor: "page-failed" }, async (tx) => {
      await mirror.writeMirrorChunk(tx, run, [answer(OLD_JOB)], [], [], [], [], [stance(OLD_JOB, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "positive")], capabilities, {
        append: true, finalize: false,
      });
      throw new Error("page failure");
    })).rejects.toThrow("page failure");
    expect(await progress.get(PROJECT, RUN)).toEqual(pageTwo);
    expect((await connection.unsafe("SELECT job_id FROM scope_answers WHERE run_id = $1 ORDER BY job_id", [RUN])).map((r) => r.job_id)).toEqual([PAGE_ONE_JOB, PAGE_TWO_JOB]);
    expect((await connection.unsafe("SELECT job_id, stance FROM scope_answer_stances WHERE job_id = $1", [PAGE_ONE_JOB]))).toEqual([
      { job_id: PAGE_ONE_JOB, stance: "positive" },
    ]);
    expect((await connection.unsafe("SELECT count(*)::int AS n FROM scope_answer_stances WHERE job_id = $1", [OLD_JOB]))[0].n).toBe(0);
  });

  it("blocks legacy replaceRun while an incomplete progress receipt exists", async () => {
    const pending = await progress.createIfAbsent({ projectId: PROJECT, runId: OTHER_RUN, state: { step: "write" } });
    await expect(mirror.scopeMirrorRepository.replaceRun({
      runId: OTHER_RUN, projectId: PROJECT, status: "completed",
      startedAt: new Date("2026-09-15T00:00:00Z"), completedAt: new Date("2026-09-15T00:01:00Z"), totalJobs: 0,
    }, [], [], [], [], [])).rejects.toThrow("unfinished bulk mirror progress");
    expect(await progress.get(PROJECT, OTHER_RUN)).toEqual(pending);
  });

  it("verifies the exact answer ID set, rejects same-count substitutions, and honors drops", async () => {
    const verifyRun = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const actualJob = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const otherJob = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const txDb = getDb();
    await connection.unsafe(
      "INSERT INTO scope_answers (job_id, run_id, target, status) VALUES ($1, $2, 'chatgpt', 'completed')",
      [actualJob, verifyRun],
    );
    const caps = { anchors: false, drops: false, occAvailable: false, stances: false };
    const state = { selected: [actualJob], expectedAcrRows: 0 } as never;
    await txDb.transaction(async (tx) => bulkRun.verifyBulkRows(tx, verifyRun, state, caps));

    await expect(txDb.transaction(async (tx) => bulkRun.verifyBulkRows(
      tx, verifyRun, { selected: [otherJob], expectedAcrRows: 0 } as never, caps,
    ))).rejects.toThrow("Bulk mirror verification failed");

    await connection.unsafe(
      "INSERT INTO scope_answer_drops (job_id, reason) VALUES ($1, 'test-drop')",
      [otherJob],
    );
    await txDb.transaction(async (tx) => bulkRun.verifyBulkRows(
      tx, verifyRun, { selected: [actualJob, otherJob], expectedAcrRows: 0 } as never,
      { ...caps, drops: true },
    ));
  });
});
