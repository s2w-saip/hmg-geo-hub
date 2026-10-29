-- 0041: 글로벌 카탈로그 감사 원장 + soft-delete/수정자 컬럼 (catalog-prompt-audit).
-- Applied via `npm run db:apply -- 0041` (0021+는 수동 멱등 SQL — apply-migration.ts).
-- append-only: 리포지터리에 update/delete 메서드가 없고, 비서버 롤은 아래 REVOKE.
-- (앱 접속 롤이 owner인 환경에서는 DB 수준 차단이 불완전 — 코드 경계가 1차 방어.)
-- NO FK (DELIBERATE, 0033 선례): 이력은 프롬프트·계정이 사라져도 남아야 한다.
-- prompts ALTER는 nullable ADD COLUMN 2개뿐 — 테이블 재작성 없음(0007 교훈 준수).
--
-- ⚠️ LOCKDOWN COVERAGE (0033 선례와 동일): 신규 테이블은 lockdown.sql 재실행
-- 전까지 anon/authenticated 가드가 없다. 적용 후 재실행 + 확인:
--   SELECT has_table_privilege('anon','public.prompt_audit_logs','SELECT');  -- expect false
CREATE TABLE IF NOT EXISTS "prompt_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "prompt_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "actor_id" uuid,
  "actor_type" text NOT NULL DEFAULT 'user',
  "event_type" text NOT NULL,
  "changes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "batch_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "prompt_audit_logs" DROP CONSTRAINT IF EXISTS "prompt_audit_logs_event_type_check";--> statement-breakpoint
ALTER TABLE "prompt_audit_logs" ADD CONSTRAINT "prompt_audit_logs_event_type_check"
  CHECK ("event_type" IN ('created','text_updated','meta_updated','enabled_changed','kind_changed','deleted','restored'));--> statement-breakpoint
ALTER TABLE "prompt_audit_logs" DROP CONSTRAINT IF EXISTS "prompt_audit_logs_actor_type_check";--> statement-breakpoint
ALTER TABLE "prompt_audit_logs" ADD CONSTRAINT "prompt_audit_logs_actor_type_check"
  CHECK ("actor_type" IN ('user','system'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_audit_logs_prompt_idx" ON "prompt_audit_logs" ("prompt_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_audit_logs_project_idx" ON "prompt_audit_logs" ("project_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_audit_logs_batch_idx" ON "prompt_audit_logs" ("batch_id");--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "prompt_audit_logs" FROM PUBLIC, anon, authenticated;
