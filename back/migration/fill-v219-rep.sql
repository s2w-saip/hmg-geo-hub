-- ============================================================================
-- 재투영(stg·이미 적재된 DB): DB-v2.19 P109·P110 답변분석 경로 셀 대표(현행 프로필 rep_round_date_cell, WU-12, 제품 결정 19·25).
-- **작성만, 실행은 제품 책임자 승인 배치**(쓰기: rd.answer.is_rep 값이 다른 행·자식 사본·rd.rep_cit_delta 교체. stg 실측 예상 is_rep 8,245(글로벌 7,998·웹 247)·보정 표 7,998행).
--
-- 무엇을(자리 = (표면, round_date) 단위 배치, 배치마다 트랜잭션 1개)
--   ① rd.reselect_rep_seat(배치 자리): is_rep := 답변분석 규칙(round_date 셀), 범위 답변의 rd.rep_cit_delta(인용 계열 보정)를 기대값으로 교체
--   ② rd.fill_child_is_rep(①이 바꾼 답변 키): 자식 사본 rd.answer_brand·answer_stance·citation.is_rep
--   ③ rd.assert_rep_seat(배치 자리): is_rep = 규칙 · 보정 표 = 기대값 · is_rep ⇒ elig_nc · 자식 = 부모. 실패하면 그 배치만 롤백되고 멈춘다
-- 멱등·재개: 대상을 매번 DB 에서 고르고 값이 다른 행만 쓴다(두 번째 실행 = is_rep 갱신 0, 보정 표는 같은 행으로 교체).
-- 전제: DB-v2.19 적용, 적재 워커의 HGH_LEGACY_PROFILE 에 같은 스위치(다르면 다음 적재가 그 셀만
--   워커 규칙으로 되돌린다: 단언이 잡는다). 롤 = migrator.
-- 락: rd.answer·자식 표·rd.rep_cit_delta 행 잠금만. API 읽기는 막지 않는다(MVCC). 끝에 VACUUM (ANALYZE) 권장.
--
-- 사용(드라이런이 기본: 규칙과 다른 is_rep·보정 표 기대 행 수만 센다, 쓰기 없음):
--   psql -X -v ON_ERROR_STOP=1 -f fill-v219-rep.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 [-v seats=5] [-v full_assert=1] -f fill-v219-rep.sql
--   psql -1 로 돌리지 않는다(아래 DO 블록이 배치마다 COMMIT 한다). 커밋하면 끝에 app.result_cache_invalidate() 를 부른다(migrator).
-- 출력 = 개수만(답변 키·본문 없음).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
\if :{?seats}
\else
  \set seats 5
\endif
\if :{?full_assert}
\else
  \set full_assert 0
\endif
SET statement_timeout = 0;
SET lock_timeout = '30s';
SELECT set_config('fill.seats', :'seats', false) AS seats;

DO $v$ BEGIN
  IF to_regclass('rd.rep_cit_delta') IS NULL OR to_regprocedure('rd.reselect_rep_seat(int2[], date[], int4[], int2[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.19 가 먼저 적용돼야 한다(rd.rep_cit_delta·rd.reselect_rep_seat 없음)';
  END IF;
  IF current_setting('fill.seats')::int NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'seats 는 1..200';
  END IF;
  IF EXISTS (SELECT 1 FROM rd.answer WHERE elig_nc IS NULL) THEN
    RAISE EXCEPTION 'rd.answer.elig_nc 가 채워져 있어야 한다(fill-v215.sql §P89 먼저)';
  END IF;
END $v$;

-- 대상 자리(세션 임시 표: 배치 COMMIT 을 넘어 유지). 답변이 있는 (표면, round_date).
DROP TABLE IF EXISTS pg_temp._fill_seat;
CREATE TEMP TABLE _fill_seat AS
SELECT row_number() OVER (ORDER BY s.surface, s.round_date)::int AS rn, s.surface, s.round_date
  FROM (SELECT DISTINCT c.surface, c.round_date FROM rd.cycle c
         WHERE EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key)) s;
CREATE UNIQUE INDEX ON _fill_seat (rn);

SELECT (SELECT count(*) FROM _fill_seat) AS target_seats,
       count(*) FILTER (WHERE a.is_rep IS DISTINCT FROM r.rep_ana) AS is_rep_differs,
       count(*) FILTER (WHERE r.rep_ana_c IS DISTINCT FROM r.rep_ana) AS delta_cit_expected,
       (SELECT count(*) FROM rd.rep_cit_delta) AS delta_cit_rows_now
  FROM rd.rep_rules(NULL, NULL, NULL, NULL) r
  JOIN rd.answer a ON a.surface = r.surface AND a.round_date = r.round_date AND a.answer_key = r.answer_key;

\if :commit
DO $f$
DECLARE
  b int := current_setting('fill.seats')::int;
  n int := (SELECT count(*) FROM _fill_seat);
  i int := 0;
  sf int2[]; rdt date[];
  keys int4[];
  up_c int;
  tp bigint := 0; tc bigint := 0;
  t0 timestamptz := clock_timestamp();
BEGIN
  WHILE i * b < n LOOP
    SELECT array_agg(surface ORDER BY rn), array_agg(round_date ORDER BY rn) INTO sf, rdt FROM _fill_seat WHERE rn > i * b AND rn <= (i + 1) * b;
    SELECT coalesce(array_agg(f.answer_key), ARRAY[]::int4[]) INTO keys
      FROM rd.reselect_rep_seat(sf, rdt, ARRAY[]::int4[], ARRAY[]::int2[]) f;
    up_c := rd.fill_child_is_rep(keys);
    PERFORM rd.assert_rep_seat(sf, rdt, ARRAY[]::int4[], ARRAY[]::int2[]);
    COMMIT;
    tp := tp + cardinality(keys); tc := tc + up_c;
    i := i + 1;
    RAISE NOTICE 'fill-v219-rep 배치 %/%: 부모 % · 자식 % (누계 % · %, %s)', i, ceil(n::numeric / b)::int, cardinality(keys), up_c, tp, tc,
                 round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
  END LOOP;
  RAISE NOTICE 'fill-v219-rep 끝: 자리 %, 부모 갱신 %, 자식 갱신 %', n, tp, tc;
END $f$;

SELECT (SELECT count(*) FILTER (WHERE is_rep) FROM rd.answer) AS answer_reps,
       (SELECT count(*) FROM rd.rep_cit_delta) AS delta_cit;
\if :full_assert
SELECT rd.assert_rep_seat(NULL, NULL, NULL, NULL) AS full_assert_answers;
\endif
SELECT app.result_cache_invalidate() AS cache_invalidated;
\else
\echo '드라이런: 쓰기 없음. 실행은 -v commit=1'
\endif
DROP TABLE IF EXISTS pg_temp._fill_seat;
