-- ============================================================================
-- 1회 채우기: DB-v2.20 P111 rd.web_target_url(⑥ 미러 정의 타겟 URL 사전 해석, WU-12). 번호는 통합 때 패치와 함께 바꾼다.
-- 무엇을: rd.refresh_web_target_url(NULL, NULL)(전체, 바뀐 행만) → rd.assert_web_target_url().
-- 드라이런이 기본: 같은 쓰기를 한 트랜잭션에서 해 보고 개수만 낸 뒤 ROLLBACK(commit=1 이면 COMMIT). 롤 = migrator.
--   psql -X -v ON_ERROR_STOP=1 -f fill-v220.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -f fill-v220.sql
-- 규모(stg hmg_r2 2026-10-01): 116,677 행, 약 1초. 뒤처리 없음(추적 표라 바뀐 행이 있으면 결과 캐시 데이터 버전이 오른다). 출력 = 개수만.
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
SET statement_timeout = '10min';
SET lock_timeout = '30s';
BEGIN;
DO $v$ BEGIN
  IF to_regprocedure('rd.refresh_web_target_url(int4[], int4[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.20 가 먼저 적용돼야 한다(rd.refresh_web_target_url 없음)';
  END IF;
END $v$;
SELECT 'refresh' AS step, rd.refresh_web_target_url(NULL, NULL) AS n;
SELECT 'assert' AS step, rd.assert_web_target_url() AS n;
\if :commit
COMMIT;
\else
ROLLBACK;
\endif
