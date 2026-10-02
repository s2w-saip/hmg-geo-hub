-- ACR 옵션(BG-33) 테스트 조각(소유자 실행 준비, API 문장 아님. core 세이브포인트 안에서 넣고 시험 끝에 되돌린다). '-- @이름' 줄로 나눈다.
-- 셀 키 9107~9109 만 쓴다(모듈 시드 9101~9106·공용 501 과 겹치지 않음).

-- @ko_cell
-- 회차 11(09-14) · 프롬프트 3(HMG bgrp 8) · chatgpt · KR · 언어 ko · 유효 2 · acr_in 참 · Hyundai 선택 1(등장 1)
INSERT INTO rd.acr_cell (acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
                         planned, valid_turn1, valid_acr, co_single, co_conditional, co_generic, co_off_shortlist, co_unresolved, co_none,
                         is_rep, acr_in, measured_date, rule_ver)
SELECT 9107, DATE '2026-09-14', 11, 3, 1, 8, 1, (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt'),
       (SELECT geo_key FROM rd.dim_country WHERE code = 'KR'), (SELECT lang_key FROM rd.dim_lang WHERE code = 'ko'), 8,
       2, 2, 2, 2, 0, 0, 0, 0, 0, true, true, DATE '2026-09-14', 1;
INSERT INTO rd.acr_choice (acr_cell_key, entity_key, brand_key, parent_brand_key, level, own_bit, name_own,
                           appearance, choice, cond_choice, off_shortlist, unresolved, generic, keep)
SELECT 9107, 1, (SELECT brand_key FROM rd.dim_brand_name WHERE name = 'Hyundai'), 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, true;

-- @hidden_cell
-- 검증 D2 회귀: 회차 11(09-14) · 프롬프트 3(HMG bgrp 8) · chatgpt · 숨김 표준 국가 ID · en · 유효 2 · acr_in 참. 키 9108.
-- 픽스처가 ID 를 이미 hidden_standard 로 두지만(fixture-00-rules 3-7) 시험 전제를 조각 안에서 고정한다.
UPDATE rd.dim_country SET hidden_standard = true WHERE code = 'ID';
INSERT INTO rd.acr_cell (acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
                         planned, valid_turn1, valid_acr, co_single, co_conditional, co_generic, co_off_shortlist, co_unresolved, co_none,
                         is_rep, acr_in, measured_date, rule_ver)
SELECT 9108, DATE '2026-09-14', 11, 3, 1, 8, 1, (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt'),
       (SELECT geo_key FROM rd.dim_country WHERE code = 'ID'), (SELECT lang_key FROM rd.dim_lang WHERE code = 'en'), 8,
       2, 2, 2, 2, 0, 0, 0, 0, 0, true, true, DATE '2026-09-14', 1;

-- @ds_de_cell
-- 검증 D5 회귀: 회차 11(09-14) · 프롬프트 3(HMG bgrp 8) · deepseek(비기본 엔진) · US · 언어 de · 유효 2 · acr_in 참. 키 9109.
-- 기본 엔진 데이터에는 안 잡히지만 현행 listMeasuredAcrLanguages(엔진 축 없음)에는 de 가 옵션으로 나온다.
INSERT INTO rd.acr_cell (acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
                         planned, valid_turn1, valid_acr, co_single, co_conditional, co_generic, co_off_shortlist, co_unresolved, co_none,
                         is_rep, acr_in, measured_date, rule_ver)
SELECT 9109, DATE '2026-09-14', 11, 3, 1, 8, 1, (SELECT engine_key FROM rd.dim_engine WHERE code = 'deepseek'),
       (SELECT geo_key FROM rd.dim_country WHERE code = 'US'), (SELECT lang_key FROM rd.dim_lang WHERE code = 'de'), 8,
       2, 2, 2, 2, 0, 0, 0, 0, 0, true, true, DATE '2026-09-14', 1;
