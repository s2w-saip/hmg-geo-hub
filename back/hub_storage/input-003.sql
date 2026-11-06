-- The GA4 properties and the service week (2026-11-06, D-17): what people and the service decide, so they sit with the other inputs. The collected rows are in
-- geohub_gold_db (metrics-004.sql); no key crosses the two databases. Nothing here goes out through the API: hmg_ext_api reads the ext schema only.
SET LOCAL check_function_bodies = false;

-- One row per GA4 property: its market (brand x country, one collected property per market), its conversion basis (1 GA4 key events, 2 the listed events) and whether
-- it is collected. A property is never deleted: stopping it keeps its collected rows and its history. account_id and account_name say which GA4 account it belongs to,
-- never a key or a token: those stay in the git-ignored .env.ga4.local.
CREATE TABLE catalog.ga4_registry (
    property_id text PRIMARY KEY CHECK (property_id ~ '^[0-9]{1,20}$'),
    brand text NOT NULL CHECK (brand IN ('Hyundai','Kia','Genesis')),
    country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    conv_basis smallint NOT NULL CHECK (conv_basis IN (1,2)),
    conv_events text[] NOT NULL DEFAULT '{}',
    enabled boolean NOT NULL DEFAULT true,
    account_id text CHECK (account_id ~ '^[0-9]{1,20}$'),
    account_name text CHECK (length(account_name) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ga4_registry_events CHECK (CASE conv_basis WHEN 1 THEN conv_events='{}'
        ELSE cardinality(conv_events) BETWEEN 1 AND 50 AND array_position(conv_events,NULL) IS NULL END)
);
CREATE UNIQUE INDEX ga4_registry_market ON catalog.ga4_registry(brand,country) WHERE enabled;
-- A registry change as the screen shows it: changes = {field: [before, after]}. actor_id is geohub_operations_db's system.user_account.user_id (no key across databases).
CREATE TABLE catalog.ga4_registry_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    property_id text NOT NULL REFERENCES catalog.ga4_registry(property_id),
    action text NOT NULL CHECK (action IN ('create','update','stop','resume')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}',
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ga4_registry_event_property ON catalog.ga4_registry_event(property_id,occurred_at);
-- The collector's last result for each property, replaced on every run.
CREATE TABLE catalog.ga4_collect_status (
    property_id text PRIMARY KEY REFERENCES catalog.ga4_registry(property_id),
    checked_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('collected','pending_grant','failed','stopped')),
    error text CHECK (length(error)<=500),
    collected_at timestamptz,
    collected_to date
);
GRANT SELECT ON catalog.ga4_registry,catalog.ga4_registry_event,catalog.ga4_collect_status TO hmg_input_reader;
-- The collector: reads what to collect, writes its result. Its rows go to geohub_gold_db.
GRANT USAGE ON SCHEMA catalog TO hmg_analytics_writer;
GRANT SELECT ON catalog.ga4_registry TO hmg_analytics_writer;
GRANT SELECT,INSERT,UPDATE ON catalog.ga4_collect_status TO hmg_analytics_writer;
-- The API's registry role: the registry and its history, nothing else (no DELETE, no new property id).
GRANT USAGE ON SCHEMA catalog TO hmg_ga4_registry_editor;
GRANT SELECT,INSERT ON catalog.ga4_registry TO hmg_ga4_registry_editor;
GRANT UPDATE(brand,country,conv_basis,conv_events,enabled,account_id,account_name,updated_at) ON catalog.ga4_registry TO hmg_ga4_registry_editor;
GRANT SELECT,INSERT ON catalog.ga4_registry_event TO hmg_ga4_registry_editor;
GRANT SELECT ON catalog.ga4_collect_status TO hmg_ga4_registry_editor;

-- The service week: one row each time the week or its cycle sets change, so the rows are its history; catalog.current_service_week is the newest row. A row is never
-- changed afterwards except checked_at, the last check that confirmed it. An empty cycle array is a surface with no cycle that week, which does not hold the week back.
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
GRANT SELECT ON catalog.service_week,catalog.current_service_week TO hmg_input_reader;
-- The job's role (manage.py only, never the API): new rows and checked_at. No DELETE, no change to a recorded week, its cycles or its time.
GRANT USAGE ON SCHEMA catalog TO hmg_service_week_writer;
GRANT SELECT ON catalog.service_week,catalog.current_service_week TO hmg_service_week_writer;
GRANT INSERT(week_start,global_cycles,website_cycles,gold_release,gold_versions) ON catalog.service_week TO hmg_service_week_writer;
GRANT UPDATE(checked_at) ON catalog.service_week TO hmg_service_week_writer;
