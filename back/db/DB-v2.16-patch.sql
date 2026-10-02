-- ============================================================================
-- hmg-geo 재설계 DB-v2.16 보완 패치 (PostgreSQL 17, 2026-10-01) · 현행 값 재현 WU-7(WEBREG16 웹 보고서 유닛 게이트)
-- 적용 순서: DB-v2.15 뒤 1회(트랜잭션 1개). 합본 DB-v2.16.sql = DB-v2.15.sql + 이 파일(이어 붙이기). 엔티티 관리 패치는 DB-v2.17 로 밀렸다
--   (메인 결정 2026-10-01): 이 패치는 엔티티 관리 객체를 읽지도 쓰지도 않는다.
-- 근거: 제품 결정 19·25(현행 값 완전 재현), 계획서 notes/hgh-impl/revert-to-current-plan-20261001.md 5.7 WEBREG16.
--
-- 현행 규칙(hmg-geo 2670a16): 웹사이트 집계층(사실표) 모수 = 보고서 유닛 소속 답변만.
--   생성기 scripts/summary/surface-website.ts:145-225 loadUnits: 보고서 명세(scripts/reports/report-spec.json 109행 = brand·cc·langCode·
--     urlLike·urlNotLike)를 website_sites(brand, country_code)·website_prompts(lang_code, summary_report_norm(target_url))에 맞춰
--     그 프롬프트의 website_prompts.file_seq 를 summary_answers.report_fs 로 굳힌다(사이트 프로젝트 = 생성 프로젝트, :398-406).
--   조회 summary-website-aggregates.ts:226-240 unitWhere·summary-trend-aggregates.ts:718-727: report_fs IS NOT NULL ∧
--     report_fs <> ALL(summary_settings.website_excluded_fs)(운영 값 [71,94,97], 2026-09-05). 카드 ①~⑤·⑥ 정확도·추이·GEO·Sub-KPI 에 걸린다.
--   URL 인용률(타겟·자사 프롬프트 단위)은 이 게이트가 없다(:1244-1271 sharedWhere 만), 미러(답변 분석 화면 cumulative) 경로도 없다.
--   hub web_reg(app.website_prompt 존재)와 다른 집합이다: stg hmg_r2 실측(2026-10-01) 웹 프롬프트 13,188 중 web_reg ∧ 유닛 소속 9,869
--   (그중 제외 fs 232), web_reg ∧ 유닛 밖 2,816, web_reg 아님 503. 답변 기준 유닛 밖 23,390·제외 fs 4,136 / 240,173.
--
-- P91 app.website_report_unit: 보고서 명세 행(테넌트 데이터, back/migration/fill-v216.sql 이 채운다). 코어는 행 내용을 모른다.
-- P92 app.website_report_excluded: 보고서 제외 유닛 file_seq(현행 summary_settings.website_excluded_fs, 조회 때 읽는다).
-- P93 rd.web_report_prompt: 웹 프롬프트 → 보고서 유닛 file_seq(현행 report_fs 판정의 투영). 사이트 프로젝트 = 프롬프트 프로젝트(현행 runit 은
--     생성 프로젝트의 사이트만)이고, 사이트 프로젝트가 비면 프롬프트 프로젝트로 본다: app.website_site.scope_project_id 가 UNIQUE 라 한 Scope
--     프로젝트를 나눠 쓰는 사이트(Genesis SA-Jeddah·SA-Riyadh = SA-Dammam 프로젝트, 현행 surface-website.ts:242)가 이관에서 NULL 이 됐다. 쓰기 = rd.refresh_web_report_prompt 만
--     (적재기 ingest.project.apply: 새 웹 프롬프트·website_catalog 재판정, fill-v216.sql). rd.dim_prompt 를 FK 로 묶지 않는다(bulk 시드의
--     rd.dim_prompt TRUNCATE 를 막지 않게): 시드·재투영 뒤에는 refresh(NULL) 를 다시 돈다.
-- 함수(호출자 권한, 소유자 hmg_owner)
--   rd.report_url_norm(text)                 현행 summary_report_norm = citation_url_norm 과 같은 식(적재 pg_temp.cit_norm 과 같다). api_ro 도 실행
--   rd.web_report_prompt_expected(int4[])    프롬프트 키 집합(NULL = 전 웹 프롬프트)의 기대 멤버십(읽기 전용)
--   rd.refresh_web_report_prompt(int4[])     기대값으로 맞춘다(바뀐 행만 INSERT·UPDATE·DELETE, 키 NULL = 전체). 반환 = 바뀐 행 수. loader·migrator
--   rd.assert_web_report_prompt()            표 = 기대값(전체) 단언, 위반 시 예외. 반환 = 행 수. loader·migrator
-- 결과 캐시: 세 표를 추적 표(rcache.tg_bump)에 올린다(조회가 바로 읽는 표). 바뀐 행이 없는 refresh 는 버전을 올리지 않는다.
-- 락: 새 표 생성뿐(기존 표 ALTER 없음). lock_timeout 30s.
-- 적용 절차(stg·prod): ① 이 패치(migrator 또는 superuser) ② psql -f back/migration/fill-v216.sql(드라이런) → -v commit=1
--   ③ 켜기 전 확인: SELECT rd.assert_web_report_prompt(). 스위치 web_registered_only 를 켜지 않으면 응답은 그대로다(읽는 코드가 스위치 뒤).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.dim_prompt'::regclass AND attname = 'cat_mask_all' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.15 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.web_report_prompt') IS NOT NULL OR to_regclass('app.website_report_unit') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.16 이미 적용됨(app.website_report_unit·rd.web_report_prompt 존재)';
  END IF;
END $v$;

-- ── P91·P92·P93 ─────────────────────────────────────────────────────────────
CREATE TABLE app.website_report_unit (
  ix int2 PRIMARY KEY CHECK (ix >= 0),                   -- 명세 행 순번(report-spec.json 배열 위치, 0부터)
  brand_code text NOT NULL,                              -- website_sites.brand 와 정확 일치(현행 ws.brand = s.brand)
  country_code text NOT NULL,                            -- website_sites.country_code 와 정확 일치(가상·유사 코드 원표기)
  lang_code text,                                        -- NULL = 언어 무관
  url_like text,                                         -- rd.report_url_norm(target_url) LIKE, NULL = 조건 없음
  url_not_like text,                                     -- rd.report_url_norm(target_url) NOT LIKE, NULL = 조건 없음
  spec_fs int NOT NULL CHECK (spec_fs > 0));             -- 명세 fs(참고용: 판정 값 report_fs 는 website_prompt.file_seq 다, surface-website.ts:135-140)
COMMENT ON TABLE app.website_report_unit IS
  '현행 웹사이트 보고서 유닛 명세(scripts/reports/report-spec.json 행, 테넌트 데이터). rd.web_report_prompt 판정 입력(WEBREG16, WU-7). DB-v2.16 P91';
CREATE TABLE app.website_report_excluded (
  file_seq int PRIMARY KEY CHECK (file_seq > 0),
  note text);
COMMENT ON TABLE app.website_report_excluded IS
  '보고서 제외 유닛 file_seq(현행 summary_settings.website_excluded_fs). 조회 때 rd.web_report_prompt.report_fs 와 비교(WEBREG16). DB-v2.16 P92';
CREATE TABLE rd.web_report_prompt (
  prompt_key int4 PRIMARY KEY,                           -- rd.dim_prompt.prompt_key(웹사이트 표면), FK 없음(헤더 참고)
  report_fs int NOT NULL CHECK (report_fs > 0));         -- 소속 보고서 유닛의 website_prompt.file_seq(여러 유닛이면 최소)
COMMENT ON TABLE rd.web_report_prompt IS
  '웹 프롬프트의 보고서 유닛 소속(현행 summary_answers.report_fs 판정 투영). 없는 프롬프트 = 유닛 밖. 쓰기 = rd.refresh_web_report_prompt. DB-v2.16 P93';

-- ── 함수 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION rd.report_url_norm(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $f$
SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
         lower(regexp_replace($1, '^\s+|\s+$', '', 'g')), '^https?://', ''), '^www\.', ''), '#.*$', ''),
         '&(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*', '', 'g'),
         '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*&', '?'),
         '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*$', ''), '/+$', '')
$f$;
COMMENT ON FUNCTION rd.report_url_norm(text) IS
  '현행 summary_report_norm(0060) = citation_url_norm 과 같은 정규화(적재 pg_temp.cit_norm seed-3x-common.sql:9-11 과 같은 식). DB-v2.16';

CREATE FUNCTION rd.web_report_prompt_expected(p_keys int4[]) RETURNS TABLE (prompt_key int4, report_fs int)
  LANGUAGE sql STABLE AS $f$
SELECT d.prompt_key, min(wp.file_seq)::int
  FROM rd.dim_prompt d
  JOIN rd.dim_project dp ON dp.project_key = d.project_key
  JOIN app.website_prompt wp ON wp.scope_prompt_id = d.prompt_id
  JOIN app.website_site ws ON ws.site_id = wp.site_id AND (ws.scope_project_id = dp.scope_project_id OR ws.scope_project_id IS NULL)
  JOIN app.website_report_unit u ON u.brand_code = ws.brand_code AND u.country_code = ws.country_code
       AND (u.lang_code IS NULL OR wp.lang_code = u.lang_code)
       AND (u.url_like IS NULL OR rd.report_url_norm(wp.target_url) LIKE u.url_like)
       AND (u.url_not_like IS NULL OR rd.report_url_norm(wp.target_url) NOT LIKE u.url_not_like)
 WHERE d.surface = 2 AND (p_keys IS NULL OR d.prompt_key = ANY (p_keys))
 GROUP BY d.prompt_key
$f$;
COMMENT ON FUNCTION rd.web_report_prompt_expected(int4[]) IS
  '웹 프롬프트 키 집합(NULL = 전체)의 보고서 유닛 소속 기대값: 사이트(브랜드·국가 정확 일치, 사이트 프로젝트 = 프롬프트 프로젝트, 사이트 프로젝트가 비면 '
  '프롬프트 프로젝트로 본다: 한 Scope 프로젝트를 나눠 쓰는 사이트가 UNIQUE 로 NULL 이 된 경우)·언어·타겟 URL 조건. DB-v2.16';

CREATE FUNCTION rd.refresh_web_report_prompt(p_keys int4[]) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n_up int; n_del int;
BEGIN
  WITH e AS (SELECT * FROM rd.web_report_prompt_expected(p_keys)),
  up AS (INSERT INTO rd.web_report_prompt AS w (prompt_key, report_fs) SELECT e.prompt_key, e.report_fs FROM e
         ON CONFLICT (prompt_key) DO UPDATE SET report_fs = EXCLUDED.report_fs WHERE w.report_fs IS DISTINCT FROM EXCLUDED.report_fs
         RETURNING 1)
  SELECT count(*) INTO n_up FROM up;
  DELETE FROM rd.web_report_prompt w
   WHERE (p_keys IS NULL OR w.prompt_key = ANY (p_keys))
     AND NOT EXISTS (SELECT 1 FROM rd.web_report_prompt_expected(p_keys) e WHERE e.prompt_key = w.prompt_key);
  GET DIAGNOSTICS n_del = ROW_COUNT;
  RETURN n_up + n_del;
END $f$;
COMMENT ON FUNCTION rd.refresh_web_report_prompt(int4[]) IS
  'rd.web_report_prompt 를 기대값으로 맞춘다(바뀐 행만, 키 NULL = 전체). 반환 = 바뀐 행 수. DB-v2.16';

CREATE FUNCTION rd.assert_web_report_prompt() RETURNS int LANGUAGE plpgsql AS $f$
DECLARE bad int; n int;
BEGIN
  SELECT count(*) INTO bad FROM (
    (SELECT prompt_key, report_fs FROM rd.web_report_prompt EXCEPT SELECT prompt_key, report_fs FROM rd.web_report_prompt_expected(NULL))
    UNION ALL
    (SELECT prompt_key, report_fs FROM rd.web_report_prompt_expected(NULL) EXCEPT SELECT prompt_key, report_fs FROM rd.web_report_prompt)) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'rd.web_report_prompt ≠ 기대값: % 행(refresh_web_report_prompt(NULL) 필요)', bad;
  END IF;
  SELECT count(*) INTO n FROM rd.web_report_prompt;
  RETURN n;
END $f$;
COMMENT ON FUNCTION rd.assert_web_report_prompt() IS 'rd.web_report_prompt = 기대값(전체) 단언. 반환 = 행 수. DB-v2.16';

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER TABLE app.website_report_unit OWNER TO hmg_owner;
ALTER TABLE app.website_report_excluded OWNER TO hmg_owner;
ALTER TABLE rd.web_report_prompt OWNER TO hmg_owner;
ALTER FUNCTION rd.report_url_norm(text) OWNER TO hmg_owner;
ALTER FUNCTION rd.web_report_prompt_expected(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.refresh_web_report_prompt(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_web_report_prompt() OWNER TO hmg_owner;
GRANT SELECT ON app.website_report_unit, app.website_report_excluded, rd.web_report_prompt TO api_ro, admin_long, loader, migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.website_report_unit, app.website_report_excluded TO migrator;   -- 테넌트 데이터 채우기(fill-v216.sql)
GRANT SELECT, INSERT, UPDATE, DELETE ON rd.web_report_prompt TO loader, migrator;
REVOKE EXECUTE ON FUNCTION rd.report_url_norm(text), rd.web_report_prompt_expected(int4[]), rd.refresh_web_report_prompt(int4[]),
  rd.assert_web_report_prompt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.report_url_norm(text) TO api_ro, admin_long, loader, migrator;
GRANT EXECUTE ON FUNCTION rd.web_report_prompt_expected(int4[]), rd.refresh_web_report_prompt(int4[]), rd.assert_web_report_prompt()
  TO loader, migrator;

-- ── 결과 캐시 추적(DB-v2.11 P67 규약, 표마다 문장 트리거 4개) ─────────────────────
DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app.website_report_unit', 'app.website_report_excluded', 'rd.web_report_prompt'] LOOP
    INSERT INTO rcache.data_version (tbl, version) VALUES (t, 0);
    EXECUTE format('CREATE TRIGGER rcache_bump_ins AFTER INSERT ON %s REFERENCING NEW TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_upd AFTER UPDATE ON %s REFERENCING NEW TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_del AFTER DELETE ON %s REFERENCING OLD TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_trunc AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
  END LOOP;
END $v$;

-- ── 사후 단언(구조) ─────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('app.website_report_unit'::regclass, 'app.website_report_excluded'::regclass,
               'rd.web_report_prompt'::regclass) AND pg_get_userbyid(relowner) <> 'hmg_owner')
     OR NOT has_table_privilege('api_ro', 'rd.web_report_prompt', 'select')
     OR NOT has_table_privilege('api_ro', 'app.website_report_excluded', 'select')
     OR has_table_privilege('api_ro', 'rd.web_report_prompt', 'insert')
     OR NOT has_table_privilege('loader', 'rd.web_report_prompt', 'insert')
     OR NOT has_function_privilege('loader', 'rd.refresh_web_report_prompt(int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.refresh_web_report_prompt(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P91~P93 실패: 소유자·권한';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('app.website_report_unit'::regclass, 'app.website_report_excluded'::regclass,
        'rd.web_report_prompt'::regclass) AND tgname LIKE 'rcache_bump_%') <> 12 THEN
    RAISE EXCEPTION 'P91~P93 실패: 결과 캐시 추적 트리거';
  END IF;
  PERFORM rd.refresh_web_report_prompt(ARRAY[]::int4[]);
  PERFORM rd.assert_web_report_prompt();       -- 명세 행이 아직 없으므로 기대값 0 = 표 0
END $v$;

COMMIT;
