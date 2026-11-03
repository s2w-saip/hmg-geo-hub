-- Incremental migration (2026-11-03): project prompts and custom tags owned by the HUB, edited on the renewal Project › Prompt
-- screen (back/bff/hub_stores/project_prompts.py). Decisions A and '프로젝트 프롬프트 적재' (docs/handoff/admin-todo.md): what people
-- decide a project measures is the HUB's; Gold only holds its projection (dim_prompt, dim_custom_field and prompt_custom_value are
-- described as projections of the GEO HUB settings) and the HUB reads it next to its own values.
--
-- No new table: a project's prompts already live in catalog.prompt / prompt_version (one row per prompt, one revision per change,
-- change_seq order, exported by ext.prompts) and its custom tags in the project definition (custom_fields) and in each prompt's
-- definition (custom_values), where the Gold import recorded them first. A HUB edit is one more revision with recorded_by set:
-- - prompt statuses: draft (added in the HUB, not sent for measurement), active, paused (measurement stop asked), archived
--   (deleted; restorable), removed (a Gold prompt that left Gold). ext.prompts carries the text of active prompts only.
-- - Once a revision of a prompt or project has recorded_by, the HUB owns its HUB keys (sync_catalog.py PROMPT_HUB_KEYS /
--   PROJECT_HUB_KEYS): the Gold import keeps them as the HUB recorded them and still records Gold's own keys. The import never
--   removes a HUB-owned prompt; its status is the HUB's.
ALTER TABLE catalog.project_version ADD COLUMN recorded_by uuid;
COMMENT ON COLUMN catalog.project_version.recorded_by IS 'HUB operations system.user_account.user_id that recorded a HUB edit; NULL for Gold imports.';
CREATE INDEX prompt_version_hub ON catalog.prompt_version(prompt_id) WHERE recorded_by IS NOT NULL;
CREATE INDEX project_version_hub ON catalog.project_version(project_id) WHERE recorded_by IS NOT NULL;

-- The project editor writes the catalogs of project-surface (3) projects only, and every revision it writes names its account.
CREATE FUNCTION catalog.project_editor_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
REVOKE ALL ON FUNCTION catalog.project_editor_guard() FROM PUBLIC;
CREATE TRIGGER project_editor_prompt BEFORE INSERT ON catalog.prompt FOR EACH ROW EXECUTE FUNCTION catalog.project_editor_guard();
CREATE TRIGGER project_editor_prompt_version BEFORE INSERT ON catalog.prompt_version FOR EACH ROW EXECUTE FUNCTION catalog.project_editor_guard();
CREATE TRIGGER project_editor_project_version BEFORE INSERT ON catalog.project_version FOR EACH ROW EXECUTE FUNCTION catalog.project_editor_guard();

-- The API's role for this screen: new prompt identities, prompt and project revisions. No UPDATE or DELETE (history stays
-- append-only, a delete is a revision), no new project, no export policy, no change_seq of its own, no other catalog table.
GRANT USAGE ON SCHEMA catalog TO hmg_project_editor;
GRANT SELECT ON catalog.project,catalog.project_version,catalog.prompt,catalog.prompt_version,catalog.current_project,
    catalog.current_prompt,catalog.current_reference TO hmg_project_editor;
GRANT INSERT ON catalog.prompt TO hmg_project_editor;
GRANT INSERT(prompt_id,version,text,definition,sha256,recorded_by) ON catalog.prompt_version TO hmg_project_editor;
GRANT INSERT(project_id,version,definition,sha256,recorded_by) ON catalog.project_version TO hmg_project_editor;
GRANT USAGE ON SEQUENCE catalog.change_seq TO hmg_project_editor;
COMMENT ON FUNCTION catalog.project_editor_guard() IS 'hmg_project_editor writes project-surface (3) catalogs only, each revision with recorded_by.';
