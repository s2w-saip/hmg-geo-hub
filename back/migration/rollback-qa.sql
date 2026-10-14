-- ============================================================================
-- QA 검수 기록 이관 되돌리기(2026-10-14): 원장(mig_src.qa_carry_ledger) 기준으로 migrate-qa.sql 이 app 에 쓴 행을 지운다.
--   원장 행마다 app 행 지문(qa_*_hash) = 원장 dst_hash 이면 app 행과 원장 행을 지운다(rollback_delete).
--   지문이 다르면(전환 뒤 back 에서 수정) app 행·원장 행을 남기고 보고한다(rollback_keep_edited). app 행이 이미 없으면 원장만 정리(rollback_forget).
--   back 에서 새로 만든 행(원장 밖)·락·세션은 건드리지 않는다. overwrite_foreign 으로 덮은 back 행은 원래 값이 없어 지워진다(보고의 원장 행).
-- 서비스 되돌리기(프론트 HGH_SOURCE_G7=legacy + 레거시 RAW_DATA_QA_ENABLED=1)와 함께 쓴다. 전환 뒤 back 에만 쓴 판정·노트는 레거시에 없으므로
--   출력 'back_only' 집계를 보고 수동 재입력한다(역번역 = 원장 legacy_key·new_key, 이 실행 전 원장을 보관해 둔다).
-- 선행: mig_src_qa.sql(원장·보고 표, 지문 함수). 실행 롤: 소유자(admin).
--
-- 사용(드라이런이 기본: 끝에서 ROLLBACK):
--   psql -X -v ON_ERROR_STOP=1 -f rollback-qa.sql                                                    # 드라이런: 지울 행·남길 행 집계
--   psql -X -v ON_ERROR_STOP=1 -v expect_reviews=29 -v expect_notes=70 -v commit=1 -f rollback-qa.sql   # 드라이런과 같은 삭제 수일 때만 COMMIT
--   expect_reviews·expect_notes = 이번 실행에서 app 에서 지울 행 수(rollback_delete, 기본 -1 = 검사 안 함)
-- ============================================================================
\if :{?expect_reviews}
\else
\set expect_reviews -1
\endif
\if :{?expect_notes}
\else
\set expect_notes -1
\endif
\set QUIET on
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT set_config('qa.expect_reviews', :'expect_reviews', true) AS e1, set_config('qa.expect_notes', :'expect_notes', true) AS e2 \gset qa_
\set QUIET off

DO $a$ BEGIN
  IF to_regclass('mig_src.qa_carry_ledger') IS NULL OR to_regclass('mig_src.qa_carry_report') IS NULL
     OR to_regprocedure('mig_src.qa_review_hash(uuid,text,text,text,text,text,text,uuid,text,uuid,timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('mig_src.qa_note_hash(uuid,uuid,text,text,text,text,text,uuid,text,uuid,timestamptz,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'mig_src QA 원장·지문 함수 없음: 되돌릴 근거가 없다(mig_src 가 이미 정리됐으면 롤백 창이 닫힌 것)';
  END IF;
END $a$;

LOCK TABLE app.qa_answer_review, app.qa_review_note IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _rb_pre ON COMMIT DROP AS
SELECT clock_timestamp() AS run_at, (SELECT count(*) FROM app.qa_answer_lock) AS locks, (SELECT count(*) FROM app.qa_review_session) AS sessions;

CREATE TEMP TABLE _rb ON COMMIT DROP AS
SELECT q.*, CASE WHEN NOT q.in_app THEN 'rollback_forget' WHEN q.cur_hash = q.dst_hash THEN 'rollback_delete' ELSE 'rollback_keep_edited' END AS action
  FROM (SELECT l.kind, l.key, l.job_id, l.dst_hash, l.legacy_key, l.new_key, l.map_status,
               (a.job_id IS NOT NULL OR n.note_id IS NOT NULL) AS in_app,
               CASE WHEN a.job_id IS NOT NULL THEN mig_src.qa_review_hash(a.job_id, a.flag_answer, a.flag_prompt, a.flag_mentions, a.flag_citations,
                                                                          a.flag_acr, a.flag_meta, a.reviewer_id, a.reviewer_name, a.session_id,
                                                                          a.reviewed_at, a.updated_at)
                    WHEN n.note_id IS NOT NULL THEN mig_src.qa_note_hash(n.note_id, n.job_id, n.target_kind, n.target_key, n.target_label, n.severity,
                                                                         n.body, n.reviewer_id, n.reviewer_name, n.session_id, n.created_at,
                                                                         n.resolved_at, n.resolved_by) END AS cur_hash
          FROM mig_src.qa_carry_ledger l
          LEFT JOIN app.qa_answer_review a ON l.kind = 'review' AND a.job_id = l.key
          LEFT JOIN app.qa_review_note n ON l.kind = 'note' AND n.note_id = l.key) q;

CREATE TEMP TABLE _rb_res (kind text NOT NULL, n bigint NOT NULL) ON COMMIT DROP;
WITH d AS (DELETE FROM app.qa_answer_review a USING _rb x WHERE x.kind = 'review' AND x.action = 'rollback_delete' AND a.job_id = x.key
           RETURNING a.job_id)
INSERT INTO _rb_res SELECT 'review', count(*) FROM d;
WITH d AS (DELETE FROM app.qa_review_note a USING _rb x WHERE x.kind = 'note' AND x.action = 'rollback_delete' AND a.note_id = x.key
           RETURNING a.note_id)
INSERT INTO _rb_res SELECT 'note', count(*) FROM d;
DELETE FROM mig_src.qa_carry_ledger l USING _rb x
 WHERE l.kind = x.kind AND l.key = x.key AND x.action IN ('rollback_delete', 'rollback_forget');
INSERT INTO mig_src.qa_carry_report (run_at, kind, key, job_id, action, map_status, detail)
SELECT p.run_at, x.kind, x.key, x.job_id, x.action, x.map_status,
       jsonb_strip_nulls(jsonb_build_object('legacy_key', x.legacy_key, 'new_key', x.new_key))
  FROM _rb x CROSS JOIN _rb_pre p;

DO $a$ DECLARE
  p record; n bigint; dr bigint; dn bigint; pr bigint; pn bigint;
  e_r int := current_setting('qa.expect_reviews')::int; e_n int := current_setting('qa.expect_notes')::int;
BEGIN
  SELECT * INTO p FROM _rb_pre;
  SELECT x.n INTO dr FROM _rb_res x WHERE x.kind = 'review';
  SELECT x.n INTO dn FROM _rb_res x WHERE x.kind = 'note';
  SELECT count(*) FILTER (WHERE kind = 'review' AND action = 'rollback_delete'), count(*) FILTER (WHERE kind = 'note' AND action = 'rollback_delete')
    INTO pr, pn FROM _rb;
  IF dr <> pr OR dn <> pn THEN RAISE EXCEPTION '삭제(리뷰 %·노트 %) <> 계획(%·%)', dr, dn, pr, pn; END IF;
  IF e_r >= 0 AND dr <> e_r THEN RAISE EXCEPTION '리뷰 삭제 % <> 기대 %(드라이런과 다름)', dr, e_r; END IF;
  IF e_n >= 0 AND dn <> e_n THEN RAISE EXCEPTION '노트 삭제 % <> 기대 %(드라이런과 다름)', dn, e_n; END IF;
  -- 남은 원장 = back 수정으로 남긴 행뿐
  SELECT count(*) INTO n FROM mig_src.qa_carry_ledger l
   WHERE NOT EXISTS (SELECT 1 FROM _rb x WHERE x.kind = l.kind AND x.key = l.key AND x.action = 'rollback_keep_edited');
  IF n <> 0 THEN RAISE EXCEPTION '되돌린 뒤 남은 원장 행 %건(수정 보존 행 밖)', n; END IF;
  IF (SELECT count(*) FROM app.qa_answer_lock) <> p.locks OR (SELECT count(*) FROM app.qa_review_session) <> p.sessions THEN
    RAISE EXCEPTION 'app.qa_answer_lock·app.qa_review_session 행 수가 바뀜: 동결 창에서 다시 실행';
  END IF;
  RAISE NOTICE 'QA_ROLLBACK_OK reviews del=% · notes del=% · keep_edited=% · forget=%', dr, dn,
    (SELECT count(*) FROM _rb WHERE action = 'rollback_keep_edited'), (SELECT count(*) FROM _rb WHERE action = 'rollback_forget');
END $a$;

SELECT 'summary' AS t, kind, action, count(*) AS n FROM _rb GROUP BY kind, action ORDER BY kind DESC, action;
-- 원장 밖 app 행(back 에서 새로 생긴 판정·노트: 남는다, 레거시로 되돌릴 때 수동 재입력 대상)
SELECT 'back_only' AS t, 'review' AS kind, count(*) AS n FROM app.qa_answer_review a
 WHERE NOT EXISTS (SELECT 1 FROM mig_src.qa_carry_ledger l WHERE l.kind = 'review' AND l.key = a.job_id)
UNION ALL
SELECT 'back_only', 'note', count(*) FROM app.qa_review_note a
 WHERE NOT EXISTS (SELECT 1 FROM mig_src.qa_carry_ledger l WHERE l.kind = 'note' AND l.key = a.note_id);

\if :{?commit}
COMMIT;
SELECT 'mode', 'COMMIT';
\else
ROLLBACK;
SELECT 'mode', 'ROLLBACK(드라이런)';
\endif
