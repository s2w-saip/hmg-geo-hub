-- ============================================================================
-- hmg-geo 재설계 DB-v2.4 보완 패치 (PostgreSQL 17, 2026-09-28) · core 재검증 N3 반영
-- 적용 순서: DB-v2.3.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.4.sql = DB-v2.3.sql + 이 파일.
--
-- P41 권역 참조 보호: 계정(app.user_account)이 참조하는 권역·국가가 사라지거나 바뀌면 그 계정의 데이터 스코프가 조용히 넓어지거나
--     (권역 전개가 비면 core 는 거부하지만) 프로젝트 가시성 규칙이 빠진다. v2.3 의 계정 쪽 참조 검증(쓰기 시점)과 짝으로,
--     참조되는 쪽 표의 변경을 막는다.
--   app.rhq_region         DELETE, UPDATE OF region_id·brand_code : scope_regions 가 그 region_id 를 가진 계정이 있으면 거부(23503)
--   app.rhq_region_country DELETE, UPDATE OF region_id·country_code:
--                           ① scope_regions 가 그 region_id 를 가진 계정이 있으면 거부(권역 전개 결과가 바뀐다)
--                           ② 그 국가가 마지막 행이고 scope_countries 가 그 국가를 가진 계정이 있으면 거부(국가 참조가 끊긴다)
--   두 표 TRUNCATE          : 권역·국가 스코프를 가진 계정이 하나라도 있으면 거부(행 트리거가 TRUNCATE 에는 돌지 않으므로 문장 트리거)
--   label 등 그 밖의 열 UPDATE 는 막지 않는다. 시드(seed-10·fixture-00)는 TRUNCATE 재적재 대신 UPSERT + 사라진 행만 DELETE 로 바꿨다.
-- ============================================================================
BEGIN;

CREATE FUNCTION app.tg_rhq_region_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM app.user_account u WHERE cardinality(u.scope_regions) > 0 OR cardinality(u.scope_countries) > 0) THEN
      RAISE EXCEPTION '%.% TRUNCATE 거부: 권역·국가 스코프를 가진 계정이 있다(UPSERT 로 재적재)', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'rhq_region' THEN
    IF (TG_OP = 'DELETE' OR NEW.region_id IS DISTINCT FROM OLD.region_id OR NEW.brand_code IS DISTINCT FROM OLD.brand_code)
       AND EXISTS (SELECT 1 FROM app.user_account u WHERE OLD.region_id = ANY (u.scope_regions)) THEN
      RAISE EXCEPTION 'app.rhq_region % 변경 거부: 이 권역을 스코프로 가진 계정이 있다', OLD.region_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSE
    IF TG_OP = 'DELETE' OR (NEW.region_id, NEW.country_code) IS DISTINCT FROM (OLD.region_id, OLD.country_code) THEN
      IF EXISTS (SELECT 1 FROM app.user_account u WHERE OLD.region_id = ANY (u.scope_regions)) THEN
        RAISE EXCEPTION 'app.rhq_region_country %/% 변경 거부: 이 권역을 스코프로 가진 계정이 있다', OLD.region_id, OLD.country_code
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM app.user_account u WHERE OLD.country_code = ANY (u.scope_countries))
         AND NOT EXISTS (SELECT 1 FROM app.rhq_region_country c
                          WHERE c.country_code = OLD.country_code AND (c.region_id, c.country_code) <> (OLD.region_id, OLD.country_code))
         AND (TG_OP = 'DELETE' OR NEW.country_code IS DISTINCT FROM OLD.country_code) THEN
        RAISE EXCEPTION 'app.rhq_region_country %/% 변경 거부: 이 국가를 스코프로 가진 계정이 있고 마지막 행이다', OLD.region_id, OLD.country_code
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $f$;

CREATE TRIGGER rhq_region_guard BEFORE DELETE OR UPDATE OF region_id, brand_code ON app.rhq_region
  FOR EACH ROW EXECUTE FUNCTION app.tg_rhq_region_guard();
CREATE TRIGGER rhq_region_country_guard BEFORE DELETE OR UPDATE OF region_id, country_code ON app.rhq_region_country
  FOR EACH ROW EXECUTE FUNCTION app.tg_rhq_region_guard();
CREATE TRIGGER rhq_region_truncate_guard BEFORE TRUNCATE ON app.rhq_region
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_rhq_region_guard();
CREATE TRIGGER rhq_region_country_truncate_guard BEFORE TRUNCATE ON app.rhq_region_country
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_rhq_region_guard();

ALTER FUNCTION app.tg_rhq_region_guard() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.tg_rhq_region_guard() FROM PUBLIC;
COMMENT ON TABLE app.rhq_region IS '권역본부 권역. 계정 scope_regions 가 참조하는 권역의 DELETE·키 UPDATE·TRUNCATE 는 거부(rhq_region_guard, DB-v2.4)';
COMMENT ON TABLE app.rhq_region_country IS '권역 → 국가. 참조 계정이 있는 권역의 행 DELETE·UPDATE, 계정 국가 참조의 마지막 행 삭제, TRUNCATE 는 거부(DB-v2.4)';

COMMIT;
