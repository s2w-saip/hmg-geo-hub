-- 합성 ing·app 행(고객 데이터 아님). seed-30·40 판정 규칙별 테스트 케이스. 로컬 hmg-ddl-check-b 전용.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
SET TIME ZONE 'UTC';
BEGIN;
SET LOCAL app.actor_id = '5eed0000-0000-4000-8000-000000000001';
SET LOCAL app.actor_type = 'system';

-- ── 앱: 프로젝트·사이트·카탈로그 ────────────────────────────────────────────
INSERT INTO app.project (project_id, kind, name, domain, brand_code, country_code, scope_project_id, created_by) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'standard_root', 'root', NULL, NULL, 'KR', 'a0000000-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-000000000001'),
  ('c0000000-0000-4000-8000-000000000003', 'customer', 'cust', 'https://mybrand.example.com/', 'Hyundai', 'US', 'a0000000-0000-4000-8000-000000000003', '5eed0000-0000-4000-8000-000000000001');
INSERT INTO app.project_owned_base (project_id, base_url, base_norm, created_by) VALUES
  ('c0000000-0000-4000-8000-000000000003', 'https://mybrand.example.com/news/', 'mybrand.example.com/news', '5eed0000-0000-4000-8000-000000000001');
INSERT INTO app.project_tracked_url (project_id, url, url_norm, created_by) VALUES
  ('c0000000-0000-4000-8000-000000000003', 'https://mybrand.example.com/landing', 'mybrand.example.com/landing', '5eed0000-0000-4000-8000-000000000001');
INSERT INTO app.website_site (site_id, brand_code, country_code, scope_project_id) VALUES
  ('d0000000-0000-4000-8000-000000000002', 'Kia', 'DE', 'a0000000-0000-4000-8000-000000000002'),
  -- 대소문자 혼합 가상 지역 코드(0056_genesis_sa_city_sites 류). Scope 프로젝트 없음 → rd.dim_project 는 안 생기고 rd.dim_country 만 생긴다
  ('d0000000-0000-4000-8000-000000000005', 'Genesis', 'SA-Dammam', NULL);
INSERT INTO app.website_prompt (site_id, file_seq, domain, lang_code, seq_no, target_url, prompt_text, owned_base_url, scope_prompt_id) VALUES
  ('d0000000-0000-4000-8000-000000000002', 101, 'kia.com', 'de', 1, 'https://www.kia.com/de/modelle/ev9/', 'ev9?', 'https://www.kia.com/de/', 'b0000000-0000-4000-8000-000000000021'),
  ('d0000000-0000-4000-8000-000000000002', 101, 'kia.com', 'de', 2, 'https://shop.kia.de/angebote', 'deals?', 'https://www.kia.com/de/', 'b0000000-0000-4000-8000-000000000022'),
  ('d0000000-0000-4000-8000-000000000002', 102, 'kia.com', 'de', 1, 'https://www.kia.com/de/sub/x', 'sub?', 'https://www.kia.com/de/sub', 'b0000000-0000-4000-8000-000000000023');
-- 루트 카탈로그(트리거가 judgment_change 를 남긴다: 시드 무관)
INSERT INTO app.prompt (prompt_id, project_id, text, brand_code, brand_presence, list_type, depth1, depth2, funnel_stage, kind, scope_prompt_id, status, created_by, deleted_at) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'best suv', 'Hyundai', NULL, 'L1', 'D1', 'D2a', 'F1', 'single', 'b0000000-0000-4000-8000-000000000001', 'done', '5eed0000-0000-4000-8000-000000000001', NULL),
  ('c1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'common q', NULL, NULL, 'L1', 'D1', 'D2b', 'F2', 'single', 'b0000000-0000-4000-8000-000000000002', 'done', '5eed0000-0000-4000-8000-000000000001', NULL),
  ('c1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 'acr q', 'HMG', NULL, 'L2', 'D1', NULL, 'F1', 'acr', 'b0000000-0000-4000-8000-000000000003', 'done', '5eed0000-0000-4000-8000-000000000001', NULL),
  ('c1000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001', '현대 SUV 추천', 'Hyundai', 'branded', 'L1', 'D1', 'D2a', 'F1', 'single', 'b0000000-0000-4000-8000-000000000004', 'done', '5eed0000-0000-4000-8000-000000000001', NULL),
  ('c1000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'deleted row', 'Kia', NULL, 'L1', 'D1', NULL, 'F1', 'single', 'b0000000-0000-4000-8000-000000000005', 'done', '5eed0000-0000-4000-8000-000000000001', now()),
  ('c1000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000001', 'us only', 'Kia', NULL, 'L1', 'D1', NULL, 'F2', 'single', 'b0000000-0000-4000-8000-000000000006', 'done', '5eed0000-0000-4000-8000-000000000001', NULL),
  -- 같은 scope_prompt_id(SP1) 의 두 번째 카탈로그 행(Genesis): cat_mask = 1|4 = 5
  ('c1000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000001', 'best suv (G)', 'Genesis', NULL, 'L1', 'D1', 'D2a', 'F1', 'single', 'b0000000-0000-4000-8000-000000000001', 'done', '5eed0000-0000-4000-8000-000000000001', NULL),
  -- 고객 프로젝트 프롬프트
  ('c3000000-0000-4000-8000-000000000031', 'c0000000-0000-4000-8000-000000000003', 'cust q', NULL, NULL, NULL, NULL, NULL, 'F9', 'single', 'b0000000-0000-4000-8000-000000000031', 'done', '5eed0000-0000-4000-8000-000000000001', NULL);
INSERT INTO app.citation_domain_override (domain, category_key, note) VALUES ('example.org', 5, 'test override');
INSERT INTO app.report_publication (id, slug, surface, brand_scope, version, round_date, source_filename, source_sha256, sb_data_version, status)
VALUES ('c9000000-0000-4000-8000-000000000001', 'rep-0918', 'website', 'all', 'v1', '2026-09-18', 'x.xlsx', 'deadbeef', 'v', 'active');
INSERT INTO app.report_site_fact (publication_id, file_seq, brand, country_code, lang_code, in_headline_pool, target_hit_prompts, measured_prompts,
                                  owned_prompts, owned_prompts_den, raw)
VALUES ('c9000000-0000-4000-8000-000000000001', 101, 'Kia', 'DE', 'de', true, 7, 10, 8, 10, '{}'),
       -- 같은 사이트 두 번째 유닛(102, 웹 유닛 있음) · 다른 나라 유닛(301 FR, 이 DB 에 웹 유닛 없음) · 다른 브랜드 유닛(401 Hyundai DE, 웹 유닛 없음)
       ('c9000000-0000-4000-8000-000000000001', 102, 'Kia', 'DE', 'de', true, 3, 5, 4, 5, '{}'),
       ('c9000000-0000-4000-8000-000000000001', 301, 'Kia', 'FR', 'fr', true, 9, 10, 9, 10, '{}'),
       ('c9000000-0000-4000-8000-000000000001', 401, 'Hyundai', 'DE', 'de', true, 1, 10, 1, 10, '{}');
-- 두 번째 발행(2026-09-25): 대소문자 혼합 가상 지역 국가 코드의 발행 유닛(웹 유닛 102 = 사이트 프로젝트 안). 검증 N2 회귀
INSERT INTO app.report_publication (id, slug, surface, brand_scope, version, round_date, source_filename, source_sha256, sb_data_version, status)
VALUES ('c9000000-0000-4000-8000-000000000002', 'rep-0925', 'website', 'all', 'v1', '2026-09-25', 'y.xlsx', 'cafebabe', 'v', 'active');
INSERT INTO app.report_site_fact (publication_id, file_seq, brand, country_code, lang_code, in_headline_pool, target_hit_prompts, measured_prompts,
                                  owned_prompts, owned_prompts_den, raw)
VALUES ('c9000000-0000-4000-8000-000000000002', 102, 'Kia', 'SA-Dammam', 'ar', true, 2, 4, 3, 4, '{}');

-- ── ing: 원장·run·답변 ─────────────────────────────────────────────────────
INSERT INTO ing.load (load_id, kind, rule_ver, status) OVERRIDING SYSTEM VALUE VALUES (1, 'seed', 1, 'committed');
SELECT setval(pg_get_serial_sequence('ing.load', 'load_id'), 1);
DO $l$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ing.answer','ing.mention','ing.mention_occurrence','ing.answer_stance','ing.citation'] LOOP
    PERFORM rd.ensure_month_leaf(t::regclass, '2026-09-01');
  END LOOP; END $l$;
INSERT INTO ing.sync_cursor (scope_project_id, surface) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'global'), ('a0000000-0000-4000-8000-000000000002', 'website'),
  ('a0000000-0000-4000-8000-000000000003', 'project');
INSERT INTO ing.prompt (scope_prompt_id, scope_project_id, text, lang, regions, kind) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'best suv', 'EN', NULL, 'single'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'common q', 'EN', '{}', 'single'),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'acr q', 'EN', NULL, 'acr'),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', '현대 SUV 추천', 'KO', NULL, 'single'),
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'us only', 'EN', '{US}', 'single'),
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'not in catalog', 'EN', NULL, 'single'),
  ('b0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000002', 'ev9?', 'DE', NULL, 'single'),
  ('b0000000-0000-4000-8000-000000000022', 'a0000000-0000-4000-8000-000000000002', 'deals?', 'DE', NULL, 'single'),
  ('b0000000-0000-4000-8000-000000000023', 'a0000000-0000-4000-8000-000000000002', 'sub?', 'DE', NULL, 'single'),
  ('b0000000-0000-4000-8000-000000000031', 'a0000000-0000-4000-8000-000000000003', 'cust q', 'EN', NULL, 'single');
INSERT INTO ing.run (run_id, run_key, scope_project_id, run_month, status, total_jobs, started_at, cycle_anchor_at, sync_state) OVERRIDING SYSTEM VALUE VALUES
  ('e0000000-0000-4000-8000-000000000001', 1, 'a0000000-0000-4000-8000-000000000001', '2026-09-01', 'completed', 14, '2026-09-14 00:30+00', '2026-09-14 00:30+00', 'loaded'),
  ('e0000000-0000-4000-8000-000000000002', 2, 'a0000000-0000-4000-8000-000000000001', '2026-09-01', 'failed', 1, '2026-09-14 00:40+00', '2026-09-14 00:30+00', 'loaded'),
  ('e0000000-0000-4000-8000-000000000003', 3, 'a0000000-0000-4000-8000-000000000001', '2026-09-01', 'completed', 1, '2026-09-07 00:30+00', '2026-09-07 00:30+00', 'loaded'),
  ('e0000000-0000-4000-8000-000000000005', 5, 'a0000000-0000-4000-8000-000000000001', '2026-09-01', 'partial_failed', 2, '2026-09-21 00:30+00', '2026-09-21 00:30+00', 'loaded'),
  ('e0000000-0000-4000-8000-000000000021', 21, 'a0000000-0000-4000-8000-000000000002', '2026-09-01', 'completed', 2, '2026-09-18 00:30+00', '2026-09-18 00:30+00', 'loaded'),
  ('e0000000-0000-4000-8000-000000000031', 31, 'a0000000-0000-4000-8000-000000000003', '2026-09-01', 'completed', 1, '2026-09-20 05:00+00', NULL, 'loaded');
INSERT INTO ing.cycle (cycle_id, cyc_key, surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status, closed_by, closed_at,
                       expected_units, completed_units, completed_answers, gap_answers, fleet_visible, view_anchor_at, hidden_scope, hidden_reason, hidden_at, origin)
OVERRIDING SYSTEM VALUE VALUES
  ('f0000000-0000-4000-8000-000000000010', 10, 'global', 'a0000000-0000-4000-8000-000000000001', '2026-09-07 00:30+00', 'scope', '2026-09-07', '2026-09-07', 'published', 'next_anchor', '2026-09-14 00:30+00', 1, 1, 1, 0, true, '2026-09-08 15:00+00', NULL, NULL, NULL, 'summary_cycles'),
  ('f0000000-0000-4000-8000-000000000011', 11, 'global', 'a0000000-0000-4000-8000-000000000001', '2026-09-14 00:30+00', 'scope', '2026-09-14', '2026-09-14', 'published', 'next_anchor', '2026-09-21 00:30+00', 10, 9, 12, 3, true, '2026-09-15 15:00+00', NULL, NULL, NULL, 'summary_cycles'),
  ('f0000000-0000-4000-8000-000000000012', 12, 'global', 'a0000000-0000-4000-8000-000000000001', '2026-09-21 00:30+00', 'scope', '2026-09-21', '2026-09-21', 'open', NULL, NULL, NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, NULL, 'summary_cycles'),
  ('f0000000-0000-4000-8000-000000000021', 21, 'website', 'a0000000-0000-4000-8000-000000000002', '2026-09-18 00:30+00', 'scope', '2026-09-18', '2026-09-18', 'published', 'complete', '2026-09-19 00:00+00', 2, 2, 2, 0, true, '2026-09-18 15:00+00', 'citations', 'operator', '2026-09-20 00:00+00', 'summary_cycles'),
  ('f0000000-0000-4000-8000-000000000031', 31, 'project', 'a0000000-0000-4000-8000-000000000003', '2026-09-20 05:00+00', 'derived', '2026-09-20', '2026-09-20', 'open', NULL, NULL, NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, NULL, 'loader');
INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011', 'scope'),
  ('e0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000011', 'scope'),
  ('e0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000010', 'scope'),
  ('e0000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000012', 'scope'),
  ('e0000000-0000-4000-8000-000000000021', 'f0000000-0000-4000-8000-000000000021', 'scope'),
  ('e0000000-0000-4000-8000-000000000031', 'f0000000-0000-4000-8000-000000000031', 'derived');

-- jobs: (answer_key, run, prompt, target, region, status, measured_at, analysis_status, n_mentions, n_citations)
CREATE TEMP TABLE _j (k int, run text, p text, tgt text, reg text, st text, mat timestamptz, ast text, nm int, nc int) ON COMMIT DROP;
INSERT INTO _j VALUES
  ( 1, '01', '01', 'chatgpt',  'US', 'completed', '2026-09-14 01:00+00', NULL,        6, 10),
  ( 2, '01', '01', 'gemini',   'US', 'completed', '2026-09-14 02:00+00', NULL,        3, 0),
  ( 3, '01', '04', 'chatgpt',  'US', 'completed', '2026-09-14 01:00+00', NULL,        2, 0),
  ( 4, '01', '04', 'chatgpt',  'KR', 'completed', '2026-09-14 01:00+00', NULL,        0, 0),
  ( 5, '01', '06', 'gemini',   'DE', 'completed', '2026-09-14 01:00+00', NULL,        0, 1),
  ( 6, '01', '07', 'chatgpt',  'US', 'completed', '2026-09-14 01:00+00', NULL,        0, 0),
  ( 7, '01', '01', 'chatgpt',  'ID', 'completed', '2026-09-14 01:00+00', NULL,        0, 0),
  ( 8, '01', '01', 'deepseek', 'US', 'completed', '2026-09-14 01:00+00', NULL,        0, 0),
  ( 9, '01', '01', 'chatgpt',  'US', 'completed', '2026-09-14 05:00+00', 'failed',    0, 0),
  (10, '01', '03', 'chatgpt',  'US', 'completed', '2026-09-14 03:00+00', NULL,        0, 0),
  (11, '01', '03', 'chatgpt',  'US', 'completed', '2026-09-14 03:10+00', NULL,        0, 0),
  (12, '01', '03', 'chatgpt',  'US', 'completed', '2026-09-14 03:20+00', 'completed', 1, 0),
  (13, '01', '01', 'chatgpt',  'US', 'running',   NULL,                  NULL,        0, 0),
  (14, '01', '01', 'gemini',   'US', 'completed', '2026-09-14 02:30+00', NULL,        0, 0),
  (15, '02', '01', 'chatgpt',  'US', 'completed', '2026-09-14 01:30+00', NULL,        0, 0),
  (16, '03', '01', 'chatgpt',  'US', 'completed', '2026-09-07 01:00+00', NULL,        0, 0),
  (17, '05', '01', 'chatgpt',  'US', 'completed', '2026-09-21 01:00+00', NULL,        0, 0),
  (18, '05', '02', 'gemini',   'US', 'completed', '2026-09-21 01:00+00', NULL,        0, 0),
  (21, '21', '21', 'chatgpt',  'DE', 'completed', '2026-09-18 01:00+00', NULL,        1, 3),
  (22, '21', '23', 'gemini',   'DE', 'completed', '2026-09-18 01:00+00', NULL,        0, 1),
  (31, '31', '31', 'chatgpt',  'US', 'completed', '2026-09-20 06:00+00', NULL,        0, 4);
INSERT INTO ing.answer_key_map (job_id, answer_key, run_month) OVERRIDING SYSTEM VALUE
SELECT ('90000000-0000-4000-8000-0000000000' || lpad(k::text, 2, '0'))::uuid, k, '2026-09-01' FROM _j;
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions, n_citations,
                        content_hash, load_id)
SELECT '2026-09-01', ('90000000-0000-4000-8000-0000000000' || lpad(k::text, 2, '0'))::uuid, k,
       ('e0000000-0000-4000-8000-0000000000' || run)::uuid, ('b0000000-0000-4000-8000-0000000000' || p)::uuid, tgt, reg, st, mat, ast, nm, nc, '\x00', 1
  FROM _j;
INSERT INTO ing.answer_drop (job_id, reason) VALUES ('90000000-0000-4000-8000-000000000014', 'test drop');
INSERT INTO ing.answer_anchor_pin (job_id, anchor, reason) VALUES ('90000000-0000-4000-8000-000000000017', '2026-09-07', 'test pin');

-- 언급: (answer_key, ord, entity_id, display_name, entity_type, rollup, mc, pos, neu, neg, mix, avg_position, t_mention)
CREATE TEMP TABLE _m (k int, o int, e uuid, dn text, et text, ro uuid, mc int, sp int, sn int, sg int, sm int, ap real, tm int) ON COMMIT DROP;
INSERT INTO _m VALUES
  (1, 1, '00000000-0000-0000-0000-000000000301', 'Hyundai',       'Brand',   '00000000-0000-0000-0000-000000000301', 3, 2, 1, 0, 0, 2.0, 3),
  (1, 2, '71000000-0000-4000-8000-000000000001', 'Toyota',        'Brand',   '71000000-0000-4000-8000-000000000001', 2, 0, 1, 1, 0, 1.0, 2),
  (1, 3, '71000000-0000-4000-8000-000000000002', 'TOYOTA',        'Brand',   '71000000-0000-4000-8000-000000000002', 1, 0, 0, 0, 0, 3.0, 1),
  (1, 4, '71000000-0000-4000-8000-000000000003', 'Apple',         'Brand',   '71000000-0000-4000-8000-000000000003', 1, 0, 0, 0, 0, 0.5, 1),
  (1, 5, '71000000-0000-4000-8000-000000000004', 'Hyundai Creta', 'Product', '71000000-0000-4000-8000-000000000005', 1, 1, 0, 0, 0, 1.5, 1),
  (1, 6, '71000000-0000-4000-8000-000000000008', 'safety',        'Feature', NULL,                                   5, 0, 0, 0, 0, NULL, 0),
  (2, 1, 'ed4b8012-4a73-4174-9b43-4cb696934b25', '기아',          'Brand',   'ed4b8012-4a73-4174-9b43-4cb696934b25', 2, 1, 0, 0, 1, 1.0, 2),
  (2, 2, '71000000-0000-4000-8000-000000000007', 'Smart Fortwo',  'Product', '71000000-0000-4000-8000-000000000006', 1, 0, 0, 0, 0, 2.0, 1),
  (2, 3, '71000000-0000-4000-8000-000000000006', 'smart',         'Brand',   '71000000-0000-4000-8000-000000000006', 1, 0, 0, 0, 0, 3.0, 1),
  (3, 1, '00000000-0000-0000-0000-000000000302', 'Kia',           'Brand',   '00000000-0000-0000-0000-000000000302', 1, 1, 0, 0, 0, 1.0, 1),
  (3, 2, '71000000-0000-4000-8000-000000000005', 'Tata',          'Brand',   '71000000-0000-4000-8000-000000000005', 1, 0, 0, 0, 0, 2.0, 1),
  (12, 1, '00000000-0000-0000-0000-000000000301', 'Hyundai',      'Brand',   '00000000-0000-0000-0000-000000000301', 1, 1, 0, 0, 0, 1.0, 1),
  (21, 1, '00000000-0000-0000-0000-000000000302', 'Kia',          'Brand',   '00000000-0000-0000-0000-000000000302', 1, 0, 1, 0, 0, 1.0, 1);
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, sentiment_positive, sentiment_neutral,
                         sentiment_negative, sentiment_mixed, avg_position, brand_rollup_entity_id, type_mention)
SELECT '2026-09-01', ('90000000-0000-4000-8000-0000000000' || lpad(k::text, 2, '0'))::uuid, o, e, dn, et, mc, sp, sn, sg, sm, ap, ro, tm FROM _m;

INSERT INTO ing.answer_stance (run_month, job_id, turn_index, entity_id, brand_label, stance) VALUES
  ('2026-09-01', '90000000-0000-4000-8000-000000000001', 0, '00000000-0000-0000-0000-000000000301', 'Hyundai', 'positive'),
  ('2026-09-01', '90000000-0000-4000-8000-000000000001', 1, '00000000-0000-0000-0000-000000000301', 'Hyundai', 'negative'),
  ('2026-09-01', '90000000-0000-4000-8000-000000000001', 0, '71000000-0000-4000-8000-000000000001', 'Toyota', 'neutral'),
  ('2026-09-01', '90000000-0000-4000-8000-000000000002', 0, 'ed4b8012-4a73-4174-9b43-4cb696934b25', '기아', 'mixed');

-- 인용: (answer_key, ord, url, host, domain_label)
CREATE TEMP TABLE _c (k int, o int, url text, host text, dom text) ON COMMIT DROP;
INSERT INTO _c VALUES
  (1, 1, 'https://www.hyundai.com/au/en/cars/suv?utm_source=x', 'hyundai.com', 'hyundai.com'),
  (1, 2, 'https://www.reddit.com/r/cars', 'reddit.com', 'reddit.com'),
  (1, 3, 'https://www.linkedin.com/posts/hyundai-motor-group_abc-123', 'linkedin.com', 'linkedin.com'),
  (1, 4, 'https://www.reddit.com/r/suv', 'reddit.com', 'reddit.com'),
  (1, 5, 'not a url', NULL, NULL),
  (1, 6, 'https://example.org/x', 'example.org', 'example.org'),
  (1, 7, 'https://caranddriver.com/review', 'caranddriver.com', 'caranddriver.com'),
  (1, 8, 'https://foo-bar.xyz/a', 'foo-bar.xyz', 'foo-bar.xyz'),
  (1, 9, 'https://www.hyundaiusa.com/?x=1', 'hyundaiusa.com', 'hyundaiusa.com'),
  (1, 10, 'https://worldwide.kia.com/en/', 'worldwide.kia.com', 'kia.com'),
  (5, 1, 'https://bmwusa.com/x3', 'bmwusa.com', 'bmwusa.com'),
  (21, 1, 'https://www.kia.com/de/modelle/ev9/?utm_campaign=x', 'kia.com', 'kia.com'),
  (21, 2, 'https://www.kia.com/de/sub/page', 'kia.com', 'kia.com'),
  (21, 3, 'https://shop.kia.de/angebote', 'shop.kia.de', 'kia.de'),
  (22, 1, 'https://www.kia.com/de/sub/x', 'kia.com', 'kia.com'),
  (31, 1, 'https://mybrand.example.com/news/article-1', 'mybrand.example.com', 'example.com'),
  (31, 2, 'https://mybrand.example.com/landing?utm_source=a', 'mybrand.example.com', 'example.com'),
  (31, 3, 'https://mybrand.example.com/', 'mybrand.example.com', 'example.com'),
  (31, 4, 'https://www.hyundaiusa.com/us/en/suv', 'hyundaiusa.com', 'hyundaiusa.com');
INSERT INTO ing.citation (run_month, job_id, ord, url, host, domain_label)
SELECT '2026-09-01', ('90000000-0000-4000-8000-0000000000' || lpad(k::text, 2, '0'))::uuid, o, url, host, dom FROM _c;

-- ACR prompt-run 1개(SP3 × chatgpt × US, run R1) + 롤업 3행
INSERT INTO ing.acr_prompt_run (prompt_run_id, acr_cell_key, run_id, prompt_id, target, region, measured_at, planned_iterations, valid_turn1_iterations,
                                valid_acr_iterations, co_single_entity, source_job_ids, acr_summary, load_id) OVERRIDING SYSTEM VALUE
VALUES ('aa000000-0000-4000-8000-000000000001', 501, 'e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', 'chatgpt', 'US',
        '2026-09-14 03:20+00', 3, 3, 2, 2,
        ARRAY['90000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000011', '90000000-0000-4000-8000-000000000012']::uuid[], '{}', 1);
INSERT INTO ing.acr_rollup_row (prompt_run_id, entity_id, rollup_level, run_id, entity_name, brand_rollup_entity_id, appearance_count, choice_count) VALUES
  ('aa000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000301', 'brand', 'e0000000-0000-4000-8000-000000000001', 'Hyundai', '00000000-0000-0000-0000-000000000301', 2, 1),
  ('aa000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'brand', 'e0000000-0000-4000-8000-000000000001', 'Toyota', '71000000-0000-4000-8000-000000000001', 1, 1),
  ('aa000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000003', 'brand', 'e0000000-0000-4000-8000-000000000001', 'Apple', '71000000-0000-4000-8000-000000000003', 1, 0);
COMMIT;
