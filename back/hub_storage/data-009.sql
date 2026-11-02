-- Incremental migration (2026-11-02): the customer-interest collection inputs the HUB owns, edited on the renewal Admin ›
-- 고객 관심 데이터 관리 screen (back/bff/hub_stores/interest.py). Decisions A and E (docs/handoff/admin-todo.md): what people
-- decide to collect is the HUB's. Gold holds what was collected (kw_suggestion seed rows, the social corpus), which the
-- HUB reads next to these lists and never rewrites.
--
-- catalog.interest_keyword: one seed keyword per normalized term (the rule of Gold dim_keyword.term_norm, as
-- catalog.interest_term_norm), its collection conditions ({location_code, language_code}), what it seeds (Google keyword,
-- community VoC) and its brands (none = common). origin gold_import = Gold's seed rows (manage.py
-- import-interest-keywords), hub = added on the screen.
-- catalog.interest_source: one community source per normalized URL (lower case, no scheme, no leading www., no trailing
-- slash; the key the external list carries), with the URL as entered, its channel and its brands. Gold has no such list:
-- no first values, and no collector reads it until the pipeline agrees to.
-- Neither is deleted: stopping is status=stopped. Each has an event table ({field: [before, after]}, the change_seq it
-- went out in) and a publishing function that records the active rows as a reference family (source hub_edit) through
-- catalog.publish_hub_edit (008) when they changed, under the catalog lock.
CREATE FUNCTION catalog.interest_term_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN lower(btrim(normalize(t, NFC),
    E'\u0009\u000A\u000B\u000C\u000D\u001C\u001D\u001E\u001F \u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000') COLLATE "und-x-icu");
COMMENT ON FUNCTION catalog.interest_term_norm(text) IS 'NFC, whitespace trim, lower: the normalization of Gold dim_keyword.term_norm. ICU, because the HUB store runs in the C locale, where lower() leaves non-ASCII letters as they are.';

CREATE TABLE catalog.interest_keyword (
    term_norm text PRIMARY KEY CHECK (length(term_norm) BETWEEN 1 AND 200),
    term text NOT NULL CHECK (length(term) BETWEEN 1 AND 200 AND term !~ '[[:cntrl:]]'),
    conditions jsonb NOT NULL CHECK (jsonb_typeof(conditions)='array' AND jsonb_array_length(conditions) BETWEEN 1 AND 40),
    source_types text[] NOT NULL CHECK (cardinality(source_types) BETWEEN 1 AND 2 AND source_types <@ ARRAY['google_keyword','community_voc']),
    brands text[] NOT NULL DEFAULT '{}' CHECK (brands <@ ARRAY['Hyundai','Kia','Genesis']),
    note text CHECK (length(note) <= 500),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
    origin text NOT NULL CHECK (origin IN ('gold_import','hub')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    CHECK (term_norm = catalog.interest_term_norm(term))
);
CREATE TABLE catalog.interest_keyword_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    term_norm text NOT NULL REFERENCES catalog.interest_keyword(term_norm),
    action text NOT NULL CHECK (action IN ('import','add','set','stop','resume')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes)='object'),
    published_seq bigint,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interest_keyword_event_key ON catalog.interest_keyword_event(term_norm,occurred_at);
CREATE INDEX interest_keyword_event_time ON catalog.interest_keyword_event(occurred_at);

CREATE TABLE catalog.interest_source (
    source_key text PRIMARY KEY CHECK (source_key = lower(source_key) AND source_key !~ '^www\.' AND source_key !~ '://'
                                      AND source_key !~ '/$' AND source_key !~ '[[:space:][:cntrl:]]'
                                      AND length(source_key) BETWEEN 3 AND 300 AND source_key ~ '^[^/]+\.[^/]+'),
    url text NOT NULL CHECK (url = btrim(url) AND length(url) BETWEEN 3 AND 500 AND url !~ '[[:space:][:cntrl:]]'),
    channel text NOT NULL CHECK (channel IN ('news','pr','social','community')),
    brands text[] NOT NULL DEFAULT '{}' CHECK (brands <@ ARRAY['Hyundai','Kia','Genesis']),
    note text CHECK (length(note) <= 500),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
);
CREATE TABLE catalog.interest_source_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_key text NOT NULL REFERENCES catalog.interest_source(source_key),
    action text NOT NULL CHECK (action IN ('add','set','stop','resume')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes)='object'),
    published_seq bigint,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interest_source_event_key ON catalog.interest_source_event(source_key,occurred_at);
CREATE INDEX interest_source_event_time ON catalog.interest_source_event(occurred_at);

-- The two families are the HUB's own (source hub_edit), recorded by their publishing functions only.
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_family_check;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_family_check CHECK (family IN ('surface','brand_bit','mention_type',
    'engine','region','country','language','taxon','brand','entity','source_category','source','owned_base','crawl_bot','keyword',
    'perspective','population','source_override','source_seed','source_social','source_code','interest_keyword','interest_source'));
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_hub_edit;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_hub_edit
    CHECK ((family IN ('source_override','source_seed','source_social','source_code','interest_keyword','interest_source')) = (source='hub_edit'));

CREATE OR REPLACE FUNCTION catalog.reference_set_hub_edit_writer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF NEW.source='hub_edit' AND current_user<>'hmg_analytics_owner' THEN
        RAISE EXCEPTION 'hub_edit sets are recorded by the catalog publishing functions only' USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION catalog.publish_interest_keywords() RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT * FROM catalog.publish_hub_edit('interest_keyword', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',k.term_norm,'term',k.term,'term_norm',k.term_norm,'conditions',k.conditions,
                                                     'source_types',to_jsonb(k.source_types),'brands',to_jsonb(k.brands)) ORDER BY k.term_norm),'[]'::jsonb)
        FROM catalog.interest_keyword k WHERE k.status='active'))
$$;
CREATE FUNCTION catalog.publish_interest_sources() RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT * FROM catalog.publish_hub_edit('interest_source', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',s.source_key,'source_key',s.source_key,'url',s.url,'channel',s.channel,
                                                     'brands',to_jsonb(s.brands)) ORDER BY s.source_key),'[]'::jsonb)
        FROM catalog.interest_source s WHERE s.status='active'))
$$;
REVOKE ALL ON FUNCTION catalog.publish_interest_keywords(),catalog.publish_interest_sources() FROM PUBLIC;

GRANT SELECT ON catalog.interest_keyword,catalog.interest_keyword_event,catalog.interest_source,catalog.interest_source_event
    TO hmg_analytics_reader;
-- The API's role for this screen: the two lists, their history and their publishing functions. No DELETE, no key, term,
-- URL or origin change, no other catalog table, no reference_set INSERT of its own.
GRANT USAGE ON SCHEMA catalog TO hmg_interest_editor;
GRANT SELECT,INSERT ON catalog.interest_keyword,catalog.interest_source TO hmg_interest_editor;
GRANT UPDATE(conditions,source_types,brands,note,status,updated_at,updated_by) ON catalog.interest_keyword TO hmg_interest_editor;
GRANT UPDATE(channel,brands,note,status,updated_at,updated_by) ON catalog.interest_source TO hmg_interest_editor;
GRANT SELECT,INSERT ON catalog.interest_keyword_event,catalog.interest_source_event TO hmg_interest_editor;
GRANT EXECUTE ON FUNCTION catalog.publish_interest_keywords(),catalog.publish_interest_sources() TO hmg_interest_editor;
COMMENT ON TABLE catalog.interest_keyword IS 'Seed keywords and their collection conditions, owned by the HUB (Admin › 고객 관심 데이터 관리); published as interest_keyword.';
COMMENT ON TABLE catalog.interest_source IS 'Community sources to collect from, owned by the HUB (Admin › 고객 관심 데이터 관리); published as interest_source.';
