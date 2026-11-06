-- T13 step 1f: who recorded a revision or an event, as it was then, in the input store. The operations DB belongs to the hub server alone and the data server builds a
-- history screen, so a history no longer looks the name up across databases. Written by the hub server with the row; earlier rows are filled once by manage.py from the
-- operations DB (backfill-actor-names). NULL when the row has no account (a Gold import, manage.py) or the account no longer exists.
ALTER TABLE catalog.prompt_version ADD COLUMN recorded_by_login text, ADD COLUMN recorded_by_name text;
COMMENT ON COLUMN catalog.prompt_version.recorded_by_login IS 'The account''s login when it recorded this revision (T13)';
COMMENT ON COLUMN catalog.prompt_version.recorded_by_name IS 'The account''s display name when it recorded this revision (T13)';
GRANT INSERT(recorded_by_login,recorded_by_name) ON catalog.prompt_version TO hmg_catalog_editor,hmg_project_editor;

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES ('source_override_event','hmg_source_override_editor'),('source_seed_event','hmg_source_override_editor'),
                                   ('source_social_event','hmg_source_override_editor'),('source_code_event','hmg_source_override_editor'),
                                   ('interest_keyword_event','hmg_interest_editor'),('interest_source_event','hmg_interest_editor'),
                                   ('entity_role_event','hmg_entity_role_editor'),('ga4_registry_event','hmg_ga4_registry_editor')) AS v(tab,editor)
    LOOP
        EXECUTE format('ALTER TABLE catalog.%I ADD COLUMN actor_login text, ADD COLUMN actor_name text', t.tab);
        EXECUTE format('COMMENT ON COLUMN catalog.%I.actor_login IS %L', t.tab, 'The account''s login when it made this change (T13)');
        EXECUTE format('COMMENT ON COLUMN catalog.%I.actor_name IS %L', t.tab, 'The account''s display name when it made this change (T13)');
        EXECUTE format('GRANT INSERT(actor_login,actor_name) ON catalog.%I TO %I', t.tab, t.editor);
    END LOOP;
END $$;
