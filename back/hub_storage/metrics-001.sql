-- Gold (geohub_gold_db, 2026-11-06, T5 · D-17): the pre-computed values of the unfiltered first screens, one set per round, with the snapshot
-- id and the definition version. Not a source of truth. The rollup job's tables come with metrics-002 and metrics-003. The schema may already
-- hold the tables of the Gold copy (copy_gold.py), so the rollup role gets its own tables by name, never by default: it writes nothing else here.
-- No other team reads this database: the only login roles are the BFF's reader and the rollup job's role.
CREATE SCHEMA IF NOT EXISTS gold;
CREATE TABLE gold.schema_migration (
    version text PRIMARY KEY,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    installed_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON SCHEMA gold FROM PUBLIC;
GRANT USAGE ON SCHEMA gold TO hmg_metrics_reader,hmg_rollup_writer;
-- Tables the rollup job's migrations add to gold are readable by the BFF without another grant.
ALTER DEFAULT PRIVILEGES FOR ROLE hmg_metrics_owner IN SCHEMA gold GRANT SELECT ON TABLES TO hmg_metrics_reader;
