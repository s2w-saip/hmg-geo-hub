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
