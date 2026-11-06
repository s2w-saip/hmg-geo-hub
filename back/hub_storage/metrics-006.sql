-- The query tables' load job (T9.7, docs/handoff/query-tables-scope.md): data_server/metrics/query_load.py puts each operating snapshot of the Silver OBT into gold_db's query tables.
-- gold.silver_load is its record: which snapshot of a cycle is loaded. The role writes the tables it fills and nothing else; the data server's reader stays read-only.
CREATE TABLE gold.silver_load (
    cycle_id uuid PRIMARY KEY,
    snapshot_id uuid NOT NULL,
    surface text NOT NULL CHECK (surface IN ('global','website','project')),
    round_date date,
    answers integer NOT NULL,
    cells integer NOT NULL,
    inputs_digest text NOT NULL,
    loaded_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE gold.silver_load IS 'One row per cycle: its operating snapshot already in the query tables. The load job compares it with the manifest.';
GRANT SELECT ON gold.silver_load TO hmg_metrics_reader;
GRANT USAGE ON SCHEMA gold TO hmg_query_loader;
GRANT SELECT,INSERT,UPDATE,DELETE ON gold.silver_load,gold.answer_fact,gold.answer_brand_fact,gold.citation_fact,gold.answer_stance_fact,gold.answer_mention_raw,gold.answer_occurrence,
    gold.answer_stance_raw,gold.answer_body,gold.job_index,gold.acr_cell_fact,gold.acr_entity_fact,gold.acr_cell_run,gold.dim_url,gold.dim_source,gold.dim_entity,gold.dim_brand,gold.dim_cycle,
    gold.entity_mention_total,gold.entity_mention_surface,gold.build,gold.release_item,gold.active_release,gold.dim_prompt,gold.catalog_entry TO hmg_query_loader;
GRANT SELECT ON gold.dim_engine,gold.dim_country,gold.dim_lang,gold.dim_project,gold.dim_category,gold.dim_owned_base,gold.dim_taxon TO hmg_query_loader;
