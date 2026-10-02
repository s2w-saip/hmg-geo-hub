-- Hand-written migration (this repo authors migrations by hand from 0003 on;
-- drizzle-kit generate needs interactive prompts it can't get here).
--
-- projects.ga4_property_id — per-project GA4 Data API property binding. A project
-- is a tracked-domain unit; its domain may NOT be in the central market catalog
-- (lib/ga4/property-map), so the project carries its own GA4 property. Resolution
-- is `project.ga4PropertyId ?? resolveProperty(brand, country)` — the project
-- value wins, the catalog is the fallback for cataloged markets (e.g. Kia/IT).
-- NULL = fall back to the catalog. Not a secret (access is gated by the OAuth
-- account's viewer grant); the OAuth credential stays in server-only env.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "ga4_property_id" text;
