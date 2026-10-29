import fs from "node:fs";
import path from "node:path";
import { bootstrapPlan, REPO_ROOT, type BootstrapStep } from "./bootstrap-plan";

export type Query = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string, parameters?: unknown[],
) => Promise<T[]>;

export const BOOTSTRAP_LOCK = 481726039;

export function targetIdentity(databaseUrl: string, supabaseUrl: string, mode: "bootstrap" | "verify" = "bootstrap"): { confirm: string; label: string } {
  const db = new URL(databaseUrl);
  const auth = new URL(supabaseUrl);
  if (!["postgres:", "postgresql:"].includes(db.protocol)) throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  if (!["http:", "https:"].includes(auth.protocol)) throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an HTTP(S) URL.");
  const local = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (local.has(db.hostname) && local.has(auth.hostname)) {
    return { confirm: "local", label: `${db.hostname}:${db.port || "5432"}${db.pathname} (local Supabase)` };
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(auth.hostname);
  if (!match || auth.protocol !== "https:") throw new Error("Use the canonical https://<project-ref>.supabase.co URL.");
  const ref = match[1];
  const port = db.port || "5432";
  const supportedPort = port === "5432" || (mode === "verify" && port === "6543");
  const username = decodeURIComponent(db.username);
  const direct = db.hostname === `db.${ref}.supabase.co` && username === "postgres";
  // Read-only verification may use a restricted Supabase role.<project-ref>.
  // Accept only simple PostgreSQL role identifiers and the exact target suffix;
  // bootstrap always retains its postgres.<project-ref> requirement.
  const poolerRole = username.endsWith(`.${ref}`) ? username.slice(0, -(ref.length + 1)) : "";
  const supportedPoolerUser = username === `postgres.${ref}`
    || (mode === "verify" && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(poolerRole));
  const pooler = /(^|\.)pooler\.supabase\.com$/.test(db.hostname)
    && supportedPoolerUser;
  if ((!direct && !pooler) || !supportedPort) {
    throw new Error(mode === "verify"
      ? "DATABASE_URL must match the Supabase project ref and use its postgres direct connection or a valid role.<project-ref> pooler account (port 5432 or 6543)."
      : "DATABASE_URL must match the Supabase project ref and use its postgres direct connection or session pooler (port 5432).");
  }
  if (db.pathname !== "/postgres") throw new Error("Use the Supabase postgres database.");
  return { confirm: ref, label: `${ref} (${db.hostname}:${db.port || "5432"}/postgres)` };
}

export async function assertSupabasePrerequisites(query: Query): Promise<void> {
  const roles = await query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')");
  if (roles.length !== 3) throw new Error("Supabase roles anon, authenticated, service_role are required; bootstrap never creates managed Auth roles.");
  // Catalog lookup does not require USAGE on auth. A verification-only role
  // should not need access to Auth data; bootstrap separately reads/locks it.
  const [auth] = await query<{ users: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname='users' AND c.relkind IN ('r','p')
    ) AS users
  `);
  if (!auth.users) throw new Error("Supabase Auth schema auth.users is missing; use a fresh Supabase project.");
  const [version] = await query<{ version: number }>("SELECT current_setting('server_version_num')::int AS version");
  if (version.version < 150000) throw new Error("PostgreSQL 15 or newer is required.");
}

export async function assertEmptyDatabase(query: Query): Promise<void> {
  await assertSupabasePrerequisites(query);
  const existing = await query<{ object: string }>(`
    SELECT 'relation:' || c.relname AS object
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'function:' || p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'type:' || t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND (t.typtype IN ('e','d','r','m')
      OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=t.typrelid AND c.relkind='c')))
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    ORDER BY object LIMIT 8
  `);
  if (existing.length) throw new Error(`Refusing non-empty public schema: ${existing.map((row) => row.object).join(", ")}. Bootstrap is never an upgrade/reset tool.`);
  const [users] = await query<{ any_users: boolean }>("SELECT EXISTS(SELECT 1 FROM auth.users) AS any_users");
  if (users.any_users) throw new Error("Refusing a Supabase project with existing Auth users. Bootstrap requires a fresh project before account creation.");
}

// A complete non-partition catalog, including summary_* objects not modeled by Drizzle.
// Parent indexes/constraints cover partition definitions; child ACLs are checked separately.
export async function readBootstrapCatalog(query: Query) {
  const columns = await query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS data_type, a.attnotnull AS not_null,
      pg_get_expr(ad.adbin,ad.adrelid) AS default_value
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
    ORDER BY c.relname,a.attnum
  `);
  const constraints = await query(`
    SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT c.relispartition AND con.contype <> 'n'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
    ORDER BY c.relname,con.conname
  `);
  const indexes = await query(`
    SELECT c.relname AS table_name, ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class ic ON ic.oid=i.indexrelid
    WHERE n.nspname='public' AND NOT c.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
    ORDER BY c.relname,ic.relname
  `);
  const enums = await query(`
    SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' GROUP BY t.typname ORDER BY t.typname
  `);
  const functions = await query(`
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_function_result(p.oid) AS result, md5(p.prosrc) AS body_hash, p.provolatile AS volatility, p.prosecdef AS security_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)
  `);
  return { columns, constraints, indexes, enums, functions };
}

export async function verifyBootstrap(query: Query, options: { applicationOnly?: boolean } = {}): Promise<{
  tables: number; columns: number; externalExposures: string[];
}> {
  await assertSupabasePrerequisites(query);
  const expected = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/db/bootstrap-schema.json"), "utf8"));
  const actual = await readBootstrapCatalog(query);
  for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
    // Require every baseline object, while allowing later additive migrations.
    const actualRows = new Set(actual[key].map((row) => JSON.stringify(row)));
    const missing = expected[key].filter((row: unknown) => !actualRows.has(JSON.stringify(row)));
    if (missing.length) throw new Error(`Bootstrap ${key} mismatch (${missing.length} objects): ${JSON.stringify(missing.slice(0, 3))}`);
  }
  const tableNames = [...new Set(expected.columns.map((row: { table_name: string }) => row.table_name))];
  const functionNames = [...new Set(expected.functions.map((row: { name: string }) => row.name))];
  const exposed = await query<{ object: string; role: string; application: boolean }>(`
    WITH RECURSIVE application_tables(oid) AS (
      SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])
      UNION
      SELECT i.inhrelid FROM pg_inherits i JOIN application_tables t ON t.oid=i.inhparent
    )
    SELECT c.relname AS object, r.rolname AS role,
      (c.oid IN (SELECT oid FROM application_tables) OR EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid
          AND d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT oid FROM application_tables)
          AND d.deptype IN ('a','i') AND c.relkind='S'
      )) AS application
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')) r
    WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.rolname,c.oid,'USAGE,SELECT,UPDATE')
        ELSE has_table_privilege(r.rolname,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END
    UNION ALL
    SELECT p.proname, r.rolname, p.proname=ANY($2::text[]) AS application
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')) r
    WHERE n.nspname='public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      AND has_function_privilege(r.rolname,p.oid,'EXECUTE')
  `, [tableNames, functionNames]);
  const blockingExposures = options.applicationOnly ? exposed.filter((row) => row.application) : exposed;
  if (blockingExposures.length) throw new Error(`Browser roles can access server-only DB objects: ${JSON.stringify(blockingExposures.slice(0, 5))}`);
  const externalExposures = [...new Set(exposed.filter((row) => !row.application).map((row) => row.object))].sort();
  const settings = await query<{ key: string; value: string }>("SELECT key,value FROM public.summary_settings WHERE key IN ('read_enabled','read_screens') ORDER BY key");
  if (settings.length !== 2) throw new Error("Required summary_settings defaults are missing.");
  return { tables: tableNames.length, columns: expected.columns.length, externalExposures };
}

/** Caller MUST wrap this in one transaction. Any error rolls back all DDL and seeds. */
export async function applyBootstrap(query: Query, execute: (sql: string) => Promise<unknown>,
  steps: BootstrapStep[] = bootstrapPlan(), onStep: (name: string) => void = () => {}) {
  await query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK]);
  await execute("LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE");
  await assertEmptyDatabase(query);
  await execute(`
    SET LOCAL search_path = public, pg_catalog;
    SET LOCAL statement_timeout = '120s';
    SET LOCAL lock_timeout = '5s';
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
    -- Per-schema defaults cannot remove global PUBLIC EXECUTE on new functions.
    -- Each migration's explicit function REVOKE and the final ACL verification
    -- enforce access control; this statement only removes schema-specific grants.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;
  `);
  for (const step of steps) {
    onStep(step.name);
    await execute(step.sql);
  }
  await execute(`
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
    SELECT summary_ensure_week_partitions(
      (now() AT TIME ZONE 'UTC')::date,
      (now() AT TIME ZONE 'UTC')::date + 28);
  `);
  return verifyBootstrap(query);
}
