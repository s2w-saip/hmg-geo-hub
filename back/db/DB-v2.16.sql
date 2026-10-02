-- ============================================================================
-- hmg-geo 재설계 통합 DB DDL v2 (PostgreSQL 17, 2026-09-27) · 제품 결정 G-01 (a)·G-02 (c)·나머지 권장안 반영
-- v2 스모크 수리: 전파 함수 rd.job 경유·위치 단언, ensure_leaf SECURITY DEFINER, ensure_month_leaf 신설, §10 실행 권한
-- v1 대비 변경(검증 blocking 해소): rd.job 신설(B1·B2), 자식 게이트 전파 함수(B3),
--   rd.catalog_entry 쓰기 주체 = 적재기(B4), R08 완료 비율 컬럼(B5), rd.brand_stance → rd.answer_stance(원본 그레인),
--   rd.ga4_*_daily → rd.ga4_row(원본 그레인), rd.citation.cit_in(갭 미포함, G-21 g), is_rep 범위 = 회차 내부,
--   judgment_change kind·payload 확장(운영자 요청 경로), report_publication 실DDL, dim_url IDENTITY, 경쟁사 도메인 토큰 표.
-- 스키마 쓰기 주체
--   ing : loader 롤만.  rd : loader 롤만(적재 트랜잭션 안).  app : api_rw(+판정 입력 변경 시 judgment_change).
--   ext : 외부 적재자(loader 롤).  mig·archive : migrator 롤.
-- 공통 규약
--   surface int2: 1 global, 2 website, 3 project.   브랜드 비트(app.brand 정본): 1 H, 2 K, 4 G, 8 HMG, 16 Hyundai N.
--   시간 축: round_date = 필터·추이·파티션 키, anchor_date 기록용(G-04).
--   사실 표 NOT NULL + 0 예약값, 열 순서 int4/date → int2 → bool.
--   WHERE 는 불리언·= ANY(상수 배열)만(배열이 1,000 을 넘으면 차원 semi-join 으로 전환), 비트 식은 FILTER 안에서만.
--   HOT 규율: 제자리 재판정 UPDATE 대상 열(elig, dflt, analysis_state, acr_iter_rank, is_rep, own_*·ment_*·sent_*,
--     tgt_cited, own_url_cited, has_cit, 생성 열 std_in·acr_in·gap, 자식의 std_in·cit_in·gap·elig·dflt)은 어떤 btree 에도 넣지 않는다.
--     source_key·url_key·brand_key·competitive·rk·owner_key·loc_owned·tgt_hit 는 규칙 버전 변경 시 leaf 재구축(스왑)으로만 바뀐다.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS ing;
CREATE SCHEMA IF NOT EXISTS rd;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS ext;
CREATE SCHEMA IF NOT EXISTS mig;
CREATE SCHEMA IF NOT EXISTS archive;
CREATE EXTENSION IF NOT EXISTS citext;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. app: 참조·판정 규칙
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE app.brand (                                   -- HMG_BRANDS lib/scope/hmg-brands.ts:22
  brand_code text PRIMARY KEY,
  brand_bit int2 NOT NULL UNIQUE CHECK (brand_bit > 0 AND (brand_bit & (brand_bit - 1)) = 0),
  is_umbrella bool NOT NULL DEFAULT false, is_hmg_own bool NOT NULL DEFAULT true,
  parent_brand_code text REFERENCES app.brand, canonical_entity_id uuid UNIQUE, sort_order int2 NOT NULL);
CREATE UNIQUE INDEX brand_one_umbrella ON app.brand ((true)) WHERE is_umbrella;
CREATE TABLE app.brand_name_prefix (brand_code text NOT NULL REFERENCES app.brand, prefix text NOT NULL, eval_order int2 NOT NULL,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (brand_code, prefix));   -- hmg-brands.ts:63
CREATE TABLE app.brand_display_alias (alias text PRIMARY KEY, canonical_name text NOT NULL,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());                                     -- brand-display-aliases.ts:77
CREATE TABLE app.non_competitor_name (name text PRIMARY KEY CHECK (name = lower(name)), bare_only_pattern text,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());                                     -- non-competitor-brands.ts:213·257
CREATE TABLE app.competitor_domain_token (                 -- TOKEN_TO_BRAND lib/citation-categorizer/competitor-brand.ts:8 (긴 토큰 우선 :25)
  token text PRIMARY KEY CHECK (token = lower(token)), brand_name text NOT NULL,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.entity_registry (entity_id uuid PRIMARY KEY, name text NOT NULL,
  role text NOT NULL CHECK (role IN ('own','excluded')), brand_code text REFERENCES app.brand,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), CHECK (role <> 'own' OR brand_code IS NOT NULL));
CREATE INDEX entity_registry_role_idx ON app.entity_registry (role, brand_code);
CREATE TABLE app.entity_alias (alias_entity_id uuid PRIMARY KEY, canon_entity_id uuid NOT NULL);     -- hmg-brands.ts:35
CREATE TABLE app.rhq_region (region_id text PRIMARY KEY, brand_code text NOT NULL REFERENCES app.brand, label text NOT NULL);
CREATE TABLE app.rhq_region_country (region_id text NOT NULL REFERENCES app.rhq_region ON DELETE CASCADE,
  country_code text NOT NULL, PRIMARY KEY (region_id, country_code));
CREATE TABLE app.hidden_market (surface text NOT NULL CHECK (surface IN ('global','website')), country_code text NOT NULL,
  reason text, PRIMARY KEY (surface, country_code));                                                  -- hidden-regions.ts:22
CREATE TABLE app.citation_category (category_key int2 PRIMARY KEY, name text NOT NULL UNIQUE, slug text NOT NULL, ord int2 NOT NULL);
CREATE TABLE app.citation_domain_override (domain text PRIMARY KEY CHECK (domain = lower(domain) AND domain !~ '^www\.'),
  category_key int2 NOT NULL REFERENCES app.citation_category, note text, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.owned_base (owner_key int2 PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('base','root_home')),
  prefix text NOT NULL, host text NOT NULL, brand_code text NOT NULL REFERENCES app.brand, geo_code text, language text,
  UNIQUE (kind, prefix));
CREATE INDEX owned_base_host_idx ON app.owned_base (host);
CREATE TABLE app.rule_param (key text PRIMARY KEY, value jsonb NOT NULL, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
-- 시드 키: default_engines(engines.ts:37), analysis_publish_ratio 0.95, view_delay_days 2, run_recheck_days 3, analysis_recheck_days 7
CREATE TABLE app.rule_set (rule_ver int2 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprints jsonb NOT NULL,   -- 필수 키: psl, owned_base, social, category_seed, brand_prefix, brand_alias, non_competitor,
                                 --   competitor_token, entity_registry, entity_alias, hidden_market, rule_param, website_catalog (13개 전부, CHECK 로 강제)
  note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz,
  CHECK (fingerprints ?& ARRAY['psl','owned_base','social','category_seed','brand_prefix','brand_alias','non_competitor',
                               'competitor_token','entity_registry','entity_alias','hidden_market','rule_param','website_catalog']));

-- 재판정·운영 요청 큐: 앱은 여기에만 쓴다. ing·rd 반영은 적재기(loader)가 한다(B4·m5).
CREATE TABLE app.judgment_change (
  change_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN (
    'catalog','prompt_kind','entity','brand_rule','competitor_token','hidden_market','citation_override','owned_base',
    'website_catalog','project_setting','project_owned_base','project_target_url','rule_param','scope_prompt',
    'cycle_admin','anchor_pin','answer_drop','report_publication')),
  subject_uuids uuid[], subject_texts text[],
  payload jsonb,                 -- cycle_admin: {cycle_id, op: hide|unhide|close|set_view_date, hidden_scope, reason, view_date}
                                 -- anchor_pin/answer_drop: {job_id, anchor, reason}. scope_prompt 는 적재기가 스스로 넣는다(Scope 쪽 regions·lang·kind 변경).
  requested_by uuid, requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','applied','failed','escalated_rebuild')),
  claimed_at timestamptz, applied_at timestamptz, applied_load_id bigint, error text,
  CHECK (kind NOT IN ('cycle_admin','anchor_pin','answer_drop') OR payload IS NOT NULL));
CREATE INDEX judgment_change_open_idx ON app.judgment_change (change_id) WHERE status IN ('pending','running');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. app: 사용자·권한·프로젝트·카탈로그·웹사이트·감사·QA·발행 리포트
-- ════════════════════════════════════════════════════════════════════════════
CREATE TYPE app.user_role      AS ENUM ('hq','region','country','admin','vendor','website');
CREATE TYPE app.operator_scope AS ENUM ('none','assigned','global');
CREATE TYPE app.menu_group     AS ENUM ('standard','website','project','admin');
CREATE TYPE app.member_role    AS ENUM ('owner','viewer');
CREATE TYPE app.member_status  AS ENUM ('pending','active');
CREATE FUNCTION app.actor() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE v text := current_setting('app.actor_id', true);
BEGIN IF v IS NULL OR v = '' THEN RAISE EXCEPTION 'app.actor_id 미설정: 감사 불가 쓰기 거부'; END IF; RETURN v::uuid; END $$;
CREATE FUNCTION app.tg_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% 는 append-only', TG_TABLE_NAME; END $$;

CREATE TABLE app.user_account (user_id uuid PRIMARY KEY, email citext NOT NULL UNIQUE, display_name text,
  role app.user_role NOT NULL, operator app.operator_scope NOT NULL DEFAULT 'none', scope_all bool NOT NULL DEFAULT false,
  scope_brands text[] NOT NULL DEFAULT '{}', scope_regions text[] NOT NULL DEFAULT '{}', scope_countries text[] NOT NULL DEFAULT '{}',
  menu_groups app.menu_group[], is_qa_reviewer bool NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  row_version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ua_vendor_no_operator CHECK (role <> 'vendor' OR operator = 'none'),
  CONSTRAINT ua_scope_nonempty CHECK (scope_all OR role = 'vendor' OR cardinality(scope_brands) > 0),
  CONSTRAINT ua_region_scope  CHECK (role <> 'region'  OR scope_all OR cardinality(scope_regions) + cardinality(scope_countries) > 0),
  CONSTRAINT ua_country_scope CHECK (role <> 'country' OR scope_all OR cardinality(scope_countries) > 0),
  CONSTRAINT ua_menu_nonempty CHECK (menu_groups IS NULL OR cardinality(menu_groups) > 0));
-- 트리거: 스코프 값 참조 검증 + permission_audit_log(행위자 필수)

CREATE TABLE app.project (project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('standard_root','customer')), name text NOT NULL, description text, domain text,
  brand_code text REFERENCES app.brand, country_code text NOT NULL, scope_project_id uuid UNIQUE, ga4_property_id text,
  ai_engines text[], created_by uuid NOT NULL REFERENCES app.user_account,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX project_one_root ON app.project ((true)) WHERE kind = 'standard_root';
-- AFTER UPDATE 트리거: domain·brand_code·country_code·ai_engines 변경 시 judgment_change('project_setting', project_id) (lens2 m4, lens1 m2)
CREATE TABLE app.project_member (project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.user_account ON DELETE CASCADE, role app.member_role NOT NULL DEFAULT 'viewer',
  status app.member_status NOT NULL DEFAULT 'pending', invited_by uuid NOT NULL REFERENCES app.user_account,
  invited_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz,
  PRIMARY KEY (project_id, user_id), CHECK ((status = 'active') = (accepted_at IS NOT NULL)));
CREATE INDEX project_member_user_idx ON app.project_member (user_id, status);
CREATE TABLE app.project_engine_history (history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE, engines text[] NOT NULL, changed_by uuid, changed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.project_owned_base (project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE, base_url text NOT NULL,
  base_norm text NOT NULL, label text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id, base_norm));
CREATE TABLE app.project_tracked_url (project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE, url text NOT NULL,
  url_norm text NOT NULL, label text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id, url_norm));
CREATE TABLE app.project_tracked_brand (project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE, canonical_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id, canonical_name));
CREATE TABLE app.project_tracked_competitor (project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE, brand_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}', notes text, is_target bool NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, brand_name));
CREATE UNIQUE INDEX tracked_competitor_one_target ON app.project_tracked_competitor (project_id) WHERE is_target;
CREATE TABLE app.project_tracked_vehicle (project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE, brand text NOT NULL, model text NOT NULL,
  segment text, aliases text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id, brand, model));
CREATE TABLE app.project_tracked_keyword (keyword_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE,
  term text NOT NULL, country_code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE NULLS NOT DISTINCT (project_id, term, country_code));

CREATE TABLE app.prompt_candidate (candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('google_keyword','social_scraping','manual')), source_keyword text, text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.prompt (prompt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE,
  candidate_id uuid REFERENCES app.prompt_candidate ON DELETE SET NULL, text text NOT NULL, prompt_type text, category text,
  brand_code text REFERENCES app.brand, brand_presence text CHECK (brand_presence IN ('branded','unbranded')),
  list_type text, depth1 text, depth2 text, depth3 text, depth4 text, funnel_stage text,
  kind text NOT NULL DEFAULT 'single' CHECK (kind IN ('single','acr')), lang text CHECK (lang = upper(lang)), regions text[], scope_prompt_id uuid,
  status text NOT NULL DEFAULT 'draft', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, UNIQUE (project_id, prompt_id));
CREATE INDEX prompt_project_live_idx ON app.prompt (project_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX prompt_scope_idx ON app.prompt (scope_prompt_id) WHERE scope_prompt_id IS NOT NULL AND deleted_at IS NULL;
-- AFTER 트리거 tg_catalog_change: prompt_audit_log 기록 + (brand_code·scope_prompt_id·kind·funnel·taxonomy·deleted_at 변경 시)
--   judgment_change('catalog'|'prompt_kind', 옛·새 scope_prompt_id). rd 는 쓰지 않는다(B4).
CREATE TABLE app.project_custom_field (field_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE,
  label text NOT NULL, archived bool NOT NULL DEFAULT false, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, label), UNIQUE (project_id, field_id));
CREATE TABLE app.prompt_custom_field_value (project_id uuid NOT NULL, prompt_id uuid NOT NULL, field_id uuid NOT NULL, value text NOT NULL,
  PRIMARY KEY (prompt_id, field_id),
  FOREIGN KEY (project_id, field_id)  REFERENCES app.project_custom_field (project_id, field_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, prompt_id) REFERENCES app.prompt (project_id, prompt_id) ON DELETE CASCADE);
CREATE INDEX pcfv_filter_idx ON app.prompt_custom_field_value (field_id, value) INCLUDE (prompt_id);
CREATE TABLE app.standard_keyword (keyword_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), term text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('google_keyword','community_voc')), brand_code text REFERENCES app.brand,
  enabled bool NOT NULL DEFAULT true, notes text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.standard_source (source_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), url text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('news','pr','social','community')), brand_code text REFERENCES app.brand,
  enabled bool NOT NULL DEFAULT true, notes text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.website_site (site_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_code text NOT NULL REFERENCES app.brand,
  country_code text NOT NULL, scope_project_id uuid UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_code, country_code));
CREATE TABLE app.website_prompt (website_prompt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES app.website_site,
  file_seq int NOT NULL, domain text NOT NULL, lang_code text NOT NULL, seq_no int NOT NULL, target_url text NOT NULL, prompt_text text NOT NULL,
  owned_base_url text, scope_prompt_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, file_seq, seq_no));
CREATE INDEX website_prompt_scope_idx ON app.website_prompt (scope_prompt_id);
CREATE TABLE app.ga4_property (property_id text PRIMARY KEY, brand_code text REFERENCES app.brand, country_code text,
  status text NOT NULL CHECK (status IN ('active','pending_grant','unmapped')), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.ga4_tracked_event (property_id text NOT NULL REFERENCES app.ga4_property, event_name text NOT NULL,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (property_id, event_name));
CREATE TABLE app.kw_prompt_draft (serp_call_id bigint NOT NULL, rank int2 NOT NULL, gen int2 NOT NULL DEFAULT 1, prompt text NOT NULL,
  model text, generated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (serp_call_id, rank, gen));
CREATE TABLE app.ctx_generated_prompt (project_id uuid NOT NULL REFERENCES app.project ON DELETE CASCADE, prompt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  batch_no int2 NOT NULL, seed_entity_ids uuid[] NOT NULL DEFAULT '{}', text text NOT NULL, source_label text, model text,
  generated_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz, PRIMARY KEY (project_id, prompt_id));

-- 발행 리포트(A5): 현행 0080 report_publications·report_site_facts·report_site_engine_facts(lib/db/schema.ts:1676·1721·1758) 1:1, FK 없음 유지
CREATE TABLE app.report_publication (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL, surface text NOT NULL,
  brand_scope text NOT NULL, volume text, version text NOT NULL, title text, cycle_label text, cycle_label_en text,
  round_date date NOT NULL, prev_round_date date, asof_cur date, asof_prev date, published_on date, engines text[], excluded_fs int[],
  bench_n int, bench_n_all int, src_cite text, source_filename text NOT NULL, source_sha256 text NOT NULL,
  manifest_verified bool NOT NULL DEFAULT false, verify_note text, sb_data_version text NOT NULL,
  status text NOT NULL DEFAULT 'active', superseded_by uuid, ingested_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX report_publications_slug_uq ON app.report_publication (slug);
CREATE UNIQUE INDEX report_publications_active_uq ON app.report_publication (surface, round_date, brand_scope) WHERE status = 'active';
CREATE INDEX report_publications_sha_idx ON app.report_publication (source_sha256);
CREATE TABLE app.report_site_fact (publication_id uuid NOT NULL, file_seq int NOT NULL, brand text NOT NULL, country_code text,
  country_name text, region_label text, lang_code text, lang_label text, agency_status text, in_headline_pool bool NOT NULL DEFAULT true,
  target_hit_prompts int NOT NULL, measured_prompts int NOT NULL, owned_prompts int NOT NULL, owned_prompts_den int NOT NULL,
  owned_answers int, monitored_answers int, prompts int, answers int,
  prev_target_hit_prompts int, prev_measured_prompts int, prev_owned_prompts int, prev_owned_prompts_den int, raw jsonb NOT NULL,
  PRIMARY KEY (publication_id, file_seq));
CREATE INDEX report_site_facts_fs_idx ON app.report_site_fact (file_seq);
CREATE TABLE app.report_site_engine_fact (publication_id uuid NOT NULL, file_seq int NOT NULL, engine text NOT NULL,
  target_hit_prompts int NOT NULL, prev_target_hit_prompts int, PRIMARY KEY (publication_id, file_seq, engine));
-- 발행 적재 트랜잭션이 judgment_change('report_publication', publication_id) 를 쓴다 → 적재기가 rd.report_unit_value 교체.

CREATE TABLE app.scope_outbox (outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate text NOT NULL CHECK (aggregate IN ('project','prompt','schedule')), aggregate_id uuid NOT NULL, op text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz, last_error text);
CREATE INDEX scope_outbox_due_idx ON app.scope_outbox (next_attempt_at) WHERE done_at IS NULL;

CREATE TABLE app.access_audit_log (ts timestamptz NOT NULL DEFAULT now(), audit_id bigint GENERATED ALWAYS AS IDENTITY,
  actor_id uuid NOT NULL, actor_role app.user_role NOT NULL, kind text NOT NULL CHECK (kind IN ('scope_call','data_access','api_read','download')),
  action text NOT NULL, target text, detail jsonb, request_id uuid, PRIMARY KEY (ts, audit_id)) PARTITION BY RANGE (ts);
CREATE INDEX access_audit_actor_idx ON app.access_audit_log (actor_id, ts DESC);
CREATE TABLE app.prompt_audit_log (audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, prompt_id uuid NOT NULL, project_id uuid NOT NULL,
  actor_id uuid, actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system')),
  event_type text NOT NULL CHECK (event_type IN ('created','text_updated','meta_updated','enabled_changed','kind_changed','deleted','restored')),
  changes jsonb NOT NULL DEFAULT '{}', batch_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX prompt_audit_project_idx ON app.prompt_audit_log (project_id, created_at DESC);
CREATE INDEX prompt_audit_prompt_idx  ON app.prompt_audit_log (prompt_id, created_at DESC);
CREATE TABLE app.member_audit_log (audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, project_id uuid NOT NULL, actor_id uuid NOT NULL,
  target_user_id uuid NOT NULL, action text NOT NULL, context text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.permission_audit_log (audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, target_user_id uuid NOT NULL, actor_id uuid NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('create','update','delete')), before jsonb, after jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER prompt_audit_ao     BEFORE UPDATE OR DELETE ON app.prompt_audit_log     FOR EACH STATEMENT EXECUTE FUNCTION app.tg_append_only();
CREATE TRIGGER member_audit_ao     BEFORE UPDATE OR DELETE ON app.member_audit_log     FOR EACH STATEMENT EXECUTE FUNCTION app.tg_append_only();
CREATE TRIGGER permission_audit_ao BEFORE UPDATE OR DELETE ON app.permission_audit_log FOR EACH STATEMENT EXECUTE FUNCTION app.tg_append_only();

-- QA: Scope job_id(재적재 불변) 키 유지. 목록·진행률은 rd.job(job_id 보유)과 조인하므로 ing 불필요(B1).
CREATE TABLE app.qa_review_session (session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES app.user_account,
  reviewer_name text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), user_agent text, ip_hash text);
CREATE TABLE app.qa_answer_review (job_id uuid PRIMARY KEY,
  flag_answer text CHECK (flag_answer IN ('ok','issue')), flag_prompt text CHECK (flag_prompt IN ('ok','issue')),
  flag_mentions text CHECK (flag_mentions IN ('ok','issue')), flag_citations text CHECK (flag_citations IN ('ok','issue')),
  flag_acr text CHECK (flag_acr IN ('ok','issue')), flag_meta text CHECK (flag_meta IN ('ok','issue')),
  status text GENERATED ALWAYS AS (CASE WHEN 'issue' IN (flag_answer, flag_prompt, flag_mentions, flag_citations, flag_acr, flag_meta)
                                        THEN 'issue' ELSE 'ok' END) STORED,
  reviewer_id uuid REFERENCES app.user_account, reviewer_name text NOT NULL, session_id uuid REFERENCES app.qa_review_session,
  reviewed_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX qa_review_status_idx ON app.qa_answer_review (status, reviewed_at DESC);
CREATE INDEX qa_review_reviewer_idx ON app.qa_answer_review (reviewer_name, reviewed_at DESC);
CREATE TABLE app.qa_review_note (note_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('answer','prompt','mention','citation','acr','meta')),
  target_key text,                                          -- 인용 = 'job_id:ord'(ing.citation·rd.citation 공통 안정 키)
  target_label text, severity text NOT NULL DEFAULT 'issue' CHECK (severity IN ('issue','question','info')), body text NOT NULL,
  reviewer_id uuid REFERENCES app.user_account, reviewer_name text NOT NULL, session_id uuid REFERENCES app.qa_review_session,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by text, CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)));
CREATE INDEX qa_note_job_idx ON app.qa_review_note (job_id, created_at);
CREATE INDEX qa_note_cursor_idx ON app.qa_review_note (created_at DESC, note_id);
CREATE TABLE app.qa_answer_lock (job_id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES app.qa_review_session ON DELETE CASCADE,
  reviewer_name text NOT NULL, acquired_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz NOT NULL DEFAULT now());

-- ════════════════════════════════════════════════════════════════════════════
-- 3. ing: 쓰기 원본 (판정 없음, 원본 불변, loader 만)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE ing.sync_cursor (scope_project_id uuid PRIMARY KEY, surface text NOT NULL CHECK (surface IN ('global','website','project')),
  last_attempt_at timestamptz, last_success_at timestamptz, last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
  prompts_updated_to timestamptz);
CREATE TABLE ing.load (load_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('run','recheck','judgment','cycle_admin','rebuild','ga4','dfs','report','seed')),
  run_id uuid, scope_ref jsonb, rule_ver int2 NOT NULL, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','committed','failed')),
  jobs_fetched int, jobs_changed int, jobs_removed int, rd_answers_upserted int, rd_gate_propagated int, rd_rep_flips int, rd_children_rows int, error text);
CREATE TABLE ing.run (run_id uuid PRIMARY KEY, run_key int4 GENERATED ALWAYS AS IDENTITY UNIQUE, scope_project_id uuid NOT NULL, run_month date NOT NULL,
  status text NOT NULL, trigger text, targets text[], regions text[], total_jobs int, started_at timestamptz, completed_at timestamptz, cycle_anchor_at timestamptz,
  seen_jobs int NOT NULL DEFAULT 0, completed_jobs int NOT NULL DEFAULT 0, unresolved_jobs int NOT NULL DEFAULT 0, analysis_pending int NOT NULL DEFAULT 0,
  recheck_until timestamptz, analysis_recheck_until timestamptz,
  sync_state text NOT NULL DEFAULT 'new' CHECK (sync_state IN ('new','staging','loaded','deferred','blocked')),
  stage_cursor text, attempts int2 NOT NULL DEFAULT 0, next_attempt_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000), last_load_id bigint, synced_at timestamptz);
CREATE INDEX run_project_idx ON ing.run (scope_project_id, started_at DESC);
CREATE INDEX run_due_idx     ON ing.run (next_attempt_at) WHERE sync_state IN ('new','staging','deferred');
CREATE INDEX run_open_idx    ON ing.run (scope_project_id) WHERE unresolved_jobs > 0 OR analysis_pending > 0;
CREATE TABLE ing.answer_key_map (job_id uuid PRIMARY KEY, answer_key int4 GENERATED ALWAYS AS IDENTITY UNIQUE, run_month date NOT NULL);
CREATE TABLE ing.answer (run_month date NOT NULL, job_id uuid NOT NULL, answer_key int4 NOT NULL, run_id uuid NOT NULL,
  prompt_id uuid, target text NOT NULL, region text, status text NOT NULL, measured_at timestamptz, model_slug text, prompt_run_id uuid,
  analysis_status text CHECK (analysis_status IN ('skipped','pending','completed','partial','failed')),   -- lib/scope/types.ts:466
  analysis_version text, quality_breakdown jsonb, answer_text text,
  n_mentions int NOT NULL DEFAULT 0, n_citations int NOT NULL DEFAULT 0, result_fallback bool NOT NULL DEFAULT false,
  content_hash bytea NOT NULL, seed_origin text NOT NULL DEFAULT 'scope_api' CHECK (seed_origin IN ('scope_api','mirror_seed','repull')),
  first_seen_at timestamptz NOT NULL DEFAULT now(), load_id bigint NOT NULL, PRIMARY KEY (run_month, job_id)) PARTITION BY RANGE (run_month);
CREATE INDEX answer_run_idx    ON ing.answer (run_id);
CREATE INDEX answer_prompt_idx ON ing.answer (prompt_id);
CREATE TABLE ing.mention (run_month date NOT NULL, job_id uuid NOT NULL, ord int2 NOT NULL, entity_id uuid NOT NULL, display_name text, entity_type text,
  mention_count int NOT NULL DEFAULT 0, sentiment_positive int NOT NULL DEFAULT 0, sentiment_neutral int NOT NULL DEFAULT 0,
  sentiment_negative int NOT NULL DEFAULT 0, sentiment_mixed int NOT NULL DEFAULT 0, avg_position real, surfaces text[],
  brand_rollup_entity_id uuid, product_rollup_entity_id uuid, company_rollup_entity_id uuid,
  type_mention int NOT NULL DEFAULT 0, type_recommendation int NOT NULL DEFAULT 0, type_comparison int NOT NULL DEFAULT 0,
  type_definition int NOT NULL DEFAULT 0, type_final_choice int NOT NULL DEFAULT 0, PRIMARY KEY (run_month, job_id, ord)) PARTITION BY RANGE (run_month);
CREATE INDEX mention_entity_idx ON ing.mention (entity_id);
CREATE INDEX mention_rollup_idx ON ing.mention (brand_rollup_entity_id);
CREATE TABLE ing.mention_occurrence (run_month date NOT NULL, job_id uuid NOT NULL, ord int NOT NULL, entity_id uuid NOT NULL,
  brand_rollup_entity_id uuid, turn_index int2, source_start int NOT NULL, source_end int NOT NULL, surface_text text NOT NULL,
  sentiment text NOT NULL CHECK (sentiment IN ('positive','negative','mixed','neutral')), mention_role text, assertion text, context_snippet text,
  descriptors text[] NOT NULL DEFAULT '{}', criteria text[] NOT NULL DEFAULT '{}', PRIMARY KEY (run_month, job_id, ord)) PARTITION BY RANGE (run_month);
CREATE TABLE ing.answer_stance (run_month date NOT NULL, job_id uuid NOT NULL, turn_index int2 NOT NULL DEFAULT 0, entity_id uuid NOT NULL,
  brand_label text, is_tracked bool NOT NULL DEFAULT false, stance text NOT NULL CHECK (stance IN ('positive','negative','mixed','neutral')),
  confidence real, evidence_text text, evidence_start int, evidence_end int, reason text, model_slug text,
  CHECK ((evidence_start IS NULL) = (evidence_end IS NULL)), PRIMARY KEY (run_month, job_id, turn_index, entity_id)) PARTITION BY RANGE (run_month);
CREATE TABLE ing.citation (run_month date NOT NULL, job_id uuid NOT NULL, ord int2 NOT NULL, url text, title text, ref_index int,
  scope_category text, host text, domain_label text, PRIMARY KEY (run_month, job_id, ord)) PARTITION BY RANGE (run_month);
CREATE TABLE ing.acr_prompt_run (prompt_run_id uuid PRIMARY KEY, acr_cell_key int4 GENERATED ALWAYS AS IDENTITY UNIQUE, run_id uuid NOT NULL,
  prompt_id uuid, target text NOT NULL, region text, measured_at timestamptz,
  planned_iterations int2 NOT NULL, valid_turn1_iterations int2 NOT NULL, valid_acr_iterations int2 NOT NULL,
  co_single_entity int2 NOT NULL DEFAULT 0, co_conditional_multiple int2 NOT NULL DEFAULT 0, co_generic_category int2 NOT NULL DEFAULT 0,
  co_resolved_off_shortlist int2 NOT NULL DEFAULT 0, co_unresolved_choice int2 NOT NULL DEFAULT 0, co_none int2 NOT NULL DEFAULT 0,
  source_job_ids uuid[] NOT NULL DEFAULT '{}', acr_summary jsonb NOT NULL, load_id bigint NOT NULL,
  CONSTRAINT acr_iter_order CHECK (valid_acr_iterations <= valid_turn1_iterations AND valid_turn1_iterations <= planned_iterations));
CREATE INDEX acr_prompt_run_run_idx ON ing.acr_prompt_run (run_id);
CREATE TABLE ing.acr_rollup_row (prompt_run_id uuid NOT NULL REFERENCES ing.acr_prompt_run ON DELETE CASCADE, entity_id uuid NOT NULL,
  rollup_level text NOT NULL CHECK (rollup_level IN ('brand','product','company')), run_id uuid NOT NULL,
  entity_name text, brand_rollup_entity_id uuid, parent_name text, entity_type text,
  appearance_count int2 NOT NULL DEFAULT 0, choice_count int2 NOT NULL DEFAULT 0, conditional_choice_count int2 NOT NULL DEFAULT 0,
  off_shortlist_choice_count int2 NOT NULL DEFAULT 0, unresolved_choice_count int2 NOT NULL DEFAULT 0, generic_choice_count int2 NOT NULL DEFAULT 0,
  appearance_rate real, acr real, overall_choice_share real, PRIMARY KEY (prompt_run_id, entity_id, rollup_level));
CREATE INDEX acr_rollup_row_run_idx ON ing.acr_rollup_row (run_id);
CREATE TABLE ing.prompt (scope_prompt_id uuid PRIMARY KEY, scope_project_id uuid NOT NULL, text text, funnel_stage text, lang text,
  regions text[], kind text, scope_updated_at timestamptz, synced_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ing.answer_anchor_pin (job_id uuid PRIMARY KEY, anchor date NOT NULL, source_measured_at timestamptz, reason text NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(), origin text NOT NULL DEFAULT 'loader', change_id bigint);   -- 운영자 요청은 judgment_change 경유
CREATE TABLE ing.answer_drop (job_id uuid PRIMARY KEY, source_measured_at timestamptz, reason text NOT NULL,
  dropped_at timestamptz NOT NULL DEFAULT now(), origin text NOT NULL DEFAULT 'loader', change_id bigint);
CREATE TABLE ing.cycle (cycle_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cyc_key int4 GENERATED ALWAYS AS IDENTITY UNIQUE,
  surface text NOT NULL CHECK (surface IN ('global','website','project')),     -- project = 가상 회차(anchor_source='derived'), 키 발급처 일원화(lens2 m5)
  scope_project_id uuid NOT NULL, cycle_anchor_at timestamptz NOT NULL,
  anchor_source text NOT NULL CHECK (anchor_source IN ('scope','derived','operator')), anchor_date date NOT NULL, round_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('open','closed','published','stale')),
  closed_by text CHECK (closed_by IN ('next_anchor','complete','recheck_window','operator')), closed_at timestamptz,
  expected_units int, completed_units int, completed_answers int, gap_answers int,   -- R01·R08 게이트 판정 근거(D8 예외 ③, 기능 API 비노출)
  completion_ratio numeric(6,5) GENERATED ALWAYS AS (CASE WHEN expected_units > 0 THEN round(completed_units::numeric / expected_units, 5) END) STORED,
  analysis_done_ratio numeric(6,5) GENERATED ALWAYS AS                                  -- R08 게이트: 이 값 >= analysis_publish_ratio 여야 발행(B5)
    (CASE WHEN completed_answers > 0 THEN round((completed_answers - gap_answers)::numeric / completed_answers, 5) END) STORED,
  fleet_visible bool NOT NULL DEFAULT true, view_anchor_at timestamptz,
  hidden_scope text CHECK (hidden_scope IN ('all','citations','mentions')), hidden_reason text CHECK (hidden_reason IN ('collection_error','operator')),
  hidden_at timestamptz, published_at timestamptz, stale_since timestamptz, projected_round_date date,
  generation bigint NOT NULL DEFAULT 1, origin text NOT NULL DEFAULT 'loader' CHECK (origin IN ('summary_cycles','loader')),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (scope_project_id, cycle_anchor_at),
  CHECK ((hidden_scope IS NULL) = (hidden_reason IS NULL)), CHECK ((hidden_reason IS NULL) = (hidden_at IS NULL)),
  CHECK (status <> 'published' OR (closed_at IS NOT NULL AND view_anchor_at IS NOT NULL)),
  CHECK (gap_answers IS NULL OR completed_answers IS NULL OR gap_answers <= completed_answers));
CREATE INDEX cycle_open_idx      ON ing.cycle (scope_project_id) WHERE status = 'open';
CREATE INDEX cycle_reproject_idx ON ing.cycle (cycle_id) WHERE projected_round_date IS DISTINCT FROM round_date;
CREATE TABLE ing.cycle_round (scope_project_id uuid NOT NULL, anchor_date date NOT NULL,
  surface text NOT NULL CHECK (surface IN ('global','website','project')), round_date date NOT NULL,
  basis text NOT NULL CHECK (basis IN ('canonical','prev_empty','next_empty','nearest','merged','project')),
  assigned_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scope_project_id, anchor_date));
CREATE TABLE ing.cycle_run (run_id uuid PRIMARY KEY, cycle_id uuid NOT NULL REFERENCES ing.cycle,
  attributed_by text NOT NULL CHECK (attributed_by IN ('scope','derived','operator','late')), attributed_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX cycle_run_cycle_idx ON ing.cycle_run (cycle_id);
CREATE UNLOGGED TABLE ing.stage_answer     (LIKE ing.answer INCLUDING DEFAULTS);
CREATE UNLOGGED TABLE ing.stage_mention    (load_id bigint NOT NULL, LIKE ing.mention INCLUDING DEFAULTS);
CREATE UNLOGGED TABLE ing.stage_occurrence (load_id bigint NOT NULL, LIKE ing.mention_occurrence INCLUDING DEFAULTS);
CREATE UNLOGGED TABLE ing.stage_stance     (load_id bigint NOT NULL, LIKE ing.answer_stance INCLUDING DEFAULTS);
CREATE UNLOGGED TABLE ing.stage_citation   (load_id bigint NOT NULL, LIKE ing.citation INCLUDING DEFAULTS);
CREATE UNLOGGED TABLE ing.stage_acr        (load_id bigint NOT NULL, prompt_run_id uuid NOT NULL, payload jsonb NOT NULL);
CREATE INDEX stage_answer_idx ON ing.stage_answer (load_id, job_id);
CREATE TABLE ing.ga4_pull (pull_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, property_id text NOT NULL,
  report text NOT NULL CHECK (report IN ('traffic_total','traffic_ai','events','landing','totals')),
  date_from date NOT NULL, date_to date NOT NULL, request jsonb NOT NULL, response_meta jsonb, row_count int NOT NULL,
  status text NOT NULL, pulled_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ing.ga4_row (property_id text NOT NULL, report text NOT NULL, date date NOT NULL,
  channel_group text NOT NULL DEFAULT '', session_source text NOT NULL DEFAULT '', device_category text NOT NULL DEFAULT '',
  new_vs_returning text NOT NULL DEFAULT '', landing_page text NOT NULL DEFAULT '', event_name text NOT NULL DEFAULT '',
  sessions int, active_users int, screen_page_views int, key_events int, event_count int, pull_id bigint NOT NULL,
  PRIMARY KEY (property_id, report, date, channel_group, session_source, device_category, new_vs_returning, landing_page, event_name)
) PARTITION BY RANGE (date);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. rd: 차원 (정수 키 = 발급 원장, 재번호 금지)
-- ════════════════════════════════════════════════════════════════════════════
CREATE FUNCTION rd.today_kst() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Seoul')::date $$;
CREATE TABLE rd.dim_engine  (engine_key int2 PRIMARY KEY, code text NOT NULL UNIQUE, is_default bool NOT NULL);
CREATE TABLE rd.dim_region  (region_key int2 PRIMARY KEY, code text NOT NULL UNIQUE);
CREATE TABLE rd.dim_country (geo_key int2 PRIMARY KEY, code text NOT NULL UNIQUE, region_key int2 REFERENCES rd.dim_region,
  kind text NOT NULL CHECK (kind IN ('iso','pseudo','virtual_brand','unknown')), virtual_brand_bit int2, hidden_standard bool NOT NULL DEFAULT false);
CREATE TABLE rd.dim_lang    (lang_key int2 PRIMARY KEY, code text NOT NULL UNIQUE CHECK (code = lower(code)));
CREATE TABLE rd.dim_project (project_key int2 PRIMARY KEY, scope_project_id uuid NOT NULL UNIQUE, surface int2 NOT NULL CHECK (surface IN (1,2,3)),
  is_root bool NOT NULL, project_id uuid, site_id uuid, site_brand_bit int2 NOT NULL DEFAULT 0, site_geo_key int2 NOT NULL DEFAULT 0);
CREATE TABLE rd.dim_taxon (taxon_key int2 PRIMARY KEY, axis text NOT NULL CHECK (axis IN ('funnel','presence','list_type','depth1','depth2','depth3')),
  code text NOT NULL, parent_key int2, UNIQUE NULLS NOT DISTINCT (axis, code, parent_key));
CREATE TABLE rd.web_unit (unit_key int2 PRIMARY KEY, project_key int2 NOT NULL REFERENCES rd.dim_project, file_seq int NOT NULL,
  lang_codes text[] NOT NULL, base text, base_src text CHECK (base_src IN ('decl','heur')), sibs text[] NOT NULL DEFAULT '{}',
  home_host text, turls text[] NOT NULL DEFAULT '{}', rule_ver int2 NOT NULL, UNIQUE (project_key, file_seq));
CREATE TABLE rd.dim_prompt (prompt_key int4 GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, prompt_id uuid NOT NULL UNIQUE,
  surface int2 NOT NULL, project_key int2 NOT NULL, kind text NOT NULL CHECK (kind IN ('single','acr')),
  text text,                                               -- ing.prompt.text 투영(같은 그레인). CF-18·QA 텍스트 검색(B1·B2)
  lang_key int2 NOT NULL DEFAULT 0, cat_mask int2 NOT NULL DEFAULT 0, in_root_catalog bool NOT NULL DEFAULT false,
  funnel_key int2 NOT NULL DEFAULT 0,                      -- scope_prompt_id 가 같은 app.prompt 어느 행이든(scope-aggregates.ts:3515 규칙, lens2 m7)
  unit_key int2 REFERENCES rd.web_unit, targets text[] NOT NULL DEFAULT '{}', web_reg bool NOT NULL DEFAULT false,
  regions text[], is_korean bool NOT NULL DEFAULT false, rule_ver int2 NOT NULL);
CREATE INDEX dim_prompt_text_trgm_hint ON rd.dim_prompt (surface, project_key);   -- 텍스트 검색은 10배 약 12만 행 순차 ILIKE(pg_trgm 은 v3 후 판단)
CREATE TABLE rd.catalog_entry (catalog_row_id uuid PRIMARY KEY, prompt_key int4 REFERENCES rd.dim_prompt, brand_bit int2 NOT NULL,
  presence_key int2, funnel_key int2, list_type_key int2, depth1_key int2, depth2_key int2, depth3_key int2, kind text NOT NULL,
  load_id bigint NOT NULL);                                -- 쓰기 주체 = 적재기(judgment_change 'catalog' 처리 트랜잭션, B4)
CREATE INDEX catalog_entry_prompt_idx ON rd.catalog_entry (prompt_key);
CREATE INDEX catalog_entry_axis_idx   ON rd.catalog_entry (brand_bit, list_type_key, depth1_key);
CREATE TABLE rd.dim_brand_name (brand_key int4 GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name text NOT NULL UNIQUE, bare text NOT NULL UNIQUE,
  kind int2 NOT NULL CHECK (kind IN (0,1,2,3)), own_bit int2 NOT NULL DEFAULT 0 CHECK (own_bit IN (0,1,2,4)),   -- Hyundai N 은 own_bit 1(open_issues)
  first_seen date NOT NULL DEFAULT current_date, CHECK ((kind = 1) = (own_bit <> 0)));
CREATE TABLE rd.dim_entity (entity_key int4 GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, entity_id uuid NOT NULL UNIQUE, entity_type text,
  rep_name text, brand_key int4 REFERENCES rd.dim_brand_name, registry_role text,       -- app.entity_registry 투영(QA 상세 역할 표시)
  first_seen timestamptz NOT NULL DEFAULT now());                                          -- last_seen 은 누적 속성이라 제거
CREATE INDEX dim_entity_brand_idx ON rd.dim_entity (brand_key);
CREATE TABLE rd.dim_source (source_key int4 GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, skey text NOT NULL UNIQUE, domain text NOT NULL,
  is_social bool NOT NULL, category_key int2 NOT NULL REFERENCES app.citation_category,
  category_src int2 NOT NULL CHECK (category_src BETWEEN 1 AND 6),
  owned_brand_bit int2 NOT NULL DEFAULT 0,                 -- 당사 공식 도메인만(ownedBrandOf)
  competitor_brand_key int4 REFERENCES rd.dim_brand_name,  -- OFFICIAL_COMPETITOR 도메인 → 경쟁사 브랜드(competitor-brand.ts:35 규칙, lens2 m3)
  rule_ver int2 NOT NULL);
CREATE INDEX dim_source_category_idx ON rd.dim_source (category_key);
CREATE TABLE rd.dim_url (url_key int4 GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,   -- 0 예약: INSERT ... OVERRIDING SYSTEM VALUE (0,...)
  url_hash bytea NOT NULL UNIQUE, url text, url_norm text, url_base_norm text, host text, domain text,
  source_key int4 REFERENCES rd.dim_source, owner_key int2 REFERENCES app.owned_base, title text, rule_ver int2 NOT NULL);
CREATE INDEX dim_url_host_idx   ON rd.dim_url (host);
CREATE INDEX dim_url_source_idx ON rd.dim_url (source_key);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. rd: 회차·세대
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE rd.cycle (cyc_key int4 PRIMARY KEY,           -- = ing.cycle.cyc_key (프로젝트 가상 회차 포함, 발급처 하나)
  cycle_id uuid NOT NULL UNIQUE, surface int2 NOT NULL, project_key int2 NOT NULL, ledger_backed bool NOT NULL,
  round_date date NOT NULL, anchor_date date NOT NULL, status int2 NOT NULL, servable bool NOT NULL, view_date date,
  hidden_scope int2 NOT NULL DEFAULT 0,                    -- 0 없음 1 all 2 citations 3 mentions
  generation bigint NOT NULL);
CREATE INDEX cycle_pick_idx ON rd.cycle (surface, round_date DESC) INCLUDE (cyc_key, project_key, servable, view_date, hidden_scope, generation);
CREATE INDEX cycle_project_idx ON rd.cycle (project_key, round_date DESC);
CREATE TABLE rd.surface_generation (surface int2 PRIMARY KEY, generation bigint NOT NULL DEFAULT 0, last_load_id bigint, rule_ver int2,
  as_of date, updated_at timestamptz NOT NULL DEFAULT now());

-- ════════════════════════════════════════════════════════════════════════════
-- 6. rd: 측정 색인과 사실 표
-- ════════════════════════════════════════════════════════════════════════════
-- 6-1. rd.job: Scope job 1건 = 1행(모든 status, 드롭 포함). ing.answer_key_map·ing.answer 와 1:1 그레인.
--      QA 목록·진행률·상세 진입, job_id ↔ answer_key 해석, 스코프 검사(fail-closed)의 유일한 경로(B1·B2, lens2 m6·m8).
CREATE TABLE rd.job (answer_key int4 PRIMARY KEY, job_id uuid NOT NULL UNIQUE, run_key int4 NOT NULL, prompt_key int4 NOT NULL DEFAULT 0,
  cyc_key int4 NOT NULL, round_date date NOT NULL, measured_at timestamptz,
  surface int2 NOT NULL, project_key int2 NOT NULL, engine_key int2 NOT NULL, geo_key int2 NOT NULL, lang_key int2 NOT NULL, bgrp int2 NOT NULL,
  status_code int2 NOT NULL,                               -- 0 completed 1 pending·running 2 failed 3 기타
  analysis_code int2 NOT NULL DEFAULT 0,                   -- analysis_state 와 같은 코드(비완료는 0)
  dropped bool NOT NULL DEFAULT false, served bool NOT NULL, -- served = rd.answer 존재(completed ∧ NOT dropped)
  load_id bigint NOT NULL,
  CHECK (served = (status_code = 0 AND NOT dropped))) WITH (fillfactor = 90);
CREATE INDEX job_qa_list_idx  ON rd.job (surface, measured_at DESC, answer_key DESC);   -- QA 목록 키셋(qa-review.ts:353 정렬 계승)
CREATE INDEX job_round_idx    ON rd.job (surface, round_date, prompt_key);               -- 진행률 창, 미측정 탐침 보조
CREATE INDEX job_run_idx      ON rd.job (run_key);
-- (status_code·dropped·served 는 제자리 UPDATE 대상이지만 btree 에 넣지 않는다)

-- 6-2. rd.answer: 완료·비드롭 job 1건(ACR 반복 포함)
CREATE TABLE rd.answer (round_date date NOT NULL, answer_key int4 NOT NULL, anchor_date date NOT NULL, cyc_key int4 NOT NULL,
  run_key int4 NOT NULL, prompt_key int4 NOT NULL,
  surface int2 NOT NULL, project_key int2 NOT NULL, engine_key int2 NOT NULL, geo_key int2 NOT NULL, lang_key int2 NOT NULL,
  cat_mask int2 NOT NULL, bgrp int2 NOT NULL, anchor_src int2 NOT NULL, acr_iter_rank int2 NOT NULL DEFAULT 1,
  analysis_state int2 NOT NULL CHECK (analysis_state BETWEEN 0 AND 3),
  own_mask int2 NOT NULL DEFAULT 0, own_rk_h int2 NOT NULL DEFAULT 0, own_rk_k int2 NOT NULL DEFAULT 0, own_rk_g int2 NOT NULL DEFAULT 0,   -- G-03
  ment_total int2 NOT NULL DEFAULT 0, ment_h int2 NOT NULL DEFAULT 0, ment_k int2 NOT NULL DEFAULT 0, ment_g int2 NOT NULL DEFAULT 0,
  sent_pos_h int2 NOT NULL DEFAULT 0, sent_pos_k int2 NOT NULL DEFAULT 0, sent_pos_g int2 NOT NULL DEFAULT 0,
  sent_neg_h int2 NOT NULL DEFAULT 0, sent_neg_k int2 NOT NULL DEFAULT 0, sent_neg_g int2 NOT NULL DEFAULT 0,
  sent_all_h int2 NOT NULL DEFAULT 0, sent_all_k int2 NOT NULL DEFAULT 0, sent_all_g int2 NOT NULL DEFAULT 0,
  elig bool NOT NULL, dflt bool NOT NULL, is_acr bool NOT NULL DEFAULT false,
  is_rep bool NOT NULL DEFAULT false,      -- R05: 회차 내부 (cyc_key, prompt, engine, geo) 셀 대표, 후보 = elig. 회차 상태 비의존(lens1 m1)
  web_reg bool NOT NULL DEFAULT false, has_cit bool NOT NULL DEFAULT false, tgt_cited bool NOT NULL DEFAULT false, own_url_cited bool NOT NULL DEFAULT false,
  acr_in bool GENERATED ALWAYS AS (NOT (is_acr AND acr_iter_rank > 1)) STORED,
  gap    bool GENERATED ALWAYS AS (analysis_state >= 2) STORED,
  std_in bool GENERATED ALWAYS AS (elig AND NOT (is_acr AND acr_iter_rank > 1) AND analysis_state < 2) STORED,
  cit_in bool GENERATED ALWAYS AS (elig AND NOT (is_acr AND acr_iter_rank > 1)) STORED,   -- 인용 모수(갭 미포함, G-21 g)
  rule_ver int2 NOT NULL, load_id bigint NOT NULL,
  CHECK (ment_total >= greatest(ment_h, ment_k, ment_g)), PRIMARY KEY (surface, round_date, answer_key)) PARTITION BY LIST (surface);
CREATE TABLE rd.answer_g PARTITION OF rd.answer FOR VALUES IN (1) PARTITION BY RANGE (round_date);
CREATE TABLE rd.answer_w PARTITION OF rd.answer FOR VALUES IN (2) PARTITION BY RANGE (round_date);
CREATE TABLE rd.answer_p PARTITION OF rd.answer FOR VALUES IN (3) PARTITION BY RANGE (round_date);

-- 6-3. rd.answer_brand: 답변 × 표시 브랜드 × 경쟁 여부(G-01 (a) 채택 시. (b) 채택 시 rd.answer_entity 로 대체: 아래 주석)
CREATE TABLE rd.answer_brand (round_date date NOT NULL, answer_key int4 NOT NULL, brand_key int4 NOT NULL, cyc_key int4 NOT NULL, prompt_key int4 NOT NULL,
  surface int2 NOT NULL, project_key int2 NOT NULL, engine_key int2 NOT NULL, geo_key int2 NOT NULL, lang_key int2 NOT NULL, bgrp int2 NOT NULL,
  own_bit int2 NOT NULL, entity_rows int2 NOT NULL, mention_count int2 NOT NULL, rk int2 NOT NULL DEFAULT 0,
  s_pos int2 NOT NULL, s_neu int2 NOT NULL, s_neg int2 NOT NULL, s_mix int2 NOT NULL,
  t_mention int2 NOT NULL, t_recommendation int2 NOT NULL, t_comparison int2 NOT NULL, t_definition int2 NOT NULL, t_final_choice int2 NOT NULL,
  competitive bool NOT NULL,
  std_in bool NOT NULL, elig bool NOT NULL, dflt bool NOT NULL,   -- 게이트 사본: rd.propagate_answer_gates 로만 갱신(B3)
  rule_ver int2 NOT NULL, CHECK (competitive OR rk = 0), CHECK (mention_count >= 0),
  PRIMARY KEY (surface, round_date, answer_key, brand_key, competitive)) PARTITION BY LIST (surface);
CREATE TABLE rd.answer_brand_g PARTITION OF rd.answer_brand FOR VALUES IN (1) PARTITION BY RANGE (round_date);
CREATE TABLE rd.answer_brand_w PARTITION OF rd.answer_brand FOR VALUES IN (2) PARTITION BY RANGE (round_date);
CREATE TABLE rd.answer_brand_p PARTITION OF rd.answer_brand FOR VALUES IN (3) PARTITION BY RANGE (round_date);
-- G-01 (b) 대안 DDL(채택 시 rd.answer_brand 대신):
--   rd.answer_entity (round_date, answer_key, ord int2, entity_key, brand_key, ... 같은 필터 축, own_bit, competitive,
--     name_first bool(같은 답변·표시 브랜드 안 대표 행), name_rk int2, mention_count, s_*, t_*, std_in, elig, dflt,
--     PRIMARY KEY (surface, round_date, answer_key, ord)) : ing.mention 과 1:1. 10배 약 5,500만 행(answer_brand 대비 약 2.4~3.7배).

-- 6-4. rd.answer_stance: ing.answer_stance 와 1:1 그레인(B2 해소, v1 rd.brand_stance 폐기)
CREATE TABLE rd.answer_stance (round_date date NOT NULL, answer_key int4 NOT NULL, entity_key int4 NOT NULL, brand_key int4 NOT NULL DEFAULT 0,
  surface int2 NOT NULL, turn_index int2 NOT NULL, own_bit int2 NOT NULL, stance int2 NOT NULL CHECK (stance BETWEEN 1 AND 4),   -- 1 pos 2 neu 3 mix 4 neg
  first_turn bool NOT NULL,           -- (답변, 엔티티) 안 최저 턴(현행 DISTINCT ON (job_id, entity_id), scope-aggregates.ts:7374 계열)
  std_in bool NOT NULL,               -- 게이트 사본(전파 함수 대상)
  PRIMARY KEY (surface, round_date, answer_key, turn_index, entity_key)) PARTITION BY LIST (surface);
CREATE TABLE rd.answer_stance_g PARTITION OF rd.answer_stance FOR VALUES IN (1) PARTITION BY RANGE (round_date);
CREATE TABLE rd.answer_stance_w PARTITION OF rd.answer_stance FOR VALUES IN (2) PARTITION BY RANGE (round_date);
CREATE TABLE rd.answer_stance_p PARTITION OF rd.answer_stance FOR VALUES IN (3) PARTITION BY RANGE (round_date);

-- 6-5. rd.citation: 인용 원소 1건(ing.citation 과 1:1, G-02)
CREATE TABLE rd.citation (round_date date NOT NULL, answer_key int4 NOT NULL, url_key int4 NOT NULL, source_key int4 NOT NULL DEFAULT 0,
  cyc_key int4 NOT NULL, prompt_key int4 NOT NULL,
  surface int2 NOT NULL, ord int2 NOT NULL, project_key int2 NOT NULL, engine_key int2 NOT NULL, geo_key int2 NOT NULL, lang_key int2 NOT NULL, bgrp int2 NOT NULL,
  scope_key int2 NOT NULL, owner_key int2 NOT NULL DEFAULT 0,
  cit_in bool NOT NULL, gap bool NOT NULL, dflt bool NOT NULL,     -- 게이트 사본(전파 함수 대상). gap 은 호환 변형·A4 대조용
  loc_owned bool NOT NULL, tgt_hit bool NOT NULL, src_first bool NOT NULL, rule_ver int2 NOT NULL,
  PRIMARY KEY (surface, round_date, answer_key, ord)) PARTITION BY LIST (surface);
CREATE TABLE rd.citation_g PARTITION OF rd.citation FOR VALUES IN (1) PARTITION BY RANGE (round_date);
CREATE TABLE rd.citation_w PARTITION OF rd.citation FOR VALUES IN (2) PARTITION BY RANGE (round_date);
CREATE TABLE rd.citation_p PARTITION OF rd.citation FOR VALUES IN (3) PARTITION BY RANGE (round_date);

-- 인덱스(부모 선언 → leaf 전파). 재판정 UPDATE 대상 열은 넣지 않는다(HOT 규율, lens1 m6·lens3 m2 해소).
CREATE INDEX answer_cell_idx    ON rd.answer (surface, round_date, cyc_key, prompt_key, engine_key, geo_key);   -- R05 셀(회차 내부)
CREATE INDEX answer_prompt_idx  ON rd.answer (prompt_key, round_date);                                          -- v1 INCLUDE std_in 제거
CREATE INDEX answer_run_idx     ON rd.answer (run_key);
CREATE INDEX answer_cyc_idx     ON rd.answer (cyc_key);
CREATE INDEX answer_rd_brin     ON rd.answer USING brin (round_date) WITH (pages_per_range = 32, autosummarize = on);
CREATE INDEX answer_p_proj_idx  ON rd.answer_p (project_key, round_date);
CREATE INDEX ab_brand_idx       ON rd.answer_brand (brand_key, round_date) INCLUDE (answer_key, prompt_key);    -- competitive·rk 는 재구축 전용 열이지만 INCLUDE 에서 뺌
CREATE INDEX ab_rd_brin         ON rd.answer_brand USING brin (round_date) WITH (pages_per_range = 32, autosummarize = on);
CREATE INDEX ab_p_proj_idx      ON rd.answer_brand_p (project_key, round_date);
CREATE INDEX st_rd_brin         ON rd.answer_stance USING brin (round_date) WITH (pages_per_range = 32, autosummarize = on);
CREATE INDEX cit_rd_brin        ON rd.citation USING brin (round_date) WITH (pages_per_range = 32, autosummarize = on);
CREATE INDEX cit_source_idx     ON rd.citation (source_key, round_date);   -- source_key 는 leaf 재구축으로만 바뀜(제자리 UPDATE 없음)
CREATE INDEX cit_url_idx        ON rd.citation (url_key);
CREATE INDEX cit_p_proj_idx     ON rd.citation_p (project_key, round_date);
ALTER TABLE rd.answer       ALTER COLUMN prompt_key SET STATISTICS 1000;
ALTER TABLE rd.answer_brand ALTER COLUMN brand_key  SET STATISTICS 1000;
ALTER TABLE rd.citation     ALTER COLUMN source_key SET STATISTICS 1000;
ALTER TABLE rd.citation     ALTER COLUMN url_key    SET STATISTICS 1000;

-- 게이트 전파(B3): rd.answer 의 게이트·회차가 바뀐 답변 집합을 받아 자식 사본을 같은 트랜잭션에서 맞추고 단언한다.
--   round_date 변경(파티션 이동)은 여기서 다루지 않고 회차 재투영(삭제·재삽입)이 담당한다.
CREATE OR REPLACE FUNCTION rd.propagate_answer_gates(p_keys int4[]) RETURNS int LANGUAGE plpgsql AS $f$
-- 답변 위치는 rd.job(answer_key PK)에서 파티션 좌표(surface, round_date)를 얻어 등치 조인으로 찾는다.
-- rd.answer 를 answer_key = ANY 로 직접 찾으면 파티션 키가 없어 모든 leaf 의 PK 인덱스를 끝까지 훑는다
-- (2026-09-27 스모크: 24만 행 12 leaf 4.5ms vs rd.job 경유 0.028ms, 행 수에 비례).
DECLARE n int := 0; m int;
BEGIN
  -- 위치 단언: served 인 job 은 같은 좌표의 rd.answer 가 있어야 한다. 없으면 아래 조인이 조용히 0건이 된다.
  IF EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = ANY(p_keys) AND j.served
               AND NOT EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key))
  THEN RAISE EXCEPTION 'rd.job ↔ rd.answer 위치 불일치: 재투영 누락'; END IF;
  UPDATE rd.answer_brand c SET std_in = a.std_in, elig = a.elig, dflt = a.dflt, cyc_key = a.cyc_key
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.elig, c.dflt, c.cyc_key) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET std_in = a.std_in
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key AND c.std_in IS DISTINCT FROM a.std_in;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET cit_in = a.cit_in, gap = a.gap, dflt = a.dflt, cyc_key = a.cyc_key
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.cit_in, c.gap, c.dflt, c.cyc_key) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.job j SET cyc_key = a.cyc_key, analysis_code = a.analysis_state
    FROM rd.answer a WHERE j.answer_key = ANY(p_keys)
     AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
     AND (j.cyc_key, j.analysis_code) IS DISTINCT FROM (a.cyc_key, a.analysis_state);
  -- 게이트 동치 단언(불변식 ①): 위반 시 롤백
  IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_brand c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.std_in, c.elig, c.dflt, c.cyc_key) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.cit_in, c.gap, c.dflt, c.cyc_key) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key))
  THEN RAISE EXCEPTION 'rd 게이트 사본 불일치: 전파 누락'; END IF;
  RETURN n;
END $f$;
-- answer_key 전역 유일성: 파티션 표의 PK·UNIQUE 는 파티션 키(round_date)를 포함해야 해서 DB 제약으로 보장할 수 없다
-- (스모크에서 같은 answer_key 가 다른 월 leaf 에 중복 삽입됨을 확인). rd.job(answer_key PK)이 유일한 위치 원장이고,
-- 야간 감사가 SELECT answer_key FROM rd.answer GROUP BY 1 HAVING count(*) > 1 = 0건을 단언한다(자식 표도 같은 방식).

-- leaf 생성 헬퍼: 3개월 앞까지 월간 잡이 호출. 카탈로그 선확인 후 CREATE(IF NOT EXISTS 는 락을 먼저 잡음). DEFAULT 파티션 없음.
CREATE OR REPLACE FUNCTION rd.ensure_leaf(p_surface int2, p_from date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, rd AS $f$   -- 부모 소유자만 파티션을 만들 수 있다(스모크 T1)
DECLARE t text; leaf text; sfx text := CASE p_surface WHEN 1 THEN 'g' WHEN 2 THEN 'w' ELSE 'p' END;
        lo date := CASE WHEN p_surface = 3 THEN date_trunc('quarter', p_from)::date ELSE date_trunc('month', p_from)::date END;
        hi date := CASE WHEN p_surface = 3 THEN (lo + interval '3 months')::date ELSE (lo + interval '1 month')::date END;
BEGIN
  FOREACH t IN ARRAY ARRAY['answer','answer_brand','answer_stance','citation'] LOOP
    leaf := format('%s_%s_%s', t, sfx, to_char(lo, 'YYYYMM'));
    IF to_regclass('rd.' || leaf) IS NULL THEN
      EXECUTE format('CREATE TABLE rd.%I PARTITION OF rd.%I FOR VALUES FROM (%L) TO (%L)
                      WITH (fillfactor = 90, parallel_workers = 4, autovacuum_vacuum_insert_scale_factor = 0.02,
                            autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', leaf, t || '_' || sfx, lo, hi);
      IF t = 'answer' THEN
        EXECUTE format('CREATE STATISTICS rd.%I (dependencies, mcv) ON bgrp, cat_mask, engine_key, geo_key, lang_key, dflt, std_in FROM rd.%I', leaf || '_x', leaf);
        EXECUTE format('CREATE STATISTICS rd.%I (dependencies) ON round_date, anchor_date, cyc_key FROM rd.%I', leaf || '_t', leaf);
      ELSIF t = 'answer_brand' THEN
        EXECUTE format('CREATE STATISTICS rd.%I (dependencies, mcv) ON bgrp, std_in, engine_key, geo_key, competitive, own_bit FROM rd.%I', leaf || '_x', leaf);
      ELSIF t = 'citation' THEN
        EXECUTE format('CREATE STATISTICS rd.%I (dependencies, mcv) ON bgrp, cit_in, engine_key, geo_key, owner_key, loc_owned, tgt_hit FROM rd.%I', leaf || '_x', leaf);
      END IF;
    END IF;
  END LOOP;
END $f$;

-- 월 범위 파티션 부모용 leaf 헬퍼(적재기 호출). 스모크 T2: ing·ga4·감사 로그·DataForSEO 는 leaf 생성 경로가 없었다.
--   허용 목록 밖 부모는 거부한다. timestamptz 키는 UTC 월 경계.
CREATE OR REPLACE FUNCTION rd.ensure_month_leaf(p_parent regclass, p_month date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET TimeZone = 'UTC' AS $f$
DECLARE lo date := date_trunc('month', p_month)::date; hi date := (date_trunc('month', p_month) + interval '1 month')::date;
        nsp text; rel text; leaf text;
BEGIN
  IF p_parent NOT IN ('ing.answer'::regclass, 'ing.mention'::regclass, 'ing.mention_occurrence'::regclass, 'ing.answer_stance'::regclass,
                      'ing.citation'::regclass, 'ing.ga4_row'::regclass, 'rd.ga4_row'::regclass, 'app.access_audit_log'::regclass,
                      'ext.dfs_call'::regclass) THEN
    RAISE EXCEPTION 'ensure_month_leaf 허용 목록 밖: %', p_parent;
  END IF;
  SELECT n.nspname, c.relname INTO nsp, rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_parent;
  leaf := rel || '_' || to_char(lo, 'YYYYMM');
  IF to_regclass(format('%I.%I', nsp, leaf)) IS NULL THEN
    EXECUTE format('CREATE TABLE %I.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', nsp, leaf, p_parent, lo, hi);
  END IF;
END $f$;

-- 6-6. 문서형 원본 뷰(G-08): answer_key 등치 조회 전용. 스코프 열(rd.job)을 함께 노출해 API 가 fail-closed 검사(lens2 m8).
--   소유자 = loader_ro(ing SELECT 보유), api_ro 는 뷰 SELECT 만(security_invoker = false). 범위 스캔 금지는 코드 리뷰 가드.
CREATE VIEW rd.v_answer_body WITH (security_barrier) AS
  SELECT j.answer_key, j.job_id, j.surface, j.project_key, j.geo_key, j.bgrp, a.answer_text, a.model_slug, a.measured_at, a.analysis_status, a.status
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id JOIN ing.answer a ON a.run_month = m.run_month AND a.job_id = m.job_id;
CREATE VIEW rd.v_answer_mention_raw WITH (security_barrier) AS          -- QA-01 엔티티 전량(entity_type·역할)(qa-review.ts:688 대체)
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, mt.ord, mt.entity_id, e.entity_key, e.registry_role, mt.display_name,
         mt.entity_type, mt.mention_count, mt.avg_position, mt.brand_rollup_entity_id, mt.surfaces
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id
    JOIN ing.mention mt ON mt.run_month = m.run_month AND mt.job_id = m.job_id LEFT JOIN rd.dim_entity e ON e.entity_id = mt.entity_id;
CREATE VIEW rd.v_answer_occurrence WITH (security_barrier) AS
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, o.ord, o.entity_id, o.turn_index, o.source_start, o.source_end, o.surface_text,
         o.sentiment, o.mention_role, o.assertion, o.context_snippet, o.descriptors, o.criteria
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id JOIN ing.mention_occurrence o ON o.run_month = m.run_month AND o.job_id = m.job_id;
CREATE VIEW rd.v_answer_stance_raw WITH (security_barrier) AS
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, s.turn_index, s.entity_id, s.brand_label, s.stance, s.confidence,
         s.evidence_text, s.evidence_start, s.evidence_end, s.reason
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id JOIN ing.answer_stance s ON s.run_month = m.run_month AND s.job_id = m.job_id;
CREATE VIEW rd.v_answer_registry WITH (security_barrier) AS            -- 앵커 고정·드롭 사유(qa-review.ts:720-721 대체)
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, p.anchor AS pin_anchor, p.reason AS pin_reason, d.reason AS drop_reason, d.dropped_at
    FROM rd.job j LEFT JOIN ing.answer_anchor_pin p ON p.job_id = j.job_id LEFT JOIN ing.answer_drop d ON d.job_id = j.job_id;
-- 인용 원문 목록은 뷰 없이 rd.citation ⋈ rd.dim_url(url·title) 로 읽는다(WA-24, lens1 B1).

-- ════════════════════════════════════════════════════════════════════════════
-- 7. rd: ACR·GA4·키워드·발행값
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE rd.acr_cell (acr_cell_key int4 PRIMARY KEY, round_date date NOT NULL, cyc_key int4 NOT NULL, prompt_key int4 NOT NULL,
  surface int2 NOT NULL, bgrp int2 NOT NULL, project_key int2 NOT NULL, engine_key int2 NOT NULL, geo_key int2 NOT NULL,
  lang_key int2 NOT NULL, cat_mask int2 NOT NULL, planned int2 NOT NULL, valid_turn1 int2 NOT NULL, valid_acr int2 NOT NULL,
  co_single int2 NOT NULL, co_conditional int2 NOT NULL, co_generic int2 NOT NULL, co_off_shortlist int2 NOT NULL, co_unresolved int2 NOT NULL, co_none int2 NOT NULL,
  is_rep bool NOT NULL, acr_in bool NOT NULL, measured_date date NOT NULL, rule_ver int2 NOT NULL) WITH (fillfactor = 90);
-- 커버링 인덱스는 acr_in 을 INCLUDE 한다(카탈로그 kind 변경 시 HOT 불가). 10배 수십만 행 소형이라 허용(HOT 규율 명시 예외). is_rep 은 뺀다.
CREATE INDEX acr_cell_round_cov ON rd.acr_cell (surface, bgrp, round_date)
  INCLUDE (acr_cell_key, cyc_key, prompt_key, engine_key, geo_key, lang_key, cat_mask, acr_in, valid_acr);
CREATE INDEX acr_cell_cyc_cov ON rd.acr_cell (surface, bgrp, cyc_key)
  INCLUDE (acr_cell_key, round_date, prompt_key, engine_key, geo_key, lang_key, cat_mask, acr_in, valid_acr);
CREATE TABLE rd.acr_cell_job (answer_key int4 NOT NULL, acr_cell_key int4 NOT NULL,     -- ing.acr_prompt_run.source_job_ids 원소 1개 = 1행
  PRIMARY KEY (answer_key, acr_cell_key));                                                 -- QA-01·QA-04 job → ACR 셀(B1·B2, lens2)
CREATE TABLE rd.acr_choice (acr_cell_key int4 NOT NULL, entity_key int4 NOT NULL,
  brand_key int4 NOT NULL DEFAULT 0,           -- level 1(브랜드) 표시 브랜드. 차종·회사 레벨은 0 이고 표시는 rd.dim_entity.rep_name(lens2 m11)
  parent_brand_key int4 NOT NULL DEFAULT 0,    -- product → 소속 브랜드
  level int2 NOT NULL, own_bit int2 NOT NULL, name_own int2 NOT NULL,
  appearance int2 NOT NULL, choice int2 NOT NULL, cond_choice int2 NOT NULL, off_shortlist int2 NOT NULL, unresolved int2 NOT NULL, generic int2 NOT NULL,
  keep bool NOT NULL, CHECK (level = 1 OR brand_key = 0),
  PRIMARY KEY (level, acr_cell_key, entity_key) INCLUDE (brand_key, own_bit, name_own, keep, choice, appearance)) PARTITION BY LIST (level);
CREATE TABLE rd.acr_choice_brand   PARTITION OF rd.acr_choice FOR VALUES IN (1);
CREATE TABLE rd.acr_choice_product PARTITION OF rd.acr_choice FOR VALUES IN (2);
CREATE TABLE rd.acr_choice_company PARTITION OF rd.acr_choice FOR VALUES IN (3);
CREATE INDEX acr_choice_brand_brin   ON rd.acr_choice_brand   USING brin (acr_cell_key) WITH (pages_per_range = 16);
CREATE INDEX acr_choice_product_brin ON rd.acr_choice_product USING brin (acr_cell_key) WITH (pages_per_range = 16);

-- GA4: ing.ga4_row 와 1:1 그레인(B2 해소). 채널·소스를 합산하지 않고 is_ai·engine_key·is_conv 는 판정 열.
CREATE TABLE rd.ga4_dim_property (prop_key int2 PRIMARY KEY, property_id text NOT NULL UNIQUE, brand_bit int2, geo_key int2,
  status text NOT NULL CHECK (status IN ('active','pending_grant','unmapped')), source text NOT NULL CHECK (source IN ('registry','project_override','env')));
CREATE TABLE rd.ga4_dim_value (kind text NOT NULL CHECK (kind IN ('channel','source','device','nvr','event','page')),
  value_key int4 NOT NULL, value text NOT NULL, PRIMARY KEY (kind, value_key), UNIQUE (kind, value));   -- 빈 문자열 = value_key 0
CREATE TABLE rd.ga4_row (prop_key int2 NOT NULL, date date NOT NULL,
  report int2 NOT NULL CHECK (report BETWEEN 1 AND 5),     -- 1 traffic_total 2 traffic_ai 3 events 4 landing 5 totals
  channel_key int4 NOT NULL, source_key int4 NOT NULL, device_key int4 NOT NULL, nvr_key int4 NOT NULL, page_key int4 NOT NULL, event_key int4 NOT NULL,
  is_ai bool NOT NULL,          -- channel_group = 'AI Assistant'(AI_CHANNEL_GROUP lib/ga4/client.ts:62)
  engine_key int2 NOT NULL,     -- AI 행의 sessionSource 매핑(ENGINE_SOURCE lib/ga4/conversion.ts:131), 그 외 0
  is_conv bool NOT NULL,        -- 추적 이벤트 또는 key event 폴백(events·landing 행)
  sessions int, users_day int,  -- users_day 는 행 사이로 합하지 않는다(API 규약, lens1 m9)
  page_views int, key_events int, event_count int,
  PRIMARY KEY (prop_key, report, date, channel_key, source_key, device_key, nvr_key, page_key, event_key)) PARTITION BY RANGE (date);
-- 적재 불변식: 날짜·기기·신규재방문별 Σ(report 2 sessions) = report 1 의 AI 채널 행 sessions(GA4 임계값 차이는 ing.load 에 기록)

CREATE TABLE rd.dim_keyword (kw_key int4 GENERATED ALWAYS AS IDENTITY PRIMARY KEY, term text NOT NULL, term_norm text NOT NULL UNIQUE);
CREATE TABLE rd.kw_volume_monthly (kw_key int4 NOT NULL REFERENCES rd.dim_keyword, location_code int NOT NULL, language_code text NOT NULL,
  month date NOT NULL CHECK (extract(day FROM month) = 1), search_volume int, competition_index int2, cpc numeric(10,2),
  call_id bigint NOT NULL, observed_at timestamptz NOT NULL, PRIMARY KEY (kw_key, location_code, language_code, month));
CREATE TABLE rd.kw_serp (call_id bigint NOT NULL, kw_key int4 NOT NULL REFERENCES rd.dim_keyword, location_code int NOT NULL,
  language_code text NOT NULL, rank int2 NOT NULL, url text NOT NULL, domain text, title text, snippet text, observed_at timestamptz NOT NULL,
  PRIMARY KEY (call_id, rank));
CREATE INDEX kw_serp_latest ON rd.kw_serp (kw_key, location_code, language_code, call_id DESC);
CREATE TABLE rd.kw_suggestion (call_id bigint NOT NULL, seed_kw_key int4 NOT NULL REFERENCES rd.dim_keyword, location_code int NOT NULL,
  language_code text NOT NULL, pos int2 NOT NULL, kw_key int4 NOT NULL REFERENCES rd.dim_keyword, search_volume int, intent text,
  is_seed bool NOT NULL DEFAULT false, PRIMARY KEY (call_id, pos));
CREATE INDEX kw_suggestion_latest ON rd.kw_suggestion (seed_kw_key, location_code, language_code, call_id DESC);
CREATE TABLE rd.report_unit_value (round_date date NOT NULL, file_seq int NOT NULL, cyc_key int4, pub_id uuid NOT NULL,
  brand text NOT NULL, country_code text, lang_code text, in_headline_pool bool NOT NULL,
  target_hit_prompts int NOT NULL, measured_prompts int NOT NULL, owned_prompts int NOT NULL, owned_prompts_den int NOT NULL,
  prev_target_hit_prompts int, prev_measured_prompts int, prev_owned_prompts int, prev_owned_prompts_den int,
  load_id bigint NOT NULL, PRIMARY KEY (round_date, file_seq));   -- 쓰기 주체 = 적재기(judgment_change 'report_publication')

-- ════════════════════════════════════════════════════════════════════════════
-- 8. ext: 외부 응답 원본·정적 스냅샷 (v1 과 같음)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE ext.dfs_call (call_id bigint GENERATED ALWAYS AS IDENTITY,
  endpoint text NOT NULL CHECK (endpoint IN ('search_volume','serp_organic','keyword_suggestions')),
  location_code int, language_code text, keywords text[] NOT NULL, request jsonb NOT NULL, response jsonb,
  status_code int NOT NULL, cost numeric(10,4), requested_by uuid, project_id uuid, requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requested_at, call_id)) PARTITION BY RANGE (requested_at);
CREATE INDEX dfs_call_latest ON ext.dfs_call (endpoint, location_code, language_code, requested_at DESC);
CREATE INDEX dfs_call_kw_gin ON ext.dfs_call USING gin (keywords);
CREATE TABLE ext.ctx_snapshot (snapshot_id int2 PRIMARY KEY, industry_entity_id uuid NOT NULL, source text NOT NULL,
  utterance_total int, taken_at timestamptz NOT NULL, is_active bool NOT NULL DEFAULT false);
CREATE UNIQUE INDEX ctx_snapshot_one_active ON ext.ctx_snapshot (industry_entity_id) WHERE is_active;
CREATE TABLE ext.ctx_entity (snapshot_id int2 NOT NULL REFERENCES ext.ctx_snapshot, id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('ConsumerContext','ConsumerRequirement')), canonical_name text NOT NULL, dimension text,
  mention_count int NOT NULL DEFAULT 0, utterance_count int NOT NULL DEFAULT 0,
  sentiment_positive int NOT NULL DEFAULT 0, sentiment_negative int NOT NULL DEFAULT 0, sentiment_neutral int NOT NULL DEFAULT 0, PRIMARY KEY (snapshot_id, id));
CREATE INDEX ctx_entity_type_mentions ON ext.ctx_entity (snapshot_id, type, mention_count DESC);
CREATE TABLE ext.ctx_drive (snapshot_id int2 NOT NULL, context_id uuid NOT NULL, requirement_id uuid NOT NULL, co_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, context_id, requirement_id));
CREATE TABLE ext.ctx_combination (snapshot_id int2 NOT NULL, cond_a uuid NOT NULL, cond_b uuid NOT NULL, co_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, cond_a, cond_b));
CREATE TABLE ext.ctx_evidence (snapshot_id int2 NOT NULL, id uuid NOT NULL, entity_id uuid NOT NULL, utterance_id uuid NOT NULL,
  quote text NOT NULL, source_host text, source_url text, sentiment text, PRIMARY KEY (snapshot_id, id));
CREATE INDEX ctx_evidence_entity ON ext.ctx_evidence (snapshot_id, entity_id);
CREATE TABLE ext.ctx_domain (snapshot_id int2 NOT NULL, entity_id uuid NOT NULL, host text NOT NULL, n int NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, entity_id, host));
-- ext.webgeo_*: 현행 정의 그대로 정적 이관(+ webgeo_pages (raw_html_path) 인덱스). crawl_*: S3 + mig.archive_manifest(G-13).

-- ════════════════════════════════════════════════════════════════════════════
-- 9. mig: 이관·병행 운영 원장 (v1 과 같음, 요약)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE mig.source_snapshot (snapshot_id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz, w0_synced_at timestamptz NOT NULL, counts jsonb NOT NULL DEFAULT '{}', note text);
CREATE TABLE mig.copy_chunk (snapshot_id int NOT NULL REFERENCES mig.source_snapshot, source_table text NOT NULL, chunk_no int NOT NULL,
  key_lo text, key_hi text, rows bigint, started_at timestamptz, done_at timestamptz, err text, PRIMARY KEY (snapshot_id, source_table, chunk_no));
CREATE TABLE mig.rebuild_batch (batch_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, rule_ver int2 NOT NULL, target_table text NOT NULL,
  partition_name text NOT NULL, range_from date NOT NULL, range_to date NOT NULL,
  state text NOT NULL CHECK (state IN ('building','checked','attached','failed')), rows bigint,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, err text);
CREATE TABLE mig.partition_checksum (rule_ver int2 NOT NULL, table_name text NOT NULL, partition_name text NOT NULL,
  method text NOT NULL CHECK (method IN ('incremental','rebuild')), row_count bigint NOT NULL, row_hash numeric NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (rule_ver, table_name, partition_name, method, taken_at));
CREATE TABLE mig.run_fingerprint (side text NOT NULL CHECK (side IN ('old','new')), run_id uuid NOT NULL, taken_at timestamptz NOT NULL DEFAULT now(),
  run_status text, jobs int NOT NULL, completed int NOT NULL, mention_rows int NOT NULL, citation_rows int NOT NULL, occ_rows int,
  jobs_without_analysis int NOT NULL, job_set_hash numeric NOT NULL, mention_sum bigint NOT NULL, PRIMARY KEY (side, run_id, taken_at));
CREATE TABLE mig.parity_run (parity_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, surface text NOT NULL, cycle_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, combos text[] NOT NULL, features text[] NOT NULL,
  old_path jsonb, input_match_ratio numeric, result text CHECK (result IN ('clean','explained_only','unexplained','aborted')));
CREATE TABLE mig.known_diff (diff_id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, rule_id text NOT NULL, feature_id text NOT NULL,
  metric_key_like text NOT NULL, compat_variant text NOT NULL CHECK (compat_variant IN ('rep','acr_incl','gap_off','gap_cit','url_prompt','rank_count','input')),
  description text NOT NULL, decided_ref text NOT NULL, notice_required bool NOT NULL DEFAULT true, first_seen_parity_run bigint,
  UNIQUE (rule_id, feature_id, metric_key_like));
CREATE TABLE mig.parity_result (parity_run_id bigint NOT NULL REFERENCES mig.parity_run, feature_id text NOT NULL, combo_id text NOT NULL,
  metric_key text NOT NULL, old_num numeric, old_den numeric, new_num numeric, new_den numeric, compat_variant text, compat_num numeric, compat_den numeric,
  verdict text NOT NULL CHECK (verdict IN ('match','round','explained','unexplained','input_mismatch','old_missing','new_missing','error')),
  rule_ids text[] NOT NULL DEFAULT '{}', note text, PRIMARY KEY (parity_run_id, feature_id, combo_id, metric_key),
  CHECK (verdict <> 'explained' OR cardinality(rule_ids) > 0));
CREATE TABLE mig.row_oracle_diff (parity_run_id bigint NOT NULL REFERENCES mig.parity_run,
  oracle text NOT NULL CHECK (oracle IN ('scope_answer_cycle_anchors','summary_answers','summary_brand_mentions','summary_url_hits')),
  job_id uuid NOT NULL, field text NOT NULL, old_value text, new_value text, rule_id text, PRIMARY KEY (parity_run_id, oracle, job_id, field));
CREATE TABLE mig.screen_group (group_id text PRIMARY KEY, order_no int NOT NULL UNIQUE, routes text[] NOT NULL, feature_ids text[] NOT NULL,
  has_writes bool NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'old' CHECK (state IN ('old','shadow','candidate','switched','rolled_back','decommissioned')),
  consecutive_clean int NOT NULL DEFAULT 0, gate_cycles_required int NOT NULL DEFAULT 2, notice_sent_at timestamptz, switched_at timestamptz,
  CHECK (state <> 'switched' OR consecutive_clean >= gate_cycles_required));
CREATE TABLE mig.cutover_event (event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, group_id text REFERENCES mig.screen_group,
  action text NOT NULL CHECK (action IN ('switch','rollback','freeze_start','freeze_end','decommission')), at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL, approval_ref text, reason text, CHECK (action NOT IN ('switch','decommission') OR approval_ref IS NOT NULL));
CREATE TABLE mig.repull_log (run_id uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (reason IN ('r12_missing_analysis','torn_seed_run','fingerprint_mismatch')),
  missing_before int, missing_after int, done_at timestamptz, err text, PRIMARY KEY (run_id, requested_at));
CREATE TABLE mig.archive_manifest (object_name text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('table','function','cron','runner','s3_table')),
  rows bigint, bytes bigint, dump_uri text, format text, sha256 text, ddl text, archived_at timestamptz, dropped_at timestamptz, retention_until date,
  CHECK (dropped_at IS NULL OR (archived_at IS NOT NULL AND sha256 IS NOT NULL AND archived_at <= dropped_at)));
-- archive.bak_anchor_fold: 원천 pg_dump --schema-only 정의 그대로 생성 후 COPY(삭제 금지).

-- ════════════════════════════════════════════════════════════════════════════
-- 10. 롤·권한 (쓰기 주체 = 계약 §5). v2: 주석 → 실행 문장, 스모크 T5·T6 통과
-- ════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- DB 설계 v2 §10 롤·권한 실행 DDL (DB-보정.sql 뒤에 적용). 2026-09-27
-- 원칙: 모든 객체 소유자 = hmg_owner(NOLOGIN). DDL 이 필요한 적재 작업(leaf 생성·스왑)은
--       SECURITY DEFINER 함수로만 연다(파티션 생성·ATTACH 는 부모 소유자만 가능).
-- ============================================================================
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['hmg_owner','loader','loader_ro','api_ro','api_rw','admin_long','migrator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP; END $$;

-- 1. 소유자 일원화(스키마·표·뷰·함수·타입·시퀀스)
DO $$ DECLARE o record; BEGIN
  FOR o IN SELECT nspname FROM pg_namespace WHERE nspname IN ('ing','rd','app','ext','mig','archive') LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO hmg_owner', o.nspname);
  END LOOP;
  FOR o IN SELECT c.oid::regclass AS obj, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('ing','rd','app','ext','mig','archive') AND c.relkind IN ('r','p','v','m','f') LOOP
    -- 파티션도 포함한다: 부모 OWNER 변경은 파티션으로 전파되지 않고, 하위 파티션 생성은 직계 부모 소유자만 가능하다
    EXECUTE format('ALTER %s %s OWNER TO hmg_owner', CASE o.relkind WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END, o.obj);
  END LOOP;
  FOR o IN SELECT p.oid::regprocedure AS obj FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('ing','rd','app','ext','mig') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hmg_owner', o.obj);
  END LOOP;
  FOR o IN SELECT t.oid::regtype AS obj FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'app' AND t.typtype = 'e' LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO hmg_owner', o.obj);
  END LOOP;
END $$;

-- 2. 기본 차단
REVOKE ALL ON SCHEMA ing, rd, app, ext, mig, archive FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA rd, app FROM PUBLIC;

-- 3. api_ro: rd·app·ext 읽기만(ing·mig·archive 없음). 문서형 뷰는 rd 안이라 함께 열린다.
GRANT USAGE ON SCHEMA rd, app, ext TO api_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA rd, app, ext TO api_ro;
GRANT EXECUTE ON FUNCTION rd.today_kst() TO api_ro;
ALTER ROLE api_ro SET plan_cache_mode = 'force_custom_plan';
ALTER ROLE api_ro SET jit = off;
ALTER ROLE api_ro SET statement_timeout = '5s';
ALTER ROLE api_ro SET default_transaction_read_only = on;

-- 4. api_rw: app 쓰기(행위자 필수), 재판정 요청 INSERT. ing·rd 쓰기 없음.
GRANT USAGE ON SCHEMA app TO api_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO api_rw;
REVOKE UPDATE, DELETE ON app.judgment_change FROM api_rw;           -- 상태 전이는 적재기만
REVOKE UPDATE, DELETE ON app.prompt_audit_log, app.member_audit_log, app.permission_audit_log FROM api_rw;
GRANT EXECUTE ON FUNCTION app.actor() TO api_rw;

-- 5. loader_ro: 문서형 뷰 소유자(로그인 불가). 뷰가 읽는 ing·rd 표 SELECT.
GRANT USAGE ON SCHEMA ing, rd TO loader_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA ing TO loader_ro;
GRANT SELECT ON rd.job, rd.dim_entity TO loader_ro;
DO $$ DECLARE v record; BEGIN
  FOR v IN SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'rd' AND c.relkind = 'v' LOOP
    EXECUTE format('ALTER VIEW %s OWNER TO loader_ro', v.obj);
    EXECUTE format('GRANT SELECT ON %s TO api_ro', v.obj);
  END LOOP; END $$;

-- 6. loader: ing·rd·ext DML, app 읽기 + 재판정 큐 상태 전이. DDL 은 SECURITY DEFINER 함수로만.
GRANT USAGE ON SCHEMA ing, rd, ext, app TO loader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ing, rd, ext TO loader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ing, rd, ext TO loader;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO loader;
GRANT UPDATE (status, claimed_at, applied_at, applied_load_id, error) ON app.judgment_change TO loader;
GRANT EXECUTE ON FUNCTION rd.propagate_answer_gates(int4[]), rd.ensure_leaf(int2, date), rd.ensure_month_leaf(regclass, date),
  rd.today_kst() TO loader;
ALTER ROLE loader SET lock_timeout = '5s';
ALTER ROLE loader SET statement_timeout = '180s';

-- 7. migrator: mig·archive 쓰기, ing·rd 쓰기(시드·재구축). 이관 종료 후 회수.
GRANT USAGE ON SCHEMA mig, archive, ing, rd, app TO migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mig, archive, ing, rd TO migrator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mig, archive, ing, rd TO migrator;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO migrator;

-- 8. admin_long: AD-01·인용 큐레이션 전용 rd 읽기(긴 제한시간).
GRANT USAGE ON SCHEMA rd, app TO admin_long;
GRANT SELECT ON ALL TABLES IN SCHEMA rd, app TO admin_long;
ALTER ROLE admin_long SET statement_timeout = '30s';
ALTER ROLE admin_long SET default_transaction_read_only = on;

-- 9. 이후 hmg_owner 가 만드는 객체(ensure_leaf 가 만든 leaf 는 부모 권한을 따르므로 대상 아님)
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_owner IN SCHEMA rd, app, ext GRANT SELECT ON TABLES TO api_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_owner IN SCHEMA ing, rd, ext GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO loader;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.1 보완 패치 (PostgreSQL 17, 2026-09-28)
-- 적용 순서: DB-v2.sql 적용 직후 이 파일 1회(트랜잭션 1개, ON_ERROR_STOP 통과 전제). DB-v2.sql 자체는 수정하지 않는다.
-- 입력: modules/전체-통합.json read_schema [채택] 1~18, modules/DECISIONS-API.md Q2·Q3·Q4·Q14·Q17, DESIGN-CONTRACT.md §3.
--
-- 반영 목록
--   P01 judgment_change.kind 에 dfs_fetch·ga4_property·ga4_tracked_event 추가(채택 1·2)
--   P02 loader 의 judgment_change INSERT(채택 3: scope_prompt 는 적재기가 스스로 넣는다)
--   P03 outbox 워커(loader) 열 단위 UPDATE + app.actor() EXECUTE(채택 4)
--   P04 트리거 본문(채택 5, Q3): app.project AFTER UPDATE → judgment_change 'project_setting',
--       app.prompt tg_catalog_change → prompt_audit_log + judgment_change 'catalog'|'prompt_kind'. SECURITY DEFINER,
--       행위자 app.actor(), batch_id = GUC app.batch_id, 행위자 유형 = GUC app.actor_type('user' 기본 | 'system')
--   P05 rd.dim_project.regions + ing.sync_cursor.regions(채택 6)
--   P06 rd.cycle.hidden_reason(채택 7) + Q2 카운터 4열(ing.cycle 1:1 투영, 새 합산 없음)
--   P07 COMMENT ON COLUMN rd.cycle.status·rd.answer.analysis_state 외(채택 8)
--   P08 rd.job job_qa_list_idx NULLS LAST 교체(채택 9)
--   P09 문서형 뷰 확장 3건(채택 10) + 운영 조회 뷰 3개(채택 11). 소유자 loader_ro, api_ro SELECT
--   P10 ing.stage_* (load_id, job_id) 인덱스(채택 12)
--   P11 rd.answer CHECK (NOT tgt_cited OR own_url_cited)(채택 13)
--   P12 rd.dim_source (domain) 인덱스(채택 14), 앱·ext 인덱스 5건(채택 15)
--   P13 제약 2건(채택 16): app.prompt.status 6값, app.member_audit_log.action 7값
--       (현행 코드 확인: lib/db/migrations/0006_member_audit_logs.sql:6-14 ENUM 7값, lib/db/schema.ts:274-282.
--        관리자 승계는 별도 action 이 아니라 action='promote' + context 'orphan-succession ...'(app/[locale]/(dash)/admin/_actions.ts:240-246))
--   P14 rd.ga4_dim_property.conv_basis(채택 17), app.ctx_generated_prompt 4열 + seed_key UNIQUE(채택 18)
--   P15 Q4: app.access_audit_log append-only(행 트리거, 파티션 leaf 로 복제) + api_rw UPDATE·DELETE 회수
--   P16 Q17: 검수 게이트 전용 롤 qa_gate(NOLOGIN)
--
-- Q14 (DB-v2.sql 주석 정정, DDL 변경 없음)
--   DB-v2.sql §8 의 주석 "ext.webgeo_*: 현행 정의 그대로 정적 이관(+ webgeo_pages (raw_html_path) 인덱스). crawl_*: S3 + mig.archive_manifest(G-13)."
--   는 다음으로 대체한다: "crawl_*·webgeo_* 모두 S3 보관(mig.archive_manifest), 새 DB 에 올리지 않음(2026-09-28 Q14)".
--   DB-v2.sql 에 webgeo_* 실 DDL 은 없으므로 이 패치에서 지울 객체도 없다. 리포 밖 사용처가 나오면 archive_manifest 로 복원한다.
--
-- 규약 확인
--   D8: 사전 집계·요약 표·매트뷰·결과 캐시·새 누적 카운터 없음. rd.cycle 카운터 4열은 ing.cycle 과 1:1 투영(Q2 개정, D8 예외 ③).
--   HOT: 새 btree 는 재판정 제자리 UPDATE 대상 열을 포함하지 않는다(rd.cycle 카운터·hidden_reason 도 어떤 인덱스에도 넣지 않는다).
--   소유자: 이 패치는 superuser 로 적용되므로 새 함수는 hmg_owner, 새 뷰는 loader_ro 로 소유자를 명시 이전하고 권한을 명시 부여한다
--          (ALTER DEFAULT PRIVILEGES FOR ROLE hmg_owner 는 hmg_owner 가 만든 객체에만 적용되기 때문).
--   조건부 보류(RDS 실측 게이트) 항목과 기각 항목은 넣지 않았다.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- P01. 재판정·운영 요청 큐 kind 확장
--   dfs_fetch        : 운영자 DataForSEO 수집 요청(Q13). 적재기(loader) 빠른 경로가 claim → ext.dfs_call·rd.kw_* 를 한 트랜잭션으로 쓰고 상태 전이
--   ga4_property     : GA4 속성 매핑 변경. 적재기가 해당 속성 전 기간 rd.ga4_row 재투영
--   ga4_tracked_event: 추적 이벤트 변경. is_conv·conv_basis 전 기간 재투영('최근 3일 교체'로는 과거 행이 안 바뀜)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE app.judgment_change DROP CONSTRAINT judgment_change_kind_check;
ALTER TABLE app.judgment_change ADD CONSTRAINT judgment_change_kind_check CHECK (kind IN (
    'catalog','prompt_kind','entity','brand_rule','competitor_token','hidden_market','citation_override','owned_base',
    'website_catalog','project_setting','project_owned_base','project_target_url','rule_param','scope_prompt',
    'cycle_admin','anchor_pin','answer_drop','report_publication',
    'dfs_fetch','ga4_property','ga4_tracked_event'));

-- ════════════════════════════════════════════════════════════════════════════
-- P02·P03. loader 권한 보강
--   P02: DB-v2.sql:81 "scope_prompt 는 적재기가 스스로 넣는다" 인데 loader 는 상태 열 UPDATE(:861)만 있었다.
--   P03: outbox 워커(hmg.ingest.worker outbox 루프, loader 롤). SET LOCAL app.actor_id = 시스템 사용자 uuid,
--        SET LOCAL app.actor_type = 'system'. Scope 반영 후 scope_*_id 되쓰기. app.prompt 되쓰기의 prompt_audit_log·
--        judgment_change('catalog') 는 P04 트리거가 남긴다(워커가 직접 쓰지 않는다).
-- ════════════════════════════════════════════════════════════════════════════
GRANT INSERT ON app.judgment_change TO loader;
GRANT UPDATE (attempts, next_attempt_at, done_at, last_error) ON app.scope_outbox TO loader;
GRANT UPDATE (scope_project_id, updated_at) ON app.project TO loader;
GRANT UPDATE (scope_prompt_id, status, updated_by, updated_at) ON app.prompt TO loader;
GRANT EXECUTE ON FUNCTION app.actor() TO loader;

-- ════════════════════════════════════════════════════════════════════════════
-- P13 (트리거보다 먼저). 제약 2건
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE app.prompt ADD CONSTRAINT prompt_status_check
  CHECK (status IN ('draft','queued','running','done','failed','paused'));          -- lib/db/schema.ts:335-342 (0004 + 0038 paused)
ALTER TABLE app.member_audit_log ADD CONSTRAINT member_audit_action_check
  CHECK (action IN ('invite','cancel_invite','remove','promote','demote','accept','reject'));   -- 0006 ENUM 7값, 승계 = 'promote'+context

-- ════════════════════════════════════════════════════════════════════════════
-- P04. 트리거 본문 (Q3 혼합: app.project·app.prompt 는 DB 트리거, 그 밖의 kind 는 앱 core.write.enqueue_change 명시 INSERT)
--   앱은 'catalog'·'prompt_kind' 와 app.project 4열 변경의 'project_setting' 을 직접 INSERT 하지 않는다(이중 기록 금지).
--   tracked_* 변경의 'project_setting' 은 앱이 명시 INSERT 한다(전체-통합 채택 5).
-- ════════════════════════════════════════════════════════════════════════════

-- P04-a. app.project AFTER UPDATE: domain·brand_code·country_code·ai_engines 변경 → judgment_change('project_setting')
CREATE FUNCTION app.tg_project_setting_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  INSERT INTO app.judgment_change (kind, subject_uuids, payload, requested_by)
  VALUES ('project_setting', ARRAY[NEW.project_id],
          jsonb_build_object('op', 'update', 'project_id', NEW.project_id, 'scope_project_id', NEW.scope_project_id,
            'old', jsonb_build_object('domain', OLD.domain, 'brand_code', OLD.brand_code, 'country_code', OLD.country_code, 'ai_engines', OLD.ai_engines),
            'new', jsonb_build_object('domain', NEW.domain, 'brand_code', NEW.brand_code, 'country_code', NEW.country_code, 'ai_engines', NEW.ai_engines)),
          app.actor());                                        -- 행위자 필수: 미설정이면 UPDATE 전체 거부
  RETURN NULL;
END $f$;
CREATE TRIGGER project_setting_change
  AFTER UPDATE OF domain, brand_code, country_code, ai_engines ON app.project
  FOR EACH ROW
  WHEN ((OLD.domain, OLD.brand_code, OLD.country_code, OLD.ai_engines) IS DISTINCT FROM (NEW.domain, NEW.brand_code, NEW.country_code, NEW.ai_engines))
  EXECUTE FUNCTION app.tg_project_setting_change();

-- P04-b. app.prompt tg_catalog_change: 전 프로젝트 대상(v1 초안의 standard_root 한정 폐기)
--   1) prompt_audit_log 1행(행 변경 1건 = 이벤트 1건, 바뀐 필드는 changes 에 합산. 현행 _actions.ts:664 의 "이벤트 분열 방지" 계승)
--      event_type 우선순위: restored·deleted > kind_changed > text_updated > enabled_changed > meta_updated
--      changes 형식 = {필드: {old: text|null, new: text|null}} (현행 lib/standards/audit.ts PromptAuditChanges)
--        INSERT → created {text}, DELETE → deleted {deleted, purged}, deleted_at 전환 → deleted|restored {deleted},
--        status 가 'paused' 로/에서 전환 → enabled_changed {enabled}. draft→queued→running→done·failed 수명 전이만 있으면 감사 행 없음.
--   2) judgment_change: 옛·새 scope_prompt_id 중 NULL 아닌 것이 있을 때만(rd 는 Scope prompt_id 로만 이 행을 안다)
--        UPDATE 에서 kind 변경 → 'prompt_kind'
--        INSERT·DELETE, 또는 UPDATE 에서 brand_code·brand_presence·list_type·depth1~4·funnel_stage·scope_prompt_id·deleted_at 변경 → 'catalog'
--      payload = {op, prompt_id, project_id, old:{…}, new:{…}}. rd 는 쓰지 않는다(B4).
--   행위자 = app.actor()(미설정이면 app.prompt 쓰기 전체 거부), actor_type = GUC app.actor_type, batch_id = GUC app.batch_id.
CREATE FUNCTION app.tg_catalog_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  v_actor uuid := app.actor();
  v_type  text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'user');
  v_batch uuid := nullif(current_setting('app.batch_id', true), '')::uuid;
  o jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  diff_f text[] := ARRAY['text','kind','prompt_type','category','brand_code','brand_presence','list_type',
                         'depth1','depth2','depth3','depth4','funnel_stage','lang','regions','scope_prompt_id'];
  cat_f  text[] := ARRAY['brand_code','brand_presence','list_type','depth1','depth2','depth3','depth4',
                         'funnel_stage','scope_prompt_id','deleted_at'];
  f text; ch jsonb := '{}'::jsonb; ev text; was_del bool; is_del bool; was_on bool; is_on bool;
  subj uuid[]; pl jsonb;
BEGIN
  IF v_type NOT IN ('user','system') THEN
    RAISE EXCEPTION 'app.actor_type 은 user|system 만 허용: %', v_type;
  END IF;

  -- 1) 감사
  IF TG_OP = 'INSERT' THEN
    ev := 'created';
    ch := jsonb_build_object('text', jsonb_build_object('old', NULL, 'new', n->>'text'));
  ELSIF TG_OP = 'DELETE' THEN
    ev := 'deleted';
    ch := jsonb_build_object('deleted', jsonb_build_object('old', ((o->>'deleted_at') IS NOT NULL)::text, 'new', 'true'),
                             'purged',  jsonb_build_object('old', 'false', 'new', 'true'));
  ELSE
    FOREACH f IN ARRAY diff_f LOOP
      IF (o->f) IS DISTINCT FROM (n->f) THEN
        ch := ch || jsonb_build_object(f, jsonb_build_object('old', o->>f, 'new', n->>f));
      END IF;
    END LOOP;
    was_del := OLD.deleted_at IS NOT NULL;  is_del := NEW.deleted_at IS NOT NULL;
    IF was_del <> is_del THEN
      ch := ch || jsonb_build_object('deleted', jsonb_build_object('old', was_del::text, 'new', is_del::text));
    END IF;
    was_on := OLD.status <> 'paused';  is_on := NEW.status <> 'paused';
    IF was_on <> is_on THEN
      ch := ch || jsonb_build_object('enabled', jsonb_build_object('old', was_on::text, 'new', is_on::text));
    END IF;
    ev := CASE WHEN was_del AND NOT is_del THEN 'restored'
               WHEN is_del AND NOT was_del THEN 'deleted'
               WHEN ch ? 'kind'    THEN 'kind_changed'
               WHEN ch ? 'text'    THEN 'text_updated'
               WHEN ch ? 'enabled' THEN 'enabled_changed'
               WHEN ch <> '{}'::jsonb THEN 'meta_updated' END;
  END IF;
  IF ev IS NOT NULL THEN
    INSERT INTO app.prompt_audit_log (prompt_id, project_id, actor_id, actor_type, event_type, changes, batch_id)
    VALUES ((coalesce(n, o)->>'prompt_id')::uuid, (coalesce(n, o)->>'project_id')::uuid, v_actor, v_type, ev, ch, v_batch);
  END IF;

  -- 2) 재판정 요청
  subj := ARRAY(SELECT DISTINCT x::uuid FROM unnest(ARRAY[o->>'scope_prompt_id', n->>'scope_prompt_id']) x WHERE x IS NOT NULL);
  IF cardinality(subj) > 0 THEN
    pl := jsonb_build_object('op', lower(TG_OP), 'prompt_id', coalesce(n, o)->'prompt_id', 'project_id', coalesce(n, o)->'project_id',
            'old', (SELECT jsonb_object_agg(k, o->k) FROM unnest(cat_f || 'kind'::text) k WHERE o IS NOT NULL),
            'new', (SELECT jsonb_object_agg(k, n->k) FROM unnest(cat_f || 'kind'::text) k WHERE n IS NOT NULL));
    IF TG_OP = 'UPDATE' AND (o->'kind') IS DISTINCT FROM (n->'kind') THEN
      INSERT INTO app.judgment_change (kind, subject_uuids, payload, requested_by) VALUES ('prompt_kind', subj, pl, v_actor);
    END IF;
    IF TG_OP <> 'UPDATE' OR EXISTS (SELECT 1 FROM unnest(cat_f) k WHERE (o->k) IS DISTINCT FROM (n->k)) THEN
      INSERT INTO app.judgment_change (kind, subject_uuids, payload, requested_by) VALUES ('catalog', subj, pl, v_actor);
    END IF;
  END IF;
  RETURN NULL;
END $f$;
CREATE TRIGGER prompt_catalog_change AFTER INSERT OR UPDATE OR DELETE ON app.prompt
  FOR EACH ROW EXECUTE FUNCTION app.tg_catalog_change();

ALTER FUNCTION app.tg_project_setting_change() OWNER TO hmg_owner;
ALTER FUNCTION app.tg_catalog_change() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.tg_project_setting_change(), app.tg_catalog_change() FROM PUBLIC;
-- 감사 원장의 쓰기 주체는 트리거 하나(Q3 "누락 불가", 채택 5 "이중 기록 금지"). 앱의 명시 INSERT 잔존분은 권한 오류로 드러나게 한다.
REVOKE INSERT ON app.prompt_audit_log FROM api_rw;

-- ════════════════════════════════════════════════════════════════════════════
-- P05. regions 투영(채택 6): Scope getProject 시장 설정 → ing.sync_cursor.regions(원본) → rd.dim_project.regions(1:1 투영)
--   프로젝트 로테이션 때 적재기가 갱신, 변경 시 judgment_change('scope_prompt') 경로와 같은 트랜잭션.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE ing.sync_cursor ADD COLUMN regions text[];
ALTER TABLE rd.dim_project  ADD COLUMN regions text[];

-- ════════════════════════════════════════════════════════════════════════════
-- P06. rd.cycle 투영 열
--   hidden_reason(채택 7): ing.cycle.hidden_reason 코드 투영. hidden_scope 와 짝(ing.cycle CHECK :344 와 같은 불변식)
--   Q2(제품 책임자 개정): expected_units·completed_units·completed_answers·gap_answers = ing.cycle 같은 이름 열 1:1 투영(새 합산 없음, NULL 허용)
--     K-2 가중 누락 비중·AD-4 진행률 분모에 쓴다. 제자리 UPDATE 열이므로 어떤 인덱스에도 넣지 않는다(HOT).
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE rd.cycle
  ADD COLUMN hidden_reason int2 NOT NULL DEFAULT 0 CONSTRAINT rd_cycle_hidden_reason_code CHECK (hidden_reason BETWEEN 0 AND 2),
  ADD COLUMN expected_units int,
  ADD COLUMN completed_units int,
  ADD COLUMN completed_answers int,
  ADD COLUMN gap_answers int,
  ADD CONSTRAINT rd_cycle_hidden_pair CHECK ((hidden_scope = 0) = (hidden_reason = 0)),
  ADD CONSTRAINT rd_cycle_gap_le_completed CHECK (gap_answers IS NULL OR completed_answers IS NULL OR gap_answers <= completed_answers);

-- ════════════════════════════════════════════════════════════════════════════
-- P07. 코드 주석(채택 8)
-- ════════════════════════════════════════════════════════════════════════════
COMMENT ON COLUMN rd.cycle.status IS '0 open 1 closed 2 published 3 stale (ing.cycle.status 코드 투영)';
COMMENT ON COLUMN rd.cycle.hidden_scope IS '0 없음 1 all 2 citations 3 mentions (3 은 값만 두고 운영 도구 미노출, Q18)';
COMMENT ON COLUMN rd.cycle.hidden_reason IS '0 없음 1 collection_error 2 operator (ing.cycle.hidden_reason 투영, hidden_scope 와 짝)';
COMMENT ON COLUMN rd.cycle.expected_units IS 'ing.cycle.expected_units 1:1 투영(Q2 개정 D8 예외 ③, 새 합산 없음)';
COMMENT ON COLUMN rd.cycle.completed_units IS 'ing.cycle.completed_units 1:1 투영(Q2)';
COMMENT ON COLUMN rd.cycle.completed_answers IS 'ing.cycle.completed_answers 1:1 투영(Q2)';
COMMENT ON COLUMN rd.cycle.gap_answers IS 'ing.cycle.gap_answers 1:1 투영(Q2)';
COMMENT ON COLUMN rd.answer.analysis_state IS
  '0 분석됨·언급 있음 1 분석됨·언급 0 2 분석 미도착 3 분석 실패·스킵 (G-05 (a): Scope analysis.status completed·partial = 분석됨). gap = (>= 2), std_in 은 < 2 만';
COMMENT ON COLUMN rd.job.analysis_code IS 'rd.answer.analysis_state 와 같은 코드(비완료 job 은 0)';
COMMENT ON COLUMN rd.dim_project.regions IS 'ing.sync_cursor.regions(Scope getProject 시장 설정) 1:1 투영';
COMMENT ON COLUMN ing.sync_cursor.regions IS 'Scope getProject 시장 설정 원본(프로젝트 로테이션 때 갱신)';

-- ════════════════════════════════════════════════════════════════════════════
-- P08. QA 목록 키셋 인덱스(채택 9): 현행 정렬 measured_at DESC NULLS LAST(qa-review.ts:357)와 방향 일치
-- ════════════════════════════════════════════════════════════════════════════
DROP INDEX rd.job_qa_list_idx;
CREATE INDEX job_qa_list_idx ON rd.job (surface, measured_at DESC NULLS LAST, answer_key DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- P09. 뷰(채택 10·11). 저장 없음(D8 적합). answer_key 등치 조회 전용 규약은 문서형 뷰와 같다.
-- ════════════════════════════════════════════════════════════════════════════
-- P09-a. v_answer_mention_raw: ing.mention 감성 4·유형 5 열을 끝에 추가(QA P-Q2, qa-review.ts:544-565)
CREATE OR REPLACE VIEW rd.v_answer_mention_raw WITH (security_barrier) AS
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, mt.ord, mt.entity_id, e.entity_key, e.registry_role, mt.display_name,
         mt.entity_type, mt.mention_count, mt.avg_position, mt.brand_rollup_entity_id, mt.surfaces,
         mt.sentiment_positive, mt.sentiment_neutral, mt.sentiment_negative, mt.sentiment_mixed,
         mt.type_mention, mt.type_recommendation, mt.type_comparison, mt.type_definition, mt.type_final_choice
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id
    JOIN ing.mention mt ON mt.run_month = m.run_month AND mt.job_id = m.job_id LEFT JOIN rd.dim_entity e ON e.entity_id = mt.entity_id;

-- P09-b. v_answer_registry: 앵커 고정·드롭의 source_measured_at 2열(QA P-Q4, qa-review.ts:633-646)
CREATE OR REPLACE VIEW rd.v_answer_registry WITH (security_barrier) AS
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, p.anchor AS pin_anchor, p.reason AS pin_reason, d.reason AS drop_reason, d.dropped_at,
         p.source_measured_at AS pin_source_measured_at, d.source_measured_at AS drop_source_measured_at
    FROM rd.job j LEFT JOIN ing.answer_anchor_pin p ON p.job_id = j.job_id LEFT JOIN ing.answer_drop d ON d.job_id = j.job_id;

-- P09-c. v_answer_citation_raw(새, QA P-Q3): 인용 원소 원본(ref_index·저장 분류 포함). rd.job 기준이라 드롭·비완료 job 포함(G-24).
--        목록 citation_count 는 이 뷰의 answer_key = ANY(페이지) 등치 count(현행 행 count, qa-review.ts:345-346 과 같은 값)
CREATE VIEW rd.v_answer_citation_raw WITH (security_barrier) AS
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, c.ord, c.url, c.title, c.ref_index, c.scope_category, c.host, c.domain_label
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id
    JOIN ing.citation c ON c.run_month = m.run_month AND c.job_id = m.job_id;

-- P09-d. 운영 조회 뷰(ingest 제안 1, GET /v1/admin/ingest/*). 원장 행 발췌와 조회 시 count 만(저장 없음).
--        ing.cycle 카운터는 여기 넣지 않았다: Q2 로 rd.cycle 에 같은 값이 투영되므로 운영 화면은 rd.cycle 을 읽는다.
CREATE VIEW rd.v_ingest_status WITH (security_barrier) AS
  SELECT c.scope_project_id, c.surface, c.last_attempt_at, c.last_success_at, c.last_error, c.prompts_updated_to, c.regions,
         r.open_runs, r.blocked_runs
    FROM ing.sync_cursor c
    CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE x.unresolved_jobs > 0 OR x.analysis_pending > 0) AS open_runs,
                               count(*) FILTER (WHERE x.sync_state = 'blocked') AS blocked_runs
                          FROM ing.run x WHERE x.scope_project_id = c.scope_project_id) r;
CREATE VIEW rd.v_ingest_backlog WITH (security_barrier) AS            -- R12 경보 대상: 재확인 창이 닫혔는데 미해소, 또는 blocked
  SELECT r.run_id, r.scope_project_id, c.surface, r.sync_state, r.status, r.total_jobs, r.unresolved_jobs, r.analysis_pending,
         r.recheck_until, r.analysis_recheck_until, r.attempts, r.next_attempt_at, r.last_error, r.started_at
    FROM ing.run r LEFT JOIN ing.sync_cursor c ON c.scope_project_id = r.scope_project_id
   WHERE r.sync_state = 'blocked'
      OR (r.unresolved_jobs  > 0 AND r.recheck_until          <= now())
      OR (r.analysis_pending > 0 AND r.analysis_recheck_until <= now());
CREATE VIEW rd.v_ingest_load WITH (security_barrier) AS               -- 키셋 load_id DESC
  SELECT l.load_id, l.kind, l.run_id, l.status, l.rule_ver, l.jobs_fetched, l.jobs_changed, l.jobs_removed, l.rd_answers_upserted,
         l.rd_gate_propagated, l.rd_rep_flips, l.rd_children_rows, l.started_at, l.finished_at, l.error
    FROM ing.load l;

-- 소유자 loader_ro(ing SELECT 보유), 읽기 롤 SELECT. CREATE OR REPLACE 한 두 뷰는 소유자·권한이 유지되지만 명시적으로 다시 맞춘다.
DO $$ DECLARE v text; BEGIN
  FOREACH v IN ARRAY ARRAY['rd.v_answer_mention_raw','rd.v_answer_registry','rd.v_answer_citation_raw',
                           'rd.v_ingest_status','rd.v_ingest_backlog','rd.v_ingest_load'] LOOP
    EXECUTE format('ALTER VIEW %s OWNER TO loader_ro', v);
    EXECUTE format('GRANT SELECT ON %s TO api_ro, admin_long', v);
  END LOOP; END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- P10. 스테이지 인덱스(채택 12, 적재 내부 전용)
-- ════════════════════════════════════════════════════════════════════════════
CREATE INDEX stage_mention_idx    ON ing.stage_mention    (load_id, job_id);
CREATE INDEX stage_occurrence_idx ON ing.stage_occurrence (load_id, job_id);
CREATE INDEX stage_stance_idx     ON ing.stage_stance     (load_id, job_id);
CREATE INDEX stage_citation_idx   ON ing.stage_citation   (load_id, job_id);

-- ════════════════════════════════════════════════════════════════════════════
-- P11. rd.answer 불변식(채택 13): 타깃 URL 인용이면 자사 URL 인용이다(own_url_cited = owned_base_hit OR target_hit, scope-aggregates.ts:9036-9037)
--   파티션 부모에 선언 → 하위 파티션 부모·이후 ensure_leaf 가 만드는 leaf 에 상속
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE rd.answer ADD CONSTRAINT answer_tgt_implies_own_url CHECK (NOT tgt_cited OR own_url_cited);

-- ════════════════════════════════════════════════════════════════════════════
-- P12. 인덱스(채택 14·15)
-- ════════════════════════════════════════════════════════════════════════════
CREATE INDEX dim_source_domain_idx        ON rd.dim_source (domain);                          -- domain 은 재구축으로만 바뀜
CREATE INDEX member_audit_project_idx     ON app.member_audit_log (project_id, created_at DESC);
CREATE INDEX scope_outbox_aggregate_idx   ON app.scope_outbox (aggregate, aggregate_id, created_at DESC);
CREATE INDEX permission_audit_target_idx  ON app.permission_audit_log (target_user_id, created_at DESC);
CREATE INDEX prompt_candidate_project_idx ON app.prompt_candidate (project_id, created_at DESC);
CREATE INDEX ctx_drive_requirement_idx    ON ext.ctx_drive (snapshot_id, requirement_id);

-- ════════════════════════════════════════════════════════════════════════════
-- P14. 열 추가(채택 17·18)
-- ════════════════════════════════════════════════════════════════════════════
-- conv_basis: GA4 적재자가 app.ga4_tracked_event 존재 여부로 판정. 변경은 'ga4_tracked_event' kind 로 전 기간 재투영
ALTER TABLE rd.ga4_dim_property ADD COLUMN conv_basis int2 NOT NULL CONSTRAINT ga4_dim_property_conv_basis_code CHECK (conv_basis IN (1, 2));
COMMENT ON COLUMN rd.ga4_dim_property.conv_basis IS '1 key events 폴백 2 추적 이벤트 event_count';
-- 생성 프롬프트 속성(현행 components/social-scraping/types.ts:187-204 GeneratedPrompt) + 동시 생성 중복 방지선 seed_key
--   seed_key = 현행 시드 id(l1-<ctx>, l2-<cond>, l3-<a>:<b>, l3-<ctx>-<cond>, selection-seeds.ts:14-17)를 조합쌍 정렬로 정규화한 값.
--   쓰기 주체 api_rw. seed_key 반영 전 IN-2 생성 엔드포인트 비공개.
ALTER TABLE app.ctx_generated_prompt
  ADD COLUMN layer text CONSTRAINT ctx_generated_prompt_layer_check CHECK (layer IN ('L1-context','L2-condition','L3-intersection')),
  ADD COLUMN funnel_stage text,
  ADD COLUMN priority int2,
  ADD COLUMN origin text CONSTRAINT ctx_generated_prompt_origin_check CHECK (origin IS NULL OR origin = 'composed'),
  ADD COLUMN seed_key text NOT NULL,
  ADD CONSTRAINT ctx_generated_prompt_seed_uq UNIQUE (project_id, seed_key);

-- ════════════════════════════════════════════════════════════════════════════
-- P15. Q4 접근 감사 append-only
--   기록 대상 = data_access·download·scope_call(api_read 는 기록 안 함, Q4). 쓰기 = api_rw 풀이 응답 후 묶어서 INSERT.
--   행 트리거로 둔다: 파티션 부모의 행 트리거는 기존·이후 leaf 에 복제되므로 leaf 를 직접 UPDATE·DELETE 해도 막힌다
--   (문장 트리거는 복제되지 않는다). 보존 기간 정리는 DELETE 가 아니라 leaf DETACH·DROP(소유자 DDL)로 한다.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TRIGGER access_audit_ao BEFORE UPDATE OR DELETE ON app.access_audit_log
  FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();
REVOKE UPDATE, DELETE ON app.access_audit_log FROM api_rw;           -- api_rw 는 INSERT·SELECT 만

-- ════════════════════════════════════════════════════════════════════════════
-- P16. Q17 검수 게이트 전용 롤 qa_gate (NOLOGIN 정의, 운영에서는 로그인 롤이 멤버십으로 상속)
--   계정 없는 외부 검수자(HMAC 세션 쿠키 게이트)의 QA 경로 전용. role 스코프 체계 밖이므로 app 의 다른 표·ing 는 권한 없음.
--   읽기: rd.job·rd.dim_*·rd.acr_*·rd.answer·rd.answer_brand·rd.citation·rd.v_*   쓰기: app.qa_* 4표
--   (statement_timeout 등 롤 설정은 로그인 롤에 둔다: 롤 설정은 멤버십으로 상속되지 않는다)
-- ════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_gate') THEN CREATE ROLE qa_gate NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA rd, app TO qa_gate;
GRANT SELECT ON rd.job, rd.answer, rd.answer_brand, rd.citation TO qa_gate;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'rd' AND NOT c.relispartition
              AND ((c.relkind IN ('r','p') AND (c.relname LIKE 'dim\_%' OR c.relname LIKE 'acr\_%'))
                   OR (c.relkind = 'v' AND c.relname LIKE 'v\_%')) LOOP
    EXECUTE format('GRANT SELECT ON %s TO qa_gate', r.obj);
  END LOOP; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.qa_review_session, app.qa_answer_review, app.qa_review_note, app.qa_answer_lock TO qa_gate;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.2 보완 패치 (PostgreSQL 17, 2026-09-28) · G-25 답변당 인용 수 열
-- 적용 순서: DB-v2.1.sql(= DB-v2.sql + DB-v2.1-patch.sql) 적용 뒤 이 파일 1회(트랜잭션 1개, ON_ERROR_STOP 전제).
--   합본 DB-v2.2.sql = DB-v2.1.sql + 이 파일(빈 DB 와 패치 DB 의 열 순서가 같다).
-- 근거: DESIGN-CONTRACT §3 G-25(제품 책임자 2026-09-28, stg 동시 5명 웹사이트 1년 summary·trend p95 1.1~1.5초)
--   → rd.answer 에 답변당 인용 수 열(D8 예외 ② 확장: G-03 당사 열과 같은 답변 1:1 판정 열). summary·trend·geo 의
--   인용 계열(M05 인용 점유율, C-1 타겟 인용 수)은 rd.citation 을 스캔하지 않는다.
--
-- 열 정의(모두 int2 NOT NULL DEFAULT 0, "호스트 있는 인용" = rd.citation.source_key <> 0 인 자식 행만 센다: G-21 (a)·M05 분모와 같은 모수)
--   cit_n        호스트 있는 인용 수(M05 분모). has_cit = (cit_n > 0)
--   cit_own_h/k/g 자사 인용(글로벌 판정식 owner_key = ANY(허용 배열))의 브랜드별 수: owner_key 의 app.owned_base.brand_code 가
--                Hyundai(비트 1)·Kia(2)·Genesis(4). 관점 비트 합(admin 전사 {1,2,4})은 열 합, 한 owner_key 는 한 브랜드라 서로소.
--   cit_own_hc/kc/gc 위 중 소유 베이스 국가(app.owned_base.geo_code) = 답변 국가(rd.dim_country.code, 글로벌 = 답변 region).
--                국가 필터로 허용 배열이 좁혀진 요청(QUERY-FIXES 공통 기호: geo_code ∈ 선택 국가, 좁힌 결과가 비면 안 좁힘)에서 쓴다.
--                선택 국가 1개면 답변 국가 = 선택 국가라 이 열이 정확히 그 값이다.
--   cit_own_x    HMG 3사 자사 인용 중 소유 베이스 국가가 있고 답변 국가와 다른 것(교차 국가). 선택 국가가 2개 이상이면
--                cit_own_x = 0 인 답변은 *c 열로, cit_own_x > 0 인 답변만 rd.citation 을 PK 로 조회해 정확히 센다
--                (stg 실측 2026-09-28: 글로벌 자사 인용 134,443 중 교차 46,850, 교차 있는 답변 18,303 / 265,970 = 6.9%).
--   cit_loc      loc_owned 인 인용 수(프로젝트 자사 = project 표면 M05 분자)
--   cit_tgt      tgt_hit 인 인용 수(C-1 target_citations). tgt_cited = (cit_tgt > 0)
--   cit_loc_tgt  (loc_owned OR tgt_hit) 인 인용 수(웹사이트 자사 = website 표면 M05 분자). own_url_cited = (cit_loc_tgt > 0)
--   표면과 무관하게 같은 식으로 채운다(글로벌 행의 loc·tgt 는 적재 시 false 라 0, 웹·프로젝트 행의 owner 열은 참고값).
--   언어 필터로 허용 배열을 좁히는 경우는 열로 두지 않았다: 글로벌 표면의 lang[] 은 K-1·T-1·GEO-1 에서 지원 축이 아니다(website 전용),
--   C-1 처럼 인용 원소를 원래 스캔하는 기능은 core.measure.allowed_owner_keys 로 언어까지 좁힌다.
--
-- 불변식
--   ① 자식 합 = 답변 열: rd.assert_answer_cit_counts(answer_key[]) 가 rd.citation 을 다시 세어 단언(위반 시 예외).
--      적재기는 인용 자식을 쓰거나 owned_base 판정을 반영한 같은 트랜잭션에서 호출한다. seed-40 은 5만 청크마다 호출한다.
--      rd.propagate_answer_gates 에는 넣지 않았다: 게이트 전파는 인용 수를 바꾸지 않고, app.owned_base 가 바뀐 뒤 재판정 전
--      (judgment_change 'owned_base' 대기) 구간에 무관한 게이트 전파가 실패하면 안 되기 때문.
--   ② 행 단위 CHECK(아래 answer_cit_bounds·answer_cit_flags): 열 사이 부등식과 기존 불리언(has_cit·tgt_cited·own_url_cited)과의 동치.
-- 규약
--   D8: 사전 집계 표 없음. 새 열은 답변 1:1 판정 열(자식 원소 수)이며 G-03 당사 열과 같은 D8 예외 ②.
--   HOT: 새 열은 제자리 재판정 UPDATE 대상이다(owned_base 판정 변경, 인용 leaf 재구축 뒤 재계산). 어떤 btree 에도 넣지 않는다.
--   owned_base 변경(judgment_change 'owned_base'): 적재기가 영향 owner_key 를 가진 답변의 cit_own_* 를 재계산한다.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- P21. rd.answer 인용 수 열 11개(파티션 부모 선언 → 모든 leaf 전파, 기존 행은 DEFAULT 0 으로 메타데이터만 바뀜)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE rd.answer
  ADD COLUMN cit_n       int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_h   int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_k   int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_g   int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_hc  int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_kc  int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_gc  int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_own_x   int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_loc     int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_tgt     int2 NOT NULL DEFAULT 0,
  ADD COLUMN cit_loc_tgt int2 NOT NULL DEFAULT 0;

COMMENT ON COLUMN rd.answer.cit_n IS '호스트 있는 인용 수(rd.citation source_key <> 0). M05 분모. has_cit = (cit_n > 0). G-25';
COMMENT ON COLUMN rd.answer.cit_own_h IS '글로벌 자사 인용 수: owner_key 브랜드 Hyundai(비트 1). G-25';
COMMENT ON COLUMN rd.answer.cit_own_k IS '글로벌 자사 인용 수: owner_key 브랜드 Kia(비트 2). G-25';
COMMENT ON COLUMN rd.answer.cit_own_g IS '글로벌 자사 인용 수: owner_key 브랜드 Genesis(비트 4). G-25';
COMMENT ON COLUMN rd.answer.cit_own_hc IS 'cit_own_h 중 소유 베이스 geo_code = 답변 국가 코드(국가 필터로 좁힌 허용 배열). G-25';
COMMENT ON COLUMN rd.answer.cit_own_kc IS 'cit_own_k 중 소유 베이스 geo_code = 답변 국가 코드. G-25';
COMMENT ON COLUMN rd.answer.cit_own_gc IS 'cit_own_g 중 소유 베이스 geo_code = 답변 국가 코드. G-25';
COMMENT ON COLUMN rd.answer.cit_own_x IS '3사 자사 인용 중 소유 베이스 geo_code 가 있고 답변 국가와 다른 수(다국가 필터 시 rd.citation 조회 대상 표식). G-25';
COMMENT ON COLUMN rd.answer.cit_loc IS 'loc_owned 인용 수(프로젝트 자사). G-25';
COMMENT ON COLUMN rd.answer.cit_tgt IS 'tgt_hit 인용 수(타겟 인용). tgt_cited = (cit_tgt > 0). G-25';
COMMENT ON COLUMN rd.answer.cit_loc_tgt IS '(loc_owned OR tgt_hit) 인용 수(웹사이트 자사). own_url_cited = (cit_loc_tgt > 0). G-25';

-- ════════════════════════════════════════════════════════════════════════════
-- P22. 판정 함수: 답변 키 집합의 인용 수를 rd.citation 에서 센다(적재기·단언·백필 공용 정본 식)
--   위치는 rd.job(answer_key PK)에서 파티션 좌표를 얻어 등치 조인(propagate_answer_gates 와 같은 이유: answer_key = ANY 로
--   파티션 표를 직접 찾으면 모든 leaf PK 를 훑는다). 호스트 없는 인용만 있는 답변은 행이 없다(= 전 열 0).
--   p_keys 가 NULL 이면 전체(백필·전수 감사 전용).
-- ════════════════════════════════════════════════════════════════════════════
CREATE FUNCTION rd.answer_cit_counts(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4,
               cit_n int, cit_own_h int, cit_own_k int, cit_own_g int, cit_own_hc int, cit_own_kc int, cit_own_gc int,
               cit_own_x int, cit_loc int, cit_tgt int, cit_loc_tgt int)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $f$
BEGIN
  IF p_keys IS NULL THEN
    RETURN QUERY
    SELECT c.surface, c.round_date, c.answer_key,
           count(*)::int,
           count(*) FILTER (WHERE ob.bit = 1)::int, count(*) FILTER (WHERE ob.bit = 2)::int, count(*) FILTER (WHERE ob.bit = 4)::int,
           count(*) FILTER (WHERE ob.bit = 1 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 2 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 4 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit IN (1, 2, 4) AND ob.geo IS NOT NULL AND ob.geo IS DISTINCT FROM upper(g.code))::int,
           count(*) FILTER (WHERE c.loc_owned)::int, count(*) FILTER (WHERE c.tgt_hit)::int,
           count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit)::int
      FROM rd.citation c
      LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
                   FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
      LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
     WHERE c.source_key <> 0
     GROUP BY c.surface, c.round_date, c.answer_key;
  ELSE
    RETURN QUERY
    SELECT c.surface, c.round_date, c.answer_key,
           count(*)::int,
           count(*) FILTER (WHERE ob.bit = 1)::int, count(*) FILTER (WHERE ob.bit = 2)::int, count(*) FILTER (WHERE ob.bit = 4)::int,
           count(*) FILTER (WHERE ob.bit = 1 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 2 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 4 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit IN (1, 2, 4) AND ob.geo IS NOT NULL AND ob.geo IS DISTINCT FROM upper(g.code))::int,
           count(*) FILTER (WHERE c.loc_owned)::int, count(*) FILTER (WHERE c.tgt_hit)::int,
           count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit)::int
      FROM rd.job j
      JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
      LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
                   FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
      LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
     WHERE j.answer_key = ANY (p_keys) AND j.served AND c.source_key <> 0
     GROUP BY c.surface, c.round_date, c.answer_key;
  END IF;
END $f$;

-- 단언: 주어진 답변 키(served)의 rd.answer 인용 수 열 = rd.answer_cit_counts 재계산. 위반 시 예외(적재 트랜잭션 롤백).
--   p_keys NULL = 전수(야간 감사·백필 확인). 반환 = 검사한 답변 수.
CREATE FUNCTION rd.assert_answer_cit_counts(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE v int; n int;
BEGIN
  IF p_keys IS NULL THEN
    SELECT count(*), count(*) FILTER (WHERE
             (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
              a.cit_loc, a.cit_tgt, a.cit_loc_tgt)
             IS DISTINCT FROM
             (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_own_h, 0)::int2, coalesce(x.cit_own_k, 0)::int2, coalesce(x.cit_own_g, 0)::int2,
              coalesce(x.cit_own_hc, 0)::int2, coalesce(x.cit_own_kc, 0)::int2, coalesce(x.cit_own_gc, 0)::int2, coalesce(x.cit_own_x, 0)::int2,
              coalesce(x.cit_loc, 0)::int2, coalesce(x.cit_tgt, 0)::int2, coalesce(x.cit_loc_tgt, 0)::int2))
      INTO n, v
      FROM rd.answer a
      LEFT JOIN rd.answer_cit_counts(NULL) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key;
  ELSE
    SELECT count(*), count(*) FILTER (WHERE
             (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
              a.cit_loc, a.cit_tgt, a.cit_loc_tgt)
             IS DISTINCT FROM
             (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_own_h, 0)::int2, coalesce(x.cit_own_k, 0)::int2, coalesce(x.cit_own_g, 0)::int2,
              coalesce(x.cit_own_hc, 0)::int2, coalesce(x.cit_own_kc, 0)::int2, coalesce(x.cit_own_gc, 0)::int2, coalesce(x.cit_own_x, 0)::int2,
              coalesce(x.cit_loc, 0)::int2, coalesce(x.cit_tgt, 0)::int2, coalesce(x.cit_loc_tgt, 0)::int2))
      INTO n, v
      FROM rd.job j
      JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
      LEFT JOIN rd.answer_cit_counts(p_keys) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key
     WHERE j.answer_key = ANY (p_keys) AND j.served;
  END IF;
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.answer 인용 수 열 ≠ rd.citation 자식 합: % 답변(G-25 불변식)', v;
  END IF;
  RETURN n;
END $f$;

ALTER FUNCTION rd.answer_cit_counts(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_cit_counts(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.answer_cit_counts(int4[]), rd.assert_answer_cit_counts(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.answer_cit_counts(int4[]), rd.assert_answer_cit_counts(int4[]) TO loader, migrator;

-- ════════════════════════════════════════════════════════════════════════════
-- P23. 기존 행 백필(빈 DB 에서는 0행). 값이 바뀌는 행만 UPDATE(호스트 인용 없는 답변은 DEFAULT 0 그대로).
-- ════════════════════════════════════════════════════════════════════════════
UPDATE rd.answer a
   SET cit_n = x.cit_n, cit_own_h = x.cit_own_h, cit_own_k = x.cit_own_k, cit_own_g = x.cit_own_g,
       cit_own_hc = x.cit_own_hc, cit_own_kc = x.cit_own_kc, cit_own_gc = x.cit_own_gc, cit_own_x = x.cit_own_x,
       cit_loc = x.cit_loc, cit_tgt = x.cit_tgt, cit_loc_tgt = x.cit_loc_tgt
  FROM rd.answer_cit_counts(NULL) x
 WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
   AND (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x, a.cit_loc, a.cit_tgt, a.cit_loc_tgt)
       IS DISTINCT FROM
       (x.cit_n::int2, x.cit_own_h::int2, x.cit_own_k::int2, x.cit_own_g::int2, x.cit_own_hc::int2, x.cit_own_kc::int2, x.cit_own_gc::int2,
        x.cit_own_x::int2, x.cit_loc::int2, x.cit_tgt::int2, x.cit_loc_tgt::int2);

-- ════════════════════════════════════════════════════════════════════════════
-- P24. 행 단위 불변식(파티션 부모 선언 → leaf 상속·이후 ensure_leaf leaf 에도 적용). 백필 뒤라 기존 행 검증이 통과해야 한다.
--   answer_cit_bounds: 브랜드 합 ≤ 전체, 국가 일치 ≤ 브랜드, 교차 ≤ 브랜드 합 − 국가 일치 합, loc∪tgt 는 loc·tgt 사이
--   answer_cit_flags : 기존 답변 불리언과 동치(has_cit·tgt_cited·own_url_cited 는 같은 호스트 있는 인용 모수에서 판정됐다)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE rd.answer ADD CONSTRAINT answer_cit_bounds CHECK (
      cit_own_h >= 0 AND cit_own_k >= 0 AND cit_own_g >= 0 AND cit_own_x >= 0 AND cit_loc >= 0 AND cit_tgt >= 0
  AND cit_own_h + cit_own_k + cit_own_g <= cit_n
  AND cit_own_hc BETWEEN 0 AND cit_own_h AND cit_own_kc BETWEEN 0 AND cit_own_k AND cit_own_gc BETWEEN 0 AND cit_own_g
  AND cit_own_x <= (cit_own_h + cit_own_k + cit_own_g) - (cit_own_hc + cit_own_kc + cit_own_gc)
  AND cit_loc_tgt <= cit_n AND cit_loc_tgt >= greatest(cit_loc, cit_tgt) AND cit_loc_tgt <= cit_loc + cit_tgt);
ALTER TABLE rd.answer ADD CONSTRAINT answer_cit_flags CHECK (
      (cit_n > 0) = has_cit AND (cit_tgt > 0) = tgt_cited AND (cit_loc_tgt > 0) = own_url_cited);

-- 백필 결과 전수 단언(빈 DB 에서는 0건 검사)
DO $a$ DECLARE n int; BEGIN
  n := rd.assert_answer_cit_counts(NULL);
  RAISE NOTICE 'G-25 인용 수 열 단언 통과: 답변 %', n;
END $a$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.3 보완 패치 (PostgreSQL 17, 2026-09-28) · core 독립 검증 지적 반영
-- 적용 순서: DB-v2.2.sql(= DB-v2.1.sql + DB-v2.2-patch.sql) 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.3.sql = DB-v2.2.sql + 이 파일.
--
-- 반영 목록
--   P31 app.user_account
--       a) CHECK ua_admin_scope_all: admin 계정은 scope_all 강제(DECISIONS-API Q16, 추가 결정 2026-09-28)
--       b) BEFORE 트리거 tg_user_account_scope: 스코프 값 참조 검증(scope_brands ⊆ app.brand, scope_regions ⊆ app.rhq_region,
--          scope_countries ⊆ app.rhq_region_country 국가). 위반은 SQLSTATE 23503(foreign_key_violation)
--          (DB-v2.sql :112 주석 "트리거: 스코프 값 참조 검증" 의 실제 구현. 검증 B1: 풀리지 않는 권역 id 가 저장되지 않게 한다)
--       c) AFTER 트리거 tg_user_account_audit: app.permission_audit_log 한 행(행위자 = app.actor(), 미설정이면 쓰기 전체 거부)
--          (같은 :112 주석 "permission_audit_log(행위자 필수)" 의 실제 구현. 감사 원장의 쓰기 주체는 트리거 하나 →
--           api_rw 의 app.permission_audit_log INSERT 회수: DB-v2.1 P04 의 prompt_audit_log 와 같은 원칙, 이중 기록 금지)
--   P32 rd.assert_answer_cit_counts(int4[], bool) 엄격 모드: p_strict = true 면 서빙 답변이 아닌(미지·비서빙) 키가 섞일 때 예외.
--       1인자 판(int4[])은 비엄격으로 위임한다(DB-v2.2 호출부 호환).
--   P33 앱 로그인 롤 hgh_app(LOGIN NOINHERIT): 풀 롤 api_ro·api_rw·admin_long·qa_gate 멤버십(INHERIT FALSE, SET TRUE).
--       롤 권한은 SET ROLE(core.db 가 트랜잭션마다 set_config('role', <풀 롤>, true)) 뒤에만 생긴다. 비밀번호는 DDL 에 두지 않는다:
--       배포 단계가 Secrets Manager 값으로 ALTER ROLE hgh_app PASSWORD 를 한다. 적재기 로그인 롤은 적재 모듈 배포 때 같은 방식으로 둔다.
--   P34 주석 정정(DB-v2.sql 은 수정하지 않는 원칙이라 카탈로그 COMMENT 로 둔다)
--       DB-v2.sql :838 "api_rw: app 쓰기(행위자 필수)" 의 실제 범위: DB 가 행위자를 강제하는 표는 트리거가 있는
--       app.project(4열)·app.prompt·app.user_account 셋이다. 그 밖의 app 쓰기는 core.db.Database.write 가 항상 행위자 GUC 를 심는
--       앱 규약으로 보장한다. 판단 근거: app 전 표에 행위자 문장 트리거를 걸면 계정 없는 검수 게이트(qa_gate, Q17)의 app.qa_* 쓰기와
--       접근 감사 배치(app.access_audit_log, 사용자 행위자가 아닌 행 값으로 기록)가 막힌다. 감사 행을 남기는 표에만 DB 강제를 둔다.
-- 규약: D8 무관(사전 집계 없음). 새 btree 없음.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- P31. app.user_account 스코프 제약·트리거
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE app.user_account ADD CONSTRAINT ua_admin_scope_all CHECK (role <> 'admin' OR scope_all);

CREATE FUNCTION app.tg_user_account_scope() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE bad text[];
BEGIN
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_brands) x WHERE NOT EXISTS (SELECT 1 FROM app.brand b WHERE b.brand_code = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_brands 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_regions) x WHERE NOT EXISTS (SELECT 1 FROM app.rhq_region r WHERE r.region_id = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_regions 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  bad := ARRAY(SELECT x FROM unnest(NEW.scope_countries) x
                WHERE NOT EXISTS (SELECT 1 FROM app.rhq_region_country c WHERE c.country_code = x));
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'app.user_account.scope_countries 참조 없음: %', bad USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER user_account_scope_check
  BEFORE INSERT OR UPDATE OF scope_brands, scope_regions, scope_countries ON app.user_account
  FOR EACH ROW EXECUTE FUNCTION app.tg_user_account_scope();

-- 권한 감사: 생성·삭제는 항상, 수정은 권한 관련 열이 바뀔 때만(표시명·타임스탬프만 바뀌면 행 없음)
CREATE FUNCTION app.tg_user_account_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE v_actor uuid := app.actor();   -- 행위자 필수: 미설정이면 계정 쓰기 전체 거부
        keep text[] := ARRAY['user_id','email','role','operator','scope_all','scope_brands','scope_regions','scope_countries',
                             'menu_groups','is_qa_reviewer','status'];
        o jsonb; n jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    o := (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(keep) k);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    n := (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(keep) k);
  END IF;
  IF TG_OP = 'UPDATE' AND o IS NOT DISTINCT FROM n THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.permission_audit_log (target_user_id, actor_id, change_type, before, after)
  VALUES (coalesce(NEW.user_id, OLD.user_id), v_actor,
          CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END, o, n);
  RETURN NULL;
END $f$;
CREATE TRIGGER user_account_audit AFTER INSERT OR UPDATE OR DELETE ON app.user_account
  FOR EACH ROW EXECUTE FUNCTION app.tg_user_account_audit();

ALTER FUNCTION app.tg_user_account_scope() OWNER TO hmg_owner;
ALTER FUNCTION app.tg_user_account_audit() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.tg_user_account_scope(), app.tg_user_account_audit() FROM PUBLIC;
REVOKE INSERT ON app.permission_audit_log FROM api_rw;                 -- 쓰기 주체 = 트리거 하나(이중 기록 금지)
COMMENT ON TABLE app.user_account IS
  '계정·권한. 트리거: user_account_scope_check(스코프 값 참조 검증, 23503) · user_account_audit(permission_audit_log, 행위자 app.actor() 필수). '
  'CHECK ua_admin_scope_all(admin = scope_all, Q16)';

-- ════════════════════════════════════════════════════════════════════════════
-- P32. 인용 수 단언 엄격 모드
-- ════════════════════════════════════════════════════════════════════════════
CREATE FUNCTION rd.assert_answer_cit_counts(p_keys int4[], p_strict bool) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE unknown int; n int;
BEGIN
  IF p_strict AND p_keys IS NOT NULL THEN
    SELECT count(*) INTO unknown
      FROM (SELECT DISTINCT k FROM unnest(p_keys) k) x
     WHERE NOT EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = x.k AND j.served);
    IF unknown > 0 THEN
      RAISE EXCEPTION 'rd.assert_answer_cit_counts: 서빙 답변이 아닌 키 % 개(미지·비완료·드롭)', unknown;
    END IF;
  END IF;
  n := rd._assert_answer_cit_counts(p_keys);
  RETURN n;
END $f$;
-- 기존 1인자 본문을 내부 이름으로 옮기고, 1인자 공개 판은 비엄격 위임으로 바꾼다(호출부·권한 유지)
ALTER FUNCTION rd.assert_answer_cit_counts(int4[]) RENAME TO _assert_answer_cit_counts;
CREATE FUNCTION rd.assert_answer_cit_counts(p_keys int4[]) RETURNS int
LANGUAGE sql SET search_path = pg_catalog AS $f$ SELECT rd.assert_answer_cit_counts(p_keys, false) $f$;
ALTER FUNCTION rd.assert_answer_cit_counts(int4[], bool) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_cit_counts(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.assert_answer_cit_counts(int4[], bool), rd.assert_answer_cit_counts(int4[]),
  rd._assert_answer_cit_counts(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.assert_answer_cit_counts(int4[], bool), rd.assert_answer_cit_counts(int4[]),
  rd._assert_answer_cit_counts(int4[]) TO loader, migrator;

-- ════════════════════════════════════════════════════════════════════════════
-- P33. 앱 로그인 롤(비밀번호 없음: 배포 단계에서 Secrets Manager 값으로 설정)
-- ════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hgh_app') THEN
    CREATE ROLE hgh_app LOGIN NOINHERIT CONNECTION LIMIT 200;
  END IF;
END $$;
GRANT api_ro, api_rw, admin_long, qa_gate TO hgh_app WITH INHERIT FALSE, SET TRUE;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO hgh_app', current_database()); END $$;
COMMENT ON ROLE hgh_app IS 'FastAPI 앱 로그인 롤(NOINHERIT). 권한은 트랜잭션마다 set_config(role) 로 풀 롤 전환 뒤에만. 비밀번호는 Secrets Manager';

-- ════════════════════════════════════════════════════════════════════════════
-- P34. 주석 정정
-- ════════════════════════════════════════════════════════════════════════════
COMMENT ON ROLE api_rw IS 'app 쓰기. DB 가 행위자(app.actor)를 강제하는 표 = app.project(4열 트리거)·app.prompt·app.user_account. '
  '그 밖은 core.db.Database.write 가 행위자 GUC 를 항상 심는 앱 규약(검수 게이트·접근 감사 배치는 사용자 행위자 없음)';

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.4 보완 패치 (PostgreSQL 17, 2026-09-28) · core 재검증 N3 반영
-- 적용 순서: DB-v2.3.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.4.sql = DB-v2.3.sql + 이 파일.
--
-- P41 권역 참조 보호: 계정(app.user_account)이 참조하는 권역·국가가 사라지거나 바뀌면 그 계정의 데이터 스코프가 조용히 넓어지거나
--     (권역 전개가 비면 core 는 거부하지만) 프로젝트 가시성 규칙이 빠진다. v2.3 의 계정 쪽 참조 검증(쓰기 시점)과 짝으로,
--     참조되는 쪽 표의 변경을 막는다.
--   app.rhq_region         DELETE, UPDATE OF region_id·brand_code : scope_regions 가 그 region_id 를 가진 계정이 있으면 거부(23503)
--   app.rhq_region_country DELETE, UPDATE OF region_id·country_code:
--                           ① scope_regions 가 그 region_id 를 가진 계정이 있으면 거부(권역 전개 결과가 바뀐다)
--                           ② 그 국가가 마지막 행이고 scope_countries 가 그 국가를 가진 계정이 있으면 거부(국가 참조가 끊긴다)
--   두 표 TRUNCATE          : 권역·국가 스코프를 가진 계정이 하나라도 있으면 거부(행 트리거가 TRUNCATE 에는 돌지 않으므로 문장 트리거)
--   label 등 그 밖의 열 UPDATE 는 막지 않는다. 시드(seed-10·fixture-00)는 TRUNCATE 재적재 대신 UPSERT + 사라진 행만 DELETE 로 바꿨다.
-- ============================================================================
BEGIN;

CREATE FUNCTION app.tg_rhq_region_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM app.user_account u WHERE cardinality(u.scope_regions) > 0 OR cardinality(u.scope_countries) > 0) THEN
      RAISE EXCEPTION '%.% TRUNCATE 거부: 권역·국가 스코프를 가진 계정이 있다(UPSERT 로 재적재)', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'rhq_region' THEN
    IF (TG_OP = 'DELETE' OR NEW.region_id IS DISTINCT FROM OLD.region_id OR NEW.brand_code IS DISTINCT FROM OLD.brand_code)
       AND EXISTS (SELECT 1 FROM app.user_account u WHERE OLD.region_id = ANY (u.scope_regions)) THEN
      RAISE EXCEPTION 'app.rhq_region % 변경 거부: 이 권역을 스코프로 가진 계정이 있다', OLD.region_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSE
    IF TG_OP = 'DELETE' OR (NEW.region_id, NEW.country_code) IS DISTINCT FROM (OLD.region_id, OLD.country_code) THEN
      IF EXISTS (SELECT 1 FROM app.user_account u WHERE OLD.region_id = ANY (u.scope_regions)) THEN
        RAISE EXCEPTION 'app.rhq_region_country %/% 변경 거부: 이 권역을 스코프로 가진 계정이 있다', OLD.region_id, OLD.country_code
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM app.user_account u WHERE OLD.country_code = ANY (u.scope_countries))
         AND NOT EXISTS (SELECT 1 FROM app.rhq_region_country c
                          WHERE c.country_code = OLD.country_code AND (c.region_id, c.country_code) <> (OLD.region_id, OLD.country_code))
         AND (TG_OP = 'DELETE' OR NEW.country_code IS DISTINCT FROM OLD.country_code) THEN
        RAISE EXCEPTION 'app.rhq_region_country %/% 변경 거부: 이 국가를 스코프로 가진 계정이 있고 마지막 행이다', OLD.region_id, OLD.country_code
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $f$;

CREATE TRIGGER rhq_region_guard BEFORE DELETE OR UPDATE OF region_id, brand_code ON app.rhq_region
  FOR EACH ROW EXECUTE FUNCTION app.tg_rhq_region_guard();
CREATE TRIGGER rhq_region_country_guard BEFORE DELETE OR UPDATE OF region_id, country_code ON app.rhq_region_country
  FOR EACH ROW EXECUTE FUNCTION app.tg_rhq_region_guard();
CREATE TRIGGER rhq_region_truncate_guard BEFORE TRUNCATE ON app.rhq_region
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_rhq_region_guard();
CREATE TRIGGER rhq_region_country_truncate_guard BEFORE TRUNCATE ON app.rhq_region_country
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_rhq_region_guard();

ALTER FUNCTION app.tg_rhq_region_guard() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.tg_rhq_region_guard() FROM PUBLIC;
COMMENT ON TABLE app.rhq_region IS '권역본부 권역. 계정 scope_regions 가 참조하는 권역의 DELETE·키 UPDATE·TRUNCATE 는 거부(rhq_region_guard, DB-v2.4)';
COMMENT ON TABLE app.rhq_region_country IS '권역 → 국가. 참조 계정이 있는 권역의 행 DELETE·UPDATE, 계정 국가 참조의 마지막 행 삭제, TRUNCATE 는 거부(DB-v2.4)';

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.5 보완 패치 (PostgreSQL 17, 2026-09-28) · core 5라운드 D-stance
-- 적용 순서: DB-v2.4.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.5.sql = DB-v2.4.sql + 이 파일.
--
-- P42 rd.answer_stance.cyc_key: 스탠스 표에만 회차 키가 없어 ① 사실 표 3술어(surface·round_date·cyc_key = ANY, SQL 경계 가드 G1)를
--     걸 수 없었고 ② 회차 숨김(hidden_scope 3 mentions·1 all)을 cyc_key 로 가를 수 없었다(CORE-REQUESTS an-answers R1·an-mentions R1).
--     가드 예외(rd.answer 조인 면제)가 아니라 다른 사실 표 3종(answer_brand·citation)과 같은 투영 규칙으로 연다(근본안).
--   - 열: cyc_key int4 NOT NULL(기본값 없음: 적재기가 rd.answer.cyc_key 를 투영하지 않으면 INSERT 가 실패해야 한다. 0 으로 조용히 채우면
--     스탠스 행이 창에서 사라진다). 기존 행은 rd.answer 등치 조인(surface, round_date, answer_key)으로 채우고 고아·NULL 0 을 단언한다.
--   - 게이트 전파: rd.propagate_answer_gates 가 answer_stance 의 std_in 과 함께 cyc_key 를 맞추고 단언 대상에 넣는다(answer_brand 와 같은 규칙).
--   - 인덱스: st_cyc_idx (cyc_key). rd.answer answer_cyc_idx 와 같은 규칙(회차 단위 조회·재투영). HOT: cyc_key 는 rd.answer 쪽도
--     btree(answer_cyc_idx·answer_cell_idx)에 있어 회차 재배정 UPDATE 가 원래 HOT 이 아니다(새 제약 아님). 조회 결합은 PK
--     (surface, round_date, answer_key, …) 접두가 맡는다.
--   적재 쪽 영향(이 패치 밖): rd.answer_stance 를 쓰는 적재 투영은 cyc_key 열을 넣어야 한다(rd.answer.cyc_key 복사, answer_brand 와 같다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '30min';     -- 기존 행 채우기(UPDATE)·NOT NULL 검사가 행 수에 비례(stg 수백만 행)

DO $v$ BEGIN
  IF to_regclass('rd.answer_stance') IS NULL OR to_regprocedure('app.tg_rhq_region_guard()') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.4 가 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer_stance'::regclass AND attname = 'cyc_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.5 이미 적용됨(rd.answer_stance.cyc_key 존재)';
  END IF;
END $v$;

ALTER TABLE rd.answer_stance ADD COLUMN cyc_key int4;          -- 파티션 leaf 전부에 전파(메타데이터만)
UPDATE rd.answer_stance s SET cyc_key = a.cyc_key
  FROM rd.answer a
 WHERE a.surface = s.surface AND a.round_date = s.round_date AND a.answer_key = s.answer_key;
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM rd.answer_stance WHERE cyc_key IS NULL;
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: rd.answer 없는 answer_stance 행(고아) %', v; END IF;
END $v$;
ALTER TABLE rd.answer_stance ALTER COLUMN cyc_key SET NOT NULL;
CREATE INDEX st_cyc_idx ON rd.answer_stance (cyc_key);
COMMENT ON COLUMN rd.answer_stance.cyc_key IS 'rd.answer.cyc_key 사본(게이트 전파 대상, DB-v2.5 P42). 사실 표 3술어·회차 숨김 판정용';

-- 게이트 전파(B3): answer_stance 도 cyc_key 를 맞추고 단언한다(v2.5). 나머지는 v2.4 와 같다.
CREATE OR REPLACE FUNCTION rd.propagate_answer_gates(p_keys int4[]) RETURNS int LANGUAGE plpgsql AS $f$
-- 답변 위치는 rd.job(answer_key PK)에서 파티션 좌표(surface, round_date)를 얻어 등치 조인으로 찾는다.
-- rd.answer 를 answer_key = ANY 로 직접 찾으면 파티션 키가 없어 모든 leaf 의 PK 인덱스를 끝까지 훑는다
-- (2026-09-27 스모크: 24만 행 12 leaf 4.5ms vs rd.job 경유 0.028ms, 행 수에 비례).
DECLARE n int := 0; m int;
BEGIN
  -- 위치 단언: served 인 job 은 같은 좌표의 rd.answer 가 있어야 한다. 없으면 아래 조인이 조용히 0건이 된다.
  IF EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = ANY(p_keys) AND j.served
               AND NOT EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key))
  THEN RAISE EXCEPTION 'rd.job ↔ rd.answer 위치 불일치: 재투영 누락'; END IF;
  UPDATE rd.answer_brand c SET std_in = a.std_in, elig = a.elig, dflt = a.dflt, cyc_key = a.cyc_key
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.elig, c.dflt, c.cyc_key) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET std_in = a.std_in, cyc_key = a.cyc_key
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.cyc_key) IS DISTINCT FROM (a.std_in, a.cyc_key);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET cit_in = a.cit_in, gap = a.gap, dflt = a.dflt, cyc_key = a.cyc_key
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.cit_in, c.gap, c.dflt, c.cyc_key) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.job j SET cyc_key = a.cyc_key, analysis_code = a.analysis_state
    FROM rd.answer a WHERE j.answer_key = ANY(p_keys)
     AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
     AND (j.cyc_key, j.analysis_code) IS DISTINCT FROM (a.cyc_key, a.analysis_state);
  -- 게이트 동치 단언(불변식 ①): 위반 시 롤백
  IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_brand c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.std_in, c.elig, c.dflt, c.cyc_key) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_stance c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.std_in, c.cyc_key) IS DISTINCT FROM (a.std_in, a.cyc_key))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.cit_in, c.gap, c.dflt, c.cyc_key) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key))
  THEN RAISE EXCEPTION 'rd 게이트 사본 불일치: 전파 누락'; END IF;
  RETURN n;
END $f$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.6 보완 패치 (PostgreSQL 17, 2026-09-28) · core 6라운드(비분석 8그룹 + 적재 워커 core 요청)
-- 적용 순서: DB-v2.5.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.6.sql = DB-v2.5.sql + 이 파일.
-- 근거: back/CORE-REQUESTS/{intent,ad-content,ad-ops,qa,ingest}.md, 메인 지시서 core-round5.md "반영(DB-v2.6)".
--
-- P43 rd.kw_suggestion.observed_at timestamptz NOT NULL(intent R4): related·search 신선도(TTL 7일)를 API 가 rd 만으로 계산한다.
--     기존 행은 ext.dfs_call.requested_at(call_id 등치)으로 채우고 NULL 0 을 단언한다. 적재기는 쓰기 때 관측 시각을 넣는다.
-- P44 app.project_tracked_keyword.term_norm 생성 열 + (project_id, term_norm, coalesce(country_code, '')) 유니크(intent R10).
--     식 = lower(btrim(normalize(term, NFC), 공백류 29자)) = core.kw.term_norm(NFC → str.strip → lower, 공백류 = 파이썬 str.isspace).
--     기존 행: country_code 가 프로젝트 국가와 같으면 NULL 로 정규화(대소문자 무시). 정규화 뒤 중복이 있으면 적용을 멈춘다(자동 삭제 안 함).
-- P45 app.ga4_property (brand_code, country_code) 부분 유니크(brand_code NOT NULL)(ad-ops R7): 같은 시장을 두 속성이 가리키지 못하게.
-- P46 GRANT EXECUTE rd.today_kst() TO admin_long(ad-content R2): 관리 조회가 같은 스냅샷에서 창을 해석한다.
-- P47 qa_gate 참조 SELECT(qa R1): app.brand·app.citation_category·app.citation_domain_override 전체, app.prompt 는 필요한 열만.
-- P48 rd.analyze_facts(regclass[]) SECURITY DEFINER(ingest R4): loader 가 소유자가 아니라 ANALYZE 가 경고와 함께 건너뛰던 것.
--     PG17 GRANT MAINTAIN 은 파티션마다 따로 검사해(부모에만 주면 leaf 전부 'permission denied to analyze' 로 건너뜀, 로컬 실측)
--     새 leaf 마다 부여해야 하므로 기각. 허용 = rd·ing 스키마의 표(부모·leaf). 함수 소유자 = rd.answer 소유자.
-- P49 ing.citation(url) hash 인덱스(ingest R5): URL 차원 재계산·고아 정리의 url = ANY 조회(파티션 부모 선언 = leaf 전부).
-- P50 app.user_account 마지막 실효 admin 보호 제약 트리거(ad-ops R11, 운영 사고 방지): 실효 admin = role admin ∧ active ∧
--     (menu_groups NULL ∨ 'admin' 포함). 그런 행을 UPDATE·DELETE 한 트랜잭션이 커밋될 때(DEFERRABLE INITIALLY DEFERRED) 하나도
--     남지 않으면 23514(ua_last_admin). 앱은 먼저 409 로 막고(accounts.users), 이 트리거는 DB 직접 쓰기·다른 경로의 최후 방어.
-- P51 ing.stage_answer.answer_key NULL 허용(ingest R11): 스테이지에 0 을 넣었다가 키를 채우던 것을 NULL 로(키 누락이 ing.answer
--     INSERT 의 NOT NULL 로 드러난다. 0 은 조용히 통과할 수 있었다).
-- P52 mig.known_diff AD-2(ad-content R7, 메인 결정): 엔티티 수치 정의 변경(계약 §3 모수 게이트 std_in ∧ dflt 추가·표시 브랜드 단위·
--     기간 필수). A4 1회 고지 대상.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '30min';     -- P49 인덱스 생성이 ing.citation 행 수에 비례

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer_stance'::regclass AND attname = 'cyc_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.5 가 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.kw_suggestion'::regclass AND attname = 'observed_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.6 이미 적용됨(rd.kw_suggestion.observed_at 존재)';
  END IF;
END $v$;

-- ── P43 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.kw_suggestion ADD COLUMN observed_at timestamptz;
UPDATE rd.kw_suggestion s SET observed_at = d.requested_at FROM ext.dfs_call d WHERE d.call_id = s.call_id;
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM rd.kw_suggestion WHERE observed_at IS NULL;
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: ext.dfs_call 없는 kw_suggestion 행 %', v; END IF;
END $v$;
ALTER TABLE rd.kw_suggestion ALTER COLUMN observed_at SET NOT NULL;
COMMENT ON COLUMN rd.kw_suggestion.observed_at IS '관측 시각(= ext.dfs_call.requested_at). related·search 신선도(TTL 7일) 판정(DB-v2.6 P43)';

-- ── P44 ─────────────────────────────────────────────────────────────────────
UPDATE app.project_tracked_keyword k SET country_code = NULL
  FROM app.project p
 WHERE p.project_id = k.project_id AND k.country_code IS NOT NULL AND upper(btrim(k.country_code)) = upper(btrim(p.country_code));
ALTER TABLE app.project_tracked_keyword ADD COLUMN term_norm text GENERATED ALWAYS AS (
  lower(btrim(normalize(term, NFC),
              E'\u0009\u000A\u000B\u000C\u000D\u001C\u001D\u001E\u001F \u0085                 　'))
) STORED;
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM (SELECT 1 FROM app.project_tracked_keyword
                                GROUP BY project_id, term_norm, coalesce(country_code, '') HAVING count(*) > 1) d;
  IF v <> 0 THEN RAISE EXCEPTION '추적 키워드 중복 %건(term_norm·유효 국가 기준): 정리 후 다시 적용', v; END IF;
END $v$;
CREATE UNIQUE INDEX project_tracked_keyword_norm_uq ON app.project_tracked_keyword (project_id, term_norm, coalesce(country_code, ''));
COMMENT ON COLUMN app.project_tracked_keyword.term_norm IS 'core.kw.term_norm 과 같은 식(NFC → 공백류 trim → lower). 유니크 판정 키(DB-v2.6 P44)';

-- ── P45 ─────────────────────────────────────────────────────────────────────
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM (SELECT 1 FROM app.ga4_property WHERE brand_code IS NOT NULL
                                GROUP BY brand_code, country_code HAVING count(*) > 1) d;
  IF v <> 0 THEN RAISE EXCEPTION 'GA4 시장 중복 %건: 정리 후 다시 적용', v; END IF;
END $v$;
CREATE UNIQUE INDEX ga4_property_market_uq ON app.ga4_property (brand_code, country_code) WHERE brand_code IS NOT NULL;

-- ── P46 ─────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION rd.today_kst() TO admin_long;

-- ── P47 ─────────────────────────────────────────────────────────────────────
GRANT SELECT ON app.brand, app.citation_category, app.citation_domain_override TO qa_gate;
GRANT SELECT (prompt_id, project_id, scope_prompt_id, deleted_at, created_at, brand_code, brand_presence, list_type,
              depth1, depth2, depth3, depth4, funnel_stage, kind, prompt_type, category) ON app.prompt TO qa_gate;

-- ── P48 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rd.analyze_facts(p_rels regclass[]) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
-- 적재기(loader)의 ANALYZE 대행. 허용 = rd·ing 스키마의 일반·파티션 표(부모면 leaf 전부를 함께 본다). 반환 = ANALYZE 한 관계 수.
DECLARE r regclass; n int := 0;
BEGIN
  FOREACH r IN ARRAY coalesce(p_rels, '{}'::regclass[]) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = r AND c.relkind IN ('r', 'p')
                     AND c.relnamespace IN ('rd'::regnamespace, 'ing'::regnamespace)) THEN
      RAISE EXCEPTION 'rd.analyze_facts 허용 목록 밖: %', r USING ERRCODE = '42501';
    END IF;
    EXECUTE format('ANALYZE %s', r);
    n := n + 1;
  END LOOP;
  RETURN n;
END $f$;
DO $v$ BEGIN
  EXECUTE format('ALTER FUNCTION rd.analyze_facts(regclass[]) OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'rd.answer'::regclass));
END $v$;
REVOKE ALL ON FUNCTION rd.analyze_facts(regclass[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.analyze_facts(regclass[]) TO loader;

-- ── P49 ─────────────────────────────────────────────────────────────────────
CREATE INDEX citation_url_hash_idx ON ing.citation USING hash (url);

-- ── P50 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tg_last_admin_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.user_account u
                  WHERE u.role = 'admin' AND u.status = 'active' AND (u.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (u.menu_groups))) THEN
    RAISE EXCEPTION '마지막 실효 admin 을 없앨 수 없다(역할·상태·메뉴 그룹 변경 또는 삭제)'
      USING ERRCODE = '23514', CONSTRAINT = 'ua_last_admin', TABLE = 'user_account', SCHEMA = 'app';
  END IF;
  RETURN NULL;
END $f$;
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM app.user_account u
   WHERE u.role = 'admin' AND u.status = 'active' AND (u.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (u.menu_groups));
  RAISE NOTICE 'P50 실효 admin %명', v;
END $v$;
CREATE CONSTRAINT TRIGGER ua_last_admin AFTER UPDATE OR DELETE ON app.user_account DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.role = 'admin' AND OLD.status = 'active' AND (OLD.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (OLD.menu_groups)))
  EXECUTE FUNCTION app.tg_last_admin_guard();

-- ── P51 ─────────────────────────────────────────────────────────────────────
ALTER TABLE ing.stage_answer ALTER COLUMN answer_key DROP NOT NULL;

-- ── P52 ─────────────────────────────────────────────────────────────────────
INSERT INTO mig.known_diff (rule_id, feature_id, metric_key_like, compat_variant, description, decided_ref, notice_required)
VALUES ('AD-2', 'admin.entities.registry', 'brand_%', 'input',
        '엔티티 수치 정의 변경: 브랜드 답변·언급 수에 계약 §3 모수 게이트(std_in ∧ dflt)를 걸고, 표시 브랜드 단위로 세며, 기간을 필수로 한다'
        ' (현행 listDiscoveredBrands: 게이트 없음·엔티티 발생 합)',
        '메인 결정 2026-09-28 core 6라운드 ad-content R7 · 모듈-관리자 §4', true)
ON CONFLICT (rule_id, feature_id, metric_key_like) DO NOTHING;

-- ── 적용 확인(행 수·존재 단언) ───────────────────────────────────────────────
DO $v$ BEGIN
  IF NOT has_function_privilege('admin_long', 'rd.today_kst()', 'execute') THEN RAISE EXCEPTION 'P46 실패'; END IF;
  IF NOT has_table_privilege('qa_gate', 'app.brand', 'select') OR NOT has_column_privilege('qa_gate', 'app.prompt', 'depth4', 'select')
    THEN RAISE EXCEPTION 'P47 실패'; END IF;
  IF NOT has_function_privilege('loader', 'rd.analyze_facts(regclass[])', 'execute') THEN RAISE EXCEPTION 'P48 실패'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'ua_last_admin' AND tgrelid = 'app.user_account'::regclass) <> 1 THEN RAISE EXCEPTION 'P50 실패'; END IF;
  IF (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'ing.stage_answer'::regclass AND attname = 'answer_key') THEN RAISE EXCEPTION 'P51 실패'; END IF;
  IF (SELECT count(*) FROM mig.known_diff WHERE rule_id = 'AD-2') <> 1 THEN RAISE EXCEPTION 'P52 실패'; END IF;
END $v$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.7 보완 패치 (PostgreSQL 17, 2026-09-28) · core 6라운드 독립 검증 수정(m-2·m-4·m-5·정보 1)
-- 적용 순서: DB-v2.6.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.7.sql = DB-v2.6.sql + 이 파일.
--
-- P53 app.tg_last_admin_guard 직렬화(검증 m-2): v2.6 P50 은 판정만 해서 REPEATABLE READ 트랜잭션 둘이 admin 2명을 각각 정지시키면
--     서로의 변경을 못 본 채 둘 다 커밋됐다(실효 admin 0). 판정 전에 남은 실효 admin 행을 FOR SHARE 로 잠근다: 다른 트랜잭션이 같은 행을
--     바꾸는 중이면 기다리고(교착이면 한쪽 40P01), 이미 커밋된 변경이 스냅샷 뒤라면 RR·SERIALIZABLE 은 40001, READ COMMITTED 는 새
--     스냅샷에서 다시 세어 23514. 행 잠금은 UPDATE 권한이 필요해 SECURITY DEFINER(소유자 = app.user_account 소유자)로 둔다.
-- P54 app.project_tracked_keyword.country_code 표기(검증 m-4): app.project.country_code 와 같은 ISO 대문자로 저장한다(쓰기 시점 정규화는
--     기능 intent.keywords.tracked). 기존 행 upper(btrim) 정규화 → 프로젝트 국가와 같으면 NULL → 중복 0 단언 → CHECK ptk_country_upper.
-- P55 app.term_norm(text)(검증 m-5): 추적 키워드 생성 열의 식을 함수 하나로 두고 생성 열도 그 함수를 쓴다(ALTER … SET EXPRESSION, PG17).
--     유일성·중복 판정·rd.dim_keyword.term_norm 쓰기·조회는 이 DB 함수가 정본이다(파이썬 core.kw.term_norm 은 표시·미리보기용).
--     식 = lower(btrim(normalize(t, NFC), 공백류 29자)). 파이썬 str.lower 와 다른 문자(İ → 'i̇' 대 'i', 어말 시그마 Σ → 'ς' 대 'σ')는
--     DB 쪽이 정본이라 차이가 판정에 영향을 주지 않는다(표시값만 다를 수 있다).
-- P56 rd.analyze_facts 반환 = (analyzed, skipped)(정보): 권한 없어 PostgreSQL 이 WARNING 과 함께 건너뛴 관계를 따로 센다(파티션 트리의
--     표 단위, MAINTAIN 권한 = 함수 소유자 기준). 반환 형이 바뀌어 DROP 후 다시 만든다(호출자 ingest.common.db.analyze).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '10min';

DO $v$ BEGIN
  IF to_regprocedure('rd.analyze_facts(regclass[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.6 이 먼저 적용돼야 한다';
  END IF;
  IF to_regprocedure('app.term_norm(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.7 이미 적용됨(app.term_norm 존재)';
  END IF;
END $v$;

-- ── P53 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tg_last_admin_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE n int;
BEGIN
  -- 남은 실효 admin 행을 FOR SHARE 로 잠그며 센다(동시에 다른 admin 을 바꾸는 트랜잭션과 직렬화: 대기·40P01·40001, RC 는 재평가 뒤 0 → 23514)
  SELECT count(*) INTO n
    FROM (SELECT 1 FROM app.user_account u
           WHERE u.role = 'admin' AND u.status = 'active' AND (u.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (u.menu_groups))
             FOR SHARE) x;
  IF n = 0 THEN
    RAISE EXCEPTION '마지막 실효 admin 을 없앨 수 없다(역할·상태·메뉴 그룹 변경 또는 삭제)'
      USING ERRCODE = '23514', CONSTRAINT = 'ua_last_admin', TABLE = 'user_account', SCHEMA = 'app';
  END IF;
  RETURN NULL;
END $f$;
DO $v$ BEGIN
  EXECUTE format('ALTER FUNCTION app.tg_last_admin_guard() OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app.user_account'::regclass));
END $v$;
REVOKE EXECUTE ON FUNCTION app.tg_last_admin_guard() FROM PUBLIC;

-- ── P54 ─────────────────────────────────────────────────────────────────────
-- 중복 사전 단언을 정규화 UPDATE 보다 먼저 한다(정규화 식으로 센다). 뒤에 두면 UPDATE 가 유니크 인덱스(project_tracked_keyword_norm_uq)에
-- 먼저 걸려 설계 메시지 대신 날것의 23505 로 멈춘다(검증 N-2).
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM (
    SELECT 1 FROM app.project_tracked_keyword k JOIN app.project p ON p.project_id = k.project_id
     GROUP BY k.project_id, k.term_norm,
              coalesce(CASE WHEN nullif(upper(btrim(k.country_code)), '') = upper(btrim(p.country_code)) THEN NULL
                            ELSE nullif(upper(btrim(k.country_code)), '') END, '')
    HAVING count(*) > 1) d;
  IF v <> 0 THEN RAISE EXCEPTION '추적 키워드 중복 %건(국가 표기 정규화 뒤 같은 term_norm·유효 국가): 정리 후 다시 적용', v; END IF;
END $v$;
UPDATE app.project_tracked_keyword SET country_code = upper(btrim(country_code))
 WHERE country_code IS NOT NULL AND country_code IS DISTINCT FROM upper(btrim(country_code));
UPDATE app.project_tracked_keyword SET country_code = NULL WHERE country_code = '';
UPDATE app.project_tracked_keyword k SET country_code = NULL
  FROM app.project p
 WHERE p.project_id = k.project_id AND k.country_code IS NOT NULL AND k.country_code = upper(btrim(p.country_code));
ALTER TABLE app.project_tracked_keyword ADD CONSTRAINT ptk_country_upper
  CHECK (country_code IS NULL OR (country_code = upper(country_code) AND country_code = btrim(country_code) AND country_code <> ''));

-- ── P55 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.term_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN lower(btrim(normalize(t, NFC),
             E'\u0009\u000A\u000B\u000C\u000D\u001C\u001D\u001E\u001F \u0085                 　'));
COMMENT ON FUNCTION app.term_norm(text) IS '키워드 정규화 정본(NFC → 공백류 trim → lower). 추적 키워드 생성 열·rd.dim_keyword·중복 판정(DB-v2.7 P55)';
REVOKE EXECUTE ON FUNCTION app.term_norm(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.term_norm(text) TO api_ro, api_rw, admin_long, qa_gate, loader, loader_ro, migrator;
CREATE TEMP TABLE _p55_before ON COMMIT DROP AS SELECT keyword_id, term_norm FROM app.project_tracked_keyword;
ALTER TABLE app.project_tracked_keyword ALTER COLUMN term_norm SET EXPRESSION AS (app.term_norm(term));
DO $v$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM _p55_before b JOIN app.project_tracked_keyword k USING (keyword_id) WHERE k.term_norm IS DISTINCT FROM b.term_norm;
  IF v <> 0 THEN RAISE EXCEPTION '생성 열 식 교체로 term_norm 이 바뀐 행 %', v; END IF;
  SELECT count(*) INTO v FROM rd.dim_keyword WHERE term_norm IS DISTINCT FROM app.term_norm(term);
  IF v <> 0 THEN RAISE NOTICE 'P55 rd.dim_keyword 에 DB 정규화와 다른 term_norm %행(적재기 파이썬 정규화 시절 값, 재수집 때 맞춰진다)', v; END IF;
END $v$;

-- ── P56 ─────────────────────────────────────────────────────────────────────
DROP FUNCTION rd.analyze_facts(regclass[]);
CREATE FUNCTION rd.analyze_facts(p_rels regclass[], OUT analyzed int, OUT skipped int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
-- 적재기(loader)의 ANALYZE 대행. 허용 = rd·ing 스키마의 일반·파티션 표(부모면 파티션 트리 전체). analyzed = ANALYZE 대상 표 수,
-- skipped = 함수 소유자에게 MAINTAIN 권한이 없어 PostgreSQL 이 WARNING 과 함께 건너뛰는 표 수(파티션 트리 기준).
DECLARE r regclass; ok int; bad int;
BEGIN
  analyzed := 0;
  skipped := 0;
  FOREACH r IN ARRAY coalesce(p_rels, '{}'::regclass[]) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = r AND c.relkind IN ('r', 'p')
                     AND c.relnamespace IN ('rd'::regnamespace, 'ing'::regnamespace)) THEN
      RAISE EXCEPTION 'rd.analyze_facts 허용 목록 밖: %', r USING ERRCODE = '42501';
    END IF;
    SELECT count(*) FILTER (WHERE has_table_privilege(t.relid, 'MAINTAIN')), count(*) FILTER (WHERE NOT has_table_privilege(t.relid, 'MAINTAIN'))
      INTO ok, bad
      FROM pg_partition_tree(r) t JOIN pg_class c ON c.oid = t.relid WHERE c.relkind IN ('r', 'p');
    EXECUTE format('ANALYZE %s', r);
    analyzed := analyzed + ok;
    skipped := skipped + bad;
  END LOOP;
END $f$;
DO $v$ BEGIN
  EXECUTE format('ALTER FUNCTION rd.analyze_facts(regclass[]) OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'rd.answer'::regclass));
END $v$;
REVOKE ALL ON FUNCTION rd.analyze_facts(regclass[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.analyze_facts(regclass[]) TO loader;

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF NOT (SELECT prosecdef AND position('FOR SHARE' in prosrc) > 0 FROM pg_proc WHERE oid = 'app.tg_last_admin_guard()'::regprocedure)
    THEN RAISE EXCEPTION 'P53 실패'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ptk_country_upper') THEN RAISE EXCEPTION 'P54 실패'; END IF;
  IF position('term_norm' in (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid
                                 AND a.attnum = d.adnum WHERE d.adrelid = 'app.project_tracked_keyword'::regclass AND a.attname = 'term_norm')) = 0
    THEN RAISE EXCEPTION 'P55 실패'; END IF;
  IF NOT has_function_privilege('loader', 'rd.analyze_facts(regclass[])', 'execute')
     OR NOT has_function_privilege('api_ro', 'app.term_norm(text)', 'execute')
     OR NOT has_function_privilege('loader', 'app.term_norm(text)', 'execute') THEN RAISE EXCEPTION 'P55·P56 권한 실패'; END IF;
END $v$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.8 보완 패치 (PostgreSQL 17, 2026-09-28) · core 6라운드 5.1 좁은 검증 수정(N-1·I-1)
-- 적용 순서: DB-v2.7.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.8.sql = DB-v2.7.sql + 이 파일. 추가·교체형(열·표 변경 없음).
--
-- P57 마지막 실효 admin 트리거 발동 조건 좁히기(검증 N-1, P53 회귀): v2.7 은 실효 admin 행의 UPDATE 면 역할과 무관한 열(display_name 등)
--     만 바꿔도 발동해 남은 실효 admin 전부를 FOR SHARE 로 잠갔다. READ COMMITTED 트랜잭션 둘이 서로 다른 admin 의 이름만 고쳐도
--     40P01(교착)이 났다(v2.6 은 오류 0). 트리거를 둘로 나눈다:
--       ua_last_admin     AFTER UPDATE, WHEN OLD 는 실효 admin ∧ NEW 는 실효 admin 아님(강등·정지·admin 메뉴 제거만)
--       ua_last_admin_del AFTER DELETE, WHEN OLD 는 실효 admin
--     함수도 첫머리에서 NEW 가 여전히 실효 admin 인 UPDATE 는 잠금 전에 돌아간다(방어 심층). 판정·잠금·오류(23514 ua_last_admin)는 v2.7 과 같다.
-- P58 app.term_norm 소유자 = app.project_tracked_keyword 소유자(hmg_owner)(검증 I-1): v2.7 은 패치 적용 롤(dev postgres, stg hmgadmin)이
--     소유해 hmg_owner 에 EXECUTE 가 없었다(생성 열 표의 소유자가 식 함수를 실행하지 못하는 상태). 기존 GRANT 는 유지·재확인한다.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';

DO $v$ BEGIN
  IF to_regprocedure('app.term_norm(text)') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.7 이 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ua_last_admin_del' AND tgrelid = 'app.user_account'::regclass) THEN
    RAISE EXCEPTION 'DB-v2.8 이미 적용됨(ua_last_admin_del 존재)';
  END IF;
END $v$;

-- ── P57 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tg_last_admin_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE n int;
BEGIN
  -- 방어 심층: 발동 조건(WHEN)이 이미 거르지만, 여전히 실효 admin 인 행의 UPDATE 는 잠그지 않고 돌아간다(역할 무관 열 편집의 교착 방지)
  IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.status = 'active'
     AND (NEW.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (NEW.menu_groups)) THEN
    RETURN NULL;
  END IF;
  -- 남은 실효 admin 행을 FOR SHARE 로 잠그며 센다(동시에 다른 admin 을 내리는 트랜잭션과 직렬화: 대기·40P01·40001, RC 는 재평가 뒤 0 → 23514)
  SELECT count(*) INTO n
    FROM (SELECT 1 FROM app.user_account u
           WHERE u.role = 'admin' AND u.status = 'active' AND (u.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (u.menu_groups))
             FOR SHARE) x;
  IF n = 0 THEN
    RAISE EXCEPTION '마지막 실효 admin 을 없앨 수 없다(역할·상태·메뉴 그룹 변경 또는 삭제)'
      USING ERRCODE = '23514', CONSTRAINT = 'ua_last_admin', TABLE = 'user_account', SCHEMA = 'app';
  END IF;
  RETURN NULL;
END $f$;
REVOKE EXECUTE ON FUNCTION app.tg_last_admin_guard() FROM PUBLIC;

DROP TRIGGER ua_last_admin ON app.user_account;
CREATE CONSTRAINT TRIGGER ua_last_admin AFTER UPDATE ON app.user_account DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.role = 'admin' AND OLD.status = 'active' AND (OLD.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (OLD.menu_groups))
        AND NOT coalesce(NEW.role = 'admin' AND NEW.status = 'active'
                         AND (NEW.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (NEW.menu_groups)), false))
  EXECUTE FUNCTION app.tg_last_admin_guard();
CREATE CONSTRAINT TRIGGER ua_last_admin_del AFTER DELETE ON app.user_account DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.role = 'admin' AND OLD.status = 'active' AND (OLD.menu_groups IS NULL OR 'admin'::app.menu_group = ANY (OLD.menu_groups)))
  EXECUTE FUNCTION app.tg_last_admin_guard();

-- ── P58 ─────────────────────────────────────────────────────────────────────
DO $v$ BEGIN
  EXECUTE format('ALTER FUNCTION app.term_norm(text) OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app.project_tracked_keyword'::regclass));
END $v$;
REVOKE EXECUTE ON FUNCTION app.term_norm(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.term_norm(text) TO api_ro, api_rw, admin_long, qa_gate, loader, loader_ro, migrator;

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$ DECLARE owner_ok bool; BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'app.user_account'::regclass AND tgname IN ('ua_last_admin', 'ua_last_admin_del')
         AND tgdeferrable AND tginitdeferred) <> 2 THEN RAISE EXCEPTION 'P57 트리거 실패'; END IF;
  IF position('NEW.role' in (SELECT prosrc FROM pg_proc WHERE oid = 'app.tg_last_admin_guard()'::regprocedure)) = 0
    THEN RAISE EXCEPTION 'P57 함수 실패'; END IF;
  SELECT pg_get_userbyid(p.proowner) = pg_get_userbyid(c.relowner) INTO owner_ok
    FROM pg_proc p, pg_class c WHERE p.oid = 'app.term_norm(text)'::regprocedure AND c.oid = 'app.project_tracked_keyword'::regclass;
  IF NOT owner_ok OR NOT has_function_privilege((SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app.project_tracked_keyword'::regclass),
                                                'app.term_norm(text)', 'execute')
     OR NOT has_function_privilege('api_ro', 'app.term_norm(text)', 'execute')
     OR NOT has_function_privilege('loader', 'app.term_norm(text)', 'execute') THEN RAISE EXCEPTION 'P58 실패'; END IF;
END $v$;

COMMIT;
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
-- ============================================================================
-- hmg-geo 재설계 DB-v2.10 보완 패치 (PostgreSQL 17, 2026-09-29) · core 9라운드(검증 관찰: rd.dim_country 대소문자 중복 → 전 요청 500)
-- 적용 순서: DB-v2.9.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.10.sql = DB-v2.9.sql + 이 파일. 추가형(색인 1개).
--
-- P65 rd.dim_country (upper(code)) 유일 색인: core.codes.load_refs 는 국가를 upper 키로 조회해 대소문자만 다른 코드가 둘이면 어느 쪽인지
--     정할 수 없어 거부한다(데이터 무결성 신호, 전 요청 500). 적재기(ingest DIM_COUNTRY·seed-30 §2)는 이제 upper 기준으로 이미 있는
--     정본 행을 재사용하고 조인도 upper 등치다. 이 색인은 어떤 경로로도 그 상태를 만들 수 없게 DB 에서 막는다(위반 = 23505,
--     적재 트랜잭션이 통째로 롤백되고 API 는 계속 돈다). 조인 upper(g.code) = upper(x) 도 이 색인을 쓸 수 있다.
--     사전 확인: 이미 중복이 있으면 목록과 함께 멈춘다(색인 생성 실패보다 먼저 원인을 보인다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'app.ga4_property'::regclass AND attname = 'verified_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.9 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.dim_country_code_upper_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.10 이미 적용됨(rd.dim_country_code_upper_uq 존재)';
  END IF;
END $v$;

-- ── P65 ─────────────────────────────────────────────────────────────────────
DO $v$ DECLARE d text; BEGIN
  SELECT string_agg(u || '(' || codes || ')', ', ') INTO d
    FROM (SELECT upper(code) AS u, string_agg(code, '·' ORDER BY code) AS codes FROM rd.dim_country GROUP BY upper(code) HAVING count(*) > 1) x;
  IF d IS NOT NULL THEN
    RAISE EXCEPTION 'rd.dim_country 에 대소문자만 다른 코드가 이미 있다: %', d;
  END IF;
END $v$;
CREATE UNIQUE INDEX dim_country_code_upper_uq ON rd.dim_country (upper(code));
COMMENT ON INDEX rd.dim_country_code_upper_uq IS '대소문자만 다른 국가 코드 금지(core.codes.load_refs upper 조회, DB-v2.10 P65)';

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'rd.dim_country_code_upper_uq'::regclass AND i.indisunique AND i.indisvalid)
    THEN RAISE EXCEPTION 'P65 실패'; END IF;
END $v$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.11 보완 패치 (PostgreSQL 17, 2026-09-30) · 데이터 버전 기반 결과 캐시(core.result_cache, 제품 책임자 승인 2026-09-30)
-- 적용 순서: DB-v2.10.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.11.sql = DB-v2.10.sql + 이 파일. 추가형(기존 표·열·권한 의미 불변).
--
-- P66 rcache 스키마(소유자 hmg_owner, 어떤 풀 롤에도 USAGE 없음) + 세 표.
--     rcache.entry(UNLOGGED): 결과 캐시 행 = 키(sha256 32바이트) PK, 라우트 템플릿, 데이터 버전 문자열, 코덱(identity|zlib), 응답 바이트,
--       원본·저장 크기, 생성 시각. 두 uvicorn 워커·호스트가 공유한다. 장애 복구 시 비워져도 된다(다음 요청이 다시 채운다).
--       색인 (data_version, created_at): 낡은 버전 정리를 범위 삭제로(put 이 표 전체를 훑지 않는다).
--     rcache.stat(UNLOGGED, 한 행): 저장 크기·행 수 누적 카운터(put·정리·무효화가 같은 트랜잭션에서 증감). entry 와 함께 장애 복구 시 비워진다.
--     rcache.data_version(LOGGED): 추적 표(P67)의 버전 카운터(표 이름 PK, 단조 증가) + 수동 무효화 *manual*. 합(sum)이 데이터 버전 요소 tv.
-- P67 rcache.tg_bump + 문장 수준 트리거 AFTER INSERT·UPDATE·DELETE(전이 표로 바뀐 행이 있을 때만) · TRUNCATE(항상). 추적 표 26개:
--     app 11개 = 캐시 대상이 조회 시점에 바로 읽는 표(참조 차원·숨김 시장·인용 오버라이드·카탈로그·커스텀 필드·발행). 세대(generation)는
--       적재 finalize 에서만 올라 관리 편집이 곧바로 결과를 바꾸는 표를 덮지 못한다.
--     rd 15개 = 차원·파생 표(dim_country·dim_region·dim_project·dim_brand_name·dim_engine·dim_entity·dim_lang·dim_prompt·dim_source·
--       dim_taxon·dim_url·catalog_entry·web_unit·report_unit_value·cycle). 세대만으로는 덮이지 않는 쓰기 경로가 있다:
--       ingest/pull/sync/service.py register_projects(rd.dim_project·dim_country, finalize 없음, 매 pull 패스), sync_prompts 첫 트랜잭션
--       (dim_project.regions, finalize 없음), rejudge 의 REGISTRY_ROLE_REFRESH(dim_entity, rd_changed 없음)·_merge_app_countries(dim_country),
--       project() 의 차원 삽입(범위 차원이 생겨도 rd_changed 는 job·답변·대표·표면 기준). 과무효화를 받아들이고 차원 전부를 카운터로 덮는다.
--     세대만으로 덮는 표 = 사실 표 7개(rd.answer·answer_brand·answer_stance·citation·job·acr_cell·acr_choice): 쓰기 위치 전부가
--       apply.project()·_project_acr 안이고 같은 트랜잭션 finalize 가 세대를 올린다(tests/core/test_result_cache_writers.py 가 정적으로 강제).
--     카운터 UPDATE 는 쓰기 트랜잭션 안이라 커밋과 함께 보이고(같은 스냅샷에서 읽는 조회는 데이터와 버전이 어긋나지 않는다), 같은 표의
--     동시 쓰기는 카운터 행 잠금으로 커밋 순서대로 올라간다(IDENTITY 최댓값처럼 늦게 커밋된 작은 번호를 놓치지 않는다).
-- P68 SECURITY DEFINER 함수(소유자 hmg_owner, search_path pg_catalog, PUBLIC 실행 회수):
--     app.result_cache_version()          데이터 버전 문자열 g=<표면:세대:마지막 load:갱신 시각(UTC µs)>…|jc=<max change_id>|tv=<카운터 합>|
--                                         d=<rd.today_kst()>. 세대 번호만으로는 재구축(seed) 뒤 번호가 되풀이될 수 있어 last_load_id·updated_at 을 함께 싣는다
--     app.result_cache_lookup(prefix)     버전을 같은 스냅샷에서 읽고 키 = sha256(prefix || 버전) 행을 찾는다(요청당 왕복 1회). 행이 없어도 버전은 돌려준다
--     app.result_cache_put(…)             저장(같은 키는 그대로 둔다). 저장 크기 상한 4 MiB(넘으면 false). 낡은 버전 정리 = 이 저장과 버전이 다르고
--                                         10분 지난 행을 색인 범위 삭제로. 전체 저장 크기 상한 256 MiB 는 rcache.stat 누적 카운터로 보고 넘을 때만 오래된 행부터 삭제
--     app.result_cache_invalidate()       수동 무효화(카운터 '*manual*' +1, 전 행 삭제, stat 차감). migrator 만. DB 패치 적용·대역 밖 SQL 뒤 필수
--     api_ro 는 lookup·put·version 실행만 받는다(rcache 표 권한·스키마 USAGE 없음: 캐시 행을 직접 읽거나 쓰지 못한다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('rd.dim_country_code_upper_uq') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.10 이 먼저 적용돼야 한다';
  END IF;
  IF to_regnamespace('rcache') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.11 이미 적용됨(rcache 스키마 존재)';
  END IF;
END $v$;

-- ── P66 ─────────────────────────────────────────────────────────────────────
CREATE SCHEMA rcache;
ALTER SCHEMA rcache OWNER TO hmg_owner;
REVOKE ALL ON SCHEMA rcache FROM PUBLIC;
COMMENT ON SCHEMA rcache IS '결과 캐시(core.result_cache). 풀 롤 USAGE 없음: app.result_cache_* SECURITY DEFINER 함수로만 접근(DB-v2.11 P66)';

CREATE UNLOGGED TABLE rcache.entry (
  cache_key    bytea       PRIMARY KEY CHECK (octet_length(cache_key) = 32),
  route        text        NOT NULL,
  data_version text        NOT NULL,
  codec        text        NOT NULL CHECK (codec IN ('identity', 'zlib')),
  body         bytea       NOT NULL,
  body_bytes   int         NOT NULL CHECK (body_bytes >= 0),
  stored_bytes int         NOT NULL CHECK (stored_bytes >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rcache.entry OWNER TO hmg_owner;
REVOKE ALL ON rcache.entry FROM PUBLIC;
COMMENT ON TABLE rcache.entry IS '결과 캐시 행(UNLOGGED). 키 = sha256(요청 서명 접두 || 데이터 버전), 값 = 응답 바이트(core.result_cache, DB-v2.11 P66)';
CREATE INDEX entry_version_created_idx ON rcache.entry (data_version, created_at);

CREATE UNLOGGED TABLE rcache.stat (
  id          smallint PRIMARY KEY CHECK (id = 1),
  total_bytes bigint   NOT NULL CHECK (total_bytes >= 0),
  entries     bigint   NOT NULL CHECK (entries >= 0)
);
ALTER TABLE rcache.stat OWNER TO hmg_owner;
REVOKE ALL ON rcache.stat FROM PUBLIC;
COMMENT ON TABLE rcache.stat IS '결과 캐시 저장 크기·행 수 누적(한 행, UNLOGGED: entry 와 함께 장애 복구 시 비워진다). put·정리·무효화가 같은 트랜잭션에서 증감(DB-v2.11 P66)';

CREATE TABLE rcache.data_version (
  tbl        text        PRIMARY KEY,
  version    bigint      NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rcache.data_version OWNER TO hmg_owner;
REVOKE ALL ON rcache.data_version FROM PUBLIC;
COMMENT ON TABLE rcache.data_version IS '추적 표(조회 시점에 바로 읽히는 app 표 11 + 세대 밖에서도 바뀌는 rd 차원·파생 표 15)의 버전 카운터(rcache.tg_bump 문장 트리거가 올린다) + 수동 무효화 *manual*. '
  '합이 데이터 버전 요소 tv(DB-v2.11 P66·P67)';

-- ── P67 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION rcache.tg_bump() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO rcache.data_version AS d (tbl, version, updated_at) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 1, now())
    ON CONFLICT (tbl) DO UPDATE SET version = d.version + 1, updated_at = now();
  ELSIF EXISTS (SELECT 1 FROM rc_rows) THEN        -- 전이 표(INSERT·UPDATE = 새 행, DELETE = 옛 행). 0행 문장은 올리지 않는다
    INSERT INTO rcache.data_version AS d (tbl, version, updated_at) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 1, now())
    ON CONFLICT (tbl) DO UPDATE SET version = d.version + 1, updated_at = now();
  END IF;
  RETURN NULL;
END $f$;
ALTER FUNCTION rcache.tg_bump() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rcache.tg_bump() FROM PUBLIC;
COMMENT ON FUNCTION rcache.tg_bump() IS '결과 캐시 추적 표 버전 카운터 +1(문장 트리거, 바뀐 행이 있을 때·TRUNCATE). DB-v2.11 P67';

DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app.brand', 'app.citation_category', 'app.citation_domain_override', 'app.hidden_market', 'app.owned_base',
                           'app.prompt', 'app.project_custom_field', 'app.prompt_custom_field_value', 'app.report_publication',
                           'app.rhq_region', 'app.rhq_region_country',
                           'rd.dim_country', 'rd.dim_region', 'rd.dim_project', 'rd.dim_brand_name', 'rd.dim_engine', 'rd.dim_entity',
                           'rd.dim_lang', 'rd.dim_prompt', 'rd.dim_source', 'rd.dim_taxon', 'rd.dim_url', 'rd.catalog_entry', 'rd.web_unit',
                           'rd.report_unit_value', 'rd.cycle'] LOOP
    INSERT INTO rcache.data_version (tbl, version) VALUES (t, 0);
    EXECUTE format('CREATE TRIGGER rcache_bump_ins AFTER INSERT ON %s REFERENCING NEW TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_upd AFTER UPDATE ON %s REFERENCING NEW TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_del AFTER DELETE ON %s REFERENCING OLD TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_trunc AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
  END LOOP;
END $v$;
INSERT INTO rcache.data_version (tbl, version) VALUES ('*manual*', 0);

-- ── P68 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.result_cache_version() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
SELECT 'g=' || coalesce((SELECT string_agg(g.surface::text || ':' || g.generation::text || ':' || coalesce(g.last_load_id::text, '-')
                                           || ':' || to_char(g.updated_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'), ',' ORDER BY g.surface)
                           FROM rd.surface_generation g), '')
    || '|jc=' || coalesce((SELECT max(c.change_id) FROM app.judgment_change c)::text, '0')
    || '|tv=' || (SELECT coalesce(sum(d.version), 0) FROM rcache.data_version d)::text
    || '|d=' || to_char(rd.today_kst(), 'YYYY-MM-DD')
$f$;

CREATE FUNCTION app.result_cache_lookup(p_prefix bytea) RETURNS TABLE (data_version text, codec text, body bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
SELECT v.dv, e.codec, e.body
  FROM (SELECT app.result_cache_version() AS dv) v
  LEFT JOIN rcache.entry e ON e.cache_key = sha256(p_prefix || convert_to(v.dv, 'UTF8'))
$f$;

CREATE FUNCTION app.result_cache_put(p_key bytea, p_route text, p_version text, p_codec text, p_body bytea, p_body_bytes int)
  RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  entry_max CONSTANT int := 4194304;        -- 저장(압축 후) 크기 상한 4 MiB
  total_max CONSTANT bigint := 268435456;   -- 전체 저장 크기 상한 256 MiB
  v text := left(p_version, 1000);
  added bigint;
  gone_b bigint;
  gone_n bigint;
  total bigint;
BEGIN
  IF p_key IS NULL OR octet_length(p_key) <> 32 THEN
    RAISE EXCEPTION 'result_cache_put: 키는 sha256 32바이트' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_codec IS NULL OR p_codec NOT IN ('identity', 'zlib') OR p_route IS NULL OR p_version IS NULL OR p_body IS NULL
     OR p_body_bytes IS NULL OR p_body_bytes < 0 THEN
    RAISE EXCEPTION 'result_cache_put: 인자 형식' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF octet_length(p_body) > entry_max THEN
    RETURN false;
  END IF;
  -- 저장: 새로 들어간 행만 누적(같은 키 동시 저장은 뒤쪽이 DO NOTHING = 0행)
  WITH ins AS (
    INSERT INTO rcache.entry (cache_key, route, data_version, codec, body, body_bytes, stored_bytes)
    VALUES (p_key, left(p_route, 200), v, p_codec, p_body, p_body_bytes, octet_length(p_body))
    ON CONFLICT (cache_key) DO NOTHING
    RETURNING stored_bytes)
  SELECT sum(stored_bytes) INTO added FROM ins;
  -- 낡은 버전 정리: 이 저장과 버전이 다르고 10분 지난 행(진행 중인 옛 스냅샷 요청이 새 행을 지우지 않게). 색인 두 범위(v 앞·뒤)만 읽는다
  WITH del AS (
    DELETE FROM rcache.entry e
     WHERE (e.data_version < v OR e.data_version > v) AND e.created_at < now() - interval '10 minutes'
    RETURNING e.stored_bytes)
  SELECT sum(stored_bytes), count(*) INTO gone_b, gone_n FROM del;
  INSERT INTO rcache.stat AS st (id, total_bytes, entries)
  VALUES (1, greatest(coalesce(added, 0) - coalesce(gone_b, 0), 0), greatest((added IS NOT NULL)::int - gone_n, 0))
  ON CONFLICT (id) DO UPDATE SET total_bytes = greatest(st.total_bytes + coalesce(added, 0) - coalesce(gone_b, 0), 0),
                                 entries = greatest(st.entries + (added IS NOT NULL)::int - gone_n, 0)
  RETURNING st.total_bytes INTO total;
  -- 전체 상한: 넘을 때만 오래된 행부터(이때만 표 전체를 본다)
  IF total > total_max THEN
    WITH del AS (
      DELETE FROM rcache.entry e
       USING (SELECT r.cache_key
                FROM (SELECT x.cache_key, sum(x.stored_bytes) OVER (ORDER BY x.created_at DESC, x.cache_key) AS run FROM rcache.entry x) r
               WHERE r.run > total_max) d
       WHERE e.cache_key = d.cache_key
      RETURNING e.stored_bytes)
    SELECT sum(stored_bytes), count(*) INTO gone_b, gone_n FROM del;
    UPDATE rcache.stat SET total_bytes = greatest(total_bytes - coalesce(gone_b, 0), 0), entries = greatest(entries - gone_n, 0) WHERE id = 1;
  END IF;
  RETURN true;
END $f$;

CREATE FUNCTION app.result_cache_invalidate() RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE gone_b bigint; gone_n bigint;
BEGIN
  UPDATE rcache.data_version SET version = version + 1, updated_at = now() WHERE tbl = '*manual*';
  WITH del AS (DELETE FROM rcache.entry RETURNING stored_bytes)
  SELECT sum(stored_bytes), count(*) INTO gone_b, gone_n FROM del;
  UPDATE rcache.stat SET total_bytes = greatest(total_bytes - coalesce(gone_b, 0), 0), entries = greatest(entries - gone_n, 0) WHERE id = 1;
  RETURN gone_n;
END $f$;

ALTER FUNCTION app.result_cache_version() OWNER TO hmg_owner;
ALTER FUNCTION app.result_cache_lookup(bytea) OWNER TO hmg_owner;
ALTER FUNCTION app.result_cache_put(bytea, text, text, text, bytea, int) OWNER TO hmg_owner;
ALTER FUNCTION app.result_cache_invalidate() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.result_cache_version(), app.result_cache_lookup(bytea),
  app.result_cache_put(bytea, text, text, text, bytea, int), app.result_cache_invalidate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.result_cache_version(), app.result_cache_lookup(bytea),
  app.result_cache_put(bytea, text, text, text, bytea, int) TO api_ro;
GRANT EXECUTE ON FUNCTION app.result_cache_invalidate() TO migrator;
COMMENT ON FUNCTION app.result_cache_version() IS '결과 캐시 데이터 버전 문자열(세대·judgment_change·app 표 카운터·KST 오늘). DB-v2.11 P68';
COMMENT ON FUNCTION app.result_cache_lookup(bytea) IS '결과 캐시 조회: (버전, 코덱, 바이트). 키 = sha256(접두 || 버전). DB-v2.11 P68';
COMMENT ON FUNCTION app.result_cache_put(bytea, text, text, text, bytea, int) IS
  '결과 캐시 저장(저장 크기 4 MiB 상한·낡은 버전 색인 범위 정리·rcache.stat 누적으로 전체 256 MiB 상한, 넘을 때만 오래된 행부터). DB-v2.11 P68';
COMMENT ON FUNCTION app.result_cache_invalidate() IS '결과 캐시 수동 무효화(*manual* +1, 전 행 삭제, stat 차감). migrator 전용. '
  'DB 패치 적용·적재 경로 밖 SQL(대역 밖 쓰기) 뒤 필수. DB-v2.11 P68';

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgfoid = 'rcache.tg_bump()'::regprocedure;
  IF n <> 104 THEN RAISE EXCEPTION 'P67 실패: 트리거 % 개(기대 104)', n; END IF;
  IF (SELECT count(*) FROM rcache.data_version) <> 27 THEN RAISE EXCEPTION 'P66 실패: 카운터 행'; END IF;
  IF (SELECT relpersistence FROM pg_class WHERE oid = 'rcache.entry'::regclass) <> 'u'
     OR (SELECT relpersistence FROM pg_class WHERE oid = 'rcache.stat'::regclass) <> 'u' THEN RAISE EXCEPTION 'P66 실패: UNLOGGED'; END IF;
  IF to_regclass('rcache.entry_version_created_idx') IS NULL THEN RAISE EXCEPTION 'P66 실패: 색인'; END IF;
  IF has_schema_privilege('api_ro', 'rcache', 'USAGE') OR has_table_privilege('api_ro', 'rcache.entry', 'SELECT')
     OR has_table_privilege('api_ro', 'rcache.entry', 'INSERT') OR has_table_privilege('api_rw', 'rcache.entry', 'INSERT')
     OR has_table_privilege('api_ro', 'rcache.data_version', 'SELECT') OR has_table_privilege('api_ro', 'rcache.stat', 'SELECT') THEN
    RAISE EXCEPTION 'P66 실패: 풀 롤이 rcache 표에 직접 권한을 가진다';
  END IF;
  IF NOT has_function_privilege('api_ro', 'app.result_cache_lookup(bytea)', 'execute')
     OR NOT has_function_privilege('api_ro', 'app.result_cache_put(bytea, text, text, text, bytea, int)', 'execute')
     OR NOT has_function_privilege('api_ro', 'app.result_cache_version()', 'execute')
     OR has_function_privilege('api_rw', 'app.result_cache_put(bytea, text, text, text, bytea, int)', 'execute')
     OR has_function_privilege('api_ro', 'app.result_cache_invalidate()', 'execute') THEN
    RAISE EXCEPTION 'P68 실패: 함수 실행 권한';
  END IF;
  IF NOT has_table_privilege('hmg_owner', 'rd.surface_generation', 'select') OR NOT has_table_privilege('hmg_owner', 'app.judgment_change', 'select')
     OR NOT has_function_privilege('hmg_owner', 'rd.today_kst()', 'execute') THEN
    RAISE EXCEPTION 'P68 실패: 정의자(hmg_owner)가 버전 원천을 읽지 못한다';
  END IF;
  PERFORM app.result_cache_version();
END $v$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.12 보완 패치 (PostgreSQL 17, 2026-09-30) · core 10(제품 책임자 전환 결정 3·4)
-- 적용 순서: DB-v2.11.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.12.sql = DB-v2.11.sql + 이 파일. 교체형(표·열 불변).
--
-- P69 app.user_account CHECK ua_country_scope 완화(결정 4: 중동 country 계정 bd942069 를 권역 단위로 유지).
--     country 역할 ∧ scope_all 거짓이면 국가 또는 권역 스코프가 하나 이상(ua_region_scope 와 같은 식). 종전 = 국가 필수(그래서 이관 R2 가
--     권역을 국가 7개로 전개했고, 비멤버 가시 목록에서 중동 밖 브랜드 공통 프로젝트 9개가 빠졌다).
--     현행 front 는 이 제약이 없다(profiles 에 CHECK 없음). 권역만 가진 country 계정의 데이터 범위 = 권역 전개(front effectiveScopeCountries,
--     백엔드 DataScope.countries), 비멤버 프로젝트 가시성 = projectInScope(scope-policy.ts:99-121: 계정 국가가 비면 국가 조건 없음, 브랜드 공통
--     프로젝트는 권역 밖도 보인다) = 백엔드 DataScope.project_in_scope. 국가·권역 둘 다 없는 country 계정(보류 2계정)은 여전히 거부한다.
-- P70 app.tg_user_account_scope 정본 표기 순서(결정 3: 계정 국가 표기를 정본으로). 대소문자 무시 일치 → rd.dim_country 코드 표기(빈 코드 제외)
--     → 없으면 app.rhq_region_country 표기 → 없으면 원문(참조 거부). 종전(P59) = rhq 먼저. rd.dim_country 코드가 API 응답·필터 옵션 코드의 정본
--     (F1 CANON_ORDER, DB-v2.10 P65 upper(code) 유일)이라 계정 저장 표기를 그 표기와 같게 한다. 두 원천 표기가 같으면 결과가 같다
--     (stg 2026-09-30 읽기 전용 실측: 계정 국가 원소 중 dim_country 표기와 다른 것 0).
--     이미 이관된 계정 보정: back/migration/fix-core10-account-scope.sql(stg 1회, 이 패치 뒤).
--
-- 결과 캐시(DB-v2.11, DECISIONS-API '결과 캐시' 무효화 절차): 이 패치를 적용한 뒤 migrator 로 `SELECT app.result_cache_invalidate();` 를 실행한다.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regnamespace('rcache') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.11 이 먼저 적용돼야 한다';
  END IF;
  IF position('scope_regions' in (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                   WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope')) > 0 THEN
    RAISE EXCEPTION 'DB-v2.12 이미 적용됨(ua_country_scope 가 권역을 받는다)';
  END IF;
END $v$;

-- ── P69 ─────────────────────────────────────────────────────────────────────
ALTER TABLE app.user_account
  DROP CONSTRAINT ua_country_scope,
  ADD CONSTRAINT ua_country_scope CHECK (role <> 'country' OR scope_all OR cardinality(scope_countries) + cardinality(scope_regions) > 0);
COMMENT ON CONSTRAINT ua_country_scope ON app.user_account IS
  'country 역할은 국가 또는 권역 스코프가 필요(권역만이면 데이터 = 권역 전개, 비멤버 가시성 = 국가 조건 없음: 현행 front projectInScope). DB-v2.12 P69';

-- ── P70 ─────────────────────────────────────────────────────────────────────
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
  -- 국가: 정본 표기(dim_country 코드 → rhq 국가 순, 대소문자 무시 일치)로 맞춘 뒤 참조 확인. 맞출 곳이 없으면 원문 그대로 두고 거부한다(P70).
  canon := ARRAY(
    SELECT c.y FROM (
      SELECT DISTINCT ON (s.y) s.y, s.i FROM (
        SELECT coalesce(
                 (SELECT d.code FROM rd.dim_country d WHERE d.code <> '' AND upper(d.code) = upper(u.x)
                   ORDER BY d.code = u.x DESC, d.code LIMIT 1),
                 (SELECT rc.country_code FROM app.rhq_region_country rc WHERE upper(rc.country_code) = upper(u.x)
                   ORDER BY rc.country_code = u.x DESC, rc.country_code LIMIT 1),
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
REVOKE EXECUTE ON FUNCTION app.tg_user_account_scope() FROM PUBLIC;

-- ── 적용 확인 ────────────────────────────────────────────────────────────────
DO $v$
DECLARE src text;
BEGIN
  IF position('scope_regions' in (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                   WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope')) = 0 THEN
    RAISE EXCEPTION 'P69 실패: ua_country_scope';
  END IF;
  IF NOT (SELECT convalidated FROM pg_constraint WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope') THEN
    RAISE EXCEPTION 'P69 실패: 검증되지 않은 제약';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'app.tg_user_account_scope()'::regprocedure;
  IF position('FROM rd.dim_country d WHERE d.code <> '''' AND upper(d.code)' in src) = 0
     OR position('FROM rd.dim_country d WHERE d.code <> '''' AND upper(d.code)' in src)
        > position('FROM app.rhq_region_country rc WHERE upper(rc.country_code)' in src)
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app.tg_user_account_scope()'::regprocedure) <> 'hmg_owner' THEN
    RAISE EXCEPTION 'P70 실패: 정본 표기 순서·소유자';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'app.user_account'::regclass AND NOT tgisinternal
                  AND tgfoid = 'app.tg_user_account_scope()'::regprocedure) THEN
    RAISE EXCEPTION 'P70 실패: 트리거 연결 없음';
  END IF;
END $v$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.13 보완 패치 (PostgreSQL 17, 2026-09-30) · 동기화 S1 BE-B: 글로벌 ⑤ 분자 = 출처 카테고리 Official (HMG) 인용 수
-- 적용 순서: DB-v2.12.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.13.sql = DB-v2.12.sql + 이 파일. 추가형(기존 열·값·권한 의미 불변).
-- 근거: hmg-geo 2670a16 #320(783478c)·#321(feddea7) lib/kpi/official-hmg-citations.ts(글로벌 ⑤ 분자 = resolveCitationCategory 가
--   'Official (HMG)' 인 인용 수, 오버라이드 포함), 제품 결정 Q2 (a)(2026-09-30: rd.answer 공식 인용 수 열 + citation_override 재판정 확장).
--
-- P71 rd.answer.cit_off int2 NOT NULL DEFAULT 0 = 호스트 있는 인용(rd.citation source_key <> 0, G-25 cit_n 과 같은 모수) 중
--     출처 차원 카테고리(rd.dim_source.category_key)가 app.citation_category name 'Official (HMG)' 인 수.
--     rd.dim_source.category_key 는 적재기 category_of(seed-3x-common.sql §9: 오버라이드 → 공식 소셜 → 공식 도메인 → 시드 → 규칙 → Other,
--     현행 resolveCitationCategory(rowCategory = null) 와 같은 순서)의 결과이고, 오버라이드 편집은 judgment_change 'citation_override'
--     재판정이 반영한다. 그래서 이 열은 "반영된 카테고리" 기준이다(조회 시 즉시 보이는 CATEGORY_EXPR 과는 재판정 전 구간에서만 다르다).
--     기존 행은 DEFAULT 0(파티션 부모 선언 → leaf 전파, 메타데이터만 바뀜, 표 재작성 없음). 값은 back/migration/fill-cit-off.sql 이 채운다.
--     CHECK answer_cit_off_bounds: 0 ≤ cit_off ≤ cit_n(행 단위 불변식, 기존 행은 0 이라 검증 스캔만).
--     공식 카테고리 키는 실행 시점에 app.citation_category name 으로 푼다(빈 DB 합본 적용 때는 코드표 행이 아직 없다: 선행 단언하지 않는다).
-- P72 불변식 ① 확장(G-25 와 같은 방식): rd.answer_cit_counts(int4[]) 반환 열에 cit_off 추가(반환 형이 바뀌어 DROP → CREATE),
--     rd._assert_answer_cit_counts(int4[]) 가 cit_off 까지 자식 합과 대조. 공개 단언 rd.assert_answer_cit_counts(int4[], bool)·(int4[]) 은
--     본문 그대로(내부 위임)라 적재기(apply.project 5만 청크, 엄격)·seed-40 §8(청크마다)·재판정이 새 열을 같은 트랜잭션에서 단언한다.
--
-- 이 열을 쓰는 곳(같은 트랜잭션 유지)
--   적재 FACT      ingest/project/apply/queries.py _ig_citc → INSERT_ANSWER (apply.project, 끝에 rd.assert_answer_cit_counts 엄격)
--   bulk           migration/seed/seed-40-facts.sql §6 _citc → §7 INSERT (§8 청크 단언)
--   재판정         citation_override: 출처 카테고리 재계산에서 'Official (HMG)' 여부가 바뀐 출처를 인용한 답변을 apply.project 로 재투영
--                  (ingest/project/apply/rejudge.py, process_change → finalize 세대 +1)
--   채우기(1회)    back/migration/fill-cit-off.sql(배치·멱등, 대역 밖 쓰기 → 결과 캐시 무효화 필요)
--
-- 적용 절차(stg·prod, 순서 고정)
--   ① 이 패치(migrator)  ② 채우기: psql -f back/migration/fill-cit-off.sql(드라이런) → -v commit=1  ③ back 배포(적재기·API 가 cit_off 를 읽고 쓴다)
--   ④ migrator 로 SELECT app.result_cache_invalidate();
--   ①~③ 사이 옛 적재기는 cit_off 를 채우지 않아 공식 인용이 있는 답변에서 단언이 실패한다(적재 트랜잭션 롤백, 데이터 불변, 배포 뒤 재시도).
--   적재 워커가 도는 환경이면 ①~③ 동안 멈춘다(stg 는 적재 워커·타이머 없음).
--
-- 결과 캐시(DB-v2.11, DECISIONS-API '결과 캐시' 무효화 절차): rd.answer 는 세대로만 덮는 사실 표라 이 패치·채우기(대역 밖 쓰기)는 데이터 버전을
--   올리지 않는다. 채우기 COMMIT 뒤(그리고 배포 뒤) migrator 로 `SELECT app.result_cache_invalidate();` 를 실행한다.
-- 규약: D8 예외 ②(답변 1:1 판정 열, G-25 와 같다). 새 btree 없음(HOT 유지: 재판정 제자리 UPDATE 대상 열을 색인에 넣지 않는다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF position('scope_regions' in coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                            WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope'), '')) = 0 THEN
    RAISE EXCEPTION 'DB-v2.12 이 먼저 적용돼야 한다';
  END IF;
  IF to_regprocedure('rd._assert_answer_cit_counts(int4[])') IS NULL OR to_regprocedure('rd.answer_cit_counts(int4[])') IS NULL THEN
    RAISE EXCEPTION 'G-25 인용 수 함수(DB-v2.2 P22·v2.3 P32)가 없다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_off' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.13 이미 적용됨(rd.answer.cit_off 존재)';
  END IF;
END $v$;

-- ── P71 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.answer ADD COLUMN cit_off int2 NOT NULL DEFAULT 0;
COMMENT ON COLUMN rd.answer.cit_off IS
  '호스트 있는 인용 중 출처 카테고리(rd.dim_source.category_key)가 Official (HMG) 인 수. 글로벌 ⑤ 인용 점유율 분자(hmg-geo #320·#321). DB-v2.13 P71';
ALTER TABLE rd.answer ADD CONSTRAINT answer_cit_off_bounds CHECK (cit_off BETWEEN 0 AND cit_n);

-- ── P72 ─────────────────────────────────────────────────────────────────────
DROP FUNCTION rd.answer_cit_counts(int4[]);
CREATE FUNCTION rd.answer_cit_counts(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4,
               cit_n int, cit_own_h int, cit_own_k int, cit_own_g int, cit_own_hc int, cit_own_kc int, cit_own_gc int,
               cit_own_x int, cit_loc int, cit_tgt int, cit_loc_tgt int, cit_off int)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $f$
DECLARE off int2 := (SELECT cc.category_key FROM app.citation_category cc WHERE cc.name = 'Official (HMG)');
BEGIN
  IF p_keys IS NULL THEN
    RETURN QUERY
    SELECT c.surface, c.round_date, c.answer_key,
           count(*)::int,
           count(*) FILTER (WHERE ob.bit = 1)::int, count(*) FILTER (WHERE ob.bit = 2)::int, count(*) FILTER (WHERE ob.bit = 4)::int,
           count(*) FILTER (WHERE ob.bit = 1 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 2 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 4 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit IN (1, 2, 4) AND ob.geo IS NOT NULL AND ob.geo IS DISTINCT FROM upper(g.code))::int,
           count(*) FILTER (WHERE c.loc_owned)::int, count(*) FILTER (WHERE c.tgt_hit)::int,
           count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit)::int,
           count(*) FILTER (WHERE s.category_key = off)::int
      FROM rd.citation c
      LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
                   FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
      LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
      LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
     WHERE c.source_key <> 0
     GROUP BY c.surface, c.round_date, c.answer_key;
  ELSE
    RETURN QUERY
    SELECT c.surface, c.round_date, c.answer_key,
           count(*)::int,
           count(*) FILTER (WHERE ob.bit = 1)::int, count(*) FILTER (WHERE ob.bit = 2)::int, count(*) FILTER (WHERE ob.bit = 4)::int,
           count(*) FILTER (WHERE ob.bit = 1 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 2 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit = 4 AND ob.geo = upper(g.code))::int,
           count(*) FILTER (WHERE ob.bit IN (1, 2, 4) AND ob.geo IS NOT NULL AND ob.geo IS DISTINCT FROM upper(g.code))::int,
           count(*) FILTER (WHERE c.loc_owned)::int, count(*) FILTER (WHERE c.tgt_hit)::int,
           count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit)::int,
           count(*) FILTER (WHERE s.category_key = off)::int
      FROM rd.job j
      JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
      LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
                   FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
      LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
      LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
     WHERE j.answer_key = ANY (p_keys) AND j.served AND c.source_key <> 0
     GROUP BY c.surface, c.round_date, c.answer_key;
  END IF;
END $f$;

-- 내부 단언(공개 판 rd.assert_answer_cit_counts(int4[], bool)·(int4[]) 이 위임): G-25 ① 에 cit_off 를 더한다
CREATE OR REPLACE FUNCTION rd._assert_answer_cit_counts(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE v int; n int;
BEGIN
  IF p_keys IS NULL THEN
    SELECT count(*), count(*) FILTER (WHERE
             (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
              a.cit_loc, a.cit_tgt, a.cit_loc_tgt, a.cit_off)
             IS DISTINCT FROM
             (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_own_h, 0)::int2, coalesce(x.cit_own_k, 0)::int2, coalesce(x.cit_own_g, 0)::int2,
              coalesce(x.cit_own_hc, 0)::int2, coalesce(x.cit_own_kc, 0)::int2, coalesce(x.cit_own_gc, 0)::int2, coalesce(x.cit_own_x, 0)::int2,
              coalesce(x.cit_loc, 0)::int2, coalesce(x.cit_tgt, 0)::int2, coalesce(x.cit_loc_tgt, 0)::int2, coalesce(x.cit_off, 0)::int2))
      INTO n, v
      FROM rd.answer a
      LEFT JOIN rd.answer_cit_counts(NULL) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key;
  ELSE
    SELECT count(*), count(*) FILTER (WHERE
             (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
              a.cit_loc, a.cit_tgt, a.cit_loc_tgt, a.cit_off)
             IS DISTINCT FROM
             (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_own_h, 0)::int2, coalesce(x.cit_own_k, 0)::int2, coalesce(x.cit_own_g, 0)::int2,
              coalesce(x.cit_own_hc, 0)::int2, coalesce(x.cit_own_kc, 0)::int2, coalesce(x.cit_own_gc, 0)::int2, coalesce(x.cit_own_x, 0)::int2,
              coalesce(x.cit_loc, 0)::int2, coalesce(x.cit_tgt, 0)::int2, coalesce(x.cit_loc_tgt, 0)::int2, coalesce(x.cit_off, 0)::int2))
      INTO n, v
      FROM rd.job j
      JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
      LEFT JOIN rd.answer_cit_counts(p_keys) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key
     WHERE j.answer_key = ANY (p_keys) AND j.served;
  END IF;
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.answer 인용 수 열 ≠ rd.citation 자식 합: % 답변(G-25 불변식)', v;          -- 종전 문구 유지(check-expected·운영 감시 호환)
  END IF;
  RETURN n;
END $f$;

ALTER FUNCTION rd.answer_cit_counts(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd._assert_answer_cit_counts(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.answer_cit_counts(int4[]), rd._assert_answer_cit_counts(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.answer_cit_counts(int4[]), rd._assert_answer_cit_counts(int4[]) TO loader, migrator;
COMMENT ON FUNCTION rd.answer_cit_counts(int4[]) IS
  '답변 키 집합의 인용 수(rd.citation 자식 합, 호스트 있는 인용): G-25 11열 + cit_off(출처 카테고리 Official (HMG)). NULL = 전체. DB-v2.13 P72';

-- ── 적용 확인(구조만: 기존 행 값 채우기는 fill-cit-off.sql 이 배치로 하고 청크마다 단언한다) ─────────
DO $v$
DECLARE src text; a record;
BEGIN
  SELECT t.typname, att.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS dflt INTO a
    FROM pg_attribute att JOIN pg_type t ON t.oid = att.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = att.attrelid AND d.adnum = att.attnum
   WHERE att.attrelid = 'rd.answer'::regclass AND att.attname = 'cit_off' AND NOT att.attisdropped;
  IF a IS NULL OR a.typname <> 'int2' OR NOT a.attnotnull OR a.dflt IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'P71 실패: rd.answer.cit_off 형·NOT NULL·기본값';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
              WHERE NOT EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'cit_off' AND NOT x.attisdropped)
                AND i.inhparent IN (SELECT 'rd.answer'::regclass UNION ALL SELECT inhrelid FROM pg_inherits WHERE inhparent = 'rd.answer'::regclass)) THEN
    RAISE EXCEPTION 'P71 실패: leaf 에 cit_off 전파 안 됨';
  END IF;
  IF NOT coalesce((SELECT convalidated FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass AND conname = 'answer_cit_off_bounds'), false) THEN
    RAISE EXCEPTION 'P71 실패: answer_cit_off_bounds 없음·미검증';
  END IF;
  IF NOT ('cit_off' = ANY ((SELECT proargnames FROM pg_proc WHERE oid = 'rd.answer_cit_counts(int4[])'::regprocedure)::text[])) THEN
    RAISE EXCEPTION 'P72 실패: rd.answer_cit_counts 반환 열에 cit_off 없음';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'rd._assert_answer_cit_counts(int4[])'::regprocedure;
  IF position('a.cit_off' in src) = 0 OR position('x.cit_off' in src) = 0 THEN
    RAISE EXCEPTION 'P72 실패: 단언이 cit_off 를 대조하지 않는다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('rd.answer_cit_counts(int4[])'::regprocedure, 'rd._assert_answer_cit_counts(int4[])'::regprocedure)
              AND pg_get_userbyid(proowner) <> 'hmg_owner')
     OR NOT has_function_privilege('loader', 'rd.answer_cit_counts(int4[])', 'execute')
     OR NOT has_function_privilege('loader', 'rd.assert_answer_cit_counts(int4[], bool)', 'execute')
     OR has_function_privilege('api_ro', 'rd.answer_cit_counts(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P72 실패: 소유자·실행 권한';
  END IF;
  -- 공개 단언 경로가 새 본문에 닿는지(빈 키 = 0 답변 검사, 예외 없음)
  PERFORM rd.assert_answer_cit_counts(ARRAY[]::int4[], true);
END $v$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.14 보완 패치 (PostgreSQL 17, 2026-09-30) · 원장 발행 게이트(제품 결정 16~18)
-- 적용 순서: DB-v2.13.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.14.sql = DB-v2.13.sql + 이 파일. 추가형(기존 열·값·권한 불변, 새 표 2·함수 1·NULL 열 1).
-- 근거: notes/hgh-impl/a4-decisions-batch.md 16~18, 설계 메모 publish-gate-design-20260930.md.
--   16 분모 = 회차 시작 시점 카탈로그의 활성 유닛(활성 프롬프트 × 프로젝트 엔진 × 측정 국가, 구조적 측정 불가 조합·도중 비활성 프롬프트 제외).
--      발송·싱크 누락은 분모에 남아 드러나야 한다(현행 expected_units = 답변 행이 있는 셀 수라 누락이 분모에서 사라진다).
--   17 자동 발행 = 활성 유닛 100% 완료(봉인 제외) ∧ 분석 비율 ≥ analysis_publish_ratio. 미달이면 알림, 운영자가 재측정·봉인(사유)·강제 발행(사유·감사).
--   18 적용 표면 = global·website. project 는 현행처럼 마감 즉시 노출.
--
-- P81 ing.cycle_unit  회차 계획(= 회차 개설 시점의 활성 유닛 스냅샷). 적재기가 회차를 열 때(ingest.cycles.ledger.attribute) 기록한다
--     (plan_source 'open'). 계획이 없는 미발행 게이트 회차(이관 origin summary_cycles·배포 창에 옛 코드가 연 회차)는 재평가 틱이 처음 볼 때
--     현재 카탈로그로 채운다(plan_source 'backfill', 앵커 뒤에 카탈로그에 들어온 프롬프트는 뺀다). 봉인 = sealed_* (사유 필수, 분모 제외,
--     운영 summary_cycles.sealed_units 와 같은 개념). 발행 뒤에는 쓰지 않는다(동결).
-- P82 ing.cycle_gate  회차별 게이트 상태(계획·활성·완료·봉인·도중 제외·빠짐 수, 판정 pass|blocked|forced, 강제 발행 감사 열, 알림 시각).
--     quiet = 이관 당시 이미 닫혀 있던 이관 회차(운영에서 발행하지 않은 잔여): 알림·노출 지체·발행 대기 감시에서 뺀다.
-- P83 ing.active_units(scope_project_id) 현재 카탈로그의 활성 유닛(프롬프트·엔진·국가, listed_at = 카탈로그 첫 등록 시각).
--       프롬프트  글로벌·고객 = app.prompt(그 Scope 프로젝트의 app.project, deleted_at NULL, scope_prompt_id 있음, scope_prompt_id 로 중복 제거)
--                 웹사이트    = app.website_prompt(그 Scope 프로젝트의 app.website_site, scope_prompt_id 있음)
--       국가      ing.prompt.regions(Scope 프롬프트 시장), NULL·빈 배열이면 ing.sync_cursor.regions(Scope 프로젝트 시장)
--                 (적재 판정 elig 과 같은 규약: ingest/project/apply/queries.py p_regions). app.prompt.regions 는 쓰지 않는다(가상 코드 x:* 포함).
--       엔진      app.project.ai_engines(비어 있지 않을 때) → app.rule_param default_engines
--       제외      app.rule_param unmeasurable_units = [{"target": "chatgpt", "region": "CN"}, …] (키 없으면 빈 목록, 대소문자 무시),
--                 ing.prompt.enabled = false(Scope 에서 꺼 둔 프롬프트, P84)
--     STABLE·호출자 권한(loader·migrator 실행). 발행 게이트 판정은 계획 ∩ 이 함수의 현재 결과 − 봉인 = 분모(도중 비활성 = 계획 ∖ 현재).
--
-- P84 ing.prompt.enabled bool NULL(제품 결정 21, 2026-10-01) = Scope 코어 prompts.enabled(Scope API 프롬프트 응답의 enabled). NULL = 모름
--     (활성으로 취급, 기존 동작 유지), false = 운영자가 Scope 에서 꺼 둔 프롬프트 → ing.active_units 에서 뺀다. 카탈로그(app.prompt·
--     app.website_prompt)와 화면은 바꾸지 않는다. 적재기 pull(ingest/pull/sync PROMPT_UPSERT)이 채우고, 이관 전 행은
--     back/migration/fill-prompt-enabled.sql 이 코어 값으로 1회 채운다. 추가형: NULL 허용·기본값 없음 열 추가(메타데이터만, 표 재작성 없음,
--     ACCESS EXCLUSIVE 순간 잠금 = lock_timeout 30s 안).
--     회차 도중 꺼진 프롬프트는 게이트 판정의 "계획 ∩ 현재 활성" 규칙으로 도중 제외(withdrawn)된다.
--
-- 쓰는 곳: ingest/cycles/ledger(attribute·reevaluate·cycle_admin seal·force_publish), ingest/cycles/watch(publish_gate 점검).
-- judgment_change 'cycle_admin' payload 확장(DDL 변경 없음, 계약 = app/core/contracts.py CycleAdmin):
--   {cycle_id, op: seal, reason, units?: [{prompt_id, target, region}]} · {cycle_id, op: force_publish, reason}
--
-- 적용 절차(stg·prod): ① 이 패치(migrator 또는 superuser) ② back 배포(적재기가 새 표·열을 쓴다)
--   ③ Scope 활성 여부 1회 채움(back/migration/fill-prompt-enabled.sql 머리말: 코어 SELECT 결과 → ing.prompt.enabled, 드라이런 → commit=1)
--   ④ 적재 틱 1회(python -m ingest.cli tick: 미발행 게이트 회차 계획 채움 + 판정, stg 는 워커·타이머가 없어 수동)
--   ①~② 사이 옛 적재기는 새 표·열을 모른다(무해): 그 사이 열린 회차는 ④ 에서 backfill 계획을 받는다.
--   ③ 을 ④ 보다 먼저 한다: 꺼진 프롬프트가 backfill 계획에 들어가지 않게(뒤에 채워도 "계획 ∩ 현재 활성"으로 빠지지만 plan_units 가 부풀어 보인다).
-- 결과 캐시: rd 를 바꾸지 않는다(rd.cycle 투영 열 불변). 규약: D8(사전 집계 없음) 준수, 새 표는 원장(ing) 판정 근거다.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_off' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.13 이 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('ing.cycle_unit') IS NOT NULL OR to_regclass('ing.cycle_gate') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'ing.prompt'::regclass AND attname = 'enabled' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.14 이미 적용됨(ing.cycle_unit·ing.cycle_gate 존재)';
  END IF;
END $v$;

-- ── P81 ─────────────────────────────────────────────────────────────────────
CREATE TABLE ing.cycle_unit (cycle_id uuid NOT NULL REFERENCES ing.cycle, prompt_id uuid NOT NULL, target text NOT NULL, region text NOT NULL,
  sealed_at timestamptz, seal_reason text, seal_change_id bigint, sealed_by uuid,
  PRIMARY KEY (cycle_id, prompt_id, target, region),
  CONSTRAINT cycle_unit_seal_pair CHECK ((sealed_at IS NULL) = (seal_reason IS NULL)),
  CONSTRAINT cycle_unit_seal_reason CHECK (seal_reason IS NULL OR length(btrim(seal_reason)) > 0));
COMMENT ON TABLE ing.cycle_unit IS '회차 계획 = 개설 시점 활성 유닛 스냅샷(발행 게이트 분모의 재료). 봉인 = 분모 제외(사유 필수). DB-v2.14 P81';

-- ── P82 ─────────────────────────────────────────────────────────────────────
CREATE TABLE ing.cycle_gate (cycle_id uuid PRIMARY KEY REFERENCES ing.cycle,
  plan_source text NOT NULL CHECK (plan_source IN ('open','backfill')), planned_at timestamptz NOT NULL DEFAULT now(),
  plan_units int NOT NULL DEFAULT 0, active_units int, done_units int, sealed_units int, withdrawn_units int, missing_units int,
  verdict text CHECK (verdict IN ('pass','blocked','forced')), evaluated_at timestamptz,
  quiet bool NOT NULL DEFAULT false, alerted_at timestamptz,
  forced_at timestamptz, forced_reason text, forced_by uuid, force_change_id bigint,
  CONSTRAINT cycle_gate_forced_pair CHECK ((forced_at IS NULL) = (forced_reason IS NULL)),
  CONSTRAINT cycle_gate_forced_reason CHECK (forced_reason IS NULL OR length(btrim(forced_reason)) > 0),
  CONSTRAINT cycle_gate_forced_verdict CHECK (verdict IS DISTINCT FROM 'forced' OR forced_at IS NOT NULL));
COMMENT ON TABLE ing.cycle_gate IS
  '발행 게이트 상태(global·website 비파생 회차). pass = 활성 유닛(계획 ∩ 현재 카탈로그 − 봉인) 전부 완료. forced = 운영자 강제 발행(사유·요청자). DB-v2.14 P82';

-- ── P84 (P83 함수 본문이 이 열을 참조하므로 먼저 만든다) ─────────────────────────
ALTER TABLE ing.prompt ADD COLUMN enabled bool;
COMMENT ON COLUMN ing.prompt.enabled IS
  'Scope 코어 prompts.enabled. NULL = 모름(활성 취급), false = Scope 에서 꺼 둠 → 발행 게이트 활성 유닛 제외(제품 결정 21). DB-v2.14 P84';

-- ── P83 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION ing.active_units(p_scope_project_id uuid)
RETURNS TABLE (prompt_id uuid, target text, region text, listed_at timestamptz)
LANGUAGE sql STABLE AS $f$
WITH cat AS (
  SELECT x.prompt_id, min(x.created_at) AS listed_at FROM (
    SELECT p.scope_prompt_id AS prompt_id, p.created_at FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id
     WHERE pr.scope_project_id = p_scope_project_id AND p.deleted_at IS NULL AND p.scope_prompt_id IS NOT NULL
    UNION ALL
    SELECT wp.scope_prompt_id, wp.created_at FROM app.website_prompt wp JOIN app.website_site s ON s.site_id = wp.site_id
     WHERE s.scope_project_id = p_scope_project_id AND wp.scope_prompt_id IS NOT NULL) x
  GROUP BY x.prompt_id),
eng AS (
  SELECT DISTINCT e.target FROM unnest(coalesce(
    (SELECT pr.ai_engines FROM app.project pr WHERE pr.scope_project_id = p_scope_project_id AND cardinality(pr.ai_engines) > 0),
    (SELECT ARRAY(SELECT jsonb_array_elements_text(rp.value)) FROM app.rule_param rp
      WHERE rp.key = 'default_engines' AND jsonb_typeof(rp.value) = 'array'),
    ARRAY[]::text[])) AS e(target)
   WHERE e.target IS NOT NULL AND e.target <> ''),
proj AS (SELECT (SELECT nullif(sc.regions, '{}'::text[]) FROM ing.sync_cursor sc WHERE sc.scope_project_id = p_scope_project_id) AS regions),
ex AS (
  SELECT lower(x ->> 'target') AS target, upper(x ->> 'region') AS region
    FROM app.rule_param rp
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(rp.value) = 'array' THEN rp.value ELSE '[]'::jsonb END) x
   WHERE rp.key = 'unmeasurable_units')
SELECT DISTINCT c.prompt_id, e.target, r.region, c.listed_at
  FROM cat c
  LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = c.prompt_id
  CROSS JOIN proj
  CROSS JOIN LATERAL unnest(coalesce(nullif(ip.regions, '{}'::text[]), proj.regions)) AS r(region)
  CROSS JOIN eng e
 WHERE r.region IS NOT NULL AND r.region <> ''
   AND ip.enabled IS DISTINCT FROM false
   AND NOT EXISTS (SELECT 1 FROM ex WHERE ex.target = lower(e.target) AND ex.region = upper(r.region))
$f$;
COMMENT ON FUNCTION ing.active_units(uuid) IS
  '현재 카탈로그 활성 유닛(프롬프트 × 엔진 × 국가, 구조적 불가 조합 제외). 발행 게이트 분모의 재료. DB-v2.14 P83';

-- ── 소유자·권한(이 패치는 superuser·migrator 로 적용되므로 명시 이전·부여) ──
ALTER TABLE ing.cycle_unit OWNER TO hmg_owner;
ALTER TABLE ing.cycle_gate OWNER TO hmg_owner;
ALTER FUNCTION ing.active_units(uuid) OWNER TO hmg_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ing.cycle_unit, ing.cycle_gate TO loader, migrator;
GRANT SELECT ON ing.cycle_unit, ing.cycle_gate TO loader_ro;
REVOKE EXECUTE ON FUNCTION ing.active_units(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ing.active_units(uuid) TO loader, migrator;

-- ── 사후 단언 ───────────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ing.cycle_unit'::regclass)) <> 'hmg_owner'
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ing.cycle_gate'::regclass)) <> 'hmg_owner'
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'ing.active_units(uuid)'::regprocedure)) <> 'hmg_owner' THEN
    RAISE EXCEPTION 'P81~P83 실패: 소유자';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'ing.prompt'::regclass AND attname = 'enabled' AND NOT attisdropped
                  AND atttypid = 'bool'::regtype AND NOT attnotnull AND NOT atthasdef) THEN
    RAISE EXCEPTION 'P84 실패: ing.prompt.enabled bool NULL 허용·기본값 없음';
  END IF;
  IF NOT has_table_privilege('loader', 'ing.cycle_unit', 'insert') OR NOT has_table_privilege('loader', 'ing.cycle_gate', 'update')
     OR NOT has_function_privilege('loader', 'ing.active_units(uuid)', 'execute')
     OR has_function_privilege('api_ro', 'ing.active_units(uuid)', 'execute') THEN
    RAISE EXCEPTION 'P81~P83 실패: 권한';
  END IF;
  -- 함수가 컴파일되고 빈 프로젝트에 빈 결과를 낸다
  PERFORM 1 FROM ing.active_units('00000000-0000-0000-0000-000000000000'::uuid);
END $v$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.15 보완 패치 (PostgreSQL 17, 2026-10-01) · 현행 값 재현 되돌림(제품 결정 19·23~25)이 쓸 열을 한 번에
-- 적용 순서: DB-v2.14.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.15.sql = DB-v2.14.sql + 이 파일.
-- 근거: notes/hgh-impl/revert-to-current-plan-20261001.md 5·7절(DDL 4건), perf-citations-r2-20261001.md 수정안 B(카테고리별 인용 수 13열).
--
-- 추가형: 기존 열·값·권한·함수 불변. 기존 표 ALTER 는 이 패치 한 번으로 모은다(표마다 ALTER 문장 1개).
--   새 열은 전부 NULL 허용·기본값 없음이다(메타데이터만 바뀜, 표 재작성·검증 스캔 없음). NULL = "아직 채우지 않음"이고, 기존 적재기(apply.project
--   INSERT_ANSWER·seed-40·seed-30·DIM_PROMPT_*)는 새 열을 모르므로 새 행도 NULL 로 들어간다. 그래서 이 패치 뒤에도 현 동작·현 적재가 그대로다.
--   값을 쓰는 곳은 채우기(back/migration/fill-v215.sql, 아래 함수)뿐이고, 적재기가 새 열을 쓰게 하는 것은 그 열을 읽는 WU 가 한다(아래 표).
--
-- P85 자식 표 대표 사본 is_rep bool NOT NULL DEFAULT false: rd.answer_brand·rd.answer_stance·rd.citation (A1 셀 대표, WU-2)
--     값 = 부모 rd.answer.is_rep 사본(계획서 5.1: 불리언 술어만으로 자식 표를 대표로 좁힌다. 세미조인 대안은 언급 화면 성능 위험 중).
--     상수 기본값 열이라 메타데이터만 바뀐다(PG11+ fast default, 표 재작성·검증 스캔 없음). 패치 직후 기존 자식 행은 전부 false(= 미채움과
--     같다) → back/migration/fill-v215-rep.sql 이 부모 값을 복사하고 단언한다(대표 행만 true 로 바뀌는 UPDATE). 그 전에는 cell_rep 을 켜지 않는다
--     (켜면 자식 표 모수가 0). NULL 을 두지 않는 이유: 대표 판정은 이진값이고, 새로 넣는 행이 기본값으로 들어와도 적재 트랜잭션 안에서
--     전파(rd.propagate_answer_gates)가 부모 값으로 맞춘다(아래). NOT NULL 로 가는 CHECK → VALIDATE → SET NOT NULL(ACCESS EXCLUSIVE)이 필요 없다.
--     대표 선정 규칙(WU-2, 현행 프로필 rep_pick_latest_first):
--       latest_first = 셀(surface, cyc_key, prompt, engine, geo) 서빙 답변 중 rd.job.measured_at DESC NULLS FIRST, job_id 1건을 먼저 굳히고
--                      그 답변이 elig_nc(P89) 가 아니면 셀 대표 없음(hmg-geo 2670a16 surface-global.ts:464-478·surface-website.ts:307-317 + 조회 게이트
--                      summary-trend-aggregates.ts:674-700. 글로벌 동률은 현행이 비결정이라 웹과 같은 job_id 오름차순으로 고정)
--       hub(기본)    = 셀 elig 후보 안 measured_at DESC NULLS LAST, answer_key DESC 1건(R05, 적재 REP_UPDATE·seed-40 §4)
--     hub 규칙은 is_rep ⇒ elig, 현행 규칙은 is_rep ⇒ elig_nc(카탈로그 무관, P89. 현행 선정은 카탈로그를 보지 않고 카탈로그는 조회 때 건다,
--     WU-4 병합 2026-10-01). 규칙 함수 rd.rep_expected 가 단일 정본이고, 적재기 REP_UPDATE 는 같은 식을 셀 임시 표에 쓴다(시험이 대조).
--     대표 선정 규칙 자체(현행 = 완료 측정 최신 1건을 먼저 굳힘, hub = elig 후보 안 최신)는 WU-2 가 정한다 → 여기서는 채우지 않는다.
--     전파: rd.propagate_answer_gates 를 이 패치에서 다시 만든다(is_rep 복사 + 사본 동치 단언에 추가, 나머지 본문은 DB-v2.13 과 같다).
--     적재기는 REP_UPDATE 가 뒤집은 다른 답변 키도 전파 대상에 넣는다(ingest.project.apply). seed-40 은 자식 INSERT 에 부모 값을 쓴다.
-- P86 rd.answer 인용 수 확장 14열 int2 NULL(G21A WU-5 + 인용 성능 수정안 B):
--     cit_n_all  = 답변의 모든 인용 원소 수(호스트 없는 인용 source_key = 0 포함). 현행 ⑤ 분모·GEO 국가 분모 정의(집계층, 호스트 무관).
--     cit_c1..cit_c13 = 호스트 있는 인용(source_key <> 0) 중 출처 차원 카테고리(rd.dim_source.category_key = app.citation_category 코드표 키
--                 1..13, fixture·seed-10 이 13 초과를 지운다)가 k 인 수. cit_off(P71)와 같은 "반영된 카테고리" 기준(오버라이드는 재판정 뒤).
--     CHECK(행 불변식, NULL 이면 통과): 14열은 전부 NULL 이거나 전부 값(answer_cit_ext_pair), cit_n_all ≥ cit_n ∧ 각 cit_c ≥ 0
--           (answer_cit_ext_bounds), Σ cit_c1..13 = cit_n(answer_cit_ext_cat_sum). cit_n 은 INSERT 로만 쓰인다(제자리 UPDATE 없음: 적재기·
--           seed-40 = INSERT, 재판정 = apply.project 재투영) → 채운 행의 cit_n 이 뒤에 혼자 바뀌어 CHECK 가 깨지는 경로가 없다.
-- P87 rd.answer.region_geo_key int2 NULL (GEOAX, WU-7): 답변 region(ing.answer.region)의 rd.dim_country geo_key(대소문자 무시, 없으면 0).
--     geo_key 는 웹사이트에서 사이트 국가 우선이라(적재 FACT_SRC) 현행 웹사이트 국가 경쟁 축(scope-aggregates.ts:7424 a.region)과 다르다.
--     global·project 는 적재 식이 같아 geo_key 와 같다: CHECK answer_region_geo_same(surface = 2 ∨ NULL ∨ region_geo_key = geo_key).
-- P88 rd.dim_prompt.cat_mask_all int2 NULL·in_root_catalog_all bool NULL (A41, WU-4): cat_mask·in_root_catalog(seed-30 §6·적재 DIM_PROMPT_*)와
--     같은 식에서 소프트 삭제 행(app.prompt.deleted_at)을 빼지 않은 값(현행 생성기 CAT_CTE surface-global.ts:117-135 는 삭제 행 브랜드를 넣는다).
--     CHECK: 둘이 함께 NULL(dim_prompt_cat_all_pair), 카탈로그 밖이면 비트 0(dim_prompt_cat_all_empty). "cat_mask_all ⊇ cat_mask" 는 확정
--     불변식이지만 CHECK 로 걸지 않는다: 지금 적재기(DIM_PROMPT_REFRESH)가 cat_mask 만 제자리 UPDATE 하므로 채운 뒤 카탈로그에 브랜드가 늘면
--     CHECK 가 적재를 깬다. 채우기 함수가 채운 시점에 단언하고, WU-4 가 적재기를 고친 뒤 CHECK 로 올린다.
--
-- 함수(전부 호출자 권한, 소유자 hmg_owner, 실행 = loader·migrator. api_ro 없음)
--   rd.answer_cit_ext(int4[])      답변 키 집합의 cit_n·cit_n_all·cit_c1..13 재계산(rd.citation 자식 합). NULL = 전체(무겁다)
--   rd.answer_region_geo(int4[])   답변 키 집합의 region_geo_key 재계산(rd.job → ing.answer_key_map → ing.answer.region → rd.dim_country)
--   rd.fill_answer_v215(int4[])    P86·P87 15열을 한 UPDATE 로 채움(값이 다른 행만, 서빙 답변만, 키 필수). 반환 = 갱신 행 수
--   rd.assert_answer_v215(int4[])  채운 행(cit_n_all NOT NULL)의 15열 = 재계산, 위반 시 예외. NULL = 채운 행 전부. 반환 = 검사 행 수
--   rd.fill_prompt_catalog_all()   P88 두 열 채움(전 행, 소형 표) + 채운 시점 ⊇ 단언. 반환 = 갱신 행 수
--   rd.fill_child_is_rep(int4[])   P85 자식 is_rep = 부모 사본(값이 다른 행만, 키 필수). 반환 = 갱신 행 수(fill-v215-rep.sql)
--   rd.rep_expected(int4[], bool)  P85 회차 키 집합(NULL = 전체)의 서빙 답변마다 대표 여부(규칙 = 둘째 인자 latest_first). 읽기 전용
--   rd.reselect_rep(int4[], bool)  P85 회차 키 집합의 rd.answer.is_rep 을 규칙대로 다시 고른다(값이 다른 행만, 키 필수). 자식은 안 건드린다
--   rd.assert_rep(int4[], bool)    P85 단언: is_rep ⇒ elig, 셀당 대표 ≤ 1, 자식 사본 = 부모, (둘째 인자가 NULL 이 아니면) 부모 = 규칙.
--                                  반환 = 검사한 답변 수. 대표의 acr_in 거짓(ACR 반복 동률 경계)은 예외가 아니라 NOTICE 로 센다
--   rd.propagate_answer_gates(int4[])  DB-v2.13 본문 + is_rep 사본(CREATE OR REPLACE, 소유자·권한 유지)
--   카테고리 키는 1..13 고정 열이라 app.citation_category 에 그 밖 키가 있으면 이 패치·채우기가 멈춘다(열 추가가 필요하다는 뜻).
--
-- 누가 언제 쓰나(열 → 읽는 WU, 적재기가 쓰게 바꿀 WU)
--   is_rep(자식)      WU-2(A1)         적재 = WU-2(전파·seed-40)
--   cit_n_all         WU-5(G21A)       적재 = WU-5(INSERT_ANSWER·seed-40·rd.assert_answer_cit_counts 확장 또는 assert_answer_v215 편입)
--   cit_c1..13        WU-5(인용 성능 B) 적재 = WU-5(같은 자리) + citation_override 재투영을 "유효 카테고리 변경" 전체로 확장
--   region_geo_key    WU-7(GEOAX)      적재 = WU-7
--   cat_mask_all 등   WU-4(A41)        적재 = WU-4(DIM_PROMPT_INSERT·REFRESH·seed-30)
--
-- 락: 한 트랜잭션에서 rd.answer·answer_brand·answer_stance·citation(파티션 전부)과 rd.dim_prompt 에 ACCESS EXCLUSIVE 를 잠깐 잡는다.
--   ADD COLUMN(NULL, 기본값 없음)은 메타데이터만, rd.answer CHECK 는 NOT VALID 로 붙여 검증 스캔이 없다(새 행·갱신 행만 검사).
--   검증(VALIDATE CONSTRAINT = SHARE UPDATE EXCLUSIVE, 읽기·쓰기 안 막음)은 채우기 끝에서 한다(fill-v215.sql). rd.dim_prompt 는 소형이라
--   검증된 CHECK 로 바로 붙인다(ms 단위 스캔). lock_timeout 30s: 긴 읽기 트랜잭션이 잡고 있으면 실패하고 아무것도 바뀌지 않는다(재시도).
--   적용 창에는 API·데우기·적재를 멈춘다(여러 표를 같은 트랜잭션에서 잠그므로 읽기와 잠금 순서가 엇갈리면 교착 감지로 한쪽이 죽는다).
--
-- 적용 절차(stg·prod): ① 이 패치(migrator 또는 superuser) ② 채우기 psql -f back/migration/fill-v215.sql(드라이런) → -v commit=1
--   (끝에 VALIDATE CONSTRAINT) ②' 대표 채우기 psql -f back/migration/fill-v215-rep.sql(드라이런) → -v commit=1(P85 자식 is_rep, 적재 워커 정지·
--   WU-2 코드 배포 뒤) ③ migrator 로 SELECT app.result_cache_invalidate();(rd.answer 는 데이터 버전 추적 표가 아니다. 새 열을 읽는
--   코드가 없어 응답은 안 바뀌지만 대역 밖 쓰기 규약대로). 배포 순서 제약 없음: 이 패치를 모르는 코드도 그대로 돈다(옛 적재기는 자식 is_rep 을
--   모르지만 새 전파 함수가 부모 사본을 쓴다. 옛 적재기가 뒤집은 다른 답변의 자식만 어긋나고 ②' 와 rd.assert_rep 이 잡는다).
-- 결과 캐시: rd.dim_prompt 는 추적 표라 채우기 UPDATE 가 데이터 버전을 올린다(rcache.tg_bump). 규약: D8 예외 ②(답변 1:1 판정 열, G-25·P71 과 같다).
-- 새 btree 없음(HOT 유지: 채우기 UPDATE 대상 열을 색인에 넣지 않는다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('ing.cycle_gate') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.14 가 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname IN ('cit_n_all', 'region_geo_key') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.dim_prompt'::regclass AND attname = 'cat_mask_all' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('rd.answer_brand'::regclass, 'rd.answer_stance'::regclass, 'rd.citation'::regclass)
                  AND attname = 'is_rep' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.15 이미 적용됨(rd.answer.cit_n_all·region_geo_key, rd.dim_prompt.cat_mask_all, 자식 is_rep 중 하나 존재)';
  END IF;
  -- 카테고리 열은 1..13 고정(빈 DB 합본 적용 때는 코드표 행이 아직 없다: 있을 때만 검사)
  IF EXISTS (SELECT 1 FROM app.citation_category WHERE category_key NOT BETWEEN 1 AND 13) THEN
    RAISE EXCEPTION 'app.citation_category 에 1..13 밖 키가 있다: cit_c 열 추가가 먼저 필요하다';
  END IF;
END $v$;

-- ── P85 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.answer_brand ADD COLUMN is_rep bool NOT NULL DEFAULT false;
ALTER TABLE rd.answer_stance ADD COLUMN is_rep bool NOT NULL DEFAULT false;
ALTER TABLE rd.citation ADD COLUMN is_rep bool NOT NULL DEFAULT false;
COMMENT ON COLUMN rd.answer_brand.is_rep IS
  '부모 rd.answer.is_rep 사본(A1 셀 대표, WU-2). rd.propagate_answer_gates 로만 갱신(패치 직후 false = 미채움, fill-v215-rep.sql). DB-v2.15 P85';
COMMENT ON COLUMN rd.answer_stance.is_rep IS
  '부모 rd.answer.is_rep 사본(A1 셀 대표, WU-2). rd.propagate_answer_gates 로만 갱신(패치 직후 false = 미채움, fill-v215-rep.sql). DB-v2.15 P85';
COMMENT ON COLUMN rd.citation.is_rep IS
  '부모 rd.answer.is_rep 사본(A1 셀 대표, WU-2). rd.propagate_answer_gates 로만 갱신(패치 직후 false = 미채움, fill-v215-rep.sql). DB-v2.15 P85';

-- ── P86·P87 (rd.answer 는 ALTER 한 문장: 열 15개 + CHECK 4개, NOT VALID = 검증 스캔 없음) ──────────────
ALTER TABLE rd.answer
  ADD COLUMN cit_n_all int2, ADD COLUMN cit_c1 int2, ADD COLUMN cit_c2 int2, ADD COLUMN cit_c3 int2, ADD COLUMN cit_c4 int2,
  ADD COLUMN cit_c5 int2, ADD COLUMN cit_c6 int2, ADD COLUMN cit_c7 int2, ADD COLUMN cit_c8 int2, ADD COLUMN cit_c9 int2,
  ADD COLUMN cit_c10 int2, ADD COLUMN cit_c11 int2, ADD COLUMN cit_c12 int2, ADD COLUMN cit_c13 int2,
  ADD COLUMN region_geo_key int2,
  ADD CONSTRAINT answer_cit_ext_pair CHECK (num_nulls(cit_n_all, cit_c1, cit_c2, cit_c3, cit_c4, cit_c5, cit_c6, cit_c7, cit_c8, cit_c9,
                                                      cit_c10, cit_c11, cit_c12, cit_c13) IN (0, 14)) NOT VALID,
  ADD CONSTRAINT answer_cit_ext_bounds CHECK (cit_n_all >= cit_n
                                              AND least(cit_c1, cit_c2, cit_c3, cit_c4, cit_c5, cit_c6, cit_c7, cit_c8, cit_c9, cit_c10,
                                                        cit_c11, cit_c12, cit_c13) >= 0) NOT VALID,
  ADD CONSTRAINT answer_cit_ext_cat_sum CHECK (cit_c1 + cit_c2 + cit_c3 + cit_c4 + cit_c5 + cit_c6 + cit_c7 + cit_c8 + cit_c9 + cit_c10
                                               + cit_c11 + cit_c12 + cit_c13 = cit_n) NOT VALID,
  ADD CONSTRAINT answer_region_geo_same CHECK (surface = 2 OR region_geo_key IS NULL OR region_geo_key = geo_key) NOT VALID;
COMMENT ON COLUMN rd.answer.cit_n_all IS
  '모든 인용 원소 수(호스트 없는 인용 source_key = 0 포함). 현행 ⑤ 분모·GEO 국가 분모(G21A, WU-5). NULL = 아직 채우지 않음. DB-v2.15 P86';
COMMENT ON COLUMN rd.answer.cit_c1 IS
  '호스트 있는 인용 중 출처 카테고리 키 1 인 수(cit_c1..cit_c13 = app.citation_category 1..13, 합 = cit_n). 인용 성능 수정안 B. DB-v2.15 P86';
COMMENT ON COLUMN rd.answer.region_geo_key IS
  '답변 region(ing.answer.region)의 rd.dim_country geo_key(없으면 0). 웹사이트 국가 경쟁 현행 축(GEOAX, WU-7). global·project 는 geo_key 와 같다. DB-v2.15 P87';

-- ── P88 (소형 표: 검증된 CHECK) ───────────────────────────────────────────────
ALTER TABLE rd.dim_prompt
  ADD COLUMN cat_mask_all int2, ADD COLUMN in_root_catalog_all bool,
  ADD CONSTRAINT dim_prompt_cat_all_pair CHECK ((cat_mask_all IS NULL) = (in_root_catalog_all IS NULL)),
  ADD CONSTRAINT dim_prompt_cat_all_empty CHECK (in_root_catalog_all OR cat_mask_all = 0);
COMMENT ON COLUMN rd.dim_prompt.cat_mask_all IS
  'cat_mask 와 같은 식에서 소프트 삭제 루트 카탈로그 행을 빼지 않은 브랜드 비트 OR(A41, WU-4). NULL = 아직 채우지 않음. DB-v2.15 P88';
COMMENT ON COLUMN rd.dim_prompt.in_root_catalog_all IS
  'in_root_catalog 와 같은 식에서 소프트 삭제 행을 빼지 않은 값(A41, WU-4). NULL = 아직 채우지 않음. DB-v2.15 P88';

-- ── P89~P90 열·CHECK(WU-4 A41·G20. 설명·함수는 아래 "P89~P90" 구간) ────────────────────────
ALTER TABLE rd.answer
  ADD COLUMN elig_nc bool, ADD COLUMN std_in_nc bool, ADD COLUMN cit_in_nc bool,
  ADD CONSTRAINT answer_nc_pair CHECK (num_nulls(elig_nc, std_in_nc, cit_in_nc) IN (0, 3)) NOT VALID,
  ADD CONSTRAINT answer_nc_rule CHECK (elig_nc IS NULL OR (
        cit_in_nc = (elig_nc AND NOT (is_acr AND acr_iter_rank > 1))
    AND std_in_nc = (cit_in_nc AND analysis_state < 2)
    AND (NOT elig OR elig_nc)
    AND (surface = 1 OR elig_nc = elig))) NOT VALID;
ALTER TABLE rd.answer_brand
  ADD COLUMN std_in_nc bool, ADD COLUMN rid_n int2,
  ADD CONSTRAINT answer_brand_rid_n CHECK (rid_n IS NULL OR rid_n BETWEEN 1 AND entity_rows) NOT VALID;
ALTER TABLE rd.answer_stance ADD COLUMN std_in_nc bool;
ALTER TABLE rd.citation ADD COLUMN cit_in_nc bool;
ALTER TABLE rd.dim_prompt
  ADD CONSTRAINT dim_prompt_cat_all_sup CHECK (cat_mask_all IS NULL OR ((cat_mask_all & cat_mask) = cat_mask AND (in_root_catalog_all OR NOT in_root_catalog)));
COMMENT ON COLUMN rd.answer.elig_nc IS
  'elig 에서 루트 카탈로그 소속(in_root_catalog) 항만 뺀 값(카탈로그 무관 게이트). A41 모수 열·현행 대표 규칙(rep_pick_latest_first) 게이트. NULL = 아직 채우지 않음. DB-v2.15 P89';
COMMENT ON COLUMN rd.answer.std_in_nc IS
  'std_in 에서 루트 카탈로그 소속 항만 뺀 언급 모수(elig_nc ∧ acr_in ∧ 분석 있음). A41 현행 프로필(카탈로그 = 삭제 행 포함 세미조인)용. NULL = 아직 채우지 않음. DB-v2.15 P89';
COMMENT ON COLUMN rd.answer.cit_in_nc IS
  'cit_in 에서 루트 카탈로그 소속 항만 뺀 인용 모수(elig_nc ∧ acr_in). A41 현행 프로필용. NULL = 아직 채우지 않음. DB-v2.15 P89';
COMMENT ON COLUMN rd.answer_brand.std_in_nc IS '부모 rd.answer.std_in_nc 사본(A41). DB-v2.15 P89';
COMMENT ON COLUMN rd.answer_stance.std_in_nc IS '부모 rd.answer.std_in_nc 사본(A41). DB-v2.15 P89';
COMMENT ON COLUMN rd.citation.cit_in_nc IS '부모 rd.answer.cit_in_nc 사본(A41). DB-v2.15 P89';
COMMENT ON COLUMN rd.answer_brand.rid_n IS
  '이 행 언급들의 서로 다른 롤업 id(J1 rid) 수. G20 현행 노출 답변 수 = sum(rid_n)(fold.ts:468,486). NULL = 아직 채우지 않음. DB-v2.15 P89';


-- ── 함수: 재계산 ──────────────────────────────────────────────────────────────
-- 위치는 rd.job(answer_key PK)에서 파티션 좌표를 얻어 등치 조인(rd.answer_cit_counts·propagate_answer_gates 와 같은 이유).
CREATE FUNCTION rd.answer_cit_ext(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4, cit_n int, cit_n_all int,
               cit_c1 int, cit_c2 int, cit_c3 int, cit_c4 int, cit_c5 int, cit_c6 int, cit_c7 int, cit_c8 int, cit_c9 int, cit_c10 int,
               cit_c11 int, cit_c12 int, cit_c13 int)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT c.surface, c.round_date, c.answer_key,
       count(*) FILTER (WHERE c.source_key <> 0)::int, count(*)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 1)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 2)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 3)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 4)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 5)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 6)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 7)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 8)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 9)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 10)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 11)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 12)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 13)::int
  FROM rd.citation c
  LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
 WHERE p_keys IS NULL
 GROUP BY c.surface, c.round_date, c.answer_key
UNION ALL
SELECT c.surface, c.round_date, c.answer_key,
       count(*) FILTER (WHERE c.source_key <> 0)::int, count(*)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 1)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 2)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 3)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 4)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 5)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 6)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 7)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 8)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 9)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 10)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 11)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 12)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 13)::int
  FROM rd.job j
  JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
  LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
 WHERE p_keys IS NOT NULL AND j.answer_key = ANY (p_keys) AND j.served
 GROUP BY c.surface, c.round_date, c.answer_key
$f$;

CREATE FUNCTION rd.answer_region_geo(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4, region_geo_key int2)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT j.surface, j.round_date, j.answer_key, coalesce(g.geo_key, 0::int2)
  FROM rd.job j
  JOIN ing.answer_key_map m ON m.job_id = j.job_id
  JOIN ing.answer ia ON ia.run_month = m.run_month AND ia.job_id = j.job_id
  LEFT JOIN rd.dim_country g ON upper(g.code) = upper(ia.region)
 WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys))
$f$;

-- ── 함수: 채우기·단언 ────────────────────────────────────────────────────────
CREATE FUNCTION rd.fill_answer_v215(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int;
BEGIN
  IF p_keys IS NULL THEN
    RAISE EXCEPTION 'rd.fill_answer_v215: 키 배열 필수(배치로 나눠 부른다, back/migration/fill-v215.sql)';
  END IF;
  UPDATE rd.answer a
     SET cit_n_all = coalesce(x.cit_n_all, 0)::int2,
         cit_c1 = coalesce(x.cit_c1, 0)::int2, cit_c2 = coalesce(x.cit_c2, 0)::int2, cit_c3 = coalesce(x.cit_c3, 0)::int2,
         cit_c4 = coalesce(x.cit_c4, 0)::int2, cit_c5 = coalesce(x.cit_c5, 0)::int2, cit_c6 = coalesce(x.cit_c6, 0)::int2,
         cit_c7 = coalesce(x.cit_c7, 0)::int2, cit_c8 = coalesce(x.cit_c8, 0)::int2, cit_c9 = coalesce(x.cit_c9, 0)::int2,
         cit_c10 = coalesce(x.cit_c10, 0)::int2, cit_c11 = coalesce(x.cit_c11, 0)::int2, cit_c12 = coalesce(x.cit_c12, 0)::int2,
         cit_c13 = coalesce(x.cit_c13, 0)::int2,
         region_geo_key = g.region_geo_key
    FROM rd.job j
    JOIN rd.answer_region_geo(p_keys) g ON g.answer_key = j.answer_key
    LEFT JOIN rd.answer_cit_ext(p_keys) x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND j.served
     AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
     AND (a.cit_n_all, a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10, a.cit_c11,
          a.cit_c12, a.cit_c13, a.region_geo_key)
         IS DISTINCT FROM
         (coalesce(x.cit_n_all, 0)::int2, coalesce(x.cit_c1, 0)::int2, coalesce(x.cit_c2, 0)::int2, coalesce(x.cit_c3, 0)::int2,
          coalesce(x.cit_c4, 0)::int2, coalesce(x.cit_c5, 0)::int2, coalesce(x.cit_c6, 0)::int2, coalesce(x.cit_c7, 0)::int2,
          coalesce(x.cit_c8, 0)::int2, coalesce(x.cit_c9, 0)::int2, coalesce(x.cit_c10, 0)::int2, coalesce(x.cit_c11, 0)::int2,
          coalesce(x.cit_c12, 0)::int2, coalesce(x.cit_c13, 0)::int2, g.region_geo_key);
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 서빙 답변인데 ing.answer 가 없어 region 을 못 풀면(적재 원장 불일치) 조용히 NULL 로 남기지 않는다
  IF EXISTS (SELECT 1 FROM rd.job j
               JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
              WHERE j.answer_key = ANY (p_keys) AND j.served AND (a.cit_n_all IS NULL OR a.region_geo_key IS NULL)) THEN
    RAISE EXCEPTION 'rd.fill_answer_v215: 채우지 못한 서빙 답변이 있다(ing.answer_key_map·ing.answer 누락)';
  END IF;
  RETURN n;
END $f$;

CREATE FUNCTION rd.assert_answer_v215(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE
           (a.cit_n, a.cit_n_all, a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10,
            a.cit_c11, a.cit_c12, a.cit_c13, a.region_geo_key)
           IS DISTINCT FROM
           (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_n_all, 0)::int2, coalesce(x.cit_c1, 0)::int2, coalesce(x.cit_c2, 0)::int2,
            coalesce(x.cit_c3, 0)::int2, coalesce(x.cit_c4, 0)::int2, coalesce(x.cit_c5, 0)::int2, coalesce(x.cit_c6, 0)::int2,
            coalesce(x.cit_c7, 0)::int2, coalesce(x.cit_c8, 0)::int2, coalesce(x.cit_c9, 0)::int2, coalesce(x.cit_c10, 0)::int2,
            coalesce(x.cit_c11, 0)::int2, coalesce(x.cit_c12, 0)::int2, coalesce(x.cit_c13, 0)::int2, g.region_geo_key))
    INTO n, v
    FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    LEFT JOIN rd.answer_region_geo(p_keys) g ON g.answer_key = j.answer_key
    LEFT JOIN rd.answer_cit_ext(p_keys) x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys))
     AND a.cit_n_all IS NOT NULL;
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.answer DB-v2.15 열(cit_n_all·cit_c1..13·region_geo_key) ≠ 재계산: % 답변', v;
  END IF;
  RETURN n;
END $f$;

CREATE FUNCTION rd.fill_prompt_catalog_all() RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v int;
BEGIN
  -- seed-30 §6·적재 DIM_PROMPT_*(cat_bits·in_root_catalog)와 같은 식, deleted_at 술어만 없다
  WITH root_cat AS (SELECT p.scope_prompt_id, p.brand_code FROM app.prompt p
                      JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
                     WHERE p.scope_prompt_id IS NOT NULL),
  cat_bits AS (SELECT c.scope_prompt_id, bit_or(coalesce(b.brand_bit, u.brand_bit))::int2 AS m
                 FROM root_cat c LEFT JOIN app.brand b ON b.brand_code = c.brand_code
                 CROSS JOIN (SELECT brand_bit FROM app.brand WHERE is_umbrella) u GROUP BY 1),
  nv AS (SELECT d.prompt_key, coalesce(cb.m, 0)::int2 AS m, cb.scope_prompt_id IS NOT NULL AS r
           FROM rd.dim_prompt d LEFT JOIN cat_bits cb ON cb.scope_prompt_id = d.prompt_id)
  UPDATE rd.dim_prompt d SET cat_mask_all = nv.m, in_root_catalog_all = nv.r
    FROM nv WHERE nv.prompt_key = d.prompt_key AND (d.cat_mask_all, d.in_root_catalog_all) IS DISTINCT FROM (nv.m, nv.r);
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 채운 시점 단언: 삭제 포함 집합 ⊇ 비삭제 집합(cat_mask·in_root_catalog 가 최신 판정일 때 성립. 어긋나면 dim_prompt 재판정 누락)
  SELECT count(*) INTO v FROM rd.dim_prompt
   WHERE cat_mask_all IS NULL OR (cat_mask_all & cat_mask) <> cat_mask OR (in_root_catalog AND NOT in_root_catalog_all);
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.dim_prompt cat_mask_all ⊉ cat_mask 또는 미채움: % 행(재판정 누락 가능)', v;
  END IF;
  RETURN n;
END $f$;

CREATE FUNCTION rd.fill_child_is_rep(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
-- 부모 rd.answer.is_rep 을 자식 사본으로 복사(값이 다른 행만). 1회 채우기(fill-v215-rep.sql)·재선정 뒤 복사용. 적재는 propagate_answer_gates.
DECLARE n int := 0; m int;
BEGIN
  IF p_keys IS NULL THEN
    RAISE EXCEPTION 'rd.fill_child_is_rep: 키 배열 필수';
  END IF;
  UPDATE rd.answer_brand c SET is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.is_rep IS DISTINCT FROM a.is_rep;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.is_rep IS DISTINCT FROM a.is_rep;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.is_rep IS DISTINCT FROM a.is_rep;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  RETURN n;
END $f$;

-- 대표 규칙 단일 정본(P85). 회차 키로 좁혀 rd.cycle 에서 파티션 좌표(surface, round_date)를 얻어 등치 조인한다(leaf 가지치기).
CREATE FUNCTION rd.rep_expected(p_cyc_keys int4[], p_latest_first bool)
RETURNS TABLE (surface int2, round_date date, answer_key int4, rep bool)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT x.surface, x.round_date, x.answer_key,
       (CASE WHEN p_latest_first THEN x.elig_nc ELSE x.elig END) AND (CASE WHEN p_latest_first THEN x.rn_all ELSE x.rn_elig END) = 1
  FROM (SELECT a.surface, a.round_date, a.answer_key, a.elig, a.elig_nc,
               row_number() OVER (PARTITION BY a.surface, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key
                                  ORDER BY j.measured_at DESC NULLS FIRST, j.job_id) AS rn_all,
               row_number() OVER (PARTITION BY a.surface, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key, a.elig
                                  ORDER BY j.measured_at DESC NULLS LAST, a.answer_key DESC) AS rn_elig
          FROM rd.cycle c
          JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key
          JOIN rd.job j ON j.answer_key = a.answer_key
         WHERE p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) x
$f$;

CREATE FUNCTION rd.reselect_rep(p_cyc_keys int4[], p_latest_first bool) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
-- 회차 전체 셀의 부모 대표를 규칙대로 다시 고른다(값이 다른 행만). 자식 사본은 호출자가 rd.fill_child_is_rep 로 맞춘다(fill-v215-rep.sql).
DECLARE n int;
BEGIN
  IF p_cyc_keys IS NULL OR p_latest_first IS NULL THEN
    RAISE EXCEPTION 'rd.reselect_rep: 회차 키 배열·규칙 필수';
  END IF;
  -- 현행 규칙의 게이트 = elig_nc(P89). 미채움(NULL)이면 대표가 NULL 로 계산돼 조용히 어긋나므로 먼저 멈춘다(fill-v215.sql §P89 먼저)
  IF p_latest_first AND EXISTS (SELECT 1 FROM rd.cycle c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date
                                   AND a.cyc_key = c.cyc_key WHERE c.cyc_key = ANY (p_cyc_keys) AND a.elig_nc IS NULL) THEN
    RAISE EXCEPTION 'rd.reselect_rep: 현행 규칙은 rd.answer.elig_nc 가 채워져 있어야 한다(fill-v215.sql §P89 먼저)';
  END IF;
  UPDATE rd.answer a SET is_rep = e.rep
    FROM rd.rep_expected(p_cyc_keys, p_latest_first) e
   WHERE a.surface = e.surface AND a.round_date = e.round_date AND a.answer_key = e.answer_key AND a.is_rep IS DISTINCT FROM e.rep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION rd.assert_rep(p_cyc_keys int4[], p_latest_first bool) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v_rule int := 0; v_elig int; v_multi int; v_child int; v_acr int;
BEGIN
  -- is_rep ⇒ 게이트: hub 규칙 = elig, 현행 규칙 = 카탈로그 무관 elig_nc(P89, WU-4). 규칙을 모르면(NULL) 둘 다 함의하는 elig_nc(미채움이면 elig)
  SELECT count(*), count(*) FILTER (WHERE a.is_rep AND NOT (CASE WHEN p_latest_first IS FALSE THEN a.elig ELSE coalesce(a.elig_nc, a.elig) END)),
         count(*) FILTER (WHERE a.is_rep AND NOT a.acr_in)
    INTO n, v_elig, v_acr
    FROM rd.cycle c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key
   WHERE p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys);
  SELECT count(*) INTO v_multi FROM (
    SELECT 1 FROM rd.cycle c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key
     WHERE (p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) AND a.is_rep
     GROUP BY a.surface, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key HAVING count(*) > 1) m;
  IF p_latest_first IS NOT NULL THEN
    SELECT count(*) INTO v_rule FROM rd.rep_expected(p_cyc_keys, p_latest_first) e
      JOIN rd.answer a ON a.surface = e.surface AND a.round_date = e.round_date AND a.answer_key = e.answer_key
     WHERE a.is_rep IS DISTINCT FROM e.rep;
  END IF;
  SELECT (SELECT count(*) FROM rd.cycle c JOIN rd.answer_brand x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
            JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
           WHERE (p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) AND x.is_rep IS DISTINCT FROM a.is_rep)
       + (SELECT count(*) FROM rd.cycle c JOIN rd.answer_stance x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
            JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
           WHERE (p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) AND x.is_rep IS DISTINCT FROM a.is_rep)
       + (SELECT count(*) FROM rd.cycle c JOIN rd.citation x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
            JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
           WHERE (p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) AND x.is_rep IS DISTINCT FROM a.is_rep)
    INTO v_child;
  IF v_elig <> 0 OR v_multi <> 0 OR v_rule <> 0 OR v_child <> 0 THEN
    RAISE EXCEPTION 'rd 대표(is_rep) 단언 실패: 게이트(elig·현행 elig_nc) 아님 %, 셀당 둘 이상 %, 규칙 불일치 %, 자식 사본 불일치 %', v_elig, v_multi, v_rule, v_child;
  END IF;
  IF v_acr <> 0 THEN
    RAISE NOTICE 'rd.assert_rep: ACR 반복 순번 > 1 인 대표 % 건(동률 경계. cell_rep 에서 acr_iter_unfolded 를 끈 조합만 영향)', v_acr;
  END IF;
  RETURN n;
END $f$;

-- 게이트 전파(DB-v2.13 본문 그대로 + is_rep 사본·단언). 적재기(ingest.project.apply)가 5만 청크로 부른다.
CREATE OR REPLACE FUNCTION rd.propagate_answer_gates(p_keys int4[]) RETURNS int LANGUAGE plpgsql AS $f$
-- 답변 위치는 rd.job(answer_key PK)에서 파티션 좌표(surface, round_date)를 얻어 등치 조인으로 찾는다.
-- rd.answer 를 answer_key = ANY 로 직접 찾으면 파티션 키가 없어 모든 leaf 의 PK 인덱스를 끝까지 훑는다
-- (2026-09-27 스모크: 24만 행 12 leaf 4.5ms vs rd.job 경유 0.028ms, 행 수에 비례).
DECLARE n int := 0; m int;
BEGIN
  -- 위치 단언: served 인 job 은 같은 좌표의 rd.answer 가 있어야 한다. 없으면 아래 조인이 조용히 0건이 된다.
  IF EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = ANY(p_keys) AND j.served
               AND NOT EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key))
  THEN RAISE EXCEPTION 'rd.job ↔ rd.answer 위치 불일치: 재투영 누락'; END IF;
  UPDATE rd.answer_brand c SET std_in = a.std_in, elig = a.elig, dflt = a.dflt, cyc_key = a.cyc_key, is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.elig, c.dflt, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key, a.is_rep);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET std_in = a.std_in, cyc_key = a.cyc_key, is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.std_in, a.cyc_key, a.is_rep);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET cit_in = a.cit_in, gap = a.gap, dflt = a.dflt, cyc_key = a.cyc_key, is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.cit_in, c.gap, c.dflt, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key, a.is_rep);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.job j SET cyc_key = a.cyc_key, analysis_code = a.analysis_state
    FROM rd.answer a WHERE j.answer_key = ANY(p_keys)
     AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
     AND (j.cyc_key, j.analysis_code) IS DISTINCT FROM (a.cyc_key, a.analysis_state);
  -- 게이트 동치 단언(불변식 ①): 위반 시 롤백
  IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_brand c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys)
                AND (c.std_in, c.elig, c.dflt, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key, a.is_rep))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_stance c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.std_in, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.std_in, a.cyc_key, a.is_rep))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys)
                AND (c.cit_in, c.gap, c.dflt, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key, a.is_rep))
  THEN RAISE EXCEPTION 'rd 게이트 사본 불일치: 전파 누락'; END IF;
  RETURN n;
END $f$;

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER FUNCTION rd.answer_cit_ext(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.answer_region_geo(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_answer_v215(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_v215(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_prompt_catalog_all() OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_child_is_rep(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.rep_expected(int4[], bool) OWNER TO hmg_owner;
ALTER FUNCTION rd.reselect_rep(int4[], bool) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_rep(int4[], bool) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.answer_cit_ext(int4[]), rd.answer_region_geo(int4[]), rd.fill_answer_v215(int4[]), rd.assert_answer_v215(int4[]),
  rd.fill_prompt_catalog_all(), rd.fill_child_is_rep(int4[]), rd.rep_expected(int4[], bool), rd.reselect_rep(int4[], bool),
  rd.assert_rep(int4[], bool) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.answer_cit_ext(int4[]), rd.answer_region_geo(int4[]), rd.fill_answer_v215(int4[]), rd.assert_answer_v215(int4[]),
  rd.fill_prompt_catalog_all(), rd.fill_child_is_rep(int4[]), rd.rep_expected(int4[], bool), rd.reselect_rep(int4[], bool),
  rd.assert_rep(int4[], bool) TO loader, migrator;

-- ── 사후 단언(구조만: 값은 fill-v215.sql 이 채우고 배치마다 단언한다) ───────────────────
DO $v$
DECLARE bad text;
BEGIN
  -- 새 열: 형·NULL 허용·기본값 없음(P85 is_rep 만 NOT NULL·기본값 false), 파티션 leaf 까지 전파
  SELECT string_agg(format('%s.%s', t.r::text, x.col), ', ') INTO bad
    FROM (VALUES ('rd.answer'::regclass, 'cit_n_all', 'int2'),
                 ('rd.answer'::regclass, 'cit_c1', 'int2'), ('rd.answer'::regclass, 'cit_c13', 'int2'),
                 ('rd.answer'::regclass, 'region_geo_key', 'int2'), ('rd.dim_prompt'::regclass, 'cat_mask_all', 'int2'),
                 ('rd.dim_prompt'::regclass, 'in_root_catalog_all', 'bool')) AS x(r, col, typ)
    CROSS JOIN LATERAL (SELECT x.r UNION ALL SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = x.r
                        UNION ALL SELECT i2.inhrelid::regclass FROM pg_inherits i1 JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
                         WHERE i1.inhparent = x.r) t(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.r AND a.attname = x.col AND NOT a.attisdropped
                      AND a.atttypid = x.typ::regtype AND NOT a.attnotnull AND NOT a.atthasdef);
  SELECT concat_ws(', ', bad, string_agg(format('%s.is_rep', t.r::text), ', ')) INTO bad
    FROM (VALUES ('rd.answer_brand'::regclass), ('rd.answer_stance'::regclass), ('rd.citation'::regclass)) AS x(r)
    CROSS JOIN LATERAL (SELECT x.r UNION ALL SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = x.r
                        UNION ALL SELECT i2.inhrelid::regclass FROM pg_inherits i1 JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
                         WHERE i1.inhparent = x.r) t(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                      WHERE a.attrelid = t.r AND a.attname = 'is_rep' AND NOT a.attisdropped AND a.atttypid = 'bool'::regtype
                        AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = 'false');
  bad := nullif(bad, '');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'P85~P88 실패: 열 형·NULL·기본값·전파: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname ~ '^cit_c([1-9]|1[0-3])$' AND NOT attisdropped) <> 13 THEN
    RAISE EXCEPTION 'P86 실패: cit_c1..cit_c13 13열';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass
        AND conname IN ('answer_cit_ext_pair', 'answer_cit_ext_bounds', 'answer_cit_ext_cat_sum', 'answer_region_geo_same')) <> 4
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'rd.dim_prompt'::regclass
           AND conname IN ('dim_prompt_cat_all_pair', 'dim_prompt_cat_all_empty') AND convalidated) <> 2 THEN
    RAISE EXCEPTION 'P86~P88 실패: CHECK';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('rd.answer_cit_ext(int4[])'::regprocedure, 'rd.answer_region_geo(int4[])'::regprocedure,
               'rd.fill_answer_v215(int4[])'::regprocedure, 'rd.assert_answer_v215(int4[])'::regprocedure,
               'rd.fill_prompt_catalog_all()'::regprocedure, 'rd.fill_child_is_rep(int4[])'::regprocedure,
               'rd.rep_expected(int4[], bool)'::regprocedure, 'rd.reselect_rep(int4[], bool)'::regprocedure,
               'rd.assert_rep(int4[], bool)'::regprocedure)
              AND pg_get_userbyid(proowner) <> 'hmg_owner')
     OR NOT has_function_privilege('loader', 'rd.assert_rep(int4[], bool)', 'execute')
     OR has_function_privilege('api_ro', 'rd.reselect_rep(int4[], bool)', 'execute')
     OR NOT has_function_privilege('loader', 'rd.fill_answer_v215(int4[])', 'execute')
     OR NOT has_function_privilege('migrator', 'rd.assert_answer_v215(int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.answer_cit_ext(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P85~P88 실패: 함수 소유자·실행 권한';
  END IF;
  -- 함수가 컴파일되고 빈 키에 0 을 낸다(쓰기 없음)
  PERFORM rd.fill_answer_v215(ARRAY[]::int4[]);
  PERFORM rd.assert_answer_v215(ARRAY[]::int4[]);
  PERFORM rd.fill_child_is_rep(ARRAY[]::int4[]);
  PERFORM rd.reselect_rep(ARRAY[]::int4[], true);
  PERFORM rd.assert_rep(ARRAY[]::int4[], true);
  PERFORM rd.propagate_answer_gates(ARRAY[]::int4[]);
  PERFORM 1 FROM rd.answer_cit_ext(ARRAY[]::int4[]);
END $v$;

-- ════════════════════════════════════════════════════════════════════════════
-- P89~P90 (WU-4, 2026-10-01: A41 catalog_incl_deleted · G20 brand_exposure_per_alias). 위 P85~P88 과 독립 구간(WU-2 는 P85 를 고친다).
--   같은 트랜잭션·같은 규약: 새 열은 NULL 허용·기본값 없음(메타데이터만), rd 사실 표 CHECK 는 NOT VALID(새 행·갱신 행만 검사),
--   값은 적재기(apply.project INSERT_*·seed-40)가 새 행부터 쓰고 기존 행은 fill-v215.sql §P89 가 채운 뒤 VALIDATE 한다.
--
-- P89 사실 표 모수 열(A41): 카탈로그 게이트를 뺀 모수 = "elig_nc"(elig 식에서 루트 카탈로그 소속 in_root_catalog 항만 뺀 것) 기반.
--     현행(surface-global.ts:117-135 CAT_CTE)은 소프트 삭제 카탈로그 행을 거르지 않아, 전부 삭제된 프롬프트(stg 103개, 2026-08-18 삭제,
--     답변 9,304건 = 07~08월 회차)도 in_root_catalog = 1 로 모수에 남는다. hub elig 는 비삭제 카탈로그만 보므로 그 답변이 elig = false 로
--     굳는다(읽기 술어만으로는 되살릴 수 없다: elig 의 다른 항(run 상태·숨김 시장·한국어 비-KR·태그 시장)이 행마다 다르다).
--     그래서 카탈로그 항만 뺀 모수를 열로 두고, 카탈로그 게이트는 조회 때 rd.dim_prompt.cat_mask_all 세미조인(core.measure.catalog_all_pred)이 건다.
--     카탈로그 변경(삭제·복구)은 이 열을 바꾸지 않는다(카탈로그 비의존) → 재판정 없이 dim_prompt 두 열만 맞으면 된다.
--       rd.answer.elig_nc    = elig 식에서 카탈로그 항만 뺀 값(현행 대표 규칙 rep_pick_latest_first 의 게이트이기도 하다: P85 rd.rep_expected)
--       rd.answer.std_in_nc  = elig_nc ∧ acr_in ∧ analysis_state < 2   (std_in 과 같은 식, elig → elig_nc)
--       rd.answer.cit_in_nc  = elig_nc ∧ acr_in                        (cit_in 과 같은 식)
--       자식 사본: answer_brand.std_in_nc · answer_stance.std_in_nc · citation.cit_in_nc = 부모 값(적재 때 같은 원천에서 쓴다)
--     website·project 는 elig 에 카탈로그 항이 없어 *_nc = std_in·cit_in(CHECK). elig ⇒ elig_nc(CHECK).
-- P89 rd.answer_brand.rid_n int2 (G20): 행(답변, 표시 브랜드, 경쟁 여부)에 모인 언급 행들의 서로 다른 롤업 id(J1 rid = 접두 교정 → 별칭 접기 →
--     원 롤업, canonRollupSql) 수. 현행 집계층 노출 답변 수(fold.ts:468,486 count(DISTINCT job_id) 를 (brand_id, brand_name) 별로 → 리더가
--     표시명으로 합산)를 재현하는 가중치: 노출 = sum(rid_n). 1 ≤ rid_n ≤ entity_rows(CHECK).
-- P90 rd.dim_prompt ⊇ CHECK(dim_prompt_cat_all_sup): cat_mask_all ⊇ cat_mask, in_root_catalog ⇒ in_root_catalog_all. P88 이 적재기 수정
--     뒤로 미뤘던 불변식이다(WU-4 가 DIM_PROMPT·DIM_PROMPT_REFRESH·seed-30 을 두 열 함께 쓰게 고쳤다). 소형 표라 검증된 CHECK.
--
-- 함수(호출자 권한, 소유자 hmg_owner, 실행 = loader·migrator)
--   rd.answer_elig_nc(int4[])   답변 키 집합(NULL = 전 서빙 답변)의 elig_nc 재계산(rd.job + ing.answer·ing.run + rd.dim_prompt·dim_country).
--                               식 = apply.project FACT_SRC·seed-40 §4 elig 에서 in_root_catalog 항만 뺀 것(세 곳이 같은 식: 단언이 대조한다)
--   rd.fill_answer_nc(int4[])   P89 모수 열 채움(부모 → 자식 사본, 값이 다른 행만). 키 필수. 반환 = 갱신 행 수
--   rd.assert_answer_nc(int4[]) 채운 행(std_in_nc NOT NULL)의 부모 = 재계산·자식 = 부모, 위반 시 예외. NULL = 채운 행 전부. 반환 = 검사 답변 수
--   rid_n 은 표기 쌍(seed-3x-common §6 _bn_pair, 세션 pg_temp)이 있어야 계산된다 → 함수 없이 fill-v215.sql §P89 가 시드 공용 파일을 올려 채운다.
-- ════════════════════════════════════════════════════════════════════════════
-- P89~P90 의 열·CHECK DDL 은 위(P88 뒤)에 있다: P85 규칙 함수 rd.rep_expected 가 rd.answer.elig_nc 를 읽어 함수 생성 전에 열이 있어야 한다.

CREATE FUNCTION rd.answer_elig_nc(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4, elig_nc bool)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT j.surface, j.round_date, j.answer_key,
       (r.status IN ('completed', 'partial_failed')
        AND (j.surface <> 1 OR (
              NOT (coalesce(g.hidden_standard, false)
                   OR (ia.region IS NULL AND EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global')))
              AND coalesce(NOT (ia.region <> 'KR' AND coalesce(p.is_korean, false)
                                AND (ia.measured_at IS NULL OR ia.measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
                                     OR p.regions IS NULL OR cardinality(p.regions) = 0)), false)
              AND (p.regions IS NULL OR cardinality(p.regions) = 0 OR coalesce(ia.region = ANY (p.regions), false)))))
  FROM rd.job j
  JOIN ing.answer_key_map m ON m.job_id = j.job_id
  JOIN ing.answer ia ON ia.run_month = m.run_month AND ia.job_id = j.job_id
  JOIN ing.run r ON r.run_id = ia.run_id
  LEFT JOIN rd.dim_prompt p ON p.prompt_key = j.prompt_key AND j.prompt_key <> 0
  LEFT JOIN rd.dim_country g ON upper(g.code) = upper(ia.region)
 WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys))
$f$;

CREATE FUNCTION rd.fill_answer_nc(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int := 0; m int;
BEGIN
  IF p_keys IS NULL THEN
    RAISE EXCEPTION 'rd.fill_answer_nc: 키 배열 필수(배치로 나눠 부른다, back/migration/fill-v215.sql §P89)';
  END IF;
  UPDATE rd.answer a
     SET elig_nc = x.elig_nc,
         std_in_nc = (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1) AND a.analysis_state < 2),
         cit_in_nc = (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1))
    FROM rd.answer_elig_nc(p_keys) x
   WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
     AND (a.elig_nc, a.std_in_nc, a.cit_in_nc) IS DISTINCT FROM
         (x.elig_nc, (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1) AND a.analysis_state < 2), (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1)));
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
              WHERE j.answer_key = ANY (p_keys) AND j.served AND a.elig_nc IS NULL) THEN
    RAISE EXCEPTION 'rd.fill_answer_nc: 채우지 못한 서빙 답변이 있다(ing.answer_key_map·ing.answer·ing.run 누락)';
  END IF;
  UPDATE rd.answer_brand c SET std_in_nc = a.std_in_nc
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.std_in_nc IS DISTINCT FROM a.std_in_nc;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET std_in_nc = a.std_in_nc
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.std_in_nc IS DISTINCT FROM a.std_in_nc;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET cit_in_nc = a.cit_in_nc
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.cit_in_nc IS DISTINCT FROM a.cit_in_nc;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  RETURN n;
END $f$;

CREATE FUNCTION rd.assert_answer_nc(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v int; c1 int; c2 int; c3 int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE (a.elig_nc, a.std_in_nc, a.cit_in_nc) IS DISTINCT FROM
           (x.elig_nc, (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1) AND a.analysis_state < 2), (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1))))
    INTO n, v
    FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    LEFT JOIN rd.answer_elig_nc(p_keys) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys)) AND a.elig_nc IS NOT NULL;
  SELECT count(*) INTO c1 FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    JOIN rd.answer_brand c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys)) AND a.std_in_nc IS NOT NULL AND c.std_in_nc IS DISTINCT FROM a.std_in_nc;
  SELECT count(*) INTO c2 FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    JOIN rd.answer_stance c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys)) AND a.std_in_nc IS NOT NULL AND c.std_in_nc IS DISTINCT FROM a.std_in_nc;
  SELECT count(*) INTO c3 FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys)) AND a.std_in_nc IS NOT NULL AND c.cit_in_nc IS DISTINCT FROM a.cit_in_nc;
  IF v <> 0 OR c1 <> 0 OR c2 <> 0 OR c3 <> 0 THEN
    RAISE EXCEPTION 'rd.answer elig_nc·std_in_nc·cit_in_nc ≠ 재계산 % 답변, 자식 사본 불일치 answer_brand % · answer_stance % · citation %', v, c1, c2, c3;
  END IF;
  RETURN n;
END $f$;

ALTER FUNCTION rd.answer_elig_nc(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_answer_nc(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_nc(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.answer_elig_nc(int4[]), rd.fill_answer_nc(int4[]), rd.assert_answer_nc(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.answer_elig_nc(int4[]), rd.fill_answer_nc(int4[]), rd.assert_answer_nc(int4[]) TO loader, migrator;

DO $v$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s', t.r::text, x.col), ', ') INTO bad
    FROM (VALUES ('rd.answer'::regclass, 'elig_nc', 'bool'), ('rd.answer'::regclass, 'std_in_nc', 'bool'), ('rd.answer'::regclass, 'cit_in_nc', 'bool'),
                 ('rd.answer_brand'::regclass, 'std_in_nc', 'bool'), ('rd.answer_brand'::regclass, 'rid_n', 'int2'),
                 ('rd.answer_stance'::regclass, 'std_in_nc', 'bool'), ('rd.citation'::regclass, 'cit_in_nc', 'bool')) AS x(r, col, typ)
    CROSS JOIN LATERAL (SELECT x.r UNION ALL SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = x.r
                        UNION ALL SELECT i2.inhrelid::regclass FROM pg_inherits i1 JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
                         WHERE i1.inhparent = x.r) t(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.r AND a.attname = x.col AND NOT a.attisdropped
                      AND a.atttypid = x.typ::regtype AND NOT a.attnotnull AND NOT a.atthasdef);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'P89 실패: 열 형·NULL·기본값·전파: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass AND conname IN ('answer_nc_pair', 'answer_nc_rule')) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'rd.answer_brand'::regclass AND conname = 'answer_brand_rid_n')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'rd.dim_prompt'::regclass AND conname = 'dim_prompt_cat_all_sup' AND convalidated) THEN
    RAISE EXCEPTION 'P89~P90 실패: CHECK';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('rd.answer_elig_nc(int4[])'::regprocedure, 'rd.fill_answer_nc(int4[])'::regprocedure,
               'rd.assert_answer_nc(int4[])'::regprocedure) AND pg_get_userbyid(proowner) <> 'hmg_owner')
     OR NOT has_function_privilege('loader', 'rd.fill_answer_nc(int4[])', 'execute')
     OR NOT has_function_privilege('migrator', 'rd.assert_answer_nc(int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.answer_elig_nc(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P89 실패: 함수 소유자·실행 권한';
  END IF;
  PERFORM rd.fill_answer_nc(ARRAY[]::int4[]);
  PERFORM rd.assert_answer_nc(ARRAY[]::int4[]);
END $v$;

COMMIT;
-- ============================================================================
-- hmg-geo 재설계 DB-v2.16 보완 패치 (PostgreSQL 17, 2026-10-01) · 현행 값 재현 WU-7(WEBREG16 웹 보고서 유닛 게이트)
-- 적용 순서: DB-v2.15 뒤 1회(트랜잭션 1개). 합본 DB-v2.16.sql = DB-v2.15.sql + 이 파일(이어 붙이기). 엔티티 관리 패치는 DB-v2.17 로 밀렸다
--   (메인 결정 2026-10-01): 이 패치는 엔티티 관리 객체를 읽지도 쓰지도 않는다.
-- 근거: 제품 결정 19·25(현행 값 완전 재현), 계획서 notes/hgh-impl/revert-to-current-plan-20261001.md 5.7 WEBREG16.
--
-- 현행 규칙(hmg-geo 2670a16): 웹사이트 집계층(사실표) 모수 = 보고서 유닛 소속 답변만.
--   생성기 scripts/summary/surface-website.ts:145-225 loadUnits: 보고서 명세(scripts/reports/report-spec.json 109행 = brand·cc·langCode·
--     urlLike·urlNotLike)를 website_sites(brand, country_code)·website_prompts(lang_code, summary_report_norm(target_url))에 맞춰
--     그 프롬프트의 website_prompts.file_seq 를 summary_answers.report_fs 로 굳힌다(사이트 프로젝트 = 생성 프로젝트, :398-406).
--   조회 summary-website-aggregates.ts:226-240 unitWhere·summary-trend-aggregates.ts:718-727: report_fs IS NOT NULL ∧
--     report_fs <> ALL(summary_settings.website_excluded_fs)(운영 값 [71,94,97], 2026-09-05). 카드 ①~⑤·⑥ 정확도·추이·GEO·Sub-KPI 에 걸린다.
--   URL 인용률(타겟·자사 프롬프트 단위)은 이 게이트가 없다(:1244-1271 sharedWhere 만), 미러(답변 분석 화면 cumulative) 경로도 없다.
--   hub web_reg(app.website_prompt 존재)와 다른 집합이다: stg hmg_r2 실측(2026-10-01) 웹 프롬프트 13,188 중 web_reg ∧ 유닛 소속 9,869
--   (그중 제외 fs 232), web_reg ∧ 유닛 밖 2,816, web_reg 아님 503. 답변 기준 유닛 밖 23,390·제외 fs 4,136 / 240,173.
--
-- P91 app.website_report_unit: 보고서 명세 행(테넌트 데이터, back/migration/fill-v216.sql 이 채운다). 코어는 행 내용을 모른다.
-- P92 app.website_report_excluded: 보고서 제외 유닛 file_seq(현행 summary_settings.website_excluded_fs, 조회 때 읽는다).
-- P93 rd.web_report_prompt: 웹 프롬프트 → 보고서 유닛 file_seq(현행 report_fs 판정의 투영). 사이트 프로젝트 = 프롬프트 프로젝트(현행 runit 은
--     생성 프로젝트의 사이트만)이고, 사이트 프로젝트가 비면 프롬프트 프로젝트로 본다: app.website_site.scope_project_id 가 UNIQUE 라 한 Scope
--     프로젝트를 나눠 쓰는 사이트(Genesis SA-Jeddah·SA-Riyadh = SA-Dammam 프로젝트, 현행 surface-website.ts:242)가 이관에서 NULL 이 됐다. 쓰기 = rd.refresh_web_report_prompt 만
--     (적재기 ingest.project.apply: 새 웹 프롬프트·website_catalog 재판정, fill-v216.sql). rd.dim_prompt 를 FK 로 묶지 않는다(bulk 시드의
--     rd.dim_prompt TRUNCATE 를 막지 않게): 시드·재투영 뒤에는 refresh(NULL) 를 다시 돈다.
-- 함수(호출자 권한, 소유자 hmg_owner)
--   rd.report_url_norm(text)                 현행 summary_report_norm = citation_url_norm 과 같은 식(적재 pg_temp.cit_norm 과 같다). api_ro 도 실행
--   rd.web_report_prompt_expected(int4[])    프롬프트 키 집합(NULL = 전 웹 프롬프트)의 기대 멤버십(읽기 전용)
--   rd.refresh_web_report_prompt(int4[])     기대값으로 맞춘다(바뀐 행만 INSERT·UPDATE·DELETE, 키 NULL = 전체). 반환 = 바뀐 행 수. loader·migrator
--   rd.assert_web_report_prompt()            표 = 기대값(전체) 단언, 위반 시 예외. 반환 = 행 수. loader·migrator
-- 결과 캐시: 세 표를 추적 표(rcache.tg_bump)에 올린다(조회가 바로 읽는 표). 바뀐 행이 없는 refresh 는 버전을 올리지 않는다.
-- 락: 새 표 생성뿐(기존 표 ALTER 없음). lock_timeout 30s.
-- 적용 절차(stg·prod): ① 이 패치(migrator 또는 superuser) ② psql -f back/migration/fill-v216.sql(드라이런) → -v commit=1
--   ③ 켜기 전 확인: SELECT rd.assert_web_report_prompt(). 스위치 web_registered_only 를 켜지 않으면 응답은 그대로다(읽는 코드가 스위치 뒤).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.dim_prompt'::regclass AND attname = 'cat_mask_all' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.15 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.web_report_prompt') IS NOT NULL OR to_regclass('app.website_report_unit') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.16 이미 적용됨(app.website_report_unit·rd.web_report_prompt 존재)';
  END IF;
END $v$;

-- ── P91·P92·P93 ─────────────────────────────────────────────────────────────
CREATE TABLE app.website_report_unit (
  ix int2 PRIMARY KEY CHECK (ix >= 0),                   -- 명세 행 순번(report-spec.json 배열 위치, 0부터)
  brand_code text NOT NULL,                              -- website_sites.brand 와 정확 일치(현행 ws.brand = s.brand)
  country_code text NOT NULL,                            -- website_sites.country_code 와 정확 일치(가상·유사 코드 원표기)
  lang_code text,                                        -- NULL = 언어 무관
  url_like text,                                         -- rd.report_url_norm(target_url) LIKE, NULL = 조건 없음
  url_not_like text,                                     -- rd.report_url_norm(target_url) NOT LIKE, NULL = 조건 없음
  spec_fs int NOT NULL CHECK (spec_fs > 0));             -- 명세 fs(참고용: 판정 값 report_fs 는 website_prompt.file_seq 다, surface-website.ts:135-140)
COMMENT ON TABLE app.website_report_unit IS
  '현행 웹사이트 보고서 유닛 명세(scripts/reports/report-spec.json 행, 테넌트 데이터). rd.web_report_prompt 판정 입력(WEBREG16, WU-7). DB-v2.16 P91';
CREATE TABLE app.website_report_excluded (
  file_seq int PRIMARY KEY CHECK (file_seq > 0),
  note text);
COMMENT ON TABLE app.website_report_excluded IS
  '보고서 제외 유닛 file_seq(현행 summary_settings.website_excluded_fs). 조회 때 rd.web_report_prompt.report_fs 와 비교(WEBREG16). DB-v2.16 P92';
CREATE TABLE rd.web_report_prompt (
  prompt_key int4 PRIMARY KEY,                           -- rd.dim_prompt.prompt_key(웹사이트 표면), FK 없음(헤더 참고)
  report_fs int NOT NULL CHECK (report_fs > 0));         -- 소속 보고서 유닛의 website_prompt.file_seq(여러 유닛이면 최소)
COMMENT ON TABLE rd.web_report_prompt IS
  '웹 프롬프트의 보고서 유닛 소속(현행 summary_answers.report_fs 판정 투영). 없는 프롬프트 = 유닛 밖. 쓰기 = rd.refresh_web_report_prompt. DB-v2.16 P93';

-- ── 함수 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION rd.report_url_norm(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $f$
SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
         lower(regexp_replace($1, '^\s+|\s+$', '', 'g')), '^https?://', ''), '^www\.', ''), '#.*$', ''),
         '&(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*', '', 'g'),
         '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*&', '?'),
         '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*$', ''), '/+$', '')
$f$;
COMMENT ON FUNCTION rd.report_url_norm(text) IS
  '현행 summary_report_norm(0060) = citation_url_norm 과 같은 정규화(적재 pg_temp.cit_norm seed-3x-common.sql:9-11 과 같은 식). DB-v2.16';

CREATE FUNCTION rd.web_report_prompt_expected(p_keys int4[]) RETURNS TABLE (prompt_key int4, report_fs int)
  LANGUAGE sql STABLE AS $f$
SELECT d.prompt_key, min(wp.file_seq)::int
  FROM rd.dim_prompt d
  JOIN rd.dim_project dp ON dp.project_key = d.project_key
  JOIN app.website_prompt wp ON wp.scope_prompt_id = d.prompt_id
  JOIN app.website_site ws ON ws.site_id = wp.site_id AND (ws.scope_project_id = dp.scope_project_id OR ws.scope_project_id IS NULL)
  JOIN app.website_report_unit u ON u.brand_code = ws.brand_code AND u.country_code = ws.country_code
       AND (u.lang_code IS NULL OR wp.lang_code = u.lang_code)
       AND (u.url_like IS NULL OR rd.report_url_norm(wp.target_url) LIKE u.url_like)
       AND (u.url_not_like IS NULL OR rd.report_url_norm(wp.target_url) NOT LIKE u.url_not_like)
 WHERE d.surface = 2 AND (p_keys IS NULL OR d.prompt_key = ANY (p_keys))
 GROUP BY d.prompt_key
$f$;
COMMENT ON FUNCTION rd.web_report_prompt_expected(int4[]) IS
  '웹 프롬프트 키 집합(NULL = 전체)의 보고서 유닛 소속 기대값: 사이트(브랜드·국가 정확 일치, 사이트 프로젝트 = 프롬프트 프로젝트, 사이트 프로젝트가 비면 '
  '프롬프트 프로젝트로 본다: 한 Scope 프로젝트를 나눠 쓰는 사이트가 UNIQUE 로 NULL 이 된 경우)·언어·타겟 URL 조건. DB-v2.16';

CREATE FUNCTION rd.refresh_web_report_prompt(p_keys int4[]) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n_up int; n_del int;
BEGIN
  WITH e AS (SELECT * FROM rd.web_report_prompt_expected(p_keys)),
  up AS (INSERT INTO rd.web_report_prompt AS w (prompt_key, report_fs) SELECT e.prompt_key, e.report_fs FROM e
         ON CONFLICT (prompt_key) DO UPDATE SET report_fs = EXCLUDED.report_fs WHERE w.report_fs IS DISTINCT FROM EXCLUDED.report_fs
         RETURNING 1)
  SELECT count(*) INTO n_up FROM up;
  DELETE FROM rd.web_report_prompt w
   WHERE (p_keys IS NULL OR w.prompt_key = ANY (p_keys))
     AND NOT EXISTS (SELECT 1 FROM rd.web_report_prompt_expected(p_keys) e WHERE e.prompt_key = w.prompt_key);
  GET DIAGNOSTICS n_del = ROW_COUNT;
  RETURN n_up + n_del;
END $f$;
COMMENT ON FUNCTION rd.refresh_web_report_prompt(int4[]) IS
  'rd.web_report_prompt 를 기대값으로 맞춘다(바뀐 행만, 키 NULL = 전체). 반환 = 바뀐 행 수. DB-v2.16';

CREATE FUNCTION rd.assert_web_report_prompt() RETURNS int LANGUAGE plpgsql AS $f$
DECLARE bad int; n int;
BEGIN
  SELECT count(*) INTO bad FROM (
    (SELECT prompt_key, report_fs FROM rd.web_report_prompt EXCEPT SELECT prompt_key, report_fs FROM rd.web_report_prompt_expected(NULL))
    UNION ALL
    (SELECT prompt_key, report_fs FROM rd.web_report_prompt_expected(NULL) EXCEPT SELECT prompt_key, report_fs FROM rd.web_report_prompt)) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'rd.web_report_prompt ≠ 기대값: % 행(refresh_web_report_prompt(NULL) 필요)', bad;
  END IF;
  SELECT count(*) INTO n FROM rd.web_report_prompt;
  RETURN n;
END $f$;
COMMENT ON FUNCTION rd.assert_web_report_prompt() IS 'rd.web_report_prompt = 기대값(전체) 단언. 반환 = 행 수. DB-v2.16';

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER TABLE app.website_report_unit OWNER TO hmg_owner;
ALTER TABLE app.website_report_excluded OWNER TO hmg_owner;
ALTER TABLE rd.web_report_prompt OWNER TO hmg_owner;
ALTER FUNCTION rd.report_url_norm(text) OWNER TO hmg_owner;
ALTER FUNCTION rd.web_report_prompt_expected(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.refresh_web_report_prompt(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_web_report_prompt() OWNER TO hmg_owner;
GRANT SELECT ON app.website_report_unit, app.website_report_excluded, rd.web_report_prompt TO api_ro, admin_long, loader, migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.website_report_unit, app.website_report_excluded TO migrator;   -- 테넌트 데이터 채우기(fill-v216.sql)
GRANT SELECT, INSERT, UPDATE, DELETE ON rd.web_report_prompt TO loader, migrator;
REVOKE EXECUTE ON FUNCTION rd.report_url_norm(text), rd.web_report_prompt_expected(int4[]), rd.refresh_web_report_prompt(int4[]),
  rd.assert_web_report_prompt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.report_url_norm(text) TO api_ro, admin_long, loader, migrator;
GRANT EXECUTE ON FUNCTION rd.web_report_prompt_expected(int4[]), rd.refresh_web_report_prompt(int4[]), rd.assert_web_report_prompt()
  TO loader, migrator;

-- ── 결과 캐시 추적(DB-v2.11 P67 규약, 표마다 문장 트리거 4개) ─────────────────────
DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app.website_report_unit', 'app.website_report_excluded', 'rd.web_report_prompt'] LOOP
    INSERT INTO rcache.data_version (tbl, version) VALUES (t, 0);
    EXECUTE format('CREATE TRIGGER rcache_bump_ins AFTER INSERT ON %s REFERENCING NEW TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_upd AFTER UPDATE ON %s REFERENCING NEW TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_del AFTER DELETE ON %s REFERENCING OLD TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_trunc AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
  END LOOP;
END $v$;

-- ── 사후 단언(구조) ─────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('app.website_report_unit'::regclass, 'app.website_report_excluded'::regclass,
               'rd.web_report_prompt'::regclass) AND pg_get_userbyid(relowner) <> 'hmg_owner')
     OR NOT has_table_privilege('api_ro', 'rd.web_report_prompt', 'select')
     OR NOT has_table_privilege('api_ro', 'app.website_report_excluded', 'select')
     OR has_table_privilege('api_ro', 'rd.web_report_prompt', 'insert')
     OR NOT has_table_privilege('loader', 'rd.web_report_prompt', 'insert')
     OR NOT has_function_privilege('loader', 'rd.refresh_web_report_prompt(int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.refresh_web_report_prompt(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P91~P93 실패: 소유자·권한';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('app.website_report_unit'::regclass, 'app.website_report_excluded'::regclass,
        'rd.web_report_prompt'::regclass) AND tgname LIKE 'rcache_bump_%') <> 12 THEN
    RAISE EXCEPTION 'P91~P93 실패: 결과 캐시 추적 트리거';
  END IF;
  PERFORM rd.refresh_web_report_prompt(ARRAY[]::int4[]);
  PERFORM rd.assert_web_report_prompt();       -- 명세 행이 아직 없으므로 기대값 0 = 표 0
END $v$;

COMMIT;
