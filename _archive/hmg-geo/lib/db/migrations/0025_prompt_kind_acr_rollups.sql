-- ACR(AI's Choice Rate) 도입 — ① 카탈로그 프롬프트에 측정 종류(kind) 태그,
-- ② scope의 prompt-run 단위 ACR 롤업(analysis.acr_summary)을 담는 미러 테이블.
-- scope 쪽은 prompts.kind('single'|'acr')를 이미 공개 API로 지원한다(0065).
-- 로컬 kind가 정본이고 scope에는 push로 반영한다 (scripts/scope/push-acr-kind.ts,
-- admin 카탈로그 토글).

ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'single';--> statement-breakpoint
ALTER TABLE "prompts" DROP CONSTRAINT IF EXISTS "prompts_kind_check";--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_kind_check" CHECK ("kind" IN ('single', 'acr'));--> statement-breakpoint

-- scope_acr_rollups: 한 행 = (ACR prompt-run × 엔티티) 롤업. scope jobs 피드의
-- analysis.acr_summary.rows[]를 prompt_run_id로 dedup해 미러링한다 (같은
-- prompt-run의 반복 job 10개가 동일 rows를 반복 반환하므로).
-- prompt_id/target/region/measured_at은 그 prompt-run의 job에서 비정규화 —
-- 표준 필터(엔진/지역/카탈로그 축)와 "최신 주기" dedup을 SQL로 돌리기 위함.
CREATE TABLE IF NOT EXISTS "scope_acr_rollups" (
  "prompt_run_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "prompt_id" uuid,
  "target" text,
  "region" text,
  "measured_at" timestamp with time zone,
  "rollup_level" text,
  "brand" text,
  "parent_brand" text,
  "brand_rollup_entity_id" uuid,
  "entity_type" text,
  "planned_iterations" integer NOT NULL DEFAULT 0,
  "valid_turn1_iterations" integer NOT NULL DEFAULT 0,
  "valid_acr_iterations" integer NOT NULL DEFAULT 0,
  "appearance_count" integer NOT NULL DEFAULT 0,
  "choice_count" integer NOT NULL DEFAULT 0,
  "conditional_choice_count" integer NOT NULL DEFAULT 0,
  "off_shortlist_choice_count" integer NOT NULL DEFAULT 0,
  "unresolved_choice_count" integer NOT NULL DEFAULT 0,
  "generic_choice_count" integer NOT NULL DEFAULT 0,
  "appearance_rate" real,
  "acr" real,
  "overall_choice_share" real,
  "co_single_entity" integer NOT NULL DEFAULT 0,
  "co_conditional_multiple" integer NOT NULL DEFAULT 0,
  "co_generic_category" integer NOT NULL DEFAULT 0,
  "co_resolved_off_shortlist" integer NOT NULL DEFAULT 0,
  "co_unresolved_choice" integer NOT NULL DEFAULT 0,
  "co_none" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("prompt_run_id", "entity_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "scope_acr_rollups_run_idx" ON "scope_acr_rollups" ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_acr_rollups_prompt_idx" ON "scope_acr_rollups" ("prompt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_acr_rollups_brand_rollup_idx" ON "scope_acr_rollups" ("brand_rollup_entity_id");--> statement-breakpoint
