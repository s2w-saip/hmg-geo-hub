-- Incremental migration: preserve the existing GA4/SEO schema and all its rows.
CREATE SCHEMA catalog AUTHORIZATION hmg_analytics_owner;
CREATE SCHEMA publication AUTHORIZATION hmg_analytics_owner;
CREATE SCHEMA published AUTHORIZATION hmg_analytics_owner;

CREATE TABLE catalog.project (
    project_id uuid PRIMARY KEY,
    origin text NOT NULL CHECK(origin IN ('gold','hub')),
    source_id uuid UNIQUE,
    registered_at timestamptz NOT NULL DEFAULT now(),
    CHECK(origin<>'gold' OR source_id IS NOT NULL)
);
CREATE TABLE catalog.project_version (
    project_id uuid NOT NULL REFERENCES catalog.project,
    version integer NOT NULL CHECK(version>0),
    definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
    sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,version)
);
CREATE TABLE catalog.prompt (
    prompt_id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES catalog.project,
    origin text NOT NULL CHECK(origin IN ('gold','hub')),
    source_id uuid UNIQUE,
    registered_at timestamptz NOT NULL DEFAULT now(),
    CHECK(origin<>'gold' OR source_id IS NOT NULL)
);
CREATE TABLE catalog.prompt_version (
    prompt_id uuid NOT NULL REFERENCES catalog.prompt,
    version integer NOT NULL CHECK(version>0),
    text text NOT NULL,
    definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
    sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(prompt_id,version)
);
CREATE VIEW catalog.current_project AS
    SELECT DISTINCT ON(p.project_id) p.*,v.version,v.definition,v.recorded_at
    FROM catalog.project p JOIN catalog.project_version v USING(project_id)
    ORDER BY p.project_id,v.version DESC;
CREATE VIEW catalog.current_prompt AS
    SELECT DISTINCT ON(p.prompt_id) p.*,v.version,v.text,v.definition,v.recorded_at
    FROM catalog.prompt p JOIN catalog.prompt_version v USING(prompt_id)
    ORDER BY p.prompt_id,v.version DESC;

-- Nothing is exported until an administrator explicitly approves each data family.
CREATE TABLE publication.project_access (
    project_id uuid PRIMARY KEY REFERENCES catalog.project,
    projects boolean NOT NULL DEFAULT false,
    prompts boolean NOT NULL DEFAULT false,
    ga4 boolean NOT NULL DEFAULT false,
    seo boolean NOT NULL DEFAULT false,
    approved_by text NOT NULL CHECK(length(trim(approved_by))>0),
    approved_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog.project_ga4_property (
    project_id uuid NOT NULL REFERENCES catalog.project,
    prop_key smallint NOT NULL REFERENCES analytics.ga4_property,
    PRIMARY KEY(project_id,prop_key)
);
CREATE VIEW published.projects WITH (security_barrier=true) AS
    SELECT p.project_id,p.version,p.definition,p.origin,p.recorded_at
    FROM catalog.current_project p JOIN publication.project_access a USING(project_id) WHERE a.projects;
CREATE VIEW published.prompts WITH (security_barrier=true) AS
    SELECT p.prompt_id,p.project_id,p.version,p.text,p.definition,p.origin,p.recorded_at
    FROM catalog.current_prompt p JOIN publication.project_access a USING(project_id) WHERE a.prompts;
-- Export measurements with stable UUIDs, not local smallint project keys.
CREATE VIEW published.ga4_daily WITH (security_barrier=true) AS
    SELECT p.project_id,r.* FROM analytics.ga4_row r JOIN catalog.project_ga4_property p USING(prop_key)
    JOIN publication.project_access a USING(project_id) WHERE a.ga4;
CREATE VIEW published.ga4_users_window WITH (security_barrier=true) AS
    SELECT p.project_id,r.* FROM analytics.ga4_users_window r JOIN catalog.project_ga4_property p USING(prop_key)
    JOIN publication.project_access a USING(project_id) WHERE a.ga4;
CREATE VIEW published.seo_visibility_daily WITH (security_barrier=true) AS
    SELECT coalesce(p.project_id,p.scope_project_id,p.site_id) AS project_id,r.*
    FROM analytics.current_page_visibility_daily r JOIN ref.dim_project p USING(project_key)
    JOIN publication.project_access a ON a.project_id=coalesce(p.project_id,p.scope_project_id,p.site_id) WHERE a.seo;
CREATE VIEW published.seo_crawl_daily WITH (security_barrier=true) AS
    SELECT coalesce(p.project_id,p.scope_project_id,p.site_id) AS project_id,r.*
    FROM analytics.current_page_crawl_daily r JOIN ref.dim_project p USING(project_key)
    JOIN publication.project_access a ON a.project_id=coalesce(p.project_id,p.scope_project_id,p.site_id) WHERE a.seo;
CREATE VIEW published.seo_device_daily WITH (security_barrier=true) AS
    SELECT coalesce(p.project_id,p.scope_project_id,p.site_id) AS project_id,r.*
    FROM analytics.current_page_seo_device_daily r JOIN ref.dim_project p USING(project_key)
    JOIN publication.project_access a ON a.project_id=coalesce(p.project_id,p.scope_project_id,p.site_id) WHERE a.seo;
CREATE VIEW published.seo_priority WITH (security_barrier=true) AS
    SELECT coalesce(p.project_id,p.scope_project_id,p.site_id) AS project_id,r.*
    FROM analytics.current_page_priority r JOIN ref.dim_project p USING(project_key)
    JOIN publication.project_access a ON a.project_id=coalesce(p.project_id,p.scope_project_id,p.site_id) WHERE a.seo;
-- Dictionaries are restricted to keys actually present in permitted GA4 rows.
CREATE VIEW published.ga4_values WITH (security_barrier=true) AS
    SELECT v.* FROM analytics.ga4_value v WHERE EXISTS (
      SELECT 1 FROM published.ga4_daily r CROSS JOIN LATERAL
      (VALUES ('channel',r.channel_key),('source',r.source_key),('device',r.device_key),
              ('nvr',r.nvr_key),('event',r.event_key),('page',r.page_key)) k(kind,value_key)
      WHERE (v.kind,v.value_key)=(k.kind,k.value_key));

REVOKE ALL ON SCHEMA catalog,publication,published FROM PUBLIC;
GRANT USAGE ON SCHEMA catalog TO hmg_analytics_reader,hmg_catalog_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO hmg_analytics_reader,hmg_catalog_writer;
GRANT INSERT ON catalog.project,catalog.prompt,catalog.project_version,catalog.prompt_version TO hmg_catalog_writer;
-- Revision rows and identities cannot be updated/deleted by application roles.
GRANT USAGE ON SCHEMA published TO hmg_data_external;
GRANT SELECT ON ALL TABLES IN SCHEMA published TO hmg_data_external;
COMMENT ON SCHEMA catalog IS 'HUB data catalog. Gold imports retain provenance; revision timestamps are HUB observation times, not source creation times.';
COMMENT ON SCHEMA publication IS 'Administrator-only, per-project opt-in export policy. No implicit exports or default grants.';
COMMENT ON SCHEMA published IS 'External read contract v1. No users, memberships, settings, secrets or unpublished projects.';
