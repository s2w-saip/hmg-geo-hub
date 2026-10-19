
/* ───────── 테이블 정의 ─────────
   cols: [이름, 키(PK|FK|PF|UK|''), 설명, 참조 테이블] · s: gold | silver | app | key | applist | ghost */
const T = {};
function tbl(id, o) { T[id] = Object.assign({ id, cols: [] }, o); }
function ghost(id, cols) { T[id + '_ref'] = { id: id + '_ref', ghostOf: id, s: 'ghost', name: T[id].name, cols: cols || T[id].cols.filter(c => c[1] === 'PK' || c[1] === 'PF').slice(0, 1).map(c => [c[0], 'PK', '']) }; }
const FAM = { dim: '차원', prompt: '프롬프트·웹 유닛', fact: '답변 사실', kpi: 'KPI·언급 셀', cit: '인용 셀', acr: 'ACR', ga4: 'GA4', kw: '키워드', soc: '소셜', pub: '발행 세대', build: '빌드·릴리스', silver: '답변 원문', queue: 'BE 요청 큐', vis: 'AI Visibility' };
const ACCEL = '선택 사항입니다. 없으면 BE 가 지금처럼 사실 테이블에서 계산하고, 성능 병목이 확인된 계열부터 적재합니다.';

/* ── 공통 차원 ── */
tbl('cell_key', { s: 'key', name: 'C 공통 셀 키', fam: 'dim', grain: '셀 집계 PK 의 앞부분 · 사실의 필터 열', cols: [
  ['build_id', 'FK', '빌드(세대)', 'build'], ['population_key', 'FK', '모수 규칙', 'dim_population'], ['surface', '', '1 global · 2 website · 3 project'],
  ['project_key', 'FK', '', 'dim_project'], ['cyc_key', 'FK', '회차', 'dim_cycle'], ['round_date · bucket_date', '', '회차일 · 지표별 버킷'],
  ['prompt_key', 'FK', '', 'dim_prompt'], ['engine_key', 'FK', '', 'dim_engine'], ['geo_key', 'FK', '국가', 'dim_country'], ['lang_key', 'FK', '', 'dim_lang'], ['bgrp', '', '당사 브랜드 그룹 비트'] ], d: {
  grain: '테이블이 아니라 키 묶음입니다. 셀 집계(kpi_cell · brand_cell · citation_cell · url_prompt_cell)의 PK 앞부분이고, 사실 테이블(job_index · answer_fact · answer_brand_fact · citation_fact · acr_cell_fact)은 같은 좌표를 일반 열로 가집니다.',
  pk: '—', inputs: '답변 정제 · 프롬프트 매핑', uses: '모든 필터·권한 축: 표면, 프로젝트, 회차·기간, 프롬프트, 엔진, 국가·권역, 언어, 당사 브랜드',
  cur: 'rd.answer · rd.job 의 필터 열', rules: ['bucket_date 의 의미(측정일 · 회차일 · 앵커일)는 지표별로 고정하고 섞지 않습니다.', '국가·프로젝트·표면 권한을 이 키로 거르므로 상위 합계도 권한 축은 지우지 않습니다.'] } });
tbl('cell_key_c', { s: 'key', ghostOf: 'cell_key', name: 'C 공통 셀 키', cols: [['build · population', '', ''], ['surface · project · cyc', '', ''], ['round_date · bucket', '', ''], ['prompt · engine', '', ''], ['geo · lang · bgrp', '', '']] });
tbl('dim_population', { s: 'gold', name: 'dim_population', fam: 'dim', grain: '모수 규칙 1개', cols: [['population_key', 'PK', 'int2'], ['code', '', 'mentions · citations · gap · url · acr'], ['gate', '', 'std_in · cit_in · web_reg · acr_in'], ['rep_mode', '', '대표 답변 선택 규칙']], d: {
  grain: '셀 집계의 모수 규칙 1개 = 1행.', pk: 'population_key', inputs: '—', uses: '셀 집계의 행 구분', cur: '없음. 사실에서는 answer_fact 의 std_in · cit_in · gap · acr_in 열이 같은 역할',
  rules: ['언급·인용·URL·ACR 모수가 서로 달라 답변 수 하나로 모든 분모를 대신할 수 없습니다.'] } });
tbl('dim_project', { s: 'gold', name: 'dim_project', fam: 'dim', grain: '측정 프로젝트 1개', cols: [
  ['project_key', 'PK', 'int2'], ['scope_project_id', 'UK', 'uuid'], ['surface', '', '1 · 2 · 3'], ['is_root', '', 'global 루트'], ['project_id', 'FK', '', 'app.project'], ['site_id', 'FK', '', 'app.website_site'], ['site_brand_bit · site_geo_key', '', '웹사이트 사이트'], ['regions[]', '', ''] ], d: {
  grain: '측정 프로젝트 1개 = 1행. global 루트, 웹사이트 사이트, 고객 프로젝트가 모두 들어갑니다.', pk: 'project_key', inputs: '프롬프트 매핑 + app.project · app.website_site',
  uses: '표면·프로젝트 권한, 웹사이트 사이트 브랜드·국가, Project 화면 전체', cur: 'rd.dim_project' } });
tbl('dim_cycle', { s: 'gold', name: 'dim_cycle', fam: 'dim', grain: '회차 1개', cols: [
  ['cyc_key', 'PK', '회차 키'], ['cycle_id', 'UK', 'uuid'], ['surface · ledger_backed', '', ''], ['project_key', 'FK', '', 'dim_project'], ['round_date · anchor_date', '', ''], ['status · servable', '', '진행 · 노출 가능'],
  ['view_date · hidden_scope · hidden_reason', '', '노출일 · 숨김'], ['expected_units · completed_units', '', '진행률'], ['completed_answers · gap_answers', '', ''], ['generation · ecat_ver', '', ''] ], d: {
  grain: '회차 1개 = 1행. 프로젝트 가상 회차도 같은 발급처에서 키를 받습니다.', pk: 'cyc_key', inputs: '답변 정제 (회차 확정) + judgment_change cycle_admin',
  uses: '기간·회차 선택, 추이, 이전 기간 비교, 회차 관제(진행률·숨김·노출일), 엔티티 카탈로그 반영 범위', cur: 'rd.cycle (열 전부)',
  rules: ['servable · view_date · hidden_scope 는 조회 게이트입니다. release 를 거치지 않고 바뀐 즉시 보이며, 바뀌면 data_version 을 올립니다.', '골드 집계는 회차 분석이 끝난 뒤 계산합니다 (20261015/D07).'] } });
tbl('cycle_pick_basis', { s: 'gold', name: 'cycle_pick_basis', fam: 'dim', grain: '회차 1개의 창 판정 근거', cols: [
  ['cyc_key', 'PF', '', 'dim_cycle'], ['fleet_visible', '', '웹 함대 가시'], ['gap_ratio', '', '판정 갭 비율 numeric(6,5)'], ['gap_src', '', 'ops · hub'], ['ops_status', '', '이관 회차 운영 상태 (generating …)'], ['updated_at', '', ''] ], d: {
  grain: '회차 1개 = 1행.', pk: 'cyc_key', inputs: '답변 정제 (회차 진행률) · 이관 회차 운영 원값', triggers: '회차 진행률 변경, 이관',
  uses: '기간 선택 시 카드 동결 판정의 생성 대기 구멍(pick_holes): 닫힘 ∧ 원장 회차 ∧ 숨김 아님 ∧ (웹이면 fleet_visible) ∧ gap_ratio ≤ 0.05 ∧ ops_status ≠ generating ∧ 활성 발행 없음', cur: 'rd.cycle_pick_basis (열 전부)',
  rules: ['이관 회차의 gap_ratio 는 현행 운영 원값(gap_src ops), 허브 회차는 허브 재계산값(gap_src hub)입니다.', '바뀌면 data_version 을 올립니다 (현행은 rcache 트리거).'] } });
tbl('dim_engine', { s: 'gold', name: 'dim_engine', fam: 'dim', grain: 'AI 엔진 1개', cols: [['engine_key', 'PK', 'int2'], ['code', 'UK', 'AI 엔진 코드'], ['is_default', '', '기본 노출']], d: {
  grain: 'AI 엔진 1개 = 1행.', pk: 'engine_key', inputs: '답변 정제', uses: '엔진 필터, 엔진별 KPI·출처·전환, 프로젝트 엔진 설정', cur: 'rd.dim_engine' } });
tbl('dim_country', { s: 'gold', name: 'dim_country', fam: 'dim', grain: '국가(시장) 1개', cols: [['geo_key', 'PK', 'int2'], ['code', 'UK', 'ISO · pseudo'], ['region_key', 'FK', '권역', 'dim_region'], ['kind · virtual_brand_bit', '', 'iso · pseudo · virtual_brand'], ['hidden_standard', '', '표준 숨김 시장']], d: {
  grain: '국가(시장) 1개 = 1행.', pk: 'geo_key', inputs: '답변 정제 · GA4 AI 유입 분류(시장 매핑)', uses: '국가 필터·권한, 국가별 GEO 현황, GA4 국가별 전환, 사용자 국가 범위', cur: 'rd.dim_country' } });
tbl('dim_region', { s: 'gold', name: 'dim_region', fam: 'dim', grain: '권역 1개', cols: [['region_key', 'PK', 'int2'], ['code', 'UK', '권역 코드']], d: {
  grain: '권역 1개 = 1행.', pk: 'region_key', inputs: 'app.rhq_region', uses: '권역·본사 전환율, 권역 필터 옵션', cur: 'rd.dim_region' } });
tbl('dim_lang', { s: 'gold', name: 'dim_lang', fam: 'dim', grain: '언어 1개', cols: [['lang_key', 'PK', 'int2'], ['code', 'UK', '소문자 언어 코드']], d: {
  grain: '언어 1개 = 1행.', pk: 'lang_key', inputs: '답변 정제', uses: '언어 필터, 웹사이트 유닛·타겟 URL', cur: 'rd.dim_lang' } });

/* ── 프롬프트 · 카탈로그 · 웹 유닛 ── */
tbl('dim_prompt', { s: 'gold', name: 'dim_prompt', fam: 'prompt', grain: '측정 프롬프트 1개', cols: [
  ['prompt_key', 'PK', 'int4'], ['prompt_id', 'UK', 'uuid'], ['surface · kind', '', 'single · acr'], ['project_key', 'FK', '', 'dim_project'], ['text', '', '검색용 본문'], ['lang_key', 'FK', '', 'dim_lang'], ['funnel_key', 'FK', '', 'dim_taxon'],
  ['cat_mask · cat_mask_all', '', '카탈로그 비트 · 삭제 포함'], ['in_root_catalog · in_root_catalog_all', '', ''], ['unit_key', 'FK', '웹 보고 유닛', 'web_unit'], ['targets[]', '', '웹 타겟 URL 정규형'], ['web_reg', '', '웹 카탈로그 등록'], ['regions[] · is_korean', '', ''], ['rule_ver', '', ''] ], d: {
  grain: '측정 프롬프트 1개 = 1행 (single · acr).', pk: 'prompt_key', inputs: '프롬프트 원천 → 프롬프트 매핑 + app 카탈로그',
  uses: '프롬프트 필터·검색, 측정 프롬프트 수, 미측정 목록, URL 인용률 분모(web_reg), 카탈로그 관리, 검수 목록', cur: 'rd.dim_prompt (열 전부)',
  rules: ['cat_mask_all · in_root_catalog_all 은 삭제 행 포함 카탈로그 프로필 스위치(A41)가 씁니다.'] } });
tbl('catalog_entry', { s: 'gold', name: 'catalog_entry', fam: 'prompt', grain: '빌드 × 카탈로그 행 (삭제 포함)', cols: [
  ['catalog_row_id', 'PK', 'uuid'], ['prompt_key', 'FK', '', 'dim_prompt'], ['brand_bit', '', '카탈로그 브랜드'], ['kind', '', 'single · acr …'], ['presence_key', 'FK', '', 'dim_taxon'], ['funnel_key · list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon'], ['depth4_key', 'FK', '신규 · 현행은 app.prompt.depth4', 'dim_taxon'], ['build_id', 'PF', '현행 load_id', 'build'] ], d: {
  grain: '빌드 × 카탈로그 행 1개 = 1행. 한 프롬프트에 여러 행이 붙을 수 있습니다.', pk: 'build_id + catalog_row_id', inputs: 'app 카탈로그 (judgment_change catalog · website_catalog)',
  uses: 'KPI 요약의 적용·측정 프롬프트 수와 퍼널, 국가별 GEO 카탈로그 게이트, 필터 옵션, 답변 상세 택소노미', cur: 'rd.catalog_entry',
  rules: ['여러 카탈로그 행이 붙어도 측정 수를 중복하지 않게 EXISTS 로만 거릅니다.', 'depth4 필터(대시보드·언급·인용·Visibility·ACR·프롬프트 목록)는 depth4_key 로 겁니다. 현행 BE 는 app.prompt.depth4 를 catalog_row_id = prompt_id 로 붙여 읽습니다.'] } });
tbl('dim_taxon', { s: 'gold', name: 'dim_taxon', fam: 'prompt', grain: '택소노미 코드 1개', cols: [['taxon_key', 'PK', 'int2'], ['axis', '', 'funnel · presence · list_type · depth1~4'], ['code', '', ''], ['parent_key', 'FK', '상위 코드', 'dim_taxon']], d: {
  grain: '택소노미 코드 1개 = 1행.', pk: 'taxon_key', inputs: 'app 카탈로그', uses: '필터 옵션, 퍼널 분포, 카탈로그 관리', cur: 'rd.dim_taxon' } });
tbl('web_unit', { s: 'gold', name: 'web_unit', fam: 'prompt', grain: '웹사이트 보고 유닛 1개', cols: [
  ['unit_key', 'PK', 'int2'], ['project_key', 'FK', '', 'dim_project'], ['file_seq', 'UK', '보고 유닛 번호'], ['lang_codes[]', '', ''], ['base · base_src', '', '소유 베이스'], ['sibs[] · home_host', '', ''], ['turls[]', '', '타겟 URL'], ['rule_ver', '', ''] ], d: {
  grain: '웹사이트 보고 유닛 1개 = 1행.', pk: 'unit_key (프로젝트 × file_seq 유일)', inputs: 'app.website_report_unit + 프롬프트 매핑',
  uses: 'Website KPI 모수 게이트(보고서 유닛 소속), ⑥ 유닛 판정, 웹 자사·타겟 판정', cur: 'rd.web_unit' } });
tbl('web_report_prompt', { s: 'gold', name: 'web_report_prompt', fam: 'prompt', grain: '프롬프트의 보고 유닛 소속', cols: [['prompt_key', 'PF', '', 'dim_prompt'], ['report_fs', 'FK', 'file_seq', 'web_unit']], d: {
  grain: '웹 프롬프트 1개의 보고 유닛 소속 = 1행.', pk: 'prompt_key', inputs: '프롬프트 매핑', uses: 'Website 모수 게이트 (WEBREG16, LIVE)', cur: 'rd.web_report_prompt' } });
tbl('web_target_url', { s: 'gold', name: 'web_target_url', fam: 'prompt', grain: '프로젝트 × 언어 × 타겟 URL', cols: [['project_key', 'PF', '', 'dim_project'], ['lang_key', 'PF', '', 'dim_lang'], ['url_key', 'PF', '', 'dim_url']], d: {
  grain: '웹 프로젝트 × 언어 × 타겟 URL = 1행. 타겟 정규형을 dim_url 키로 미리 풀어 둡니다.', pk: 'project_key + lang_key + url_key', inputs: '자사/타겟 URL 매칭',
  uses: '⑥ AI 타겟 출처 인용률 (LIVE)', cur: 'rd.web_target_url' } });
tbl('website_report_excluded', { s: 'app', name: 'website_report_excluded', fam: 'prompt', grain: '제외 보고 유닛', cols: [['file_seq', 'PF', '', 'web_unit'], ['note', '', '']], d: {
  grain: 'Website 모수에서 뺄 보고 유닛 1개 = 1행. GEO HUB 설정입니다.', pk: 'file_seq', inputs: 'GEO HUB 설정', uses: 'Website 모수 게이트 (조회 시점 적용)', cur: 'app.website_report_excluded' } });

/* ── 답변 사실 ── */
tbl('job_index', { s: 'gold', name: 'job_index', fam: 'fact', grain: 'Scope job 1건 (모든 상태)', cols: [
  ['answer_key', 'PK', 'int4'], ['job_id', 'UK', 'uuid'], ['run_key', '', ''], ['C 좌표', 'FK', 'cyc·prompt·project·engine·geo·lang·bgrp', 'cell_key', ['cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']], ['surface · round_date', '', ''], ['measured_at', '', '측정 시각'],
  ['status_code', '', '0 완료 · 1 대기·실행 · 2 실패'], ['analysis_code', '', ''], ['dropped · served', '', ''], ['last_build_id', 'FK', '마지막 반영 build (현행 load_id)', 'build'] ], d: {
  grain: 'Scope job 1건 = 1행. 대기·실행·실패·드롭까지 모든 상태를 담습니다.', pk: 'answer_key (job_id 유일)', inputs: '답변 원문 → 답변 정제', triggers: '적재마다, 드롭·앵커 고정 반영',
  uses: '필터 옵션(국가·엔진 매트릭스), 답변 모달 링크(job_id), 추이의 측정 일수(measured_at), 회차·job 관제, 검수 목록·진행률·노트, scope 연결 진단', cur: 'rd.job',
  rules: ['served = 완료 ∧ 드롭 아님. answer_fact 는 served job 만 가집니다.', 'job_id ↔ answer_key 해석과 접근 범위 검사(fail-closed)가 이 테이블을 거칩니다.', 'build 로 나누지 않는 현재 상태 원장입니다. 대기·실행·실패가 build 없이 바로 보여야 해서 release 밖에 두고, 바뀌면 data_version 을 올립니다.'] } });
tbl('answer_fact', { s: 'gold', name: 'answer_fact', fam: 'fact', grain: '빌드 × 정상 완료 답변 1건', cols: [
  ['build_id', 'PF', '', 'build'], ['surface · round_date', 'PK', '파티션'], ['answer_key', 'PF', '', 'job_index'], ['C 좌표', 'FK', 'cyc·run·prompt·project·engine·geo·lang·bgrp', 'cell_key', ['cyc_key', 'run_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']],
  ['anchor_date · anchor_src · region_geo_key', '', ''], ['cat_mask · acr_iter_rank · analysis_state', '', ''], ['elig · dflt · is_acr · is_rep · web_reg', '', '게이트'], ['std_in · cit_in · gap · acr_in', '', '모수'],
  ['elig_nc · std_in_nc · cit_in_nc', '', '프로필 대체 모수'], ['own_mask · own_rk_{h,k,g} · t_own', '', '당사 경쟁 순위'], ['own_fp_{h,k,g}', '', '텍스트 첫 등장 · 신규'], ['ment_total · ment_{h,k,g}', '', ''],
  ['sent_{pos,neg,all}_{h,k,g}', '', ''], ['cit_n · cit_n_all · cit_off', '', '인용 수 · Official'], ['cit_own_{h,k,g}[c] · cit_own_x', '', '글로벌 자사', '', ['cit_own_h', 'cit_own_k', 'cit_own_g', 'cit_own_hc', 'cit_own_kc', 'cit_own_gc', 'cit_own_x']], ['cit_loc · cit_tgt · cit_loc_tgt', '', '웹·프로젝트 자사'],
  ['cit_c1 … cit_c13', '', '카테고리별'], ['has_cit · tgt_cited · own_url_cited', '', 'URL 인용률'], ['rep_cit_xor', '', '인용 대표 보정'], ['ecat_ver · rule_ver', '', '판정 버전'] ], d: {
  grain: '빌드 × 정상 완료 답변 1건 = 1행 (ACR 반복 포함, 본문 제외).', pk: 'build_id + surface + round_date + answer_key',
  inputs: '답변 정제 · 프롬프트 매핑 · 브랜드 언급 추출 · 언급 감정 분류 · 인용 정규화 · 자사/타겟 URL 매칭', triggers: '회차 마감, 재판정(judgment_change), 드롭·앵커 고정',
  uses: 'KPI 카드·엔진·비교·추이·국가별 GEO, 언급·인용 분석 전반, 답변 목록, 회차 관제, 프롬프트 라이프사이클 영향 수, scope 연결 진단', cur: 'rd.answer (열 전부) + rd.rep_cit_delta',
  rules: ['현행 rd.answer 열을 줄이지 않습니다. *_nc 열은 레거시 프로필 스위치가 쓰는 대체 모수입니다.', 'own_fp_{h,k,g} 는 GEO 우선 노출도(T001)용 신규 열입니다. 텍스트상 첫 등장 순서입니다.', 'rep_cit_xor 는 현행 rd.rep_cit_delta 를 열로 접은 것입니다. 답변분석 인용 대표 = is_rep XOR rep_cit_xor.'] } });
tbl('answer_brand_fact', { s: 'gold', name: 'answer_brand_fact', fam: 'fact', grain: '빌드 × 답변 × 표시 브랜드 × 경쟁', cols: [
  ['build_id', 'PF', '', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['brand_key', 'PF', '', 'dim_brand'], ['competitive', 'PK', '경쟁 행'], ['C 좌표 사본', 'FK', '', 'cell_key', ['cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']],
  ['own_bit · entity_rows · rid_n', '', ''], ['mention_count · rk', '', '경쟁 순위'], ['first_pos', '', '텍스트 첫 등장 · 신규'], ['s_pos · s_neu · s_neg · s_mix', '', ''], ['t_mention … t_final_choice', '', '유형 5종', '', ['t_mention', 't_recommendation', 't_comparison', 't_definition', 't_final_choice']],
  ['std_in · elig · dflt · is_rep · std_in_nc', '', '게이트 사본'], ['rule_ver', '', ''] ], d: {
  grain: '빌드 × 답변 × 표시 브랜드 × 경쟁 여부 = 1행.', pk: 'build_id + 답변 PK + brand_key + competitive', inputs: '브랜드 언급 추출 · 언급 감정 분류',
  uses: '경쟁사 표, 브랜드 순위·주별 언급, 멘션 유형, 헤드투헤드, 답변 목록 브랜드 배지, 인용 출처의 언급 브랜드 조건, 엔티티 카탈로그 버전 영향', cur: 'rd.answer_brand',
  rules: ['게이트 열은 answer_fact 사본입니다 (현행 rd.propagate_answer_gates).', 'first_pos 는 T001 용 신규 열입니다.', 'exposure_answers = Σrid_n (프로필 스위치).'] } });
tbl('answer_stance_fact', { s: 'gold', name: 'answer_stance_fact', fam: 'fact', grain: '빌드 × 답변 × 턴 × 엔티티', cols: [
  ['build_id', 'PF', '', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['turn_index', 'PK', ''], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key', 'FK', '', 'dim_brand'], ['cyc_key', '', ''],
  ['own_bit · stance', '', '1 긍정 2 중립 3 혼합 4 부정'], ['first_turn', '', '대표 턴'], ['std_in · is_rep · std_in_nc', '', '게이트 사본'] ], d: {
  grain: '빌드 × 답변 × 턴 × 엔티티 = 1행.', pk: 'build_id + 답변 PK + turn_index + entity_key', inputs: '언급 감정 분류(스탠스)',
  uses: '멘션 유형 화면의 스탠스 4종 분포, 답변 상세', cur: 'rd.answer_stance',
  rules: ['first_turn = (답변, 엔티티) 안 가장 이른 턴. 화면 집계는 first_turn 만 셉니다.', '카드 경로는 스탠스를 읽지 않아 발행 세대에 넣지 않습니다.'] } });
tbl('citation_fact', { s: 'gold', name: 'citation_fact', fam: 'fact', grain: '빌드 × 인용 원소 1건', cols: [
  ['build_id', 'PF', '', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['ord', 'PK', '인용 순서'], ['url_key', 'FK', '', 'dim_url'], ['source_key', 'FK', '', 'dim_source'], ['C 좌표 사본', 'FK', '', 'cell_key', ['cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']],
  ['scope_key · owner_key', '', ''], ['cit_in · gap · dflt · is_rep · cit_in_nc', '', '게이트 사본'], ['loc_owned · tgt_hit · src_first', '', ''], ['rule_ver', '', ''] ], d: {
  grain: '빌드 × 인용 원소 1건 = 1행.', pk: 'build_id + 답변 PK + ord', inputs: '인용 정규화 · 자사/타겟 URL 매칭',
  uses: '출처·도메인·톤·카테고리, 인용 프롬프트·도메인 상세, 추이, 출처 교정 영향 수, 프롬프트 라이프사이클 영향 수, 검수 상세', cur: 'rd.citation',
  rules: ['URL 문자열은 dim_url 에만 둡니다.', '일별 고유 URL 수를 더하지 않습니다.'] } });
tbl('dim_brand', { s: 'gold', name: 'dim_brand', fam: 'kpi', grain: '표시 브랜드 1개', cols: [['brand_key', 'PK', 'int4'], ['name', 'UK', '표시명'], ['bare', 'UK', '접두 없는 이름'], ['kind', '', '0 ~ 3'], ['own_bit', '', '0 · 1 · 2 · 4'], ['first_seen', '', '처음 관측']], d: {
  grain: '표시 브랜드 1개 = 1행.', pk: 'brand_key', inputs: '브랜드 언급 추출(롤업) + app 엔티티 카탈로그', uses: '경쟁사 표, 브랜드 순위, 헤드투헤드, ACR 브랜드 표, 엔티티 관리',
  cur: 'rd.dim_brand_name', rules: ['kind = 1 ⇔ own_bit ≠ 0 (당사 브랜드).'] } });
tbl('dim_entity', { s: 'gold', name: 'dim_entity', fam: 'kpi', grain: '엔티티 1개', cols: [['entity_key', 'PK', 'int4'], ['entity_id', 'UK', 'uuid'], ['entity_type · registry_role', '', ''], ['rep_name', '', '대표 표시명'], ['brand_key', 'FK', '', 'dim_brand'], ['first_seen', '', '처음 관측']], d: {
  grain: '엔티티 1개 = 1행 (브랜드 · 차종 · 회사).', pk: 'entity_key', inputs: '브랜드 언급 추출 + app 엔티티 카탈로그(ecat)', uses: 'ACR 차종·회사 레벨, 엔티티 관리, 답변·검수 상세 역할 표시', cur: 'rd.dim_entity' } });

/* ── KPI · 언급 셀 ── */
tbl('dim_perspective', { s: 'gold', name: 'dim_perspective', fam: 'kpi', grain: '당사 브랜드 조합 1개', cols: [['perspective_key', 'PK', 'int2'], ['own_bits', '', '1 현대 · 2 기아 · 4 제네시스'], ['label', '', 'HMG 통합 · 브랜드별']], d: {
  grain: '당사 브랜드 비트 조합 1개 = 1행. 실제 쓰는 조합만 둡니다 (최대 7개).', pk: 'perspective_key', inputs: '—', uses: '셀 집계의 관점 구분', cur: '없음. 사실에서는 own_bits 로 _h · _k · _g 열을 고릅니다.',
  rules: ['조회는 관점 1개를 명시해 중복 합산을 막습니다.'] } });
tbl('kpi_cell', { s: 'gold', name: 'kpi_cell', fam: 'kpi', grain: '셀(C) × 관점 · 가속', cols: [
  ['C', 'PF', '셀 키 12열', 'cell_key'], ['perspective_key', 'PF', '', 'dim_perspective'], ['answers · tracked', '', '노출률'], ['own_mentions · total_mentions', '', '점유율'], ['sent_pos · sent_neg · sent_all', '', '우호도'],
  ['st_pos · st_neu · st_mix · st_neg', '', '스탠스 4종'], ['rank_sum · ranked', '', '경쟁 순위'], ['fp_sum · fp_n', '', '텍스트 첫 등장 · 신규'], ['multi_answers · multi_mentions', '', '복수 언급'], ['t_mention … t_final_choice', '', '유형 5종'],
  ['gap_answers · gap_base', '', '분석 누락'], ['cit_total · cit_m05 · cit_owned', '', '인용 점유율'], ['has_measured · has_mention', '', '프롬프트 존재'] ], d: {
  grain: '셀(C) × 관점 1개 = 1행. 언급·인용이 0 이어도 분모 셀은 남깁니다.', pk: 'C(12) + perspective_key', inputs: 'answer_fact · answer_stance_fact (같은 build)', triggers: '사실 build 와 같은 빌드',
  uses: 'KPI 요약·엔진·비교, 국가별 GEO, 추이, 멘션 유형 스탠스 분포 → /v1/kpi/*, /v1/geo, /v1/trend, /v1/mentions/types', cur: '없음 (신규 가속층). 현행은 rd.answer 를 조회 때마다 SUM',
  rules: [ACCEL, 'M05 인용 점유율 분자: global 은 cit_m05(= Σcit_off, Official 카테고리), website · project 는 cit_owned. 서로 대체하지 않습니다.', '우선 노출도: 카드 ④는 경쟁 순위(rank_sum), 국가별 GEO 현황은 텍스트 첫 등장(fp_sum)을 씁니다 (T001).'] } });
tbl('kpi_rollup', { s: 'gold', name: 'kpi_rollup', fam: 'kpi', grain: '상위 합계 D × 관점 · 가속', cols: [['D', 'PF', 'C − prompt_key', 'cell_key'], ['perspective_key', 'PF', '', 'dim_perspective'], ['rollup_kind', 'PK', ''], ['(가산 열)', '', 'kpi_cell 과 동일'], ['eligibility', '', '지원 축 · 대표 창']], d: {
  grain: 'kpi_cell 에서 prompt_key 를 뺀 상위 합계 1행.', pk: 'D + perspective_key + rollup_kind', inputs: 'kpi_cell (같은 build 에서 SUM)', uses: '프롬프트 필터 없는 KPI · 국가 · 엔진 조회 가속', cur: '없음 (신규)',
  rules: ['택소노미·검색처럼 rollup 이 표현하지 못하는 축이 걸리면 kpi_cell 이나 사실을 읽습니다.'] } });
tbl('brand_cell', { s: 'gold', name: 'brand_cell', fam: 'kpi', grain: '셀(C) × 브랜드 × 경쟁 · 가속', cols: [
  ['C', 'PF', '셀 키 12열', 'cell_key'], ['brand_key', 'PF', '', 'dim_brand'], ['competitive', 'PK', ''], ['mention_count', '', ''], ['answers_present', '', 'Σrid_n'], ['rank_sum · ranked', '', '경쟁 순위'], ['fp_sum · fp_n', '', '텍스트 첫 등장 · 신규'],
  ['s_pos · s_neu · s_neg · s_mix', '', ''], ['t_mention … t_final_choice', '', '유형 5종'], ['multi_answers · multi_mentions', '', ''], ['has_brand · has_multi', '', '프롬프트 존재'] ], d: {
  grain: '셀(C) × 표시 브랜드 × 경쟁 여부 = 1행.', pk: 'C(12) + brand_key + competitive', inputs: 'answer_brand_fact (같은 build)', triggers: '사실 build 와 같은 빌드',
  uses: '경쟁사 표, 브랜드 언급 순위, 주별 언급 수, GEO 경쟁 비교 → /v1/mentions/brands, /v1/geo', cur: '없음 (신규 가속층). 현행은 rd.answer_brand 를 조회 때 집계',
  rules: [ACCEL, 'HMG 통합 관점은 브랜드 행을 더하지 않고 kpi_cell 관점 행을 씁니다.', '형제 HMG 브랜드는 경쟁 행에 남습니다 (M-1).'] } });
tbl('entity_mention_total', { s: 'gold', name: 'entity_mention_total', fam: 'kpi', grain: '엔티티 전 기간 합계', cols: [['entity_id', 'PF', 'dim_entity.entity_id (UK)', 'dim_entity'], ['answers', '', '언급 답변 수'], ['mentions', '', '언급 수'], ['updated_at', '', '']], d: {
  grain: '엔티티 1개의 전 기간 합계 = 1행. 기간·게이트 없이 드롭 답변만 뺍니다.', pk: 'entity_id', inputs: '브랜드 언급 추출', uses: 'Admin > Entity catalog 엔티티 목록·수', cur: 'rd.entity_mention_total' } });

/* ── 인용 셀 ── */
tbl('citation_cell', { s: 'gold', name: 'citation_cell', fam: 'cit', grain: '셀 × 관점 × 출처 × 소유 · 가속', cols: [
  ['C', 'PF', '셀 키 12열', 'cell_key'], ['perspective_key', 'PF', '', 'dim_perspective'], ['source_key', 'PF', '', 'dim_source'], ['owner_key', 'PF', '', 'owned_base'], ['category_key', 'PF', '유효 카테고리', 'dim_category'],
  ['loc_owned · tgt_hit', 'PK', '소유 · 타겟 판정'], ['citations', '', '인용 원소 수'], ['source_first_count', '', 'src_first 합'], ['cit_t_{mention…final}', '', '유형 5종'], ['cit_pos · cit_neg', '', '톤별 인용'] ], d: {
  grain: '셀(C) × 관점 × 출처 × 소유자 × 유효 카테고리 × 소유·타겟 판정 = 1행.', pk: 'C(12) + perspective_key + source_key + owner_key + category_key + loc_owned + tgt_hit',
  inputs: 'citation_fact + answer_fact(톤) (같은 build)', triggers: '사실 build 와 같은 빌드', uses: '도메인·출처 순위, 긍정/부정 답변 인용, 출처 카테고리, 자사 인용/미인용 프롬프트 → /v1/citations/*',
  cur: '없음 (신규 가속층). 현행은 rd.citation ⋈ dim_source · dim_url 을 조회 때 집계',
  rules: [ACCEL, '소유·출처 조건을 먼저 걸고 나서 축을 지워 합칩니다.', '자사 미인용 = 인용은 1건 이상인데 자사 인용이 0 인 프롬프트입니다.'] } });
tbl('url_prompt_cell', { s: 'gold', name: 'url_prompt_cell', fam: 'cit', grain: '셀(C) · 가속', cols: [['C', 'PF', '셀 키 12열', 'cell_key'], ['eligible', '', '적격 프롬프트'], ['any_target · any_owned', '', 'BOOL_OR 용'], ['url_den', '', '측정 단위 분모'], ['tgt_hits · own_url_hits', '', ''], ['tgt_own_hits', '', '정확도 분자']], d: {
  grain: '셀(C) 1개 = 1행.', pk: 'C(12)', inputs: 'answer_fact (tgt_cited · own_url_cited · web_reg)', uses: '자사 URL 인용률 · 타겟 URL 인용률 · 인용 정확도 (Website · Project)',
  cur: '없음 (신규 가속층)', rules: [ACCEL, '엔진·회차를 합칠 때 prompt_key 기준 OR 로 묶습니다.'] } });
tbl('report_value', { s: 'gold', name: 'report_value', fam: 'cit', grain: '발행 × 보고 유닛', cols: [
  ['build_id', 'PK', ''], ['pub_id', 'PK', '발행 ID'], ['round_date · file_seq', 'PK', '보고 유닛'], ['cyc_key', 'FK', '', 'dim_cycle'], ['brand · country_code · lang_code', '', ''], ['in_headline_pool', '', ''],
  ['target_hit_prompts · measured_prompts', '', ''], ['owned_prompts · owned_prompts_den', '', ''], ['prev_*', '', '전 회차 4종', '', ['prev_target_hit_prompts', 'prev_measured_prompts', 'prev_owned_prompts', 'prev_owned_prompts_den']] ], d: {
  grain: '발행 1건 × 보고 유닛(file_seq) 1개 = 1행.', pk: 'build_id + pub_id + round_date + file_seq', inputs: '자사/타겟 URL 매칭 + app.report_publication',
  triggers: '발행 · 명시적 재발행 (judgment_change report_publication)', uses: 'Website ⑥ AI 타겟 출처 인용률 발행값 (R09 우선) → /v1/citations/targets', cur: 'rd.report_unit_value',
  rules: ['발행값을 원문 재계산값으로 자동 교체하지 않습니다.', '발행 유닛을 답변 수로 가중하지 않습니다.'] } });
tbl('dim_source', { s: 'gold', name: 'dim_source', fam: 'cit', grain: '출처(도메인) 1개', cols: [
  ['source_key', 'PK', 'int4'], ['skey', 'UK', '도메인 정규 키'], ['domain · is_social', '', ''], ['category_key', 'FK', '', 'dim_category'], ['category_src', '', '판정 출처 1~6'], ['owned_brand_bit', '', '당사 공식 도메인'], ['competitor_brand_key', 'FK', '', 'dim_brand'], ['rule_ver', '', ''] ], d: {
  grain: '출처(도메인) 1개 = 1행.', pk: 'source_key', inputs: '인용 정규화 + app.citation_domain_override', uses: '도메인 인용 순위, 출처 카테고리, 경쟁사 공식 도메인, 출처 교정 화면', cur: 'rd.dim_source' } });
tbl('dim_url', { s: 'gold', name: 'dim_url', fam: 'cit', grain: 'URL 1개 (인용 · 자사 페이지)', cols: [
  ['url_key', 'PK', 'int4 · 0 예약'], ['url_hash', 'UK', ''], ['url · title', '', ''], ['url_norm · url_base_norm', '', ''], ['host · domain', '', ''], ['source_key', 'FK', '', 'dim_source'], ['owner_key', 'FK', '', 'owned_base'], ['rule_ver', '', ''] ], d: {
  grain: '인용 URL 또는 자사 페이지 1개 = 1행.', pk: 'url_key', inputs: '인용 정규화 · 자사/타겟 URL 매칭 · 자사 사이트 페이지 목록', uses: '인용 URL 목록, 타겟 URL 매칭, 답변·검수 상세, AI Visibility 페이지 URL', cur: 'rd.dim_url',
  rules: ['AI Visibility 페이지와 인용 URL 은 같은 url_norm → 같은 url_key 입니다. 인용되지 않은 자사 페이지도 행을 만듭니다 (신규).'] } });
tbl('dim_category', { s: 'gold', name: 'dim_category', fam: 'cit', grain: '출처 카테고리 1개', cols: [['category_key', 'PK', 'int2'], ['name', 'UK', ''], ['slug', '', ''], ['ord', '', '표시 순서']], d: {
  grain: '출처 카테고리 1개 = 1행.', pk: 'category_key', inputs: 'app.citation_category 투영', uses: '출처 카테고리 도넛·추이, 공식(HMG)·딜러·마켓 비중. answer_fact.cit_c1~c13 의 번호', cur: 'app.citation_category' } });
tbl('owned_base', { s: 'app', name: 'owned_base', fam: 'cit', grain: '당사 소유 베이스 1개', cols: [['owner_key', 'PK', 'int2'], ['kind', '', 'base · root_home'], ['prefix · host', '', ''], ['brand_code', '', ''], ['geo_code · language', '', '']], d: {
  grain: '당사 소유 URL 베이스 1개 = 1행. GEO HUB 설정입니다.', pk: 'owner_key', inputs: 'GEO HUB 관리 화면', uses: 'Global 자사 인용 판정, KPI ⑥ 분모', cur: 'app.owned_base',
  rules: ['바뀌면 judgment_change owned_base → 재판정 → 영향 회차 새 build.'] } });

/* ── ACR ── */
tbl('acr_cell_fact', { s: 'gold', name: 'acr_cell_fact', fam: 'acr', grain: '빌드 × ACR 셀', cols: [
  ['build_id', 'PF', '', 'build'], ['acr_cell_key', 'PK', 'ACR 셀'], ['C 좌표', 'FK', 'surface 포함', 'cell_key', ['surface', 'cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']], ['round_date · measured_date', '', ''], ['cat_mask', '', ''], ['planned · valid_turn1 · valid_acr', '', '반복 모수'],
  ['co_single · co_conditional · co_generic', '', '결과 유형'], ['co_off_shortlist · co_unresolved · co_none', '', ''], ['is_rep · acr_in', '', ''], ['rule_ver', '', ''] ], d: {
  grain: '빌드 × ACR 셀(프롬프트 × 엔진 × 국가 × 회차의 반복 측정 묶음) = 1행.', pk: 'build_id + acr_cell_key', inputs: 'ACR 답변 원문 → 답변 정제 → ACR 최종 선택 판정', triggers: 'ACR 수집 완료, 반복·셀 재판정',
  uses: 'Top1 · Top5 ACR, 답변 수, 1순위 횟수, 측정 프롬프트·셀·반복 수, 선택률 추이, 검수 상세 ACR 블록 → /v1/funnel/acr', cur: 'rd.acr_cell',
  rules: ['선택률 = choice / 전체 valid_acr · coverage = 등장 셀 / 전체 셀'] } });
tbl('acr_entity_fact', { s: 'gold', name: 'acr_entity_fact', fam: 'acr', grain: '빌드 × ACR 셀 × 레벨 × 엔티티', cols: [
  ['build_id · acr_cell_key', 'PF', '', 'acr_cell_fact'], ['level', 'PK', '1 브랜드 · 2 차종 · 3 회사'], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key · parent_brand_key', 'FK', '차종 소속', 'dim_brand'], ['own_bit · name_own', '', ''],
  ['appearance · choice · cond_choice', '', ''], ['off_shortlist · unresolved · generic', '', ''], ['keep', '', '표시 유지'] ], d: {
  grain: '빌드 × ACR 셀 × 레벨 × 엔티티 = 1행.', pk: 'build_id + acr_cell_key + level + entity_key', inputs: 'ACR 최종 선택 판정 · 브랜드 언급 추출',
  uses: '브랜드별 ACR 표, 모델별 선택 구도(배틀 그리드), 차종별 선택 전환율, 모델별 점유 맵, 검수 상세', cur: 'rd.acr_choice (레벨 파티션)',
  rules: ['배틀 승자는 국가 등 필터를 건 뒤 계산합니다. 국가별 승자만 저장하지 않습니다.', '차종 분모 = 차종 엔티티 행에 붙은 셀의 valid_acr 합. 표시명 병합 때 임의로 중복 제거하지 않습니다.', 'appearance 는 언급 기반이라 반복 수보다 클 수 있습니다. 후보군 등장 run 수는 acr_iter_shortlist 로 셉니다.'] } });
tbl('acr_iter_fact', { s: 'gold', name: 'acr_iter_fact', fam: 'acr', grain: '빌드 × ACR 셀 × 반복', cols: [
  ['build_id · acr_cell_key', 'PF', '', 'acr_cell_fact'], ['iter_no', 'PK', '= answer_fact.acr_iter_rank'], ['answer_key', 'FK', '반복 job', 'job_index'], ['result_type', '', '1 single · 2 conditional · 3 generic · 4 off_shortlist · 5 unresolved · 6 none'],
  ['winner_brand_key', 'FK', '0 = 선택 없음', 'dim_brand'], ['winner_entity_key', 'FK', '차종 · 없으면 0', 'dim_entity'], ['own_bit', '', ''] ], d: {
  grain: '빌드 × ACR 셀 × 반복 1회 = 1행.', pk: 'build_id + acr_cell_key + iter_no', inputs: 'ACR 최종 선택 판정 (반복 단위)', triggers: 'ACR 수집 완료, 반복·셀 재판정',
  uses: '모델별 점유 맵의 반복 1–N 칸별 승자 · 최빈 브랜드 (Global · Website · Project ACR)', cur: '없음 (신규. 현행 live 화면은 반복 순서가 API 에 없어 분포로 대신 그림)',
  rules: ['셀의 반복 행 합이 acr_cell_fact.co_* 와 acr_entity_fact.choice 와 같아야 합니다.', '열 수는 고정 10 이 아니라 acr_cell_fact.planned 입니다.'] } });
tbl('acr_iter_shortlist', { s: 'gold', name: 'acr_iter_shortlist', fam: 'acr', grain: '반복 × 레벨 × 후보 엔티티', cols: [
  ['build_id · acr_cell_key · iter_no', 'PF', '', 'acr_iter_fact'], ['level', 'PK', '1 브랜드 · 2 차종 · 3 회사'], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key · parent_brand_key', 'FK', '', 'dim_brand'], ['is_choice', '', '그 반복의 최종 선택'] ], d: {
  grain: '빌드 × ACR 셀 × 반복 × 레벨 × 후보 엔티티 = 1행.', pk: 'build_id + acr_cell_key + iter_no + level + entity_key', inputs: 'ACR 최종 선택 판정 (반복 단위 후보군)',
  uses: '차종별 선택 전환율 표의 후보군 등장 run 수 · 1위 선택 수 · 전환율 = 1위 ÷ 등장', cur: '없음 (신규)' } });
tbl('acr_cell_job', { s: 'gold', name: 'acr_cell_job', fam: 'acr', grain: 'ACR 셀 × 소속 job', cols: [['build_id', 'PF', '', 'build'], ['answer_key', 'PF', '', 'job_index'], ['acr_cell_key', 'PF', '', 'acr_cell_fact']], d: {
  grain: 'ACR 셀 1개에 속한 job 1건 = 1행.', pk: 'build_id + answer_key + acr_cell_key', inputs: 'ACR 최종 선택 판정', uses: '검수 상세에서 job → ACR 셀 찾기', cur: 'rd.acr_cell_job' } });

/* ── GA4 ── */
tbl('ga4_property', { s: 'gold', name: 'ga4_property', fam: 'ga4', grain: 'GA4 속성 1개', cols: [['prop_key', 'PK', 'int2'], ['property_id', 'UK', ''], ['brand_bit', '', ''], ['geo_key', 'FK', '', 'dim_country'], ['status', '', 'active · pending_grant · unmapped'], ['source', '', 'registry · override · env'], ['conv_basis', '', '적재된 전환 기준: 1 key events 폴백 · 2 추적 이벤트']], d: {
  grain: 'GA4 속성 1개 = 1행.', pk: 'prop_key', inputs: 'app.ga4_property · 프로젝트 오버라이드 · env 매핑 (judgment_change ga4_property)', uses: '시장별 전환, 측정 커버리지, GA4 연동 관리', cur: 'rd.ga4_dim_property' } });
tbl('ga4_value', { s: 'gold', name: 'ga4_value', fam: 'ga4', grain: 'GA4 값 사전', cols: [['kind · value_key', 'PK', 'channel · source · device · nvr · event · page'], ['value', '', '빈 문자열 = 0 · page = landingPagePlusQueryString'], ['url_key', 'FK', 'kind=page 의 URL (신규)', 'dim_url']], d: {
  grain: 'GA4 차원 값 1개 = 1행.', pk: 'kind + value_key', inputs: 'GA4 리포트', uses: '기기·신규/재방문·페이지·이벤트 표시명', cur: 'rd.ga4_dim_value' } });
tbl('ga4_row', { s: 'gold', name: 'ga4_row', fam: 'ga4', grain: '속성 × 일 × report × 차원', cols: [
  ['prop_key', 'PF', '', 'ga4_property'], ['date', 'PK', ''], ['report', 'PK', '1 total · 2 ai · 3 events · 4 landing · 5 totals'], ['channel_key · source_key', 'PF', '', 'ga4_value'],
  ['device_key · nvr_key', 'PF', '', 'ga4_value'], ['page_key · event_key', 'PF', '', 'ga4_value'], ['is_ai', '', 'AI Assistant 채널'], ['engine_key', 'FK', 'AI 행만', 'dim_engine'], ['is_conv', '', '전환 이벤트'],
  ['sessions · users_day', '', ''], ['page_views · key_events · event_count', '', ''] ], d: {
  grain: '속성 × 보고일 × report × 차원 조합 = 1행.', pk: 'prop_key + date + report + channel · source · device · nvr · page · event', inputs: 'GA4 Data API 일 리포트 (현행 rd.ga4_row 와 같은 5종)', triggers: 'GA4 날짜 배치',
  uses: 'AI Conversion 전환율·방문 수·일별 방문·입구 페이지 세션·국가별 전환, 측정 커버리지, Admin GA4 적재 상태', cur: 'rd.ga4_row (그대로)',
  rules: ['sessions · key_events · event_count 는 날짜·차원끼리 더해도 됩니다. users_day 는 행끼리 더하지 않습니다 (사용자 수는 ga4_users_window).'] } });
tbl('ga4_users_window', { s: 'gold', name: 'ga4_users_window', fam: 'ga4', grain: '속성 × 기간 × 코호트 × 필터 조합 × 입구 페이지', cols: [
  ['prop_key', 'PF', '', 'ga4_property'], ['window_end · window_days', 'PK', '마지막 적재일 · 1 · 7 · 28 · 90일'], ['cohort', 'PK', 'ai · total · general'], ['engine_mask', 'PK', 'AI 엔진 비트 조합 · 0 = 필터 없음'],
  ['device_mask · nvr_mask', 'PK', '기기 · 신규/재방문 비트 조합 · 0 = 필터 없음'], ['page_key', 'PF', '0 = 전체 · 그 밖 = 입구 페이지', 'ga4_value'], ['users', '', '순 방문자 (기간 중복 제거)'] ], d: {
  grain: '속성 × 기간 × 코호트 × 엔진·기기·신규/재방문 필터 조합 × 입구 페이지 = 1행.', pk: 'prop_key + window_end + window_days + cohort + engine_mask + device_mask + nvr_mask + page_key',
  inputs: 'GA4 Data API activeUsers (기간 합). AI 조건 = sessionDefaultChannelGroup AI Assistant ∧ sessionSource ∈ 선택 엔진 호스트', triggers: 'GA4 날짜 배치',
  uses: '방문 블록의 순 방문자·방문 빈도 카드, 입구 페이지 표 사용자 열, 사용자 기준 전환율 (레거시 분모, 일별 = window_days 1)', cur: '없음 (신규. 레거시는 GA4 를 화면 요청마다 직접 호출, API 경로는 users null)',
  rules: ['순 방문자는 더할 수 없어서 필터 조합마다 행을 둡니다. 화면의 모든 조합(엔진 · 기기 · 신규/재방문 다중 선택)을 비트 조합으로 미리 계산하고 근사하지 않습니다.', 'cohort: ai = AI 유입, total = 엔진 조건 없이 기기·신규/재방문만 건 전체, general = 비AI 값 (레거시 일반 = total − ai 도 재현 가능).', '입구 페이지 행(page_key ≠ 0)은 조합마다 AI 세션 상위 15 페이지와 그 total 값입니다.', 'window_end = 그 속성의 마지막 적재일 (현행 API 경로 U8-N5 와 같음).'] } });

/* ── AI Visibility ── */
tbl('dim_crawl_bot', { s: 'gold', name: 'dim_crawl_bot', fam: 'vis', grain: 'AI 크롤러 1개', cols: [['bot_key', 'PK', 'int2'], ['code', 'UK', 'ChatGPT-User · Claude-Web · PerplexityBot · Googlebot-Vertex'], ['engine_key', 'FK', '', 'dim_engine']], d: {
  grain: 'AI 크롤러 1개 = 1행.', pk: 'bot_key', inputs: '데이터 분석팀 UA 목록', uses: 'AI 크롤 수의 구성, 엔진 필터 옵션', cur: '없음 (신규)',
  rules: ['엔진 필터는 AI 크롤 수만 좁힙니다. 검색 노출에는 엔진이 없습니다.'] } });
tbl('page_visibility_daily', { s: 'gold', name: 'page_visibility_daily', fam: 'vis', grain: '사이트 × 페이지 × 일', cols: [
  ['build_id', 'PF', '', 'build'], ['project_key', 'PF', '사이트 · 프로젝트', 'dim_project'], ['url_key', 'PF', '페이지', 'dim_url'], ['geo_key', 'FK', '시장', 'dim_country'], ['lang_key', 'FK', '언어', 'dim_lang'], ['date', 'PK', ''], ['seo_impressions', '', '검색 노출 (GSC)'], ['ai_crawls', '', 'AI 크롤 합계'] ], d: {
  grain: '빌드 × 사이트 × 페이지 × 일 = 1행.', pk: 'build_id + project_key + url_key + date', inputs: 'Google Search Console 페이지 노출 + 서버 크롤 로그 AI 봇 집계', triggers: '일 배치',
  uses: 'AI Visibility 4분면 카드 · 산점도 · 페이지 진단 표 (Global · Project)', cur: '없음 (신규 · 현재 화면은 정적 표본)',
  rules: ['url_key 는 dim_url 에서 받습니다. 인용된 적 없는 자사 페이지도 dim_url 행을 만들어 인용 쪽과 같은 키를 씁니다.', 'Global 화면 = 웹사이트 사이트(dim_project surface 2) 페이지 전체, Project 화면 = 그 프로젝트 자사 기준 URL(app.project_owned_base) 아래 페이지.', '분면 · 카드 수 · 중앙값은 필터를 건 페이지 집합의 기간 합으로 BE 가 계산합니다 (중앙값 = 정렬 후 floor(n/2) 번째, x ≥ 중앙값이면 높음). 저장하지 않습니다.', '프롬프트 축(promptContext · brandPresence · listType · depth1~4 · brand) · 경쟁사 축 = 그 페이지(url_key)를 인용한 답변의 프롬프트 · 언급 브랜드 (citation_fact ⋈ catalog_entry · answer_brand_fact).', '출처 축 = dim_url.source_key → dim_source.category_key. 기기 축 = page_seo_device_daily (검색 노출만). 방문자 유형 축 = GA4 입구 페이지(ga4_row report 4, ga4_value.url_key) 중 그 유형 세션이 있는 페이지.'] } });
tbl('page_crawl_daily', { s: 'gold', name: 'page_crawl_daily', fam: 'vis', grain: '페이지 × 일 × 크롤러', cols: [['build_id · project_key · url_key · date', 'PF', '', 'page_visibility_daily'], ['bot_key', 'PF', '', 'dim_crawl_bot'], ['hits', '', '크롤 수']], d: {
  grain: '빌드 × 사이트 × 페이지 × 일 × AI 크롤러 = 1행.', pk: 'page_visibility_daily PK + bot_key', inputs: '서버 크롤 로그 (UA → dim_crawl_bot)', triggers: '일 배치',
  uses: '엔진 필터를 건 AI 크롤 수', cur: '없음 (신규)', rules: ['Σhits = page_visibility_daily.ai_crawls 이어야 합니다.'] } });
tbl('page_seo_device_daily', { s: 'gold', name: 'page_seo_device_daily', fam: 'vis', grain: '페이지 × 일 × 기기', cols: [['build_id · project_key · url_key · date', 'PF', '', 'page_visibility_daily'], ['device_key', 'PF', 'ga4_value kind=device 코드', 'ga4_value'], ['seo_impressions', '', 'GSC 기기별 노출']], d: {
  grain: '빌드 × 사이트 × 페이지 × 일 × 기기 = 1행.', pk: 'page_visibility_daily PK + device_key', inputs: 'Google Search Console device 차원', triggers: '일 배치', uses: 'AI Visibility 기기 필터 (검색 노출)', cur: '없음 (신규)',
  rules: ['Σseo_impressions = page_visibility_daily.seo_impressions 이어야 합니다.'] } });
tbl('page_priority', { s: 'gold', name: 'page_priority', fam: 'vis', grain: '사이트 × 페이지 우선순위', cols: [['build_id', 'PF', '', 'build'], ['project_key', 'PF', '', 'dim_project'], ['url_key', 'PF', '', 'dim_url'], ['priority', '', '1 높음 · 2 · 3 낮음'], ['reason', '', '산정 근거'], ['rule_ver', '', '산정 규칙 버전']], d: {
  grain: '빌드 × 사이트 × 페이지 = 1행.', pk: 'build_id + project_key + url_key', inputs: '데이터 분석팀 산정 규칙', uses: 'AI Visibility 페이지 진단 표의 우선순위 열 · 기본 정렬', cur: '없음 (신규 · 현재는 픽스처 값, 산정 규칙 없음)',
  rules: ['산정 규칙은 데이터 분석팀이 정하고 rule_ver 로 남깁니다. 현행 화면에는 규칙이 없어서 이 테이블이 정의의 출처가 됩니다.'] } });

/* ── 키워드 ── */
tbl('dim_keyword', { s: 'gold', name: 'dim_keyword', fam: 'kw', grain: '검색어 1개', cols: [['kw_key', 'PK', 'int4'], ['term', '', ''], ['term_norm', 'UK', '정규화']], d: {
  grain: '검색어 1개 = 1행.', pk: 'kw_key', inputs: '키워드 원천 → 키워드 정규화', uses: '키워드 화면 전체', cur: 'rd.dim_keyword' } });
tbl('kw_volume_monthly', { s: 'gold', name: 'kw_volume_monthly', fam: 'kw', grain: '검색어 × 지역 × 언어 × 월', cols: [['kw_key', 'PF', '', 'dim_keyword'], ['location_code · language_code', 'PK', ''], ['month', 'PK', '월 1일'], ['search_volume', '', ''], ['competition · competition_index · cpc', '', 'LOW·MEDIUM·HIGH 라벨 · 지수 · CPC'], ['call_id', '', '수집 호출'], ['observed_at', '', '']], d: {
  grain: '검색어 × 지역 × 언어 × 월 = 1행.', pk: 'kw_key + location_code + language_code + month', inputs: '키워드 정규화', triggers: '정기 수집, BE 요청(judgment_change dfs_fetch)',
  uses: '평균 관심도, 키워드 수, 검색량, 볼륨 구간, 추적 키워드, 키워드 도구', cur: 'rd.kw_volume_monthly', rules: ['경쟁도 · CPC 는 일괄 합산하지 않습니다.', '최신 성공 관측만 읽고, 실패한 수집이 이전 값을 덮지 않습니다.'] } });
tbl('kw_serp', { s: 'gold', name: 'kw_serp', fam: 'kw', grain: '호출 × 순위', cols: [['call_id', 'PK', ''], ['rank', 'PK', ''], ['kw_key', 'FK', '', 'dim_keyword'], ['location_code · language_code', '', ''], ['url · domain', '', ''], ['title · snippet', '', ''], ['observed_at', '', '']], d: {
  grain: '수집 호출 × 순위 = 1행. 집계 없이 화면에 그대로 나갑니다.', pk: 'call_id + rank', inputs: '키워드 원천 (SERP)', triggers: 'BE 요청 dfs_fetch',
  uses: 'SERP 표 + 제안 프롬프트 초안', cur: 'rd.kw_serp' } });
tbl('kw_suggestion', { s: 'gold', name: 'kw_suggestion', fam: 'kw', grain: '호출 × 위치', cols: [['call_id', 'PK', ''], ['pos', 'PK', ''], ['seed_kw_key', 'FK', '시드', 'dim_keyword'], ['kw_key', 'FK', '', 'dim_keyword'], ['location_code · language_code', '', ''], ['search_volume · intent', '', ''], ['total_count', '', '호출 단위 연관어 총수 (BG-39)'], ['is_seed · observed_at', '', '7일 신선도']], d: {
  grain: '수집 호출 × 위치 = 1행. 집계 없이 화면에 그대로 나갑니다.', pk: 'call_id + pos', inputs: '키워드 원천 (연관 검색어)', triggers: 'BE 요청 dfs_fetch',
  uses: '관련 검색어 표, 생성 프롬프트 표, 키워드 수집 신선도 판정', cur: 'rd.kw_suggestion' } });

/* ── 소셜 ── */
tbl('ctx_snapshot', { s: 'gold', name: 'ctx_snapshot', fam: 'soc', grain: '분석 스냅샷 1개', cols: [['snapshot_id', 'PK', 'int2'], ['industry_entity_id', '', '산업 엔티티'], ['source', '', ''], ['utterance_total', '', ''], ['taken_at', '', ''], ['is_active', '', '산업당 활성 1개'],
  ['keyword', '', '지도 제목 키워드 (신규)'], ['geo_key', 'FK', '리서치 지역 (신규)', 'dim_country'], ['lang_key', 'FK', '(신규)', 'dim_lang'], ['run_id', 'FK', '리서치 실행 (신규)', 'ctx_research_run'], ['worker_total · speaker_total · source_total', '', '분석 표본 · 발화자 · 출처 수 (신규)']], d: {
  grain: '구매 맥락 분석 스냅샷 1개 = 1행.', pk: 'snapshot_id', inputs: '소셜 원문 → 구매 맥락 추출', triggers: '스냅샷 전체 적재 성공 후 한 번', uses: 'Project > Intent > Social Scraping, Global > Customer interest > Social Scraping, Admin 리서치 결과 지도', cur: 'ext.ctx_snapshot',
  rules: ['그래프의 mention_rate = ctx_entity.worker_count ÷ worker_total, 조합 overlap = ctx_combination.speaker_count ÷ speaker_total.'] } });
tbl('ctx_entity', { s: 'gold', name: 'ctx_entity', fam: 'soc', grain: '스냅샷 × 맥락·조건', cols: [['snapshot_id', 'PF', '', 'ctx_snapshot'], ['id', 'PK', 'uuid'], ['type', '', 'ConsumerContext · ConsumerRequirement'], ['canonical_name', '', ''], ['dimension', '', '테마·카테고리 코드'], ['mention_count · utterance_count', '', ''], ['sentiment_positive · sentiment_negative · sentiment_neutral', '', ''], ['group_id', 'FK', '테마 · 카테고리 (신규)', 'ctx_group'], ['worker_count · unique_source_count', '', '언급 표본 · 고유 출처 수 (신규)'], ['perspective_buyer · perspective_seller · perspective_neutral', '', '관점 분포 (신규)']], d: {
  grain: '스냅샷 × 구매 맥락 또는 구매 조건 1개 = 1행.', pk: 'snapshot_id + id', inputs: '구매 맥락 추출', uses: '구매 맥락 표, 구매 조건 표, 맥락·조건 수', cur: 'ext.ctx_entity' } });
tbl('ctx_drive', { s: 'gold', name: 'ctx_drive', fam: 'soc', grain: '맥락 → 조건 연결', cols: [['snapshot_id', 'PK', ''], ['context_id', 'PF', '', 'ctx_entity'], ['requirement_id', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현'], ['strength_score', '', '유발 강도 1~10 (신규)']], d: {
  grain: '스냅샷 × 맥락 × 조건 = 1행.', pk: 'snapshot_id + context_id + requirement_id', inputs: '구매 맥락 추출', uses: '관계 수, 연결 수', cur: 'ext.ctx_drive' } });
tbl('ctx_combination', { s: 'gold', name: 'ctx_combination', fam: 'soc', grain: '조건 A × 조건 B', cols: [['snapshot_id', 'PK', ''], ['cond_a', 'PF', '', 'ctx_entity'], ['cond_b', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현'], ['description', '', '조합 시나리오 (신규)'], ['speaker_count · unique_source_count', '', '(신규)']], d: {
  grain: '스냅샷 × 조건 쌍 = 1행.', pk: 'snapshot_id + cond_a + cond_b', inputs: '구매 맥락 추출', uses: '조합 패턴 표', cur: 'ext.ctx_combination' } });
tbl('ctx_domain', { s: 'gold', name: 'ctx_domain', fam: 'soc', grain: '엔티티 × 출처 host', cols: [['snapshot_id', 'PK', ''], ['entity_id', 'PF', '', 'ctx_entity'], ['host', 'PK', ''], ['n', '', '']], d: {
  grain: '스냅샷 × 엔티티 × 출처 host = 1행.', pk: 'snapshot_id + entity_id + host', inputs: '구매 맥락 추출', uses: '출처 도메인 수', cur: 'ext.ctx_domain' } });
tbl('ctx_evidence', { s: 'gold', name: 'ctx_evidence', fam: 'soc', grain: '근거 발화 1개', cols: [['snapshot_id', 'PK', ''], ['id', 'PK', 'uuid'], ['entity_id', 'FK', '', 'ctx_entity'], ['utterance_id', '', ''], ['quote', '', '근거 인용'], ['source_host · source_url', '', ''], ['sentiment', '', ''], ['source_title · rank', '', '출처 제목 · 표시 순서 (신규)']], d: {
  grain: '스냅샷 × 근거 발화 1개 = 1행.', pk: 'snapshot_id + id', inputs: '구매 맥락 추출', uses: '상세 언급 수, 근거 인용', cur: 'ext.ctx_evidence' } });

/* ── 발행 세대 (카드 동결) ── */
tbl('publication', { s: 'gold', name: 'publication', fam: 'pub', grain: '회차 × 발행 세대', cols: [
  ['gen_key', 'PK', '현행 frz.generation.gen_key'], ['cyc_key', 'FK', '', 'dim_cycle'], ['surface', '', 'global · website'], ['source', '', 'ops 이관 · hub 발행'], ['state', '', 'building · active · retired'], ['build_id', 'FK', '고정한 사실 build', 'build'],
  ['ops_cycle_id · ops_generation_id · ops_generator_version', '', 'ops 이관 세대 원값'], ['ops_started_at · ops_finished_at', '', ''], ['judgment', '', '판정 입력 버전'], ['row_counts · verify', '', ''], ['created_at · activated_at · retired_at · retired_reason', '', ''] ], d: {
  grain: '회차 × 발행 세대 1개 = 1행. 회차당 active 는 1개입니다.', pk: 'gen_key', inputs: '회차 마감 후 발행', triggers: '발행, 명시적 재발행',
  uses: '카드 경로 API 7개(kpi/summary · mentions/brands · trend · geo · kpi/engines · citations/domains · kpi/compare)의 동결 읽기, 글로벌 추이 격자, 창 판정(세대 없는 발행 회차가 끼면 비카드 경로)',
  cur: 'frz.generation. frz.kept · keep_* 는 build_id 고정으로 대체', rules: ['build_id 로 발행 시점 사실 build 를 고정합니다. 발행 뒤 재판정은 새 build 로만 들어가 카드 값이 바뀌지 않습니다.', '활성 발행이 참조하는 build 는 지우지 않습니다.', 'ops 이관 세대(source ops)도 운영 원값을 담은 build 를 하나 만들어 build_id 로 가리킵니다 (현행 frz.keep_* · keep_fold 보관 행 대체).', '고정 build 는 발행 당시 규칙 서명(profile_signature)으로 만든 것이어야 합니다.'] } });
tbl('pub_cell', { s: 'gold', name: 'pub_cell', fam: 'pub', grain: '발행 × 셀 대표 답변', cols: [['gen_key', 'PF', '', 'publication'], ['answer_key', 'PF', '셀 대표', 'answer_fact'], ['surface · cyc_key', '', ''], ['round_date', '', '동결 좌석'], ['prompt_key · engine_key · geo_key', '', '셀 좌표']], d: {
  grain: '발행 세대 × 셀 대표 답변 1건 = 1행.', pk: 'gen_key + answer_key', inputs: 'answer_fact (고정 build) + 발행 정렬 규칙', uses: '카드·격자 읽기의 셀 집합', cur: 'frz.cell',
  rules: ['셀 대표는 발행 정렬 규칙(미러 시각 > 앵커 핀 > 원본)으로 고르며 LIVE 의 is_rep 와 다를 수 있습니다.'] } });
tbl('pub_cell_web', { s: 'gold', name: 'pub_cell_web', fam: 'pub', grain: '웹 셀 판정', cols: [['gen_key · answer_key', 'PF', '', 'pub_cell'], ['cyc_key', '', ''], ['report_fs', '', '보고 유닛'], ['unit_owned · unit_target', '', '⑥ 유닛 판정'], ['url_registered · url_owned_hit · url_target_hit', '', '']], d: {
  grain: '웹 셀 1개의 발행 시점 판정 = 1행.', pk: 'gen_key + answer_key', inputs: 'web_unit · web_target_url (발행 시점)', uses: 'Website 카드의 유닛 게이트 · ⑥ · URL 인용률', cur: 'frz.cell_web' } });
tbl('pub_prompt', { s: 'gold', name: 'pub_prompt', fam: 'pub', grain: '발행 × 프롬프트', cols: [
  ['gen_key', 'PF', '', 'publication'], ['prompt_key', 'PF', '', 'dim_prompt'], ['cyc_key', '', ''], ['in_full_cycle · expected_cells · window_cells', '', ''], ['in_root_catalog · catalog_deleted · cat_mask', '', '동결 카탈로그'],
  ['funnel_key · presence_key · list_type_key · depth1~3_key', '', '동결 택소노미'], ['regions · is_korean · report_fs', '', ''], ['src', '', '운영 원값 (감사)'] ], d: {
  grain: '발행 세대 × 프롬프트 = 1행.', pk: 'gen_key + prompt_key', inputs: 'dim_prompt · catalog_entry (발행 시점)', uses: '카드의 in_full_cycle 게이트와 동결 카탈로그 비트', cur: 'frz.prompt' } });
tbl('pub_prompt_axis', { s: 'gold', name: 'pub_prompt_axis', fam: 'pub', grain: '발행 × 프롬프트 택소노미', cols: [['gen_key · prompt_key', 'PF', '', 'pub_prompt'], ['cyc_key', '', ''], ['funnel_key', 'FK', '', 'dim_taxon'], ['presence_keys[]', '', ''], ['list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon']], d: {
  grain: '발행 세대 × 프롬프트의 택소노미 축 = 1행.', pk: 'gen_key + prompt_key', inputs: 'catalog_entry (발행 시점)', uses: '카드 경로 택소노미 필터', cur: 'frz.prompt_axis' } });
tbl('pub_brand_name', { s: 'gold', name: 'pub_brand_name', fam: 'pub', grain: '발행 × 브랜드 표시명', cols: [['gen_key', 'PF', '', 'publication'], ['brand_key', 'PF', '', 'dim_brand'], ['name', '', '발행 시점 표시명']], d: {
  grain: '발행 세대 × 브랜드 = 1행.', pk: 'gen_key + brand_key', inputs: 'dim_brand (발행 시점)', uses: '카드 경로 브랜드 표시명', cur: 'frz.brand_name' } });

/* ── 빌드 · 릴리스 ── */
tbl('gold_facts', { s: 'key', name: '골드 사실·셀 전체', fam: 'build', grain: 'build_id 를 가진 테이블', cols: [
  ['build_id', 'FK', '모든 사실·셀 공통', 'build'], ['answer_fact', '', ''], ['answer_brand_fact · answer_stance_fact', '', ''], ['citation_fact · catalog_entry', '', ''], ['acr_cell_fact · acr_entity_fact · acr_cell_job', '', ''],
  ['kpi_cell · kpi_rollup · brand_cell', '', ''], ['citation_cell · url_prompt_cell · report_value', '', ''], ['page_visibility_daily · page_crawl_daily · page_seo_device_daily · page_priority', '', ''], ['acr_iter_fact · acr_iter_shortlist', '', ''], ['GA4 · 키워드 · 소셜', '', '날짜 · call_id · snapshot_id'] ], d: {
  grain: 'build_id 로 세대를 나누는 골드 테이블 목록입니다. 키워드는 call_id · observed_at, 소셜은 snapshot_id 로 버전을 관리합니다.', pk: '—', inputs: '—',
  uses: 'API 요청 시작에 release 하나를 고정하고, 그 release 가 가리키는 build 의 행만 읽습니다. 카드 경로는 publication.build_id 를 읽습니다.', cur: '현행 rd 는 제자리 갱신 + frz 보관 행' } });
tbl('build', { s: 'gold', name: 'build', fam: 'build', grain: '빌드 1회', cols: [
  ['build_id', 'PK', ''], ['family', '', 'fact · kpi · citation · acr · ga4 …'], ['slice_key', '', '회차 · 속성×일 · 스냅샷'], ['input_snapshot · watermark', '', '입력 고정'], ['profile_signature · metric_version', '', ''],
  ['ecat_ver · rule_ver', '', '판정 버전'], ['status', '', 'pending · running · validated · failed'], ['row_counts · verify', '', 'jsonb'], ['error · attempt', '', ''], ['started_at · finished_at', '', ''] ], d: {
  grain: '패밀리 × 슬라이스 × 입력·규칙 버전의 빌드 1회 = 1행.', pk: 'build_id (유일: family + slice_key + 입력·규칙 버전)', inputs: '회차 마감, judgment_change 반영',
  triggers: '회차 마감, 재판정, GA4 날짜 배치, 소셜 스냅샷', uses: '데이터 분석팀 운영, 반영 큐 화면(applied_build_id), 실패 재시도', cur: 'ing.load (적재 이력) 의 역할을 대신',
  rules: ['재시도는 같은 출력의 교체·재개입니다. 활성 통계에 SUM 을 더하지 않습니다.', '실패한 빌드는 공개하지 않고 상태와 오류만 남깁니다.'] } });
tbl('data_version', { s: 'gold', name: 'data_version', fam: 'build', grain: 'release 밖 데이터의 버전', cols: [['scope', 'PK', 'dim · cycle · job · catalog_raw · ga4 · kw · soc …'], ['version', '', 'bigint, 쓸 때마다 +1'], ['changed_at', '', '']], d: {
  grain: '버전 범위 1개 = 1행.', pk: 'scope', inputs: '데이터 분석팀의 모든 gold 쓰기', triggers: 'release 를 거치지 않는 gold 테이블을 쓴 트랜잭션 안에서 함께 증가',
  uses: 'BE 결과 캐시 키 = active_release.version + data_version. 현행 rcache 트리거(rd 차원·cycle·cycle_pick_basis·catalog_entry·web_*·entity_mention_total·report_unit_value) 대체', cur: '현행 rcache.tg_bump 트리거 (rd 쓰기 시 캐시 버전 증가)',
  rules: ['차원·회차·job·답변 원문·GA4·키워드·소셜처럼 build 로 나누지 않는 테이블은 쓸 때 해당 scope 의 version 을 반드시 올립니다.', '올리지 않으면 BE 캐시가 낡은 값을 계속 냅니다.'] } });
tbl('release', { s: 'gold', name: 'release', fam: 'build', grain: '공개 manifest 1개', cols: [['release_id', 'PK', ''], ['read_mode', '', 'live · card · grid'], ['rule_signature', '', '활성 프로필'], ['base_release_id', 'FK', '이전 release', 'release'], ['validated_at', '', '']], d: {
  grain: '불변 공개 manifest 1개 = 1행.', pk: 'release_id', inputs: 'validated 된 build 묶음', uses: '한 응답 안의 숫자를 같은 세대로 고정', cur: '없음 (신규)' } });
tbl('release_item', { s: 'gold', name: 'release_item', fam: 'build', grain: 'release × 패밀리 × 슬라이스', cols: [['release_id', 'PF', '', 'release'], ['family', 'PK', ''], ['slice_key', 'PK', ''], ['build_id', 'FK', '', 'build'], ['state', '', 'ready · empty']], d: {
  grain: 'release × 패밀리 × 슬라이스 = 1행. 어느 회차·날짜에 어느 build 를 쓸지 정합니다.', pk: 'release_id + family + slice_key', inputs: 'build', uses: 'BE 조회 경로의 build_id 결정 (LIVE)', cur: '없음 (신규)',
  rules: ['빈 슬라이스도 empty 로 매핑해 삭제를 표현합니다.'] } });
tbl('active_release', { s: 'gold', name: 'active_release', fam: 'build', grain: '공개 포인터', cols: [['read_mode', 'PK', ''], ['rule_signature', 'PK', ''], ['scope', 'PK', '공개 범위 (LIVE = surface)'], ['release_id', 'FK', '', 'release'], ['version', '', '데이터 버전 (현행 generation)'], ['last_build_id', 'FK', '현행 last_load_id', 'build'], ['rule_ver · as_of · updated_at', '', '']], d: {
  grain: '읽기 모드 × 규칙 서명 × 공개 범위의 현재 release = 1행.', pk: 'read_mode + rule_signature + scope', inputs: 'release',
  triggers: '검증 통과 후 짧은 트랜잭션으로 자동 전환 (승인 없음, 20261015 회의)', uses: 'BE 는 읽기만. version 은 결과 캐시 키와 as_of 표시에 씀', cur: 'rd.surface_generation (surface → scope, generation → version, last_load_id → last_build_id)',
  rules: ['기대한 이전 release 와 입력 버전을 확인한 뒤 전환해서, 오래된 빌드가 새 입력을 덮지 못하게 합니다.'] } });

/* ── serve 뷰 ── */
const SCOPE = ['surface · project_key · geo_key · bgrp', '', '접근 범위'];
tbl('answer_body', { s: 'gold', name: 'answer_body', fam: 'silver', grain: '답변 본문·메타', cols: [['answer_key', 'PF', '', 'job_index'], ['job_id · run_id · prompt_run_id', '', ''], SCOPE, ['answer_text', '', '답변 본문'], ['model_slug', '', ''], ['measured_at', '', ''], ['status · analysis_status', '', ''], ['region', '', 'Scope 측정 지역']], d: {
  grain: '답변 1건의 본문과 측정 메타 = 1행.', pk: 'answer_key', inputs: '데이터 분석팀', uses: '답변 모달, 검수 상세, 엔티티 카탈로그 초안 표본', cur: 'rd.v_answer_body',
  rules: ['접근 범위 열(surface · project_key · geo_key · bgrp)을 꼭 둡니다. BE 가 권한 검사를 이 열로 합니다.'] } });
tbl('answer_registry', { s: 'gold', name: 'answer_registry', fam: 'silver', grain: '앵커 고정·드롭 사유', cols: [['answer_key', 'PF', '', 'job_index'], SCOPE, ['pin_anchor · pin_reason', '', ''], ['drop_reason · dropped_at', '', ''], ['{pin,drop}_source_measured_at', '', '']], d: {
  grain: '답변 1건의 앵커 고정·드롭 기록 = 1행.', pk: 'answer_key', inputs: 'judgment_change anchor_pin · answer_drop', uses: '회차·job 관제, 검수 상세', cur: 'rd.v_answer_registry' } });
tbl('answer_citation_raw', { s: 'gold', name: 'answer_citation_raw', fam: 'silver', grain: '인용 원본', cols: [['answer_key · ord', 'PF', '', 'job_index'], SCOPE, ['url · title', '', ''], ['ref_index', '', ''], ['scope_category', '', ''], ['host · domain_label', '', '']], d: {
  grain: '답변의 인용 원본 1건 = 1행.', pk: 'answer_key + ord', inputs: '답변 원문 → 인용 정규화', uses: '검수 목록·상세의 인용 블록', cur: 'rd.v_answer_citation_raw' } });
tbl('answer_mention_raw', { s: 'gold', name: 'answer_mention_raw', fam: 'silver', grain: '언급 원본', cols: [['answer_key · ord', 'PF', '', 'job_index'], SCOPE, ['entity_id · entity_key', 'FK', '', 'dim_entity'], ['registry_role · entity_type', '', ''], ['display_name', '', ''], ['mention_count · avg_position', '', ''], ['brand_rollup_entity_id · surfaces[]', '', ''], ['sentiment_positive · sentiment_neutral · sentiment_negative · sentiment_mixed', '', ''], ['type_mention … type_final_choice', '', '유형 5종', '', ['type_mention', 'type_recommendation', 'type_comparison', 'type_definition', 'type_final_choice']]], d: {
  grain: '답변의 엔티티 언급 원본 1건 = 1행 (모든 엔티티, 브랜드 롤업 전).', pk: 'answer_key + ord', inputs: '브랜드 언급 추출 · 언급 감정 분류', uses: '답변 모달 언급 배지, 언급 프롬프트 상세, 검수 목록·상세, 엔티티 카탈로그 표면 표본', cur: 'rd.v_answer_mention_raw' } });
tbl('answer_occurrence', { s: 'gold', name: 'answer_occurrence', fam: 'silver', grain: '본문 안 등장 위치', cols: [['answer_key · ord', 'PF', '', 'job_index'], SCOPE, ['entity_id · turn_index', '', ''], ['source_start · source_end', '', '본문 위치'], ['surface_text', '', ''], ['sentiment · mention_role · assertion', '', ''], ['context_snippet', '', ''], ['descriptors[] · criteria[]', '', '']], d: {
  grain: '답변 본문 안 언급 등장 1건 = 1행.', pk: 'answer_key + ord', inputs: '브랜드 언급 추출', uses: '본문 하이라이트, 엔티티 카탈로그 린트·미리보기', cur: 'rd.v_answer_occurrence' } });
tbl('answer_stance_raw', { s: 'gold', name: 'answer_stance_raw', fam: 'silver', grain: '스탠스 근거', cols: [['answer_key · turn_index · entity_id', 'PF', '', 'job_index'], SCOPE, ['brand_label', '', ''], ['stance · confidence', '', ''], ['evidence_text', '', ''], ['evidence_start · evidence_end', '', ''], ['reason', '', '']], d: {
  grain: '답변 × 턴 × 엔티티의 스탠스 근거 = 1행.', pk: 'answer_key + turn_index + entity_id', inputs: '언급 감정 분류', uses: '답변 상세의 스탠스 근거', cur: 'rd.v_answer_stance_raw' } });
tbl('acr_cell_run', { s: 'gold', name: 'acr_cell_run', fam: 'silver', grain: 'ACR 셀 실행', cols: [['acr_cell_key', 'PF', '셀 식별자 (build 무관)', 'acr_cell_fact'], ['prompt_run_id', '', ''], ['run_id', '', '']], d: {
  grain: 'ACR 셀 1개의 Scope 실행 id = 1행.', pk: 'acr_cell_key', inputs: 'ACR 답변 원문', uses: '검수 상세 ACR 블록', cur: 'rd.v_acr_cell_run' } });
tbl('entity_mention_surface', { s: 'gold', name: 'entity_mention_surface', fam: 'silver', grain: '엔티티 × 월 × 표면', cols: [['entity_id', 'PF', 'dim_entity.entity_id (UK)', 'dim_entity'], ['run_month', 'PK', ''], ['surface', 'PK', '표면 문자열'], ['brand_rollup_entity_id', '', ''], ['display_name', '', '']], d: {
  grain: '엔티티 × 월 × 관측 표면 = 1행.', pk: 'entity_id + run_month + surface', inputs: '브랜드 언급 추출', uses: 'Entity catalog 초안의 표면별 언급 표본', cur: 'rd.v_entity_mention_surface' } });

/* ── BE 요청 큐 ── */
tbl('app_inputs', { s: 'applist', name: 'app 입력 설정', fam: 'queue', grain: '데이터 분석팀이 판정에 읽는 GEO HUB 설정', cols: [
  ['owned_base · project_owned_base', '', '자사 판정'], ['project_tracked_url · website_report_unit', '', '타겟 · 웹 유닛'], ['citation_category · citation_domain_override', '', '출처 분류'], ['brand · competitor_domain_token · non_competitor_name', '', '브랜드 규칙'],
  ['ecat_version · ecat_entity · ecat_surface · ecat_apply', '', '엔티티 카탈로그'], ['prompt · website_prompt · project', '', '카탈로그 · 프로젝트'], ['ga4_property · ga4_tracked_event', '', 'GA4'], ['hidden_market · rule_param · rule_set', '', '노출 · 규칙'] ], d: {
  grain: 'GEO HUB BE 가 소유하고 데이터 분석팀이 읽는 app 테이블 묶음입니다.', pk: '—', inputs: 'GEO HUB 관리 화면', triggers: '저장 시 트리거가 judgment_change 를 적재',
  uses: '데이터 분석팀 재판정의 입력', cur: 'app 스키마 (현행 그대로)', rules: ['데이터 분석팀은 이 테이블을 읽기만 합니다. 쓰기는 BE 만 합니다.'] } });
tbl('judgment_change', { s: 'app', name: 'judgment_change', fam: 'queue', grain: 'BE → 데이터 분석팀 요청 1건', cols: [
  ['change_id', 'PK', ''], ['kind', 'FK', '요청 종류 23', 'judgment_kind'], ['subject_uuids · subject_texts', '', ''], ['payload', '', 'jsonb'], ['requested_by · requested_at', '', ''],
  ['status', '', 'pending · running · applied · failed · escalated_rebuild'], ['claimed_at · applied_at', '', ''], ['applied_build_id', 'FK', '현행 applied_load_id', 'build'], ['error', '', ''] ], d: {
  grain: 'BE 의 재판정·운영·수집 요청 1건 = 1행.', pk: 'change_id', inputs: 'BE 쓰기 (설정 저장 트리거, 회차 관제, 키워드 수집 버튼)', triggers: '데이터 분석팀이 claim → 적용 → 새 build',
  uses: '반영 큐 화면, 키워드 수집 상태, 회차 관제 쓰기, 엔티티 버전 반영', cur: 'app.judgment_change (applied_load_id → ing.load)',
  rules: ['cycle_admin · anchor_pin · answer_drop 은 payload 가 필수입니다.', 'scope_prompt 는 데이터 분석팀이 스스로 넣는 유일한 종류입니다 (Scope 쪽 regions · lang · kind 변경).'] } });
tbl('judgment_kind', { s: 'key', name: '요청 종류 23', fam: 'queue', grain: 'judgment_change.kind 값', cols: [
  ['카탈로그 · 프롬프트', '', 'catalog · prompt_kind · website_catalog · scope_prompt'], ['엔티티 · 브랜드', '', 'entity · entity_version · brand_rule · competitor_token'], ['출처 · 자사 판정', '', 'citation_override · owned_base · project_owned_base · project_target_url'],
  ['프로젝트 · 노출', '', 'project_setting · hidden_market · rule_param'], ['회차 · 답변 운영', '', 'cycle_admin · anchor_pin · answer_drop'], ['발행', '', 'report_publication'], ['외부 수집 요청', '', 'dfs_fetch · ga4_property · ga4_tracked_event · ctx_research (신규)'] ], d: {
  grain: 'judgment_change.kind 값 23개(현행 22 + 리서치 실행 요청 ctx_research 1)를 7개 묶음으로 나눈 것입니다 (CHECK 제약).', pk: '—', inputs: '—', uses: '데이터 분석팀이 kind 별로 처리기를 고릅니다.', cur: 'app.judgment_change kind CHECK (합성 DB 기준 22종)' } });

/* ── 다른 탭 참조 상자 ── */
ghost('dim_prompt', [['prompt_key', 'PK', '']]); ghost('dim_project', [['project_key', 'PK', '']]); ghost('dim_lang', [['lang_key', 'PK', '']]); ghost('dim_url', [['url_key', 'PK', '']]);
ghost('dim_brand', [['brand_key', 'PK', '']]); ghost('dim_entity', [['entity_key', 'PK', '']]); ghost('dim_source', [['source_key', 'PK', '']]); ghost('dim_cycle', [['cyc_key', 'PK', '']]);
ghost('dim_taxon', [['taxon_key', 'PK', '']]); ghost('dim_engine', [['engine_key', 'PK', '']]); ghost('dim_country', [['geo_key', 'PK', '']]);
ghost('answer_fact', [['surface · round_date · answer_key', 'PK', '']]); ghost('answer_brand_fact', [['답변 PK · brand_key', 'PK', '']]); ghost('answer_stance_fact', [['답변 PK · turn · entity', 'PK', '']]);
ghost('citation_fact', [['답변 PK · ord', 'PK', '']]); ghost('job_index', [['answer_key', 'PK', '']]); ghost('build', [['build_id', 'PK', '']]);
ghost('publication', [['gen_key', 'PK', ''], ['build_id', 'FK', '', 'build']]); ghost('ga4_value', [['kind · value_key', 'PK', '']]); ghost('ctx_snapshot', [['snapshot_id', 'PK', '']]); ghost('judgment_change', [['change_id', 'PK', ''], ['applied_build_id', 'FK', '', 'build']]);

/* ── 소셜 노드맵 · 리서치 (신규) ── */
tbl('ctx_group', { s: 'gold', name: 'ctx_group', fam: 'soc', grain: '스냅샷 × 테마·카테고리', cols: [['snapshot_id', 'PF', '', 'ctx_snapshot'], ['group_id', 'PK', ''], ['side', '', 'context 테마 · condition 카테고리'], ['name', '', ''], ['description', '', '설명문'], ['dimension', '', '현행 dimension 코드'], ['sort_order', '', '']], d: {
  grain: '스냅샷 × 테마 또는 카테고리 1개 = 1행.', pk: 'snapshot_id + group_id', inputs: '구매 맥락 추출', uses: '맥락 표 주제 · 조건 표 카테고리 · 그래프의 테마/카테고리 노드 이름과 설명', cur: '없음 (신규. 현행은 코드의 DIMENSION_THEME 맵 · 이름 정규식 분류)' } });
tbl('ctx_combination_evidence', { s: 'gold', name: 'ctx_combination_evidence', fam: 'soc', grain: '조합 × 근거 발화', cols: [['snapshot_id · cond_a · cond_b', 'PF', '', 'ctx_combination'], ['seq', 'PK', ''], ['quote', '', ''], ['source_title · source_url · source_host', '', ''], ['perspective', '', 'buyer · seller · neutral']], d: {
  grain: '스냅샷 × 조건 쌍 × 근거 발화 1개 = 1행.', pk: 'snapshot_id + cond_a + cond_b + seq', inputs: '구매 맥락 추출', uses: '그래프 조합 패널의 근거 · 출처 URL 목록 (20개 + 외 n건)', cur: '없음 (신규)' } });
tbl('ctx_claim', { s: 'gold', name: 'ctx_claim', fam: 'soc', grain: '조건 × 심층 근거 주장', cols: [['snapshot_id · entity_id', 'PF', '조건', 'ctx_entity'], ['claim_id', 'PK', ''], ['claim', '', '주장문'], ['supporting · contradicting · neutral', '', '지지 · 반박 · 중립 수'], ['total_scanned', '', '검토 소스 수'], ['confidence', '', '신뢰도']], d: {
  grain: '스냅샷 × 조건 × 심층 근거 주장 1개 = 1행.', pk: 'snapshot_id + entity_id + claim_id', inputs: '심층 근거 검증', uses: '그래프 조건 패널의 심층 근거 · 점선 링 · 툴바의 deep_evidence_linked', cur: '없음 (신규)' } });
tbl('ctx_claim_quote', { s: 'gold', name: 'ctx_claim_quote', fam: 'soc', grain: '주장 × 인용 표본', cols: [['snapshot_id · entity_id · claim_id', 'PF', '', 'ctx_claim'], ['seq', 'PK', ''], ['quote', '', ''], ['source', '', ''], ['stance', '', 'supporting · contradicting · neutral']], d: {
  grain: '주장 × 인용 표본 1개 = 1행.', pk: 'snapshot_id + entity_id + claim_id + seq', inputs: '심층 근거 검증', uses: '심층 근거의 표본 인용', cur: '없음 (신규)' } });
tbl('ctx_research_run', { s: 'gold', name: 'ctx_research_run', fam: 'soc', grain: '리서치 실행 1회', cols: [['run_id', 'PK', 'uuid'], ['keyword', '', ''], ['geo_key', 'FK', '지역', 'dim_country'], ['lang_key', 'FK', '', 'dim_lang'], ['purpose_preset · purpose_text', '', '목적'], ['status', '', 'queued · exploring · done · failed'],
  ['requested_by', 'FK', '', 'app.user_account'], ['started_at · finished_at', '', ''], ['search_count · source_count · worker_count', '', '탐색 카운터'], ['cost_usd', '', ''], ['snapshot_id', 'FK', '결과 지도', 'ctx_snapshot']], d: {
  grain: '리서치 실행 1회 = 1행.', pk: 'run_id', inputs: 'judgment_change ctx_research (BE 요청) → 데이터 분석팀 리서치 실행', triggers: '요청 접수 · 진행 · 완료',
  uses: 'Admin 리서치 입력 폼 · 탐색 화면 카운터 · 결과 지도 연결', cur: '없음 (신규. 현행은 스크립트 픽스처, 입력 폼은 지역·목적을 버림)' } });
tbl('ctx_research_wave', { s: 'gold', name: 'ctx_research_wave', fam: 'soc', grain: '실행 × 탐색 웨이브', cols: [['run_id', 'PF', '', 'ctx_research_run'], ['wave_no', 'PK', ''], ['strategy', '', ''], ['task_count', '', ''], ['started_at', '', '']], d: {
  grain: '실행 × 웨이브 1개 = 1행.', pk: 'run_id + wave_no', inputs: '리서치 실행', uses: '탐색 화면 웨이브 목록', cur: '없음 (신규)' } });
tbl('ctx_research_worker', { s: 'gold', name: 'ctx_research_worker', fam: 'soc', grain: '실행 × 워커', cols: [['run_id', 'PF', '', 'ctx_research_run'], ['worker_id', 'PK', ''], ['wave_no', '', ''], ['label · query', '', ''], ['status', '', ''], ['source_count', '', ''], ['dispatched_at · completed_at', '', '']], d: {
  grain: '실행 × 워커 1개 = 1행.', pk: 'run_id + worker_id', inputs: '리서치 실행', uses: '탐색 화면 워커 목록 · 완료 수 · 출처 수', cur: '없음 (신규)' } });
tbl('ctx_research_log', { s: 'gold', name: 'ctx_research_log', fam: 'soc', grain: '실행 × 활동 로그', cols: [['run_id', 'PF', '', 'ctx_research_run'], ['seq', 'PK', ''], ['kind', '', ''], ['title · detail', '', ''], ['created_at', '', '']], d: {
  grain: '실행 × 로그 1줄 = 1행.', pk: 'run_id + seq', inputs: '리서치 실행', uses: '탐색 화면 활동 로그', cur: '없음 (신규)' } });

/* ── 데이터 분석팀 신규 · 변경 요청 (현행 rd 에 없는 것) ── */
const NEWREQ = [
  { t: 'answer_fact.own_fp_{h,k,g}', kind: '신규 열', f: '국가별 GEO 현황 · 시장별 경쟁 위치의 우선 노출도 (T001)', src: '답변 본문의 텍스트상 첫 등장 순서 (브랜드 언급 추출)' },
  { t: 'answer_brand_fact.first_pos', kind: '신규 열', f: 'GEO 경쟁사 우선 노출도 (T001)', src: '위와 같은 규칙, 브랜드별' },
  { t: 'answer_fact.rep_cit_xor', kind: '정의 변경', f: '답변 분석 인용 대표 (현행 rd.rep_cit_delta 행을 열로 접음)', src: '현행 rep_cit_delta 규칙' },
  { t: 'catalog_entry.depth4_key', kind: '신규 열', f: 'depth4 필터 (대시보드 · 언급 · 인용 · Visibility · ACR · 프롬프트 목록)', src: 'app.prompt.depth4 → dim_taxon axis depth4' },
  { t: 'catalog_entry', kind: '정의 변경', f: 'KPI 적용·측정 프롬프트 수가 같은 release 의 사실과 맞도록 build 로 버전 관리', src: 'build_id 를 PK 에 포함' },
  { t: 'publication.build_id', kind: '정의 변경', f: '카드 동결 7개 경로 (frz.keep_* 보관 행 대체)', src: '발행 시점 사실 build 고정 · ops 이관 세대도 build 로' },
  { t: 'build', kind: '신규 테이블', f: '모든 사실·셀의 세대 · 반영 큐 화면 applied_build_id', src: '데이터 분석팀 빌드 이력' },
  { t: 'release', kind: '신규 테이블', f: '한 응답 안의 숫자를 같은 세대로 고정 (release_item · active_release 포함)', src: '검증 통과 build 묶음' },
  { t: 'data_version', kind: '신규 테이블', f: 'BE 결과 캐시 무효화 (현행 rcache 트리거 대체)', src: 'release 밖 gold 쓰기마다 증가' },
  { t: 'cycle_pick_basis', kind: '누락 보강', f: '기간 선택 시 카드 동결 판정 (생성 대기 구멍)', src: '현행 rd.cycle_pick_basis 그대로' },
  { t: 'ga4_property.conv_basis', kind: '누락 보강', f: 'Admin > GA4 연동 전환 기준 열', src: '현행 rd.ga4_dim_property.conv_basis' },
  { t: 'kw_volume_monthly.competition', kind: '누락 보강', f: 'Admin > Keyword tools 경쟁도 라벨', src: 'DataForSEO competition (현행 열)' },
  { t: 'kw_suggestion.total_count', kind: '누락 보강', f: 'Google keywords 연관어 총수 (BG-39)', src: 'DataForSEO total_count (현행 열)' },
  { t: 'ga4_users_window', kind: '신규 테이블', f: '순 방문자 · 방문 빈도 · 입구 페이지 사용자 · 사용자 기준 전환율 (std · website · project)', src: 'GA4 Data API activeUsers, 필터 조합별' },
  { t: 'page_visibility_daily', kind: '신규 테이블', f: 'AI Visibility 4분면 카드 · 산점도 · 페이지 진단 표', src: 'GSC 페이지 노출 + 서버 크롤 로그' },
  { t: 'page_crawl_daily', kind: '신규 테이블', f: 'AI 크롤 수 엔진 필터', src: '서버 크롤 로그 (dim_crawl_bot 포함)' },
  { t: 'page_seo_device_daily', kind: '신규 테이블', f: 'AI Visibility 기기 필터', src: 'GSC device 차원' },
  { t: 'page_priority', kind: '신규 테이블', f: 'AI Visibility 페이지 진단 표 우선순위 (산정 규칙 정의 포함)', src: '데이터 분석팀 규칙 (rule_ver)' },
  { t: 'dim_url', kind: '정의 변경', f: 'Visibility 페이지와 인용 URL 을 같은 키로 (인용 안 된 자사 페이지 행 추가)', src: '자사 사이트 페이지 목록' },
  { t: 'ga4_value.url_key', kind: '신규 열', f: 'Visibility 방문자 유형 필터 (GA4 입구 페이지 ↔ URL)', src: 'landingPagePlusQueryString 정규화' },
  { t: 'acr_iter_fact', kind: '신규 테이블', f: '모델별 점유 맵의 반복별 승자 · 최빈 브랜드', src: 'ACR 반복 단위 최종 선택' },
  { t: 'acr_iter_shortlist', kind: '신규 테이블', f: '차종별 선택 전환율의 후보군 등장 run 수', src: 'ACR 반복 단위 후보군' },
  { t: 'ctx_snapshot.keyword', kind: '신규 열', f: '구매 맥락 지도 제목 · 지역별 스냅샷 · 그래프 툴바 (keyword · geo_key · lang_key · run_id · worker_total · speaker_total · source_total)', src: '구매 맥락 추출' },
  { t: 'ctx_entity.perspective_buyer', kind: '신규 열', f: '관점 분포 · 관점 필터 · mention_rate (group_id · worker_count · unique_source_count · perspective_*)', src: '구매 맥락 추출' },
  { t: 'ctx_evidence.source_title', kind: '신규 열', f: '근거 인용의 출처 제목 · 순서 (source_title · rank)', src: '구매 맥락 추출' },
  { t: 'ctx_drive.strength_score', kind: '신규 열', f: '그래프 유발 강도 (엣지 굵기 · 막대)', src: '구매 맥락 추출' },
  { t: 'ctx_combination.description', kind: '신규 열', f: '조합 시나리오 · 발화자 수 · 출처 수 · overlap', src: '구매 맥락 추출' },
  { t: 'ctx_group', kind: '신규 테이블', f: '테마 · 카테고리 이름과 설명', src: '구매 맥락 추출' },
  { t: 'ctx_combination_evidence', kind: '신규 테이블', f: '조합 근거 · 출처 URL', src: '구매 맥락 추출' },
  { t: 'ctx_claim', kind: '신규 테이블', f: '조건 심층 근거 (주장 · 지지/반박/중립 · 검토 수 · 신뢰도, ctx_claim_quote 포함)', src: '심층 근거 검증' },
  { t: 'ctx_research_run', kind: '신규 테이블', f: 'Admin 리서치 입력 · 탐색 화면 · 결과 지도 (wave · worker · log 포함)', src: 'judgment_change ctx_research 요청 처리' },
  { t: 'judgment_change', kind: '정의 변경', f: 'kind ctx_research 추가 (리서치 실행 요청, BE 쓰기)', src: 'app CHECK 제약에 값 추가' },
  { t: 'kpi_cell', kind: '신규 테이블', f: '선택 가속층 (kpi_cell · kpi_rollup · brand_cell · citation_cell · url_prompt_cell). 없으면 BE 가 사실에서 계산', src: '같은 build 의 사실 합계' },
];

/* ───────── 탭(뷰) ───────── */
const VIEWS = [
  { g: '차원', id: 'dim', label: '공통 차원', w: 1090, h: 660, main: 'cell_key',
    note: '셀 집계가 공유하는 키 묶음(C)과 공통 차원입니다. 정수 키는 현행 rd 처럼 발급 원장이고 재번호하지 않습니다. 차원은 build 로 나누지 않는 현재값이고(현행 rd 와 같음), 바뀌면 data_version 을 올립니다.',
    pos: { dim_population: [20, 20, 220], dim_project: [20, 170, 220], dim_cycle: [20, 404, 240], cell_key: [320, 150, 240],
      dim_prompt_ref: [620, 20, 220], dim_engine: [620, 118, 220], dim_country: [620, 262, 220], dim_lang: [620, 442, 220], dim_region: [890, 290, 180], cycle_pick_basis: [320, 440, 240] },
    loop: { 'dim_cycle>dim_project': 'L' } },
  { g: '차원', id: 'prompt', label: '프롬프트·웹 유닛', w: 1150, h: 520, main: 'dim_prompt',
    note: '프롬프트, 카탈로그 행, 웹사이트 보고 유닛입니다. Website KPI 는 보고 유닛 소속 프롬프트만 모수로 셉니다. dim_prompt → dim_project · dim_lang 관계는 열 옆에만 표시했습니다.',
    pos: { catalog_entry: [20, 20, 230], dim_taxon: [20, 262, 230], dim_prompt: [320, 20, 260], web_report_prompt: [650, 20, 230], web_unit: [650, 146, 230], web_target_url: [650, 380, 230],
      dim_project_ref: [950, 20, 180], dim_lang_ref: [950, 118, 180], dim_url_ref: [950, 216, 180], website_report_excluded: [950, 314, 180] },
    skip: ['dim_prompt>dim_project_ref', 'dim_prompt>dim_lang_ref'], loop: { 'catalog_entry>dim_taxon': 'L', 'web_report_prompt>web_unit': 'L' } },
  { g: '답변 계열', id: 'fact', label: '답변 사실', w: 1220, h: 840, main: 'answer_fact',
    note: '현행 rd.job · rd.answer · rd.answer_brand · rd.answer_stance · rd.citation 과 같은 그레인·열입니다. 현행 기능 대부분이 이 층을 읽고, 셀 집계는 여기서 만듭니다. 세 사실의 C 좌표 사본은 선이 겹쳐 생략했습니다.',
    pos: { job_index: [20, 20, 230], cell_key_c: [20, 300, 230], answer_fact: [320, 20, 290], answer_brand_fact: [690, 20, 270], answer_stance_fact: [690, 326, 270], citation_fact: [690, 578, 270],
      dim_brand_ref: [1030, 20, 170], dim_entity_ref: [1030, 118, 170], dim_url_ref: [1030, 600, 170], dim_source_ref: [1030, 698, 170] },
    skip: ['answer_brand_fact>cell_key_c', 'citation_fact>cell_key_c'], loop: { 'job_index>cell_key_c': 'L' } },
  { g: '답변 계열', id: 'kpi', label: 'KPI·언급 셀', w: 1330, h: 560, main: 'kpi_cell',
    note: '노출률·점유율·우호도·우선 노출도·스탠스와 경쟁 브랜드 비교를 셀 단위로 미리 더한 가속층입니다. 점선 화살표는 같은 build 의 사실에서 만든다는 뜻입니다.',
    pos: { answer_fact_ref: [20, 20, 160], answer_stance_fact_ref: [20, 118, 160], kpi_cell: [230, 20, 260], kpi_rollup: [230, 380, 260], cell_key_c: [560, 20, 190], dim_perspective: [560, 200, 190],
      brand_cell: [820, 20, 250], entity_mention_total: [820, 320, 250], answer_brand_fact_ref: [1130, 20, 170], dim_brand: [1130, 118, 170], dim_entity: [1130, 298, 170] },
    derive: [['answer_fact_ref', 'kpi_cell', 'SUM'], ['answer_stance_fact_ref', 'kpi_cell', 'SUM'], ['kpi_cell', 'kpi_rollup', 'SUM (가산 열)'], ['answer_brand_fact_ref', 'brand_cell', 'SUM']] },
  { g: '답변 계열', id: 'cit', label: '인용 셀', w: 1180, h: 790, main: 'citation_cell',
    note: '출처 · 카테고리 · 자사 판정과 URL 인용률입니다. citation_cell · url_prompt_cell 은 가속층이고, report_value 는 웹사이트 발행값이라 사실에서 다시 계산하지 않습니다.',
    pos: { dim_perspective: [20, 20, 190], owned_base: [20, 164, 190], citation_fact_ref: [20, 344, 190], answer_fact_ref: [20, 452, 190], citation_cell: [270, 20, 250], url_prompt_cell: [270, 300, 250],
      cell_key_c: [590, 20, 210], dim_source: [590, 200, 210], dim_url: [590, 416, 210], dim_category: [590, 632, 210], report_value: [900, 20, 240], dim_cycle_ref: [900, 272, 240] },
    skip: ['dim_url>owned_base'], derive: [['citation_fact_ref', 'citation_cell', 'SUM'], ['answer_fact_ref', 'url_prompt_cell', 'SUM']] },
  { g: '기타 계열', id: 'acr', label: 'ACR', w: 1170, h: 610, main: 'acr_cell_fact',
    note: 'AI 에이전트 최종 선택(ACR)입니다. 셀 단위 반복 모수와 엔티티 단위 선택 수를 나눠 적재하고, 배틀 승자는 필터를 건 뒤 BE 가 계산합니다.',
    pos: { cell_key_c: [20, 20, 200], job_index_ref: [20, 200, 200], acr_cell_fact: [290, 20, 260], acr_cell_job: [290, 300, 260], acr_iter_shortlist: [290, 440, 260], acr_entity_fact: [620, 20, 260], acr_iter_fact: [620, 250, 260], dim_entity: [950, 20, 190], dim_brand: [950, 210, 190] } },
  { g: '기타 계열', id: 'ga4', label: 'GA4', w: 870, h: 540, main: 'ga4_row', note: '',
    pos: { dim_engine: [20, 20, 190], ga4_row: [280, 20, 260], ga4_users_window: [280, 330, 260], ga4_property: [610, 20, 220], dim_country_ref: [610, 218, 220], ga4_value: [610, 326, 220] } },
  { g: '기타 계열', id: 'kw', label: '키워드', w: 960, h: 440, main: 'kw_volume_monthly',
    note: '키워드는 적재된 값을 그대로 씁니다. BE 의 수집 버튼은 judgment_change dfs_fetch 로 요청하고, 데이터 분석팀이 외부 호출 후 이 테이블에 씁니다. SERP 와 연관 검색어는 집계 없이 그대로 화면에 나갑니다.',
    pos: { kw_volume_monthly: [20, 20, 260], dim_keyword: [360, 20, 200], kw_serp: [650, 20, 280], kw_suggestion: [650, 236, 280] } },
  { g: '기타 계열', id: 'soc', label: '소셜', w: 1150, h: 660, main: 'ctx_entity',
    note: '소셜 구매 맥락은 스냅샷 단위로 공개합니다. 연결 테이블의 snapshot_id 는 모두 ctx_snapshot 을 가리키지만 선은 ctx_entity 쪽만 그렸습니다.',
    pos: { ctx_snapshot: [20, 20, 250], ctx_group: [20, 330, 250], ctx_entity: [320, 20, 260], ctx_claim: [320, 300, 260], ctx_claim_quote: [320, 490, 260], ctx_drive: [630, 20, 230], ctx_combination: [630, 180, 230], ctx_combination_evidence: [630, 370, 230], ctx_domain: [910, 20, 220], ctx_evidence: [910, 170, 220] } },
  { g: '기타 계열', id: 'research', label: '소셜 리서치', w: 880, h: 480, main: 'ctx_research_run',
    note: 'Admin > Customer interest config 의 리서치 입력 · 탐색 화면 · 결과 지도입니다. 실행 요청은 BE 가 judgment_change ctx_research 로 넘기고, 데이터 분석팀이 진행 기록과 결과 스냅샷을 씁니다. 실시간 진행 표시는 폴링으로 이 테이블을 읽습니다.',
    pos: { ctx_research_run: [20, 20, 270], ctx_research_wave: [350, 20, 230], ctx_research_worker: [350, 190, 230], ctx_research_log: [640, 20, 220], ctx_snapshot_ref: [640, 220, 200], dim_country_ref: [640, 310, 200], dim_lang_ref: [640, 400, 200] } },
  { g: '기타 계열', id: 'vis', label: 'AI Visibility', w: 800, h: 580, main: 'page_visibility_daily', note: '분면·카드 수·중앙값은 저장하지 않고 필터를 건 페이지 집합에서 BE 가 계산합니다. 프롬프트·브랜드·경쟁사 필터는 그 페이지를 인용한 답변으로 겁니다 (citation_fact).',
    pos: { page_visibility_daily: [20, 20, 260], page_crawl_daily: [20, 250, 260], page_seo_device_daily: [20, 390, 260], page_priority: [330, 390, 240], dim_project_ref: [330, 20, 180], dim_url_ref: [330, 110, 180], dim_country_ref: [560, 20, 180], dim_lang_ref: [560, 110, 180], dim_crawl_bot: [330, 250, 220], dim_engine_ref: [600, 250, 170], ga4_value_ref: [600, 390, 180] },
    loop: { 'page_crawl_daily>page_visibility_daily': 'L' } },
  { g: '공개', id: 'pub', label: '발행 세대', w: 1250, h: 670, main: 'publication',
    note: '대시보드 카드 경로 7개가 읽는 동결 값입니다. 발행 세대가 그 회차의 사실 build 를 고정하고, 셀 대표 집합·프롬프트 게이트·택소노미·표시명·웹 셀 판정을 발행 시점 값으로 보관합니다.',
    pos: { dim_cycle_ref: [20, 20, 190], build_ref: [20, 108, 190], publication: [280, 20, 260], pub_brand_name: [280, 300, 260], pub_cell: [610, 20, 250], pub_cell_web: [610, 200, 250], pub_prompt: [610, 380, 250],
      answer_fact_ref: [930, 20, 280], dim_prompt_ref: [930, 280, 280], pub_prompt_axis: [930, 380, 280], dim_taxon_ref: [930, 578, 280] },
    loop: { 'pub_brand_name>publication': 'L' } },
  { g: '공개', id: 'build', label: '빌드·릴리스', w: 1170, h: 490, main: 'build',
    note: '골드를 회차마다 자동 생성하되 검증을 통과한 세대만 보이게 하는 제어 테이블입니다. LIVE 는 active_release → release_item → build_id, 카드는 publication.build_id 를 읽습니다.',
    pos: { gold_facts: [20, 20, 280], publication_ref: [20, 274, 280], judgment_change_ref: [20, 380, 280], build: [370, 20, 260], release_item: [690, 20, 210], release: [960, 20, 190], active_release: [960, 190, 190], data_version: [690, 230, 210] } },
  { g: '답변 계열', id: 'silver', label: '답변 원문', w: 1090, h: 730, main: 'answer_body',
    note: '답변 모달·검수·엔티티 카탈로그가 읽는 원문 조회 뷰입니다. 뷰 뒤의 원천은 데이터 분석팀 소관이고 BE 는 이 뷰 계약만 봅니다. 모든 뷰에 접근 범위 열이 있어야 BE 가 권한을 검사할 수 있습니다.',
    pos: { answer_body: [20, 20, 320], answer_registry: [20, 254, 320], answer_citation_raw: [20, 434, 320], job_index_ref: [420, 260, 230], acr_cell_run: [420, 420, 230], entity_mention_surface: [420, 560, 230],
      answer_mention_raw: [730, 20, 330], answer_occurrence: [730, 272, 330], answer_stance_raw: [730, 506, 330] } },
  { g: 'app', id: 'queue', label: 'BE 요청 큐', w: 1110, h: 320, main: 'judgment_change',
    note: 'GEO HUB 가 데이터 분석팀에 일을 넘기는 유일한 쓰기 경로입니다. 설정을 저장하면 트리거가 요청을 쌓고, 데이터 분석팀이 처리한 뒤 새 build 번호를 적습니다.',
    pos: { app_inputs: [20, 20, 330], judgment_change: [410, 20, 270], judgment_kind: [750, 20, 330], build_ref: [750, 220, 330] },
    derive: [['app_inputs', 'judgment_change', '저장 트리거']] },
];
const HOME = {};
VIEWS.forEach(v => Object.keys(v.pos).forEach(id => { if (!HOME[id] && !T[id].ghostOf) HOME[id] = v.id; }));
const viewLabel = id => (VIEWS.find(v => v.id === id) || {}).label || '';

