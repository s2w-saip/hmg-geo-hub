-- ============================================================================
-- mig_src QA 검수 기록 이관 표(2026-10-14). 멱등(IF NOT EXISTS·CREATE OR REPLACE). 소유 = 적용자(소유자 admin, migrate-qa 실행 롤과 같다).
--   스테이지 2표  qa_answer_reviews·qa_review_notes = mig_src.sql 과 같은 열(이미 있으면 그대로 둔다. mig_src.sql 판에는 PK 가 없어
--                 migrate-qa.sql 사전 단언이 키 유일을 따로 확인한다)
--   참조 4표      qa_ref_job·qa_ref_citation·qa_ref_mention·qa_ref_acr = export-qa.sql 같은 이름 블록의 열 순서
--   원장          qa_carry_ledger: 이관이 app 에 쓴 행의 지문(원천 src_hash·쓴 값 dst_hash·키 번역). 재실행 판정·롤백의 근거
--   보고          qa_carry_report: 실행마다 행 단위 처리(action·map_status·detail). 드라이런이면 같이 롤백된다
--   지문 함수     qa_review_hash·qa_note_hash: app 행 투영의 md5(시각은 epoch 로 바꿔 세션 TimeZone·DateStyle 과 무관). migrate·verify·rollback 공용.
--                 이 함수 정의를 바꾸면 원장 dst_hash 가 모두 어긋나(back 수정으로 보인다) 재실행·롤백이 행을 건너뛴다. 바꾸지 않는다
-- 원장·보고를 mig 스키마(DDL 정본)가 아니라 mig_src 에 두는 이유(결정 5 기본값): DB 패치가 필요 없고 스테이지와 수명이 같다.
--   이관 승인 뒤 mig_src 를 지우면 재실행 판정·롤백 근거도 함께 사라진다(= 롤백 창 종료). mig.* 로 옮기려면 DB 패치가 필요하다.
-- 레거시 세션(qa_review_sessions)·락(qa_answer_locks)은 이관하지 않는다(결정 기본값: 이관 행 session_id NULL = back 로그아웃 뒤 상태).
--
-- 사용:
--   psql -X -v ON_ERROR_STOP=1 -f mig_src_qa.sql                        # 표만(이어서 qa-load 가 snap/qa 를 적재)
--   psql -X -v ON_ERROR_STOP=1 -v from_snapshot=1 -f mig_src_qa.sql     # stg 리허설: 10-06 mig_src 스냅샷(scope_*·qa_*)에서 참조 4표를 만든다
--     (변수를 정의하기만 하면 켜진다. ing.citation 이 같은 스냅샷으로 시드됐으므로 ord 가 정확히 맞는다)
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS mig_src;

-- ── 스테이지(레거시 원천 그대로) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mig_src.qa_answer_reviews (
    job_id uuid NOT NULL,
    status text NOT NULL,
    section_flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    reviewer_name text NOT NULL,
    session_id uuid,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT qa_answer_reviews_status_ck CHECK ((status = ANY (ARRAY['ok'::text, 'issue'::text]))),
    PRIMARY KEY (job_id)
);

CREATE TABLE IF NOT EXISTS mig_src.qa_review_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_key text,
    target_label text,
    severity text DEFAULT 'issue'::text NOT NULL,
    body text NOT NULL,
    reviewer_name text NOT NULL,
    session_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    CONSTRAINT qa_review_notes_kind_ck CHECK ((target_kind = ANY (ARRAY['answer'::text, 'prompt'::text, 'mention'::text, 'citation'::text, 'acr'::text, 'meta'::text]))),
    CONSTRAINT qa_review_notes_severity_ck CHECK ((severity = ANY (ARRAY['issue'::text, 'question'::text, 'info'::text]))),
    PRIMARY KEY (id)
);

-- ── 참조(같은 추출 시점의 레거시 낱알·가시성) ────────────────────────────────
-- 리뷰·노트 job 의 레거시 가시성: in_mirror = 레거시 scope_answers 에 있다(드롭·원본 고아면 false)
CREATE TABLE IF NOT EXISTS mig_src.qa_ref_job (job_id uuid PRIMARY KEY, in_mirror bool NOT NULL, run_id uuid, measured_at timestamptz);
-- 인용 노트 job 의 레거시 인용: id = 레거시 노트 키(bigserial), ord = job 안 id 순 row_number(= 새 ing.citation.ord 규칙)
CREATE TABLE IF NOT EXISTS mig_src.qa_ref_citation (job_id uuid NOT NULL, id bigint NOT NULL, ord int NOT NULL, url text, ref_index int, domain text,
  PRIMARY KEY (job_id, id));
CREATE TABLE IF NOT EXISTS mig_src.qa_ref_mention (job_id uuid NOT NULL, entity_id uuid NOT NULL, PRIMARY KEY (job_id, entity_id));
CREATE TABLE IF NOT EXISTS mig_src.qa_ref_acr (job_id uuid NOT NULL, prompt_run_id uuid NOT NULL, entity_id uuid NOT NULL,
  PRIMARY KEY (job_id, prompt_run_id, entity_id));

-- ── 원장·보고 ───────────────────────────────────────────────────────────────
-- 원장: 이관이 app 에 쓴(또는 덮은) 행. key = review 는 job_id, note 는 note_id(= 레거시 id). dst_hash = 쓴 값의 qa_*_hash
CREATE TABLE IF NOT EXISTS mig_src.qa_carry_ledger (kind text NOT NULL CHECK (kind IN ('review','note')), key uuid NOT NULL,
  job_id uuid NOT NULL, src_hash text NOT NULL, dst_hash text NOT NULL, legacy_key text, new_key text, map_status text,
  legacy_attached bool, carried_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, key));
-- 보고: run_at = 실행 시작 clock_timestamp(). action = migrate-qa(insert·update·noop·skip_*·overwrite_foreign·delete_gone_in_source·forget_gone)
--       또는 rollback-qa(rollback_*). detail = 키·URL·가시성(이름·본문 없음)
CREATE TABLE IF NOT EXISTS mig_src.qa_carry_report (run_at timestamptz NOT NULL, kind text NOT NULL, key uuid NOT NULL, job_id uuid,
  action text NOT NULL, map_status text, detail jsonb, PRIMARY KEY (run_at, kind, key));

-- ── 지문 함수(app 행 투영, 쓸 값 투영 공용) ──────────────────────────────────
CREATE OR REPLACE FUNCTION mig_src.qa_review_hash(job_id uuid, flag_answer text, flag_prompt text, flag_mentions text, flag_citations text,
  flag_acr text, flag_meta text, reviewer_id uuid, reviewer_name text, session_id uuid, reviewed_at timestamptz, updated_at timestamptz)
RETURNS text LANGUAGE sql STABLE AS
$f$ SELECT md5(row($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, extract(epoch FROM $11), extract(epoch FROM $12))::text) $f$;

CREATE OR REPLACE FUNCTION mig_src.qa_note_hash(note_id uuid, job_id uuid, target_kind text, target_key text, target_label text,
  severity text, body text, reviewer_id uuid, reviewer_name text, session_id uuid, created_at timestamptz, resolved_at timestamptz,
  resolved_by text)
RETURNS text LANGUAGE sql STABLE AS
$f$ SELECT md5(row($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, extract(epoch FROM $11), extract(epoch FROM $12), $13)::text) $f$;

-- back 검수자 이름 정규화(core.auth.normalize_reviewer_name: 제어문자 제거 + 앞뒤 공백 제거, 1~40자)와 다른 이름(보고용 근사:
-- JS trim·Python strip 과 PostgreSQL \s 의 공백 집합이 특수 공백에서 다를 수 있다). 노트 수정·삭제 권한이 이름 일치라 다르면 작성자가 못 고친다
CREATE OR REPLACE FUNCTION mig_src.qa_name_off(name text) RETURNS bool LANGUAGE sql IMMUTABLE AS
$f$ SELECT $1 IS NOT NULL AND ($1 <> regexp_replace(regexp_replace($1, '[\x01-\x1f\x7f]', '', 'g'), '^\s+|\s+$', '', 'g')
                               OR char_length($1) > 40 OR $1 = '') $f$;

\if :{?from_snapshot}
-- ── stg 리허설: 10-06 mig_src 스냅샷에서 참조 4표(export-qa.sql 같은 이름 블록의 public → mig_src) ──────────────
TRUNCATE mig_src.qa_ref_job, mig_src.qa_ref_citation, mig_src.qa_ref_mention, mig_src.qa_ref_acr;
INSERT INTO mig_src.qa_ref_job (job_id, in_mirror, run_id, measured_at)
SELECT x.job_id, (a.job_id IS NOT NULL), a.run_id, a.measured_at
  FROM (SELECT job_id FROM mig_src.qa_answer_reviews UNION SELECT job_id FROM mig_src.qa_review_notes) x
  LEFT JOIN mig_src.scope_answers a ON a.job_id = x.job_id;
INSERT INTO mig_src.qa_ref_citation (job_id, id, ord, url, ref_index, domain)
SELECT c.job_id, c.id, row_number() OVER (PARTITION BY c.job_id ORDER BY c.id)::int, c.url, c.ref_index, c.domain
  FROM mig_src.scope_citations c
 WHERE c.job_id IN (SELECT n.job_id FROM mig_src.qa_review_notes n WHERE n.target_kind = 'citation' AND n.target_key IS NOT NULL);
INSERT INTO mig_src.qa_ref_mention (job_id, entity_id)
SELECT DISTINCT m.job_id, m.entity_id
  FROM mig_src.scope_mentions m
 WHERE m.job_id IN (SELECT n.job_id FROM mig_src.qa_review_notes n WHERE n.target_kind = 'mention' AND n.target_key IS NOT NULL);
INSERT INTO mig_src.qa_ref_acr (job_id, prompt_run_id, entity_id)
SELECT DISTINCT a.job_id, r.prompt_run_id, r.entity_id
  FROM mig_src.scope_answers a
  JOIN mig_src.scope_acr_rollups r ON r.run_id = a.run_id AND r.prompt_id = a.prompt_id
   AND r.target IS NOT DISTINCT FROM a.target AND r.region IS NOT DISTINCT FROM a.region
 WHERE a.job_id IN (SELECT n.job_id FROM mig_src.qa_review_notes n WHERE n.target_kind = 'acr' AND n.target_key IS NOT NULL);
SELECT 'from_snapshot' AS src, (SELECT count(*) FROM mig_src.qa_ref_job) AS ref_job, (SELECT count(*) FROM mig_src.qa_ref_citation) AS ref_citation,
       (SELECT count(*) FROM mig_src.qa_ref_mention) AS ref_mention, (SELECT count(*) FROM mig_src.qa_ref_acr) AS ref_acr;
\endif
