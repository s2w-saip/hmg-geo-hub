-- C-3·C-4 회귀 시험용 추가 합성 행(고객 데이터 아님). core 롤백 전용 준비(tests.support.staged)로 소유자가 넣고 블록 끝에 ROLLBACK.
-- 준비 SQL 은 데이터 파일(.pgsql)로 두고 '-- @이름' 으로 나눠 읽는다(back/tests/README.md 6절).
-- 사실 행은 템플릿 답변(글로벌 k1 · 웹사이트 k21·k22)의 인용 원소를 골라 복사하고, 답변 인용 수 열(G-25 + DB-v2.13 cit_off)은 rd.answer_cit_counts 로
-- 다시 채운 뒤 rd.assert_answer_cit_counts 로 단언한다. 키 범위: 회차 13·14·15·22, prompt_key 9101~9109, answer_key 9101~9299,
-- 웹 유닛 3·4, 발행물 c9000000-…-00000000000a·b, 2026-09-25 발행 유닛 101·103·104·401(픽스처의 102 는 건드리지 않는다).

-- @global
-- 글로벌 회차: 13(09-22, 인용 숨김 hidden_scope 2 → 인용 계열 배제) · 14(09-23, 언급 숨김 3 → 인용 계열 포함, 새 스냅샷)
--              · 15(09-24, 노출일 미래 → 배제)
INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date, hidden_scope,
                      hidden_reason, generation)
VALUES (13, gen_random_uuid(), 1, 1, true, '2026-09-22', '2026-09-22', 2, true, '2026-09-23', 2, 2, 1),
       (14, gen_random_uuid(), 1, 1, true, '2026-09-23', '2026-09-23', 2, true, '2026-09-24', 3, 2, 1),
       (15, gen_random_uuid(), 1, 1, true, '2026-09-24', '2026-09-24', 2, true, '2099-12-31', 0, 0, 1);
-- 프롬프트(퍼널·카탈로그 비트는 SP1 과 같게): PA·PC 는 인용 수 동률(3), prompt_id 순 PA < PC
INSERT INTO rd.dim_prompt (prompt_key, prompt_id, surface, project_key, kind, text, lang_key, cat_mask, in_root_catalog, funnel_key, rule_ver)
SELECT v.k, v.pid::uuid, 1, 1, 'single', v.t, t.lang_key, t.cat_mask, t.in_root_catalog, t.funnel_key, 1
  FROM (VALUES (9101, 'c3a00000-0000-4000-8000-000000000001', 'stage a tie'),
               (9102, 'c3a00000-0000-4000-8000-000000000002', 'stage b uncited'),
               (9103, 'c3a00000-0000-4000-8000-000000000003', 'stage c tie'),
               (9104, 'c3a00000-0000-4000-8000-000000000004', 'stage d many'),
               (9105, 'c3a00000-0000-4000-8000-000000000005', 'stage e hostless'),
               (9106, 'c3a00000-0000-4000-8000-000000000006', 'stage f deepseek'),
               (9107, 'c3a00000-0000-4000-8000-000000000007', 'stage g inelig'),
               (9108, 'c3a00000-0000-4000-8000-000000000008', 'stage h hidden cycle'),
               (9109, 'c3a00000-0000-4000-8000-000000000009', 'stage i future cycle')) v(k, pid, t)
 CROSS JOIN rd.dim_prompt t WHERE t.prompt_key = 1;
-- 답변 명세: (answer_key, job_id, prompt_key, cyc_key, round_date, engine_key(NULL=템플릿), elig, 복사할 k1 인용 ord)
--   k1 ord: 1 = 현대 자사(AU) · 9 = 현대 자사(US root_home) · 10 = 기아 자사 · 5 = 호스트 없음 · 2·3·4·6·7·8 = 비자사
--   PD(9104) 10답변: 인용 2건 3개 + 1건 7개 = 13, 자사 1(9111 ord 1). job_id 는 answer_key 의 역순(표본 동률이 job_id 순인지 본다)
CREATE TEMP TABLE _sa (ak int, jid uuid, pk int, ck int, rdt date, ek int2, elig bool, ords int2[]) ON COMMIT DROP;
INSERT INTO _sa VALUES
  (9101, '9a000000-0000-4000-8000-000000000001', 9101, 14, '2026-09-23', NULL, true, '{1,2,3}'),
  (9102, '9a000000-0000-4000-8000-000000000002', 9102, 14, '2026-09-23', NULL, true, '{2,3,4}'),
  (9103, '9a000000-0000-4000-8000-000000000003', 9103, 14, '2026-09-23', NULL, true, '{9,2,3}'),
  (9104, '9a000000-0000-4000-8000-000000000004', 9105, 14, '2026-09-23', NULL, true, '{5}'),
  (9105, '9a000000-0000-4000-8000-000000000005', 9106, 14, '2026-09-23', 3,    true, '{1,2}'),
  (9106, '9a000000-0000-4000-8000-000000000006', 9107, 14, '2026-09-23', NULL, false, '{1,2,3}'),
  (9107, '9a000000-0000-4000-8000-000000000007', 9108, 13, '2026-09-22', NULL, true, '{1,2,3,4}'),
  (9108, '9a000000-0000-4000-8000-000000000008', 9109, 15, '2026-09-24', NULL, true, '{1,2,3,4,6}'),
  (9111, '9a000000-0000-4000-8000-000000000099', 9104, 14, '2026-09-23', NULL, true, '{1,2}'),
  (9112, '9a000000-0000-4000-8000-000000000098', 9104, 14, '2026-09-23', NULL, true, '{2,3}'),
  (9113, '9a000000-0000-4000-8000-000000000097', 9104, 14, '2026-09-23', NULL, true, '{3,4}'),
  (9114, '9a000000-0000-4000-8000-000000000096', 9104, 14, '2026-09-23', NULL, true, '{6}'),
  (9115, '9a000000-0000-4000-8000-000000000095', 9104, 14, '2026-09-23', NULL, true, '{7}'),
  (9116, '9a000000-0000-4000-8000-000000000094', 9104, 14, '2026-09-23', NULL, true, '{8}'),
  (9117, '9a000000-0000-4000-8000-000000000093', 9104, 14, '2026-09-23', NULL, true, '{2}'),
  (9118, '9a000000-0000-4000-8000-000000000092', 9104, 14, '2026-09-23', NULL, true, '{3}'),
  (9119, '9a000000-0000-4000-8000-000000000091', 9104, 14, '2026-09-23', NULL, true, '{4}'),
  (9120, '9a000000-0000-4000-8000-000000000090', 9104, 14, '2026-09-23', NULL, true, '{6}');
INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                       cat_mask, bgrp, anchor_src, acr_iter_rank, analysis_state, elig, dflt, is_acr, is_rep, web_reg, rule_ver, load_id)
SELECT s.rdt, s.ak, s.rdt, s.ck, t.run_key, s.pk, 1, t.project_key, coalesce(s.ek, t.engine_key), t.geo_key, t.lang_key,
       t.cat_mask, t.bgrp, t.anchor_src, 1, 0, s.elig, coalesce((SELECT e.is_default FROM rd.dim_engine e WHERE e.engine_key = s.ek), t.dflt),
       false, true, false, 1, t.load_id
  FROM _sa s CROSS JOIN rd.answer t
 WHERE t.surface = 1 AND t.round_date = '2026-09-14' AND t.cyc_key = 11 AND t.answer_key = 1;
INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key, lang_key,
                         bgrp, scope_key, owner_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver)
SELECT a.round_date, a.answer_key, c.url_key, c.source_key, a.cyc_key, a.prompt_key, 1, c.ord, c.project_key, a.engine_key, c.geo_key, c.lang_key,
       c.bgrp, c.scope_key, c.owner_key, a.cit_in, a.gap, a.dflt, c.loc_owned, c.tgt_hit, c.src_first, 1
  FROM _sa s
  JOIN rd.answer a ON a.surface = 1 AND a.round_date = s.rdt AND a.answer_key = s.ak
  JOIN rd.citation c ON c.surface = 1 AND c.round_date = '2026-09-14' AND c.cyc_key = 11 AND c.answer_key = 1 AND c.ord = ANY (s.ords);
INSERT INTO rd.job (answer_key, job_id, run_key, prompt_key, cyc_key, round_date, measured_at, surface, project_key, engine_key, geo_key, lang_key,
                    bgrp, status_code, analysis_code, dropped, served, load_id)
SELECT a.answer_key, s.jid, a.run_key, a.prompt_key, a.cyc_key, a.round_date, a.round_date + time '01:00', 1, a.project_key, a.engine_key, a.geo_key,
       a.lang_key, a.bgrp, 0, 0, false, true, a.load_id
  FROM _sa s JOIN rd.answer a ON a.surface = 1 AND a.round_date = s.rdt AND a.answer_key = s.ak;
UPDATE rd.answer a
   SET cit_n = x.cit_n, cit_own_h = x.cit_own_h, cit_own_k = x.cit_own_k, cit_own_g = x.cit_own_g, cit_own_hc = x.cit_own_hc,
       cit_own_kc = x.cit_own_kc, cit_own_gc = x.cit_own_gc, cit_own_x = x.cit_own_x, cit_loc = x.cit_loc, cit_tgt = x.cit_tgt,
       cit_loc_tgt = x.cit_loc_tgt, cit_off = x.cit_off, has_cit = x.cit_n > 0, tgt_cited = x.cit_tgt > 0, own_url_cited = x.cit_loc_tgt > 0
  FROM rd.answer_cit_counts((SELECT array_agg(ak) FROM _sa)) x
 WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key;
SELECT rd.assert_answer_cit_counts((SELECT array_agg(ak) FROM _sa));

-- @website
-- 웹사이트 회차 22(Kia DE 사이트, 09-25, 숨김 없음) + 답변 2건(k21·k22 복사: 둘 다 타겟·자사 URL 인용) + 웹 유닛 103(en)·104(de)
INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date, hidden_scope, generation)
VALUES (22, gen_random_uuid(), 2, 2, true, '2026-09-25', '2026-09-25', 2, true, '2026-09-26', 0, 1);
INSERT INTO rd.web_unit (unit_key, project_key, file_seq, lang_codes, rule_ver) VALUES (3, 2, 103, '{en}', 1), (4, 2, 104, '{de}', 1);
CREATE TEMP TABLE _sw (ak int, jid uuid, tak int) ON COMMIT DROP;
INSERT INTO _sw VALUES (9201, '9b000000-0000-4000-8000-000000000001', 21), (9202, '9b000000-0000-4000-8000-000000000002', 22);
INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                       cat_mask, bgrp, anchor_src, acr_iter_rank, analysis_state, elig, dflt, is_acr, is_rep, web_reg, rule_ver, load_id)
SELECT '2026-09-25', s.ak, '2026-09-25', 22, t.run_key, t.prompt_key, 2, t.project_key, t.engine_key, t.geo_key, t.lang_key,
       t.cat_mask, t.bgrp, t.anchor_src, 1, 0, t.elig, t.dflt, false, true, t.web_reg, 1, t.load_id
  FROM _sw s JOIN rd.answer t ON t.surface = 2 AND t.round_date = '2026-09-18' AND t.cyc_key = 21 AND t.answer_key = s.tak;
INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key, lang_key,
                         bgrp, scope_key, owner_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver)
SELECT '2026-09-25', s.ak, c.url_key, c.source_key, 22, c.prompt_key, 2, c.ord, c.project_key, c.engine_key, c.geo_key, c.lang_key,
       c.bgrp, c.scope_key, c.owner_key, c.cit_in, c.gap, c.dflt, c.loc_owned, c.tgt_hit, c.src_first, 1
  FROM _sw s JOIN rd.citation c ON c.surface = 2 AND c.round_date = '2026-09-18' AND c.cyc_key = 21 AND c.answer_key = s.tak;
INSERT INTO rd.job (answer_key, job_id, run_key, prompt_key, cyc_key, round_date, measured_at, surface, project_key, engine_key, geo_key, lang_key,
                    bgrp, status_code, analysis_code, dropped, served, load_id)
SELECT a.answer_key, s.jid, a.run_key, a.prompt_key, 22, a.round_date, '2026-09-25 01:00+00', 2, a.project_key, a.engine_key, a.geo_key,
       a.lang_key, a.bgrp, 0, 0, false, true, a.load_id
  FROM _sw s JOIN rd.answer a ON a.surface = 2 AND a.round_date = '2026-09-25' AND a.answer_key = s.ak;
UPDATE rd.answer a
   SET cit_n = x.cit_n, cit_own_h = x.cit_own_h, cit_own_k = x.cit_own_k, cit_own_g = x.cit_own_g, cit_own_hc = x.cit_own_hc,
       cit_own_kc = x.cit_own_kc, cit_own_gc = x.cit_own_gc, cit_own_x = x.cit_own_x, cit_loc = x.cit_loc, cit_tgt = x.cit_tgt,
       cit_loc_tgt = x.cit_loc_tgt, cit_off = x.cit_off, has_cit = x.cit_n > 0, tgt_cited = x.cit_tgt > 0, own_url_cited = x.cit_loc_tgt > 0
  FROM rd.answer_cit_counts((SELECT array_agg(ak) FROM _sw)) x
 WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key;
SELECT rd.assert_answer_cit_counts((SELECT array_agg(ak) FROM _sw));

-- @pub_single
-- rep-0925(픽스처 발행물)에 Kia DE 유닛 101(헤드라인 풀) 발행값
INSERT INTO rd.report_unit_value (round_date, file_seq, cyc_key, pub_id, brand, country_code, lang_code, in_headline_pool,
                                  target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den, load_id)
VALUES ('2026-09-25', 101, 22, 'c9000000-0000-4000-8000-000000000002', 'Kia', 'DE', 'de', true, 11, 20, 13, 20, 3);

-- @pub_mixed_pool
-- 검증 D2: 같은 선택에 풀 유닛 101(de) + 비풀 유닛 103(en, 같은 사이트 프로젝트)
INSERT INTO rd.report_unit_value (round_date, file_seq, cyc_key, pub_id, brand, country_code, lang_code, in_headline_pool,
                                  target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den, load_id)
VALUES ('2026-09-25', 103, 22, 'c9000000-0000-4000-8000-000000000002', 'Kia', 'DE', 'en', false, 1, 7, 2, 7, 3);

-- @pub_multi
-- 검증 D1: 같은 회차에 브랜드 범위 발행물 둘 추가. hyundai-secret-0925(Hyundai, 유닛 401 = 웹 유닛 없음) · kia-extra-0925(Kia, 유닛 104)
SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true);
INSERT INTO app.report_publication (id, slug, surface, brand_scope, version, round_date, source_filename, source_sha256, sb_data_version, status)
VALUES ('c9000000-0000-4000-8000-00000000000a', 'hyundai-secret-0925', 'website', 'Hyundai', 'v1', '2026-09-25', 'h.xlsx', 'aa', 'v', 'active'),
       ('c9000000-0000-4000-8000-00000000000b', 'kia-extra-0925', 'website', 'Kia', 'v1', '2026-09-25', 'k.xlsx', 'bb', 'v', 'active');
INSERT INTO rd.report_unit_value (round_date, file_seq, cyc_key, pub_id, brand, country_code, lang_code, in_headline_pool,
                                  target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den, load_id)
VALUES ('2026-09-25', 104, 22, 'c9000000-0000-4000-8000-00000000000b', 'Kia', 'DE', 'de', true, 4, 5, 5, 5, 3),
       ('2026-09-25', 401, NULL, 'c9000000-0000-4000-8000-00000000000a', 'Hyundai', 'DE', 'de', true, 1, 10, 1, 10, 3);
