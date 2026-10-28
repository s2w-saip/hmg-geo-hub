BEGIN;
INSERT INTO catalog.project(project_id,origin) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1','hub');
INSERT INTO catalog.project_version(project_id,version,definition,sha256)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1',1,'{"name":"rollback-only permission fixture"}',repeat('a',64));
INSERT INTO catalog.prompt(prompt_id,project_id,origin)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2','ffffffff-ffff-4fff-8fff-fffffffffff1','hub');
INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2',1,'rollback-only','{}',repeat('a',64));
SET LOCAL ROLE hmg_data_external;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM published.projects WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1') THEN RAISE EXCEPTION 'Unapproved project exported'; END IF;
 IF EXISTS(SELECT 1 FROM published.prompts WHERE prompt_id='ffffffff-ffff-4fff-8fff-fffffffffff2') THEN RAISE EXCEPTION 'Unapproved prompt exported'; END IF;
 BEGIN PERFORM count(*) FROM catalog.project; RAISE EXCEPTION 'External role can read internal catalog'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM analytics.ga4_row; RAISE EXCEPTION 'External role can read base metrics'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM publication.project_access; RAISE EXCEPTION 'External role can read policy'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN CREATE TABLE published.forbidden(id int); RAISE EXCEPTION 'External role can create table'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
INSERT INTO publication.project_access(project_id,projects,approved_by)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1',true,'rollback-only test');
SET LOCAL ROLE hmg_data_external;
DO $$ BEGIN
 IF (SELECT count(*) FROM published.projects WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1')<>1 THEN RAISE EXCEPTION 'Approved project missing'; END IF;
 IF EXISTS(SELECT 1 FROM published.prompts WHERE prompt_id='ffffffff-ffff-4fff-8fff-fffffffffff2') THEN RAISE EXCEPTION 'Project approval leaked prompts'; END IF;
 IF has_table_privilege(current_user,'published.projects','UPDATE') OR has_table_privilege(current_user,'published.projects','INSERT') OR has_table_privilege(current_user,'published.projects','DELETE') THEN RAISE EXCEPTION 'External role has export write grants'; END IF;
 BEGIN INSERT INTO catalog.project(project_id,origin) VALUES(gen_random_uuid(),'hub'); RAISE EXCEPTION 'External role can write catalog'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
UPDATE publication.project_access SET prompts=true WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1';
SET LOCAL ROLE hmg_data_external;
DO $$ BEGIN
 IF (SELECT count(*) FROM published.prompts WHERE prompt_id='ffffffff-ffff-4fff-8fff-fffffffffff2')<>1 THEN RAISE EXCEPTION 'Approved prompt missing'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_catalog_writer;
DO $$ BEGIN
 BEGIN UPDATE catalog.prompt_version SET text='changed'; RAISE EXCEPTION 'Writer can mutate history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.project; RAISE EXCEPTION 'Writer can delete stable IDs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE publication.project_access SET ga4=true; RAISE EXCEPTION 'Writer can approve exports'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF has_schema_privilege('hmg_analytics_writer','catalog','CREATE') OR has_table_privilege('hmg_analytics_writer','catalog.project','INSERT') THEN RAISE EXCEPTION 'Metric collector can mutate catalog'; END IF;
 IF has_database_privilege('hmg_data_external','postgres','CONNECT') THEN RAISE EXCEPTION 'External role has default DB access'; END IF;
 BEGIN INSERT INTO catalog.prompt(prompt_id,project_id,origin) VALUES(gen_random_uuid(),gen_random_uuid(),'hub'); RAISE EXCEPTION 'Orphan prompt allowed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
-- The API's Global prompt editor (004): appends prompt revisions, nothing else.
SET LOCAL ROLE hmg_catalog_editor;
INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256,recorded_by)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2',2,'rollback-only edit','{"status":"archived"}',repeat('b',64),gen_random_uuid());
DO $$ BEGIN
 BEGIN UPDATE catalog.prompt_version SET text='changed'; RAISE EXCEPTION 'Editor can mutate history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.prompt; RAISE EXCEPTION 'Editor can delete stable IDs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.project(project_id,origin) VALUES(gen_random_uuid(),'hub'); RAISE EXCEPTION 'Editor can create projects'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE publication.project_access SET prompts=true; RAISE EXCEPTION 'Editor can approve exports'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM analytics.ga4_row; RAISE EXCEPTION 'Editor can read metrics'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
-- External API (005): ext answers one caller, only what is granted and approved; writers never set change_seq.
INSERT INTO catalog.project(project_id,origin) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff3','hub');
INSERT INTO catalog.project_version(project_id,version,definition,sha256)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff3',1,'{"site_id":"internal"}',repeat('c',64));
INSERT INTO publication.project_access(project_id,projects,prompts,approved_by)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff3',true,true,'rollback-only test');
INSERT INTO publication.api_client(client_id,name,created_by) VALUES
 ('ffffffff-ffff-4fff-8fff-fffffffffffa','rollback-only A','test'),('ffffffff-ffff-4fff-8fff-fffffffffffb','rollback-only B','test');
INSERT INTO publication.api_key(key_id,client_id,key_hash,created_by,created_at,expires_at) VALUES
 ('ffffffff-ffff-4fff-8fff-ffffffffffa1','ffffffff-ffff-4fff-8fff-fffffffffffa',repeat('1',64),'test',now(),now()+interval '1 day'),
 ('ffffffff-ffff-4fff-8fff-ffffffffffb1','ffffffff-ffff-4fff-8fff-fffffffffffb',repeat('2',64),'test',now(),now()+interval '1 day'),
 ('ffffffff-ffff-4fff-8fff-ffffffffffa2','ffffffff-ffff-4fff-8fff-fffffffffffa',repeat('3',64),'test',now()-interval '2 days',now()-interval '1 day');
INSERT INTO publication.api_client_project(client_id,project_id,granted_by) VALUES
 ('ffffffff-ffff-4fff-8fff-fffffffffffa','ffffffff-ffff-4fff-8fff-fffffffffff1','test'),
 ('ffffffff-ffff-4fff-8fff-fffffffffffb','ffffffff-ffff-4fff-8fff-fffffffffff3','test');
INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
VALUES('ffffffff-ffff-4fff-8fff-ffffffffffc1','engine',2147483647,1,repeat('d',64),'gold');
INSERT INTO catalog.reference_item(set_id,item_key,definition) VALUES('ffffffff-ffff-4fff-8fff-ffffffffffc1','rollback-only','{"code":"rollback-only"}');
-- The real database may already approve families; this transaction withdraws engine first.
INSERT INTO publication.reference_access(family,enabled,approved_by) VALUES('engine',false,'rollback-only test')
 ON CONFLICT(family) DO UPDATE SET enabled=false;
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ext.caller) OR EXISTS(SELECT 1 FROM ext.projects) OR EXISTS(SELECT 1 FROM ext.reference_sets) THEN RAISE EXCEPTION 'ext answers without a key'; END IF;
 PERFORM set_config('hgh.key_hash','',true);
 IF EXISTS(SELECT 1 FROM ext.meta) THEN RAISE EXCEPTION 'ext answers an empty key'; END IF;
 PERFORM set_config('hgh.key_hash',repeat('3',64),true);
 IF EXISTS(SELECT 1 FROM ext.caller) THEN RAISE EXCEPTION 'An expired key is accepted'; END IF;
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF (SELECT count(*) FROM ext.projects WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1')<>1 THEN RAISE EXCEPTION 'Granted project missing'; END IF;
 IF EXISTS(SELECT 1 FROM ext.projects WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff3') THEN RAISE EXCEPTION 'Another caller''s project is visible'; END IF;
 IF (SELECT text FROM ext.prompts WHERE prompt_id='ffffffff-ffff-4fff-8fff-fffffffffff2') IS NOT NULL THEN RAISE EXCEPTION 'An archived prompt exports its text'; END IF;
 IF EXISTS(SELECT 1 FROM ext.reference_items WHERE family='engine' AND item_key='rollback-only') THEN RAISE EXCEPTION 'Unapproved family exported'; END IF;
 BEGIN PERFORM count(*) FROM publication.api_key; RAISE EXCEPTION 'ext role reads keys'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM catalog.prompt; RAISE EXCEPTION 'ext role reads the catalog'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM published.projects; RAISE EXCEPTION 'ext role reads the unscoped exports'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('hgh.key_hash',repeat('2',64),true);
 IF (SELECT definition FROM ext.projects WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff3') ? 'site_id' THEN RAISE EXCEPTION 'Internal Gold ids exported'; END IF;
END $$;
RESET ROLE;
INSERT INTO publication.reference_access(family,enabled,approved_by) VALUES('engine',true,'rollback-only test')
 ON CONFLICT(family) DO UPDATE SET enabled=true;
DO $$ DECLARE before bigint; BEGIN
 before := (SELECT access_seq FROM publication.project_access WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1');
 UPDATE publication.project_access SET prompts=false WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1';
 IF (SELECT access_seq FROM publication.project_access WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1')<=before THEN RAISE EXCEPTION 'An approval change keeps its change_seq'; END IF;
 IF (SELECT seqcache FROM pg_sequence WHERE seqrelid='catalog.change_seq'::regclass)<>1 THEN RAISE EXCEPTION 'change_seq is cached per session'; END IF;
 IF EXISTS(SELECT 1 FROM publication.api_key WHERE revoked_at IS NULL AND expires_at>now() GROUP BY client_id HAVING count(*)>2) THEN RAISE EXCEPTION 'A client has more than two valid keys'; END IF;
END $$;
UPDATE publication.api_client SET status='disabled' WHERE client_id='ffffffff-ffff-4fff-8fff-fffffffffffb';
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF NOT EXISTS(SELECT 1 FROM ext.reference_items WHERE family='engine' AND item_key='rollback-only') THEN RAISE EXCEPTION 'Approved family missing'; END IF;
 IF EXISTS(SELECT 1 FROM ext.prompts WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1') THEN RAISE EXCEPTION 'Withdrawn prompts approval still exports'; END IF;
 PERFORM set_config('hgh.key_hash',repeat('2',64),true);
 IF EXISTS(SELECT 1 FROM ext.caller) THEN RAISE EXCEPTION 'A disabled client is accepted'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_data_external;
DO $$ BEGIN
 BEGIN PERFORM count(*) FROM ext.caller; RAISE EXCEPTION 'The DB export role reads the API contract'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_catalog_writer;
DO $$ BEGIN
 BEGIN INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256,change_seq)
   VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2',9,'x','{}',repeat('e',64),1); RAISE EXCEPTION 'Writer sets change_seq'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE publication.api_client_project SET revoked_at=now(); RAISE EXCEPTION 'Writer changes grants'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE publication.reference_access SET enabled=true; RAISE EXCEPTION 'Writer approves families'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_catalog_editor;
DO $$ BEGIN
 BEGIN INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256,change_seq)
   VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2',9,'x','{}',repeat('e',64),1); RAISE EXCEPTION 'Editor sets change_seq'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM publication.api_key; RAISE EXCEPTION 'Editor reads keys'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
