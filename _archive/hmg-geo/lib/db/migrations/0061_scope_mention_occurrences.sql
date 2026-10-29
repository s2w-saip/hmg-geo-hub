-- 0061 — 답변 원문 감성 밑줄용 발생 단위 언급 미러 (scope#632).
-- additive-only · 멱등. 읽기는 mentionOccurrencesAvailable() 프로브 뒤에만 — 머지가
-- db:apply 보다 앞서는 창에서 42P01 로 답변 모달이 죽지 않게.
CREATE TABLE IF NOT EXISTS "scope_mention_occurrences" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"brand_rollup_entity_id" uuid,
	"turn_index" integer,
	"source_start" integer NOT NULL,
	"source_end" integer NOT NULL,
	"surface_text" text NOT NULL,
	"sentiment" text NOT NULL,
	"mention_role" text,
	"assertion" text,
	"context_snippet" text,
	"descriptors" text[] DEFAULT '{}' NOT NULL,
	"criteria" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_mention_occurrences_job_idx" ON "scope_mention_occurrences" USING btree ("job_id");
--> statement-breakpoint
REVOKE ALL ON "scope_mention_occurrences" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON SEQUENCE "scope_mention_occurrences_id_seq" FROM PUBLIC, anon, authenticated;
