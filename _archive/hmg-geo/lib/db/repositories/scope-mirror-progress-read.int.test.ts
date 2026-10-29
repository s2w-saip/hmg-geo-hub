import { beforeAll, afterAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.MIRROR_READER_TEST_DATABASE_URL;
let localDatabase = false;
try {
  if (databaseUrl) {
    const host = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, "");
    localDatabase = host === "127.0.0.1" || host === "localhost" || host === "::1";
  }
} catch {
  localDatabase = false;
}

const PROJECT = "66666666-6666-6666-6666-666666666666";
const RUN_COMPLETE = "77777777-7777-7777-7777-777777777777";
const RUN_PUBLISHED = "88888888-8888-8888-8888-888888888888";
const RUN_NULL_STATE = "99999999-9999-9999-9999-999999999999";
const RUN_WRONG_STEP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RUN_WRITE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
describe.skipIf(!localDatabase)("bulk mirror reader gate (isolated Postgres)", () => {
  let connection: Sql;
  let reader: typeof import("./scope-mirror-progress-read");

  beforeAll(async () => {
    connection = postgres(databaseUrl!, { prepare: false, connect_timeout: 5 });
    await connection.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
    `);
    const migrationPath = fileURLToPath(new URL("../migrations/0073_scope_mirror_progress.sql", import.meta.url));
    await connection.unsafe(readFileSync(migrationPath, "utf8"));
    process.env.DATABASE_URL = databaseUrl;
    reader = await import("./scope-mirror-progress-read");
    await connection.unsafe(`
      INSERT INTO scope_mirror_progress (project_id, run_id, phase, state)
      VALUES
        ('${PROJECT}', '${RUN_COMPLETE}', 'complete', '{}'::jsonb),
        ('${PROJECT}', '${RUN_PUBLISHED}', 'finalize', '{"step":"invalidate-published"}'::jsonb),
        ('${PROJECT}', '${RUN_NULL_STATE}', 'finalize', 'null'::jsonb),
        ('${PROJECT}', '${RUN_WRONG_STEP}', 'finalize', '{"step":"publish"}'::jsonb),
        ('${PROJECT}', '${RUN_WRITE}', 'write', '{}'::jsonb)
      ON CONFLICT (project_id, run_id) DO UPDATE SET phase = EXCLUDED.phase, state = EXCLUDED.state
    `);
  });

  afterAll(async () => {
    await connection.unsafe(`DELETE FROM scope_mirror_progress WHERE project_id = '${PROJECT}'`);
    await connection.end({ timeout: 5 });
  });

  it("fails closed for null or incompatible finalize steps", async () => {
    const query = new PgDialect().sqlToQuery(
      await reader.bulkMirrorRunVisibleSql(sql`x.run_id`),
    );
    const rows = await connection.unsafe(`
      SELECT x.run_id::text AS run_id, (${query.sql}) AS visible
      FROM (VALUES
        ('${RUN_COMPLETE}'::uuid), ('${RUN_PUBLISHED}'::uuid),
        ('${RUN_NULL_STATE}'::uuid), ('${RUN_WRONG_STEP}'::uuid), ('${RUN_WRITE}'::uuid)
      ) AS x(run_id)
      ORDER BY x.run_id
    `) as Array<{ run_id: string; visible: boolean }>;
    const byRun = new Map(rows.map((row) => [row.run_id, row.visible]));
    expect(byRun.get(RUN_COMPLETE)).toBe(true);
    expect(byRun.get(RUN_PUBLISHED)).toBe(true);
    expect(byRun.get(RUN_NULL_STATE)).toBe(false);
    expect(byRun.get(RUN_WRONG_STEP)).toBe(false);
    expect(byRun.get(RUN_WRITE)).toBe(false);
  });
});
