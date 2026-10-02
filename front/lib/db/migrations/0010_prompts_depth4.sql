-- Hand-written migration (this repo authors migrations by hand from 0003 on;
-- drizzle-kit generate needs interactive prompts it can't get here).
--
-- prompts.depth4 — 4-th level taxonomy placeholder for HMG framework v0.5+. The
-- editorial team will start populating it once the column is decided; until
-- then every row stays NULL. Additive + nullable → safe online change.

-- IF NOT EXISTS keeps this idempotent if applied out-of-band (Supabase MCP)
-- ahead of drizzle's tracker.
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "depth4" text;
