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
