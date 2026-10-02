-- 값 갭 보강(BG-28~31) 테스트 조각(소유자 실행 준비, API 문장 아님. core 세이브포인트 안에서 넣고 시험 끝에 되돌린다). '-- @이름' 줄로 나눈다.
-- 키 920~929, property_id 7001~7009(숫자: 전환 이벤트 경로 형식) 만 쓴다(모듈 시드 901~903·회귀 905~909 와 겹치지 않음).

-- @days
-- 901(Kia IT) 에 7일 창 밖·28일 창 안 행: 08-20 AI(chatgpt, mobile·new) 세션 40·페이지뷰 50, 09-01 비AI 세션 1000.
-- 최신 적재일 09-11 기준 7일 = 09-05~09-11(무변화), 28일 = 08-15~09-11(AI +40, 비AI +1000).
SELECT rd.ensure_month_leaf('rd.ga4_row'::regclass, DATE '2026-08-01');
INSERT INTO rd.ga4_row (prop_key, date, report, channel_key, source_key, device_key, nvr_key, page_key, event_key, is_ai, engine_key, is_conv,
                        sessions, page_views)
SELECT 901, x.d, x.rep, x.ch, x.src, 9001, 9001, 0, 0, x.ai,
       CASE WHEN x.ai THEN (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt') ELSE 0 END, false, x.s, x.pv
  FROM (VALUES (DATE '2026-08-20', 1, 9001, 9001, true, 40, NULL::int), (DATE '2026-08-20', 2, 9001, 9001, true, 40, 50),
               (DATE '2026-09-01', 1, 9002, 9003, false, 1000, NULL::int)) x(d, rep, ch, src, ai, s, pv);

-- @events
-- 레지스트리: 7001 Kia FR active · 7002 Hyundai DE pending_grant(적재 투영 없음). 추적 이벤트: 7001 purchase.
-- 적재 투영: 920 = 7001(registry, conv_basis 2) · 921 = 7003(project_override, Hyundai US 비트·국가지만 프로젝트 자체 속성, conv_basis 1).
-- 이벤트 보고서(오늘 KST - 1): 7001 purchase 5 · page_view 3, 7003 purchase 2.
-- 921 트래픽(09-11): AI(chatgpt) 세션 7, 비AI 세션 70, AI 전환 key_events 1(비AI 전환 없음).
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status) VALUES
  ('7001', 'Kia', 'FR', 'active'), ('7002', 'Hyundai', 'DE', 'pending_grant');
INSERT INTO app.ga4_tracked_event (property_id, event_name) VALUES ('7001', 'purchase');
INSERT INTO rd.ga4_dim_property (prop_key, property_id, brand_bit, geo_key, status, source, conv_basis)
SELECT x.k, x.pid, (SELECT brand_bit FROM app.brand WHERE brand_code = x.b), (SELECT geo_key FROM rd.dim_country WHERE code = x.c),
       'active', x.src, x.cb
  FROM (VALUES (920, '7001', 'Kia', 'FR', 'registry', 2), (921, '7003', 'Hyundai', 'US', 'project_override', 1)) x(k, pid, b, c, src, cb);
SELECT rd.ensure_month_leaf('rd.ga4_row'::regclass, rd.today_kst() - 1);
INSERT INTO rd.ga4_row (prop_key, date, report, channel_key, source_key, device_key, nvr_key, page_key, event_key, is_ai, engine_key, is_conv,
                        event_count, key_events)
SELECT x.p, rd.today_kst() - 1, 3, 9002, 9003, 9002, 9002, 0, x.ev, false, 0, x.conv, x.n, NULL
  FROM (VALUES (920, 9001, true, 5), (920, 9002, false, 3), (921, 9001, false, 2)) x(p, ev, conv, n);
INSERT INTO rd.ga4_row (prop_key, date, report, channel_key, source_key, device_key, nvr_key, page_key, event_key, is_ai, engine_key, is_conv,
                        sessions, page_views, key_events, event_count)
SELECT 921, DATE '2026-09-11', x.rep, CASE WHEN x.ai THEN 9001 ELSE 9002 END, CASE WHEN x.ai THEN 9001 ELSE 9003 END, 9001, 9001, 0, x.ev, x.ai,
       CASE WHEN x.ai THEN (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt') ELSE 0 END, x.conv, x.s, x.pv, x.ke, x.ec
  FROM (VALUES (1, true, 0, false, 7, NULL::int, NULL::int, NULL::int), (1, false, 0, false, 70, NULL, NULL, NULL),
               (2, true, 0, false, 7, 9, NULL, NULL), (3, true, 9001, true, NULL, NULL, 1, NULL)) x(rep, ai, ev, conv, s, pv, ke, ec);

-- @override
-- 검증 D1·D2·D4 회귀(events 조각과 같이 쓴다). 레지스트리: 7004 Kia BE unmapped(시장 귀속, 속성 id 있음, D4)
-- · 7008 브랜드·국가 없음 unmapped(매핑 전, 적재 없음, D2).
-- 적재 투영: 922 = 7006(project_override, Kia FR 비트·국가: 다른 시장 프로젝트 속성) · 923 = 7007(registry 출처, 시장 미귀속).
-- 두 속성 모두 09-11 AI(chatgpt) 세션 13·비AI 세션 130: 프로젝트 몫이 아니면 한 줄도 읽히면 안 된다.
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status) VALUES
  ('7004', 'Kia', 'BE', 'unmapped'), ('7008', NULL, NULL, 'unmapped');
INSERT INTO rd.ga4_dim_property (prop_key, property_id, brand_bit, geo_key, status, source, conv_basis)
SELECT x.k, x.pid, (SELECT brand_bit FROM app.brand WHERE brand_code = x.b), (SELECT geo_key FROM rd.dim_country WHERE code = x.c),
       'active', x.src, 1
  FROM (VALUES (922, '7006', 'Kia', 'FR', 'project_override'), (923, '7007', NULL, NULL, 'registry')) x(k, pid, b, c, src);
INSERT INTO rd.ga4_row (prop_key, date, report, channel_key, source_key, device_key, nvr_key, page_key, event_key, is_ai, engine_key, is_conv,
                        sessions, page_views)
SELECT x.p, DATE '2026-09-11', x.rep, CASE WHEN x.ai THEN 9001 ELSE 9002 END, CASE WHEN x.ai THEN 9001 ELSE 9003 END, 9001, 9001, 0, 0, x.ai,
       CASE WHEN x.ai THEN (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt') ELSE 0 END, false, x.s, NULL
  FROM (VALUES (922, 1, true, 13), (922, 1, false, 130), (922, 2, true, 13),
               (923, 1, true, 13), (923, 1, false, 130), (923, 2, true, 13)) x(p, rep, ai, s);
