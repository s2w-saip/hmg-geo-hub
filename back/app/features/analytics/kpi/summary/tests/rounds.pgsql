-- KPI(K-1·K-2) 회귀 테스트용 준비 문장(소유자 실행, API 문장 아님). seed.py 가 "-- name:" 단위로 읽어 core 롤백 전용 준비
-- (tests.support.staged)로 실행한다. 준비 SQL 은 데이터 파일로 둔다(back/tests/README.md 6절).
-- 추가 회차는 모두 글로벌 루트 프로젝트(project_key 1), 2026-09 파티션 안이다. 블록이 끝나면 ROLLBACK 이라 치우는 문장이 없다.
--   40  09-01 closed ∧ 비서빙(노출일 없음)         계획 4   원장 안 · 미발행(누락)
--   41  09-03 발행 · 노출 09-05 · 언급 숨김(3)     계획 2   언급 계열 원장 밖, 인용 계열 발행. 답변 4101(k1 사본, 인용 열 복사: 자사 2·공식 4/9)
--   44  09-05 발행 · 노출 09-06                    계획 2   답변 4401(k1 사본)
--   42  09-10 발행 · 노출 09-12                    계획 3   답변 4201(k1 사본)
--   43  09-11 closed ∧ 비서빙                      계획 4   원장 안 · 미발행(누락)

-- name: seed_global
INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date,
                      hidden_scope, generation, hidden_reason, expected_units, completed_units, completed_answers, gap_answers)
VALUES (40, 'f0000000-0000-4000-8000-000000000040', 1, 1, true, '2026-09-01', '2026-09-01', 1, false, NULL, 0, 1, 0, 4, 1, 1, 0),
       (41, 'f0000000-0000-4000-8000-000000000041', 1, 1, true, '2026-09-03', '2026-09-03', 2, true, '2026-09-05', 3, 1, 2, 2, 2, 2, 0),
       (44, 'f0000000-0000-4000-8000-000000000044', 1, 1, true, '2026-09-05', '2026-09-05', 2, true, '2026-09-06', 0, 1, 0, 2, 2, 2, 0),
       (42, 'f0000000-0000-4000-8000-000000000042', 1, 1, true, '2026-09-10', '2026-09-10', 2, true, '2026-09-12', 0, 1, 0, 3, 3, 3, 0),
       (43, 'f0000000-0000-4000-8000-000000000043', 1, 1, true, '2026-09-11', '2026-09-11', 1, false, NULL, 0, 1, 0, 4, 0, 0, 0);
INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key,
                       lang_key, cat_mask, bgrp, anchor_src, acr_iter_rank, analysis_state, own_mask, own_rk_h, own_rk_k, own_rk_g,
                       ment_total, ment_h, ment_k, ment_g, sent_pos_h, sent_pos_k, sent_pos_g, sent_neg_h, sent_neg_k, sent_neg_g,
                       sent_all_h, sent_all_k, sent_all_g, elig, dflt, is_acr, is_rep, web_reg, has_cit, tgt_cited, own_url_cited,
                       rule_ver, load_id, cit_n, cit_own_h, cit_own_k, cit_own_g, cit_own_hc, cit_own_kc, cit_own_gc, cit_own_x, cit_loc,
                       cit_tgt, cit_loc_tgt, cit_off)
SELECT s.rd, s.k, s.rd, s.c, a.run_key, a.prompt_key, a.surface, a.project_key, a.engine_key, a.geo_key,
       a.lang_key, a.cat_mask, a.bgrp, a.anchor_src, a.acr_iter_rank, a.analysis_state, a.own_mask, a.own_rk_h, a.own_rk_k, a.own_rk_g,
       a.ment_total, a.ment_h, a.ment_k, a.ment_g, a.sent_pos_h, a.sent_pos_k, a.sent_pos_g, a.sent_neg_h, a.sent_neg_k, a.sent_neg_g,
       a.sent_all_h, a.sent_all_k, a.sent_all_g, a.elig, a.dflt, a.is_acr, a.is_rep, a.web_reg, a.has_cit, a.tgt_cited, a.own_url_cited,
       a.rule_ver, a.load_id, a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x, a.cit_loc,
       a.cit_tgt, a.cit_loc_tgt, a.cit_off
  FROM rd.answer a
  CROSS JOIN (VALUES (DATE '2026-09-03', 4101, 41), (DATE '2026-09-05', 4401, 44), (DATE '2026-09-10', 4201, 42)) AS s(rd, k, c)
 WHERE a.surface = 1 AND a.round_date = '2026-09-14' AND a.answer_key = 1;

-- name: web_unhide
-- 웹사이트 회차 21(09-18)의 인용 숨김을 풀어 R09 발행값 접기 경로를 태운다.
UPDATE rd.cycle SET hidden_scope = 0, hidden_reason = 0 WHERE cyc_key = 21;

-- name: web_dup_prompt
-- 결정 6(url_prompts): 웹사이트 회차 21 인용 숨김 해제 + k21(프롬프트 8, chatgpt) 사본을 gemini 로 한 건 더(답변 2101, 같은 프롬프트).
-- 기본 엔진 라이브: 답변 3(k21·k22·2101) = 측정 단위 분모 3, 서로 다른 프롬프트 2(8·10) = 프롬프트 단위 분모 2.
UPDATE rd.cycle SET hidden_scope = 0, hidden_reason = 0 WHERE cyc_key = 21;
INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key,
                       lang_key, cat_mask, bgrp, anchor_src, acr_iter_rank, analysis_state, own_mask, own_rk_h, own_rk_k, own_rk_g,
                       ment_total, ment_h, ment_k, ment_g, sent_pos_h, sent_pos_k, sent_pos_g, sent_neg_h, sent_neg_k, sent_neg_g,
                       sent_all_h, sent_all_k, sent_all_g, elig, dflt, is_acr, is_rep, web_reg, has_cit, tgt_cited, own_url_cited,
                       rule_ver, load_id, cit_n, cit_own_h, cit_own_k, cit_own_g, cit_own_hc, cit_own_kc, cit_own_gc, cit_own_x, cit_loc,
                       cit_tgt, cit_loc_tgt, cit_off)
SELECT a.round_date, 2101, a.anchor_date, a.cyc_key, a.run_key, a.prompt_key, a.surface, a.project_key,
       (SELECT engine_key FROM rd.dim_engine WHERE code = 'gemini'), a.geo_key,
       a.lang_key, a.cat_mask, a.bgrp, a.anchor_src, a.acr_iter_rank, a.analysis_state, a.own_mask, a.own_rk_h, a.own_rk_k, a.own_rk_g,
       a.ment_total, a.ment_h, a.ment_k, a.ment_g, a.sent_pos_h, a.sent_pos_k, a.sent_pos_g, a.sent_neg_h, a.sent_neg_k, a.sent_neg_g,
       a.sent_all_h, a.sent_all_k, a.sent_all_g, a.elig, a.dflt, a.is_acr, a.is_rep, a.web_reg, a.has_cit, a.tgt_cited, a.own_url_cited,
       a.rule_ver, a.load_id, a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x, a.cit_loc,
       a.cit_tgt, a.cit_loc_tgt, a.cit_off
  FROM rd.answer a
 WHERE a.surface = 2 AND a.round_date = '2026-09-18' AND a.answer_key = 21;
