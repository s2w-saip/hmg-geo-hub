-- KPI #16 (경쟁사 대비 SOV 비율) — 타겟 경쟁사 지정.
-- 하이브리드 정책 (2026-07-02 결정): is_target 지정 시 그 브랜드가 분모 고정,
-- 미지정 프로젝트/표준 대시보드는 집계 시점에 SOV 1위 외부 브랜드 자동 선택.
-- partial unique index 로 프로젝트당 타겟 1개를 DB 레벨에서 보장한다.

ALTER TABLE "tracked_competitors"
  ADD COLUMN IF NOT EXISTS "is_target" boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "tracked_competitors_one_target_per_project"
  ON "tracked_competitors" ("project_id") WHERE "is_target";
