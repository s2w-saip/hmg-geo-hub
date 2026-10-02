-- ============================================================================
-- hmg-geo 재설계 DB-v2.7 보완 패치 (PostgreSQL 17, 2026-09-28) · core 6라운드 독립 검증 수정(m-2·m-4·m-5·정보 1)
-- 적용 순서: DB-v2.6.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.7.sql = DB-v2.6.sql + 이 파일.
--
-- P53 app.tg_last_admin_guard 직렬화(검증 m-2): v2.6 P50 은 판정만 해서 REPEATABLE READ 트랜잭션 둘이 admin 2명을 각각 정지시키면
--     서로의 변경을 못 본 채 둘 다 커밋됐다(실효 admin 0). 판정 전에 남은 실효 admin 행을 FOR SHARE 로 잠근다: 다른 트랜잭션이 같은 행을
--     바꾸는 중이면 기다리고(교착이면 한쪽 40P01), 이미 커밋된 변경이 스냅샷 뒤라면 RR·SERIALIZABLE 은 40001, READ COMMITTED 는 새
--     스냅샷에서 다시 세어 23514. 행 잠금은 UPDATE 권한이 필요해 SECURITY DEFINER(소유자 = app.user_account 소유자)로 둔다.
-- P54 app.project_tracked_keyword.country_code 표기(검증 m-4): app.project.country_code 와 같은 ISO 대문자로 저장한다(쓰기 시점 정규화는
--     기능 intent.keywords.tracked). 기존 행 upper(btrim) 정규화 → 프로젝트 국가와 같으면 NULL → 중복 0 단언 → CHECK ptk_country_upper.
-- P55 app.term_norm(text)(검증 m-5): 추적 키워드 생성 열의 식을 함수 하나로 두고 생성 열도 그 함수를 쓴다(ALTER … SET EXPRESSION, PG17).
--     유일성·중복 판정·rd.dim_keyword.term_norm 쓰기·조회는 이 DB 함수가 정본이다(파이썬 core.kw.term_norm 은 표시·미리보기용).
--     식 = lower(btrim(normalize(t, NFC), 공백류 29자)). 파이썬 str.lower 와 다른 문자(İ → 'i̇' 대 'i', 어말 시그마 Σ → 'ς' 대 'σ')는
--     DB 쪽이 정본이라 차이가 판정에 영향을 주지 않는다(표시값만 다를 수 있다).
-- P56 rd.analyze_facts 반환 = (analyzed, skipped)(정보): 권한 없어 PostgreSQL 이 WARNING 과 함께 건너뛴 관계를 따로 센다(파티션 트리의
--     표 단위, MAINTAIN 권한 = 함수 소유자 기준). 반환 형이 바뀌어 DROP 후 다시 만든다(호출자 ingest.common.db.analyze).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '10min';

DO $v$ BEGIN
  IF to_regprocedure('rd.analyze_facts(regclass[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.6 이 먼저 적용돼야 한다';
  END IF;
  IF to_regprocedure('app.term_norm(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.7 이미 적용됨(app.term_norm 존재)';
  END IF;
END $v$;

-- ── P53 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tg_last_admin_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE n int;
BEGIN
  -- 남은 실효 admin 행을 FOR SHARE 로 잠그며 센다(동시에 다른 admin 을 바꾸는 트랜잭션과 직렬화: 대기·40P01·40001, RC 는 재평가 뒤 0 → 23514)
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
DO $v$ BEGIN
  EXECUTE format('ALTER FUNCTION app.tg_last_admin_guard() OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app.user_account'::regclass));
END $v$;
REVOKE EXECUTE ON FUNCTION app.tg_last_admin_guard() FROM PUBLIC;

-- ── P54 ─────────────────────────────────────────────────────────────────────
-- 중복 사전 단언을 정규화 UPDATE 보다 먼저 한다(정규화 식으로 센다). 뒤에 두면 UPDATE 가 유니크 인덱스(project_tracked_keyword_norm_uq)에
-- 먼저 걸려 설계 메시지 대신 날것의 23505 로 멈춘다(검증 N-2).
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM (
    SELECT 1 FROM app.project_tracked_keyword k JOIN app.project p ON p.project_id = k.project_id
     GROUP BY k.project_id, k.term_norm,
              coalesce(CASE WHEN nullif(upper(btrim(k.country_code)), '') = upper(btrim(p.country_code)) THEN NULL
                            ELSE nullif(upper(btrim(k.country_code)), '') END, '')
    HAVING count(*) > 1) d;
  IF v <> 0 THEN RAISE EXCEPTION '추적 키워드 중복 %건(국가 표기 정규화 뒤 같은 term_norm·유효 국가): 정리 후 다시 적용', v; END IF;
END $v$;
UPDATE app.project_tracked_keyword SET country_code = upper(btrim(country_code))
 WHERE country_code IS NOT NULL AND country_code IS DISTINCT FROM upper(btrim(country_code));
UPDATE app.project_tracked_keyword SET country_code = NULL WHERE country_code = '';
UPDATE app.project_tracked_keyword k SET country_code = NULL
  FROM app.project p
 WHERE p.project_id = k.project_id AND k.country_code IS NOT NULL AND k.country_code = upper(btrim(p.country_code));
ALTER TABLE app.project_tracked_keyword ADD CONSTRAINT ptk_country_upper
  CHECK (country_code IS NULL OR (country_code = upper(country_code) AND country_code = btrim(country_code) AND country_code <> ''));

-- ── P55 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.term_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN lower(btrim(normalize(t, NFC),
             E'\u0009\u000A\u000B\u000C\u000D\u001C\u001D\u001E\u001F \u0085                 　'));
COMMENT ON FUNCTION app.term_norm(text) IS '키워드 정규화 정본(NFC → 공백류 trim → lower). 추적 키워드 생성 열·rd.dim_keyword·중복 판정(DB-v2.7 P55)';
REVOKE EXECUTE ON FUNCTION app.term_norm(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.term_norm(text) TO api_ro, api_rw, admin_long, qa_gate, loader, loader_ro, migrator;
CREATE TEMP TABLE _p55_before ON COMMIT DROP AS SELECT keyword_id, term_norm FROM app.project_tracked_keyword;
ALTER TABLE app.project_tracked_keyword ALTER COLUMN term_norm SET EXPRESSION AS (app.term_norm(term));
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM _p55_before b JOIN app.project_tracked_keyword k USING (keyword_id) WHERE k.term_norm IS DISTINCT FROM b.term_norm;
  IF v <> 0 THEN RAISE EXCEPTION '생성 열 식 교체로 term_norm 이 바뀐 행 %', v; END IF;
  SELECT count(*) INTO v FROM rd.dim_keyword WHERE term_norm IS DISTINCT FROM app.term_norm(term);
  IF v <> 0 THEN RAISE NOTICE 'P55 rd.dim_keyword 에 DB 정규화와 다른 term_norm %행(적재기 파이썬 정규화 시절 값, 재수집 때 맞춰진다)', v; END IF;
END $v$;

-- ── P56 ─────────────────────────────────────────────────────────────────────
DROP FUNCTION rd.analyze_facts(regclass[]);
CREATE FUNCTION rd.analyze_facts(p_rels regclass[], OUT analyzed int, OUT skipped int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
-- 적재기(loader)의 ANALYZE 대행. 허용 = rd·ing 스키마의 일반·파티션 표(부모면 파티션 트리 전체). analyzed = ANALYZE 대상 표 수,
-- skipped = 함수 소유자에게 MAINTAIN 권한이 없어 PostgreSQL 이 WARNING 과 함께 건너뛰는 표 수(파티션 트리 기준).
DECLARE r regclass; ok int; bad int;
BEGIN
  analyzed := 0;
  skipped := 0;
  FOREACH r IN ARRAY coalesce(p_rels, '{}'::regclass[]) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = r AND c.relkind IN ('r', 'p')
                     AND c.relnamespace IN ('rd'::regnamespace, 'ing'::regnamespace)) THEN
      RAISE EXCEPTION 'rd.analyze_facts 허용 목록 밖: %', r USING ERRCODE = '42501';
    END IF;
    SELECT count(*) FILTER (WHERE has_table_privilege(t.relid, 'MAINTAIN')), count(*) FILTER (WHERE NOT has_table_privilege(t.relid, 'MAINTAIN'))
      INTO ok, bad
      FROM pg_partition_tree(r) t JOIN pg_class c ON c.oid = t.relid WHERE c.relkind IN ('r', 'p');
    EXECUTE format('ANALYZE %s', r);
    analyzed := analyzed + ok;
    skipped := skipped + bad;
  END LOOP;
END $f$;
DO $v$ BEGIN
  EXECUTE format('ALTER FUNCTION rd.analyze_facts(regclass[]) OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'rd.answer'::regclass));
END $v$;
REVOKE ALL ON FUNCTION rd.analyze_facts(regclass[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.analyze_facts(regclass[]) TO loader;

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF NOT (SELECT prosecdef AND position('FOR SHARE' in prosrc) > 0 FROM pg_proc WHERE oid = 'app.tg_last_admin_guard()'::regprocedure)
    THEN RAISE EXCEPTION 'P53 실패'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ptk_country_upper') THEN RAISE EXCEPTION 'P54 실패'; END IF;
  IF position('term_norm' in (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid
                                 AND a.attnum = d.adnum WHERE d.adrelid = 'app.project_tracked_keyword'::regclass AND a.attname = 'term_norm')) = 0
    THEN RAISE EXCEPTION 'P55 실패'; END IF;
  IF NOT has_function_privilege('loader', 'rd.analyze_facts(regclass[])', 'execute')
     OR NOT has_function_privilege('api_ro', 'app.term_norm(text)', 'execute')
     OR NOT has_function_privilege('loader', 'app.term_norm(text)', 'execute') THEN RAISE EXCEPTION 'P55·P56 권한 실패'; END IF;
END $v$;

COMMIT;
