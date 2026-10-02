-- ============================================================================
-- hmg-geo 재설계 DB-v2.3 보완 패치 (PostgreSQL 17, 2026-09-28) · core 독립 검증 지적 반영
-- 적용 순서: DB-v2.2.sql(= DB-v2.1.sql + DB-v2.2-patch.sql) 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.3.sql = DB-v2.2.sql + 이 파일.
--
-- 반영 목록
--   P31 app.user_account
--       a) CHECK ua_admin_scope_all: admin 계정은 scope_all 강제(DECISIONS-API Q16, 추가 결정 2026-09-28)
--       b) BEFORE 트리거 tg_user_account_scope: 스코프 값 참조 검증(scope_brands ⊆ app.brand, scope_regions ⊆ app.rhq_region,
--          scope_countries ⊆ app.rhq_region_country 국가). 위반은 SQLSTATE 23503(foreign_key_violation)
--          (DB-v2.sql :112 주석 "트리거: 스코프 값 참조 검증" 의 실제 구현. 검증 B1: 풀리지 않는 권역 id 가 저장되지 않게 한다)
--       c) AFTER 트리거 tg_user_account_audit: app.permission_audit_log 한 행(행위자 = app.actor(), 미설정이면 쓰기 전체 거부)
--          (같은 :112 주석 "permission_audit_log(행위자 필수)" 의 실제 구현. 감사 원장의 쓰기 주체는 트리거 하나 →
--           api_rw 의 app.permission_audit_log INSERT 회수: DB-v2.1 P04 의 prompt_audit_log 와 같은 원칙, 이중 기록 금지)
--   P32 rd.assert_answer_cit_counts(int4[], bool) 엄격 모드: p_strict = true 면 서빙 답변이 아닌(미지·비서빙) 키가 섞일 때 예외.
--       1인자 판(int4[])은 비엄격으로 위임한다(DB-v2.2 호출부 호환).
--   P33 앱 로그인 롤 hgh_app(LOGIN NOINHERIT): 풀 롤 api_ro·api_rw·admin_long·qa_gate 멤버십(INHERIT FALSE, SET TRUE).
--       롤 권한은 SET ROLE(core.db 가 트랜잭션마다 set_config('role', <풀 롤>, true)) 뒤에만 생긴다. 비밀번호는 DDL 에 두지 않는다:
--       배포 단계가 Secrets Manager 값으로 ALTER ROLE hgh_app PASSWORD 를 한다. 적재기 로그인 롤은 적재 모듈 배포 때 같은 방식으로 둔다.
--   P34 주석 정정(DB-v2.sql 은 수정하지 않는 원칙이라 카탈로그 COMMENT 로 둔다)
--       DB-v2.sql :838 "api_rw: app 쓰기(행위자 필수)" 의 실제 범위: DB 가 행위자를 강제하는 표는 트리거가 있는
--       app.project(4열)·app.prompt·app.user_account 셋이다. 그 밖의 app 쓰기는 core.db.Database.write 가 항상 행위자 GUC 를 심는
--       앱 규약으로 보장한다. 판단 근거: app 전 표에 행위자 문장 트리거를 걸면 계정 없는 검수 게이트(qa_gate, Q17)의 app.qa_* 쓰기와
--       접근 감사 배치(app.access_audit_log, 사용자 행위자가 아닌 행 값으로 기록)가 막힌다. 감사 행을 남기는 표에만 DB 강제를 둔다.
-- 규약: D8 무관(사전 집계 없음). 새 btree 없음.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- P31. app.user_account 스코프 제약·트리거
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE app.user_account ADD CONSTRAINT ua_admin_scope_all CHECK (role <> 'admin' OR scope_all);

CREATE FUNCTION app.tg_user_account_scope() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE bad text[];
BEGIN
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_brands) x WHERE NOT EXISTS (SELECT 1 FROM app.brand b WHERE b.brand_code = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_brands 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_regions) x WHERE NOT EXISTS (SELECT 1 FROM app.rhq_region r WHERE r.region_id = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_regions 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_countries) x
                WHERE NOT EXISTS (SELECT 1 FROM app.rhq_region_country c WHERE c.country_code = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_countries 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER user_account_scope_check
  BEFORE INSERT OR UPDATE OF scope_brands, scope_regions, scope_countries ON app.user_account
  FOR EACH ROW EXECUTE FUNCTION app.tg_user_account_scope();

-- 권한 감사: 생성·삭제는 항상, 수정은 권한 관련 열이 바뀔 때만(표시명·타임스탬프만 바뀌면 행 없음)
CREATE FUNCTION app.tg_user_account_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE v_actor uuid := app.actor();   -- 행위자 필수: 미설정이면 계정 쓰기 전체 거부
        keep text[] := ARRAY['user_id','email','role','operator','scope_all','scope_brands','scope_regions','scope_countries',
                             'menu_groups','is_qa_reviewer','status'];
        o jsonb; n jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    o := (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(keep) k);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    n := (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(keep) k);
  END IF;
  IF TG_OP = 'UPDATE' AND o IS NOT DISTINCT FROM n THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.permission_audit_log (target_user_id, actor_id, change_type, before, after)
  VALUES (coalesce(NEW.user_id, OLD.user_id), v_actor,
          CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END, o, n);
  RETURN NULL;
END $f$;
CREATE TRIGGER user_account_audit AFTER INSERT OR UPDATE OR DELETE ON app.user_account
  FOR EACH ROW EXECUTE FUNCTION app.tg_user_account_audit();

ALTER FUNCTION app.tg_user_account_scope() OWNER TO hmg_owner;
ALTER FUNCTION app.tg_user_account_audit() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.tg_user_account_scope(), app.tg_user_account_audit() FROM PUBLIC;
REVOKE INSERT ON app.permission_audit_log FROM api_rw;                 -- 쓰기 주체 = 트리거 하나(이중 기록 금지)
COMMENT ON TABLE app.user_account IS
  '계정·권한. 트리거: user_account_scope_check(스코프 값 참조 검증, 23503) · user_account_audit(permission_audit_log, 행위자 app.actor() 필수). '
  'CHECK ua_admin_scope_all(admin = scope_all, Q16)';

-- ════════════════════════════════════════════════════════════════════════════
-- P32. 인용 수 단언 엄격 모드
-- ════════════════════════════════════════════════════════════════════════════
CREATE FUNCTION rd.assert_answer_cit_counts(p_keys int4[], p_strict bool) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE unknown int; n int;
BEGIN
  IF p_strict AND p_keys IS NOT NULL THEN
    SELECT count(*) INTO unknown
      FROM (SELECT DISTINCT k FROM unnest(p_keys) k) x
     WHERE NOT EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = x.k AND j.served);
    IF unknown > 0 THEN
      RAISE EXCEPTION 'rd.assert_answer_cit_counts: 서빙 답변이 아닌 키 % 개(미지·비완료·드롭)', unknown;
    END IF;
  END IF;
  n := rd._assert_answer_cit_counts(p_keys);
  RETURN n;
END $f$;
-- 기존 1인자 본문을 내부 이름으로 옮기고, 1인자 공개 판은 비엄격 위임으로 바꾼다(호출부·권한 유지)
ALTER FUNCTION rd.assert_answer_cit_counts(int4[]) RENAME TO _assert_answer_cit_counts;
CREATE FUNCTION rd.assert_answer_cit_counts(p_keys int4[]) RETURNS int
LANGUAGE sql SET search_path = pg_catalog AS $f$ SELECT rd.assert_answer_cit_counts(p_keys, false) $f$;
ALTER FUNCTION rd.assert_answer_cit_counts(int4[], bool) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_cit_counts(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.assert_answer_cit_counts(int4[], bool), rd.assert_answer_cit_counts(int4[]),
  rd._assert_answer_cit_counts(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.assert_answer_cit_counts(int4[], bool), rd.assert_answer_cit_counts(int4[]),
  rd._assert_answer_cit_counts(int4[]) TO loader, migrator;

-- ════════════════════════════════════════════════════════════════════════════
-- P33. 앱 로그인 롤(비밀번호 없음: 배포 단계에서 Secrets Manager 값으로 설정)
-- ════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hgh_app') THEN
    CREATE ROLE hgh_app LOGIN NOINHERIT CONNECTION LIMIT 200;
  END IF;
END $$;
GRANT api_ro, api_rw, admin_long, qa_gate TO hgh_app WITH INHERIT FALSE, SET TRUE;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO hgh_app', current_database()); END $$;
COMMENT ON ROLE hgh_app IS 'FastAPI 앱 로그인 롤(NOINHERIT). 권한은 트랜잭션마다 set_config(role) 로 풀 롤 전환 뒤에만. 비밀번호는 Secrets Manager';

-- ════════════════════════════════════════════════════════════════════════════
-- P34. 주석 정정
-- ════════════════════════════════════════════════════════════════════════════
COMMENT ON ROLE api_rw IS 'app 쓰기. DB 가 행위자(app.actor)를 강제하는 표 = app.project(4열 트리거)·app.prompt·app.user_account. '
  '그 밖은 core.db.Database.write 가 행위자 GUC 를 항상 심는 앱 규약(검수 게이트·접근 감사 배치는 사용자 행위자 없음)';

COMMIT;
