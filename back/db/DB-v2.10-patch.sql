-- ============================================================================
-- hmg-geo 재설계 DB-v2.10 보완 패치 (PostgreSQL 17, 2026-09-29) · core 9라운드(검증 관찰: rd.dim_country 대소문자 중복 → 전 요청 500)
-- 적용 순서: DB-v2.9.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.10.sql = DB-v2.9.sql + 이 파일. 추가형(색인 1개).
--
-- P65 rd.dim_country (upper(code)) 유일 색인: core.codes.load_refs 는 국가를 upper 키로 조회해 대소문자만 다른 코드가 둘이면 어느 쪽인지
--     정할 수 없어 거부한다(데이터 무결성 신호, 전 요청 500). 적재기(ingest DIM_COUNTRY·seed-30 §2)는 이제 upper 기준으로 이미 있는
--     정본 행을 재사용하고 조인도 upper 등치다. 이 색인은 어떤 경로로도 그 상태를 만들 수 없게 DB 에서 막는다(위반 = 23505,
--     적재 트랜잭션이 통째로 롤백되고 API 는 계속 돈다). 조인 upper(g.code) = upper(x) 도 이 색인을 쓸 수 있다.
--     사전 확인: 이미 중복이 있으면 목록과 함께 멈춘다(색인 생성 실패보다 먼저 원인을 보인다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'app.ga4_property'::regclass AND attname = 'verified_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.9 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.dim_country_code_upper_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.10 이미 적용됨(rd.dim_country_code_upper_uq 존재)';
  END IF;
END $v$;

-- ── P65 ─────────────────────────────────────────────────────────────────────
DO $v$ DECLARE d text; BEGIN
  SELECT string_agg(u || '(' || codes || ')', ', ') INTO d
    FROM (SELECT upper(code) AS u, string_agg(code, '·' ORDER BY code) AS codes FROM rd.dim_country GROUP BY upper(code) HAVING count(*) > 1) x;
  IF d IS NOT NULL THEN
    RAISE EXCEPTION 'rd.dim_country 에 대소문자만 다른 코드가 이미 있다: %', d;
  END IF;
END $v$;
CREATE UNIQUE INDEX dim_country_code_upper_uq ON rd.dim_country (upper(code));
COMMENT ON INDEX rd.dim_country_code_upper_uq IS '대소문자만 다른 국가 코드 금지(core.codes.load_refs upper 조회, DB-v2.10 P65)';

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'rd.dim_country_code_upper_uq'::regclass AND i.indisunique AND i.indisvalid)
    THEN RAISE EXCEPTION 'P65 실패'; END IF;
END $v$;

COMMIT;
