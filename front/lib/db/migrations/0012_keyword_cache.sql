-- Hand-written migration (this repo authors migrations by hand from 0003 on).
--
-- keyword_cache — generic payload cache for the Google Keyword intent view so a
-- page refresh is a cache hit, not a re-paid DataForSEO (SERP + volume) +
-- OpenRouter (prompt drafting) round-trip. Keyed by an opaque string
-- ("insight|term|loc|lang", "related|term|loc|lang"). NOT scope-gated (public
-- keyword data); best-effort (lib/keyword/cache.ts disables itself if absent).
--
-- IF NOT EXISTS keeps it idempotent if applied out-of-band (Supabase MCP / psql).

CREATE TABLE IF NOT EXISTS "keyword_cache" (
  "cache_key" text PRIMARY KEY,
  "payload" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
