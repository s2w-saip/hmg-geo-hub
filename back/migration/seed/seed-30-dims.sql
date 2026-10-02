-- ============================================================================
-- seed-30-dims.sql : ing·app → rd 차원 투영(정수 키 발급) + rd.catalog_entry   (빌더 B, 2026-09-28)
-- 전제: DB-v2.1.sql 적용, seed-10-app.sql·seed-20-ing.sql(빌더 A) 적용 완료. app.rule_set 1행 이상.
-- 포함 파일(같은 디렉터리): seed-00-fn.sql(빌더 A 정규화 함수), seed-3x-rules.sql(gen_seed3x.py 생성 판정 입력),
--   seed-3x-common.sql(공용 판정 함수·표기 쌍 표).
-- 재실행 가능: 트랜잭션 1개. rd 차원·카탈로그와 **rd 사실 표 전부**를 TRUNCATE ... RESTART IDENTITY 후 INSERT...SELECT.
--   키가 다시 발급되므로 이 파일을 다시 돌리면 seed-40-facts.sql 도 반드시 다시 돌린다(사실 표를 여기서 비우는 이유).
-- 키 발급 규칙: 같은 입력이면 같은 키(ORDER BY 고정). 0 = 예약값('없음'·'미상'), 사실 표 NOT NULL 열이 가리킨다.
-- D8: 사전 집계·요약 표·캐시 없음. 여기 쓰는 모든 표는 원본과 1:1 차원이거나 규칙 판정 열이다.
-- 판정 규칙마다 현행 근거(7639b9e file:line)를 주석으로 단다. 근거를 못 찾은 것은 '미확인'.
-- ============================================================================
\set ON_ERROR_STOP on
\set VERBOSITY terse
SET client_min_messages = warning;
SET TIME ZONE 'UTC';
\if :{?work_mem}
SET work_mem = :'work_mem';
\else
SET work_mem = '512MB';
\endif
SET maintenance_work_mem = '1GB';
SET statement_timeout = 0;
\timing on
-- 동결 층 보관 관문(DB-v2.21 P117, 결정 32): 기본 = 사실 표를 비우기 전에 동결 답변의 지금 행을 보관(src bulk)하고 seed-40 끝에서 값이 같은 것을 정리.
--   -v frz_no_keep=1 = 보관 안 함(이관 작업 명시 모드: 열 백필·패치 채우기처럼 값을 "고치는" 재구축은 동결 값도 바뀌어야 한다. 위험·판단 = 설계 12.11).
\if :{?frz_no_keep}
\else
\set frz_no_keep 0
\endif
\ir seed-00-fn.sql
\ir seed-3x-rules.sql

BEGIN;
SET LOCAL lock_timeout = '60s';

DO $a$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.rule_set) THEN RAISE EXCEPTION 'app.rule_set 비어 있음: seed-10 먼저'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.brand WHERE is_umbrella) THEN RAISE EXCEPTION 'app.brand 엄브렐러 행 없음(Q11)'; END IF;
END $a$;
SELECT max(rule_ver) AS rv FROM app.rule_set \gset
-- ecat_pins(E1): 노출 회차에 고정한 엔티티 버전(rd.cycle.ecat_ver). 아래 §0 이 rd.cycle 을 비우므로 이 적재 원장 행에 남기고 seed-40 이 되살린다.
INSERT INTO ing.load (kind, scope_ref, rule_ver, status)
VALUES ('rebuild', jsonb_build_object('step', 'seed-30-dims', 'builder', 'B',
                                      'ecat_pins', coalesce((SELECT jsonb_agg(jsonb_build_array(c.cycle_id, c.ecat_ver) ORDER BY c.cycle_id)
                                                               FROM rd.cycle c WHERE c.ecat_ver IS NOT NULL), '[]'::jsonb)), :rv, 'running')
RETURNING load_id AS l30 \gset

\ir seed-3x-common.sql

-- ── 0. 비우기(차원 키 재발급 → 사실 표도 함께) ───────────────────────────────
-- 동결 층(DB-v2.21 P117): 비우기 직전 동결 답변의 지금 행 보관(bulk, 보관 관문 명시 단계. frz 가 없는 DB 는 건너뛴다)
\if :frz_no_keep
\else
DO $frz$ BEGIN
  IF to_regprocedure('frz.keep_rewrite(int4[], text)') IS NOT NULL THEN
    PERFORM frz.keep_rewrite((SELECT array_agg(DISTINCT c.answer_key) FROM frz.cell c
                                JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active'), 'bulk');
  END IF;
END $frz$;
\endif
TRUNCATE rd.catalog_entry, rd.dim_prompt, rd.web_unit, rd.dim_project, rd.dim_taxon, rd.dim_lang, rd.dim_country, rd.dim_region,
         rd.dim_engine, rd.dim_url, rd.dim_source, rd.dim_entity, rd.dim_brand_name,
         rd.job, rd.answer, rd.answer_brand, rd.answer_stance, rd.citation, rd.cycle, rd.surface_generation,
         rd.acr_cell, rd.acr_cell_job, rd.acr_choice, rd.report_unit_value RESTART IDENTITY;

-- ── 1. rd.dim_engine: ing.answer.target(·ACR target) ∪ rule_param default_engines. 0 = 미상.
--    is_default = app.rule_param 'default_engines'(lib/scope/engines.ts:37 DEFAULT_AI_ENGINES, 0077 hmg_anchor_default_engines :202)
INSERT INTO rd.dim_engine VALUES (0, '', false);
WITH dflt AS (SELECT jsonb_array_elements_text(value) AS code FROM app.rule_param WHERE key = 'default_engines'),
     e AS (SELECT target AS code FROM ing.answer UNION SELECT target FROM ing.acr_prompt_run UNION SELECT code FROM dflt)
INSERT INTO rd.dim_engine (engine_key, code, is_default)
SELECT row_number() OVER (ORDER BY (e.code IN (SELECT code FROM dflt)) DESC, e.code)::int2, e.code, e.code IN (SELECT code FROM dflt)
  FROM e WHERE coalesce(e.code, '') <> '';

-- ── 2. rd.dim_region·rd.dim_country
--    권역 = 지오 카탈로그 대륙 권역(geoLocateByCode lib/geo-catalog/index.ts:121). 0 = 미상.
--    국가 코드 원천: 답변 region(scope_answers.region = ISO alpha-2, index.ts:98 주석), 웹사이트 사이트 국가(가상 코드 SA-Dammam 류 포함,
--    0056_genesis_sa_city_sites.sql), 소유 베이스·권역본부·숨김 시장·프로젝트 국가, 웹사이트 가상 브랜드 코드(website-virtual-geo.ts:23).
--    kind: virtual_brand(가상 코드) | iso(^[A-Z]{2}$) | pseudo(그 밖, 예 SA-Dammam) | unknown(0 예약).
--    hidden_standard = app.hidden_market surface 'global'(HIDDEN_STANDARD_REGIONS lib/scope/hidden-regions.ts:22).
--    pseudo 코드의 권역 = 앞 2자 ISO 의 권역(SA-Dammam → SA). 근거 미확인(현행은 pseudo 코드에 권역을 주지 않는다), 필터 권역 펼침용 편의.
INSERT INTO rd.dim_region VALUES (0, '');
INSERT INTO rd.dim_region (region_key, code)
SELECT row_number() OVER (ORDER BY region)::int2, region FROM (SELECT DISTINCT region FROM _r_iso_region) r;

INSERT INTO rd.dim_country (geo_key, code, region_key, kind, virtual_brand_bit, hidden_standard) VALUES (0, '', NULL, 'unknown', NULL, false);
WITH c0 AS (
  SELECT region AS code FROM ing.answer WHERE region IS NOT NULL
  UNION SELECT region FROM ing.acr_prompt_run WHERE region IS NOT NULL
  UNION SELECT country_code FROM app.website_site
  UNION SELECT geo_code FROM app.owned_base WHERE geo_code IS NOT NULL
  UNION SELECT country_code FROM app.rhq_region_country
  UNION SELECT country_code FROM app.hidden_market
  UNION SELECT country_code FROM app.project
  UNION SELECT code FROM _r_virtual_geo),
-- 대소문자만 다른 코드는 하나로. 정본 = 적재 순서와 무관한 CANON_ORDER(ingest/project/apply/queries.py 와 글자까지 같다: 회귀
-- tests/core 가 대조): app 원천 정확 표기(권위 순위) → 대문자 표기 → 코드(COLLATE "C"). 숨김 시장·가상 코드 판정도 upper 등치(검증 F1·F2).
cu AS (
  SELECT DISTINCT ON (upper(c0.code)) c0.code FROM c0
   WHERE coalesce(c0.code, '') <> ''
   ORDER BY upper(c0.code), CASE WHEN EXISTS (SELECT 1 FROM app.website_site w WHERE w.country_code = c0.code) THEN 1
                  WHEN EXISTS (SELECT 1 FROM _r_virtual_geo v WHERE v.code = c0.code) THEN 2
                  WHEN EXISTS (SELECT 1 FROM app.rhq_region_country r WHERE r.country_code = c0.code) THEN 3
                  WHEN EXISTS (SELECT 1 FROM app.project p WHERE p.country_code = c0.code) THEN 4
                  WHEN EXISTS (SELECT 1 FROM app.owned_base o WHERE o.geo_code = c0.code) THEN 5
                  WHEN EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.country_code = c0.code) THEN 6 ELSE 7 END,
             (c0.code = upper(c0.code)) DESC, c0.code COLLATE "C")
INSERT INTO rd.dim_country (geo_key, code, region_key, kind, virtual_brand_bit, hidden_standard)
SELECT row_number() OVER (ORDER BY c.code)::int2, c.code, rg.region_key,
       CASE WHEN v.code IS NOT NULL THEN 'virtual_brand' WHEN c.code ~ '^[A-Z]{2}$' THEN 'iso' ELSE 'pseudo' END,
       vb.brand_bit,
       EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global' AND upper(h.country_code) = upper(c.code))
  FROM cu c
  LEFT JOIN _r_virtual_geo v ON upper(v.code) = upper(c.code)
  LEFT JOIN app.brand vb ON vb.brand_code = v.brand_code
  LEFT JOIN _r_iso_region ir ON ir.iso = CASE WHEN c.code ~ '^[A-Z]{2}(-|$)' THEN left(c.code, 2) END
  LEFT JOIN rd.dim_region rg ON rg.code = ir.region
 WHERE coalesce(c.code, '') <> '';

-- ── 3. rd.dim_lang: 소문자 코드(CHECK). 원천: Scope 프롬프트 lang(대문자 ISO 639-1), 웹사이트 lang_code(소문자 BCP-47),
--    카탈로그 lang. langAxisPred scope-aggregates.ts:949 가 표면별로 두 원천을 쓴다(값 공간은 소문자로 통일, :943 주석).
INSERT INTO rd.dim_lang VALUES (0, '');
INSERT INTO rd.dim_lang (lang_key, code)
SELECT row_number() OVER (ORDER BY code)::int2, code FROM (
  SELECT lower(lang) AS code FROM ing.prompt WHERE coalesce(lang, '') <> ''
  UNION SELECT lower(lang_code) FROM app.website_prompt WHERE coalesce(lang_code, '') <> ''
  UNION SELECT lower(lang) FROM app.prompt WHERE coalesce(lang, '') <> '') l;

-- ── 4. rd.dim_project: 알려진 scope project 전부(커서 ∪ run ∪ 회차 원장 ∪ 앱 프로젝트 ∪ 웹사이트 사이트).
--    표면 = ing.sync_cursor.surface(빌더 A 가 run-surface 규칙으로 판정) → 원장 회차 표면 → 없으면 같은 규칙(표준 루트 → global,
--    website_sites → website, 그 밖 → project; 0077 refresh_answer_cycle_anchors :965-981 순서).
--    site_* = 그 scope project 를 가진 app.website_site(UNIQUE). 프로젝트 브랜드 비트는 두지 않는다(DDL 에 열 없음, 사실 행 bgrp 로 굳힘).
--    regions = ing.sync_cursor.regions(DB-v2.1 P05).
WITH k AS (
  SELECT scope_project_id FROM ing.sync_cursor
  UNION SELECT scope_project_id FROM ing.run
  UNION SELECT scope_project_id FROM ing.cycle
  UNION SELECT scope_project_id FROM app.project WHERE scope_project_id IS NOT NULL
  UNION SELECT scope_project_id FROM app.website_site WHERE scope_project_id IS NOT NULL),
s AS (
  SELECT k.scope_project_id,
         coalesce(sc.surface,
                  (SELECT c.surface FROM ing.cycle c WHERE c.scope_project_id = k.scope_project_id ORDER BY c.cycle_anchor_at DESC LIMIT 1),
                  CASE WHEN EXISTS (SELECT 1 FROM app.website_site w WHERE w.scope_project_id = k.scope_project_id) THEN 'website'
                       WHEN EXISTS (SELECT 1 FROM app.project p WHERE p.scope_project_id = k.scope_project_id AND p.kind = 'standard_root') THEN 'global'
                       ELSE 'project' END) AS surface_txt,
         sc.regions
    FROM k LEFT JOIN ing.sync_cursor sc ON sc.scope_project_id = k.scope_project_id)
INSERT INTO rd.dim_project (project_key, scope_project_id, surface, is_root, project_id, site_id, site_brand_bit, site_geo_key, regions)
SELECT row_number() OVER (ORDER BY sf, s.scope_project_id)::int2, s.scope_project_id, sf,
       (sf = 1 AND coalesce(p.kind = 'standard_root', false)), p.project_id, w.site_id,
       coalesce(wb.brand_bit, 0), coalesce(g.geo_key, 0), s.regions
  FROM s
  CROSS JOIN LATERAL (SELECT (CASE s.surface_txt WHEN 'global' THEN 1 WHEN 'website' THEN 2 ELSE 3 END)::int2 AS sf) x
  LEFT JOIN app.project p ON p.scope_project_id = s.scope_project_id
  LEFT JOIN app.website_site w ON w.scope_project_id = s.scope_project_id
  LEFT JOIN app.brand wb ON wb.brand_code = w.brand_code
  LEFT JOIN rd.dim_country g ON upper(g.code) = upper(w.country_code);
DO $a$ BEGIN
  IF (SELECT count(*) FROM rd.dim_project WHERE is_root) <> 1 THEN
    RAISE EXCEPTION 'rd.dim_project 루트 표면 프로젝트가 1개가 아님: %', (SELECT count(*) FROM rd.dim_project WHERE is_root);
  END IF;
END $a$;

-- ── 5. rd.dim_taxon: 카탈로그 택소노미(축별 코드, depth2 의 부모 = depth1, depth3 의 부모 = depth2).
--    원천 = 표준 루트 카탈로그(app.prompt, kind standard_root 프로젝트, 비삭제; catalogPromptPreds scope-aggregates.ts:6062 의 축).
--    funnel 은 모든 프로젝트 행(dim_prompt.funnel_key 가 scope_prompt_id 같은 어느 행이든 쓰므로, :3515 규칙).
--    presence = brandPresenceResolvedSqlFor scope-aggregates.ts:989 (brand_presence, 없으면 엄브렐러 → unbranded, 브랜드 있음 → branded).
DROP TABLE IF EXISTS _root_cat;
CREATE TEMP TABLE _root_cat AS
SELECT p.*, coalesce(p.brand_presence,
                     CASE WHEN b.is_umbrella THEN 'unbranded' WHEN p.brand_code IS NOT NULL THEN 'branded' END) AS presence_res
  FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
  LEFT JOIN app.brand b ON b.brand_code = p.brand_code
 WHERE p.deleted_at IS NULL;
WITH t AS (
  SELECT 'funnel' AS axis, funnel_stage AS code, NULL::text AS p1, NULL::text AS p2, 1 AS o FROM app.prompt WHERE coalesce(funnel_stage, '') <> ''
  UNION SELECT 'presence', presence_res, NULL, NULL, 2 FROM _root_cat WHERE presence_res IS NOT NULL
  UNION SELECT 'list_type', list_type, NULL, NULL, 3 FROM _root_cat WHERE coalesce(list_type, '') <> ''
  UNION SELECT 'depth1', depth1, NULL, NULL, 4 FROM _root_cat WHERE coalesce(depth1, '') <> '')
INSERT INTO rd.dim_taxon (taxon_key, axis, code, parent_key)
SELECT row_number() OVER (ORDER BY o, code)::int2, axis, code, NULL FROM t;
-- depth2·depth3: 빈 부모(NULL·빈 문자열 혼재)를 NULL 로 통일하고, 해석된 (코드, 부모 키) 기준으로 중복 제거
--   (2026-09-28 stg 실데이터: 부모 경로가 빈 depth3 17행이 NULL 과 '' 로 갈려 (depth3, code, NULL) 중복 → UNIQUE 위반).
INSERT INTO rd.dim_taxon (taxon_key, axis, code, parent_key)
SELECT (SELECT coalesce(max(taxon_key), 0) FROM rd.dim_taxon) + row_number() OVER (ORDER BY y.pk NULLS FIRST, y.depth2)::int2, 'depth2', y.depth2, y.pk
  FROM (SELECT DISTINCT d1.taxon_key AS pk, x.depth2
          FROM (SELECT DISTINCT nullif(depth1, '') AS depth1, depth2 FROM _root_cat WHERE coalesce(depth2, '') <> '') x
          LEFT JOIN rd.dim_taxon d1 ON d1.axis = 'depth1' AND d1.code = x.depth1) y;
INSERT INTO rd.dim_taxon (taxon_key, axis, code, parent_key)
SELECT (SELECT coalesce(max(taxon_key), 0) FROM rd.dim_taxon) + row_number() OVER (ORDER BY y.pk NULLS FIRST, y.depth3)::int2, 'depth3', y.depth3, y.pk
  FROM (SELECT DISTINCT d2.taxon_key AS pk, x.depth3
          FROM (SELECT DISTINCT nullif(depth1, '') AS depth1, nullif(depth2, '') AS depth2, depth3
                  FROM _root_cat WHERE coalesce(depth3, '') <> '') x
          LEFT JOIN rd.dim_taxon d1 ON d1.axis = 'depth1' AND d1.code = x.depth1
          LEFT JOIN rd.dim_taxon d2 ON d2.axis = 'depth2' AND d2.code = x.depth2 AND d2.parent_key IS NOT DISTINCT FROM d1.taxon_key) y;

-- ── 6. rd.web_unit: 웹사이트 측정 유닛(사이트 × file_seq) 자사 판정 입력 = websiteOwnedUnits scope-aggregates.ts:8542
--    base: 선언 owned_base_url 최빈(동률 문자열) → 없으면 타겟 URL base 최다 호스트(공유 글로벌 호스트면 host/1seg) (:8551-8575),
--          ownedBasePrefixFromUrl(pg_temp.owned_prefix, owned.ts:137) 적용 후 빈 값이면 NULL(판정 false, :8581).
--    sibs: 선언 base 전량(owned_prefix) 중 이 base 아래의 더 긴 것(:8584-8592, ownedBasePrefixClause longerSiblings :738 과 같은 식).
--    home_host: base 호스트, 공유 글로벌 호스트면 NULL(isSiteRootHome owned.ts:161).
--    turls: 유닛 안 모든 행의 타겟 URL tracked NORM(citation_url_norm) 집합(wut CTE :8468-8476, scope_prompt_id 조건 없음).
--    유닛 모집단: scope_prompt_id·file_seq 가 있는 행(:8547-8548). 사이트의 scope project 는 app.website_site 값,
--    없으면(빌더 A 가 공유 scope project 사이트의 둘째 이후를 NULL 로 둠: 제네시스 사우디 도시 사이트) 유닛 프롬프트의 ing.prompt 소속으로 복원.
--    키 (project_key, file_seq): file_seq 는 현행에서 사이트 사이 유일(빌더 A seed-10 4-9 주석). 충돌 시 site_id 순 첫 유닛만 두고 경고.
DROP TABLE IF EXISTS _wu;
CREATE TEMP TABLE _wu AS
WITH wp AS (
  SELECT wp.site_id, wp.file_seq, nullif(wp.owned_base_url, '') AS decl, pg_temp.cit_base_norm(wp.target_url) AS turl_base,
         wp.scope_prompt_id
    FROM app.website_prompt wp
   WHERE wp.scope_prompt_id IS NOT NULL AND wp.file_seq IS NOT NULL),
u AS (SELECT DISTINCT site_id, file_seq FROM wp),
decl AS (
  SELECT DISTINCT ON (site_id, file_seq) site_id, file_seq, decl AS base
    FROM (SELECT site_id, file_seq, decl, count(*) AS n FROM wp WHERE decl IS NOT NULL GROUP BY 1, 2, 3) d
   ORDER BY site_id, file_seq, n DESC, decl),
heur AS (
  SELECT DISTINCT ON (site_id, file_seq) site_id, file_seq, k AS base
    FROM (SELECT site_id, file_seq,
                 CASE WHEN split_part(turl_base, '/', 1) IN (SELECT host FROM _r_shared_host) AND split_part(turl_base, '/', 2) <> ''
                      THEN split_part(turl_base, '/', 1) || '/' || split_part(turl_base, '/', 2)
                      ELSE split_part(turl_base, '/', 1) END AS k,
                 count(*) AS n
            FROM wp WHERE coalesce(turl_base, '') <> '' GROUP BY 1, 2, 3) h
   ORDER BY site_id, file_seq, n DESC, k),
proj AS (   -- 유닛 → scope project: 사이트 값 → 유닛 프롬프트의 ing.prompt 소속(최빈, 동률 uuid 순)
  SELECT DISTINCT ON (wp.site_id, wp.file_seq) wp.site_id, wp.file_seq, ip.scope_project_id
    FROM wp JOIN ing.prompt ip ON ip.scope_prompt_id = wp.scope_prompt_id
   GROUP BY 1, 2, 3 ORDER BY wp.site_id, wp.file_seq, count(*) DESC, ip.scope_project_id)
SELECT u.site_id, u.file_seq, coalesce(s.scope_project_id, pj.scope_project_id) AS scope_project_id,
       nullif(pg_temp.owned_prefix(coalesce(d.base, h.base)), '') AS base,
       CASE WHEN d.base IS NOT NULL THEN 'decl' WHEN h.base IS NOT NULL THEN 'heur' END AS base_src
  FROM u
  JOIN app.website_site s ON s.site_id = u.site_id
  LEFT JOIN decl d ON d.site_id = u.site_id AND d.file_seq = u.file_seq
  LEFT JOIN heur h ON h.site_id = u.site_id AND h.file_seq = u.file_seq
  LEFT JOIN proj pj ON pj.site_id = u.site_id AND pj.file_seq = u.file_seq;
UPDATE _wu SET base_src = NULL WHERE base IS NULL;

DROP TABLE IF EXISTS _decl_prefix;
CREATE TEMP TABLE _decl_prefix AS   -- 형제 모집단 = 선언 base 전량(:8577-8580)
SELECT DISTINCT pg_temp.owned_prefix(owned_base_url) AS q FROM app.website_prompt WHERE coalesce(owned_base_url, '') <> '';
DELETE FROM _decl_prefix WHERE coalesce(q, '') = '';

WITH ku AS (
  SELECT DISTINCT ON (dp.project_key, w.file_seq) dp.project_key, w.*
    FROM _wu w JOIN rd.dim_project dp ON dp.scope_project_id = w.scope_project_id
   ORDER BY dp.project_key, w.file_seq, w.site_id)
INSERT INTO rd.web_unit (unit_key, project_key, file_seq, lang_codes, base, base_src, sibs, home_host, turls, rule_ver)
SELECT row_number() OVER (ORDER BY ku.project_key, ku.file_seq)::int2, ku.project_key, ku.file_seq,
       coalesce((SELECT array_agg(DISTINCT lower(wp.lang_code) ORDER BY lower(wp.lang_code)) FROM app.website_prompt wp
                  WHERE wp.site_id = ku.site_id AND wp.file_seq = ku.file_seq AND coalesce(wp.lang_code, '') <> ''), '{}'),
       ku.base, ku.base_src,
       CASE WHEN ku.base IS NULL THEN '{}'::text[] ELSE
         coalesce((SELECT array_agg(q ORDER BY q) FROM _decl_prefix WHERE length(q) > length(ku.base) AND starts_with(q, ku.base || '/')), '{}') END,
       CASE WHEN ku.base IS NOT NULL AND split_part(ku.base, '/', 1) NOT IN (SELECT host FROM _r_shared_host)
            THEN split_part(ku.base, '/', 1) END,
       coalesce((SELECT array_agg(DISTINCT pg_temp.cit_norm(wp.target_url) ORDER BY pg_temp.cit_norm(wp.target_url)) FROM app.website_prompt wp
                  WHERE wp.site_id = ku.site_id AND wp.file_seq = ku.file_seq AND coalesce(wp.target_url, '') <> ''), '{}'),
       :rv
  FROM ku;
DO $a$ DECLARE n int; BEGIN
  SELECT count(*) - count(DISTINCT (w.scope_project_id, w.file_seq)) INTO n FROM _wu w WHERE w.scope_project_id IS NOT NULL;
  IF n > 0 THEN RAISE WARNING 'web_unit (project, file_seq) 충돌 %건: site_id 순 첫 유닛만 투영', n; END IF;
END $a$;

-- ── 7. rd.dim_prompt: Scope 프롬프트 1개 = 1행. 모집단 = ing.prompt ∪ 답변·ACR 의 prompt_id ∪ 카탈로그·웹사이트 카탈로그의 scope_prompt_id.
--    소속(surface·project_key) = ing.prompt.scope_project_id → 답변 run 소속 최빈 → 웹사이트 사이트 → 앱 카탈로그 프로젝트. 못 풀면 행 없음.
--    kind = ing.prompt.kind → app.prompt.kind(비삭제·최신 우선) → ACR prompt-run 존재 시 'acr' → 'single'
--           (0025 prompt kind, 빌더 A seed-20 1-4 와 같은 폴백 사슬).
--    lang_key: website = 웹사이트 프롬프트 lang_code(langAxisPred project 분기 :953), 그 외 = Scope 프롬프트 lang 소문자(:957).
--    cat_mask = 루트 카탈로그 행 브랜드 비트 OR. 브랜드 없음·엄브렐러 행 = app.brand 엄브렐러 비트(Q11), 0 = 카탈로그 미등록.
--    in_root_catalog = rootCatalogGate scope-aggregates.ts:921 (루트 프로젝트 카탈로그의 scope_prompt_id 집합).
--      ⚠️ 현행은 소프트삭제 행을 일부러 거르지 않는다(:6180-6183). 여기서는 비삭제 행만 카탈로그로 본다(A4 고지 대상).
--    cat_mask_all·in_root_catalog_all(DB-v2.15 P88, A41) = 같은 식에서 삭제 행을 거르지 않은 값(현행 정의). 현행 프로필 catalog_incl_deleted 가 읽는다.
--    funnel_key = scope_prompt_id 같은 app.prompt 어느 행이든(:3504-3509 'LIMIT 1'): 비삭제 → 값 있음 → 최신 순으로 1개.
--    is_korean = Scope 프롬프트 text ~ '[가-힣]'(scope_prompts.is_korean schema.ts:1195, rootKoreanNonKrPred :1074).
--    regions = Scope 프롬프트 regions(rootRegionTagPred :1118).
--    unit_key = 프롬프트 → 유닛(base 있는 유닛만, DISTINCT ON scope_prompt_id ORDER BY unit_base, file_seq, site_id :8480-8486).
--    targets = 그 프롬프트 웹사이트 행들의 target_url tracked NORM(websitePromptUrlHitJobFlagsSql wp CTE :9001-9007, 빈 값 제외).
--    web_reg = 웹사이트 카탈로그 등록 여부(:9051 registered).
DROP TABLE IF EXISTS _pp;
CREATE TEMP TABLE _pp AS
WITH ids AS (
  SELECT scope_prompt_id AS prompt_id FROM ing.prompt
  UNION SELECT prompt_id FROM ing.answer WHERE prompt_id IS NOT NULL
  UNION SELECT prompt_id FROM ing.acr_prompt_run WHERE prompt_id IS NOT NULL
  UNION SELECT scope_prompt_id FROM app.prompt WHERE scope_prompt_id IS NOT NULL
  UNION SELECT scope_prompt_id FROM app.website_prompt WHERE scope_prompt_id IS NOT NULL),
by_ans AS (
  SELECT DISTINCT ON (a.prompt_id) a.prompt_id, r.scope_project_id
    FROM ing.answer a JOIN ing.run r ON r.run_id = a.run_id WHERE a.prompt_id IS NOT NULL
   GROUP BY 1, 2 ORDER BY a.prompt_id, count(*) DESC, r.scope_project_id),
by_app AS (
  SELECT DISTINCT ON (p.scope_prompt_id) p.scope_prompt_id, pr.scope_project_id
    FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id
   WHERE p.scope_prompt_id IS NOT NULL AND pr.scope_project_id IS NOT NULL
   ORDER BY p.scope_prompt_id, (p.deleted_at IS NOT NULL), (pr.kind <> 'standard_root'), p.updated_at DESC)
SELECT i.prompt_id,
       coalesce(ip.scope_project_id, ba.scope_project_id, wpk.site_scope_project_id, bp.scope_project_id) AS scope_project_id
  FROM ids i
  LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = i.prompt_id
  LEFT JOIN by_ans ba ON ba.prompt_id = i.prompt_id
  LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = i.prompt_id
  LEFT JOIN by_app bp ON bp.scope_prompt_id = i.prompt_id;

DROP TABLE IF EXISTS _app_kind;
CREATE TEMP TABLE _app_kind AS
SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, kind, text
  FROM app.prompt WHERE scope_prompt_id IS NOT NULL ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), updated_at DESC;
DROP TABLE IF EXISTS _app_lang;
CREATE TEMP TABLE _app_lang AS
SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, lang
  FROM app.prompt WHERE scope_prompt_id IS NOT NULL AND coalesce(lang, '') <> ''
 ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), updated_at DESC;
DROP TABLE IF EXISTS _acr_pids;
CREATE TEMP TABLE _acr_pids AS SELECT DISTINCT prompt_id FROM ing.acr_prompt_run WHERE prompt_id IS NOT NULL;
DROP TABLE IF EXISTS _funnel;
CREATE TEMP TABLE _funnel AS
SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, funnel_stage
  FROM app.prompt WHERE scope_prompt_id IS NOT NULL
 ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), (coalesce(funnel_stage, '') = ''), updated_at DESC;
DROP TABLE IF EXISTS _unit_of;
CREATE TEMP TABLE _unit_of AS
SELECT DISTINCT ON (wp.scope_prompt_id) wp.scope_prompt_id, wu.unit_key
  FROM app.website_prompt wp
  JOIN _wu w ON w.site_id = wp.site_id AND w.file_seq = wp.file_seq AND w.base IS NOT NULL
  JOIN rd.dim_project dp ON dp.scope_project_id = w.scope_project_id
  JOIN rd.web_unit wu ON wu.project_key = dp.project_key AND wu.file_seq = w.file_seq
 WHERE wp.scope_prompt_id IS NOT NULL
 ORDER BY wp.scope_prompt_id, w.base, wp.file_seq, wp.site_id;
DROP TABLE IF EXISTS _cat_bits;
CREATE TEMP TABLE _cat_bits AS
SELECT c.scope_prompt_id, bit_or(coalesce(b.brand_bit, u.brand_bit))::int2 AS cat_mask
  FROM _root_cat c LEFT JOIN app.brand b ON b.brand_code = c.brand_code
  CROSS JOIN (SELECT brand_bit FROM app.brand WHERE is_umbrella) u
 WHERE c.scope_prompt_id IS NOT NULL GROUP BY 1;
-- 삭제 행 포함 카탈로그 비트(DB-v2.15 P88 cat_mask_all·in_root_catalog_all, A41 현행 CAT_CTE surface-global.ts:117-135 = deleted_at 술어 없음).
--   _root_cat 과 같은 식에서 deleted_at 술어만 뺀다(적재 DIM_PROMPT·DIM_PROMPT_REFRESH·rd.fill_prompt_catalog_all 과 같다).
DROP TABLE IF EXISTS _cat_bits_all;
CREATE TEMP TABLE _cat_bits_all AS
SELECT p.scope_prompt_id, bit_or(coalesce(b.brand_bit, u.brand_bit))::int2 AS cat_mask_all
  FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
  LEFT JOIN app.brand b ON b.brand_code = p.brand_code
  CROSS JOIN (SELECT brand_bit FROM app.brand WHERE is_umbrella) u
 WHERE p.scope_prompt_id IS NOT NULL GROUP BY 1;

INSERT INTO rd.dim_prompt (prompt_key, prompt_id, surface, project_key, kind, text, lang_key, cat_mask, in_root_catalog, funnel_key,
                           unit_key, targets, web_reg, regions, is_korean, rule_ver, cat_mask_all, in_root_catalog_all)
VALUES (0, '00000000-0000-0000-0000-000000000000', 0, 0, 'single', NULL, 0, 0, false, 0, NULL, '{}', false, NULL, false, :rv, 0, false);
INSERT INTO rd.dim_prompt (prompt_key, prompt_id, surface, project_key, kind, text, lang_key, cat_mask, in_root_catalog, funnel_key,
                           unit_key, targets, web_reg, regions, is_korean, rule_ver, cat_mask_all, in_root_catalog_all)
SELECT row_number() OVER (ORDER BY dp.surface, dp.project_key, pp.prompt_id)::int4,
       pp.prompt_id, dp.surface, dp.project_key,
       coalesce(CASE WHEN ip.kind IN ('single', 'acr') THEN ip.kind END, ak.kind,
                CASE WHEN ap.prompt_id IS NOT NULL THEN 'acr' END, 'single'),
       coalesce(ip.text, ak.text, (SELECT w.prompt_text FROM app.website_prompt w WHERE w.scope_prompt_id = pp.prompt_id
                                    ORDER BY w.file_seq, w.site_id LIMIT 1)),
       coalesce(l.lang_key, 0),
       coalesce(cb.cat_mask, 0), cb.scope_prompt_id IS NOT NULL,
       coalesce(tf.taxon_key, 0),
       uo.unit_key,
       coalesce((SELECT array_agg(DISTINCT n ORDER BY n) FROM (
                  SELECT nullif(pg_temp.cit_norm(coalesce(w.target_url, '')), '') AS n FROM app.website_prompt w
                   WHERE w.scope_prompt_id = pp.prompt_id) t WHERE n IS NOT NULL), '{}'),
       EXISTS (SELECT 1 FROM app.website_prompt w WHERE w.scope_prompt_id = pp.prompt_id),
       ip.regions,
       coalesce(ip.text ~ '[가-힣]', false),
       :rv,
       coalesce(cba.cat_mask_all, 0), cba.scope_prompt_id IS NOT NULL
  FROM _pp pp
  JOIN rd.dim_project dp ON dp.scope_project_id = pp.scope_project_id
  LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = pp.prompt_id
  LEFT JOIN _app_kind ak ON ak.scope_prompt_id = pp.prompt_id
  LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = pp.prompt_id
  LEFT JOIN _app_lang al ON al.scope_prompt_id = pp.prompt_id
  LEFT JOIN rd.dim_lang l ON l.code = CASE WHEN dp.surface = 2 THEN wpk.lang_code ELSE lower(coalesce(nullif(ip.lang, ''), al.lang)) END
  LEFT JOIN _acr_pids ap ON ap.prompt_id = pp.prompt_id
  LEFT JOIN _cat_bits cb ON cb.scope_prompt_id = pp.prompt_id
  LEFT JOIN _cat_bits_all cba ON cba.scope_prompt_id = pp.prompt_id
  LEFT JOIN _funnel fu ON fu.scope_prompt_id = pp.prompt_id
  LEFT JOIN rd.dim_taxon tf ON tf.axis = 'funnel' AND tf.code = fu.funnel_stage
  LEFT JOIN _unit_of uo ON uo.scope_prompt_id = pp.prompt_id;
SELECT setval(pg_get_serial_sequence('rd.dim_prompt', 'prompt_key'), greatest((SELECT max(prompt_key) FROM rd.dim_prompt), 1));

-- ── 8. rd.catalog_entry: 표준 루트 카탈로그 행 1개 = 1행(비삭제, §7 주석의 A4 고지). 쓰기 주체 = 적재기(B4).
--    brand_bit = 행 브랜드 비트, 브랜드 없음·엄브렐러 = 엄브렐러 비트(Q11). 택소노미 키 = rd.dim_taxon(깊이 부모 사슬).
--    prompt_key = 그 행의 scope_prompt_id 의 dim_prompt(미발행 행은 NULL, M12 적용 수 countCatalogPromptsFromCatalog :6200 는
--    scope_prompt_id IS NOT NULL 행만 센다).
INSERT INTO rd.catalog_entry (catalog_row_id, prompt_key, brand_bit, presence_key, funnel_key, list_type_key, depth1_key, depth2_key,
                              depth3_key, kind, load_id)
SELECT c.prompt_id, dp.prompt_key, coalesce(b.brand_bit, u.brand_bit),
       tp.taxon_key, tf.taxon_key, tl.taxon_key, t1.taxon_key, t2.taxon_key, t3.taxon_key, c.kind, :l30
  FROM _root_cat c
  CROSS JOIN (SELECT brand_bit FROM app.brand WHERE is_umbrella) u
  LEFT JOIN app.brand b ON b.brand_code = c.brand_code
  LEFT JOIN rd.dim_prompt dp ON dp.prompt_id = c.scope_prompt_id
  LEFT JOIN rd.dim_taxon tp ON tp.axis = 'presence' AND tp.code = c.presence_res
  LEFT JOIN rd.dim_taxon tf ON tf.axis = 'funnel' AND tf.code = c.funnel_stage
  LEFT JOIN rd.dim_taxon tl ON tl.axis = 'list_type' AND tl.code = c.list_type
  LEFT JOIN rd.dim_taxon t1 ON t1.axis = 'depth1' AND t1.code = c.depth1
  LEFT JOIN rd.dim_taxon t2 ON t2.axis = 'depth2' AND t2.code = c.depth2 AND t2.parent_key IS NOT DISTINCT FROM t1.taxon_key
  LEFT JOIN rd.dim_taxon t3 ON t3.axis = 'depth3' AND t3.code = c.depth3 AND t3.parent_key IS NOT DISTINCT FROM t2.taxon_key;

-- ── 9. rd.dim_brand_name: 표시 브랜드 1개 = 1행(bare UNIQUE). 0 = 이름 없음.
--    이름 원천 = _bn_pair(언급·스탠스·ACR 표기 쌍의 J2 표시명) ∪ 경쟁사 도메인 토큰 브랜드(app.competitor_domain_token, dim_source 가 가리킴).
--    bare(= lower(js_trim(canon(name)))) 가 같은 표기들은 한 키로 접는다(DDL bare UNIQUE). 대표 표기 = 정본 표기(app.brand·표시 별칭 정본)
--      → 언급 행 수 최다 → 라틴 우선 → 사전순. 현행은 표시명 문자열 그대로 GROUP BY(:2900) 라 대소문자만 다른 표기가 두 줄이었다(A4 고지).
--    현행 프로필 NAME(hgh.legacy_name = '1'): bare = 정본 표시명 그대로(seed-3x-common §3 name_key) → 대소문자만 다른 표기가 현행처럼 두 키,
--      대표 표기 선택은 키 = 이름이라 고를 것이 없다(현행 표시명 = 그 문자열). 자사·비경쟁 판정은 lower(js_trim(bare)) 로 한다.
--    own_bit(G-20 표시 브랜드 수준 자사) = bare 가 자사 브랜드 코드(app.brand is_hmg_own)와 같으면 그 비트(1·2·4), Hyundai N(16)은 부모 비트(1).
--      현행은 행의 rid 가 명부에 있는가(trackedRollupPredicate :333). 차이 건수는 seed-40 이 NOTICE 로 낸다(A4 고지).
--    kind: 0 이름 없음 · 1 자사 · 3 비경쟁 등재(app.non_competitor_name) · 2 그 밖(경쟁).
DROP TABLE IF EXISTS _bn_w;
CREATE TEMP TABLE _bn_w AS   -- 표시명별 언급 행 수(대표 표기 선택용)
SELECT p.name, p.bare, sum(m.n) AS w
  FROM (SELECT display_name, brand_rollup_entity_id, count(*) AS n FROM ing.mention WHERE brand_rollup_entity_id IS NOT NULL GROUP BY 1, 2) m
  JOIN _bn_pair p ON p.ver = (SELECT dv FROM _ecat_cfg) AND NOT p.ovr
                  AND p.dkey = coalesce(m.display_name, '') AND p.dnull = (m.display_name IS NULL) AND p.rollup = m.brand_rollup_entity_id
 WHERE p.bare <> '' GROUP BY 1, 2;
INSERT INTO rd.dim_brand_name (brand_key, name, bare, kind, own_bit) VALUES (0, '(이름 없음)', '', 0, 0);
WITH cand AS (
  SELECT name, bare FROM _bn_pair WHERE bare <> ''
  UNION SELECT canon_name, bare FROM _acr_nm WHERE bare <> ''
  UNION SELECT parent_canon, parent_bare FROM _acr_nm WHERE parent_bare <> ''
  UNION SELECT pg_temp.canon_brand(brand_name), pg_temp.brand_bare(brand_name) FROM app.competitor_domain_token),
canon_names AS (SELECT brand_code AS n FROM app.brand UNION SELECT canonical_name FROM app.brand_display_alias
                UNION SELECT brand_name FROM app.competitor_domain_token),
pick AS (
  SELECT DISTINCT ON (c.bare) c.bare, c.name
    FROM (SELECT DISTINCT name, bare FROM cand WHERE bare <> '') c
    LEFT JOIN _bn_w w ON w.name = c.name AND w.bare = c.bare
   ORDER BY c.bare, (c.name IN (SELECT n FROM canon_names)) DESC, coalesce(w.w, 0) DESC, (c.name ~ '^[A-Za-z]') DESC, c.name),
own AS (
  SELECT lower(b.brand_code) AS bare,
         (CASE WHEN b.brand_bit IN (1, 2, 4) THEN b.brand_bit ELSE coalesce(pb.brand_bit, 0) END)::int2 AS bit
    FROM app.brand b LEFT JOIN app.brand pb ON pb.brand_code = b.parent_brand_code
   WHERE b.is_hmg_own AND NOT b.is_umbrella),
k AS (
  SELECT p.name, p.bare, coalesce(o.bit, 0::int2) AS own_bit,
         (CASE WHEN coalesce(o.bit, 0) <> 0 THEN 1 WHEN nc.name IS NOT NULL THEN 3 ELSE 2 END)::int2 AS kind
    FROM pick p LEFT JOIN own o ON o.bare = lower(pg_temp.js_trim(p.bare)) LEFT JOIN app.non_competitor_name nc ON nc.name = lower(pg_temp.js_trim(p.bare)))
INSERT INTO rd.dim_brand_name (brand_key, name, bare, kind, own_bit)
SELECT row_number() OVER (ORDER BY kind = 1 DESC, own_bit, bare)::int4, name, bare, kind, own_bit FROM k;
SELECT setval(pg_get_serial_sequence('rd.dim_brand_name', 'brand_key'), (SELECT max(brand_key) FROM rd.dim_brand_name));

-- ── 10. rd.dim_entity: Scope 엔티티 1개 = 1행(언급·스탠스·ACR 롤업에 나온 전부).
--    entity_type = 언급 행 최빈(없으면 ACR entity_type). rep_name = 롤업 대표 표기(names, :236), 없으면 자기 표기 최빈.
--    brand_key = 그 엔티티 행들이 접힌 표시 브랜드 최빈(롤업 NULL 행만 있으면 NULL). registry_role = app.entity_registry.role.
--    엔티티 버전(E1): 차원은 기준 버전 dv(활성) 한 벌로 판정한다(표기 쌍 ver = dv 의 원본 쌍). registry_role = 활성 버전 투영(E0 호환 계층).
DROP TABLE IF EXISTS _ent;
CREATE TEMP TABLE _ent AS
WITH m AS (
  SELECT entity_id, entity_type, display_name, brand_rollup_entity_id, count(*) AS n
    FROM ing.mention GROUP BY 1, 2, 3, 4),
st AS (SELECT entity_id, brand_label, count(*) AS n FROM ing.answer_stance GROUP BY 1, 2),
ac AS (SELECT entity_id, entity_type, entity_name, count(*) AS n FROM ing.acr_rollup_row GROUP BY 1, 2, 3),
ty AS (SELECT DISTINCT ON (entity_id) entity_id, entity_type FROM (
         SELECT entity_id, entity_type, sum(n) AS n, 1 AS pri FROM m WHERE entity_type IS NOT NULL GROUP BY 1, 2
         UNION ALL SELECT entity_id, entity_type, sum(n), 2 FROM ac WHERE entity_type IS NOT NULL GROUP BY 1, 2) x
        ORDER BY entity_id, pri, n DESC, entity_type),
nm AS (SELECT DISTINCT ON (entity_id) entity_id, nm FROM (
         SELECT entity_id, display_name AS nm, sum(n) AS n, 1 AS pri FROM m WHERE display_name IS NOT NULL GROUP BY 1, 2
         UNION ALL SELECT entity_id, brand_label, sum(n), 2 FROM st WHERE brand_label IS NOT NULL GROUP BY 1, 2
         UNION ALL SELECT entity_id, entity_name, sum(n), 3 FROM ac WHERE entity_name IS NOT NULL GROUP BY 1, 2) x
        ORDER BY entity_id, pri, n DESC, nm),
bk AS (SELECT DISTINCT ON (entity_id) entity_id, bare FROM (
         SELECT m.entity_id, p.bare, sum(m.n) AS n, 1 AS pri FROM m
           JOIN _bn_pair p ON p.ver = (SELECT dv FROM _ecat_cfg) AND NOT p.ovr
                          AND p.dkey = coalesce(m.display_name, '') AND p.dnull = (m.display_name IS NULL) AND p.rollup = m.brand_rollup_entity_id
          WHERE m.brand_rollup_entity_id IS NOT NULL AND p.bare <> '' GROUP BY 1, 2
         UNION ALL
         SELECT st.entity_id, p.bare, sum(st.n), 2 FROM st
           JOIN _bn_pair p ON p.ver = (SELECT dv FROM _ecat_cfg) AND NOT p.ovr
                          AND p.dkey = coalesce(st.brand_label, '') AND p.dnull = (st.brand_label IS NULL) AND p.rollup = st.entity_id
          WHERE p.bare <> '' GROUP BY 1, 2) x
        ORDER BY entity_id, pri, n DESC, bare),
ids AS (SELECT entity_id FROM m UNION SELECT entity_id FROM st UNION SELECT entity_id FROM ac)
SELECT i.entity_id, ty.entity_type, coalesce(n.brand, nm.nm) AS rep_name, bk.bare
  FROM ids i
  LEFT JOIN ty ON ty.entity_id = i.entity_id
  LEFT JOIN _names n ON n.entity_id = i.entity_id
  LEFT JOIN nm ON nm.entity_id = i.entity_id
  LEFT JOIN bk ON bk.entity_id = i.entity_id;
INSERT INTO rd.dim_entity (entity_key, entity_id, entity_type, rep_name, brand_key, registry_role)
SELECT row_number() OVER (ORDER BY e.entity_id)::int4, e.entity_id, e.entity_type, e.rep_name, b.brand_key, r.role
  FROM _ent e LEFT JOIN rd.dim_brand_name b ON b.bare = e.bare
  LEFT JOIN app.entity_registry r ON r.entity_id = e.entity_id;
SELECT setval(pg_get_serial_sequence('rd.dim_entity', 'entity_key'), greatest((SELECT max(entity_key) FROM rd.dim_entity), 1));

-- ── 11. rd.dim_url·rd.dim_source: 인용 URL 1개 = 1행, 출처 그룹 키 1개 = 1행.
--    url_norm·url_base_norm = 0052 함수(pg_temp.cit_norm·cit_base_norm). host = 미러 url_host(0052 citation_url_host) 최빈, 없으면 url_norm 첫 구간.
--    domain = 미러 도메인(registrableDomainOfHost sync.ts:1341, PSL) 최빈(소문자·www 제거). 새 적재기는 같은 값을 Python PSL 로 낸다.
--    같은 URL 에 도메인이 둘 이상이면(과거 TWO_LEVEL_TLDS 절단 행, rules.ts:28 주석) 최빈을 쓴다(미확인 영향, 검증 표에 건수).
--    skey = citationGroupKey official-social.ts:225: 공식 HMG 소셜 계정 매처(경계 규칙 :181)에 걸리면 계정 키, 아니면 도메인.
--      경로 키 = citationPathKeyOf :193(트림·소문자·scheme 제거·첫 '/' 부터 경로·?#절단·%40→@) 앞에 등록 가능 도메인.
--    source_key 0 = 호스트(도메인) 없는 인용(G-21 a: 전 기능 제외).
--    owner_key(M05 전역 자사 항목, app.owned_base) = url_base_norm 이 ① 사이트 루트 홈(kind root_home, prefix = 호스트, 공유 글로벌 호스트 제외)
--      이면 그 항목 → ② 아니면 최장 base 접두 일치(= prefix | prefix/… | prefix.html, 호스트 일치)
--      (ownedBasePrefixClause scope-aggregates.ts:716-805 의 판정을 URL 1회로 굳힘. 루트 홈 우선은 DB 설계(인용 §4 전역 자사) 규칙 —
--       owned.ts:221 ownedBaseEntryForUrl 은 접두 우선이지만 허용 배열(owner_key = ANY) 로 ownedBasePrefixClause 와 동치가 되려면 루트 홈 항목이
--       전 언어로 열려야 하므로 루트 홈을 먼저 둔다). 없으면 NULL(사실 행은 0).
--    category(M09) = resolveCitationCategory index.ts:90 에서 Scope 행 카테고리를 뺀 순서(G-21 a):
--      1 override(app.citation_domain_override) → 2 공식 소셜 키 → 3 공식 도메인(ownedBrandOf owned.ts:108)
--      → 4 seed.json → 5 rules.ts ruleCategory :182 → 6 Other. category_src 는 그 순번.
--    owned_brand_bit = ownedBrandOf(skey) 브랜드 비트. competitor_brand_key = 카테고리가 Official (Competitor) 인 도메인의
--      competitorBrandOfDomain competitor-brand.ts:35(첫 라벨 정확 일치 → 긴 토큰 접두, 2자 이하·모호 토큰은 정확 일치만) 브랜드.
DROP TABLE IF EXISTS _cu;
CREATE TEMP TABLE _cu AS
SELECT url, host, nullif(regexp_replace(lower(pg_temp.js_trim(domain_label)), '^www\.', ''), '') AS dom, title, count(*) AS n
  FROM ing.citation WHERE url IS NOT NULL GROUP BY 1, 2, 3, 4;
DROP TABLE IF EXISTS _u;
CREATE TEMP TABLE _u AS
WITH h AS (SELECT DISTINCT ON (url) url, host FROM (SELECT url, host, sum(n) AS n FROM _cu WHERE host IS NOT NULL GROUP BY 1, 2) x ORDER BY url, n DESC, host),
     d AS (SELECT DISTINCT ON (url) url, dom FROM (SELECT url, dom, sum(n) AS n FROM _cu WHERE dom IS NOT NULL GROUP BY 1, 2) x ORDER BY url, n DESC, dom),
     t AS (SELECT DISTINCT ON (url) url, title FROM (SELECT url, title, sum(n) AS n FROM _cu WHERE title IS NOT NULL GROUP BY 1, 2) x ORDER BY url, n DESC, title),
     v AS (SELECT url, count(DISTINCT dom) AS dom_variants FROM _cu GROUP BY url)
SELECT v.url, sha256(convert_to(v.url, 'UTF8')) AS url_hash, pg_temp.cit_norm(v.url) AS url_norm, pg_temp.cit_base_norm(v.url) AS url_base_norm,
       coalesce(h.host, split_part(pg_temp.cit_norm(v.url), '/', 1)) AS host, d.dom AS domain, t.title, v.dom_variants
  FROM v LEFT JOIN h ON h.url = v.url LEFT JOIN d ON d.url = v.url LEFT JOIN t ON t.url = v.url;
-- URL 은 btree 행 한도(2,704바이트)를 넘는 값이 있다(2026-09-28 stg 실측 2,944바이트) → 유일성은 해시에, 조인은 hash 인덱스로
CREATE UNIQUE INDEX ON _u (url_hash);
CREATE INDEX ON _u USING hash (url);

-- 출처 그룹 키(경로 키 계산은 공식 소셜 게이트 도메인에만: official-social.ts:148 성능 게이트) · 전역 자사 항목
ALTER TABLE _u ADD COLUMN skey text, ADD COLUMN owner_key int2;
UPDATE _u SET skey = CASE WHEN domain IN (SELECT domain FROM _r_social) THEN pg_temp.group_key(domain, url) ELSE domain END;
UPDATE _u SET owner_key = pg_temp.owner_key_of(url_base_norm) WHERE coalesce(url_base_norm, '') <> '';

-- 출처 차원
DROP TABLE IF EXISTS _src;
CREATE TEMP TABLE _src AS
SELECT DISTINCT ON (skey) skey, domain, (skey <> domain) AS is_social FROM _u WHERE coalesce(skey, '') <> '' ORDER BY skey, domain;
ALTER TABLE _src ADD COLUMN d text, ADD COLUMN label text, ADD COLUMN nparts int, ADD COLUMN cat text, ADD COLUMN cat_src int2,
                 ADD COLUMN owned_brand text, ADD COLUMN comp_brand text;
UPDATE _src SET d = lower(pg_temp.js_trim(regexp_replace(lower(pg_temp.js_trim(skey)), '^www\.', ''))),
                label = split_part(domain, '.', 1), nparts = array_length(string_to_array(domain, '.'), 1);
UPDATE _src SET owned_brand = pg_temp.owned_brand_of(d);
UPDATE _src s SET (cat, cat_src) = (SELECT c.cat, c.src FROM pg_temp.category_of(s.skey) c);
UPDATE _src s SET comp_brand = pg_temp.competitor_brand_of(s.domain) WHERE s.cat = 'Official (Competitor)';

INSERT INTO rd.dim_source (source_key, skey, domain, is_social, category_key, category_src, owned_brand_bit, competitor_brand_key, rule_ver)
SELECT 0, '', '', false, (SELECT category_key FROM app.citation_category WHERE name = 'Other'), 6, 0, NULL, :rv;
INSERT INTO rd.dim_source (source_key, skey, domain, is_social, category_key, category_src, owned_brand_bit, competitor_brand_key, rule_ver)
SELECT row_number() OVER (ORDER BY s.skey)::int4, s.skey, s.domain, s.is_social, cc.category_key, s.cat_src,
       coalesce(ob.brand_bit, 0), bn.brand_key, :rv
  FROM _src s
  JOIN app.citation_category cc ON cc.name = s.cat
  LEFT JOIN app.brand ob ON ob.brand_code = s.owned_brand
  LEFT JOIN rd.dim_brand_name bn ON bn.bare = pg_temp.brand_bare(s.comp_brand);
SELECT setval(pg_get_serial_sequence('rd.dim_source', 'source_key'), greatest((SELECT max(source_key) FROM rd.dim_source), 1));

INSERT INTO rd.dim_url (url_key, url_hash, url, url_norm, url_base_norm, host, domain, source_key, owner_key, title, rule_ver)
OVERRIDING SYSTEM VALUE VALUES (0, '\x00'::bytea, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, :rv);
INSERT INTO rd.dim_url (url_key, url_hash, url, url_norm, url_base_norm, host, domain, source_key, owner_key, title, rule_ver)
SELECT row_number() OVER (ORDER BY u.url_hash)::int4, u.url_hash, u.url, u.url_norm, u.url_base_norm, u.host, u.domain,
       coalesce(s.source_key, 0), u.owner_key, u.title, :rv
  FROM _u u LEFT JOIN rd.dim_source s ON s.skey = u.skey AND u.skey <> '';
SELECT setval(pg_get_serial_sequence('rd.dim_url', 'url_key'), greatest((SELECT max(url_key) FROM rd.dim_url), 1));

-- ── 12. 단언·마감 ──────────────────────────────────────────────────────────
DO $a$ DECLARE v bigint; BEGIN
  -- 모든 답변 프롬프트가 dim_prompt 에 있다(없으면 사실 행 prompt_key 가 0 으로 떨어진다)
  SELECT count(DISTINCT a.prompt_id) INTO v FROM ing.answer a
   WHERE a.prompt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rd.dim_prompt p WHERE p.prompt_id = a.prompt_id);
  IF v <> 0 THEN RAISE EXCEPTION 'dim_prompt 누락 답변 프롬프트 %', v; END IF;
  -- 모든 run 프로젝트가 dim_project 에 있다
  SELECT count(*) INTO v FROM (SELECT DISTINCT scope_project_id FROM ing.run) r
   WHERE NOT EXISTS (SELECT 1 FROM rd.dim_project p WHERE p.scope_project_id = r.scope_project_id);
  IF v <> 0 THEN RAISE EXCEPTION 'dim_project 누락 run 프로젝트 %', v; END IF;
  -- 모든 언급·스탠스·ACR 엔티티가 dim_entity 에 있다
  SELECT count(*) INTO v FROM (SELECT entity_id FROM ing.mention UNION SELECT entity_id FROM ing.answer_stance
                                UNION SELECT entity_id FROM ing.acr_rollup_row) e
   WHERE NOT EXISTS (SELECT 1 FROM rd.dim_entity d WHERE d.entity_id = e.entity_id);
  IF v <> 0 THEN RAISE EXCEPTION 'dim_entity 누락 %', v; END IF;
  -- 표기 쌍의 표시명이 전부 dim_brand_name 에 있다
  SELECT count(*) INTO v FROM _bn_pair p WHERE p.bare <> '' AND NOT EXISTS (SELECT 1 FROM rd.dim_brand_name b WHERE b.bare = p.bare);
  IF v <> 0 THEN RAISE EXCEPTION 'dim_brand_name 누락 표시명 %', v; END IF;
  -- 인용 URL 전부 dim_url 에 있다
  SELECT count(DISTINCT c.url) INTO v FROM ing.citation c WHERE c.url IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM rd.dim_url u WHERE u.url_hash = sha256(convert_to(c.url, 'UTF8')));
  IF v <> 0 THEN RAISE EXCEPTION 'dim_url 누락 %', v; END IF;
  -- 루트 카탈로그 행 전부 catalog_entry 에 있다
  IF (SELECT count(*) FROM rd.catalog_entry) <> (SELECT count(*) FROM _root_cat) THEN RAISE EXCEPTION 'catalog_entry 행 수 불일치'; END IF;
END $a$;

-- 검증 요약(관찰용): 판정 분포
SELECT 'dim_project' AS t, surface::text AS k, count(*) AS n FROM rd.dim_project GROUP BY 2
UNION ALL SELECT 'dim_prompt.kind', kind, count(*) FROM rd.dim_prompt WHERE prompt_key <> 0 GROUP BY 2
UNION ALL SELECT 'dim_prompt.in_root_catalog', in_root_catalog::text, count(*) FROM rd.dim_prompt WHERE prompt_key <> 0 GROUP BY 2
UNION ALL SELECT 'web_unit.base_src', coalesce(base_src, '(none)'), count(*) FROM rd.web_unit GROUP BY 2
UNION ALL SELECT 'dim_brand_name.kind', kind::text, count(*) FROM rd.dim_brand_name GROUP BY 2
UNION ALL SELECT 'dim_source.category_src', category_src::text, count(*) FROM rd.dim_source GROUP BY 2
UNION ALL SELECT 'dim_url.owner_key', CASE WHEN owner_key IS NULL THEN 'none' ELSE 'set' END, count(*) FROM rd.dim_url GROUP BY 2
UNION ALL SELECT 'url.domain_variants>1', 'urls', count(*) FROM _u WHERE dom_variants > 1
ORDER BY 1, 2;

-- rd.web_report_prompt(DB-v2.16 P93, WU-7 WEBREG16): prompt_key 를 위에서 다시 발급했으므로(TRUNCATE rd.dim_prompt) 보고서 유닛 소속을
--   새 키로 다시 맞춘다(바뀐 행만, 정본 rd.refresh_web_report_prompt = 적재기 apply·website_catalog 재판정과 같은 함수). 안 하면 옛 키 행이
--   남아 엉뚱한 프롬프트가 보고서 모수에 든다. 패치 전 DB(함수 없음)는 건너뛴다.
DO $w$ BEGIN
  IF to_regprocedure('rd.refresh_web_report_prompt(int4[])') IS NOT NULL THEN
    PERFORM rd.refresh_web_report_prompt(NULL);
  END IF;
END $w$;
-- rd.web_target_url(DB-v2.20 P111, WU-12 ⑥ 미러 정의 타겟 URL 사전 해석): rd.dim_prompt·rd.dim_url 키를 위에서 다시 발급했으므로 같은 이유로
--   기대값으로 다시 맞춘다(정본 rd.refresh_web_target_url = 적재기 apply·website_catalog 재판정과 같은 함수). 패치 전 DB 는 건너뛴다.
DO $w$ BEGIN
  IF to_regprocedure('rd.refresh_web_target_url(int4[], int4[])') IS NOT NULL THEN
    PERFORM rd.refresh_web_target_url(NULL, NULL);
  END IF;
END $w$;

UPDATE ing.load SET status = 'committed', finished_at = clock_timestamp() WHERE load_id = :l30;
COMMIT;

ANALYZE rd.dim_engine, rd.dim_region, rd.dim_country, rd.dim_lang, rd.dim_project, rd.dim_taxon, rd.web_unit, rd.dim_prompt,
        rd.catalog_entry, rd.dim_brand_name, rd.dim_entity, rd.dim_source, rd.dim_url;
