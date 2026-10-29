-- summary table v4.1 — 회차 원장 + 판정 완료 사실표(세부층, 주 파티션) + 추이층 + 설정.
-- 정본: workspace (내부 설계 문서) §2-6·§3-3·§5-2.
--
-- additive-only · 멱등(IF NOT EXISTS / ON CONFLICT DO NOTHING) · 한 트랜잭션.
-- 이 파일은 표만 만든다 — 데이터는 생성기(scripts/summary/*)가 넣고, 읽기는
-- summary_settings.read_enabled='1' 이전엔 어떤 화면도 이 표를 보지 않는다(킬스위치 기본 0).
-- 세부층 6표는 cycle_week(주, UTC 월요일) RANGE 파티션 — 보존 = 최근 13주, 넘는 주는 DROP.
-- 1차 롤아웃 파티션: 2026-08-24 / 08-31 / 09-07 / 09-14 주를 미리 만든다.
SET LOCAL lock_timeout = '5s';

-- ── 회차 원장 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS summary_cycles (
  cycle_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surface              text NOT NULL CHECK (surface IN ('global','website','project')),
  project_id           uuid NOT NULL,
  cycle_anchor_at      timestamptz NOT NULL,
  cycle_week           date NOT NULL,
  anchor_source        text NOT NULL CHECK (anchor_source IN ('scope','derived','operator')),
  status               text NOT NULL CHECK (status IN ('open','closed','generating','published','stale')),
  closed_by            text CHECK (closed_by IN ('next_anchor','complete','recheck_window','operator')),
  closed_at            timestamptz,
  measured_from        timestamptz,
  measured_to          timestamptz,
  expected_units       int,
  completed_units      int,
  sealed_units         int,
  completion_ratio     numeric(6,5),
  analysis_gap_ratio   numeric(6,5),
  analysis_gate        text CHECK (analysis_gate IN ('scope','proxy','override')),
  fleet_visible        boolean NOT NULL DEFAULT true,
  active_generation_id uuid,
  view_anchor_at       timestamptz,
  stale_since          timestamptz,
  generator_version    text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, cycle_anchor_at)
);
CREATE INDEX IF NOT EXISTS summary_cycles_pick_idx ON summary_cycles (surface, project_id, cycle_anchor_at DESC)
  WHERE view_anchor_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS summary_cycles_week_idx ON summary_cycles (surface, cycle_week) WHERE view_anchor_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS summary_cycle_runs (
  cycle_id       uuid NOT NULL REFERENCES summary_cycles (cycle_id),
  run_id         uuid NOT NULL UNIQUE,
  attributed_by  text NOT NULL CHECK (attributed_by IN ('scope','derived','operator','late')),
  attributed_at  timestamptz NOT NULL DEFAULT now(),
  synced_at_seen timestamptz,
  PRIMARY KEY (cycle_id, run_id)
);

CREATE TABLE IF NOT EXISTS summary_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO summary_settings (key, value) VALUES ('read_enabled', '0') ON CONFLICT (key) DO NOTHING;
INSERT INTO summary_settings (key, value) VALUES ('read_screens', '[]') ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS summary_generations (
  generation_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id          uuid NOT NULL REFERENCES summary_cycles (cycle_id),
  generator_version text NOT NULL,
  status            text NOT NULL CHECK (status IN ('loading','ready','active','retired','failed')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  roster_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_universe     jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_universe   jsonb,
  noise_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_counts        jsonb,
  checksum          text,
  error             text
);
CREATE INDEX IF NOT EXISTS summary_generations_cycle_idx ON summary_generations (cycle_id, status);

-- ── 세부층 (주 파티션) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS summary_cycle_jobs (
  cycle_week date NOT NULL, cycle_id uuid NOT NULL, generation_id uuid NOT NULL,
  job_id uuid NOT NULL, run_id uuid NOT NULL,
  prompt_id uuid NOT NULL, engine text NOT NULL, country text NOT NULL,
  measured_at timestamptz NOT NULL,
  PRIMARY KEY (cycle_week, cycle_id, generation_id, job_id),
  UNIQUE (cycle_week, cycle_id, generation_id, prompt_id, engine, country)
) PARTITION BY RANGE (cycle_week);
CREATE INDEX IF NOT EXISTS summary_cycle_jobs_job_idx ON summary_cycle_jobs (job_id);

CREATE TABLE IF NOT EXISTS summary_answers (
  cycle_week date NOT NULL, cycle_id uuid NOT NULL, generation_id uuid NOT NULL,
  job_id uuid NOT NULL, prompt_id uuid NOT NULL, engine text NOT NULL, country text NOT NULL,
  project_id uuid NOT NULL, lang text, catalog_brands text[] NOT NULL DEFAULT '{}',
  funnel_catalog text, funnel_scope text, brand_presence_resolved text,
  list_type text, depth1 text, depth2 text, depth3 text,
  in_root_catalog int NOT NULL, in_tagged_region int NOT NULL, in_full_cycle int NOT NULL,
  run_status text NOT NULL,
  monitored      int NOT NULL DEFAULT 1,
  all_mentions   int NOT NULL,
  all_citations  int NOT NULL,
  has_any_brand  int NOT NULL,
  PRIMARY KEY (cycle_week, cycle_id, generation_id, job_id)
) PARTITION BY RANGE (cycle_week);
CREATE INDEX IF NOT EXISTS summary_answers_pick_idx  ON summary_answers (cycle_id, generation_id, country, engine);
CREATE INDEX IF NOT EXISTS summary_answers_brand_idx ON summary_answers USING gin (catalog_brands);
CREATE INDEX IF NOT EXISTS summary_answers_job_idx   ON summary_answers (job_id);

CREATE TABLE IF NOT EXISTS summary_brand_mentions (
  cycle_week date NOT NULL, cycle_id uuid NOT NULL, generation_id uuid NOT NULL,
  job_id uuid NOT NULL, prompt_id uuid NOT NULL, engine text NOT NULL, country text NOT NULL,
  project_id uuid NOT NULL, lang text, catalog_brands text[] NOT NULL DEFAULT '{}',
  funnel_catalog text, funnel_scope text, brand_presence_resolved text,
  list_type text, depth1 text, depth2 text, depth3 text,
  in_root_catalog int NOT NULL, in_tagged_region int NOT NULL, in_full_cycle int NOT NULL, run_status text NOT NULL,
  brand_id    uuid NOT NULL,
  brand_name  text NOT NULL,
  is_competitor int NOT NULL,
  mentions    int NOT NULL,
  first_rank  real,
  positive int NOT NULL, neutral int NOT NULL, negative int NOT NULL, mixed int NOT NULL,
  type_mention int NOT NULL, type_recommendation int NOT NULL, type_comparison int NOT NULL,
  type_definition int NOT NULL, type_final_choice int NOT NULL,
  PRIMARY KEY (cycle_week, cycle_id, generation_id, job_id, brand_id, brand_name)
) PARTITION BY RANGE (cycle_week);
CREATE INDEX IF NOT EXISTS summary_brand_pick_idx ON summary_brand_mentions (cycle_id, generation_id, country, engine);
CREATE INDEX IF NOT EXISTS summary_brand_id_idx   ON summary_brand_mentions (cycle_id, generation_id, brand_id);
CREATE INDEX IF NOT EXISTS summary_brand_cat_idx  ON summary_brand_mentions USING gin (catalog_brands);
CREATE INDEX IF NOT EXISTS summary_brand_job_idx  ON summary_brand_mentions (job_id);

CREATE TABLE IF NOT EXISTS summary_domain_citations (
  cycle_week date NOT NULL, cycle_id uuid NOT NULL, generation_id uuid NOT NULL,
  job_id uuid NOT NULL, prompt_id uuid NOT NULL, engine text NOT NULL, country text NOT NULL,
  project_id uuid NOT NULL, lang text, catalog_brands text[] NOT NULL DEFAULT '{}',
  funnel_catalog text, funnel_scope text, brand_presence_resolved text,
  list_type text, depth1 text, depth2 text, depth3 text,
  in_root_catalog int NOT NULL, in_tagged_region int NOT NULL, in_full_cycle int NOT NULL, run_status text NOT NULL,
  group_key   text NOT NULL,
  domain      text,
  matched_base   text NOT NULL DEFAULT '',
  base_norm_null int NOT NULL,
  citations   int NOT NULL,
  PRIMARY KEY (cycle_week, cycle_id, generation_id, job_id, group_key, matched_base)
) PARTITION BY RANGE (cycle_week);
CREATE INDEX IF NOT EXISTS summary_domain_pick_idx ON summary_domain_citations (cycle_id, generation_id, country, engine);
CREATE INDEX IF NOT EXISTS summary_domain_key_idx  ON summary_domain_citations (cycle_id, generation_id, group_key);
CREATE INDEX IF NOT EXISTS summary_domain_dom_idx  ON summary_domain_citations (cycle_id, generation_id, domain);
CREATE INDEX IF NOT EXISTS summary_domain_job_idx  ON summary_domain_citations (job_id);

CREATE TABLE IF NOT EXISTS summary_target_hits (
  cycle_week date NOT NULL, cycle_id uuid NOT NULL, generation_id uuid NOT NULL,
  job_id uuid NOT NULL, prompt_id uuid NOT NULL, engine text NOT NULL, country text NOT NULL,
  project_id uuid NOT NULL, lang text, run_status text NOT NULL,
  matched_base_tracked text NOT NULL DEFAULT '',
  target_keys text[] NOT NULL DEFAULT '{}',
  citations int NOT NULL,
  PRIMARY KEY (cycle_week, cycle_id, generation_id, job_id, matched_base_tracked)
) PARTITION BY RANGE (cycle_week);
CREATE INDEX IF NOT EXISTS summary_target_hits_pick_idx ON summary_target_hits (cycle_id, generation_id, project_id, country, engine);
CREATE INDEX IF NOT EXISTS summary_target_hits_job_idx  ON summary_target_hits (job_id);

CREATE TABLE IF NOT EXISTS summary_prompt_dim (
  cycle_week date NOT NULL, cycle_id uuid NOT NULL, generation_id uuid NOT NULL,
  prompt_id uuid NOT NULL, project_id uuid NOT NULL,
  lang text, catalog_brands text[] NOT NULL DEFAULT '{}', funnel_catalog text, funnel_scope text,
  brand_presence_resolved text, list_type text, depth1 text, depth2 text, depth3 text,
  regions text[],
  is_korean int,
  in_root_catalog int NOT NULL, catalog_status text, catalog_deleted int NOT NULL DEFAULT 0,
  in_full_cycle int NOT NULL,
  expected_cells int, window_cells int,
  catalog_row_id uuid,
  custom_tags jsonb, text text,
  site_country text, site_lang text, target_url_norm text, owned_base_url text,
  PRIMARY KEY (cycle_week, cycle_id, generation_id, prompt_id)
) PARTITION BY RANGE (cycle_week);

-- ── GA4 (⑦) — 1차 롤아웃에서는 비어 있음 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS summary_ga4 (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, project_id uuid NOT NULL, property_id text NOT NULL,
  window_from date NOT NULL, window_to date NOT NULL,
  key_events int NOT NULL, ai_channel_active_users int NOT NULL,
  PRIMARY KEY (cycle_id, generation_id, project_id, property_id)
);

-- ── 추이층 (영구, 키 그레인) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS summary_trend_answers (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, cycle_anchor_at timestamptz NOT NULL, cycle_week date NOT NULL,
  surface text NOT NULL, project_id uuid NOT NULL, country text NOT NULL, lang text NOT NULL DEFAULT '', engine text NOT NULL,
  catalog_brands text[] NOT NULL DEFAULT '{}', funnel_catalog text NOT NULL DEFAULT '', funnel_scope text NOT NULL DEFAULT '',
  brand_presence_resolved text NOT NULL DEFAULT '', list_type text NOT NULL DEFAULT '',
  depth1 text NOT NULL DEFAULT '', depth2 text NOT NULL DEFAULT '', depth3 text NOT NULL DEFAULT '',
  in_root_catalog int NOT NULL, in_tagged_region int NOT NULL, in_full_cycle int NOT NULL, run_status text NOT NULL,
  monitored int NOT NULL, all_mentions int NOT NULL, all_citations int NOT NULL, has_any_brand int NOT NULL,
  PRIMARY KEY (cycle_id, generation_id, country, lang, engine, catalog_brands, funnel_catalog, funnel_scope,
               brand_presence_resolved, list_type, depth1, depth2, depth3, in_root_catalog, in_tagged_region, in_full_cycle, run_status)
);
CREATE TABLE IF NOT EXISTS summary_trend_brands (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, cycle_anchor_at timestamptz NOT NULL, cycle_week date NOT NULL,
  surface text NOT NULL, project_id uuid NOT NULL, country text NOT NULL, lang text NOT NULL DEFAULT '', engine text NOT NULL,
  catalog_brands text[] NOT NULL DEFAULT '{}', funnel_catalog text NOT NULL DEFAULT '', funnel_scope text NOT NULL DEFAULT '',
  brand_presence_resolved text NOT NULL DEFAULT '', list_type text NOT NULL DEFAULT '', depth1 text NOT NULL DEFAULT '',
  in_root_catalog int NOT NULL, in_tagged_region int NOT NULL, in_full_cycle int NOT NULL, run_status text NOT NULL,
  brand_id uuid NOT NULL, brand_name text NOT NULL, is_competitor int NOT NULL,
  mentions int NOT NULL, answers int NOT NULL,
  rank_sum real, ranked_answers int NOT NULL,
  top3_answers int NOT NULL,
  positive int NOT NULL, neutral int NOT NULL, negative int NOT NULL, mixed int NOT NULL,
  type_mention int NOT NULL, type_recommendation int NOT NULL, type_comparison int NOT NULL,
  type_definition int NOT NULL, type_final_choice int NOT NULL,
  PRIMARY KEY (cycle_id, generation_id, country, lang, engine, catalog_brands, funnel_catalog, funnel_scope,
               brand_presence_resolved, list_type, depth1, in_root_catalog, in_tagged_region, in_full_cycle, run_status, brand_id, brand_name)
);
CREATE TABLE IF NOT EXISTS summary_trend_domains (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, cycle_anchor_at timestamptz NOT NULL, cycle_week date NOT NULL,
  surface text NOT NULL, project_id uuid NOT NULL, country text NOT NULL, lang text NOT NULL DEFAULT '', engine text NOT NULL,
  catalog_brands text[] NOT NULL DEFAULT '{}', funnel_catalog text NOT NULL DEFAULT '', funnel_scope text NOT NULL DEFAULT '',
  brand_presence_resolved text NOT NULL DEFAULT '', list_type text NOT NULL DEFAULT '', depth1 text NOT NULL DEFAULT '',
  in_root_catalog int NOT NULL, in_tagged_region int NOT NULL, in_full_cycle int NOT NULL, run_status text NOT NULL,
  group_key text NOT NULL, domain text, matched_base text NOT NULL DEFAULT '', base_norm_null int NOT NULL,
  citations int NOT NULL, citing_answers int NOT NULL,
  PRIMARY KEY (cycle_id, generation_id, country, lang, engine, catalog_brands, funnel_catalog, funnel_scope,
               brand_presence_resolved, list_type, depth1, in_root_catalog, in_tagged_region, in_full_cycle, run_status,
               group_key, matched_base, base_norm_null)
);
CREATE TABLE IF NOT EXISTS summary_trend_own (
  cycle_id uuid NOT NULL, generation_id uuid NOT NULL, cycle_anchor_at timestamptz NOT NULL, cycle_week date NOT NULL,
  surface text NOT NULL, project_id uuid NOT NULL, country text NOT NULL, lang text NOT NULL DEFAULT '', engine text NOT NULL,
  catalog_brands text[] NOT NULL DEFAULT '{}', funnel_catalog text NOT NULL DEFAULT '', funnel_scope text NOT NULL DEFAULT '',
  brand_presence_resolved text NOT NULL DEFAULT '', list_type text NOT NULL DEFAULT '', depth1 text NOT NULL DEFAULT '',
  in_root_catalog int NOT NULL, in_tagged_region int NOT NULL, in_full_cycle int NOT NULL, run_status text NOT NULL,
  own_variant text NOT NULL,
  monitored int NOT NULL,
  tracked_answers int NOT NULL,
  multi_answers int NOT NULL,
  top1_answers int NOT NULL, top3_answers int NOT NULL,
  rank_sum real, ranked_answers int NOT NULL,
  own_mentions int NOT NULL,
  own_positive int NOT NULL, own_signals int NOT NULL,
  prompts_tracked int NOT NULL,
  PRIMARY KEY (cycle_id, generation_id, country, lang, engine, catalog_brands, funnel_catalog, funnel_scope,
               brand_presence_resolved, list_type, depth1, in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant)
);
CREATE INDEX IF NOT EXISTS summary_trend_answers_pick ON summary_trend_answers (surface, project_id, cycle_anchor_at);
CREATE INDEX IF NOT EXISTS summary_trend_brands_pick  ON summary_trend_brands  (surface, project_id, cycle_anchor_at);
CREATE INDEX IF NOT EXISTS summary_trend_domains_pick ON summary_trend_domains (surface, project_id, cycle_anchor_at);
CREATE INDEX IF NOT EXISTS summary_trend_own_pick     ON summary_trend_own     (surface, project_id, own_variant, cycle_anchor_at);

-- ── 주 파티션 (1차 롤아웃 창) — 이후 주는 생성기/관제가 미리 만든다 ─────────────
DO $do$
DECLARE
  t text; w date;
BEGIN
  FOREACH t IN ARRAY ARRAY['summary_cycle_jobs','summary_answers','summary_brand_mentions','summary_domain_citations','summary_target_hits','summary_prompt_dim'] LOOP
    FOREACH w IN ARRAY ARRAY['2026-08-24'::date,'2026-08-31'::date,'2026-09-07'::date,'2026-09-14'::date] LOOP
      IF to_regclass(format('public.%I', t || '_' || to_char(w, 'YYYYMMDD'))) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                       t || '_' || to_char(w, 'YYYYMMDD'), t, w, w + 7);
      END IF;
    END LOOP;
  END LOOP;
END
$do$;

-- 앱 롤 이외 접근 차단 (0053~0055 관례). 파티션은 부모의 ACL 을 상속하지 않으므로 함께 건다.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname LIKE 'summary\_%' LOOP
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', r.relname);
  END LOOP;
END
$do$;
