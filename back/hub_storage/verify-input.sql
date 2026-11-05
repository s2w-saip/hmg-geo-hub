BEGIN;
INSERT INTO catalog.project(project_id,origin) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1','hub');
INSERT INTO catalog.project_version(project_id,version,definition,sha256)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1',1,'{"name":"rollback-only permission fixture"}',repeat('a',64));
INSERT INTO catalog.prompt(prompt_id,project_id,origin)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2','ffffffff-ffff-4fff-8fff-fffffffffff1','hub');
INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2',1,'rollback-only','{}',repeat('a',64));
INSERT INTO publication.project_access(project_id,projects,approved_by)
VALUES('ffffffff-ffff-4fff-8fff-fffffffffff1',true,'rollback-only test');
UPDATE publication.project_access SET prompts=true WHERE project_id='ffffffff-ffff-4fff-8fff-fffffffffff1';
SET LOCAL ROLE hmg_catalog_writer;
DO $$ BEGIN
 BEGIN UPDATE catalog.prompt_version SET text='changed'; RAISE EXCEPTION 'Writer can mutate history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.project; RAISE EXCEPTION 'Writer can delete stable IDs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE publication.project_access SET prompts=true; RAISE EXCEPTION 'Writer can approve exports'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN
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
UPDATE publication.api_client SET audience='analyze' WHERE client_id='ffffffff-ffff-4fff-8fff-fffffffffffa';
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
UPDATE publication.api_client SET audience='collect' WHERE client_id='ffffffff-ffff-4fff-8fff-fffffffffffa';
SET LOCAL ROLE hmg_source_override_editor;
UPDATE catalog.source_override SET status='cleared',updated_at=now() WHERE skey='rollback-only.example';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.publish_source_overrides()) THEN RAISE EXCEPTION 'A revert was not published'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_input_reader;
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
SET LOCAL ROLE hmg_input_reader;
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
-- The customer-interest role (009): its two lists, their history and their publishing functions, nothing else. Keys are
-- the normalized forms, a stopped row leaves the published list, and the HUB lists stay out of contract_version.
DO $$ BEGIN
 IF catalog.interest_term_norm(E' \u3000ÜBER SUV\n')<>'über suv' THEN RAISE EXCEPTION 'The keyword key differs from Gold term_norm'; END IF;
END $$;
SET LOCAL ROLE hmg_interest_editor;
INSERT INTO catalog.interest_keyword(term_norm,term,conditions,source_types,origin,updated_by)
VALUES('rollback-only seed','Rollback-Only Seed','[{"location_code":2410,"language_code":"ko"}]',ARRAY['google_keyword'],'hub',gen_random_uuid());
UPDATE catalog.interest_keyword SET conditions='[{"location_code":2840,"language_code":"en"}]',source_types=ARRAY['google_keyword','community_voc'],
    brands=ARRAY['Kia'],note='x',updated_at=now() WHERE term_norm='rollback-only seed';
INSERT INTO catalog.interest_keyword_event(term_norm,action,changes) VALUES('rollback-only seed','add','{}');
INSERT INTO catalog.interest_source(source_key,url,channel,updated_by) VALUES('rollback-only.example/forum','https://www.Rollback-Only.example/forum/','community',gen_random_uuid());
INSERT INTO catalog.interest_source(source_key,url,channel) VALUES('rollback-stopped.example','rollback-stopped.example','news');
UPDATE catalog.interest_source SET channel='news',brands=ARRAY['Genesis'],note='x',updated_at=now() WHERE source_key='rollback-only.example/forum';
UPDATE catalog.interest_source SET status='stopped' WHERE source_key='rollback-stopped.example';
INSERT INTO catalog.interest_source_event(source_key,action,changes) VALUES('rollback-only.example/forum','add','{}');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.publish_interest_keywords()) THEN RAISE EXCEPTION 'A changed keyword list was not published'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.publish_interest_keywords()) THEN RAISE EXCEPTION 'An unchanged keyword list was published again'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.publish_interest_sources()) THEN RAISE EXCEPTION 'A changed source list was not published'; END IF;
 BEGIN UPDATE catalog.interest_keyword SET term_norm='other'; RAISE EXCEPTION 'Interest role changes a keyword key'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.interest_keyword SET term='Other'; RAISE EXCEPTION 'Interest role changes a term'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.interest_keyword SET origin='gold_import'; RAISE EXCEPTION 'Interest role changes an origin'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.interest_keyword; RAISE EXCEPTION 'Interest role deletes keywords'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.interest_source SET source_key='other.example'; RAISE EXCEPTION 'Interest role changes a source key'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.interest_source SET url='other.example'; RAISE EXCEPTION 'Interest role changes a URL'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.interest_source; RAISE EXCEPTION 'Interest role deletes sources'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.interest_keyword_event SET action='stop'; RAISE EXCEPTION 'Interest role rewrites keyword history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.interest_source_event; RAISE EXCEPTION 'Interest role deletes source history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.publish_hub_edit('interest_keyword','[]'); RAISE EXCEPTION 'Interest role calls the shared publisher';
       EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.publish_source_seeds(); RAISE EXCEPTION 'Interest role publishes another list'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.source_seed; RAISE EXCEPTION 'Interest role reads another list'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
       VALUES(gen_random_uuid(),'interest_keyword',99999,0,repeat('f',64),'hub_edit');
       RAISE EXCEPTION 'Interest role writes reference sets'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.interest_keyword(term_norm,term,conditions,source_types,origin) VALUES('not the norm','Other','[{}]',ARRAY['google_keyword'],'hub');
       RAISE EXCEPTION 'A key that is not the term''s norm'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.interest_keyword(term_norm,term,conditions,source_types,origin) VALUES('no condition','No Condition','[]',ARRAY['google_keyword'],'hub');
       RAISE EXCEPTION 'A keyword without a condition'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.interest_keyword(term_norm,term,conditions,source_types,origin) VALUES('bad type','Bad Type','[{}]',ARRAY['other'],'hub');
       RAISE EXCEPTION 'An unknown source type'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.interest_source(source_key,url,channel) VALUES('www.lower.example','lower.example','news');
       RAISE EXCEPTION 'A source key with www.'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.interest_source(source_key,url,channel) VALUES('https://lower.example','lower.example','news');
       RAISE EXCEPTION 'A source key with a scheme'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.interest_source(source_key,url,channel) VALUES('lower.example','lower.example','blog');
       RAISE EXCEPTION 'An unknown channel'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF coalesce((SELECT hub_reference FROM ext.meta),'') LIKE '%interest_%' THEN RAISE EXCEPTION 'Customer-interest lists change contract_version'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_input_reader;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='interest_keyword' AND item_key='rollback-only seed'
               AND definition->>'term'='Rollback-Only Seed' AND definition->'brands'='["Kia"]') THEN RAISE EXCEPTION 'The published keyword list misses a keyword'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='interest_source' AND item_key='rollback-only.example/forum'
               AND definition->>'channel'='news') THEN RAISE EXCEPTION 'The published source list misses a source'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='interest_source' AND item_key='rollback-stopped.example') THEN
   RAISE EXCEPTION 'A stopped source is published'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.interest_keyword_event) OR NOT EXISTS(SELECT 1 FROM catalog.interest_source_event) THEN
   RAISE EXCEPTION 'The API reader cannot read the interest history'; END IF;
END $$;
RESET ROLE;
-- The entity role editor (010): the roles, their history and their publishing function, nothing else. own carries a brand,
-- excluded none, a cleared row leaves the published list, and the HUB list stays out of contract_version.
SET LOCAL ROLE hmg_entity_role_editor;
INSERT INTO catalog.entity_role(entity_id,rep_name,role,brand,origin,updated_by)
VALUES('00000000-0000-4000-8000-00000000e001','Rollback Own','own','Kia','hub',gen_random_uuid()),
      ('00000000-0000-4000-8000-00000000e002','Rollback Excluded','excluded',NULL,'hub',NULL);
UPDATE catalog.entity_role SET brand='Hyundai',note='x',updated_at=now() WHERE entity_id='00000000-0000-4000-8000-00000000e001';
UPDATE catalog.entity_role SET status='cleared' WHERE entity_id='00000000-0000-4000-8000-00000000e002';
INSERT INTO catalog.entity_role_event(entity_id,action,changes) VALUES('00000000-0000-4000-8000-00000000e001','set','{}');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.publish_entity_roles()) THEN RAISE EXCEPTION 'A changed role list was not published'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.publish_entity_roles()) THEN RAISE EXCEPTION 'An unchanged role list was published again'; END IF;
 BEGIN UPDATE catalog.entity_role SET entity_id=gen_random_uuid(); RAISE EXCEPTION 'Role editor changes an entity'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.entity_role SET rep_name='x'; RAISE EXCEPTION 'Role editor changes a name'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.entity_role SET origin='gold_import'; RAISE EXCEPTION 'Role editor changes an origin'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.entity_role; RAISE EXCEPTION 'Role editor deletes roles'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.entity_role_event SET action='clear'; RAISE EXCEPTION 'Role editor rewrites history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.entity_role_event; RAISE EXCEPTION 'Role editor deletes history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.publish_hub_edit('entity_role','[]'); RAISE EXCEPTION 'Role editor calls the shared publisher';
       EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.publish_interest_keywords(); RAISE EXCEPTION 'Role editor publishes another list'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.interest_keyword; RAISE EXCEPTION 'Role editor reads another list'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source)
       VALUES(gen_random_uuid(),'entity_role',99999,0,repeat('f',64),'hub_edit');
       RAISE EXCEPTION 'Role editor writes reference sets'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.entity_role(entity_id,rep_name,role,origin) VALUES(gen_random_uuid(),'x','own','hub');
       RAISE EXCEPTION 'An own role without a brand'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.entity_role(entity_id,rep_name,role,brand,origin) VALUES(gen_random_uuid(),'x','excluded','Kia','hub');
       RAISE EXCEPTION 'An excluded role with a brand'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.entity_role(entity_id,rep_name,role,origin) VALUES(gen_random_uuid(),'x','competitor','hub');
       RAISE EXCEPTION 'A stored competitor'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.entity_role(entity_id,rep_name,role,brand,origin) VALUES(gen_random_uuid(),'x','own','Toyota','hub');
       RAISE EXCEPTION 'An unknown own brand'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF coalesce((SELECT hub_reference FROM ext.meta),'') LIKE '%entity_role%' THEN RAISE EXCEPTION 'The entity role list changes contract_version'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_input_reader;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='entity_role' AND item_key='00000000-0000-4000-8000-00000000e001'
               AND definition->>'role'='own' AND definition->>'brand'='Hyundai') THEN RAISE EXCEPTION 'The published role list misses a role'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='entity_role' AND item_key='00000000-0000-4000-8000-00000000e002') THEN
   RAISE EXCEPTION 'A cleared role is published'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.entity_role_event) THEN RAISE EXCEPTION 'The API reader cannot read the role history'; END IF;
END $$;
RESET ROLE;
-- Project prompts (012): the project editor adds prompts and revisions of project-surface (3) catalogs only, each naming its
-- account; it never rewrites history, creates projects, touches other surfaces, approves exports or sets change_seq.
INSERT INTO catalog.project(project_id,origin) VALUES('00000000-0000-4000-8000-0000000000f3','hub'),('00000000-0000-4000-8000-0000000000f1','hub');
INSERT INTO catalog.project_version(project_id,version,definition,sha256) VALUES
 ('00000000-0000-4000-8000-0000000000f3',1,'{"surface":3,"custom_fields":[]}',repeat('a',64)),
 ('00000000-0000-4000-8000-0000000000f1',1,'{"surface":1}',repeat('a',64));
INSERT INTO catalog.prompt(prompt_id,project_id,origin) VALUES('00000000-0000-4000-8000-0000000000f4','00000000-0000-4000-8000-0000000000f1','hub');
INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256) VALUES('00000000-0000-4000-8000-0000000000f4',1,'global','{}',repeat('a',64));
SET LOCAL ROLE hmg_project_editor;
INSERT INTO catalog.prompt(prompt_id,project_id,origin) VALUES('00000000-0000-4000-8000-0000000000f5','00000000-0000-4000-8000-0000000000f3','hub');
INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256,recorded_by)
VALUES('00000000-0000-4000-8000-0000000000f5',1,'rollback-only draft','{"status":"draft"}',repeat('b',64),gen_random_uuid());
INSERT INTO catalog.project_version(project_id,version,definition,sha256,recorded_by)
VALUES('00000000-0000-4000-8000-0000000000f3',2,'{"surface":3,"custom_fields":[{"field_id":"x","label":"x","archived":false}]}',repeat('b',64),gen_random_uuid());
DO $$ BEGIN
 BEGIN INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256)
   VALUES('00000000-0000-4000-8000-0000000000f5',2,'x','{}',repeat('c',64)); RAISE EXCEPTION 'Project editor records an anonymous revision';
   EXCEPTION WHEN not_null_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.prompt(prompt_id,project_id,origin) VALUES(gen_random_uuid(),'00000000-0000-4000-8000-0000000000f1','hub');
   RAISE EXCEPTION 'Project editor adds a Global prompt'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256,recorded_by)
   VALUES('00000000-0000-4000-8000-0000000000f4',2,'x','{}',repeat('c',64),gen_random_uuid()); RAISE EXCEPTION 'Project editor revises a Global prompt';
   EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.project_version(project_id,version,definition,sha256,recorded_by)
   VALUES('00000000-0000-4000-8000-0000000000f1',2,'{}',repeat('c',64),gen_random_uuid()); RAISE EXCEPTION 'Project editor revises the Global project';
   EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.project(project_id,origin) VALUES(gen_random_uuid(),'hub'); RAISE EXCEPTION 'Project editor creates projects';
   EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.prompt_version SET text='changed'; RAISE EXCEPTION 'Project editor rewrites history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.prompt; RAISE EXCEPTION 'Project editor deletes stable IDs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256,recorded_by,change_seq)
   VALUES('00000000-0000-4000-8000-0000000000f5',3,'x','{}',repeat('e',64),gen_random_uuid(),1); RAISE EXCEPTION 'Project editor sets change_seq';
   EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE publication.project_access SET prompts=true; RAISE EXCEPTION 'Project editor approves exports'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM publication.api_key; RAISE EXCEPTION 'Project editor reads keys'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM count(*) FROM catalog.entity_role; RAISE EXCEPTION 'Project editor reads other HUB inputs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF has_table_privilege('hmg_project_editor','catalog.prompt_version','UPDATE') OR has_table_privilege('hmg_project_editor','catalog.prompt_version','DELETE')
    OR has_table_privilege('hmg_project_editor','catalog.project_version','UPDATE') OR has_table_privilege('hmg_project_editor','catalog.project_version','DELETE')
    OR has_table_privilege('hmg_project_editor','catalog.prompt','UPDATE') OR has_table_privilege('hmg_project_editor','catalog.prompt','DELETE')
    OR has_table_privilege('hmg_project_editor','catalog.project','INSERT') OR has_table_privilege('hmg_project_editor','catalog.reference_set','INSERT')
 THEN RAISE EXCEPTION 'The project editor has more than INSERT on project catalogs'; END IF;
END $$;
-- Source list versions (013): every change of a 인용 출처 분류 list is one whole-row version, written by the trigger only
-- (a bookkeeping-only update is none); nobody else writes or rewrites a version; every current row is its latest version.
SET LOCAL ROLE hmg_source_override_editor;
INSERT INTO catalog.source_seed(skey,category,origin,updated_by) VALUES('rollback-only-version.example','newsMedia','hub',gen_random_uuid());
UPDATE catalog.source_seed SET category='blogsReviews',updated_at=now() WHERE skey='rollback-only-version.example';
UPDATE catalog.source_seed SET updated_at=now() WHERE skey='rollback-only-version.example';
DO $$ BEGIN
 IF (SELECT array_agg(category ORDER BY version) FROM catalog.source_seed_version WHERE skey='rollback-only-version.example')
    IS DISTINCT FROM ARRAY['newsMedia','blogsReviews'] THEN RAISE EXCEPTION 'A seed change is not one version each'; END IF;
 BEGIN INSERT INTO catalog.source_seed_version(skey,version,category,status,origin,recorded_at,change_seq)
       VALUES('rollback-only-version.example',9,'x','active','hub',now(),1); RAISE EXCEPTION 'List role writes a version';
       EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.source_code_version SET name_ko='x'; RAISE EXCEPTION 'List role rewrites a version'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.source_override_version; RAISE EXCEPTION 'List role deletes versions'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$
DECLARE
    t text;
    k text;
    bad bigint;
    r text;
BEGIN
 FOR t, k IN VALUES ('source_override','skey'),('source_seed','skey'),('source_social','account_key'),('source_code','kind,code') LOOP
   EXECUTE format($q$SELECT count(*) FROM (SELECT to_jsonb(c)-'created_at'-'updated_at'-'updated_by' AS v FROM catalog.%1$I c) a
       FULL JOIN (SELECT DISTINCT ON (%3$s) to_jsonb(v)-'version'-'recorded_at'-'recorded_by'-'change_seq' AS v FROM catalog.%2$I v
                  ORDER BY %3$s,v.version DESC) b USING (v) WHERE a.v IS NULL OR b.v IS NULL$q$, t, t || '_version', k) INTO bad;
   IF bad > 0 THEN RAISE EXCEPTION '%: % current rows differ from their latest version', t, bad; END IF;
   EXECUTE format('SELECT count(*) FROM (SELECT count(*) n,max(version) m FROM catalog.%I GROUP BY %s) g WHERE n<>m', t || '_version', k) INTO bad;
   IF bad > 0 THEN RAISE EXCEPTION '%: versions are not 1..n', t; END IF;
   FOREACH r IN ARRAY ARRAY['hmg_source_override_editor','hmg_input_reader','hmg_catalog_writer','hmg_catalog_editor'] LOOP
     IF has_table_privilege(r, 'catalog.' || t || '_version', 'INSERT') OR has_table_privilege(r, 'catalog.' || t || '_version', 'UPDATE')
        OR has_table_privilege(r, 'catalog.' || t || '_version', 'DELETE') THEN
       RAISE EXCEPTION '% can write %_version', r, t; END IF;
   END LOOP;
 END LOOP;
END $$;
-- The input store's own (input-002). Versions of the remaining lists, the reference values the store owns, the measurement settings
-- and who reads what through the API.
SET LOCAL ROLE hmg_interest_editor;
INSERT INTO catalog.interest_source(source_key,url,channel,updated_by) VALUES('rollback-version.example/f','rollback-version.example/f','news',gen_random_uuid());
UPDATE catalog.interest_source SET channel='community',updated_at=now() WHERE source_key='rollback-version.example/f';
DO $$ BEGIN
 IF (SELECT array_agg(channel ORDER BY version) FROM catalog.interest_source_version WHERE source_key='rollback-version.example/f')
    IS DISTINCT FROM ARRAY['news','community'] THEN RAISE EXCEPTION 'An interest source change is not one version each'; END IF;
 BEGIN DELETE FROM catalog.interest_source_version; RAISE EXCEPTION 'Interest role deletes versions'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_catalog_writer;
INSERT INTO catalog.reference_source(family,item_key,definition,origin) VALUES('language','rollback-language','{"code":"rollback-language"}','gold_import');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.publish_reference_source('language')) THEN RAISE EXCEPTION 'A changed reference family was not published'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.publish_reference_source('language')) THEN RAISE EXCEPTION 'An unchanged reference family was published again'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='language' AND item_key='rollback-language' AND source='hub_edit') THEN
   RAISE EXCEPTION 'The published family misses the item'; END IF;
 BEGIN UPDATE catalog.reference_source SET status='stopped'; RAISE EXCEPTION 'The import changes a reference value'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.reference_source(family,item_key,definition,origin) VALUES('keyword','x','{}','gold_import'); RAISE EXCEPTION 'A family the store does not own';
       EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM catalog.reference_source_version WHERE family='language' AND item_key='rollback-language' AND version=1) THEN
   RAISE EXCEPTION 'A reference value has no version'; END IF;
END $$;
INSERT INTO catalog.project(project_id,origin) VALUES('00000000-0000-4000-8000-0000000000d1','hub');
INSERT INTO catalog.project_version(project_id,version,definition,sha256) VALUES('00000000-0000-4000-8000-0000000000d1',1,'{"surface":3}',repeat('a',64));
SET LOCAL ROLE hmg_measurement_editor;
INSERT INTO catalog.project_measurement_version(project_id,version,brands,engines,cadence,acr_repeats,origin,sha256,recorded_by)
VALUES('00000000-0000-4000-8000-0000000000d1',1,'{kia}','{chatgpt}','weekly',5,'hub',repeat('a',64),gen_random_uuid());
INSERT INTO catalog.project_measurement_version(project_id,version,brands,origin,sha256,recorded_by)
VALUES('00000000-0000-4000-8000-0000000000d1',2,'{hyundai}','hub',repeat('b',64),gen_random_uuid());
DO $$ BEGIN
 IF (SELECT brands FROM catalog.current_measurement WHERE project_id='00000000-0000-4000-8000-0000000000d1')<>'{hyundai}' THEN RAISE EXCEPTION 'The newest version is not current'; END IF;
 BEGIN UPDATE catalog.project_measurement_version SET cadence='monthly'; RAISE EXCEPTION 'Editor rewrites settings'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.project_measurement_version; RAISE EXCEPTION 'Editor deletes settings'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.project_measurement_version(project_id,version,origin,sha256,recorded_by,change_seq)
       VALUES('00000000-0000-4000-8000-0000000000d1',3,'hub',repeat('c',64),gen_random_uuid(),1); RAISE EXCEPTION 'Editor sets change_seq'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.project_measurement_version(project_id,version,origin,sha256)
       VALUES('00000000-0000-4000-8000-0000000000d1',3,'hub',repeat('c',64)); RAISE EXCEPTION 'An anonymous HUB version'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.project_measurement_version(project_id,version,cadence,origin,sha256,recorded_by)
       VALUES('00000000-0000-4000-8000-0000000000d1',3,'daily','hub',repeat('c',64),gen_random_uuid()); RAISE EXCEPTION 'An unknown cadence'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256) VALUES('ffffffff-ffff-4fff-8fff-fffffffffff2',9,'x','{}',repeat('e',64));
       RAISE EXCEPTION 'Editor writes prompts'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM publication.api_key; RAISE EXCEPTION 'Editor reads keys'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.entity_role; RAISE EXCEPTION 'Editor reads other inputs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
-- A collecting client sees its projects with their settings and the collecting families; an analysis client sees the analysis
-- families and no project. Both decode with the code tables.
INSERT INTO publication.project_access(project_id,projects,prompts,approved_by) VALUES('00000000-0000-4000-8000-0000000000d1',true,true,'rollback-only test');
INSERT INTO publication.api_client_project(client_id,project_id,granted_by) VALUES('ffffffff-ffff-4fff-8fff-fffffffffffa','00000000-0000-4000-8000-0000000000d1','test');
INSERT INTO publication.reference_access(family,enabled,approved_by) VALUES('engine',true,'rollback-only test'),('taxon',true,'rollback-only test')
 ON CONFLICT(family) DO UPDATE SET enabled=true;
INSERT INTO catalog.reference_set(set_id,family,version,item_count,sha256,source) VALUES('ffffffff-ffff-4fff-8fff-ffffffffffc2','keyword',2147483647,0,repeat('d',64),'gold');
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF (SELECT measurement->'brands' FROM ext.projects WHERE project_id='00000000-0000-4000-8000-0000000000d1')<>'["hyundai"]' THEN RAISE EXCEPTION 'The settings are not in the project'; END IF;
 IF NOT EXISTS(SELECT 1 FROM ext.reference_sets WHERE family='engine') THEN RAISE EXCEPTION 'A collecting client misses a collecting family'; END IF;
 IF EXISTS(SELECT 1 FROM ext.reference_sets WHERE family='taxon') THEN RAISE EXCEPTION 'A collecting client reads an analysis family'; END IF;
 IF EXISTS(SELECT 1 FROM ext.reference_sets WHERE family='keyword') THEN RAISE EXCEPTION 'A family outside the contract leaves'; END IF;
END $$;
RESET ROLE;
UPDATE publication.api_client SET audience='analyze' WHERE client_id='ffffffff-ffff-4fff-8fff-fffffffffffa';
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 PERFORM set_config('hgh.key_hash',repeat('1',64),true);
 IF EXISTS(SELECT 1 FROM ext.projects) OR EXISTS(SELECT 1 FROM ext.prompts) THEN RAISE EXCEPTION 'An analysis client reads projects or prompts'; END IF;
 IF EXISTS(SELECT 1 FROM ext.reference_sets WHERE family='engine') THEN RAISE EXCEPTION 'An analysis client reads a collecting family'; END IF;
 IF NOT EXISTS(SELECT 1 FROM ext.reference_sets WHERE family='taxon') THEN RAISE EXCEPTION 'An analysis client misses an analysis family'; END IF;
 IF NOT EXISTS(SELECT 1 FROM ext.codes WHERE family='surface') THEN RAISE EXCEPTION 'The code tables are missing'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
