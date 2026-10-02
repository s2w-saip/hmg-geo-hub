-- ============================================================================
-- seed-3x-common.sql : 빌더 B(seed-30·40) 공용 판정 함수·중간 표(세션 pg_temp 만, 영구 객체 없음)
-- 전제: seed-00-fn.sql(빌더 A: js_trim·norm_match·owned_prefix)·seed-3x-rules.sql 을 먼저 \ir.
-- 입력: app.*(판정 규칙 정본) + ing.mention·ing.answer_stance·ing.acr_rollup_row(표기 쌍). 쓰기 없음.
-- ============================================================================

-- ── 1. URL 정규화(0052 SQL 함수와 같은 식. 미러 url_norm·url_base_norm·url_host 의 정본)
--    lib/db/migrations/0052_scope_citations_url_norm.sql citation_url_norm / citation_url_base_norm / citation_url_host
CREATE OR REPLACE FUNCTION pg_temp.cit_norm(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $f$
SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(regexp_replace($1, '^\s+|\s+$', '', 'g')), '^https?://', ''), '^www\.', ''), '#.*$', ''), '&(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*', '', 'g'), '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*&', '?'), '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*$', ''), '/+$', '')
$f$;
CREATE OR REPLACE FUNCTION pg_temp.cit_base_norm(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $f$
SELECT rtrim(split_part(split_part(regexp_replace(regexp_replace(lower(btrim($1, E' \t\n\r\f\013')), '^https?://', ''), '^www\.', ''), '?', 1), '#', 1), '/')
$f$;

-- ── 2. 정규식 리터럴 이스케이프(escapeRegexLiteral hmg-brands 접두 규칙용, scope-aggregates.ts:323)
CREATE OR REPLACE FUNCTION pg_temp.rx_escape(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $f$
  SELECT regexp_replace(t, '([.*+?^${}()|\[\]\\])', '\\\1', 'g')
$f$;
-- POSIX_LEADING_TRIM lib/scope/text-trim.ts:(JS_TRIM_CHARS 선행 트림 클래스). seed-00-fn.sql js_trim 과 같은 문자 집합.
CREATE OR REPLACE FUNCTION pg_temp.rx_lead_trim() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT E'[\u0009\u000a\u000b\u000c\u000d                  　﻿]*'
$f$;

-- ── 3. 표시명 정본화: canonBrandNameSql scope-aggregates.ts:341 (BRAND_DISPLAY_ALIAS_ENTRIES 정확 일치, 트림 없음)
CREATE OR REPLACE FUNCTION pg_temp.canon_brand(t text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT coalesce((SELECT a.canonical_name FROM app.brand_display_alias a WHERE a.alias = t), t)
$f$;
-- bare 키: bareBrandNameSql scope-aggregates.ts:350 = lower(btrim(canon(x), JS_TRIM_CHARS))
--   표시 브랜드 키(rd.dim_brand_name.bare)는 pg_temp.name_key(정본 표시명)다. 기본 = 위 bare(대소문자·앞뒤 공백 접기).
--   현행 프로필 NAME(display_name_latin, 투영 스위치, 세션 GUC hgh.legacy_name = '1'): 키 = 정본 표시명 문자열 그대로(트림 뒤 빈 값만 '').
--     운영 생성기는 summary_brand_mentions 를 (brand_id, brand_name = canonBrandNameSql(COALESCE(n.brand, m.brand))) 로 접고
--     (hmg-geo 2670a16 lib/summary/generate/context.ts:134-145 brandExprs, load.ts:79-98 bg GROUP BY 1,2,3) 리더가 brand_name 으로
--     합산(summary-trend-aggregates.ts:966-999 GROUPING SETS (brand_name)). 대소문자만 다른 표기(Vivo·vivo)는 두 행, 표시명 = 그 문자열.
--     bare(소문자)는 판정에만 쓴다: 비경쟁 제외(bareBrandNameSql)·자사 비트(app.brand 코드). 호출자가 lower(js_trim(키)) 로 맞춘다.
--   적재기는 이 GUC 를 트랜잭션마다 프로필로 건다(ingest.common.rules.refresh_app_rules). 꺼짐이면 종전 식과 같다.
CREATE OR REPLACE FUNCTION pg_temp.name_key(n text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN n IS NULL THEN NULL
              WHEN current_setting('hgh.legacy_name', true) = '1' THEN CASE WHEN pg_temp.js_trim(n) = '' THEN '' ELSE n END
              ELSE lower(pg_temp.js_trim(n)) END
$f$;
CREATE OR REPLACE FUNCTION pg_temp.brand_bare(t text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT pg_temp.name_key(pg_temp.canon_brand(t))
$f$;

-- J1 접두 교정(canonRollupSql scope-aggregates.ts:291-296, HMG_BRAND_NAME_PREFIXES hmg-brands.ts:63): 표기가 선행 트림 뒤 3사 접두로 시작하고
--   바로 뒤가 영숫자가 아니면 그 브랜드 정본 id. 평가 순서 = app.brand_name_prefix.eval_order(Genesis → Hyundai → Kia), 대소문자 무시.
CREATE OR REPLACE FUNCTION pg_temp.hmg_prefix_id(disp text) RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT b.canonical_entity_id FROM app.brand_name_prefix p JOIN app.brand b ON b.brand_code = p.brand_code
   WHERE disp ~* ('^' || pg_temp.rx_lead_trim() || '(' || pg_temp.rx_escape(p.prefix) || ')([^[:alnum:]]|$)')
   ORDER BY p.eval_order LIMIT 1
$f$;
-- J3 경쟁 여부(excludeNonCompetitorBaresSql scope-aggregates.ts:437): bare ∉ 비경쟁 → 경쟁, bare-only 이름은 자기 표기 ~* 패턴이면 경쟁,
--   그 밖 비경쟁. 이름 없음(bare '')은 false.
CREATE OR REPLACE FUNCTION pg_temp.brand_competitive(bare text, disp text) RETURNS bool LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN coalesce(bare, '') = '' THEN false
              WHEN nc.name IS NULL THEN true
              WHEN nc.bare_only_pattern IS NOT NULL THEN coalesce(disp ~* nc.bare_only_pattern, false)
              ELSE false END
    FROM (SELECT 1) one LEFT JOIN app.non_competitor_name nc ON nc.name = bare
$f$;

-- ── 4. 엔티티 버전(E1 투영 오버레이, DB-v2.17) → 별칭 접기·명부. 버전마다 한 벌(ver 열).
--    4-0 버전 집합(_ecat_cfg·_ecat_vset). 기준 버전 dv = 세션 GUC hgh.ecat_ver(지정 버전: 미리보기·반영) → 활성 버전 → 1.
--        활성 버전도 지정도 없으면 legacy(= v1 이관 전): 규칙 원천이 기존 명부·별칭 표(app.entity_registry·entity_alias)이고 오버레이가 없다
--        (도입 전 동작 그대로, ver = 1 로 기록). 답변 버전 v(a) = coalesce(rd.cycle.ecat_ver(노출 때 고정), dv).
--        hgh.ecat_force = '1' 이면 고정을 무시하고 전부 dv(미리보기·전 기간 반영). 고정 버전은 rd.cycle 에서 읽고, 전량 재구축(seed-30 →
--        seed-40)이 rd.cycle 을 비우는 사이에는 seed-30 이 적재 원장(ing.load.scope_ref ecat_pins)에 남긴 값을 seed-40 이 _ecat_pin_extra 로 넘긴다.
--    4-1 규칙 표(버전별): _ecat_reg(명부 own·excluded 모양) · _ecat_ali(별칭) → _alias_map·_roster(ver, …).
--        legacy 는 기존 표, 그 밖은 app.ecat_registry_rows(ver)·ecat_alias_rows(ver)(E0: 활성 버전의 이 결과 = 기존 표, md5 단언).
--    4-2 행 오버레이 입력(버전별, legacy 는 빈 표): _ecat_x(제거·관계 덮어쓰기, 병합 대상의 제거·관계 포함) · _ecat_blk(차단 표면, 엔티티 한정
--        차단은 그 엔티티로 병합되는 원본에도 편다) · _ecat_add(추가 표면) · _ecat_hent(추가 표면 엔티티의 표기·롤업: 재매칭 언급 행 모양).
DROP VIEW IF EXISTS _meff;                                  -- seed-40 §5 의 유효 언급 뷰(아래 표에 기대므로 다시 만들기 전에 지운다)
CREATE TEMP TABLE IF NOT EXISTS _ecat_pin_extra (cycle_id uuid, ver int4);
DROP TABLE IF EXISTS _ecat_cfg;
CREATE TEMP TABLE _ecat_cfg AS
WITH act AS (SELECT max(ver) AS ver FROM app.ecat_version WHERE status = 'active'),
tgt AS (SELECT nullif(current_setting('hgh.ecat_ver', true), '')::int4 AS ver)
SELECT coalesce(tgt.ver, act.ver, 1) AS dv, (tgt.ver IS NULL AND act.ver IS NULL) AS legacy,
       coalesce(current_setting('hgh.ecat_force', true), '') = '1' AS force
  FROM act, tgt;
ANALYZE _ecat_cfg, _ecat_pin_extra;  -- 빈·작은 임시 표를 통계 없이 두면 추정 2,400행으로 계획이 부풀어 JIT 가 켜진다(로컬 실측 §6 0.004s → 0.37s)
DROP TABLE IF EXISTS _ecat_vset;
CREATE TEMP TABLE _ecat_vset AS
SELECT c.dv AS ver, c.legacy, true AS is_dv FROM _ecat_cfg c
UNION
SELECT p.ver, false, false
  FROM (SELECT DISTINCT ecat_ver::int4 AS ver FROM rd.cycle WHERE ecat_ver IS NOT NULL UNION SELECT ver FROM _ecat_pin_extra) p, _ecat_cfg c
 WHERE NOT c.force AND p.ver <> c.dv;
ANALYZE _ecat_vset;
DO $e$ DECLARE bad text; BEGIN
  SELECT string_agg(v.ver::text, ',') INTO bad FROM _ecat_vset v
   WHERE NOT v.legacy AND NOT EXISTS (SELECT 1 FROM app.ecat_version e WHERE e.ver = v.ver AND e.status <> 'discarded');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ECAT_VERSION_MISSING: 투영 버전 % 이 app.ecat_version 에 없다(폐기 포함)', bad; END IF;
  IF (SELECT legacy FROM _ecat_cfg) AND (SELECT count(*) FROM _ecat_vset) > 1 THEN
    RAISE EXCEPTION 'ECAT_VERSION_MISSING: 활성 버전이 없는데 rd.cycle.ecat_ver 고정 회차가 있다';
  END IF;
END $e$;

DROP TABLE IF EXISTS _ecat_reg;
CREATE TEMP TABLE _ecat_reg AS
SELECT v.ver, r.entity_id, r.role, r.brand_code FROM _ecat_vset v JOIN app.entity_registry r ON v.legacy
UNION ALL
SELECT v.ver, r.entity_id, r.role, r.brand_code FROM _ecat_vset v CROSS JOIN LATERAL app.ecat_registry_rows(v.ver) r WHERE NOT v.legacy;
DROP TABLE IF EXISTS _ecat_ali;
CREATE TEMP TABLE _ecat_ali AS
SELECT v.ver, a.alias_entity_id AS alias_id, a.canon_entity_id AS canon_id FROM _ecat_vset v JOIN app.entity_alias a ON v.legacy
UNION ALL
SELECT v.ver, a.alias_entity_id, a.canon_entity_id FROM _ecat_vset v CROSS JOIN LATERAL app.ecat_alias_rows(v.ver) a WHERE NOT v.legacy;
ANALYZE _ecat_reg, _ecat_ali;

--    별칭 엔티티 → 정본 엔티티: rollupCanonicalPairs hmg-brands.ts:279 (명부에서 파생) ∪ app.entity_alias(hmg-brands.ts:35 시드)
--    현행은 명부(entity_registry own, 없으면 SEED_ROSTER)의 행 중 이름이 3사로 풀리고 id 가 정본과 다른 것을 쌍으로 만든다.
--    app.entity_registry.brand_code 는 빌더 A 가 resolveHmgBrandName 으로 채웠다(seed-10 4-14). 버전의 병합(merge_into)이 별칭 행이다.
DROP TABLE IF EXISTS _alias_map;
CREATE TEMP TABLE _alias_map AS
SELECT DISTINCT ON (ver, alias_id) ver, alias_id, canon_id FROM (
  SELECT r.ver, r.entity_id AS alias_id, b.canonical_entity_id AS canon_id, 1 AS pri
    FROM _ecat_reg r JOIN app.brand b ON b.brand_code = r.brand_code
   WHERE r.role = 'own' AND b.canonical_entity_id IS NOT NULL AND r.entity_id <> b.canonical_entity_id
  UNION ALL
  SELECT ver, alias_id, canon_id, 2 FROM _ecat_ali
) x ORDER BY ver, alias_id, pri;
CREATE UNIQUE INDEX ON _alias_map (ver, alias_id);

-- 명부(진단용): trackedRollupIn scope-aggregates.ts:195 = 명부 id 집합. 행 수준 판정(현행)과 표시 브랜드 수준(G-20) 차이를 세는 데만 쓴다.
DROP TABLE IF EXISTS _roster;
CREATE TEMP TABLE _roster AS
SELECT DISTINCT ON (ver, entity_id) ver, entity_id, bit FROM (
  SELECT r.ver, r.entity_id,
         (CASE WHEN b.is_umbrella THEN 0 WHEN b.brand_bit IN (1, 2, 4) THEN b.brand_bit ELSE coalesce(p.brand_bit, 0) END)::int2 AS bit
    FROM _ecat_reg r JOIN app.brand b ON b.brand_code = r.brand_code LEFT JOIN app.brand p ON p.brand_code = b.parent_brand_code
   WHERE r.role = 'own'
  UNION ALL
  SELECT v.ver, b.canonical_entity_id, b.brand_bit FROM _ecat_vset v CROSS JOIN app.brand b
   WHERE b.canonical_entity_id IS NOT NULL AND b.brand_bit IN (1, 2, 4)
) x ORDER BY ver, entity_id;
CREATE UNIQUE INDEX ON _roster (ver, entity_id);

-- 4-2 행 오버레이 입력. 병합 원본(A → B)은 B 의 제거·관계를 따른다(체인 금지는 E0 트리거).
DROP TABLE IF EXISTS _ecat_ent;
CREATE TEMP TABLE _ecat_ent AS
SELECT e.ver, e.entity_id, e.origin, e.name, e.entity_type, e.role, e.merge_into, e.parent_brand_id
  FROM app.ecat_entity e JOIN _ecat_vset v ON v.ver = e.ver AND NOT v.legacy;
CREATE UNIQUE INDEX ON _ecat_ent (ver, entity_id);
ANALYZE _ecat_ent;
DROP TABLE IF EXISTS _ecat_x;
CREATE TEMP TABLE _ecat_x AS
SELECT e.ver, e.entity_id,
       (e.role = 'removed' OR coalesce(t.role = 'removed', false)) AS removed,
       coalesce(e.parent_brand_id, t.parent_brand_id) AS parent
  FROM _ecat_ent e LEFT JOIN _ecat_ent t ON t.ver = e.ver AND t.entity_id = e.merge_into
 WHERE e.role = 'removed' OR t.role = 'removed' OR e.parent_brand_id IS NOT NULL OR t.parent_brand_id IS NOT NULL;
CREATE UNIQUE INDEX ON _ecat_x (ver, entity_id);
DROP TABLE IF EXISTS _ecat_blk;
CREATE TEMP TABLE _ecat_blk AS
SELECT DISTINCT x.ver, x.entity_id, normalize(x.surface_norm, NFC) AS surface_norm FROM (
  SELECT s.ver, d.entity_id, d.surface_norm
    FROM app.ecat_surface s JOIN _ecat_vset v ON v.ver = s.ver AND NOT v.legacy JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id
   WHERE s.action = 'block'
  UNION ALL
  SELECT s.ver, e.entity_id, d.surface_norm
    FROM app.ecat_surface s JOIN _ecat_vset v ON v.ver = s.ver AND NOT v.legacy JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id
    JOIN _ecat_ent e ON e.ver = s.ver AND e.merge_into = d.entity_id
   WHERE s.action = 'block') x;
DROP TABLE IF EXISTS _ecat_add;
CREATE TEMP TABLE _ecat_add AS
SELECT s.ver, s.surface_id, d.entity_id
  FROM app.ecat_surface s JOIN _ecat_vset v ON v.ver = s.ver AND NOT v.legacy JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id
 WHERE s.action = 'add' AND d.entity_id IS NOT NULL;
CREATE UNIQUE INDEX ON _ecat_add (ver, surface_id);
-- 재매칭 언급 행 모양(버전 × 추가 표면 엔티티): 표기 = 버전 이름 → Scope 언급 최빈 표기, 유형 = 버전 유형 → Scope 최빈 유형 → Brand,
--   롤업 = 관계 덮어쓰기(모 브랜드) → Brand 면 자기 자신 → Scope 언급 최빈 롤업. 롤업 대상이 제거면 NULL(브랜드 귀속 없음). 제거 엔티티는 재매칭 안 함.
--   Scope 언급 집계(최빈값)는 버전 행에 값이 없을 때만 돈다(coalesce 는 앞 인자가 NULL 일 때만 뒤 부질의를 평가한다: 적재 트랜잭션마다
--   대형 엔티티 언급 전체를 훑지 않게). 하위 브랜드(예: Hyundai N 이 Hyundai 로 롤업)는 관계 덮어쓰기로 모 브랜드를 지정한다.
DROP TABLE IF EXISTS _ecat_hent;
CREATE TEMP TABLE _ecat_hent AS
WITH e AS (SELECT DISTINCT ver, entity_id FROM _ecat_add),
h AS (
  SELECT e.ver, e.entity_id, x.parent, coalesce(x.removed, false) AS removed,
         coalesce(t.name, (SELECT m.display_name FROM ing.mention m WHERE m.entity_id = e.entity_id AND m.display_name IS NOT NULL
                            GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1)) AS disp,
         coalesce(t.entity_type, (SELECT m.entity_type FROM ing.mention m WHERE m.entity_id = e.entity_id AND m.entity_type IS NOT NULL
                                   GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1), 'Brand') AS entity_type
    FROM e LEFT JOIN _ecat_ent t ON t.ver = e.ver AND t.entity_id = e.entity_id
    LEFT JOIN _ecat_x x ON x.ver = e.ver AND x.entity_id = e.entity_id),
h2 AS (
  SELECT h.*, coalesce(h.parent, CASE WHEN h.entity_type = 'Brand' THEN h.entity_id END,
                       (SELECT m.brand_rollup_entity_id FROM ing.mention m WHERE m.entity_id = h.entity_id AND m.brand_rollup_entity_id IS NOT NULL
                         GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1)) AS rollup0
    FROM h)
SELECT h.ver, h.entity_id, h.disp, h.entity_type, h.removed, (h.parent IS NOT NULL) AS ovr,
       CASE WHEN coalesce(r.removed, false) THEN NULL ELSE h.rollup0 END AS rollup
  FROM h2 h LEFT JOIN _ecat_x r ON r.ver = h.ver AND r.entity_id = h.rollup0;
CREATE UNIQUE INDEX ON _ecat_hent (ver, entity_id);
ANALYZE _ecat_x, _ecat_blk, _ecat_add, _ecat_hent;

-- ── 5. 롤업 대표 표기(names): ROLLUP_NAMES scope-aggregates.ts:236 (Brand 행, 라틴 우선 → 사전순, DB 기본 정렬)
--    현행 프로필 NAME(display_name_latin, 투영 스위치): 세션 GUC hgh.legacy_name = '1' 이면 사전순을 운영 DB 콜레이션(ICU en-US)으로 정한다
--    (운영 Supabase 기본 = ICU en-US, stg RDS = libc en_US: 'KGM' 대 'KG모빌리티' 순서가 반대). 꺼짐이면 CASE 가 NULL 이라 종전 정렬 그대로.
--    NAME 켜짐이면 표기 원천 = 지금 Brand 행 ∪ 롤업 대표 표기 원장 ing.entity_brand_name(DB-v2.26 P138: 원천에서 Brand 행이 사라진 엔티티도
--    운영 생성 때의 이름(Wahl·Sharp·Arrival)을 유지. 운영 names = 생성 시점 미러 Brand 행, scope-aggregates.ts:238-254).
--    적재기(ingest apply)는 같은 규칙을 queries.name_sql(프로필)로 탄다. 켜려면 시드 실행 전 PGOPTIONS='-c hgh.legacy_name=1'(적재기와 같은 값).
DROP TABLE IF EXISTS _names;
CREATE TEMP TABLE _names AS
SELECT DISTINCT ON (entity_id) entity_id, display_name AS brand
  FROM (SELECT DISTINCT entity_id, display_name FROM ing.mention WHERE entity_type = 'Brand' AND display_name IS NOT NULL
        UNION SELECT entity_id, display_name FROM ing.entity_brand_name WHERE current_setting('hgh.legacy_name', true) = '1') m
 ORDER BY entity_id, (display_name ~ '^[A-Za-z]') DESC,
          (CASE WHEN current_setting('hgh.legacy_name', true) = '1' THEN display_name END) COLLATE "en-US-x-icu", display_name;
CREATE UNIQUE INDEX ON _names (entity_id);

-- ── 6. 표기 쌍 판정 표: (자기 표기, 롤업 id) → rid·표시명·bare·경쟁 여부
--    원천 쌍: 언급(display_name, brand_rollup_entity_id; 롤업 NULL 행은 어떤 지표에도 안 들어가 제외, canonRollupSql NULL 보존
--    scope-aggregates.ts:307), 스탠스(brand_label, entity_id; aggregateAnswerStanceDistributionFromMirror :7401 의 투영),
--    ACR 롤업(entity_name, entity_id)·(entity_name, brand_rollup_entity_id)(acrIsOurs :9323 의 canonRollupSql 입력).
--    J1 rid  : canonRollupSql scope-aggregates.ts:263 = 접두 교정(표기가 3사 접두로 시작, app.brand_name_prefix eval_order 순,
--              hmg-brands.ts:63) → 별칭 id 접기(_alias_map) → 원 롤업 id
--    J2 표시명: rollupDisplayName scope-aggregates.ts:378 = canon(COALESCE(names[rid], 자기 표기))
--    J3 경쟁 : excludeNonCompetitorBaresSql scope-aggregates.ts:437 = bare ∉ 비경쟁 ∨ (bare-only 이름 ∧ 자기 표기 ~* 패턴)
--              (app.non_competitor_name, non-competitor-brands.ts:213·275). 이름 없음(bare '')은 false.
--    버전(E1): 쌍은 버전마다 한 벌(ver). 원천 = 원본 쌍 × 버전 ∪ 관계 덮어쓰기 쌍(ovr: 덮어쓴 롤업, 접두 교정 J1 을 건너뛴다 = 관리자가
--    지정한 모 브랜드가 표기 접두보다 우선) ∪ 재매칭 언급 쌍(_ecat_hent). 버전 규칙이 없으면(legacy·v1) 원본 쌍 1벌 = 도입 전 표와 같다.
--    사실 행은 (ver = 답변 버전, 표기, 롤업, ovr) 로 붙고, 차원(표시 브랜드 대표 표기 가중치·엔티티 표시 브랜드)은 기준 버전 dv 의 원본 쌍으로 붙는다.
DROP TABLE IF EXISTS _bn_pair;
CREATE TEMP TABLE _bn_pair AS
WITH src0 AS (
  SELECT DISTINCT display_name AS disp, brand_rollup_entity_id AS rollup FROM ing.mention WHERE brand_rollup_entity_id IS NOT NULL
  UNION SELECT DISTINCT brand_label, entity_id FROM ing.answer_stance
  UNION SELECT DISTINCT entity_name, entity_id FROM ing.acr_rollup_row
  UNION SELECT DISTINCT entity_name, brand_rollup_entity_id FROM ing.acr_rollup_row WHERE brand_rollup_entity_id IS NOT NULL
),
src AS (
  SELECT v.ver, s.disp, s.rollup, false AS ovr FROM src0 s CROSS JOIN _ecat_vset v
  UNION SELECT DISTINCT x.ver, m.display_name, x.parent, true FROM ing.mention m JOIN _ecat_x x ON x.entity_id = m.entity_id AND x.parent IS NOT NULL
  UNION SELECT DISTINCT x.ver, a.entity_name, x.parent, true FROM ing.acr_rollup_row a JOIN _ecat_x x ON x.entity_id = a.entity_id AND x.parent IS NOT NULL
  UNION SELECT h.ver, h.disp, h.rollup, h.ovr FROM _ecat_hent h WHERE h.rollup IS NOT NULL
),
pfx AS (   -- 표기 → 접두 교정 대상 브랜드의 정본 id (표기 단위로 1회만 평가)
  SELECT d.disp, pg_temp.hmg_prefix_id(d.disp) AS pfx_id FROM (SELECT DISTINCT disp FROM src WHERE disp IS NOT NULL) d
),
r AS (
  SELECT s.ver, s.disp, s.rollup, s.ovr,
         CASE WHEN s.ovr THEN coalesce(am.canon_id, s.rollup) ELSE coalesce(p.pfx_id, am.canon_id, s.rollup) END AS rid
    FROM src s LEFT JOIN pfx p ON p.disp = s.disp LEFT JOIN _alias_map am ON am.ver = s.ver AND am.alias_id = s.rollup
),
n AS (
  SELECT r.*, pg_temp.canon_brand(coalesce(nm.brand, r.disp)) AS name
    FROM r LEFT JOIN _names nm ON nm.entity_id = r.rid
),
b AS (SELECT n.*, coalesce(pg_temp.name_key(n.name), '') AS bare FROM n)
SELECT b.ver, b.disp, b.rollup, b.ovr, b.rid, b.name, b.bare,
       coalesce(ro.bit, 0::int2) AS rid_bit,
       pg_temp.brand_competitive(lower(pg_temp.js_trim(b.bare)), b.disp) AS competitive
  FROM b LEFT JOIN _roster ro ON ro.ver = b.ver AND ro.entity_id = b.rid;
-- 표시명은 md5 로 접어 색인(값 비교는 원문): 길이 보장 없는 Scope 표시명이 btree 2,704 바이트 상한을 넘지 않게(be/int3-longkey, 증분 _ig_pairs 와 같은 규칙)
CREATE UNIQUE INDEX ON _bn_pair (ver, md5(disp), rollup, ovr) NULLS NOT DISTINCT;
-- 해시 조인 가능한 등치 키(IS NOT DISTINCT FROM 은 해시·머지 조인이 안 돼 언급 행 수 × 쌍 수 중첩 루프가 된다)
ALTER TABLE _bn_pair ADD COLUMN dkey text, ADD COLUMN dnull bool;
UPDATE _bn_pair SET dkey = coalesce(disp, ''), dnull = (disp IS NULL);
CREATE UNIQUE INDEX ON _bn_pair (ver, md5(dkey), dnull, rollup, ovr);
CREATE INDEX ON _bn_pair USING hash (dkey);                     -- 원문 등치 조회(해시 색인은 키 길이 상한 없음)
ANALYZE _alias_map, _roster, _names, _bn_pair;

-- ── 7. 웹사이트 프롬프트 대표 행(언어·사이트 국가·사이트 브랜드 축의 원천): scope_prompt_id 당 1행, (file_seq, site_id) 순
--    현행 축 판정은 website_prompts ⋈ website_sites 에 대한 semi-join(langAxisPred scope-aggregates.ts:949,
--    websiteSiteGeoPred) 이라 행이 여럿이면 어느 행이든 걸린다. 여기서는 1행으로 굳힌다(한 프롬프트 = 한 유닛 계약, :8453).
DROP TABLE IF EXISTS _wp_pick;
CREATE TEMP TABLE _wp_pick AS
SELECT DISTINCT ON (wp.scope_prompt_id) wp.scope_prompt_id, wp.site_id, wp.file_seq, lower(nullif(wp.lang_code, '')) AS lang_code,
       s.country_code, s.brand_code, s.scope_project_id AS site_scope_project_id
  FROM app.website_prompt wp JOIN app.website_site s ON s.site_id = wp.site_id
 WHERE wp.scope_prompt_id IS NOT NULL
 ORDER BY wp.scope_prompt_id, wp.file_seq, wp.site_id;
CREATE UNIQUE INDEX ON _wp_pick (scope_prompt_id);
ANALYZE _wp_pick;

-- ── 8. ACR 롤업 행 이름·당사 판정(현행 aggregateAcrFromMirror scope-aggregates.ts:9317-9380)
--    표시명 = COALESCE(sync 가 푼 이름 entity_name, names[entity_id])(ACR_BRAND_NAME :9317). 현행은 표시 별칭 정본화가 없다:
--      키는 bare(= lower(js_trim(canon(이름))))로 dim_brand_name 에 붙인다(언급과 같은 사전, 별칭 표기가 합쳐지는 것은 A4 고지).
--    keep = excludeNonCompetitorBrandsSql(이름, 자기 표기 entity_name) :428 — 현행대로 정본화 없는 lower(btrim(이름)) 로 판정.
--    own_bit(행 수준) = acrIsOurs :9323 = canonRollupSql(롤업 id·entity_name) ∈ 명부 ∨ entity_id ∈ 명부 의 비트.
--    parent_bare = 제품 행의 소속 브랜드 = COALESCE(parent_name, names[brand_rollup_entity_id]) 의 bare(근거 미확인: 현행 ACR 제품 표시는
--      sync.ts:1180-1216 이 parent_brand 를 싣는다).
--    버전(E1): 버전마다 한 벌(ver). 제거 엔티티 행은 dropped(사실 행에서 뺀다, ACR 선택 수 co_* 는 재계산하지 않는다: 근사), 관계 덮어쓰기는
--    롤업 = 모 브랜드·parent_name 을 비워 모 브랜드 표기(names)로, 롤업 대상이 제거면 롤업·parent_name 을 비운다(모 브랜드 귀속 없음).
--    사실 행은 ACR prompt-run 의 버전(그 run 회차의 rd.cycle.ecat_ver, 없으면 dv)의 행으로 붙는다.
DROP TABLE IF EXISTS _acr_nm;
CREATE TEMP TABLE _acr_nm AS
WITH x0 AS (
  SELECT v.ver, a.prompt_run_id, a.entity_id, a.rollup_level, a.entity_name, a.parent_name, a.brand_rollup_entity_id AS rollup_raw,
         xe.parent, coalesce(xe.removed, false) AS dropped, coalesce(a.entity_name, n.brand) AS nm
    FROM ing.acr_rollup_row a CROSS JOIN _ecat_vset v
    LEFT JOIN _ecat_x xe ON xe.ver = v.ver AND xe.entity_id = a.entity_id
    LEFT JOIN _names n ON n.entity_id = a.entity_id),
x AS (
  SELECT x0.ver, x0.prompt_run_id, x0.entity_id, x0.rollup_level, x0.entity_name, x0.dropped, x0.nm, (x0.parent IS NOT NULL) AS ovr,
         CASE WHEN rx.entity_id IS NOT NULL THEN NULL ELSE coalesce(x0.parent, x0.rollup_raw) END AS brand_rollup_entity_id,
         CASE WHEN rx.entity_id IS NOT NULL OR x0.parent IS NOT NULL THEN NULL ELSE x0.parent_name END AS parent_name
    FROM x0 LEFT JOIN _ecat_x rx ON rx.ver = x0.ver AND rx.entity_id = coalesce(x0.parent, x0.rollup_raw) AND rx.removed),
rid AS (
  SELECT x.*, bp.rid
    FROM x LEFT JOIN _bn_pair bp ON bp.ver = x.ver AND bp.dkey = coalesce(x.entity_name, '') AND bp.dnull = (x.entity_name IS NULL)
                                AND bp.rollup = x.brand_rollup_entity_id AND bp.ovr = x.ovr)
SELECT r.ver, r.prompt_run_id, r.entity_id, r.rollup_level, r.dropped,
       coalesce(pg_temp.brand_bare(r.nm), '') AS bare,
       pg_temp.canon_brand(r.nm) AS canon_name,
       coalesce(pg_temp.brand_bare(coalesce(r.parent_name, pn.brand)), '') AS parent_bare,
       pg_temp.canon_brand(coalesce(r.parent_name, pn.brand)) AS parent_canon,
       pg_temp.brand_competitive(lower(pg_temp.js_trim(r.nm)), r.entity_name) AS keep,
       greatest(coalesce(ro1.bit, 0), coalesce(ro2.bit, 0))::int2 AS own_bit
  FROM rid r
  LEFT JOIN _names pn ON pn.entity_id = r.brand_rollup_entity_id
  LEFT JOIN _roster ro1 ON ro1.ver = r.ver AND ro1.entity_id = r.rid
  LEFT JOIN _roster ro2 ON ro2.ver = r.ver AND ro2.entity_id = r.entity_id;
CREATE UNIQUE INDEX ON _acr_nm (ver, prompt_run_id, entity_id, rollup_level);
ANALYZE _acr_nm;

-- ── 9. 인용 출처 판정 함수(seed-30 dim_source 와 패리티 검사가 같은 코드를 쓴다)
-- ruleCategory(d) rules.ts:182-209 (평가 순서 고정, gen_seed3x.py 가 원문 순서를 단언)
CREATE OR REPLACE FUNCTION pg_temp.rule_category(dm text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT CASE
    WHEN split_part(dm, '.', 1) IN (SELECT v FROM _r_set WHERE name = 'HMG_BRAND_LABEL')
      OR (split_part(dm, '.', 1) = 'genesis' AND array_length(string_to_array(dm, '.'), 1) >= 3) THEN 'Official (HMG)'
    WHEN dm IN (SELECT v FROM _r_set WHERE name = 'COMPETITOR_OFFICIAL') THEN 'Official (Competitor)'
    WHEN split_part(dm, '.', 1) IN (SELECT v FROM _r_set WHERE name = 'COMPETITOR_BRAND_LABEL') THEN 'Official (Competitor)'
    WHEN dm IN (SELECT v FROM _r_set WHERE name = 'WIKI_REFERENCE') OR dm ~ (SELECT rx FROM _r_rx WHERE name = 'WIKI_PATTERN') THEN 'Wiki & Reference'
    WHEN dm IN (SELECT v FROM _r_set WHERE name = 'COMMUNITY') THEN 'Community & Forums'
    WHEN dm IN (SELECT v FROM _r_set WHERE name = 'SOCIAL_VIDEO') THEN 'Social & Video'
    WHEN dm IN (SELECT v FROM _r_set WHERE name = 'BLOG_PLATFORMS') THEN 'Blogs & Reviews'
    WHEN dm IN (SELECT v FROM _r_set WHERE name = 'PUBLIC_ORGS') OR dm ~ (SELECT rx FROM _r_rx WHERE name = 'GOV_TLD') THEN 'Government & Public'
    WHEN dm IN (SELECT v FROM _r_set WHERE name = 'AWARD_CERT') THEN 'Award & Certification'
    WHEN dm IN (SELECT v FROM _r_set WHERE name = 'ACADEMIC_ORGS') OR dm ~ (SELECT rx FROM _r_rx WHERE name = 'ACADEMIC_TLD') THEN 'Academic & Research'
    WHEN dm ~ (SELECT rx FROM _r_rx WHERE name = 'INLINE_COMMUNITY') THEN 'Community & Forums'
    WHEN dm ~ (SELECT rx FROM _r_rx WHERE name = 'INLINE_DEALER') THEN 'Dealer & Marketplace'
    WHEN dm ~ (SELECT rx FROM _r_rx WHERE name = 'DEALER_BRAND_PREFIX') THEN 'Dealer & Marketplace'
    WHEN dm ~ (SELECT rx FROM _r_rx WHERE name = 'CONTAINED_BRAND')
         AND dm NOT IN (SELECT v FROM _r_set WHERE name = 'CONTAINED_BRAND_DENY') THEN 'Dealer & Marketplace'
  END
$f$;

-- ownedBrandOf(d) owned.ts:108-116: d(소문자·www 제거) = 공식 도메인 또는 '.공식 도메인' 으로 끝남, GEO_OWNED_DOMAINS 순서 첫 일치
CREATE OR REPLACE FUNCTION pg_temp.owned_brand_of(raw text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT o.brand_code FROM _r_owned_domain o, (SELECT regexp_replace(lower(raw), '^www\.', '') AS d) x
   WHERE x.d = o.domain OR right(x.d, length(o.domain) + 1) = '.' || o.domain ORDER BY o.ord LIMIT 1
$f$;
-- 카테고리(M09) = resolveCitationCategory index.ts:90 에서 Scope 행 카테고리를 뺀 순서(G-21 a), category_src 1..6(source.ts classificationSource)
--   입력 = 출처 그룹 키(citationGroupKey). normalize index.ts:57 = trim → lower → ^www. 제거 → trim.
CREATE OR REPLACE FUNCTION pg_temp.category_of(skey text, OUT cat text, OUT src int2) LANGUAGE sql STABLE AS $f$
  WITH n AS (SELECT pg_temp.js_trim(regexp_replace(lower(pg_temp.js_trim(skey)), '^www\.', '')) AS d)
  SELECT CASE WHEN ov.name IS NOT NULL THEN ov.name
              WHEN so.skey IS NOT NULL THEN 'Official (HMG)'
              WHEN pg_temp.owned_brand_of(n.d) IS NOT NULL THEN 'Official (HMG)'
              WHEN sd.category IS NOT NULL THEN sd.category
              ELSE coalesce(pg_temp.rule_category(n.d), 'Other') END,
         (CASE WHEN ov.name IS NOT NULL THEN 1 WHEN so.skey IS NOT NULL THEN 2 WHEN pg_temp.owned_brand_of(n.d) IS NOT NULL THEN 3
               WHEN sd.category IS NOT NULL THEN 4 WHEN pg_temp.rule_category(n.d) IS NOT NULL THEN 5 ELSE 6 END)::int2
    FROM n
    LEFT JOIN (SELECT o.domain, c.name FROM app.citation_domain_override o JOIN app.citation_category c ON c.category_key = o.category_key) ov
           ON ov.domain = n.d
    LEFT JOIN (SELECT DISTINCT lower(skey) AS skey FROM _r_social) so ON so.skey = n.d     -- isOfficialSocialKey official-social.ts:238(대소문자 무시)
    LEFT JOIN _r_cat_seed sd ON sd.domain = n.d
$f$;
-- competitorBrandOfDomain competitor-brand.ts:35-45: 첫 라벨(www 제거) 정확 일치 → 긴 토큰 접두(2자 이하·모호 토큰 제외)
CREATE OR REPLACE FUNCTION pg_temp.competitor_brand_of(dom text) RETURNS text LANGUAGE sql STABLE AS $f$
  WITH l AS (SELECT split_part(regexp_replace(lower(dom), '^www\.', ''), '.', 1) AS label)
  SELECT coalesce(
    (SELECT t.brand_name FROM app.competitor_domain_token t, l WHERE t.token = l.label),
    (SELECT t.brand_name FROM app.competitor_domain_token t, l
      WHERE length(t.token) > coalesce((SELECT (value ->> 'max_len_exact')::int FROM app.rule_param WHERE key = 'competitor_token_exact_only'), 2)
        AND t.token NOT IN (SELECT jsonb_array_elements_text(value -> 'tokens') FROM app.rule_param WHERE key = 'competitor_token_exact_only')
        AND starts_with(l.label, t.token)
      ORDER BY length(t.token) DESC, t.token LIMIT 1))
$f$;
-- citationGroupKey official-social.ts:225 (공식 소셜 계정이면 계정 키, 아니면 도메인). 경로 키 = citationPathKeyOf :193.
CREATE OR REPLACE FUNCTION pg_temp.group_key(dom text, url text) RETURNS text LANGUAGE sql STABLE AS $f$
  WITH d AS (SELECT regexp_replace(lower(pg_temp.js_trim(coalesce(dom, ''))), '^www\.', '') AS d),
       u AS (SELECT regexp_replace(lower(pg_temp.js_trim(coalesce(url, ''))), '^https?://', '') AS u),
       k AS (SELECT d.d, CASE WHEN strpos(u.u, '/') = 0 THEN d.d
                            ELSE d.d || replace(split_part(split_part(substr(u.u, strpos(u.u, '/')), '?', 1), '#', 1), '%40', '@') END AS k
               FROM d, u)
  SELECT CASE WHEN k.d = '' THEN '' ELSE coalesce(
           (SELECT s.skey FROM _r_social s
             WHERE s.domain = k.d
               AND CASE WHEN s.boundary THEN k.k = s.prefix OR starts_with(k.k, s.prefix || '/') ELSE starts_with(k.k, s.prefix) END
             ORDER BY s.acc_ord, s.m_ord LIMIT 1), k.d) END
    FROM k
$f$;
-- 전역 자사 항목(owner_key): 사이트 루트 홈(공유 글로벌 호스트 제외) 먼저 → 최장 base 접두(= | /… | .html, 호스트 일치). seed-30 §11 주석.
CREATE OR REPLACE FUNCTION pg_temp.owner_key_of(bn text) RETURNS int2 LANGUAGE sql STABLE AS $f$
  SELECT coalesce(
    (SELECT o.owner_key FROM app.owned_base o WHERE o.kind = 'root_home' AND o.prefix = bn AND o.host NOT IN (SELECT host FROM _r_shared_host) LIMIT 1),
    (SELECT o.owner_key FROM app.owned_base o
      WHERE o.kind = 'base' AND split_part(bn, '/', 1) = o.host
        AND (bn = o.prefix OR starts_with(bn, o.prefix || '/') OR bn = o.prefix || '.html')
      ORDER BY length(o.prefix) DESC, o.owner_key LIMIT 1))
   WHERE coalesce(bn, '') <> ''
$f$;

-- ── 10. 엔티티 버전 오버레이 함수(E1, DB-v2.17). 정본은 파이썬 app.core.ecat(표면 정규화 text.normalize_surface·겹침 제거
--    matcher.resolve_overlaps)이고, 이 둘은 투영 SQL 안에서 같은 결과를 내는 쌍둥이다(대조 시험 tests/core/test_ecat_sql_parity.py).
-- ecat_norm: 표면 정규형 = NFKC → 소문자(ICU, 문맥 무관 casefold 에 맞춰 ß → ss·어말 ς → σ) → 공백 연속을 한 칸 → 앞뒤 공백 자르기 → NFC.
--   원문 표면(ing.mention.surfaces·mention_occurrence.surface_text)을 app.ecat_surface_def.surface_norm 과 맞출 때만 쓰고, 비교는
--   양쪽 NFC 로 한다(_ecat_blk.surface_norm = NFC(정의 값)). 파이썬은 글자 묶음별 NFKC 라 반각 가나 탁점(ｶﾞ, U+FF9E 는 결합 부호가 아니다)이
--   분해형(カ + U+3099)으로 남고 SQL 전체 NFKC 는 합성형(ガ)이 된다: NFC 비교로 같은 표면으로 본다(대조 시험 test_ecat_sql_parity).
CREATE OR REPLACE FUNCTION pg_temp.ecat_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $f$
  SELECT normalize(btrim(regexp_replace(replace(replace(lower(normalize(t, NFKC) COLLATE "und-x-icu"), 'ß', 'ss'), 'ς', 'σ'), '\s+', ' ', 'g'), ' '), NFC)
$f$;
-- ecat_resolve: 한 턴의 재매칭 발생(ing.hub_match 행들을 펼친 배열: 시작·끝·surface_id·엔티티)과 Scope 기존 발생 구간(occupied)을 받아
--   남길 발생의 첨자(1부터)를 돌려준다. matcher.resolve_overlaps 와 같은 규칙: occupied 와 겹치면 버림 → (시작, -길이, surface_id) 순 탐욕,
--   직전 채택과 완전히 같은 구간이면 다른 엔티티일 때만 함께 남김, 채택된 것과 겹치면 버림.
CREATE OR REPLACE FUNCTION pg_temp.ecat_resolve(hs int[], he int[], hsid int[], hent uuid[], os int[], oe int[])
RETURNS SETOF int LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE i int; k int; ks int[] := '{}'; n int; lastk int; hit bool;
BEGIN
  FOR i IN
    SELECT x.i FROM generate_subscripts(hs, 1) AS x(i)
     WHERE NOT EXISTS (SELECT 1 FROM generate_subscripts(coalesce(os, '{}'::int[]), 1) AS y(j) WHERE hs[x.i] < oe[y.j] AND he[x.i] > os[y.j])
     ORDER BY hs[x.i], hs[x.i] - he[x.i], hsid[x.i]
  LOOP
    n := cardinality(ks);
    IF n > 0 THEN
      lastk := ks[n];
      IF hs[i] = hs[lastk] AND he[i] = he[lastk] THEN
        hit := false;
        FOREACH k IN ARRAY ks LOOP
          IF hs[k] = hs[i] AND he[k] = he[i] AND hent[k] = hent[i] THEN hit := true; EXIT; END IF;
        END LOOP;
        IF NOT hit THEN ks := ks || i; END IF;
        CONTINUE;
      END IF;
      hit := false;
      FOREACH k IN ARRAY ks LOOP
        IF hs[i] < he[k] AND he[i] > hs[k] THEN hit := true; EXIT; END IF;
      END LOOP;
      IF hit THEN CONTINUE; END IF;
    END IF;
    ks := ks || i;
  END LOOP;
  RETURN QUERY SELECT unnest(ks);
END $f$;
