-- ============================================================================
-- 1회 채우기: DB-v2.25 P132 rd.entity_mention_total(관리 엔티티 목록 = 엔티티별 전 기간 합계, 엔티티 관리 5차 항목 1). 번호는 통합 때
-- 패치와 함께 바꾼다.
-- 무엇을: rd.refresh_entity_mention_total(NULL)(전체 재계산, 증분 원장 비움) → rd.assert_entity_mention_total().
-- 드라이런이 기본: 같은 쓰기를 한 트랜잭션에서 해 보고 개수만 낸 뒤 ROLLBACK(commit=1 이면 COMMIT). 롤 = migrator.
--   psql -X -v ON_ERROR_STOP=1 -f fill-v225.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -f fill-v225.sql
-- 재구축·복구에도 같은 파일을 쓴다(합계는 ing 원천만 보므로 rd 재구축 seed-40 과 무관하다: ing 를 다시 적재했을 때만 필요).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
SET statement_timeout = '30min';
SET lock_timeout = '30s';
BEGIN;
DO $v$ BEGIN
  IF to_regprocedure('rd.refresh_entity_mention_total(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.25 엔티티 합계 패치가 먼저 적용돼야 한다(rd.refresh_entity_mention_total 없음)';
  END IF;
END $v$;
SELECT 'refresh' AS step, rd.refresh_entity_mention_total(NULL) AS n;
SELECT 'assert' AS step, rd.assert_entity_mention_total() AS n;
\if :commit
COMMIT;
\else
ROLLBACK;
\endif
