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
ROLLBACK;
