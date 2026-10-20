/* ── 발행 세대 (카드 동결) ── */
tbl('publication', { s: 'gold', name: 'publication', fam: 'pub', grain: '회차 × 발행 세대', cols: [
  ['gen_key', 'PK', '세대 키 (identity)'], ['cyc_key', 'FK', '', 'dim_cycle'], ['surface', '', 'CHECK 1~3 · 발행은 1 · 2'], ['source', '', 'ops 이관 · hub 발행'], ['state', '', 'building · active · retired'], ['build_id', 'FK', '고정한 사실 build', 'build'],
  ['ops_{cycle_id,generation_id,generator_version}', '', 'ops 이관 세대 원값'], ['ops_started_at · ops_finished_at', '', ''], ['judgment', '', '판정 입력 버전 jsonb'], ['row_counts · verify', '', '행 수 · 단언 결과'], ['created_at · activated_at · retired_{at,reason}', '', ''] ], d: {
  grain: '회차 × 발행 세대 1개 = 1행. 회차당 active · building 은 각 1개입니다.', pk: 'gen_key', inputs: '데이터 분석팀 · dim_cycle · build',
  triggers: '회차 발행 직후 자동 생성(global · website) · ops 세대 이관 · 재생성',
  uses: 'Global › Overview · Website › Overview 의 KPI 카드 · 증감 · 추이 · 경쟁사 비교 · 기간 비교 칩 · 국가(시장)별 GEO · 출처 도메인(기간 미선택), Website › Overview 엔진 간 일관성 배지 · URL 인용률 카드, Global › Answer analysis › Mention 기간 비교 표시',
  rules: ['build_id 로 발행 시점 사실 build 를 고정합니다. 발행 뒤 재판정은 새 build 로만 들어갑니다.', '활성 발행이 가리키는 build 는 지우지 않습니다.', 'ops 이관 세대도 운영 원값 build 를 만들어 가리킵니다.', '고정 build 는 발행 당시 규칙 서명(profile_signature)으로 만든 것이어야 합니다.',
    '기간을 고르지 않은 카드는 노출된 회차 중 활성 발행 세대가 있는 가장 늦은 회차일을 읽습니다. 그런 회차가 없으면 최신 회차를 라이브 값으로 읽습니다.',
    '카드 조회 창에 발행 세대가 없는 회차(숨김 회차 제외)가 있거나 쓸 발행 회차(전체 숨김 아님)가 없으면 그 요청은 라이브 값으로 읽습니다. 기간 비교는 예외로, 발행 회차 값만 쓰고 빠진 회차는 누락 비중으로 셉니다.',
    '기간을 고르지 않은 Website 카드 창에 judgment.url_hits_covered 가 참이 아닌 ops 세대가 있으면 자사 · 타겟 URL 인용률 카드만 라이브 값으로 읽습니다.'] } });
tbl('pub_cell', { s: 'gold', name: 'pub_cell', fam: 'pub', grain: '발행 × 셀 대표 답변', cols: [['gen_key', 'PF', '', 'publication'], ['answer_key', 'PF', '셀 대표', 'answer_fact'], ['surface · cyc_key', '', ''], ['round_date', '', '발행 시점 회차 날짜 (좌석)'], ['prompt_key · engine_key · geo_key', '', '셀 좌표']], d: {
  grain: '발행 세대 × 셀 대표 답변 1건 = 1행.', pk: 'gen_key + answer_key', inputs: '데이터 분석팀 · job_index · dim_project',
  uses: 'publication 과 같은 카드 화면(Global › Overview · Website › Overview · Global › Answer analysis › Mention 기간 비교)의 회차 셀 집합',
  rules: ['셀 대표 = 회차 run 서빙 답변 중 셀(프롬프트 × 엔진 × 국가)당 1건, 미러 시각 > 앵커 핀 접기 > 원본 시각 최신순(NULL 먼저) · job_id. answer_fact.is_rep 와 다를 수 있습니다.', '웹 셀의 국가는 사이트 국가이고, 사이트 국가가 없으면 답변 국가입니다.'] } });
tbl('pub_cell_web', { s: 'gold', name: 'pub_cell_web', fam: 'pub', grain: '웹 셀 판정', cols: [['gen_key · answer_key', 'PF', '', 'pub_cell'], ['cyc_key', '', ''], ['report_fs', '', '보고 유닛 (NULL = 밖)'], ['unit_owned · unit_target', '', '⑥ 유닛 자사 · 타겟 인용'], ['url_registered · url_owned_hit · url_target_hit', '', 'URL 률 플래그 (ops 세대만)']], d: {
  grain: '웹 셀 1개의 발행 시점 판정 = 1행.', pk: 'gen_key + answer_key', inputs: '데이터 분석팀 · pub_cell · web_report_prompt · answer_fact · citation_fact · dim_url · dim_prompt',
  uses: 'Website › Overview 카드의 보고 유닛 모수(report_fs), AI 타겟 출처 인용률 카드(기간 미선택) · KPI 추이 차트 ⑥ 선(unit_*), 자사 · 타겟 URL 인용률 카드(기간 미선택, url_*)',
  rules: ['url_* 는 ops 이관 세대만 채웁니다. 비면 answer_fact 의 web_reg · tgt_cited · own_url_cited 를 씁니다.'] } });
tbl('pub_prompt', { s: 'gold', name: 'pub_prompt', fam: 'pub', grain: '발행 × 프롬프트', cols: [
  ['gen_key', 'PF', '', 'publication'], ['prompt_key', 'PF', '', 'dim_prompt'], ['cyc_key', '', ''], ['in_full_cycle · expected_cells · window_cells', '', '풀 사이클 판정 (웹 = 참)'], ['in_root_catalog · catalog_deleted · cat_mask', '', '동결 카탈로그 비트'],
  ['funnel_key · presence_key · list_type_key · depth1~3_key', '', '생성 시점 축 (필터는 pub_prompt_axis)'], ['regions · is_korean · report_fs', '', ''], ['src', '', '원값 jsonb (감사 · 대조)'] ], d: {
  grain: '발행 세대 × 셀 프롬프트 1개 = 1행.', pk: 'gen_key + prompt_key', inputs: '데이터 분석팀 · pub_cell · dim_prompt · catalog_entry · web_report_prompt',
  uses: 'Global › Overview · Website › Overview 카드와 Global › Answer analysis › Mention 기간 비교: Global 풀 사이클 게이트(in_full_cycle, 회차 추이 격자 제외) · 브랜드 그룹(cat_mask), 택소노미 필터 버림 판정의 관점 범위(cat_mask)' } });
tbl('pub_prompt_axis', { s: 'gold', name: 'pub_prompt_axis', fam: 'pub', grain: '발행 × 프롬프트 택소노미', cols: [['gen_key · prompt_key', 'PF', '', 'pub_prompt'], ['cyc_key', '', ''], ['funnel_key', 'FK', '', 'dim_taxon'], ['presence_keys[]', '', 'presence 키 집합'], ['list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon']], d: {
  grain: '발행 세대 × 프롬프트의 택소노미 축 = 1행.', pk: 'gen_key + prompt_key', inputs: '데이터 분석팀 · pub_prompt · dim_taxon',
  uses: 'Global › Overview · Website › Overview 카드와 Global › Answer analysis › Mention 기간 비교의 택소노미 필터 · 버림 판정',
  rules: ['hub 발행 세대의 축은 발행 시점 프롬프트 카탈로그에서 굽습니다. Global 은 표준 루트 카탈로그 행(삭제 포함), Website 는 삭제되지 않은 행을 봅니다. 퍼널 · 목록 유형 · depth 는 최근 수정 행의 값, presence_keys 는 행들의 presence 집합입니다.'] } });
tbl('pub_brand_name', { s: 'gold', name: 'pub_brand_name', fam: 'pub', grain: '발행 × 브랜드 표시명', cols: [['gen_key', 'PF', '', 'publication'], ['brand_key', 'PF', '', 'dim_brand'], ['name', '', '발행 시점 표시명']], d: {
  grain: '발행 세대 × 브랜드(셀 답변 브랜드 ∪ 당사) = 1행.', pk: 'gen_key + brand_key', inputs: '데이터 분석팀 · pub_cell · answer_brand_fact · dim_brand',
  uses: 'Global › Overview · Website › Overview 카드의 브랜드 표시명 (경쟁사 비교 · 국가(시장)별 GEO)',
  rules: ['창에 회차가 여럿이면 가장 늦은 회차 세대의 이름을 씁니다. 창 안에서 이름이 바뀐 브랜드는 이름별 행으로 나눕니다.'] } });
