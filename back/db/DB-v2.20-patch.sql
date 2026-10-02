-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.20 (PostgreSQL 17, 2026-10-01) · 현행 값 재현 WU-12(⑥ 인용 정확도 미러 정의 지연)
-- 번호: be/int2 통합(2026-10-01)에서 배정(가번호 DB-vNEXT-wu12 PW1~PW3 → DB-v2.20 P111~P113). 적용 순서: DB-v2.19 뒤 1회(트랜잭션 1개).
--   합본 DB-v2.20.sql = DB-v2.19.sql + 이 파일. 이 패치는 v2.17~v2.19 객체를 읽거나 쓰지 않는다(순서만 뒤).
-- 근거: 제품 결정 19·25·31, 메인 지시(2026-10-01) "(B) 안 비교: rd.dim_url(url_norm) 색인 대 타겟 URL 사전 해석 표".
--
-- 무엇을 위한가: 현행 ⑥ 미러 정의(기간 카드·비카드, hmg-geo 2670a16 scope-aggregates.ts:8831-8849 websiteTargetSetSelect·8970-9010)는
--   "답변 인용 중 하나라도 화면 사이트 전체 타겟 URL(tracked 정규형)과 같다"를 센다. 허브 조회(core.measure.accuracy_counts_sql screen)는
--   인용 → rd.dim_url PK 조회 → url_norm ∈ 타겟을 인용 행마다 했다(stg C11 1년 +0.98초). 타겟 정규형 → url_key 를 미리 풀어 두면
--   인용의 url_key 만 본다(인용 표 url_key 색인).
-- 비교(stg hmg_r2 읽기 전용, 2026-10-01, 값 동일 확인, 3회 중앙값): ⑥ 추가 문장
--   경우                     쿼리 시점 해석(현 구현)   사전 해석 표(이 패치)   url_norm 색인안
--   C11 1년 기간(무필터)       979 ms                    ~800 ms(모사 762~815)   표 + 해석 ~150 ms
--   30일 기간                  566 ms                    ~280 ms(모사 277~283)   표 + 해석 ~150 ms
--   비카드 스냅샷(09-25)       276 ms                    ~240 ms(모사 232~244)   표 + 해석 ~150 ms
--   색인안: stg 는 읽기 전용·hypopg 미설치라 직접 EXPLAIN 불가. 하류(인용 url_key 조회)는 이 표와 같고 해석 단계만 다르다. 로컬 합성
--   규모(176만 행, 정규형 1.1만 → url_key 11.7만) 측정: 플래너는 색인이 있어도 순차 해시 세미조인을 고르고(~125 ms), 색인을 강제해도
--   150~180 ms. stg 순차 해석 152 ms 와 같은 수준이라 색인은 이득이 없다. 색인 크기 138 MB(합성)·dim_url 적재 쓰기 비용도 더한다.
--   → 사전 해석 표를 택한다.
--
-- P111 rd.web_target_url(project_key, lang_key, url_key): 웹사이트 프롬프트(rd.dim_prompt surface 2)의 타겟 정규형(targets)과 url_norm 이 같은
--     rd.dim_url 행. (프로젝트, 언어) 단위라 화면 축(사이트 프로젝트 집합·언어 필터)으로 바로 좁힌다(현행 websiteTargetSetSelect 의 좁히기).
--     FK 없음(bulk 시드의 rd.dim_prompt·rd.dim_url TRUNCATE 를 막지 않게): 시드·재투영 뒤에는 refresh(NULL, NULL) 를 다시 돈다.
-- P112 rd.web_target_url_expected(p_url_keys, p_groups) / rd.refresh_web_target_url(p_url_keys, p_groups) / rd.assert_web_target_url():
--     기대값(위 정의) · 맞추기(바뀐 행만, 범위 = url_key 집합 또는 (프로젝트, 언어) 집합, 둘 다 NULL = 전체) · 전체 단언.
--     적재기: DIM_URL 뒤 이 적재 URL 의 url_key 범위, DIM_PROMPT 뒤 새 웹 프롬프트의 (프로젝트, 언어) 범위, website_catalog 재판정 = 전체.
-- P113 결과 캐시 추적(DB-v2.11 P67 규약: 문장 트리거 4개). 조회가 바로 읽는 파생 차원이다.
-- 규모(stg 2026-10-01): 116,677 행(정규형 11,014 → url_key 116,677), 전체 맞추기 약 0.8초.
-- 락: 새 표·함수 생성뿐(기존 표 ALTER 없음). lock_timeout 30s.
-- 적용 절차(stg·prod): ① 이 패치(migrator 또는 superuser) ② psql -f back/migration/fill-v220.sql(드라이런) → -v commit=1
--   ③ 켜기 전 SELECT rd.assert_web_target_url(). 스위치 web_accuracy_flat 를 켜지 않으면 응답은 그대로다(읽는 코드가 스위치 뒤).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('rd.web_report_prompt') IS NULL OR to_regclass('rd.rep_cit_delta') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.16(rd.web_report_prompt)·DB-v2.19(rd.rep_cit_delta) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.web_target_url') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.20 이미 적용됨(rd.web_target_url 존재)';
  END IF;
END $v$;

-- ── P111 ─────────────────────────────────────────────────────────────────────
CREATE TABLE rd.web_target_url (
  project_key int2 NOT NULL,                             -- rd.dim_prompt.project_key(웹사이트 사이트 프로젝트)
  lang_key int2 NOT NULL,                                -- rd.dim_prompt.lang_key(언어 축 좁히기, 현행 wp.lang_code)
  url_key int4 NOT NULL,                                 -- rd.dim_url.url_key(url_norm = 타겟 정규형)
  PRIMARY KEY (project_key, lang_key, url_key));
COMMENT ON TABLE rd.web_target_url IS
  '웹사이트 타겟 URL 사전 해석: 웹 프롬프트 타겟 정규형과 url_norm 이 같은 dim_url 행(프로젝트·언어 단위). ⑥ 미러 정의 조회 전용(WU-12). DB-v2.20 P111';

-- ── P112 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION rd.web_target_url_expected(p_url_keys int4[], p_groups int4[])
  RETURNS TABLE (project_key int2, lang_key int2, url_key int4) LANGUAGE sql STABLE AS $f$
SELECT DISTINCT d.project_key, d.lang_key, u.url_key
  FROM rd.dim_prompt d CROSS JOIN LATERAL unnest(d.targets) t(n)
  JOIN rd.dim_url u ON u.url_norm = t.n
 WHERE d.surface = 2
   AND (p_url_keys IS NULL OR u.url_key = ANY (p_url_keys))
   AND (p_groups IS NULL OR (d.project_key::int4 * 65536 + d.lang_key::int4) = ANY (p_groups))
$f$;
COMMENT ON FUNCTION rd.web_target_url_expected(int4[], int4[]) IS
  'rd.web_target_url 기대값. 범위: url_key 집합, (프로젝트 키 × 65536 + 언어 키) 집합, 둘 다 NULL = 전체. DB-v2.20 P112';

CREATE FUNCTION rd.refresh_web_target_url(p_url_keys int4[], p_groups int4[]) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n_ins int; n_del int;
BEGIN
  IF p_url_keys IS NOT NULL AND cardinality(p_url_keys) = 0 OR p_groups IS NOT NULL AND cardinality(p_groups) = 0 THEN
    RETURN 0;
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS _wtu_exp (project_key int2, lang_key int2, url_key int4) ON COMMIT DROP;
  TRUNCATE _wtu_exp;
  INSERT INTO _wtu_exp SELECT * FROM rd.web_target_url_expected(p_url_keys, p_groups);
  DELETE FROM rd.web_target_url w
   WHERE (p_url_keys IS NULL OR w.url_key = ANY (p_url_keys))
     AND (p_groups IS NULL OR (w.project_key::int4 * 65536 + w.lang_key::int4) = ANY (p_groups))
     AND NOT EXISTS (SELECT 1 FROM _wtu_exp e WHERE e.project_key = w.project_key AND e.lang_key = w.lang_key AND e.url_key = w.url_key);
  GET DIAGNOSTICS n_del = ROW_COUNT;
  INSERT INTO rd.web_target_url (project_key, lang_key, url_key)
  SELECT e.project_key, e.lang_key, e.url_key FROM _wtu_exp e
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n_ins = ROW_COUNT;
  RETURN n_ins + n_del;
END $f$;
COMMENT ON FUNCTION rd.refresh_web_target_url(int4[], int4[]) IS
  'rd.web_target_url 를 기대값으로 맞춘다(범위 안 바뀐 행만). 반환 = 바뀐 행 수. DB-v2.20 P112';

CREATE FUNCTION rd.assert_web_target_url() RETURNS int LANGUAGE plpgsql AS $f$
DECLARE bad int; n int;
BEGIN
  SELECT count(*) INTO bad FROM (
    (SELECT project_key, lang_key, url_key FROM rd.web_target_url EXCEPT SELECT * FROM rd.web_target_url_expected(NULL, NULL))
    UNION ALL
    (SELECT * FROM rd.web_target_url_expected(NULL, NULL) EXCEPT SELECT project_key, lang_key, url_key FROM rd.web_target_url)) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'rd.web_target_url ≠ 기대값: % 행(refresh_web_target_url(NULL, NULL) 필요)', bad;
  END IF;
  SELECT count(*) INTO n FROM rd.web_target_url;
  RETURN n;
END $f$;
COMMENT ON FUNCTION rd.assert_web_target_url() IS 'rd.web_target_url = 기대값(전체) 단언. 반환 = 행 수. DB-v2.20 P112';

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER TABLE rd.web_target_url OWNER TO hmg_owner;
ALTER FUNCTION rd.web_target_url_expected(int4[], int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.refresh_web_target_url(int4[], int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_web_target_url() OWNER TO hmg_owner;
GRANT SELECT ON rd.web_target_url TO api_ro, admin_long, loader, migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON rd.web_target_url TO loader, migrator;
REVOKE EXECUTE ON FUNCTION rd.web_target_url_expected(int4[], int4[]), rd.refresh_web_target_url(int4[], int4[]),
  rd.assert_web_target_url() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.web_target_url_expected(int4[], int4[]), rd.refresh_web_target_url(int4[], int4[]), rd.assert_web_target_url()
  TO loader, migrator;

-- ── P113 결과 캐시 추적 ───────────────────────────────────────────────────────
DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rd.web_target_url'] LOOP
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
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'rd.web_target_url'::regclass)) <> 'hmg_owner'
     OR NOT has_table_privilege('api_ro', 'rd.web_target_url', 'select')
     OR has_table_privilege('api_ro', 'rd.web_target_url', 'insert')
     OR NOT has_function_privilege('loader', 'rd.refresh_web_target_url(int4[], int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.refresh_web_target_url(int4[], int4[])', 'execute') THEN
    RAISE EXCEPTION 'P111~P112 실패: 소유자·권한';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'rd.web_target_url'::regclass AND tgname LIKE 'rcache_bump_%') <> 4 THEN
    RAISE EXCEPTION 'P113 실패: 결과 캐시 추적 트리거';
  END IF;
END $v$;

COMMIT;
