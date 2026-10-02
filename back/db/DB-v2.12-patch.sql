-- ============================================================================
-- hmg-geo 재설계 DB-v2.12 보완 패치 (PostgreSQL 17, 2026-09-30) · core 10(제품 책임자 전환 결정 3·4)
-- 적용 순서: DB-v2.11.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.12.sql = DB-v2.11.sql + 이 파일. 교체형(표·열 불변).
--
-- P69 app.user_account CHECK ua_country_scope 완화(결정 4: 중동 country 계정 bd942069 를 권역 단위로 유지).
--     country 역할 ∧ scope_all 거짓이면 국가 또는 권역 스코프가 하나 이상(ua_region_scope 와 같은 식). 종전 = 국가 필수(그래서 이관 R2 가
--     권역을 국가 7개로 전개했고, 비멤버 가시 목록에서 중동 밖 브랜드 공통 프로젝트 9개가 빠졌다).
--     현행 front 는 이 제약이 없다(profiles 에 CHECK 없음). 권역만 가진 country 계정의 데이터 범위 = 권역 전개(front effectiveScopeCountries,
--     백엔드 DataScope.countries), 비멤버 프로젝트 가시성 = projectInScope(scope-policy.ts:99-121: 계정 국가가 비면 국가 조건 없음, 브랜드 공통
--     프로젝트는 권역 밖도 보인다) = 백엔드 DataScope.project_in_scope. 국가·권역 둘 다 없는 country 계정(보류 2계정)은 여전히 거부한다.
-- P70 app.tg_user_account_scope 정본 표기 순서(결정 3: 계정 국가 표기를 정본으로). 대소문자 무시 일치 → rd.dim_country 코드 표기(빈 코드 제외)
--     → 없으면 app.rhq_region_country 표기 → 없으면 원문(참조 거부). 종전(P59) = rhq 먼저. rd.dim_country 코드가 API 응답·필터 옵션 코드의 정본
--     (F1 CANON_ORDER, DB-v2.10 P65 upper(code) 유일)이라 계정 저장 표기를 그 표기와 같게 한다. 두 원천 표기가 같으면 결과가 같다
--     (stg 2026-09-30 읽기 전용 실측: 계정 국가 원소 중 dim_country 표기와 다른 것 0).
--     이미 이관된 계정 보정: back/migration/fix-core10-account-scope.sql(stg 1회, 이 패치 뒤).
--
-- 결과 캐시(DB-v2.11, DECISIONS-API '결과 캐시' 무효화 절차): 이 패치를 적용한 뒤 migrator 로 `SELECT app.result_cache_invalidate();` 를 실행한다.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regnamespace('rcache') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.11 이 먼저 적용돼야 한다';
  END IF;
  IF position('scope_regions' in (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                   WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope')) > 0 THEN
    RAISE EXCEPTION 'DB-v2.12 이미 적용됨(ua_country_scope 가 권역을 받는다)';
  END IF;
END $v$;

-- ── P69 ─────────────────────────────────────────────────────────────────────
ALTER TABLE app.user_account
  DROP CONSTRAINT ua_country_scope,
  ADD CONSTRAINT ua_country_scope CHECK (role <> 'country' OR scope_all OR cardinality(scope_countries) + cardinality(scope_regions) > 0);
COMMENT ON CONSTRAINT ua_country_scope ON app.user_account IS
  'country 역할은 국가 또는 권역 스코프가 필요(권역만이면 데이터 = 권역 전개, 비멤버 가시성 = 국가 조건 없음: 현행 front projectInScope). DB-v2.12 P69';

-- ── P70 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tg_user_account_scope() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE bad text[]; canon text[];
BEGIN
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_brands) x WHERE NOT EXISTS (SELECT 1 FROM app.brand b WHERE b.brand_code = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_brands 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_regions) x WHERE NOT EXISTS (SELECT 1 FROM app.rhq_region r WHERE r.region_id = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_regions 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- 국가: 정본 표기(dim_country 코드 → rhq 국가 순, 대소문자 무시 일치)로 맞춘 뒤 참조 확인. 맞출 곳이 없으면 원문 그대로 두고 거부한다(P70).
  canon := ARRAY(
    SELECT c.y FROM (
      SELECT DISTINCT ON (s.y) s.y, s.i FROM (
        SELECT coalesce(
                 (SELECT d.code FROM rd.dim_country d WHERE d.code <> '' AND upper(d.code) = upper(u.x)
                   ORDER BY d.code = u.x DESC, d.code LIMIT 1),
                 (SELECT rc.country_code FROM app.rhq_region_country rc WHERE upper(rc.country_code) = upper(u.x)
                   ORDER BY rc.country_code = u.x DESC, rc.country_code LIMIT 1),
                 u.x) AS y, u.i
          FROM unnest(NEW.scope_countries) WITH ORDINALITY u(x, i)) s
      ORDER BY s.y, s.i) c
    ORDER BY c.i);
  bad := ARRAY(SELECT x FROM unnest(canon) x
                WHERE NOT EXISTS (SELECT 1 FROM app.rhq_region_country c WHERE c.country_code = x)
                  AND NOT EXISTS (SELECT 1 FROM rd.dim_country d WHERE d.code = x AND d.code <> ''));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_countries 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF canon IS DISTINCT FROM NEW.scope_countries THEN
    NEW.scope_countries := canon;
  END IF;
  RETURN NEW;
END $f$;
ALTER FUNCTION app.tg_user_account_scope() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.tg_user_account_scope() FROM PUBLIC;

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$
DECLARE src text;
BEGIN
  IF position('scope_regions' in (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                   WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope')) = 0 THEN
    RAISE EXCEPTION 'P69 실패: ua_country_scope';
  END IF;
  IF NOT (SELECT convalidated FROM pg_constraint WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope') THEN
    RAISE EXCEPTION 'P69 실패: 검증되지 않은 제약';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'app.tg_user_account_scope()'::regprocedure;
  IF position('FROM rd.dim_country d WHERE d.code <> '''' AND upper(d.code)' in src) = 0
     OR position('FROM rd.dim_country d WHERE d.code <> '''' AND upper(d.code)' in src)
        > position('FROM app.rhq_region_country rc WHERE upper(rc.country_code)' in src)
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app.tg_user_account_scope()'::regprocedure) <> 'hmg_owner' THEN
    RAISE EXCEPTION 'P70 실패: 정본 표기 순서·소유자';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'app.user_account'::regclass AND NOT tgisinternal
                  AND tgfoid = 'app.tg_user_account_scope()'::regprocedure) THEN
    RAISE EXCEPTION 'P70 실패: 트리거 연결 없음';
  END IF;
END $v$;

COMMIT;
