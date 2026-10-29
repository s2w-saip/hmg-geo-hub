import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../lib/db/schema";
import { applyBootstrap, assertEmptyDatabase, assertSupabasePrerequisites, targetIdentity, verifyBootstrap, type Query } from "./bootstrap-lib";
import { bootstrapPlan } from "./bootstrap-plan";

function queryFor(db: PGlite): Query {
  return async <T extends Record<string, unknown>>(text: string, params?: unknown[]) => (await db.query<T>(text, params)).rows;
}
async function freshDatabase() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
    -- Supabase defaults grant browser roles access; bootstrap must close these defaults.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;`);
  return db;
}

it("rejects an unrelated hosted project, transaction pooler and unconfirmed external target", () => {
  expect(targetIdentity("postgres://postgres:pw@db.abc.supabase.co:5432/postgres", "https://abc.supabase.co").confirm).toBe("abc");
  expect(targetIdentity("postgres://postgres.abc:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres", "https://abc.supabase.co").confirm).toBe("abc");
  expect(targetIdentity("postgres://postgres:pw@127.0.0.1:54322/postgres", "http://127.0.0.1:54321").confirm).toBe("local");
  for (const url of ["postgres://postgres:pw@db.other.supabase.co/postgres", "postgres://postgres.abc:pw@aws-0-ap.pooler.supabase.com:6543/postgres", "postgres://postgres:pw@localhost/postgres"]) {
    expect(() => targetIdentity(url, "https://abc.supabase.co")).toThrow();
  }
});

it("allows a matching hosted transaction pooler only for read-only verification", () => {
  for (const host of ["postgres.abc:pw@aws-0-ap-northeast-2.pooler.supabase.com", "postgres:pw@db.abc.supabase.co"]) {
    const url = `postgres://${host}:6543/postgres`;
    expect(targetIdentity(url, "https://abc.supabase.co", "verify").confirm).toBe("abc");
    expect(() => targetIdentity(url, "https://abc.supabase.co")).toThrow(/5432/);
    expect(() => targetIdentity(url, "https://other.supabase.co", "verify")).toThrow(/project ref/);
    expect(() => targetIdentity(`postgres://${host}:5433/postgres`, "https://abc.supabase.co", "verify")).toThrow(/5432 or 6543/);
  }
  expect(targetIdentity("postgres://postgres.abc:pw@aws-0-ap.pooler.supabase.com:5432/postgres", "https://abc.supabase.co", "verify").confirm).toBe("abc");
});

it("permits a restricted pooler role only for verification of the exact project", () => {
  for (const port of [5432, 6543]) {
    const url = `postgres://hmg_int_ro.abc:pw@aws-0-ap.pooler.supabase.com:${port}/postgres`;
    expect(targetIdentity(url, "https://abc.supabase.co", "verify").confirm).toBe("abc");
    expect(() => targetIdentity(url, "https://abc.supabase.co")).toThrow();
    expect(() => targetIdentity(url, "https://other.supabase.co", "verify")).toThrow(/project ref/);
  }
  for (const role of ["", "9role", "hmg-int-ro", "role.with.dot", "a".repeat(64)]) {
    expect(() => targetIdentity(`postgres://${role}.abc:pw@aws-0-ap.pooler.supabase.com:5432/postgres`, "https://abc.supabase.co", "verify")).toThrow();
  }
});

it("checks Auth metadata without requiring the verification role to read Auth data", async () => {
  const db = await freshDatabase();
  try {
    await db.exec("CREATE ROLE bootstrap_readonly; SET ROLE bootstrap_readonly");
    await expect(queryFor(db)("SELECT to_regclass('auth.users')")).rejects.toThrow(/permission denied for schema auth/);
    await expect(assertSupabasePrerequisites(queryFor(db))).resolves.toBeUndefined();
    // The write-path empty-Auth check still requires actual Auth read permission.
    await expect(assertEmptyDatabase(queryFor(db))).rejects.toThrow(/permission denied for schema auth/);
  } finally { await db.close(); }
});

it("rolls back every schema change after a failure and allows a clean retry", async () => {
  const db = await freshDatabase();
  try {
    await expect(db.transaction(async (tx) => {
      const query: Query = async <T extends Record<string, unknown>>(text: string, params?: unknown[]) => (await tx.query<T>(text, params)).rows;
      await applyBootstrap(query, (text) => tx.exec(text), [
        { name: "fixture", sql: "CREATE TABLE public.rollback_probe (id int)" },
        { name: "failure", sql: "SELECT missing_bootstrap_function()" },
      ]);
    })).rejects.toThrow(/missing_bootstrap_function/);
    await expect(assertEmptyDatabase(queryFor(db))).resolves.toBeUndefined();
  } finally { await db.close(); }
});

it("rejects Auth users and existing unrelated public objects before applying", async () => {
  const db = await freshDatabase();
  try {
    await db.exec("INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001')");
    await expect(assertEmptyDatabase(queryFor(db))).rejects.toThrow(/existing Auth users/);
    await db.exec("DELETE FROM auth.users; CREATE TYPE public.customer_type AS (id int)");
    await expect(assertEmptyDatabase(queryFor(db))).rejects.toThrow(/non-empty public schema/);
    await db.exec("DROP TYPE public.customer_type; CREATE TABLE public.customer_data (id int)");
    await expect(assertEmptyDatabase(queryFor(db))).rejects.toThrow(/non-empty public schema/);
  } finally { await db.close(); }
});

describe("complete fresh-project bootstrap", () => {
  let db: PGlite;
  let query: Query;
  beforeAll(async () => {
    db = await freshDatabase(); query = queryFor(db);
    await db.transaction(async (tx) => {
      const q: Query = async <T extends Record<string, unknown>>(text: string, params?: unknown[]) => (await tx.query<T>(text, params)).rows;
      await applyBootstrap(q, (text) => tx.exec(text));
    });
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("includes both 0043 migrations and all schema migrations through 0073", () => {
    const names = bootstrapPlan().map((step) => step.name);
    expect(names.filter((name) => name.includes("/0043_"))).toHaveLength(2);
    expect(names.some((name) => name.includes("0073_scope_mirror_progress"))).toBe(true);
    expect(names.some((name) => name.includes("/0035_") || name.includes("/0056_"))).toBe(false);
    expect(names.some((name) => name.includes("0066_summary_aggregate_keys"))).toBe(true);
  });

  it("verifies complete catalog including summary tables, and refuses a second bootstrap", async () => {
    const result = await db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION READ ONLY");
      const q: Query = async <T extends Record<string, unknown>>(text: string, params?: unknown[]) => (await tx.query<T>(text, params)).rows;
      return verifyBootstrap(q);
    });
    expect(result.tables).toBeGreaterThan(60);
    expect(result.columns).toBeGreaterThan(700);
    await expect(assertEmptyDatabase(query)).rejects.toThrow(/non-empty public schema/);
  });

  it("matches every current Drizzle column type and nullability (independent of catalog fixture)", async () => {
    const actual = await query<{ table_name: string; column_name: string; data_type: string; not_null: boolean }>(`
      SELECT c.relname AS table_name,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull AS not_null
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`);
    const rows = new Map(actual.map((row) => [`${row.table_name}.${row.column_name}`, row]));
    let checked = 0;
    for (const value of Object.values(schema)) {
      if (!value || typeof value !== "object" || !(Symbol.for("drizzle:Name") in value)) continue;
      const table = getTableConfig(value as PgTable);
      for (const column of table.columns) {
        const type = column.getSQLType().replace(/^"public"\./, "").replaceAll('"', '').replace(/^bigserial$/, "bigint").replace(/^serial$/, "integer");
        expect(rows.get(`${table.name}.${column.name}`), `${table.name}.${column.name}`).toMatchObject({ data_type: type, not_null: column.notNull });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it("creates current-week partitions, carries only reference seeds and preserves safe defaults", async () => {
    expect((await query("SELECT count(*)::int AS n FROM public.projects"))[0].n).toBe(0);
    expect((await query("SELECT count(*)::int AS n FROM public.profiles"))[0].n).toBe(0);
    expect((await query("SELECT count(*)::int AS n FROM public.website_sites"))[0].n).toBe(0);
    expect((await query("SELECT value FROM summary_settings WHERE key='read_enabled'"))[0].value).toBe("0");
    expect((await query("SELECT to_regclass('public.summary_answers_' || to_char(date_trunc('week', now() AT TIME ZONE 'UTC'),'YYYYMMDD')) IS NOT NULL AS present"))[0].present).toBe(true);
    const normalized = await query("SELECT citation_url_norm('https://www.example.com/A/?utm_source=test#x') AS value");
    expect(normalized[0].value).toBe("example.com/a");
  });

  it("keeps strict ACL failure while application-only reports exposed external objects by name", async () => {
    await db.exec(`CREATE FUNCTION public.external_probe() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      GRANT EXECUTE ON FUNCTION public.external_probe() TO anon, authenticated;
      CREATE VIEW public.external_view AS SELECT 1 AS value; GRANT SELECT ON public.external_view TO anon`);
    try {
      await expect(verifyBootstrap(query)).rejects.toThrow(/Browser roles/);
      const result = await verifyBootstrap(query, { applicationOnly: true });
      expect(result.externalExposures).toEqual(["external_probe", "external_view"]);
      expect(result.tables).toBe(69);
      expect(result.columns).toBe(787);
    } finally {
      await db.exec("DROP FUNCTION public.external_probe(); DROP VIEW public.external_view");
    }
  });

  it("still rejects application function, sequence and partition leaks in application-only mode", async () => {
    for (const grant of [
      "EXECUTE ON FUNCTION public.citation_url_norm(text)",
      "SELECT ON SEQUENCE public.scope_citations_id_seq",
      "SELECT ON TABLE public.summary_answers_20260824",
    ]) {
      await db.exec(`GRANT ${grant} TO anon`);
      try { await expect(verifyBootstrap(query, { applicationOnly: true })).rejects.toThrow(/Browser roles/); }
      finally { await db.exec(`REVOKE ${grant} FROM anon`); }
    }
  });

  it("does not accept a view replacing a baseline application table in application-only mode", async () => {
    await db.exec(`BEGIN; ALTER TABLE public.summary_generations RENAME TO saved_generations;
      CREATE VIEW public.summary_generations AS SELECT * FROM public.saved_generations;
      GRANT SELECT ON public.summary_generations TO anon`);
    try { await expect(verifyBootstrap(query, { applicationOnly: true })).rejects.toThrow(/columns mismatch/); }
    finally { await db.exec("ROLLBACK"); }
  });

  it("detects leaked table grants and missing summary columns in a read-only check", async () => {
    await db.exec("GRANT SELECT ON public.projects TO authenticated");
    await expect(verifyBootstrap(query)).rejects.toThrow(/Browser roles/);
    await expect(verifyBootstrap(query, { applicationOnly: true })).rejects.toThrow(/Browser roles/);
    await db.exec("REVOKE SELECT ON public.projects FROM authenticated");
    await db.exec("CREATE VIEW public.leaked_view AS SELECT id FROM public.projects; GRANT SELECT ON public.leaked_view TO anon");
    await expect(verifyBootstrap(query)).rejects.toThrow(/Browser roles/);
    await db.exec("REVOKE SELECT ON public.leaked_view FROM anon");
    await db.exec("CREATE MATERIALIZED VIEW public.leaked_materialized_view AS SELECT id FROM public.projects; GRANT SELECT ON public.leaked_materialized_view TO authenticated");
    await expect(verifyBootstrap(query)).rejects.toThrow(/Browser roles/);
    await db.exec("REVOKE SELECT ON public.leaked_materialized_view FROM authenticated");
    await db.exec("ALTER TABLE summary_generations DROP COLUMN timings");
    await expect(verifyBootstrap(query)).rejects.toThrow(/columns mismatch/);
  });
});
