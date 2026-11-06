-- The cache DB (cache_db): UNLOGGED, holds what SSOT service/cache-db.md lists, and the cache role reaches that table only.
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
 BEGIN CREATE TABLE cache.forbidden(id int); RAISE EXCEPTION 'The cache role creates tables'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM cache.schema_migration; RAISE EXCEPTION 'The cache role reads beyond its table'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO cache.query_result(cache_key,snapshot_id,definition_version,query,result) VALUES('short','s','v','{}','{}');
       RAISE EXCEPTION 'A key that is not a hash'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
