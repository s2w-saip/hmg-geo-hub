-- Phase 5.1: Answer Analysis data pipeline (브랜드 가시성/Mentions + Citations).
--
-- Three core tables (ai_responses → brand_mentions / citation_analysis) plus
-- two supporting (tracked_brands, youtube_video_metadata).
--
-- ONLY new tables — no ALTER TABLE on existing tables (lesson learned from
-- 0007 needs_reanalysis column addition that broke prod queries before
-- migration applied). When this migration runs, existing queries are
-- unaffected; only new code importing these tables sees them.

CREATE TYPE "public"."ai_provider" AS ENUM('chatgpt', 'claude', 'gemini', 'perplexity');--> statement-breakpoint
CREATE TYPE "public"."funnel_stage" AS ENUM('awareness', 'consideration', 'purchase');--> statement-breakpoint
CREATE TYPE "public"."mention_type" AS ENUM('mention', 'recommendation', 'comparison', 'definition');--> statement-breakpoint

-- ─── ai_responses ──────────────────────────────────────────────────
-- One row per (prompt × model) execution. Captures raw AI answer + metadata.
CREATE TABLE "ai_responses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "prompt_id" uuid NOT NULL,
  "ai_provider" "ai_provider" NOT NULL,
  "ai_model" text NOT NULL,
  "response_text" text NOT NULL,
  "funnel_stage" "funnel_stage",
  "query_created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "ai_responses_prompt_idx" ON "ai_responses" ("prompt_id");--> statement-breakpoint
CREATE INDEX "ai_responses_provider_idx" ON "ai_responses" ("ai_provider");--> statement-breakpoint
CREATE INDEX "ai_responses_query_time_idx" ON "ai_responses" ("query_created_at");--> statement-breakpoint

-- ─── brand_mentions ────────────────────────────────────────────────
-- One row per brand occurrence inside an AI answer. Drives ACR
-- Top1/Top5, sentiment distribution, mention-type pie, etc.
CREATE TABLE "brand_mentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "response_id" uuid NOT NULL,
  "prompt_id" uuid NOT NULL,
  "brand_name" text NOT NULL,
  "mention_position" integer NOT NULL,
  "mention_type" "mention_type",
  "brand_sentiment" real,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "brand_mentions_response_idx" ON "brand_mentions" ("response_id");--> statement-breakpoint
CREATE INDEX "brand_mentions_prompt_idx" ON "brand_mentions" ("prompt_id");--> statement-breakpoint
CREATE INDEX "brand_mentions_brand_idx" ON "brand_mentions" ("brand_name");--> statement-breakpoint
CREATE INDEX "brand_mentions_position_idx" ON "brand_mentions" ("mention_position");--> statement-breakpoint

-- ─── citation_analysis ─────────────────────────────────────────────
-- One row per cited URL in an AI answer. category/subcategory are
-- LLM-classified — drives the Category → Subcategory → Domain → URL
-- 4-level tree in the Citation Sources view.
CREATE TABLE "citation_analysis" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "response_id" uuid NOT NULL,
  "prompt_id" uuid NOT NULL,
  "url" text NOT NULL,
  "domain" text NOT NULL,
  "title" text,
  "category" text,
  "subcategory" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "citation_analysis_response_idx" ON "citation_analysis" ("response_id");--> statement-breakpoint
CREATE INDEX "citation_analysis_prompt_idx" ON "citation_analysis" ("prompt_id");--> statement-breakpoint
CREATE INDEX "citation_analysis_domain_idx" ON "citation_analysis" ("domain");--> statement-breakpoint
CREATE INDEX "citation_analysis_category_idx" ON "citation_analysis" ("category");--> statement-breakpoint

-- ─── tracked_brands (alias 카탈로그) ────────────────────────────────
-- Per-project. canonical_name = displayed brand; aliases = alternate
-- spellings the pipeline matches. Drives "+N" alias merge badge.
CREATE TABLE "tracked_brands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "canonical_name" text NOT NULL,
  "aliases" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "tracked_brands_project_idx" ON "tracked_brands" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_brands_project_canonical_unique" ON "tracked_brands" ("project_id", "canonical_name");--> statement-breakpoint

-- ─── youtube_video_metadata ────────────────────────────────────────
-- Cache of channel info for citations whose domain = youtube.com.
-- video_id is the canonical key (extracted from URL by worker).
CREATE TABLE "youtube_video_metadata" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "video_id" text NOT NULL UNIQUE,
  "channel_title" text,
  "channel_id" text,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "youtube_video_metadata_channel_idx" ON "youtube_video_metadata" ("channel_id");
