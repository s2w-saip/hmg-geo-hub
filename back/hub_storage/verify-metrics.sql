-- Gold (geohub_gold_db): the rollup role writes its own tables and nothing else in the schema, the BFF's reader only reads.
BEGIN;
SET LOCAL ROLE hmg_rollup_writer;
INSERT INTO gold.rollup_run(surface,snapshot_id,definition_version) VALUES('global','rollback-only','v0');
INSERT INTO gold.metric_call(surface,round_date,call,scope,snapshot_id,definition_version,row_count) VALUES('global','2026-01-01','c','bits=7','rollback-only','v0',1);
INSERT INTO gold.metric_row(surface,round_date,call,scope,ord,dims,counts,metrics,snapshot_id,definition_version) VALUES('global','2026-01-01','c','bits=7',0,'{}','{"n":1}','{}','rollback-only','v0');
INSERT INTO gold.first_screen_read(read_key,surface,path,query,snapshot_id,definition_version,result) VALUES(repeat('b',64),'global','kpi/summary','surface=global','rollback-only','v0','{"n":1}');
DO $$ BEGIN
 BEGIN INSERT INTO gold.first_screen_read(read_key,surface,path,query,snapshot_id,definition_version) VALUES(repeat('c',64),'global','p','q','s','v');
       RAISE EXCEPTION 'A kept read with neither a result nor an error'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN CREATE TABLE gold.forbidden(id int); RAISE EXCEPTION 'The rollup role creates tables'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF to_regclass('gold.active_release') IS NOT NULL THEN
  BEGIN EXECUTE 'DELETE FROM gold.active_release'; RAISE EXCEPTION 'The rollup role changes a table that is not its own'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_metrics_reader;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM gold.first_screen_read WHERE read_key=repeat('b',64)) THEN RAISE EXCEPTION 'The reader cannot read Gold'; END IF;
 IF NOT EXISTS(SELECT 1 FROM gold.metric_row WHERE call='c') THEN RAISE EXCEPTION 'The reader cannot read the metric rows'; END IF;
 BEGIN DELETE FROM gold.metric_row; RAISE EXCEPTION 'The reader changes the metric rows'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM gold.first_screen_read; RAISE EXCEPTION 'The reader changes Gold'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_analytics_reader;
DO $$ BEGIN
 PERFORM 1 FROM analytics.ga4_row LIMIT 1;
 BEGIN PERFORM 1 FROM gold.first_screen_read; RAISE EXCEPTION 'The GA4 reader reaches the gold schema'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM analytics.ga4_row; RAISE EXCEPTION 'The GA4 reader changes rows'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_analytics_writer;
DO $$ BEGIN
 BEGIN PERFORM 1 FROM gold.first_screen_read; RAISE EXCEPTION 'The GA4 writer reaches the gold schema'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
