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
-- GA4 registry: the API's role writes the registry and its history only; the collector reads it and notes its runs.
SET LOCAL ROLE hmg_ga4_registry_editor;
INSERT INTO analytics.ga4_registry(property_id,brand,country,conv_basis) VALUES('900000000001','Kia','IT',1);
INSERT INTO analytics.ga4_registry(property_id,brand,country,conv_basis,conv_events) VALUES('900000000002','Hyundai','DE',2,'{generate_lead}');
UPDATE analytics.ga4_registry SET conv_basis=2,conv_events='{test_drive}',enabled=false,updated_at=now() WHERE property_id='900000000001';
INSERT INTO analytics.ga4_registry_event(property_id,action,changes) VALUES('900000000001','update','{"enabled":[true,false]}');
DO $$ BEGIN
 BEGIN INSERT INTO analytics.ga4_registry(property_id,brand,country,conv_basis) VALUES('900000000003','Hyundai','DE',1);
       RAISE EXCEPTION 'Two collected properties in one market'; EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN INSERT INTO analytics.ga4_registry(property_id,brand,country,conv_basis) VALUES('G-123','Kia','IT',1);
       RAISE EXCEPTION 'A non-numeric property id'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO analytics.ga4_registry(property_id,brand,country,conv_basis) VALUES('900000000004','Kia','it',1);
       RAISE EXCEPTION 'A lower-case country'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO analytics.ga4_registry(property_id,brand,country,conv_basis) VALUES('900000000004','HMG','IT',1);
       RAISE EXCEPTION 'An unknown brand'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO analytics.ga4_registry(property_id,brand,country,conv_basis) VALUES('900000000004','Kia','FR',2);
       RAISE EXCEPTION 'Listed events without an event'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO analytics.ga4_registry(property_id,brand,country,conv_basis,conv_events) VALUES('900000000004','Kia','FR',1,'{x}');
       RAISE EXCEPTION 'Events under the key events basis'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE analytics.ga4_registry SET property_id='900000000009' WHERE property_id='900000000002';
       RAISE EXCEPTION 'Registry role changes a property id'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM analytics.ga4_registry; RAISE EXCEPTION 'Registry role deletes properties'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE analytics.ga4_registry_event SET action='create'; RAISE EXCEPTION 'Registry role rewrites history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM analytics.ga4_registry_event; RAISE EXCEPTION 'Registry role deletes history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO analytics.ga4_collect_status(property_id,checked_at,status) VALUES('900000000001',now(),'collected');
       RAISE EXCEPTION 'Registry role writes collector results'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM analytics.ga4_row; RAISE EXCEPTION 'Registry role reads GA4 rows'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM analytics.ga4_property; RAISE EXCEPTION 'Registry role reads collected properties'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.prompt; RAISE EXCEPTION 'Registry role reads the catalog'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN CREATE TABLE analytics.forbidden(id int); RAISE EXCEPTION 'Registry role can create schema objects'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_analytics_writer;
INSERT INTO analytics.ga4_collect_status(property_id,checked_at,status,collected_at,collected_to) VALUES('900000000002',now(),'collected',now(),current_date-1);
UPDATE analytics.ga4_collect_status SET status='failed',error='rollback-only' WHERE property_id='900000000002';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM analytics.ga4_registry WHERE property_id='900000000002') THEN RAISE EXCEPTION 'The collector cannot read the registry'; END IF;
 BEGIN UPDATE analytics.ga4_registry SET enabled=false; RAISE EXCEPTION 'The collector changes the registry'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO analytics.ga4_collect_status(property_id,checked_at,status) VALUES('900000000005',now(),'collected');
       RAISE EXCEPTION 'A result for an unregistered property'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_analytics_reader;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM analytics.ga4_registry r JOIN analytics.ga4_collect_status s USING(property_id))
    OR NOT EXISTS(SELECT 1 FROM analytics.ga4_registry_event WHERE property_id='900000000001') THEN
   RAISE EXCEPTION 'The API reader cannot read the registry'; END IF;
END $$;
RESET ROLE;
-- Source corrections (007): the API's role keeps the corrections and their history and publishes them through
-- catalog.publish_source_overrides() only. The family needs an approval, stays out of hub_reference (contract_version)
-- and no other writer records it.
SET LOCAL ROLE hmg_source_override_editor;
INSERT INTO catalog.source_override(skey,category,origin,updated_by) VALUES('rollback-only.example','newsMedia','hub',gen_random_uuid());
UPDATE catalog.source_override SET category='blogsReviews',updated_at=now() WHERE skey='rollback-only.example';
INSERT INTO catalog.source_override_event(skey,action,changes) VALUES('rollback-only.example','set','{"category":[null,"blogsReviews"]}');
DO $$ DECLARE v integer; BEGIN
 SELECT set_version INTO v FROM catalog.publish_source_overrides();
 IF v IS NULL THEN RAISE EXCEPTION 'A changed correction list was not published'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.publish_source_overrides()) THEN RAISE EXCEPTION 'An unchanged correction list was published again'; END IF;
 BEGIN UPDATE catalog.source_override SET skey='other.example' WHERE skey='rollback-only.example';
       RAISE EXCEPTION 'Correction role changes a key'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_override SET origin='gold_import'; RAISE EXCEPTION 'Correction role changes the origin'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_override SET note='x'; RAISE EXCEPTION 'Correction role writes notes'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.source_override; RAISE EXCEPTION 'Correction role deletes corrections'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_override_event SET action='clear'; RAISE EXCEPTION 'Correction role rewrites history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.source_override_event; RAISE EXCEPTION 'Correction role deletes history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
       VALUES(gen_random_uuid(),'source_override',99999,0,repeat('f',64),'hub_edit');
       RAISE EXCEPTION 'Correction role records a set of its own'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.prompt; RAISE EXCEPTION 'Correction role reads the catalog'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM analytics.ga4_row; RAISE EXCEPTION 'Correction role reads GA4 rows'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM publication.api_key; RAISE EXCEPTION 'Correction role reads keys'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.source_override(skey,category,origin) VALUES('Upper.example','newsMedia','hub');
       RAISE EXCEPTION 'An upper-case key'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.source_override(skey,category,origin) VALUES('www.lower.example','newsMedia','hub');
       RAISE EXCEPTION 'A key with www.'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.source_override(skey,category,origin) VALUES('name.example','News & Media','hub');
       RAISE EXCEPTION 'A category name instead of its slug'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.source_override(skey,category,origin,status) VALUES('status.example','newsMedia','hub','deleted');
       RAISE EXCEPTION 'An unknown status'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_catalog_writer;
DO $$ BEGIN
 BEGIN INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
       VALUES(gen_random_uuid(),'source_override',99999,0,repeat('f',64),'hub_edit');
       RAISE EXCEPTION 'The Gold import records HUB corrections'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
       VALUES(gen_random_uuid(),'source_override',99999,0,repeat('f',64),'gold');
       RAISE EXCEPTION 'The HUB correction family under another source'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
INSERT INTO publication.reference_access(family,enabled,approved_by) VALUES('source_override',false,'rollback-only test')
 ON CONFLICT(family) DO UPDATE SET enabled=false;
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF EXISTS(SELECT 1 FROM ext.reference_sets WHERE family='source_override') THEN RAISE EXCEPTION 'Unapproved HUB corrections exported'; END IF;
 IF coalesce((SELECT hub_reference FROM ext.meta),'') LIKE '%source_override%' THEN RAISE EXCEPTION 'HUB corrections change contract_version'; END IF;
END $$;
RESET ROLE;
UPDATE publication.reference_access SET enabled=true WHERE family='source_override';
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF NOT EXISTS(SELECT 1 FROM ext.reference_items WHERE family='source_override' AND item_key='rollback-only.example'
               AND definition->>'category'='blogsReviews') THEN RAISE EXCEPTION 'Approved HUB corrections missing'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_source_override_editor;
UPDATE catalog.source_override SET status='cleared',updated_at=now() WHERE skey='rollback-only.example';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.publish_source_overrides()) THEN RAISE EXCEPTION 'A revert was not published'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_analytics_reader;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.source_override_event WHERE skey='rollback-only.example') THEN RAISE EXCEPTION 'The API reader cannot read the corrections'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='source_override' AND item_key='rollback-only.example') THEN
   RAISE EXCEPTION 'A reverted correction is still published'; END IF;
END $$;
RESET ROLE;
-- Source lists (008): the same role keeps the seeds, the official social accounts and the code table (names, order,
-- description only: the code rows are imported, never added or removed), their history, and publishes them through
-- their own functions. No DELETE, no key or origin change, no set of its own.
INSERT INTO catalog.source_code(kind,code,number,name_en,name_ko,ord) VALUES('layer','rollbackOnly',99,'Rollback','롤백',99);
SET LOCAL ROLE hmg_source_override_editor;
INSERT INTO catalog.source_seed(skey,category,origin,updated_by) VALUES('rollback-only-seed.example','newsMedia','hub',gen_random_uuid());
UPDATE catalog.source_seed SET category='blogsReviews',status='removed',updated_at=now() WHERE skey='rollback-only-seed.example';
UPDATE catalog.source_seed SET status='active' WHERE skey='rollback-only-seed.example';
INSERT INTO catalog.source_seed_event(skey,action,changes) VALUES('rollback-only-seed.example','add','{"category":[null,"newsMedia"]}');
INSERT INTO catalog.source_social(account_key,display_key,domain,matchers,origin)
VALUES('rollback-only.example/account','rollback-only.example/Account','rollback-only.example','[{"prefix":"rollback-only.example/account","boundary":true}]','hub');
UPDATE catalog.source_social SET matchers='[{"prefix":"rollback-only.example/account2","boundary":false}]',status='stopped'
 WHERE account_key='rollback-only.example/account';
INSERT INTO catalog.source_social_event(account_key,action,changes) VALUES('rollback-only.example/account','add','{}');
UPDATE catalog.source_code SET name_ko='롤백 이름',description='x',ord=98,updated_at=now() WHERE kind='layer' AND code='rollbackOnly';
INSERT INTO catalog.source_code_event(kind,code,action,changes) VALUES('layer','rollbackOnly','set','{}');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.publish_source_seeds()) THEN RAISE EXCEPTION 'A changed seed list was not published'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.publish_source_seeds()) THEN RAISE EXCEPTION 'An unchanged seed list was published again'; END IF;
 PERFORM 1 FROM catalog.publish_source_socials();
 IF NOT EXISTS(SELECT 1 FROM catalog.publish_source_codes()) THEN RAISE EXCEPTION 'A changed code table was not published'; END IF;
 BEGIN UPDATE catalog.source_seed SET skey='other.example' WHERE skey='rollback-only-seed.example';
       RAISE EXCEPTION 'List role changes a seed key'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_seed SET origin='file_import'; RAISE EXCEPTION 'List role changes a seed origin'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_seed SET note='x'; RAISE EXCEPTION 'List role writes seed notes'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.source_seed; RAISE EXCEPTION 'List role deletes seeds'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_social SET display_key='rollback-only.example/ACCOUNT';
       RAISE EXCEPTION 'List role changes an account key'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_social SET domain='other.example'; RAISE EXCEPTION 'List role changes an account domain'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.source_social; RAISE EXCEPTION 'List role deletes accounts'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.source_code(kind,code,number,name_en,name_ko,ord) VALUES('category','newOne',98,'New','새',98);
       RAISE EXCEPTION 'List role adds a code'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_code SET number=97 WHERE code='rollbackOnly'; RAISE EXCEPTION 'List role renumbers a code'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_code SET code='renamed' WHERE code='rollbackOnly'; RAISE EXCEPTION 'List role changes a code'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.source_code; RAISE EXCEPTION 'List role deletes codes'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_seed_event SET action='remove'; RAISE EXCEPTION 'List role rewrites seed history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.source_social_event; RAISE EXCEPTION 'List role deletes account history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.source_code_event; RAISE EXCEPTION 'List role deletes code history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.publish_hub_edit('source_seed','[]'); RAISE EXCEPTION 'List role calls the shared publisher';
       EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
       VALUES(gen_random_uuid(),'source_seed',99999,0,repeat('f',64),'hub_edit');
       RAISE EXCEPTION 'List role records a set of its own'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.source_seed(skey,category,origin) VALUES('slash.example/path','newsMedia','hub');
       RAISE EXCEPTION 'A seed key with a slash'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.source_seed(skey,category,origin,status) VALUES('status.example','newsMedia','hub','cleared');
       RAISE EXCEPTION 'An unknown seed status'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.source_social(account_key,display_key,domain,matchers,origin) VALUES('nopath.example','nopath.example','nopath.example','[{}]','hub');
       RAISE EXCEPTION 'An account key without a path'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.source_social(account_key,display_key,domain,matchers,origin) VALUES('a.example/x','A.example/X','b.example','[{}]','hub');
       RAISE EXCEPTION 'An account outside its domain'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.source_social(account_key,display_key,domain,matchers,origin) VALUES('c.example/x','c.example/x','c.example','[]','hub');
       RAISE EXCEPTION 'An account without matchers'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_catalog_writer;
DO $$ BEGIN
 BEGIN INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
       VALUES(gen_random_uuid(),'source_code',99999,0,repeat('f',64),'gold');
       RAISE EXCEPTION 'A HUB list family under another source'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF coalesce((SELECT hub_reference FROM ext.meta),'') ~ 'source_(seed|social|code)' THEN RAISE EXCEPTION 'HUB lists change contract_version'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_analytics_reader;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='source_seed' AND item_key='rollback-only-seed.example'
               AND definition->>'category'='blogsReviews') THEN RAISE EXCEPTION 'The published seed list misses a seed'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='source_social' AND item_key='rollback-only.example/account') THEN
   RAISE EXCEPTION 'A stopped account is published'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='source_code' AND item_key='layer:rollbackOnly'
               AND definition->>'name_ko'='롤백 이름') THEN RAISE EXCEPTION 'The published code table misses a change'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.source_social_event) OR NOT EXISTS(SELECT 1 FROM catalog.source_code_event) THEN
   RAISE EXCEPTION 'The API reader cannot read the list history'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
