-- acr 테스트 시드(소유자 접속 전용, API 문장 아님). conftest.py 가 읽어 실행한다.
DO $$
DECLARE us int2; kr int2; de int2; en int2; dl int2; gpt int2; gem int2; ds int2; l1 int2; hy int4; kia int4; toy int4;
BEGIN
  SELECT geo_key INTO us FROM rd.dim_country WHERE code = 'US';
  SELECT geo_key INTO kr FROM rd.dim_country WHERE code = 'KR';
  SELECT geo_key INTO de FROM rd.dim_country WHERE code = 'DE';
  SELECT lang_key INTO en FROM rd.dim_lang WHERE code = 'en';
  SELECT lang_key INTO dl FROM rd.dim_lang WHERE code = 'de';
  SELECT engine_key INTO gpt FROM rd.dim_engine WHERE code = 'chatgpt';
  SELECT engine_key INTO gem FROM rd.dim_engine WHERE code = 'gemini';
  SELECT engine_key INTO ds FROM rd.dim_engine WHERE code = 'deepseek';
  SELECT taxon_key INTO l1 FROM rd.dim_taxon WHERE axis = 'list_type' AND code = 'L1';
  SELECT brand_key INTO hy FROM rd.dim_brand_name WHERE name = 'Hyundai';
  SELECT brand_key INTO kia FROM rd.dim_brand_name WHERE name = 'Kia';
  SELECT brand_key INTO toy FROM rd.dim_brand_name WHERE name = 'Toyota';

  INSERT INTO rd.dim_prompt (prompt_key, prompt_id, surface, project_key, kind, text, lang_key, cat_mask, in_root_catalog, rule_ver) VALUES
    (9001, 'b9000000-0000-4000-8000-000000009001', 1, 1, 'acr', 'acr hyundai q', en, 1, true, 1),
    (9002, 'b9000000-0000-4000-8000-000000009002', 1, 1, 'acr', 'acr kia q', en, 2, true, 1);
  INSERT INTO rd.catalog_entry (catalog_row_id, prompt_key, brand_bit, list_type_key, kind, load_id) VALUES
    ('c9000000-0000-4000-8000-000000009001', 9001, 1, l1, 'acr', 1),
    ('c9000000-0000-4000-8000-000000009002', 9002, 2, l1, 'acr', 1);
  INSERT INTO rd.dim_entity (entity_key, entity_id, entity_type, rep_name, brand_key) VALUES
    (9001, 'e9000000-0000-4000-8000-000000009001', 'Product', 'Toyota RAV4', toy);

  INSERT INTO rd.acr_cell (acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
                           planned, valid_turn1, valid_acr, co_single, co_conditional, co_generic, co_off_shortlist, co_unresolved, co_none,
                           is_rep, acr_in, measured_date, rule_ver) VALUES
    (9101, '2026-09-14', 11, 9001, 1, 1, 1, gem, kr, en, 1, 4, 4, 4, 4, 0, 0, 0, 0, 0, true, true,  '2026-09-14', 1),
    (9102, '2026-09-14', 11, 9002, 1, 2, 1, gpt, us, en, 2, 3, 3, 3, 3, 0, 0, 0, 0, 0, true, true,  '2026-09-14', 1),
    (9103, '2026-09-14', 11, 3,    1, 8, 1, ds,  us, en, 8, 5, 5, 5, 5, 0, 0, 0, 0, 0, true, true,  '2026-09-14', 1),
    (9104, '2026-09-07', 10, 3,    1, 8, 1, gpt, us, en, 8, 2, 2, 2, 2, 0, 0, 0, 0, 0, true, true,  '2026-09-07', 1),
    (9105, '2026-09-14', 11, 3,    1, 8, 1, gpt, de, dl, 8, 9, 9, 9, 9, 0, 0, 0, 0, 0, true, false, '2026-09-14', 1),
    (9106, '2026-09-21', 12, 3,    1, 8, 1, gpt, us, en, 8, 7, 7, 7, 7, 0, 0, 0, 0, 0, true, true,  '2026-09-21', 1);

  INSERT INTO rd.acr_choice (acr_cell_key, entity_key, brand_key, parent_brand_key, level, own_bit, name_own,
                             appearance, choice, cond_choice, off_shortlist, unresolved, generic, keep) VALUES
    (9101, 1, hy,  0, 1, 1, 1, 4, 3, 0, 0, 0, 0, true),
    (9101, 3, toy, 0, 1, 0, 0, 2, 1, 0, 0, 0, 0, true),
    (9101, 6, 0,  hy, 2, 1, 1, 3, 2, 0, 0, 0, 0, true),
    (9102, 2, kia, 0, 1, 2, 2, 3, 2, 0, 0, 0, 0, true),
    (9102, 1, hy,  0, 1, 1, 1, 1, 1, 0, 0, 0, 0, true),
    (9103, 3, toy, 0, 1, 0, 0, 5, 5, 0, 0, 0, 0, true),
    (9103, 9001, 0, toy, 2, 0, 0, 4, 3, 0, 0, 0, 0, true),
    (9104, 1, hy,  0, 1, 1, 1, 2, 2, 0, 0, 0, 0, true),
    (9105, 3, toy, 0, 1, 0, 0, 9, 9, 0, 0, 0, 0, true),
    (9106, 3, toy, 0, 1, 0, 0, 7, 7, 0, 0, 0, 0, true);
END $$;
