-- Hand-written migration: bff_audit_logs (spec 2026-07-23-add-bff-audit-sink).
-- Append-only sink for the BFF audit trail — replaces the console PLACEHOLDER
-- in lib/audit.ts (auditScopeCall + auditDataAccess).
--
-- Applied via `npm run db:apply -- 0033` (this repo applies later migrations as
-- hand-written idempotent SQL; the drizzle journal's last registered entry is
-- `0020_scope_runs_project`, so 0021+ are hand-written — see
-- scripts/db/apply-migration.ts). Idempotent (safe to re-run): DO $$ enum guard
-- + IF NOT EXISTS on table/indexes. Additive-only: a brand-new table, NO ALTER
-- on any existing table (0007 outage lesson).
--
-- NO FK on actor_id → profiles.id (DELIBERATE): audit rows must survive account
-- deletion. actor_role is a snapshot of the caller's role at call time. Inserts
-- into this table are NOT themselves audited (no recursion).
--
-- ⚠️ LOCKDOWN COVERAGE (verify AFTER apply — NOT covered by this migration):
-- scripts/db/lockdown.sql REVOKEs anon/authenticated privileges per-table; a
-- NEW table is unguarded until lockdown.sql is re-run. After applying, re-run
-- lockdown.sql and confirm anon has no access to this table, e.g.:
--   SELECT has_table_privilege('anon','public.bff_audit_logs','SELECT');  -- expect false
--   SELECT has_table_privilege('anon','public.bff_audit_logs','INSERT');  -- expect false
-- (also UPDATE/DELETE). This is a compensating control (no RLS on this DB).

DO $$ BEGIN
  CREATE TYPE "public"."bff_audit_kind" AS ENUM ('scope_call', 'data_access');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bff_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ts" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_id" uuid NOT NULL,
  "actor_role" text NOT NULL,
  "kind" "bff_audit_kind" NOT NULL,
  "action" text NOT NULL,
  "target" text,
  "detail" jsonb
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "bff_audit_logs_ts_idx" ON "bff_audit_logs" ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bff_audit_logs_actor_ts_idx" ON "bff_audit_logs" ("actor_id", "ts");
