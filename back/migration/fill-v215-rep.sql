-- ============================================================================
-- 1회 채우기(stg·이미 적재된 DB): DB-v2.15 P85 셀 대표(A1, WU-2). 부모 rd.answer.is_rep 을 규칙대로 다시 고르고(선택) 자식 사본
-- rd.answer_brand·rd.answer_stance·rd.citation.is_rep 을 부모 값으로 맞춘 뒤 단언한다. 현행 값 재현 되돌림(제품 결정 19·23~25).
-- **작성만, 실행은 제품 책임자 승인 배치**(대량 UPDATE: 자식 표 중 대표 답변 행 전부 false → true, stg 실측 기준 자식 행의 약 3분의 2).
--
-- 무엇을(회차 단위 배치, 배치마다 트랜잭션 1개)
--   ① 부모: rd.reselect_rep(배치 회차, latest_first)(값이 다른 행만). 규칙 = 현행 프로필 rep_pick_latest_first 와 같게 준다:
--      latest_first=1 이면 현행 규칙(셀 최신 1건을 게이트 전에 굳힘), 0 이면 hub 규칙(elig 후보 안 최신, 적재 기본). 적재 워커의
--      HGH_LEGACY_PROFILE 과 다르면 다음 적재가 그 셀만 워커 규칙으로 되돌린다(단언 assert_rep 가 잡는다). stg 2026-10-01 실측: 두 규칙의
--      대표 집합이 세 표면 모두 같다(차이 0) → ① 은 0행이 예상값이다.
--   ② 자식: rd.fill_child_is_rep(배치 회차의 서빙 답변 키)(값이 다른 행만).
--   ③ 단언: rd.assert_rep(배치 회차, latest_first)(is_rep ⇒ elig, 셀당 ≤ 1, 부모 = 규칙, 자식 = 부모). 실패하면 그 배치만 롤백되고 멈춘다.
-- 멱등·재개: 대상을 매번 DB 에서 고르고 값이 다른 행만 쓴다. 다시 돌리면 남은 회차만 바뀐다(두 번째 실행 = 0행).
-- 전제: DB-v2.15 적용, 적재 워커 정지(채우는 동안 재투영이 같은 답변을 지우고 다시 넣어도 새 적재기는 전파로 맞추지만, 7129851e 이전
--   적재기는 뒤집힌 다른 답변을 전파하지 않는다 → 새 코드 배포 뒤에 돌린다). 롤 = migrator.
-- 락: rd.answer(①)·자식 표(②)에 ROW EXCLUSIVE(행 잠금만). API 읽기는 막지 않는다(MVCC). 새 튜플이 생기므로 끝에 VACUUM (ANALYZE) 권장.
--
-- 사용(드라이런이 기본: 규칙 불일치 부모·자식 불일치 행 수만 센다, 쓰기 없음):
--   psql -X -v ON_ERROR_STOP=1 [-v latest_first=1] -f fill-v215-rep.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 [-v latest_first=1] [-v cycles=5] [-v full_assert=1] -f fill-v215-rep.sql
--   psql -1 로 돌리지 않는다(아래 DO 블록이 배치마다 COMMIT 한다).
-- 뒤처리: migrator 로 `SELECT app.result_cache_invalidate();`(rd.answer 는 데이터 버전 추적 표가 아니다. cell_rep 을 켜기 전이라도 규약대로).
-- 출력 = 개수만(답변 키·본문 없음).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
\if :{?latest_first}
\else
  \set latest_first 0
\endif
\if :{?cycles}
\else
  \set cycles 5
\endif
\if :{?full_assert}
\else
  \set full_assert 0
\endif
SET statement_timeout = 0;
SET lock_timeout = '30s';
SELECT set_config('fill.latest_first', :'latest_first', false) AS latest_first, set_config('fill.cycles', :'cycles', false) AS cycles;

DO $v$ BEGIN
  IF to_regprocedure('rd.rep_expected(int4[], bool)') IS NULL OR to_regprocedure('rd.assert_rep(int4[], bool)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.citation'::regclass AND attname = 'is_rep' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.15 가 먼저 적용돼야 한다(rd.rep_expected·rd.assert_rep·rd.citation.is_rep 없음)';
  END IF;
  IF current_setting('fill.latest_first') NOT IN ('0', '1') THEN
    RAISE EXCEPTION 'latest_first 는 0 또는 1';
  END IF;
  IF current_setting('fill.cycles')::int NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'cycles 는 1..500';
  END IF;
  -- 현행 규칙 게이트 = rd.answer.elig_nc(DB-v2.15 P89, WU-4): fill-v215.sql §P89 가 먼저 채워야 한다(순서: fill-v215.sql → 이 파일)
  IF current_setting('fill.latest_first') = '1' AND EXISTS (SELECT 1 FROM rd.answer WHERE elig_nc IS NULL) THEN
    RAISE EXCEPTION 'latest_first=1 은 rd.answer.elig_nc 가 채워져 있어야 한다(fill-v215.sql §P89 먼저)';
  END IF;
END $v$;

-- 대상 회차(세션 임시 표: 배치 COMMIT 을 넘어 유지). 서빙 답변이 있는 회차만.
DROP TABLE IF EXISTS pg_temp._fill_rep;
CREATE TEMP TABLE _fill_rep AS
SELECT row_number() OVER (ORDER BY c.cyc_key)::int AS rn, c.cyc_key
  FROM rd.cycle c
 WHERE EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key);
CREATE UNIQUE INDEX ON _fill_rep (rn);

SELECT (SELECT count(*) FROM _fill_rep) AS target_cycles,
       (SELECT count(*) FROM rd.rep_expected(NULL, current_setting('fill.latest_first') = '1') e
          JOIN rd.answer a ON a.surface = e.surface AND a.round_date = e.round_date AND a.answer_key = e.answer_key
         WHERE a.is_rep IS DISTINCT FROM e.rep) AS parent_rule_differs,
       (SELECT count(*) FROM rd.answer_brand x JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
         WHERE x.is_rep IS DISTINCT FROM a.is_rep) AS brand_differs,
       (SELECT count(*) FROM rd.answer_stance x JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
         WHERE x.is_rep IS DISTINCT FROM a.is_rep) AS stance_differs,
       (SELECT count(*) FROM rd.citation x JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
         WHERE x.is_rep IS DISTINCT FROM a.is_rep) AS citation_differs;

\if :commit
DO $f$
DECLARE
  b int := current_setting('fill.cycles')::int;
  lf bool := current_setting('fill.latest_first') = '1';
  n int := (SELECT count(*) FROM _fill_rep);
  i int := 0;
  cyc int4[];
  keys int4[];
  up_p int; up_c int;
  tp bigint := 0; tc bigint := 0;
  t0 timestamptz := clock_timestamp();
BEGIN
  WHILE i * b < n LOOP
    SELECT array_agg(cyc_key ORDER BY cyc_key) INTO cyc FROM _fill_rep WHERE rn > i * b AND rn <= (i + 1) * b;
    up_p := rd.reselect_rep(cyc, lf);
    SELECT coalesce(array_agg(a.answer_key ORDER BY a.answer_key), ARRAY[]::int4[]) INTO keys
      FROM rd.cycle c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key
     WHERE c.cyc_key = ANY (cyc);
    up_c := rd.fill_child_is_rep(keys);
    PERFORM rd.assert_rep(cyc, lf);
    COMMIT;
    tp := tp + up_p; tc := tc + up_c;
    i := i + 1;
    RAISE NOTICE 'fill-v215-rep 배치 %/%: 부모 % · 자식 % (누계 % · %, %s)', i, ceil(n::numeric / b)::int, up_p, up_c, tp, tc,
                 round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
  END LOOP;
  RAISE NOTICE 'fill-v215-rep 끝: 회차 %, 부모 갱신 %, 자식 갱신 %', n, tp, tc;
END $f$;

SELECT (SELECT count(*) FILTER (WHERE is_rep) FROM rd.answer) AS answer_reps,
       (SELECT count(*) FILTER (WHERE is_rep) FROM rd.answer_brand) AS brand_reps,
       (SELECT count(*) FILTER (WHERE is_rep) FROM rd.answer_stance) AS stance_reps,
       (SELECT count(*) FILTER (WHERE is_rep) FROM rd.citation) AS citation_reps;
\if :full_assert
SELECT rd.assert_rep(NULL, current_setting('fill.latest_first') = '1') AS full_assert_answers;
\endif
\else
\echo '드라이런: 쓰기 없음. 실행은 -v commit=1'
\endif
DROP TABLE IF EXISTS pg_temp._fill_rep;

-- 확인(읽기 전용, 필요 시):
--   SELECT rd.assert_rep(NULL, true);          -- 전수 단언(현행 규칙). 무겁다(자식 표 전 행 조인)
--   VACUUM (ANALYZE) rd.answer_brand, rd.answer_stance, rd.citation;   -- 채운 뒤(migrator 또는 소유자)
