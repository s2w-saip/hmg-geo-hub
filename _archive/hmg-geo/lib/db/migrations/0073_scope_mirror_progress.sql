-- 0073: per-run mirror progress for resumable, bounded sync.
-- Applied only via `npm run db:apply -- 0073` after review.
--
-- The project rotation cursor remains the fairness key. This table is a
-- separate run-level checkpoint so an interrupted run can resume its source
-- cursor without pretending that the run completed.
CREATE TABLE IF NOT EXISTS "scope_mirror_progress" (
  "project_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "phase" text NOT NULL,
  "cursor" text,
  "state" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "revision" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_error" text,
  CONSTRAINT "scope_mirror_progress_phase_ck"
    CHECK ("phase" IN ('plan', 'write', 'finalize', 'complete', 'blocked')),
  CONSTRAINT "scope_mirror_progress_revision_ck"
    CHECK ("revision" >= 0),
  CONSTRAINT "scope_mirror_progress_pk" PRIMARY KEY ("project_id", "run_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_mirror_progress_pending_idx"
  ON "scope_mirror_progress" ("created_at", "project_id", "run_id")
  WHERE "phase" NOT IN ('complete', 'blocked');--> statement-breakpoint
REVOKE ALL ON "scope_mirror_progress" FROM PUBLIC, anon, authenticated;
