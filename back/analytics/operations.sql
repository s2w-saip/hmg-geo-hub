-- HUB-local integrity/publication support. These objects do not depend on the Gold server.
CREATE UNIQUE INDEX dim_country_code_ci ON ref.dim_country(lower(code));
CREATE INDEX dim_url_norm_lookup ON ref.dim_url(url_norm) WHERE url_norm IS NOT NULL;

ALTER TABLE analytics.ga4_property ADD CHECK (status IN ('active','pending_grant','unmapped'));
ALTER TABLE analytics.ga4_property ADD CHECK (source IN ('registry','project_override','env'));
ALTER TABLE analytics.ga4_property ADD CHECK (conv_basis IN (1,2));
ALTER TABLE analytics.ga4_value ADD CHECK (kind IN ('channel','source','device','nvr','event','page'));
ALTER TABLE analytics.ga4_value ADD CHECK (kind='page' OR url_key IS NULL);
ALTER TABLE analytics.ga4_row ADD CHECK (report BETWEEN 1 AND 5);
ALTER TABLE analytics.ga4_row ADD CHECK (sessions>=0 AND users_day>=0 AND page_views>=0 AND key_events>=0 AND event_count>=0);
ALTER TABLE analytics.ga4_users_window ADD CHECK (window_days>0 AND users>=0 AND engine_mask>=0 AND device_mask>=0 AND nvr_mask>=0);
ALTER TABLE analytics.ga4_users_window ADD CHECK (cohort IN ('ai','total','general'));
ALTER TABLE analytics.page_visibility_daily ADD CHECK (seo_impressions>=0 AND ai_crawls>=0);
ALTER TABLE analytics.page_crawl_daily ADD CHECK (hits>=0);
ALTER TABLE analytics.page_seo_device_daily ADD CHECK (seo_impressions>=0);
ALTER TABLE analytics.page_priority ADD CHECK (priority BETWEEN 1 AND 3);

ALTER TABLE ops.build ALTER COLUMN family SET DEFAULT 'vis';
ALTER TABLE ops.build ALTER COLUMN family SET NOT NULL;
ALTER TABLE ops.build ADD CHECK (family='vis');
ALTER TABLE ops.build ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE ops.build ALTER COLUMN status SET NOT NULL;
ALTER TABLE ops.build ADD CHECK (status IN ('pending','running','validated','failed'));

CREATE TABLE ops.seo_active_build (
    project_key smallint NOT NULL REFERENCES ref.dim_project(project_key),
    date date NOT NULL,
    build_id bigint NOT NULL REFERENCES ops.build(build_id),
    version bigint NOT NULL DEFAULT 1 CHECK (version>0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_key,date)
);
CREATE TABLE ops.data_version (
    scope text PRIMARY KEY CHECK (scope IN ('ref','ga4','seo')),
    version bigint NOT NULL CHECK (version>0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ops.schema_migration (
    version text PRIMARY KEY,
    sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ga4_row_date_property ON analytics.ga4_row(date,prop_key,report);
CREATE INDEX ga4_row_ai_engine ON analytics.ga4_row(prop_key,date,engine_key) WHERE is_ai;
CREATE INDEX ga4_window_lookup ON analytics.ga4_users_window(window_end,window_days,prop_key,cohort);
CREATE INDEX ga4_value_page_url ON analytics.ga4_value(url_key) WHERE kind='page';
CREATE INDEX seo_page_lookup ON analytics.page_visibility_daily(project_key,date,url_key,build_id);
CREATE INDEX seo_country_date ON analytics.page_visibility_daily(geo_key,date);
CREATE INDEX seo_build_lookup ON analytics.page_visibility_daily(build_id);

CREATE FUNCTION ops.guard_vis_build() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE FUNCTION ops.guard_validated_build() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status='validated' THEN
        RAISE EXCEPTION 'Validated SEO builds are immutable; create another build' USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER build_immutable BEFORE UPDATE OR DELETE ON ops.build
    FOR EACH ROW EXECUTE FUNCTION ops.guard_validated_build();
CREATE TRIGGER visibility_build_guard BEFORE INSERT OR UPDATE OR DELETE ON analytics.page_visibility_daily
    FOR EACH ROW EXECUTE FUNCTION ops.guard_vis_build();
CREATE TRIGGER crawl_build_guard BEFORE INSERT OR UPDATE OR DELETE ON analytics.page_crawl_daily
    FOR EACH ROW EXECUTE FUNCTION ops.guard_vis_build();
CREATE TRIGGER device_build_guard BEFORE INSERT OR UPDATE OR DELETE ON analytics.page_seo_device_daily
    FOR EACH ROW EXECUTE FUNCTION ops.guard_vis_build();
CREATE TRIGGER priority_build_guard BEFORE INSERT OR UPDATE OR DELETE ON analytics.page_priority
    FOR EACH ROW EXECUTE FUNCTION ops.guard_vis_build();

CREATE FUNCTION ops.bump_data_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    INSERT INTO ops.data_version(scope,version) VALUES(TG_ARGV[0],1)
    ON CONFLICT(scope) DO UPDATE SET version=ops.data_version.version+1,updated_at=now();
    RETURN NULL;
END $$;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['ga4_property','ga4_value','ga4_row','ga4_users_window'] LOOP
        EXECUTE format('CREATE TRIGGER data_version AFTER INSERT OR UPDATE OR DELETE ON analytics.%I FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version(''ga4'')',t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['dim_region','dim_country','dim_engine','dim_project','dim_brand','dim_category','dim_source','dim_owned_base','dim_url'] LOOP
        EXECUTE format('CREATE TRIGGER data_version AFTER INSERT OR UPDATE OR DELETE ON ref.%I FOR EACH STATEMENT EXECUTE FUNCTION ops.bump_data_version(''ref'')',t);
    END LOOP;
END $$;

-- Validate the sums specified in the source ERD, then atomically publish one site/day.
CREATE FUNCTION ops.publish_seo_build(p_project smallint,p_date date,p_build bigint,p_expected_previous bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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

CREATE VIEW analytics.current_page_visibility_daily AS
    SELECT p.* FROM analytics.page_visibility_daily p JOIN ops.seo_active_build a
    ON (a.project_key,a.date,a.build_id)=(p.project_key,p.date,p.build_id);
CREATE VIEW analytics.current_page_crawl_daily AS
    SELECT p.* FROM analytics.page_crawl_daily p JOIN ops.seo_active_build a
    ON (a.project_key,a.date,a.build_id)=(p.project_key,p.date,p.build_id);
CREATE VIEW analytics.current_page_seo_device_daily AS
    SELECT p.* FROM analytics.page_seo_device_daily p JOIN ops.seo_active_build a
    ON (a.project_key,a.date,a.build_id)=(p.project_key,p.date,p.build_id);
CREATE VIEW analytics.current_page_priority AS
    SELECT DISTINCT p.* FROM analytics.page_priority p JOIN ops.seo_active_build a
    ON (a.project_key,a.build_id)=(p.project_key,p.build_id);

COMMENT ON TABLE analytics.ga4_users_window IS 'Exact GA4 period users. Never derive this by adding users_day.';
COMMENT ON COLUMN analytics.ga4_row.users_day IS 'Non-additive distinct daily users; do not sum across dates or dimension rows.';
COMMENT ON TABLE ops.seo_active_build IS 'HUB-local publication pointer; independent from the remote Gold manifest.';
COMMENT ON SCHEMA ref IS 'Local reference keys. Cross-database matching uses project UUID, country/engine code and url_norm, never bare integer keys.';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ref,analytics,ops TO hmg_analytics_reader,hmg_analytics_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA ref,analytics,ops TO hmg_analytics_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ref,analytics TO hmg_analytics_writer;
GRANT SELECT,INSERT,UPDATE,DELETE ON ops.build TO hmg_analytics_writer;
GRANT SELECT ON ops.seo_active_build,ops.data_version TO hmg_analytics_writer;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ref,analytics,ops TO hmg_analytics_writer;
GRANT EXECUTE ON FUNCTION ops.publish_seo_build(smallint,date,bigint,bigint) TO hmg_analytics_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_analytics_owner IN SCHEMA ref,analytics,ops
    GRANT SELECT ON TABLES TO hmg_analytics_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_analytics_owner IN SCHEMA ref,analytics,ops
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
