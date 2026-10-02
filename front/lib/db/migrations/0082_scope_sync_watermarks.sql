-- 0082: 미러 싱크 증분 읽기 워터마크 (fix: 루트 프로젝트 크론 정지).
-- Applied only via `npm run db:apply -- 0082` (수동 멱등 SQL — db:migrate 금지).
-- 번호: 통합 프리뷰가 0081(저널 idx 70)까지 쓰고, 미머지 feat/core-view-anchor 가
-- 0074·0076 을 쓴다 → 0082 · idx 71 · when = 직전 + 86,400,000.
--
-- 배경(2026-09-27 17:20Z~): 루트 프로젝트(prompts ~12,446 · runs ~8,681)는 매 틱
-- listPrompts 50페이지 + listMeasurementRuns 50페이지를 **처음부터 전부** 읽다가
-- `Scope read deadline exceeded` 로 쓰기 단계에 못 갔다 — 신규 run 이 크론으로 안 들어온다.
-- 이 표는 "어디까지 읽었다고 믿어도 되는가"를 프로젝트별로 남겨, 다음 패스가 그
-- 뒤만 읽게 한다. 판정 규칙의 정본은 lib/scope/mirror/sync.ts 주석.
--
--   prompts_synced_through    이 시각 이전 갱신분은 전부 upsert 됐다(단조, GREATEST).
--   prompts_resume_*          한 틱 상한을 넘은 프롬프트 창의 이어 읽기 지점(커서·창 하한·창 시작 시각).
--   runs_floor_run_ids        run 목록 정착 경계 앵커(연속 K개 — 하나만 만나도 통과).
--   runs_floor_snapshot_at    그 floor 를 계산한 목록 읽기 시작 시각. 더 새 스냅샷만 덮어쓴다.
--
-- additive-only: 신규 테이블 1개, 기존 테이블 ALTER 없음(0007 교훈). scope_sync_cursors 에
-- 컬럼을 더하지 않은 이유 — 그 표는 크론이 20분마다 쓰므로 ALTER 의 ACCESS EXCLUSIVE 가
-- 크론 tx 와 경합한다. 신규 CREATE TABLE 은 기존 표에 락을 잡지 않는다.
--
-- 코드는 이 표가 없어도 돈다(column-availability 프로브 → 종전 전량 읽기, 쓰기 없음).
-- 그래서 배포와 적용 순서가 뒤바뀌어도 안전하다.
--
-- ⚠️ LOCKDOWN COVERAGE (0043 선례): 적용 후 확인:
--   SELECT has_table_privilege('anon','public.scope_sync_watermarks','SELECT');  -- expect false
CREATE TABLE IF NOT EXISTS "scope_sync_watermarks" (
  "project_id" uuid PRIMARY KEY,
  "prompts_synced_through" timestamp with time zone,
  "prompts_resume_cursor" text,
  "prompts_resume_from" timestamp with time zone,
  "prompts_resume_started_at" timestamp with time zone,
  "runs_floor_run_ids" uuid[],
  "runs_floor_snapshot_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
REVOKE ALL ON "scope_sync_watermarks" FROM PUBLIC, anon, authenticated;
