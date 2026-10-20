/* ── KPI · 언급 셀 ── */
tbl('dim_perspective', { s: 'gold', name: 'dim_perspective', fam: 'kpi', grain: '당사 브랜드 조합 1개', cols: [['perspective_key', 'PK', 'int2'], ['own_bits', '', '1 현대 · 2 기아 · 4 제네시스 합'], ['label', '', '단일 = brand_code · 복수 = 엄브렐러']], d: {
  grain: '당사 브랜드 비트 조합 1개 = 1행. 실제 쓰는 조합만 둡니다 (최대 7개).', pk: 'perspective_key', inputs: '데이터 분석팀 (출처 제안: own_bits 1~7 고정 코드표)', uses: 'KPI · 언급 · 인용 화면의 브랜드 관점(Global · Website = 계정 브랜드 범위 ∩ 브랜드 필터, Project = 프로젝트 브랜드, 없으면 3사)으로 kpi_cell · kpi_rollup · citation_cell 행을 고르는 축',
  rules: ['조회는 관점 1개를 명시해 중복 합산을 막습니다.', '복수 관점의 노출 · 순위는 브랜드 행 합이 아니라 답변 단위 판정입니다 (노출 = 어느 한 브랜드 언급, 순위 = 0 을 뺀 최솟값). 그래서 조합마다 행을 둡니다.'] } });
tbl('kpi_cell', { s: 'gold', name: 'kpi_cell', fam: 'kpi', grain: '셀(C) × 관점 · 가속', cols: [
  ['C', 'PF', '셀 키 12열', 'cell_key'], ['perspective_key', 'PF', '', 'dim_perspective'], ['answers · tracked', '', '노출률'], ['own_mentions · total_mentions', '', '점유율'], ['sent_pos · sent_neg · sent_all', '', '우호도'],
  ['st_pos · st_neu · st_mix · st_neg', '', '스탠스 4종 · 화면 꺼짐'], ['rank_sum · ranked', '', '우선 노출도 (경쟁 순위)'], ['top1 · top3', '', '대표 순위 1 · 3 이하 답변'], ['fp_sum · fp_n', '', '텍스트 첫 등장 순서'], ['multi_answers · multi_mentions', '', '당사 언급 2회 이상'],
  ['t_mention … t_final_choice', '', '유형 신호 당사 답변 수', '', ['t_mention', 't_recommendation', 't_comparison', 't_definition', 't_final_choice']],
  ['gap_answers · gap_base', '', '분석 누락 · 인용 모수 답변'], ['cit_total · cit_total_all', '', '⑤ 분모 · 호스트 없는 인용 포함'], ['cit_m05 · cit_target', '', '⑤ 분자 · 타겟 인용'], ['cit_owned · cit_owned_c', '', '자사 인용 · 국가 좁힘판'],
  ['has_measured · has_mention · has_multi', '', '고유 프롬프트 수용'] ], d: {
  grain: '셀(C) × 관점 1개 = 1행. 언급·인용이 0 이어도 분모 셀은 남깁니다.', pk: 'C(12) + perspective_key', inputs: '데이터 분석팀 (출처 제안: 같은 build 의 answer_fact · answer_stance_fact 합)', triggers: '사실 build 와 같은 빌드',
  uses: 'Overview · Dashboard · Answer analysis 의 KPI 카드 · 엔진 · 비교 · 국가 · 추이, 언급 표 당사 행, 인용 프롬프트',
  rules: [ACCEL, 'M05 인용 점유율 분자 = cit_m05: global 은 Σcit_off (카테고리 Official (HMG)), website · project 는 표면 자사 (cit_owned 와 같은 값). global 에서 cit_owned 로 대신하지 않습니다.',
    '글로벌 자사 인용: 허용 배열을 국가로 좁히지 않으면 cit_owned, 국가 1개로 좁히면 cit_owned_c. 국가 2개 이상 · 언어로 좁힘은 citation_cell 의 owner_key = ANY(허용 배열) 합, 출처 카테고리 축이면 인용 열 전부를 citation_cell 에서 셉니다.',
    '⑤ 분모: 호스트 있는 인용만 세면 cit_total, 호스트 없는 인용까지 세면 cit_total_all 입니다. 인용 화면 프롬프트 목록은 늘 cit_total 입니다.',
    '우선 노출도: 카드 · 국가별 GEO 현황 모두 경쟁 순위(rank_sum ÷ ranked)입니다. fp_sum · fp_n 은 답변 텍스트상 첫 등장 순서로 매기는 우선 노출도용 열입니다.',
    '셀로 내지 않는 값은 사실을 읽습니다: 멘션 유형 표의 비교 측 답변 수 · 유형별 행 수 · 유형 × 감성 매트릭스 (answer_brand_fact), 추이 측정 일수 (job_index).'] } });
tbl('kpi_rollup', { s: 'gold', name: 'kpi_rollup', fam: 'kpi', grain: '상위 합계 D × 관점 · 가속', cols: [['D', 'PF', 'C − prompt_key', 'cell_key'], ['perspective_key', 'PF', '', 'dim_perspective'], ['(가산 열)', '', 'kpi_cell 합 열 (has_* 제외)']], d: {
  grain: 'D(= C − prompt_key) × 관점 1개 = 1행.', pk: 'D + perspective_key', inputs: '데이터 분석팀 (출처 제안: 같은 build 의 kpi_cell 합)', triggers: '사실 build 와 같은 빌드',
  uses: '프롬프트 단위 조건이 없는 KPI 카드 · 엔진 · 국가 · 추이 합계',
  rules: [ACCEL, '프롬프트 단위 조건(택소노미 · 커스텀 필드, 삭제 행 포함 카탈로그, 보고 유닛 소속)이 걸리면 kpi_cell 을 읽습니다.', '고유 프롬프트 수(측정 · 언급 · 복수 언급 프롬프트)는 더할 수 없어 kpi_cell 에서 셉니다.'] } });
tbl('brand_cell', { s: 'gold', name: 'brand_cell', fam: 'kpi', grain: '셀(C) × 브랜드 × 경쟁 · 가속', cols: [
  ['C', 'PF', '셀 키 12열', 'cell_key'], ['brand_key', 'PF', '', 'dim_brand'], ['competitive', 'PK', '경쟁 행 여부'], ['mention_count', '', '언급 수'], ['answers_present · rid_n_sum', '', '노출 답변: 행 수 · Σrid_n'], ['rank_sum · ranked', '', '경쟁 순위 (rk > 0)'], ['fp_sum · fp_n', '', '텍스트 첫 등장 순서'],
  ['s_pos · s_neu · s_neg · s_mix', '', '감성 4종'], ['t_mention … t_final_choice', '', '유형 5종 언급 수', '', ['t_mention', 't_recommendation', 't_comparison', 't_definition', 't_final_choice']], ['multi_answers · multi_mentions', '', 'mention_count 2 이상'], ['has_brand · has_multi', '', '고유 프롬프트 수용'] ], d: {
  grain: '셀(C) × 표시 브랜드 × 경쟁 여부 = 1행.', pk: 'C(12) + brand_key + competitive', inputs: '데이터 분석팀 (출처 제안: 같은 build 의 answer_brand_fact 합)', triggers: '사실 build 와 같은 빌드',
  uses: '언급 표 경쟁 행 · 당사 감성 · 유형, 국가별 GEO 현황 · 시장별 경쟁 위치 · 시장별 스냅샷 경쟁사, 추이 브랜드 계열',
  rules: [ACCEL, '당사 행: 노출 · 언급 · 순위 · 복수 언급은 kpi_cell 관점 행, 감성 4종 · 유형 5종은 관점 비트 당사 브랜드 행의 합입니다.',
    '노출 답변 수: 행 수로 세면 answers_present, (답변, 롤업 id) 단위로 세면 Σrid_n(rid_n_sum) 입니다.', '형제 HMG 브랜드는 경쟁 행에 남습니다. 국가별 GEO 현황 · 시장별 경쟁 위치 · 시장별 스냅샷의 경쟁사는 HMG 브랜드를 뺍니다 (own_bit = 0).'] } });
tbl('entity_mention_total', { s: 'gold', name: 'entity_mention_total', fam: 'kpi', grain: '엔티티 전 기간 합계', cols: [['entity_id', 'PF', 'uuid · dim_entity.entity_id (UK)', 'dim_entity'], ['answers', '', '언급 답변 수 (고유 job)'], ['mentions', '', 'Σmention_count'], ['updated_at', '', '마지막 반영 시각']], d: {
  grain: '엔티티 1개의 전 기간 합계 = 1행. Brand · 표시명 있는 언급만, 드롭 답변 제외, 기간·게이트 없음. 합계 0 이면 행이 없습니다.', pk: 'entity_id', inputs: '데이터 분석팀', triggers: '적재 마무리마다 차분 반영',
  uses: 'Admin › Global config › Entity catalog 엔티티 표의 답변 · 언급 수와 답변 수 정렬' } });
