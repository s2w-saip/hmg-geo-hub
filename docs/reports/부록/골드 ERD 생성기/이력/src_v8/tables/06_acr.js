/* ── ACR ── */
tbl('acr_cell_fact', { s: 'gold', name: 'acr_cell_fact', fam: 'acr', grain: '빌드 × ACR 셀', cols: [
  ['build_id', 'PF', '빌드 (신규)', 'build'], ['acr_cell_key', 'PK', 'ACR 셀 = Scope prompt-run'], ['C 좌표', 'FK', 'surface·cyc·prompt·project·engine·geo·lang·bgrp', 'cell_key', ['surface', 'cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']], ['round_date · measured_date', '', '회차일 · 측정일(KST)'], ['cat_mask', '', ''], ['planned · valid_turn1 · valid_acr', '', '반복 수: 계획 · 1턴 유효 · ACR 유효'],
  ['co_single · co_conditional · co_generic', '', '결과 유형별 수'], ['co_off_shortlist · co_unresolved · co_none', '', ''], ['is_rep · acr_in', '', '회차 대표 셀 · ACR 모수 게이트'], ['rule_ver', '', '적재 규칙 버전 (app.rule_set)'] ], d: {
  grain: '빌드 × ACR 셀(Scope prompt-run 1개 = 프롬프트 × 엔진 × 지역의 반복 측정 묶음) = 1행.', pk: 'build_id + acr_cell_key', inputs: '데이터 분석팀 · app.prompt (루트 카탈로그) · app.hidden_market (global acr_in)', triggers: 'Scope run 적재, 재판정(judgment_change)',
  uses: 'Global ACR 의 셀 선택 · 분모: Top1 · Top5 ACR 카드, 답변 수 카드, 측정 프롬프트 · 셀 · 반복 수 주석, 선택률 추이 분모 → /v1/funnel/acr. 검수 상세 ACR 롤업 블록 → /v1/qa/answers/{job_id}. Website · Project ACR (신규 공급, 현행 정적 표본)', cur: 'rd.acr_cell (열 전부 + build_id)',
  rules: ['현행 Top1 ACR = 브랜드 Σchoice ÷ 셀 Σvalid_acr · Top5(후보군 포함율) = 등장 셀 수 ÷ 셀 수'] } });
tbl('acr_entity_fact', { s: 'gold', name: 'acr_entity_fact', fam: 'acr', grain: '빌드 × ACR 셀 × 레벨 × 엔티티', cols: [
  ['build_id · acr_cell_key', 'PF', '', 'acr_cell_fact'], ['level', 'PK', '1 브랜드 · 2 차종 · 3 회사'], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key · parent_brand_key', 'FK', '레벨1 표시 브랜드 · 차종 소속 (그 밖 0)', 'dim_brand'], ['own_bit · name_own', '', '당사 비트: 명부 · 표시 이름'],
  ['appearance · choice · cond_choice', '', ''], ['off_shortlist · unresolved · generic', '', ''], ['keep', '', 'false = 비경쟁 이름 (표시 제외)'] ], d: {
  grain: '빌드 × ACR 셀 × 레벨 × 엔티티 = 1행.', pk: 'build_id + acr_cell_key + level + entity_key', inputs: '데이터 분석팀 · app.brand · app 엔티티 카탈로그(ecat) · app.non_competitor_name (keep)',
  uses: 'Global ACR 브랜드별 ACR 표, Top1 · Top5 ACR · 1순위 횟수 카드, 선택률 추이 분자, 모델별 선택 구도 표, 차종별 선택 전환율 표, 모델별 점유 맵 → /v1/funnel/acr. 검수 상세 ACR 롤업 블록. Website · Project ACR (신규 공급, 현행 정적 표본)', cur: 'rd.acr_choice (열 전부 + build_id, 레벨 파티션)',
  rules: ['배틀 승자는 필터를 건 셀을 (프롬프트, 엔진)으로 합산한 뒤 고릅니다 (현행). 골드는 국가별 승자만 저장하지 않습니다.', '현행 차종 전환율 = 표시 이름 × 소속 브랜드로 묶은 Σchoice ÷ 차종 행이 붙은 셀의 valid_acr 합. 같은 이름 엔티티 둘이 한 셀에 있으면 분모가 두 번 더해질 수 있으나 실데이터 발생 여부는 미확인입니다 (stg 조사 대기).', 'appearance 는 언급 기반이라 반복 수보다 클 수 있습니다. 골드는 후보군 등장 반복 수를 acr_iter_shortlist 로 셉니다.'] } });
tbl('acr_iter_fact', { s: 'gold', name: 'acr_iter_fact', fam: 'acr', grain: '빌드 × ACR 셀 × 반복', cols: [
  ['build_id · acr_cell_key', 'PF', '', 'acr_cell_fact'], ['iter_no', 'PK', '= answer_fact.acr_iter_rank (최신 = 1)'], ['answer_key', 'FK', '반복 job', 'job_index'], ['result_type', '', '1 single · 2 conditional · 3 generic · 4 off_shortlist · 5 unresolved · 6 none'],
  ['winner_brand_key', 'FK', '0 = 선택 없음', 'dim_brand'], ['winner_entity_key', 'FK', '차종 · 없으면 0', 'dim_entity'], ['own_bit', '', ''] ], d: {
  grain: '빌드 × ACR 셀 × 반복 1회 = 1행.', pk: 'build_id + acr_cell_key + iter_no', inputs: '데이터 분석팀 (출처 제안: Scope ACR 반복 job 별 최종 선택. 현행 acr_summary 는 prompt-run 단위 합계뿐)', triggers: 'acr_cell_fact 와 같은 빌드',
  uses: '(신규 공급) 모델별 점유 맵의 반복 칸별 승자 · 최빈 브랜드. Website · Project ACR 은 현행 정적 표본(반복 1–10), Global ACR 은 현행 선택 분포로 그림', cur: '없음 (신규. 현행 Global ACR 점유 맵은 반복 순서가 없어 선택 횟수 분포로 그림)',
  rules: ['골드에서는 셀의 반복 행을 result_type 별로 센 값이 acr_cell_fact.co_* 와 같아야 합니다.', '골드에서는 반복 열 수 = acr_cell_fact.planned 입니다 (정적 표본 화면은 10 고정).'] } });
tbl('acr_iter_shortlist', { s: 'gold', name: 'acr_iter_shortlist', fam: 'acr', grain: '반복 × 레벨 × 후보 엔티티', cols: [
  ['build_id · acr_cell_key · iter_no', 'PF', '', 'acr_iter_fact'], ['level', 'PK', '1 브랜드 · 2 차종 · 3 회사'], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key · parent_brand_key', 'FK', '', 'dim_brand'], ['is_choice', '', '그 반복의 최종 선택'] ], d: {
  grain: '빌드 × ACR 셀 × 반복 × 레벨 × 후보 엔티티 = 1행.', pk: 'build_id + acr_cell_key + iter_no + level + entity_key', inputs: '데이터 분석팀 (출처 제안: Scope ACR 반복 job 별 후보군 · 최종 선택. 현행 acr_summary 는 prompt-run 단위 합계뿐)',
  uses: '(신규 공급) 차종별 선택 전환율 표의 후보군 등장 · 1위 선택 · 전환율 = 최종 선택 ÷ 후보로 등장한 회차(반복) (화면 정의). 현행 Global 은 등장 셀 수 · 셀 valid_acr 합으로 계산, Website · Project 는 정적 표본', cur: '없음 (신규)' } });
tbl('acr_cell_job', { s: 'gold', name: 'acr_cell_job', fam: 'acr', grain: 'ACR 셀 × 소속 job', cols: [['build_id', 'PF', '빌드 (신규)', 'build'], ['answer_key', 'PF', '', 'job_index'], ['acr_cell_key', 'PF', '', 'acr_cell_fact']], d: {
  grain: '빌드 × ACR 셀 × 소속 job 1건 = 1행.', pk: 'build_id + answer_key + acr_cell_key', inputs: '데이터 분석팀 (Scope prompt-run source_job_ids)', uses: '검수 상세 ACR 롤업 블록: job → ACR 셀 (/v1/qa/answers/{job_id})', cur: 'rd.acr_cell_job (열 전부 + build_id)' } });
