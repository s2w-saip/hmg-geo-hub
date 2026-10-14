-- ============================================================================
-- QA 검수 기록 이관 검증(V1~V11, 2026-10-14). migrate-qa.sql COMMIT 직후(컷오버 동결 창) 실행한다. 아무것도 남기지 않는다:
--   결과는 임시 표에만 쓰고 끝에서 ROLLBACK 한다(READ ONLY 트랜잭션은 임시 표를 만들 수 없어 쓰지 않는다).
--   행마다 no·check_name·expected·actual·verdict(OK|FAIL|INFO)·detail. FAIL 이 하나라도 있으면 끝에서 예외(QA_VERIFY_FAIL, strict=0 이면 알림만).
-- "이관 미수정 행" = 원장에 있고 app 행 지문(qa_*_hash)이 원장 dst_hash 와 같은 행. skip_* 는 마지막 migrate 실행 보고(mig_src.qa_carry_report)로 센다.
-- V5·V6·V7 은 스테이지 전체와 app 전체를 비교한다: 전환 뒤 back 에서 판정·노트가 생기면 그만큼 달라진다(컷오버 직후 기준 검사).
--
-- 사용:
--   psql -X -v ON_ERROR_STOP=1 -v surfaces='{1,2,3}' -v since='' -f verify-qa.sql
--   surfaces = 배포 HGH_QA_SURFACES 의 표면 코드(global 1, website 2, project 3), since = HGH_QA_SINCE(YYYY-MM-DD, 비우면 없음). 기본 {1,2,3}·''
--   strict=0 이면 FAIL 이어도 예외 없이 표만 출력(기본 1)
-- 결과 해석: V8(낱알 붙음 대조)·V9(가시성)·V10b·V11 은 INFO(알려진 차이 보고). 레거시 화면 진행률(scope_answers 가시분)과 새 화면 진행률
--   (rd.job ∧ 서버 범위)은 모집단이 달라(드롭 포함·표면 판정) 같다고 단언하지 않는다. V7 은 같은 모집단(rd.job ∧ 범위)에서 원천과 app 을 비교한다.
-- ============================================================================
\if :{?surfaces}
\else
\set surfaces '{1,2,3}'
\endif
\if :{?since}
\else
\set since ''
\endif
\if :{?strict}
\else
\set strict 1
\endif
\set QUIET on
BEGIN;
SET LOCAL statement_timeout = '5min';
SELECT set_config('qa.surfaces', :'surfaces', true) AS v1, set_config('qa.since', :'since', true) AS v2,
       set_config('qa.verify_strict', :'strict', true) AS v3 \gset qa_
-- QUIET 유지: 임시 표 명령 태그 없이 결과 표와 QA_VERIFY_OK·QA_VERIFY_FAIL 알림만 나온다

DO $a$ BEGIN
  IF to_regclass('mig_src.qa_carry_ledger') IS NULL OR to_regclass('mig_src.qa_carry_report') IS NULL
     OR to_regclass('mig_src.qa_answer_reviews') IS NULL OR to_regclass('mig_src.qa_review_notes') IS NULL
     OR to_regclass('mig_src.qa_ref_job') IS NULL OR to_regclass('mig_src.qa_ref_citation') IS NULL
     OR to_regprocedure('mig_src.qa_review_hash(uuid,text,text,text,text,text,text,uuid,text,uuid,timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('mig_src.qa_note_hash(uuid,uuid,text,text,text,text,text,uuid,text,uuid,timestamptz,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'mig_src QA 표·지문 함수 없음: mig_src_qa.sql·migrate-qa.sql 을 먼저 실행한다';
  END IF;
END $a$;

CREATE TEMP TABLE _qv (no text NOT NULL, check_name text NOT NULL, expected text, actual text, verdict text NOT NULL, detail jsonb) ON COMMIT DROP;
CREATE TEMP TABLE _qv_scope ON COMMIT DROP AS
SELECT current_setting('qa.surfaces')::int2[] AS surfaces, nullif(current_setting('qa.since'), '')::date AS since;
-- 원장 행 상태
CREATE TEMP TABLE _qv_led ON COMMIT DROP AS
SELECT l.*, (a.job_id IS NOT NULL OR n.note_id IS NOT NULL) AS in_app,
       coalesce(CASE WHEN a.job_id IS NOT NULL THEN mig_src.qa_review_hash(a.job_id, a.flag_answer, a.flag_prompt, a.flag_mentions, a.flag_citations,
                                                                            a.flag_acr, a.flag_meta, a.reviewer_id, a.reviewer_name, a.session_id,
                                                                            a.reviewed_at, a.updated_at)
                     WHEN n.note_id IS NOT NULL THEN mig_src.qa_note_hash(n.note_id, n.job_id, n.target_kind, n.target_key, n.target_label, n.severity,
                                                                          n.body, n.reviewer_id, n.reviewer_name, n.session_id, n.created_at,
                                                                          n.resolved_at, n.resolved_by) END = l.dst_hash, false) AS untouched
  FROM mig_src.qa_carry_ledger l
  LEFT JOIN app.qa_answer_review a ON l.kind = 'review' AND a.job_id = l.key
  LEFT JOIN app.qa_review_note n ON l.kind = 'note' AND n.note_id = l.key;
-- 마지막 migrate 실행의 행 처리
CREATE TEMP TABLE _qv_last ON COMMIT DROP AS
SELECT r.kind, r.key, r.action, r.map_status
  FROM mig_src.qa_carry_report r
 WHERE r.run_at = (SELECT max(x.run_at) FROM mig_src.qa_carry_report x WHERE x.action NOT LIKE 'rollback%');

-- ── V1 행 수: 스테이지 = 이관 미수정 + 마지막 실행 skip_* ─────────────────────
INSERT INTO _qv
SELECT 'V1', k.kind || ' 행 수(스테이지 = 이관 미수정 + skip_*)', '0', u::text, CASE WHEN u = 0 THEN 'OK' ELSE 'FAIL' END,
       jsonb_build_object('stage', s, 'carried_untouched', c, 'skip_foreign', sf, 'skip_edited_in_back', se, 'skip_deleted_in_back', sd,
                          'unaccounted_keys', ul)
  FROM (VALUES ('review'), ('note')) k(kind)
  CROSS JOIN LATERAL (
    SELECT count(*) AS s,
           count(*) FILTER (WHERE l.untouched) AS c,
           count(*) FILTER (WHERE NOT coalesce(l.untouched, false) AND x.action = 'skip_foreign') AS sf,
           count(*) FILTER (WHERE NOT coalesce(l.untouched, false) AND x.action = 'skip_edited_in_back') AS se,
           count(*) FILTER (WHERE NOT coalesce(l.untouched, false) AND x.action = 'skip_deleted_in_back') AS sd,
           count(*) FILTER (WHERE NOT coalesce(l.untouched, false) AND x.action IS DISTINCT FROM 'skip_foreign'
                              AND x.action IS DISTINCT FROM 'skip_edited_in_back' AND x.action IS DISTINCT FROM 'skip_deleted_in_back') AS u,
           coalesce(jsonb_agg(left(st.key::text, 8) ORDER BY st.key) FILTER (
             WHERE NOT coalesce(l.untouched, false) AND x.action IS DISTINCT FROM 'skip_foreign'
               AND x.action IS DISTINCT FROM 'skip_edited_in_back' AND x.action IS DISTINCT FROM 'skip_deleted_in_back'), '[]') AS ul
      FROM (SELECT job_id AS key FROM mig_src.qa_answer_reviews WHERE k.kind = 'review'
            UNION ALL SELECT id FROM mig_src.qa_review_notes WHERE k.kind = 'note') st
      LEFT JOIN _qv_led l ON l.kind = k.kind AND l.key = st.key
      LEFT JOIN _qv_last x ON x.kind = k.kind AND x.key = st.key) q;

-- ── V2 리뷰 내용(이관 미수정): status·6 flags·이름·시각 ─────────────────────────
INSERT INTO _qv
SELECT 'V2', 'review 내용(status·flag 6·reviewer_name·reviewed_at·updated_at)', '0', count(*)::text,
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END, jsonb_build_object('keys', coalesce(jsonb_agg(left(s.job_id::text, 8)), '[]'))
  FROM mig_src.qa_answer_reviews s
  JOIN _qv_led l ON l.kind = 'review' AND l.key = s.job_id AND l.untouched
  JOIN app.qa_answer_review a ON a.job_id = s.job_id
 WHERE (s.status, s.section_flags->>'answer', s.section_flags->>'prompt', s.section_flags->>'mentions', s.section_flags->>'citations',
        s.section_flags->>'acr', s.section_flags->>'meta', s.reviewer_name, s.reviewed_at, s.updated_at)
       IS DISTINCT FROM
       (a.status, a.flag_answer, a.flag_prompt, a.flag_mentions, a.flag_citations, a.flag_acr, a.flag_meta, a.reviewer_name, a.reviewed_at,
        a.updated_at);

-- ── V3 노트 내용(키 제외, 이관 미수정) ─────────────────────────────────────────
INSERT INTO _qv
SELECT 'V3', 'note 내용(job·kind·label·severity·body·이름·시각·해결)', '0', count(*)::text,
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END, jsonb_build_object('keys', coalesce(jsonb_agg(left(s.id::text, 8)), '[]'))
  FROM mig_src.qa_review_notes s
  JOIN _qv_led l ON l.kind = 'note' AND l.key = s.id AND l.untouched
  JOIN app.qa_review_note a ON a.note_id = s.id
 WHERE (s.job_id, s.target_kind, s.target_label, s.severity, s.body, s.reviewer_name, s.created_at, s.resolved_at, s.resolved_by)
       IS DISTINCT FROM
       (a.job_id, a.target_kind, a.target_label, a.severity, a.body, a.reviewer_name, a.created_at, a.resolved_at, a.resolved_by);

-- ── V4 노트 키: app = 원장 new_key, 원장 legacy_key = 스테이지 키, 번역 규칙 재계산 ─────────
INSERT INTO _qv
SELECT 'V4', 'note 키(app = 원장 new_key, 번역 규칙)', '0', count(*)::text, CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END,
       jsonb_build_object('keys', coalesce(jsonb_agg(left(s.id::text, 8)), '[]'))
  FROM mig_src.qa_review_notes s
  JOIN _qv_led l ON l.kind = 'note' AND l.key = s.id AND l.untouched
  JOIN app.qa_review_note a ON a.note_id = s.id
  LEFT JOIN mig_src.qa_ref_citation rc ON rc.job_id = s.job_id
        AND rc.id = CASE WHEN s.target_kind = 'citation' AND s.target_key ~ '^[0-9]{1,18}$' THEN s.target_key::bigint END
 WHERE a.target_key IS DISTINCT FROM l.new_key
    OR l.legacy_key IS DISTINCT FROM s.target_key
    OR (l.map_status NOT IN ('cit_mapped', 'cit_unverified', 'cit_label') AND l.new_key IS DISTINCT FROM s.target_key)
    OR (l.map_status IN ('cit_mapped', 'cit_unverified') AND l.new_key IS DISTINCT FROM s.job_id::text || ':' || rc.ord)
    OR (l.map_status = 'cit_label' AND l.new_key !~ ('^' || s.job_id::text || ':[0-9]+$'));

-- ── V5 job 별 노트 수(전체·미해결): 스테이지 vs app ──────────────────────────────
INSERT INTO _qv
SELECT 'V5', 'job 별 노트 수(전체·미해결)', '0', count(*)::text, CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END,
       jsonb_build_object('jobs', coalesce(jsonb_agg(jsonb_build_object('job', left(coalesce(s.job_id, a.job_id)::text, 8), 'stage', s.n,
                                                                       'stage_open', s.open, 'app', a.n, 'app_open', a.open)), '[]'))
  FROM (SELECT job_id, count(*) AS n, count(*) FILTER (WHERE resolved_at IS NULL) AS open FROM mig_src.qa_review_notes GROUP BY 1) s
  FULL JOIN (SELECT job_id, count(*) AS n, count(*) FILTER (WHERE resolved_at IS NULL) AS open FROM app.qa_review_note GROUP BY 1) a
    ON a.job_id = s.job_id
 WHERE (s.n, s.open) IS DISTINCT FROM (a.n, a.open);

-- ── V6 대상별 노트 수(배지 = 정확한 키 일치 ∧ 미해결): 스테이지(원장 new_key) vs app ──────────
INSERT INTO _qv
SELECT 'V6', '대상별 노트 수(job·kind·키, 전체·미해결)', '0', count(*)::text, CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END,
       jsonb_build_object('targets', coalesce(jsonb_agg(jsonb_build_object('job', left(coalesce(s.job_id, a.job_id)::text, 8),
                                                                           'kind', coalesce(s.target_kind, a.target_kind),
                                                                           'key', coalesce(s.k, a.k), 'stage', s.n, 'app', a.n,
                                                                           'stage_open', s.open, 'app_open', a.open)), '[]'))
  FROM (SELECT n.job_id, n.target_kind, CASE WHEN l.key IS NOT NULL THEN l.new_key ELSE n.target_key END AS k, count(*) AS n,
               count(*) FILTER (WHERE n.resolved_at IS NULL) AS open
          FROM mig_src.qa_review_notes n LEFT JOIN mig_src.qa_carry_ledger l ON l.kind = 'note' AND l.key = n.id
         GROUP BY 1, 2, 3) s
  FULL JOIN (SELECT job_id, target_kind, target_key AS k, count(*) AS n, count(*) FILTER (WHERE resolved_at IS NULL) AS open
               FROM app.qa_review_note GROUP BY 1, 2, 3) a
    ON a.job_id = s.job_id AND a.target_kind = s.target_kind AND a.k IS NOT DISTINCT FROM s.k
 WHERE (s.n, s.open) IS DISTINCT FROM (a.n, a.open);

-- ── V7 진행률 동등(서버 범위 = rd.job ∧ surfaces ∧ round_date ≥ since): 표면별 total·reviewed·issues·notes ──────────
-- 노트 있는 job 은 job 단위 EXISTS 대신 DISTINCT job 집합과 해시 조인(운영 rd.job 전체를 한 번만 훑는다)
INSERT INTO _qv
SELECT 'V7', '진행률(서버 범위, 표면별 total·reviewed·issues·notes)', '0', count(*) FILTER (WHERE d)::text,
       CASE WHEN count(*) FILTER (WHERE d) = 0 THEN 'OK' ELSE 'FAIL' END,
       jsonb_build_object('surfaces', coalesce(jsonb_agg(jsonb_build_object('surface', surface, 'stage', leg, 'app', new)), '[]'))
  FROM (SELECT coalesce(l.surface, n.surface) AS surface, to_jsonb(l) - 'surface' AS leg, to_jsonb(n) - 'surface' AS new,
               (l.total, l.reviewed, l.issues, l.notes) IS DISTINCT FROM (n.total, n.reviewed, n.issues, n.notes) AS d
          FROM (SELECT j.surface, count(*) AS total, count(r.job_id) AS reviewed, count(*) FILTER (WHERE r.status = 'issue') AS issues,
                       count(x.job_id) AS notes
                  FROM rd.job j CROSS JOIN _qv_scope sc
                  LEFT JOIN mig_src.qa_answer_reviews r ON r.job_id = j.job_id
                  LEFT JOIN (SELECT DISTINCT job_id FROM mig_src.qa_review_notes) x ON x.job_id = j.job_id
                 WHERE j.surface = ANY (sc.surfaces) AND (sc.since IS NULL OR j.round_date >= sc.since) GROUP BY 1) l
          FULL JOIN (SELECT j.surface, count(*) AS total, count(a.job_id) AS reviewed, count(*) FILTER (WHERE a.status = 'issue') AS issues,
                            count(x.job_id) AS notes
                       FROM rd.job j CROSS JOIN _qv_scope sc
                       LEFT JOIN app.qa_answer_review a ON a.job_id = j.job_id
                       LEFT JOIN (SELECT DISTINCT job_id FROM app.qa_review_note) x ON x.job_id = j.job_id
                      WHERE j.surface = ANY (sc.surfaces) AND (sc.since IS NULL OR j.round_date >= sc.since) GROUP BY 1) n
            ON n.surface = l.surface) v;

-- ── V8 낱알 붙음 대조(레거시 붙음 = 원장 legacy_attached × 새 붙음 = 지금 rd 에서 다시 계산) ──────────
-- 새 붙음: mention = rd.v_answer_mention_raw.entity_id, citation = 'job_id:ord' 가 rd.v_answer_citation_raw 에 있음,
--          acr = rd.acr_cell_job ⋈ rd.v_acr_cell_run ⋈ rd.acr_choice(level 1·2·3) ⋈ rd.dim_entity 의 prompt_run_id:entity_id.
-- ingest 가 job 을 다시 채운 뒤에도 다시 돌려 표류를 잡는다(인용 ord 규칙 = ingest 합의 항목)
CREATE TEMP TABLE _qv_att ON COMMIT DROP AS
SELECT a.note_id, a.job_id, a.target_kind, a.target_key, l.map_status, l.legacy_attached,
       CASE a.target_kind
         WHEN 'mention' THEN EXISTS (SELECT 1 FROM rd.job j JOIN rd.v_answer_mention_raw m ON m.answer_key = j.answer_key
                                      WHERE j.job_id = a.job_id AND m.entity_id::text = a.target_key)
         WHEN 'citation' THEN EXISTS (SELECT 1 FROM rd.job j JOIN rd.v_answer_citation_raw c ON c.answer_key = j.answer_key
                                       WHERE j.job_id = a.job_id AND j.job_id::text || ':' || c.ord = a.target_key)
         WHEN 'acr' THEN EXISTS (SELECT 1 FROM rd.job j JOIN rd.acr_cell_job cj ON cj.answer_key = j.answer_key
                                   JOIN rd.v_acr_cell_run r ON r.acr_cell_key = cj.acr_cell_key
                                   JOIN rd.acr_choice ch ON ch.acr_cell_key = cj.acr_cell_key AND ch.level IN (1, 2, 3)
                                   JOIN rd.dim_entity e ON e.entity_key = ch.entity_key
                                  WHERE j.job_id = a.job_id AND r.prompt_run_id::text || ':' || e.entity_id::text = a.target_key) END AS new_attached
  FROM app.qa_review_note a
  JOIN _qv_led l ON l.kind = 'note' AND l.key = a.note_id AND l.untouched
 WHERE a.target_key IS NOT NULL AND a.target_kind IN ('mention', 'citation', 'acr');
INSERT INTO _qv
SELECT 'V8', k.kind || ' 낱알 붙음(레거시 × 새)', NULL,
       format('TT %s · TF %s · FT %s · FF %s', count(x.*) FILTER (WHERE x.legacy_attached AND x.new_attached),
              count(x.*) FILTER (WHERE x.legacy_attached AND NOT x.new_attached), count(x.*) FILTER (WHERE NOT x.legacy_attached AND x.new_attached),
              count(x.*) FILTER (WHERE NOT x.legacy_attached AND NOT x.new_attached)),
       'INFO',
       jsonb_build_object('legacy_attached_new_detached', coalesce(jsonb_agg(jsonb_build_object('note', left(x.note_id::text, 8),
                            'job', left(x.job_id::text, 8), 'key', x.target_key, 'map_status', x.map_status))
                            FILTER (WHERE x.legacy_attached AND NOT x.new_attached), '[]'),
                          'new_only', coalesce(jsonb_agg(left(x.note_id::text, 8)) FILTER (WHERE NOT x.legacy_attached AND x.new_attached), '[]'))
  FROM (VALUES ('mention'), ('citation'), ('acr')) k(kind)
  LEFT JOIN _qv_att x ON x.target_kind = k.kind
 GROUP BY k.kind;
INSERT INTO _qv
SELECT 'V8m', 'cit_mapped·cit_label 노트는 새 인용 낱알에 붙는다', '0', count(*)::text, CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END,
       jsonb_build_object('notes', coalesce(jsonb_agg(left(x.note_id::text, 8)), '[]'))
  FROM _qv_att x WHERE x.map_status IN ('cit_mapped', 'cit_label') AND NOT x.new_attached;

-- ── V9 가시성(레거시 보임 = scope_answers 에 있음 × 새 보임 = rd.job ∧ 서버 범위) + 새 고아 ──────────
INSERT INTO _qv
SELECT 'V9', k.kind || ' 가시성(레거시 × 새)', NULL,
       format('TT %s · TF %s · FT %s · FF %s · 새 고아 %s', count(v.key) FILTER (WHERE v.leg AND v.new),
              count(v.key) FILTER (WHERE v.leg AND NOT v.new), count(v.key) FILTER (WHERE NOT v.leg AND v.new),
              count(v.key) FILTER (WHERE NOT v.leg AND NOT v.new), count(v.key) FILTER (WHERE NOT v.in_job)),
       'INFO',
       jsonb_build_object('hidden_now', coalesce(jsonb_agg(left(v.key::text, 8)) FILTER (WHERE v.leg AND NOT v.new), '[]'),
                          'visible_now', coalesce(jsonb_agg(left(v.key::text, 8)) FILTER (WHERE NOT v.leg AND v.new), '[]'),
                          'orphan_jobs', coalesce(jsonb_agg(DISTINCT left(v.job_id::text, 8)) FILTER (WHERE NOT v.in_job), '[]'))
  FROM (VALUES ('review'), ('note')) k(kind)
  LEFT JOIN LATERAL (
    SELECT st.key, st.job_id, coalesce(rj.in_mirror, false) AS leg, j.job_id IS NOT NULL AS in_job,
           (j.job_id IS NOT NULL AND j.surface = ANY (sc.surfaces) AND (sc.since IS NULL OR j.round_date >= sc.since)) AS new
      FROM (SELECT job_id AS key, job_id FROM mig_src.qa_answer_reviews WHERE k.kind = 'review'
            UNION ALL SELECT id, job_id FROM mig_src.qa_review_notes WHERE k.kind = 'note') st
      CROSS JOIN _qv_scope sc
      LEFT JOIN mig_src.qa_ref_job rj ON rj.job_id = st.job_id
      LEFT JOIN rd.job j ON j.job_id = st.job_id) v ON true
 GROUP BY k.kind;

-- ── V10 무결성: 이관 미수정 행은 계정·세션 없음, 해결 쌍 ────────────────────────
INSERT INTO _qv
SELECT 'V10', '이관 행 session_id·reviewer_id NULL, 노트 해결 쌍', '0', (r.n + n.n + p.n)::text,
       CASE WHEN r.n + n.n + p.n = 0 THEN 'OK' ELSE 'FAIL' END, jsonb_build_object('review_ids', r.n, 'note_ids', n.n, 'resolved_pair', p.n)
  FROM (SELECT count(*) AS n FROM app.qa_answer_review a JOIN _qv_led l ON l.kind = 'review' AND l.key = a.job_id AND l.untouched
         WHERE a.session_id IS NOT NULL OR a.reviewer_id IS NOT NULL) r,
       (SELECT count(*) AS n FROM app.qa_review_note a JOIN _qv_led l ON l.kind = 'note' AND l.key = a.note_id AND l.untouched
         WHERE a.session_id IS NOT NULL OR a.reviewer_id IS NOT NULL) n,
       (SELECT count(*) AS n FROM app.qa_review_note WHERE (resolved_at IS NULL) <> (resolved_by IS NULL)) p;
INSERT INTO _qv
SELECT 'V10b', '락·세션 행(이관 안 함, 동결 창이면 0)·원천에서 사라졌지만 back 수정으로 남긴 원장 행', NULL,
       format('lock %s · session %s · ledger_without_stage %s', (SELECT count(*) FROM app.qa_answer_lock), (SELECT count(*) FROM app.qa_review_session),
              (SELECT count(*) FROM _qv_led l WHERE NOT EXISTS (SELECT 1 FROM mig_src.qa_answer_reviews s WHERE l.kind = 'review' AND s.job_id = l.key)
                                                AND NOT EXISTS (SELECT 1 FROM mig_src.qa_review_notes s WHERE l.kind = 'note' AND s.id = l.key))),
       'INFO', NULL;

-- ── V11 이름: back 정규화(제어문자 제거·trim·1~40자)와 다른 reviewer_name·resolved_by(작성자 수정 권한 = 이름 일치) ──────────
INSERT INTO _qv
SELECT 'V11', 'back 이름 정규화와 다른 reviewer_name·resolved_by', NULL, count(*)::text, 'INFO',
       jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'key', left(x.key::text, 8), 'field', x.field)), '[]'))
  FROM (SELECT 'review' AS kind, a.job_id AS key, 'reviewer_name' AS field FROM app.qa_answer_review a
          JOIN _qv_led l ON l.kind = 'review' AND l.key = a.job_id WHERE mig_src.qa_name_off(a.reviewer_name)
        UNION ALL
        SELECT 'note', a.note_id, 'reviewer_name' FROM app.qa_review_note a
          JOIN _qv_led l ON l.kind = 'note' AND l.key = a.note_id WHERE mig_src.qa_name_off(a.reviewer_name)
        UNION ALL
        SELECT 'note', a.note_id, 'resolved_by' FROM app.qa_review_note a
          JOIN _qv_led l ON l.kind = 'note' AND l.key = a.note_id WHERE mig_src.qa_name_off(a.resolved_by)) x;

SELECT no, check_name, expected, actual, verdict, detail FROM _qv ORDER BY substring(no FROM '[0-9]+')::int, no, check_name DESC;
DO $a$ DECLARE f text; BEGIN
  SELECT string_agg(no, ',' ORDER BY no) INTO f FROM _qv WHERE verdict = 'FAIL';
  IF f IS NULL THEN
    RAISE NOTICE 'QA_VERIFY_OK';
  ELSIF current_setting('qa.verify_strict') = '1' THEN
    RAISE EXCEPTION 'QA_VERIFY_FAIL %', f;
  ELSE
    RAISE NOTICE 'QA_VERIFY_FAIL %', f;
  END IF;
END $a$;

ROLLBACK;
