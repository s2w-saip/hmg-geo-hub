// snapshotRunFilter의 미러 진행 gate가 실제 answer run을 기준으로 평가되는지
// 격리 Postgres에서 검증한다. 운영 DB에는 접근하지 않는다.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

const databaseUrl = process.env.MIRROR_READER_TEST_DATABASE_URL;
let localDatabase = false;
try {
  if (databaseUrl) {
    const parsed = new URL(databaseUrl);
    localDatabase =
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1") &&
      parsed.pathname === "/mirror_reader_test";
  }
} catch {
  localDatabase = false;
}

const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_COMPLETE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_WRITE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const JOB_COMPLETE = "11111111-aaaa-4aaa-8aaa-111111111111";
const JOB_WRITE = "22222222-bbbb-4bbb-8bbb-222222222222";
const PROMPT_COMPLETE = "33333333-cccc-4ccc-8ccc-333333333333";
const PROMPT_WRITE = "44444444-dddd-4ddd-8ddd-444444444444";

describe.skipIf(!localDatabase)("snapshotRunFilter bulk visibility (isolated Postgres)", () => {
  let connection: Sql;

  beforeAll(async () => {
    // max:1 keeps TEMP tables and assertions on one session.
    connection = postgres(databaseUrl!, { prepare: false, connect_timeout: 5, max: 1 });
    process.env.DATABASE_URL = databaseUrl;
    await connection.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
    `);
    await connection.unsafe(readFileSync(new URL("../migrations/0073_scope_mirror_progress.sql", import.meta.url), "utf8"));
    await connection.unsafe(`
      CREATE TEMP TABLE scope_runs (
        run_id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        status text NOT NULL,
        started_at timestamptz NOT NULL
      );
      CREATE TEMP TABLE scope_answers (
        job_id uuid PRIMARY KEY,
        prompt_id uuid NOT NULL,
        target text NOT NULL,
        region text NOT NULL,
        status text NOT NULL,
        measured_at timestamptz NOT NULL,
        run_id uuid NOT NULL
      );
      INSERT INTO scope_runs (run_id, project_id, status, started_at) VALUES
        ('${RUN_COMPLETE}', '${PROJECT}', 'completed', '2026-09-15T00:00:00Z'),
        ('${RUN_WRITE}', '${PROJECT}', 'completed', '2026-09-15T00:01:00Z');
      INSERT INTO scope_answers (job_id, prompt_id, target, region, status, measured_at, run_id) VALUES
        ('${JOB_COMPLETE}', '${PROMPT_COMPLETE}', 'example.com', 'KR', 'completed', '2026-09-15T00:00:00Z', '${RUN_COMPLETE}'),
        ('${JOB_WRITE}', '${PROMPT_WRITE}', 'example.com', 'KR', 'completed', '2026-09-15T00:01:00Z', '${RUN_WRITE}');
    `);
    await connection.unsafe(`
      INSERT INTO scope_mirror_progress (project_id, run_id, phase, state)
      VALUES
        ('${PROJECT}', '${RUN_COMPLETE}', 'complete', '{}'::jsonb),
        ('${PROJECT}', '${RUN_WRITE}', 'write', '{}'::jsonb)
      ON CONFLICT (project_id, run_id) DO UPDATE SET phase = EXCLUDED.phase, state = EXCLUDED.state
    `);
  });

  afterAll(async () => {
    await connection.unsafe(`DELETE FROM scope_mirror_progress WHERE project_id = '${PROJECT}'`);
    await connection.end({ timeout: 5 });
  });

  it("keeps a complete run and hides an unrelated in-progress run", async () => {
    const reader = await import("./scope-mirror-progress-read");
    // Populate the successful-probe cache before the synchronous SQL builder.
    await reader.bulkMirrorRunVisibleSql(sql`scope_answers.run_id`);
    const aggregates = await import("./scope-aggregates");
    const built = new PgDialect().sqlToQuery(aggregates.snapshotRunFilter(PROJECT, {}));
    const rows = await connection.unsafe(
      `SELECT scope_answers.run_id::text AS run_id, (${built.sql}) AS visible
         FROM scope_answers ORDER BY scope_answers.run_id`,
      built.params,
    ) as Array<{ run_id: string; visible: boolean }>;
    const byRun = new Map(rows.map((row) => [row.run_id, row.visible]));
    expect(byRun.get(RUN_COMPLETE)).toBe(true);
    expect(byRun.get(RUN_WRITE)).toBe(false);
  });
});
