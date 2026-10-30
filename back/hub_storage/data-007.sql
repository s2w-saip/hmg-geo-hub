-- Incremental migration (2026-10-30): source category corrections owned by the HUB, edited on the renewal Admin ›
-- 인용 출처 분류 screen (back/bff/hub_stores/source_overrides.py). The HUB keeps only what people decide (the
-- override layer); Gold keeps the automatic classification and the social / seed lists, and the HUB reads them.
--
-- catalog.source_override: one row per source key (Gold dim_source.skey, lower case, no leading www.), the
-- category slug (gold.dim_category.slug) and active | cleared. A correction is never deleted: a revert is
-- status=cleared, so the key and its history stay. origin gold_import = taken once from Gold
-- (manage.py import-source-overrides), hub = set on the screen.
-- catalog.source_override_event: every change as the screen shows it ({field: [before, after]}), with the
-- change_seq of the upstream list it went out in.
-- The upstream list: catalog.publish_source_overrides() records every active correction as the reference family
-- `source_override` (source hub_edit) whenever the list changed, so the external API serves it with change_seq and
-- etag like the Gold families. hub_edit is not part of ext.meta.hub_reference (source='hub' only): an edit does not
-- change contract_version, and the family needs a reference approval like the Gold ones.
CREATE TABLE catalog.source_override (
    skey text PRIMARY KEY CHECK (skey = lower(skey) AND skey = btrim(skey) AND skey !~ '^www\.'
                                AND skey !~ '[[:space:][:cntrl:]]' AND length(skey) BETWEEN 3 AND 300 AND skey ~ '\.'),
    category text NOT NULL CHECK (category ~ '^[a-z][A-Za-z0-9]{0,63}$'),
    note text CHECK (length(note) <= 500),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cleared')),
    origin text NOT NULL CHECK (origin IN ('gold_import','hub')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
);
-- actor_id is the operations DB system.user_account.user_id (no key across the two databases); NULL = manage.py.
CREATE TABLE catalog.source_override_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    skey text NOT NULL REFERENCES catalog.source_override(skey),
    action text NOT NULL CHECK (action IN ('import','set','clear')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes)='object'),
    published_seq bigint,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_override_event_skey ON catalog.source_override_event(skey,occurred_at);
CREATE INDEX source_override_event_time ON catalog.source_override_event(occurred_at);

-- The reference family of the HUB corrections. Only its own function records it (the trigger below).
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_family_check;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_family_check CHECK (family IN ('surface','brand_bit','mention_type',
    'engine','region','country','language','taxon','brand','entity','source_category','source','owned_base','crawl_bot','keyword',
    'perspective','population','source_override'));
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_source_check;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_source_check CHECK (source IN ('gold','hub','hub_edit'));
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_hub_edit CHECK ((family='source_override') = (source='hub_edit'));

CREATE FUNCTION catalog.reference_set_hub_edit_writer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF NEW.source='hub_edit' AND current_user<>'hmg_analytics_owner' THEN
        RAISE EXCEPTION 'hub_edit sets are recorded by catalog.publish_source_overrides() only' USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER reference_set_hub_edit_writer BEFORE INSERT ON catalog.reference_set
    FOR EACH ROW EXECUTE FUNCTION catalog.reference_set_hub_edit_writer();

-- Record the active corrections as the next `source_override` set when they differ from the current one (same
-- digest: nothing). Under the catalog lock (617427413), so change_seq order is commit order across catalog writers.
-- Returns the new set's version and change_seq, or no row when the list did not change.
CREATE FUNCTION catalog.publish_source_overrides() RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
REVOKE ALL ON FUNCTION catalog.publish_source_overrides(),catalog.reference_set_hub_edit_writer() FROM PUBLIC;

GRANT SELECT ON catalog.source_override,catalog.source_override_event TO hmg_analytics_reader;
-- The API's correction role: the corrections, their history and the function that publishes them. No DELETE, no new
-- key for an existing row, no other catalog table, no reference_set INSERT of its own.
GRANT USAGE ON SCHEMA catalog TO hmg_source_override_editor;
GRANT SELECT,INSERT ON catalog.source_override TO hmg_source_override_editor;
GRANT UPDATE(category,status,updated_at,updated_by) ON catalog.source_override TO hmg_source_override_editor;
GRANT SELECT,INSERT ON catalog.source_override_event TO hmg_source_override_editor;
GRANT EXECUTE ON FUNCTION catalog.publish_source_overrides() TO hmg_source_override_editor;
COMMENT ON TABLE catalog.source_override IS 'Source category corrections owned by the HUB (Admin › 인용 출처 분류); published as the reference family source_override.';
