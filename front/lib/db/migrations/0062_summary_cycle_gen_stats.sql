-- 0062 — 사실표 (cycle_id, generation_id) 확장 통계 + 부모 ANALYZE.
--
-- 왜 (2026-09-07 프로덕션 실측):
-- 웹사이트 사실표 경로가 미러보다 느렸다 — KPI 카드 36.1s, Sub-KPI 는 120s
-- statement_timeout 으로 **실패**(화면은 300s 런타임 타임아웃). EXPLAIN:
--
--   Nested Loop Left Join (cost=… rows=1) (actual rows=19428) … 66,288ms
--     Join Filter: summary_brand_mentions.job_id = summary_answers.job_id
--     Rows Removed by Join Filter: 187,712,058
--     ->  Bitmap Heap Scan on summary_answers  19,428 rows  36ms    ← 스캔은 정상
--     ->  Unique (cost=… rows=8) (actual rows=9663 loops=19428)     ← CTE 를 19,428회 재실행
--
-- 원인은 조인 형태가 아니라 **선택도 추정**이다. 플래너가 cycle_id 와
-- generation_id 를 독립으로 보고 곱한다:
--   1/94(cycle) × 1/612(generation) × 58,704행 ≈ 1
-- 실제로는 generation 이 cycle 에 **함수 종속**이라 쌍당 ~194행이다(194배 과소).
-- 94쌍이 전부 이렇게 접혀 바깥 19,428행이 rows=1 로, 안쪽 9,663행이 rows=8 로
-- 추정됐고, 그 위에서 nested loop 이 "싸 보였다".
--
-- 처방: (dependencies, ndistinct, mcv) 확장 통계. 실측 결과
--   KPI 카드   36,087ms → 3,917ms (9.2배)
--   Sub-KPI   120,224ms 실패 → 2,604ms 성공
--   6문장 합계 150s+실패 → 9.9s
--
-- 함께 고치는 것 — **파티션 부모는 autovacuum 이 ANALYZE 하지 않는다**(자식만 돈다).
-- 적재 직후 부모 6개가 전부 `reltuples = -1` · 통계 컬럼 0개였다. 그 자체가 이번
-- 병목의 원인은 아니었지만(부모만 ANALYZE 했을 때 36.1s → 35.7s), 부모 대상 쿼리의
-- 계획이 통계 없이 잡히는 상태를 남겨둘 이유가 없다.
--
-- ⚠️ 확장 통계는 **테이블마다** 만들어야 한다 — 주 파티션을 새로 만들면 그 파티션엔
-- 통계 객체가 없어 같은 회귀가 돌아온다. 그래서 함수로 만들어 두고(아래
-- `summary_ensure_cycle_gen_stats`), 파티션을 만드는 쪽이 매번 호출한다.

CREATE OR REPLACE FUNCTION summary_ensure_cycle_gen_stats() RETURNS int
LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  stat_name text;
  n int := 0;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname LIKE 'summary\_%'
      -- 두 컬럼을 모두 가진 테이블만 (설정·원장 테이블 제외)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'cycle_id'     AND a.attnum > 0 AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'generation_id' AND a.attnum > 0 AND NOT a.attisdropped)
    ORDER BY c.relname
  LOOP
    stat_name := left('st_' || r.relname || '_cyc_gen', 63);
    IF NOT EXISTS (
      SELECT 1 FROM pg_statistic_ext e
      JOIN pg_namespace en ON en.oid = e.stxnamespace
      WHERE en.nspname = 'public' AND e.stxname = stat_name
    ) THEN
      EXECUTE format(
        'CREATE STATISTICS public.%I (dependencies, ndistinct, mcv) ON cycle_id, generation_id FROM public.%I',
        stat_name, r.relname);
    END IF;
    -- 통계 객체는 ANALYZE 가 돌아야 채워진다. 부모('p')는 autovacuum 대상이 아니므로
    -- 특히 여기서 돌려야 한다.
    EXECUTE format('ANALYZE public.%I', r.relname);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$fn$;

COMMENT ON FUNCTION summary_ensure_cycle_gen_stats() IS
  'summary_* 파티션 부모·자식에 (cycle_id, generation_id) 확장 통계를 만들고 ANALYZE 한다. 새 주 파티션을 만든 뒤 반드시 호출할 것 — 0062 머리 주석 참조.';

SELECT summary_ensure_cycle_gen_stats();

-- 앱 롤 이외 실행 차단 (0059 의 REVOKE 관례와 동일 — 통계 재계산은 운영 동작이다).
REVOKE ALL ON FUNCTION summary_ensure_cycle_gen_stats() FROM PUBLIC, anon, authenticated;
