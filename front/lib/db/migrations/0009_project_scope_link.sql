-- Hand-written migration (this repo authors migrations by hand from 0003 on;
-- drizzle-kit generate needs interactive prompts it can't get here).
--
-- Link each HMG project to its mirror in the scope (GEO 측정 엔진) "Hyundai
-- Motor Group" workspace. NULL until the mirror is created (live mode only;
-- mock mode leaves it NULL — lib/scope/project-sync.ts). Additive + nullable →
-- safe online change; the local row remains the source of truth, scope owns
-- measurement, and the two databases integrate only over the HTTP /api/v1
-- contract.

-- IF NOT EXISTS: this column may be applied out-of-band (Supabase MCP) ahead of
-- drizzle's own migration tracking, so keep the statement idempotent — a later
-- `npm run db:migrate` re-running 0009 is then a harmless no-op.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "scope_project_id" uuid;
