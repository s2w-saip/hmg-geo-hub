-- 0042: 프로젝트 AI 엔진 선택 + 변경 이력 (feature: project-ai-engine-selection).
-- Applied via `npm run db:apply -- 0042` (0021+는 수동 멱등 SQL — apply-migration.ts).
-- projects ALTER는 nullable ADD COLUMN 1개뿐 — 테이블 재작성 없음(0007 교훈 준수).
--   ai_engines NULL = 레거시(미지정 → scope 기본 chatgpt·gemini로 측정 중),
--   '{}' = 명시적 전부 해제. 어휘: lib/scope/engines.ts (chatgpt/gemini/deepseek).
-- project_engine_history: append-only, 행 = 저장 시점의 전체 선택 집합. NO FK
-- (0033·0041 선례) — 프로젝트 삭제는 리포지터리가 함께 지운다.
--
-- ⚠️ LOCKDOWN COVERAGE (0033 선례와 동일): 신규 테이블은 lockdown.sql 재실행
-- 전까지 anon/authenticated 가드가 없다. 적용 후 재실행 + 확인:
--   SELECT has_table_privilege('anon','public.project_engine_history','SELECT');  -- expect false
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "ai_engines" text[];--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_engine_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL,
  "engines" text[] NOT NULL,
  "changed_by" uuid,
  "changed_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_engine_history_project_idx" ON "project_engine_history" ("project_id","changed_at" DESC);--> statement-breakpoint
REVOKE UPDATE, DELETE ON "project_engine_history" FROM PUBLIC, anon, authenticated;
