-- Hand-written migration: tracked_keywords (Intent > Google Keyword).
--
-- Persists the per-project list of Google keyword terms the operator tracks.
-- The view previously held tabs in client state only (seeded from a hardcoded
-- sample list), so the tracked set was lost on refresh. `country` is the ISO
-- alpha-2 market auto-applied from the project's country at save time.

CREATE TABLE "tracked_keywords" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "term" text NOT NULL,
  "country" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "tracked_keywords_project_idx" ON "tracked_keywords" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_keywords_project_term_unique" ON "tracked_keywords" ("project_id", "term");
