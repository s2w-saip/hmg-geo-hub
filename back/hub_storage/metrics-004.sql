-- GA4 collected data, SEO, their dimensions and build records (2026-11-06, D-17): the structure of the analytics, ref and ops schemas of the former data store, taken
-- from its schema dump, without the GA4 registry (input-003.sql) and that store's migration table. GA4's rows are collected values, not Gold in the SSOT's sense
-- (pre-computed values), so they keep their own schemas. hmg_analytics_reader and hmg_analytics_writer keep their names and reach these schemas only, not gold.
SET LOCAL check_function_bodies = false;
CREATE SCHEMA analytics;
CREATE SCHEMA ops;
CREATE SCHEMA ref;
COMMENT ON SCHEMA ref IS 'Local reference keys. Cross-database matching uses project UUID, country/engine code and url_norm, never bare integer keys.';
CREATE FUNCTION ops.bump_data_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
    INSERT INTO ops.data_version(scope,version) VALUES(TG_ARGV[0],1)
    ON CONFLICT(scope) DO UPDATE SET version=ops.data_version.version+1,updated_at=now();
    RETURN NULL;
END $$;
CREATE FUNCTION ops.guard_validated_build() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status='validated' THEN
        RAISE EXCEPTION 'Validated SEO builds are immutable; create another build' USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION ops.guard_vis_build() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE state text;
BEGIN
    SELECT status INTO state FROM ops.build WHERE build_id=coalesce(NEW.build_id,OLD.build_id) FOR SHARE;
    IF state IS DISTINCT FROM 'running' THEN
        RAISE EXCEPTION 'SEO rows can only change in a running local build' USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND NEW.build_id<>OLD.build_id THEN
        RAISE EXCEPTION 'Move a row by creating a new build' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION ops.publish_seo_build(p_project smallint, p_date date, p_build bigint, p_expected_previous bigint) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE state text; previous bigint; next_version bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('hmg-seo:'||p_project::text||':'||p_date::text,0));
    SELECT status INTO state FROM ops.build WHERE build_id=p_build FOR SHARE;
    IF state IS DISTINCT FROM 'validated' THEN
        RAISE EXCEPTION 'Only validated local SEO builds can be published' USING ERRCODE='55000';
    END IF;
    SELECT build_id INTO previous FROM ops.seo_active_build WHERE project_key=p_project AND date=p_date;
    IF previous IS DISTINCT FROM p_expected_previous THEN
        RAISE EXCEPTION 'SEO publication changed; reload the current pointer' USING ERRCODE='40001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM analytics.page_visibility_daily p
        WHERE p.build_id=p_build AND p.project_key=p_project AND p.date=p_date AND
          (p.ai_crawls IS NULL OR p.seo_impressions IS NULL OR
           p.ai_crawls <> (SELECT coalesce(sum(c.hits),0) FROM analytics.page_crawl_daily c
               WHERE (c.build_id,c.project_key,c.url_key,c.date)=(p.build_id,p.project_key,p.url_key,p.date)) OR
           p.seo_impressions <> (SELECT coalesce(sum(d.seo_impressions),0) FROM analytics.page_seo_device_daily d
               WHERE (d.build_id,d.project_key,d.url_key,d.date)=(p.build_id,p.project_key,p.url_key,p.date)))
    ) THEN
        RAISE EXCEPTION 'SEO crawl/device sums do not match the page totals' USING ERRCODE='23514';
    END IF;
    INSERT INTO ops.seo_active_build(project_key,date,build_id) VALUES(p_project,p_date,p_build)
    ON CONFLICT(project_key,date) DO UPDATE SET build_id=excluded.build_id,version=ops.seo_active_build.version+1,updated_at=now()
    RETURNING version INTO next_version;
    INSERT INTO ops.data_version(scope,version) VALUES('seo',1)
    ON CONFLICT(scope) DO UPDATE SET version=ops.data_version.version+1,updated_at=now();
    RETURN next_version;
END $$;
CREATE TABLE analytics.page_crawl_daily (
    build_id bigint NOT NULL,
    project_key smallint NOT NULL,
    url_key integer NOT NULL,
    date date NOT NULL,
    bot_key smallint NOT NULL,
    hits integer,
    CONSTRAINT page_crawl_daily_hits_check CHECK ((hits >= 0))
);
CREATE TABLE ops.seo_active_build (
    project_key smallint NOT NULL,
    date date NOT NULL,
    build_id bigint NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT seo_active_build_version_check CHECK ((version > 0))
);
COMMENT ON TABLE ops.seo_active_build IS 'HUB-local publication pointer; independent from the remote Gold manifest.';
CREATE VIEW analytics.current_page_crawl_daily AS
 SELECT p.build_id,
    p.project_key,
    p.url_key,
    p.date,
    p.bot_key,
    p.hits
   FROM (analytics.page_crawl_daily p
     JOIN ops.seo_active_build a ON (((a.project_key = p.project_key) AND (a.date = p.date) AND (a.build_id = p.build_id))));
CREATE TABLE analytics.page_priority (
    build_id bigint NOT NULL,
    project_key smallint NOT NULL,
    url_key integer NOT NULL,
    priority smallint,
    rule_ver text,
    CONSTRAINT page_priority_priority_check CHECK (((priority >= 1) AND (priority <= 3)))
);
CREATE VIEW analytics.current_page_priority AS
 SELECT DISTINCT p.build_id,
    p.project_key,
    p.url_key,
    p.priority,
    p.rule_ver
   FROM (analytics.page_priority p
     JOIN ops.seo_active_build a ON (((a.project_key = p.project_key) AND (a.build_id = p.build_id))));
CREATE TABLE analytics.page_seo_device_daily (
    build_id bigint NOT NULL,
    project_key smallint NOT NULL,
    url_key integer NOT NULL,
    date date NOT NULL,
    device_key integer NOT NULL,
    seo_impressions integer,
    device_kind text GENERATED ALWAYS AS ('device'::text) STORED,
    CONSTRAINT page_seo_device_daily_seo_impressions_check CHECK ((seo_impressions >= 0))
);
CREATE VIEW analytics.current_page_seo_device_daily AS
 SELECT p.build_id,
    p.project_key,
    p.url_key,
    p.date,
    p.device_key,
    p.seo_impressions,
    p.device_kind
   FROM (analytics.page_seo_device_daily p
     JOIN ops.seo_active_build a ON (((a.project_key = p.project_key) AND (a.date = p.date) AND (a.build_id = p.build_id))));
CREATE TABLE analytics.page_visibility_daily (
    build_id bigint NOT NULL,
    project_key smallint NOT NULL,
    url_key integer NOT NULL,
    geo_key smallint,
    date date NOT NULL,
    seo_impressions integer,
    ai_crawls integer,
    CONSTRAINT page_visibility_daily_check CHECK (((seo_impressions >= 0) AND (ai_crawls >= 0)))
);
CREATE VIEW analytics.current_page_visibility_daily AS
 SELECT p.build_id,
    p.project_key,
    p.url_key,
    p.geo_key,
    p.date,
    p.seo_impressions,
    p.ai_crawls
   FROM (analytics.page_visibility_daily p
     JOIN ops.seo_active_build a ON (((a.project_key = p.project_key) AND (a.date = p.date) AND (a.build_id = p.build_id))));
CREATE TABLE analytics.dim_crawl_bot (
    bot_key smallint NOT NULL,
    code text,
    engine_key smallint
);
ALTER TABLE analytics.dim_crawl_bot ALTER COLUMN bot_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME analytics.dim_crawl_bot_bot_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE analytics.ga4_property (
    prop_key smallint NOT NULL,
    property_id text,
    brand_bit integer,
    geo_key smallint,
    status text,
    source text,
    conv_basis smallint,
    CONSTRAINT ga4_property_conv_basis_check CHECK ((conv_basis = ANY (ARRAY[1, 2]))),
    CONSTRAINT ga4_property_source_check CHECK ((source = ANY (ARRAY['registry'::text, 'project_override'::text, 'env'::text]))),
    CONSTRAINT ga4_property_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending_grant'::text, 'unmapped'::text])))
);
ALTER TABLE analytics.ga4_property ALTER COLUMN prop_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME analytics.ga4_property_prop_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE analytics.ga4_row (
    prop_key smallint NOT NULL,
    date date NOT NULL,
    report smallint NOT NULL,
    channel_key integer NOT NULL,
    source_key integer NOT NULL,
    device_key integer NOT NULL,
    nvr_key integer NOT NULL,
    page_key integer NOT NULL,
    event_key integer NOT NULL,
    is_ai boolean,
    engine_key smallint,
    is_conv boolean,
    sessions integer,
    users_day integer,
    page_views integer,
    key_events integer,
    event_count integer,
    channel_kind text GENERATED ALWAYS AS ('channel'::text) STORED,
    source_kind text GENERATED ALWAYS AS ('source'::text) STORED,
    device_kind text GENERATED ALWAYS AS ('device'::text) STORED,
    nvr_kind text GENERATED ALWAYS AS ('nvr'::text) STORED,
    page_kind text GENERATED ALWAYS AS ('page'::text) STORED,
    event_kind text GENERATED ALWAYS AS ('event'::text) STORED,
    CONSTRAINT ga4_row_check CHECK (((sessions >= 0) AND (users_day >= 0) AND (page_views >= 0) AND (key_events >= 0) AND (event_count >= 0))),
    CONSTRAINT ga4_row_report_check CHECK (((report >= 1) AND (report <= 5)))
);
COMMENT ON COLUMN analytics.ga4_row.users_day IS 'Non-additive distinct daily users; do not sum across dates or dimension rows.';
CREATE TABLE analytics.ga4_users_window (
    prop_key smallint NOT NULL,
    window_end date NOT NULL,
    window_days integer NOT NULL,
    cohort text NOT NULL,
    engine_mask integer NOT NULL,
    device_mask integer NOT NULL,
    nvr_mask integer NOT NULL,
    page_key integer NOT NULL,
    users integer,
    page_kind text GENERATED ALWAYS AS ('page'::text) STORED,
    CONSTRAINT ga4_users_window_check CHECK (((window_days > 0) AND (users >= 0) AND (engine_mask >= 0) AND (device_mask >= 0) AND (nvr_mask >= 0))),
    CONSTRAINT ga4_users_window_cohort_check CHECK ((cohort = ANY (ARRAY['ai'::text, 'total'::text, 'general'::text])))
);
COMMENT ON TABLE analytics.ga4_users_window IS 'Exact GA4 period users. Never derive this by adding users_day.';
CREATE TABLE analytics.ga4_value (
    kind text NOT NULL,
    value_key integer NOT NULL,
    value text,
    url_key integer,
    CONSTRAINT ga4_value_check CHECK (((kind = 'page'::text) OR (url_key IS NULL))),
    CONSTRAINT ga4_value_kind_check CHECK ((kind = ANY (ARRAY['channel'::text, 'source'::text, 'device'::text, 'nvr'::text, 'event'::text, 'page'::text])))
);
CREATE TABLE ops.build (
    build_id bigint NOT NULL,
    family text DEFAULT 'vis'::text NOT NULL,
    slice_key text,
    input_snapshot text,
    watermark text,
    profile_signature text,
    metric_version text,
    ecat_ver text,
    rule_ver text,
    status text DEFAULT 'pending'::text NOT NULL,
    row_counts jsonb,
    verify jsonb,
    error text,
    attempt integer,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT build_family_check CHECK ((family = 'vis'::text)),
    CONSTRAINT build_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'validated'::text, 'failed'::text])))
);
ALTER TABLE ops.build ALTER COLUMN build_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ops.build_build_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE ops.data_version (
    scope text NOT NULL,
    version bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_version_scope_check CHECK ((scope = ANY (ARRAY['ref'::text, 'ga4'::text, 'seo'::text]))),
    CONSTRAINT data_version_version_check CHECK ((version > 0))
);
CREATE TABLE ref.dim_project (
    project_key smallint NOT NULL,
    scope_project_id uuid,
    surface smallint,
    is_root boolean,
    project_id uuid,
    site_id uuid,
    site_brand_bit integer,
    site_geo_key smallint,
    regions text[]
);
CREATE TABLE ref.dim_country (
    geo_key smallint NOT NULL,
    code text,
    region_key smallint,
    kind text,
    virtual_brand_bit integer,
    hidden_standard boolean
);
CREATE TABLE ref.dim_engine (
    engine_key smallint NOT NULL,
    code text,
    is_default boolean
);
CREATE TABLE ref.dim_url (
    url_key integer NOT NULL,
    url_hash text,
    url text,
    title text,
    url_norm text,
    url_base_norm text,
    host text,
    domain text,
    source_key integer,
    owner_key smallint,
    rule_ver text
);
CREATE TABLE ref.dim_brand (
    brand_key integer NOT NULL,
    name text,
    bare text,
    kind smallint,
    own_bit integer,
    first_seen date
);
ALTER TABLE ref.dim_brand ALTER COLUMN brand_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_brand_brand_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE ref.dim_category (
    category_key smallint NOT NULL,
    name text,
    slug text,
    ord integer
);
ALTER TABLE ref.dim_category ALTER COLUMN category_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_category_category_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
ALTER TABLE ref.dim_country ALTER COLUMN geo_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_country_geo_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
ALTER TABLE ref.dim_engine ALTER COLUMN engine_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_engine_engine_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE ref.dim_owned_base (
    owner_key smallint NOT NULL,
    kind text,
    prefix text,
    host text,
    brand_code text,
    brand_bit integer,
    geo_code text,
    language text
);
ALTER TABLE ref.dim_owned_base ALTER COLUMN owner_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_owned_base_owner_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
ALTER TABLE ref.dim_project ALTER COLUMN project_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_project_project_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE ref.dim_region (
    region_key smallint NOT NULL,
    code text
);
ALTER TABLE ref.dim_region ALTER COLUMN region_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_region_region_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE ref.dim_source (
    source_key integer NOT NULL,
    skey text,
    domain text,
    is_social boolean,
    category_key smallint,
    category_src smallint,
    owned_brand_bit integer,
    competitor_brand_key integer,
    rule_ver text
);
ALTER TABLE ref.dim_source ALTER COLUMN source_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_source_source_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
ALTER TABLE ref.dim_url ALTER COLUMN url_key ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME ref.dim_url_url_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
ALTER TABLE ONLY analytics.dim_crawl_bot
    ADD CONSTRAINT dim_crawl_bot_code_key UNIQUE (code);
ALTER TABLE ONLY analytics.dim_crawl_bot
    ADD CONSTRAINT dim_crawl_bot_pkey PRIMARY KEY (bot_key);
ALTER TABLE ONLY analytics.ga4_property
    ADD CONSTRAINT ga4_property_pkey PRIMARY KEY (prop_key);
ALTER TABLE ONLY analytics.ga4_property
    ADD CONSTRAINT ga4_property_property_id_key UNIQUE (property_id);
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ga4_row_pkey PRIMARY KEY (prop_key, report, date, channel_key, source_key, device_key, nvr_key, page_key, event_key);
ALTER TABLE ONLY analytics.ga4_users_window
    ADD CONSTRAINT ga4_users_window_pkey PRIMARY KEY (prop_key, window_end, window_days, cohort, engine_mask, device_mask, nvr_mask, page_key);
ALTER TABLE ONLY analytics.ga4_value
    ADD CONSTRAINT ga4_value_pkey PRIMARY KEY (kind, value_key);
ALTER TABLE ONLY analytics.page_crawl_daily
    ADD CONSTRAINT page_crawl_daily_pkey PRIMARY KEY (build_id, project_key, url_key, date, bot_key);
ALTER TABLE ONLY analytics.page_priority
    ADD CONSTRAINT page_priority_pkey PRIMARY KEY (build_id, project_key, url_key);
ALTER TABLE ONLY analytics.page_seo_device_daily
    ADD CONSTRAINT page_seo_device_daily_pkey PRIMARY KEY (build_id, project_key, url_key, date, device_key);
ALTER TABLE ONLY analytics.page_visibility_daily
    ADD CONSTRAINT page_visibility_daily_pkey PRIMARY KEY (build_id, project_key, url_key, date);
ALTER TABLE ONLY ops.build
    ADD CONSTRAINT build_pkey PRIMARY KEY (build_id);
ALTER TABLE ONLY ops.data_version
    ADD CONSTRAINT data_version_pkey PRIMARY KEY (scope);
ALTER TABLE ONLY ops.seo_active_build
    ADD CONSTRAINT seo_active_build_pkey PRIMARY KEY (project_key, date);
ALTER TABLE ONLY ref.dim_brand
    ADD CONSTRAINT dim_brand_bare_key UNIQUE (bare);
ALTER TABLE ONLY ref.dim_brand
    ADD CONSTRAINT dim_brand_name_key UNIQUE (name);
ALTER TABLE ONLY ref.dim_brand
    ADD CONSTRAINT dim_brand_pkey PRIMARY KEY (brand_key);
ALTER TABLE ONLY ref.dim_category
    ADD CONSTRAINT dim_category_name_key UNIQUE (name);
ALTER TABLE ONLY ref.dim_category
    ADD CONSTRAINT dim_category_pkey PRIMARY KEY (category_key);
ALTER TABLE ONLY ref.dim_country
    ADD CONSTRAINT dim_country_pkey PRIMARY KEY (geo_key);
ALTER TABLE ONLY ref.dim_engine
    ADD CONSTRAINT dim_engine_code_key UNIQUE (code);
ALTER TABLE ONLY ref.dim_engine
    ADD CONSTRAINT dim_engine_pkey PRIMARY KEY (engine_key);
ALTER TABLE ONLY ref.dim_owned_base
    ADD CONSTRAINT dim_owned_base_kind_prefix_key UNIQUE (kind, prefix);
ALTER TABLE ONLY ref.dim_owned_base
    ADD CONSTRAINT dim_owned_base_pkey PRIMARY KEY (owner_key);
ALTER TABLE ONLY ref.dim_project
    ADD CONSTRAINT dim_project_pkey PRIMARY KEY (project_key);
ALTER TABLE ONLY ref.dim_project
    ADD CONSTRAINT dim_project_scope_project_id_key UNIQUE (scope_project_id);
ALTER TABLE ONLY ref.dim_region
    ADD CONSTRAINT dim_region_code_key UNIQUE (code);
ALTER TABLE ONLY ref.dim_region
    ADD CONSTRAINT dim_region_pkey PRIMARY KEY (region_key);
ALTER TABLE ONLY ref.dim_source
    ADD CONSTRAINT dim_source_pkey PRIMARY KEY (source_key);
ALTER TABLE ONLY ref.dim_source
    ADD CONSTRAINT dim_source_skey_key UNIQUE (skey);
ALTER TABLE ONLY ref.dim_url
    ADD CONSTRAINT dim_url_pkey PRIMARY KEY (url_key);
ALTER TABLE ONLY ref.dim_url
    ADD CONSTRAINT dim_url_url_hash_key UNIQUE (url_hash);
CREATE INDEX ga4_row_ai_engine ON analytics.ga4_row USING btree (prop_key, date, engine_key) WHERE is_ai;
CREATE INDEX ga4_row_date_property ON analytics.ga4_row USING btree (date, prop_key, report);
CREATE INDEX ga4_value_page_url ON analytics.ga4_value USING btree (url_key) WHERE (kind = 'page'::text);
CREATE INDEX ga4_window_lookup ON analytics.ga4_users_window USING btree (window_end, window_days, prop_key, cohort);
CREATE INDEX seo_build_lookup ON analytics.page_visibility_daily USING btree (build_id);
CREATE INDEX seo_country_date ON analytics.page_visibility_daily USING btree (geo_key, date);
CREATE INDEX seo_page_lookup ON analytics.page_visibility_daily USING btree (project_key, date, url_key, build_id);
CREATE UNIQUE INDEX dim_country_code_ci ON ref.dim_country USING btree (lower(code));
CREATE INDEX dim_url_norm_lookup ON ref.dim_url USING btree (url_norm) WHERE (url_norm IS NOT NULL);
CREATE TRIGGER crawl_build_guard BEFORE INSERT OR DELETE OR UPDATE ON analytics.page_crawl_daily FOR EACH ROW EXECUTE FUNCTION ops.guard_vis_build();
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON analytics.ga4_property FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ga4');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON analytics.ga4_row FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ga4');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON analytics.ga4_users_window FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ga4');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON analytics.ga4_value FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ga4');
CREATE TRIGGER device_build_guard BEFORE INSERT OR DELETE OR UPDATE ON analytics.page_seo_device_daily FOR EACH ROW EXECUTE FUNCTION ops.guard_vis_build();
CREATE TRIGGER priority_build_guard BEFORE INSERT OR DELETE OR UPDATE ON analytics.page_priority FOR EACH ROW EXECUTE FUNCTION ops.guard_vis_build();
CREATE TRIGGER visibility_build_guard BEFORE INSERT OR DELETE OR UPDATE ON analytics.page_visibility_daily FOR EACH ROW EXECUTE FUNCTION ops.guard_vis_build();
CREATE TRIGGER build_immutable BEFORE DELETE OR UPDATE ON ops.build FOR EACH ROW EXECUTE FUNCTION ops.guard_validated_build();
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_brand FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_category FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_country FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_engine FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_owned_base FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_project FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_region FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_source FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
CREATE TRIGGER data_version AFTER INSERT OR DELETE OR UPDATE ON ref.dim_url FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version('ref');
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ga4_row_channel_fk FOREIGN KEY (channel_kind, channel_key) REFERENCES analytics.ga4_value(kind, value_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ga4_row_device_fk FOREIGN KEY (device_kind, device_key) REFERENCES analytics.ga4_value(kind, value_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ga4_row_event_fk FOREIGN KEY (event_kind, event_key) REFERENCES analytics.ga4_value(kind, value_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ga4_row_nvr_fk FOREIGN KEY (nvr_kind, nvr_key) REFERENCES analytics.ga4_value(kind, value_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ga4_row_page_fk FOREIGN KEY (page_kind, page_key) REFERENCES analytics.ga4_value(kind, value_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ga4_row_source_fk FOREIGN KEY (source_kind, source_key) REFERENCES analytics.ga4_value(kind, value_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_users_window
    ADD CONSTRAINT ga4_users_window_page_fk FOREIGN KEY (page_kind, page_key) REFERENCES analytics.ga4_value(kind, value_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_seo_device_daily
    ADD CONSTRAINT page_seo_device_daily_device_fk FOREIGN KEY (device_kind, device_key) REFERENCES analytics.ga4_value(kind, value_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ref_link_10 FOREIGN KEY (engine_key) REFERENCES ref.dim_engine(engine_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_users_window
    ADD CONSTRAINT ref_link_11 FOREIGN KEY (prop_key) REFERENCES analytics.ga4_property(prop_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.dim_crawl_bot
    ADD CONSTRAINT ref_link_12 FOREIGN KEY (engine_key) REFERENCES ref.dim_engine(engine_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_visibility_daily
    ADD CONSTRAINT ref_link_13 FOREIGN KEY (build_id) REFERENCES ops.build(build_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_visibility_daily
    ADD CONSTRAINT ref_link_14 FOREIGN KEY (project_key) REFERENCES ref.dim_project(project_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_visibility_daily
    ADD CONSTRAINT ref_link_15 FOREIGN KEY (url_key) REFERENCES ref.dim_url(url_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_visibility_daily
    ADD CONSTRAINT ref_link_16 FOREIGN KEY (geo_key) REFERENCES ref.dim_country(geo_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_crawl_daily
    ADD CONSTRAINT ref_link_17 FOREIGN KEY (build_id, project_key, url_key, date) REFERENCES analytics.page_visibility_daily(build_id, project_key, url_key, date) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_crawl_daily
    ADD CONSTRAINT ref_link_18 FOREIGN KEY (bot_key) REFERENCES analytics.dim_crawl_bot(bot_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_seo_device_daily
    ADD CONSTRAINT ref_link_19 FOREIGN KEY (build_id, project_key, url_key, date) REFERENCES analytics.page_visibility_daily(build_id, project_key, url_key, date) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_priority
    ADD CONSTRAINT ref_link_20 FOREIGN KEY (build_id) REFERENCES ops.build(build_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_priority
    ADD CONSTRAINT ref_link_21 FOREIGN KEY (project_key) REFERENCES ref.dim_project(project_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.page_priority
    ADD CONSTRAINT ref_link_22 FOREIGN KEY (url_key) REFERENCES ref.dim_url(url_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_property
    ADD CONSTRAINT ref_link_7 FOREIGN KEY (geo_key) REFERENCES ref.dim_country(geo_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_value
    ADD CONSTRAINT ref_link_8 FOREIGN KEY (url_key) REFERENCES ref.dim_url(url_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY analytics.ga4_row
    ADD CONSTRAINT ref_link_9 FOREIGN KEY (prop_key) REFERENCES analytics.ga4_property(prop_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY ops.seo_active_build
    ADD CONSTRAINT seo_active_build_build_id_fkey FOREIGN KEY (build_id) REFERENCES ops.build(build_id);
ALTER TABLE ONLY ops.seo_active_build
    ADD CONSTRAINT seo_active_build_project_key_fkey FOREIGN KEY (project_key) REFERENCES ref.dim_project(project_key);
ALTER TABLE ONLY ref.dim_country
    ADD CONSTRAINT ref_link_1 FOREIGN KEY (region_key) REFERENCES ref.dim_region(region_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY ref.dim_project
    ADD CONSTRAINT ref_link_2 FOREIGN KEY (site_geo_key) REFERENCES ref.dim_country(geo_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY ref.dim_source
    ADD CONSTRAINT ref_link_3 FOREIGN KEY (category_key) REFERENCES ref.dim_category(category_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY ref.dim_source
    ADD CONSTRAINT ref_link_4 FOREIGN KEY (competitor_brand_key) REFERENCES ref.dim_brand(brand_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY ref.dim_url
    ADD CONSTRAINT ref_link_5 FOREIGN KEY (source_key) REFERENCES ref.dim_source(source_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY ref.dim_url
    ADD CONSTRAINT ref_link_6 FOREIGN KEY (owner_key) REFERENCES ref.dim_owned_base(owner_key) DEFERRABLE INITIALLY DEFERRED;
GRANT USAGE ON SCHEMA analytics TO hmg_analytics_reader;
GRANT USAGE ON SCHEMA analytics TO hmg_analytics_writer;
GRANT USAGE ON SCHEMA ops TO hmg_analytics_reader;
GRANT USAGE ON SCHEMA ops TO hmg_analytics_writer;
GRANT USAGE ON SCHEMA ref TO hmg_analytics_reader;
GRANT USAGE ON SCHEMA ref TO hmg_analytics_writer;
REVOKE ALL ON FUNCTION ops.bump_data_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.guard_validated_build() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.guard_vis_build() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.publish_seo_build(p_project smallint, p_date date, p_build bigint, p_expected_previous bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION ops.publish_seo_build(p_project smallint, p_date date, p_build bigint, p_expected_previous bigint) TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.page_crawl_daily TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.page_crawl_daily TO hmg_analytics_writer;
GRANT SELECT ON TABLE ops.seo_active_build TO hmg_analytics_reader;
GRANT SELECT ON TABLE ops.seo_active_build TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.current_page_crawl_daily TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.current_page_crawl_daily TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.page_priority TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.page_priority TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.current_page_priority TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.current_page_priority TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.page_seo_device_daily TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.page_seo_device_daily TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.current_page_seo_device_daily TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.current_page_seo_device_daily TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.page_visibility_daily TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.page_visibility_daily TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.current_page_visibility_daily TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.current_page_visibility_daily TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.dim_crawl_bot TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.dim_crawl_bot TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE analytics.dim_crawl_bot_bot_key_seq TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ga4_property TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ga4_property TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE analytics.ga4_property_prop_key_seq TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ga4_row TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ga4_row TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ga4_users_window TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ga4_users_window TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ga4_value TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ga4_value TO hmg_analytics_writer;
GRANT SELECT ON TABLE ops.build TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.build TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ops.build_build_id_seq TO hmg_analytics_writer;
GRANT SELECT ON TABLE ops.data_version TO hmg_analytics_reader;
GRANT SELECT ON TABLE ops.data_version TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_project TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_project TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_country TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_country TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_engine TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_engine TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_url TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_url TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_brand TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_brand TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_brand_brand_key_seq TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_category TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_category TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_category_category_key_seq TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_country_geo_key_seq TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_engine_engine_key_seq TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_owned_base TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_owned_base TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_owned_base_owner_key_seq TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_project_project_key_seq TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_region TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_region TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_region_region_key_seq TO hmg_analytics_writer;
GRANT SELECT ON TABLE ref.dim_source TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ref.dim_source TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_source_source_key_seq TO hmg_analytics_writer;
GRANT SELECT,USAGE ON SEQUENCE ref.dim_url_url_key_seq TO hmg_analytics_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_metrics_owner IN SCHEMA analytics GRANT SELECT ON TABLES TO hmg_analytics_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_metrics_owner IN SCHEMA ops GRANT SELECT ON TABLES TO hmg_analytics_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_metrics_owner IN SCHEMA ref GRANT SELECT ON TABLES TO hmg_analytics_reader;
