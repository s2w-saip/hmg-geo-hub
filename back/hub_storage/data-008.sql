-- Incremental migration (2026-10-30): the rest of the source classification inputs the HUB owns, edited on the
-- renewal Admin › 인용 출처 분류 screen (back/bff/hub_stores/source_lists.py), next to the corrections of 007.
-- Decisions 코드표 and G (docs/handoff/admin-todo.md): the code table, the seed list and the official social accounts
-- are the HUB's. Gold only holds their results (dim_category, dim_source.category_src 4 · 2); the first values came
-- from the original HUB app (front/lib/citation-categorizer: taxonomy.ts, seed.json, official-social.ts) and the
-- labels of front/messages (manage.py import-source-lists). The automatic classification (rules) stays Gold's.
--
-- catalog.source_seed: one curated domain → category per row (key as source_override: lower case, no leading www.,
-- no slash). Never deleted: removing is status=removed. origin file_import = seed.json, hub = added on the screen.
-- catalog.source_social: one official HMG social account (category Official (HMG), not stored) per row. account_key
-- is lower(display_key); matchers are the URL prefixes folded into the account ({prefix, boundary}). Stopping is
-- status=stopped.
-- catalog.source_code: the code table. kind category = Gold dim_category (number = category_key, tied to
-- answer_fact.cit_c<k>: rows are only imported, never added or removed here); kind layer = the classification layers
-- of dim_source.category_src (number = the code and its priority). Names, description and the category order change.
-- Each has an event table ({field: [before, after]}, the change_seq it went out in) and a publishing function that
-- records the list as a reference family (source hub_edit) when it changed, under the catalog lock, as 007 does.
CREATE TABLE catalog.source_seed (
    skey text PRIMARY KEY CHECK (skey = lower(skey) AND skey = btrim(skey) AND skey !~ '^www\.' AND skey !~ '/'
                                AND skey !~ '[[:space:][:cntrl:]]' AND length(skey) BETWEEN 3 AND 300 AND skey ~ '\.'),
    category text NOT NULL CHECK (category ~ '^[a-z][A-Za-z0-9]{0,63}$'),
    note text CHECK (length(note) <= 500),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
    origin text NOT NULL CHECK (origin IN ('file_import','hub')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
);
CREATE TABLE catalog.source_seed_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    skey text NOT NULL REFERENCES catalog.source_seed(skey),
    action text NOT NULL CHECK (action IN ('import','add','set','remove')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes)='object'),
    published_seq bigint,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_seed_event_key ON catalog.source_seed_event(skey,occurred_at);
CREATE INDEX source_seed_event_time ON catalog.source_seed_event(occurred_at);

CREATE TABLE catalog.source_social (
    account_key text PRIMARY KEY CHECK (account_key = lower(account_key) AND account_key ~ '^[^/]+\.[^/]+/.+'
                                       AND account_key !~ '^www\.' AND account_key !~ '[[:space:][:cntrl:]]'
                                       AND length(account_key) BETWEEN 5 AND 300),
    display_key text NOT NULL CHECK (lower(display_key) = account_key AND display_key = btrim(display_key)),
    domain text NOT NULL CHECK (domain = lower(domain) AND domain ~ '\.' AND domain !~ '/'),
    matchers jsonb NOT NULL CHECK (jsonb_typeof(matchers)='array' AND jsonb_array_length(matchers) BETWEEN 1 AND 10),
    note text CHECK (length(note) <= 500),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
    origin text NOT NULL CHECK (origin IN ('file_import','hub')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    CHECK (account_key LIKE domain || '/%')
);
CREATE TABLE catalog.source_social_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_key text NOT NULL REFERENCES catalog.source_social(account_key),
    action text NOT NULL CHECK (action IN ('import','add','set','stop','resume')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes)='object'),
    published_seq bigint,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_social_event_key ON catalog.source_social_event(account_key,occurred_at);
CREATE INDEX source_social_event_time ON catalog.source_social_event(occurred_at);

CREATE TABLE catalog.source_code (
    kind text NOT NULL CHECK (kind IN ('category','layer')),
    code text NOT NULL CHECK (code ~ '^[a-z][A-Za-z0-9]{0,63}$'),
    number smallint NOT NULL CHECK (number BETWEEN 1 AND 99),
    name_en text NOT NULL CHECK (name_en = btrim(name_en) AND length(name_en) BETWEEN 1 AND 80 AND name_en !~ '[[:cntrl:]]'),
    name_ko text NOT NULL CHECK (name_ko = btrim(name_ko) AND length(name_ko) BETWEEN 1 AND 80 AND name_ko !~ '[[:cntrl:]]'),
    ord smallint NOT NULL CHECK (ord BETWEEN 1 AND 99),
    description text CHECK (length(description) <= 500),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    PRIMARY KEY (kind, code),
    UNIQUE (kind, number),
    CONSTRAINT source_code_order UNIQUE (kind, ord) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE catalog.source_code_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL,
    code text NOT NULL,
    action text NOT NULL CHECK (action IN ('import','set','order')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes)='object'),
    published_seq bigint,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (kind, code) REFERENCES catalog.source_code(kind, code)
);
CREATE INDEX source_code_event_key ON catalog.source_code_event(kind,code,occurred_at);
CREATE INDEX source_code_event_time ON catalog.source_code_event(occurred_at);

-- The three families are the HUB's own (source hub_edit), recorded by their publishing functions only.
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_family_check;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_family_check CHECK (family IN ('surface','brand_bit','mention_type',
    'engine','region','country','language','taxon','brand','entity','source_category','source','owned_base','crawl_bot','keyword',
    'perspective','population','source_override','source_seed','source_social','source_code'));
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_hub_edit;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_hub_edit
    CHECK ((family IN ('source_override','source_seed','source_social','source_code')) = (source='hub_edit'));

CREATE OR REPLACE FUNCTION catalog.reference_set_hub_edit_writer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF NEW.source='hub_edit' AND current_user<>'hmg_analytics_owner' THEN
        RAISE EXCEPTION 'hub_edit sets are recorded by the catalog.publish_source_* functions only' USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

-- Record items as the next set of a hub_edit family when they differ from its current set (same digest: nothing).
-- Called by the publishing functions below (as the owner); nobody else can execute it.
CREATE FUNCTION catalog.publish_hub_edit(fam text, items jsonb) RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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

CREATE FUNCTION catalog.publish_source_seeds() RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT * FROM catalog.publish_hub_edit('source_seed', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',s.skey,'skey',s.skey,'category',s.category) ORDER BY s.skey),'[]'::jsonb)
        FROM catalog.source_seed s WHERE s.status='active'))
$$;
CREATE FUNCTION catalog.publish_source_socials() RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT * FROM catalog.publish_hub_edit('source_social', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',s.account_key,'skey',s.display_key,'domain',s.domain,
                                                     'category','officialHmg','matchers',s.matchers) ORDER BY s.account_key),'[]'::jsonb)
        FROM catalog.source_social s WHERE s.status='active'))
$$;
CREATE FUNCTION catalog.publish_source_codes() RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT * FROM catalog.publish_hub_edit('source_code', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',c.kind||':'||c.code,'kind',c.kind,'code',c.code,'number',c.number,
                                                     'name_en',c.name_en,'name_ko',c.name_ko,'ord',c.ord,'description',c.description)
                                  ORDER BY c.kind,c.number),'[]'::jsonb)
        FROM catalog.source_code c))
$$;
REVOKE ALL ON FUNCTION catalog.publish_hub_edit(text,jsonb),catalog.publish_source_seeds(),catalog.publish_source_socials(),
    catalog.publish_source_codes() FROM PUBLIC;

GRANT SELECT ON catalog.source_seed,catalog.source_seed_event,catalog.source_social,catalog.source_social_event,
    catalog.source_code,catalog.source_code_event TO hmg_analytics_reader;
-- The 인용 출처 분류 screen's role (007) also keeps these three lists, their history and their publishing functions.
-- No DELETE, no key or origin change, no new code-table row, no reference_set INSERT of its own.
GRANT SELECT,INSERT ON catalog.source_seed,catalog.source_social TO hmg_source_override_editor;
GRANT UPDATE(category,status,updated_at,updated_by) ON catalog.source_seed TO hmg_source_override_editor;
GRANT UPDATE(matchers,status,updated_at,updated_by) ON catalog.source_social TO hmg_source_override_editor;
GRANT SELECT ON catalog.source_code TO hmg_source_override_editor;
GRANT UPDATE(name_en,name_ko,ord,description,updated_at,updated_by) ON catalog.source_code TO hmg_source_override_editor;
GRANT SELECT,INSERT ON catalog.source_seed_event,catalog.source_social_event,catalog.source_code_event TO hmg_source_override_editor;
GRANT EXECUTE ON FUNCTION catalog.publish_source_seeds(),catalog.publish_source_socials(),catalog.publish_source_codes()
    TO hmg_source_override_editor;
COMMENT ON TABLE catalog.source_seed IS 'Curated source domains and their category, owned by the HUB (Admin › 인용 출처 분류); published as source_seed.';
COMMENT ON TABLE catalog.source_social IS 'Official HMG social accounts and their URL matchers, owned by the HUB; published as source_social.';
COMMENT ON TABLE catalog.source_code IS 'Source category and classification layer code table, owned by the HUB; published as source_code.';
