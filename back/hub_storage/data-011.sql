-- Incremental migration (2026-11-02): the service week (서비스 기준 주), recorded by manage.py sync-service-week
-- (back/hub_storage/service_week.py; hourly on the VM, vm.sh service-week). Decisions '발행 시점 판정' and '기준 주 세부'
-- (docs/handoff/admin-todo.md): every screen reads Gold only up to one ISO week (Monday..Sunday) shared by the whole
-- service (Global and Website), moved by that job from Gold's own status.
--
-- catalog.service_week: one row each time the week or its cycle sets change, so the rows are its history. A row is never
-- changed afterwards except checked_at, the last check that confirmed it. global_cycles / website_cycles are the Gold
-- dim_cycle.cycle_id of the week's complete cycles of surface 1 / 2 that are not hidden (no key across the two databases);
-- an empty array is a surface with no cycle that week ('측정 없음'), which does not hold the week back. gold_release /
-- gold_versions are Gold's active_release rows and data_version when the row was recorded, for the record only: reads are
-- never pinned to them (a Gold re-publication is followed). catalog.current_service_week is the newest row.
CREATE TABLE catalog.service_week (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
    global_cycles uuid[] NOT NULL DEFAULT '{}' CHECK (array_position(global_cycles, NULL) IS NULL),
    website_cycles uuid[] NOT NULL DEFAULT '{}' CHECK (array_position(website_cycles, NULL) IS NULL),
    gold_release jsonb NOT NULL CHECK (jsonb_typeof(gold_release)='object'),
    gold_versions jsonb NOT NULL CHECK (jsonb_typeof(gold_versions)='object'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    checked_at timestamptz NOT NULL DEFAULT now(),
    CHECK (cardinality(global_cycles) + cardinality(website_cycles) > 0),
    CHECK (checked_at >= recorded_at)
);
CREATE VIEW catalog.current_service_week AS
    SELECT w.seq,w.week_start,w.week_start+6 AS week_end,w.global_cycles,w.website_cycles,w.gold_release,w.gold_versions,
           w.recorded_at,w.checked_at
    FROM catalog.service_week w
    WHERE NOT EXISTS(SELECT 1 FROM catalog.service_week n WHERE n.seq>w.seq);

GRANT SELECT ON catalog.service_week,catalog.current_service_week TO hmg_analytics_reader;
-- The job's role (manage.py only, never the API): this table and nothing else. It adds rows and moves checked_at; no
-- DELETE, no change to a recorded week, its cycles or its time, no seq of its own, no other catalog table.
GRANT USAGE ON SCHEMA catalog TO hmg_service_week_writer;
GRANT SELECT ON catalog.service_week,catalog.current_service_week TO hmg_service_week_writer;
GRANT INSERT(week_start,global_cycles,website_cycles,gold_release,gold_versions) ON catalog.service_week TO hmg_service_week_writer;
GRANT UPDATE(checked_at) ON catalog.service_week TO hmg_service_week_writer;
COMMENT ON TABLE catalog.service_week IS 'The service week (the last Gold week every screen shows), one row per change of the week or its cycles; checked_at = the last check that confirmed it. Written by manage.py sync-service-week only.';
