-- Incremental migration (2026-11-05): hmg_account_editor holds only the columns bff/hub_stores/accounts.py reads and
-- writes (admin-todo F14). 004 granted whole tables: the role could read every password hash, rewrite when a role was
-- granted, move a role or password to another account, backdate an account or an audit event, and read the audit
-- history (the screen reads it with the operations reader). The password upsert sets the hash from its parameter, not
-- EXCLUDED, since reading EXCLUDED.password_hash needs SELECT on the hash.
REVOKE ALL ON system.user_account,system.global_role,system.user_credential,system.audit_event FROM hmg_account_editor;
GRANT SELECT(user_id,subject,display_name,email,status,created_at,last_sign_in_at),
      INSERT(user_id,subject,display_name,email),
      UPDATE(display_name,email,status,last_sign_in_at) ON system.user_account TO hmg_account_editor;
GRANT SELECT(user_id,must_change,changed_at),
      INSERT(user_id,password_hash,must_change),
      UPDATE(password_hash,must_change,changed_at) ON system.user_credential TO hmg_account_editor;
GRANT SELECT(user_id,role,brands,regions,countries,updated_at),
      INSERT(user_id,role,brands,regions,countries),
      UPDATE(role,brands,regions,countries,updated_at) ON system.global_role TO hmg_account_editor;
GRANT INSERT(actor_id,action,details) ON system.audit_event TO hmg_account_editor;
