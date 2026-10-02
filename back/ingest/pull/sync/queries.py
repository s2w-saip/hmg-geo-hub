"""ingest.pull.sync SQL(loader 쓰기 경로: ing.sync_cursor·ing.run·ing.prompt·ing.stage_*·ing 원본 반영).

단계(모듈-적재-파이프라인.md §3-4, DB-보정 §4 0~2·10단계)
  0 프로젝트 등록 동기화 → 커서 임대 → 프롬프트 증분
  1 run 대조(R12 워터마크) → 스테이지 전량 수신(load_id 태그, stage_cursor 로 재개)
  2 해시 diff → ing 원본 반영(바뀐 job 만: 키 발급 → answer UPSERT → 자식 DELETE·INSERT → ACR prompt-run UPSERT) → run 카운터
"""

# app.project(표준 루트 → global, 고객 → project) ∪ app.website_site(website) → ing.sync_cursor. 표면 판정은 seed-20 1-1 과 같은 순서.
REGISTER = """
INSERT INTO ing.sync_cursor (scope_project_id, surface)
SELECT x.scope_project_id, x.surface FROM (
  SELECT w.scope_project_id, 'website' AS surface, 1 AS pri FROM app.website_site w WHERE w.scope_project_id IS NOT NULL
  UNION ALL SELECT p.scope_project_id, CASE WHEN p.kind = 'standard_root' THEN 'global' ELSE 'project' END, 2 FROM app.project p
   WHERE p.scope_project_id IS NOT NULL) x
 WHERE NOT EXISTS (SELECT 1 FROM ing.sync_cursor c WHERE c.scope_project_id = x.scope_project_id)
ON CONFLICT (scope_project_id) DO NOTHING
RETURNING scope_project_id
"""
# 커서 임대: 오래 시도 안 한 프로젝트 1개(또는 지정). 임대 = last_attempt_at 선기록(에러는 지우지 않음, markSyncAttemptStarted 계승)
LEASE_NEXT = """
UPDATE ing.sync_cursor c SET last_attempt_at = now()
 WHERE c.scope_project_id = (SELECT scope_project_id FROM ing.sync_cursor ORDER BY last_attempt_at NULLS FIRST, scope_project_id
                              FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING c.scope_project_id, c.surface, c.prompts_updated_to, c.regions
"""
LEASE_ONE = """
UPDATE ing.sync_cursor c SET last_attempt_at = now()
 WHERE c.scope_project_id = (SELECT scope_project_id FROM ing.sync_cursor WHERE scope_project_id = $1 FOR UPDATE SKIP LOCKED)
RETURNING c.scope_project_id, c.surface, c.prompts_updated_to, c.regions
"""
CURSOR_DONE = """
UPDATE ing.sync_cursor SET last_success_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_success_at END,
       last_error = $2 WHERE scope_project_id = $1
"""
CURSOR_REGIONS = """
UPDATE ing.sync_cursor SET regions = $2 WHERE scope_project_id = $1 AND regions IS DISTINCT FROM $2::text[] RETURNING scope_project_id
"""
DIM_PROJECT_REGIONS = "UPDATE rd.dim_project SET regions = $2 WHERE scope_project_id = $1 AND regions IS DISTINCT FROM $2::text[]"
PROMPTS_CURSOR = "UPDATE ing.sync_cursor SET prompts_updated_to = $2 WHERE scope_project_id = $1"

# ing.prompt UPSERT. 반환 = 판정 입력(regions·lang·kind·text)이 바뀐 기존 프롬프트.
# enabled(DB-v2.14 P84, 제품 결정 21) = Scope 응답의 enabled(코어 prompts.enabled). 응답에 없으면(NULL) 기존 값을 지우지 않는다.
# 판정 입력이 아니다(rd 재판정 없음): 발행 게이트 활성 유닛(ing.active_units)만 읽는다.
PROMPT_UPSERT = """
WITH src AS (SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::text[],
                                  $9::bool[])
                   AS t(scope_prompt_id, scope_project_id, text, funnel_stage, lang, kind, scope_updated_at, regions_json, enabled)),
old AS (SELECT p.* FROM ing.prompt p WHERE p.scope_prompt_id IN (SELECT scope_prompt_id FROM src)),
up AS (
  INSERT INTO ing.prompt AS p (scope_prompt_id, scope_project_id, text, funnel_stage, lang, regions, kind, scope_updated_at, enabled, synced_at)
  SELECT s.scope_prompt_id, s.scope_project_id, s.text, s.funnel_stage, s.lang,
         CASE WHEN s.regions_json IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(s.regions_json::jsonb)) END,
         s.kind, s.scope_updated_at, s.enabled, now()
    FROM src s
  ON CONFLICT (scope_prompt_id) DO UPDATE SET scope_project_id = EXCLUDED.scope_project_id, text = EXCLUDED.text,
         funnel_stage = EXCLUDED.funnel_stage, lang = EXCLUDED.lang, regions = EXCLUDED.regions, kind = EXCLUDED.kind,
         scope_updated_at = EXCLUDED.scope_updated_at, enabled = coalesce(EXCLUDED.enabled, p.enabled), synced_at = now()
   WHERE (p.scope_project_id, p.text, p.funnel_stage, p.lang, p.regions, p.kind, p.scope_updated_at, p.enabled)
         IS DISTINCT FROM (EXCLUDED.scope_project_id, EXCLUDED.text, EXCLUDED.funnel_stage, EXCLUDED.lang, EXCLUDED.regions, EXCLUDED.kind,
                           EXCLUDED.scope_updated_at, coalesce(EXCLUDED.enabled, p.enabled))
  RETURNING p.scope_prompt_id, p.text, p.lang, p.regions, p.kind)
SELECT up.scope_prompt_id FROM up JOIN old o ON o.scope_prompt_id = up.scope_prompt_id
 WHERE (o.text, o.lang, o.regions, o.kind) IS DISTINCT FROM (up.text, up.lang, up.regions, up.kind)
"""

RUNS_OF_PROJECT = """
SELECT run_id, run_key, status, total_jobs, started_at, completed_at, cycle_anchor_at, unresolved_jobs, analysis_pending, recheck_until,
       analysis_recheck_until, sync_state, stage_cursor, attempts, next_attempt_at, last_load_id
  FROM ing.run WHERE scope_project_id = $1
"""
# run 원장 반영(새 run INSERT, 기존 run 은 상태·총수·완료 시각·앵커만). run_month = started_at 의 KST 월(seed-00 kst_month)
RUN_UPSERT = """
INSERT INTO ing.run AS r (run_id, scope_project_id, run_month, status, trigger, targets, regions, total_jobs, started_at, completed_at, cycle_anchor_at)
VALUES ($1, $2, date_trunc('month', coalesce($8::timestamptz, now()) AT TIME ZONE 'Asia/Seoul')::date, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, trigger = EXCLUDED.trigger, targets = EXCLUDED.targets, regions = EXCLUDED.regions,
       total_jobs = EXCLUDED.total_jobs, completed_at = EXCLUDED.completed_at, cycle_anchor_at = coalesce(EXCLUDED.cycle_anchor_at, r.cycle_anchor_at)
 WHERE (r.status, r.trigger, r.targets, r.regions, r.total_jobs, r.completed_at, r.cycle_anchor_at)
       IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.trigger, EXCLUDED.targets, EXCLUDED.regions, EXCLUDED.total_jobs, EXCLUDED.completed_at,
                         coalesce(EXCLUDED.cycle_anchor_at, r.cycle_anchor_at))
RETURNING run_id, run_month
"""
RUN_OF = "SELECT * FROM ing.run WHERE run_id = $1"
RUN_STAGING = "UPDATE ing.run SET sync_state = 'staging', stage_cursor = $2 WHERE run_id = $1"
RUN_FAIL = """
UPDATE ing.run SET attempts = attempts + 1, last_error = $2, stage_cursor = NULL,
       next_attempt_at = coalesce($4::timestamptz, now()) + make_interval(mins => least(20 * (1 << least(attempts::int, 6)), 1440)),
       sync_state = CASE WHEN attempts + 1 >= $3 THEN 'blocked' ELSE 'deferred' END
 WHERE run_id = $1 RETURNING sync_state, attempts
"""
# 수신 중단: 스테이지·stage_cursor 를 남기고(재개) 백오프. 연속 실패가 상한이면 blocked
RUN_STAGE_FAIL = """
UPDATE ing.run SET attempts = attempts + 1, last_error = $2,
       next_attempt_at = coalesce($4::timestamptz, now()) + make_interval(mins => least(20 * (1 << least(attempts::int, 6)), 1440)),
       sync_state = CASE WHEN attempts + 1 >= $3 THEN 'blocked' ELSE 'staging' END
 WHERE run_id = $1 RETURNING sync_state, attempts
"""

# 스테이지 적재(열 순서 = stage.job_rows 튜플)
STAGE_ANSWER = """
INSERT INTO ing.stage_answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, model_slug, prompt_run_id,
                              analysis_status, analysis_version, quality_breakdown, answer_text, n_mentions, n_citations, result_fallback,
                              content_hash, seed_origin, load_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $21)
"""
STAGE_MENTION = """
INSERT INTO ing.stage_mention (load_id, run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, sentiment_positive,
                               sentiment_neutral, sentiment_negative, sentiment_mixed, avg_position, surfaces, brand_rollup_entity_id,
                               product_rollup_entity_id, company_rollup_entity_id, type_mention, type_recommendation, type_comparison,
                               type_definition, type_final_choice)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
"""
STAGE_OCC = """
INSERT INTO ing.stage_occurrence (load_id, run_month, job_id, ord, entity_id, brand_rollup_entity_id, turn_index, source_start, source_end,
                                  surface_text, sentiment, mention_role, assertion, context_snippet, descriptors, criteria)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
"""
STAGE_STANCE = """
INSERT INTO ing.stage_stance (load_id, run_month, job_id, turn_index, entity_id, brand_label, is_tracked, stance, confidence, evidence_text,
                              evidence_start, evidence_end, reason, model_slug)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
"""
STAGE_CIT = """
INSERT INTO ing.stage_citation (load_id, run_month, job_id, ord, url, title, ref_index, scope_category, host, domain_label)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
"""
STAGE_ACR = "INSERT INTO ing.stage_acr (load_id, prompt_run_id, payload) VALUES ($1, $2, $3::jsonb)"
STAGE_COUNT = "SELECT count(*) FROM ing.stage_answer WHERE load_id = $1"
# 페이지 스테이지 = 그 페이지 job 들의 스테이지 행 교체(멱등). 같은 load 로 페이지를 다시 받는 경로(적재 트랜잭션 안 크래시 뒤 재개는
# stage_cursor.cursor 가 null 이라 1페이지부터 다시 받는다)에서 자식 스테이지가 겹쳐 쌓이면 CHILDREN 이 ing 자식 PK 위반으로 실패한다
# (결함 N2). 답변·언급·출현·스탠스·인용을 한 문장(쓰기 CTE)으로 지운다. stage_acr 는 prompt-run 단위라 _stage_run 이 payload 를 합친다.
STAGE_CLEAR_JOBS = """
WITH m AS (DELETE FROM ing.stage_mention WHERE load_id = $1 AND job_id = ANY($2::uuid[])),
     o AS (DELETE FROM ing.stage_occurrence WHERE load_id = $1 AND job_id = ANY($2::uuid[])),
     st AS (DELETE FROM ing.stage_stance WHERE load_id = $1 AND job_id = ANY($2::uuid[])),
     c AS (DELETE FROM ing.stage_citation WHERE load_id = $1 AND job_id = ANY($2::uuid[]))
DELETE FROM ing.stage_answer WHERE load_id = $1 AND job_id = ANY($2::uuid[])
"""

# ── 적재 트랜잭션: 해시 diff → ing 원본 ──
KEYS = """
INSERT INTO ing.answer_key_map (job_id, run_month)
SELECT s.job_id, s.run_month FROM ing.stage_answer s
 WHERE s.load_id = $1 AND NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = s.job_id)
 ORDER BY s.measured_at NULLS LAST, s.job_id
ON CONFLICT (job_id) DO NOTHING
"""
FILL_KEYS = """
UPDATE ing.stage_answer s SET answer_key = k.answer_key, run_month = k.run_month
  FROM ing.answer_key_map k WHERE s.load_id = $1 AND k.job_id = s.job_id AND (s.answer_key, s.run_month) IS DISTINCT FROM (k.answer_key, k.run_month)
"""
CHANGED = """
DROP TABLE IF EXISTS _pl_changed;
CREATE TEMP TABLE _pl_changed ON COMMIT DROP AS
SELECT s.job_id, s.run_month, s.answer_key FROM ing.stage_answer s
 WHERE s.load_id = {load_id} AND NOT EXISTS (SELECT 1 FROM ing.answer a WHERE a.run_month = s.run_month AND a.job_id = s.job_id
                                              AND a.content_hash = s.content_hash);
CREATE UNIQUE INDEX ON _pl_changed (run_month, job_id);
"""
UPSERT_ANSWER = """
INSERT INTO ing.answer AS a (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, model_slug, prompt_run_id,
                             analysis_status, analysis_version, quality_breakdown, answer_text, n_mentions, n_citations, result_fallback,
                             content_hash, seed_origin, load_id)
SELECT s.run_month, s.job_id, s.answer_key, s.run_id, s.prompt_id, s.target, s.region, s.status, s.measured_at, s.model_slug, s.prompt_run_id,
       s.analysis_status, s.analysis_version, s.quality_breakdown, s.answer_text, s.n_mentions, s.n_citations, s.result_fallback,
       s.content_hash, 'scope_api', $1
  FROM ing.stage_answer s JOIN _pl_changed c ON c.run_month = s.run_month AND c.job_id = s.job_id WHERE s.load_id = $1
ON CONFLICT (run_month, job_id) DO UPDATE SET run_id = EXCLUDED.run_id, prompt_id = EXCLUDED.prompt_id, target = EXCLUDED.target,
       region = EXCLUDED.region, status = EXCLUDED.status, measured_at = EXCLUDED.measured_at, model_slug = EXCLUDED.model_slug,
       prompt_run_id = EXCLUDED.prompt_run_id, analysis_status = EXCLUDED.analysis_status, analysis_version = EXCLUDED.analysis_version,
       quality_breakdown = EXCLUDED.quality_breakdown, answer_text = EXCLUDED.answer_text, n_mentions = EXCLUDED.n_mentions,
       n_citations = EXCLUDED.n_citations, result_fallback = EXCLUDED.result_fallback, content_hash = EXCLUDED.content_hash,
       seed_origin = CASE WHEN a.seed_origin = 'scope_api' THEN 'scope_api' ELSE 'repull' END, load_id = EXCLUDED.load_id
"""
CHILDREN = """
DELETE FROM ing.mention m USING _pl_changed c WHERE m.run_month = c.run_month AND m.job_id = c.job_id;
DELETE FROM ing.mention_occurrence m USING _pl_changed c WHERE m.run_month = c.run_month AND m.job_id = c.job_id;
DELETE FROM ing.answer_stance m USING _pl_changed c WHERE m.run_month = c.run_month AND m.job_id = c.job_id;
DELETE FROM ing.citation m USING _pl_changed c WHERE m.run_month = c.run_month AND m.job_id = c.job_id;
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, sentiment_positive, sentiment_neutral,
                         sentiment_negative, sentiment_mixed, avg_position, surfaces, brand_rollup_entity_id, product_rollup_entity_id,
                         company_rollup_entity_id, type_mention, type_recommendation, type_comparison, type_definition, type_final_choice)
SELECT c.run_month, s.job_id, s.ord, s.entity_id, s.display_name, s.entity_type, s.mention_count, s.sentiment_positive, s.sentiment_neutral,
       s.sentiment_negative, s.sentiment_mixed, s.avg_position, s.surfaces, s.brand_rollup_entity_id, s.product_rollup_entity_id,
       s.company_rollup_entity_id, s.type_mention, s.type_recommendation, s.type_comparison, s.type_definition, s.type_final_choice
  FROM ing.stage_mention s JOIN _pl_changed c ON c.job_id = s.job_id WHERE s.load_id = {load_id};
INSERT INTO ing.mention_occurrence (run_month, job_id, ord, entity_id, brand_rollup_entity_id, turn_index, source_start, source_end, surface_text,
                                    sentiment, mention_role, assertion, context_snippet, descriptors, criteria)
SELECT c.run_month, s.job_id, s.ord, s.entity_id, s.brand_rollup_entity_id, s.turn_index, s.source_start, s.source_end, s.surface_text,
       s.sentiment, s.mention_role, s.assertion, s.context_snippet, s.descriptors, s.criteria
  FROM ing.stage_occurrence s JOIN _pl_changed c ON c.job_id = s.job_id WHERE s.load_id = {load_id};
INSERT INTO ing.answer_stance (run_month, job_id, turn_index, entity_id, brand_label, is_tracked, stance, confidence, evidence_text,
                               evidence_start, evidence_end, reason, model_slug)
SELECT c.run_month, s.job_id, s.turn_index, s.entity_id, s.brand_label, s.is_tracked, s.stance, s.confidence, s.evidence_text,
       s.evidence_start, s.evidence_end, s.reason, s.model_slug
  FROM ing.stage_stance s JOIN _pl_changed c ON c.job_id = s.job_id WHERE s.load_id = {load_id};
INSERT INTO ing.citation (run_month, job_id, ord, url, title, ref_index, scope_category, host, domain_label)
SELECT c.run_month, s.job_id, s.ord, s.url, s.title, s.ref_index, s.scope_category, s.host, s.domain_label
  FROM ing.stage_citation s JOIN _pl_changed c ON c.job_id = s.job_id WHERE s.load_id = {load_id};
"""
# ACR prompt-run: 바뀐 job 이 속한 prompt-run 만 다시 쓴다(acr_cell_key IDENTITY 는 UPSERT 로 유지)
ACR_UPSERT = """
INSERT INTO ing.acr_prompt_run AS p (prompt_run_id, run_id, prompt_id, target, region, measured_at, planned_iterations, valid_turn1_iterations,
                                     valid_acr_iterations, co_single_entity, co_conditional_multiple, co_generic_category, co_resolved_off_shortlist,
                                     co_unresolved_choice, co_none, source_job_ids, acr_summary, load_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)
ON CONFLICT (prompt_run_id) DO UPDATE SET run_id = EXCLUDED.run_id, prompt_id = EXCLUDED.prompt_id, target = EXCLUDED.target,
       region = EXCLUDED.region, measured_at = EXCLUDED.measured_at, planned_iterations = EXCLUDED.planned_iterations,
       valid_turn1_iterations = EXCLUDED.valid_turn1_iterations, valid_acr_iterations = EXCLUDED.valid_acr_iterations,
       co_single_entity = EXCLUDED.co_single_entity, co_conditional_multiple = EXCLUDED.co_conditional_multiple,
       co_generic_category = EXCLUDED.co_generic_category, co_resolved_off_shortlist = EXCLUDED.co_resolved_off_shortlist,
       co_unresolved_choice = EXCLUDED.co_unresolved_choice, co_none = EXCLUDED.co_none, source_job_ids = EXCLUDED.source_job_ids,
       acr_summary = EXCLUDED.acr_summary, load_id = EXCLUDED.load_id
RETURNING prompt_run_id
"""
ACR_ROWS_DELETE = "DELETE FROM ing.acr_rollup_row WHERE prompt_run_id = $1"
ACR_ROW_INSERT = """
INSERT INTO ing.acr_rollup_row (prompt_run_id, entity_id, rollup_level, run_id, entity_name, brand_rollup_entity_id, parent_name, entity_type,
                                appearance_count, choice_count, conditional_choice_count, off_shortlist_choice_count, unresolved_choice_count,
                                generic_choice_count, appearance_rate, acr, overall_choice_share)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
"""
STAGE_ACR_ROWS = "SELECT prompt_run_id, payload FROM ing.stage_acr WHERE load_id = $1"
CHANGED_KEYS = "SELECT answer_key FROM _pl_changed"
CHANGED_JOBS = "SELECT job_id FROM _pl_changed"
REMOVED = """
SELECT count(*) FROM ing.answer a WHERE a.run_id = $1
   AND NOT EXISTS (SELECT 1 FROM ing.stage_answer s WHERE s.load_id = $2 AND s.job_id = a.job_id)
"""
# run 카운터·재확인 창(R12 워터마크): seen = 스테이지 job 수, unresolved = 종결 아님 ∪ 완료인데 본문을 못 받음, pending = 분석 결손(DN-3)
RUN_COUNTERS = """
WITH s AS (
  SELECT count(*) AS seen, count(*) FILTER (WHERE status = 'completed') AS completed,
         count(*) FILTER (WHERE status NOT IN ('completed', 'failed', 'partial_failed', 'cancelled', 'canceled', 'error', 'skipped')
                             OR (status = 'completed' AND answer_text IS NULL AND NOT result_fallback AND job_id = ANY($3::uuid[]))) AS unresolved,
         count(*) FILTER (WHERE status = 'completed' AND (analysis_status = 'pending'
                                                          OR (analysis_status IS NULL AND n_mentions = 0 AND n_citations = 0))) AS pending
    FROM ing.stage_answer WHERE load_id = $2)
UPDATE ing.run r SET seen_jobs = s.seen, completed_jobs = s.completed, unresolved_jobs = s.unresolved, analysis_pending = s.pending,
       recheck_until = coalesce(r.completed_at, r.started_at) + make_interval(days =>
            coalesce((SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'run_recheck_days'), 3)),
       analysis_recheck_until = coalesce(r.completed_at, r.started_at) + make_interval(days =>
            coalesce((SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'analysis_recheck_days'), 7))
  FROM s WHERE r.run_id = $1
"""
RUN_LOADED = """
UPDATE ing.run SET sync_state = 'loaded', stage_cursor = NULL, attempts = 0, next_attempt_at = NULL, last_error = NULL, last_load_id = $2,
       synced_at = now() WHERE run_id = $1
"""
ENSURE_ING_MONTH = """
SELECT rd.ensure_month_leaf(t::regclass, $1::date)
  FROM unnest(ARRAY['ing.answer','ing.mention','ing.mention_occurrence','ing.answer_stance','ing.citation']) t
UNION ALL SELECT rd.ensure_hub_match_leaf($1::date)   -- 허브 추가 표면 적중(DB-v2.17 P100, 적재 훅이 같은 월에 쓴다)
"""
