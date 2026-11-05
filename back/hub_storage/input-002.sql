-- What the input store did not have when it moved out of hmg_analytics (2026-11-06, T4). Every input now has the same shape: a current
-- value, numbered versions that hold the whole value, the writer and its change_seq, and the published set the API serves.

-- ═══ versions of the remaining lists ════════════════════════════════════════════════════════════════════════════════════════
-- The customer-interest lists and the entity roles get what the 인용 출처 분류 lists have had since data-013 (earlier open point D-8 ③).
CREATE TABLE catalog.interest_keyword_version (
    term_norm text NOT NULL REFERENCES catalog.interest_keyword(term_norm),
    version integer NOT NULL CHECK (version > 0),
    term text NOT NULL,
    conditions jsonb NOT NULL,
    source_types text[] NOT NULL,
    brands text[] NOT NULL,
    note text,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamptz NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    PRIMARY KEY (term_norm, version)
);
CREATE TABLE catalog.interest_source_version (
    source_key text NOT NULL REFERENCES catalog.interest_source(source_key),
    version integer NOT NULL CHECK (version > 0),
    url text NOT NULL,
    channel text NOT NULL,
    brands text[] NOT NULL,
    note text,
    status text NOT NULL,
    recorded_at timestamptz NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    PRIMARY KEY (source_key, version)
);
CREATE TABLE catalog.entity_role_version (
    entity_id uuid NOT NULL REFERENCES catalog.entity_role(entity_id),
    version integer NOT NULL CHECK (version > 0),
    rep_name text NOT NULL,
    role text NOT NULL,
    brand text,
    note text,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamptz NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    PRIMARY KEY (entity_id, version)
);
CREATE TRIGGER interest_keyword_version AFTER INSERT OR UPDATE ON catalog.interest_keyword
    FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('term_norm');
CREATE TRIGGER interest_source_version AFTER INSERT OR UPDATE ON catalog.interest_source
    FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('source_key');
CREATE TRIGGER entity_role_version AFTER INSERT OR UPDATE ON catalog.entity_role
    FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('entity_id');

-- ═══ the reference values the Gold import used to own ═══════════════════════════════════════════════════════════════════════
-- engine, country, language (collecting), taxon, brand and the service code tables surface, brand_bit, mention_type (analysis). SSOT
-- gives them no management screen, so they share one table; the first values come from Gold once (sync_catalog.py), after that the
-- import leaves these families alone. A family with no active row publishes an empty set.
CREATE TABLE catalog.reference_source (
    family text NOT NULL CHECK (family IN ('engine','country','language','taxon','brand','surface','brand_bit','mention_type')),
    item_key text NOT NULL CHECK (length(item_key) > 0),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
    origin text NOT NULL CHECK (origin IN ('gold_import','hub')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    PRIMARY KEY (family, item_key)
);
CREATE TABLE catalog.reference_source_version (
    family text NOT NULL,
    item_key text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    definition jsonb NOT NULL,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamptz NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    PRIMARY KEY (family, item_key, version),
    FOREIGN KEY (family, item_key) REFERENCES catalog.reference_source(family, item_key)
);
CREATE TRIGGER reference_source_version AFTER INSERT OR UPDATE ON catalog.reference_source
    FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('family', 'item_key');

-- engine, country, language, taxon and brand become source hub_edit, which until now only the screens' lists could be.
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_hub_edit;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_hub_edit CHECK (
    (source = 'hub_edit') = (family IN ('source_override','source_seed','source_social','source_code','interest_keyword','interest_source','entity_role'))
    OR (source IN ('hub_edit','gold') AND family IN ('engine','country','language','taxon','brand')));

-- The active rows as the family's next set, when they changed. surface, brand_bit and mention_type stay source='hub': the API decodes
-- with them, so a change moves contract_version. The rest are source='hub_edit' like the other lists.
CREATE FUNCTION catalog.publish_reference_source(fam text) RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
    items jsonb := (SELECT coalesce(jsonb_agg(r.definition || jsonb_build_object('key', r.item_key) ORDER BY r.item_key), '[]'::jsonb)
                    FROM catalog.reference_source r WHERE r.family=fam AND r.status='active');
    digest text := encode(sha256(convert_to(items::text,'UTF8')),'hex');
    src text := CASE WHEN fam IN ('surface','brand_bit','mention_type') THEN 'hub' ELSE 'hub_edit' END;
    prev_version integer;
    prev_sha text;
    prev_source text;
    sid uuid := gen_random_uuid();
BEGIN
    PERFORM pg_advisory_xact_lock(617427413);
    SELECT s.version, s.sha256, s.source INTO prev_version, prev_sha, prev_source FROM catalog.reference_set s
     WHERE s.family=fam ORDER BY s.version DESC LIMIT 1;
    IF prev_sha IS NOT DISTINCT FROM digest AND prev_source IS NOT DISTINCT FROM src THEN
        RETURN;
    END IF;
    INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
    VALUES(sid,fam,coalesce(prev_version,0)+1,jsonb_array_length(items),digest,src);
    INSERT INTO catalog.reference_item(set_id,item_key,definition)
    SELECT sid,e->>'key',e-'key' FROM jsonb_array_elements(items) e;
    RETURN QUERY SELECT s.version,s.change_seq FROM catalog.reference_set s WHERE s.set_id=sid;
END $$;
REVOKE ALL ON FUNCTION catalog.publish_reference_source(text) FROM PUBLIC;

-- ═══ measurement settings ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- One numbered version per change of a project's settings, like its definition (project_version): the newest is the current value, and
-- nothing is rewritten. What 수집 reads (SSOT shared/input-contract.md, 측정 설정). A value the store has not been given stays empty:
-- the Gold import fills what Gold holds once (brands, countries, engines, website units, owned URLs; origin gold_import), and the
-- rest waits for a person or for the original operations DB (docs/handoff/architecture-rebuild.md 2.6).
CREATE TABLE catalog.project_measurement_version (
    project_id uuid NOT NULL REFERENCES catalog.project,
    version integer NOT NULL CHECK (version > 0),
    brands text[] NOT NULL DEFAULT '{}',
    countries text[] NOT NULL DEFAULT '{}',
    engines text[] NOT NULL DEFAULT '{}',
    cadence text CHECK (cadence IN ('weekly','biweekly','monthly')),
    acr_repeats integer CHECK (acr_repeats BETWEEN 1 AND 100),
    web_units jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(web_units) = 'array'),
    owned_urls text[] NOT NULL DEFAULT '{}',
    tracked_urls text[] NOT NULL DEFAULT '{}',
    tracked_targets jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tracked_targets) = 'array'),
    origin text NOT NULL CHECK (origin IN ('gold_import','hub')),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    change_seq bigint NOT NULL DEFAULT nextval('catalog.change_seq'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    recorded_by uuid,
    PRIMARY KEY (project_id, version),
    CHECK (origin <> 'hub' OR recorded_by IS NOT NULL)
);
CREATE INDEX project_measurement_change_seq ON catalog.project_measurement_version(change_seq);
CREATE VIEW catalog.current_measurement AS
    SELECT m.* FROM catalog.project_measurement_version m
    WHERE NOT EXISTS(SELECT 1 FROM catalog.project_measurement_version n WHERE n.project_id=m.project_id AND n.version>m.version);
COMMENT ON TABLE catalog.project_measurement_version IS 'Measurement settings of a project, one version per change (SSOT shared/input-contract.md, 측정 설정).';
COMMENT ON COLUMN catalog.project_measurement_version.web_units IS 'Website measurement units: [{file_seq, lang_codes, base}].';
COMMENT ON COLUMN catalog.project_measurement_version.tracked_targets IS 'Tracked competitors and models: [{kind: brand|model, name, brand?}].';
COMMENT ON COLUMN catalog.project_measurement_version.recorded_by IS 'HUB operations system.user_account.user_id; NULL for the Gold import.';

-- ═══ the API contract: who reads what ═══════════════════════════════════════════════════════════════════════════════════════
-- SSOT service/prompt-reference-api.md: 수집 reads the prompts, the measurement settings and the collecting values; 분석 reads the
-- analysis values. A client is one or the other, and only the 15 families of the contract leave (the rest stay in the store).
ALTER TABLE publication.api_client ADD COLUMN audience text NOT NULL DEFAULT 'collect' CHECK (audience IN ('collect','analyze'));
CREATE TABLE publication.reference_family (
    family text PRIMARY KEY,
    audience text NOT NULL CHECK (audience IN ('collect','analyze'))
);
INSERT INTO publication.reference_family(family,audience) VALUES
    ('engine','collect'),('country','collect'),('language','collect'),('interest_keyword','collect'),('interest_source','collect'),
    ('taxon','analyze'),('brand','analyze'),('source_override','analyze'),('source_seed','analyze'),('source_social','analyze'),
    ('source_code','analyze'),('entity_role','analyze'),('surface','analyze'),('brand_bit','analyze'),('mention_type','analyze');

DROP VIEW ext.reference_items, ext.reference_sets, ext.prompts, ext.projects, ext.meta, ext.caller;
CREATE VIEW ext.caller WITH (security_barrier=true) AS
    SELECT c.client_id,c.name AS client_name,k.key_id,k.expires_at,c.audience
    FROM publication.api_key k JOIN publication.api_client c USING(client_id)
    WHERE k.key_hash=nullif(current_setting('hgh.key_hash',true),'')
      AND k.revoked_at IS NULL AND k.expires_at>now() AND c.status='active';
-- as_of: the last successful Gold import (until T10 stops it). hub_reference: the code tables the API decodes with.
CREATE VIEW ext.meta WITH (security_barrier=true) AS
    SELECT c.*,(SELECT max(finished_at) FROM catalog.sync_run WHERE result='ok') AS as_of,
        (SELECT string_agg(s.family||':'||s.sha256,',' ORDER BY s.family) FROM catalog.current_reference_set s
         WHERE s.source='hub') AS hub_reference
    FROM ext.caller c;
-- The surface and brand-bit tables every response decodes with, whichever audience the caller is.
CREATE VIEW ext.codes WITH (security_barrier=true) AS
    SELECT r.family,r.item_key,r.definition FROM catalog.current_reference r
    WHERE r.family IN ('surface','brand_bit') AND EXISTS(SELECT 1 FROM ext.caller);
-- Projects granted to the caller and approved for export. change_seq and sha256 cover the definition and the measurement settings
-- together, so a settings change moves them. A project that is not active is only its id and status.
CREATE VIEW ext.projects WITH (security_barrier=true) AS
    SELECT p.project_id,p.origin,greatest(p.change_seq,m.change_seq) AS change_seq,
        encode(sha256(convert_to(p.sha256||':'||coalesce(m.sha256,''),'UTF8')),'hex') AS sha256,
        greatest(p.recorded_at,m.recorded_at) AS recorded_at,greatest(g.grant_seq,a.access_seq) AS reset_seq,
        CASE WHEN coalesce(p.definition->>'status','active')='active'
             THEN p.definition-'scope_project_id'-'source_project_id'-'site_id'
             ELSE jsonb_build_object('status',p.definition->>'status') END AS definition,
        CASE WHEN coalesce(p.definition->>'status','active')='active' AND m.project_id IS NOT NULL THEN jsonb_build_object(
             'brands',to_jsonb(m.brands),'countries',to_jsonb(m.countries),'engines',to_jsonb(m.engines),'cadence',m.cadence,
             'acr_repeats',m.acr_repeats,'web_units',m.web_units,'owned_urls',to_jsonb(m.owned_urls),'tracked_urls',to_jsonb(m.tracked_urls),
             'tracked_targets',m.tracked_targets) END AS measurement
    FROM ext.caller c
    JOIN publication.api_client_project g ON g.client_id=c.client_id AND g.revoked_at IS NULL
    JOIN publication.project_access a ON a.project_id=g.project_id AND a.projects
    JOIN catalog.current_project p ON p.project_id=g.project_id
    LEFT JOIN catalog.current_measurement m ON m.project_id=p.project_id
    WHERE c.audience='collect';
-- Prompts need both the projects and the prompts approval. A prompt that is not active is only its id, status and order.
CREATE VIEW ext.prompts WITH (security_barrier=true) AS
    SELECT q.prompt_id,q.project_id,q.origin,q.change_seq,q.sha256,q.recorded_at,
        CASE WHEN coalesce(q.definition->>'status','active')='active' THEN q.text END AS text,
        CASE WHEN coalesce(q.definition->>'status','active')='active' THEN q.definition
             ELSE jsonb_build_object('status',q.definition->>'status') END AS definition
    FROM ext.projects p
    JOIN publication.project_access a ON a.project_id=p.project_id AND a.prompts
    JOIN catalog.current_prompt q ON q.project_id=p.project_id;
-- Reference families of the caller's audience: approved ones, and the code tables, which the contract itself needs.
CREATE VIEW ext.reference_sets WITH (security_barrier=true) AS
    SELECT s.family,s.source,s.item_count,s.sha256,s.change_seq,s.recorded_at
    FROM catalog.current_reference_set s
    JOIN publication.reference_family f ON f.family=s.family
    JOIN ext.caller c ON c.audience=f.audience
    WHERE s.source='hub' OR EXISTS(SELECT 1 FROM publication.reference_access r WHERE r.family=s.family AND r.enabled);
CREATE VIEW ext.reference_items WITH (security_barrier=true) AS
    SELECT r.family,r.item_key,r.definition,r.change_seq
    FROM catalog.current_reference r
    JOIN publication.reference_family f ON f.family=r.family
    JOIN ext.caller c ON c.audience=f.audience
    WHERE r.source='hub' OR EXISTS(SELECT 1 FROM publication.reference_access a WHERE a.family=r.family AND a.enabled);

-- ═══ grants ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
GRANT SELECT ON ext.caller,ext.meta,ext.codes,ext.projects,ext.prompts,ext.reference_sets,ext.reference_items TO hmg_ext_api;
GRANT SELECT ON catalog.interest_keyword_version,catalog.interest_source_version,catalog.entity_role_version,catalog.reference_source,
    catalog.reference_source_version,catalog.project_measurement_version,catalog.current_measurement,publication.reference_family
    TO hmg_input_reader;
GRANT SELECT ON catalog.interest_keyword_version,catalog.interest_source_version TO hmg_interest_editor;
GRANT SELECT ON catalog.entity_role_version TO hmg_entity_role_editor;
-- The Gold import fills the first reference values and settings once, and reads them to leave alone what is there.
GRANT SELECT ON catalog.reference_source,catalog.project_measurement_version,catalog.current_measurement TO hmg_catalog_writer;
GRANT INSERT ON catalog.reference_source TO hmg_catalog_writer;
GRANT INSERT(project_id,version,brands,countries,engines,cadence,acr_repeats,web_units,owned_urls,tracked_urls,tracked_targets,origin,sha256)
    ON catalog.project_measurement_version TO hmg_catalog_writer;
GRANT EXECUTE ON FUNCTION catalog.publish_reference_source(text) TO hmg_catalog_writer;
-- The API's role for Project › Setting: new versions of the settings, naming their account. No rewrite, no delete, no other input.
GRANT USAGE ON SCHEMA catalog TO hmg_measurement_editor;
GRANT USAGE ON SEQUENCE catalog.change_seq TO hmg_measurement_editor;
GRANT SELECT ON catalog.project,catalog.project_version,catalog.current_project,catalog.project_measurement_version,catalog.current_measurement,
    catalog.reference_source TO hmg_measurement_editor;
GRANT INSERT(project_id,version,brands,countries,engines,cadence,acr_repeats,web_units,owned_urls,tracked_urls,tracked_targets,origin,sha256,recorded_by)
    ON catalog.project_measurement_version TO hmg_measurement_editor;
