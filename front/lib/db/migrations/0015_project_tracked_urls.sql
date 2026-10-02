-- project_tracked_urls: KPI ⑥ AI 타겟 URL 인용률을 측정하기 위한 프로젝트별
-- 추적 URL 리스트. (2026-06-22) URL = 정확한 경로(canonical full path).
-- KPI 매칭은 exact equality.

CREATE TABLE IF NOT EXISTS "project_tracked_urls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL,
  "url" text NOT NULL,
  "label" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Lookup index: list/match queries are always per-project.
CREATE INDEX IF NOT EXISTS "project_tracked_urls_project_idx"
  ON "project_tracked_urls" ("project_id");

-- Same project should not have the same URL twice.
CREATE UNIQUE INDEX IF NOT EXISTS "project_tracked_urls_project_url_unique"
  ON "project_tracked_urls" ("project_id", "url");
