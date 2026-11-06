-- The rollup job's tables (2026-11-06, T5.3): the first screens' values, read by read (decision 'Gold 저장 단위'). The job runs the
-- builders of the unfiltered first screens and keeps every /v1 read they make, so a first screen and a filtered read are one calculation.
CREATE TABLE gold.first_screen_read (
    read_key text PRIMARY KEY CHECK (read_key ~ '^[a-f0-9]{64}$'),
    surface text NOT NULL CHECK (surface IN ('global','website','project')),
    path text NOT NULL,
    query text NOT NULL,
    snapshot_id text NOT NULL CHECK (length(snapshot_id) > 0),
    definition_version text NOT NULL CHECK (length(definition_version) > 0),
    result jsonb,
    error text,
    computed_at timestamptz NOT NULL DEFAULT now(),
    -- a read that failed in the run is kept as failed: the screen shows nothing rather than counting it at query time
    CHECK ((result IS NULL) <> (error IS NULL))
);
CREATE INDEX first_screen_read_surface ON gold.first_screen_read(surface,snapshot_id);
COMMENT ON TABLE gold.first_screen_read IS 'One row per /v1 read of an unfiltered first screen. Served only while snapshot_id and definition_version are the current ones.';
COMMENT ON COLUMN gold.first_screen_read.read_key IS 'sha256 of path?query, as bff.metrics.serving reads it.';
COMMENT ON COLUMN gold.first_screen_read.result IS 'The read''s answer, NULL when it failed in the run (error says why).';

CREATE TABLE gold.rollup_run (
    run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    surface text NOT NULL CHECK (surface IN ('global','website','project')),
    snapshot_id text NOT NULL,
    definition_version text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
    reads integer,
    failed integer,
    note text
);
CREATE INDEX rollup_run_last ON gold.rollup_run(surface,run_id DESC);
COMMENT ON TABLE gold.rollup_run IS 'The rollup job''s log: which snapshot and definition version each surface was computed for, and how it went.';
GRANT SELECT,INSERT,UPDATE,DELETE ON gold.first_screen_read,gold.rollup_run TO hmg_rollup_writer;
