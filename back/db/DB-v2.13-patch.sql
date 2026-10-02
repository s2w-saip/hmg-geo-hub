-- ============================================================================
-- hmg-geo 재설계 DB-v2.13 보완 패치 (PostgreSQL 17, 2026-09-30) · 동기화 S1 BE-B: 글로벌 ⑤ 분자 = 출처 카테고리 Official (HMG) 인용 수
-- 적용 순서: DB-v2.12.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.13.sql = DB-v2.12.sql + 이 파일. 추가형(기존 열·값·권한 의미 불변).
-- 근거: hmg-geo 2670a16 #320(783478c)·#321(feddea7) lib/kpi/official-hmg-citations.ts(글로벌 ⑤ 분자 = resolveCitationCategory 가
--   'Official (HMG)' 인 인용 수, 오버라이드 포함), 제품 결정 Q2 (a)(2026-09-30: rd.answer 공식 인용 수 열 + citation_override 재판정 확장).
--
-- P71 rd.answer.cit_off int2 NOT NULL DEFAULT 0 = 호스트 있는 인용(rd.citation source_key <> 0, G-25 cit_n 과 같은 모수) 중
--     출처 차원 카테고리(rd.dim_source.category_key)가 app.citation_category name 'Official (HMG)' 인 수.
--     rd.dim_source.category_key 는 적재기 category_of(seed-3x-common.sql §9: 오버라이드 → 공식 소셜 → 공식 도메인 → 시드 → 규칙 → Other,
--     현행 resolveCitationCategory(rowCategory = null) 와 같은 순서)의 결과이고, 오버라이드 편집은 judgment_change 'citation_override'
--     재판정이 반영한다. 그래서 이 열은 "반영된 카테고리" 기준이다(조회 시 즉시 보이는 CATEGORY_EXPR 과는 재판정 전 구간에서만 다르다).
--     기존 행은 DEFAULT 0(파티션 부모 선언 → leaf 전파, 메타데이터만 바뀜, 표 재작성 없음). 값은 back/migration/fill-cit-off.sql 이 채운다.
--     CHECK answer_cit_off_bounds: 0 ≤ cit_off ≤ cit_n(행 단위 불변식, 기존 행은 0 이라 검증 스캔만).
--     공식 카테고리 키는 실행 시점에 app.citation_category name 으로 푼다(빈 DB 합본 적용 때는 코드표 행이 아직 없다: 선행 단언하지 않는다).
-- P72 불변식 ① 확장(G-25 와 같은 방식): rd.answer_cit_counts(int4[]) 반환 열에 cit_off 추가(반환 형이 바뀌어 DROP → CREATE),
--     rd._assert_answer_cit_counts(int4[]) 가 cit_off 까지 자식 합과 대조. 공개 단언 rd.assert_answer_cit_counts(int4[], bool)·(int4[]) 은
--     본문 그대로(내부 위임)라 적재기(apply.project 5만 청크, 엄격)·seed-40 §8(청크마다)·재판정이 새 열을 같은 트랜잭션에서 단언한다.
--
-- 이 열을 쓰는 곳(같은 트랜잭션 유지)
--   적재 FACT      ingest/project/apply/queries.py _ig_citc → INSERT_ANSWER (apply.project, 끝에 rd.assert_answer_cit_counts 엄격)
--   bulk           migration/seed/seed-40-facts.sql §6 _citc → §7 INSERT (§8 청크 단언)
--   재판정         citation_override: 출처 카테고리 재계산에서 'Official (HMG)' 여부가 바뀐 출처를 인용한 답변을 apply.project 로 재투영
--                  (ingest/project/apply/rejudge.py, process_change → finalize 세대 +1)
--   채우기(1회)    back/migration/fill-cit-off.sql(배치·멱등, 대역 밖 쓰기 → 결과 캐시 무효화 필요)
--
-- 적용 절차(stg·prod, 순서 고정)
--   ① 이 패치(migrator)  ② 채우기: psql -f back/migration/fill-cit-off.sql(드라이런) → -v commit=1  ③ back 배포(적재기·API 가 cit_off 를 읽고 쓴다)
--   ④ migrator 로 SELECT app.result_cache_invalidate();
--   ①~③ 사이 옛 적재기는 cit_off 를 채우지 않아 공식 인용이 있는 답변에서 단언이 실패한다(적재 트랜잭션 롤백, 데이터 불변, 배포 뒤 재시도).
--   적재 워커가 도는 환경이면 ①~③ 동안 멈춘다(stg 는 적재 워커·타이머 없음).
--
-- 결과 캐시(DB-v2.11, DECISIONS-API '결과 캐시' 무효화 절차): rd.answer 는 세대로만 덮는 사실 표라 이 패치·채우기(대역 밖 쓰기)는 데이터 버전을
--   올리지 않는다. 채우기 COMMIT 뒤(그리고 배포 뒤) migrator 로 `SELECT app.result_cache_invalidate();` 를 실행한다.
-- 규약: D8 예외 ②(답변 1:1 판정 열, G-25 와 같다). 새 btree 없음(HOT 유지: 재판정 제자리 UPDATE 대상 열을 색인에 넣지 않는다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF position('scope_regions' in coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                            WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope'), '')) = 0 THEN
    RAISE EXCEPTION 'DB-v2.12 이 먼저 적용돼야 한다';
  END IF;
  IF to_regprocedure('rd._assert_answer_cit_counts(int4[])') IS NULL OR to_regprocedure('rd.answer_cit_counts(int4[])') IS NULL THEN
    RAISE EXCEPTION 'G-25 인용 수 함수(DB-v2.2 P22·v2.3 P32)가 없다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_off' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.13 이미 적용됨(rd.answer.cit_off 존재)';
  END IF;
END $v$;

-- ── P71 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.answer ADD COLUMN cit_off int2 NOT NULL DEFAULT 0;
COMMENT ON COLUMN rd.answer.cit_off IS
  '호스트 있는 인용 중 출처 카테고리(rd.dim_source.category_key)가 Official (HMG) 인 수. 글로벌 ⑤ 인용 점유율 분자(hmg-geo #320·#321). DB-v2.13 P71';
ALTER TABLE rd.answer ADD CONSTRAINT answer_cit_off_bounds CHECK (cit_off BETWEEN 0 AND cit_n);

-- ── P72 ─────────────────────────────────────────────────────────────────────
DROP FUNCTION rd.answer_cit_counts(int4[]);
CREATE FUNCTION rd.answer_cit_counts(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4,
               cit_n int, cit_own_h int, cit_own_k int, cit_own_g int, cit_own_hc int, cit_own_kc int, cit_own_gc int,
               cit_own_x int, cit_loc int, cit_tgt int, cit_loc_tgt int, cit_off int)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $f$
DECLARE off int2 := (SELECT cc.category_key FROM app.citation_category cc WHERE cc.name = 'Official (HMG)');
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
           count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit)::int,
           count(*) FILTER (WHERE s.category_key = off)::int
      FROM rd.citation c
      LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
                   FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
      LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
      LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
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
           count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit)::int,
           count(*) FILTER (WHERE s.category_key = off)::int
      FROM rd.job j
      JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
      LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
                   FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
      LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
      LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
     WHERE j.answer_key = ANY (p_keys) AND j.served AND c.source_key <> 0
     GROUP BY c.surface, c.round_date, c.answer_key;
  END IF;
END $f$;

-- 내부 단언(공개 판 rd.assert_answer_cit_counts(int4[], bool)·(int4[]) 이 위임): G-25 ① 에 cit_off 를 더한다
CREATE OR REPLACE FUNCTION rd._assert_answer_cit_counts(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE v int; n int;
BEGIN
  IF p_keys IS NULL THEN
    SELECT count(*), count(*) FILTER (WHERE
             (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
              a.cit_loc, a.cit_tgt, a.cit_loc_tgt, a.cit_off)
             IS DISTINCT FROM
             (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_own_h, 0)::int2, coalesce(x.cit_own_k, 0)::int2, coalesce(x.cit_own_g, 0)::int2,
              coalesce(x.cit_own_hc, 0)::int2, coalesce(x.cit_own_kc, 0)::int2, coalesce(x.cit_own_gc, 0)::int2, coalesce(x.cit_own_x, 0)::int2,
              coalesce(x.cit_loc, 0)::int2, coalesce(x.cit_tgt, 0)::int2, coalesce(x.cit_loc_tgt, 0)::int2, coalesce(x.cit_off, 0)::int2))
      INTO n, v
      FROM rd.answer a
      LEFT JOIN rd.answer_cit_counts(NULL) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key;
  ELSE
    SELECT count(*), count(*) FILTER (WHERE
             (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
              a.cit_loc, a.cit_tgt, a.cit_loc_tgt, a.cit_off)
             IS DISTINCT FROM
             (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_own_h, 0)::int2, coalesce(x.cit_own_k, 0)::int2, coalesce(x.cit_own_g, 0)::int2,
              coalesce(x.cit_own_hc, 0)::int2, coalesce(x.cit_own_kc, 0)::int2, coalesce(x.cit_own_gc, 0)::int2, coalesce(x.cit_own_x, 0)::int2,
              coalesce(x.cit_loc, 0)::int2, coalesce(x.cit_tgt, 0)::int2, coalesce(x.cit_loc_tgt, 0)::int2, coalesce(x.cit_off, 0)::int2))
      INTO n, v
      FROM rd.job j
      JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
      LEFT JOIN rd.answer_cit_counts(p_keys) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key
     WHERE j.answer_key = ANY (p_keys) AND j.served;
  END IF;
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.answer 인용 수 열 ≠ rd.citation 자식 합: % 답변(G-25 불변식)', v;          -- 종전 문구 유지(check-expected·운영 감시 호환)
  END IF;
  RETURN n;
END $f$;

ALTER FUNCTION rd.answer_cit_counts(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd._assert_answer_cit_counts(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.answer_cit_counts(int4[]), rd._assert_answer_cit_counts(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.answer_cit_counts(int4[]), rd._assert_answer_cit_counts(int4[]) TO loader, migrator;
COMMENT ON FUNCTION rd.answer_cit_counts(int4[]) IS
  '답변 키 집합의 인용 수(rd.citation 자식 합, 호스트 있는 인용): G-25 11열 + cit_off(출처 카테고리 Official (HMG)). NULL = 전체. DB-v2.13 P72';

-- ── 적용 확인(구조만: 기존 행 값 채우기는 fill-cit-off.sql 이 배치로 하고 청크마다 단언한다) ─────────
DO $v$
DECLARE src text; a record;
BEGIN
  SELECT t.typname, att.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS dflt INTO a
    FROM pg_attribute att JOIN pg_type t ON t.oid = att.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = att.attrelid AND d.adnum = att.attnum
   WHERE att.attrelid = 'rd.answer'::regclass AND att.attname = 'cit_off' AND NOT att.attisdropped;
  IF a IS NULL OR a.typname <> 'int2' OR NOT a.attnotnull OR a.dflt IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'P71 실패: rd.answer.cit_off 형·NOT NULL·기본값';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
              WHERE NOT EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'cit_off' AND NOT x.attisdropped)
                AND i.inhparent IN (SELECT 'rd.answer'::regclass UNION ALL SELECT inhrelid FROM pg_inherits WHERE inhparent = 'rd.answer'::regclass)) THEN
    RAISE EXCEPTION 'P71 실패: leaf 에 cit_off 전파 안 됨';
  END IF;
  IF NOT coalesce((SELECT convalidated FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass AND conname = 'answer_cit_off_bounds'), false) THEN
    RAISE EXCEPTION 'P71 실패: answer_cit_off_bounds 없음·미검증';
  END IF;
  IF NOT ('cit_off' = ANY ((SELECT proargnames FROM pg_proc WHERE oid = 'rd.answer_cit_counts(int4[])'::regprocedure)::text[])) THEN
    RAISE EXCEPTION 'P72 실패: rd.answer_cit_counts 반환 열에 cit_off 없음';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'rd._assert_answer_cit_counts(int4[])'::regprocedure;
  IF position('a.cit_off' in src) = 0 OR position('x.cit_off' in src) = 0 THEN
    RAISE EXCEPTION 'P72 실패: 단언이 cit_off 를 대조하지 않는다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('rd.answer_cit_counts(int4[])'::regprocedure, 'rd._assert_answer_cit_counts(int4[])'::regprocedure)
              AND pg_get_userbyid(proowner) <> 'hmg_owner')
     OR NOT has_function_privilege('loader', 'rd.answer_cit_counts(int4[])', 'execute')
     OR NOT has_function_privilege('loader', 'rd.assert_answer_cit_counts(int4[], bool)', 'execute')
     OR has_function_privilege('api_ro', 'rd.answer_cit_counts(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P72 실패: 소유자·실행 권한';
  END IF;
  -- 공개 단언 경로가 새 본문에 닿는지(빈 키 = 0 답변 검사, 예외 없음)
  PERFORM rd.assert_answer_cit_counts(ARRAY[]::int4[], true);
END $v$;

COMMIT;
