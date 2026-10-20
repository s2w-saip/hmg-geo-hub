/* ── 발행 세대 (카드 동결) ── */
tbl('publication', { s: 'gold', name: 'publication', fam: 'pub', grain: '회차 × 발행 세대', cols: [
  ['gen_key', 'PK', '세대 키 (identity)'], ['cyc_key', 'FK', '', 'dim_cycle'], ['surface', '', 'CHECK 1~3 · 발행은 1 · 2'], ['source', '', 'ops 이관 · hub 발행'], ['state', '', 'building · active · retired'], ['build_id', 'FK', '고정한 사실 build (신규)', 'build'],
  ['ops_{cycle_id,generation_id,generator_version}', '', 'ops 이관 세대 원값'], ['ops_started_at · ops_finished_at', '', ''], ['judgment', '', '판정 입력 버전 jsonb'], ['row_counts · verify', '', '행 수 · 단언 결과'], ['created_at · activated_at · retired_{at,reason}', '', ''] ], d: {
  grain: '회차 × 발행 세대 1개 = 1행. 회차당 active · building 은 각 1개입니다.', pk: 'gen_key', inputs: '데이터 분석팀 · app.ecat_version · app.rule_set (판정 버전)',
  triggers: '현행 회차 발행 직후 자동 생성(global · website) · ops 이관 CLI · cycle_admin regenerate(BE 경로 없음)',
  uses: 'freeze_at_publish 켬일 때 카드 경로 7개(kpi/summary · mentions/brands · trend · geo · kpi/engines website · citations/domains 기간 없음 · kpi/compare)의 동결 읽기, 글로벌 추이 격자, 창 판정(세대 없는 회차가 끼면 비카드), 카드 스냅샷 회차, URL 인용률 커버 판정(judgment)',
  cur: 'frz.generation (열 전부 + build_id 신규). frz.ops_judgment(감사 사본, BE 미사용)는 두지 않음', rules: ['현행 카드 뷰는 frz.cell 셀의 rd 행을 라이브로 읽고, 보관 표시(frz.kept src apply · bulk · ops · seat · fold)된 답변만 frz.keep_* 옛 행으로 읽습니다.', '골드에서는 build_id 로 발행 시점 사실 build 를 고정해 보관 행을 없앱니다. 발행 뒤 재판정은 새 build 로만 들어갑니다.', '골드에서는 활성 발행이 가리키는 build 를 지우지 않습니다.', '골드에서는 ops 이관 세대도 운영 원값 build 를 만들어 가리킵니다 (현행 kept src ops · fold 대체).', '골드에서는 고정 build 가 발행 당시 규칙 서명(profile_signature)으로 만든 것이어야 합니다.'] } });
tbl('pub_cell', { s: 'gold', name: 'pub_cell', fam: 'pub', grain: '발행 × 셀 대표 답변', cols: [['gen_key', 'PF', '', 'publication'], ['answer_key', 'PF', '셀 대표', 'answer_fact'], ['surface · cyc_key', '', ''], ['round_date', '', '동결 좌석'], ['prompt_key · engine_key · geo_key', '', '셀 좌표']], d: {
  grain: '발행 세대 × 셀 대표 답변 1건 = 1행.', pk: 'gen_key + answer_key', inputs: '데이터 분석팀 · app.website_prompt · app.website_site (웹 셀 국가)', uses: '카드 · 격자 동결 읽기의 셀 집합', cur: 'frz.cell (열 전부)',
  rules: ['셀 대표 = 회차 run 서빙 답변 중 셀(프롬프트 × 엔진 × 국가)당 1건, 미러 시각 > 앵커 핀 접기 > 원본 시각 최신순(NULL 먼저) · job_id. LIVE 의 is_rep 와 다를 수 있습니다.'] } });
tbl('pub_cell_web', { s: 'gold', name: 'pub_cell_web', fam: 'pub', grain: '웹 셀 판정', cols: [['gen_key · answer_key', 'PF', '', 'pub_cell'], ['cyc_key', '', ''], ['report_fs', '', '보고 유닛 (NULL = 밖)'], ['unit_owned · unit_target', '', '⑥ 유닛 자사 · 타겟 인용'], ['url_registered · url_owned_hit · url_target_hit', '', 'URL 률 플래그 (이관만)']], d: {
  grain: '웹 셀 1개의 발행 시점 판정 = 1행.', pk: 'gen_key + answer_key', inputs: '데이터 분석팀 (발행 시점 web_report_prompt · answer_fact · citation_fact · dim_prompt.targets)',
  uses: 'Website 카드 동결 읽기: 유닛 게이트(web_registered_only) · ⑥ 유닛 몫(web_accuracy_flat) · URL 인용률 플래그', cur: 'frz.cell_web (열 전부, 읽기 = frz.card_web · card_*_w)',
  rules: ['url_* 는 ops 이관 세대만 채웁니다. 비면 답변 행 열(web_reg · tgt_cited · own_url_cited)을 씁니다.'] } });
tbl('pub_prompt', { s: 'gold', name: 'pub_prompt', fam: 'pub', grain: '발행 × 프롬프트', cols: [
  ['gen_key', 'PF', '', 'publication'], ['prompt_key', 'PF', '', 'dim_prompt'], ['cyc_key', '', ''], ['in_full_cycle · expected_cells · window_cells', '', '풀 사이클 판정 (웹 = 참)'], ['in_root_catalog · catalog_deleted · cat_mask', '', '동결 카탈로그 비트'],
  ['funnel_key · presence_key · list_type_key · depth1~3_key', '', '생성 시점 축 (BE 미사용)'], ['regions · is_korean · report_fs', '', ''], ['src', '', '원값 jsonb (감사 · 대조)'] ], d: {
  grain: '발행 세대 × 셀 프롬프트 1개 = 1행.', pk: 'gen_key + prompt_key', inputs: '데이터 분석팀 (발행 시점 dim_prompt · catalog_entry · web_report_prompt · 회차 셀 측정)',
  uses: '글로벌 카드의 in_full_cycle 게이트 · 동결 카탈로그 비트(bgrp = cat_mask, 버림 판정)', cur: 'frz.prompt (열 전부)' } });
tbl('pub_prompt_axis', { s: 'gold', name: 'pub_prompt_axis', fam: 'pub', grain: '발행 × 프롬프트 택소노미', cols: [['gen_key · prompt_key', 'PF', '', 'pub_prompt'], ['cyc_key', '', ''], ['funnel_key', 'FK', '', 'dim_taxon'], ['presence_keys[]', '', 'presence 키 집합'], ['list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon']], d: {
  grain: '발행 세대 × 프롬프트의 택소노미 축 = 1행.', pk: 'gen_key + prompt_key', inputs: '데이터 분석팀 · app.prompt · app.brand (발행 시점 축)', uses: '카드 동결 읽기의 택소노미 필터 · 버림 판정', cur: 'frz.prompt_axis (열 전부, 읽기 = frz.card_axis)' } });
tbl('pub_brand_name', { s: 'gold', name: 'pub_brand_name', fam: 'pub', grain: '발행 × 브랜드 표시명', cols: [['gen_key', 'PF', '', 'publication'], ['brand_key', 'PF', '', 'dim_brand'], ['name', '', '발행 시점 표시명']], d: {
  grain: '발행 세대 × 브랜드(셀 답변 브랜드 ∪ 당사) = 1행.', pk: 'gen_key + brand_key', inputs: '데이터 분석팀 (발행 시점 dim_brand 표시명)', uses: '카드 동결 읽기의 브랜드 표시명 (창의 가장 늦은 회차 이름, 개명 브랜드는 이름별 행)', cur: 'frz.brand_name (열 전부, 읽기 = frz.card_brand_name)' } });
