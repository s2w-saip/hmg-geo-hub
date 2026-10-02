-- scope_context_prompt_cache — per-project cache of the LLM-generated candidate
-- prompts derived from the context map (decision B, 2026-07-09). See
-- lib/db/schema.ts / lib/social-scraping/generate-context-prompts.ts for the
-- rationale. Like 0027, applied directly against hmg-geo's DB (0021-0026 are on
-- disk but not in meta/_journal.json — in-flight work — so `npm run db:migrate`
-- is not used for this one).

CREATE TABLE IF NOT EXISTS "scope_context_prompt_cache" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text,
  "generated_at" timestamptz DEFAULT now() NOT NULL
);

-- Compensating control (no RLS): revoke anon/PostgREST access, matching
-- scripts/db/lockdown.sql for the other tables.
REVOKE ALL ON "scope_context_prompt_cache" FROM anon;
