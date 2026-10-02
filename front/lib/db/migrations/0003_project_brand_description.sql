-- Hand-written migration: drizzle-kit can't tell whether `goal → description`
-- is a rename or drop+add without interactive prompts, so we spell it out.
-- 1) Rename `goal` → `description` to match the v23 form field semantics.
-- 2) Add a new `brand` text column (nullable; scope-filtered at submit).
-- Seed is the only existing producer of `goal`; renaming preserves any data
-- already loaded.

ALTER TABLE "projects" RENAME COLUMN "goal" TO "description";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brand" text;
