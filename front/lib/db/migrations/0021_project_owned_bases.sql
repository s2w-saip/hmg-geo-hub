-- Project-level owned-base structure for KPI ⑤/⑥.
-- - `project_owned_bases` becomes the authoritative ownership set for project
--   dashboards and settings.
-- - `projects.domain` remains as a legacy single-base fallback / sync source.
-- - tracked_competitors / tracked_vehicles gain optional alias arrays so the
--   settings form can capture brand/model variations explicitly.

CREATE TABLE IF NOT EXISTS "project_owned_bases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "base_url" text NOT NULL,
  "label" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "project_owned_bases_project_idx"
  ON "project_owned_bases" ("project_id");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "project_owned_bases_project_base_unique"
  ON "project_owned_bases" ("project_id", "base_url");--> statement-breakpoint

ALTER TABLE "tracked_competitors"
  ADD COLUMN IF NOT EXISTS "aliases" text[];--> statement-breakpoint

ALTER TABLE "tracked_vehicles"
  ADD COLUMN IF NOT EXISTS "aliases" text[];--> statement-breakpoint
