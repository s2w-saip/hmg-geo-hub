-- scope_context_* — one-time mirror of scope's Automotive-industry
-- ConsumerContext/ConsumerRequirement corpus (2026-07-07). See lib/db/schema.ts
-- for the full rationale (scope's own context-map read API times out at this
-- corpus scale). Applied directly against hmg-geo's DB — migrations
-- 0021-0026 are on disk but not yet in meta/_journal.json (unrelated
-- in-flight work), so `npm run db:migrate` is not used for this one.

CREATE TABLE "scope_context_entities" (
  "id" uuid PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "canonical_name" text NOT NULL,
  "dimension" text,
  "mention_count" integer DEFAULT 0 NOT NULL,
  "utterance_count" integer DEFAULT 0 NOT NULL,
  "sentiment_positive" integer DEFAULT 0 NOT NULL,
  "sentiment_negative" integer DEFAULT 0 NOT NULL,
  "sentiment_neutral" integer DEFAULT 0 NOT NULL
);
CREATE INDEX "scope_context_entities_type_idx" ON "scope_context_entities" ("type");

CREATE TABLE "scope_context_drives" (
  "context_id" uuid NOT NULL,
  "requirement_id" uuid NOT NULL,
  "co_count" integer DEFAULT 0 NOT NULL,
  PRIMARY KEY ("context_id", "requirement_id")
);
CREATE INDEX "scope_context_drives_requirement_idx" ON "scope_context_drives" ("requirement_id");

CREATE TABLE "scope_context_combinations" (
  "cond_a" uuid NOT NULL,
  "cond_b" uuid NOT NULL,
  "co_count" integer DEFAULT 0 NOT NULL,
  PRIMARY KEY ("cond_a", "cond_b")
);

CREATE TABLE "scope_context_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_id" uuid NOT NULL,
  "utterance_id" uuid NOT NULL,
  "quote" text NOT NULL,
  "source_host" text,
  "source_url" text,
  "sentiment" text
);
CREATE INDEX "scope_context_evidence_entity_idx" ON "scope_context_evidence" ("entity_id");

CREATE TABLE "scope_context_domains" (
  "entity_id" uuid NOT NULL,
  "host" text NOT NULL,
  "n" integer DEFAULT 0 NOT NULL,
  PRIMARY KEY ("entity_id", "host")
);
