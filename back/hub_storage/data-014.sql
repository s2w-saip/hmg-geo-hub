-- Incremental migration (2026-11-06): the inputs moved to the input store (hmg_input, input-001.sql), so nothing may write them here any
-- more. The catalog and publication tables stay as they were, read only, until T12 removes them; the moved copy is the source of truth.
-- The roles keep their names on the input server. catalog.service_week stays here with its job's role, and so do GA4, SEO and published.*.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON catalog.project,catalog.project_version,catalog.prompt,catalog.prompt_version,catalog.reference_set,
    catalog.reference_item,catalog.sync_run,catalog.source_override,catalog.source_override_event,catalog.source_seed,catalog.source_seed_event,
    catalog.source_social,catalog.source_social_event,catalog.source_code,catalog.source_code_event,catalog.interest_keyword,
    catalog.interest_keyword_event,catalog.interest_source,catalog.interest_source_event,catalog.entity_role,catalog.entity_role_event,
    publication.reference_access,publication.project_access,publication.api_client,publication.api_key,publication.api_client_project
    FROM hmg_catalog_writer,hmg_catalog_editor,hmg_project_editor,hmg_source_override_editor,hmg_interest_editor,hmg_entity_role_editor;
REVOKE CONNECT ON DATABASE hmg_analytics FROM hmg_catalog_writer,hmg_catalog_editor,hmg_project_editor,hmg_source_override_editor,
    hmg_interest_editor,hmg_entity_role_editor,hmg_ext_api;
COMMENT ON SCHEMA catalog IS 'Frozen since 2026-11-06: the inputs moved to hmg_input (back/hub_storage/input-001.sql). Only catalog.service_week is still written here.';
COMMENT ON SCHEMA publication IS 'Frozen since 2026-11-06: the API policy moved to hmg_input. published.* still reads this copy.';
