-- scope_runs.project_id: the project DIMENSION the flat mirror lacked. Every
-- run belongs to one scope project (= MeasurementRunSummary.project_id), and
-- answers/mentions/citations join to a run — so filtering runs by project_id
-- scopes every downstream aggregate to one project (per-project KPI⑥). Additive
-- + nullable → existing mirrored runs stay valid; a `?force=1` re-sync backfills
-- project_id. See lib/db/schema.ts scopeRuns + scope-aggregates answerWhere.
ALTER TABLE "scope_runs" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_runs_project_idx" ON "scope_runs" ("project_id");
