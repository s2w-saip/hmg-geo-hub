-- Incremental migration (2026-10-27): HUB login for the top-level administrator.
-- Accounts are registered by the management command (manage.py set-admin); the API only reads them.
CREATE TABLE system.global_role (
    user_id uuid PRIMARY KEY REFERENCES system.user_account,
    role text NOT NULL CHECK(role IN ('admin')),
    granted_at timestamptz NOT NULL DEFAULT now()
);
-- scrypt$N$r$p$salt$hash (back/bff/hub_stores/passwords.py). changed_at versions every login token.
CREATE TABLE system.user_credential (
    user_id uuid PRIMARY KEY REFERENCES system.user_account,
    password_hash text NOT NULL CHECK(password_hash LIKE 'scrypt$%'),
    changed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON system.global_role,system.user_credential TO hmg_operations_reader,hmg_operations_writer;
GRANT INSERT,DELETE ON system.global_role TO hmg_operations_writer;
GRANT INSERT,UPDATE ON system.user_credential TO hmg_operations_writer;
