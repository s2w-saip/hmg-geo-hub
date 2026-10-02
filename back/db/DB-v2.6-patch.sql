-- ============================================================================
-- hmg-geo 재설계 DB-v2.6 보완 패치 (PostgreSQL 17, 2026-09-28) · core 6라운드(비분석 8그룹 + 적재 워커 core 요청)
-- 적용 순서: DB-v2.5.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.6.sql = DB-v2.5.sql + 이 파일.
-- 근거: back/CORE-REQUESTS/{intent,ad-content,ad-ops,qa,ingest}.md, 메인 지시서 core-round5.md "반영(DB-v2.6)".
--
-- P43 rd.kw_suggestion.observed_at timestamptz NOT NULL(intent R4): related·search 신선도(TTL 7일)를 API 가 rd 만으로 계산한다.
--     기존 행은 ext.dfs_call.requested_at(call_id 등치)으로 채우고 NULL 0 을 단언한다. 적재기는 쓰기 때 관측 시각을 넣는다.
-- P44 app.project_tracked_keyword.term_norm 생성 열 + (project_id, term_norm, coalesce(country_code, '')) 유니크(intent R10).
--     식 = lower(btrim(normalize(term, NFC), 공백류 29자)) = core.kw.term_norm(NFC → str.strip → lower, 공백류 = 파이썬 str.isspace).
--     기존 행: country_code 가 프로젝트 국가와 같으면 NULL 로 정규화(대소문자 무시). 정규화 뒤 중복이 있으면 적용을 멈춘다(자동 삭제 안 함).
-- P45 app.ga4_property (brand_code, country_code) 부분 유니크(brand_code NOT NULL)(ad-ops R7): 같은 시장을 두 속성이 가리키지 못하게.
-- P46 GRANT EXECUTE rd.today_kst() TO admin_long(ad-content R2): 관리 조회가 같은 스냅샷에서 창을 해석한다.
-- P47 qa_gate 참조 SELECT(qa R1): app.brand·app.citation_category·app.citation_domain_override 전체, app.prompt 는 필요한 열만.
-- P48 rd.analyze_facts(regclass[]) SECURITY DEFINER(ingest R4): loader 가 소유자가 아니라 ANALYZE 가 경고와 함께 건너뛰던 것.
--     PG17 GRANT MAINTAIN 은 파티션마다 따로 검사해(부모에만 주면 leaf 전부 'permission denied to analyze' 로 건너뜀, 로컬 실측)
--     새 leaf 마다 부여해야 하므로 기각. 허용 = rd·ing 스키마의 표(부모·leaf). 함수 소유자 = rd.answer 소유자.
-- P49 ing.citation(url) hash 인덱스(ingest R5): URL 차원 재계산·고아 정리의 url = ANY 조회(파티션 부모 선언 = leaf 전부).
-- P50 app.user_account 마지막 실효 admin 보호 제약 트리거(ad-ops R11, 운영 사고 방지): 실효 admin = role admin ∧ active ∧
--     (menu_groups NULL ∨ 'admin' 포함). 그런 행을 UPDATE·DELETE 한 트랜잭션이 커밋될 때(DEFERRABLE INITIALLY DEFERRED) 하나도
--     남지 않으면 23514(ua_last_admin). 앱은 먼저 409 로 막고(accounts.users), 이 트리거는 DB 직접 쓰기·다른 경로의 최후 방어.
-- P51 ing.stage_answer.answer_key NULL 허용(ingest R11): 스테이지에 0 을 넣었다가 키를 채우던 것을 NULL 로(키 누락이 ing.answer
--     INSERT 의 NOT NULL 로 드러난다. 0 은 조용히 통과할 수 있었다).
-- P52 mig.known_diff AD-2(ad-content R7, 메인 결정): 엔티티 수치 정의 변경(계약 §3 모수 게이트 std_in ∧ dflt 추가·표시 브랜드 단위·
--     기간 필수). A4 1회 고지 대상.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '30min';     -- P49 인덱스 생성이 ing.citation 행 수에 비례

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer_stance'::regclass AND attname = 'cyc_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.5 가 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.kw_suggestion'::regclass AND attname = 'observed_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.6 이미 적용됨(rd.kw_suggestion.observed_at 존재)';
  END IF;
END $v$;

-- ── P43 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.kw_suggestion ADD COLUMN observed_at timestamptz;
UPDATE rd.kw_suggestion s SET observed_at = d.requested_at FROM ext.dfs_call d WHERE d.call_id = s.call_id;
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM rd.kw_suggestion WHERE observed_at IS NULL;
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: ext.dfs_call 없는 kw_suggestion 행 %', v; END IF;
END $v$;
ALTER TABLE rd.kw_suggestion ALTER COLUMN observed_at SET NOT NULL;
COMMENT ON COLUMN rd.kw_suggestion.observed_at IS '관측 시각(= ext.dfs_call.requested_at). related·search 신선도(TTL 7일) 판정(DB-v2.6 P43)';

-- ── P44 ─────────────────────────────────────────────────────────────────────
UPDATE app.project_tracked_keyword k SET country_code = NULL
  FROM app.project p
 WHERE p.project_id = k.project_id AND k.country_code IS NOT NULL AND upper(btrim(k.country_code)) = upper(btrim(p.country_code));
ALTER TABLE app.project_tracked_keyword ADD COLUMN term_norm text GENERATED ALWAYS AS (
  lower(btrim(normalize(term, NFC),
              E'\u0009\u000A\u000B\u000C\u000D\u001C\u001D\u001E\u001F \u0085                 　'))
) STORED;
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM (SELECT 1 FROM app.project_tracked_keyword
                                GROUP BY project_id, term_norm, coalesce(country_code, '') HAVING count(*) > 1) d;
  IF v <> 0 THEN RAISE EXCEPTION '추적 키워드 중복 %건(term_norm·유효 국가 기준): 정리 후 다시 적용', v; END IF;
END $v$;
CREATE UNIQUE INDEX project_tracked_keyword_norm_uq ON app.project_tracked_keyword (project_id, term_norm, coalesce(country_code, ''));
COMMENT ON COLUMN app.project_tracked_keyword.term_norm IS 'core.kw.term_norm 과 같은 식(NFC → 공백류 trim → lower). 유니크 판정 키(DB-v2.6 P44)';

-- ── P45 ─────────────────────────────────────────────────────────────────────
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM (SELECT 1 FROM app.ga4_property WHERE brand_code IS NOT NULL
                                GROUP BY brand_code, country_code HAVING count(*) > 1) d;
  IF v <> 0 THEN RAISE EXCEPTION 'GA4 시장 중복 %건: 정리 후 다시 적용', v; END IF;
END $v$;
CREATE UNIQUE INDEX ga4_property_market_uq ON app.ga4_property (brand_code, country_code) WHERE brand_code IS NOT NULL;

-- ── P46 ─────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION rd.today_kst() TO admin_long;

-- ── P47 ─────────────────────────────────────────────────────────────────────
GRANT SELECT ON app.brand, app.citation_category, app.citation_domain_override TO qa_gate;
GRANT SELECT (prompt_id, project_id, scope_prompt_id, deleted_at, created_at, brand_code, brand_presence, list_type,
              depth1, depth2, depth3, depth4, funnel_stage, kind, prompt_type, category) ON app.prompt TO qa_gate;

-- ── P48 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rd.analyze_facts(p_rels regclass[]) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
-- 적재기(loader)의 ANALYZE 대행. 허용 = rd·ing 스키마의 일반·파티션 표(부모면 leaf 전부를 함께 본다). 반환 = ANALYZE 한 관계 수.
DECLARE r regclass; n int := 0;
BEGIN
  FOREACH r IN ARRAY coalesce(p_rels, '{}'::regclass[]) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = r AND c.relkind IN ('r', 'p')
                     AND c.relnamespace IN ('rd'::regnamespace, 'ing'::regnamespace)) THEN
      RAISE EXCEPTION 'rd.analyze_facts 허용 목록 밖: %', r USING ERRCODE = '42501';
    END IF;
    EXECUTE format('ANALYZE %s', r);
    n := n + 1;
  END LOOP;
  RETURN n;
END $f$;
DO $v$ BEGIN
  EXECUTE format('ALTER FUNCTION rd.analyze_facts(regclass[]) OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'rd.answer'::regclass));
END $v$;
REVOKE ALL ON FUNCTION rd.analyze_facts(regclass[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.analyze_facts(regclass[]) TO loader;

-- ── P49 ─────────────────────────────────────────────────────────────────────
CREATE INDEX citation_url_hash_idx ON ing.citation USING hash (url);

-- ── P50 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tg_last_admin_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.user_account u
                  WHERE u.role = 'admin' AND u.status = 'active' AND (u.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (u.menu_groups))) THEN
    RAISE EXCEPTION '마지막 실효 admin 을 없앨 수 없다(역할·상태·메뉴 그룹 변경 또는 삭제)'
      USING ERRCODE = '23514', CONSTRAINT = 'ua_last_admin', TABLE = 'user_account', SCHEMA = 'app';
  END IF;
  RETURN NULL;
END $f$;
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM app.user_account u
   WHERE u.role = 'admin' AND u.status = 'active' AND (u.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (u.menu_groups));
  RAISE NOTICE 'P50 실효 admin %명', v;
END $v$;
CREATE CONSTRAINT TRIGGER ua_last_admin AFTER UPDATE OR DELETE ON app.user_account DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.role = 'admin' AND OLD.status = 'active' AND (OLD.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (OLD.menu_groups)))
  EXECUTE FUNCTION app.tg_last_admin_guard();

-- ── P51 ─────────────────────────────────────────────────────────────────────
ALTER TABLE ing.stage_answer ALTER COLUMN answer_key DROP NOT NULL;

-- ── P52 ─────────────────────────────────────────────────────────────────────
INSERT INTO mig.known_diff (rule_id, feature_id, metric_key_like, compat_variant, description, decided_ref, notice_required)
VALUES ('AD-2', 'admin.entities.registry', 'brand_%', 'input',
        '엔티티 수치 정의 변경: 브랜드 답변·언급 수에 계약 §3 모수 게이트(std_in ∧ dflt)를 걸고, 표시 브랜드 단위로 세며, 기간을 필수로 한다'
        ' (현행 listDiscoveredBrands: 게이트 없음·엔티티 발생 합)',
        '메인 결정 2026-09-28 core 6라운드 ad-content R7 · 모듈-관리자 §4', true)
ON CONFLICT (rule_id, feature_id, metric_key_like) DO NOTHING;

-- ── 적용 확인(행 수·존재 단언) ───────────────────────────────────────────────
DO $v$ BEGIN
  IF NOT has_function_privilege('admin_long', 'rd.today_kst()', 'execute') THEN RAISE EXCEPTION 'P46 실패'; END IF;
  IF NOT has_table_privilege('qa_gate', 'app.brand', 'select') OR NOT has_column_privilege('qa_gate', 'app.prompt', 'depth4', 'select')
    THEN RAISE EXCEPTION 'P47 실패'; END IF;
  IF NOT has_function_privilege('loader', 'rd.analyze_facts(regclass[])', 'execute') THEN RAISE EXCEPTION 'P48 실패'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'ua_last_admin' AND tgrelid = 'app.user_account'::regclass) <> 1 THEN RAISE EXCEPTION 'P50 실패'; END IF;
  IF (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'ing.stage_answer'::regclass AND attname = 'answer_key') THEN RAISE EXCEPTION 'P51 실패'; END IF;
  IF (SELECT count(*) FROM mig.known_diff WHERE rule_id = 'AD-2') <> 1 THEN RAISE EXCEPTION 'P52 실패'; END IF;
END $v$;

COMMIT;
