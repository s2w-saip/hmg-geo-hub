-- Incremental migration (2026-10-28): the external API.
-- The current prompts and the values collecting and processing them needs leave the HUB through the
-- ext schema only. ext views are scoped to one caller by the transaction setting hgh.key_hash (the
-- sha256 of the caller's API key); without a valid key every view is empty. Only hmg_ext_api reads ext.

-- ═══ change order ═══════════════════════════════════════════════════════════════════════════════════════
-- Every catalog writer (Gold import, HUB editor) inserts under advisory lock 617427413, so nextval order
-- is commit order and a consumer reading "change_seq > n" misses nothing. CACHE 1: no per-session blocks.
CREATE SEQUENCE catalog.change_seq CACHE 1;
ALTER TABLE catalog.project_version ADD COLUMN change_seq bigint NOT NULL DEFAULT nextval('catalog.change_seq');
ALTER TABLE catalog.prompt_version ADD COLUMN change_seq bigint NOT NULL DEFAULT nextval('catalog.change_seq');
CREATE INDEX project_version_change_seq ON catalog.project_version(change_seq);
CREATE INDEX prompt_version_change_seq ON catalog.prompt_version(change_seq);
CREATE INDEX prompt_project ON catalog.prompt(project_id);

-- The newest revision by anti-join (DISTINCT ON sorted every revision on each read and kept filters out).
-- Same leading columns as 002; change_seq and sha256 are appended.
CREATE OR REPLACE VIEW catalog.current_project AS
    SELECT p.*,v.version,v.definition,v.recorded_at,v.change_seq,v.sha256
    FROM catalog.project p JOIN catalog.project_version v USING(project_id)
    WHERE NOT EXISTS(SELECT 1 FROM catalog.project_version w WHERE w.project_id=v.project_id AND w.version>v.version);
CREATE OR REPLACE VIEW catalog.current_prompt AS
    SELECT p.*,v.version,v.text,v.definition,v.recorded_at,v.change_seq,v.sha256
    FROM catalog.prompt p JOIN catalog.prompt_version v USING(prompt_id)
    WHERE NOT EXISTS(SELECT 1 FROM catalog.prompt_version w WHERE w.prompt_id=v.prompt_id AND w.version>v.version);

-- ═══ reference values ═══════════════════════════════════════════════════════════════════════════════════
-- One family = one set. Any change records the whole family again as a new set (never overwritten);
-- an unchanged family (same sha256) records nothing. A family with no items still has a set.
CREATE TABLE catalog.reference_set (
    set_id uuid PRIMARY KEY,
    family text NOT NULL CHECK(family IN ('surface','brand_bit','mention_type','engine','region','country','language',
        'taxon','brand','entity','source_category','source','owned_base','crawl_bot','keyword','perspective','population')),
    version integer NOT NULL CHECK(version>0),
    item_count integer NOT NULL CHECK(item_count>=0),
    sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
    source text NOT NULL CHECK(source IN ('gold','hub')),
    source_release jsonb,
    change_seq bigint NOT NULL DEFAULT nextval('catalog.change_seq'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(family,version)
);
CREATE TABLE catalog.reference_item (
    set_id uuid NOT NULL REFERENCES catalog.reference_set,
    item_key text NOT NULL CHECK(length(item_key)>0),
    definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
    PRIMARY KEY(set_id,item_key)
);
CREATE VIEW catalog.current_reference_set AS
    SELECT s.* FROM catalog.reference_set s
    WHERE NOT EXISTS(SELECT 1 FROM catalog.reference_set n WHERE n.family=s.family AND n.version>s.version);
CREATE VIEW catalog.current_reference AS
    SELECT s.family,s.source,s.version,s.sha256,s.change_seq,i.item_key,i.definition
    FROM catalog.current_reference_set s JOIN catalog.reference_item i USING(set_id);

-- One row per Gold import: what it read, what it recorded or why it refused. removal_candidates are the
-- Gold-origin ids missing from Gold in this run; a later run removes only ids missing in both.
CREATE TABLE catalog.sync_run (
    run_id uuid PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    result text NOT NULL DEFAULT 'running' CHECK(result IN ('running','ok','refused','failed')),
    reason text,
    gold_versions jsonb,
    gold_release jsonb,
    counts jsonb,
    removal_candidates jsonb
);
CREATE INDEX sync_run_finished ON catalog.sync_run(result,finished_at DESC);

-- ═══ approval and callers ═══════════════════════════════════════════════════════════════════════════════
-- Approval changes take a new change_seq on every UPDATE as well (a trigger), so a consumer can tell that
-- a project became visible again and must read it from the start.
ALTER TABLE publication.project_access ADD COLUMN access_seq bigint NOT NULL DEFAULT nextval('catalog.change_seq');
CREATE TABLE publication.reference_access (
    family text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT false,
    approved_by text NOT NULL CHECK(length(trim(approved_by))>0),
    approved_at timestamptz NOT NULL DEFAULT now(),
    access_seq bigint NOT NULL DEFAULT nextval('catalog.change_seq')
);
CREATE TABLE publication.api_client (
    client_id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK(length(trim(name))>0),
    status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    created_by text NOT NULL CHECK(length(trim(created_by))>0),
    created_at timestamptz NOT NULL DEFAULT now()
);
-- The key is hgh_<key_id hex>_<256-bit secret>; only its sha256 is stored. The secret is shown once.
CREATE TABLE publication.api_key (
    key_id uuid PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES publication.api_client,
    key_hash text NOT NULL UNIQUE CHECK(key_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL CHECK(length(trim(created_by))>0),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_by text,
    revoke_reason text,
    CHECK(expires_at>created_at),
    CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
-- A withdrawn grant keeps its row (revoked_at); granting again clears it and takes a new grant_seq.
CREATE TABLE publication.api_client_project (
    client_id uuid NOT NULL REFERENCES publication.api_client,
    project_id uuid NOT NULL REFERENCES catalog.project,
    granted_by text NOT NULL CHECK(length(trim(granted_by))>0),
    granted_at timestamptz NOT NULL DEFAULT now(),
    grant_seq bigint NOT NULL DEFAULT nextval('catalog.change_seq'),
    revoked_at timestamptz,
    revoked_by text,
    PRIMARY KEY(client_id,project_id),
    CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE FUNCTION publication.next_access_seq() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.access_seq := nextval('catalog.change_seq'); RETURN NEW; END $$;
CREATE FUNCTION publication.next_grant_seq() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.grant_seq := nextval('catalog.change_seq'); RETURN NEW; END $$;
CREATE TRIGGER project_access_seq BEFORE UPDATE ON publication.project_access
    FOR EACH ROW EXECUTE FUNCTION publication.next_access_seq();
CREATE TRIGGER reference_access_seq BEFORE UPDATE ON publication.reference_access
    FOR EACH ROW EXECUTE FUNCTION publication.next_access_seq();
CREATE TRIGGER api_client_project_seq BEFORE UPDATE ON publication.api_client_project
    FOR EACH ROW EXECUTE FUNCTION publication.next_grant_seq();

-- ═══ the external contract ══════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA ext AUTHORIZATION hmg_analytics_owner;

-- The caller of this transaction: one row for a valid key, otherwise none.
CREATE VIEW ext.caller WITH (security_barrier=true) AS
    SELECT c.client_id,c.name AS client_name,k.key_id,k.expires_at
    FROM publication.api_key k JOIN publication.api_client c USING(client_id)
    WHERE k.key_hash=nullif(current_setting('hgh.key_hash',true),'')
      AND k.revoked_at IS NULL AND k.expires_at>now() AND c.status='active';
-- as_of: the last successful Gold import. hub_reference: the HUB-owned code tables (surface, brand bits,
-- mention types) the API decodes with; when they change, consumers read everything again.
CREATE VIEW ext.meta WITH (security_barrier=true) AS
    SELECT c.*,(SELECT max(finished_at) FROM catalog.sync_run WHERE result='ok') AS as_of,
        (SELECT string_agg(s.family||':'||s.sha256,',' ORDER BY s.family) FROM catalog.current_reference_set s
         WHERE s.source='hub') AS hub_reference
    FROM ext.caller c;
-- Projects granted to the caller and approved for export. reset_seq: the latest grant or approval change.
-- A removed project is only its id and status; internal Gold ids are not exported.
CREATE VIEW ext.projects WITH (security_barrier=true) AS
    SELECT p.project_id,p.origin,p.change_seq,p.sha256,p.recorded_at,greatest(g.grant_seq,a.access_seq) AS reset_seq,
        CASE WHEN coalesce(p.definition->>'status','active')='active'
             THEN p.definition-'scope_project_id'-'source_project_id'-'site_id'
             ELSE jsonb_build_object('status',p.definition->>'status') END AS definition
    FROM ext.caller c
    JOIN publication.api_client_project g ON g.client_id=c.client_id AND g.revoked_at IS NULL
    JOIN publication.project_access a ON a.project_id=g.project_id AND a.projects
    JOIN catalog.current_project p ON p.project_id=g.project_id;
-- Prompts need both the projects and the prompts approval. archived/removed: id, status and order only.
CREATE VIEW ext.prompts WITH (security_barrier=true) AS
    SELECT q.prompt_id,q.project_id,q.origin,q.change_seq,q.sha256,q.recorded_at,
        CASE WHEN coalesce(q.definition->>'status','active')='active' THEN q.text END AS text,
        CASE WHEN coalesce(q.definition->>'status','active')='active' THEN q.definition
             ELSE jsonb_build_object('status',q.definition->>'status') END AS definition
    FROM ext.projects p
    JOIN publication.project_access a ON a.project_id=p.project_id AND a.prompts
    JOIN catalog.current_prompt q ON q.project_id=p.project_id;
-- Reference families: approved ones, plus the HUB-owned code tables, which the contract itself needs.
CREATE VIEW ext.reference_sets WITH (security_barrier=true) AS
    SELECT s.family,s.source,s.item_count,s.sha256,s.change_seq,s.recorded_at
    FROM catalog.current_reference_set s
    WHERE EXISTS(SELECT 1 FROM ext.caller)
      AND (s.source='hub' OR EXISTS(SELECT 1 FROM publication.reference_access r WHERE r.family=s.family AND r.enabled));
CREATE VIEW ext.reference_items WITH (security_barrier=true) AS
    SELECT r.family,r.item_key,r.definition,r.change_seq
    FROM catalog.current_reference r
    WHERE EXISTS(SELECT 1 FROM ext.caller)
      AND (r.source='hub' OR EXISTS(SELECT 1 FROM publication.reference_access a WHERE a.family=r.family AND a.enabled));

-- ═══ grants ═════════════════════════════════════════════════════════════════════════════════════════════
REVOKE ALL ON SCHEMA ext FROM PUBLIC;
REVOKE ALL ON FUNCTION publication.next_access_seq(),publication.next_grant_seq() FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_analytics_owner IN SCHEMA catalog,publication,ext
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- change_seq is never supplied by a writer: table INSERT gives way to column lists without it.
REVOKE INSERT ON catalog.project_version,catalog.prompt_version FROM hmg_catalog_writer,hmg_catalog_editor;
GRANT INSERT(project_id,version,definition,sha256) ON catalog.project_version TO hmg_catalog_writer;
GRANT INSERT(prompt_id,version,text,definition,sha256) ON catalog.prompt_version TO hmg_catalog_writer;
GRANT INSERT(prompt_id,version,text,definition,sha256,recorded_by) ON catalog.prompt_version TO hmg_catalog_editor;
GRANT INSERT(set_id,family,version,item_count,sha256,source,source_release) ON catalog.reference_set TO hmg_catalog_writer;
GRANT INSERT ON catalog.reference_item TO hmg_catalog_writer;
GRANT INSERT(run_id,gold_versions) ON catalog.sync_run TO hmg_catalog_writer;
GRANT UPDATE(finished_at,result,reason,gold_versions,gold_release,counts,removal_candidates) ON catalog.sync_run TO hmg_catalog_writer;
GRANT USAGE ON SEQUENCE catalog.change_seq TO hmg_catalog_writer,hmg_catalog_editor;
GRANT SELECT ON catalog.reference_set,catalog.reference_item,catalog.current_reference_set,catalog.current_reference,catalog.sync_run
    TO hmg_analytics_reader,hmg_catalog_writer,hmg_catalog_editor;
GRANT USAGE ON SCHEMA ext TO hmg_ext_api;
GRANT SELECT ON ext.caller,ext.meta,ext.projects,ext.prompts,ext.reference_sets,ext.reference_items TO hmg_ext_api;
COMMENT ON SCHEMA ext IS 'External API contract v1: caller-scoped views keyed by the transaction setting hgh.key_hash. Read only by hmg_ext_api.';
COMMENT ON TABLE catalog.reference_set IS 'Inputs that collecting and processing need (never processing results), one versioned set per family.';
COMMENT ON COLUMN catalog.prompt_version.change_seq IS 'Commit order across catalog writers (all insert under advisory lock 617427413).';
