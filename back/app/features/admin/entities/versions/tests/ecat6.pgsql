-- E6 시험 준비·정리 문장(test_ad_entities_versions.py 가 load_named_sql 로 읽는다). ing 쓰기·세션 설정은 API 문장 정적 가드 대상이
-- 아니라 이 데이터 파일에 둔다(back/tests/README.md 6절).

-- name: cleanup
-- 시험마다 커밋된 엔티티 버전 상태를 전부 지운다(소유자 = superuser). 불변 트리거(ecat_version_guard·ecat_apply_guard·감사 append-only)는
-- 복제 모드에서 돌지 않는다. 뒤따르는 admin 시험은 버전 없는 상태(기존 명부 동작)를 본다.
SET session_replication_role = replica;
DELETE FROM app.judgment_change WHERE kind = 'entity_version';
DELETE FROM app.ecat_audit_log;
DELETE FROM app.ecat_review;
DELETE FROM app.ecat_apply;
DELETE FROM app.ecat_surface;
DELETE FROM app.ecat_entity;
DELETE FROM app.ecat_surface_def;
DELETE FROM app.ecat_version;
DELETE FROM app.rule_param WHERE key IN ('ecat_approvers', 'ecat_lint');
SET session_replication_role = origin;

-- name: answer_text
-- 답변 1(job …0001, 발생 행 없음)의 저장 본문
UPDATE ing.answer SET answer_text = $1 WHERE job_id = '90000000-0000-4000-8000-000000000001'

-- name: mention_surfaces
UPDATE ing.mention SET surfaces = ARRAY['Hyundai'] WHERE job_id = '90000000-0000-4000-8000-000000000001' AND entity_id = $1

-- name: occurrence
-- 답변 12(job …0012)의 발생 행 1개(문맥 조각 포함)
INSERT INTO ing.mention_occurrence (run_month, job_id, ord, entity_id, turn_index, source_start, source_end, surface_text,
                                    sentiment, mention_role, context_snippet)
SELECT m.run_month, m.job_id, 900, $1, 1, 10, 17, 'Hyundai', 'positive', 'recommendation', '…the best pick is Hyundai for value…'
  FROM ing.answer_key_map m WHERE m.job_id = '90000000-0000-4000-8000-000000000012'

-- name: role_loader
SET ROLE loader

-- name: role_reset
RESET ROLE

-- name: role_api_rw
SET LOCAL ROLE api_rw
