-- The cache DB (geohub_cache_db, 2026-11-06, D-17): filtered query results until the next round goes live (SSOT service/cache-db.md). Its own
-- database, apart from Gold. UNLOGGED and left out of backups: a crash empties it and the next query fills it again from the live snapshot.
-- No other team reads this database: the only login role is the BFF's cache role.
CREATE SCHEMA cache;
CREATE TABLE cache.schema_migration (
    version text PRIMARY KEY,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    installed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNLOGGED TABLE cache.query_result (
    cache_key text PRIMARY KEY CHECK (cache_key ~ '^[a-f0-9]{64}$'),
    snapshot_id text NOT NULL CHECK (length(snapshot_id) > 0),
    definition_version text NOT NULL CHECK (length(definition_version) > 0),
    query jsonb NOT NULL CHECK (jsonb_typeof(query) = 'object'),
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- A new live snapshot removes the rows of every other one (bff.hub_stores.cache_db.purge_other_snapshots).
CREATE INDEX query_result_snapshot ON cache.query_result(snapshot_id);
COMMENT ON TABLE cache.query_result IS 'Filtered query results, one row per query + live snapshot + definition version. No TTL; never a source of truth.';
COMMENT ON COLUMN cache.query_result.cache_key IS 'sha256 of the canonical query, the snapshot id and the definition version.';

REVOKE ALL ON SCHEMA cache FROM PUBLIC;
GRANT USAGE ON SCHEMA cache TO hmg_cache_writer;
GRANT SELECT,INSERT,UPDATE,DELETE ON cache.query_result TO hmg_cache_writer;
