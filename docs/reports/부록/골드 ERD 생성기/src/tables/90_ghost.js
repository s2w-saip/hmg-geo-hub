/* ── 다른 탭 참조 상자 ── */
ghost('dim_prompt', [['prompt_key', 'PK', '']]); ghost('dim_project', [['project_key', 'PK', '']]); ghost('dim_lang', [['lang_key', 'PK', '']]); ghost('dim_url', [['url_key', 'PK', '']]);
ghost('dim_brand', [['brand_key', 'PK', '']]); ghost('dim_entity', [['entity_key', 'PK', '']]); ghost('dim_source', [['source_key', 'PK', '']]); ghost('dim_cycle', [['cyc_key', 'PK', '']]);
ghost('dim_taxon', [['taxon_key', 'PK', '']]); ghost('dim_engine', [['engine_key', 'PK', '']]); ghost('dim_country', [['geo_key', 'PK', '']]);
ghost('answer_fact', [['build_id', 'PK', ''], ['surface · round_date · answer_key', 'PK', '']]); ghost('answer_brand_fact', [['build_id · 답변 PK', 'PK', ''], ['brand_key · competitive', 'PK', '']]);
ghost('answer_stance_fact', [['build_id · 답변 PK', 'PK', ''], ['turn_index · entity_key', 'PK', '']]); ghost('citation_fact', [['build_id · 답변 PK', 'PK', ''], ['ord', 'PK', '']]); ghost('job_index', [['answer_key', 'PK', '']]); ghost('build', [['build_id', 'PK', '']]);
ghost('publication', [['gen_key', 'PK', ''], ['build_id', 'FK', '', 'build']]); ghost('ga4_value', [['kind · value_key', 'PK', '']]); ghost('ctx_snapshot', [['snapshot_id', 'PK', '']]);
