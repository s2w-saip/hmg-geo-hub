/* ── ACR ── */
tbl('acr_cell_fact', { s: 'gold', name: 'acr_cell_fact', fam: 'acr', grain: '빌드 × ACR 셀', cols: [
  ['build_id', 'PF', '빌드', 'build'], ['acr_cell_key', 'PK', 'ACR 셀 = Scope prompt-run'], ['C 좌표', 'FK', 'surface·cyc·prompt·project·engine·geo·lang·bgrp', 'cell_key', ['surface', 'cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']], ['round_date · measured_date', '', '회차일 · 측정일(KST)'], ['cat_mask', '', ''], ['planned · valid_turn1 · valid_acr', '', '반복 수: 계획 · 1턴 유효 · ACR 유효'],
  ['co_single · co_conditional · co_generic', '', '결과 유형별 수'], ['co_off_shortlist · co_unresolved · co_none', '', ''], ['is_rep · acr_in', '', '회차 대표 셀 · ACR 모수 게이트'], ['rule_ver', '', '적재 규칙 버전'] ], d: {
  grain: '빌드 × ACR 셀(Scope prompt-run 1개 = 프롬프트 × 엔진 × 지역의 반복 측정 묶음) = 1행.', pk: 'build_id + acr_cell_key', inputs: '데이터 분석팀 · dim_prompt (루트 카탈로그) · dim_country (global 숨김 시장)', triggers: 'Scope run 적재, 판정 입력 변경 시 재판정',
  uses: 'Global ACR 의 셀 선택 · 분모: Top1 · Top5 ACR 카드, 답변 수 카드, 측정 프롬프트 · 셀 · 반복 수 주석, 선택률 추이 분모. 검수 상세 ACR 롤업 블록. Website · Project ACR',
  rules: ['Top1 ACR = 브랜드 Σchoice ÷ 셀 Σvalid_acr · Top5(후보군 포함율) = 등장 셀 수 ÷ 셀 수'] } });
tbl('acr_entity_fact', { s: 'gold', name: 'acr_entity_fact', fam: 'acr', grain: '빌드 × ACR 셀 × 레벨 × 엔티티', cols: [
  ['build_id · acr_cell_key', 'PF', '', 'acr_cell_fact'], ['level', 'PK', '1 브랜드 · 2 차종 · 3 회사'], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key · parent_brand_key', 'FK', '레벨1 표시 브랜드 · 차종 소속 (그 밖 0)', 'dim_brand'], ['own_bit · name_own', '', '당사 비트: 명부 · 표시 이름'],
  ['appearance · choice · cond_choice', '', ''], ['off_shortlist · unresolved · generic', '', ''], ['keep', '', 'false = 비경쟁 이름 (표시 제외)'] ], d: {
  grain: '빌드 × ACR 셀 × 레벨 × 엔티티 = 1행.', pk: 'build_id + acr_cell_key + level + entity_key', inputs: '데이터 분석팀 · dim_entity · dim_brand',
  uses: 'Global ACR 브랜드별 ACR 표, Top1 · Top5 ACR · 1순위 횟수 카드, 선택률 추이 분자, 모델별 선택 구도 표, 차종별 선택 전환율 표, 모델별 점유 맵. 검수 상세 ACR 롤업 블록. Website · Project ACR',
  rules: ['모델별 선택 구도 표의 칸 승자(선택 수 최다 브랜드)는 저장하지 않습니다. 필터를 건 셀을 (프롬프트, 엔진)으로 합산한 뒤 조회 때 고릅니다.', 'appearance 는 언급 기반이라 반복 수보다 클 수 있습니다. 후보군 등장 반복 수는 acr_iter_shortlist 로 셉니다.'] } });
tbl('acr_iter_fact', { s: 'gold', name: 'acr_iter_fact', fam: 'acr', grain: '빌드 × ACR 셀 × 반복', cols: [
  ['build_id · acr_cell_key', 'PF', '', 'acr_cell_fact'], ['iter_no', 'PK', '= answer_fact.acr_iter_rank (최신 = 1)'], ['answer_key', 'FK', '반복 job', 'job_index'], ['result_type', '', '1 single · 2 conditional · 3 generic · 4 off_shortlist · 5 unresolved · 6 none'],
  ['winner_brand_key', 'FK', '0 = 선택 없음', 'dim_brand'], ['winner_entity_key', 'FK', '차종 · 없으면 0', 'dim_entity'], ['own_bit', '', ''] ], d: {
  grain: '빌드 × ACR 셀 × 반복 1회 = 1행.', pk: 'build_id + acr_cell_key + iter_no', inputs: '데이터 분석팀 (출처 제안: Scope ACR 반복 job 별 최종 선택)', triggers: 'acr_cell_fact 와 같은 빌드',
  uses: 'Website · Project ACR 모델별 점유 맵의 반복 칸별 승자 · 최빈 브랜드',
  rules: ['셀의 반복 행을 result_type 별로 센 값이 acr_cell_fact.co_* 와 같아야 합니다.', '반복 열 수 = acr_cell_fact.planned 입니다.'] } });
tbl('acr_iter_shortlist', { s: 'gold', name: 'acr_iter_shortlist', fam: 'acr', grain: '반복 × 레벨 × 후보 엔티티', cols: [
  ['build_id · acr_cell_key · iter_no', 'PF', '', 'acr_iter_fact'], ['level', 'PK', '1 브랜드 · 2 차종 · 3 회사'], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key · parent_brand_key', 'FK', '', 'dim_brand'], ['is_choice', '', '그 반복의 최종 선택'] ], d: {
  grain: '빌드 × ACR 셀 × 반복 × 레벨 × 후보 엔티티 = 1행.', pk: 'build_id + acr_cell_key + iter_no + level + entity_key', inputs: '데이터 분석팀 (출처 제안: Scope ACR 반복 job 별 후보군 · 최종 선택)',
  uses: 'Website · Project ACR 차종별 선택 전환율 표의 후보군 등장 · 1위 선택 · 전환율 = 최종 선택 ÷ 후보로 등장한 회차(반복) (화면 정의)' } });
tbl('acr_cell_job', { s: 'gold', name: 'acr_cell_job', fam: 'acr', grain: 'ACR 셀 × 소속 job', cols: [['build_id', 'PF', '빌드', 'build'], ['answer_key', 'PF', '', 'job_index'], ['acr_cell_key', 'PF', '', 'acr_cell_fact']], d: {
  grain: '빌드 × ACR 셀 × 소속 job 1건 = 1행.', pk: 'build_id + answer_key + acr_cell_key', inputs: '데이터 분석팀 (출처: Scope prompt-run 의 source_job_ids)', uses: '검수 상세 ACR 롤업 블록: job → ACR 셀' } });
