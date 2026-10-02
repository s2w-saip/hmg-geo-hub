-- ── 4. 앱 데이터 표(mig_src → app, 1:1 매핑) ────────────────────────────────
-- 원칙: 원본 값 보존. FK 가 요구하는 자리만 시스템 사용자로 채운다. FK·CHECK 를 못 맞추는 행은 버리고 검증 표에 사유로 남긴다.

-- 4-1. app.project ← projects. kind: 표준 루트 카탈로그 = STANDARD_ROOT_PROJECT_ID(lib/db/repositories/standards.ts:26-27),
--      나머지 customer. created_by 는 FK(app.user_account) 라 시스템 사용자. projects.language 는 대상 열 없음(버림).
INSERT INTO app.project (project_id, kind, name, description, domain, brand_code, country_code, scope_project_id,
                         ga4_property_id, ai_engines, created_by, created_at, updated_at)
SELECT p.id,
       CASE WHEN p.id = '26751906-c175-485c-9e69-29fc68d0fdbb' THEN 'standard_root' ELSE 'customer' END,
       p.name, p.description, nullif(p.domain, ''), b.brand_code, p.country, p.scope_project_id,
       nullif(p.ga4_property_id, ''), p.ai_engines, current_setting('app.actor_id')::uuid, p.created_at, p.updated_at
  FROM mig_src.projects p LEFT JOIN app.brand b ON b.brand_code = p.brand;
-- 표준 루트의 scope project = 글로벌 루트(SCOPE_ROOT_PROJECT_ID, scripts/db/export-standard-answers.ts:22). 비어 있으면 채운다.
UPDATE app.project SET scope_project_id = 'be28fe15-c743-4a88-abb8-182b25602812'
 WHERE kind = 'standard_root' AND scope_project_id IS NULL;

-- 4-2. app.prompt_candidate ← prompt_candidates
INSERT INTO app.prompt_candidate (candidate_id, project_id, source, source_keyword, text, created_at)
SELECT c.id, c.project_id, c.source::text, c.source_keyword, c.text, c.created_at
  FROM mig_src.prompt_candidates c JOIN app.project p ON p.project_id = c.project_id;

-- 4-3. app.prompt ← prompts. 소속 프로젝트가 없는 행(원본에 FK 없음, 삭제된 프로젝트의 초안)은 FK 때문에 제외.
--      lang 은 CHECK (lang = upper(lang)) 라 upper. 없는 후보 id 는 NULL. needs_reanalysis 는 대상 열 없음(버림).
--      created_by·updated_by 는 FK 없는 열이라 원본 보존.
INSERT INTO app.prompt (prompt_id, project_id, candidate_id, text, prompt_type, category, brand_code, brand_presence,
                        list_type, depth1, depth2, depth3, depth4, funnel_stage, kind, lang, regions, scope_prompt_id,
                        status, created_by, created_at, updated_by, updated_at, deleted_at)
SELECT p.id, p.project_id, c.candidate_id, p.text, p.prompt_type::text, p.category, b.brand_code, p.brand_presence,
       p.list_type, p.depth1, p.depth2, p.depth3, p.depth4, p.funnel_stage, p.kind, upper(nullif(p.lang, '')), p.regions,
       p.scope_prompt_id, p.status::text, p.created_by, p.created_at, p.updated_by, p.updated_at, p.deleted_at
  FROM mig_src.prompts p
  JOIN app.project pr ON pr.project_id = p.project_id
  LEFT JOIN app.prompt_candidate c ON c.candidate_id = p.candidate_id
  LEFT JOIN app.brand b ON b.brand_code = p.brand;

-- 4-4. 사용자 정의 필드
INSERT INTO app.project_custom_field (field_id, project_id, label, archived, created_by, created_at)
SELECT f.id, f.project_id, f.label, f.archived, f.created_by, f.created_at
  FROM mig_src.project_custom_fields f JOIN app.project p ON p.project_id = f.project_id;
INSERT INTO app.prompt_custom_field_value (project_id, prompt_id, field_id, value)
SELECT pr.project_id, v.prompt_id, v.field_id, v.value
  FROM mig_src.prompt_custom_field_values v
  JOIN app.prompt pr ON pr.prompt_id = v.prompt_id
  JOIN app.project_custom_field f ON f.field_id = v.field_id AND f.project_id = pr.project_id;

-- 4-5. 엔진 이력(history_id 는 IDENTITY, changed_at 순으로 발급)
INSERT INTO app.project_engine_history (project_id, engines, changed_by, changed_at)
SELECT h.project_id, h.engines, h.changed_by, h.changed_at
  FROM mig_src.project_engine_history h JOIN app.project p ON p.project_id = h.project_id
 ORDER BY h.changed_at, h.id;

-- 4-6. 프로젝트 자사 base: base_norm = ownedBasePrefixFromUrl(base_url)(현행 서버가 판정에 쓰는 값, lib/scope/server.ts:881-883).
--      (project_id, base_norm) 충돌은 가장 먼저 만든 행을 남긴다. 정규화 결과가 빈 값이면 현행도 버리므로(filter(Boolean)) 제외.
INSERT INTO app.project_owned_base (project_id, base_url, base_norm, label, created_by, created_at)
SELECT DISTINCT ON (o.project_id, n.norm) o.project_id, o.base_url, n.norm, o.label, o.created_by, o.created_at
  FROM mig_src.project_owned_bases o
  JOIN app.project p ON p.project_id = o.project_id
  CROSS JOIN LATERAL (SELECT pg_temp.owned_prefix(o.base_url) AS norm) n
 WHERE n.norm <> ''
 ORDER BY o.project_id, n.norm, o.created_at, o.id;

-- 4-7. 프로젝트 타겟 URL: url_norm = normalizeUrlForMatch(url)(lib/scope/url-match.ts:29). 충돌은 먼저 만든 행.
INSERT INTO app.project_tracked_url (project_id, url, url_norm, label, created_by, created_at)
SELECT DISTINCT ON (u.project_id, n.norm) u.project_id, u.url, n.norm, u.label, u.created_by, u.created_at
  FROM mig_src.project_tracked_urls u
  JOIN app.project p ON p.project_id = u.project_id
  CROSS JOIN LATERAL (SELECT pg_temp.norm_match(u.url) AS norm) n
 WHERE n.norm <> ''
 ORDER BY u.project_id, n.norm, u.created_at, u.id;

-- 4-8. tracked_* (aliases NULL → '{}' : 대상 열 NOT NULL DEFAULT '{}')
INSERT INTO app.project_tracked_brand (project_id, canonical_name, aliases, created_at)
SELECT DISTINCT ON (t.project_id, t.canonical_name) t.project_id, t.canonical_name, coalesce(t.aliases, '{}'), t.created_at
  FROM mig_src.tracked_brands t JOIN app.project p ON p.project_id = t.project_id
 ORDER BY t.project_id, t.canonical_name, t.created_at;
INSERT INTO app.project_tracked_competitor (project_id, brand_name, aliases, notes, is_target, created_at)
SELECT DISTINCT ON (t.project_id, t.brand_name) t.project_id, t.brand_name, coalesce(t.aliases, '{}'), t.notes, t.is_target, t.created_at
  FROM mig_src.tracked_competitors t JOIN app.project p ON p.project_id = t.project_id
 ORDER BY t.project_id, t.brand_name, t.created_at;
-- 4-8b. 경쟁사 별칭 ∪ 같은 이름 tracked_brand 별칭(core 9 U9-5). 현행 설정 화면은 경쟁사 별칭 자리에 같은 이름(canonical_name =
--       brand_name)의 tracked_brands 별칭을 보여 줬다(setting/page.tsx:99-103). 이관은 두 표를 따로 옮겨 그 별칭이 API 에서 빠졌다.
--       규칙(core shared.clean_aliases 와 같게): 경쟁사 별칭은 원래 순서 그대로 두고, tracked_brand 별칭 중 앞뒤 공백을 뗀 값이 비지 않고
--       정본 이름(brand_name)과 다르며 경쟁사 별칭(공백 뗀 값)에 없는 것만 tracked_brand 순서대로 덧붙인다(중복 제거, 대소문자 구분).
--       재실행 안전(덧붙일 것이 없으면 갱신 0). 같은 식이 back/migration/fix-u95-competitor-aliases.sql(운영 1회 보정)에 있다.
UPDATE app.project_tracked_competitor c
   SET aliases = c.aliases || x.add
  FROM (SELECT c2.project_id, c2.brand_name,
               ARRAY(SELECT d.a FROM (SELECT DISTINCT ON (t.a) t.a, t.ord
                                        FROM (SELECT regexp_replace(u.v, '^[[:space:]]+|[[:space:]]+$', '', 'g') AS a, u.ord
                                                FROM unnest(b.aliases) WITH ORDINALITY AS u(v, ord)) t
                                       WHERE t.a <> '' AND t.a <> c2.brand_name
                                         AND NOT EXISTS (SELECT 1 FROM unnest(c2.aliases) AS e(v)
                                                          WHERE regexp_replace(e.v, '^[[:space:]]+|[[:space:]]+$', '', 'g') = t.a)
                                       ORDER BY t.a, t.ord) d
                     ORDER BY d.ord) AS add
          FROM app.project_tracked_competitor c2
          JOIN app.project_tracked_brand b ON b.project_id = c2.project_id AND b.canonical_name = c2.brand_name) x
 WHERE c.project_id = x.project_id AND c.brand_name = x.brand_name AND cardinality(x.add) > 0;
INSERT INTO app.project_tracked_vehicle (project_id, brand, model, segment, aliases, created_at)
SELECT DISTINCT ON (t.project_id, t.brand, t.model) t.project_id, t.brand, t.model, t.segment, coalesce(t.aliases, '{}'), t.created_at
  FROM mig_src.tracked_vehicles t JOIN app.project p ON p.project_id = t.project_id
 ORDER BY t.project_id, t.brand, t.model, t.created_at;
INSERT INTO app.project_tracked_keyword (keyword_id, project_id, term, country_code, created_at)
SELECT DISTINCT ON (t.project_id, t.term, t.country) t.id, t.project_id, t.term, t.country, t.created_at
  FROM mig_src.tracked_keywords t JOIN app.project p ON p.project_id = t.project_id
 ORDER BY t.project_id, t.term, t.country, t.created_at;

-- 4-9. 웹사이트 카탈로그(scope_project_id·scope_prompt_id 는 원본이 text 라 uuid 로 캐스트)
--      ⚠️ 설계 충돌: app.website_site.scope_project_id 는 UNIQUE 인데 현행은 한 scope project 를 여러 사이트가 공유한다
--      (제네시스 사우디 도시 사이트 SA-Dammam·SA-Jeddah·SA-Riyadh = scope project 1개, 0056_genesis_sa_city_sites).
--      공유 그룹에서 가장 먼저 만든 사이트만 scope_project_id 를 갖고 나머지는 NULL 로 둔다(사이트·유닛 구분은 website_prompt.file_seq 가
--      전역 유일이라 보존된다). 검증 표에 건수를 남긴다.
INSERT INTO app.website_site (site_id, brand_code, country_code, scope_project_id, created_at, updated_at)
SELECT s.id, s.brand, s.country_code,
       CASE WHEN row_number() OVER (PARTITION BY s.scope_project_id ORDER BY s.created_at, s.id) = 1
            THEN nullif(s.scope_project_id, '')::uuid END,
       s.created_at, s.updated_at
  FROM mig_src.website_sites s;
INSERT INTO app.website_prompt (website_prompt_id, site_id, file_seq, domain, lang_code, seq_no, target_url, prompt_text,
                                owned_base_url, scope_prompt_id, created_at, updated_at)
SELECT w.id, w.site_id, w.file_seq, w.domain, w.lang_code, w.seq_no, w.target_url, w.prompt_text,
       w.owned_base_url, nullif(w.scope_prompt_id, '')::uuid, w.created_at, w.updated_at
  FROM mig_src.website_prompts w JOIN app.website_site s ON s.site_id = w.site_id;

-- 4-10. 표준 키워드·출처(standard_prompts 는 대상 표가 없다: 카탈로그 정본은 표준 루트 프로젝트의 app.prompt)
INSERT INTO app.standard_keyword (keyword_id, term, source_type, brand_code, enabled, notes, created_by, created_at, updated_at)
SELECT k.id, k.term, k.source_type::text, b.brand_code, k.enabled, k.notes, k.created_by, k.created_at, k.updated_at
  FROM mig_src.standard_keywords k LEFT JOIN app.brand b ON b.brand_code = k.brand;
INSERT INTO app.standard_source (source_id, url, channel, brand_code, enabled, notes, created_by, created_at, updated_at)
SELECT s.id, s.url, s.channel::text, b.brand_code, s.enabled, s.notes, s.created_by, s.created_at, s.updated_at
  FROM mig_src.standard_sources s LEFT JOIN app.brand b ON b.brand_code = s.brand;

-- 4-11. GA4 (property_id 가 PK 라 원본의 property_id NULL 행은 app.ga4_market_pending 으로, DB-v2.9 P60·P61)
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status, verified_at, updated_by, updated_at)
SELECT DISTINCT ON (g.property_id) g.property_id, b.brand_code, g.country_code, g.status, g.verified_at, g.created_by, g.updated_at
  FROM mig_src.ga4_properties g LEFT JOIN app.brand b ON b.brand_code = g.brand
 WHERE g.property_id IS NOT NULL AND g.property_id <> ''
 ORDER BY g.property_id, g.updated_at DESC;
-- 속성 없는 시장(현행 브랜드·국가만 먼저 등록한 행). 알 수 없는 브랜드·ISO 2자 밖 국가·이미 속성이 매핑된 시장은 버린다.
INSERT INTO app.ga4_market_pending (brand_code, country_code, updated_by, updated_at)
SELECT DISTINCT ON (b.brand_code, upper(btrim(g.country_code))) b.brand_code, upper(btrim(g.country_code)), g.created_by, g.updated_at
  FROM mig_src.ga4_properties g JOIN app.brand b ON b.brand_code = g.brand
 WHERE (g.property_id IS NULL OR g.property_id = '') AND upper(btrim(g.country_code)) ~ '^[A-Z]{2}$'
   AND NOT EXISTS (SELECT 1 FROM app.ga4_property p WHERE p.brand_code = b.brand_code AND p.country_code = upper(btrim(g.country_code)))
 ORDER BY b.brand_code, upper(btrim(g.country_code)), g.updated_at DESC;
INSERT INTO app.ga4_tracked_event (property_id, event_name, updated_by, updated_at)
SELECT e.property_id, e.event_name, e.created_by, e.created_at
  FROM mig_src.ga4_tracked_events e JOIN app.ga4_property p ON p.property_id = e.property_id;

-- 4-12. 발행 리포트(0080 과 1:1, lib/db/schema.ts:1676·1721·1758)
INSERT INTO app.report_publication (id, slug, surface, brand_scope, volume, version, title, cycle_label, cycle_label_en, round_date,
  prev_round_date, asof_cur, asof_prev, published_on, engines, excluded_fs, bench_n, bench_n_all, src_cite, source_filename,
  source_sha256, manifest_verified, verify_note, sb_data_version, status, superseded_by, ingested_at)
SELECT id, slug, surface, brand_scope, volume, version, title, cycle_label, cycle_label_en, round_date,
  prev_round_date, asof_cur, asof_prev, published_on, engines, excluded_fs, bench_n, bench_n_all, src_cite, source_filename,
  source_sha256, manifest_verified, verify_note, sb_data_version, status, superseded_by, ingested_at
  FROM mig_src.report_publications;
INSERT INTO app.report_site_fact (publication_id, file_seq, brand, country_code, country_name, region_label, lang_code, lang_label,
  agency_status, in_headline_pool, target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den, owned_answers,
  monitored_answers, prompts, answers, prev_target_hit_prompts, prev_measured_prompts, prev_owned_prompts, prev_owned_prompts_den, raw)
SELECT publication_id, file_seq, brand, country_code, country_name, region_label, lang_code, lang_label,
  agency_status, in_headline_pool, target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den, owned_answers,
  monitored_answers, prompts, answers, prev_target_hit_prompts, prev_measured_prompts, prev_owned_prompts, prev_owned_prompts_den, raw
  FROM mig_src.report_site_facts;
INSERT INTO app.report_site_engine_fact (publication_id, file_seq, engine, target_hit_prompts, prev_target_hit_prompts)
SELECT publication_id, file_seq, engine, target_hit_prompts, prev_target_hit_prompts FROM mig_src.report_site_engine_facts;

-- 4-13. 인용 출처 오버라이드: 도메인은 CHECK(소문자·www 없음)에 맞춰 정규화, 카테고리 이름 → category_key(택소노미 표).
INSERT INTO app.citation_domain_override (domain, category_key, note, updated_by, updated_at)
SELECT DISTINCT ON (d.dom) d.dom, c.category_key, o.note, o.updated_by, o.updated_at
  FROM mig_src.citation_domain_overrides o
  CROSS JOIN LATERAL (SELECT regexp_replace(lower(btrim(o.domain)), '^www\.', '') AS dom) d
  JOIN app.citation_category c ON c.name = o.category
 ORDER BY d.dom, o.updated_at DESC;

-- 4-14. 엔티티 레지스트리: own 행의 brand_code = resolveHmgBrandName(name)(lib/scope/hmg-brands.ts:132-137:
--       3사 정확 일치 → 대소문자 무시 → HMG 표기 알리아스). 해소 못 한 own 행은 CHECK 가 막아 시드 전체가 실패한다(조용히 버리지 않음).
INSERT INTO app.entity_registry (entity_id, name, role, brand_code, updated_by, updated_at)
SELECT e.entity_id, e.name, e.role,
       CASE WHEN e.role = 'own' THEN coalesce(
         (SELECT b.brand_code FROM app.brand b WHERE b.brand_code IN ('Hyundai', 'Kia', 'Genesis') AND b.brand_code = e.name),
         (SELECT b.brand_code FROM app.brand b WHERE b.brand_code IN ('Hyundai', 'Kia', 'Genesis') AND lower(b.brand_code) = lower(btrim(e.name))),
         (SELECT a.canonical_name FROM app.brand_display_alias a
           WHERE a.alias = btrim(e.name) AND a.canonical_name IN ('Hyundai', 'Kia', 'Genesis'))) END,
       e.updated_by, e.updated_at
  FROM mig_src.entity_registry e;
-- 명부에 own 행이 하나도 없으면 현행은 SEED_ROSTER(hmg-brands.ts:145-148)로 폴백한다. 같은 의미를 행으로 둔다.
INSERT INTO app.entity_registry (entity_id, name, role, brand_code)
SELECT v.id::uuid, v.name, 'own', v.name
  FROM (VALUES ('00000000-0000-0000-0000-000000000301', 'Hyundai'), ('00000000-0000-0000-0000-000000000302', 'Kia'),
               ('00000000-0000-0000-0000-000000000304', 'Genesis'),
               ('e0348d5f-afe4-48e6-aa99-1dee566f2822', 'Hyundai'), ('c6dc2ca3-0fc9-42bc-b255-6fbfdb394e45', 'Hyundai'),
               ('65eabd79-6138-4851-8b58-8a9b0261b517', 'Hyundai'), ('ed4b8012-4a73-4174-9b43-4cb696934b25', 'Kia'),
               ('53a1ac82-6346-477d-9fb7-31d78b9248fa', 'Kia'), ('e21f66ad-9a28-46ab-8436-78ead06bd8f9', 'Kia'),
               ('fd2f4a33-8f9b-4a46-bfd0-62133d162d28', 'Genesis')) v(id, name)
 WHERE NOT EXISTS (SELECT 1 FROM app.entity_registry WHERE role = 'own')
ON CONFLICT (entity_id) DO NOTHING;

-- 4-15. 감사 원장(append-only, 원본 그대로. audit_id 는 IDENTITY 로 created_at 순 발급)
INSERT INTO app.prompt_audit_log (prompt_id, project_id, actor_id, actor_type, event_type, changes, batch_id, created_at)
SELECT prompt_id, project_id, actor_id, actor_type, event_type, changes, batch_id, created_at
  FROM mig_src.prompt_audit_logs ORDER BY created_at, id;
INSERT INTO app.member_audit_log (project_id, actor_id, target_user_id, action, context, created_at)
SELECT project_id, actor_id, target_user_id, action::text, context, created_at
  FROM mig_src.member_audit_logs ORDER BY created_at, id;

-- ── 5. 앱 표 단언 ───────────────────────────────────────────────────────────
DO $a$ DECLARE v int; BEGIN
  SELECT count(*) INTO v FROM app.project WHERE kind = 'standard_root' AND scope_project_id IS NOT NULL;
  IF v <> 1 THEN RAISE EXCEPTION '표준 루트 프로젝트 %', v; END IF;
  SELECT count(*) INTO v FROM app.entity_registry WHERE role = 'own' AND brand_code IS NULL;
  IF v <> 0 THEN RAISE EXCEPTION 'own 레지스트리 brand_code 미해소 %', v; END IF;
END $a$;
