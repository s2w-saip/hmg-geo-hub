/* ── 프롬프트 · 카탈로그 · 웹 유닛 ── */
tbl('dim_prompt', { s: 'gold', name: 'dim_prompt', fam: 'prompt', grain: '측정 프롬프트 1개', cols: [
  ['prompt_key', 'PK', 'int4'], ['prompt_id', 'UK', 'uuid'], ['surface · kind', '', '표면 · single · acr'], ['project_key', 'FK', '', 'dim_project'], ['text', '', '프롬프트 본문 (표시 · 검색)'], ['lang_key', 'FK', '', 'dim_lang'], ['funnel_key', 'FK', '', 'dim_taxon'],
  ['cat_mask · cat_mask_all', '', '루트 카탈로그 브랜드 비트 · 삭제 포함'], ['in_root_catalog · in_root_catalog_all', '', '루트 카탈로그 소속 · 삭제 포함'], ['unit_key', 'FK', '웹 유닛', 'web_unit'], ['targets[]', '', '웹 타겟 URL 정규형'], ['web_reg', '', '웹 카탈로그 등록'], ['regions[] · is_korean', '', 'Scope 시장 태그 · 한글 본문'], ['rule_ver', '', ''] ], d: {
  grain: '측정 프롬프트 1개 = 1행 (single · acr).', pk: 'prompt_key', inputs: '데이터 분석팀 · app.prompt (종류 · 언어 · 퍼널 · 루트 카탈로그) · app.brand · app.website_prompt · app.website_site',
  uses: '프롬프트 본문 · 퍼널 표시(답변 목록·상세 · 인용 프롬프트 · 톤 · 도메인 상세 · ACR · 검수), KPI 적용 프롬프트 수(website = web_reg), Global prompts · Website › Prompts · Admin › Global config › Global prompts 카탈로그, Project › Prompt 영향 수, 검수 목록 · 노트, 미측정 목록 API(호출 화면 없음)', cur: 'rd.dim_prompt (열 전부)',
  rules: ['레거시 프로필 스위치 catalog_incl_deleted(A41)가 cat_mask_all · in_root_catalog_all(삭제 행 포함 카탈로그)을 읽습니다.'] } });
tbl('catalog_entry', { s: 'gold', name: 'catalog_entry', fam: 'prompt', grain: '빌드 × 루트 카탈로그 행 (비삭제)', cols: [
  ['catalog_row_id', 'PK', 'uuid = app.prompt.prompt_id'], ['prompt_key', 'FK', '미발행 행 NULL', 'dim_prompt'], ['brand_bit', '', '행 브랜드 비트 (없음 = 엄브렐러)'], ['kind', '', 'single · acr'], ['presence_key', 'FK', '', 'dim_taxon'], ['funnel_key · list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon'], ['depth4_key', 'FK', '현행 app.prompt.depth4 (신규)', 'dim_taxon'], ['build_id', 'PF', '현행 load_id', 'build'] ], d: {
  grain: '빌드 × 표준 루트 카탈로그 행(비삭제) 1개 = 1행. 한 프롬프트에 여러 행이 붙을 수 있습니다.', pk: 'build_id + catalog_row_id', inputs: '데이터 분석팀 · app.prompt (표준 루트 카탈로그) · app.brand',
  uses: 'global 택소노미 · depth4 필터의 프롬프트 키 해석(답변 목록 · 언급 · 인용 · ACR · 국가별 GEO · KPI), KPI 적용 프롬프트 수 · 미측정 목록, 필터 옵션 카탈로그 택소노미, 답변 상세 택소노미', cur: 'rd.catalog_entry (load_id → build_id, depth4_key 신규)',
  rules: ['한 프롬프트에 여러 카탈로그 행이 붙으므로 현행 BE 는 프롬프트 수를 DISTINCT prompt_key 로 셉니다.', '현행 BE 는 depth4 필터를 app.prompt.depth4 에 catalog_row_id = prompt_id 로 붙여 겁니다(rd.dim_taxon 축 아님). 골드에서는 depth4_key 로 겁니다.'] } });
tbl('dim_taxon', { s: 'gold', name: 'dim_taxon', fam: 'prompt', grain: '택소노미 코드 1개', cols: [['taxon_key', 'PK', 'int2'], ['axis', '', 'funnel · presence · list_type · depth1~3, depth4 (신규)'], ['code', '', '(axis, code, parent_key) 유일'], ['parent_key', 'FK', '상위 코드', 'dim_taxon']], d: {
  grain: '택소노미 코드 1개 = 1행.', pk: 'taxon_key', inputs: '데이터 분석팀 · app.prompt (카탈로그 · 퍼널) · app.brand',
  uses: '택소노미 필터 해석 · 필터 옵션, 퍼널 코드 표시(KPI 퍼널별 측정 수 · 인용 프롬프트 · 언급 프롬프트 · 도메인 상세 · 검수 상세), 답변 상세 택소노미', cur: 'rd.dim_taxon (열 전부, axis depth4 값은 신규)' } });
tbl('web_unit', { s: 'gold', name: 'web_unit', fam: 'prompt', grain: '웹사이트 유닛 (프로젝트 × file_seq)', cols: [
  ['unit_key', 'PK', 'int2'], ['project_key', 'FK', '', 'dim_project'], ['file_seq', 'UK', 'project_key 와 복합 유일'], ['lang_codes[]', '', '소문자 언어 코드'], ['base · base_src', '', '자사 base · decl · heur'], ['sibs[] · home_host', '', '하위 선언 base · base 호스트'], ['turls[]', '', '타겟 URL 정규형'], ['rule_ver', '', ''] ], d: {
  grain: '웹사이트 유닛(사이트 프로젝트 × file_seq) 1개 = 1행.', pk: 'unit_key (프로젝트 × file_seq 유일)', inputs: '데이터 분석팀 · app.website_prompt · app.website_site',
  uses: 'R09 발행값 범위: 허용 프로젝트 유닛의 file_seq 만 합산(Website 자사 · 타겟 URL 인용률 카드), dim_prompt.unit_key', cur: 'rd.web_unit (열 전부)',
  rules: ['현행 적재기는 base · sibs · home_host · turls 로 웹사이트 인용의 자사 판정(loc_owned)을 합니다. 타겟 판정(tgt_hit)은 dim_prompt.targets 입니다.'] } });
tbl('web_report_prompt', { s: 'gold', name: 'web_report_prompt', fam: 'prompt', grain: '프롬프트의 보고 유닛 소속', cols: [['prompt_key', 'PF', '', 'dim_prompt'], ['report_fs', '', '소속 보고 유닛 file_seq (여럿이면 최소)']], d: {
  grain: '보고 유닛에 속한 웹 프롬프트 1개 = 1행. 행이 없으면 유닛 밖입니다.', pk: 'prompt_key', inputs: '데이터 분석팀 · app.website_report_unit · app.website_prompt · app.website_site',
  uses: 'Website 카드 경로 요청(요약 · 카드 브랜드 · 추이 · GEO · 엔진 배지 · 기간 없는 도메인 · 기간 비교)의 모수 게이트: 보고 유닛 소속 ∧ 제외 유닛 아님. 레거시 프로필 web_registered_only(WEBREG16)이고 동결 읽기가 아닐 때', cur: 'rd.web_report_prompt (열 전부)',
  rules: ['report_fs 는 website_prompt.file_seq 입니다. 현행 DDL 에 FK 가 없고, web_unit 의 유일 키는 (project_key, file_seq) 라 report_fs 혼자로는 가리키지 못합니다.'] } });
tbl('web_target_url', { s: 'gold', name: 'web_target_url', fam: 'prompt', grain: '프로젝트 × 언어 × 타겟 URL', cols: [['project_key', 'PF', '', 'dim_project'], ['lang_key', 'PF', '', 'dim_lang'], ['url_key', 'PF', '', 'dim_url']], d: {
  grain: '웹 프로젝트 × 언어 × 타겟 URL = 1행. 타겟 정규형을 dim_url 키로 미리 풀어 둡니다.', pk: 'project_key + lang_key + url_key', inputs: '데이터 분석팀',
  uses: 'Website ⑥ AI 타겟 출처 인용률(카드 · 추이)의 화면 모드(기간 카드 · 비카드) 타겟 URL 집합. 레거시 프로필 web_accuracy_flat 일 때', cur: 'rd.web_target_url (열 전부)' } });
tbl('website_report_excluded', { s: 'app', name: 'website_report_excluded', fam: 'prompt', grain: '제외 보고 유닛', cols: [['file_seq', 'PK', 'file_seq > 0'], ['note', '', '']], d: {
  grain: 'Website 모수에서 뺄 보고 유닛 1개 = 1행. GEO HUB 설정입니다.', pk: 'file_seq', inputs: '이관 채우기 (back/migration/fill-v216.sql, 운영 website_excluded_fs). BE 쓰기 경로 없음',
  uses: 'Website 카드 경로 모수 게이트에서 뺄 file_seq (조회 시점 적용, 동결 읽기 포함). 레거시 프로필 web_registered_only 일 때', cur: 'app.website_report_excluded (열 전부)' } });
