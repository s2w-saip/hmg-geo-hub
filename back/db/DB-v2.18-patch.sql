-- ============================================================================
-- hmg-geo 재설계 DB-v2.18 보완 패치 (PostgreSQL 17, 2026-10-01) · 인용 출처 유형 문장 답변 열 경로(rd.answer.t_own)
-- 적용 순서: DB-v2.17(엔티티 관리, P94~P104) 뒤 1회(트랜잭션 1개). 합본 DB-v2.18.sql = DB-v2.17.sql + 이 파일(이어 붙이기).
-- 근거: be/web-card-perf 성능 조사(2026-10-01, notes/hgh-impl/webcard-perf/): /v1/citations/sources 글로벌 3개월 창 유형 문장(답변 열 경로
--   sources_ans_sql)의 0.43s 중 약 0.31s 가 jt(rd.answer_brand 를 답변별 bool_or 로 접기)다. 같은 플래그를 답변 열로 두면 답변 스캔만 남는다
--   (프록시 실측 435 → 124ms, 요청 3개월 약 1.08 → 0.77s). 메인 결정(2026-10-01): 새 표 대안 대신 rd.answer ADD COLUMN(v2.15 P86 전례).
--
-- P105 rd.answer.t_own int2 NULL: 당사 언급 유형 마스크. 비트 (5 × b + i):
--        b = 당사 비트 위치(own_bit 1 → 0 Hyundai, 2 → 1 Kia, 4 → 2 Genesis), i = 유형(0 mention, 1 recommendation, 2 comparison,
--        3 definition, 4 final_choice). 값 = 그 답변의 rd.answer_brand 행 중 own_bit = b 인 행의 t_<유형> > 0 이 하나라도 있으면 1
--        (경쟁 여부 무관, 게이트 무관: 게이트 사본은 답변 열과 같아 조회가 답변 쪽에서 건다). 자사 행이 없으면 0. NULL = 아직 채우지 않음.
--        조회(app.features.analytics.citations.sources.queries.sources_ans_sql)의 종전 jt(answer_brand ⋈ own_bit = ANY(관점) ∧ 언급 모수,
--        bool_or(t_x > 0))와 같은 값: 관점 비트 집합 S 의 유형 i 플래그 = t_own & (OR_{b∈S} 1 << (5b + i)) <> 0 ∧ 언급 모수(답변 열).
--        NULL 행이 모수에 있으면 조회는 종전 jt 경로로 되돌아간다(cit_c 의 unfilled 폴백과 같은 방식).
--      CHECK(NOT VALID = 새 행·갱신 행만, 검증은 fill-v218.sql 끝): answer_t_own_range(0 ≤ t_own < 2^15),
--        answer_t_own_in_mask(유형 비트가 있는 당사 비트는 own_mask 에도 있다: 같은 자사 행에서 나온다).
-- P106 함수(호출자 권한, 소유자 hmg_owner)
--   rd.t_own_bits(own_bit, t_mention, t_recommendation, t_comparison, t_definition, t_final_choice)  행 하나의 기여 비트(IMMUTABLE SQL,
--        인라인: SET 절을 두지 않는다 = 계획기가 식으로 펼친다, 내장 연산자만). own_bit 이 1·2·4 가 아니면 NULL(bit_or 가 무시). 적재기(_ig_own)·seed-40(_own)·재계산 함수가 같은 식을 쓴다. loader·migrator
--   rd.answer_t_own(int4[])        답변 키 집합(NULL = 전체, 무겁다)의 t_own 재계산(rd.answer_brand 합, 서빙 답변). 읽기 전용
--   rd.fill_answer_t_own(int4[])   키 집합의 t_own 을 재계산 값으로(값이 다른 행만, 키 필수). 끝에 그 키의 서빙 답변 NULL 0 단언. 반환 = 갱신 행 수
--   rd.assert_answer_t_own(int4[]) 채운 행(t_own NOT NULL)의 t_own = 재계산, 위반 시 예외. NULL = 채운 행 전부. 반환 = 검사 행 수
--
-- 쓰는 곳(값의 정본 = rd.answer_brand, 답변 열은 사본)
--   적재기 ingest.project.apply: FACT_MR _ig_own.t_own(rd.t_own_bits) → INSERT_ANSWER, ASSERT_OWN 이 자식 합과 대조(재판정 rejudge·
--     엔티티 반영 E5 apply·rollback·abandon·WU-5 재투영은 전부 이 project() 재투영을 탄다: answer_brand 를 다시 쓰는 경로 = t_own 을 다시 쓰는 경로)
--   seed-40 §5 _own.t_own → §7 rd.answer, §8 ④ 당사 합 불변식에 포함
--   채우기 back/migration/fill-v218.sql(stg·기존 DB 1회): 배치 fill → assert → COMMIT, 끝에 CHECK VALIDATE
-- 락: rd.answer(파티션 전부) ACCESS EXCLUSIVE 를 잠깐(ADD COLUMN NULL 기본값 없음 = 메타데이터만, CHECK NOT VALID = 검증 스캔 없음).
--   lock_timeout 30s: 긴 읽기 트랜잭션이 잡고 있으면 실패하고 아무것도 바뀌지 않는다(재시도). 적용 창에는 API·데우기·적재를 멈춘다.
-- 결과 캐시: rd.answer 는 추적 표가 아니다. 채우기 뒤 규약대로 app.result_cache_invalidate()(fill-v218.sql 머리 주석).
-- 배포 순서: ① 이 패치 ② 이 패치를 아는 코드(적재기가 t_own 을 쓴다) 배포 ③ fill-v218.sql. ①만 적용된 채 옛 적재기가 돌면 새 답변 t_own 이
--   NULL 로 들어가 조회가 jt 경로로 폴백한다(값 같음, 느림). ②가 ① 보다 먼저면 적재기 INSERT 가 없는 열로 실패한다.
-- 새 btree 없음(HOT 유지).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('app.ecat_version') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'ecat_ver' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.17(엔티티 관리) 이 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 't_own' AND NOT attisdropped)
     OR to_regprocedure('rd.answer_t_own(int4[])') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.18 이미 적용됨(rd.answer.t_own 또는 rd.answer_t_own 존재)';
  END IF;
END $v$;

-- ── P105 ────────────────────────────────────────────────────────────────────
ALTER TABLE rd.answer
  ADD COLUMN t_own int2,
  ADD CONSTRAINT answer_t_own_range CHECK (t_own >= 0) NOT VALID,
  ADD CONSTRAINT answer_t_own_in_mask CHECK (
    (t_own & ~((CASE WHEN own_mask & 1 <> 0 THEN 31 ELSE 0 END) | (CASE WHEN own_mask & 2 <> 0 THEN 992 ELSE 0 END)
               | (CASE WHEN own_mask & 4 <> 0 THEN 31744 ELSE 0 END))) = 0) NOT VALID;
COMMENT ON COLUMN rd.answer.t_own IS
  '당사 언급 유형 마스크: 비트 5b+i(b = own_bit 1·2·4 → 0·1·2, i = mention·recommendation·comparison·definition·final_choice). '
  '자식 rd.answer_brand 의 own_bit = b 행 t_<i> > 0 이 하나라도 있으면 1(게이트 무관). NULL = 아직 채우지 않음(조회 = jt 폴백). DB-v2.18 P105';

-- ── P106 함수 ───────────────────────────────────────────────────────────────
CREATE FUNCTION rd.t_own_bits(p_own_bit int2, p_mention int2, p_recommendation int2, p_comparison int2, p_definition int2,
                              p_final_choice int2) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$
SELECT ((CASE WHEN p_mention > 0 THEN 1 ELSE 0 END) | (CASE WHEN p_recommendation > 0 THEN 2 ELSE 0 END)
        | (CASE WHEN p_comparison > 0 THEN 4 ELSE 0 END) | (CASE WHEN p_definition > 0 THEN 8 ELSE 0 END)
        | (CASE WHEN p_final_choice > 0 THEN 16 ELSE 0 END))
       << (CASE p_own_bit WHEN 1 THEN 0 WHEN 2 THEN 5 WHEN 4 THEN 10 END)
$f$;
COMMENT ON FUNCTION rd.t_own_bits(int2, int2, int2, int2, int2, int2) IS
  'rd.answer_brand 행 하나의 t_own 기여 비트(own_bit 1·2·4 밖이면 NULL). t_own = coalesce(bit_or(이 값), 0). DB-v2.18 P106';

-- 위치는 rd.job(answer_key PK)에서 파티션 좌표를 얻어 등치 조인(rd.answer_cit_ext 와 같은 이유)
CREATE FUNCTION rd.answer_t_own(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4, t_own int2)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT j.surface, j.round_date, j.answer_key,
       coalesce(bit_or(rd.t_own_bits(b.own_bit, b.t_mention, b.t_recommendation, b.t_comparison, b.t_definition, b.t_final_choice)), 0)::int2
  FROM rd.job j
  LEFT JOIN rd.answer_brand b ON b.surface = j.surface AND b.round_date = j.round_date AND b.answer_key = j.answer_key
 WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys))
 GROUP BY j.surface, j.round_date, j.answer_key
$f$;

CREATE FUNCTION rd.fill_answer_t_own(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int;
BEGIN
  IF p_keys IS NULL THEN
    RAISE EXCEPTION 'rd.fill_answer_t_own: 키 배열 필수(배치로 나눠 부른다, back/migration/fill-v218.sql)';
  END IF;
  UPDATE rd.answer a SET t_own = x.t_own
    FROM rd.answer_t_own(p_keys) x
   WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
     AND a.t_own IS DISTINCT FROM x.t_own;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF EXISTS (SELECT 1 FROM rd.job j
               JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
              WHERE j.answer_key = ANY (p_keys) AND j.served AND a.t_own IS NULL) THEN
    RAISE EXCEPTION 'rd.fill_answer_t_own: 채우지 못한 서빙 답변이 있다(rd.job ↔ rd.answer 좌표 불일치)';
  END IF;
  RETURN n;
END $f$;

CREATE FUNCTION rd.assert_answer_t_own(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE a.t_own IS DISTINCT FROM x.t_own)
    INTO n, v
    FROM rd.answer_t_own(p_keys) x
    JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
   WHERE a.t_own IS NOT NULL;
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.answer.t_own ≠ 재계산(rd.answer_brand): % 답변', v;
  END IF;
  RETURN n;
END $f$;

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER FUNCTION rd.t_own_bits(int2, int2, int2, int2, int2, int2) OWNER TO hmg_owner;
ALTER FUNCTION rd.answer_t_own(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_answer_t_own(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_t_own(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.t_own_bits(int2, int2, int2, int2, int2, int2), rd.answer_t_own(int4[]), rd.fill_answer_t_own(int4[]),
  rd.assert_answer_t_own(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.t_own_bits(int2, int2, int2, int2, int2, int2), rd.answer_t_own(int4[]), rd.fill_answer_t_own(int4[]),
  rd.assert_answer_t_own(int4[]) TO loader, migrator;

-- ── 사후 단언(구조만: 값은 적재기가 새 행부터, 기존 행은 fill-v218.sql) ─────────────────────
DO $v$
DECLARE bad text;
BEGIN
  -- 새 열: int2·NULL 허용·기본값 없음, 파티션 leaf 까지 전파
  SELECT string_agg(t.r::text, ', ') INTO bad
    FROM (SELECT 'rd.answer'::regclass UNION ALL SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = 'rd.answer'::regclass
          UNION ALL SELECT i2.inhrelid::regclass FROM pg_inherits i1 JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
           WHERE i1.inhparent = 'rd.answer'::regclass) t(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.r AND a.attname = 't_own' AND NOT a.attisdropped
                      AND a.atttypid = 'int2'::regtype AND NOT a.attnotnull AND NOT a.atthasdef);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'P105 실패: t_own 형·NULL·기본값·전파: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass
        AND conname IN ('answer_t_own_range', 'answer_t_own_in_mask')) <> 2 THEN
    RAISE EXCEPTION 'P105 실패: CHECK';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('rd.t_own_bits(int2, int2, int2, int2, int2, int2)'::regprocedure,
               'rd.answer_t_own(int4[])'::regprocedure, 'rd.fill_answer_t_own(int4[])'::regprocedure,
               'rd.assert_answer_t_own(int4[])'::regprocedure) AND pg_get_userbyid(proowner) <> 'hmg_owner')
     OR NOT has_function_privilege('loader', 'rd.t_own_bits(int2, int2, int2, int2, int2, int2)', 'execute')
     OR NOT has_function_privilege('loader', 'rd.assert_answer_t_own(int4[])', 'execute')
     OR NOT has_function_privilege('migrator', 'rd.fill_answer_t_own(int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.answer_t_own(int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.fill_answer_t_own(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P106 실패: 함수 소유자·실행 권한';
  END IF;
  -- 식 고정값(비트 배치가 조회 core 와 같다: Hyundai mention = 1, Kia comparison = 1 << 7, Genesis final_choice = 1 << 14, 밖 = NULL)
  IF rd.t_own_bits(1::int2, 1::int2, 0::int2, 0::int2, 0::int2, 0::int2) <> 1
     OR rd.t_own_bits(2::int2, 0::int2, 0::int2, 3::int2, 0::int2, 0::int2) <> 128
     OR rd.t_own_bits(4::int2, 0::int2, 0::int2, 0::int2, 0::int2, 2::int2) <> 16384
     OR rd.t_own_bits(0::int2, 1::int2, 1::int2, 1::int2, 1::int2, 1::int2) IS NOT NULL THEN
    RAISE EXCEPTION 'P106 실패: rd.t_own_bits 비트 배치';
  END IF;
  -- 함수가 컴파일되고 빈 키에 0 을 낸다(쓰기 없음)
  PERFORM rd.fill_answer_t_own(ARRAY[]::int4[]);
  PERFORM rd.assert_answer_t_own(ARRAY[]::int4[]);
  PERFORM 1 FROM rd.answer_t_own(ARRAY[]::int4[]);
END $v$;

COMMIT;
