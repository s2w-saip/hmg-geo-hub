-- Hand-written migration: prompt_candidates + prompts tables for the
-- Prompt tab flow (v22 user flow #3). Enums declared up front so the
-- column DEFAULTs and type references resolve in a single statement
-- batch.

CREATE TYPE "public"."prompt_source" AS ENUM('google_keyword', 'social_scraping', 'manual');--> statement-breakpoint
CREATE TYPE "public"."prompt_type" AS ENUM('comparison', 'recommendation', 'information', 'other');--> statement-breakpoint
CREATE TYPE "public"."prompt_status" AS ENUM('draft', 'queued', 'running', 'done', 'failed');--> statement-breakpoint

CREATE TABLE "prompt_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "source" "prompt_source" NOT NULL,
  "source_keyword" text,
  "text" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "prompt_candidates_project_idx" ON "prompt_candidates" ("project_id");--> statement-breakpoint

CREATE TABLE "prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "candidate_id" uuid,
  "text" text NOT NULL,
  "prompt_type" "prompt_type",
  "category" text,
  "status" "prompt_status" DEFAULT 'draft' NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "prompts_project_idx" ON "prompts" ("project_id");
