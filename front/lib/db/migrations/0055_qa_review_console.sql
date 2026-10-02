-- 0055: Raw Data QA Console — 검수 산출물 4개 테이블 + 목록 커서 인덱스.
-- 적용: npm run db:apply -- 0055   (drizzle-kit migrate 금지)
--
-- 설계 정본: docs/specs/2026-09-04-raw-data-qa-console-design.md
--
-- ── 왜 FK 가 없는가 ──────────────────────────────────────────────────────────
-- 검수 기록은 scope_answers.job_id 를 가리키지만 FK 로 묶지 않는다.
-- scope-mirror.ts::replaceRun 은 run 단위 delete+insert 라, FK(ON DELETE CASCADE)가
-- 있으면 **정규 재싱크가 사람이 쌓은 검수 기록을 통째로 지운다.**
-- 0053(앵커)·0054(드롭)가 같은 이유로 미러 밖 독립 테이블인 것과 같은 논리다.
-- job_id 는 scope 가 발급한 안정 식별자라, 재싱크 후에도 같은 값으로 돌아와 기록이 붙는다.
-- 드롭된 답변의 검수 행은 고아로 남지만 **지우지 않는다** — 검수 이력은 감사 기록이고,
-- 목록은 scope_answers 와 inner join 이라 화면에는 나타나지 않는다.
--
-- additive-only: 신규 테이블 4개 + 신규 인덱스. 기존 테이블 ALTER 없음.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- 게이트 통과 1회 = 1행. 락 소유자 식별 + 사후 감사의 근거.
-- ip_hash 는 HMAC(RAW_DATA_QA_SECRET, ip) — 원문 IP 는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS "qa_review_sessions" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "reviewer_name" text NOT NULL,
  "started_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "user_agent"    text,
  "ip_hash"       text
);--> statement-breakpoint

-- 한 답변 = 한 행. 행이 없으면 미검수.
-- status 는 파생값 — section_flags 에 'issue' 가 하나라도 있으면 'issue'.
CREATE TABLE IF NOT EXISTS "qa_answer_reviews" (
  "job_id"        uuid PRIMARY KEY,
  "status"        text NOT NULL,
  "section_flags" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "reviewer_name" text NOT NULL,
  "session_id"    uuid,
  "reviewed_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "qa_answer_reviews_status_ck" CHECK ("status" IN ('ok','issue'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_answer_reviews_status_idx"   ON "qa_answer_reviews" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_answer_reviews_reviewer_idx" ON "qa_answer_reviews" ("reviewer_name");--> statement-breakpoint

-- 낱알 단위 노트. target_label 은 스냅샷 — 재싱크로 scope_citations.id(bigserial)가
-- 바뀌면 target_key 만으로는 무엇을 지목했는지 영구히 알 수 없게 된다.
CREATE TABLE IF NOT EXISTS "qa_review_notes" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_id"        uuid NOT NULL,
  "target_kind"   text NOT NULL,
  "target_key"    text,
  "target_label"  text,
  "severity"      text NOT NULL DEFAULT 'issue',
  "body"          text NOT NULL,
  "reviewer_name" text NOT NULL,
  "session_id"    uuid,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at"   timestamp with time zone,
  "resolved_by"   text,
  CONSTRAINT "qa_review_notes_kind_ck"     CHECK ("target_kind" IN ('answer','prompt','mention','citation','acr','meta')),
  CONSTRAINT "qa_review_notes_severity_ck" CHECK ("severity"    IN ('issue','question','info'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_review_notes_job_idx"        ON "qa_review_notes" ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_review_notes_created_idx"    ON "qa_review_notes" ("created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_review_notes_unresolved_idx" ON "qa_review_notes" ("resolved_at") WHERE "resolved_at" IS NULL;--> statement-breakpoint

-- 동시 검수 방지. 획득은 애플리케이션이 아니라 이 표의 ON CONFLICT ... WHERE 가 정한다
-- (qa-review.ts::acquireLock) — read-then-write 로 나누면 두 검수자가 같은 답변을
-- 동시에 여는 창이 생긴다.
CREATE TABLE IF NOT EXISTS "qa_answer_locks" (
  "job_id"        uuid PRIMARY KEY,
  "session_id"    uuid NOT NULL,
  "reviewer_name" text NOT NULL,
  "acquired_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "heartbeat_at"  timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_answer_locks_heartbeat_idx" ON "qa_answer_locks" ("heartbeat_at");--> statement-breakpoint

-- 검수 목록의 정렬(measured_at DESC, job_id)을 받치는 인덱스. 기존 scope_answers
-- 인덱스는 run/target/region 뿐이라 이 커서 페이지네이션을 받쳐주지 못한다
-- (모집단이 미러 전체 = 십수만 행).
CREATE INDEX IF NOT EXISTS "scope_answers_measured_cursor_idx"
  ON "scope_answers" ("measured_at" DESC, "job_id");--> statement-breakpoint

-- ⚠️ LOCKDOWN COVERAGE (0053·0054 와 동일): 신규 테이블은 lockdown.sql 재실행
-- 전까지 anon/authenticated 가드가 없다. 이 콘솔은 공개 라우트를 쓰므로 특히 중요하다.
REVOKE ALL ON "qa_review_sessions" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "qa_answer_reviews"  FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "qa_review_notes"    FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "qa_answer_locks"    FROM PUBLIC, anon, authenticated;

-- ── 적용 후 검증 (읽기) ───────────────────────────────────────────────────────
--   SELECT has_table_privilege('anon','public.qa_answer_reviews','SELECT'); -- expect false
--   SELECT has_table_privilege('anon','public.qa_review_notes','SELECT');   -- expect false
--   SELECT count(*) FROM qa_answer_locks;                                    -- expect 0
