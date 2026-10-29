-- 0043: 미러 싱크 로테이션 커서 (fix: 뒷순번 프로젝트 영구 기아).
-- Applied via `npm run db:apply -- 0043` (0021+는 수동 멱등 SQL — apply-migration.ts).
--
-- 배경: sync.ts 의 oldest-first 로테이션 키가 `max(scope_runs.synced_at)` =
-- "마지막으로 run 을 **쓴** 시각"이었다. 쓸 게 없어서 아무것도 안 쓴 프로젝트는
-- 키가 영원히 안 움직여 매 패스 앞순번을 그대로 점유하고, 반대로 실제로 쓴
-- 프로젝트만 뒤로 밀린다 — 로테이션이 사실상 정지한다. 대상 176개 중 매 패스
-- 250s 예산으로 ~74개만 도달(2026-08-20 실측 로그: deferred 89·102)하므로,
-- 뒷순번은 영구히 미도달이었다(GENESIS GV80 HEV 1.1v: 2026-08-12 이후 정지).
--
-- 이 테이블은 "마지막으로 **시도한** 시각"을 기록한다 — 성공·실패·무작업 전부.
-- additive-only(신규 테이블 1개, 기존 테이블 ALTER 없음 — 0007 교훈 준수).
--
-- ⚠️ LOCKDOWN COVERAGE (0033·0042 선례와 동일): 신규 테이블은 lockdown.sql
-- 재실행 전까지 anon/authenticated 가드가 없다. 적용 후 재실행 + 확인:
--   SELECT has_table_privilege('anon','public.scope_sync_cursors','SELECT');  -- expect false
CREATE TABLE IF NOT EXISTS "scope_sync_cursors" (
  "project_id" uuid PRIMARY KEY,
  "last_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_error" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_sync_cursors_attempt_idx" ON "scope_sync_cursors" ("last_attempt_at");--> statement-breakpoint
REVOKE ALL ON "scope_sync_cursors" FROM PUBLIC, anon, authenticated;
