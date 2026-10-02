--
-- PostgreSQL database dump
--

\restrict STztmGYYSC7OMhHoqEgcmTeeGVzYJ4HX9hRQbK1ER7tXDd6QHD0N5yYURSm0aRp

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: citation_domain_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.citation_domain_overrides (
    domain text NOT NULL,
    category text NOT NULL,
    note text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: entity_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_registry (
    entity_id uuid NOT NULL,
    name text NOT NULL,
    role text DEFAULT 'own'::text NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_registry_role_check CHECK ((role = ANY (ARRAY['own'::text, 'excluded'::text])))
);


--
-- Name: ga4_properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ga4_properties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand text NOT NULL,
    country_code text NOT NULL,
    property_id text,
    status text DEFAULT 'pending_grant'::text NOT NULL,
    granted_at timestamp with time zone,
    verified_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ga4_properties_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending_grant'::text, 'unmapped'::text])))
);


--
-- Name: ga4_tracked_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ga4_tracked_events (
    property_id text NOT NULL,
    event_name text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: keyword_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyword_cache (
    cache_key text NOT NULL,
    payload jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: keyword_volume_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyword_volume_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    keyword text NOT NULL,
    location_code integer,
    language_code text,
    sort_by text DEFAULT 'search_volume'::text NOT NULL,
    search_volume integer,
    competition text,
    competition_index integer,
    cpc real,
    low_top_of_page_bid real,
    high_top_of_page_bid real,
    monthly_searches jsonb,
    raw_data jsonb,
    success boolean DEFAULT false NOT NULL,
    error_message text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: member_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    action public.member_audit_action NOT NULL,
    context text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_custom_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_custom_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    label text NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_engine_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_engine_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    engines text[] NOT NULL,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.project_member_role DEFAULT 'viewer'::public.project_member_role NOT NULL,
    status public.project_member_status DEFAULT 'pending'::public.project_member_status NOT NULL,
    invited_by uuid NOT NULL,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone
);


--
-- Name: project_owned_bases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_owned_bases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    base_url text NOT NULL,
    label text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_tracked_urls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_tracked_urls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    url text NOT NULL,
    label text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    domain text,
    country text NOT NULL,
    language text,
    description text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    brand text,
    scope_project_id uuid,
    ga4_property_id text,
    ai_engines text[]
);


--
-- Name: prompt_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    prompt_id uuid NOT NULL,
    project_id uuid NOT NULL,
    actor_id uuid,
    actor_type text DEFAULT 'user'::text NOT NULL,
    event_type text NOT NULL,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    batch_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prompt_audit_logs_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text]))),
    CONSTRAINT prompt_audit_logs_event_type_check CHECK ((event_type = ANY (ARRAY['created'::text, 'text_updated'::text, 'meta_updated'::text, 'enabled_changed'::text, 'kind_changed'::text, 'deleted'::text, 'restored'::text])))
);


--
-- Name: prompt_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    source public.prompt_source NOT NULL,
    source_keyword text,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: prompt_custom_field_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_custom_field_values (
    prompt_id uuid NOT NULL,
    field_id uuid NOT NULL,
    value text NOT NULL
);


--
-- Name: prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    candidate_id uuid,
    text text NOT NULL,
    prompt_type public.prompt_type,
    category text,
    status public.prompt_status DEFAULT 'draft'::public.prompt_status NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    needs_reanalysis boolean DEFAULT false NOT NULL,
    brand text,
    list_type text,
    depth1 text,
    depth2 text,
    depth3 text,
    funnel_stage text,
    scope_prompt_id uuid,
    depth4 text,
    kind text DEFAULT 'single'::text NOT NULL,
    brand_presence text,
    updated_by uuid,
    deleted_at timestamp with time zone,
    lang text,
    regions text[],
    CONSTRAINT prompts_brand_presence_check CHECK (((brand_presence IS NULL) OR (brand_presence = ANY (ARRAY['branded'::text, 'unbranded'::text])))),
    CONSTRAINT prompts_kind_check CHECK ((kind = ANY (ARRAY['single'::text, 'acr'::text])))
);


--
-- Name: qa_answer_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_answer_locks (
    job_id uuid NOT NULL,
    session_id uuid NOT NULL,
    reviewer_name text NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: qa_answer_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_answer_reviews (
    job_id uuid NOT NULL,
    status text NOT NULL,
    section_flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    reviewer_name text NOT NULL,
    session_id uuid,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT qa_answer_reviews_status_ck CHECK ((status = ANY (ARRAY['ok'::text, 'issue'::text])))
);


--
-- Name: qa_review_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_review_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_key text,
    target_label text,
    severity text DEFAULT 'issue'::text NOT NULL,
    body text NOT NULL,
    reviewer_name text NOT NULL,
    session_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    CONSTRAINT qa_review_notes_kind_ck CHECK ((target_kind = ANY (ARRAY['answer'::text, 'prompt'::text, 'mention'::text, 'citation'::text, 'acr'::text, 'meta'::text]))),
    CONSTRAINT qa_review_notes_severity_ck CHECK ((severity = ANY (ARRAY['issue'::text, 'question'::text, 'info'::text])))
);


--
-- Name: report_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_publications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    surface text NOT NULL,
    brand_scope text NOT NULL,
    volume text,
    version text NOT NULL,
    title text,
    cycle_label text,
    cycle_label_en text,
    round_date date NOT NULL,
    prev_round_date date,
    asof_cur date,
    asof_prev date,
    published_on date,
    engines text[],
    excluded_fs integer[],
    bench_n integer,
    bench_n_all integer,
    src_cite text,
    source_filename text NOT NULL,
    source_sha256 text NOT NULL,
    manifest_verified boolean DEFAULT false NOT NULL,
    verify_note text,
    sb_data_version text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    superseded_by uuid,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT report_publications_bench_ck CHECK (((bench_n IS NULL) OR (bench_n_all IS NULL) OR (bench_n <= bench_n_all))),
    CONSTRAINT report_publications_status_ck CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'rolled_back'::text])))
);


--
-- Name: report_site_engine_facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_site_engine_facts (
    publication_id uuid NOT NULL,
    file_seq integer NOT NULL,
    engine text NOT NULL,
    target_hit_prompts integer NOT NULL,
    prev_target_hit_prompts integer
);


--
-- Name: report_site_facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_site_facts (
    publication_id uuid NOT NULL,
    file_seq integer NOT NULL,
    brand text NOT NULL,
    country_code text,
    country_name text,
    region_label text,
    lang_code text,
    lang_label text,
    agency_status text,
    in_headline_pool boolean DEFAULT true NOT NULL,
    target_hit_prompts integer NOT NULL,
    measured_prompts integer NOT NULL,
    owned_prompts integer NOT NULL,
    owned_prompts_den integer NOT NULL,
    owned_answers integer,
    monitored_answers integer,
    prompts integer,
    answers integer,
    prev_target_hit_prompts integer,
    prev_measured_prompts integer,
    prev_owned_prompts integer,
    prev_owned_prompts_den integer,
    raw jsonb NOT NULL,
    CONSTRAINT report_site_facts_owned_ck CHECK (((owned_prompts >= 0) AND (owned_prompts <= owned_prompts_den))),
    CONSTRAINT report_site_facts_target_ck CHECK (((target_hit_prompts >= 0) AND (target_hit_prompts <= measured_prompts)))
);


--
-- Name: scope_acr_rollups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_acr_rollups (
    prompt_run_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    run_id uuid NOT NULL,
    prompt_id uuid,
    target text,
    region text,
    measured_at timestamp with time zone,
    rollup_level text,
    brand text,
    parent_brand text,
    brand_rollup_entity_id uuid,
    entity_type text,
    planned_iterations integer DEFAULT 0 NOT NULL,
    valid_turn1_iterations integer DEFAULT 0 NOT NULL,
    valid_acr_iterations integer DEFAULT 0 NOT NULL,
    appearance_count integer DEFAULT 0 NOT NULL,
    choice_count integer DEFAULT 0 NOT NULL,
    conditional_choice_count integer DEFAULT 0 NOT NULL,
    off_shortlist_choice_count integer DEFAULT 0 NOT NULL,
    unresolved_choice_count integer DEFAULT 0 NOT NULL,
    generic_choice_count integer DEFAULT 0 NOT NULL,
    appearance_rate real,
    acr real,
    overall_choice_share real,
    co_single_entity integer DEFAULT 0 NOT NULL,
    co_conditional_multiple integer DEFAULT 0 NOT NULL,
    co_generic_category integer DEFAULT 0 NOT NULL,
    co_resolved_off_shortlist integer DEFAULT 0 NOT NULL,
    co_unresolved_choice integer DEFAULT 0 NOT NULL,
    co_none integer DEFAULT 0 NOT NULL
);


--
-- Name: scope_answer_anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_answer_anchors (
    job_id uuid NOT NULL,
    anchor date NOT NULL,
    source_measured_at timestamp with time zone,
    folded_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text
);


--
-- Name: scope_answer_cycle_anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_answer_cycle_anchors (
    job_id uuid NOT NULL,
    run_id uuid NOT NULL,
    project_id uuid,
    surface text NOT NULL,
    anchor_at timestamp with time zone NOT NULL,
    anchor_date date NOT NULL,
    anchor_week date NOT NULL,
    anchor_month date NOT NULL,
    measured_at_orig timestamp with time zone NOT NULL,
    is_default_engine boolean NOT NULL,
    round_date date NOT NULL,
    view_anchor_date date,
    ledger_view_anchor_date date,
    cycle_id uuid,
    source text NOT NULL,
    source_measured_at timestamp with time zone,
    reason text,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scope_answer_cycle_anchors_source_ck CHECK ((source = ANY (ARRAY['registry'::text, 'ledger'::text, 'run'::text, 'fallback_measured'::text]))),
    CONSTRAINT scope_answer_cycle_anchors_surface_ck CHECK ((surface = ANY (ARRAY['standard'::text, 'website'::text, 'project'::text])))
);


--
-- Name: scope_answer_drops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_answer_drops (
    job_id uuid NOT NULL,
    source_measured_at timestamp with time zone,
    dropped_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text NOT NULL
);


--
-- Name: scope_answer_stances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_answer_stances (
    job_id uuid NOT NULL,
    turn_index integer DEFAULT 0 NOT NULL,
    entity_id uuid NOT NULL,
    brand_label text,
    is_tracked boolean DEFAULT false NOT NULL,
    stance text NOT NULL,
    confidence real,
    evidence_text text,
    evidence_start integer,
    evidence_end integer,
    reason text,
    model_slug text
);


--
-- Name: scope_answers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_answers (
    job_id uuid NOT NULL,
    run_id uuid NOT NULL,
    prompt_id uuid,
    target text NOT NULL,
    region text,
    status text,
    measured_at timestamp with time zone,
    model_slug text,
    answer_text text
);


--
-- Name: scope_citations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_citations (
    id bigint NOT NULL,
    job_id uuid NOT NULL,
    url text,
    domain text,
    title text,
    ref_index integer,
    category text,
    url_norm text,
    url_host text,
    url_base_norm text
);


--
-- Name: scope_citations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scope_citations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scope_citations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scope_citations_id_seq OWNED BY public.scope_citations.id;


--
-- Name: scope_context_combinations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_context_combinations (
    cond_a uuid NOT NULL,
    cond_b uuid NOT NULL,
    co_count integer DEFAULT 0 NOT NULL
);


--
-- Name: scope_context_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_context_domains (
    entity_id uuid NOT NULL,
    host text NOT NULL,
    n integer DEFAULT 0 NOT NULL
);


--
-- Name: scope_context_drives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_context_drives (
    context_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    co_count integer DEFAULT 0 NOT NULL
);


--
-- Name: scope_context_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_context_entities (
    id uuid NOT NULL,
    type text NOT NULL,
    canonical_name text NOT NULL,
    dimension text,
    mention_count integer DEFAULT 0 NOT NULL,
    utterance_count integer DEFAULT 0 NOT NULL,
    sentiment_positive integer DEFAULT 0 NOT NULL,
    sentiment_negative integer DEFAULT 0 NOT NULL,
    sentiment_neutral integer DEFAULT 0 NOT NULL
);


--
-- Name: scope_context_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_context_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id uuid NOT NULL,
    utterance_id uuid NOT NULL,
    quote text NOT NULL,
    source_host text,
    source_url text,
    sentiment text
);


--
-- Name: scope_context_prompt_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_context_prompt_cache (
    project_id uuid NOT NULL,
    prompts jsonb DEFAULT '[]'::jsonb NOT NULL,
    model text,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 0 NOT NULL
);


--
-- Name: scope_cycle_anchor_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_cycle_anchor_state (
    cycle_key text NOT NULL,
    project_id uuid NOT NULL,
    run_cycle_anchor_at timestamp with time zone,
    solo_run_id uuid,
    surface text NOT NULL,
    source text NOT NULL,
    anchor_at timestamp with time zone NOT NULL,
    anchor_date date NOT NULL,
    round_date date NOT NULL,
    reg_utc_kept boolean DEFAULT false NOT NULL,
    ledger_view_date date,
    ledger_view_variants integer DEFAULT 0 NOT NULL,
    reg_anchor date,
    reg_split boolean DEFAULT false NOT NULL,
    ledger_anchor_at timestamp with time zone,
    ledger_variants integer DEFAULT 0 NOT NULL,
    expanded_count bigint DEFAULT 0 NOT NULL,
    last_expanded_at timestamp with time zone,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scope_cycle_anchor_state_source_ck CHECK ((source = ANY (ARRAY['registry'::text, 'ledger'::text, 'run'::text, 'fallback_measured'::text]))),
    CONSTRAINT scope_cycle_anchor_state_surface_ck CHECK ((surface = ANY (ARRAY['standard'::text, 'website'::text, 'project'::text])))
);


--
-- Name: scope_cycle_registry_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_cycle_registry_runs (
    run_id uuid NOT NULL,
    cycle_key text NOT NULL,
    project_id uuid NOT NULL,
    reg_anchor_min date NOT NULL,
    reg_anchor_max date NOT NULL,
    reg_rows integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scope_cycle_rounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_cycle_rounds (
    project_id uuid NOT NULL,
    anchor_date date NOT NULL,
    surface text NOT NULL,
    round_date date NOT NULL,
    basis text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scope_cycle_rounds_basis_ck CHECK ((basis = ANY (ARRAY['canonical'::text, 'prev_empty'::text, 'next_empty'::text, 'nearest'::text, 'merged'::text, 'project'::text]))),
    CONSTRAINT scope_cycle_rounds_surface_ck CHECK ((surface = ANY (ARRAY['standard'::text, 'website'::text, 'project'::text])))
);


--
-- Name: scope_mention_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_mention_occurrences (
    id bigint NOT NULL,
    job_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    brand_rollup_entity_id uuid,
    turn_index integer,
    source_start integer NOT NULL,
    source_end integer NOT NULL,
    surface_text text NOT NULL,
    sentiment text NOT NULL,
    mention_role text,
    assertion text,
    context_snippet text,
    descriptors text[] DEFAULT '{}'::text[] NOT NULL,
    criteria text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: scope_mention_occurrences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scope_mention_occurrences_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scope_mention_occurrences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scope_mention_occurrences_id_seq OWNED BY public.scope_mention_occurrences.id;


--
-- Name: scope_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_mentions (
    job_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    brand text,
    entity_type text,
    mention_count integer DEFAULT 0 NOT NULL,
    sentiment_positive integer DEFAULT 0 NOT NULL,
    sentiment_neutral integer DEFAULT 0 NOT NULL,
    sentiment_negative integer DEFAULT 0 NOT NULL,
    sentiment_mixed integer DEFAULT 0 NOT NULL,
    avg_position real,
    surfaces text[],
    brand_rollup_entity_id uuid,
    type_mention integer DEFAULT 0 NOT NULL,
    type_recommendation integer DEFAULT 0 NOT NULL,
    type_comparison integer DEFAULT 0 NOT NULL,
    type_definition integer DEFAULT 0 NOT NULL,
    type_final_choice integer DEFAULT 0 NOT NULL
);


--
-- Name: scope_mirror_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_mirror_progress (
    project_id uuid NOT NULL,
    run_id uuid NOT NULL,
    phase text NOT NULL,
    cursor text,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    CONSTRAINT scope_mirror_progress_phase_ck CHECK ((phase = ANY (ARRAY['plan'::text, 'write'::text, 'finalize'::text, 'complete'::text, 'blocked'::text]))),
    CONSTRAINT scope_mirror_progress_revision_ck CHECK ((revision >= 0))
);


--
-- Name: scope_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_prompts (
    prompt_id uuid NOT NULL,
    text text,
    funnel_stage text,
    is_korean boolean GENERATED ALWAYS AS ((text ~ '[가-힣]'::text)) STORED,
    lang text,
    regions text[]
);


--
-- Name: scope_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_runs (
    run_id uuid NOT NULL,
    status text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    total_jobs integer,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid,
    cycle_anchor_at timestamp with time zone
);


--
-- Name: scope_sync_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_sync_cursors (
    project_id uuid NOT NULL,
    last_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text
);


--
-- Name: standard_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.standard_keywords (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    term text NOT NULL,
    source_type public.standard_keyword_source NOT NULL,
    brand text,
    enabled boolean DEFAULT true NOT NULL,
    notes text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: standard_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.standard_prompts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    text text NOT NULL,
    prompt_type public.prompt_type,
    category text,
    brand text,
    enabled boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: standard_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.standard_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    url text NOT NULL,
    channel public.standard_source_channel NOT NULL,
    brand text,
    enabled boolean DEFAULT true NOT NULL,
    notes text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: summary_cycle_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.summary_cycle_runs (
    cycle_id uuid NOT NULL,
    run_id uuid NOT NULL,
    attributed_by text NOT NULL,
    attributed_at timestamp with time zone DEFAULT now() NOT NULL,
    synced_at_seen timestamp with time zone,
    CONSTRAINT summary_cycle_runs_attributed_by_check CHECK ((attributed_by = ANY (ARRAY['scope'::text, 'derived'::text, 'operator'::text, 'late'::text])))
);


--
-- Name: summary_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.summary_cycles (
    cycle_id uuid DEFAULT gen_random_uuid() NOT NULL,
    surface text NOT NULL,
    project_id uuid NOT NULL,
    cycle_anchor_at timestamp with time zone NOT NULL,
    cycle_week date NOT NULL,
    anchor_source text NOT NULL,
    status text NOT NULL,
    closed_by text,
    closed_at timestamp with time zone,
    measured_from timestamp with time zone,
    measured_to timestamp with time zone,
    expected_units integer,
    completed_units integer,
    sealed_units integer,
    completion_ratio numeric(6,5),
    analysis_gap_ratio numeric(6,5),
    analysis_gate text,
    fleet_visible boolean DEFAULT true NOT NULL,
    active_generation_id uuid,
    view_anchor_at timestamp with time zone,
    stale_since timestamp with time zone,
    generator_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hidden_reason text,
    hidden_at timestamp with time zone,
    hidden_scope text,
    CONSTRAINT summary_cycles_analysis_gate_check CHECK ((analysis_gate = ANY (ARRAY['scope'::text, 'proxy'::text, 'override'::text]))),
    CONSTRAINT summary_cycles_anchor_source_check CHECK ((anchor_source = ANY (ARRAY['scope'::text, 'derived'::text, 'operator'::text]))),
    CONSTRAINT summary_cycles_closed_by_check CHECK ((closed_by = ANY (ARRAY['next_anchor'::text, 'complete'::text, 'recheck_window'::text, 'operator'::text]))),
    CONSTRAINT summary_cycles_hidden_reason_ck CHECK ((((hidden_reason IS NULL) AND (hidden_at IS NULL)) OR ((hidden_reason = ANY (ARRAY['collection_error'::text, 'operator'::text])) AND (hidden_at IS NOT NULL)))),
    CONSTRAINT summary_cycles_hidden_scope_ck CHECK (((hidden_scope IS NULL) OR ((hidden_reason IS NOT NULL) AND (hidden_scope = ANY (ARRAY['all'::text, 'citations'::text]))))),
    CONSTRAINT summary_cycles_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'generating'::text, 'published'::text, 'stale'::text]))),
    CONSTRAINT summary_cycles_surface_check CHECK ((surface = ANY (ARRAY['global'::text, 'website'::text, 'project'::text])))
);


--
-- Name: summary_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.summary_settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tracked_brands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tracked_brands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    canonical_name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tracked_competitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tracked_competitors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    brand_name text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_target boolean DEFAULT false NOT NULL,
    aliases text[]
);


--
-- Name: tracked_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tracked_keywords (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    term text NOT NULL,
    country text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tracked_vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tracked_vehicles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    brand text NOT NULL,
    model text NOT NULL,
    segment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    aliases text[]
);


--
-- Name: website_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website_prompts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    site_id uuid NOT NULL,
    file_seq integer NOT NULL,
    domain text NOT NULL,
    lang_code text NOT NULL,
    seq_no integer NOT NULL,
    target_url text NOT NULL,
    prompt_text text NOT NULL,
    scope_prompt_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owned_base_url text
);


--
-- Name: website_sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website_sites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand text NOT NULL,
    country_code text NOT NULL,
    scope_project_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scope_citations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_citations ALTER COLUMN id SET DEFAULT nextval('public.scope_citations_id_seq'::regclass);


--
-- Name: scope_mention_occurrences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_mention_occurrences ALTER COLUMN id SET DEFAULT nextval('public.scope_mention_occurrences_id_seq'::regclass);


--
-- Name: citation_domain_overrides citation_domain_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.citation_domain_overrides
    ADD CONSTRAINT citation_domain_overrides_pkey PRIMARY KEY (domain);


--
-- Name: entity_registry entity_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_registry
    ADD CONSTRAINT entity_registry_pkey PRIMARY KEY (entity_id);


--
-- Name: ga4_properties ga4_properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ga4_properties
    ADD CONSTRAINT ga4_properties_pkey PRIMARY KEY (id);


--
-- Name: ga4_tracked_events ga4_tracked_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ga4_tracked_events
    ADD CONSTRAINT ga4_tracked_events_pkey PRIMARY KEY (property_id, event_name);


--
-- Name: keyword_cache keyword_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_cache
    ADD CONSTRAINT keyword_cache_pkey PRIMARY KEY (cache_key);


--
-- Name: keyword_volume_cache keyword_volume_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_volume_cache
    ADD CONSTRAINT keyword_volume_cache_pkey PRIMARY KEY (id);


--
-- Name: member_audit_logs member_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_audit_logs
    ADD CONSTRAINT member_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: project_custom_fields project_custom_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_custom_fields
    ADD CONSTRAINT project_custom_fields_pkey PRIMARY KEY (id);


--
-- Name: project_engine_history project_engine_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_engine_history
    ADD CONSTRAINT project_engine_history_pkey PRIMARY KEY (id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (id);


--
-- Name: project_owned_bases project_owned_bases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_owned_bases
    ADD CONSTRAINT project_owned_bases_pkey PRIMARY KEY (id);


--
-- Name: project_tracked_urls project_tracked_urls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_tracked_urls
    ADD CONSTRAINT project_tracked_urls_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: prompt_audit_logs prompt_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_audit_logs
    ADD CONSTRAINT prompt_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: prompt_candidates prompt_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_candidates
    ADD CONSTRAINT prompt_candidates_pkey PRIMARY KEY (id);


--
-- Name: prompt_custom_field_values prompt_custom_field_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_custom_field_values
    ADD CONSTRAINT prompt_custom_field_values_pkey PRIMARY KEY (prompt_id, field_id);


--
-- Name: prompts prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_pkey PRIMARY KEY (id);


--
-- Name: qa_answer_locks qa_answer_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_answer_locks
    ADD CONSTRAINT qa_answer_locks_pkey PRIMARY KEY (job_id);


--
-- Name: qa_answer_reviews qa_answer_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_answer_reviews
    ADD CONSTRAINT qa_answer_reviews_pkey PRIMARY KEY (job_id);


--
-- Name: qa_review_notes qa_review_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_review_notes
    ADD CONSTRAINT qa_review_notes_pkey PRIMARY KEY (id);


--
-- Name: report_publications report_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_publications
    ADD CONSTRAINT report_publications_pkey PRIMARY KEY (id);


--
-- Name: report_site_engine_facts report_site_engine_facts_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_site_engine_facts
    ADD CONSTRAINT report_site_engine_facts_pk PRIMARY KEY (publication_id, file_seq, engine);


--
-- Name: report_site_facts report_site_facts_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_site_facts
    ADD CONSTRAINT report_site_facts_pk PRIMARY KEY (publication_id, file_seq);


--
-- Name: scope_acr_rollups scope_acr_rollups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_acr_rollups
    ADD CONSTRAINT scope_acr_rollups_pkey PRIMARY KEY (prompt_run_id, entity_id);


--
-- Name: scope_answer_anchors scope_answer_anchors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_answer_anchors
    ADD CONSTRAINT scope_answer_anchors_pkey PRIMARY KEY (job_id);


--
-- Name: scope_answer_cycle_anchors scope_answer_cycle_anchors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_answer_cycle_anchors
    ADD CONSTRAINT scope_answer_cycle_anchors_pkey PRIMARY KEY (job_id);


--
-- Name: scope_answer_drops scope_answer_drops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_answer_drops
    ADD CONSTRAINT scope_answer_drops_pkey PRIMARY KEY (job_id);


--
-- Name: scope_answer_stances scope_answer_stances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_answer_stances
    ADD CONSTRAINT scope_answer_stances_pkey PRIMARY KEY (job_id, turn_index, entity_id);


--
-- Name: scope_answers scope_answers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_answers
    ADD CONSTRAINT scope_answers_pkey PRIMARY KEY (job_id);


--
-- Name: scope_citations scope_citations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_citations
    ADD CONSTRAINT scope_citations_pkey PRIMARY KEY (id);


--
-- Name: scope_context_combinations scope_context_combinations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_context_combinations
    ADD CONSTRAINT scope_context_combinations_pkey PRIMARY KEY (cond_a, cond_b);


--
-- Name: scope_context_domains scope_context_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_context_domains
    ADD CONSTRAINT scope_context_domains_pkey PRIMARY KEY (entity_id, host);


--
-- Name: scope_context_drives scope_context_drives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_context_drives
    ADD CONSTRAINT scope_context_drives_pkey PRIMARY KEY (context_id, requirement_id);


--
-- Name: scope_context_entities scope_context_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_context_entities
    ADD CONSTRAINT scope_context_entities_pkey PRIMARY KEY (id);


--
-- Name: scope_context_evidence scope_context_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_context_evidence
    ADD CONSTRAINT scope_context_evidence_pkey PRIMARY KEY (id);


--
-- Name: scope_context_prompt_cache scope_context_prompt_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_context_prompt_cache
    ADD CONSTRAINT scope_context_prompt_cache_pkey PRIMARY KEY (project_id);


--
-- Name: scope_cycle_anchor_state scope_cycle_anchor_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_cycle_anchor_state
    ADD CONSTRAINT scope_cycle_anchor_state_pkey PRIMARY KEY (cycle_key);


--
-- Name: scope_cycle_registry_runs scope_cycle_registry_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_cycle_registry_runs
    ADD CONSTRAINT scope_cycle_registry_runs_pkey PRIMARY KEY (run_id);


--
-- Name: scope_cycle_rounds scope_cycle_rounds_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_cycle_rounds
    ADD CONSTRAINT scope_cycle_rounds_pk PRIMARY KEY (project_id, anchor_date);


--
-- Name: scope_mention_occurrences scope_mention_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_mention_occurrences
    ADD CONSTRAINT scope_mention_occurrences_pkey PRIMARY KEY (id);


--
-- Name: scope_mentions scope_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_mentions
    ADD CONSTRAINT scope_mentions_pkey PRIMARY KEY (job_id, entity_id);


--
-- Name: scope_mirror_progress scope_mirror_progress_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_mirror_progress
    ADD CONSTRAINT scope_mirror_progress_pk PRIMARY KEY (project_id, run_id);


--
-- Name: scope_prompts scope_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_prompts
    ADD CONSTRAINT scope_prompts_pkey PRIMARY KEY (prompt_id);


--
-- Name: scope_runs scope_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_runs
    ADD CONSTRAINT scope_runs_pkey PRIMARY KEY (run_id);


--
-- Name: scope_sync_cursors scope_sync_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_sync_cursors
    ADD CONSTRAINT scope_sync_cursors_pkey PRIMARY KEY (project_id);


--
-- Name: standard_keywords standard_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.standard_keywords
    ADD CONSTRAINT standard_keywords_pkey PRIMARY KEY (id);


--
-- Name: standard_prompts standard_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.standard_prompts
    ADD CONSTRAINT standard_prompts_pkey PRIMARY KEY (id);


--
-- Name: standard_sources standard_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.standard_sources
    ADD CONSTRAINT standard_sources_pkey PRIMARY KEY (id);


--
-- Name: summary_cycle_runs summary_cycle_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_cycle_runs
    ADD CONSTRAINT summary_cycle_runs_pkey PRIMARY KEY (cycle_id, run_id);


--
-- Name: summary_cycle_runs summary_cycle_runs_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_cycle_runs
    ADD CONSTRAINT summary_cycle_runs_run_id_key UNIQUE (run_id);


--
-- Name: summary_cycles summary_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_cycles
    ADD CONSTRAINT summary_cycles_pkey PRIMARY KEY (cycle_id);


--
-- Name: summary_cycles summary_cycles_project_id_cycle_anchor_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_cycles
    ADD CONSTRAINT summary_cycles_project_id_cycle_anchor_at_key UNIQUE (project_id, cycle_anchor_at);


--
-- Name: summary_settings summary_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_settings
    ADD CONSTRAINT summary_settings_pkey PRIMARY KEY (key);


--
-- Name: tracked_brands tracked_brands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracked_brands
    ADD CONSTRAINT tracked_brands_pkey PRIMARY KEY (id);


--
-- Name: tracked_competitors tracked_competitors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracked_competitors
    ADD CONSTRAINT tracked_competitors_pkey PRIMARY KEY (id);


--
-- Name: tracked_keywords tracked_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracked_keywords
    ADD CONSTRAINT tracked_keywords_pkey PRIMARY KEY (id);


--
-- Name: tracked_vehicles tracked_vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracked_vehicles
    ADD CONSTRAINT tracked_vehicles_pkey PRIMARY KEY (id);


--
-- Name: website_prompts website_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_prompts
    ADD CONSTRAINT website_prompts_pkey PRIMARY KEY (id);


--
-- Name: website_sites website_sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_sites
    ADD CONSTRAINT website_sites_pkey PRIMARY KEY (id);


--
-- Name: citation_domain_overrides_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX citation_domain_overrides_updated_idx ON public.citation_domain_overrides USING btree (updated_at DESC);


--
-- Name: ga4_properties_brand_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ga4_properties_brand_country_idx ON public.ga4_properties USING btree (brand, country_code);


--
-- Name: ga4_tracked_events_property_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ga4_tracked_events_property_idx ON public.ga4_tracked_events USING btree (property_id);


--
-- Name: keyword_volume_cache_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX keyword_volume_cache_expires_idx ON public.keyword_volume_cache USING btree (expires_at);


--
-- Name: keyword_volume_cache_keyword_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX keyword_volume_cache_keyword_idx ON public.keyword_volume_cache USING btree (keyword);


--
-- Name: member_audit_logs_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_audit_logs_actor_idx ON public.member_audit_logs USING btree (actor_id);


--
-- Name: member_audit_logs_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_audit_logs_project_idx ON public.member_audit_logs USING btree (project_id, created_at DESC);


--
-- Name: member_audit_logs_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_audit_logs_target_idx ON public.member_audit_logs USING btree (target_user_id);


--
-- Name: project_custom_fields_project_label_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX project_custom_fields_project_label_unique ON public.project_custom_fields USING btree (project_id, label);


--
-- Name: project_engine_history_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_engine_history_project_idx ON public.project_engine_history USING btree (project_id, changed_at DESC);


--
-- Name: project_members_project_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX project_members_project_user_unique ON public.project_members USING btree (project_id, user_id);


--
-- Name: project_owned_bases_project_base_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX project_owned_bases_project_base_unique ON public.project_owned_bases USING btree (project_id, base_url);


--
-- Name: project_owned_bases_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_owned_bases_project_idx ON public.project_owned_bases USING btree (project_id);


--
-- Name: project_tracked_urls_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_tracked_urls_project_idx ON public.project_tracked_urls USING btree (project_id);


--
-- Name: project_tracked_urls_project_url_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX project_tracked_urls_project_url_unique ON public.project_tracked_urls USING btree (project_id, url);


--
-- Name: prompt_audit_logs_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_audit_logs_batch_idx ON public.prompt_audit_logs USING btree (batch_id);


--
-- Name: prompt_audit_logs_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_audit_logs_project_idx ON public.prompt_audit_logs USING btree (project_id, created_at DESC);


--
-- Name: prompt_audit_logs_prompt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_audit_logs_prompt_idx ON public.prompt_audit_logs USING btree (prompt_id, created_at DESC);


--
-- Name: prompt_candidates_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_candidates_project_idx ON public.prompt_candidates USING btree (project_id);


--
-- Name: prompt_custom_field_values_field_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_custom_field_values_field_idx ON public.prompt_custom_field_values USING btree (field_id);


--
-- Name: prompts_project_brand_presence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompts_project_brand_presence_idx ON public.prompts USING btree (project_id, brand_presence);


--
-- Name: prompts_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompts_project_idx ON public.prompts USING btree (project_id);


--
-- Name: prompts_scope_prompt_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompts_scope_prompt_id_idx ON public.prompts USING btree (scope_prompt_id) INCLUDE (funnel_stage);


--
-- Name: qa_answer_locks_heartbeat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_answer_locks_heartbeat_idx ON public.qa_answer_locks USING btree (heartbeat_at);


--
-- Name: qa_answer_reviews_reviewer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_answer_reviews_reviewer_idx ON public.qa_answer_reviews USING btree (reviewer_name);


--
-- Name: qa_answer_reviews_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_answer_reviews_status_idx ON public.qa_answer_reviews USING btree (status);


--
-- Name: qa_review_notes_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_review_notes_created_idx ON public.qa_review_notes USING btree (created_at DESC);


--
-- Name: qa_review_notes_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_review_notes_job_idx ON public.qa_review_notes USING btree (job_id);


--
-- Name: qa_review_notes_unresolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qa_review_notes_unresolved_idx ON public.qa_review_notes USING btree (resolved_at) WHERE (resolved_at IS NULL);


--
-- Name: report_publications_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX report_publications_active_uq ON public.report_publications USING btree (surface, round_date, brand_scope) WHERE (status = 'active'::text);


--
-- Name: report_publications_sha_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_publications_sha_idx ON public.report_publications USING btree (source_sha256);


--
-- Name: report_publications_slug_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX report_publications_slug_uq ON public.report_publications USING btree (slug);


--
-- Name: report_site_facts_fs_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_site_facts_fs_idx ON public.report_site_facts USING btree (file_seq);


--
-- Name: scope_acr_rollups_brand_rollup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_acr_rollups_brand_rollup_idx ON public.scope_acr_rollups USING btree (brand_rollup_entity_id);


--
-- Name: scope_acr_rollups_prompt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_acr_rollups_prompt_idx ON public.scope_acr_rollups USING btree (prompt_id);


--
-- Name: scope_acr_rollups_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_acr_rollups_run_idx ON public.scope_acr_rollups USING btree (run_id);


--
-- Name: scope_answer_anchors_anchor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answer_anchors_anchor_idx ON public.scope_answer_anchors USING btree (anchor);


--
-- Name: scope_answer_cycle_anchors_cycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answer_cycle_anchors_cycle_idx ON public.scope_answer_cycle_anchors USING btree (cycle_id) WHERE (cycle_id IS NOT NULL);


--
-- Name: scope_answer_cycle_anchors_project_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answer_cycle_anchors_project_date_idx ON public.scope_answer_cycle_anchors USING btree (project_id, anchor_date);


--
-- Name: scope_answer_cycle_anchors_rep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answer_cycle_anchors_rep_idx ON public.scope_answer_cycle_anchors USING btree (project_id, round_date, measured_at_orig DESC);


--
-- Name: scope_answer_cycle_anchors_round_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answer_cycle_anchors_round_idx ON public.scope_answer_cycle_anchors USING btree (round_date, job_id);


--
-- Name: scope_answer_cycle_anchors_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answer_cycle_anchors_run_idx ON public.scope_answer_cycle_anchors USING btree (run_id);


--
-- Name: scope_answer_cycle_anchors_surface_round_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answer_cycle_anchors_surface_round_idx ON public.scope_answer_cycle_anchors USING btree (surface, round_date);


--
-- Name: scope_answer_cycle_anchors_week_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answer_cycle_anchors_week_idx ON public.scope_answer_cycle_anchors USING btree (anchor_week);


--
-- Name: scope_answers_measured_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answers_measured_at_idx ON public.scope_answers USING btree (measured_at DESC) WHERE (status = 'completed'::text);


--
-- Name: scope_answers_measured_cursor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answers_measured_cursor_idx ON public.scope_answers USING btree (measured_at DESC, job_id);


--
-- Name: scope_answers_prompt_lens_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answers_prompt_lens_idx ON public.scope_answers USING btree (target, measured_at, prompt_id) WHERE (status = 'completed'::text);


--
-- Name: scope_answers_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answers_region_idx ON public.scope_answers USING btree (region);


--
-- Name: scope_answers_run_cycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answers_run_cycle_idx ON public.scope_answers USING btree (run_id, prompt_id, region, target, measured_at DESC) INCLUDE (job_id) WHERE (status = 'completed'::text);


--
-- Name: scope_answers_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answers_run_idx ON public.scope_answers USING btree (run_id);


--
-- Name: scope_answers_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answers_snapshot_idx ON public.scope_answers USING btree (prompt_id, target, region, measured_at DESC) WHERE (status = 'completed'::text);


--
-- Name: scope_answers_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_answers_target_idx ON public.scope_answers USING btree (target);


--
-- Name: scope_citations_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_citations_domain_idx ON public.scope_citations USING btree (domain);


--
-- Name: scope_citations_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_citations_job_idx ON public.scope_citations USING btree (job_id);


--
-- Name: scope_citations_lower_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_citations_lower_domain_idx ON public.scope_citations USING btree (lower(domain), job_id);


--
-- Name: scope_context_combinations_cocount_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_context_combinations_cocount_idx ON public.scope_context_combinations USING btree (co_count DESC);


--
-- Name: scope_context_drives_requirement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_context_drives_requirement_idx ON public.scope_context_drives USING btree (requirement_id);


--
-- Name: scope_context_entities_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_context_entities_type_idx ON public.scope_context_entities USING btree (type);


--
-- Name: scope_context_entities_type_mentions_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_context_entities_type_mentions_idx ON public.scope_context_entities USING btree (type, mention_count DESC);


--
-- Name: scope_context_evidence_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_context_evidence_entity_idx ON public.scope_context_evidence USING btree (entity_id);


--
-- Name: scope_cycle_anchor_state_project_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_cycle_anchor_state_project_date_idx ON public.scope_cycle_anchor_state USING btree (project_id, anchor_date);


--
-- Name: scope_cycle_registry_runs_cycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_cycle_registry_runs_cycle_idx ON public.scope_cycle_registry_runs USING btree (cycle_key);


--
-- Name: scope_cycle_rounds_round_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_cycle_rounds_round_idx ON public.scope_cycle_rounds USING btree (surface, round_date);


--
-- Name: scope_cycle_rounds_seat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_cycle_rounds_seat_idx ON public.scope_cycle_rounds USING btree (project_id, round_date);


--
-- Name: scope_mention_occurrences_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_mention_occurrences_job_idx ON public.scope_mention_occurrences USING btree (job_id);


--
-- Name: scope_mentions_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_mentions_brand_idx ON public.scope_mentions USING btree (brand);


--
-- Name: scope_mentions_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_mentions_job_idx ON public.scope_mentions USING btree (job_id);


--
-- Name: scope_mentions_rollup_names_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_mentions_rollup_names_idx ON public.scope_mentions USING btree (entity_type, entity_id, brand) WHERE (brand IS NOT NULL);


--
-- Name: scope_mirror_progress_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_mirror_progress_pending_idx ON public.scope_mirror_progress USING btree (created_at, project_id, run_id) WHERE (phase <> ALL (ARRAY['complete'::text, 'blocked'::text]));


--
-- Name: scope_runs_project_cycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_runs_project_cycle_idx ON public.scope_runs USING btree (project_id, cycle_anchor_at);


--
-- Name: scope_runs_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_runs_project_idx ON public.scope_runs USING btree (project_id);


--
-- Name: scope_sync_cursors_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scope_sync_cursors_attempt_idx ON public.scope_sync_cursors USING btree (last_attempt_at);


--
-- Name: standard_keywords_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX standard_keywords_brand_idx ON public.standard_keywords USING btree (brand);


--
-- Name: standard_keywords_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX standard_keywords_enabled_idx ON public.standard_keywords USING btree (enabled);


--
-- Name: standard_keywords_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX standard_keywords_source_idx ON public.standard_keywords USING btree (source_type);


--
-- Name: standard_prompts_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX standard_prompts_brand_idx ON public.standard_prompts USING btree (brand);


--
-- Name: standard_prompts_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX standard_prompts_enabled_idx ON public.standard_prompts USING btree (enabled);


--
-- Name: standard_sources_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX standard_sources_brand_idx ON public.standard_sources USING btree (brand);


--
-- Name: standard_sources_channel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX standard_sources_channel_idx ON public.standard_sources USING btree (channel);


--
-- Name: standard_sources_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX standard_sources_enabled_idx ON public.standard_sources USING btree (enabled);


--
-- Name: summary_cycles_pick_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX summary_cycles_pick_idx ON public.summary_cycles USING btree (surface, project_id, cycle_anchor_at DESC) WHERE (view_anchor_at IS NOT NULL);


--
-- Name: summary_cycles_week_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX summary_cycles_week_idx ON public.summary_cycles USING btree (surface, cycle_week) WHERE (view_anchor_at IS NOT NULL);


--
-- Name: tracked_brands_project_canonical_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tracked_brands_project_canonical_unique ON public.tracked_brands USING btree (project_id, canonical_name);


--
-- Name: tracked_brands_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tracked_brands_project_idx ON public.tracked_brands USING btree (project_id);


--
-- Name: tracked_competitors_one_target_per_project; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tracked_competitors_one_target_per_project ON public.tracked_competitors USING btree (project_id) WHERE is_target;


--
-- Name: tracked_competitors_project_brand_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tracked_competitors_project_brand_unique ON public.tracked_competitors USING btree (project_id, brand_name);


--
-- Name: tracked_competitors_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tracked_competitors_project_idx ON public.tracked_competitors USING btree (project_id);


--
-- Name: tracked_keywords_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tracked_keywords_project_idx ON public.tracked_keywords USING btree (project_id);


--
-- Name: tracked_keywords_project_term_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tracked_keywords_project_term_unique ON public.tracked_keywords USING btree (project_id, term);


--
-- Name: tracked_vehicles_project_brand_model_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tracked_vehicles_project_brand_model_unique ON public.tracked_vehicles USING btree (project_id, brand, model);


--
-- Name: tracked_vehicles_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tracked_vehicles_project_idx ON public.tracked_vehicles USING btree (project_id);


--
-- Name: website_prompts_lang_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_prompts_lang_idx ON public.website_prompts USING btree (site_id, lang_code);


--
-- Name: website_prompts_site_file_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX website_prompts_site_file_seq_idx ON public.website_prompts USING btree (site_id, file_seq, seq_no);


--
-- Name: website_prompts_site_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_prompts_site_id_idx ON public.website_prompts USING btree (site_id);


--
-- Name: website_sites_brand_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX website_sites_brand_country_idx ON public.website_sites USING btree (brand, country_code);


--
-- Name: website_sites_scope_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_sites_scope_project_idx ON public.website_sites USING btree (scope_project_id);


--
-- Name: summary_cycle_runs summary_cycle_runs_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_cycle_runs
    ADD CONSTRAINT summary_cycle_runs_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.summary_cycles(cycle_id);


--
-- Name: website_prompts website_prompts_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_prompts
    ADD CONSTRAINT website_prompts_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.website_sites(id) ON DELETE CASCADE;


--
-- Name: citation_domain_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.citation_domain_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: project_engine_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_engine_history ENABLE ROW LEVEL SECURITY;

--
-- Name: prompt_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prompt_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: scope_sync_cursors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scope_sync_cursors ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict STztmGYYSC7OMhHoqEgcmTeeGVzYJ4HX9hRQbK1ER7tXDd6QHD0N5yYURSm0aRp

