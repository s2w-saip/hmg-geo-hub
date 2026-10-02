-- Hand-written migration: standard_prompts + standard_keywords for the
-- 표준 관리 admin tables (Task L). Both are admin-only global catalogs —
-- standard_prompts feeds 표준 dashboards (separate from per-project prompts),
-- standard_keywords seeds the customer-interest pipeline (Google Keyword +
-- community VoC) before any per-project Intent run.

CREATE TYPE "public"."standard_keyword_source" AS ENUM('google_keyword', 'community_voc');--> statement-breakpoint

CREATE TABLE "standard_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "text" text NOT NULL,
  "prompt_type" "prompt_type",
  "category" text,
  "brand" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "standard_prompts_enabled_idx" ON "standard_prompts" ("enabled");--> statement-breakpoint
CREATE INDEX "standard_prompts_brand_idx" ON "standard_prompts" ("brand");--> statement-breakpoint

CREATE TABLE "standard_keywords" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "term" text NOT NULL,
  "source_type" "standard_keyword_source" NOT NULL,
  "brand" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "notes" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "standard_keywords_source_idx" ON "standard_keywords" ("source_type");--> statement-breakpoint
CREATE INDEX "standard_keywords_enabled_idx" ON "standard_keywords" ("enabled");--> statement-breakpoint
CREATE INDEX "standard_keywords_brand_idx" ON "standard_keywords" ("brand");--> statement-breakpoint

CREATE TYPE "public"."standard_source_channel" AS ENUM('news', 'pr', 'social', 'community');--> statement-breakpoint

CREATE TABLE "standard_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "url" text NOT NULL,
  "channel" "standard_source_channel" NOT NULL,
  "brand" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "notes" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "standard_sources_channel_idx" ON "standard_sources" ("channel");--> statement-breakpoint
CREATE INDEX "standard_sources_enabled_idx" ON "standard_sources" ("enabled");--> statement-breakpoint
CREATE INDEX "standard_sources_brand_idx" ON "standard_sources" ("brand");
