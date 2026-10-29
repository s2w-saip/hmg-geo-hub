BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('hmg_data_external','hmg_catalog_writer','hmg_catalog_editor','hmg_analytics_reader','hmg_analytics_writer')) THEN RAISE EXCEPTION 'Data-store roles exist on private operations server'; END IF;
 IF EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
           WHERE d.datname='hmg_operations' AND a.grantee=0 AND a.privilege_type='CONNECT') THEN RAISE EXCEPTION 'Public operations access'; END IF;
END $$;
INSERT INTO system.project_reference VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1',now());
SET LOCAL ROLE hmg_operations_writer;
INSERT INTO system.project_setting_version(project_id,version,settings)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1',1,'{"fixture":"rollback-only"}');
INSERT INTO system.audit_event(project_id,action) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1','rollback-only');
DO $$ BEGIN
 BEGIN UPDATE system.project_setting_version SET settings='{}'; RAISE EXCEPTION 'Settings history mutable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM system.audit_event; RAISE EXCEPTION 'Audit history deletable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN CREATE TABLE system.forbidden(id int); RAISE EXCEPTION 'Writer can create schema objects'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO system.project_member VALUES(gen_random_uuid(),gen_random_uuid(),'viewer',now()); RAISE EXCEPTION 'Orphan membership allowed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_operations_reader;
DO $$ BEGIN
 BEGIN DELETE FROM system.user_account; RAISE EXCEPTION 'Reader can delete users'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE system.user_credential SET password_hash='scrypt$x'; RAISE EXCEPTION 'Reader can change passwords'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO system.global_role VALUES(gen_random_uuid(),'admin',now()); RAISE EXCEPTION 'Reader can grant roles'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM system.saved_filter; RAISE EXCEPTION 'Reader can delete saved filters'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
-- Saved filters: the API's role writes system.saved_filter and nothing else; one default per account and page.
INSERT INTO system.user_account(user_id,subject) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2','rollback-only saved filter fixture');
SET LOCAL ROLE hmg_saved_filter_editor;
INSERT INTO system.saved_filter(filter_id,user_id,page,name,query,is_default,position)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff3','ffffffff-ffff-4fff-8fff-fffffffffff2','overview','rollback-only','brand=x',true,0);
UPDATE system.saved_filter SET name='renamed',is_default=false WHERE filter_id='ffffffff-ffff-4fff-8fff-fffffffffff3';
UPDATE system.saved_filter SET is_default=true WHERE filter_id='ffffffff-ffff-4fff-8fff-fffffffffff3';
DO $$ BEGIN
 BEGIN INSERT INTO system.saved_filter(filter_id,user_id,page,name,query,is_default,position)
       VALUES(gen_random_uuid(),'ffffffff-ffff-4fff-8fff-fffffffffff2','overview','second default','',true,1);
       RAISE EXCEPTION 'Two default saved filters'; EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN INSERT INTO system.saved_filter(filter_id,user_id,page,name,query,position) VALUES(gen_random_uuid(),gen_random_uuid(),'overview','orphan','',0);
       RAISE EXCEPTION 'Orphan saved filter allowed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN INSERT INTO system.saved_filter(filter_id,user_id,page,name,query,position) VALUES(gen_random_uuid(),'ffffffff-ffff-4fff-8fff-fffffffffff2','overview','','',2);
       RAISE EXCEPTION 'Empty saved filter name allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM 1 FROM system.user_account; RAISE EXCEPTION 'Saved filter role reads accounts'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM system.user_credential; RAISE EXCEPTION 'Saved filter role reads credentials'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM system.global_role; RAISE EXCEPTION 'Saved filter role revokes roles'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO system.audit_event(action) VALUES('rollback-only'); RAISE EXCEPTION 'Saved filter role writes audit'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN CREATE TABLE system.forbidden(id int); RAISE EXCEPTION 'Saved filter role can create schema objects'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
DELETE FROM system.saved_filter WHERE filter_id='ffffffff-ffff-4fff-8fff-fffffffffff3';
-- Accounts: the API's role writes the account tables and nothing else; a role's scope keeps its shape.
SET LOCAL ROLE hmg_account_editor;
INSERT INTO system.user_account(user_id,subject) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff4','rollback-only account fixture');
INSERT INTO system.user_credential(user_id,password_hash,must_change) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff4','scrypt$rollback-only',true);
INSERT INTO system.global_role(user_id,role,brands) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff4','hq','{Genesis}');
UPDATE system.global_role SET role='region',regions='{genesis-asia-pacific}',updated_at=now() WHERE user_id='ffffffff-ffff-4fff-8fff-fffffffffff4';
UPDATE system.user_credential SET password_hash='scrypt$rollback-only-2',must_change=false,changed_at=now() WHERE user_id='ffffffff-ffff-4fff-8fff-fffffffffff4';
UPDATE system.user_account SET status='disabled',display_name='rollback-only',last_sign_in_at=now() WHERE user_id='ffffffff-ffff-4fff-8fff-fffffffffff4';
INSERT INTO system.audit_event(action,details) VALUES('account.rollback-only','{"user_id":"ffffffff-ffff-4fff-8fff-fffffffffff4"}');
DO $$ BEGIN
 BEGIN UPDATE system.global_role SET regions='{}' WHERE user_id='ffffffff-ffff-4fff-8fff-fffffffffff4';
       RAISE EXCEPTION 'Region account without a region'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE system.global_role SET role='admin' WHERE user_id='ffffffff-ffff-4fff-8fff-fffffffffff4';
       RAISE EXCEPTION 'Administrator with a narrowed scope'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO system.global_role(user_id,role) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff4','viewer');
       RAISE EXCEPTION 'Unknown role allowed'; EXCEPTION WHEN unique_violation OR check_violation THEN NULL; END;
 BEGIN INSERT INTO system.user_account(user_id,subject) VALUES(gen_random_uuid(),'ROLLBACK-ONLY ACCOUNT FIXTURE');
       RAISE EXCEPTION 'Login IDs differing in case only'; EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN UPDATE system.user_account SET subject='renamed' WHERE user_id='ffffffff-ffff-4fff-8fff-fffffffffff4';
       RAISE EXCEPTION 'Account role renames login IDs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM system.user_account; RAISE EXCEPTION 'Account role deletes accounts'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM system.global_role; RAISE EXCEPTION 'Account role deletes roles'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE system.audit_event SET action='x'; RAISE EXCEPTION 'Account role rewrites audit'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM system.audit_event; RAISE EXCEPTION 'Account role deletes audit'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM system.saved_filter; RAISE EXCEPTION 'Account role reads saved filters'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM system.project_member; RAISE EXCEPTION 'Account role reads memberships'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN CREATE TABLE system.forbidden(id int); RAISE EXCEPTION 'Account role can create schema objects'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
