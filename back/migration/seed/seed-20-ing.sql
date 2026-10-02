-- ============================================================================
-- seed-20-ing.sql : mig_src(현행 미러 원본 스테이지) → ing.* (쓰기 스키마, 판정 없음) 이관
-- 전제: seed-10-app.sql 적용 완료(app.rule_set·app.project·app.website_site·app.prompt 를 읽는다).
-- 재실행 가능: 단계마다 트랜잭션 1개, 그 단계의 대상 표를 TRUNCATE 한 뒤 INSERT…SELECT.
--   완료 표지 = ing.load(kind='seed').status = 'committed'(마지막 단계에서만 바뀐다). 중간 실패 뒤에는 파일 전체를 다시 돌린다
--   (1단계가 ing 전체를 비운다). ⚠️ 다시 돌리면 answer_key·run_key·cyc_key 가 같은 입력에 대해 같은 값으로 재발급되지만,
--   입력(mig_src)이 바뀌었으면 키가 달라지므로 rd(빌더 B)도 다시 투영해야 한다.
-- 원천 무변경: mig_src 는 SELECT 만 한다.
-- 매핑 근거(현행 코드 7639b9e): lib/scope/mirror/sync.ts(appendJobRows :1250-1340, ACR :993-1230),
--   lib/db/repositories/scope-mirror.ts(anchorReapplySql :114, 드롭 재적용 :140-), 0053·0054·0077·0078 마이그레이션.
-- ============================================================================
\set ON_ERROR_STOP on
\set VERBOSITY terse
SET client_min_messages = warning;
SET TIME ZONE 'UTC';
SET work_mem = '512MB';
SET maintenance_work_mem = '2GB';
SET statement_timeout = 0;
\timing on
-- 현행 프로필 resub_phantom_exclude(RESUB, WU-3b): -v attrib_member=1 이면 원장 이관 회차의 좌석(round_date)을 현행 좌석으로 이관한다(§7-3).
--   seed-40 과 적재 워커(HGH_LEGACY_PROFILE)와 같은 값이어야 한다. 기본 0 = hub 좌석(좌석 원장 매핑).
\if :{?attrib_member}
\else
\set attrib_member 0
\endif
\ir seed-00-fn.sql

-- ════════════════════════════════════════════════════════════════════════════
-- 단계 1. 비우기 + 적재 원장 행 + 프롬프트 + run + 키 발급 + 답변 원본
-- ════════════════════════════════════════════════════════════════════════════
\echo '== 1. run·answer'
BEGIN;
TRUNCATE ing.cycle_run, ing.cycle, ing.cycle_round, ing.answer_anchor_pin, ing.answer_drop, ing.answer_mirror_time,
         ing.acr_rollup_row, ing.acr_prompt_run, ing.citation, ing.answer_stance, ing.mention_occurrence, ing.mention,
         ing.answer, ing.answer_key_map, ing.run, ing.prompt, ing.sync_cursor, ing.load RESTART IDENTITY;

-- 1-0. 적재 원장: kind 'seed' 1행. rule_ver = seed-10 이 만든(또는 재사용한) 현재 규칙 세트.
INSERT INTO ing.load (kind, run_id, scope_ref, rule_ver, status)
SELECT 'seed', NULL,
       jsonb_build_object('source', 'mig_src', 'origin', 'supabase mirror snapshot',
                          'w0_synced_at', (SELECT max(synced_at) FROM mig_src.scope_runs)),
       (SELECT max(rule_ver) FROM app.rule_set), 'running'
RETURNING load_id AS seed_load \gset
SELECT :seed_load AS seed_load_id;

-- 1-1. scope project → 표면(현행 규칙 lib/surface/run-surface.ts: 글로벌 루트 / website_sites / 그 외 project)
-- 세션 임시 표(단계 7 에서도 쓴다: ON COMMIT DROP 아님)
CREATE TEMP TABLE _proj_surface AS
SELECT DISTINCT ON (scope_project_id) scope_project_id, surface FROM (
  SELECT scope_project_id, 'global' AS surface, 1 AS pri FROM app.project WHERE kind = 'standard_root' AND scope_project_id IS NOT NULL
  UNION ALL SELECT scope_project_id, 'website', 2 FROM app.website_site WHERE scope_project_id IS NOT NULL
  UNION ALL SELECT scope_project_id, 'project', 3 FROM app.project WHERE kind = 'customer' AND scope_project_id IS NOT NULL
) x ORDER BY scope_project_id, pri;

-- 1-2. 프롬프트 → scope project 후보(답변이 실제로 측정된 run 의 프로젝트가 1순위, 그다음 앱 카탈로그 매핑)
--      run.project_id 가 비어 있는 과거 run(2026-06, 594건)의 소속을 복원하는 데도 쓴다.
CREATE TEMP TABLE _prompt_proj ON COMMIT DROP AS
WITH by_answer AS (
  SELECT a.prompt_id, r.project_id, count(*) AS n
    FROM mig_src.scope_answers a JOIN mig_src.scope_runs r ON r.run_id = a.run_id
   WHERE a.prompt_id IS NOT NULL AND r.project_id IS NOT NULL
   GROUP BY 1, 2),
ranked AS (SELECT prompt_id, project_id, row_number() OVER (PARTITION BY prompt_id ORDER BY n DESC, project_id) AS rk FROM by_answer),
by_web AS (SELECT DISTINCT ON (w.scope_prompt_id) w.scope_prompt_id AS prompt_id, s.scope_project_id AS project_id
             FROM app.website_prompt w JOIN app.website_site s ON s.site_id = w.site_id
            WHERE w.scope_prompt_id IS NOT NULL AND s.scope_project_id IS NOT NULL ORDER BY w.scope_prompt_id, w.created_at),
by_app AS (SELECT DISTINCT ON (p.scope_prompt_id) p.scope_prompt_id AS prompt_id, pr.scope_project_id AS project_id
             FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id
            WHERE p.scope_prompt_id IS NOT NULL AND pr.scope_project_id IS NOT NULL
            ORDER BY p.scope_prompt_id, (p.deleted_at IS NOT NULL), p.updated_at DESC)
SELECT k.prompt_id,
       coalesce(ra.project_id, bw.project_id, ba.project_id) AS project_id,
       CASE WHEN ra.project_id IS NOT NULL THEN 'answers' WHEN bw.project_id IS NOT NULL THEN 'website_prompt'
            WHEN ba.project_id IS NOT NULL THEN 'app_prompt' END AS basis
  FROM (SELECT prompt_id FROM mig_src.scope_prompts
        UNION SELECT prompt_id FROM by_answer UNION SELECT prompt_id FROM by_web UNION SELECT prompt_id FROM by_app) k
  LEFT JOIN ranked ra ON ra.prompt_id = k.prompt_id AND ra.rk = 1
  LEFT JOIN by_web bw ON bw.prompt_id = k.prompt_id
  LEFT JOIN by_app ba ON ba.prompt_id = k.prompt_id;
CREATE UNIQUE INDEX ON _prompt_proj (prompt_id);

-- 1-3. run 의 scope project: 원본 → 원장 귀속(summary_cycle_runs→summary_cycles) → 소속 답변 프롬프트의 최빈 프로젝트
CREATE TEMP TABLE _run_proj ON COMMIT DROP AS
WITH led AS (SELECT cr.run_id, c.project_id FROM mig_src.summary_cycle_runs cr JOIN mig_src.summary_cycles c ON c.cycle_id = cr.cycle_id),
viap AS (
  SELECT a.run_id, pp.project_id, count(*) AS n,
         row_number() OVER (PARTITION BY a.run_id ORDER BY count(*) DESC, pp.project_id) AS rk
    FROM mig_src.scope_answers a JOIN _prompt_proj pp ON pp.prompt_id = a.prompt_id
   WHERE pp.project_id IS NOT NULL
   GROUP BY a.run_id, pp.project_id)
SELECT r.run_id, coalesce(r.project_id, led.project_id, vp.project_id) AS project_id,
       CASE WHEN r.project_id IS NOT NULL THEN 'source' WHEN led.project_id IS NOT NULL THEN 'ledger'
            WHEN vp.project_id IS NOT NULL THEN 'prompt' END AS basis
  FROM mig_src.scope_runs r
  LEFT JOIN led ON led.run_id = r.run_id
  LEFT JOIN viap vp ON vp.run_id = r.run_id AND vp.rk = 1;

-- 1-4. ing.prompt ← scope_prompts. scope_project_id 가 복원되지 않는 프롬프트는 NOT NULL 이라 제외(검증 표에 사유).
--      kind 는 미러에 없다(Scope listPrompts 의 kind 미저장): app.prompt.kind(같은 scope_prompt_id, 비삭제 우선)
--      → ACR 롤업이 있는 프롬프트면 'acr' → 웹사이트 프롬프트면 'single' → NULL. scope_updated_at 은 미러에 없어 NULL.
CREATE TEMP TABLE _app_kind ON COMMIT DROP AS
SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, kind FROM app.prompt
 WHERE scope_prompt_id IS NOT NULL ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), updated_at DESC;
CREATE UNIQUE INDEX ON _app_kind (scope_prompt_id);
INSERT INTO ing.prompt (scope_prompt_id, scope_project_id, text, funnel_stage, lang, regions, kind, scope_updated_at, synced_at)
SELECT sp.prompt_id, pp.project_id, sp.text, sp.funnel_stage, sp.lang, sp.regions,
       coalesce((SELECT ak.kind FROM _app_kind ak WHERE ak.scope_prompt_id = sp.prompt_id),
                CASE WHEN EXISTS (SELECT 1 FROM mig_src.scope_acr_rollups x WHERE x.prompt_id = sp.prompt_id) THEN 'acr' END,
                CASE WHEN EXISTS (SELECT 1 FROM app.website_prompt w WHERE w.scope_prompt_id = sp.prompt_id) THEN 'single' END),
       NULL, (SELECT max(synced_at) FROM mig_src.scope_runs)
  FROM mig_src.scope_prompts sp JOIN _prompt_proj pp ON pp.prompt_id = sp.prompt_id
 WHERE pp.project_id IS NOT NULL;

-- 1-5. ing.run ← scope_runs. run_month = started_at 의 KST 월(DB-적재-쓰기-스키마.sql:22).
--      trigger·targets·regions 는 미러에 없어 NULL. 카운터·재확인 창은 아래 1-8 에서 답변으로 채운다.
INSERT INTO ing.run (run_id, scope_project_id, run_month, status, trigger, targets, regions, total_jobs,
                     started_at, completed_at, cycle_anchor_at, sync_state, attempts, last_load_id, synced_at)
SELECT r.run_id, rp.project_id, pg_temp.kst_month(r.started_at), coalesce(r.status, 'unknown'), NULL, NULL, NULL, r.total_jobs,
       r.started_at, r.completed_at, r.cycle_anchor_at, 'loaded', 0, :seed_load, r.synced_at
  FROM mig_src.scope_runs r JOIN _run_proj rp ON rp.run_id = r.run_id
 WHERE rp.project_id IS NOT NULL AND r.started_at IS NOT NULL
 ORDER BY r.started_at, r.run_id;

-- 1-6. 파티션 leaf: run_month 마다 ing 원본 5표(rd.ensure_month_leaf, DB-v2.1.sql:612)
DO $l$ DECLARE m date; t text; BEGIN
  FOR m IN SELECT DISTINCT run_month FROM ing.run ORDER BY 1 LOOP
    FOREACH t IN ARRAY ARRAY['ing.answer', 'ing.mention', 'ing.mention_occurrence', 'ing.answer_stance', 'ing.citation'] LOOP
      PERFORM rd.ensure_month_leaf(t::regclass, m);
    END LOOP;
  END LOOP;
END $l$;
SELECT count(*) AS leaves FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace n ON n.oid = p.relnamespace
 WHERE n.nspname = 'ing' AND p.relname IN ('answer', 'mention', 'mention_occurrence', 'answer_stance', 'citation');

-- 1-7. 키 발급 + 답변 원본
--   measured_at 원복(DB-이관.md §0 함정 ①): 미러 measured_at 은 앵커로 접힌 값이다(anchorReapplySql scope-mirror.ts:114,
--   scope_anchor_fold 0053:59). 원본 = scope_answer_cycle_anchors.measured_at_orig(0077) → scope_answer_anchors.source_measured_at(0053)
--   → 미러 값 순.
--   content_hash = sha256(정규 JSON: 답변 원본 필드 + 자식 행 수). jsonb 텍스트는 키 정렬이 고정이고 TimeZone=UTC 로 시각 표기를 고정.
--   ⚠️ 적재기가 Scope API 응답으로 계산할 해시와는 입력 모양이 달라 비교할 수 없다(첫 재pull 에서 changed 로 잡혀 1회 교체된다).
--   prompt_run_id: 미러가 저장하지 않았다. 같은 run·같은 셀(prompt_id, target, region)의 ACR prompt_run 이 정확히 1개면 그것으로 채운다
--   (현행 접기 대체 키 cellKeyForJob sync.ts:966 와 같은 좌표). analysis_status·analysis_version·quality_breakdown 은 미러에 없어 NULL.
CREATE TEMP TABLE _ans ON COMMIT DROP AS
SELECT a.job_id, a.run_id, r.run_month, r.started_at AS run_started_at, a.prompt_id, a.target, a.region, coalesce(a.status, 'unknown') AS status,
       coalesce(ca.measured_at_orig, pin.source_measured_at, a.measured_at) AS measured_at,
       a.measured_at AS mirror_measured_at, r.synced_at
  FROM mig_src.scope_answers a
  JOIN ing.run r ON r.run_id = a.run_id
  LEFT JOIN mig_src.scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
  LEFT JOIN mig_src.scope_answer_anchors pin ON pin.job_id = a.job_id;
CREATE UNIQUE INDEX ON _ans (job_id);
ANALYZE _ans;

INSERT INTO ing.answer_key_map (job_id, run_month)
SELECT job_id, run_month FROM _ans ORDER BY run_started_at, run_id, job_id;

CREATE TEMP TABLE _cnt ON COMMIT DROP AS
SELECT x.job_id, sum(x.m)::int AS n_mentions, sum(x.c)::int AS n_citations FROM (
  SELECT job_id, count(*) AS m, 0 AS c FROM mig_src.scope_mentions GROUP BY job_id
  UNION ALL SELECT job_id, 0, count(*) FROM mig_src.scope_citations GROUP BY job_id) x
GROUP BY x.job_id;
CREATE UNIQUE INDEX ON _cnt (job_id);

CREATE TEMP TABLE _cell_pr ON COMMIT DROP AS
SELECT run_id, prompt_id, target, coalesce(region, '') AS region_k, min(prompt_run_id::text)::uuid AS prompt_run_id, count(DISTINCT prompt_run_id) AS n
  FROM mig_src.scope_acr_rollups WHERE prompt_id IS NOT NULL GROUP BY 1, 2, 3, 4;
CREATE INDEX ON _cell_pr (run_id, prompt_id, target, region_k);

INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, model_slug,
                        prompt_run_id, analysis_status, analysis_version, quality_breakdown, answer_text,
                        n_mentions, n_citations, result_fallback, content_hash, seed_origin, first_seen_at, load_id)
SELECT a.run_month, a.job_id, k.answer_key, a.run_id, a.prompt_id, a.target, a.region, a.status, a.measured_at, src.model_slug,
       CASE WHEN cp.n = 1 THEN cp.prompt_run_id END, NULL, NULL, NULL, src.answer_text,
       coalesce(c.n_mentions, 0), coalesce(c.n_citations, 0), false,
       sha256(convert_to(jsonb_build_object(
         'job_id', a.job_id, 'run_id', a.run_id, 'prompt_id', a.prompt_id, 'target', a.target, 'region', a.region,
         'status', a.status, 'measured_at', a.measured_at, 'model_slug', src.model_slug, 'answer_text', src.answer_text,
         'n_mentions', coalesce(c.n_mentions, 0), 'n_citations', coalesce(c.n_citations, 0))::text, 'UTF8')),
       'mirror_seed', coalesce(a.synced_at, now()), :seed_load
  FROM _ans a
  JOIN mig_src.scope_answers src ON src.job_id = a.job_id
  JOIN ing.answer_key_map k ON k.job_id = a.job_id
  LEFT JOIN _cnt c ON c.job_id = a.job_id
  LEFT JOIN _cell_pr cp ON cp.run_id = a.run_id AND cp.prompt_id = a.prompt_id AND cp.target = a.target AND cp.region_k = coalesce(a.region, '');

-- 1-8. run 카운터·재확인 창(R12 워터마크의 시드값)
--   seen_jobs = 미러에 있는 job 수(⚠️ 미러는 ACR 반복 중 대표 job 만 보존: sync.ts:1648-1650, 그래서 total_jobs 보다 작을 수 있다)
--   completed_jobs = status completed, unresolved_jobs = 종결 아닌 job(pending·running·queued 등),
--   analysis_pending = 완료인데 언급·인용이 모두 없는 job(현행 분석 갭 대용식 lib/summary/generate/cycle.ts:124-126 과 같은 술어)
--   recheck_until = coalesce(completed_at, started_at) + run_recheck_days(3), analysis_recheck_until = + analysis_recheck_days(7)
UPDATE ing.run r SET
  seen_jobs = s.seen, completed_jobs = s.completed, unresolved_jobs = s.unresolved, analysis_pending = s.pending,
  recheck_until = coalesce(r.completed_at, r.started_at) + make_interval(days => (SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'run_recheck_days')),
  analysis_recheck_until = coalesce(r.completed_at, r.started_at) + make_interval(days => (SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'analysis_recheck_days'))
  FROM (SELECT run_id, count(*) AS seen,
               count(*) FILTER (WHERE status = 'completed') AS completed,
               count(*) FILTER (WHERE status NOT IN ('completed', 'failed', 'partial_failed', 'cancelled', 'canceled', 'error', 'skipped')) AS unresolved,
               count(*) FILTER (WHERE status = 'completed' AND n_mentions = 0 AND n_citations = 0) AS pending
          FROM ing.answer GROUP BY run_id) s
 WHERE s.run_id = r.run_id;
UPDATE ing.run r SET
  recheck_until = coalesce(r.completed_at, r.started_at) + make_interval(days => (SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'run_recheck_days')),
  analysis_recheck_until = coalesce(r.completed_at, r.started_at) + make_interval(days => (SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'analysis_recheck_days'))
 WHERE r.recheck_until IS NULL;
COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- 단계 2~5. 자식 원본(언급·발생·스탠스·인용). job 이 ing.answer_key_map 에 없는 원본 행(드롭 잔존 등)은 넣지 않는다.
--   ord 는 1부터(WITH ORDINALITY 관례). 미러에는 배열 순번이 없어:
--   언급 = (avg_position NULLS LAST, entity_id) 순(미러 PK 가 (job_id, entity_id) 라 원 배열 순서 소실),
--   발생·인용 = 미러 bigserial id 순(삽입 순서 = Scope 배열 순서, appendJobRows sync.ts:1305·1331).
-- ════════════════════════════════════════════════════════════════════════════
\echo '== 2. mention'
BEGIN;
TRUNCATE ing.mention;
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count,
                         sentiment_positive, sentiment_neutral, sentiment_negative, sentiment_mixed, avg_position, surfaces,
                         brand_rollup_entity_id, product_rollup_entity_id, company_rollup_entity_id,
                         type_mention, type_recommendation, type_comparison, type_definition, type_final_choice)
SELECT k.run_month, m.job_id,
       row_number() OVER (PARTITION BY m.job_id ORDER BY m.avg_position NULLS LAST, m.entity_id)::int2,
       m.entity_id, m.brand, m.entity_type, m.mention_count,
       m.sentiment_positive, m.sentiment_neutral, m.sentiment_negative, m.sentiment_mixed, m.avg_position, m.surfaces,
       m.brand_rollup_entity_id, NULL, NULL,
       m.type_mention, m.type_recommendation, m.type_comparison, m.type_definition, m.type_final_choice
  FROM mig_src.scope_mentions m JOIN ing.answer_key_map k ON k.job_id = m.job_id;
COMMIT;

\echo '== 3. mention_occurrence'
BEGIN;
TRUNCATE ing.mention_occurrence;
INSERT INTO ing.mention_occurrence (run_month, job_id, ord, entity_id, brand_rollup_entity_id, turn_index, source_start, source_end,
                                    surface_text, sentiment, mention_role, assertion, context_snippet, descriptors, criteria)
SELECT k.run_month, o.job_id, row_number() OVER (PARTITION BY o.job_id ORDER BY o.id)::int,
       o.entity_id, o.brand_rollup_entity_id, o.turn_index::int2, o.source_start, o.source_end,
       o.surface_text, o.sentiment, o.mention_role, o.assertion, o.context_snippet, o.descriptors, o.criteria
  FROM mig_src.scope_mention_occurrences o JOIN ing.answer_key_map k ON k.job_id = o.job_id;
COMMIT;

\echo '== 4. answer_stance'
BEGIN;
TRUNCATE ing.answer_stance;
INSERT INTO ing.answer_stance (run_month, job_id, turn_index, entity_id, brand_label, is_tracked, stance, confidence,
                               evidence_text, evidence_start, evidence_end, reason, model_slug)
SELECT k.run_month, s.job_id, s.turn_index::int2, s.entity_id, s.brand_label, s.is_tracked, s.stance, s.confidence,
       s.evidence_text, s.evidence_start, s.evidence_end, s.reason, s.model_slug
  FROM mig_src.scope_answer_stances s JOIN ing.answer_key_map k ON k.job_id = s.job_id;
COMMIT;

\echo '== 5. citation'
BEGIN;
TRUNCATE ing.citation;
-- scope_category = Scope 가 준 category(미러 category 열, sync.ts:1336-1338). host = 미러 url_host(0052 citation_url_host),
-- domain_label = 미러 domain(registrableDomainOfHost, sync.ts:1332). 둘은 미러 파생값이며 Scope 원본 필드가 아니다.
INSERT INTO ing.citation (run_month, job_id, ord, url, title, ref_index, scope_category, host, domain_label)
SELECT k.run_month, c.job_id, row_number() OVER (PARTITION BY c.job_id ORDER BY c.id)::int2,
       c.url, c.title, c.ref_index, c.category, c.url_host, c.domain
  FROM mig_src.scope_citations c JOIN ing.answer_key_map k ON k.job_id = c.job_id;
COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- 단계 6. ACR 원본: prompt_run 1행 + 롤업 행(prompt_run × 엔티티 × 레벨)
--   미러 scope_acr_rollups 는 prompt_run 단위 값(반복 수·선택 결과 분해)을 엔티티 행마다 반복해 담았다(sync.ts:1180-1216).
--   acr_summary 원문은 미러에 없다 → {origin, rows} 표지만 둔다(원문은 적재기 재pull 때 채워진다).
--   source_job_ids: 미러에 없다. 같은 run·같은 셀(prompt_id, target, region)의 시드 job 으로 복원(미러는 대표 job 1개만 보존).
--   rollup_level NULL 은 현행 접기 규칙(dedupeAcrRowsByEntity: brand 우선, sync.ts:1052)에 따라 'brand' 로 본다.
-- ════════════════════════════════════════════════════════════════════════════
\echo '== 6. acr'
BEGIN;
TRUNCATE ing.acr_rollup_row, ing.acr_prompt_run;
INSERT INTO ing.acr_prompt_run (prompt_run_id, run_id, prompt_id, target, region, measured_at,
                                planned_iterations, valid_turn1_iterations, valid_acr_iterations,
                                co_single_entity, co_conditional_multiple, co_generic_category, co_resolved_off_shortlist,
                                co_unresolved_choice, co_none, source_job_ids, acr_summary, load_id)
SELECT g.prompt_run_id, g.run_id, g.prompt_id, g.target, g.region, g.measured_at,
       g.planned, g.turn1, g.acr, g.co1, g.co2, g.co3, g.co4, g.co5, g.co6,
       coalesce(sj.ids, '{}'),
       jsonb_build_object('origin', 'mirror_seed', 'rows', g.nrows), :seed_load
  FROM (SELECT x.prompt_run_id, min(x.run_id::text)::uuid AS run_id, min(x.prompt_id::text)::uuid AS prompt_id,
               coalesce(min(x.target), '') AS target, min(x.region) AS region, max(x.measured_at) AS measured_at,
               max(x.planned_iterations)::int2 AS planned, max(x.valid_turn1_iterations)::int2 AS turn1, max(x.valid_acr_iterations)::int2 AS acr,
               max(x.co_single_entity)::int2 AS co1, max(x.co_conditional_multiple)::int2 AS co2, max(x.co_generic_category)::int2 AS co3,
               max(x.co_resolved_off_shortlist)::int2 AS co4, max(x.co_unresolved_choice)::int2 AS co5, max(x.co_none)::int2 AS co6,
               count(*) AS nrows
          FROM mig_src.scope_acr_rollups x JOIN ing.run r ON r.run_id = x.run_id
         GROUP BY x.prompt_run_id) g
  LEFT JOIN (SELECT a.run_id, a.prompt_id, a.target, coalesce(a.region, '') AS region_k, array_agg(a.job_id ORDER BY a.job_id) AS ids
               FROM ing.answer a
              WHERE a.prompt_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM mig_src.scope_acr_rollups x WHERE x.run_id = a.run_id AND x.prompt_id = a.prompt_id)
              GROUP BY 1, 2, 3, 4) sj
    ON sj.run_id = g.run_id AND sj.prompt_id = g.prompt_id AND sj.target = g.target AND sj.region_k = coalesce(g.region, '')
 ORDER BY g.measured_at NULLS LAST, g.prompt_run_id;   -- acr_cell_key(IDENTITY) 발급 순서 고정
INSERT INTO ing.acr_rollup_row (prompt_run_id, entity_id, rollup_level, run_id, entity_name, brand_rollup_entity_id, parent_name, entity_type,
                                appearance_count, choice_count, conditional_choice_count, off_shortlist_choice_count,
                                unresolved_choice_count, generic_choice_count, appearance_rate, acr, overall_choice_share)
SELECT x.prompt_run_id, x.entity_id, coalesce(x.rollup_level, 'brand'), x.run_id, x.brand, x.brand_rollup_entity_id, x.parent_brand, x.entity_type,
       x.appearance_count, x.choice_count, x.conditional_choice_count, x.off_shortlist_choice_count,
       x.unresolved_choice_count, x.generic_choice_count, x.appearance_rate, x.acr, x.overall_choice_share
  FROM mig_src.scope_acr_rollups x JOIN ing.acr_prompt_run p ON p.prompt_run_id = x.prompt_run_id;
COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- 단계 7. 운영 레지스트리·회차 원장·귀속·커서, 적재 원장 마감
-- ════════════════════════════════════════════════════════════════════════════
\echo '== 7. registry·cycle·cursor'
BEGIN;
TRUNCATE ing.cycle_run, ing.cycle, ing.cycle_round, ing.answer_anchor_pin, ing.answer_drop, ing.answer_mirror_time, ing.sync_cursor;

-- 7-1. 앵커 고정 ← scope_answer_anchors(0053). 드롭 ← scope_answer_drops(0054). 운영자 원장이므로 job 이 미러에 없어도 전량 보존
--      (드롭 job 은 미러가 답변·언급·인용을 지웠다: scope_answer_drop_apply 0054:51). origin = 'mirror_seed'.
INSERT INTO ing.answer_anchor_pin (job_id, anchor, source_measured_at, reason, pinned_at, origin)
SELECT job_id, anchor, source_measured_at, coalesce(reason, 'mirror_seed: 사유 미기재'), folded_at, 'mirror_seed'
  FROM mig_src.scope_answer_anchors;
INSERT INTO ing.answer_drop (job_id, source_measured_at, reason, dropped_at, origin)
SELECT job_id, source_measured_at, reason, dropped_at, 'mirror_seed' FROM mig_src.scope_answer_drops;
-- 7-1'. 현행 미러 measured_at 예외(DB-v2.19 P107, 동결 스냅샷 층(결정 31)의 카드 셀 대표 정렬 시각. is_rep 에는 쓰지 않는다). 현행 카드 셀 대표는
--      미러 measured_at(앵커 핀으로 접힌 값, scope-mirror.ts:101-127·0053 scope_anchor_fold)으로 고른다. 위 1-7 은 원본으로 원복했으므로 정렬 시각 = rd.rep_order_at(원본, 예외, 핀)이고,
--      핀 접기로 재현되지 않는 답변만 미러 값을 여기 둔다(stg 2026-10-01 실측 166행). back/migration/fill-v219.sql 과 같은 식.
INSERT INTO ing.answer_mirror_time (job_id, measured_at, origin)
SELECT a.job_id, m.measured_at, 'mirror_seed'
  FROM ing.answer a
  JOIN mig_src.scope_answers m ON m.job_id = a.job_id
  LEFT JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
 WHERE m.measured_at IS NOT NULL
   AND rd.rep_order_at(a.measured_at, NULL, p.anchor) IS DISTINCT FROM m.measured_at;

-- 7-2. 좌석 배정 원장 ← scope_cycle_rounds(0077 hmg_assign_cycle_rounds 결과, 과거 배정은 재계산하지 않는 원장). 'standard' → 'global'.
INSERT INTO ing.cycle_round (scope_project_id, anchor_date, surface, round_date, basis, assigned_at)
SELECT project_id, anchor_date, CASE surface WHEN 'standard' THEN 'global' ELSE surface END, round_date, basis, assigned_at
  FROM mig_src.scope_cycle_rounds;

-- 7-3. 회차 원장 ← summary_cycles(1:1, cycle_id 보존, G-09). anchor_date = KST 날짜(hmg_anchor_date 0077:95, 타임존 :83),
--      round_date = 좌석 원장(hmg_round_date_of 0077:580, 매핑 없으면 anchor_date).
--        -v attrib_member=1(현행 프로필 resub_phantom_exclude): 현행 좌석 = 앵커 표에서 그 회차 답변의 최소 round_date(현행 사실표 경로의 회차 자리,
--        hmg-geo 2670a16 lib/period/anchor-axis.ts:254-266 cycleRoundJoinSql min(round_date) GROUP BY cycle_id → summary-cycles.ts:166
--        COALESCE(그 값, 앵커 KST 일자)). pin 으로 코호트가 다른 날짜에 접힌 원장 회차는 그 날짜 자리에 선다(stg hmg_r2 2026-10-01: 웹 원장
--        08-01·08-02 회차 24개가 07-24, 재제출 유령 회차 6개가 09-17 → 09-18, 나머지 회차는 매핑과 같다).
--      status 'generating' → 'closed'(새 CHECK 에 없음, 생성 중 = 종결된 회차). hidden_scope NULL + 사유 있음 → 'all'(0071 COMMENT).
--      completed_answers·gap_answers 는 원장에 없어 아래 7-6 에서 시드 답변으로 계산. published_at 은 원장에 없어 NULL.
INSERT INTO ing.cycle (cycle_id, surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status,
                       closed_by, closed_at, expected_units, completed_units, fleet_visible, view_anchor_at,
                       hidden_scope, hidden_reason, hidden_at, published_at, stale_since, projected_round_date, generation, origin, updated_at)
SELECT c.cycle_id, c.surface, c.project_id, c.cycle_anchor_at, c.anchor_source,
       (c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date,
       coalesce(CASE WHEN :'attrib_member' = '1'
                     THEN (SELECT min(x.round_date) FROM mig_src.scope_answer_cycle_anchors x WHERE x.cycle_id = c.cycle_id) END,
                cr.round_date, (c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date),
       CASE c.status WHEN 'generating' THEN 'closed' ELSE c.status END,
       c.closed_by, c.closed_at, c.expected_units, c.completed_units, c.fleet_visible, c.view_anchor_at,
       CASE WHEN c.hidden_reason IS NOT NULL THEN coalesce(c.hidden_scope, 'all') END, c.hidden_reason, c.hidden_at,
       NULL, c.stale_since, NULL, 1, 'summary_cycles', now()
  FROM mig_src.summary_cycles c
  LEFT JOIN mig_src.scope_cycle_rounds cr ON cr.project_id = c.project_id AND cr.anchor_date = (c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date
 ORDER BY c.cycle_anchor_at, c.cycle_id;   -- cyc_key(IDENTITY) 발급 순서 고정

INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by, attributed_at)
SELECT cr.run_id, cr.cycle_id, cr.attributed_by, cr.attributed_at
  FROM mig_src.summary_cycle_runs cr JOIN ing.run r ON r.run_id = cr.run_id JOIN ing.cycle c ON c.cycle_id = cr.cycle_id;
-- 이관 회차의 현행 갭 원값·상태(DB-v2.30 P148): 창 판정(현행 judgeCycleRange 구멍·isGeneratorSkipped 면제)은 현행 갭으로 한다.
-- 이관 때 open 인 회차는 허브가 종결·계수하므로 적지 않는다. 패치 전 DB 에서는 건너뛴다(채우기 = fill-v230.sql 와 같은 문장)
DO $pb$ BEGIN
  IF to_regclass('ing.cycle_ops_gap') IS NOT NULL THEN
    EXECUTE 'TRUNCATE ing.cycle_ops_gap';
    EXECUTE $q$
      INSERT INTO ing.cycle_ops_gap (cycle_id, analysis_gap_ratio, ops_status)
      SELECT s.cycle_id, s.analysis_gap_ratio, s.status
        FROM mig_src.summary_cycles s JOIN ing.cycle c ON c.cycle_id = s.cycle_id AND c.origin = 'summary_cycles'
       WHERE s.status <> 'open'
      ON CONFLICT (cycle_id) DO UPDATE SET analysis_gap_ratio = EXCLUDED.analysis_gap_ratio, ops_status = EXCLUDED.ops_status$q$;
  END IF;
END $pb$;

-- 7-4. 파생 회차: 원장에 귀속되지 않은 run(원장이 모르는 run). IG-3 attribute 규칙(모듈-적재-파이프라인.md §3-6):
--      run 앵커가 있으면 (project, cycle_anchor_at) 회차에 붙인다(원장에 같은 키가 있으면 그 회차, anchor_source 'scope').
--      run 앵커가 없으면 측정일 회차(anchor_source 'derived'): 같은 프로젝트·같은 KST 측정일의 앵커 없는 run 을 한 회차로 묶고,
--      앵커 시각 = 그 묶음의 최초 측정 시각(시드 답변 measured_at 원복값, 답변이 없으면 run started_at).
--      project 표면은 가상 회차라 anchor_source 'derived'(DB-v2.1.sql:330).
CREATE TEMP TABLE _orph ON COMMIT DROP AS
WITH b AS (
  SELECT r.run_id, r.scope_project_id, coalesce(ps.surface, 'project') AS surface, r.cycle_anchor_at, r.started_at, r.completed_at,
         coalesce((SELECT min(a.measured_at) FROM ing.answer a WHERE a.run_id = r.run_id), r.started_at) AS first_at
    FROM ing.run r LEFT JOIN _proj_surface ps ON ps.scope_project_id = r.scope_project_id
   WHERE NOT EXISTS (SELECT 1 FROM ing.cycle_run cr WHERE cr.run_id = r.run_id))
SELECT b.run_id, b.scope_project_id, b.surface,
       coalesce(b.cycle_anchor_at,
                min(b.first_at) FILTER (WHERE b.cycle_anchor_at IS NULL)
                  OVER (PARTITION BY b.scope_project_id, (b.first_at AT TIME ZONE 'Asia/Seoul')::date, b.cycle_anchor_at IS NULL)) AS anchor_at,
       b.cycle_anchor_at IS NOT NULL AS has_scope_anchor, b.started_at, b.completed_at
  FROM b;

-- cycle_id 는 (scope project, 앵커 시각 epoch 마이크로초) md5 로 결정론적으로 만든다(재실행해도 같은 uuid, 현행 hmg_cycle_key 0078:145 와 같은 재료).
INSERT INTO ing.cycle (cycle_id, surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status, generation, origin, updated_at)
SELECT DISTINCT ON (o.scope_project_id, o.anchor_at)
       md5('derived|' || o.scope_project_id::text || '|' || (extract(epoch FROM o.anchor_at) * 1000000)::bigint::text)::uuid,
       o.surface, o.scope_project_id, o.anchor_at,
       CASE WHEN o.surface = 'project' OR NOT o.has_scope_anchor THEN 'derived' ELSE 'scope' END,
       (o.anchor_at AT TIME ZONE 'Asia/Seoul')::date,
       coalesce(cr.round_date, (o.anchor_at AT TIME ZONE 'Asia/Seoul')::date),
       'open', 1, 'loader', now()
  FROM _orph o
  LEFT JOIN ing.cycle_round cr ON cr.scope_project_id = o.scope_project_id AND cr.anchor_date = (o.anchor_at AT TIME ZONE 'Asia/Seoul')::date
 WHERE NOT EXISTS (SELECT 1 FROM ing.cycle c WHERE c.scope_project_id = o.scope_project_id AND c.cycle_anchor_at = o.anchor_at)
 ORDER BY o.scope_project_id, o.anchor_at, o.has_scope_anchor DESC;

-- 귀속 구분: 원장 회차에 붙는데 그 회차가 이미 종결(closed·published·stale)이고 현행 답변 앵커 표(scope_answer_cycle_anchors)가
--   이 run 을 그 회차로 본 적이 없으면 'late'(현행 원장의 '종결 뒤 늦게 붙은 run' 의미, summary-cycles.ts cycleAttributeSql).
--   대표 사례: 2026-06 글로벌 루트 run 중 미러 project_id 가 비어 있던 것(프롬프트로 소속 복원) → 현행 글로벌 집계에서 빠져 있던 답변.
INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by, attributed_at)
SELECT o.run_id, c.cycle_id,
       CASE WHEN c.origin = 'summary_cycles' THEN
              CASE WHEN c.status IN ('closed', 'published', 'stale')
                        AND NOT EXISTS (SELECT 1 FROM mig_src.scope_answer_cycle_anchors x WHERE x.run_id = o.run_id AND x.cycle_id = c.cycle_id)
                   THEN 'late' ELSE 'scope' END
            WHEN c.anchor_source = 'derived' THEN 'derived' ELSE 'scope' END, now()
  FROM _orph o JOIN ing.cycle c ON c.scope_project_id = o.scope_project_id AND c.cycle_anchor_at = o.anchor_at;

-- 7-5. 파생 회차 상태(원장 회차는 원장 값 그대로): 종결 3팔 중 시드에서 판정 가능한 둘(summary-cycles.ts:1232-1258)
--      다음 앵커 존재 → closed/next_anchor(closed_at = 다음 앵커 시각), 소속 run started_at 이 모두 재확인 창(3일) 밖 → closed/recheck_window
--      (closed_at = 최신 started_at + 3일). 그 밖은 open. project 표면의 종결 회차는 현행 노출 규칙(앵커 +1일, 0077 hmg_anchor_view_date ②)에
--      따라 published + view_anchor_at = (anchor_date + 1) KST 자정. 글로벌·웹사이트 파생 회차는 현행 규칙 ③ 비노출(view NULL)이라 closed 에 머문다.
WITH d AS (
  SELECT c.cycle_id, c.surface, c.anchor_date,
         (SELECT min(n.cycle_anchor_at) FROM ing.cycle n WHERE n.scope_project_id = c.scope_project_id AND n.cycle_anchor_at > c.cycle_anchor_at) AS next_at,
         (SELECT max(r.started_at) FROM ing.cycle_run cr JOIN ing.run r ON r.run_id = cr.run_id WHERE cr.cycle_id = c.cycle_id) AS last_start
    FROM ing.cycle c WHERE c.origin = 'loader'),
j AS (
  SELECT d.*, CASE WHEN d.next_at IS NOT NULL THEN 'next_anchor'
                   WHEN d.last_start IS NOT NULL AND d.last_start + interval '3 days' < now() THEN 'recheck_window' END AS cb
    FROM d)
UPDATE ing.cycle c SET
  status = CASE WHEN j.cb IS NULL THEN 'open' WHEN j.surface = 'project' THEN 'published' ELSE 'closed' END,
  closed_by = j.cb,
  closed_at = CASE j.cb WHEN 'next_anchor' THEN j.next_at WHEN 'recheck_window' THEN j.last_start + interval '3 days' END,
  view_anchor_at = CASE WHEN j.surface = 'project' THEN ((j.anchor_date + 1)::timestamp AT TIME ZONE 'Asia/Seoul') END
  FROM j WHERE j.cycle_id = c.cycle_id;

-- 7-6. 회차 카운터(D8 예외 ③, R01·R08 근거). 원장 회차의 expected_units·completed_units 는 원장 동결값을 보존(P6)하고 없을 때만 계산.
--      completed_answers = 소속 run 의 완료 답변 수, gap_answers = 그중 언급·인용이 모두 없는 답변(현행 대용식 cycle.ts:124-126).
--      expected/completed_units = 셀 (prompt_id, target, region) 수(현행 cycle.ts:113-115).
WITH s AS (
  SELECT cr.cycle_id,
         count(DISTINCT (a.prompt_id, a.target, a.region)) AS expected_units,
         count(DISTINCT (a.prompt_id, a.target, a.region)) FILTER (WHERE a.status = 'completed') AS completed_units,
         count(*) FILTER (WHERE a.status = 'completed') AS completed_answers,
         count(*) FILTER (WHERE a.status = 'completed' AND a.n_mentions = 0 AND a.n_citations = 0) AS gap_answers
    FROM ing.cycle_run cr JOIN ing.answer a ON a.run_id = cr.run_id
   GROUP BY cr.cycle_id)
UPDATE ing.cycle c SET
  expected_units = coalesce(c.expected_units, s.expected_units),
  completed_units = coalesce(c.completed_units, s.completed_units),
  completed_answers = s.completed_answers, gap_answers = s.gap_answers
  FROM s WHERE s.cycle_id = c.cycle_id;

-- 7-7. 커서: 알려진 scope project 전부(미러 커서 ∪ 앱 등록 ∪ run 소속). 표면 = 1-1 규칙, 모르면 'project'.
--      last_attempt_at·last_error = 미러 커서, last_success_at = 그 프로젝트 run 의 최종 동기화 시각(미러 scope_runs.synced_at 최대).
--      prompts_updated_to·regions 는 미러에 없어 NULL(적재기 첫 패스가 채운다).
INSERT INTO ing.sync_cursor (scope_project_id, surface, last_attempt_at, last_success_at, last_error, prompts_updated_to)
SELECT k.pid, coalesce(ps.surface, 'project'), sc.last_attempt_at,
       (SELECT max(r.synced_at) FROM ing.run r WHERE r.scope_project_id = k.pid),
       left(sc.last_error, 2000), NULL
  FROM (SELECT project_id AS pid FROM mig_src.scope_sync_cursors
        UNION SELECT scope_project_id FROM _proj_surface
        UNION SELECT scope_project_id FROM ing.run) k
  LEFT JOIN _proj_surface ps ON ps.scope_project_id = k.pid
  LEFT JOIN mig_src.scope_sync_cursors sc ON sc.project_id = k.pid;

-- 7-8. 적재 원장 마감
UPDATE ing.load SET status = 'committed', finished_at = clock_timestamp(),
       jobs_fetched = (SELECT count(*) FROM ing.answer), jobs_changed = (SELECT count(*) FROM ing.answer), jobs_removed = 0
 WHERE load_id = :seed_load;

-- 7-9. 단언: 모든 run 은 회차 1개에 귀속, 자식 고아 0, 파생 회차 CHECK 충족
DO $a$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM ing.run r WHERE NOT EXISTS (SELECT 1 FROM ing.cycle_run cr WHERE cr.run_id = r.run_id);
  IF v <> 0 THEN RAISE EXCEPTION '회차 미귀속 run %', v; END IF;
  SELECT count(*) INTO v FROM ing.answer a WHERE NOT EXISTS (SELECT 1 FROM ing.answer_key_map k WHERE k.job_id = a.job_id AND k.answer_key = a.answer_key AND k.run_month = a.run_month);
  IF v <> 0 THEN RAISE EXCEPTION 'answer ↔ answer_key_map 불일치 %', v; END IF;
END $a$;
COMMIT;

ANALYZE ing.run, ing.answer_key_map, ing.answer, ing.mention, ing.mention_occurrence, ing.answer_stance, ing.citation,
        ing.acr_prompt_run, ing.acr_rollup_row, ing.prompt, ing.cycle, ing.cycle_run, ing.cycle_round,
        ing.answer_anchor_pin, ing.answer_drop, ing.answer_mirror_time, ing.sync_cursor;
SELECT load_id, kind, status, rule_ver, jobs_fetched, finished_at - started_at AS elapsed FROM ing.load;

-- 7-10. 관리 엔티티 목록 합계(DB-v2.25 P132, 엔티티 관리 5차): 위 단계의 TRUNCATE ing.mention·ing.answer_drop 은 문장 트리거 차분을 남기지
--   않으므로 이관 끝에 전체 재계산한다(재실행해도 같은 값). 패치가 아직 없으면(이관 순서상 앞) 건너뛴다.
DO $t$ BEGIN
  IF to_regprocedure('rd.refresh_entity_mention_total(uuid[])') IS NOT NULL THEN
    PERFORM rd.refresh_entity_mention_total(NULL);
    PERFORM rd.assert_entity_mention_total();
  END IF;
END $t$;
