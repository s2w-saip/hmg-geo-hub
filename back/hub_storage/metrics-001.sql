-- The metrics store (hmg_metrics, 2026-11-06, T5): what the BFF computes and keeps. Neither schema is a source of truth.
--   gold  : the pre-computed values of the unfiltered first screens, one set per round, with the snapshot id and the definition version.
--           Its tables come with the rollup job (T5.3), once the metric definitions (T3) and the rollup targets (D-13) are set.
--   cache : filtered query results until the next round goes live (SSOT service/cache-db.md). UNLOGGED and left out of backups: a crash
--           empties it and the next query fills it again from the live snapshot.
-- No other team reads this store: the only login roles are the BFF's reader, its cache role and the rollup job's role.
CREATE SCHEMA gold;
CREATE SCHEMA cache;
CREATE TABLE gold.schema_migration (
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

REVOKE ALL ON SCHEMA gold,cache FROM PUBLIC;
GRANT USAGE ON SCHEMA gold TO hmg_metrics_reader,hmg_rollup_writer;
GRANT USAGE ON SCHEMA cache TO hmg_metrics_reader,hmg_cache_writer;
-- Tables the rollup job's migration adds to gold are readable by the BFF without another grant.
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_metrics_owner IN SCHEMA gold GRANT SELECT ON TABLES TO hmg_metrics_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_metrics_owner IN SCHEMA gold GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO hmg_rollup_writer;
GRANT SELECT ON cache.query_result TO hmg_metrics_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON cache.query_result TO hmg_cache_writer;
