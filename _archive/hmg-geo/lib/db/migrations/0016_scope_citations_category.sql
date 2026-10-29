-- Hand-written migration (this repo authors migrations by hand from 0003 on;
-- drizzle-kit generate needs interactive prompts it can't get here).
--
-- scope_citations.category — re-mirror scope's domain-classifier category so the
-- standard (mirror) Citation Sources card/pie/badge populate (live·mirror
-- parity). Restores ONLY category (subcategory 폐기 — 4-tier tree dropped).
-- Additive + nullable → existing rows stay valid as "—" (0007 lesson).

ALTER TABLE "scope_citations" ADD COLUMN IF NOT EXISTS "category" text;
