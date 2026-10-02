-- DB 설계 v2 스모크: 빈 PG17 에 DB-보정.sql + DB-v2-roles.sql 적용 후 실행. 합성 행만 쓴다(고객 데이터 없음).
-- 결과는 NOTICE 'OK …' / 'FAIL …' 로 낸다. ON_ERROR_STOP 은 끄고 돌린다(기대 실패를 잡기 위해).
\pset footer off
SET client_min_messages = notice;

\echo ===== T1 ensure_leaf: 소유자 아닌 적재기 호출(수정 전 = SECURITY INVOKER 재현)
ALTER FUNCTION rd.ensure_leaf(int2, date) SECURITY INVOKER;
SET ROLE loader;
DO $$ BEGIN PERFORM rd.ensure_leaf(1::int2, date '2026-08-01'); RAISE NOTICE 'FAIL(예상과 다름) invoker 로 leaf 생성됨';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK 재현: invoker 는 leaf 생성 불가 → %', SQLERRM; END $$;
RESET ROLE;
ALTER FUNCTION rd.ensure_leaf(int2, date) SECURITY DEFINER;
SET ROLE loader;
DO $$ DECLARE d date; BEGIN
  FOR d IN SELECT generate_series(date '2025-10-01', date '2026-09-01', interval '1 month')::date LOOP
    PERFORM rd.ensure_leaf(1::int2, d);
  END LOOP;
  RAISE NOTICE 'OK definer 로 12개월 leaf 생성: rd.answer_g leaf % 개', (SELECT count(*) FROM pg_inherits WHERE inhparent = 'rd.answer_g'::regclass);
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL definer leaf 생성: %', SQLERRM; END $$;
RESET ROLE;

\echo ===== T2 ing 파티션 leaf 생성 경로(설계에 헬퍼 없음)
SELECT count(*) AS ing_answer_leaves FROM pg_inherits WHERE inhparent = 'ing.answer'::regclass;
-- v2: 적재기가 rd.ensure_month_leaf 로 만든다
SET ROLE loader;
DO $$ DECLARE p regclass; BEGIN
  FOREACH p IN ARRAY ARRAY['ing.answer','ing.mention','ing.mention_occurrence','ing.answer_stance','ing.citation','ing.ga4_row','rd.ga4_row',
                           'app.access_audit_log','ext.dfs_call']::regclass[] LOOP
    PERFORM rd.ensure_month_leaf(p, date '2026-09-15');
  END LOOP;
  RAISE NOTICE 'OK 월 leaf 9 부모 생성, ing.answer leaf % 개', (SELECT count(*) FROM pg_inherits WHERE inhparent = 'ing.answer'::regclass);
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL ensure_month_leaf: %', SQLERRM; END $$;
DO $$ BEGIN PERFORM rd.ensure_month_leaf('rd.answer'::regclass, date '2026-09-01'); RAISE NOTICE 'FAIL 허용 목록 밖 부모 통과';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK 허용 목록 밖 거부'; END $$;
INSERT INTO app.access_audit_log (ts, actor_id, actor_role, kind, action) VALUES ('2026-09-30 23:30+09', gen_random_uuid(), 'hq', 'api_read', 'smoke');
RESET ROLE;

\echo ===== T3 적재 경로: loader 가 job·answer·자식 투영 쓰기
SET ROLE loader;
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('00000000-0000-0000-0000-000000000001', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, target, status, content_hash, load_id, answer_text)
  SELECT '2026-09-01', job_id, answer_key, '00000000-0000-0000-0000-0000000000aa', 'chatgpt', 'completed', '\x00', 1, '합성 본문'
    FROM ing.answer_key_map WHERE job_id = '00000000-0000-0000-0000-000000000001';
INSERT INTO rd.job (answer_key, job_id, run_key, cyc_key, round_date, surface, project_key, engine_key, geo_key, lang_key, bgrp, status_code, served, load_id)
  SELECT answer_key, job_id, 1, 1, '2026-09-07', 1, 1, 1, 1, 1, 1, 0, true, 1 FROM ing.answer_key_map;
INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                       cat_mask, bgrp, anchor_src, analysis_state, elig, dflt, rule_ver, load_id)
  SELECT '2026-09-07', answer_key, '2026-09-07', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, true, true, 1, 1 FROM ing.answer_key_map;
INSERT INTO rd.answer_brand (round_date, answer_key, brand_key, cyc_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key, bgrp,
                             own_bit, entity_rows, mention_count, s_pos, s_neu, s_neg, s_mix, t_mention, t_recommendation, t_comparison,
                             t_definition, t_final_choice, competitive, std_in, elig, dflt, rule_ver)
  SELECT '2026-09-07', answer_key, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 0, 0, 1, 0, 0, 0, 0, true, true, true, true, 1 FROM ing.answer_key_map;
INSERT INTO rd.citation (round_date, answer_key, url_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key, lang_key, bgrp,
                         scope_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver)
  SELECT '2026-09-07', answer_key, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, true, false, true, false, false, true, 1 FROM ing.answer_key_map;
INSERT INTO rd.answer_stance (round_date, answer_key, entity_key, surface, turn_index, own_bit, stance, first_turn, std_in)
  SELECT '2026-09-07', answer_key, 1, 1, 0, 1, 1, true, true FROM ing.answer_key_map;
SELECT 'OK 적재 쓰기' AS t3, (SELECT std_in FROM rd.answer) AS answer_std_in;

\echo ===== T4 게이트 전파: 답변 elig=false → 자식 사본 3표 맞춤
UPDATE rd.answer SET elig = false WHERE answer_key = 1;
SELECT rd.propagate_answer_gates('{1}') AS propagated_rows;
SELECT (SELECT std_in FROM rd.answer_brand) AS ab_std_in, (SELECT elig FROM rd.answer_brand) AS ab_elig,
       (SELECT cit_in FROM rd.citation) AS cit_in, (SELECT std_in FROM rd.answer_stance) AS st_std_in;
\echo -- 재호출은 0 이어야(멱등)
SELECT rd.propagate_answer_gates('{1}') AS propagated_again;
RESET ROLE;

\echo ===== T5 권한: api_ro
SET ROLE api_ro;
DO $$ BEGIN PERFORM 1 FROM ing.answer LIMIT 1; RAISE NOTICE 'FAIL api_ro 가 ing.answer 를 읽음';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK api_ro ing.answer 거부'; END $$;
DO $$ BEGIN PERFORM 1 FROM rd.answer LIMIT 1; RAISE NOTICE 'OK api_ro rd.answer 읽기';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL api_ro rd.answer: %', SQLERRM; END $$;
DO $$ DECLARE t text; BEGIN SELECT answer_text INTO t FROM rd.v_answer_body WHERE answer_key = 1; RAISE NOTICE 'OK api_ro 뷰 경유 본문 = %', t;
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL api_ro 뷰 경유: %', SQLERRM; END $$;
DO $$ BEGIN INSERT INTO app.judgment_change (kind) VALUES ('catalog'); RAISE NOTICE 'FAIL api_ro 가 app 에 씀';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK api_ro app 쓰기 거부'; END $$;
RESET ROLE;

\echo ===== T6 권한: api_rw
SET ROLE api_rw;
DO $$ BEGIN INSERT INTO app.judgment_change (kind) VALUES ('catalog'); RAISE NOTICE 'OK api_rw 재판정 요청 INSERT';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL api_rw judgment_change: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.judgment_change SET status = 'applied'; RAISE NOTICE 'FAIL api_rw 가 큐 상태를 바꿈';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK api_rw 큐 상태 전이 거부'; END $$;
DO $$ BEGIN UPDATE rd.answer SET elig = true; RAISE NOTICE 'FAIL api_rw 가 rd 에 씀';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK api_rw rd 쓰기 거부'; END $$;
RESET ROLE;

\echo ===== T7 R08 발행 비율: 완료 100·결손 3 → 0.97 (완료 비율)
INSERT INTO ing.cycle (surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status, completed_answers, gap_answers)
  VALUES ('global', '00000000-0000-0000-0000-0000000000bb', '2026-09-07 00:00+09', 'scope', '2026-09-07', '2026-09-07', 'open', 100, 3);
SELECT analysis_done_ratio FROM ing.cycle;

\echo ===== T8 전파 함수의 답변 탐색 계획(answer_key 단독 인덱스 부재)
INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                       cat_mask, bgrp, anchor_src, analysis_state, elig, dflt, rule_ver, load_id)
  SELECT d::date + (g % 28), 100 + g, d::date, 1, 1, g % 500, 1, 1, g % 3, g % 60, 1, 1, 1, 1, 0, true, true, 1, 1
    FROM generate_series(date '2025-10-01', date '2026-09-01', interval '1 month') d, generate_series(1, 20000) g
   WHERE d::date + (g % 28) < (d + interval '1 month')::date;
ANALYZE rd.answer, rd.answer_brand, rd.citation, rd.job;
SELECT count(*) AS rd_answer_rows FROM rd.answer;
\echo -- 현행 설계: rd.answer 를 answer_key = ANY 로 직접 찾음
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT count(*) FROM rd.answer a WHERE a.answer_key = ANY('{150,5000,90000}');
\echo -- 대안: rd.job(answer_key PK)으로 파티션 키를 얻어 등치 조인(실행 시 가지치기)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
  SELECT count(*) FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY('{1}');

\echo ===== T9 v2 전파 함수: 위치 불일치 단언 + answer_key 중복 감사
SET ROLE loader;
UPDATE rd.answer SET elig = true WHERE answer_key = 1;
SELECT rd.propagate_answer_gates('{1}') AS propagated_v2;
SELECT (SELECT elig FROM rd.answer_brand WHERE answer_key = 1) AS ab_elig_after;
UPDATE rd.job SET round_date = '2026-09-14' WHERE answer_key = 1;   -- 재투영 누락 흉내
DO $$ BEGIN PERFORM rd.propagate_answer_gates('{1}'); RAISE NOTICE 'FAIL 위치 불일치를 못 잡음';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK 위치 불일치 단언: %', SQLERRM; END $$;
UPDATE rd.job SET round_date = '2026-09-07' WHERE answer_key = 1;
RESET ROLE;
SELECT count(*) AS dup_answer_keys FROM (SELECT answer_key FROM rd.answer GROUP BY 1 HAVING count(*) > 1) d;
\echo -- v2 전파 함수 내부 조인 계획(rd.job 경유)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
UPDATE rd.answer_brand c SET std_in = a.std_in
  FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.answer_key = ANY('{1}') AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
   AND c.std_in IS DISTINCT FROM a.std_in;
