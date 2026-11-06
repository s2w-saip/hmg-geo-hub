-- T12.1 (2026-11-07): the gold_db tables no code reads since the query tables took over (docs/handoff/query-tables-scope.md 6). NOT a migration: manage.py never runs it, because a drop
-- cannot be undone. The user runs it after the cross-check, as the store's owner:
--   psql -h .local/pg/metrics-socket -p 55439 -U hmg_metrics_admin -d gold_db -v ON_ERROR_STOP=1 -f back/hub_storage/teardown-t12.sql
-- Checked on 2026-11-07: no view or foreign key depends on them, and a full capture of the screens does not touch them. A new install never had them (metrics-005a.sql leaves them out).
-- The kept copy of the old database goes on its own, outside a transaction, once nothing compares with it: DROP DATABASE gold_before_t97;
-- (build_virtual_obt.py reads gold.answer_citation_raw there: the stand-in OBT can no longer be rebuilt after that.)
BEGIN;
-- empty in the new database
DROP TABLE IF EXISTS gold.kpi_cell,gold.citation_cell,gold.brand_cell,gold.kpi_rollup,gold.url_prompt_cell,gold.answer_citation_raw;
-- copied over and read by nothing
DROP TABLE IF EXISTS gold.pub_cell,gold.pub_cell_web,gold.pub_prompt,gold.pub_prompt_axis,gold.pub_brand_name,gold.report_value,gold.answer_registry,gold.acr_cell_job;
-- the service week moved to the manifest (T7.6)
DROP TABLE IF EXISTS gold.publication,gold.cycle_pick_basis,gold.data_version;
COMMIT;
