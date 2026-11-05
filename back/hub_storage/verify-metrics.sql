-- The metrics store: the cache is UNLOGGED and holds what SSOT service/cache-db.md lists, each role reaches its own part only.
BEGIN;
DO $$ BEGIN
 IF (SELECT relpersistence FROM pg_class WHERE oid='cache.query_result'::regclass)<>'u' THEN RAISE EXCEPTION 'The cache table is not UNLOGGED'; END IF;
 IF (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='cache' AND table_name='query_result')
    IS DISTINCT FROM ARRAY['cache_key','snapshot_id','definition_version','query','result','created_at'] THEN RAISE EXCEPTION 'The cache columns differ from the SSOT'; END IF;
END $$;
SET LOCAL ROLE hmg_cache_writer;
INSERT INTO cache.query_result(cache_key,snapshot_id,definition_version,query,result) VALUES(repeat('a',64),'rollback-only','v0','{"q":1}','{"n":1}');
UPDATE cache.query_result SET result='{"n":2}' WHERE cache_key=repeat('a',64);
DO $$ BEGIN
 BEGIN PERFORM 1 FROM gold.schema_migration; RAISE EXCEPTION 'The cache role reads Gold'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN CREATE TABLE cache.forbidden(id int); RAISE EXCEPTION 'The cache role creates tables'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO cache.query_result(cache_key,snapshot_id,definition_version,query,result) VALUES('short','s','v','{}','{}');
       RAISE EXCEPTION 'A key that is not a hash'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_metrics_reader;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM cache.query_result WHERE cache_key=repeat('a',64)) THEN RAISE EXCEPTION 'The reader cannot read the cache'; END IF;
 BEGIN DELETE FROM cache.query_result; RAISE EXCEPTION 'The reader changes the cache'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE hmg_rollup_writer;
DO $$ BEGIN
 BEGIN PERFORM 1 FROM cache.query_result; RAISE EXCEPTION 'The rollup role reads the cache'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
