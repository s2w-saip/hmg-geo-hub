/* ── 소셜 ── */
tbl('ctx_snapshot', { s: 'gold', name: 'ctx_snapshot', fam: 'soc', grain: '분석 스냅샷 1개', cols: [['snapshot_id', 'PK', 'int2'], ['industry_entity_id', '', '산업 엔티티'], ['source', '', ''], ['utterance_total', '', ''], ['taken_at', '', '기준일 (as_of)'], ['is_active', '', '산업당 활성 1개'],
  ['keyword', '', '지도 제목 키워드'], ['worker_total · source_total', '', '분석 표본 · 출처 수']], d: {
  grain: '구매 맥락 분석 스냅샷 1개 = 1행.', pk: 'snapshot_id', inputs: '데이터 분석팀 (출처 제안: 소셜 코퍼스 · 리서치 실행 결과)', triggers: '스냅샷 전체 적재 후 활성 전환 (제안)',
  uses: 'Project > Intent > Social Scraping 활성 스냅샷 · 기준일, Global > Customer interest > Social Scraping 지도 제목 · 그래프 통계, Admin > Global config > Customer interest config 지도 제목',
  rules: ['Project > Intent > Social Scraping 은 활성(is_active) 스냅샷을 읽습니다. 활성 스냅샷은 산업(industry_entity_id)당 1개입니다. 리서치 결과 지도는 ctx_research_run.snapshot_id 의 스냅샷입니다.', '그래프의 클러스터 표시는 ctx_entity.mention_count / worker_total, 비율은 mention_count ÷ worker_total 이고 조회 때 계산합니다.'] } });
tbl('ctx_entity', { s: 'gold', name: 'ctx_entity', fam: 'soc', grain: '스냅샷 × 맥락·조건', cols: [['snapshot_id', 'PF', '', 'ctx_snapshot'], ['id', 'PK', 'uuid'], ['type', '', 'ConsumerContext · ConsumerRequirement'], ['canonical_name', '', ''], ['dimension', '', '맥락 테마 코드 (맥락만)'], ['mention_count · utterance_count', '', ''], ['sentiment_{positive,negative,neutral}', '', '표의 감성 분포'], ['group_id', 'FK', '테마 · 카테고리', 'ctx_group'], ['unique_source_count', '', '고유 출처 수'], ['perspective_{buyer,seller,neutral}', '', '구매자 · 판매자 · 중립 관점'], ['related_ids[]', '', '연관 조건 id · 조건만']], d: {
  grain: '스냅샷 × 구매 맥락 또는 구매 조건 1개 = 1행.', pk: 'snapshot_id + id', inputs: '데이터 분석팀', triggers: '스냅샷 적재 때 함께 (제안)',
  uses: 'Project > Intent > Social Scraping 맥락 · 조건 수 · 표 · 상세 · 내보내기 · 프롬프트 시드, Global · Admin 표 · 상세, Global 그래프 노드 · 연관 조건',
  rules: ['표의 감성(긍정 · 부정 · 중립)은 sentiment_*, 그래프의 관점(구매자 · 판매자 · 중립)은 perspective_* 입니다.', '연관 조건은 조합에서 나오지 않는 별도 목록입니다.'] } });
tbl('ctx_drive', { s: 'gold', name: 'ctx_drive', fam: 'soc', grain: '맥락 → 조건 연결', cols: [['snapshot_id', 'PK', ''], ['context_id', 'PF', '', 'ctx_entity'], ['requirement_id', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현'], ['strength_score', '', '그래프 유발 강도']], d: {
  grain: '스냅샷 × 맥락 × 조건 = 1행.', pk: 'snapshot_id + context_id + requirement_id', inputs: '데이터 분석팀', triggers: '스냅샷 적재 때 함께 (제안)',
  uses: 'Project > Intent > Social Scraping 관계 수 · 연결 수 · 상세 연결 항목 · 프롬프트 시드, Global 그래프 유발 링크' } });
tbl('ctx_combination', { s: 'gold', name: 'ctx_combination', fam: 'soc', grain: '조건 조합 (2개 이상)', cols: [['snapshot_id', 'PK', ''], ['combo_id', 'PK', '조건 id 를 : 로 이음'], ['cond_a · cond_b', 'FK', '첫째 · 둘째 조건', 'ctx_entity'], ['cond_more[]', '', '셋째 이후 조건 id'], ['co_count', '', '동시 출현'], ['description', '', '조합 시나리오'], ['total_speakers · unique_source_count', '', '중첩률 분모 · 고유 출처 수']], d: {
  grain: '스냅샷 × 조건 조합 1개 (쌍 또는 3개 이상) = 1행.', pk: 'snapshot_id + combo_id. 쌍 행(cond_more 없음)은 snapshot_id + cond_a + cond_b 로도 유일', inputs: '데이터 분석팀', triggers: '스냅샷 적재 때 함께 (제안)',
  uses: 'Project > Intent > Social Scraping 관계 수 · 조합 패턴 표 · 내보내기 · 프롬프트 시드, Global · Admin 조합 표, Global 그래프 조합 목록 · 상세',
  rules: ['조합 1개 = 1행입니다. 첫째 · 둘째 조건은 cond_a · cond_b, 셋째부터는 cond_more 에 둡니다. combo_id 는 구성 조건 id 를 : 로 이은 값입니다. 쌍 기준인 Project 표 · 내보내기 · 프롬프트 시드는 cond_more 가 빈 행만 읽습니다.', '그래프 중첩률 = co_count ÷ total_speakers, 근거 문구 = "{total_speakers}명 중 {co_count}명 ({반올림 %})" 이고, 저장하지 않고 조회 때 만듭니다.'] } });
tbl('ctx_domain', { s: 'gold', name: 'ctx_domain', fam: 'soc', grain: '엔티티 × 출처 host', cols: [['snapshot_id', 'PK', ''], ['entity_id', 'PF', '', 'ctx_entity'], ['host', 'PK', ''], ['n', '', '']], d: {
  grain: '스냅샷 × 엔티티 × 출처 host = 1행.', pk: 'snapshot_id + entity_id + host', inputs: '데이터 분석팀', triggers: '스냅샷 적재 때 함께 (제안)',
  uses: 'Project > Intent > Social Scraping 출처 도메인 수 · 상세 소스 도메인, Global · Admin 상세 소스 도메인, Global 그래프 도메인별 출처' } });
tbl('ctx_evidence', { s: 'gold', name: 'ctx_evidence', fam: 'soc', grain: '근거 발화 1개', cols: [['snapshot_id', 'PK', ''], ['id', 'PK', 'uuid'], ['entity_id', 'FK', '', 'ctx_entity'], ['utterance_id', '', ''], ['quote', '', '근거 인용'], ['source_host · source_url', '', ''], ['sentiment', '', ''], ['source_title · rank', '', '출처 제목 · 표시 순서'], ['perspective', '', 'buyer · seller · neutral 관점']], d: {
  grain: '스냅샷 × 근거 발화 1개 = 1행.', pk: 'snapshot_id + id', inputs: '데이터 분석팀', triggers: '스냅샷 적재 때 함께 (제안)',
  uses: 'Project > Intent > Social Scraping 상세 근거 인용, Global · Admin 상세 근거 인용, Global 그래프 근거 인용',
  rules: ['엔티티 상세의 근거 인용은 rank 순으로 읽고, 출처 제목 자리에는 source_title 을 씁니다.'] } });
