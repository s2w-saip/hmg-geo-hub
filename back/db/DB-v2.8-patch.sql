-- ============================================================================
-- hmg-geo 재설계 DB-v2.8 보완 패치 (PostgreSQL 17, 2026-09-28) · core 6라운드 5.1 좁은 검증 수정(N-1·I-1)
-- 적용 순서: DB-v2.7.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.8.sql = DB-v2.7.sql + 이 파일. 추가·교체형(열·표 변경 없음).
--
-- P57 마지막 실효 admin 트리거 발동 조건 좁히기(검증 N-1, P53 회귀): v2.7 은 실효 admin 행의 UPDATE 면 역할과 무관한 열(display_name 등)
--     만 바꿔도 발동해 남은 실효 admin 전부를 FOR SHARE 로 잠갔다. READ COMMITTED 트랜잭션 둘이 서로 다른 admin 의 이름만 고쳐도
--     40P01(교착)이 났다(v2.6 은 오류 0). 트리거를 둘로 나눈다:
--       ua_last_admin     AFTER UPDATE, WHEN OLD 는 실효 admin ∧ NEW 는 실효 admin 아님(강등·정지·admin 메뉴 제거만)
--       ua_last_admin_del AFTER DELETE, WHEN OLD 는 실효 admin
--     함수도 첫머리에서 NEW 가 여전히 실효 admin 인 UPDATE 는 잠금 전에 돌아간다(방어 심층). 판정·잠금·오류(23514 ua_last_admin)는 v2.7 과 같다.
-- P58 app.term_norm 소유자 = app.project_tracked_keyword 소유자(hmg_owner)(검증 I-1): v2.7 은 패치 적용 롤(dev postgres, stg hmgadmin)이
--     소유해 hmg_owner 에 EXECUTE 가 없었다(생성 열 표의 소유자가 식 함수를 실행하지 못하는 상태). 기존 GRANT 는 유지·재확인한다.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';

DO $v$ BEGIN
  IF to_regprocedure('app.term_norm(text)') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.7 이 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ua_last_admin_del' AND tgrelid = 'app.user_account'::regclass) THEN
    RAISE EXCEPTION 'DB-v2.8 이미 적용됨(ua_last_admin_del 존재)';
  END IF;
END $v$;

-- ── P57 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tg_last_admin_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE n int;
BEGIN
  -- 방어 심층: 발동 조건(WHEN)이 이미 거르지만, 여전히 실효 admin 인 행의 UPDATE 는 잠그지 않고 돌아간다(역할 무관 열 편집의 교착 방지)
  IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.status = 'active'
     AND (NEW.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (NEW.menu_groups)) THEN
    RETURN NULL;
  END IF;
  -- 남은 실효 admin 행을 FOR SHARE 로 잠그며 센다(동시에 다른 admin 을 내리는 트랜잭션과 직렬화: 대기·40P01·40001, RC 는 재평가 뒤 0 → 23514)
  SELECT count(*) INTO n
    FROM (SELECT 1 FROM app.user_account u
           WHERE u.role = 'admin' AND u.status = 'active' AND (u.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (u.menu_groups))
             FOR SHARE) x;
  IF n = 0 THEN
    RAISE EXCEPTION '마지막 실효 admin 을 없앨 수 없다(역할·상태·메뉴 그룹 변경 또는 삭제)'
      USING ERRCODE = '23514', CONSTRAINT = 'ua_last_admin', TABLE = 'user_account', SCHEMA = 'app';
  END IF;
  RETURN NULL;
END $f$;
REVOKE EXECUTE ON FUNCTION app.tg_last_admin_guard() FROM PUBLIC;

DROP TRIGGER ua_last_admin ON app.user_account;
CREATE CONSTRAINT TRIGGER ua_last_admin AFTER UPDATE ON app.user_account DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.role = 'admin' AND OLD.status = 'active' AND (OLD.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (OLD.menu_groups))
        AND NOT coalesce(NEW.role = 'admin' AND NEW.status = 'active'
                         AND (NEW.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (NEW.menu_groups)), false))
  EXECUTE FUNCTION app.tg_last_admin_guard();
CREATE CONSTRAINT TRIGGER ua_last_admin_del AFTER DELETE ON app.user_account DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.role = 'admin' AND OLD.status = 'active' AND (OLD.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (OLD.menu_groups)))
  EXECUTE FUNCTION app.tg_last_admin_guard();

-- ── P58 ─────────────────────────────────────────────────────────────────────
DO $v$ BEGIN
  EXECUTE format('ALTER FUNCTION app.term_norm(text) OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app.project_tracked_keyword'::regclass));
END $v$;
REVOKE EXECUTE ON FUNCTION app.term_norm(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.term_norm(text) TO api_ro, api_rw, admin_long, qa_gate, loader, loader_ro, migrator;

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$ DECLARE owner_ok bool; BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'app.user_account'::regclass AND tgname IN ('ua_last_admin', 'ua_last_admin_del')
         AND tgdeferrable AND tginitdeferred) <> 2 THEN RAISE EXCEPTION 'P57 트리거 실패'; END IF;
  IF position('NEW.role' in (SELECT prosrc FROM pg_proc WHERE oid = 'app.tg_last_admin_guard()'::regprocedure)) = 0
    THEN RAISE EXCEPTION 'P57 함수 실패'; END IF;
  SELECT pg_get_userbyid(p.proowner) = pg_get_userbyid(c.relowner) INTO owner_ok
    FROM pg_proc p, pg_class c WHERE p.oid = 'app.term_norm(text)'::regprocedure AND c.oid = 'app.project_tracked_keyword'::regclass;
  IF NOT owner_ok OR NOT has_function_privilege((SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app.project_tracked_keyword'::regclass),
                                                'app.term_norm(text)', 'execute')
     OR NOT has_function_privilege('api_ro', 'app.term_norm(text)', 'execute')
     OR NOT has_function_privilege('loader', 'app.term_norm(text)', 'execute') THEN RAISE EXCEPTION 'P58 실패'; END IF;
END $v$;

COMMIT;
