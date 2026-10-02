-- ============================================================================
-- 1회 채우기(stg·이미 적재된 DB): rd.answer.cit_off(DB-v2.13 P71, 글로벌 ⑤ 분자 = 출처 카테고리 Official (HMG) 인용 수) (2026-09-30).
-- **작성만, 실행은 메인 결정 뒤**. 동기화 S1 BE-B(hmg-geo #320·#321), 제품 결정 Q2 (a).
--
-- 무엇을: DB-v2.13 패치 뒤 기존 답변의 cit_off 는 DEFAULT 0 이다. 공식 출처(rd.dim_source.category_key = 'Official (HMG)')를 인용한 서빙 답변 ∪
--   cit_off > 0 인 답변(재실행 시 0 으로 되돌릴 행)을 대상으로, 정본 식 rd.answer_cit_counts(DB-v2.13 P72)의 cit_off 로 바꾼다.
--   대상 밖 답변은 공식 인용이 없어 정답이 0(= 현재 값)이다. 배치마다 트랜잭션 1개: UPDATE(값이 다른 행만) → rd.assert_answer_cit_counts(배치 키, 엄격)
--   (G-25·DB-v2.13 불변식 = 12열 전부 자식 합) → COMMIT. 단언이 실패하면 그 배치만 롤백되고 멈춘다(앞 배치는 커밋된 채, 재실행이 이어받는다).
-- 멱등·재개: 대상을 매번 DB 에서 다시 고르고 값이 다른 행만 쓴다. 중간에 끊겨도 같은 명령을 다시 돌리면 남은 행만 바뀐다(두 번째 실행 = 0행).
-- 전제: DB-v2.13 적용(열·함수). 적재 워커 정지(DB-v2.13 머리말 절차 ①~③). 롤 = migrator(rd UPDATE·단언 함수 실행) 또는 loader.
--
-- 사용(드라이런이 기본: 대상 수·공식 인용 수·이미 채운 행만 센다, 쓰기 없음):
--   psql -X -v ON_ERROR_STOP=1 -f fill-cit-off.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 [-v batch=20000] [-v full_assert=1] -f fill-cit-off.sql
--   psql -1(단일 트랜잭션)로 돌리지 않는다: 아래 DO 블록이 배치마다 COMMIT 한다(자동 커밋 문장이어야 한다).
--   full_assert=1 이면 끝에 rd.assert_answer_cit_counts(NULL)(전 답변 재계산, 가장 무겁다)을 한 번 더 돈다.
-- 뒤처리: COMMIT 뒤(그리고 back 배포 뒤) migrator 로 `SELECT app.result_cache_invalidate();`(rd.answer 는 세대로만 덮는 사실 표라
--   대역 밖 쓰기는 데이터 버전을 올리지 않는다, DECISIONS-API '결과 캐시' 운영).
-- 출력 = 개수만(답변 키·본문·도메인 없음).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
\if :{?batch}
\else
  \set batch 20000
\endif
\if :{?full_assert}
\else
  \set full_assert 0
\endif
SET statement_timeout = 0;
SET lock_timeout = '30s';
SELECT set_config('fill.batch', :'batch', false) AS batch, set_config('fill.commit', :'commit', false) AS commit;

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_off' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.13 이 먼저 적용돼야 한다(rd.answer.cit_off 없음)';
  END IF;
  IF NOT ('cit_off' = ANY ((SELECT proargnames FROM pg_proc WHERE oid = 'rd.answer_cit_counts(int4[])'::regprocedure)::text[])) THEN
    RAISE EXCEPTION 'DB-v2.13 P72 가 없다(rd.answer_cit_counts 에 cit_off 없음)';
  END IF;
  IF current_setting('fill.batch')::int NOT BETWEEN 1 AND 200000 THEN
    RAISE EXCEPTION 'batch 는 1..200000';
  END IF;
END $v$;

-- 대상(세션 임시 표: 배치 COMMIT 을 넘어 유지). 공식 출처 키는 소수라 rd.citation 은 cit_source_idx(source_key, round_date)로 읽는다.
DROP TABLE IF EXISTS pg_temp._fill_off;
CREATE TEMP TABLE _fill_off AS
WITH off AS (SELECT s.source_key FROM rd.dim_source s JOIN app.citation_category cc ON cc.category_key = s.category_key
              WHERE cc.name = 'Official (HMG)' AND s.source_key <> 0),
k AS (SELECT c.answer_key FROM rd.citation c WHERE c.source_key IN (SELECT source_key FROM off)
      UNION
      SELECT a.answer_key FROM rd.answer a WHERE a.cit_off > 0)
SELECT row_number() OVER (ORDER BY k.answer_key)::int AS rn, k.answer_key
  FROM k WHERE EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = k.answer_key AND j.served);
CREATE UNIQUE INDEX ON _fill_off (rn);
ANALYZE _fill_off;

SELECT (SELECT count(*) FROM _fill_off) AS target_answers,
       (SELECT count(*) FROM rd.dim_source s JOIN app.citation_category cc ON cc.category_key = s.category_key
         WHERE cc.name = 'Official (HMG)' AND s.source_key <> 0) AS official_sources,
       (SELECT count(*) FROM rd.answer a WHERE a.cit_off > 0) AS already_filled,
       ceil((SELECT count(*) FROM _fill_off)::numeric / current_setting('fill.batch')::int)::int AS batches;

\if :commit
DO $f$
DECLARE
  b int := current_setting('fill.batch')::int;
  n int := (SELECT count(*) FROM _fill_off);
  i int := 0;
  keys int4[];
  upd int;
  tot bigint := 0;
  t0 timestamptz := clock_timestamp();
BEGIN
  WHILE i * b < n LOOP
    SELECT array_agg(answer_key ORDER BY answer_key) INTO keys FROM _fill_off WHERE rn > i * b AND rn <= (i + 1) * b;
    UPDATE rd.answer a SET cit_off = coalesce(x.cit_off, 0)::int2
      FROM rd.job j LEFT JOIN rd.answer_cit_counts(keys) x
             ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
     WHERE j.answer_key = ANY (keys) AND j.served
       AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
       AND a.cit_off IS DISTINCT FROM coalesce(x.cit_off, 0)::int2;
    GET DIAGNOSTICS upd = ROW_COUNT;
    PERFORM rd.assert_answer_cit_counts(keys, true);
    COMMIT;
    tot := tot + upd;
    i := i + 1;
    RAISE NOTICE 'fill-cit-off 배치 %/%: 갱신 % (누계 %, %s)', i, ceil(n::numeric / b)::int, upd, tot,
                 round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
  END LOOP;
  RAISE NOTICE 'fill-cit-off 끝: 대상 % 답변, 갱신 % 행', n, tot;
END $f$;

SELECT count(*) FILTER (WHERE a.cit_off > 0) AS answers_with_official, coalesce(sum(a.cit_off), 0) AS official_citations,
       coalesce(sum(a.cit_n), 0) AS host_citations
  FROM rd.answer a;
\if :full_assert
SELECT rd.assert_answer_cit_counts(NULL) AS full_assert_answers;
\endif
\else
\echo '드라이런: 쓰기 없음. 실행은 -v commit=1'
\endif
DROP TABLE IF EXISTS pg_temp._fill_off;

-- 확인(읽기 전용, 필요 시):
--   SELECT count(*) FILTER (WHERE cit_off > 0), sum(cit_off) FROM rd.answer;                       -- 채운 답변·공식 인용 수
--   SELECT rd.assert_answer_cit_counts(NULL);                                                     -- 전수 단언(무겁다)
