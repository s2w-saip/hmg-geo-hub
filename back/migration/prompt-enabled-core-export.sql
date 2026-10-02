-- ============================================================================
-- Scope 코어 프롬프트 활성 여부 내보내기(읽기 전용, 1회) · DB-v2.14 P84 ing.prompt.enabled 이관 채움의 1단계 (제품 결정 21, 2026-10-01)
-- **작성만, 실행은 제품 책임자 승인 배치에서**. 코어 = Scope 운영 DB(이름이 staging 이어도 라이브 고객 DB다). 쓰기 없음.
--
-- 무엇을: 새 DB 가 동기화하는 Scope 프로젝트들의 삭제되지 않은 프롬프트 (id, project_id, enabled) 를 CSV 로 낸다.
--   본문·차원 등 다른 열은 내지 않는다(고객 문구 비반출). 코어 스키마 근거 = Scope lib/prompts/store.ts(prompts.enabled·deleted_at,
--   목록 API 도 deleted_at IS NULL 만 낸다), 2026-09-18 코어 조회(notes/ops/web_uncovered40_core_20260918.py)와 같은 열.
-- 입력: project_ids = 새 DB 에서 얻은 Scope 프로젝트 id 배열 리터럴. 새 DB 에서:
--   SELECT '{' || string_agg(scope_project_id::text, ',' ORDER BY scope_project_id) || '}' FROM ing.sync_cursor;
-- 사용(접속 URL 은 env 로만, argv·출력 금지. 결과 CSV 는 2단계 입력이며 끝나면 지운다):
--   psql -X -q -v ON_ERROR_STOP=1 -v project_ids='{…}' -f prompt-enabled-core-export.sql > prompt-enabled.csv
-- 2단계: back/migration/fill-prompt-enabled.sql(새 DB, CSV 를 stdin 으로).
-- ============================================================================
BEGIN READ ONLY;
DO $v$ BEGIN
  IF current_setting('transaction_read_only') <> 'on' THEN RAISE EXCEPTION 'read-only 트랜잭션이 아니다'; END IF;
END $v$;
SET LOCAL statement_timeout = '60s';
COPY (SELECT p.id AS prompt_id, p.project_id, p.enabled
        FROM prompts p
       WHERE p.deleted_at IS NULL AND p.project_id = ANY (:'project_ids'::uuid[])
       ORDER BY p.id) TO STDOUT WITH (FORMAT csv, HEADER true);
COMMIT;
