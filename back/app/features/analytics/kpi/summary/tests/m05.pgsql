-- 동기화 S1 BE-B(글로벌 ⑤ 분자 = 출처 카테고리 Official (HMG)) 값 동치 시험용 준비 문장(소유자 실행, API 문장 아님). 고객 데이터 아님.
-- test_sync_s1_m05.py 가 "-- name:" 단위로 읽어 core 롤백 전용 준비(tests.support.staged, Sql 단계 = 드라이버 직접)로 실행한다.
-- 복사 명세 표 _m05(ak 새 답변 키, src 원본 답변 키(글로벌 회차 11), geo·eng 새 국가·엔진 코드(NULL = 원본), cyc·rd 새 회차 키·회차일
-- (NULL = 원본), srcmap 인용 ord → 새 출처 그룹 키)를 채운 뒤 copy(job·answer·citation 복사, 생성 열 제외) → recount(인용 수 열 정본 재계산 +
-- 엄격 단언) 순서로 돈다. 소유(owner_key)는 원본 그대로라 종전 분자(base URL 자사)와 새 분자(카테고리)가 갈라진다.

-- name: spread
DROP TABLE IF EXISTS _m05;
CREATE TEMP TABLE _m05 (ak int, src int, geo text, eng text, cyc int, rd date, srcmap jsonb) ON COMMIT DROP;
INSERT INTO _m05 VALUES
  (9501, 1, 'DE', 'gemini', NULL, NULL, '{"2": "hyundai.com", "4": "hyundai.com", "10": "bmwusa.com"}'),
  (9502, 1, 'KR', 'chatgpt', NULL, NULL, '{"1": "reddit.com", "9": "reddit.com"}'),
  (9503, 1, 'US', 'gemini', NULL, NULL, '{}');

-- name: two_rounds
DROP TABLE IF EXISTS _m05;
CREATE TEMP TABLE _m05 (ak int, src int, geo text, eng text, cyc int, rd date, srcmap jsonb) ON COMMIT DROP;
INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date, hidden_scope,
                      generation, hidden_reason, expected_units, completed_units, completed_answers, gap_answers)
VALUES (900, md5('m05-900')::uuid, 1, 1, true, '2026-09-10', '2026-09-10', 2, true, '2026-09-12', 0, 1, 0, 1, 1, 1, 0);
INSERT INTO _m05 VALUES (9601, 1, NULL, NULL, 900, '2026-09-10', '{"3": "reddit.com"}');

-- name: copy
DO $c$
DECLARE m record; t text; cols text; sel text; w text;
BEGIN
  FOR m IN SELECT * FROM _m05 ORDER BY ak LOOP
    FOREACH t IN ARRAY ARRAY['job', 'answer', 'citation'] LOOP
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
             string_agg(CASE a.attname
                          WHEN 'answer_key' THEN m.ak::text
                          WHEN 'job_id' THEN quote_literal(md5('m05-' || m.ak)) || '::uuid'
                          WHEN 'geo_key' THEN CASE WHEN m.geo IS NULL THEN 'x.geo_key'
                                                   ELSE format('(SELECT geo_key FROM rd.dim_country WHERE code = %L)', m.geo) END
                          WHEN 'region_geo_key' THEN CASE WHEN m.geo IS NULL THEN 'x.region_geo_key'   -- DB-v2.15 P87: 글로벌은 geo_key 와 같다
                                                          ELSE format('(SELECT geo_key FROM rd.dim_country WHERE code = %L)', m.geo) END
                          WHEN 'engine_key' THEN CASE WHEN m.eng IS NULL THEN 'x.engine_key'
                                                      ELSE format('(SELECT engine_key FROM rd.dim_engine WHERE code = %L)', m.eng) END
                          WHEN 'cyc_key' THEN coalesce(m.cyc::text, 'x.cyc_key')
                          WHEN 'round_date' THEN coalesce(quote_literal(m.rd) || '::date', 'x.round_date')
                          WHEN 'anchor_date' THEN coalesce(quote_literal(m.rd) || '::date', 'x.anchor_date')
                          WHEN 'source_key' THEN format('coalesce((SELECT s.source_key FROM rd.dim_source s WHERE s.skey = (%L::jsonb ->> x.ord::text)), x.source_key)',
                                                        m.srcmap::text)
                          ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum)
        INTO cols, sel
        FROM pg_attribute a
       WHERE a.attrelid = ('rd.' || t)::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
      w := CASE t WHEN 'job' THEN format('x.answer_key = %s', m.src)
                  ELSE format('x.surface = 1 AND x.round_date = %L AND x.answer_key = %s', '2026-09-14', m.src) END;
      EXECUTE format('INSERT INTO rd.%I (%s) SELECT %s FROM rd.%I x WHERE %s', t, cols, sel, t, w);
    END LOOP;
  END LOOP;
END $c$;

-- name: recount
UPDATE rd.answer a
   SET cit_n = x.cit_n, cit_own_h = x.cit_own_h, cit_own_k = x.cit_own_k, cit_own_g = x.cit_own_g, cit_own_hc = x.cit_own_hc,
       cit_own_kc = x.cit_own_kc, cit_own_gc = x.cit_own_gc, cit_own_x = x.cit_own_x, cit_loc = x.cit_loc, cit_tgt = x.cit_tgt,
       cit_loc_tgt = x.cit_loc_tgt, cit_off = x.cit_off, has_cit = x.cit_n > 0, tgt_cited = x.cit_tgt > 0, own_url_cited = x.cit_loc_tgt > 0
  FROM rd.answer_cit_counts((SELECT array_agg(answer_key) FROM rd.job WHERE served)) x
 WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key;
SELECT rd.assert_answer_cit_counts((SELECT array_agg(answer_key) FROM rd.job WHERE served), true);
-- DB-v2.15 P86(WU-5): 재투영과 같은 cit_n_all·cit_c1..13(정본 재계산 rd.answer_cit_ext). /v1/citations/sources 답변 열 경로가 읽는다
UPDATE rd.answer a SET cit_n_all = coalesce(x.cit_n_all, 0)::int2, cit_c1 = coalesce(x.cit_c1, 0)::int2, cit_c2 = coalesce(x.cit_c2, 0)::int2, cit_c3 = coalesce(x.cit_c3, 0)::int2, cit_c4 = coalesce(x.cit_c4, 0)::int2, cit_c5 = coalesce(x.cit_c5, 0)::int2, cit_c6 = coalesce(x.cit_c6, 0)::int2, cit_c7 = coalesce(x.cit_c7, 0)::int2, cit_c8 = coalesce(x.cit_c8, 0)::int2, cit_c9 = coalesce(x.cit_c9, 0)::int2, cit_c10 = coalesce(x.cit_c10, 0)::int2, cit_c11 = coalesce(x.cit_c11, 0)::int2, cit_c12 = coalesce(x.cit_c12, 0)::int2, cit_c13 = coalesce(x.cit_c13, 0)::int2
  FROM rd.answer a2
  LEFT JOIN rd.answer_cit_ext(NULL) x ON x.surface = a2.surface AND x.round_date = a2.round_date AND x.answer_key = a2.answer_key
 WHERE a.surface = a2.surface AND a.round_date = a2.round_date AND a.answer_key = a2.answer_key;

-- name: override_pending
-- 운영자 오버라이드 저장(app 원본만, 재판정 전): caranddriver.com(Automotive Media) → Official (HMG)
SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true);
INSERT INTO app.citation_domain_override (domain, category_key)
SELECT 'caranddriver.com', category_key FROM app.citation_category WHERE name = 'Official (HMG)';

-- name: override_reflected
-- 재판정(judgment_change 'citation_override') 결과와 같은 차원 상태: 출처 카테고리 갱신(category_src 1 = 오버라이드). 뒤에 recount 를 돈다
UPDATE rd.dim_source SET category_key = (SELECT category_key FROM app.citation_category WHERE name = 'Official (HMG)'), category_src = 1
 WHERE skey = 'caranddriver.com';
