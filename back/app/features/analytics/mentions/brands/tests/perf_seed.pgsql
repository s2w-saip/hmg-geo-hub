-- 성능 라운드 A4 동치 테스트 준비(소유자, 롤백 전용): 글로벌 회차 11(09-14)·10(09-07)에 합성 rd.answer_brand 행.
-- 같은 프롬프트가 여러 답변·엔진·국가(US·DE·ID 숨김 시장·KR)에 걸치고, 복수 언급(mention_count ≥ 2)이 일부 프롬프트에만 있으며,
-- 당사 비트(Hyundai 1·Kia 2) 행·비경쟁(Apple kind 3)·비표준(std_in 거짓)·비기본 엔진(deepseek, dflt 거짓) 행이 섞인다.
INSERT INTO rd.answer_brand (round_date, answer_key, brand_key, cyc_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key, bgrp,
                             own_bit, entity_rows, mention_count, rk, s_pos, s_neu, s_neg, s_mix, t_mention, t_recommendation, t_comparison,
                             t_definition, t_final_choice, competitive, std_in, elig, dflt, rule_ver)
SELECT d.round_date, 8000000 + d.cyc_key * 1000 + g.i, b.brand_key, d.cyc_key, 1 + (g.i * b.brand_key) % 7, 1, 1,
       CASE WHEN g.i % 13 = 0 THEN 3 ELSE 1 + g.i % 2 END,
       (ARRAY[175, 44, 78, 92])[1 + g.i % 4], 2, (ARRAY[1, 2, 4, 8, 5])[1 + g.i % 5],
       b.own_bit, 1, (g.i * 7 + b.brand_key) % 4,
       CASE WHEN g.i % 17 = 0 THEN 0 ELSE 1 + (g.i + b.brand_key) % 5 END,
       g.i % 2, (g.i + 1) % 2, (g.i % 3 = 0)::int, (g.i % 5 = 0)::int,
       (g.i + b.brand_key) % 3, g.i % 2, (g.i * b.brand_key) % 3, (g.i % 4 = 0)::int, (b.brand_key % 2)::int,
       g.i % 17 <> 0, g.i % 11 <> 0, true, g.i % 13 <> 0, 1
  FROM (VALUES (DATE '2026-09-14', 11), (DATE '2026-09-07', 10)) d(round_date, cyc_key)
  CROSS JOIN generate_series(1, 90) g(i)
  CROSS JOIN (SELECT n.brand_key, n.own_bit FROM rd.dim_brand_name n WHERE n.brand_key IN (1, 2, 5, 9, 23, 26, 33, 40, 59, 60, 61)) b
 WHERE (g.i + b.brand_key) % 3 <> 0;
