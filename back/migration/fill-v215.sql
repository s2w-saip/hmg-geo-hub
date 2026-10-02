-- ============================================================================
-- 1회 채우기(stg·이미 적재된 DB): DB-v2.15 의 확정 규칙 열(2026-10-01, 현행 값 재현 되돌림 제품 결정 19·23~25).
-- **작성만, 실행은 제품 책임자 승인 배치**(대량 UPDATE: stg rd.answer 전 행 1회 재작성).
--
-- 무엇을
--   ① rd.answer.cit_n_all·cit_c1..cit_c13·region_geo_key(P86·P87): 서빙 답변 중 아직 비었거나(recheck=1 이면 전부) 대상, 배치마다 트랜잭션 1개:
--      rd.fill_answer_v215(배치 키)(15열 한 UPDATE, 값이 다른 행만) → rd.assert_answer_v215(배치 키)(= 재계산 단언) → COMMIT.
--      단언이 실패하면 그 배치만 롤백되고 멈춘다(앞 배치는 커밋된 채, 재실행이 이어받는다).
--   ② rd.dim_prompt.cat_mask_all·in_root_catalog_all(P88): rd.fill_prompt_catalog_all()(소형 표 1문장 + ⊇ 단언).
--   ③ 검증: ALTER TABLE rd.answer VALIDATE CONSTRAINT(4개, SHARE UPDATE EXCLUSIVE = 읽기·쓰기 안 막음, 전 행 스캔).
--   자식 is_rep(P85)은 채우지 않는다(대표 규칙 = WU-2 몫, rd.fill_child_is_rep 는 WU-2 가 부른다).
--   ④⑤⑥ P89(WU-4): rd.answer.std_in_nc·cit_in_nc + 자식 사본, rd.answer_brand.rid_n, P89 CHECK VALIDATE. 아래 "§P89" 구간(독립).
-- 멱등·재개: 대상을 매번 DB 에서 다시 고르고 값이 다른 행만 쓴다. 중간에 끊겨도 같은 명령을 다시 돌리면 남은 행만 바뀐다(두 번째 실행 = 0행).
-- 전제: DB-v2.15 적용. 적재 워커 정지(채우는 동안 재투영이 같은 답변을 지우고 다시 넣으면 그 답변은 NULL 로 돌아간다 → 재실행이 다시 채운다).
--   롤 = migrator(rd UPDATE·함수 실행·VALIDATE 는 소유자 권한이 필요하므로 VALIDATE 만은 hmg_owner 또는 superuser).
--
-- 사용(드라이런이 기본: 대상 수·이미 채운 행·호스트 없는 인용 수만 센다, 쓰기 없음):
--   psql -X -v ON_ERROR_STOP=1 -f fill-v215.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 [-v batch=20000] [-v recheck=1] [-v validate=0] [-v full_assert=1] -f fill-v215.sql
--   psql -1(단일 트랜잭션)로 돌리지 않는다: 아래 DO 블록이 배치마다 COMMIT 한다(자동 커밋 문장이어야 한다).
--   recheck=1: 이미 채운 행도 대상(값이 다른 행만 쓴다). full_assert=1: 끝에 rd.assert_answer_v215(NULL)(채운 행 전부 재계산, 가장 무겁다).
-- 뒤처리: migrator 로 `SELECT app.result_cache_invalidate();`(rd.answer 는 데이터 버전 추적 표가 아니다. 새 열을 읽는 코드가 없어도 규약대로).
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
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_n_all' AND NOT attisdropped)
     OR to_regprocedure('rd.fill_answer_v215(int4[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.15 가 먼저 적용돼야 한다(rd.answer.cit_n_all·rd.fill_answer_v215 없음)';
  END IF;
  IF current_setting('fill.batch')::int NOT BETWEEN 1 AND 200000 THEN
    RAISE EXCEPTION 'batch 는 1..200000';
  END IF;
  IF EXISTS (SELECT 1 FROM app.citation_category WHERE category_key NOT BETWEEN 1 AND 13) THEN
    RAISE EXCEPTION 'app.citation_category 에 1..13 밖 키가 있다: cit_c 열로 셀 수 없다(합 CHECK 가 깨진다)';
  END IF;
END $v$;

-- 대상(세션 임시 표: 배치 COMMIT 을 넘어 유지). 서빙 답변(rd.job served)만: rd.answer 는 서빙 답변 = 행.
DROP TABLE IF EXISTS pg_temp._fill_v215;
CREATE TEMP TABLE _fill_v215 AS
SELECT row_number() OVER (ORDER BY j.answer_key)::int AS rn, j.answer_key
  FROM rd.job j
  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.served
   AND (current_setting('fill.recheck') = '1' OR a.cit_n_all IS NULL OR a.region_geo_key IS NULL);
CREATE UNIQUE INDEX ON _fill_v215 (rn);
ANALYZE _fill_v215;

SELECT (SELECT count(*) FROM _fill_v215) AS target_answers,
       (SELECT count(*) FROM rd.answer WHERE cit_n_all IS NOT NULL) AS already_filled,
       (SELECT count(*) FROM rd.citation WHERE source_key = 0) AS hostless_citations,
       (SELECT count(*) FROM rd.dim_prompt WHERE cat_mask_all IS NULL) AS prompts_unfilled,
       ceil((SELECT count(*) FROM _fill_v215)::numeric / current_setting('fill.batch')::int)::int AS batches;

\if :commit
DO $f$
DECLARE
  b int := current_setting('fill.batch')::int;
  n int := (SELECT count(*) FROM _fill_v215);
  i int := 0;
  keys int4[];
  upd int;
  tot bigint := 0;
  t0 timestamptz := clock_timestamp();
BEGIN
  WHILE i * b < n LOOP
    SELECT array_agg(answer_key ORDER BY answer_key) INTO keys FROM _fill_v215 WHERE rn > i * b AND rn <= (i + 1) * b;
    upd := rd.fill_answer_v215(keys);
    PERFORM rd.assert_answer_v215(keys);
    COMMIT;
    tot := tot + upd;
    i := i + 1;
    RAISE NOTICE 'fill-v215 배치 %/%: 갱신 % (누계 %, %s)', i, ceil(n::numeric / b)::int, upd, tot,
                 round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
  END LOOP;
  RAISE NOTICE 'fill-v215 답변 끝: 대상 % 답변, 갱신 % 행', n, tot;
END $f$;

SELECT rd.fill_prompt_catalog_all() AS prompts_updated;

SELECT count(*) AS answers, count(*) FILTER (WHERE cit_n_all IS NULL) AS unfilled,
       coalesce(sum(cit_n_all - cit_n), 0) AS hostless_in_answers, count(*) FILTER (WHERE surface = 2 AND region_geo_key <> geo_key) AS web_region_differs
  FROM rd.answer;
SELECT count(*) AS prompts, count(*) FILTER (WHERE cat_mask_all <> cat_mask) AS mask_differs,
       count(*) FILTER (WHERE in_root_catalog_all AND NOT in_root_catalog) AS deleted_only_in_catalog
  FROM rd.dim_prompt;

-- ════════════════════════════════════════════════════════════════════════════
-- §P89 (WU-4: A41·G20, DB-v2.15 P89). 위 ①②와 독립 구간. commit=1 일 때만 쓴다(이 구간 전체가 \if :commit 안이다).
--   ④ rd.answer.elig_nc·std_in_nc·cit_in_nc + 자식 사본(answer_brand·answer_stance·citation): 배치마다 rd.fill_answer_nc → rd.assert_answer_nc → COMMIT.
--      대상 = 서빙 답변 중 elig_nc 가 빈 것(recheck=1 이면 전부). 재계산 원천 = rd.answer_elig_nc(ing.answer·ing.run·rd.dim_prompt).
--   ⑤ rd.answer_brand.rid_n: 표기 쌍 표(seed-3x-common §6 _bn_pair)가 필요해 시드 공용 파일을 이 세션에 올린다(pg_temp 만, 쓰기 없음).
--      행(답변, 표시 브랜드, 경쟁 여부)마다 언급 행의 서로 다른 J1 rid 수. 같은 매핑으로 센 언급 행 수가 entity_rows 와 다르면(표시 브랜드
--      매핑이 투영 때와 다름: NAME 스위치 hgh.legacy_name 값이 투영과 다른 경우 등) 예외로 멈춘다. rid_n 이 NULL 로 남는 행도 예외.
--      NAME(display_name_latin)으로 투영한 DB 면 이 파일도 같은 값으로 돌린다: PGOPTIONS='-c hgh.legacy_name=1' psql …
--   ⑥ (validate=1) P89 CHECK 3개 VALIDATE.
-- ════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS pg_temp._fill_nc;
CREATE TEMP TABLE _fill_nc AS
SELECT row_number() OVER (ORDER BY j.answer_key)::int AS rn, j.answer_key
  FROM rd.job j
  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.served AND (current_setting('fill.recheck') = '1' OR a.elig_nc IS NULL);
CREATE UNIQUE INDEX ON _fill_nc (rn);
ANALYZE _fill_nc;
DO $f$
DECLARE
  b int := current_setting('fill.batch')::int;
  n int := (SELECT count(*) FROM _fill_nc);
  i int := 0;
  keys int4[];
  upd int;
  tot bigint := 0;
BEGIN
  WHILE i * b < n LOOP
    SELECT array_agg(answer_key ORDER BY answer_key) INTO keys FROM _fill_nc WHERE rn > i * b AND rn <= (i + 1) * b;
    upd := rd.fill_answer_nc(keys);
    PERFORM rd.assert_answer_nc(keys);
    COMMIT;
    tot := tot + upd;
    i := i + 1;
  END LOOP;
  RAISE NOTICE 'fill-v215 P89 모수 열 끝: 대상 % 답변, 갱신 % 행', n, tot;
END $f$;

\ir seed/seed-00-fn.sql
\ir seed/seed-3x-rules.sql
\ir seed/seed-3x-common.sql
DROP TABLE IF EXISTS pg_temp._fill_rid;
CREATE TEMP TABLE _fill_rid AS
SELECT row_number() OVER (ORDER BY answer_key)::int AS rn, answer_key
  FROM (SELECT DISTINCT c.answer_key FROM rd.answer_brand c WHERE current_setting('fill.recheck') = '1' OR c.rid_n IS NULL) x;
CREATE UNIQUE INDEX ON _fill_rid (rn);
ANALYZE _fill_rid;
DO $r$
DECLARE
  b int := current_setting('fill.batch')::int;
  n int := (SELECT count(*) FROM _fill_rid);
  i int := 0;
  keys int4[];
  upd int;
  bad int;
  tot bigint := 0;
BEGIN
  WHILE i * b < n LOOP
    SELECT array_agg(answer_key ORDER BY answer_key) INTO keys FROM _fill_rid WHERE rn > i * b AND rn <= (i + 1) * b;
    DROP TABLE IF EXISTS _rid_x;
    CREATE TEMP TABLE _rid_x AS
    SELECT k.answer_key, bn.brand_key, p.competitive, count(DISTINCT p.rid)::int2 AS rid_n, count(*)::int AS entity_rows
      FROM ing.answer_key_map k
      JOIN ing.mention m ON m.run_month = k.run_month AND m.job_id = k.job_id AND m.brand_rollup_entity_id IS NOT NULL
      JOIN _bn_pair p ON p.ver = (SELECT dv FROM _ecat_cfg) AND NOT p.ovr     -- 엔티티 버전(DB-v2.17 E1): 기준 버전의 원본 쌍
                     AND p.dkey = coalesce(m.display_name, '') AND p.dnull = (m.display_name IS NULL) AND p.rollup = m.brand_rollup_entity_id
      JOIN rd.dim_brand_name bn ON bn.bare = p.bare
     WHERE k.answer_key = ANY (keys)
     GROUP BY 1, 2, 3;
    UPDATE rd.answer_brand c SET rid_n = x.rid_n
      FROM rd.job j JOIN _rid_x x ON x.answer_key = j.answer_key
     WHERE j.answer_key = ANY (keys) AND c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
       AND c.brand_key = x.brand_key AND c.competitive = x.competitive AND c.rid_n IS DISTINCT FROM x.rid_n;
    GET DIAGNOSTICS upd = ROW_COUNT;
    SELECT count(*) INTO bad
      FROM rd.job j
      JOIN rd.answer_brand c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
      LEFT JOIN _rid_x x ON x.answer_key = c.answer_key AND x.brand_key = c.brand_key AND x.competitive = c.competitive
     WHERE j.answer_key = ANY (keys) AND (c.rid_n IS NULL OR x.answer_key IS NULL OR x.entity_rows <> c.entity_rows OR x.rid_n <> c.rid_n);
    IF bad <> 0 THEN
      RAISE EXCEPTION 'fill-v215 P89 rid_n: 표시 브랜드 매핑이 투영과 다른 행 %(hgh.legacy_name 값·재투영 누락 확인)', bad;
    END IF;
    COMMIT;
    tot := tot + upd;
    i := i + 1;
  END LOOP;
  RAISE NOTICE 'fill-v215 P89 rid_n 끝: 대상 % 답변, 갱신 % 행', n, tot;
END $r$;
DROP TABLE IF EXISTS pg_temp._rid_x;
SELECT (SELECT count(*) FROM rd.answer WHERE elig_nc IS NULL) AS nc_unfilled,
       (SELECT count(*) FROM rd.answer WHERE surface = 1 AND std_in_nc AND NOT std_in) AS global_std_revived,
       (SELECT count(*) FROM rd.answer WHERE surface = 1 AND cit_in_nc AND NOT cit_in) AS global_cit_revived,
       (SELECT count(*) FROM rd.answer_brand WHERE rid_n IS NULL) AS rid_unfilled,
       (SELECT count(*) FROM rd.answer_brand WHERE rid_n > 1) AS brand_rows_multi_rid;
\if :validate
ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_nc_pair;
ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_nc_rule;
ALTER TABLE rd.answer_brand VALIDATE CONSTRAINT answer_brand_rid_n;
\endif
DROP TABLE IF EXISTS pg_temp._fill_nc;
DROP TABLE IF EXISTS pg_temp._fill_rid;
-- §P89 끝

\if :validate
ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_cit_ext_pair;
ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_cit_ext_bounds;
ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_cit_ext_cat_sum;
ALTER TABLE rd.answer VALIDATE CONSTRAINT answer_region_geo_same;
SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass
   AND conname IN ('answer_cit_ext_pair', 'answer_cit_ext_bounds', 'answer_cit_ext_cat_sum', 'answer_region_geo_same') ORDER BY 1;
\endif
\if :full_assert
SELECT rd.assert_answer_v215(NULL) AS full_assert_answers;
\endif
\else
\echo '드라이런: 쓰기 없음. 실행은 -v commit=1'
\endif
DROP TABLE IF EXISTS pg_temp._fill_v215;

-- 확인(읽기 전용, 필요 시):
--   SELECT count(*) FILTER (WHERE cit_n_all IS NULL), sum(cit_n_all - cit_n) FROM rd.answer;         -- 미채움·호스트 없는 인용
--   SELECT rd.assert_answer_v215(NULL);                                                            -- 채운 행 전수 단언(무겁다)
