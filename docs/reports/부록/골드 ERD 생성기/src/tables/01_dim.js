/* ── 공통 차원 ── */
tbl('cell_key', { s: 'key', name: 'C 공통 셀 키', fam: 'dim', grain: '셀 집계 PK 의 앞부분 · 사실의 필터 열', cols: [
  ['build_id', 'FK', '빌드(세대)', 'build'], ['population_key', 'FK', '모수 규칙', 'dim_population'], ['surface', '', '1 global · 2 website · 3 project'],
  ['project_key', 'FK', '', 'dim_project'], ['cyc_key', 'FK', '회차', 'dim_cycle'], ['round_date · bucket_date', '', '회차일 · 지표별 버킷'],
  ['prompt_key', 'FK', '', 'dim_prompt'], ['engine_key', 'FK', '', 'dim_engine'], ['geo_key', 'FK', '국가', 'dim_country'], ['lang_key', 'FK', '', 'dim_lang'], ['bgrp', '', '브랜드 비트 (카탈로그·사이트·프로젝트)'] ], d: {
  grain: '테이블이 아니라 키 묶음입니다. 셀 집계(kpi_cell · brand_cell · citation_cell · url_prompt_cell)의 PK 앞부분이고, 사실 테이블(job_index · answer_fact · answer_brand_fact · citation_fact · acr_cell_fact)은 이 중 회차 · 프롬프트 · 프로젝트 · 엔진 · 국가 · 언어 · bgrp 를 일반 열로 가집니다.',
  pk: '—', inputs: '데이터 분석팀', uses: '필터·권한 축: 표면, 프로젝트, 회차·기간, 프롬프트(택소노미), 엔진, 국가(계정 권역 스코프 포함), 언어, 브랜드(bgrp)',
  rules: ['bucket_date 의 의미(측정일 · 회차일 · 앵커일)를 지표별로 고정하고 섞지 않습니다.', '프로젝트 · 브랜드 · 엔진 · 국가 · 언어 · 프롬프트 권한과 필터는 이 열로 겁니다. 상위 합계에서도 권한 축을 지우지 않습니다.'] } });
tbl('cell_key_c', { s: 'key', ghostOf: 'cell_key', name: 'C 공통 셀 키', cols: [['build · population', '', ''], ['surface · project · cyc', '', ''], ['round_date · bucket', '', ''], ['prompt · engine', '', ''], ['geo · lang · bgrp', '', '']] });
tbl('dim_population', { s: 'gold', name: 'dim_population', fam: 'dim', grain: '모수 규칙 1개', cols: [['population_key', 'PK', 'int2'], ['code', '', 'mentions · citations · gap · url · acr'], ['gate', '', 'std_in · cit_in · gap · web_reg · acr_in · *_nc'], ['rep_mode', '', '대표 답변 선택 규칙']], d: {
  grain: '셀 집계(kpi_cell · brand_cell · citation_cell · url_prompt_cell)의 모수 규칙 1개 = 1행.', pk: 'population_key', inputs: '데이터 분석팀 (출처 제안: answer_fact 의 게이트 · 모수 열 정의)',
  rules: ['언급(std_in) · 인용(cit_in, 결손 포함) · URL(web_reg) · ACR(acr_in) 모수가 서로 달라 답변 수 하나로 모든 분모를 대신할 수 없습니다.',
    '삭제 행 포함 카탈로그 모수(std_in_nc · cit_in_nc), 셀 대표 답변(is_rep), 보고 유닛 게이트처럼 모수를 바꾸는 조합은 모수 규칙 행 하나로 둡니다.'] } });
tbl('dim_project', { s: 'gold', name: 'dim_project', fam: 'dim', grain: 'Scope 프로젝트 1개', cols: [
  ['project_key', 'PK', 'int2'], ['scope_project_id', 'UK', 'uuid'], ['surface', '', '1 global · 2 website · 3 project'], ['is_root', '', '표준 루트 (global 1개)'], ['project_id', '', '프로젝트 ID (루트 · 고객 프로젝트)'], ['site_id', '', '웹사이트 사이트 ID'], ['site_brand_bit · site_geo_key', '', '사이트 브랜드 비트 · 국가'], ['regions[]', '', 'Scope 시장 설정'] ], d: {
  grain: 'Scope 프로젝트 1개 = 1행. global 루트, 웹사이트 사이트, 고객 프로젝트의 Scope 프로젝트가 모두 들어갑니다.', pk: 'project_key', inputs: '데이터 분석팀',
  uses: '표면·프로젝트 범위(global 루트 · 웹사이트 사이트 선택 · Project 화면의 프로젝트 키), 답변 상세 프로젝트 확인, Admin › Global config › Global prompts 시장 어휘(regions)' } });
tbl('dim_cycle', { s: 'gold', name: 'dim_cycle', fam: 'dim', grain: '회차 1개', cols: [
  ['cyc_key', 'PK', '회차 키'], ['cycle_id', 'UK', 'uuid'], ['surface · ledger_backed', '', '표면 · 원장 회차(파생 아님)'], ['project_key', 'FK', '', 'dim_project'], ['round_date · anchor_date', '', ''], ['status · servable', '', '상태 · 서빙 가능'],
  ['view_date · hidden_scope · hidden_reason', '', '노출일 · 숨김 범위 · 숨김 사유'], ['expected_units · completed_units', '', '진행률'], ['completed_answers · gap_answers', '', ''], ['generation · ecat_ver', '', '표면 세대 · 고정 엔티티 버전'] ], d: {
  grain: '회차 1개 = 1행. 프로젝트 가상 회차도 같은 발급처에서 키를 받습니다.', pk: 'cyc_key', inputs: '데이터 분석팀',
  uses: '분석 화면의 기간·회차 창(servable ∧ view_date ≤ 오늘), 추이 · 기간 비교, 답변 상세 노출 게이트, Project › Prompt 영향 수, Project › Setting › General 분석 연결 진단, Entity catalog 버전 고정(ecat_ver)',
  rules: ['servable · view_date · hidden_scope 는 조회 때 거는 게이트입니다(사실 행은 그대로). release 를 거치지 않고 바뀐 즉시 보이며, 바뀌면 data_version 을 올립니다.',
    'status 0 open · 1 closed · 2 published · 3 stale. servable = published ∧ 함대 가시 (project 표면은 항상 참).',
    'hidden_scope 0 없음 · 1 all · 2 citations · 3 mentions, hidden_reason 0 없음 · 1 collection_error · 2 operator. 둘은 함께 0 이거나 함께 0 이 아닙니다.',
    '최종 KPI 는 중간 집계 없이 회차 분석이 끝난 뒤 계산합니다 (20261015/D07).'] } });
tbl('cycle_pick_basis', { s: 'gold', name: 'cycle_pick_basis', fam: 'dim', grain: '회차 1개의 창 판정 근거', cols: [
  ['cyc_key', 'PF', '', 'dim_cycle'], ['fleet_visible', '', '주 묶음 대표 회차 (함대 가시)'], ['gap_ratio', '', '판정 갭 비율 numeric(6,5)'], ['gap_src', '', 'ops · hub'], ['ops_status', '', 'ops 회차 closed · generating · published'], ['updated_at', '', ''] ], d: {
  grain: '회차 1개 = 1행.', pk: 'cyc_key', inputs: '데이터 분석팀', triggers: '회차 개설 · 귀속 · 카운터 · 종결 · 발행 때마다',
  uses: 'Global · Website 카드(Overview 카드 · 추이 격자)와 기간 비교(Δ)의 누적 창(기간 선택 · 최근 N)을 발행 세대로 읽을지 판정',
  rules: ['gap_src ops 회차의 gap_ratio 는 운영 원값, hub 회차는 gap_answers ÷ completed_answers (소수 5자리) 입니다.',
    '생성 대기 회차 = 닫힘 ∧ 원장 회차 ∧ 숨김 아님 ∧ (website 면 fleet_visible) ∧ gap_ratio ≤ 0.05 ∧ ops_status ≠ generating ∧ 활성 발행 세대 없음. 누적 창에 생성 대기 회차가 있으면 발행 세대 대신 최신 사실로 읽습니다.',
    '바뀌면 data_version 을 올립니다.'] } });
tbl('dim_engine', { s: 'gold', name: 'dim_engine', fam: 'dim', grain: 'AI 엔진 1개', cols: [['engine_key', 'PK', 'int2'], ['code', 'UK', 'AI 엔진 코드'], ['is_default', '', '기본 엔진 (engine 미지정 시)']], d: {
  grain: 'AI 엔진 1개 = 1행.', pk: 'engine_key', inputs: '데이터 분석팀',
  uses: '엔진 필터 · 기본 엔진, 엔진 코드 표기(답변 · 인용 · ACR), 필터 옵션 엔진 목록, 프로젝트 만들기 · 엔진 설정의 엔진 어휘, 검수 목록 엔진 필터' } });
tbl('dim_country', { s: 'gold', name: 'dim_country', fam: 'dim', grain: '국가(시장) 1개', cols: [['geo_key', 'PK', 'int2'], ['code', 'UK', '국가 코드 (대소문자 무시 유일)'], ['region_key', 'FK', '대륙', 'dim_region'], ['kind · virtual_brand_bit', '', 'iso · pseudo · virtual_brand · unknown · 가상 브랜드 비트'], ['hidden_standard', '', 'global 숨김 시장']], d: {
  grain: '국가(시장) 1개 = 1행.', pk: 'geo_key', inputs: '데이터 분석팀',
  uses: '국가 필터·권한(가상 브랜드 코드 포함), 국가 코드 표기(국가별 GEO 현황 · 답변 · 인용 · ACR), global 숨김 시장, AI Conversion 시장 ↔ GA4 속성 매핑, Website 자사 · 타겟 URL 인용률 카드의 발행값 국가 범위, Admin › User management 계정 국가 스코프 검증',
  rules: ['kind unknown 은 geo_key 0 표식 행입니다.'] } });
tbl('dim_region', { s: 'gold', name: 'dim_region', fam: 'dim', grain: '대륙 1개', cols: [['region_key', 'PK', 'int2'], ['code', 'UK', '대륙 (ISO 국가 → 대륙 매핑)']], d: {
  grain: '대륙 1개 = 1행.', pk: 'region_key', inputs: '데이터 분석팀',
  rules: ['code 는 Africa · Asia · Europe · Latin America · Middle East · North America · Oceania 와 key 0 빈 코드입니다. 계정 권역(RHQ)과는 다른 개념입니다.'] } });
tbl('dim_lang', { s: 'gold', name: 'dim_lang', fam: 'dim', grain: '언어 1개', cols: [['lang_key', 'PK', 'int2'], ['code', 'UK', '소문자 언어 코드']], d: {
  grain: '언어 1개 = 1행.', pk: 'lang_key', inputs: '데이터 분석팀', uses: '언어 필터, 언어 코드 표기(ACR · 검수)' } });
