BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('hmg_data_external','hmg_catalog_writer','hmg_analytics_reader','hmg_analytics_writer')) THEN RAISE EXCEPTION 'Data-store roles exist on private operations server'; END IF;
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
END $$;
ROLLBACK;
