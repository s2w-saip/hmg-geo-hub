-- conversion 테스트 시드(소유자 접속 전용, API 문장 아님). conftest.py 가 읽어 실행한다.
SELECT rd.ensure_month_leaf('rd.ga4_row'::regclass, d) FROM (VALUES (DATE '2026-05-01'), (DATE '2026-09-01')) v(d);
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status) VALUES
  ('t-ga4-kia-it', 'Kia', 'IT', 'active'), ('t-ga4-hy-us', 'Hyundai', 'US', 'active'),
  ('t-ga4-kia-de', 'Kia', 'DE', 'pending_grant'), ('t-ga4-gen-kr', 'Genesis', 'KR', 'unmapped');
INSERT INTO rd.ga4_dim_property (prop_key, property_id, brand_bit, geo_key, status, source, conv_basis)
SELECT x.k, x.pid, (SELECT brand_bit FROM app.brand WHERE brand_code = x.b), (SELECT geo_key FROM rd.dim_country WHERE code = x.c), x.s, 'registry', x.cb
  FROM (VALUES (901, 't-ga4-kia-it', 'Kia', 'IT', 'active', 2), (902, 't-ga4-hy-us', 'Hyundai', 'US', 'active', 1),
               (903, 't-ga4-kia-de', 'Kia', 'DE', 'pending_grant', 1)) x(k, pid, b, c, s, cb);
INSERT INTO rd.ga4_dim_value (kind, value_key, value) VALUES
  ('device', 9001, 'mobile'), ('device', 9002, 'desktop'), ('nvr', 9001, 'new'), ('nvr', 9002, 'returning'),
  ('page', 9001, '/a'), ('page', 9002, '/b'), ('event', 9001, 'purchase'), ('event', 9002, 'page_view'),
  ('channel', 9001, 'AI Assistant'), ('channel', 9002, 'Organic Search'),
  ('source', 9001, 'chatgpt.com'), ('source', 9002, 'gemini.google.com'), ('source', 9003, 'google');
WITH e AS (SELECT (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt') AS gpt,
                  (SELECT engine_key FROM rd.dim_engine WHERE code = 'gemini') AS gem)
INSERT INTO rd.ga4_row (prop_key, date, report, channel_key, source_key, device_key, nvr_key, page_key, event_key, is_ai, engine_key, is_conv,
                        sessions, page_views, key_events, event_count)
SELECT v.p, v.d::date, v.rep, CASE WHEN v.ai THEN 9001 ELSE 9002 END,
       CASE v.eng WHEN 'gpt' THEN 9001 WHEN 'gem' THEN 9002 ELSE 9003 END,
       v.dev, v.nvr, v.page, v.ev, v.ai, CASE v.eng WHEN 'gpt' THEN e.gpt WHEN 'gem' THEN e.gem ELSE 0 END, v.conv,
       v.sess, v.pv, v.ke, v.ec
  FROM e, (VALUES
    (901, '2026-09-10', 1, true,  'gpt', 9001, 9001, 0,    0,    false, 10,   NULL, NULL, NULL),
    (901, '2026-09-10', 1, false, '',    9002, 9002, 0,    0,    false, 100,  NULL, NULL, NULL),
    (901, '2026-09-11', 1, true,  'gem', 9002, 9001, 0,    0,    false, 5,    NULL, NULL, NULL),
    (901, '2026-09-11', 1, false, '',    9001, 9001, 0,    0,    false, 50,   NULL, NULL, NULL),
    (901, '2026-05-01', 1, false, '',    9001, 9001, 0,    0,    false, 999,  NULL, NULL, NULL),
    (901, '2026-09-10', 2, true,  'gpt', 9001, 9001, 0,    0,    false, 10,   30,   NULL, NULL),
    (901, '2026-09-11', 2, true,  'gem', 9002, 9001, 0,    0,    false, 5,    8,    NULL, NULL),
    (901, '2026-09-10', 3, true,  'gpt', 9001, 9001, 0,    9001, true,  NULL, NULL, 9,    2),
    (901, '2026-09-10', 3, false, '',    9002, 9002, 0,    9001, true,  NULL, NULL, 99,   7),
    (901, '2026-09-11', 3, true,  'gem', 9002, 9001, 0,    9001, true,  NULL, NULL, 0,    1),
    (901, '2026-09-10', 3, false, '',    9002, 9002, 0,    9002, false, NULL, NULL, NULL, 500),
    (901, '2026-09-10', 4, true,  'gpt', 9001, 9001, 9001, 0,    false, 10,   NULL, NULL, NULL),
    (901, '2026-09-10', 4, false, '',    9002, 9002, 9001, 0,    false, 60,   NULL, NULL, NULL),
    (901, '2026-09-11', 4, false, '',    9001, 9001, 9002, 0,    false, 50,   NULL, NULL, NULL),
    (901, '2026-09-11', 4, true,  'gem', 9002, 9001, 9002, 0,    false, 5,    NULL, NULL, NULL),
    (901, '2026-09-10', 4, true,  'gpt', 9001, 9001, 9001, 9001, true,  NULL, NULL, 9,    2),
    (901, '2026-09-10', 4, false, '',    9002, 9002, 9001, 9001, true,  NULL, NULL, 99,   7),
    (902, '2026-09-11', 1, true,  'gpt', 9001, 9002, 0,    0,    false, 20,   NULL, NULL, NULL),
    (902, '2026-09-11', 1, false, '',    9002, 9002, 0,    0,    false, 200,  NULL, NULL, NULL),
    (902, '2026-09-11', 2, true,  'gpt', 9001, 9002, 0,    0,    false, 20,   40,   NULL, NULL),
    (902, '2026-09-11', 3, true,  'gpt', 9001, 9002, 0,    9001, true,  NULL, NULL, 4,    50),
    (902, '2026-09-11', 3, false, '',    9002, 9002, 0,    9001, true,  NULL, NULL, 10,   60),
    (902, '2026-09-11', 4, true,  'gpt', 9001, 9002, 9001, 0,    false, 20,   NULL, NULL, NULL),
    (902, '2026-09-11', 4, false, '',    9002, 9002, 9001, 0,    false, 200,  NULL, NULL, NULL),
    (903, '2026-09-11', 1, false, '',    9002, 9002, 0,    0,    false, 7777, NULL, NULL, NULL)
  ) v(p, d, rep, ai, eng, dev, nvr, page, ev, conv, sess, pv, ke, ec);
