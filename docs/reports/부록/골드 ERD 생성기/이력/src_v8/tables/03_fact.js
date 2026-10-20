/* ── 답변 사실 ── */
tbl('job_index', { s: 'gold', name: 'job_index', fam: 'fact', grain: 'Scope job 1건 (모든 상태)', cols: [
  ['answer_key', 'PK', 'int4'], ['job_id', 'UK', 'uuid'], ['run_key', '', ''], ['C 좌표', 'FK', 'cyc·prompt·project·engine·geo·lang·bgrp', 'cell_key', ['cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']], ['surface · round_date', '', ''], ['measured_at', '', '측정 시각'],
  ['status_code', '', '0 완료 · 1 대기·실행 · 2 실패 · 3 기타'], ['analysis_code', '', ''], ['dropped · served', '', ''], ['last_build_id', 'FK', '마지막 반영 build (현행 load_id)', 'build'] ], d: {
  grain: 'Scope job 1건 = 1행. 대기·실행·실패·드롭까지 모든 상태를 담습니다.', pk: 'answer_key (job_id 유일)', inputs: '데이터 분석팀',
  triggers: '적재마다, 회차 재평가의 run 귀속 이동, judgment_change 처리(재판정 · 앵커 고정 · 드롭 등)',
  uses: '답변 모달 헤더·범위 검사, 언급·인용 프롬프트·도메인 상세의 답변 참조(job_id), 추이 측정 일수(/v1/trend), 글로벌 필터 옵션(filter_options 스위치), 원본 데이터 검수 목록·진행률·상세·노트, Project › Setting › General 분석 연결 진단, 회차·job 관제 API(화면 없음)',
  cur: 'rd.job (load_id → last_build_id)',
  rules: ['served = 완료 ∧ 드롭 아님. answer_fact 는 served job 만 가집니다.', 'job_id ↔ answer_key 해석과 접근 범위 검사(fail-closed)가 이 테이블을 거칩니다.', '골드에서는 build 로 나누지 않는 현재 상태 원장입니다. 대기·실행·실패가 build 없이 바로 보여야 해서 release 밖에 두고, 바뀌면 data_version 을 올립니다.'] } });
tbl('answer_fact', { s: 'gold', name: 'answer_fact', fam: 'fact', grain: '빌드 × 정상 완료 답변 1건', cols: [
  ['build_id', 'PF', '빌드 (현행 load_id)', 'build'], ['surface · round_date', 'PK', '파티션'], ['answer_key', 'PF', '', 'job_index'], ['C 좌표', 'FK', 'cyc·run·prompt·project·engine·geo·lang·bgrp', 'cell_key', ['cyc_key', 'run_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']],
  ['anchor_date · anchor_src · region_geo_key', '', ''], ['cat_mask · acr_iter_rank · analysis_state', '', ''], ['elig · dflt · is_acr · is_rep · web_reg', '', '게이트'], ['std_in · cit_in · gap · acr_in', '', '모수·갭 (현행 생성 열)'],
  ['elig_nc · std_in_nc · cit_in_nc', '', '프로필 대체 모수'], ['own_mask · own_rk_{h,k,g} · t_own', '', '당사 비트 · 경쟁 순위 · 유형'], ['own_fp_{h,k,g}', '', '텍스트 첫 등장 순서 (신규)'], ['ment_total · ment_{h,k,g}', '', ''],
  ['sent_{pos,neg,all}_{h,k,g}', '', ''], ['cit_n · cit_n_all · cit_off', '', '호스트 인용 · 전체 · Official'], ['cit_own_{h,k,g}[c] · cit_own_x', '', '글로벌 자사 인용 수', '', ['cit_own_h', 'cit_own_k', 'cit_own_g', 'cit_own_hc', 'cit_own_kc', 'cit_own_gc', 'cit_own_x']], ['cit_loc · cit_tgt · cit_loc_tgt', '', '자사 · 타겟 · 자사∨타겟 인용 수'],
  ['cit_c1 … cit_c13', '', '카테고리별'], ['has_cit · tgt_cited · own_url_cited', '', '인용 여부 · URL 인용률'], ['rep_cit_xor', '', '인용 대표 보정 (신규)'], ['ecat_ver · rule_ver', '', '판정 버전'] ], d: {
  grain: '빌드 × 정상 완료 답변 1건 = 1행 (ACR 반복 포함, 본문 제외).', pk: 'build_id + surface + round_date + answer_key',
  inputs: '데이터 분석팀 · app.hidden_market · app.owned_base · app.citation_category · app.ecat_* (엔티티 버전)',
  triggers: '현행: 적재마다, 회차 재평가의 run 귀속 이동, judgment_change 처리(재판정 · 앵커 고정 · 드롭 · 엔티티 버전). 골드는 새 build 로 반영',
  uses: 'KPI 카드·엔진·비교·추이·국가별 GEO, 언급·인용 분석 전반(core.measure), 답변 상세 API 분석 상태(모달은 안 읽음), Website › Prompts 측정 메타, Project › Prompt 영향 답변 수, 답변 목록·회차 관제 API(화면 없음)',
  cur: 'rd.answer (load_id → build_id, own_fp_* 신규) + rd.rep_cit_delta (→ rep_cit_xor)',
  rules: ['골드는 현행 rd.answer 열을 모두 둡니다. *_nc 열은 레거시 프로필 스위치(catalog_incl_deleted · freeze_at_publish · rep_pick_latest_first)가 읽는 대체 모수입니다.', '현행 우선 노출도는 AI 우선 노출도 카드 · 국가별 GEO 현황 모두 경쟁 순위(own_rk_*, rk)입니다. 골드는 레거시(답변 텍스트상 첫 등장 순서)와 맞추려고 own_fp_{h,k,g} 를 새로 둡니다.', '골드에서는 현행 rd.rep_cit_delta(행 존재)를 rep_cit_xor 열로 접습니다. rep_round_date_cell 스위치의 인용 계열 셀 대표 = is_rep XOR rep_cit_xor (동결 읽기 제외).'] } });
tbl('answer_brand_fact', { s: 'gold', name: 'answer_brand_fact', fam: 'fact', grain: '빌드 × 답변 × 표시 브랜드 × 경쟁', cols: [
  ['build_id', 'PF', '빌드 (신규)', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['brand_key', 'PF', '', 'dim_brand'], ['competitive', 'PK', '경쟁 여부 (비경쟁 명단 판정)'], ['C 좌표 사본', 'FK', '', 'cell_key', ['cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']],
  ['own_bit · entity_rows · rid_n', '', ''], ['mention_count · rk', '', '언급 수 · 경쟁 순위'], ['first_pos', '', '텍스트 첫 등장 순서 (신규)'], ['s_pos · s_neu · s_neg · s_mix', '', ''], ['t_mention … t_final_choice', '', '유형 5종', '', ['t_mention', 't_recommendation', 't_comparison', 't_definition', 't_final_choice']],
  ['std_in · elig · dflt · is_rep · std_in_nc', '', '게이트 사본'], ['rule_ver', '', ''] ], d: {
  grain: '빌드 × 답변 × 표시 브랜드 × 경쟁 여부 = 1행.', pk: 'build_id + 답변 PK + brand_key + competitive', inputs: '데이터 분석팀 · app.ecat_* (엔티티 버전) · app.non_competitor_name',
  uses: '경쟁사 표·브랜드 순위·헤드투헤드(/v1/mentions/brands), 국가별 GEO 경쟁사, 멘션 유형·유형 추이, 언급 프롬프트, 답변 모달 언급 브랜드, 인용 도메인의 언급 브랜드 조건·유형 × 카테고리, Project › Prompt 영향 언급 수, Entity catalog 언급 샘플, 답변 목록 API(화면 없음)',
  cur: 'rd.answer_brand (+ build_id · first_pos 신규)',
  rules: ['게이트 열은 answer_fact 사본입니다. 현행은 rd.propagate_answer_gates(std_in · elig · dflt · is_rep · cyc_key)와 rd.fill_answer_nc(std_in_nc)가 복사합니다.', 'first_pos 는 레거시 우선 노출도(답변 텍스트상 첫 등장 순서)와 맞추려는 신규 열입니다.', 'exposure_answers 는 기본 행 수이고, brand_exposure_per_alias 스위치일 때만 Σrid_n 입니다.'] } });
tbl('answer_stance_fact', { s: 'gold', name: 'answer_stance_fact', fam: 'fact', grain: '빌드 × 답변 × 턴 × 엔티티', cols: [
  ['build_id', 'PF', '빌드 (신규)', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['turn_index', 'PK', ''], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key', 'FK', '', 'dim_brand'], ['cyc_key', '', ''],
  ['own_bit · stance', '', '1 긍정 2 중립 3 혼합 4 부정'], ['first_turn', '', '대표 턴'], ['std_in · is_rep · std_in_nc', '', '게이트 사본'] ], d: {
  grain: '빌드 × 답변 × 턴 × 엔티티 = 1행.', pk: 'build_id + 답변 PK + turn_index + entity_key', inputs: '데이터 분석팀 · app.ecat_* (엔티티 버전)',
  uses: '/v1/mentions/types 당사 스탠스 4계열 (Global › Answer analysis › Mention 스탠스 카드, 현재 꺼짐)', cur: 'rd.answer_stance (+ build_id 신규)',
  rules: ['first_turn = (답변, 엔티티) 안 가장 이른 턴. 스탠스 집계는 first_turn 만 셉니다.', '카드 경로는 스탠스를 읽지 않아 발행 세대에 넣지 않습니다.'] } });
tbl('citation_fact', { s: 'gold', name: 'citation_fact', fam: 'fact', grain: '빌드 × 인용 원소 1건', cols: [
  ['build_id', 'PF', '빌드 (신규)', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['ord', 'PK', '인용 순서'], ['url_key', 'FK', '', 'dim_url'], ['source_key', 'FK', '', 'dim_source'], ['C 좌표 사본', 'FK', '', 'cell_key', ['cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']],
  ['scope_key · owner_key', '', ''], ['cit_in · gap · dflt · is_rep · cit_in_nc', '', '게이트 사본'], ['loc_owned · tgt_hit · src_first', '', ''], ['rule_ver', '', ''] ], d: {
  grain: '빌드 × 인용 원소 1건 = 1행.', pk: 'build_id + 답변 PK + ord', inputs: '데이터 분석팀 · app.owned_base · app.project_owned_base · app.project_tracked_url',
  uses: '출처·도메인·톤·카테고리, 인용 프롬프트·도메인 상세, 추이 상위 도메인, 답변 모달 인용, 검수 상세 정규화 URL, Admin › 인용 출처 분류 도메인 인용 수, Project › Prompt 영향 인용 수',
  cur: 'rd.citation (+ build_id 신규)',
  rules: ['URL 문자열은 두지 않고 url_key 로 dim_url 을 참조합니다.', '고유 URL 수는 기간 전체에서 count(DISTINCT url_key) 로 셉니다. 일별 값을 더하지 않습니다.'] } });
tbl('dim_brand', { s: 'gold', name: 'dim_brand', fam: 'kpi', grain: '표시 브랜드 1개', cols: [['brand_key', 'PK', 'int4'], ['name', 'UK', '표시명'], ['bare', 'UK', '정본명 키 (기본 소문자·트림)'], ['kind', '', '0 이름 없음 · 1 자사 · 2 경쟁 · 3 비경쟁'], ['own_bit', '', '0 · 1 Hyundai · 2 Kia · 4 Genesis'], ['first_seen', '', '행 생성일']], d: {
  grain: '표시 브랜드 1개 = 1행 (brand_key 0 = 이름 없음).', pk: 'brand_key', inputs: '데이터 분석팀 · app.brand · app.brand_display_alias · app.competitor_domain_token · app.non_competitor_name',
  uses: '브랜드 이름·자사 비트: 경쟁사 표·브랜드 순위·헤드투헤드, 국가별 GEO, 추이, 인용 도메인, ACR 브랜드 표, 답변 모달·언급 프롬프트, 검수 상세, Entity catalog',
  cur: 'rd.dim_brand_name', rules: ['kind = 1 ⇔ own_bit ≠ 0 (당사 브랜드).'] } });
tbl('dim_entity', { s: 'gold', name: 'dim_entity', fam: 'kpi', grain: '엔티티 1개', cols: [['entity_key', 'PK', 'int4'], ['entity_id', 'UK', 'uuid'], ['entity_type · registry_role', '', ''], ['rep_name', '', '대표 표시명'], ['brand_key', 'FK', '', 'dim_brand'], ['first_seen', '', '행 생성 시각']], d: {
  grain: 'Scope 엔티티 1개 = 1행 (언급·스탠스·ACR 에 나온 전부, entity_type Brand · Product 등).', pk: 'entity_key', inputs: '데이터 분석팀 · app.entity_registry',
  uses: 'ACR 차종 전환율 이름, 명부 제외 브랜드 판정(순위·목록), Entity catalog, 답변 모달·언급 프롬프트의 엔티티 → 브랜드, 검수 상세 이름·ACR', cur: 'rd.dim_entity' } });
