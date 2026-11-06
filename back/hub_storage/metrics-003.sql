-- Gold's metric rows (2026-11-06, D-18): one row per dimension combination of a round, with its base counts and metric values. The screens
-- read the counts through a data source (bff/metrics/gold_rows.py) and calculate with the metric functions; SQL review and the metrics API
-- read the values. Reads that hold no metric (prompt lists, filter options) stay whole in gold.first_screen_read.
CREATE TABLE gold.metric_row (
    surface text NOT NULL CHECK (surface IN ('global','website','project')),
    project_key integer NOT NULL DEFAULT 0,
    round_date date NOT NULL,
    call text NOT NULL,
    scope text NOT NULL,
    ord integer NOT NULL,
    dims jsonb NOT NULL,
    counts jsonb NOT NULL,
    metrics jsonb NOT NULL,
    snapshot_id text NOT NULL CHECK (length(snapshot_id) > 0),
    definition_version text NOT NULL CHECK (length(definition_version) > 0),
    computed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (surface, project_key, round_date, call, scope, ord)
);
COMMENT ON TABLE gold.metric_row IS 'One dimension combination of a round: its base counts (counts) and metric values (metrics). Served only while the round''s gold.metric_call is current.';
COMMENT ON COLUMN gold.metric_row.call IS 'What the row answers: the data source call, its population and its group, e.g. answer_counts|monitoring|round_date,engine_key.';
COMMENT ON COLUMN gold.metric_row.scope IS 'The first screen''s conditions: bits=7 (the 당사 perspective), engine=, brand_presence=.';
COMMENT ON COLUMN gold.metric_row.dims IS 'The dimension values of the row: engine_key, geo_key, brand_key … (empty = the whole scope).';

CREATE TABLE gold.metric_call (
    surface text NOT NULL CHECK (surface IN ('global','website','project')),
    project_key integer NOT NULL DEFAULT 0,
    round_date date NOT NULL,
    call text NOT NULL,
    scope text NOT NULL,
    snapshot_id text NOT NULL CHECK (length(snapshot_id) > 0),
    definition_version text NOT NULL CHECK (length(definition_version) > 0),
    row_count integer NOT NULL,
    error text,
    computed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (surface, project_key, round_date, call, scope)
);
COMMENT ON TABLE gold.metric_call IS 'Whether a call of a round was computed, and of which snapshot and definition version. A row here that is not current, or failed, means the value is late: it is not shown.';
GRANT SELECT,INSERT,UPDATE,DELETE ON gold.metric_row,gold.metric_call TO hmg_rollup_writer;
