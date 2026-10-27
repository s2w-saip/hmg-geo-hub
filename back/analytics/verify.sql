-- Transaction-only probes; nothing from this file is committed or visible to the application.
BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;
INSERT INTO ref.dim_region(region_key,code) VALUES(-32000,'__rollback_probe__');
INSERT INTO ref.dim_country(geo_key,code,region_key) VALUES(-32000,'__rollback_probe__',-32000);
INSERT INTO ref.dim_engine(engine_key,code) VALUES(-32000,'__rollback_probe__');
INSERT INTO ref.dim_project(project_key,surface,site_geo_key) VALUES(-32000,2,-32000);
INSERT INTO ref.dim_url(url_key,url,url_norm) VALUES(-2147483000,'https://rollback-probe.invalid/','https://rollback-probe.invalid/');
INSERT INTO analytics.ga4_property(prop_key,property_id,geo_key,status,source,conv_basis)
    VALUES(-32000,'__rollback_probe__',-32000,'active','registry',1);
INSERT INTO analytics.ga4_value(kind,value_key,value)
    SELECT k,-2147483000,'__rollback_probe__' FROM unnest(ARRAY['channel','source','device','nvr','page','event']) k;
INSERT INTO analytics.dim_crawl_bot(bot_key,code,engine_key) VALUES(-32000,'__rollback_probe__',-32000);
INSERT INTO analytics.ga4_row(prop_key,date,report,channel_key,source_key,device_key,nvr_key,page_key,event_key,
    is_ai,engine_key,is_conv,sessions,users_day,page_views,key_events,event_count)
    VALUES(-32000,'2000-01-01',2,-2147483000,-2147483000,-2147483000,-2147483000,-2147483000,-2147483000,
        true,-32000,false,10,5,20,0,0);
INSERT INTO analytics.ga4_value(kind,value_key,value) VALUES('event',-2147482999,'__event_only_rollback_probe__');

DO $$
DECLARE b1 bigint; b2 bigint; b3 bigint; n bigint;
BEGIN
    BEGIN
        CREATE TABLE analytics.forbidden_writer_ddl(id integer);
        RAISE EXCEPTION 'Writer was able to create a table';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        INSERT INTO analytics.ga4_users_window(prop_key,window_end,window_days,cohort,engine_mask,device_mask,nvr_mask,page_key,users)
        VALUES(-32000,'2000-01-01',28,'ai',0,0,0,-2147482999,1);
        RAISE EXCEPTION 'Missing GA4 page dictionary key was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN
        INSERT INTO analytics.ga4_row(prop_key,date,report,channel_key,source_key,device_key,nvr_key,page_key,event_key)
        VALUES(-32000,'2000-01-02',2,-2147483000,-2147483000,-2147482999,-2147483000,-2147483000,-2147483000);
        RAISE EXCEPTION 'An event dictionary key was accepted as a device';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN
        INSERT INTO analytics.ga4_users_window(prop_key,window_end,window_days,cohort,engine_mask,device_mask,nvr_mask,page_key,users)
        VALUES(-32000,'2000-01-01',28,'ai',0,0,0,-2147483000,-1);
        RAISE EXCEPTION 'Negative GA4 user count was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;

    INSERT INTO ops.build(family,slice_key,status) VALUES('vis','__rollback_probe__1','running') RETURNING build_id INTO b1;
    INSERT INTO analytics.page_visibility_daily VALUES(b1,-32000,-2147483000,-32000,'2000-01-01',10,2);
    INSERT INTO analytics.page_crawl_daily VALUES(b1,-32000,-2147483000,'2000-01-01',-32000,2);
    INSERT INTO analytics.page_seo_device_daily(build_id,project_key,url_key,date,device_key,seo_impressions)
        VALUES(b1,-32000,-2147483000,'2000-01-01',-2147483000,10);
    UPDATE ops.build SET status='validated' WHERE build_id=b1;
    PERFORM ops.publish_seo_build(-32000::smallint,'2000-01-01',b1,NULL);
    BEGIN
        UPDATE analytics.page_visibility_daily SET seo_impressions=11 WHERE build_id=b1;
        RAISE EXCEPTION 'Validated SEO facts were writable';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;

    INSERT INTO ops.build(family,slice_key,status) VALUES('vis','__rollback_probe__2','running') RETURNING build_id INTO b2;
    INSERT INTO analytics.page_visibility_daily VALUES(b2,-32000,-2147483000,-32000,'2000-01-01',20,4);
    INSERT INTO analytics.page_crawl_daily VALUES(b2,-32000,-2147483000,'2000-01-01',-32000,3);
    INSERT INTO analytics.page_seo_device_daily(build_id,project_key,url_key,date,device_key,seo_impressions)
        VALUES(b2,-32000,-2147483000,'2000-01-01',-2147483000,20);
    UPDATE ops.build SET status='validated' WHERE build_id=b2;
    BEGIN
        PERFORM ops.publish_seo_build(-32000::smallint,'2000-01-01',b2,b1);
        RAISE EXCEPTION 'Mismatched SEO crawl sums were published';
    EXCEPTION WHEN check_violation THEN NULL; END;

    INSERT INTO ops.build(family,slice_key,status) VALUES('vis','__rollback_probe__3','running') RETURNING build_id INTO b3;
    INSERT INTO analytics.page_visibility_daily VALUES(b3,-32000,-2147483000,-32000,'2000-01-01',20,4);
    INSERT INTO analytics.page_crawl_daily VALUES(b3,-32000,-2147483000,'2000-01-01',-32000,4);
    INSERT INTO analytics.page_seo_device_daily(build_id,project_key,url_key,date,device_key,seo_impressions)
        VALUES(b3,-32000,-2147483000,'2000-01-01',-2147483000,20);
    UPDATE ops.build SET status='validated' WHERE build_id=b3;
    n := ops.publish_seo_build(-32000::smallint,'2000-01-01',b3,b1);
    IF n<>2 OR (SELECT sum(seo_impressions) FROM analytics.current_page_visibility_daily WHERE project_key=-32000)<>20 THEN
        RAISE EXCEPTION 'Current SEO view mixed historical builds';
    END IF;
    BEGIN
        PERFORM ops.publish_seo_build(-32000::smallint,'2000-01-01',b1,NULL);
        RAISE EXCEPTION 'A stale publication replaced the active build';
    EXCEPTION WHEN serialization_failure THEN NULL; END;
END $$;
ROLLBACK;
