-- Hand-written migration (this repo authors migrations by hand from 0003 on;
-- drizzle-kit generate needs interactive prompts it can't get here, and the
-- meta snapshots are not kept in sync).
--
-- keyword_volume_cache — caches DataForSEO Google Ads search-volume responses
-- per (keyword, location, language, sort) so /admin/keyword-tools doesn't re-pay
-- for repeat lookups. NOT scope-gated (public Google data, no brand/region axis)
-- and treated as BEST-EFFORT by lib/keyword/service.ts: the feature works even
-- if this table is absent (every lookup just hits the API). Ported from
-- aeorank's keyword_search_volume_cache.
--
-- IF NOT EXISTS keeps it idempotent if applied out-of-band (Supabase MCP / psql)
-- ahead of drizzle's tracker.

CREATE TABLE IF NOT EXISTS "keyword_volume_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "keyword" text NOT NULL,
  "location_code" integer,
  "language_code" text,
  "sort_by" text DEFAULT 'search_volume' NOT NULL,
  "search_volume" integer,
  "competition" text,
  "competition_index" integer,
  "cpc" real,
  "low_top_of_page_bid" real,
  "high_top_of_page_bid" real,
  "monthly_searches" jsonb,
  "raw_data" jsonb,
  "success" boolean DEFAULT false NOT NULL,
  "error_message" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "keyword_volume_cache_keyword_idx" ON "keyword_volume_cache" ("keyword");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keyword_volume_cache_expires_idx" ON "keyword_volume_cache" ("expires_at");
