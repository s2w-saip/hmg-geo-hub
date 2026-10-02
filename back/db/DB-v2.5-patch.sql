-- ============================================================================
-- hmg-geo 재설계 DB-v2.5 보완 패치 (PostgreSQL 17, 2026-09-28) · core 5라운드 D-stance
-- 적용 순서: DB-v2.4.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.5.sql = DB-v2.4.sql + 이 파일.
--
-- P42 rd.answer_stance.cyc_key: 스탠스 표에만 회차 키가 없어 ① 사실 표 3술어(surface·round_date·cyc_key = ANY, SQL 경계 가드 G1)를
--     걸 수 없었고 ② 회차 숨김(hidden_scope 3 mentions·1 all)을 cyc_key 로 가를 수 없었다(CORE-REQUESTS an-answers R1·an-mentions R1).
--     가드 예외(rd.answer 조인 면제)가 아니라 다른 사실 표 3종(answer_brand·citation)과 같은 투영 규칙으로 연다(근본안).
--   - 열: cyc_key int4 NOT NULL(기본값 없음: 적재기가 rd.answer.cyc_key 를 투영하지 않으면 INSERT 가 실패해야 한다. 0 으로 조용히 채우면
--     스탠스 행이 창에서 사라진다). 기존 행은 rd.answer 등치 조인(surface, round_date, answer_key)으로 채우고 고아·NULL 0 을 단언한다.
--   - 게이트 전파: rd.propagate_answer_gates 가 answer_stance 의 std_in 과 함께 cyc_key 를 맞추고 단언 대상에 넣는다(answer_brand 와 같은 규칙).
--   - 인덱스: st_cyc_idx (cyc_key). rd.answer answer_cyc_idx 와 같은 규칙(회차 단위 조회·재투영). HOT: cyc_key 는 rd.answer 쪽도
--     btree(answer_cyc_idx·answer_cell_idx)에 있어 회차 재배정 UPDATE 가 원래 HOT 이 아니다(새 제약 아님). 조회 결합은 PK
--     (surface, round_date, answer_key, …) 접두가 맡는다.
--   적재 쪽 영향(이 패치 밖): rd.answer_stance 를 쓰는 적재 투영은 cyc_key 열을 넣어야 한다(rd.answer.cyc_key 복사, answer_brand 와 같다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '30min';     -- 기존 행 채우기(UPDATE)·NOT NULL 검사가 행 수에 비례(stg 수백만 행)

DO $v$ BEGIN
  IF to_regclass('rd.answer_stance') IS NULL OR to_regprocedure('app.tg_rhq_region_guard()') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.4 가 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer_stance'::regclass AND attname = 'cyc_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.5 이미 적용됨(rd.answer_stance.cyc_key 존재)';
  END IF;
END $v$;

ALTER TABLE rd.answer_stance ADD COLUMN cyc_key int4;          -- 파티션 leaf 전부에 전파(메타데이터만)
UPDATE rd.answer_stance s SET cyc_key = a.cyc_key
  FROM rd.answer a
 WHERE a.surface = s.surface AND a.round_date = s.round_date AND a.answer_key = s.answer_key;
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM rd.answer_stance WHERE cyc_key IS NULL;
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: rd.answer 없는 answer_stance 행(고아) %', v; END IF;
END $v$;
ALTER TABLE rd.answer_stance ALTER COLUMN cyc_key SET NOT NULL;
CREATE INDEX st_cyc_idx ON rd.answer_stance (cyc_key);
COMMENT ON COLUMN rd.answer_stance.cyc_key IS 'rd.answer.cyc_key 사본(게이트 전파 대상, DB-v2.5 P42). 사실 표 3술어·회차 숨김 판정용';

-- 게이트 전파(B3): answer_stance 도 cyc_key 를 맞추고 단언한다(v2.5). 나머지는 v2.4 와 같다.
CREATE OR REPLACE FUNCTION rd.propagate_answer_gates(p_keys int4[]) RETURNS int LANGUAGE plpgsql AS $f$
-- 답변 위치는 rd.job(answer_key PK)에서 파티션 좌표(surface, round_date)를 얻어 등치 조인으로 찾는다.
-- rd.answer 를 answer_key = ANY 로 직접 찾으면 파티션 키가 없어 모든 leaf 의 PK 인덱스를 끝까지 훑는다
-- (2026-09-27 스모크: 24만 행 12 leaf 4.5ms vs rd.job 경유 0.028ms, 행 수에 비례).
DECLARE n int := 0; m int;
BEGIN
  -- 위치 단언: served 인 job 은 같은 좌표의 rd.answer 가 있어야 한다. 없으면 아래 조인이 조용히 0건이 된다.
  IF EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = ANY(p_keys) AND j.served
               AND NOT EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key))
  THEN RAISE EXCEPTION 'rd.job ↔ rd.answer 위치 불일치: 재투영 누락'; END IF;
  UPDATE rd.answer_brand c SET std_in = a.std_in, elig = a.elig, dflt = a.dflt, cyc_key = a.cyc_key
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.elig, c.dflt, c.cyc_key) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET std_in = a.std_in, cyc_key = a.cyc_key
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.cyc_key) IS DISTINCT FROM (a.std_in, a.cyc_key);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET cit_in = a.cit_in, gap = a.gap, dflt = a.dflt, cyc_key = a.cyc_key
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.cit_in, c.gap, c.dflt, c.cyc_key) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.job j SET cyc_key = a.cyc_key, analysis_code = a.analysis_state
    FROM rd.answer a WHERE j.answer_key = ANY(p_keys)
     AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
     AND (j.cyc_key, j.analysis_code) IS DISTINCT FROM (a.cyc_key, a.analysis_state);
  -- 게이트 동치 단언(불변식 ①): 위반 시 롤백
  IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_brand c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.std_in, c.elig, c.dflt, c.cyc_key) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_stance c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.std_in, c.cyc_key) IS DISTINCT FROM (a.std_in, a.cyc_key))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.cit_in, c.gap, c.dflt, c.cyc_key) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key))
  THEN RAISE EXCEPTION 'rd 게이트 사본 불일치: 전파 누락'; END IF;
  RETURN n;
END $f$;

COMMIT;
