CREATE SCHEMA system AUTHORIZATION hmg_operations_owner;
REVOKE ALL ON SCHEMA public,system FROM PUBLIC;
CREATE TABLE system.schema_migration (
    version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE system.user_account (
    user_id uuid PRIMARY KEY,
    subject text NOT NULL UNIQUE,
    display_name text,
    email text,
    status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    created_at timestamptz NOT NULL DEFAULT now()
);
-- Cross-database FK is enforced by the HUB service/importer against catalog.project.
-- Catalog identity is append-only for service roles; archive in a new revision.
CREATE TABLE system.project_reference (
    project_id uuid PRIMARY KEY,
    validated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE system.project_member (
    project_id uuid NOT NULL REFERENCES system.project_reference,
    user_id uuid NOT NULL REFERENCES system.user_account,
    role text NOT NULL CHECK(role IN ('owner','editor','viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,user_id)
);
CREATE TABLE system.project_setting_version (
    project_id uuid NOT NULL REFERENCES system.project_reference,
    version integer NOT NULL CHECK(version>0),
    settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
    changed_by uuid REFERENCES system.user_account,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,version)
);
CREATE VIEW system.current_project_setting AS
    SELECT DISTINCT ON(project_id) * FROM system.project_setting_version ORDER BY project_id,version DESC;
CREATE TABLE system.integration (
    integration_id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES system.project_reference,
    provider text NOT NULL CHECK(provider IN ('ga4','seo','gold')),
    config jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(config)='object'),
    credential_ref text,
    enabled boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id,provider)
);
CREATE TABLE system.audit_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id uuid REFERENCES system.user_account,
    project_id uuid REFERENCES system.project_reference,
    action text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
    occurred_at timestamptz NOT NULL DEFAULT now()
);
GRANT USAGE ON SCHEMA system TO hmg_operations_reader,hmg_operations_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA system TO hmg_operations_reader,hmg_operations_writer;
GRANT INSERT,UPDATE ON system.user_account,system.project_member,system.integration TO hmg_operations_writer;
GRANT DELETE ON system.project_member TO hmg_operations_writer;
GRANT INSERT ON system.project_reference,system.project_setting_version,system.audit_event TO hmg_operations_writer;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA system TO hmg_operations_writer;
COMMENT ON TABLE system.project_reference IS 'Only stable UUIDs validated against data DB catalog.project. Never use Gold/local integer keys across databases.';
COMMENT ON TABLE system.integration IS 'Private operational connection settings. credential_ref points to secret storage; do not put credential values in config.';
COMMENT ON TABLE system.project_setting_version IS 'Append-only software settings. Pin this version and prompt_version in future collection execution records.';
