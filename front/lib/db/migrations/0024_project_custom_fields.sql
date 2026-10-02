-- 프로젝트별 사용자 정의 커스텀 필드 (다이나믹 스키마).
-- 브랜드/listType/Depth1~4/퍼널단계 같은 HMG 고정 taxonomy와는 완전히 별도의
-- 병행 시스템 — 기존 컬럼/테이블은 건드리지 않는다.

CREATE TABLE IF NOT EXISTS "project_custom_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "label" text NOT NULL,
  "type" text NOT NULL,
  "options" text[],
  "archived" boolean DEFAULT false NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "project_custom_fields_project_label_unique"
  ON "project_custom_fields" ("project_id", "label");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "prompt_custom_field_values" (
  "prompt_id" uuid NOT NULL,
  "field_id" uuid NOT NULL,
  "value" text NOT NULL,
  PRIMARY KEY ("prompt_id", "field_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "prompt_custom_field_values_field_idx"
  ON "prompt_custom_field_values" ("field_id");--> statement-breakpoint
