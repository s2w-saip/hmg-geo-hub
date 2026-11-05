-- The input store (hmg_input, 2026-11-06): prompts, measurement settings and the collecting and analysis reference values, kept
-- by the service and read by 앤써 and the analysis team through the prompt and reference API (back/ext). SSOT
-- shared/input-contract.md; decision '입력 DB 분리' in docs/handoff/architecture-rebuild.md.
--
-- This file is the structure the catalog, publication and ext schemas had in hmg_analytics after data-013 (a schema dump, moved as
-- it was), so the screens' roles, keys, CHECKs, triggers and publishing functions behave the same. Left behind in hmg_analytics:
-- catalog.service_week (the Gold-judged service week, removed at T12), catalog.project_ga4_property and published.* (GA4 and SEO),
-- and the GA4/SEO columns of publication.project_access. input-002.sql adds what the store did not have yet.
SET LOCAL check_function_bodies = false;  -- the dump's order: functions before the tables their bodies name
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE TABLE catalog.schema_migration (
    version text PRIMARY KEY,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    installed_at timestamptz NOT NULL DEFAULT now()
);


COMMENT ON SCHEMA catalog IS 'HUB data catalog. Gold imports retain provenance; revision timestamps are HUB observation times, not source creation times.';

CREATE SCHEMA ext;

COMMENT ON SCHEMA ext IS 'External API contract v1: caller-scoped views keyed by the transaction setting hgh.key_hash. Read only by hmg_ext_api.';

CREATE SCHEMA publication;

COMMENT ON SCHEMA publication IS 'Administrator-only, per-project opt-in export policy. No implicit exports or default grants.';

CREATE FUNCTION catalog.interest_term_norm(t text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN lower((btrim(NORMALIZE(t, NFC), '	






 
             

  　'::text) COLLATE "und-x-icu"));

COMMENT ON FUNCTION catalog.interest_term_norm(t text) IS 'NFC, whitespace trim, lower: the normalization of Gold dim_keyword.term_norm. ICU, because the HUB store runs in the C locale, where lower() leaves non-ASCII letters as they are.';

CREATE FUNCTION catalog.project_editor_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE pid uuid;
BEGIN
    IF current_user <> 'hmg_project_editor' THEN RETURN NEW; END IF;
    -- one statement per table: PL/pgSQL plans every field a statement names, and each table has only its own
    IF TG_TABLE_NAME='prompt_version' THEN
        pid := (SELECT p.project_id FROM catalog.prompt p WHERE p.prompt_id=NEW.prompt_id);
    ELSE
        pid := NEW.project_id;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM catalog.current_project c WHERE c.project_id=pid AND c.definition->>'surface'='3') THEN
        RAISE EXCEPTION 'The project editor writes project-surface catalogs only' USING ERRCODE='insufficient_privilege';
    END IF;
    IF TG_TABLE_NAME<>'prompt' THEN
        IF NEW.recorded_by IS NULL THEN
            RAISE EXCEPTION 'A HUB revision names its account (recorded_by)' USING ERRCODE='not_null_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

COMMENT ON FUNCTION catalog.project_editor_guard() IS 'hmg_project_editor writes project-surface (3) catalogs only, each revision with recorded_by.';

CREATE FUNCTION catalog.publish_entity_roles() RETURNS TABLE(set_version integer, set_change_seq bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT * FROM catalog.publish_hub_edit('entity_role', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',r.entity_id::text,'entity_id',r.entity_id,'rep_name',r.rep_name,'role',r.role,
                                                     'brand',r.brand) ORDER BY r.entity_id),'[]'::jsonb)
        FROM catalog.entity_role r WHERE r.status='active'))
$$;

CREATE FUNCTION catalog.publish_hub_edit(fam text, items jsonb) RETURNS TABLE(set_version integer, set_change_seq bigint)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
    digest text := encode(sha256(convert_to(items::text,'UTF8')),'hex');
    prev_version integer;
    prev_sha text;
    sid uuid := gen_random_uuid();
BEGIN
    PERFORM pg_advisory_xact_lock(617427413);
    SELECT s.version, s.sha256 INTO prev_version, prev_sha FROM catalog.reference_set s
     WHERE s.family=fam ORDER BY s.version DESC LIMIT 1;
    IF prev_sha IS NOT DISTINCT FROM digest THEN
        RETURN;
    END IF;
    INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
    VALUES(sid,fam,coalesce(prev_version,0)+1,jsonb_array_length(items),digest,'hub_edit');
    INSERT INTO catalog.reference_item(set_id,item_key,definition)
    SELECT sid,e->>'key',e-'key' FROM jsonb_array_elements(items) e;
    RETURN QUERY SELECT s.version,s.change_seq FROM catalog.reference_set s WHERE s.set_id=sid;
END $$;

CREATE FUNCTION catalog.publish_interest_keywords() RETURNS TABLE(set_version integer, set_change_seq bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT * FROM catalog.publish_hub_edit('interest_keyword', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',k.term_norm,'term',k.term,'term_norm',k.term_norm,'conditions',k.conditions,
                                                     'source_types',to_jsonb(k.source_types),'brands',to_jsonb(k.brands)) ORDER BY k.term_norm),'[]'::jsonb)
        FROM catalog.interest_keyword k WHERE k.status='active'))
$$;

CREATE FUNCTION catalog.publish_interest_sources() RETURNS TABLE(set_version integer, set_change_seq bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT * FROM catalog.publish_hub_edit('interest_source', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',s.source_key,'source_key',s.source_key,'url',s.url,'channel',s.channel,
                                                     'brands',to_jsonb(s.brands)) ORDER BY s.source_key),'[]'::jsonb)
        FROM catalog.interest_source s WHERE s.status='active'))
$$;

CREATE FUNCTION catalog.publish_source_codes() RETURNS TABLE(set_version integer, set_change_seq bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT * FROM catalog.publish_hub_edit('source_code', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',c.kind||':'||c.code,'kind',c.kind,'code',c.code,'number',c.number,
                                                     'name_en',c.name_en,'name_ko',c.name_ko,'ord',c.ord,'description',c.description)
                                  ORDER BY c.kind,c.number),'[]'::jsonb)
        FROM catalog.source_code c))
$$;

CREATE FUNCTION catalog.publish_source_overrides() RETURNS TABLE(set_version integer, set_change_seq bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
    items jsonb;
    n integer;
    digest text;
    prev_version integer;
    prev_sha text;
    sid uuid := gen_random_uuid();
BEGIN
    PERFORM pg_advisory_xact_lock(617427413);
    SELECT coalesce(jsonb_agg(jsonb_build_object('skey',o.skey,'category',o.category) ORDER BY o.skey),'[]'::jsonb), count(*)::integer
      INTO items, n FROM catalog.source_override o WHERE o.status='active';
    digest := encode(sha256(convert_to(items::text,'UTF8')),'hex');
    SELECT s.version, s.sha256 INTO prev_version, prev_sha FROM catalog.reference_set s
     WHERE s.family='source_override' ORDER BY s.version DESC LIMIT 1;
    IF prev_sha IS NOT DISTINCT FROM digest THEN
        RETURN;
    END IF;
    INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
    VALUES(sid,'source_override',coalesce(prev_version,0)+1,n,digest,'hub_edit');
    INSERT INTO catalog.reference_item(set_id,item_key,definition)
    SELECT sid,e->>'skey',e FROM jsonb_array_elements(items) e;
    RETURN QUERY SELECT s.version,s.change_seq FROM catalog.reference_set s WHERE s.set_id=sid;
END $$;

CREATE FUNCTION catalog.publish_source_seeds() RETURNS TABLE(set_version integer, set_change_seq bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT * FROM catalog.publish_hub_edit('source_seed', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',s.skey,'skey',s.skey,'category',s.category) ORDER BY s.skey),'[]'::jsonb)
        FROM catalog.source_seed s WHERE s.status='active'))
$$;

CREATE FUNCTION catalog.publish_source_socials() RETURNS TABLE(set_version integer, set_change_seq bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT * FROM catalog.publish_hub_edit('source_social', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',s.account_key,'skey',s.display_key,'domain',s.domain,
                                                     'category','officialHmg','matchers',s.matchers) ORDER BY s.account_key),'[]'::jsonb)
        FROM catalog.source_social s WHERE s.status='active'))
$$;

CREATE FUNCTION catalog.record_source_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
DECLARE
    vt text := TG_TABLE_NAME || '_version';
    vals jsonb := to_jsonb(NEW) - 'created_at' - 'updated_at' - 'updated_by';
    keyed text;
    next_version integer;
BEGIN
    IF TG_OP = 'UPDATE' AND vals = to_jsonb(OLD) - 'created_at' - 'updated_at' - 'updated_by' THEN
        RETURN NULL;
    END IF;
    PERFORM pg_advisory_xact_lock(617427413);
    keyed := (SELECT string_agg(format('v.%1$I=($1).%1$I', k), ' AND ') FROM unnest(TG_ARGV) k);
    EXECUTE format('SELECT coalesce(max(v.version),0)+1 FROM catalog.%I v WHERE %s', vt, keyed) INTO next_version USING NEW;
    EXECUTE format('INSERT INTO catalog.%1$I SELECT (jsonb_populate_record(NULL::catalog.%1$I, $1)).*', vt)
        USING vals || jsonb_build_object('version', next_version, 'recorded_at', now(), 'recorded_by', NEW.updated_by,
                                         'change_seq', nextval('catalog.change_seq'));
    RETURN NULL;
END $_$;

COMMENT ON FUNCTION catalog.record_source_version() IS 'Records the whole row as its next version on every change of a 인용 출처 분류 list (data-013).';

CREATE FUNCTION catalog.reference_set_hub_edit_writer() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
    IF NEW.source='hub_edit' AND current_user<>'hmg_input_owner' THEN
        RAISE EXCEPTION 'hub_edit sets are recorded by the catalog publishing functions only' USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION publication.next_access_seq() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN NEW.access_seq := nextval('catalog.change_seq'); RETURN NEW; END $$;

CREATE FUNCTION publication.next_grant_seq() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN NEW.grant_seq := nextval('catalog.change_seq'); RETURN NEW; END $$;

CREATE SEQUENCE catalog.change_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;




CREATE TABLE catalog.project (
    project_id uuid NOT NULL,
    origin text NOT NULL,
    source_id uuid,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_check CHECK (((origin <> 'gold'::text) OR (source_id IS NOT NULL))),
    CONSTRAINT project_origin_check CHECK ((origin = ANY (ARRAY['gold'::text, 'hub'::text])))
);

CREATE TABLE catalog.project_version (
    project_id uuid NOT NULL,
    version integer NOT NULL,
    definition jsonb NOT NULL,
    sha256 text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    change_seq bigint DEFAULT nextval('catalog.change_seq'::regclass) NOT NULL,
    recorded_by uuid,
    CONSTRAINT project_version_definition_check CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT project_version_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT project_version_version_check CHECK ((version > 0))
);

COMMENT ON COLUMN catalog.project_version.recorded_by IS 'HUB operations system.user_account.user_id that recorded a HUB edit; NULL for Gold imports.';

CREATE VIEW catalog.current_project AS
 SELECT p.project_id,
    p.origin,
    p.source_id,
    p.registered_at,
    v.version,
    v.definition,
    v.recorded_at,
    v.change_seq,
    v.sha256
   FROM (catalog.project p
     JOIN catalog.project_version v USING (project_id))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM catalog.project_version w
          WHERE ((w.project_id = v.project_id) AND (w.version > v.version)))));

CREATE TABLE catalog.prompt (
    prompt_id uuid NOT NULL,
    project_id uuid NOT NULL,
    origin text NOT NULL,
    source_id uuid,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prompt_check CHECK (((origin <> 'gold'::text) OR (source_id IS NOT NULL))),
    CONSTRAINT prompt_origin_check CHECK ((origin = ANY (ARRAY['gold'::text, 'hub'::text])))
);

CREATE TABLE catalog.prompt_version (
    prompt_id uuid NOT NULL,
    version integer NOT NULL,
    text text NOT NULL,
    definition jsonb NOT NULL,
    sha256 text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by uuid,
    change_seq bigint DEFAULT nextval('catalog.change_seq'::regclass) NOT NULL,
    CONSTRAINT prompt_version_definition_check CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT prompt_version_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT prompt_version_version_check CHECK ((version > 0))
);

COMMENT ON COLUMN catalog.prompt_version.recorded_by IS 'HUB operations system.user_account.user_id that recorded a HUB edit; NULL for Gold imports.';

COMMENT ON COLUMN catalog.prompt_version.change_seq IS 'Commit order across catalog writers (all insert under advisory lock 617427413).';

CREATE VIEW catalog.current_prompt AS
 SELECT p.prompt_id,
    p.project_id,
    p.origin,
    p.source_id,
    p.registered_at,
    v.version,
    v.text,
    v.definition,
    v.recorded_at,
    v.change_seq,
    v.sha256
   FROM (catalog.prompt p
     JOIN catalog.prompt_version v USING (prompt_id))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM catalog.prompt_version w
          WHERE ((w.prompt_id = v.prompt_id) AND (w.version > v.version)))));

CREATE TABLE catalog.reference_set (
    set_id uuid NOT NULL,
    family text NOT NULL,
    version integer NOT NULL,
    item_count integer NOT NULL,
    sha256 text NOT NULL,
    source text NOT NULL,
    source_release jsonb,
    change_seq bigint DEFAULT nextval('catalog.change_seq'::regclass) NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reference_set_family_check CHECK ((family = ANY (ARRAY['surface'::text, 'brand_bit'::text, 'mention_type'::text, 'engine'::text, 'region'::text, 'country'::text, 'language'::text, 'taxon'::text, 'brand'::text, 'entity'::text, 'source_category'::text, 'source'::text, 'owned_base'::text, 'crawl_bot'::text, 'keyword'::text, 'perspective'::text, 'population'::text, 'source_override'::text, 'source_seed'::text, 'source_social'::text, 'source_code'::text, 'interest_keyword'::text, 'interest_source'::text, 'entity_role'::text]))),
    CONSTRAINT reference_set_hub_edit CHECK (((family = ANY (ARRAY['source_override'::text, 'source_seed'::text, 'source_social'::text, 'source_code'::text, 'interest_keyword'::text, 'interest_source'::text, 'entity_role'::text])) = (source = 'hub_edit'::text))),
    CONSTRAINT reference_set_item_count_check CHECK ((item_count >= 0)),
    CONSTRAINT reference_set_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT reference_set_source_check CHECK ((source = ANY (ARRAY['gold'::text, 'hub'::text, 'hub_edit'::text]))),
    CONSTRAINT reference_set_version_check CHECK ((version > 0))
);

COMMENT ON TABLE catalog.reference_set IS 'Inputs that collecting and processing need (never processing results), one versioned set per family.';

CREATE VIEW catalog.current_reference_set AS
 SELECT set_id,
    family,
    version,
    item_count,
    sha256,
    source,
    source_release,
    change_seq,
    recorded_at
   FROM catalog.reference_set s
  WHERE (NOT (EXISTS ( SELECT 1
           FROM catalog.reference_set n
          WHERE ((n.family = s.family) AND (n.version > s.version)))));

CREATE TABLE catalog.reference_item (
    set_id uuid NOT NULL,
    item_key text NOT NULL,
    definition jsonb NOT NULL,
    CONSTRAINT reference_item_definition_check CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT reference_item_item_key_check CHECK ((length(item_key) > 0))
);

CREATE VIEW catalog.current_reference AS
 SELECT s.family,
    s.source,
    s.version,
    s.sha256,
    s.change_seq,
    i.item_key,
    i.definition
   FROM (catalog.current_reference_set s
     JOIN catalog.reference_item i USING (set_id));

CREATE TABLE catalog.entity_role (
    entity_id uuid NOT NULL,
    rep_name text NOT NULL,
    role text NOT NULL,
    brand text,
    note text,
    status text DEFAULT 'active'::text NOT NULL,
    origin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT entity_role_brand_check CHECK ((brand = ANY (ARRAY['Hyundai'::text, 'Kia'::text, 'Genesis'::text]))),
    CONSTRAINT entity_role_check CHECK (((role = 'own'::text) = (brand IS NOT NULL))),
    CONSTRAINT entity_role_note_check CHECK ((length(note) <= 500)),
    CONSTRAINT entity_role_origin_check CHECK ((origin = ANY (ARRAY['gold_import'::text, 'hub'::text]))),
    CONSTRAINT entity_role_rep_name_check CHECK (((length(rep_name) >= 1) AND (length(rep_name) <= 300))),
    CONSTRAINT entity_role_role_check CHECK ((role = ANY (ARRAY['own'::text, 'excluded'::text]))),
    CONSTRAINT entity_role_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cleared'::text])))
);

COMMENT ON TABLE catalog.entity_role IS 'Entity roles (own with its brand, excluded), owned by the HUB (Admin › 엔티티 카탈로그); published as entity_role.';

CREATE TABLE catalog.entity_role_event (
    event_id bigint NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL,
    actor_id uuid,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_seq bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_role_event_action_check CHECK ((action = ANY (ARRAY['import'::text, 'set'::text, 'clear'::text]))),
    CONSTRAINT entity_role_event_changes_check CHECK ((jsonb_typeof(changes) = 'object'::text))
);

ALTER TABLE catalog.entity_role_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME catalog.entity_role_event_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE catalog.interest_keyword (
    term_norm text NOT NULL,
    term text NOT NULL,
    conditions jsonb NOT NULL,
    source_types text[] NOT NULL,
    brands text[] DEFAULT '{}'::text[] NOT NULL,
    note text,
    status text DEFAULT 'active'::text NOT NULL,
    origin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT interest_keyword_brands_check CHECK ((brands <@ ARRAY['Hyundai'::text, 'Kia'::text, 'Genesis'::text])),
    CONSTRAINT interest_keyword_check CHECK ((term_norm = catalog.interest_term_norm(term))),
    CONSTRAINT interest_keyword_conditions_check CHECK (((jsonb_typeof(conditions) = 'array'::text) AND ((jsonb_array_length(conditions) >= 1) AND (jsonb_array_length(conditions) <= 40)))),
    CONSTRAINT interest_keyword_note_check CHECK ((length(note) <= 500)),
    CONSTRAINT interest_keyword_origin_check CHECK ((origin = ANY (ARRAY['gold_import'::text, 'hub'::text]))),
    CONSTRAINT interest_keyword_source_types_check CHECK ((((cardinality(source_types) >= 1) AND (cardinality(source_types) <= 2)) AND (source_types <@ ARRAY['google_keyword'::text, 'community_voc'::text]))),
    CONSTRAINT interest_keyword_status_check CHECK ((status = ANY (ARRAY['active'::text, 'stopped'::text]))),
    CONSTRAINT interest_keyword_term_check CHECK ((((length(term) >= 1) AND (length(term) <= 200)) AND (term !~ '[[:cntrl:]]'::text))),
    CONSTRAINT interest_keyword_term_norm_check CHECK (((length(term_norm) >= 1) AND (length(term_norm) <= 200)))
);

COMMENT ON TABLE catalog.interest_keyword IS 'Seed keywords and their collection conditions, owned by the HUB (Admin › 고객 관심 데이터 관리); published as interest_keyword.';

CREATE TABLE catalog.interest_keyword_event (
    event_id bigint NOT NULL,
    term_norm text NOT NULL,
    action text NOT NULL,
    actor_id uuid,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_seq bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT interest_keyword_event_action_check CHECK ((action = ANY (ARRAY['import'::text, 'add'::text, 'set'::text, 'stop'::text, 'resume'::text]))),
    CONSTRAINT interest_keyword_event_changes_check CHECK ((jsonb_typeof(changes) = 'object'::text))
);

ALTER TABLE catalog.interest_keyword_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME catalog.interest_keyword_event_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE catalog.interest_source (
    source_key text NOT NULL,
    url text NOT NULL,
    channel text NOT NULL,
    brands text[] DEFAULT '{}'::text[] NOT NULL,
    note text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT interest_source_brands_check CHECK ((brands <@ ARRAY['Hyundai'::text, 'Kia'::text, 'Genesis'::text])),
    CONSTRAINT interest_source_channel_check CHECK ((channel = ANY (ARRAY['news'::text, 'pr'::text, 'social'::text, 'community'::text]))),
    CONSTRAINT interest_source_note_check CHECK ((length(note) <= 500)),
    CONSTRAINT interest_source_source_key_check CHECK (((source_key = lower(source_key)) AND (source_key !~ '^www\.'::text) AND (source_key !~ '://'::text) AND (source_key !~ '/$'::text) AND (source_key !~ '[[:space:][:cntrl:]]'::text) AND ((length(source_key) >= 3) AND (length(source_key) <= 300)) AND (source_key ~ '^[^/]+\.[^/]+'::text))),
    CONSTRAINT interest_source_status_check CHECK ((status = ANY (ARRAY['active'::text, 'stopped'::text]))),
    CONSTRAINT interest_source_url_check CHECK (((url = btrim(url)) AND ((length(url) >= 3) AND (length(url) <= 500)) AND (url !~ '[[:space:][:cntrl:]]'::text)))
);

COMMENT ON TABLE catalog.interest_source IS 'Community sources to collect from, owned by the HUB (Admin › 고객 관심 데이터 관리); published as interest_source.';

CREATE TABLE catalog.interest_source_event (
    event_id bigint NOT NULL,
    source_key text NOT NULL,
    action text NOT NULL,
    actor_id uuid,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_seq bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT interest_source_event_action_check CHECK ((action = ANY (ARRAY['add'::text, 'set'::text, 'stop'::text, 'resume'::text]))),
    CONSTRAINT interest_source_event_changes_check CHECK ((jsonb_typeof(changes) = 'object'::text))
);

ALTER TABLE catalog.interest_source_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME catalog.interest_source_event_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE catalog.source_code (
    kind text NOT NULL,
    code text NOT NULL,
    number smallint NOT NULL,
    name_en text NOT NULL,
    name_ko text NOT NULL,
    ord smallint NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT source_code_code_check CHECK ((code ~ '^[a-z][A-Za-z0-9]{0,63}$'::text)),
    CONSTRAINT source_code_description_check CHECK ((length(description) <= 500)),
    CONSTRAINT source_code_kind_check CHECK ((kind = ANY (ARRAY['category'::text, 'layer'::text]))),
    CONSTRAINT source_code_name_en_check CHECK (((name_en = btrim(name_en)) AND ((length(name_en) >= 1) AND (length(name_en) <= 80)) AND (name_en !~ '[[:cntrl:]]'::text))),
    CONSTRAINT source_code_name_ko_check CHECK (((name_ko = btrim(name_ko)) AND ((length(name_ko) >= 1) AND (length(name_ko) <= 80)) AND (name_ko !~ '[[:cntrl:]]'::text))),
    CONSTRAINT source_code_number_check CHECK (((number >= 1) AND (number <= 99))),
    CONSTRAINT source_code_ord_check CHECK (((ord >= 1) AND (ord <= 99)))
);

COMMENT ON TABLE catalog.source_code IS 'Source category and classification layer code table, owned by the HUB; published as source_code.';

CREATE TABLE catalog.source_code_event (
    event_id bigint NOT NULL,
    kind text NOT NULL,
    code text NOT NULL,
    action text NOT NULL,
    actor_id uuid,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_seq bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_code_event_action_check CHECK ((action = ANY (ARRAY['import'::text, 'set'::text, 'order'::text]))),
    CONSTRAINT source_code_event_changes_check CHECK ((jsonb_typeof(changes) = 'object'::text))
);

ALTER TABLE catalog.source_code_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME catalog.source_code_event_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE catalog.source_code_version (
    kind text NOT NULL,
    code text NOT NULL,
    version integer NOT NULL,
    number smallint NOT NULL,
    name_en text NOT NULL,
    name_ko text NOT NULL,
    ord smallint NOT NULL,
    description text,
    recorded_at timestamp with time zone NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    CONSTRAINT source_code_version_version_check CHECK ((version > 0))
);

COMMENT ON TABLE catalog.source_code_version IS 'Every version of a code-table row (the whole row), written by catalog.record_source_version() only.';

CREATE TABLE catalog.source_override (
    skey text NOT NULL,
    category text NOT NULL,
    note text,
    status text DEFAULT 'active'::text NOT NULL,
    origin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT source_override_category_check CHECK ((category ~ '^[a-z][A-Za-z0-9]{0,63}$'::text)),
    CONSTRAINT source_override_note_check CHECK ((length(note) <= 500)),
    CONSTRAINT source_override_origin_check CHECK ((origin = ANY (ARRAY['gold_import'::text, 'hub'::text]))),
    CONSTRAINT source_override_skey_check CHECK (((skey = lower(skey)) AND (skey = btrim(skey)) AND (skey !~ '^www\.'::text) AND (skey !~ '[[:space:][:cntrl:]]'::text) AND ((length(skey) >= 3) AND (length(skey) <= 300)) AND (skey ~ '\.'::text))),
    CONSTRAINT source_override_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cleared'::text])))
);

COMMENT ON TABLE catalog.source_override IS 'Source category corrections owned by the HUB (Admin › 인용 출처 분류); published as the reference family source_override.';

CREATE TABLE catalog.source_override_event (
    event_id bigint NOT NULL,
    skey text NOT NULL,
    action text NOT NULL,
    actor_id uuid,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_seq bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_override_event_action_check CHECK ((action = ANY (ARRAY['import'::text, 'set'::text, 'clear'::text]))),
    CONSTRAINT source_override_event_changes_check CHECK ((jsonb_typeof(changes) = 'object'::text))
);

ALTER TABLE catalog.source_override_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME catalog.source_override_event_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE catalog.source_override_version (
    skey text NOT NULL,
    version integer NOT NULL,
    category text NOT NULL,
    note text,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    CONSTRAINT source_override_version_version_check CHECK ((version > 0))
);

COMMENT ON TABLE catalog.source_override_version IS 'Every version of a source correction (the whole row), written by catalog.record_source_version() only.';

CREATE TABLE catalog.source_seed (
    skey text NOT NULL,
    category text NOT NULL,
    note text,
    status text DEFAULT 'active'::text NOT NULL,
    origin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT source_seed_category_check CHECK ((category ~ '^[a-z][A-Za-z0-9]{0,63}$'::text)),
    CONSTRAINT source_seed_note_check CHECK ((length(note) <= 500)),
    CONSTRAINT source_seed_origin_check CHECK ((origin = ANY (ARRAY['file_import'::text, 'hub'::text]))),
    CONSTRAINT source_seed_skey_check CHECK (((skey = lower(skey)) AND (skey = btrim(skey)) AND (skey !~ '^www\.'::text) AND (skey !~ '/'::text) AND (skey !~ '[[:space:][:cntrl:]]'::text) AND ((length(skey) >= 3) AND (length(skey) <= 300)) AND (skey ~ '\.'::text))),
    CONSTRAINT source_seed_status_check CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text])))
);

COMMENT ON TABLE catalog.source_seed IS 'Curated source domains and their category, owned by the HUB (Admin › 인용 출처 분류); published as source_seed.';

CREATE TABLE catalog.source_seed_event (
    event_id bigint NOT NULL,
    skey text NOT NULL,
    action text NOT NULL,
    actor_id uuid,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_seq bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_seed_event_action_check CHECK ((action = ANY (ARRAY['import'::text, 'add'::text, 'set'::text, 'remove'::text]))),
    CONSTRAINT source_seed_event_changes_check CHECK ((jsonb_typeof(changes) = 'object'::text))
);

ALTER TABLE catalog.source_seed_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME catalog.source_seed_event_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE catalog.source_seed_version (
    skey text NOT NULL,
    version integer NOT NULL,
    category text NOT NULL,
    note text,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    CONSTRAINT source_seed_version_version_check CHECK ((version > 0))
);

COMMENT ON TABLE catalog.source_seed_version IS 'Every version of a seed (the whole row), written by catalog.record_source_version() only.';

CREATE TABLE catalog.source_social (
    account_key text NOT NULL,
    display_key text NOT NULL,
    domain text NOT NULL,
    matchers jsonb NOT NULL,
    note text,
    status text DEFAULT 'active'::text NOT NULL,
    origin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT source_social_account_key_check CHECK (((account_key = lower(account_key)) AND (account_key ~ '^[^/]+\.[^/]+/.+'::text) AND (account_key !~ '^www\.'::text) AND (account_key !~ '[[:space:][:cntrl:]]'::text) AND ((length(account_key) >= 5) AND (length(account_key) <= 300)))),
    CONSTRAINT source_social_check CHECK (((lower(display_key) = account_key) AND (display_key = btrim(display_key)))),
    CONSTRAINT source_social_check1 CHECK ((account_key ~~ (domain || '/%'::text))),
    CONSTRAINT source_social_domain_check CHECK (((domain = lower(domain)) AND (domain ~ '\.'::text) AND (domain !~ '/'::text))),
    CONSTRAINT source_social_matchers_check CHECK (((jsonb_typeof(matchers) = 'array'::text) AND ((jsonb_array_length(matchers) >= 1) AND (jsonb_array_length(matchers) <= 10)))),
    CONSTRAINT source_social_note_check CHECK ((length(note) <= 500)),
    CONSTRAINT source_social_origin_check CHECK ((origin = ANY (ARRAY['file_import'::text, 'hub'::text]))),
    CONSTRAINT source_social_status_check CHECK ((status = ANY (ARRAY['active'::text, 'stopped'::text])))
);

COMMENT ON TABLE catalog.source_social IS 'Official HMG social accounts and their URL matchers, owned by the HUB; published as source_social.';

CREATE TABLE catalog.source_social_event (
    event_id bigint NOT NULL,
    account_key text NOT NULL,
    action text NOT NULL,
    actor_id uuid,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_seq bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_social_event_action_check CHECK ((action = ANY (ARRAY['import'::text, 'add'::text, 'set'::text, 'stop'::text, 'resume'::text]))),
    CONSTRAINT source_social_event_changes_check CHECK ((jsonb_typeof(changes) = 'object'::text))
);

ALTER TABLE catalog.source_social_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME catalog.source_social_event_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE catalog.source_social_version (
    account_key text NOT NULL,
    version integer NOT NULL,
    display_key text NOT NULL,
    domain text NOT NULL,
    matchers jsonb NOT NULL,
    note text,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    CONSTRAINT source_social_version_version_check CHECK ((version > 0))
);

COMMENT ON TABLE catalog.source_social_version IS 'Every version of an official social account (the whole row), written by catalog.record_source_version() only.';

CREATE TABLE catalog.sync_run (
    run_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    result text DEFAULT 'running'::text NOT NULL,
    reason text,
    gold_versions jsonb,
    gold_release jsonb,
    counts jsonb,
    removal_candidates jsonb,
    CONSTRAINT sync_run_result_check CHECK ((result = ANY (ARRAY['running'::text, 'ok'::text, 'refused'::text, 'failed'::text])))
);

CREATE TABLE publication.api_client (
    client_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_client_created_by_check CHECK ((length(TRIM(BOTH FROM created_by)) > 0)),
    CONSTRAINT api_client_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT api_client_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

CREATE TABLE publication.api_key (
    key_id uuid NOT NULL,
    client_id uuid NOT NULL,
    key_hash text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by text,
    revoke_reason text,
    CONSTRAINT api_key_check CHECK ((expires_at > created_at)),
    CONSTRAINT api_key_check1 CHECK (((revoked_at IS NULL) = (revoked_by IS NULL))),
    CONSTRAINT api_key_created_by_check CHECK ((length(TRIM(BOTH FROM created_by)) > 0)),
    CONSTRAINT api_key_key_hash_check CHECK ((key_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE VIEW ext.caller WITH (security_barrier='true') AS
 SELECT c.client_id,
    c.name AS client_name,
    k.key_id,
    k.expires_at
   FROM (publication.api_key k
     JOIN publication.api_client c USING (client_id))
  WHERE ((k.key_hash = NULLIF(current_setting('hgh.key_hash'::text, true), ''::text)) AND (k.revoked_at IS NULL) AND (k.expires_at > now()) AND (c.status = 'active'::text));

CREATE VIEW ext.meta WITH (security_barrier='true') AS
 SELECT client_id,
    client_name,
    key_id,
    expires_at,
    ( SELECT max(sync_run.finished_at) AS max
           FROM catalog.sync_run
          WHERE (sync_run.result = 'ok'::text)) AS as_of,
    ( SELECT string_agg(((s.family || ':'::text) || s.sha256), ','::text ORDER BY s.family) AS string_agg
           FROM catalog.current_reference_set s
          WHERE (s.source = 'hub'::text)) AS hub_reference
   FROM ext.caller c;

CREATE TABLE publication.api_client_project (
    client_id uuid NOT NULL,
    project_id uuid NOT NULL,
    granted_by text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    grant_seq bigint DEFAULT nextval('catalog.change_seq'::regclass) NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by text,
    CONSTRAINT api_client_project_check CHECK (((revoked_at IS NULL) = (revoked_by IS NULL))),
    CONSTRAINT api_client_project_granted_by_check CHECK ((length(TRIM(BOTH FROM granted_by)) > 0))
);

CREATE TABLE publication.project_access (
    project_id uuid NOT NULL,
    projects boolean DEFAULT false NOT NULL,
    prompts boolean DEFAULT false NOT NULL,
    approved_by text NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    access_seq bigint DEFAULT nextval('catalog.change_seq'::regclass) NOT NULL,
    CONSTRAINT project_access_approved_by_check CHECK ((length(TRIM(BOTH FROM approved_by)) > 0))
);

CREATE VIEW ext.projects WITH (security_barrier='true') AS
 SELECT p.project_id,
    p.origin,
    p.change_seq,
    p.sha256,
    p.recorded_at,
    GREATEST(g.grant_seq, a.access_seq) AS reset_seq,
        CASE
            WHEN (COALESCE((p.definition ->> 'status'::text), 'active'::text) = 'active'::text) THEN (((p.definition - 'scope_project_id'::text) - 'source_project_id'::text) - 'site_id'::text)
            ELSE jsonb_build_object('status', (p.definition ->> 'status'::text))
        END AS definition
   FROM (((ext.caller c
     JOIN publication.api_client_project g ON (((g.client_id = c.client_id) AND (g.revoked_at IS NULL))))
     JOIN publication.project_access a ON (((a.project_id = g.project_id) AND a.projects)))
     JOIN catalog.current_project p ON ((p.project_id = g.project_id)));

CREATE VIEW ext.prompts WITH (security_barrier='true') AS
 SELECT q.prompt_id,
    q.project_id,
    q.origin,
    q.change_seq,
    q.sha256,
    q.recorded_at,
        CASE
            WHEN (COALESCE((q.definition ->> 'status'::text), 'active'::text) = 'active'::text) THEN q.text
            ELSE NULL::text
        END AS text,
        CASE
            WHEN (COALESCE((q.definition ->> 'status'::text), 'active'::text) = 'active'::text) THEN q.definition
            ELSE jsonb_build_object('status', (q.definition ->> 'status'::text))
        END AS definition
   FROM ((ext.projects p
     JOIN publication.project_access a ON (((a.project_id = p.project_id) AND a.prompts)))
     JOIN catalog.current_prompt q ON ((q.project_id = p.project_id)));

CREATE TABLE publication.reference_access (
    family text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    approved_by text NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    access_seq bigint DEFAULT nextval('catalog.change_seq'::regclass) NOT NULL,
    CONSTRAINT reference_access_approved_by_check CHECK ((length(TRIM(BOTH FROM approved_by)) > 0))
);

CREATE VIEW ext.reference_items WITH (security_barrier='true') AS
 SELECT family,
    item_key,
    definition,
    change_seq
   FROM catalog.current_reference r
  WHERE ((EXISTS ( SELECT 1
           FROM ext.caller)) AND ((source = 'hub'::text) OR (EXISTS ( SELECT 1
           FROM publication.reference_access a
          WHERE ((a.family = r.family) AND a.enabled)))));

CREATE VIEW ext.reference_sets WITH (security_barrier='true') AS
 SELECT family,
    source,
    item_count,
    sha256,
    change_seq,
    recorded_at
   FROM catalog.current_reference_set s
  WHERE ((EXISTS ( SELECT 1
           FROM ext.caller)) AND ((source = 'hub'::text) OR (EXISTS ( SELECT 1
           FROM publication.reference_access r
          WHERE ((r.family = s.family) AND r.enabled)))));

ALTER TABLE ONLY catalog.entity_role_event
    ADD CONSTRAINT entity_role_event_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY catalog.entity_role
    ADD CONSTRAINT entity_role_pkey PRIMARY KEY (entity_id);

ALTER TABLE ONLY catalog.interest_keyword_event
    ADD CONSTRAINT interest_keyword_event_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY catalog.interest_keyword
    ADD CONSTRAINT interest_keyword_pkey PRIMARY KEY (term_norm);

ALTER TABLE ONLY catalog.interest_source_event
    ADD CONSTRAINT interest_source_event_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY catalog.interest_source
    ADD CONSTRAINT interest_source_pkey PRIMARY KEY (source_key);

ALTER TABLE ONLY catalog.project
    ADD CONSTRAINT project_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY catalog.project
    ADD CONSTRAINT project_source_id_key UNIQUE (source_id);

ALTER TABLE ONLY catalog.project_version
    ADD CONSTRAINT project_version_pkey PRIMARY KEY (project_id, version);

ALTER TABLE ONLY catalog.prompt
    ADD CONSTRAINT prompt_pkey PRIMARY KEY (prompt_id);

ALTER TABLE ONLY catalog.prompt
    ADD CONSTRAINT prompt_source_id_key UNIQUE (source_id);

ALTER TABLE ONLY catalog.prompt_version
    ADD CONSTRAINT prompt_version_pkey PRIMARY KEY (prompt_id, version);

ALTER TABLE ONLY catalog.reference_item
    ADD CONSTRAINT reference_item_pkey PRIMARY KEY (set_id, item_key);

ALTER TABLE ONLY catalog.reference_set
    ADD CONSTRAINT reference_set_family_version_key UNIQUE (family, version);

ALTER TABLE ONLY catalog.reference_set
    ADD CONSTRAINT reference_set_pkey PRIMARY KEY (set_id);

ALTER TABLE ONLY catalog.source_code_event
    ADD CONSTRAINT source_code_event_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY catalog.source_code
    ADD CONSTRAINT source_code_kind_number_key UNIQUE (kind, number);

ALTER TABLE ONLY catalog.source_code
    ADD CONSTRAINT source_code_order UNIQUE (kind, ord) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY catalog.source_code
    ADD CONSTRAINT source_code_pkey PRIMARY KEY (kind, code);

ALTER TABLE ONLY catalog.source_code_version
    ADD CONSTRAINT source_code_version_pkey PRIMARY KEY (kind, code, version);

ALTER TABLE ONLY catalog.source_override_event
    ADD CONSTRAINT source_override_event_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY catalog.source_override
    ADD CONSTRAINT source_override_pkey PRIMARY KEY (skey);

ALTER TABLE ONLY catalog.source_override_version
    ADD CONSTRAINT source_override_version_pkey PRIMARY KEY (skey, version);

ALTER TABLE ONLY catalog.source_seed_event
    ADD CONSTRAINT source_seed_event_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY catalog.source_seed
    ADD CONSTRAINT source_seed_pkey PRIMARY KEY (skey);

ALTER TABLE ONLY catalog.source_seed_version
    ADD CONSTRAINT source_seed_version_pkey PRIMARY KEY (skey, version);

ALTER TABLE ONLY catalog.source_social_event
    ADD CONSTRAINT source_social_event_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY catalog.source_social
    ADD CONSTRAINT source_social_pkey PRIMARY KEY (account_key);

ALTER TABLE ONLY catalog.source_social_version
    ADD CONSTRAINT source_social_version_pkey PRIMARY KEY (account_key, version);

ALTER TABLE ONLY catalog.sync_run
    ADD CONSTRAINT sync_run_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY publication.api_client
    ADD CONSTRAINT api_client_name_key UNIQUE (name);

ALTER TABLE ONLY publication.api_client
    ADD CONSTRAINT api_client_pkey PRIMARY KEY (client_id);

ALTER TABLE ONLY publication.api_client_project
    ADD CONSTRAINT api_client_project_pkey PRIMARY KEY (client_id, project_id);

ALTER TABLE ONLY publication.api_key
    ADD CONSTRAINT api_key_key_hash_key UNIQUE (key_hash);

ALTER TABLE ONLY publication.api_key
    ADD CONSTRAINT api_key_pkey PRIMARY KEY (key_id);

ALTER TABLE ONLY publication.project_access
    ADD CONSTRAINT project_access_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY publication.reference_access
    ADD CONSTRAINT reference_access_pkey PRIMARY KEY (family);

CREATE INDEX entity_role_event_key ON catalog.entity_role_event USING btree (entity_id, occurred_at);

CREATE INDEX entity_role_event_time ON catalog.entity_role_event USING btree (occurred_at);

CREATE INDEX interest_keyword_event_key ON catalog.interest_keyword_event USING btree (term_norm, occurred_at);

CREATE INDEX interest_keyword_event_time ON catalog.interest_keyword_event USING btree (occurred_at);

CREATE INDEX interest_source_event_key ON catalog.interest_source_event USING btree (source_key, occurred_at);

CREATE INDEX interest_source_event_time ON catalog.interest_source_event USING btree (occurred_at);

CREATE INDEX project_version_change_seq ON catalog.project_version USING btree (change_seq);

CREATE INDEX project_version_hub ON catalog.project_version USING btree (project_id) WHERE (recorded_by IS NOT NULL);

CREATE INDEX prompt_project ON catalog.prompt USING btree (project_id);

CREATE INDEX prompt_version_change_seq ON catalog.prompt_version USING btree (change_seq);

CREATE INDEX prompt_version_hub ON catalog.prompt_version USING btree (prompt_id) WHERE (recorded_by IS NOT NULL);

CREATE INDEX source_code_event_key ON catalog.source_code_event USING btree (kind, code, occurred_at);

CREATE INDEX source_code_event_time ON catalog.source_code_event USING btree (occurred_at);

CREATE INDEX source_code_version_change_seq ON catalog.source_code_version USING btree (change_seq);

CREATE INDEX source_override_event_skey ON catalog.source_override_event USING btree (skey, occurred_at);

CREATE INDEX source_override_event_time ON catalog.source_override_event USING btree (occurred_at);

CREATE INDEX source_override_version_change_seq ON catalog.source_override_version USING btree (change_seq);

CREATE INDEX source_seed_event_key ON catalog.source_seed_event USING btree (skey, occurred_at);

CREATE INDEX source_seed_event_time ON catalog.source_seed_event USING btree (occurred_at);

CREATE INDEX source_seed_version_change_seq ON catalog.source_seed_version USING btree (change_seq);

CREATE INDEX source_social_event_key ON catalog.source_social_event USING btree (account_key, occurred_at);

CREATE INDEX source_social_event_time ON catalog.source_social_event USING btree (occurred_at);

CREATE INDEX source_social_version_change_seq ON catalog.source_social_version USING btree (change_seq);

CREATE INDEX sync_run_finished ON catalog.sync_run USING btree (result, finished_at DESC);

CREATE TRIGGER project_editor_project_version BEFORE INSERT ON catalog.project_version FOR EACH ROW EXECUTE FUNCTION catalog.project_editor_guard();

CREATE TRIGGER project_editor_prompt BEFORE INSERT ON catalog.prompt FOR EACH ROW EXECUTE FUNCTION catalog.project_editor_guard();

CREATE TRIGGER project_editor_prompt_version BEFORE INSERT ON catalog.prompt_version FOR EACH ROW EXECUTE FUNCTION catalog.project_editor_guard();

CREATE TRIGGER reference_set_hub_edit_writer BEFORE INSERT ON catalog.reference_set FOR EACH ROW EXECUTE FUNCTION catalog.reference_set_hub_edit_writer();

CREATE TRIGGER source_code_version AFTER INSERT OR UPDATE ON catalog.source_code FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('kind', 'code');

CREATE TRIGGER source_override_version AFTER INSERT OR UPDATE ON catalog.source_override FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('skey');

CREATE TRIGGER source_seed_version AFTER INSERT OR UPDATE ON catalog.source_seed FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('skey');

CREATE TRIGGER source_social_version AFTER INSERT OR UPDATE ON catalog.source_social FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('account_key');

CREATE TRIGGER api_client_project_seq BEFORE UPDATE ON publication.api_client_project FOR EACH ROW EXECUTE FUNCTION publication.next_grant_seq();

CREATE TRIGGER project_access_seq BEFORE UPDATE ON publication.project_access FOR EACH ROW EXECUTE FUNCTION publication.next_access_seq();

CREATE TRIGGER reference_access_seq BEFORE UPDATE ON publication.reference_access FOR EACH ROW EXECUTE FUNCTION publication.next_access_seq();

ALTER TABLE ONLY catalog.entity_role_event
    ADD CONSTRAINT entity_role_event_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES catalog.entity_role(entity_id);

ALTER TABLE ONLY catalog.interest_keyword_event
    ADD CONSTRAINT interest_keyword_event_term_norm_fkey FOREIGN KEY (term_norm) REFERENCES catalog.interest_keyword(term_norm);

ALTER TABLE ONLY catalog.interest_source_event
    ADD CONSTRAINT interest_source_event_source_key_fkey FOREIGN KEY (source_key) REFERENCES catalog.interest_source(source_key);

ALTER TABLE ONLY catalog.project_version
    ADD CONSTRAINT project_version_project_id_fkey FOREIGN KEY (project_id) REFERENCES catalog.project(project_id);

ALTER TABLE ONLY catalog.prompt
    ADD CONSTRAINT prompt_project_id_fkey FOREIGN KEY (project_id) REFERENCES catalog.project(project_id);

ALTER TABLE ONLY catalog.prompt_version
    ADD CONSTRAINT prompt_version_prompt_id_fkey FOREIGN KEY (prompt_id) REFERENCES catalog.prompt(prompt_id);

ALTER TABLE ONLY catalog.reference_item
    ADD CONSTRAINT reference_item_set_id_fkey FOREIGN KEY (set_id) REFERENCES catalog.reference_set(set_id);

ALTER TABLE ONLY catalog.source_code_event
    ADD CONSTRAINT source_code_event_kind_code_fkey FOREIGN KEY (kind, code) REFERENCES catalog.source_code(kind, code);

ALTER TABLE ONLY catalog.source_code_version
    ADD CONSTRAINT source_code_version_kind_code_fkey FOREIGN KEY (kind, code) REFERENCES catalog.source_code(kind, code);

ALTER TABLE ONLY catalog.source_override_event
    ADD CONSTRAINT source_override_event_skey_fkey FOREIGN KEY (skey) REFERENCES catalog.source_override(skey);

ALTER TABLE ONLY catalog.source_override_version
    ADD CONSTRAINT source_override_version_skey_fkey FOREIGN KEY (skey) REFERENCES catalog.source_override(skey);

ALTER TABLE ONLY catalog.source_seed_event
    ADD CONSTRAINT source_seed_event_skey_fkey FOREIGN KEY (skey) REFERENCES catalog.source_seed(skey);

ALTER TABLE ONLY catalog.source_seed_version
    ADD CONSTRAINT source_seed_version_skey_fkey FOREIGN KEY (skey) REFERENCES catalog.source_seed(skey);

ALTER TABLE ONLY catalog.source_social_event
    ADD CONSTRAINT source_social_event_account_key_fkey FOREIGN KEY (account_key) REFERENCES catalog.source_social(account_key);

ALTER TABLE ONLY catalog.source_social_version
    ADD CONSTRAINT source_social_version_account_key_fkey FOREIGN KEY (account_key) REFERENCES catalog.source_social(account_key);

ALTER TABLE ONLY publication.api_client_project
    ADD CONSTRAINT api_client_project_client_id_fkey FOREIGN KEY (client_id) REFERENCES publication.api_client(client_id);

ALTER TABLE ONLY publication.api_client_project
    ADD CONSTRAINT api_client_project_project_id_fkey FOREIGN KEY (project_id) REFERENCES catalog.project(project_id);

ALTER TABLE ONLY publication.api_key
    ADD CONSTRAINT api_key_client_id_fkey FOREIGN KEY (client_id) REFERENCES publication.api_client(client_id);

ALTER TABLE ONLY publication.project_access
    ADD CONSTRAINT project_access_project_id_fkey FOREIGN KEY (project_id) REFERENCES catalog.project(project_id);

GRANT USAGE ON SCHEMA catalog TO hmg_input_reader;
GRANT USAGE ON SCHEMA catalog TO hmg_catalog_writer;
GRANT USAGE ON SCHEMA catalog TO hmg_catalog_editor;
GRANT USAGE ON SCHEMA catalog TO hmg_source_override_editor;
GRANT USAGE ON SCHEMA catalog TO hmg_interest_editor;
GRANT USAGE ON SCHEMA catalog TO hmg_entity_role_editor;
GRANT USAGE ON SCHEMA catalog TO hmg_project_editor;

GRANT USAGE ON SCHEMA ext TO hmg_ext_api;

REVOKE ALL ON FUNCTION catalog.project_editor_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION catalog.publish_entity_roles() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.publish_entity_roles() TO hmg_entity_role_editor;

REVOKE ALL ON FUNCTION catalog.publish_hub_edit(fam text, items jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION catalog.publish_interest_keywords() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.publish_interest_keywords() TO hmg_interest_editor;

REVOKE ALL ON FUNCTION catalog.publish_interest_sources() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.publish_interest_sources() TO hmg_interest_editor;

REVOKE ALL ON FUNCTION catalog.publish_source_codes() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.publish_source_codes() TO hmg_source_override_editor;

REVOKE ALL ON FUNCTION catalog.publish_source_overrides() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.publish_source_overrides() TO hmg_source_override_editor;

REVOKE ALL ON FUNCTION catalog.publish_source_seeds() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.publish_source_seeds() TO hmg_source_override_editor;

REVOKE ALL ON FUNCTION catalog.publish_source_socials() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.publish_source_socials() TO hmg_source_override_editor;

REVOKE ALL ON FUNCTION catalog.record_source_version() FROM PUBLIC;

REVOKE ALL ON FUNCTION catalog.reference_set_hub_edit_writer() FROM PUBLIC;

REVOKE ALL ON FUNCTION publication.next_access_seq() FROM PUBLIC;

REVOKE ALL ON FUNCTION publication.next_grant_seq() FROM PUBLIC;

GRANT USAGE ON SEQUENCE catalog.change_seq TO hmg_catalog_writer;
GRANT USAGE ON SEQUENCE catalog.change_seq TO hmg_catalog_editor;
GRANT USAGE ON SEQUENCE catalog.change_seq TO hmg_project_editor;

GRANT SELECT ON TABLE catalog.project TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.project TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.project TO hmg_catalog_editor;
GRANT SELECT ON TABLE catalog.project TO hmg_project_editor;

GRANT SELECT ON TABLE catalog.project_version TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.project_version TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.project_version TO hmg_catalog_editor;
GRANT SELECT ON TABLE catalog.project_version TO hmg_project_editor;

GRANT INSERT(project_id) ON TABLE catalog.project_version TO hmg_catalog_writer;
GRANT INSERT(project_id) ON TABLE catalog.project_version TO hmg_project_editor;

GRANT INSERT(version) ON TABLE catalog.project_version TO hmg_catalog_writer;
GRANT INSERT(version) ON TABLE catalog.project_version TO hmg_project_editor;

GRANT INSERT(definition) ON TABLE catalog.project_version TO hmg_catalog_writer;
GRANT INSERT(definition) ON TABLE catalog.project_version TO hmg_project_editor;

GRANT INSERT(sha256) ON TABLE catalog.project_version TO hmg_catalog_writer;
GRANT INSERT(sha256) ON TABLE catalog.project_version TO hmg_project_editor;

GRANT INSERT(recorded_by) ON TABLE catalog.project_version TO hmg_project_editor;

GRANT SELECT ON TABLE catalog.current_project TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.current_project TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.current_project TO hmg_catalog_editor;
GRANT SELECT ON TABLE catalog.current_project TO hmg_project_editor;

GRANT SELECT ON TABLE catalog.prompt TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.prompt TO hmg_catalog_writer;
GRANT SELECT,INSERT ON TABLE catalog.prompt TO hmg_catalog_editor;
GRANT SELECT,INSERT ON TABLE catalog.prompt TO hmg_project_editor;

GRANT SELECT ON TABLE catalog.prompt_version TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.prompt_version TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.prompt_version TO hmg_catalog_editor;
GRANT SELECT ON TABLE catalog.prompt_version TO hmg_project_editor;

GRANT INSERT(prompt_id) ON TABLE catalog.prompt_version TO hmg_catalog_writer;
GRANT INSERT(prompt_id) ON TABLE catalog.prompt_version TO hmg_catalog_editor;
GRANT INSERT(prompt_id) ON TABLE catalog.prompt_version TO hmg_project_editor;

GRANT INSERT(version) ON TABLE catalog.prompt_version TO hmg_catalog_writer;
GRANT INSERT(version) ON TABLE catalog.prompt_version TO hmg_catalog_editor;
GRANT INSERT(version) ON TABLE catalog.prompt_version TO hmg_project_editor;

GRANT INSERT(text) ON TABLE catalog.prompt_version TO hmg_catalog_writer;
GRANT INSERT(text) ON TABLE catalog.prompt_version TO hmg_catalog_editor;
GRANT INSERT(text) ON TABLE catalog.prompt_version TO hmg_project_editor;

GRANT INSERT(definition) ON TABLE catalog.prompt_version TO hmg_catalog_writer;
GRANT INSERT(definition) ON TABLE catalog.prompt_version TO hmg_catalog_editor;
GRANT INSERT(definition) ON TABLE catalog.prompt_version TO hmg_project_editor;

GRANT INSERT(sha256) ON TABLE catalog.prompt_version TO hmg_catalog_writer;
GRANT INSERT(sha256) ON TABLE catalog.prompt_version TO hmg_catalog_editor;
GRANT INSERT(sha256) ON TABLE catalog.prompt_version TO hmg_project_editor;

GRANT INSERT(recorded_by) ON TABLE catalog.prompt_version TO hmg_catalog_editor;
GRANT INSERT(recorded_by) ON TABLE catalog.prompt_version TO hmg_project_editor;

GRANT SELECT ON TABLE catalog.current_prompt TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.current_prompt TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.current_prompt TO hmg_catalog_editor;
GRANT SELECT ON TABLE catalog.current_prompt TO hmg_project_editor;

GRANT SELECT ON TABLE catalog.reference_set TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.reference_set TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.reference_set TO hmg_catalog_editor;

GRANT INSERT(set_id) ON TABLE catalog.reference_set TO hmg_catalog_writer;

GRANT INSERT(family) ON TABLE catalog.reference_set TO hmg_catalog_writer;

GRANT INSERT(version) ON TABLE catalog.reference_set TO hmg_catalog_writer;

GRANT INSERT(item_count) ON TABLE catalog.reference_set TO hmg_catalog_writer;

GRANT INSERT(sha256) ON TABLE catalog.reference_set TO hmg_catalog_writer;

GRANT INSERT(source) ON TABLE catalog.reference_set TO hmg_catalog_writer;

GRANT INSERT(source_release) ON TABLE catalog.reference_set TO hmg_catalog_writer;

GRANT SELECT ON TABLE catalog.current_reference_set TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.current_reference_set TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.current_reference_set TO hmg_catalog_editor;

GRANT SELECT,INSERT ON TABLE catalog.reference_item TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.reference_item TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.reference_item TO hmg_catalog_editor;

GRANT SELECT ON TABLE catalog.current_reference TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.current_reference TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.current_reference TO hmg_catalog_editor;
GRANT SELECT ON TABLE catalog.current_reference TO hmg_project_editor;

GRANT SELECT ON TABLE catalog.entity_role TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.entity_role TO hmg_entity_role_editor;

GRANT UPDATE(role) ON TABLE catalog.entity_role TO hmg_entity_role_editor;

GRANT UPDATE(brand) ON TABLE catalog.entity_role TO hmg_entity_role_editor;

GRANT UPDATE(note) ON TABLE catalog.entity_role TO hmg_entity_role_editor;

GRANT UPDATE(status) ON TABLE catalog.entity_role TO hmg_entity_role_editor;

GRANT UPDATE(updated_at) ON TABLE catalog.entity_role TO hmg_entity_role_editor;

GRANT UPDATE(updated_by) ON TABLE catalog.entity_role TO hmg_entity_role_editor;

GRANT SELECT ON TABLE catalog.entity_role_event TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.entity_role_event TO hmg_entity_role_editor;

GRANT SELECT ON TABLE catalog.interest_keyword TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.interest_keyword TO hmg_interest_editor;

GRANT UPDATE(conditions) ON TABLE catalog.interest_keyword TO hmg_interest_editor;

GRANT UPDATE(source_types) ON TABLE catalog.interest_keyword TO hmg_interest_editor;

GRANT UPDATE(brands) ON TABLE catalog.interest_keyword TO hmg_interest_editor;

GRANT UPDATE(note) ON TABLE catalog.interest_keyword TO hmg_interest_editor;

GRANT UPDATE(status) ON TABLE catalog.interest_keyword TO hmg_interest_editor;

GRANT UPDATE(updated_at) ON TABLE catalog.interest_keyword TO hmg_interest_editor;

GRANT UPDATE(updated_by) ON TABLE catalog.interest_keyword TO hmg_interest_editor;

GRANT SELECT ON TABLE catalog.interest_keyword_event TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.interest_keyword_event TO hmg_interest_editor;

GRANT SELECT ON TABLE catalog.interest_source TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.interest_source TO hmg_interest_editor;

GRANT UPDATE(channel) ON TABLE catalog.interest_source TO hmg_interest_editor;

GRANT UPDATE(brands) ON TABLE catalog.interest_source TO hmg_interest_editor;

GRANT UPDATE(note) ON TABLE catalog.interest_source TO hmg_interest_editor;

GRANT UPDATE(status) ON TABLE catalog.interest_source TO hmg_interest_editor;

GRANT UPDATE(updated_at) ON TABLE catalog.interest_source TO hmg_interest_editor;

GRANT UPDATE(updated_by) ON TABLE catalog.interest_source TO hmg_interest_editor;

GRANT SELECT ON TABLE catalog.interest_source_event TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.interest_source_event TO hmg_interest_editor;

GRANT SELECT ON TABLE catalog.source_code TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.source_code TO hmg_source_override_editor;

GRANT UPDATE(name_en) ON TABLE catalog.source_code TO hmg_source_override_editor;

GRANT UPDATE(name_ko) ON TABLE catalog.source_code TO hmg_source_override_editor;

GRANT UPDATE(ord) ON TABLE catalog.source_code TO hmg_source_override_editor;

GRANT UPDATE(description) ON TABLE catalog.source_code TO hmg_source_override_editor;

GRANT UPDATE(updated_at) ON TABLE catalog.source_code TO hmg_source_override_editor;

GRANT UPDATE(updated_by) ON TABLE catalog.source_code TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_code_event TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.source_code_event TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_code_version TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.source_code_version TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_override TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.source_override TO hmg_source_override_editor;

GRANT UPDATE(category) ON TABLE catalog.source_override TO hmg_source_override_editor;

GRANT UPDATE(status) ON TABLE catalog.source_override TO hmg_source_override_editor;

GRANT UPDATE(updated_at) ON TABLE catalog.source_override TO hmg_source_override_editor;

GRANT UPDATE(updated_by) ON TABLE catalog.source_override TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_override_event TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.source_override_event TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_override_version TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.source_override_version TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_seed TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.source_seed TO hmg_source_override_editor;

GRANT UPDATE(category) ON TABLE catalog.source_seed TO hmg_source_override_editor;

GRANT UPDATE(status) ON TABLE catalog.source_seed TO hmg_source_override_editor;

GRANT UPDATE(updated_at) ON TABLE catalog.source_seed TO hmg_source_override_editor;

GRANT UPDATE(updated_by) ON TABLE catalog.source_seed TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_seed_event TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.source_seed_event TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_seed_version TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.source_seed_version TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_social TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.source_social TO hmg_source_override_editor;

GRANT UPDATE(matchers) ON TABLE catalog.source_social TO hmg_source_override_editor;

GRANT UPDATE(status) ON TABLE catalog.source_social TO hmg_source_override_editor;

GRANT UPDATE(updated_at) ON TABLE catalog.source_social TO hmg_source_override_editor;

GRANT UPDATE(updated_by) ON TABLE catalog.source_social TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_social_event TO hmg_input_reader;
GRANT SELECT,INSERT ON TABLE catalog.source_social_event TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.source_social_version TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.source_social_version TO hmg_source_override_editor;

GRANT SELECT ON TABLE catalog.sync_run TO hmg_input_reader;
GRANT SELECT ON TABLE catalog.sync_run TO hmg_catalog_writer;
GRANT SELECT ON TABLE catalog.sync_run TO hmg_catalog_editor;

GRANT INSERT(run_id) ON TABLE catalog.sync_run TO hmg_catalog_writer;

GRANT UPDATE(finished_at) ON TABLE catalog.sync_run TO hmg_catalog_writer;

GRANT UPDATE(result) ON TABLE catalog.sync_run TO hmg_catalog_writer;

GRANT UPDATE(reason) ON TABLE catalog.sync_run TO hmg_catalog_writer;

GRANT INSERT(gold_versions),UPDATE(gold_versions) ON TABLE catalog.sync_run TO hmg_catalog_writer;

GRANT UPDATE(gold_release) ON TABLE catalog.sync_run TO hmg_catalog_writer;

GRANT UPDATE(counts) ON TABLE catalog.sync_run TO hmg_catalog_writer;

GRANT UPDATE(removal_candidates) ON TABLE catalog.sync_run TO hmg_catalog_writer;

GRANT SELECT ON TABLE ext.caller TO hmg_ext_api;

GRANT SELECT ON TABLE ext.meta TO hmg_ext_api;

GRANT SELECT ON TABLE ext.projects TO hmg_ext_api;

GRANT SELECT ON TABLE ext.prompts TO hmg_ext_api;

GRANT SELECT ON TABLE ext.reference_items TO hmg_ext_api;

GRANT SELECT ON TABLE ext.reference_sets TO hmg_ext_api;


--
-- PostgreSQL database dump complete
--

