-- ============================================================================
-- QA 검수 기록 이관(2026-10-14): mig_src.qa_answer_reviews·qa_review_notes(레거시 스냅샷) → app.qa_answer_review·app.qa_review_note.
--   리뷰 1:1(키 job_id 그대로): section_flags jsonb → flag_* 6열(6키의 ok/issue 만), status 는 GENERATED 라 넣지 않고 레거시 값과 같은지 단언한다.
--   노트 1:1(note_id = 레거시 id 그대로): 인용 노트 키만 번역한다(레거시 scope_citations.id → 'job_id:ord'). 멘션(entity_id)·ACR
--   (prompt_run_id:entity_id) 키는 형식·값이 같아 그대로 둔다. 시각(reviewed_at·updated_at·created_at·resolved_at)은 원천 값 그대로(now() 아님).
--   reviewer_id·session_id 는 NULL(계정 없는 검수자 Q17, 세션 미이관 = back 로그아웃 뒤 상태). 작성자는 reviewer_name 스냅샷.
--   rd.job 에 없는 job(새 고아)·레거시에서도 고아인 job·서버 검수 범위 밖 job 도 이관한다(FK 없음, 0055 원칙). verify-qa.sql V9 가 보고한다.
-- 인용 노트 키 번역(map_status, 원장·보고에 남긴다)
--   nokey          키 NULL(블록 노트)                                         → NULL
--   cit_mapped     숫자 키 ∧ 레거시 참조에 (job, id) 있음 ∧ 새 ord 행 url 같음   → job_id:ord
--   cit_unverified 위와 같은데 job 이 rd.job 에 없음(대조 불가, ord 규칙이 같아 적재되면 붙는다) → job_id:ord
--   cit_drift      레거시 참조에 있으나 새 ord 행이 없거나 url 이 다름(표류)     → 원래 키(엉뚱한 낱알에 붙이지 않는다)
--   cit_stale      레거시 참조에 그 id 없음(재싱크로 이미 끊김, 레거시에서도 배지 0) → 원래 키
--   cit_label      recover_stale=1 일 때만: cit_stale 중 target_label('#ref domain')이 job 안에서 하나로만 맞고 새 ord url 도 같음 → job_id:ord
--   cit_newfmt     이미 'uuid:ord' 형식(레거시에는 없어야 함)                    → 그대로
--   identity       멘션·ACR 키                                                 → 그대로(붙음 대조는 verify-qa V8)
--   opaque         그 밖                                                       → 그대로
-- 재실행 판정(키 = job_id·note_id, 원장 mig_src.qa_carry_ledger 와 app 행 지문 qa_*_hash 비교)
--   원장 없음·app 없음 → insert / 원장 없음·app 있음 → skip_foreign(back 에서 생긴 행, overwrite_foreign=1 이면 overwrite_foreign)
--   원장 있음·app 없음 → skip_deleted_in_back(지운 노트를 되살리지 않는다) / app 지문 ≠ 원장 → skip_edited_in_back(back 수정 보존)
--   원천·번역 같음 → noop / 다름 → update(detail.change = source | remap)
--   원장 있음·스테이지에 없음(레거시에서 삭제) → app 미수정이면 delete_gone_in_source, 수정됐으면 skip_edited_in_back, app 도 없으면 forget_gone(원장만 정리)
-- 결정 기본값(사용자·동료 확인 전, 매개변수로 바꾼다): stale 인용 노트 미복구(recover_stale=0) · 세션·락 미이관 · 원장 = mig_src · 드라이런 기본
-- 선행: DB-v2.32(app.qa_*), mig_src_qa.sql(스테이지·참조·원장·보고 표, 지문 함수), qa-load.tpl.sh(snap/qa → mig_src) 또는 from_snapshot 참조.
-- 실행 롤: 소유자(admin). migrator 는 app 에 SELECT 만 있다. app.qa_* 에는 트리거가 없어 행위자 GUC 가 필요 없다.
-- 동결 창에서 실행한다(레거시 RAW_DATA_QA_ENABLED≠1, back QA 미개방): 사후 단언이 app.qa_answer_lock·app.qa_review_session 행 수가 그대로인지 본다.
--
-- 사용(드라이런이 기본: 끝에서 ROLLBACK):
--   psql -X -v ON_ERROR_STOP=1 -f migrate-qa.sql                                                   # 드라이런: 집계·주의 행 출력
--   psql -X -v ON_ERROR_STOP=1 -v expect_reviews=29 -v expect_notes=70 -v commit=1 -f migrate-qa.sql  # 드라이런과 같은 반영 수일 때만 COMMIT
--   매개변수: expect_reviews·expect_notes = 이번 실행 반영 수(insert+update+overwrite_foreign+delete_gone_in_source, 기본 -1 = 검사 안 함)
--            overwrite_foreign=1(기본 0) · recover_stale=1(기본 0, 결정 1) · commit(정의하면 COMMIT)
-- 출력: NOTICE QA_CARRY_OK …, 'summary' 행(kind × action × map_status), 'attention' 행(주의가 필요한 행: 키·URL·가시성, 이름·본문 없음)
-- 뒤처리: COMMIT 뒤 verify-qa.sql(V1~V11). 되돌리기 = rollback-qa.sql(원장 기준, 드라이런 기본)
-- ============================================================================
\if :{?expect_reviews}
\else
\set expect_reviews -1
\endif
\if :{?expect_notes}
\else
\set expect_notes -1
\endif
\if :{?overwrite_foreign}
\else
\set overwrite_foreign 0
\endif
\if :{?recover_stale}
\else
\set recover_stale 0
\endif
\set QUIET on
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT set_config('qa.expect_reviews', :'expect_reviews', true) AS e1, set_config('qa.expect_notes', :'expect_notes', true) AS e2,
       set_config('qa.overwrite_foreign', :'overwrite_foreign', true) AS e3, set_config('qa.recover_stale', :'recover_stale', true) AS e4 \gset qa_
\set QUIET off

-- ── 0. 사전 단언(실패 = 예외 = 전체 롤백) ─────────────────────────────────────
DO $a$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('app.qa_answer_review') AND attname = 'flag_answer' AND NOT attisdropped)
     OR to_regclass('app.qa_review_note') IS NULL THEN
    RAISE EXCEPTION 'app.qa_answer_review.flag_answer·app.qa_review_note 없음: DB-v2.32 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('mig_src.qa_answer_reviews') IS NULL OR to_regclass('mig_src.qa_review_notes') IS NULL
     OR to_regclass('mig_src.qa_ref_job') IS NULL OR to_regclass('mig_src.qa_ref_citation') IS NULL
     OR to_regclass('mig_src.qa_ref_mention') IS NULL OR to_regclass('mig_src.qa_ref_acr') IS NULL
     OR to_regclass('mig_src.qa_carry_ledger') IS NULL OR to_regclass('mig_src.qa_carry_report') IS NULL
     OR to_regprocedure('mig_src.qa_review_hash(uuid,text,text,text,text,text,text,uuid,text,uuid,timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('mig_src.qa_note_hash(uuid,uuid,text,text,text,text,text,uuid,text,uuid,timestamptz,timestamptz,text)') IS NULL
     OR to_regprocedure('mig_src.qa_name_off(text)') IS NULL THEN
    RAISE EXCEPTION 'mig_src QA 표·지문 함수 없음: mig_src_qa.sql 을 먼저 실행한다';
  END IF;
  IF current_setting('qa.overwrite_foreign') NOT IN ('0', '1') OR current_setting('qa.recover_stale') NOT IN ('0', '1') THEN
    RAISE EXCEPTION 'overwrite_foreign·recover_stale 은 0 또는 1';
  END IF;
END $a$;

DO $a$ DECLARE n bigint; BEGIN
  SELECT count(*) - count(DISTINCT job_id) INTO n FROM mig_src.qa_answer_reviews;
  IF n <> 0 THEN RAISE EXCEPTION '스테이지 리뷰 job_id 중복 %건', n; END IF;
  SELECT count(*) - count(DISTINCT id) INTO n FROM mig_src.qa_review_notes;
  IF n <> 0 THEN RAISE EXCEPTION '스테이지 노트 id 중복 %건', n; END IF;
  SELECT count(*) INTO n FROM (SELECT job_id FROM mig_src.qa_answer_reviews UNION SELECT job_id FROM mig_src.qa_review_notes) x
   WHERE NOT EXISTS (SELECT 1 FROM mig_src.qa_ref_job r WHERE r.job_id = x.job_id);
  IF n <> 0 THEN
    RAISE EXCEPTION '참조 qa_ref_job 에 없는 job %건: 스테이지와 참조가 같은 추출이 아니다(export.py --qa → qa-load 를 다시)', n;
  END IF;
  SELECT count(*) INTO n FROM mig_src.qa_review_notes WHERE (resolved_at IS NULL) <> (resolved_by IS NULL);
  IF n <> 0 THEN RAISE EXCEPTION '원천 위반: 해결 시각·해결자 한쪽만 있는 노트 %건(새 표 CHECK 위반, 처리 결정 필요)', n; END IF;
  SELECT count(*) INTO n FROM mig_src.qa_review_notes
   WHERE target_kind NOT IN ('answer', 'prompt', 'mention', 'citation', 'acr', 'meta') OR severity NOT IN ('issue', 'question', 'info');
  IF n <> 0 THEN RAISE EXCEPTION '원천 위반: target_kind·severity 가 허용 값 밖인 노트 %건', n; END IF;
  SELECT count(*) INTO n FROM mig_src.qa_answer_reviews r
   WHERE jsonb_typeof(r.section_flags) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(r.section_flags) = 'object' THEN r.section_flags ELSE '{}'::jsonb END) e
                  WHERE e.key NOT IN ('answer', 'prompt', 'mentions', 'citations', 'acr', 'meta')
                     OR e.value NOT IN ('"ok"'::jsonb, '"issue"'::jsonb));
  IF n <> 0 THEN RAISE EXCEPTION '원천 위반: section_flags 에 6키 밖 키·ok/issue 밖 값이 있는 리뷰 %건', n; END IF;
  -- 레거시 status = 파생값(upsertReview: 섹션 하나라도 issue 면 issue). 새 표 status 는 같은 규칙의 GENERATED 열이다
  SELECT count(*) INTO n FROM mig_src.qa_answer_reviews r
   WHERE r.status IS DISTINCT FROM (CASE WHEN EXISTS (SELECT 1 FROM jsonb_each_text(r.section_flags) e WHERE e.value = 'issue')
                                         THEN 'issue' ELSE 'ok' END);
  IF n <> 0 THEN RAISE EXCEPTION '원천 위반: status 가 section_flags 파생값과 다른 리뷰 %건(새 표 status 는 GENERATED)', n; END IF;
END $a$;

-- 이관 중 back 쓰기 차단(읽기는 허용). 락·세션 표는 잠그지 않고 행 수만 사후 대조한다(동결 창 전제)
LOCK TABLE app.qa_answer_review, app.qa_review_note IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _qa_pre ON COMMIT DROP AS
SELECT clock_timestamp() AS run_at, (SELECT count(*) FROM app.qa_answer_lock) AS locks, (SELECT count(*) FROM app.qa_review_session) AS sessions,
       current_setting('qa.overwrite_foreign') = '1' AS overwrite_foreign, current_setting('qa.recover_stale') = '1' AS recover_stale;

-- ── 1. 리뷰 변환 ─────────────────────────────────────────────────────────────
CREATE TEMP TABLE _rv ON COMMIT DROP AS
SELECT x.*, mig_src.qa_review_hash(x.job_id, x.flag_answer, x.flag_prompt, x.flag_mentions, x.flag_citations, x.flag_acr, x.flag_meta,
                                   NULL, x.reviewer_name, NULL, x.reviewed_at, x.updated_at) AS dst_hash
  FROM (SELECT r.job_id,
               CASE WHEN r.section_flags->>'answer'    IN ('ok', 'issue') THEN r.section_flags->>'answer'    END AS flag_answer,
               CASE WHEN r.section_flags->>'prompt'    IN ('ok', 'issue') THEN r.section_flags->>'prompt'    END AS flag_prompt,
               CASE WHEN r.section_flags->>'mentions'  IN ('ok', 'issue') THEN r.section_flags->>'mentions'  END AS flag_mentions,
               CASE WHEN r.section_flags->>'citations' IN ('ok', 'issue') THEN r.section_flags->>'citations' END AS flag_citations,
               CASE WHEN r.section_flags->>'acr'       IN ('ok', 'issue') THEN r.section_flags->>'acr'       END AS flag_acr,
               CASE WHEN r.section_flags->>'meta'      IN ('ok', 'issue') THEN r.section_flags->>'meta'      END AS flag_meta,
               r.reviewer_name, r.reviewed_at, r.updated_at, r.status AS legacy_status,
               md5(row(r.job_id, r.status, r.section_flags, r.reviewer_name, extract(epoch FROM r.reviewed_at),
                       extract(epoch FROM r.updated_at))::text) AS src_hash
          FROM mig_src.qa_answer_reviews r) x;

-- ── 2. 노트 키 번역 ──────────────────────────────────────────────────────────
-- 숫자 키 캐스트는 CASE 안에서만(AND 는 평가 순서를 보장하지 않아 비숫자 키가 bigint 캐스트에서 터질 수 있다).
-- 새 ord 행은 rd.v_answer_citation_raw(answer_key 등치 조회 전용 규약)를 노트마다 LATERAL·LIMIT 1 로 찾는다(뷰 전체를 펼치지 않게)
CREATE TEMP TABLE _nm ON COMMIT DROP AS
WITH n AS (
  SELECT n.*, CASE WHEN n.target_kind = 'citation' AND n.target_key ~ '^[0-9]{1,18}$' THEN n.target_key::bigint END AS cit_id
    FROM mig_src.qa_review_notes n),
b AS (
  SELECT n.*, j.answer_key, rc.id AS rc_id, rc.ord AS rc_ord, rc.url AS rc_url
    FROM n
    LEFT JOIN rd.job j ON j.job_id = n.job_id
    LEFT JOIN mig_src.qa_ref_citation rc ON rc.job_id = n.job_id AND rc.id = n.cit_id),
lab AS (
  -- recover_stale=1: 끊긴 숫자 키 노트의 target_label 과 레거시 표시 규칙(granule-tables.tsx `#${refIndex ?? "?"} ${domain ?? url ?? ""}`.trim())이 같은 현재 인용
  SELECT b.id, count(*) AS hits, min(c.ord) AS ord, min(c.url) AS url
    FROM b JOIN mig_src.qa_ref_citation c ON c.job_id = b.job_id
     AND btrim('#' || coalesce(c.ref_index::text, '?') || ' ' || coalesce(c.domain, c.url, '')) = b.target_label
   WHERE b.cit_id IS NOT NULL AND b.rc_id IS NULL AND (SELECT p.recover_stale FROM _qa_pre p)
   GROUP BY b.id),
c AS (
  SELECT b.*, coalesce(b.rc_ord, CASE WHEN lab.hits = 1 THEN lab.ord END) AS ord,
         coalesce(b.rc_url, CASE WHEN lab.hits = 1 THEN lab.url END) AS legacy_url, lab.hits AS label_hits
    FROM b LEFT JOIN lab ON lab.id = b.id)
SELECT c.id AS note_id, c.job_id, c.target_kind, c.target_key AS legacy_key, c.target_label, c.severity, c.body, c.reviewer_name, c.created_at,
       c.resolved_at, c.resolved_by, c.answer_key, c.ord, c.legacy_url, nc.url AS new_url, nc.ord IS NOT NULL AS new_ord_found, c.label_hits,
       CASE WHEN c.target_key IS NULL THEN 'nokey'
            WHEN c.cit_id IS NOT NULL AND c.rc_id IS NOT NULL THEN
              CASE WHEN c.answer_key IS NULL THEN 'cit_unverified'
                   WHEN nc.ord IS NOT NULL AND nc.url IS NOT DISTINCT FROM c.rc_url THEN 'cit_mapped'
                   ELSE 'cit_drift' END
            WHEN c.cit_id IS NOT NULL THEN
              CASE WHEN c.ord IS NOT NULL AND nc.ord IS NOT NULL AND nc.url IS NOT DISTINCT FROM c.legacy_url THEN 'cit_label'
                   ELSE 'cit_stale' END
            WHEN c.target_kind = 'citation'
                 AND c.target_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$' THEN 'cit_newfmt'
            WHEN c.target_kind IN ('mention', 'acr') THEN 'identity'
            ELSE 'opaque' END AS map_status,
       -- 레거시 화면에서 그 낱알에 붙어 있었나(추출 시점 참조 기준. 블록 노트·그 밖 종류는 NULL)
       CASE WHEN c.target_key IS NULL THEN NULL
            WHEN c.target_kind = 'citation' THEN c.rc_id IS NOT NULL
            WHEN c.target_kind = 'mention' THEN EXISTS (SELECT 1 FROM mig_src.qa_ref_mention x WHERE x.job_id = c.job_id
                                                          AND x.entity_id::text = c.target_key)
            WHEN c.target_kind = 'acr' THEN EXISTS (SELECT 1 FROM mig_src.qa_ref_acr x WHERE x.job_id = c.job_id
                                                      AND x.prompt_run_id::text || ':' || x.entity_id::text = c.target_key) END AS legacy_attached,
       md5(row(c.id, c.job_id, c.target_kind, c.target_key, c.target_label, c.severity, c.body, c.reviewer_name, extract(epoch FROM c.created_at),
               extract(epoch FROM c.resolved_at), c.resolved_by)::text) AS src_hash
  FROM c
  LEFT JOIN LATERAL (SELECT v.ord, v.url FROM rd.v_answer_citation_raw v
                      WHERE c.answer_key IS NOT NULL AND c.ord IS NOT NULL AND v.answer_key = c.answer_key AND v.ord = c.ord LIMIT 1) nc ON true;
ALTER TABLE _nm ADD COLUMN new_key text, ADD COLUMN dst_hash text;
UPDATE _nm SET new_key = CASE WHEN map_status IN ('cit_mapped', 'cit_unverified', 'cit_label') THEN job_id::text || ':' || ord ELSE legacy_key END;
UPDATE _nm SET dst_hash = mig_src.qa_note_hash(note_id, job_id, target_kind, new_key, target_label, severity, body, NULL, reviewer_name, NULL,
                                               created_at, resolved_at, resolved_by);

-- ── 3. 행동 판정(원장 × app 지문) ────────────────────────────────────────────
CREATE TEMP TABLE _rv_act ON COMMIT DROP AS
SELECT q.*,
       CASE WHEN q.s_key IS NULL THEN CASE WHEN NOT q.in_app THEN 'forget_gone' WHEN q.cur_hash = q.led_dst THEN 'delete_gone_in_source'
                                           ELSE 'skip_edited_in_back' END
            WHEN q.led_key IS NULL THEN CASE WHEN NOT q.in_app THEN 'insert' WHEN p.overwrite_foreign THEN 'overwrite_foreign'
                                             ELSE 'skip_foreign' END
            WHEN NOT q.in_app THEN 'skip_deleted_in_back'
            WHEN q.cur_hash IS DISTINCT FROM q.led_dst THEN 'skip_edited_in_back'
            WHEN q.src_hash = q.led_src AND q.dst_hash = q.led_dst THEN 'noop'
            ELSE 'update' END AS action,
       CASE WHEN q.s_key IS NULL OR q.led_key IS NULL THEN NULL WHEN q.src_hash IS DISTINCT FROM q.led_src THEN 'source'
            WHEN q.dst_hash IS DISTINCT FROM q.led_dst THEN 'remap' END AS change
  FROM (SELECT coalesce(s.job_id, l.key) AS job_id, s.job_id AS s_key, l.key AS led_key, s.flag_answer, s.flag_prompt, s.flag_mentions,
               s.flag_citations, s.flag_acr, s.flag_meta, s.reviewer_name, s.reviewed_at, s.updated_at, s.legacy_status, s.src_hash, s.dst_hash,
               l.src_hash AS led_src, l.dst_hash AS led_dst, a.job_id IS NOT NULL AS in_app,
               CASE WHEN a.job_id IS NOT NULL THEN mig_src.qa_review_hash(a.job_id, a.flag_answer, a.flag_prompt, a.flag_mentions, a.flag_citations,
                                                                          a.flag_acr, a.flag_meta, a.reviewer_id, a.reviewer_name, a.session_id,
                                                                          a.reviewed_at, a.updated_at) END AS cur_hash
          FROM _rv s
          FULL JOIN (SELECT * FROM mig_src.qa_carry_ledger WHERE kind = 'review') l ON l.key = s.job_id
          LEFT JOIN app.qa_answer_review a ON a.job_id = coalesce(s.job_id, l.key)) q
 CROSS JOIN _qa_pre p;

CREATE TEMP TABLE _nt_act ON COMMIT DROP AS
SELECT q.*,
       CASE WHEN q.s_key IS NULL THEN CASE WHEN NOT q.in_app THEN 'forget_gone' WHEN q.cur_hash = q.led_dst THEN 'delete_gone_in_source'
                                           ELSE 'skip_edited_in_back' END
            WHEN q.led_key IS NULL THEN CASE WHEN NOT q.in_app THEN 'insert' WHEN p.overwrite_foreign THEN 'overwrite_foreign'
                                             ELSE 'skip_foreign' END
            WHEN NOT q.in_app THEN 'skip_deleted_in_back'
            WHEN q.cur_hash IS DISTINCT FROM q.led_dst THEN 'skip_edited_in_back'
            WHEN q.src_hash = q.led_src AND q.dst_hash = q.led_dst THEN 'noop'
            ELSE 'update' END AS action,
       CASE WHEN q.s_key IS NULL OR q.led_key IS NULL THEN NULL WHEN q.src_hash IS DISTINCT FROM q.led_src THEN 'source'
            WHEN q.dst_hash IS DISTINCT FROM q.led_dst THEN 'remap' END AS change
  FROM (SELECT coalesce(s.note_id, l.key) AS note_id, coalesce(s.job_id, l.job_id) AS job_id, s.note_id AS s_key, l.key AS led_key,
               s.target_kind, s.legacy_key, s.new_key, s.target_label, s.severity, s.body, s.reviewer_name, s.created_at, s.resolved_at,
               s.resolved_by, s.map_status, s.legacy_attached, s.ord, s.legacy_url, s.new_url, s.new_ord_found, s.label_hits, s.src_hash, s.dst_hash,
               l.src_hash AS led_src, l.dst_hash AS led_dst, a.note_id IS NOT NULL AS in_app,
               CASE WHEN a.note_id IS NOT NULL THEN mig_src.qa_note_hash(a.note_id, a.job_id, a.target_kind, a.target_key, a.target_label,
                                                                         a.severity, a.body, a.reviewer_id, a.reviewer_name, a.session_id,
                                                                         a.created_at, a.resolved_at, a.resolved_by) END AS cur_hash
          FROM _nm s
          FULL JOIN (SELECT * FROM mig_src.qa_carry_ledger WHERE kind = 'note') l ON l.key = s.note_id
          LEFT JOIN app.qa_review_note a ON a.note_id = coalesce(s.note_id, l.key)) q
 CROSS JOIN _qa_pre p;

-- ── 4. 반영(명시 열, 원천 시각) ───────────────────────────────────────────────
CREATE TEMP TABLE _qa_res (kind text NOT NULL, op text NOT NULL, n bigint NOT NULL) ON COMMIT DROP;
WITH w AS (
  INSERT INTO app.qa_answer_review (job_id, flag_answer, flag_prompt, flag_mentions, flag_citations, flag_acr, flag_meta,
                                    reviewer_id, reviewer_name, session_id, reviewed_at, updated_at)
  SELECT job_id, flag_answer, flag_prompt, flag_mentions, flag_citations, flag_acr, flag_meta, NULL, reviewer_name, NULL, reviewed_at, updated_at
    FROM _rv_act WHERE action IN ('insert', 'update', 'overwrite_foreign')
  ON CONFLICT (job_id) DO UPDATE SET flag_answer = EXCLUDED.flag_answer, flag_prompt = EXCLUDED.flag_prompt, flag_mentions = EXCLUDED.flag_mentions,
    flag_citations = EXCLUDED.flag_citations, flag_acr = EXCLUDED.flag_acr, flag_meta = EXCLUDED.flag_meta, reviewer_id = NULL,
    reviewer_name = EXCLUDED.reviewer_name, session_id = NULL, reviewed_at = EXCLUDED.reviewed_at, updated_at = EXCLUDED.updated_at
  RETURNING job_id)
INSERT INTO _qa_res SELECT 'review', 'write', count(*) FROM w;
WITH d AS (DELETE FROM app.qa_answer_review a USING _rv_act x WHERE x.action = 'delete_gone_in_source' AND a.job_id = x.job_id RETURNING a.job_id)
INSERT INTO _qa_res SELECT 'review', 'delete', count(*) FROM d;

WITH w AS (
  INSERT INTO app.qa_review_note (note_id, job_id, target_kind, target_key, target_label, severity, body,
                                  reviewer_id, reviewer_name, session_id, created_at, resolved_at, resolved_by)
  SELECT note_id, job_id, target_kind, new_key, target_label, severity, body, NULL, reviewer_name, NULL, created_at, resolved_at, resolved_by
    FROM _nt_act WHERE action IN ('insert', 'update', 'overwrite_foreign')
  ON CONFLICT (note_id) DO UPDATE SET job_id = EXCLUDED.job_id, target_kind = EXCLUDED.target_kind, target_key = EXCLUDED.target_key,
    target_label = EXCLUDED.target_label, severity = EXCLUDED.severity, body = EXCLUDED.body, reviewer_id = NULL,
    reviewer_name = EXCLUDED.reviewer_name, session_id = NULL, created_at = EXCLUDED.created_at, resolved_at = EXCLUDED.resolved_at,
    resolved_by = EXCLUDED.resolved_by
  RETURNING note_id)
INSERT INTO _qa_res SELECT 'note', 'write', count(*) FROM w;
WITH d AS (DELETE FROM app.qa_review_note a USING _nt_act x WHERE x.action = 'delete_gone_in_source' AND a.note_id = x.note_id RETURNING a.note_id)
INSERT INTO _qa_res SELECT 'note', 'delete', count(*) FROM d;

-- 원장: 쓴 행은 지문·키 번역을 갱신, 지운·잊은 행은 정리, noop 은 판정 정보(map_status·legacy_attached)만 바뀌었을 때 갱신
INSERT INTO mig_src.qa_carry_ledger AS l (kind, key, job_id, src_hash, dst_hash, legacy_key, new_key, map_status, legacy_attached, carried_at)
SELECT 'review', x.job_id, x.job_id, x.src_hash, x.dst_hash, NULL, NULL, NULL, NULL, p.run_at
  FROM _rv_act x CROSS JOIN _qa_pre p WHERE x.action IN ('insert', 'update', 'overwrite_foreign')
UNION ALL
SELECT 'note', x.note_id, x.job_id, x.src_hash, x.dst_hash, x.legacy_key, x.new_key, x.map_status, x.legacy_attached, p.run_at
  FROM _nt_act x CROSS JOIN _qa_pre p WHERE x.action IN ('insert', 'update', 'overwrite_foreign')
ON CONFLICT (kind, key) DO UPDATE SET job_id = EXCLUDED.job_id, src_hash = EXCLUDED.src_hash, dst_hash = EXCLUDED.dst_hash,
  legacy_key = EXCLUDED.legacy_key, new_key = EXCLUDED.new_key, map_status = EXCLUDED.map_status, legacy_attached = EXCLUDED.legacy_attached,
  carried_at = EXCLUDED.carried_at;
DELETE FROM mig_src.qa_carry_ledger l
 USING (SELECT 'review' AS kind, job_id AS key FROM _rv_act WHERE action IN ('delete_gone_in_source', 'forget_gone')
        UNION ALL SELECT 'note', note_id FROM _nt_act WHERE action IN ('delete_gone_in_source', 'forget_gone')) g
 WHERE l.kind = g.kind AND l.key = g.key;
UPDATE mig_src.qa_carry_ledger l SET map_status = x.map_status, legacy_attached = x.legacy_attached
  FROM _nt_act x
 WHERE l.kind = 'note' AND l.key = x.note_id AND x.action = 'noop'
   AND (l.map_status, l.legacy_attached) IS DISTINCT FROM (x.map_status, x.legacy_attached);

-- 보고(실행 단위 run_at). detail 에 이름·본문은 넣지 않는다(name_off = back 이름 정규화와 다른 이름이 있다)
INSERT INTO mig_src.qa_carry_report (run_at, kind, key, job_id, action, map_status, detail)
SELECT p.run_at, 'review', x.job_id, x.job_id, x.action, NULL,
       jsonb_strip_nulls(jsonb_build_object(
         'change', x.change, 'legacy_status', x.legacy_status,
         'in_rd_job', EXISTS (SELECT 1 FROM rd.job j WHERE j.job_id = x.job_id),
         'in_mirror', (SELECT r.in_mirror FROM mig_src.qa_ref_job r WHERE r.job_id = x.job_id),
         'name_off', CASE WHEN mig_src.qa_name_off(x.reviewer_name) THEN true END))
  FROM _rv_act x CROSS JOIN _qa_pre p
UNION ALL
SELECT p.run_at, 'note', x.note_id, x.job_id, x.action, x.map_status,
       jsonb_strip_nulls(jsonb_build_object(
         'change', x.change, 'target_kind', x.target_kind, 'legacy_key', x.legacy_key, 'new_key', x.new_key, 'ord', x.ord,
         'legacy_url', x.legacy_url, 'new_url', x.new_url, 'label_hits', x.label_hits, 'legacy_attached', x.legacy_attached,
         'in_rd_job', EXISTS (SELECT 1 FROM rd.job j WHERE j.job_id = x.job_id),
         'in_mirror', (SELECT r.in_mirror FROM mig_src.qa_ref_job r WHERE r.job_id = x.job_id),
         'name_off', CASE WHEN mig_src.qa_name_off(x.reviewer_name) OR mig_src.qa_name_off(x.resolved_by) THEN true END))
  FROM _nt_act x CROSS JOIN _qa_pre p;

-- ── 5. 사후 단언(실패 = 예외 = 전체 롤백) ─────────────────────────────────────
DO $a$ DECLARE
  p record; r record; t record; n bigint; rw bigint; rdel bigint; nw bigint; ndel bigint;
  e_r int := current_setting('qa.expect_reviews')::int; e_n int := current_setting('qa.expect_notes')::int;
BEGIN
  SELECT * INTO p FROM _qa_pre;
  SELECT count(*) FILTER (WHERE action = 'insert') AS ins, count(*) FILTER (WHERE action = 'update') AS upd,
         count(*) FILTER (WHERE action = 'overwrite_foreign') AS ovr, count(*) FILTER (WHERE action = 'delete_gone_in_source') AS del,
         count(*) FILTER (WHERE action = 'noop') AS noop, count(*) FILTER (WHERE action LIKE 'skip%') AS skip,
         count(*) FILTER (WHERE action = 'forget_gone') AS fgt INTO r FROM _rv_act;
  SELECT count(*) FILTER (WHERE action = 'insert') AS ins, count(*) FILTER (WHERE action = 'update') AS upd,
         count(*) FILTER (WHERE action = 'overwrite_foreign') AS ovr, count(*) FILTER (WHERE action = 'delete_gone_in_source') AS del,
         count(*) FILTER (WHERE action = 'noop') AS noop, count(*) FILTER (WHERE action LIKE 'skip%') AS skip,
         count(*) FILTER (WHERE action = 'forget_gone') AS fgt INTO t FROM _nt_act;
  SELECT x.n INTO rw FROM _qa_res x WHERE x.kind = 'review' AND x.op = 'write';
  SELECT x.n INTO rdel FROM _qa_res x WHERE x.kind = 'review' AND x.op = 'delete';
  SELECT x.n INTO nw FROM _qa_res x WHERE x.kind = 'note' AND x.op = 'write';
  SELECT x.n INTO ndel FROM _qa_res x WHERE x.kind = 'note' AND x.op = 'delete';
  IF rw <> r.ins + r.upd + r.ovr OR rdel <> r.del THEN
    RAISE EXCEPTION '리뷰 반영(쓰기 %·삭제 %) <> 계획(%·%)', rw, rdel, r.ins + r.upd + r.ovr, r.del;
  END IF;
  IF nw <> t.ins + t.upd + t.ovr OR ndel <> t.del THEN
    RAISE EXCEPTION '노트 반영(쓰기 %·삭제 %) <> 계획(%·%)', nw, ndel, t.ins + t.upd + t.ovr, t.del;
  END IF;
  IF e_r >= 0 AND r.ins + r.upd + r.ovr + r.del <> e_r THEN
    RAISE EXCEPTION '리뷰 반영 % <> 기대 %(드라이런과 다름)', r.ins + r.upd + r.ovr + r.del, e_r;
  END IF;
  IF e_n >= 0 AND t.ins + t.upd + t.ovr + t.del <> e_n THEN
    RAISE EXCEPTION '노트 반영 % <> 기대 %(드라이런과 다름)', t.ins + t.upd + t.ovr + t.del, e_n;
  END IF;
  -- 쓴 행·noop 행: app 지문 = 원장 dst_hash = 이번 변환 dst_hash
  SELECT count(*) INTO n FROM _rv_act x
    LEFT JOIN mig_src.qa_carry_ledger l ON l.kind = 'review' AND l.key = x.job_id
    LEFT JOIN app.qa_answer_review a ON a.job_id = x.job_id
   WHERE x.action IN ('insert', 'update', 'overwrite_foreign', 'noop')
     AND (l.key IS NULL OR a.job_id IS NULL OR l.dst_hash IS DISTINCT FROM x.dst_hash
          OR mig_src.qa_review_hash(a.job_id, a.flag_answer, a.flag_prompt, a.flag_mentions, a.flag_citations, a.flag_acr, a.flag_meta,
                                    a.reviewer_id, a.reviewer_name, a.session_id, a.reviewed_at, a.updated_at) IS DISTINCT FROM l.dst_hash);
  IF n <> 0 THEN RAISE EXCEPTION '리뷰 지문 불일치 %건(app ≠ 원장)', n; END IF;
  SELECT count(*) INTO n FROM _nt_act x
    LEFT JOIN mig_src.qa_carry_ledger l ON l.kind = 'note' AND l.key = x.note_id
    LEFT JOIN app.qa_review_note a ON a.note_id = x.note_id
   WHERE x.action IN ('insert', 'update', 'overwrite_foreign', 'noop')
     AND (l.key IS NULL OR a.note_id IS NULL OR l.dst_hash IS DISTINCT FROM x.dst_hash
          OR mig_src.qa_note_hash(a.note_id, a.job_id, a.target_kind, a.target_key, a.target_label, a.severity, a.body, a.reviewer_id,
                                  a.reviewer_name, a.session_id, a.created_at, a.resolved_at, a.resolved_by) IS DISTINCT FROM l.dst_hash);
  IF n <> 0 THEN RAISE EXCEPTION '노트 지문 불일치 %건(app ≠ 원장)', n; END IF;
  -- 이관 행 = 계정·세션 없음, status GENERATED = 레거시 status
  SELECT count(*) INTO n FROM _rv_act x JOIN app.qa_answer_review a ON a.job_id = x.job_id
   WHERE x.action IN ('insert', 'update', 'overwrite_foreign', 'noop')
     AND (a.session_id IS NOT NULL OR a.reviewer_id IS NOT NULL OR a.status IS DISTINCT FROM x.legacy_status);
  IF n <> 0 THEN RAISE EXCEPTION '이관 리뷰 중 session_id·reviewer_id 가 있거나 status ≠ 레거시 status 인 행 %건', n; END IF;
  SELECT count(*) INTO n FROM _nt_act x JOIN app.qa_review_note a ON a.note_id = x.note_id
   WHERE x.action IN ('insert', 'update', 'overwrite_foreign', 'noop') AND (a.session_id IS NOT NULL OR a.reviewer_id IS NOT NULL);
  IF n <> 0 THEN RAISE EXCEPTION '이관 노트 중 session_id·reviewer_id 가 있는 행 %건', n; END IF;
  -- 레거시에서 사라진 미수정 행은 지워졌다
  SELECT count(*) INTO n FROM (SELECT job_id AS k FROM _rv_act WHERE action = 'delete_gone_in_source') g
   WHERE EXISTS (SELECT 1 FROM app.qa_answer_review a WHERE a.job_id = g.k);
  IF n <> 0 THEN RAISE EXCEPTION '삭제 대상 리뷰가 남았다 %건', n; END IF;
  SELECT count(*) INTO n FROM (SELECT note_id AS k FROM _nt_act WHERE action = 'delete_gone_in_source') g
   WHERE EXISTS (SELECT 1 FROM app.qa_review_note a WHERE a.note_id = g.k);
  IF n <> 0 THEN RAISE EXCEPTION '삭제 대상 노트가 남았다 %건', n; END IF;
  -- 세션·락 미이관: 이관이 건드리지 않았다
  IF (SELECT count(*) FROM app.qa_answer_lock) <> p.locks OR (SELECT count(*) FROM app.qa_review_session) <> p.sessions THEN
    RAISE EXCEPTION 'app.qa_answer_lock·app.qa_review_session 행 수가 바뀜(락 %→%, 세션 %→%): 동결 창에서 다시 실행', p.locks,
      (SELECT count(*) FROM app.qa_answer_lock), p.sessions, (SELECT count(*) FROM app.qa_review_session);
  END IF;
  RAISE NOTICE 'QA_CARRY_OK reviews ins=% upd=% ovr=% del=% noop=% skip=% forget=% · notes ins=% upd=% ovr=% del=% noop=% skip=% forget=%',
    r.ins, r.upd, r.ovr, r.del, r.noop, r.skip, r.fgt, t.ins, t.upd, t.ovr, t.del, t.noop, t.skip, t.fgt;
END $a$;

SELECT 'summary' AS t, x.kind, x.action, coalesce(x.map_status, '-') AS map_status, count(*) AS n
  FROM (SELECT 'review' AS kind, action, NULL::text AS map_status FROM _rv_act UNION ALL SELECT 'note', action, map_status FROM _nt_act) x
 GROUP BY x.kind, x.action, x.map_status
 ORDER BY x.kind DESC, x.action, 4;
-- 주의 행: 쓰기 외 처리(skip·삭제·덮어쓰기), 키 번역이 원래 키를 남긴 인용, 새 고아·레거시 고아, 이름 비정규
SELECT 'attention' AS t, r.kind, left(r.key::text, 8) AS key8, left(r.job_id::text, 8) AS job8, r.action, r.map_status, r.detail
  FROM mig_src.qa_carry_report r JOIN _qa_pre p ON p.run_at = r.run_at
 WHERE r.action NOT IN ('insert', 'update', 'noop')
    OR r.map_status IN ('cit_unverified', 'cit_drift', 'cit_stale', 'cit_label', 'cit_newfmt', 'opaque')
    OR NOT (r.detail->>'in_rd_job')::bool OR NOT coalesce((r.detail->>'in_mirror')::bool, false) OR r.detail ? 'name_off'
 ORDER BY r.kind DESC, r.action, r.map_status, r.key;

\if :{?commit}
COMMIT;
SELECT 'mode', 'COMMIT';
\else
ROLLBACK;
SELECT 'mode', 'ROLLBACK(드라이런)';
\endif
