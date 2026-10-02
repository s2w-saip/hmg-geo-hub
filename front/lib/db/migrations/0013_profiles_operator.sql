-- Hand-written migration (this repo authors migrations by hand from 0003 on;
-- drizzle-kit generate needs interactive prompts it can't get here).
--
-- profiles.operator — 운영자(비용 게이트) 권한. role 과 직교(orthogonal): role 은
-- 데이터 가시성, operator 는 비용 유발 액션(프로젝트 생성·인텐트 수집·프롬프트
-- 실행)의 실행 가능 여부 (GGMD 유저 시나리오 3-2). NOT NULL DEFAULT 'none' 추가 —
-- 기존 행은 자동으로 none(조회 전용, 가장 안전한 기본값). additive only (0007 교훈).

DO $$ BEGIN
  CREATE TYPE "public"."operator_scope" AS ENUM('none', 'assigned', 'global');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "operator" "operator_scope" NOT NULL DEFAULT 'none';
