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
DO $$ BEGIN
 IF has_schema_privilege('hmg_analytics_writer','catalog','CREATE') OR has_table_privilege('hmg_analytics_writer','catalog.project','INSERT') THEN RAISE EXCEPTION 'Metric collector can mutate catalog'; END IF;
 IF has_database_privilege('hmg_data_external','postgres','CONNECT') THEN RAISE EXCEPTION 'External role has default DB access'; END IF;
 BEGIN INSERT INTO catalog.prompt(prompt_id,project_id,origin) VALUES(gen_random_uuid(),gen_random_uuid(),'hub'); RAISE EXCEPTION 'Orphan prompt allowed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
SET LOCAL ROLE hmg_data_external;
DO $$ BEGIN
 BEGIN PERFORM count(*) FROM ext.caller; RAISE EXCEPTION 'The DB export role reads the API contract'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
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
-- The service week job's role (011): its one table, new rows and checked_at only, never a recorded week, its cycles, its
-- Gold record or its time. Its grants are checked as well as tried, so a column or privilege added later is caught too.
-- The API reader sees the newest week; the external API and the API's catalog roles do not reach it.
SET LOCAL ROLE hmg_service_week_writer;
INSERT INTO catalog.service_week(week_start,global_cycles,website_cycles,gold_release,gold_versions)
VALUES('2026-09-28','{00000000-0000-4000-8000-0000000000a1}','{00000000-0000-4000-8000-0000000000b1}','{"global":{"live":{"version":27}}}','{"cycle":3183}');
INSERT INTO catalog.service_week(week_start,global_cycles,website_cycles,gold_release,gold_versions)
VALUES('2026-10-05','{00000000-0000-4000-8000-0000000000a2}','{}','{"global":{"live":{"version":27}}}','{"cycle":3184}');
UPDATE catalog.service_week SET checked_at=now()+interval '1 hour' WHERE seq=(SELECT max(seq) FROM catalog.service_week);
DO $$ BEGIN
 IF (SELECT week_start FROM catalog.current_service_week)<>'2026-10-05' THEN RAISE EXCEPTION 'The newest row is not the service week'; END IF;
 BEGIN UPDATE catalog.service_week SET week_start='2026-10-12'; RAISE EXCEPTION 'Writer moves a recorded week'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.service_week SET website_cycles='{}'; RAISE EXCEPTION 'Writer rewrites recorded cycles'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE catalog.service_week SET recorded_at=now(); RAISE EXCEPTION 'Writer rewrites a record time'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM catalog.service_week; RAISE EXCEPTION 'Writer deletes history'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='catalog.service_week'::regclass AND attnum>0 AND NOT attisdropped
           AND attname<>'checked_at' AND has_column_privilege(attrelid,attnum,'UPDATE')) THEN
   RAISE EXCEPTION 'Writer can UPDATE a column other than checked_at'; END IF;
 IF has_table_privilege('catalog.service_week','DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
   RAISE EXCEPTION 'Writer has DELETE, TRUNCATE, REFERENCES or TRIGGER on the history'; END IF;
 BEGIN INSERT INTO catalog.service_week(seq,week_start,global_cycles,gold_release,gold_versions) OVERRIDING SYSTEM VALUE
       VALUES(99,'2026-10-12','{00000000-0000-4000-8000-0000000000a3}','{}','{}'); RAISE EXCEPTION 'Writer sets seq';
       EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.service_week(week_start,global_cycles,gold_release,gold_versions,recorded_at)
       VALUES('2026-10-12','{00000000-0000-4000-8000-0000000000a3}','{}','{}',now()); RAISE EXCEPTION 'Writer sets recorded_at';
       EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.service_week(week_start,global_cycles,gold_release,gold_versions,checked_at)
       VALUES('2026-10-12','{00000000-0000-4000-8000-0000000000a3}','{}','{}',now()); RAISE EXCEPTION 'Writer sets checked_at on a new row';
       EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.prompt; RAISE EXCEPTION 'Writer reads the catalog'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN CREATE TABLE catalog.forbidden_week(id int); RAISE EXCEPTION 'Writer creates schema objects'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO catalog.service_week(week_start,global_cycles,gold_release,gold_versions) VALUES('2026-10-13','{00000000-0000-4000-8000-0000000000a3}','{}','{}');
       RAISE EXCEPTION 'A week that does not start on Monday'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.service_week(week_start,gold_release,gold_versions) VALUES('2026-10-12','{}','{}');
       RAISE EXCEPTION 'A week with no cycle on either surface'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.service_week(week_start,global_cycles,gold_release,gold_versions) VALUES('2026-10-12','{NULL}','{}','{}');
       RAISE EXCEPTION 'A NULL cycle id'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO catalog.service_week(week_start,global_cycles,gold_release,gold_versions) VALUES('2026-10-12','{00000000-0000-4000-8000-0000000000a3}','[]','{}');
       RAISE EXCEPTION 'A release record that is not an object'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE catalog.service_week SET checked_at=recorded_at-interval '1 hour'; RAISE EXCEPTION 'A check before the record';
       EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_analytics_reader;
DO $$ BEGIN
 IF (SELECT week_start FROM catalog.current_service_week)<>'2026-10-05' OR (SELECT count(*) FROM catalog.service_week)<2 THEN
   RAISE EXCEPTION 'The API reader cannot read the service week'; END IF;
 IF (SELECT extract(isodow FROM week_end) FROM catalog.current_service_week)<>7
    OR (SELECT checked_at<=recorded_at FROM catalog.current_service_week) THEN RAISE EXCEPTION 'The current week reads wrong'; END IF;
 BEGIN INSERT INTO catalog.service_week(week_start,global_cycles,gold_release,gold_versions) VALUES('2026-10-12','{00000000-0000-4000-8000-0000000000a3}','{}','{}');
       RAISE EXCEPTION 'The API reader writes the service week'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_ext_api;
DO $$ BEGIN
 BEGIN PERFORM 1 FROM catalog.service_week; RAISE EXCEPTION 'ext role reads the service week'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM catalog.current_service_week; RAISE EXCEPTION 'ext role reads the current week'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_catalog_writer;
DO $$ BEGIN
 BEGIN INSERT INTO catalog.service_week(week_start,global_cycles,gold_release,gold_versions) VALUES('2026-10-12','{00000000-0000-4000-8000-0000000000a3}','{}','{}');
       RAISE EXCEPTION 'The Gold catalog import writes the service week'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_catalog_editor;
DO $$ BEGIN
 BEGIN UPDATE catalog.service_week SET checked_at=now(); RAISE EXCEPTION 'The API catalog editor touches the service week';
       EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
-- The inputs moved to input_db (014): nothing writes the frozen copy here, and the API's input roles no longer connect.
DO $$ BEGIN
 IF has_table_privilege('hmg_catalog_writer','catalog.prompt_version','INSERT') OR has_table_privilege('hmg_catalog_editor','catalog.prompt_version','INSERT')
    OR has_table_privilege('hmg_project_editor','catalog.prompt','INSERT') OR has_table_privilege('hmg_source_override_editor','catalog.source_seed','INSERT')
    OR has_table_privilege('hmg_interest_editor','catalog.interest_keyword','INSERT') OR has_table_privilege('hmg_entity_role_editor','catalog.entity_role','INSERT') THEN
   RAISE EXCEPTION 'A role can still write the frozen inputs'; END IF;
 IF has_database_privilege('hmg_ext_api','hmg_analytics','CONNECT') OR has_database_privilege('hmg_catalog_editor','hmg_analytics','CONNECT') THEN
   RAISE EXCEPTION 'An input role can still connect to the data DB'; END IF;
END $$;
ROLLBACK;
