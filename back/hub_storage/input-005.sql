-- T6.3 (2026-11-07): the administrator adds a project on the hub server, now that the Gold import no longer starts any (T10.1). The project editor writes
-- the project, its first version and its first measurement settings in one transaction; the guard holds it to the project surface.
CREATE OR REPLACE FUNCTION catalog.project_editor_guard() RETURNS trigger
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
        -- a new project's first version is the only row that names its own surface
        IF TG_TABLE_NAME<>'project_version' THEN
            RAISE EXCEPTION 'The project editor writes project-surface catalogs only' USING ERRCODE='insufficient_privilege';
        ELSIF NEW.version<>1 OR NEW.definition->>'surface' IS DISTINCT FROM '3' THEN
            RAISE EXCEPTION 'The project editor writes project-surface catalogs only' USING ERRCODE='insufficient_privilege';
        END IF;
    END IF;
    IF TG_TABLE_NAME<>'prompt' THEN
        IF NEW.recorded_by IS NULL THEN
            RAISE EXCEPTION 'A HUB revision names its account (recorded_by)' USING ERRCODE='not_null_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER project_editor_measurement BEFORE INSERT ON catalog.project_measurement_version FOR EACH ROW EXECUTE FUNCTION catalog.project_editor_guard();

GRANT INSERT(project_id,origin) ON TABLE catalog.project TO hmg_project_editor;
GRANT SELECT ON catalog.project_measurement_version,catalog.current_measurement,catalog.reference_source TO hmg_project_editor;
GRANT INSERT(project_id,version,brands,countries,engines,cadence,acr_repeats,web_units,owned_urls,tracked_urls,tracked_targets,origin,sha256,recorded_by)
    ON catalog.project_measurement_version TO hmg_project_editor;
