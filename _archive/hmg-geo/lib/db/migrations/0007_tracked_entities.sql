-- Hand-written migration: tracked_competitors + tracked_vehicles +
-- prompts.needs_reanalysis flag (Task P3).
--
-- The new tables are the "what does this project track besides its own
-- brand" lists — competitors and vehicles. Add/remove on either flips the
-- needs_reanalysis flag on existing prompts so the next batch picks them
-- up to re-label answers against the new tracked set.

CREATE TABLE "tracked_competitors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "brand_name" text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "tracked_competitors_project_idx" ON "tracked_competitors" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_competitors_project_brand_unique" ON "tracked_competitors" ("project_id", "brand_name");--> statement-breakpoint

CREATE TABLE "tracked_vehicles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "brand" text NOT NULL,
  "model" text NOT NULL,
  "segment" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "tracked_vehicles_project_idx" ON "tracked_vehicles" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_vehicles_project_brand_model_unique" ON "tracked_vehicles" ("project_id", "brand", "model");--> statement-breakpoint

ALTER TABLE "prompts" ADD COLUMN "needs_reanalysis" boolean DEFAULT false NOT NULL;
