-- Resolve only dimensions referenced by explicitly permitted measurements.
CREATE VIEW published.ga4_properties WITH (security_barrier=true) AS
    SELECT DISTINCT g.* FROM analytics.ga4_property g
    JOIN catalog.project_ga4_property p USING(prop_key)
    JOIN publication.project_access a USING(project_id) WHERE a.ga4;
CREATE OR REPLACE VIEW published.ga4_values WITH (security_barrier=true) AS
    SELECT v.* FROM analytics.ga4_value v WHERE EXISTS (
      SELECT 1 FROM published.ga4_daily r CROSS JOIN LATERAL
      (VALUES ('channel',r.channel_key),('source',r.source_key),('device',r.device_key),
              ('nvr',r.nvr_key),('event',r.event_key),('page',r.page_key)) k(kind,value_key)
      WHERE (v.kind,v.value_key)=(k.kind,k.value_key))
    OR (v.kind='page' AND EXISTS(SELECT 1 FROM published.ga4_users_window w WHERE w.page_key=v.value_key))
    OR (v.kind='device' AND EXISTS(SELECT 1 FROM published.seo_device_daily d WHERE d.device_key=v.value_key));
CREATE VIEW published.urls WITH (security_barrier=true) AS
    SELECT u.url_key,u.url,u.title,u.url_norm,u.host,u.domain FROM ref.dim_url u
    WHERE EXISTS(SELECT 1 FROM published.seo_visibility_daily r WHERE r.url_key=u.url_key)
       OR EXISTS(SELECT 1 FROM published.seo_crawl_daily r WHERE r.url_key=u.url_key)
       OR EXISTS(SELECT 1 FROM published.seo_device_daily r WHERE r.url_key=u.url_key)
       OR EXISTS(SELECT 1 FROM published.seo_priority r WHERE r.url_key=u.url_key)
       OR EXISTS(SELECT 1 FROM published.ga4_values v WHERE v.kind='page' AND v.url_key=u.url_key);
CREATE VIEW published.countries WITH (security_barrier=true) AS
    SELECT c.geo_key,c.code FROM ref.dim_country c
    WHERE EXISTS(SELECT 1 FROM published.seo_visibility_daily r WHERE r.geo_key=c.geo_key)
       OR EXISTS(SELECT 1 FROM published.ga4_properties p WHERE p.geo_key=c.geo_key);
CREATE VIEW published.crawl_bots WITH (security_barrier=true) AS
    SELECT b.* FROM analytics.dim_crawl_bot b
    WHERE EXISTS(SELECT 1 FROM published.seo_crawl_daily r WHERE r.bot_key=b.bot_key);
CREATE VIEW published.engines WITH (security_barrier=true) AS
    SELECT e.engine_key,e.code FROM ref.dim_engine e
    WHERE EXISTS(SELECT 1 FROM published.ga4_daily r WHERE r.engine_key=e.engine_key)
       OR EXISTS(SELECT 1 FROM published.crawl_bots b WHERE b.engine_key=e.engine_key);
GRANT SELECT ON ALL TABLES IN SCHEMA published TO hmg_data_external;
