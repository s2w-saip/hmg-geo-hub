-- Incremental migration (2026-10-29): the GA4 property registry, edited on the renewal Admin › GA4 연동 screen
-- (back/bff/hub_stores/ga4_registry.py) and read by the GA4 collector (back/analytics/ga4_collect.py), which read
-- the git-ignored .local/ga4-properties.json before. One row per GA4 property: its market (brand × country, one
-- collected property per market), its conversion basis (1 GA4 key events, 2 the listed events, as
-- analytics.ga4_property.conv_basis) and whether it is collected. A property is never deleted: stopping it keeps
-- its collected rows and its history. analytics.ga4_property stays the collector's record of what it collected;
-- the collector copies a registry row into it on its next run and notes the run in ga4_collect_status.
CREATE TABLE analytics.ga4_registry (
    property_id text PRIMARY KEY CHECK (property_id ~ '^[0-9]{1,20}$'),
    brand text NOT NULL CHECK (brand IN ('Hyundai','Kia','Genesis')),
    country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    conv_basis smallint NOT NULL CHECK (conv_basis IN (1,2)),
    conv_events text[] NOT NULL DEFAULT '{}',
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ga4_registry_events CHECK (CASE conv_basis WHEN 1 THEN conv_events='{}'
        ELSE cardinality(conv_events) BETWEEN 1 AND 50 AND array_position(conv_events,NULL) IS NULL END)
);
CREATE UNIQUE INDEX ga4_registry_market ON analytics.ga4_registry(brand,country) WHERE enabled;
-- A registry change as the screen shows it: changes = {field: [before, after]}. actor_id is the operations DB
-- system.user_account.user_id (no key across the two databases).
CREATE TABLE analytics.ga4_registry_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    property_id text NOT NULL REFERENCES analytics.ga4_registry(property_id),
    action text NOT NULL CHECK (action IN ('create','update','stop','resume')),
    actor_id uuid,
    changes jsonb NOT NULL DEFAULT '{}',
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ga4_registry_event_property ON analytics.ga4_registry_event(property_id,occurred_at);
-- The collector's last result for each property, replaced on every run: collected (rows written through
-- collected_to), pending_grant (GA4 refused the property), failed (another GA4 error), stopped (the registry
-- stops it: ga4_property became unmapped). collected_at / collected_to keep the last successful collection.
CREATE TABLE analytics.ga4_collect_status (
    property_id text PRIMARY KEY REFERENCES analytics.ga4_registry(property_id),
    checked_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('collected','pending_grant','failed','stopped')),
    error text CHECK (length(error)<=500),
    collected_at timestamptz,
    collected_to date
);
GRANT SELECT ON analytics.ga4_registry,analytics.ga4_registry_event,analytics.ga4_collect_status TO hmg_analytics_reader;
GRANT SELECT ON analytics.ga4_registry TO hmg_analytics_writer;
GRANT SELECT,INSERT,UPDATE ON analytics.ga4_collect_status TO hmg_analytics_writer;
-- The API's registry role: the registry and its history, nothing else (no DELETE, no new property id).
GRANT USAGE ON SCHEMA analytics TO hmg_ga4_registry_editor;
GRANT SELECT,INSERT ON analytics.ga4_registry TO hmg_ga4_registry_editor;
GRANT UPDATE(brand,country,conv_basis,conv_events,enabled,updated_at) ON analytics.ga4_registry TO hmg_ga4_registry_editor;
GRANT SELECT,INSERT ON analytics.ga4_registry_event TO hmg_ga4_registry_editor;
GRANT SELECT ON analytics.ga4_collect_status TO hmg_ga4_registry_editor;
