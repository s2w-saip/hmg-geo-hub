-- 0002 리스 픽·리퍼 부분 인덱스. 측정 lane `0005_lease_scaling.sql`·`0006_reaper_indexes.sql`·
-- `0013_expired_sweep_idx.sql` 이 **실측으로 도달한 결론**을 처음부터 갖고 시작한다.
--
-- 측정 lane 이 치른 값(재사용 근거):
--   · 0005 — 후보 비율이 오르면 플래너가 픽 쿼리를 **Seq Scan 으로 뒤집는다**(1,533행 중 후보
--     488 → Seq Scan, shared hit 220). 폴러 수만큼 그 비용이 곱해진다. 수리 = 픽 조건과
--     **정렬 키까지 일치하는 부분 인덱스**, 그리고 OR 을 UNION ALL 로 분해해 ordered scan.
--   · 0006 — 리퍼는 원장 **전체**에서 라이브 상태를 찾는다. 선두 컬럼이 status 인 통합 인덱스는
--     Bitmap Index Scan 은 타지만 **그 status 의 모든 힙을 다시 읽어야** 술어를 평가한다.
--     부분 인덱스 술어를 리퍼 쿼리의 술어와 **글자 그대로** 맞춘다(플래너의 함의 증명은 동일
--     표현식에 대해서만 확실하다).
--
-- ⚠️ `IF NOT EXISTS` 를 쓰지 않는다 — 이미 존재해 no-op 이 되는 경우에도 **락을 먼저 잡는다**
--    (워크스페이스 룰 `pg-migration-lock-and-journal-traps`: no-op 이 ACCESS EXCLUSIVE 를 797초
--    대기시킨 실증). `to_regclass` 카탈로그 선확인은 락을 잡지 않는다.
-- ⚠️ CONCURRENTLY 는 쓸 수 없다: 마이그레이터가 advisory lock + schema_migrations 기록을
--    **한 트랜잭션**으로 묶는데 CREATE INDEX CONCURRENTLY 는 트랜잭션 안에서 실행 불가다.
--    라이브 상태 행만 인덱싱하므로 빌드 대상은 원장 전체가 아니라 큐 깊이 규모다.

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  -- 픽: queued 분기. 정렬 키(manual 우선 → next_eligible_at → created_at)까지 인덱스에 맞춘다.
  IF to_regclass('analysis_tickets_pick_queued_idx') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX analysis_tickets_pick_queued_idx
        ON analysis_tickets ((priority = 'manual') DESC, next_eligible_at, created_at)
        WHERE status = 'queued'
    $ddl$;
  END IF;

  -- 픽: deferred 분기. 선두가 next_eligible_at 인 것이 queued 와 다르다 — deferred 는 시간이
  -- 먼저 걸러지고 그 안에서 manual 이 우선이다.
  IF to_regclass('analysis_tickets_pick_deferred_idx') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX analysis_tickets_pick_deferred_idx
        ON analysis_tickets (next_eligible_at, (priority = 'manual') DESC, created_at)
        WHERE status = 'deferred'
    $ddl$;
  END IF;

  -- 리퍼 ①: 마감 초과 스윕. 술어를 `expire_deadlines` 와 글자 그대로 맞춘다.
  IF to_regclass('analysis_tickets_deadline_sweep_idx') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX analysis_tickets_deadline_sweep_idx
        ON analysis_tickets (deadline_at)
        WHERE status IN ('queued','deferred') AND failure_class IS DISTINCT FROM 'deadline'
    $ddl$;
  END IF;

  -- 리퍼 ②: 마감 스탬프가 찍힌 채 grace 를 넘긴 행의 terminal GC.
  -- ⚠️ ①의 부분 술어(`IS DISTINCT FROM 'deadline'`)와 정확히 **여집합**이라 ①을 못 탄다 —
  --    전용 인덱스가 없으면 0006 이 없앤 버퍼 처닝이 이 리퍼로 재발한다(측정 0013 의 경위).
  IF to_regclass('analysis_tickets_expired_sweep_idx') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX analysis_tickets_expired_sweep_idx
        ON analysis_tickets (deadline_at)
        WHERE status IN ('queued','deferred') AND failure_class = 'deadline'
    $ddl$;
  END IF;

  -- 리퍼 ③: attempt 소진 스윕.
  IF to_regclass('analysis_tickets_chronic_sweep_idx') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX analysis_tickets_chronic_sweep_idx
        ON analysis_tickets (attempt_count)
        WHERE status IN ('queued','deferred')
    $ddl$;
  END IF;
END $$;

-- SET LOCAL 은 트랜잭션 끝까지 산다. 마이그레이터가 전 마이그레이션을 한 트랜잭션에서 돌리므로
-- 여기서 되돌리지 않으면 0003+ 가 모르는 채 10s 타임아웃을 물려받는다(측정 0012·0014 와 같은 이유).
RESET lock_timeout;
