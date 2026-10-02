-- ============================================================================
-- hmg-geo 재설계 DB-v2.9 보완 패치 (PostgreSQL 17, 2026-09-29) · core 8라운드(계정 가상 지오 스코프·GA4 DDL·BG 값 갭 요청)
-- 적용 순서: DB-v2.8.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.9.sql = DB-v2.8.sql + 이 파일. 추가·교체형(기존 열 의미 불변).
--
-- P59 계정 국가 스코프가 rd.dim_country 의 가상·의사 코드를 허용(보류 계정 9개 재이관): app.tg_user_account_scope 의 국가 참조 집합 =
--     app.rhq_region_country 국가 ∪ rd.dim_country 코드(빈 코드 제외, 백엔드 가상 지오 정본). 값은 정본 표기로 맞춘다(대소문자 무시로
--     일치하는 rhq 국가 → 그 표기, 아니면 dim_country 코드 표기, 중복 제거·순서 유지). 백엔드 비교는 양쪽 upper(core.auth DataScope.of·
--     country_allowed, core.codes.geo_key)라 표기 정규화는 판정을 바꾸지 않는다. 현행 front 는 원문 includes 비교(scope-policy.ts:76-79)이고
--     이 코드들은 website_sites.country_code 리터럴(허브·도시·CPO 사이트 1개, 권역 전개 없음)과만 맞는다: dim_country 코드 표기가 그 리터럴과 같다.
-- P60 app.ga4_property.verified_at(bg-admin R1, BG-43): 마지막 GA4 읽기 권한 확인 성공 시각. 이관 원천(mig_src.ga4_properties.verified_at)이
--     있으면 채운다.
-- P61 app.ga4_market_pending(bg-admin R2 (a), BG-43): 속성 id 없이 브랜드×국가만 등록한 시장. 적재기는 읽지 않는다. 속성 매핑 때 API 가
--     같은 트랜잭션에서 그 시장 행을 지운다. 이관 원천의 property_id 없는 행을 옮긴다.
-- P62 rd.kw_suggestion.total_count(bg-intent BG-39), rd.kw_volume_monthly.competition(BG-40): 적재기가 DataForSEO 응답에서 쓴다.
--     기존 행은 ext.dfs_call 원본 응답에서 채운다(call_id·requested_at 등치).
-- P63 rd.v_answer_body 끝에 run_id·region·prompt_run_id(bg-qa-platform R1, BG-46), 새 뷰 rd.v_acr_cell_run(R2): 소유자 loader_ro, 명시 부여.
-- P64 mig.known_diff 3행: K-1b(bg-kpi-filters R4), BG-07·BG-10(bg-trend-geo R1·R2). A4 1회 고지 대상.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '10min';

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ua_last_admin_del' AND tgrelid = 'app.user_account'::regclass) THEN
    RAISE EXCEPTION 'DB-v2.8 이 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'app.ga4_property'::regclass AND attname = 'verified_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.9 이미 적용됨(app.ga4_property.verified_at 존재)';
  END IF;
END $v$;

-- ── P59 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tg_user_account_scope() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE bad text[]; canon text[];
BEGIN
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_brands) x WHERE NOT EXISTS (SELECT 1 FROM app.brand b WHERE b.brand_code = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_brands 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_regions) x WHERE NOT EXISTS (SELECT 1 FROM app.rhq_region r WHERE r.region_id = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_regions 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- 국가: 정본 표기(rhq 국가 → dim_country 코드 순, 대소문자 무시 일치)로 맞춘 뒤 참조 확인. 맞출 곳이 없으면 원문 그대로 두고 거부한다.
  canon := ARRAY(
    SELECT c.y FROM (
      SELECT DISTINCT ON (s.y) s.y, s.i FROM (
        SELECT coalesce(
                 (SELECT rc.country_code FROM app.rhq_region_country rc WHERE upper(rc.country_code) = upper(u.x)
                   ORDER BY rc.country_code = u.x DESC, rc.country_code LIMIT 1),
                 (SELECT d.code FROM rd.dim_country d WHERE d.code <> '' AND upper(d.code) = upper(u.x)
                   ORDER BY d.code = u.x DESC, d.code LIMIT 1),
                 u.x) AS y, u.i
          FROM unnest(NEW.scope_countries) WITH ORDINALITY u(x, i)) s
      ORDER BY s.y, s.i) c
    ORDER BY c.i);
  bad := ARRAY(SELECT x FROM unnest(canon) x
                WHERE NOT EXISTS (SELECT 1 FROM app.rhq_region_country c WHERE c.country_code = x)
                  AND NOT EXISTS (SELECT 1 FROM rd.dim_country d WHERE d.code = x AND d.code <> ''));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_countries 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF canon IS DISTINCT FROM NEW.scope_countries THEN
    NEW.scope_countries := canon;
  END IF;
  RETURN NEW;
END $f$;
ALTER FUNCTION app.tg_user_account_scope() OWNER TO hmg_owner;

-- ── P60 ─────────────────────────────────────────────────────────────────────
ALTER TABLE app.ga4_property ADD COLUMN verified_at timestamptz;
COMMENT ON COLUMN app.ga4_property.verified_at IS
  '마지막 GA4 읽기 권한 확인 성공 시각(PUT verify=true 성공 때 now(), 실패·미요청은 유지). 현행 ga4_properties.verified_at 계승';
DO $b$ DECLARE n bigint := 0; BEGIN
  IF to_regclass('mig_src.ga4_properties') IS NOT NULL THEN
    UPDATE app.ga4_property p SET verified_at = g.verified_at
      FROM (SELECT DISTINCT ON (property_id) property_id, verified_at FROM mig_src.ga4_properties
             WHERE property_id IS NOT NULL AND property_id <> '' ORDER BY property_id, updated_at DESC) g
     WHERE g.property_id = p.property_id AND p.verified_at IS NULL AND g.verified_at IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RAISE NOTICE 'P60 verified_at 이관 %', n;
END $b$;

-- ── P61 ─────────────────────────────────────────────────────────────────────
CREATE TABLE app.ga4_market_pending (
  brand_code text NOT NULL REFERENCES app.brand, country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  note text CHECK (note IS NULL OR length(note) <= 500), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_code, country_code));
COMMENT ON TABLE app.ga4_market_pending IS
  '속성 id 없이 등록한 GA4 시장(현행 ga4_properties.property_id NULL 행, status unmapped). 적재기 비대상. 속성 매핑 시 API 가 같은 트랜잭션에서 삭제';
ALTER TABLE app.ga4_market_pending OWNER TO hmg_owner;
GRANT SELECT ON app.ga4_market_pending TO api_ro, admin_long, loader, migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.ga4_market_pending TO api_rw;
DO $b$ DECLARE n bigint := 0; BEGIN
  IF to_regclass('mig_src.ga4_properties') IS NOT NULL THEN
    INSERT INTO app.ga4_market_pending (brand_code, country_code, updated_by, updated_at)
    SELECT DISTINCT ON (b.brand_code, upper(btrim(g.country_code))) b.brand_code, upper(btrim(g.country_code)), g.created_by, g.updated_at
      FROM mig_src.ga4_properties g JOIN app.brand b ON b.brand_code = g.brand
     WHERE (g.property_id IS NULL OR g.property_id = '') AND upper(btrim(g.country_code)) ~ '^[A-Z]{2}$'
       AND NOT EXISTS (SELECT 1 FROM app.ga4_property p WHERE p.brand_code = b.brand_code AND p.country_code = upper(btrim(g.country_code)))
     ORDER BY b.brand_code, upper(btrim(g.country_code)), g.updated_at DESC
    ON CONFLICT (brand_code, country_code) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RAISE NOTICE 'P61 대기 시장 이관 %', n;
END $b$;

-- ── P62 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.kw_suggestion ADD COLUMN total_count int CHECK (total_count >= 0);
COMMENT ON COLUMN rd.kw_suggestion.total_count IS
  '그 호출의 DataForSEO keyword_suggestions total_count(호출 단위 같은 값, 행마다 반복). 응답에 없으면 NULL';
ALTER TABLE rd.kw_volume_monthly ADD COLUMN competition text CHECK (competition IN ('LOW', 'MEDIUM', 'HIGH'));
COMMENT ON COLUMN rd.kw_volume_monthly.competition IS
  'DataForSEO google_ads search_volume 행의 competition 라벨(키워드 단위 값, 월 행마다 반복). 세 값 밖이면 NULL';
DO $b$ DECLARE n1 bigint; n2 bigint; BEGIN
  UPDATE rd.kw_suggestion s SET total_count = (d.response #>> '{tasks,0,result,0,total_count}')::int
    FROM ext.dfs_call d
   WHERE d.call_id = s.call_id AND d.requested_at = s.observed_at AND d.endpoint = 'keyword_suggestions'
     AND (d.response #>> '{tasks,0,result,0,total_count}') ~ '^[0-9]{1,9}$' AND s.total_count IS NULL;
  GET DIAGNOSTICS n1 = ROW_COUNT;
  -- 적재기와 같은 규칙: 응답 결과 원소의 keyword 를 app.term_norm 으로 kw_key 에 잇고, 같은 키가 여럿이면 뒤 원소가 이긴다(ON CONFLICT DO UPDATE)
  UPDATE rd.kw_volume_monthly v SET competition = c.comp
    FROM (SELECT DISTINCT ON (w.kw_key, w.call_id) w.kw_key, w.call_id, e.el->>'competition' AS comp
            FROM (SELECT DISTINCT kw_key, call_id, observed_at FROM rd.kw_volume_monthly) w
            JOIN rd.dim_keyword k ON k.kw_key = w.kw_key
            JOIN ext.dfs_call d ON d.call_id = w.call_id AND d.requested_at = w.observed_at AND d.endpoint = 'search_volume'
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.response #> '{tasks,0,result}') = 'array'
                                                         THEN d.response #> '{tasks,0,result}' ELSE '[]'::jsonb END) WITH ORDINALITY e(el, i)
           WHERE app.term_norm(e.el->>'keyword') = k.term_norm
           ORDER BY w.kw_key, w.call_id, e.i DESC) c
   WHERE v.kw_key = c.kw_key AND v.call_id = c.call_id AND v.competition IS NULL AND c.comp IN ('LOW', 'MEDIUM', 'HIGH');
  GET DIAGNOSTICS n2 = ROW_COUNT;
  RAISE NOTICE 'P62 total_count 채움 %, competition 채움 %', n1, n2;
END $b$;

-- ── P63 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW rd.v_answer_body WITH (security_barrier) AS
  SELECT j.answer_key, j.job_id, j.surface, j.project_key, j.geo_key, j.bgrp, a.answer_text, a.model_slug, a.measured_at, a.analysis_status, a.status,
         a.run_id, a.region, a.prompt_run_id
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id JOIN ing.answer a ON a.run_month = m.run_month AND a.job_id = m.job_id;
ALTER VIEW rd.v_answer_body OWNER TO loader_ro;
GRANT SELECT ON rd.v_answer_body TO api_ro, admin_long, qa_gate;
CREATE VIEW rd.v_acr_cell_run WITH (security_barrier) AS
  SELECT p.acr_cell_key, p.prompt_run_id, p.run_id FROM ing.acr_prompt_run p;
COMMENT ON VIEW rd.v_acr_cell_run IS 'ACR 셀 키 ↔ Scope prompt_run_id(현행 ACR 노트 키 ${promptRunId}:${entityId} 연결용, bg-qa-platform R2)';
ALTER VIEW rd.v_acr_cell_run OWNER TO loader_ro;
GRANT SELECT ON rd.v_acr_cell_run TO api_ro, admin_long, qa_gate;

-- ── P64 ─────────────────────────────────────────────────────────────────────
INSERT INTO mig.known_diff (rule_id, feature_id, metric_key_like, compat_variant, description, decided_ref, notice_required)
VALUES ('K-1b', 'analytics.kpi.summary', 'unmeasured%', 'input',
        '미측정 목록 = 서로 다른 프롬프트 키 단위(대표 행 = 게이트 통과 행 중 최소 prompt_id, total = 서로 다른 키 수)'
        ' (현행 listUnmeasuredPromptsFromCatalog: 카탈로그 행 단위, 같은 키의 브랜드 행 둘 = 두 행)',
        '메인 결정 2026-09-29 core 8라운드 bg-kpi-filters R4 · 모듈-KPI K-1b · DECISIONS-API', true),
       ('BG-07', 'analytics.trend.series', 'type_exposure%', 'input',
        '유형 추이 분자 = 그 유형 신호가 있는 competitive 당사 답변(GET /v1/mentions/types M-2 당사 행과 같은 술어)'
        ' (현행 typeTrend: 당사 롤업 행 전부, 비경쟁 표기 포함)',
        '메인 결정 2026-09-29 core 8라운드 bg-trend-geo R1 · M-2 미결 1번과 함께 F08·F10 패리티로 확정', true),
       ('BG-10', 'analytics.trend.series', 'measured_days', 'input',
        '커버리지 N일 = 버킷 답변 measured_at 의 KST 고유 일수, 엔진 합집합, 셀 대표 여부 무관(버킷 답변 전부)'
        ' (현행 엔진 추이: 엔진별 세션 TZ 일수의 max, 셀 대표 1건만)',
        '메인 결정 2026-09-29 core 8라운드 bg-trend-geo R2 · 설계 A-G5', true)
ON CONFLICT (rule_id, feature_id, metric_key_like) DO NOTHING;

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF position('rd.dim_country' in (SELECT prosrc FROM pg_proc WHERE oid = 'app.tg_user_account_scope()'::regprocedure)) = 0
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app.tg_user_account_scope()'::regprocedure) <> 'hmg_owner'
     OR NOT has_table_privilege('hmg_owner', 'rd.dim_country', 'select') THEN RAISE EXCEPTION 'P59 실패'; END IF;
  IF NOT has_column_privilege('api_rw', 'app.ga4_property', 'verified_at', 'update')
     OR NOT has_column_privilege('api_ro', 'app.ga4_property', 'verified_at', 'select') THEN RAISE EXCEPTION 'P60 실패'; END IF;
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app.ga4_market_pending'::regclass) <> 'hmg_owner'
     OR NOT (has_table_privilege('api_rw', 'app.ga4_market_pending', 'insert') AND has_table_privilege('api_rw', 'app.ga4_market_pending', 'update')
             AND has_table_privilege('api_rw', 'app.ga4_market_pending', 'delete') AND has_table_privilege('api_rw', 'app.ga4_market_pending', 'select'))
     OR NOT has_table_privilege('api_ro', 'app.ga4_market_pending', 'select')
     OR has_table_privilege('api_ro', 'app.ga4_market_pending', 'insert') THEN RAISE EXCEPTION 'P61 실패'; END IF;
  IF NOT has_column_privilege('loader', 'rd.kw_suggestion', 'total_count', 'insert')
     OR NOT has_column_privilege('loader', 'rd.kw_volume_monthly', 'competition', 'update')
     OR NOT has_column_privilege('api_ro', 'rd.kw_volume_monthly', 'competition', 'select') THEN RAISE EXCEPTION 'P62 실패'; END IF;
  IF NOT has_column_privilege('qa_gate', 'rd.v_answer_body', 'prompt_run_id', 'select')
     OR NOT has_table_privilege('qa_gate', 'rd.v_acr_cell_run', 'select')
     OR NOT has_table_privilege('api_ro', 'rd.v_acr_cell_run', 'select')
     OR (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'rd.v_acr_cell_run'::regclass) <> 'loader_ro'
     OR NOT has_table_privilege('loader_ro', 'ing.acr_prompt_run', 'select') THEN RAISE EXCEPTION 'P63 실패'; END IF;
  IF (SELECT count(*) FROM mig.known_diff WHERE rule_id IN ('K-1b', 'BG-07', 'BG-10')) <> 3 THEN RAISE EXCEPTION 'P64 실패'; END IF;
END $v$;

COMMIT;
