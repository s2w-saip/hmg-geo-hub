\set pob_md5 '55f945173b4510f083eb6c20a36dd2ca'
\set ptu_md5 '21116cd5f71323ac4f2a36f445bdd1b6'
-- ============================================================================
-- verify-seed.sql : 시드 검증(읽기 전용). 표별 원본·이관·차이와 차이 사유, 고아, 파티션 leaf, 정규화 파리티, 소요 시간.
-- 출력은 표 이름·수치만(고객 본문 없음). 생성: gen_verify.py(TS 파리티 기대값 치환).
-- ============================================================================
\set ON_ERROR_STOP on
\set VERBOSITY terse
SET client_min_messages = warning;
SET TIME ZONE 'UTC';
SET work_mem = '512MB';
\pset footer off
\ir seed-00-fn.sql
BEGIN READ ONLY;

\echo '### A. 앱 표 대조(mig_src → app)'
WITH t(ord, dst, src, s_n, d_n, reason) AS (VALUES
 (1, 'app.project', 'projects', (SELECT count(*) FROM mig_src.projects), (SELECT count(*) FROM app.project), ''),
 (2, 'app.prompt_candidate', 'prompt_candidates', (SELECT count(*) FROM mig_src.prompt_candidates), (SELECT count(*) FROM app.prompt_candidate),
    format('소속 프로젝트 없음 %s', (SELECT count(*) FROM mig_src.prompt_candidates c WHERE NOT EXISTS (SELECT 1 FROM mig_src.projects p WHERE p.id = c.project_id)))),
 (3, 'app.prompt', 'prompts', (SELECT count(*) FROM mig_src.prompts), (SELECT count(*) FROM app.prompt),
    format('소속 프로젝트 없음(원본 FK 없음·삭제된 프로젝트) %s', (SELECT count(*) FROM mig_src.prompts p WHERE NOT EXISTS (SELECT 1 FROM mig_src.projects x WHERE x.id = p.project_id)))),
 (4, 'app.project_custom_field', 'project_custom_fields', (SELECT count(*) FROM mig_src.project_custom_fields), (SELECT count(*) FROM app.project_custom_field),
    format('소속 프로젝트 없음 %s', (SELECT count(*) FROM mig_src.project_custom_fields f WHERE NOT EXISTS (SELECT 1 FROM mig_src.projects p WHERE p.id = f.project_id)))),
 (5, 'app.prompt_custom_field_value', 'prompt_custom_field_values', (SELECT count(*) FROM mig_src.prompt_custom_field_values), (SELECT count(*) FROM app.prompt_custom_field_value),
    format('프롬프트 미이관 %s, 필드-프로젝트 불일치·필드 없음 %s',
      (SELECT count(*) FROM mig_src.prompt_custom_field_values v WHERE NOT EXISTS (SELECT 1 FROM app.prompt p WHERE p.prompt_id = v.prompt_id)),
      (SELECT count(*) FROM mig_src.prompt_custom_field_values v JOIN app.prompt p ON p.prompt_id = v.prompt_id
        WHERE NOT EXISTS (SELECT 1 FROM app.project_custom_field f WHERE f.field_id = v.field_id AND f.project_id = p.project_id)))),
 (6, 'app.project_engine_history', 'project_engine_history', (SELECT count(*) FROM mig_src.project_engine_history), (SELECT count(*) FROM app.project_engine_history), ''),
 (7, 'app.project_owned_base', 'project_owned_bases', (SELECT count(*) FROM mig_src.project_owned_bases), (SELECT count(*) FROM app.project_owned_base),
    format('정규화 후 (project, base_norm) 중복 %s, 빈 값 %s',
      (SELECT count(*) - count(DISTINCT (project_id, pg_temp.owned_prefix(base_url))) FROM mig_src.project_owned_bases WHERE pg_temp.owned_prefix(base_url) <> ''),
      (SELECT count(*) FROM mig_src.project_owned_bases WHERE pg_temp.owned_prefix(base_url) = ''))),
 (8, 'app.project_tracked_url', 'project_tracked_urls', (SELECT count(*) FROM mig_src.project_tracked_urls), (SELECT count(*) FROM app.project_tracked_url),
    format('정규화 후 (project, url_norm) 중복 %s, 빈 값 %s',
      (SELECT count(*) - count(DISTINCT (project_id, pg_temp.norm_match(url))) FROM mig_src.project_tracked_urls WHERE pg_temp.norm_match(url) <> ''),
      (SELECT count(*) FROM mig_src.project_tracked_urls WHERE pg_temp.norm_match(url) = ''))),
 (9, 'app.project_tracked_brand', 'tracked_brands', (SELECT count(*) FROM mig_src.tracked_brands), (SELECT count(*) FROM app.project_tracked_brand), ''),
 (10, 'app.project_tracked_competitor', 'tracked_competitors', (SELECT count(*) FROM mig_src.tracked_competitors), (SELECT count(*) FROM app.project_tracked_competitor), ''),
 (11, 'app.project_tracked_vehicle', 'tracked_vehicles', (SELECT count(*) FROM mig_src.tracked_vehicles), (SELECT count(*) FROM app.project_tracked_vehicle), ''),
 (12, 'app.project_tracked_keyword', 'tracked_keywords', (SELECT count(*) FROM mig_src.tracked_keywords), (SELECT count(*) FROM app.project_tracked_keyword), ''),
 (13, 'app.website_site', 'website_sites', (SELECT count(*) FROM mig_src.website_sites), (SELECT count(*) FROM app.website_site),
    format('행 차이 없음. scope project 공유로 scope_project_id 를 비운 사이트 %s (UNIQUE 충돌, 0056 사우디 도시 사이트)',
      (SELECT count(*) FROM app.website_site w JOIN mig_src.website_sites s ON s.id = w.site_id WHERE w.scope_project_id IS NULL AND s.scope_project_id IS NOT NULL))),
 (14, 'app.website_prompt', 'website_prompts', (SELECT count(*) FROM mig_src.website_prompts), (SELECT count(*) FROM app.website_prompt), ''),
 (15, 'app.standard_keyword', 'standard_keywords', (SELECT count(*) FROM mig_src.standard_keywords), (SELECT count(*) FROM app.standard_keyword), ''),
 (16, 'app.standard_source', 'standard_sources', (SELECT count(*) FROM mig_src.standard_sources), (SELECT count(*) FROM app.standard_source), ''),
 (17, '(대상 없음)', 'standard_prompts', (SELECT count(*) FROM mig_src.standard_prompts), 0, '대상 표 없음: 카탈로그 정본 = 표준 루트 프로젝트의 app.prompt'),
 (18, 'app.ga4_property', 'ga4_properties', (SELECT count(*) FROM mig_src.ga4_properties), (SELECT count(*) FROM app.ga4_property),
    format('property_id NULL %s', (SELECT count(*) FROM mig_src.ga4_properties WHERE property_id IS NULL OR property_id = ''))),
 (19, 'app.ga4_tracked_event', 'ga4_tracked_events', (SELECT count(*) FROM mig_src.ga4_tracked_events), (SELECT count(*) FROM app.ga4_tracked_event), ''),
 (20, 'app.report_publication', 'report_publications', (SELECT count(*) FROM mig_src.report_publications), (SELECT count(*) FROM app.report_publication), ''),
 (21, 'app.report_site_fact', 'report_site_facts', (SELECT count(*) FROM mig_src.report_site_facts), (SELECT count(*) FROM app.report_site_fact), ''),
 (22, 'app.report_site_engine_fact', 'report_site_engine_facts', (SELECT count(*) FROM mig_src.report_site_engine_facts), (SELECT count(*) FROM app.report_site_engine_fact), ''),
 (23, 'app.citation_domain_override', 'citation_domain_overrides', (SELECT count(*) FROM mig_src.citation_domain_overrides), (SELECT count(*) FROM app.citation_domain_override),
    format('택소노미 밖 카테고리 %s', (SELECT count(*) FROM mig_src.citation_domain_overrides o WHERE NOT EXISTS (SELECT 1 FROM app.citation_category c WHERE c.name = o.category)))),
 (24, 'app.entity_registry', 'entity_registry', (SELECT count(*) FROM mig_src.entity_registry), (SELECT count(*) FROM app.entity_registry), ''),
 (25, 'app.prompt_audit_log', 'prompt_audit_logs', (SELECT count(*) FROM mig_src.prompt_audit_logs), (SELECT count(*) FROM app.prompt_audit_log), ''),
 (26, 'app.member_audit_log', 'member_audit_logs', (SELECT count(*) FROM mig_src.member_audit_logs), (SELECT count(*) FROM app.member_audit_log), ''),
 (27, 'app.project_member(미이관)', 'project_members', (SELECT count(*) FROM mig_src.project_members), (SELECT count(*) FROM app.project_member),
    'user_id·invited_by 가 app.user_account FK 인데 profiles 미이관(시스템 사용자 1행만)'),
 (28, 'app.qa_answer_review(시드 밖)', 'qa_answer_reviews', (SELECT count(*) FROM mig_src.qa_answer_reviews), (SELECT count(*) FROM app.qa_answer_review), '시드 범위 밖 — migrate-qa.sql 로 별도 이관(verify-qa.sql)'),
 (29, 'app.qa_review_note(시드 밖)', 'qa_review_notes', (SELECT count(*) FROM mig_src.qa_review_notes), (SELECT count(*) FROM app.qa_review_note), '시드 범위 밖 — migrate-qa.sql 로 별도 이관(verify-qa.sql)')
)
SELECT dst AS "대상", src AS "원본(mig_src)", s_n AS "원본", d_n AS "이관", s_n - d_n AS "차이", reason AS "차이 사유" FROM t ORDER BY ord;

\echo '### B. 판정 규칙 표(현행 코드 상수)·시스템 사용자·규칙 세트'
SELECT 'app.brand' AS t, count(*) AS n FROM app.brand
UNION ALL SELECT 'app.brand_name_prefix', count(*) FROM app.brand_name_prefix
UNION ALL SELECT 'app.brand_display_alias', count(*) FROM app.brand_display_alias
UNION ALL SELECT 'app.non_competitor_name', count(*) FROM app.non_competitor_name
UNION ALL SELECT 'app.non_competitor_name(bare_only)', count(*) FROM app.non_competitor_name WHERE bare_only_pattern IS NOT NULL
UNION ALL SELECT 'app.competitor_domain_token', count(*) FROM app.competitor_domain_token
UNION ALL SELECT 'app.entity_alias', count(*) FROM app.entity_alias
UNION ALL SELECT 'app.citation_category', count(*) FROM app.citation_category
UNION ALL SELECT 'app.owned_base(base)', count(*) FROM app.owned_base WHERE kind = 'base'
UNION ALL SELECT 'app.owned_base(root_home)', count(*) FROM app.owned_base WHERE kind = 'root_home'
UNION ALL SELECT 'app.rule_param', count(*) FROM app.rule_param
UNION ALL SELECT 'app.rhq_region', count(*) FROM app.rhq_region
UNION ALL SELECT 'app.rhq_region_country', count(*) FROM app.rhq_region_country
UNION ALL SELECT 'app.hidden_market', count(*) FROM app.hidden_market
UNION ALL SELECT 'app.user_account', count(*) FROM app.user_account
UNION ALL SELECT 'app.rule_set', count(*) FROM app.rule_set
UNION ALL SELECT 'app.rule_set 지문 키 수(최신)', (SELECT count(*) FROM jsonb_object_keys((SELECT fingerprints FROM app.rule_set ORDER BY rule_ver DESC LIMIT 1)))
UNION ALL SELECT 'app.judgment_change(시드가 만들면 안 됨)', count(*) FROM app.judgment_change
UNION ALL SELECT 'app.prompt 트리거 활성', count(*) FROM pg_trigger WHERE tgname = 'prompt_catalog_change' AND tgenabled = 'O';

\echo '### C. 정규화 파리티(SQL 쌍둥이 vs 현행 TS, 스냅샷 원본 행 전수 md5)'
SELECT 'project_owned_bases → ownedBasePrefixFromUrl' AS rule,
       md5(string_agg(id::text || '|' || pg_temp.owned_prefix(base_url), E'\n' ORDER BY id)) = :'pob_md5' AS parity,
       count(*) AS rows_checked FROM mig_src.project_owned_bases
UNION ALL
SELECT 'project_tracked_urls → normalizeUrlForMatch',
       md5(string_agg(id::text || '|' || pg_temp.norm_match(url), E'\n' ORDER BY id)) = :'ptu_md5', count(*) FROM mig_src.project_tracked_urls;

\echo '### D. ing 표 대조(mig_src → ing)'
WITH
  ans_excl AS (SELECT a.job_id, a.run_id FROM mig_src.scope_answers a WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = a.job_id)),
  run_excl AS (SELECT r.run_id, r.project_id FROM mig_src.scope_runs r WHERE NOT EXISTS (SELECT 1 FROM ing.run x WHERE x.run_id = r.run_id)),
  src_jobs AS (SELECT job_id FROM mig_src.scope_answers),
  t(ord, dst, src, s_n, d_n, reason) AS (VALUES
 (1, 'ing.run', 'scope_runs', (SELECT count(*) FROM mig_src.scope_runs), (SELECT count(*) FROM ing.run),
    format('scope project 복원 불가(원본 project_id NULL·원장 귀속 없음·답변 프롬프트로도 불명) %s', (SELECT count(*) FROM run_excl))),
 (2, 'ing.answer_key_map', 'scope_answers', (SELECT count(*) FROM mig_src.scope_answers), (SELECT count(*) FROM ing.answer_key_map),
    format('run 미이관 %s, run 이 미러에 없음 %s',
      (SELECT count(*) FROM ans_excl e WHERE EXISTS (SELECT 1 FROM run_excl r WHERE r.run_id = e.run_id)),
      (SELECT count(*) FROM ans_excl e WHERE NOT EXISTS (SELECT 1 FROM mig_src.scope_runs r WHERE r.run_id = e.run_id)))),
 (3, 'ing.answer', 'scope_answers', (SELECT count(*) FROM mig_src.scope_answers), (SELECT count(*) FROM ing.answer), '위와 같음'),
 (4, 'ing.mention', 'scope_mentions', (SELECT count(*) FROM mig_src.scope_mentions), (SELECT count(*) FROM ing.mention),
    format('job 이 미러 답변에 없음(드롭 잔존·원본 고아) %s, 답변은 있으나 run 미이관 %s',
      (SELECT count(*) FROM mig_src.scope_mentions m WHERE NOT EXISTS (SELECT 1 FROM src_jobs s WHERE s.job_id = m.job_id)),
      (SELECT count(*) FROM mig_src.scope_mentions m WHERE EXISTS (SELECT 1 FROM ans_excl e WHERE e.job_id = m.job_id)))),
 (5, 'ing.mention_occurrence', 'scope_mention_occurrences', (SELECT count(*) FROM mig_src.scope_mention_occurrences), (SELECT count(*) FROM ing.mention_occurrence),
    format('job 이 미러 답변에 없음 %s (그중 드롭 job %s), 답변은 있으나 run 미이관 %s',
      (SELECT count(*) FROM mig_src.scope_mention_occurrences m WHERE NOT EXISTS (SELECT 1 FROM src_jobs s WHERE s.job_id = m.job_id)),
      (SELECT count(*) FROM mig_src.scope_mention_occurrences m JOIN mig_src.scope_answer_drops d ON d.job_id = m.job_id),
      (SELECT count(*) FROM mig_src.scope_mention_occurrences m WHERE EXISTS (SELECT 1 FROM ans_excl e WHERE e.job_id = m.job_id)))),
 (6, 'ing.answer_stance', 'scope_answer_stances', (SELECT count(*) FROM mig_src.scope_answer_stances), (SELECT count(*) FROM ing.answer_stance),
    format('job 이 미러 답변에 없음 %s (그중 드롭 job %s), 답변은 있으나 run 미이관 %s',
      (SELECT count(*) FROM mig_src.scope_answer_stances m WHERE NOT EXISTS (SELECT 1 FROM src_jobs s WHERE s.job_id = m.job_id)),
      (SELECT count(*) FROM mig_src.scope_answer_stances m JOIN mig_src.scope_answer_drops d ON d.job_id = m.job_id),
      (SELECT count(*) FROM mig_src.scope_answer_stances m WHERE EXISTS (SELECT 1 FROM ans_excl e WHERE e.job_id = m.job_id)))),
 (7, 'ing.citation', 'scope_citations', (SELECT count(*) FROM mig_src.scope_citations), (SELECT count(*) FROM ing.citation),
    format('job 이 미러 답변에 없음 %s, 답변은 있으나 run 미이관 %s',
      (SELECT count(*) FROM mig_src.scope_citations m WHERE NOT EXISTS (SELECT 1 FROM src_jobs s WHERE s.job_id = m.job_id)),
      (SELECT count(*) FROM mig_src.scope_citations m WHERE EXISTS (SELECT 1 FROM ans_excl e WHERE e.job_id = m.job_id)))),
 (8, 'ing.acr_prompt_run', 'scope_acr_rollups(DISTINCT prompt_run_id)', (SELECT count(DISTINCT prompt_run_id) FROM mig_src.scope_acr_rollups), (SELECT count(*) FROM ing.acr_prompt_run),
    format('run 미이관 %s', (SELECT count(DISTINCT prompt_run_id) FROM mig_src.scope_acr_rollups x WHERE NOT EXISTS (SELECT 1 FROM ing.run r WHERE r.run_id = x.run_id)))),
 (9, 'ing.acr_rollup_row', 'scope_acr_rollups', (SELECT count(*) FROM mig_src.scope_acr_rollups), (SELECT count(*) FROM ing.acr_rollup_row),
    format('run 미이관 %s', (SELECT count(*) FROM mig_src.scope_acr_rollups x WHERE NOT EXISTS (SELECT 1 FROM ing.run r WHERE r.run_id = x.run_id)))),
 (10, 'ing.prompt', 'scope_prompts', (SELECT count(*) FROM mig_src.scope_prompts), (SELECT count(*) FROM ing.prompt),
    'scope project 복원 불가(답변 없음·앱 카탈로그·웹사이트 카탈로그에도 없음)'),
 (11, 'ing.answer_anchor_pin', 'scope_answer_anchors', (SELECT count(*) FROM mig_src.scope_answer_anchors), (SELECT count(*) FROM ing.answer_anchor_pin), ''),
 (12, 'ing.answer_drop', 'scope_answer_drops', (SELECT count(*) FROM mig_src.scope_answer_drops), (SELECT count(*) FROM ing.answer_drop), ''),
 (13, 'ing.cycle(원장)', 'summary_cycles', (SELECT count(*) FROM mig_src.summary_cycles), (SELECT count(*) FROM ing.cycle WHERE origin = 'summary_cycles'), ''),
 (14, 'ing.cycle(파생)', '(원장 미귀속 run)', 0, (SELECT count(*) FROM ing.cycle WHERE origin = 'loader'), '원장에 없는 run 을 IG-3 규칙으로 귀속한 회차(음수 = 신규)'),
 (15, 'ing.cycle_run(원장)', 'summary_cycle_runs', (SELECT count(*) FROM mig_src.summary_cycle_runs),
    (SELECT count(*) FROM ing.cycle_run cr WHERE EXISTS (SELECT 1 FROM mig_src.summary_cycle_runs s WHERE s.run_id = cr.run_id AND s.cycle_id = cr.cycle_id)),
    format('run 미이관 %s', (SELECT count(*) FROM mig_src.summary_cycle_runs s WHERE NOT EXISTS (SELECT 1 FROM ing.run r WHERE r.run_id = s.run_id)))),
 (16, 'ing.cycle_run(파생)', '(원장 미귀속 run)', 0,
    (SELECT count(*) FROM ing.cycle_run cr WHERE NOT EXISTS (SELECT 1 FROM mig_src.summary_cycle_runs s WHERE s.run_id = cr.run_id)), '음수 = 신규 귀속'),
 (17, 'ing.cycle_round', 'scope_cycle_rounds', (SELECT count(*) FROM mig_src.scope_cycle_rounds), (SELECT count(*) FROM ing.cycle_round), ''),
 (18, 'ing.sync_cursor', 'scope_sync_cursors', (SELECT count(*) FROM mig_src.scope_sync_cursors), (SELECT count(*) FROM ing.sync_cursor),
    '음수 = 앱에 등록됐거나 run 이 있는데 미러 커서가 없던 프로젝트 추가')
)
SELECT dst AS "대상", src AS "원본(mig_src)", s_n AS "원본", d_n AS "이관", s_n - d_n AS "차이", reason AS "차이 사유" FROM t ORDER BY ord;

\echo '### E. 고아(자식 job_id 가 ing.answer_key_map 에 없음) — 모두 0 이어야 함'
SELECT * FROM (SELECT 1 AS o, 'ing.answer' AS t, count(*) AS orphans FROM ing.answer a WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = a.job_id AND k.answer_key = a.answer_key AND k.run_month = a.run_month)
UNION ALL SELECT 2, 'ing.answer(run 없음)', count(*) FROM ing.answer a WHERE NOT EXISTS (SELECT 1 FROM ing.run r WHERE r.run_id = a.run_id)
UNION ALL SELECT 3, 'ing.answer_key_map(answer 없음)', count(*) FROM ing.answer_key_map k WHERE NOT EXISTS (SELECT 1 FROM ing.answer a WHERE a.run_month = k.run_month AND a.job_id = k.job_id)
UNION ALL SELECT 4, 'ing.mention', count(*) FROM ing.mention m WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = m.job_id AND k.run_month = m.run_month)
UNION ALL SELECT 5, 'ing.mention_occurrence', count(*) FROM ing.mention_occurrence m WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = m.job_id AND k.run_month = m.run_month)
UNION ALL SELECT 6, 'ing.answer_stance', count(*) FROM ing.answer_stance m WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = m.job_id AND k.run_month = m.run_month)
UNION ALL SELECT 7, 'ing.citation', count(*) FROM ing.citation m WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = m.job_id AND k.run_month = m.run_month)
UNION ALL SELECT 8, 'ing.acr_prompt_run(run 없음)', count(*) FROM ing.acr_prompt_run p WHERE NOT EXISTS (SELECT 1 FROM ing.run r WHERE r.run_id = p.run_id)
UNION ALL SELECT 9, 'ing.acr_prompt_run.source_job_ids 원소', count(*) FROM ing.acr_prompt_run p, unnest(p.source_job_ids) j WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = j)
UNION ALL SELECT 10, 'ing.answer.prompt_run_id(acr_prompt_run 없음)', count(*) FROM ing.answer a WHERE a.prompt_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ing.acr_prompt_run p WHERE p.prompt_run_id = a.prompt_run_id)
UNION ALL SELECT 11, 'ing.run(회차 미귀속)', count(*) FROM ing.run r WHERE NOT EXISTS (SELECT 1 FROM ing.cycle_run cr WHERE cr.run_id = r.run_id)
UNION ALL SELECT 12, 'ing.cycle_run(run 없음)', count(*) FROM ing.cycle_run cr WHERE NOT EXISTS (SELECT 1 FROM ing.run r WHERE r.run_id = cr.run_id)
UNION ALL SELECT 13, 'ing.prompt 대비 ing.answer.prompt_id 누락(참고)', count(DISTINCT a.prompt_id) FROM ing.answer a WHERE a.prompt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ing.prompt p WHERE p.scope_prompt_id = a.prompt_id)) x ORDER BY o;

\echo '### F. 레지스트리 참고(고아 판정 대상 아님: 운영자 원장은 job 이 미러에 없어도 보존)'
SELECT 'ing.answer_anchor_pin(답변 있음)' AS t, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = p.job_id)) AS n,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = p.job_id)) AS without_answer FROM ing.answer_anchor_pin p
UNION ALL SELECT 'ing.answer_drop(답변 있음)', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = d.job_id)),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = d.job_id)) FROM ing.answer_drop d;

\echo '### G. 무결성·매핑 점검'
SELECT 'answer_key 전역 유일(중복 수)' AS k, (SELECT count(*) - count(DISTINCT answer_key) FROM ing.answer)::text AS v
UNION ALL SELECT 'answer_key 범위', (SELECT min(answer_key) || '..' || max(answer_key) || ' / ' || count(*) FROM ing.answer_key_map)
UNION ALL SELECT 'answer.run_month = run.run_month 불일치', (SELECT count(*) FROM ing.answer a JOIN ing.run r ON r.run_id = a.run_id WHERE a.run_month <> r.run_month)::text
UNION ALL SELECT 'content_hash 32바이트 아님', (SELECT count(*) FROM ing.answer WHERE octet_length(content_hash) <> 32)::text
UNION ALL SELECT 'measured_at 원복: 원장 원본(measured_at_orig) 사용', (SELECT count(*) FROM ing.answer a JOIN mig_src.scope_answer_cycle_anchors c ON c.job_id = a.job_id)::text
UNION ALL SELECT 'measured_at 원복: 미러값과 달라진 답변(=접힘 원복)', (SELECT count(*) FROM ing.answer a JOIN mig_src.scope_answers s ON s.job_id = a.job_id WHERE a.measured_at IS DISTINCT FROM s.measured_at)::text
UNION ALL SELECT 'measured_at: 고정(pin) job 인데 접힌 미러값이 남음(0 이어야 함)', (SELECT count(*) FROM ing.answer a JOIN mig_src.scope_answer_anchors p ON p.job_id = a.job_id
     JOIN mig_src.scope_answers s ON s.job_id = a.job_id WHERE a.measured_at = s.measured_at AND p.source_measured_at IS NOT NULL AND p.source_measured_at <> s.measured_at)::text
UNION ALL SELECT 'measured_at: 고정 job 중 원본 시각 미확보(원장 원본·고정 원본 모두 NULL)', (SELECT count(*) FROM ing.answer a JOIN mig_src.scope_answer_anchors p ON p.job_id = a.job_id
     WHERE p.source_measured_at IS NULL AND NOT EXISTS (SELECT 1 FROM mig_src.scope_answer_cycle_anchors c WHERE c.job_id = a.job_id))::text
UNION ALL SELECT 'measured_at: 원장 원본 vs 고정 원본 불일치', (SELECT count(*) FROM mig_src.scope_answer_cycle_anchors c JOIN mig_src.scope_answer_anchors p ON p.job_id = c.job_id
     WHERE p.source_measured_at IS NOT NULL AND p.source_measured_at <> c.measured_at_orig)::text
UNION ALL SELECT 'answer.prompt_run_id 채움(셀 1:1 복원)', (SELECT count(*) FROM ing.answer WHERE prompt_run_id IS NOT NULL)::text
UNION ALL SELECT 'acr_prompt_run.source_job_ids 비어 있음', (SELECT count(*) FROM ing.acr_prompt_run WHERE cardinality(source_job_ids) = 0)::text
UNION ALL SELECT 'acr_prompt_run 반복 수 값이 행마다 달랐던 prompt_run', (SELECT count(*) FROM (SELECT prompt_run_id FROM mig_src.scope_acr_rollups GROUP BY 1
     HAVING count(DISTINCT (planned_iterations, valid_turn1_iterations, valid_acr_iterations, co_single_entity, co_none)) > 1) x)::text
UNION ALL SELECT 'acr_rollup_row rollup_level NULL→brand 보정', (SELECT count(*) FROM mig_src.scope_acr_rollups WHERE rollup_level IS NULL)::text
UNION ALL SELECT 'ing.prompt kind NULL', (SELECT count(*) FROM ing.prompt WHERE kind IS NULL)::text
UNION ALL SELECT 'ing.run 카운터: unresolved>0 run', (SELECT count(*) FROM ing.run WHERE unresolved_jobs > 0)::text
UNION ALL SELECT 'ing.run 카운터: analysis_pending>0 run(대용식)', (SELECT count(*) FROM ing.run WHERE analysis_pending > 0)::text
UNION ALL SELECT 'ing.run: 재확인 창 안(recheck_until > now)', (SELECT count(*) FROM ing.run WHERE recheck_until > now() OR analysis_recheck_until > now())::text
UNION ALL SELECT 'ing.run: seen_jobs < total_jobs(미러 ACR 대표만 보존 등)', (SELECT count(*) FROM ing.run WHERE seen_jobs < coalesce(total_jobs, 0))::text
UNION ALL SELECT 'ing.run project 복원 근거: prompt(원본 NULL)', (SELECT count(*) FROM ing.run r JOIN mig_src.scope_runs s ON s.run_id = r.run_id WHERE s.project_id IS NULL)::text
UNION ALL SELECT 'ing.cycle status', (SELECT string_agg(k || ' ' || n, ', ' ORDER BY k) FROM (SELECT origin || ':' || status AS k, count(*) AS n FROM ing.cycle GROUP BY 1) x)
UNION ALL SELECT 'ing.cycle surface', (SELECT string_agg(k || ' ' || n, ', ' ORDER BY k) FROM (SELECT surface AS k, count(*) AS n FROM ing.cycle GROUP BY 1) x)
UNION ALL SELECT 'ing.cycle round_date 출처(표면: 좌석 원장/anchor_date 폴백)', (SELECT string_agg(surface || ' ' || seat || '/' || fb, ', ' ORDER BY surface) FROM (
     SELECT c.surface, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ing.cycle_round r WHERE r.scope_project_id = c.scope_project_id AND r.anchor_date = c.anchor_date)) AS seat,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ing.cycle_round r WHERE r.scope_project_id = c.scope_project_id AND r.anchor_date = c.anchor_date)) AS fb
       FROM ing.cycle c GROUP BY c.surface) x)
UNION ALL SELECT '오라클(scope_answer_cycle_anchors) 대비: run→회차 귀속 불일치 job / 대조 job', (SELECT count(*) FILTER (WHERE cr.cycle_id IS DISTINCT FROM x.cycle_id) || ' / ' || count(*)
     FROM mig_src.scope_answer_cycle_anchors x JOIN ing.answer a ON a.job_id = x.job_id LEFT JOIN ing.cycle_run cr ON cr.run_id = a.run_id WHERE x.cycle_id IS NOT NULL)
UNION ALL SELECT '오라클 대비: 같은 회차인데 round_date 불일치 job / 대조 job', (SELECT count(*) FILTER (WHERE c.round_date <> x.round_date) || ' / ' || count(*)
     FROM mig_src.scope_answer_cycle_anchors x JOIN ing.cycle c ON c.cycle_id = x.cycle_id)
UNION ALL SELECT '오라클 대비: 고정(pin) 없는 job 의 anchor_date(KST) 불일치 / 대조 job', (SELECT count(*) FILTER (WHERE c.anchor_date <> x.anchor_date) || ' / ' || count(*)
     FROM mig_src.scope_answer_cycle_anchors x JOIN ing.cycle c ON c.cycle_id = x.cycle_id WHERE NOT EXISTS (SELECT 1 FROM ing.answer_anchor_pin p WHERE p.job_id = x.job_id))
UNION ALL SELECT 'ing.cycle 숨김', (SELECT string_agg(hidden_scope || '/' || hidden_reason, ', ') FROM ing.cycle WHERE hidden_scope IS NOT NULL)
UNION ALL SELECT 'ing.cycle_run 파생 귀속(원장 회차에 late·scope / 파생 회차)', (SELECT string_agg(k || ' ' || n, ', ' ORDER BY k) FROM (
     SELECT c.origin || ':' || cr.attributed_by AS k, count(*) AS n FROM ing.cycle_run cr JOIN ing.cycle c ON c.cycle_id = cr.cycle_id
      WHERE NOT EXISTS (SELECT 1 FROM mig_src.summary_cycle_runs s WHERE s.run_id = cr.run_id) GROUP BY 1) x)
UNION ALL SELECT 'ing.cycle_run attributed_by', (SELECT string_agg(k || ' ' || n, ', ' ORDER BY k) FROM (SELECT attributed_by AS k, count(*) AS n FROM ing.cycle_run GROUP BY 1) x)
UNION ALL SELECT 'ing.cycle 카운터 NULL(완료 답변 0 회차)', (SELECT count(*) FROM ing.cycle WHERE completed_answers IS NULL)::text
UNION ALL SELECT 'ing.cycle analysis_done_ratio < 0.95 (발행/전체)', (SELECT count(*) FILTER (WHERE status = 'published') || '/' || count(*) FROM ing.cycle WHERE analysis_done_ratio < 0.95)
UNION ALL SELECT 'ing.sync_cursor surface', (SELECT string_agg(k || ' ' || n, ', ' ORDER BY k) FROM (SELECT surface AS k, count(*) AS n FROM ing.sync_cursor GROUP BY 1) x)
UNION ALL SELECT 'ing.answer seed_origin', (SELECT string_agg(k || ' ' || n, ', ') FROM (SELECT seed_origin AS k, count(*) AS n FROM ing.answer GROUP BY 1) x)
UNION ALL SELECT 'ing.answer status', (SELECT string_agg(k || ' ' || n, ', ' ORDER BY k) FROM (SELECT status AS k, count(*) AS n FROM ing.answer GROUP BY 1) x);

\echo '### H. 파티션 leaf(ing, run_month)'
SELECT p.relname AS parent, c.relname AS leaf, pg_get_expr(c.relpartbound, c.oid) AS bound, c.reltuples::bigint AS est_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace n ON n.oid = p.relnamespace
 WHERE n.nspname = 'ing' ORDER BY p.relname, c.relname;

\echo '### I. 적재 원장·소요'
SELECT load_id, kind, status, rule_ver, jobs_fetched, started_at, finished_at, finished_at - started_at AS elapsed FROM ing.load ORDER BY load_id;
COMMIT;
