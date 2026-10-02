-- ============================================================================
-- stg 1회 보정: 이미 이관된 계정(app.user_account)에 core 10 제품 결정 3·4 반영 (2026-09-30). **작성만, 실행은 메인 결정 뒤**.
--   A. 결정 3 계정 국가 표기 정본화: scope_countries 원소를 정본 표기(대소문자 무시 일치 → rd.dim_country 코드 → app.rhq_region_country
--      → 원문, DB-v2.12 P70 트리거와 같은 규칙)로 고친다. 2026-09-30 stg 읽기 전용 실측 대상 0행(계정 국가 원소가 전부 dim_country 표기와 같다).
--   B. 결정 4 권역만 가진 country 계정 되돌림: 이관 R2 가 권역을 국가로 펼친 계정(원천 mig_src.profiles 의 countries 가 비고 권역이 있으며,
--      지금 값이 그 권역 전개 그대로인 country 역할)을 국가 비움·권역 유지로. stg 기대 1행(bd942069). 이관 뒤 관리자가 고친 계정은 건드리지 않는다.
-- 선행: DB-v2.12(P69·P70). 멱등: 다시 돌리면 A·B 모두 0행. 트랜잭션 1개, 행위자 = 계정 이관 합성 행위자(5eed…0002, system).
-- 권한 감사: 바뀐 행마다 app.permission_audit_log 1행(트리거)을 단언한다. 출력 = 개수·user_id 앞 8자·설정값(PII 없음).
--
-- 사용(드라이런이 기본: 끝에서 ROLLBACK):
--   psql -X -v ON_ERROR_STOP=1 -f fix-core10-account-scope.sql                                   # 드라이런, 대상 목록·개수 확인
--   psql -X -v ON_ERROR_STOP=1 -v expect_canon=0 -v expect_r2=1 -v commit=1 -f fix-core10-account-scope.sql   # 드라이런과 같은 개수일 때만 COMMIT
-- 뒤처리(결과 캐시 DB-v2.11, DECISIONS-API '결과 캐시' 무효화 절차): COMMIT 뒤 migrator 로 `SELECT app.result_cache_invalidate();`.
-- ============================================================================
\if :{?expect_canon}
\else
\set expect_canon -1
\endif
\if :{?expect_r2}
\else
\set expect_r2 -1
\endif
\set QUIET on
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SET LOCAL app.actor_id = '5eed0000-0000-4000-8000-000000000002';
SET LOCAL app.actor_type = 'system';
SELECT set_config('fix.expect_canon', :'expect_canon', true) AS e1, set_config('fix.expect_r2', :'expect_r2', true) AS e2 \gset fix_
\set QUIET off

DO $a$ BEGIN
  IF position('scope_regions' in coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                            WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope'), '')) = 0 THEN
    RAISE EXCEPTION 'DB-v2.12 이 먼저 적용돼야 한다(ua_country_scope 가 권역을 받지 않음)';
  END IF;
  IF to_regclass('mig_src.profiles') IS NULL THEN
    RAISE EXCEPTION 'mig_src.profiles 없음(계정 이관 원천: 결정 4 대상 판정에 필요)';
  END IF;
END $a$;

CREATE TEMP TABLE _pre ON COMMIT DROP AS
SELECT (SELECT count(*) FROM app.user_account) AS ua, (SELECT count(*) FROM app.permission_audit_log) AS pal;

-- ── B. 결정 4: R2 전개 계정 → 권역 유지 ─────────────────────────────────────────
CREATE TEMP TABLE _r2 ON COMMIT DROP AS
SELECT u.user_id, u.scope_regions, u.scope_countries AS before
  FROM app.user_account u
  JOIN mig_src.profiles p ON p.id = u.user_id
 WHERE u.role = 'country' AND NOT u.scope_all
   AND cardinality(coalesce(p.countries, '{}')) = 0 AND cardinality(u.scope_regions) > 0
   AND u.scope_regions = coalesce(p.regions, '{}')
   AND cardinality(u.scope_countries) > 0
   AND u.scope_countries = coalesce((SELECT array_agg(DISTINCT c.country_code ORDER BY c.country_code)
                                       FROM app.rhq_region_country c WHERE c.region_id = ANY (u.scope_regions)), '{}');
SELECT 'r2_target', left(user_id::text, 8), array_to_string(scope_regions, ','), array_to_string(before, ',') FROM _r2 ORDER BY user_id;
CREATE TEMP TABLE _r2_res ON COMMIT DROP AS
WITH up AS (UPDATE app.user_account u SET scope_countries = '{}', updated_at = now(), row_version = u.row_version + 1
              FROM _r2 WHERE u.user_id = _r2.user_id RETURNING u.user_id)
SELECT count(*) AS n FROM up;

-- ── A. 결정 3: 계정 국가 표기 정본화 ───────────────────────────────────────────
CREATE TEMP TABLE _canon ON COMMIT DROP AS
SELECT u.user_id, u.scope_countries AS before,
       ARRAY(SELECT c.y FROM (
               SELECT DISTINCT ON (s.y) s.y, s.i FROM (
                 SELECT coalesce((SELECT d.code FROM rd.dim_country d WHERE d.code <> '' AND upper(d.code) = upper(x.v)
                                   ORDER BY d.code = x.v DESC, d.code LIMIT 1),
                                 (SELECT rc.country_code FROM app.rhq_region_country rc WHERE upper(rc.country_code) = upper(x.v)
                                   ORDER BY rc.country_code = x.v DESC, rc.country_code LIMIT 1),
                                 x.v) AS y, x.i
                   FROM unnest(u.scope_countries) WITH ORDINALITY x(v, i)) s
               ORDER BY s.y, s.i) c ORDER BY c.i) AS after
  FROM app.user_account u;
DELETE FROM _canon WHERE after IS NOT DISTINCT FROM before;
SELECT 'canon_target', left(user_id::text, 8), array_to_string(before, ','), array_to_string(after, ',') FROM _canon ORDER BY user_id;
CREATE TEMP TABLE _canon_res ON COMMIT DROP AS
WITH up AS (UPDATE app.user_account u SET scope_countries = _canon.after, updated_at = now(), row_version = u.row_version + 1
              FROM _canon WHERE u.user_id = _canon.user_id RETURNING u.user_id, u.scope_countries)
SELECT count(*) AS n, count(*) FILTER (WHERE up.scope_countries IS DISTINCT FROM c.after) AS trigger_diff
  FROM up JOIN _canon c USING (user_id);

-- ── 단언(실패 = 예외 = 전체 롤백) ─────────────────────────────────────────────
DO $a$ DECLARE
  pre record; n_r2 bigint; t_r2 bigint; n_c bigint; t_c bigint; tdiff bigint; pal bigint; ua bigint; left_r2 bigint; left_c bigint;
  e_c int := current_setting('fix.expect_canon')::int; e_r2 int := current_setting('fix.expect_r2')::int;
BEGIN
  SELECT * INTO pre FROM _pre;
  SELECT n INTO n_r2 FROM _r2_res;  SELECT count(*) INTO t_r2 FROM _r2;
  SELECT n, trigger_diff INTO n_c, tdiff FROM _canon_res;  SELECT count(*) INTO t_c FROM _canon;
  IF n_r2 <> t_r2 THEN RAISE EXCEPTION 'B 갱신 % <> 대상 %', n_r2, t_r2; END IF;
  IF n_c <> t_c THEN RAISE EXCEPTION 'A 갱신 % <> 대상 %', n_c, t_c; END IF;
  IF tdiff <> 0 THEN RAISE EXCEPTION 'A 트리거 정본 표기와 보정 값이 다른 행 %(P70 규칙 불일치)', tdiff; END IF;
  IF e_r2 >= 0 AND n_r2 <> e_r2 THEN RAISE EXCEPTION 'B 대상 % <> 기대 %(드라이런과 다름)', n_r2, e_r2; END IF;
  IF e_c >= 0 AND n_c <> e_c THEN RAISE EXCEPTION 'A 대상 % <> 기대 %(드라이런과 다름)', n_c, e_c; END IF;
  SELECT count(*) INTO ua FROM app.user_account;
  IF ua <> pre.ua THEN RAISE EXCEPTION '계정 행 수가 바뀜 % → %', pre.ua, ua; END IF;
  SELECT count(*) INTO pal FROM app.permission_audit_log;
  IF pal <> pre.pal + n_r2 + n_c THEN RAISE EXCEPTION '권한 감사 % <> 사전 % + 갱신 %', pal, pre.pal, n_r2 + n_c; END IF;
  -- 보정 뒤 남은 대상 0(멱등의 근거)
  SELECT count(*) INTO left_r2 FROM app.user_account u JOIN _r2 USING (user_id) WHERE cardinality(u.scope_countries) > 0;
  SELECT count(*) INTO left_c FROM app.user_account u JOIN _canon c USING (user_id) WHERE u.scope_countries IS DISTINCT FROM c.after;
  IF left_r2 + left_c <> 0 THEN RAISE EXCEPTION '보정 뒤 남은 대상 B % A %', left_r2, left_c; END IF;
  RAISE NOTICE 'FIX_OK r2=% canon=% audit=%→% accounts=%', n_r2, n_c, pre.pal, pal, ua;
END $a$;
SELECT 'result', (SELECT n FROM _r2_res) AS r2_updated, (SELECT n FROM _canon_res) AS canon_updated;

\if :{?commit}
COMMIT;
SELECT 'mode', 'COMMIT';
\else
ROLLBACK;
SELECT 'mode', 'ROLLBACK(드라이런)';
\endif
