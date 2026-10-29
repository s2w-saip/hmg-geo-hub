-- Incremental migration (2026-10-29): HUB accounts for the four internal roles, managed on the renewal
-- Admin › 사용자 관리 screen. global_role becomes the account's role and data scope (front lib/auth/scope-policy):
--   admin    every brand, region and country (no scope values)
--   hq       its brands, every region and country
--   region   its brands and RHQ regions, every country of those regions
--   country  its brands, RHQ regions and countries
-- An account without a role cannot sign in. Brands are HMG brand names (Hyundai · Kia · Genesis), regions the RHQ ids
-- of front/lib/rhq (back/bff/screens/_query.py RHQ_REGION_COUNTRIES), countries ISO codes: the API checks the values,
-- the table their shape. The API writes accounts with hmg_account_editor, which can touch the account tables only.
ALTER TABLE system.global_role DROP CONSTRAINT global_role_role_check;
ALTER TABLE system.global_role
    ADD CONSTRAINT global_role_role_check CHECK(role IN ('admin','hq','region','country')),
    ADD COLUMN brands text[] NOT NULL DEFAULT '{}',
    ADD COLUMN regions text[] NOT NULL DEFAULT '{}',
    ADD COLUMN countries text[] NOT NULL DEFAULT '{}',
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT global_role_scope CHECK(CASE role
        WHEN 'admin' THEN brands='{}' AND regions='{}' AND countries='{}'
        WHEN 'hq' THEN cardinality(brands)>0 AND regions='{}' AND countries='{}'
        WHEN 'region' THEN cardinality(brands)>0 AND cardinality(regions)>0 AND countries='{}'
        ELSE cardinality(brands)>0 AND cardinality(regions)>0 AND cardinality(countries)>0 END);
-- A password the administrator issued (new account, reset) is replaced at the next sign-in before any page opens.
ALTER TABLE system.user_credential ADD COLUMN must_change boolean NOT NULL DEFAULT false;
ALTER TABLE system.user_account ADD COLUMN last_sign_in_at timestamptz;
-- One login ID per person whatever its case (sign-in compares IDs without case).
CREATE UNIQUE INDEX user_account_subject_ci ON system.user_account(lower(subject));
-- An account's own history on the Admin screen (details->>'user_id' = the account the event changed).
CREATE INDEX audit_event_account ON system.audit_event((details->>'user_id'),occurred_at) WHERE action LIKE 'account.%';
GRANT USAGE ON SCHEMA system TO hmg_account_editor;
GRANT SELECT ON system.user_account,system.global_role,system.user_credential,system.audit_event TO hmg_account_editor;
GRANT INSERT,UPDATE(display_name,email,status,last_sign_in_at) ON system.user_account TO hmg_account_editor;
GRANT INSERT,UPDATE ON system.global_role,system.user_credential TO hmg_account_editor;
GRANT INSERT ON system.audit_event TO hmg_account_editor;
COMMENT ON TABLE system.global_role IS 'The account''s HUB role and data scope (brands, RHQ regions, countries). No row = no sign-in.';
COMMENT ON COLUMN system.user_credential.must_change IS 'An administrator issued this password; the account sets its own before any page opens.';
