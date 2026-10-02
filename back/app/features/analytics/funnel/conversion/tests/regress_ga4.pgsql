-- conversion 회귀 테스트(test_conversion_regress.py) 조각(소유자 실행 준비, API 문장 아님. core 세이브포인트 안에서 넣고 시험 끝에 되돌린다). '-- @이름' 줄로 조각을 나눈다.
-- 키 905~909, property_id 't-ga4-rg-*' 만 쓴다(모듈 시드 901~903 과 겹치지 않음). 세션 행은 09-11 하루치 report 1(비AI)·2(AI chatgpt).

-- @d1
-- Hyundai N × KR active(907): AI 3, 비AI 30. 가상 코드 HYUNDAI-N 이면 이 시장만 남아야 한다
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status) VALUES ('t-ga4-rg-hyn-kr', 'Hyundai N', 'KR', 'active');
INSERT INTO rd.ga4_dim_property (prop_key, property_id, brand_bit, geo_key, status, source, conv_basis)
SELECT 907, 't-ga4-rg-hyn-kr', (SELECT brand_bit FROM app.brand WHERE brand_code = 'Hyundai N'),
       (SELECT geo_key FROM rd.dim_country WHERE code = 'KR'), 'active', 'registry', 1;
INSERT INTO rd.ga4_row (prop_key, date, report, channel_key, source_key, device_key, nvr_key, page_key, event_key, is_ai, engine_key, is_conv,
                        sessions, page_views)
SELECT x.p, DATE '2026-09-11', x.rep, x.ch, x.src, 9002, 9002, 0, 0, x.ai,
       CASE WHEN x.ai THEN (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt') ELSE 0 END, false, x.s, x.pv
  FROM (VALUES (907, 1, 9002, 9003, false, 30, NULL::int), (907, 2, 9001, 9001, true, 3, 1)) x(p, rep, ch, src, ai, s, pv);

-- @d2
-- Hyundai US 적재 투영(rd.ga4_dim_property)에 속성 셋을 더한다: 905 pending_grant(registry) · 906 active(project_override, 프로젝트 자체 속성)
-- · 908 active(registry, 902 보다 큰 prop_key). 선택 규칙(active 우선 → prop_key 작은 것)이면 902 만 읽히고 1111·2222·3333 은 안 보인다.
-- 레지스트리(app.ga4_property)에는 같은 시장 행을 더하지 않는다: DB-v2.6 P45 ga4_property_market_uq(brand_code, country_code)가 거부한다
-- (@d2_dup_registry 로 따로 단언). 적재 투영은 시장 유니크가 없어(PK prop_key·UNIQUE property_id 뿐) 교체된 옛 속성·env 출처 행이
-- 같은 시장에 남을 수 있으므로 서비스의 결정성 규칙은 여전히 필요하다.
INSERT INTO rd.ga4_dim_property (prop_key, property_id, brand_bit, geo_key, status, source, conv_basis)
SELECT x.k, x.pid, (SELECT brand_bit FROM app.brand WHERE brand_code = 'Hyundai'), (SELECT geo_key FROM rd.dim_country WHERE code = 'US'),
       x.st, x.src, 1
  FROM (VALUES (905, 't-ga4-rg-hy-us-old', 'pending_grant', 'registry'), (906, 't-ga4-rg-hy-us-proj', 'active', 'project_override'),
               (908, 't-ga4-rg-hy-us-new', 'active', 'registry')) x(k, pid, st, src);
INSERT INTO rd.ga4_row (prop_key, date, report, channel_key, source_key, device_key, nvr_key, page_key, event_key, is_ai, engine_key, is_conv,
                        sessions, page_views)
SELECT x.p, DATE '2026-09-11', x.rep, CASE WHEN x.rep = 2 THEN 9001 ELSE 9002 END, CASE WHEN x.rep = 2 THEN 9001 ELSE 9003 END,
       9002, 9002, 0, 0, x.rep = 2,
       CASE WHEN x.rep = 2 THEN (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt') ELSE 0 END, false, x.s, NULL
  FROM (VALUES (905, 1, 1111), (905, 2, 1111), (906, 1, 2222), (906, 2, 2222), (908, 1, 3333), (908, 2, 3333)) x(p, rep, s);

-- @touch
-- 값 무변화 UPDATE: 행 내용은 같고 물리 위치만 바뀐다($1 = prop_key)
UPDATE rd.ga4_dim_property SET status = status WHERE prop_key = $1;

-- @touch_registry
UPDATE app.ga4_property SET status = status WHERE property_id = 't-ga4-hy-us';

-- @d2_no_active
-- Hyundai US 의 active 후보를 모두 없앤다(906·908 삭제, 902 pending_grant). 남는 후보는 902·905 둘 다 pending_grant
DELETE FROM rd.ga4_dim_property WHERE prop_key IN (906, 908);
UPDATE rd.ga4_dim_property SET status = 'pending_grant' WHERE prop_key = 902;

-- @d2_restore
UPDATE rd.ga4_dim_property SET status = 'active' WHERE prop_key = 902;

-- @d2_dup_registry
-- 같은 시장(Hyundai, US)의 두 번째 레지스트리 행: DB-v2.6 P45 ga4_property_market_uq 가 23505 로 거부해야 한다(시드 't-ga4-hy-us' 가 이미 있다)
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status) VALUES ('t-ga4-rg-hy-us-dup', 'Hyundai', 'US', 'active');
