-- 0007 보존(retention) 스윕의 접근 경로 (설계 리뷰 B9 · D6).
--
-- ── 무엇을 위한 인덱스인가
--
--   `app/tickets.ts` `purgeTerminalTickets` 가 "터미널이면서 `finished_at` 이 보존 기간보다
--   오래된" 티켓을 배치로 집는다. 그 술어에 맞는 인덱스가 없으면 이 잡은 **원장 전체 Seq Scan**
--   이고, 보존 잡은 정의상 원장이 가장 클 때 돈다 — 즉 없을수록 아플 때 더 아프다.
--   기존 인덱스로는 대체되지 않는다: 0001 의 넷은 전부 `status`·`next_eligible_at`·`leased_until`·
--   `turn_run_id`·`query_run_id` 축이고 `finished_at` 을 키로 가진 것이 하나도 없다.
--
--   술어는 `purgeTerminalTickets` 의 후보 서브쿼리와 **글자 그대로** 같아야 한다(플래너의 함의
--   증명은 동일 표현식에서만 확실하다 — 0002 헤더가 인용한 측정 lane 0006 의 결론, 그리고 술어가
--   어긋나 Seq Scan 이 됐던 0005 ②의 전례). 바꿀 때는 둘을 함께 바꾼다.
--
-- ── ⚠️ `CREATE INDEX CONCURRENTLY` 를 쓰지 **않는다** — 쓸 수 없다
--
--   이 리포의 마이그레이션 러너는 미적용분 전부를 **한 트랜잭션**에서 적용한다
--   (`app/migrate.ts` `migrate()` = `db.begin(...)`, 그 안에서 `pg_advisory_xact_lock`).
--   PostgreSQL 은 `CREATE INDEX CONCURRENTLY` 를 트랜잭션 블록 안에서 거부하므로
--   (`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`), 이 파일에 넣으면
--   **마이그레이션 전체가 실패하고 배포가 중단된다**(deploy 규약: migrate 실패 = 배포 중단).
--
--   그래서 일반 `CREATE INDEX` 다. 지금 그렇게 해도 되는 근거:
--     · `CREATE INDEX` 는 대상 테이블에 `SHARE` 를 잡아 **쓰기만** 막는다(읽기는 계속된다).
--     · 이 lane 은 아직 램프 전이고 `analysis_tickets` 는 작다. 인덱스 생성은 초 단위다.
--     · 아래 `lock_timeout` 이 10s 다 — 못 잡으면 **빨리 실패**하고, 실패한 마이그레이션은
--       배포를 세운다(조용히 오래 잡고 있는 것보다 낫다. 2026-07-31 `IF NOT EXISTS` 가 no-op
--       에서도 락을 먼저 잡아 797초를 대기한 전례와 같은 자리).
--   원장이 커진 뒤에 이 종류의 인덱스를 더 붙여야 하면, 러너를 "문장별 트랜잭션" 으로 바꾸거나
--   운영자가 손으로 CONCURRENTLY 를 만든 뒤 `to_regclass` 가드가 그것을 인식하게 하는 쪽이다.
--   **지금 그 복잡도를 사지 않는다**(러너 규약을 바꾸는 것은 별도 변경이다).
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  -- `purgeTerminalTickets` 의 후보 서브쿼리 술어와 **글자 그대로** 같다.
  IF to_regclass('analysis_tickets_retention_idx') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX analysis_tickets_retention_idx
        ON analysis_tickets (finished_at)
        WHERE status IN ('completed','failed','cancelled')
    $ddl$;
  END IF;
END $$;

RESET lock_timeout;
