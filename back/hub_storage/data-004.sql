-- Incremental migration (2026-10-27): HUB editing of Global prompts.
-- A HUB edit is one more catalog.prompt_version row; recorded_by names the operations account that
-- recorded it (no cross-database FK). Gold imports keep it NULL.
ALTER TABLE catalog.prompt_version ADD COLUMN recorded_by uuid;
COMMENT ON COLUMN catalog.prompt_version.recorded_by IS 'HUB operations system.user_account.user_id that recorded a HUB edit; NULL for Gold imports.';

-- The API's editor role: prompt identities and revisions only. No project definitions, no export
-- policy, no UPDATE/DELETE (an archive is a new revision), so history stays append-only.
GRANT USAGE ON SCHEMA catalog TO hmg_catalog_editor;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO hmg_catalog_editor;
GRANT INSERT ON catalog.prompt,catalog.prompt_version TO hmg_catalog_editor;
