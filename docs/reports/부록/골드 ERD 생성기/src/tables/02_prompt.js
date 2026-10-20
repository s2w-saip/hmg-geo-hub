/* ── 프롬프트 · 카탈로그 · 웹 유닛 ── */
tbl('dim_prompt', { s: 'gold', name: 'dim_prompt', fam: 'prompt', grain: '측정 프롬프트 1개', cols: [
  ['prompt_key', 'PK', 'int4'], ['prompt_id', 'UK', 'uuid'], ['surface · kind', '', '표면 · single · acr'], ['project_key', 'FK', '', 'dim_project'], ['text', '', '프롬프트 본문 (표시 · 검색)'], ['lang_key', 'FK', '', 'dim_lang'], ['funnel_key', 'FK', '', 'dim_taxon'],
  ['presence_key · list_type_key', 'FK', 'project 프롬프트 택소노미', 'dim_taxon'], ['depth1~4_key', 'FK', 'project 프롬프트 택소노미', 'dim_taxon'], ['in_project_catalog', '', '프로젝트 프롬프트 행 있음 (삭제 아님)'],
  ['cat_mask · cat_mask_all', '', '루트 카탈로그 브랜드 비트 · 삭제 포함'], ['in_root_catalog · in_root_catalog_all', '', '루트 카탈로그 소속 · 삭제 포함'], ['unit_key', 'FK', '웹 유닛', 'web_unit'], ['targets[]', '', '웹 타겟 URL 정규형'], ['web_reg', '', '웹 카탈로그 등록'], ['regions[] · is_korean', '', 'Scope 시장 태그 · 한글 본문'], ['rule_ver', '', ''] ], d: {
  grain: '측정 프롬프트 1개 = 1행 (single · acr).', pk: 'prompt_key', inputs: '데이터 분석팀',
  uses: '프롬프트 본문 · 퍼널 표시(답변 목록·상세 · 인용 프롬프트 · 톤 · 도메인 상세 · ACR · 검수), KPI 적용 프롬프트 수(website = web_reg), Global › Global prompts · Website › Prompts · Admin › Global config › Global prompts 카탈로그, Project › Prompt 영향 수, 검수 목록 · 노트, Project › (프로젝트) › Dashboard · Analysis › Mention · Citation 필터 바의 택소노미 필터',
  rules: ['cat_mask_all · in_root_catalog_all 은 삭제 행 포함 카탈로그 기준입니다. Global 의 삭제 행 포함 모수(std_in_nc · cit_in_nc)에 카탈로그 게이트를 걸 때와 KPI 적용 프롬프트 수를 셀 때 씁니다.',
    'presence_key · list_type_key · depth1~4_key · in_project_catalog 는 project 프롬프트만 채웁니다(그 프로젝트의 삭제되지 않은 프롬프트 행 값, 없으면 NULL · 거짓). project 택소노미 필터(funnel · brand_presence · list_type · depth1~4)는 in_project_catalog ∧ 축 코드 일치로 겁니다. global 택소노미는 catalog_entry 로 겁니다.', '프로젝트 안에서 Scope 프롬프트 하나에 살아 있는 프롬프트 행은 하나여야 합니다. 여럿이면 택소노미 값을 하나로 정할 수 없습니다.', 'project 택소노미 필터 옵션은 dim_prompt(측정된 프롬프트)에 담긴 값입니다.'] } });
tbl('catalog_entry', { s: 'gold', name: 'catalog_entry', fam: 'prompt', grain: '빌드 × 루트 카탈로그 행 (비삭제)', cols: [
  ['catalog_row_id', 'PK', '카탈로그 행 uuid'], ['prompt_key', 'FK', '미발행 행 NULL', 'dim_prompt'], ['brand_bit', '', '행 브랜드 비트 (없음 = 엄브렐러)'], ['kind', '', 'single · acr'], ['presence_key', 'FK', '', 'dim_taxon'], ['funnel_key · list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon'], ['depth4_key', 'FK', '카탈로그 depth4', 'dim_taxon'], ['build_id', 'PF', '빌드(세대)', 'build'] ], d: {
  grain: '빌드 × 표준 루트 카탈로그 행(비삭제) 1개 = 1행. 한 프롬프트에 여러 행이 붙을 수 있습니다.', pk: 'build_id + catalog_row_id', inputs: '데이터 분석팀',
  uses: 'global 택소노미 · depth4 필터의 프롬프트 키 해석(답변 목록 · 언급 · 인용 · ACR · 국가별 GEO · KPI), KPI 적용 프롬프트 수, 필터 옵션 카탈로그 택소노미, 답변 상세 택소노미',
  rules: ['한 프롬프트에 여러 카탈로그 행이 붙으므로 프롬프트 수는 DISTINCT prompt_key 로 셉니다.', 'depth4 필터도 다른 택소노미 축처럼 관점 카탈로그 행(brand_bit)의 depth4_key 로 겁니다.'] } });
tbl('dim_taxon', { s: 'gold', name: 'dim_taxon', fam: 'prompt', grain: '택소노미 코드 1개', cols: [['taxon_key', 'PK', 'int2'], ['axis', '', 'funnel · presence · list_type · depth1~3 · depth4'], ['code', '', '(axis, code, parent_key) 유일'], ['parent_key', 'FK', '상위 코드', 'dim_taxon']], d: {
  grain: '택소노미 코드 1개 = 1행.', pk: 'taxon_key', inputs: '데이터 분석팀',
  uses: '택소노미 필터 해석 · 필터 옵션, 퍼널 코드 표시(KPI 퍼널별 측정 수 · 인용 프롬프트 · 언급 프롬프트 · 도메인 상세 · 검수 상세), 답변 상세 택소노미',
  rules: ['global 루트 카탈로그 행(catalog_entry)과 project 프롬프트(dim_prompt)의 택소노미 코드를 모두 담습니다.', 'depth2 · depth3 은 상위 코드(parent_key) 아래 코드라 같은 코드가 여러 키일 수 있습니다. 필터는 코드를 그 코드의 키 전부로 풉니다.'] } });
tbl('web_unit', { s: 'gold', name: 'web_unit', fam: 'prompt', grain: '웹사이트 유닛 (프로젝트 × file_seq)', cols: [
  ['unit_key', 'PK', 'int2'], ['project_key', 'FK', '', 'dim_project'], ['file_seq', 'UK', 'project_key 와 복합 유일'], ['lang_codes[]', '', '소문자 언어 코드'], ['base · base_src', '', '자사 base · decl · heur'], ['sibs[] · home_host', '', '하위 선언 base · base 호스트'], ['turls[]', '', '타겟 URL 정규형'], ['excluded', '', 'Website 모수에서 뺀 보고 유닛'], ['rule_ver', '', ''] ], d: {
  grain: '웹사이트 유닛(사이트 프로젝트 × file_seq) 1개 = 1행.', pk: 'unit_key (프로젝트 × file_seq 유일)', inputs: '데이터 분석팀',
  uses: 'Website 자사 · 타겟 URL 인용률 카드의 발행값 범위(허용 프로젝트 유닛의 file_seq 만 합산), Website › Overview 카드 모수의 제외 유닛(excluded)',
  rules: ['base · sibs · home_host · turls 로 웹사이트 인용의 자사 판정(loc_owned)을 합니다. 타겟 판정(tgt_hit)은 dim_prompt.targets 로 합니다.',
    'excluded 는 file_seq 단위 값입니다(같은 file_seq 의 유닛은 같은 값). 보고 유닛 file_seq 가 excluded 유닛의 file_seq 인 답변은 Website › Overview 카드 모수에서 뺍니다.'] } });
tbl('web_report_prompt', { s: 'gold', name: 'web_report_prompt', fam: 'prompt', grain: '프롬프트의 보고 유닛 소속', cols: [['prompt_key', 'PF', '', 'dim_prompt'], ['report_fs', '', '소속 보고 유닛 file_seq (여럿이면 최소)']], d: {
  grain: '보고 유닛에 속한 웹 프롬프트 1개 = 1행. 행이 없으면 유닛 밖입니다.', pk: 'prompt_key', inputs: '데이터 분석팀',
  uses: 'Website › Overview 의 KPI 카드(①~⑤) · 경쟁사 SOV 비교 · 증감 표시 · 기간 비교 칩 · 엔진 간 일관성 배지 · KPI 추이 · 시장별 GEO · 출처별 구성비(기간 없음) 모수 게이트: 보고 유닛 소속 ∧ 제외 유닛(web_unit.excluded) 아님',
  rules: ['report_fs 는 web_unit.file_seq 와 같은 값입니다. web_unit 은 (project_key, file_seq) 로 유일해 report_fs 혼자로는 FK 를 걸지 않습니다.',
    '발행 세대로 읽는 창은 이 테이블 대신 발행 시점 소속(pub_cell_web.report_fs)으로 거릅니다. 제외 유닛은 두 경우 모두 조회 때 web_unit.excluded 로 뺍니다.'] } });
tbl('web_target_url', { s: 'gold', name: 'web_target_url', fam: 'prompt', grain: '프로젝트 × 언어 × 타겟 URL', cols: [['project_key', 'PF', '', 'dim_project'], ['lang_key', 'PF', '', 'dim_lang'], ['url_key', 'PF', '', 'dim_url']], d: {
  grain: '웹 프로젝트 × 언어 × 타겟 URL = 1행. 타겟 정규형을 dim_url 키로 미리 풀어 둡니다.', pk: 'project_key + lang_key + url_key', inputs: '데이터 분석팀',
  uses: 'Website › Overview AI 타겟 출처 인용률(⑥) 카드 · KPI 추이 ⑥ 선의 타겟 URL 집합',
  rules: ['⑥ 은 발행 세대로 읽는 기간 없는 카드 · 카드 추이면 발행 시점 유닛 판정(pub_cell_web.unit_owned · unit_target)으로 세고, 기간을 고른 카드나 발행 세대로 읽지 않는 창이면 이 집합으로 셉니다. 타겟 = 인용 URL 중 하나라도 이 집합에 있는 답변입니다.'] } });
tbl('dim_custom_field', { s: 'gold', name: 'dim_custom_field', fam: 'prompt', grain: '프로젝트 커스텀 필드 1개', cols: [
  ['field_id', 'PK', 'uuid'], ['project_key', 'FK', '', 'dim_project'], ['label', '', '필드 이름 · 프로젝트 안 유일'], ['archived', '', '보관'], ['created_at', '', '필드 순서 (생성 순)'] ], d: {
  grain: '프로젝트 커스텀 필드(태그 열) 1개 = 1행.', pk: 'field_id', inputs: '데이터 분석팀 (출처 제안: GEO HUB 프로젝트 커스텀 필드 설정의 투영)', triggers: '커스텀 필드 설정이 바뀔 때',
  uses: 'Project › Dashboard · Analysis › Mention · Analysis › Citation 의 커스텀 태그 필터 (필드 이름 · 순서)',
  rules: ['보관(archived) 필드는 필터 옵션에서 뺍니다.', '필드 순서는 created_at, field_id 순입니다.'] } });
tbl('prompt_custom_value', { s: 'gold', name: 'prompt_custom_value', fam: 'prompt', grain: '프롬프트 × 커스텀 필드 값', cols: [
  ['prompt_key', 'PF', '', 'dim_prompt'], ['field_id', 'PF', '', 'dim_custom_field'], ['value', '', '태그 값'] ], d: {
  grain: '프로젝트 프롬프트 × 커스텀 필드 = 1행 (값 1개).', pk: 'prompt_key + field_id', inputs: '데이터 분석팀 (출처 제안: GEO HUB 프롬프트 태그 값의 투영)', triggers: '프롬프트 태그 값이 바뀔 때',
  uses: 'Project › Dashboard · Analysis › Mention · Analysis › Citation 의 커스텀 태그 필터 (값 옵션 · 거르기)',
  rules: ['필터는 한 필드 안 값은 OR, 필드끼리 AND 로 겁니다. 빈 값만 준 필드는 결과가 0 입니다.', '필터 옵션 값은 그 프로젝트에 살아 있는 프롬프트(dim_prompt.in_project_catalog)에 붙은 값입니다.'] } });
