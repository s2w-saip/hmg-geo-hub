-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.31 (PostgreSQL 17, 2026-10-02) · 엔티티 반영 재동결 감사(제품 결정 27·31·32)
-- 적용 순서: DB-v2.30 뒤 1회(트랜잭션 1개). 합본 DB-v2.31.sql = DB-v2.30.sql + 이 파일(바이트 연결). 가번호 DB-vNEXT-ecat-refreeze-audit
--   PR1 → P152(be/int4 통합).
-- 근거: 엔티티 버전 반영(ingest/project/apply/ecat_engine.py)이 범위의 동결 회차를 재해석 재동결(frz.regenerate)하면 그 회차·옛 세대·새 세대를
--   엔티티 관리 감사 원장(app.ecat_audit_log, DB-v2.17 P102)에 한 행씩 남긴다(action 'apply.refreeze'). 적재기는 loader 롤로 돈다.
--   원장은 append-only 그대로(UPDATE·DELETE·TRUNCATE 트리거), 행위자 = app.actor()(적재기가 반영 승인자를 app.actor_id 로 심는다,
--   actor_type 'system'). loader 는 app.actor() 실행 권한이 이미 있다(PUBLIC).
-- P152 GRANT INSERT ON app.ecat_audit_log TO loader + 사후 단언(loader 는 INSERT 만, UPDATE·DELETE 없음)
-- 락: 권한 부여뿐(표 잠금 = 카탈로그 갱신 순간).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '1min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('app.ecat_audit_log') IS NULL OR to_regprocedure('frz.regenerate(uuid, text, jsonb)') IS NULL
     OR to_regclass('rd.cycle_pick_basis') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.30(rd.cycle_pick_basis, DB-v2.17 app.ecat_audit_log·DB-v2.22 frz.regenerate 포함) 이 먼저 적용돼야 한다';
  END IF;
  IF has_table_privilege('loader', 'app.ecat_audit_log', 'insert') THEN
    RAISE EXCEPTION 'DB-v2.31(ecat-refreeze-audit) 이미 적용됨(loader 가 app.ecat_audit_log INSERT 가능)';
  END IF;
END $v$;

-- ── P152 ─────────────────────────────────────────────────────────────────────
GRANT INSERT ON app.ecat_audit_log TO loader;

DO $v$ BEGIN
  IF NOT has_table_privilege('loader', 'app.ecat_audit_log', 'insert')
     OR has_table_privilege('loader', 'app.ecat_audit_log', 'update') OR has_table_privilege('loader', 'app.ecat_audit_log', 'delete')
     OR NOT has_function_privilege('loader', 'app.actor()', 'execute') THEN
    RAISE EXCEPTION 'DB-v2.31(ecat-refreeze-audit) P152 사후 단언 실패: loader 감사 원장 권한';
  END IF;
END $v$;
COMMIT;
