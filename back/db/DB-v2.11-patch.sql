-- ============================================================================
-- hmg-geo 재설계 DB-v2.11 보완 패치 (PostgreSQL 17, 2026-09-30) · 데이터 버전 기반 결과 캐시(core.result_cache, 제품 책임자 승인 2026-09-30)
-- 적용 순서: DB-v2.10.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.11.sql = DB-v2.10.sql + 이 파일. 추가형(기존 표·열·권한 의미 불변).
--
-- P66 rcache 스키마(소유자 hmg_owner, 어떤 풀 롤에도 USAGE 없음) + 세 표.
--     rcache.entry(UNLOGGED): 결과 캐시 행 = 키(sha256 32바이트) PK, 라우트 템플릿, 데이터 버전 문자열, 코덱(identity|zlib), 응답 바이트,
--       원본·저장 크기, 생성 시각. 두 uvicorn 워커·호스트가 공유한다. 장애 복구 시 비워져도 된다(다음 요청이 다시 채운다).
--       색인 (data_version, created_at): 낡은 버전 정리를 범위 삭제로(put 이 표 전체를 훑지 않는다).
--     rcache.stat(UNLOGGED, 한 행): 저장 크기·행 수 누적 카운터(put·정리·무효화가 같은 트랜잭션에서 증감). entry 와 함께 장애 복구 시 비워진다.
--     rcache.data_version(LOGGED): 추적 표(P67)의 버전 카운터(표 이름 PK, 단조 증가) + 수동 무효화 *manual*. 합(sum)이 데이터 버전 요소 tv.
-- P67 rcache.tg_bump + 문장 수준 트리거 AFTER INSERT·UPDATE·DELETE(전이 표로 바뀐 행이 있을 때만) · TRUNCATE(항상). 추적 표 26개:
--     app 11개 = 캐시 대상이 조회 시점에 바로 읽는 표(참조 차원·숨김 시장·인용 오버라이드·카탈로그·커스텀 필드·발행). 세대(generation)는
--       적재 finalize 에서만 올라 관리 편집이 곧바로 결과를 바꾸는 표를 덮지 못한다.
--     rd 15개 = 차원·파생 표(dim_country·dim_region·dim_project·dim_brand_name·dim_engine·dim_entity·dim_lang·dim_prompt·dim_source·
--       dim_taxon·dim_url·catalog_entry·web_unit·report_unit_value·cycle). 세대만으로는 덮이지 않는 쓰기 경로가 있다:
--       ingest/pull/sync/service.py register_projects(rd.dim_project·dim_country, finalize 없음, 매 pull 패스), sync_prompts 첫 트랜잭션
--       (dim_project.regions, finalize 없음), rejudge 의 REGISTRY_ROLE_REFRESH(dim_entity, rd_changed 없음)·_merge_app_countries(dim_country),
--       project() 의 차원 삽입(범위 차원이 생겨도 rd_changed 는 job·답변·대표·표면 기준). 과무효화를 받아들이고 차원 전부를 카운터로 덮는다.
--     세대만으로 덮는 표 = 사실 표 7개(rd.answer·answer_brand·answer_stance·citation·job·acr_cell·acr_choice): 쓰기 위치 전부가
--       apply.project()·_project_acr 안이고 같은 트랜잭션 finalize 가 세대를 올린다(tests/core/test_result_cache_writers.py 가 정적으로 강제).
--     카운터 UPDATE 는 쓰기 트랜잭션 안이라 커밋과 함께 보이고(같은 스냅샷에서 읽는 조회는 데이터와 버전이 어긋나지 않는다), 같은 표의
--     동시 쓰기는 카운터 행 잠금으로 커밋 순서대로 올라간다(IDENTITY 최댓값처럼 늦게 커밋된 작은 번호를 놓치지 않는다).
-- P68 SECURITY DEFINER 함수(소유자 hmg_owner, search_path pg_catalog, PUBLIC 실행 회수):
--     app.result_cache_version()          데이터 버전 문자열 g=<표면:세대:마지막 load:갱신 시각(UTC µs)>…|jc=<max change_id>|tv=<카운터 합>|
--                                         d=<rd.today_kst()>. 세대 번호만으로는 재구축(seed) 뒤 번호가 되풀이될 수 있어 last_load_id·updated_at 을 함께 싣는다
--     app.result_cache_lookup(prefix)     버전을 같은 스냅샷에서 읽고 키 = sha256(prefix || 버전) 행을 찾는다(요청당 왕복 1회). 행이 없어도 버전은 돌려준다
--     app.result_cache_put(…)             저장(같은 키는 그대로 둔다). 저장 크기 상한 4 MiB(넘으면 false). 낡은 버전 정리 = 이 저장과 버전이 다르고
--                                         10분 지난 행을 색인 범위 삭제로. 전체 저장 크기 상한 256 MiB 는 rcache.stat 누적 카운터로 보고 넘을 때만 오래된 행부터 삭제
--     app.result_cache_invalidate()       수동 무효화(카운터 '*manual*' +1, 전 행 삭제, stat 차감). migrator 만. DB 패치 적용·대역 밖 SQL 뒤 필수
--     api_ro 는 lookup·put·version 실행만 받는다(rcache 표 권한·스키마 USAGE 없음: 캐시 행을 직접 읽거나 쓰지 못한다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('rd.dim_country_code_upper_uq') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.10 이 먼저 적용돼야 한다';
  END IF;
  IF to_regnamespace('rcache') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.11 이미 적용됨(rcache 스키마 존재)';
  END IF;
END $v$;

-- ── P66 ─────────────────────────────────────────────────────────────────────
CREATE SCHEMA rcache;
ALTER SCHEMA rcache OWNER TO hmg_owner;
REVOKE ALL ON SCHEMA rcache FROM PUBLIC;
COMMENT ON SCHEMA rcache IS '결과 캐시(core.result_cache). 풀 롤 USAGE 없음: app.result_cache_* SECURITY DEFINER 함수로만 접근(DB-v2.11 P66)';

CREATE UNLOGGED TABLE rcache.entry (
  cache_key    bytea       PRIMARY KEY CHECK (octet_length(cache_key) = 32),
  route        text        NOT NULL,
  data_version text        NOT NULL,
  codec        text        NOT NULL CHECK (codec IN ('identity', 'zlib')),
  body         bytea       NOT NULL,
  body_bytes   int         NOT NULL CHECK (body_bytes >= 0),
  stored_bytes int         NOT NULL CHECK (stored_bytes >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rcache.entry OWNER TO hmg_owner;
REVOKE ALL ON rcache.entry FROM PUBLIC;
COMMENT ON TABLE rcache.entry IS '결과 캐시 행(UNLOGGED). 키 = sha256(요청 서명 접두 || 데이터 버전), 값 = 응답 바이트(core.result_cache, DB-v2.11 P66)';
CREATE INDEX entry_version_created_idx ON rcache.entry (data_version, created_at);

CREATE UNLOGGED TABLE rcache.stat (
  id          smallint PRIMARY KEY CHECK (id = 1),
  total_bytes bigint   NOT NULL CHECK (total_bytes >= 0),
  entries     bigint   NOT NULL CHECK (entries >= 0)
);
ALTER TABLE rcache.stat OWNER TO hmg_owner;
REVOKE ALL ON rcache.stat FROM PUBLIC;
COMMENT ON TABLE rcache.stat IS '결과 캐시 저장 크기·행 수 누적(한 행, UNLOGGED: entry 와 함께 장애 복구 시 비워진다). put·정리·무효화가 같은 트랜잭션에서 증감(DB-v2.11 P66)';

CREATE TABLE rcache.data_version (
  tbl        text        PRIMARY KEY,
  version    bigint      NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rcache.data_version OWNER TO hmg_owner;
REVOKE ALL ON rcache.data_version FROM PUBLIC;
COMMENT ON TABLE rcache.data_version IS '추적 표(조회 시점에 바로 읽히는 app 표 11 + 세대 밖에서도 바뀌는 rd 차원·파생 표 15)의 버전 카운터(rcache.tg_bump 문장 트리거가 올린다) + 수동 무효화 *manual*. '
  '합이 데이터 버전 요소 tv(DB-v2.11 P66·P67)';

-- ── P67 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION rcache.tg_bump() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO rcache.data_version AS d (tbl, version, updated_at) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 1, now())
    ON CONFLICT (tbl) DO UPDATE SET version = d.version + 1, updated_at = now();
  ELSIF EXISTS (SELECT 1 FROM rc_rows) THEN        -- 전이 표(INSERT·UPDATE = 새 행, DELETE = 옛 행). 0행 문장은 올리지 않는다
    INSERT INTO rcache.data_version AS d (tbl, version, updated_at) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 1, now())
    ON CONFLICT (tbl) DO UPDATE SET version = d.version + 1, updated_at = now();
  END IF;
  RETURN NULL;
END $f$;
ALTER FUNCTION rcache.tg_bump() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rcache.tg_bump() FROM PUBLIC;
COMMENT ON FUNCTION rcache.tg_bump() IS '결과 캐시 추적 표 버전 카운터 +1(문장 트리거, 바뀐 행이 있을 때·TRUNCATE). DB-v2.11 P67';

DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app.brand', 'app.citation_category', 'app.citation_domain_override', 'app.hidden_market', 'app.owned_base',
                           'app.prompt', 'app.project_custom_field', 'app.prompt_custom_field_value', 'app.report_publication',
                           'app.rhq_region', 'app.rhq_region_country',
                           'rd.dim_country', 'rd.dim_region', 'rd.dim_project', 'rd.dim_brand_name', 'rd.dim_engine', 'rd.dim_entity',
                           'rd.dim_lang', 'rd.dim_prompt', 'rd.dim_source', 'rd.dim_taxon', 'rd.dim_url', 'rd.catalog_entry', 'rd.web_unit',
                           'rd.report_unit_value', 'rd.cycle'] LOOP
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
INSERT INTO rcache.data_version (tbl, version) VALUES ('*manual*', 0);

-- ── P68 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.result_cache_version() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
SELECT 'g=' || coalesce((SELECT string_agg(g.surface::text || ':' || g.generation::text || ':' || coalesce(g.last_load_id::text, '-')
                                           || ':' || to_char(g.updated_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'), ',' ORDER BY g.surface)
                           FROM rd.surface_generation g), '')
    || '|jc=' || coalesce((SELECT max(c.change_id) FROM app.judgment_change c)::text, '0')
    || '|tv=' || (SELECT coalesce(sum(d.version), 0) FROM rcache.data_version d)::text
    || '|d=' || to_char(rd.today_kst(), 'YYYY-MM-DD')
$f$;

CREATE FUNCTION app.result_cache_lookup(p_prefix bytea) RETURNS TABLE (data_version text, codec text, body bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
SELECT v.dv, e.codec, e.body
  FROM (SELECT app.result_cache_version() AS dv) v
  LEFT JOIN rcache.entry e ON e.cache_key = sha256(p_prefix || convert_to(v.dv, 'UTF8'))
$f$;

CREATE FUNCTION app.result_cache_put(p_key bytea, p_route text, p_version text, p_codec text, p_body bytea, p_body_bytes int)
  RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  entry_max CONSTANT int := 4194304;        -- 저장(압축 후) 크기 상한 4 MiB
  total_max CONSTANT bigint := 268435456;   -- 전체 저장 크기 상한 256 MiB
  v text := left(p_version, 1000);
  added bigint;
  gone_b bigint;
  gone_n bigint;
  total bigint;
BEGIN
  IF p_key IS NULL OR octet_length(p_key) <> 32 THEN
    RAISE EXCEPTION 'result_cache_put: 키는 sha256 32바이트' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_codec IS NULL OR p_codec NOT IN ('identity', 'zlib') OR p_route IS NULL OR p_version IS NULL OR p_body IS NULL
     OR p_body_bytes IS NULL OR p_body_bytes < 0 THEN
    RAISE EXCEPTION 'result_cache_put: 인자 형식' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF octet_length(p_body) > entry_max THEN
    RETURN false;
  END IF;
  -- 저장: 새로 들어간 행만 누적(같은 키 동시 저장은 뒤쪽이 DO NOTHING = 0행)
  WITH ins AS (
    INSERT INTO rcache.entry (cache_key, route, data_version, codec, body, body_bytes, stored_bytes)
    VALUES (p_key, left(p_route, 200), v, p_codec, p_body, p_body_bytes, octet_length(p_body))
    ON CONFLICT (cache_key) DO NOTHING
    RETURNING stored_bytes)
  SELECT sum(stored_bytes) INTO added FROM ins;
  -- 낡은 버전 정리: 이 저장과 버전이 다르고 10분 지난 행(진행 중인 옛 스냅샷 요청이 새 행을 지우지 않게). 색인 두 범위(v 앞·뒤)만 읽는다
  WITH del AS (
    DELETE FROM rcache.entry e
     WHERE (e.data_version < v OR e.data_version > v) AND e.created_at < now() - interval '10 minutes'
    RETURNING e.stored_bytes)
  SELECT sum(stored_bytes), count(*) INTO gone_b, gone_n FROM del;
  INSERT INTO rcache.stat AS st (id, total_bytes, entries)
  VALUES (1, greatest(coalesce(added, 0) - coalesce(gone_b, 0), 0), greatest((added IS NOT NULL)::int - gone_n, 0))
  ON CONFLICT (id) DO UPDATE SET total_bytes = greatest(st.total_bytes + coalesce(added, 0) - coalesce(gone_b, 0), 0),
                                 entries = greatest(st.entries + (added IS NOT NULL)::int - gone_n, 0)
  RETURNING st.total_bytes INTO total;
  -- 전체 상한: 넘을 때만 오래된 행부터(이때만 표 전체를 본다)
  IF total > total_max THEN
    WITH del AS (
      DELETE FROM rcache.entry e
       USING (SELECT r.cache_key
                FROM (SELECT x.cache_key, sum(x.stored_bytes) OVER (ORDER BY x.created_at DESC, x.cache_key) AS run FROM rcache.entry x) r
               WHERE r.run > total_max) d
       WHERE e.cache_key = d.cache_key
      RETURNING e.stored_bytes)
    SELECT sum(stored_bytes), count(*) INTO gone_b, gone_n FROM del;
    UPDATE rcache.stat SET total_bytes = greatest(total_bytes - coalesce(gone_b, 0), 0), entries = greatest(entries - gone_n, 0) WHERE id = 1;
  END IF;
  RETURN true;
END $f$;

CREATE FUNCTION app.result_cache_invalidate() RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE gone_b bigint; gone_n bigint;
BEGIN
  UPDATE rcache.data_version SET version = version + 1, updated_at = now() WHERE tbl = '*manual*';
  WITH del AS (DELETE FROM rcache.entry RETURNING stored_bytes)
  SELECT sum(stored_bytes), count(*) INTO gone_b, gone_n FROM del;
  UPDATE rcache.stat SET total_bytes = greatest(total_bytes - coalesce(gone_b, 0), 0), entries = greatest(entries - gone_n, 0) WHERE id = 1;
  RETURN gone_n;
END $f$;

ALTER FUNCTION app.result_cache_version() OWNER TO hmg_owner;
ALTER FUNCTION app.result_cache_lookup(bytea) OWNER TO hmg_owner;
ALTER FUNCTION app.result_cache_put(bytea, text, text, text, bytea, int) OWNER TO hmg_owner;
ALTER FUNCTION app.result_cache_invalidate() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.result_cache_version(), app.result_cache_lookup(bytea),
  app.result_cache_put(bytea, text, text, text, bytea, int), app.result_cache_invalidate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.result_cache_version(), app.result_cache_lookup(bytea),
  app.result_cache_put(bytea, text, text, text, bytea, int) TO api_ro;
GRANT EXECUTE ON FUNCTION app.result_cache_invalidate() TO migrator;
COMMENT ON FUNCTION app.result_cache_version() IS '결과 캐시 데이터 버전 문자열(세대·judgment_change·app 표 카운터·KST 오늘). DB-v2.11 P68';
COMMENT ON FUNCTION app.result_cache_lookup(bytea) IS '결과 캐시 조회: (버전, 코덱, 바이트). 키 = sha256(접두 || 버전). DB-v2.11 P68';
COMMENT ON FUNCTION app.result_cache_put(bytea, text, text, text, bytea, int) IS
  '결과 캐시 저장(저장 크기 4 MiB 상한·낡은 버전 색인 범위 정리·rcache.stat 누적으로 전체 256 MiB 상한, 넘을 때만 오래된 행부터). DB-v2.11 P68';
COMMENT ON FUNCTION app.result_cache_invalidate() IS '결과 캐시 수동 무효화(*manual* +1, 전 행 삭제, stat 차감). migrator 전용. '
  'DB 패치 적용·적재 경로 밖 SQL(대역 밖 쓰기) 뒤 필수. DB-v2.11 P68';

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgfoid = 'rcache.tg_bump()'::regprocedure;
  IF n <> 104 THEN RAISE EXCEPTION 'P67 실패: 트리거 % 개(기대 104)', n; END IF;
  IF (SELECT count(*) FROM rcache.data_version) <> 27 THEN RAISE EXCEPTION 'P66 실패: 카운터 행'; END IF;
  IF (SELECT relpersistence FROM pg_class WHERE oid = 'rcache.entry'::regclass) <> 'u'
     OR (SELECT relpersistence FROM pg_class WHERE oid = 'rcache.stat'::regclass) <> 'u' THEN RAISE EXCEPTION 'P66 실패: UNLOGGED'; END IF;
  IF to_regclass('rcache.entry_version_created_idx') IS NULL THEN RAISE EXCEPTION 'P66 실패: 색인'; END IF;
  IF has_schema_privilege('api_ro', 'rcache', 'USAGE') OR has_table_privilege('api_ro', 'rcache.entry', 'SELECT')
     OR has_table_privilege('api_ro', 'rcache.entry', 'INSERT') OR has_table_privilege('api_rw', 'rcache.entry', 'INSERT')
     OR has_table_privilege('api_ro', 'rcache.data_version', 'SELECT') OR has_table_privilege('api_ro', 'rcache.stat', 'SELECT') THEN
    RAISE EXCEPTION 'P66 실패: 풀 롤이 rcache 표에 직접 권한을 가진다';
  END IF;
  IF NOT has_function_privilege('api_ro', 'app.result_cache_lookup(bytea)', 'execute')
     OR NOT has_function_privilege('api_ro', 'app.result_cache_put(bytea, text, text, text, bytea, int)', 'execute')
     OR NOT has_function_privilege('api_ro', 'app.result_cache_version()', 'execute')
     OR has_function_privilege('api_rw', 'app.result_cache_put(bytea, text, text, text, bytea, int)', 'execute')
     OR has_function_privilege('api_ro', 'app.result_cache_invalidate()', 'execute') THEN
    RAISE EXCEPTION 'P68 실패: 함수 실행 권한';
  END IF;
  IF NOT has_table_privilege('hmg_owner', 'rd.surface_generation', 'select') OR NOT has_table_privilege('hmg_owner', 'app.judgment_change', 'select')
     OR NOT has_function_privilege('hmg_owner', 'rd.today_kst()', 'execute') THEN
    RAISE EXCEPTION 'P68 실패: 정의자(hmg_owner)가 버전 원천을 읽지 못한다';
  END IF;
  PERFORM app.result_cache_version();
END $v$;

COMMIT;
