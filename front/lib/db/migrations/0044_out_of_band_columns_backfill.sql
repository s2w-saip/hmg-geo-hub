-- 저널 밖에서 추가된 컬럼을 리포로 회수한다 (드리프트 상환, 2026-08-21).
--
-- 배경: 아래 14개 컬럼은 lib/db/schema.ts 와 운영 DB 에는 있지만 어떤
-- 마이그레이션 파일에도 DDL 이 없다 — Supabase 대시보드/MCP 로 직접
-- 적용되고 리포에는 흔적이 안 남았다. 그래서 "0000~0043 을 순서대로 돌린
-- DB" 는 schema.ts 와 다른 모양이 된다(신규 환경 구축이 조용히 깨진다).
--
-- 운영 DB 에서 이 파일은 **전부 no-op** 이다 (IF NOT EXISTS). 존재 이유는
-- 신규/온프렘 환경이 schema.ts 와 같은 모양으로 만들어지게 하는 것뿐이다.
-- 컬럼 타입은 schema.ts 를 정본으로 삼았다 — 운영 DB 의 실제 타입이 다르면
-- IF NOT EXISTS 라 여기서는 조용히 넘어가므로, `npm run db:drift` 로 별도
-- 확인한다.
--
-- 적용: npm run db:apply -- 0044

ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "list_type" text;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "depth1" text;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "depth2" text;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "depth3" text;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "funnel_stage" text;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "brand" text;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "scope_prompt_id" uuid;--> statement-breakpoint

ALTER TABLE "scope_mentions" ADD COLUMN IF NOT EXISTS "brand_rollup_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "scope_mentions" ADD COLUMN IF NOT EXISTS "surfaces" text[];--> statement-breakpoint
ALTER TABLE "scope_mentions" ADD COLUMN IF NOT EXISTS "type_mention" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "scope_mentions" ADD COLUMN IF NOT EXISTS "type_recommendation" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "scope_mentions" ADD COLUMN IF NOT EXISTS "type_comparison" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "scope_mentions" ADD COLUMN IF NOT EXISTS "type_definition" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "scope_mentions" ADD COLUMN IF NOT EXISTS "type_final_choice" integer NOT NULL DEFAULT 0;
