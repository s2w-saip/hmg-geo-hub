-- Incremental migration (2026-11-02): the entity roles the HUB owns, edited on the renewal Admin › 엔티티 카탈로그 screen
-- (back/bff/hub_stores/entity_roles.py). Decisions A and F (docs/handoff/admin-todo.md): who is own or excluded is decided
-- by people, so it is the HUB's; the entities themselves, their display brand and their numbers are Gold's and are only read.
--
-- catalog.entity_role: one role per Gold entity (entity_id; no key across the two databases, the BFF checks it against
-- Gold first). own carries its brand; excluded has none. Competitor is the default and is not stored: a row back to it is
-- status=cleared, the row and its history stay. rep_name is Gold's name when the role was set, for the history and the
-- external list. origin gold_import = Gold's registry_role (manage.py import-entity-roles), hub = set on the screen.
-- catalog.entity_role_event: every change as the screen shows it ({field: [before, after]}), with the change_seq of the
-- list it went out in. The active rows are published as the reference family entity_role (source hub_edit) through
-- catalog.publish_hub_edit (008) when they changed, under the catalog lock.
CREATE TABLE catalog.entity_role (
    entity_id uuid PRIMARY KEY,
    rep_name text NOT NULL CHECK (length(rep_name) BETWEEN 1 AND 300),
    role text NOT NULL CHECK (role IN ('own','excluded')),
    brand text CHECK (brand IN ('Hyundai','Kia','Genesis')),
    note text CHECK (length(note) <= 500),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cleared')),
    origin text NOT NULL CHECK (origin IN ('gold_import','hub')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    CHECK ((role='own') = (brand IS NOT NULL))
);
CREATE TABLE catalog.entity_role_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES catalog.entity_role(entity_id),
    action text NOT NULL CHECK (action IN ('import','set','clear')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes)='object'),
    published_seq bigint,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entity_role_event_key ON catalog.entity_role_event(entity_id,occurred_at);
CREATE INDEX entity_role_event_time ON catalog.entity_role_event(occurred_at);

-- The family is the HUB's own (source hub_edit), recorded by its publishing function only.
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_family_check;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_family_check CHECK (family IN ('surface','brand_bit','mention_type',
    'engine','region','country','language','taxon','brand','entity','source_category','source','owned_base','crawl_bot','keyword',
    'perspective','population','source_override','source_seed','source_social','source_code','interest_keyword','interest_source',
    'entity_role'));
ALTER TABLE catalog.reference_set DROP CONSTRAINT reference_set_hub_edit;
ALTER TABLE catalog.reference_set ADD CONSTRAINT reference_set_hub_edit
    CHECK ((family IN ('source_override','source_seed','source_social','source_code','interest_keyword','interest_source','entity_role')) = (source='hub_edit'));

CREATE FUNCTION catalog.publish_entity_roles() RETURNS TABLE(set_version integer, set_change_seq bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT * FROM catalog.publish_hub_edit('entity_role', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('key',r.entity_id::text,'entity_id',r.entity_id,'rep_name',r.rep_name,'role',r.role,
                                                     'brand',r.brand) ORDER BY r.entity_id),'[]'::jsonb)
        FROM catalog.entity_role r WHERE r.status='active'))
$$;
REVOKE ALL ON FUNCTION catalog.publish_entity_roles() FROM PUBLIC;

GRANT SELECT ON catalog.entity_role,catalog.entity_role_event TO hmg_analytics_reader;
-- The API's role for this screen: the roles, their history and their publishing function. No DELETE, no entity, name or
-- origin change, no other catalog table, no reference_set INSERT of its own.
GRANT USAGE ON SCHEMA catalog TO hmg_entity_role_editor;
GRANT SELECT,INSERT ON catalog.entity_role TO hmg_entity_role_editor;
GRANT UPDATE(role,brand,note,status,updated_at,updated_by) ON catalog.entity_role TO hmg_entity_role_editor;
GRANT SELECT,INSERT ON catalog.entity_role_event TO hmg_entity_role_editor;
GRANT EXECUTE ON FUNCTION catalog.publish_entity_roles() TO hmg_entity_role_editor;
COMMENT ON TABLE catalog.entity_role IS 'Entity roles (own with its brand, excluded), owned by the HUB (Admin › 엔티티 카탈로그); published as entity_role.';
