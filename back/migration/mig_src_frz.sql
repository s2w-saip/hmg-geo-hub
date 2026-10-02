-- ============================================================================
-- mig_src 동결 층 이관 입력 표(결정 32, DB-v2.21, card-snapshot-design.md 12장). export.py --frz 가 운영 미러에서 뽑은 CSV 를 그대로 받는다
-- (열 순서 = export.py FRZ 질의의 SELECT 순서). 멱등(IF NOT EXISTS). 소유 = 적용자, 읽기 = migrator(이관기 ingest.cli frz-import-ops).
-- 운영 summary 세부층 전체가 아니라 활성 세대의 셀 집합·프롬프트 축·판정 입력 + 생성 뒤 바뀐 답변(동기화 지문이 바뀐 run)의 세부층 행 +
-- 회차별 집계층 합(단언 기준값)만 담는다. 운영 실측(2026-10-01, 활성 세대 924): 셀 472,083 · 프롬프트 362,209 · 바뀐 답변 후보 1,066.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS mig_src;

-- 추출 시작·끝 마커(회차별 활성 세대). 두 값이 다르면 추출 중 재생성 = 이관기가 그 회차를 건너뛴다
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_marker (
  phase text NOT NULL CHECK (phase IN ('start', 'end')), cycle_id uuid NOT NULL, surface text NOT NULL, project_id uuid NOT NULL,
  active_generation_id uuid, captured_at timestamptz NOT NULL, PRIMARY KEY (phase, cycle_id));

CREATE TABLE IF NOT EXISTS mig_src.frz_ops_generation (
  generation_id uuid PRIMARY KEY, cycle_id uuid NOT NULL, generator_version text NOT NULL, status text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz, row_counts jsonb, checksum text,
  roster_snapshot jsonb, base_universe jsonb, target_universe jsonb, noise_snapshot jsonb);

CREATE TABLE IF NOT EXISTS mig_src.frz_ops_cell (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, cycle_week date NOT NULL, job_id uuid NOT NULL, run_id uuid NOT NULL,
  prompt_id uuid NOT NULL, engine text NOT NULL, country text NOT NULL, measured_at timestamptz NOT NULL,
  PRIMARY KEY (cycle_id, generation_id, job_id));

CREATE TABLE IF NOT EXISTS mig_src.frz_ops_prompt (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, prompt_id uuid NOT NULL, project_id uuid NOT NULL, lang text,
  catalog_brands text[] NOT NULL, funnel_catalog text, funnel_scope text, brand_presence_resolved text, presence_set text[] NOT NULL,
  list_type text, depth1 text, depth2 text, depth3 text, regions text[], is_korean integer, in_root_catalog integer NOT NULL,
  catalog_status text, catalog_deleted integer NOT NULL, in_full_cycle integer NOT NULL, expected_cells integer, window_cells integer,
  report_fs integer, unit_base text, site_country text, site_lang text,
  PRIMARY KEY (cycle_id, generation_id, prompt_id));

-- 생성 뒤 바뀐 답변 후보 = 동기화 지문(scope_runs.synced_at ≠ summary_cycle_runs.synced_at_seen)이 바뀐 run 의 셀 답변.
-- fp_changed = 언급 지문(언급 수·감정·유형·최소 순위 합)이 지금 미러와 다름, cit_changed = 인용 수가 다름(정보용: 이관기는 행 값으로 다시 판정)
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_changed (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, job_id uuid NOT NULL, run_id uuid NOT NULL,
  synced_at_seen timestamptz, synced_at timestamptz, fp_changed boolean NOT NULL, cit_changed boolean NOT NULL,
  PRIMARY KEY (cycle_id, generation_id, job_id));

CREATE TABLE IF NOT EXISTS mig_src.frz_ops_answer (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, job_id uuid NOT NULL, prompt_id uuid NOT NULL, engine text NOT NULL,
  country text NOT NULL, run_status text NOT NULL, in_root_catalog integer NOT NULL, in_tagged_region integer NOT NULL,
  in_full_cycle integer NOT NULL, monitored integer NOT NULL, all_mentions integer NOT NULL, all_citations integer NOT NULL,
  has_any_brand integer NOT NULL, report_fs integer, unit_owned integer, unit_target integer,
  PRIMARY KEY (cycle_id, generation_id, job_id));

CREATE TABLE IF NOT EXISTS mig_src.frz_ops_brand (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, job_id uuid NOT NULL, brand_id uuid NOT NULL, brand_name text NOT NULL,
  is_competitor integer NOT NULL, mentions integer NOT NULL, first_rank real, positive integer NOT NULL, neutral integer NOT NULL,
  negative integer NOT NULL, mixed integer NOT NULL, type_mention integer NOT NULL, type_recommendation integer NOT NULL,
  type_comparison integer NOT NULL, type_definition integer NOT NULL, type_final_choice integer NOT NULL);
CREATE INDEX IF NOT EXISTS frz_ops_brand_job_idx ON mig_src.frz_ops_brand (cycle_id, generation_id, job_id);

-- 단언 기준값: 운영 집계층(summary_trend_*) 회차 합. answers = trend_answers, domain_citations = trend_domains
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_sum_cycle (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, cells bigint NOT NULL, cells_ifc bigint NOT NULL, all_mentions bigint NOT NULL,
  all_citations bigint NOT NULL, has_any_brand bigint NOT NULL, domain_citations bigint NOT NULL, PRIMARY KEY (cycle_id, generation_id));
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_sum_brand (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, brand_name text NOT NULL, mentions bigint NOT NULL, answers bigint NOT NULL,
  comp_rank_sum double precision NOT NULL, comp_ranked_answers bigint NOT NULL, PRIMARY KEY (cycle_id, generation_id, brand_name));
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_sum_own (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, own_variant text NOT NULL, tracked_answers bigint NOT NULL, own_mentions bigint NOT NULL,
  own_positive bigint NOT NULL, own_negative bigint NOT NULL, own_signals bigint NOT NULL, PRIMARY KEY (cycle_id, generation_id, own_variant));

-- S4(DB-v2.24): 웹 셀 생성 시점 판정(summary_answers 유닛 플래그 + summary_url_hits job 플래그, url_hits 없는 세대는 NULL)
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_web (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, job_id uuid NOT NULL, report_fs integer, unit_owned integer, unit_target integer,
  url_registered boolean, url_owned_hit boolean, url_target_hit boolean,
  PRIMARY KEY (cycle_id, generation_id, job_id));

-- S4b URL 인용률 사실표 커버리지: 운영 summary_url_hit_generations 의 활성 세대(없는 웹 세대 = 현행 URL 인용률 2종 미러)
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_url_cov (generation_id uuid PRIMARY KEY);

-- S4b 단언 보강(선택 입력: 있으면 이관기가 대조, 없으면 건너뜀을 결과에 적는다): 운영 집계층 같은 정의 합
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_sum_brand_x (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, brand_name text NOT NULL, positive bigint NOT NULL, neutral bigint NOT NULL,
  negative bigint NOT NULL, mixed bigint NOT NULL, type_mention bigint NOT NULL, type_recommendation bigint NOT NULL, type_comparison bigint NOT NULL,
  type_definition bigint NOT NULL, type_final_choice bigint NOT NULL, PRIMARY KEY (cycle_id, generation_id, brand_name));
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_sum_own_x (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, own_variant text NOT NULL, rank_sum bigint NOT NULL, ranked_answers bigint NOT NULL,
  top1_answers bigint NOT NULL, top3_answers bigint NOT NULL, multi_answers bigint NOT NULL, PRIMARY KEY (cycle_id, generation_id, own_variant));

-- DB-v2.27 brand_card_fold 단언 보강(선택 입력: 있고 스위치가 켜져 있으면 이관기가 Σ ment_total 을 대조): 운영 카드 점유율 분모
-- = summary_trend_own.comp_mentions(변형 ALL). 접힌 경쟁 행 언급 합이라 all_mentions(언급 행 단위)와 접기가 바꾼 회차에서만 다르다
CREATE TABLE IF NOT EXISTS mig_src.frz_ops_sum_comp (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, comp_mentions bigint NOT NULL, PRIMARY KEY (cycle_id, generation_id));

DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['frz_ops_marker', 'frz_ops_generation', 'frz_ops_cell', 'frz_ops_prompt', 'frz_ops_changed', 'frz_ops_answer',
                           'frz_ops_brand', 'frz_ops_sum_cycle', 'frz_ops_sum_brand', 'frz_ops_sum_own', 'frz_ops_web',
                           'frz_ops_sum_brand_x', 'frz_ops_sum_own_x', 'frz_ops_url_cov', 'frz_ops_sum_comp'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
      EXECUTE format('GRANT USAGE ON SCHEMA mig_src TO migrator');
      EXECUTE format('GRANT SELECT ON mig_src.%I TO migrator', t);
    END IF;
  END LOOP;
END $v$;
