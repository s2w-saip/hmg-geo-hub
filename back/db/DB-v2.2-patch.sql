-- ============================================================================
-- hmg-geo 재설계 DB-v2.2 보완 패치 (PostgreSQL 17, 2026-09-28) · G-25 답변당 인용 수 열
-- 적용 순서: DB-v2.1.sql(= DB-v2.sql + DB-v2.1-patch.sql) 적용 뒤 이 파일 1회(트랜잭션 1개, ON_ERROR_STOP 전제).
--   합본 DB-v2.2.sql = DB-v2.1.sql + 이 파일(빈 DB 와 패치 DB 의 열 순서가 같다).
-- 근거: DESIGN-CONTRACT §3 G-25(제품 책임자 2026-09-28, stg 동시 5명 웹사이트 1년 summary·trend p95 1.1~1.5초)
--   → rd.answer 에 답변당 인용 수 열(D8 예외 ② 확장: G-03 당사 열과 같은 답변 1:1 판정 열). summary·trend·geo 의
--   인용 계열(M05 인용 점유율, C-1 타겟 인용 수)은 rd.citation 을 스캔하지 않는다.
--
-- 열 정의(모두 int2 NOT NULL DEFAULT 0, "호스트 있는 인용" = rd.citation.source_key <> 0 인 자식 행만 센다: G-21 (a)·M05 분모와 같은 모수)
--   cit_n        호스트 있는 인용 수(M05 분모). has_cit = (cit_n > 0)
--   cit_own_h/k/g 자사 인용(글로벌 판정식 owner_key = ANY(허용 배열))의 브랜드별 수: owner_key 의 app.owned_base.brand_code 가
--                Hyundai(비트 1)·Kia(2)·Genesis(4). 관점 비트 합(admin 전사 {1,2,4})은 열 합, 한 owner_key 는 한 브랜드라 서로소.
--   cit_own_hc/kc/gc 위 중 소유 베이스 국가(app.owned_base.geo_code) = 답변 국가(rd.dim_country.code, 글로벌 = 답변 region).
--                국가 필터로 허용 배열이 좁혀진 요청(QUERY-FIXES 공통 기호: geo_code ∈ 선택 국가, 좁힌 결과가 비면 안 좁힘)에서 쓴다.
--                선택 국가 1개면 답변 국가 = 선택 국가라 이 열이 정확히 그 값이다.
--   cit_own_x    HMG 3사 자사 인용 중 소유 베이스 국가가 있고 답변 국가와 다른 것(교차 국가). 선택 국가가 2개 이상이면
--                cit_own_x = 0 인 답변은 *c 열로, cit_own_x > 0 인 답변만 rd.citation 을 PK 로 조회해 정확히 센다
--                (stg 실측 2026-09-28: 글로벌 자사 인용 134,443 중 교차 46,850, 교차 있는 답변 18,303 / 265,970 = 6.9%).
--   cit_loc      loc_owned 인 인용 수(프로젝트 자사 = project 표면 M05 분자)
--   cit_tgt      tgt_hit 인 인용 수(C-1 target_citations). tgt_cited = (cit_tgt > 0)
--   cit_loc_tgt  (loc_owned OR tgt_hit) 인 인용 수(웹사이트 자사 = website 표면 M05 분자). own_url_cited = (cit_loc_tgt > 0)
--   표면과 무관하게 같은 식으로 채운다(글로벌 행의 loc·tgt 는 적재 시 false 라 0, 웹·프로젝트 행의 owner 열은 참고값).
--   언어 필터로 허용 배열을 좁히는 경우는 열로 두지 않았다: 글로벌 표면의 lang[] 은 K-1·T-1·GEO-1 에서 지원 축이 아니다(website 전용),
--   C-1 처럼 인용 원소를 원래 스캔하는 기능은 core.measure.allowed_owner_keys 로 언어까지 좁힌다.
--
-- 불변식
--   ① 자식 합 = 답변 열: rd.assert_answer_cit_counts(answer_key[]) 가 rd.citation 을 다시 세어 단언(위반 시 예외).
--      적재기는 인용 자식을 쓰거나 owned_base 판정을 반영한 같은 트랜잭션에서 호출한다. seed-40 은 5만 청크마다 호출한다.
--      rd.propagate_answer_gates 에는 넣지 않았다: 게이트 전파는 인용 수를 바꾸지 않고, app.owned_base 가 바뀐 뒤 재판정 전
--      (judgment_change 'owned_base' 대기) 구간에 무관한 게이트 전파가 실패하면 안 되기 때문.
--   ② 행 단위 CHECK(아래 answer_cit_bounds·answer_cit_flags): 열 사이 부등식과 기존 불리언(has_cit·tgt_cited·own_url_cited)과의 동치.
-- 규약
--   D8: 사전 집계 표 없음. 새 열은 답변 1:1 판정 열(자식 원소 수)이며 G-03 당사 열과 같은 D8 예외 ②.
--   HOT: 새 열은 제자리 재판정 UPDATE 대상이다(owned_base 판정 변경, 인용 leaf 재구축 뒤 재계산). 어떤 btree 에도 넣지 않는다.
--   owned_base 변경(judgment_change 'owned_base'): 적재기가 영향 owner_key 를 가진 답변의 cit_own_* 를 재계산한다.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- P21. rd.answer 인용 수 열 11개(파티션 부모 선언 → 모든 leaf 전파, 기존 행은 DEFAULT 0 으로 메타데이터만 바뀜)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE rd.answer
  ADD COLUMN cit_n       int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_h   int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_k   int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_g   int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_hc  int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_kc  int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_gc  int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_x   int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_loc     int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_tgt     int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_loc_tgt int2 NOT NULL DEFAULT 0;

COMMENT ON COLUMN rd.answer.cit_n IS '호스트 있는 인용 수(rd.citation source_key <> 0). M05 분모. has_cit = (cit_n > 0). G-25';
COMMENT ON COLUMN rd.answer.cit_own_h IS '글로벌 자사 인용 수: owner_key 브랜드 Hyundai(비트 1). G-25';
COMMENT ON COLUMN rd.answer.cit_own_k IS '글로벌 자사 인용 수: owner_key 브랜드 Kia(비트 2). G-25';
COMMENT ON COLUMN rd.answer.cit_own_g IS '글로벌 자사 인용 수: owner_key 브랜드 Genesis(비트 4). G-25';
COMMENT ON COLUMN rd.answer.cit_own_hc IS 'cit_own_h 중 소유 베이스 geo_code = 답변 국가 코드(국가 필터로 좁힌 허용 배열). G-25';
COMMENT ON COLUMN rd.answer.cit_own_kc IS 'cit_own_k 중 소유 베이스 geo_code = 답변 국가 코드. G-25';
COMMENT ON COLUMN rd.answer.cit_own_gc IS 'cit_own_g 중 소유 베이스 geo_code = 답변 국가 코드. G-25';
COMMENT ON COLUMN rd.answer.cit_own_x IS '3사 자사 인용 중 소유 베이스 geo_code 가 있고 답변 국가와 다른 수(다국가 필터 시 rd.citation 조회 대상 표식). G-25';
COMMENT ON COLUMN rd.answer.cit_loc IS 'loc_owned 인용 수(프로젝트 자사). G-25';
COMMENT ON COLUMN rd.answer.cit_tgt IS 'tgt_hit 인용 수(타겟 인용). tgt_cited = (cit_tgt > 0). G-25';
COMMENT ON COLUMN rd.answer.cit_loc_tgt IS '(loc_owned OR tgt_hit) 인용 수(웹사이트 자사). own_url_cited = (cit_loc_tgt > 0). G-25';

-- ════════════════════════════════════════════════════════════════════════════
-- P22. 판정 함수: 답변 키 집합의 인용 수를 rd.citation 에서 센다(적재기·단언·백필 공용 정본 식)
--   위치는 rd.job(answer_key PK)에서 파티션 좌표를 얻어 등치 조인(propagate_answer_gates 와 같은 이유: answer_key = ANY 로
--   파티션 표를 직접 찾으면 모든 leaf PK 를 훑는다). 호스트 없는 인용만 있는 답변은 행이 없다(= 전 열 0).
--   p_keys 가 NULL 이면 전체(백필·전수 감사 전용).
-- ════════════════════════════════════════════════════════════════════════════
CREATE FUNCTION rd.answer_cit_counts(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4,
               cit_n int, cit_own_h int, cit_own_k int, cit_own_g int, cit_own_hc int, cit_own_kc int, cit_own_gc int,
               cit_own_x int, cit_loc int, cit_tgt int, cit_loc_tgt int)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $f$
BEGIN
  IF p_keys IS NULL THEN
    RETURN QUERY
    SELECT c.surface, c.round_date, c.answer_key,
           count(*)::int,
           count(*) FILTER (WHERE ob.bit = 1)::int, count(*) FILTER (WHERE ob.bit = 2)::int, count(*) FILTER (WHERE ob.bit = 4)::int,
           count(*) FILTER (WHERE ob.bit = 1 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 2 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 4 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit IN (1, 2, 4) AND ob.geo IS NOT NULL AND ob.geo IS DISTINCT FROM upper(g.code))::int,
           count(*) FILTER (WHERE c.loc_owned)::int, count(*) FILTER (WHERE c.tgt_hit)::int,
           count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit)::int
      FROM rd.citation c
      LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
                   FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
      LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
     WHERE c.source_key <> 0
     GROUP BY c.surface, c.round_date, c.answer_key;
  ELSE
    RETURN QUERY
    SELECT c.surface, c.round_date, c.answer_key,
           count(*)::int,
           count(*) FILTER (WHERE ob.bit = 1)::int, count(*) FILTER (WHERE ob.bit = 2)::int, count(*) FILTER (WHERE ob.bit = 4)::int,
           count(*) FILTER (WHERE ob.bit = 1 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 2 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 4 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit IN (1, 2, 4) AND ob.geo IS NOT NULL AND ob.geo IS DISTINCT FROM upper(g.code))::int,
           count(*) FILTER (WHERE c.loc_owned)::int, count(*) FILTER (WHERE c.tgt_hit)::int,
           count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit)::int
      FROM rd.job j
      JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
      LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
                   FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
      LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
     WHERE j.answer_key = ANY (p_keys) AND j.served AND c.source_key <> 0
     GROUP BY c.surface, c.round_date, c.answer_key;
  END IF;
END $f$;

-- 단언: 주어진 답변 키(served)의 rd.answer 인용 수 열 = rd.answer_cit_counts 재계산. 위반 시 예외(적재 트랜잭션 롤백).
--   p_keys NULL = 전수(야간 감사·백필 확인). 반환 = 검사한 답변 수.
CREATE FUNCTION rd.assert_answer_cit_counts(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE v int; n int;
BEGIN
  IF p_keys IS NULL THEN
    SELECT count(*), count(*) FILTER (WHERE
             (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
              a.cit_loc, a.cit_tgt, a.cit_loc_tgt)
             IS DISTINCT FROM
             (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_own_h, 0)::int2, coalesce(x.cit_own_k, 0)::int2, coalesce(x.cit_own_g, 0)::int2,
              coalesce(x.cit_own_hc, 0)::int2, coalesce(x.cit_own_kc, 0)::int2, coalesce(x.cit_own_gc, 0)::int2, coalesce(x.cit_own_x, 0)::int2,
              coalesce(x.cit_loc, 0)::int2, coalesce(x.cit_tgt, 0)::int2, coalesce(x.cit_loc_tgt, 0)::int2))
      INTO n, v
      FROM rd.answer a
      LEFT JOIN rd.answer_cit_counts(NULL) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key;
  ELSE
    SELECT count(*), count(*) FILTER (WHERE
             (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
              a.cit_loc, a.cit_tgt, a.cit_loc_tgt)
             IS DISTINCT FROM
             (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_own_h, 0)::int2, coalesce(x.cit_own_k, 0)::int2, coalesce(x.cit_own_g, 0)::int2,
              coalesce(x.cit_own_hc, 0)::int2, coalesce(x.cit_own_kc, 0)::int2, coalesce(x.cit_own_gc, 0)::int2, coalesce(x.cit_own_x, 0)::int2,
              coalesce(x.cit_loc, 0)::int2, coalesce(x.cit_tgt, 0)::int2, coalesce(x.cit_loc_tgt, 0)::int2))
      INTO n, v
      FROM rd.job j
      JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
      LEFT JOIN rd.answer_cit_counts(p_keys) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key
     WHERE j.answer_key = ANY (p_keys) AND j.served;
  END IF;
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.answer 인용 수 열 ≠ rd.citation 자식 합: % 답변(G-25 불변식)', v;
  END IF;
  RETURN n;
END $f$;

ALTER FUNCTION rd.answer_cit_counts(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_cit_counts(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.answer_cit_counts(int4[]), rd.assert_answer_cit_counts(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.answer_cit_counts(int4[]), rd.assert_answer_cit_counts(int4[]) TO loader, migrator;

-- ════════════════════════════════════════════════════════════════════════════
-- P23. 기존 행 백필(빈 DB 에서는 0행). 값이 바뀌는 행만 UPDATE(호스트 인용 없는 답변은 DEFAULT 0 그대로).
-- ════════════════════════════════════════════════════════════════════════════
UPDATE rd.answer a
   SET cit_n = x.cit_n, cit_own_h = x.cit_own_h, cit_own_k = x.cit_own_k, cit_own_g = x.cit_own_g,
       cit_own_hc = x.cit_own_hc, cit_own_kc = x.cit_own_kc, cit_own_gc = x.cit_own_gc, cit_own_x = x.cit_own_x,
       cit_loc = x.cit_loc, cit_tgt = x.cit_tgt, cit_loc_tgt = x.cit_loc_tgt
  FROM rd.answer_cit_counts(NULL) x
 WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
   AND (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x, a.cit_loc, a.cit_tgt, a.cit_loc_tgt)
       IS DISTINCT FROM
       (x.cit_n::int2, x.cit_own_h::int2, x.cit_own_k::int2, x.cit_own_g::int2, x.cit_own_hc::int2, x.cit_own_kc::int2, x.cit_own_gc::int2,
        x.cit_own_x::int2, x.cit_loc::int2, x.cit_tgt::int2, x.cit_loc_tgt::int2);

-- ════════════════════════════════════════════════════════════════════════════
-- P24. 행 단위 불변식(파티션 부모 선언 → leaf 상속·이후 ensure_leaf leaf 에도 적용). 백필 뒤라 기존 행 검증이 통과해야 한다.
--   answer_cit_bounds: 브랜드 합 ≤ 전체, 국가 일치 ≤ 브랜드, 교차 ≤ 브랜드 합 − 국가 일치 합, loc∪tgt 는 loc·tgt 사이
--   answer_cit_flags : 기존 답변 불리언과 동치(has_cit·tgt_cited·own_url_cited 는 같은 호스트 있는 인용 모수에서 판정됐다)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE rd.answer ADD CONSTRAINT answer_cit_bounds CHECK (
      cit_own_h >= 0 AND cit_own_k >= 0 AND cit_own_g >= 0 AND cit_own_x >= 0 AND cit_loc >= 0 AND cit_tgt >= 0
  AND cit_own_h + cit_own_k + cit_own_g <= cit_n
  AND cit_own_hc BETWEEN 0 AND cit_own_h AND cit_own_kc BETWEEN 0 AND cit_own_k AND cit_own_gc BETWEEN 0 AND cit_own_g
  AND cit_own_x <= (cit_own_h + cit_own_k + cit_own_g) - (cit_own_hc + cit_own_kc + cit_own_gc)
  AND cit_loc_tgt <= cit_n AND cit_loc_tgt >= greatest(cit_loc, cit_tgt) AND cit_loc_tgt <= cit_loc + cit_tgt);
ALTER TABLE rd.answer ADD CONSTRAINT answer_cit_flags CHECK (
      (cit_n > 0) = has_cit AND (cit_tgt > 0) = tgt_cited AND (cit_loc_tgt > 0) = own_url_cited);

-- 백필 결과 전수 단언(빈 DB 에서는 0건 검사)
DO $a$ DECLARE n int; BEGIN
  n := rd.assert_answer_cit_counts(NULL);
  RAISE NOTICE 'G-25 인용 수 열 단언 통과: 답변 %', n;
END $a$;

COMMIT;
