-- ============================================================================
-- 1회 채우기(stg·이미 적재된 DB): DB-v2.18 P105 rd.answer.t_own(당사 언급 유형 마스크, 인용 출처 유형 문장 답변 열 경로).
-- **작성만, 실행은 제품 책임자 승인 배치**(대량 UPDATE: stg rd.answer 서빙 답변 전 행 1회 재작성).
--
-- 무엇을
--   ① rd.answer.t_own: 서빙 답변 중 아직 빈 것(recheck=1 이면 전부)이 대상, 배치마다 트랜잭션 1개:
--      rd.fill_answer_t_own(배치 키)(값이 다른 행만, 끝에 그 키 NULL 0 단언) → rd.assert_answer_t_own(배치 키)(= rd.answer_brand 재계산) → COMMIT.
--      단언이 실패하면 그 배치만 롤백되고 멈춘다(앞 배치는 커밋된 채, 재실행이 이어받는다).
--   ② 검증(validate=1, 기본): ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_t_own_range·answer_t_own_in_mask
--      (SHARE UPDATE EXCLUSIVE = 읽기·쓰기 안 막음, 전 행 스캔). 소유자 권한(hmg_owner 또는 superuser)이 필요하다.
-- 멱등·재개: 대상을 매번 DB 에서 다시 고르고 값이 다른 행만 쓴다. 끊겨도 같은 명령을 다시 돌리면 남은 행만 바뀐다(두 번째 실행 = 0행).
-- 전제: DB-v2.18 적용 + t_own 을 쓰는 적재기 배포(그 전 적재분은 NULL 로 들어온다 → 이 파일 재실행이 채운다). 채우는 동안 적재가 같은
--   답변을 재투영하면 적재기가 새 값을 쓰므로 충돌하지 않는다(행 잠금 대기만). 롤 = migrator(VALIDATE 만 소유자).
--
-- 사용(드라이런이 기본: 대상 수·이미 채운 행·배치 수만 센다, 쓰기 없음):
--   psql -X -v ON_ERROR_STOP=1 -f fill-v218.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 [-v batch=20000] [-v recheck=1] [-v validate=0] [-v full_assert=1] -f fill-v218.sql
--   psql -1(단일 트랜잭션)로 돌리지 않는다: 아래 DO 블록이 배치마다 COMMIT 한다(자동 커밋 문장이어야 한다).
--   full_assert=1: 끝에 rd.assert_answer_t_own(NULL)(채운 행 전부 재계산, 가장 무겁다).
-- 뒤처리: migrator 로 `SELECT app.result_cache_invalidate();`(rd.answer 는 데이터 버전 추적 표가 아니다. 채운 뒤 조회가 jt 폴백에서
--   답변 열 경로로 바뀌지만 값은 같다: 규약대로 무효화).
-- 출력 = 개수만(답변 키·본문 없음).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
\if :{?batch}
\else
  \set batch 20000
\endif
\if :{?recheck}
\else
  \set recheck 0
\endif
\if :{?validate}
\else
  \set validate 1
\endif
\if :{?full_assert}
\else
  \set full_assert 0
\endif
SET statement_timeout = 0;
SET lock_timeout = '30s';
SELECT set_config('fill.batch', :'batch', false) AS batch, set_config('fill.recheck', :'recheck', false) AS recheck;

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 't_own' AND NOT attisdropped)
     OR to_regprocedure('rd.fill_answer_t_own(int4[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.18 이 먼저 적용돼야 한다(rd.answer.t_own·rd.fill_answer_t_own 없음)';
  END IF;
  IF current_setting('fill.batch')::int NOT BETWEEN 1 AND 200000 THEN
    RAISE EXCEPTION 'batch 는 1..200000';
  END IF;
END $v$;

-- 대상(세션 임시 표: 배치 COMMIT 을 넘어 유지). 서빙 답변(rd.job served)만: rd.answer 는 서빙 답변 = 행.
DROP TABLE IF EXISTS pg_temp._fill_v218;
CREATE TEMP TABLE _fill_v218 AS
SELECT row_number() OVER (ORDER BY j.answer_key)::int AS rn, j.answer_key
  FROM rd.job j
  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.served AND (current_setting('fill.recheck') = '1' OR a.t_own IS NULL);
CREATE UNIQUE INDEX ON _fill_v218 (rn);
ANALYZE _fill_v218;

SELECT (SELECT count(*) FROM _fill_v218) AS target_answers,
       (SELECT count(*) FROM rd.answer WHERE t_own IS NOT NULL) AS already_filled,
       (SELECT count(*) FROM rd.answer WHERE t_own IS NULL) AS unfilled_rows,
       ceil((SELECT count(*) FROM _fill_v218)::numeric / current_setting('fill.batch')::int)::int AS batches;

\if :commit
DO $f$
DECLARE
  b int := current_setting('fill.batch')::int;
  n int := (SELECT count(*) FROM _fill_v218);
  i int := 0;
  keys int4[];
  upd int;
  tot bigint := 0;
  t0 timestamptz := clock_timestamp();
BEGIN
  WHILE i * b < n LOOP
    SELECT array_agg(answer_key ORDER BY answer_key) INTO keys FROM _fill_v218 WHERE rn > i * b AND rn <= (i + 1) * b;
    upd := rd.fill_answer_t_own(keys);
    PERFORM rd.assert_answer_t_own(keys);
    COMMIT;
    tot := tot + upd;
    i := i + 1;
    RAISE NOTICE 'fill-v218 배치 %/%: 갱신 % (누계 %, %s)', i, ceil(n::numeric / b)::int, upd, tot,
                 round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
  END LOOP;
  RAISE NOTICE 'fill-v218 끝: 대상 % 답변, 갱신 % 행', n, tot;
END $f$;

SELECT count(*) AS answers, count(*) FILTER (WHERE t_own IS NULL) AS unfilled, count(*) FILTER (WHERE t_own <> 0) AS with_own_types
  FROM rd.answer;

\if :full_assert
SELECT rd.assert_answer_t_own(NULL) AS asserted_all;
\endif

\if :validate
ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_t_own_range;
ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_t_own_in_mask;
SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass
   AND conname IN ('answer_t_own_range', 'answer_t_own_in_mask') ORDER BY 1;
\endif
\endif
