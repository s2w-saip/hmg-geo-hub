-- ============================================================================
-- QA 검수 기록 이관 입력 추출 질의 정본(레거시 Supabase public, 읽기 전용). "-- name:" 블록 단위로 읽는다.
--   export.py --qa 가 한 커넥션·한 트랜잭션(REPEATABLE READ READ ONLY)에서 블록마다 COPY (질의) TO STDOUT(csv) 한다
--   → snap/qa/<이름>/00000.csv.gz. 열 순서 = mig_src_qa.sql 의 같은 이름 표(\copy 가 열 이름 없이 순서로 받는다).
--   back/tests/core/test_migrate_qa.py 가 tests.support.load_named_sql 로 같은 블록을 읽어 시험한다(파서 규칙: "--" 로 시작하는 줄은 버림).
-- 질의 끝에 세미콜론을 두지 않는다(COPY (…) 안에 들어간다). 줄 끝 주석도 두지 않는다.
-- 리뷰·노트 job 의 참조만 뽑는다(노트가 있는 job 의 인용·멘션·ACR). 레거시 세션(qa_review_sessions)·락(qa_answer_locks)은 이관하지 않아 뽑지 않는다.
-- ============================================================================

-- name: qa_answer_reviews
-- mig_src.sql·mig_src_qa.sql mig_src.qa_answer_reviews 열 순서(0055_qa_review_console.sql 33-44)
SELECT r.job_id, r.status, r.section_flags, r.reviewer_name, r.session_id, r.reviewed_at, r.updated_at
  FROM public.qa_answer_reviews r

-- name: qa_review_notes
-- mig_src.qa_review_notes 열 순서(0055:46-66)
SELECT n.id, n.job_id, n.target_kind, n.target_key, n.target_label, n.severity, n.body, n.reviewer_name, n.session_id, n.created_at,
       n.resolved_at, n.resolved_by
  FROM public.qa_review_notes n

-- name: qa_ref_job
-- 리뷰·노트 job 의 레거시 가시성(고아 분류): 레거시 목록·노트는 scope_answers 와 inner join 한다(qa-review.ts:932-944). 드롭은 scope_answers 행을 지운다
SELECT x.job_id, (a.job_id IS NOT NULL) AS in_mirror, a.run_id, a.measured_at
  FROM (SELECT job_id FROM public.qa_answer_reviews UNION SELECT job_id FROM public.qa_review_notes) x
  LEFT JOIN public.scope_answers a ON a.job_id = x.job_id

-- name: qa_ref_citation
-- 낱알 인용 노트가 있는 job 의 현재 인용 전부 + 레거시 ord = id 순 row_number(미러 insert 순서 = result.citations[] 순서 = 새 ing.citation.ord).
-- WHERE 가 job 단위로만 거르므로 창 함수는 job 의 인용 전부를 센다
SELECT c.job_id, c.id, row_number() OVER (PARTITION BY c.job_id ORDER BY c.id)::int AS ord, c.url, c.ref_index, c.domain
  FROM public.scope_citations c
 WHERE c.job_id IN (SELECT n.job_id FROM public.qa_review_notes n WHERE n.target_kind = 'citation' AND n.target_key IS NOT NULL)

-- name: qa_ref_mention
-- 낱알 멘션 노트가 있는 job 의 현재 멘션(키 = entity_id, granule-tables.tsx 184-189)
SELECT DISTINCT m.job_id, m.entity_id
  FROM public.scope_mentions m
 WHERE m.job_id IN (SELECT n.job_id FROM public.qa_review_notes n WHERE n.target_kind = 'mention' AND n.target_key IS NOT NULL)

-- name: qa_ref_acr
-- 낱알 ACR 노트가 있는 job 의 레거시 연결 = 4축 근사(run_id·prompt_id·target·region, qa-review.ts:708-719). 키 = prompt_run_id:entity_id
SELECT DISTINCT a.job_id, r.prompt_run_id, r.entity_id
  FROM public.scope_answers a
  JOIN public.scope_acr_rollups r ON r.run_id = a.run_id AND r.prompt_id = a.prompt_id
   AND r.target IS NOT DISTINCT FROM a.target AND r.region IS NOT DISTINCT FROM a.region
 WHERE a.job_id IN (SELECT n.job_id FROM public.qa_review_notes n WHERE n.target_kind = 'acr' AND n.target_key IS NOT NULL)
