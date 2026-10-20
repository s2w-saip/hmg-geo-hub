/* ── 빌드 · 릴리스 ── */
tbl('gold_facts', { s: 'key', name: '골드 사실·셀 전체', fam: 'build', grain: 'build_id 를 가진 테이블', cols: [
  ['build_id', 'FK', '모든 사실·셀 공통', 'build'], ['answer_fact', '', ''], ['answer_brand_fact · answer_stance_fact', '', ''], ['citation_fact · catalog_entry', '', ''], ['acr_cell_fact · acr_entity_fact · acr_cell_job', '', ''],
  ['kpi_cell · kpi_rollup · brand_cell', '', 'C 키의 build_id'], ['citation_cell · url_prompt_cell · report_value', '', ''], ['page_visibility_daily · page_crawl_daily', '', ''], ['page_seo_device_daily · page_priority', '', ''], ['acr_iter_fact · acr_iter_shortlist', '', ''], ['GA4 · 키워드 · 소셜', '', 'build 없음: 날짜 · call_id · snapshot_id'] ], d: {
  grain: 'build_id 로 세대를 나누는 골드 테이블 목록입니다(셀 집계는 C 키의 build_id). GA4 는 날짜, 키워드는 call_id · observed_at, 소셜은 snapshot_id 로 나누고 build_id 가 없습니다.', pk: '—', inputs: '—',
  uses: 'API 요청 시작에 release 하나를 고정하고, 그 release 가 가리키는 build 의 행만 읽습니다. 카드 경로는 publication.build_id 를 읽습니다.', cur: '현행 rd 사실 표는 제자리 갱신(load_id = 마지막 적재), 카드는 frz 셀 · 보관 행' } });
tbl('build', { s: 'gold', name: 'build', fam: 'build', grain: '빌드 1회', cols: [
  ['build_id', 'PK', ''], ['family', '', 'fact · cell · report · acr · vis'], ['slice_key', '', '회차 · 발행 · 사이트×일'], ['input_snapshot · watermark', '', '입력 고정'], ['profile_signature · metric_version', '', '규칙 서명'],
  ['ecat_ver · rule_ver', '', '판정 버전'], ['status', '', 'pending · running · validated · failed'], ['row_counts · verify', '', 'jsonb'], ['error · attempt', '', ''], ['started_at · finished_at', '', ''] ], d: {
  grain: '패밀리 × 슬라이스 × 입력·규칙 버전의 빌드 1회 = 1행.', pk: 'build_id (유일: family + slice_key + 입력·규칙 버전)', inputs: '데이터 분석팀 (빌드 실행 기록)',
  triggers: '회차 마감, 재판정(judgment_change), ACR 수집 완료, 발행(report_publication), 일 배치(vis)', uses: 'release_item · publication 이 가리킴, judgment_change.applied_build_id, 실패 재시도', cur: '없음 (신규. 현행 ing.load 적재 이력 역할)',
  rules: ['골드에서는 재시도가 같은 build 출력을 교체·재개합니다. row_counts 를 누적하지 않습니다.', '골드에서는 실패한 build 를 release 에 넣지 않고 status · error 만 남깁니다.'] } });
tbl('data_version', { s: 'gold', name: 'data_version', fam: 'build', grain: 'release 밖 데이터의 버전', cols: [['scope', 'PK', 'dim · cycle · job · raw … (신규)'], ['version', '', 'bigint, 쓸 때마다 +1'], ['updated_at', '', '']], d: {
  grain: '버전 범위 1개 = 1행.', pk: 'scope', inputs: '데이터 분석팀 (release 밖 gold 쓰기)', triggers: 'release 를 거치지 않는 gold 테이블을 쓴 트랜잭션 안에서 함께 증가',
  uses: '골드에서는 BE 결과 캐시 키 = active_release.version + data_version. 현행 app.result_cache_version() 의 rd 19표 · frz.generation 카운터를 대체(app 13표 카운터 · jc · d 는 유지)', cur: 'rcache.data_version (표별 tbl → 범위 scope). tg_bump 트리거 33표: app 13 · frz 1 · rd 19',
  rules: ['골드에서는 차원 · 회차 · job · 답변 원문 · GA4 · 키워드 · 소셜처럼 build 로 나누지 않는 테이블을 쓸 때 해당 scope 의 version 을 반드시 올립니다.', '올리지 않으면 BE 캐시가 낡은 값을 계속 냅니다.'] } });
tbl('release', { s: 'gold', name: 'release', fam: 'build', grain: '공개 manifest 1개', cols: [['release_id', 'PK', ''], ['read_mode', '', 'live · card · grid'], ['rule_signature', '', '활성 프로필 서명'], ['base_release_id', 'FK', '이전 release', 'release'], ['validated_at', '', '']], d: {
  grain: '불변 공개 manifest 1개 = 1행.', pk: 'release_id', inputs: '데이터 분석팀 (validated build 묶음)', uses: '한 응답 안의 숫자를 같은 세대로 고정', cur: '없음 (신규)' } });
tbl('release_item', { s: 'gold', name: 'release_item', fam: 'build', grain: 'release × 패밀리 × 슬라이스', cols: [['release_id', 'PF', '', 'release'], ['family', 'PK', ''], ['slice_key', 'PK', ''], ['build_id', 'FK', '', 'build'], ['state', '', 'ready · empty']], d: {
  grain: 'release × 패밀리 × 슬라이스 = 1행. 어느 회차·날짜에 어느 build 를 쓸지 정합니다.', pk: 'release_id + family + slice_key', inputs: '데이터 분석팀 (validated build)', uses: 'BE 조회의 build_id 결정 (card · grid 는 활성 publication.build_id)', cur: '없음 (신규)',
  rules: ['골드에서는 빈 슬라이스도 empty 로 매핑해 삭제를 표현합니다.'] } });
tbl('active_release', { s: 'gold', name: 'active_release', fam: 'build', grain: '공개 포인터', cols: [['read_mode', 'PK', '읽기 모드 (신규)'], ['rule_signature', 'PK', '규칙 서명 (신규)'], ['scope', 'PK', '공개 범위 (현행 surface)'], ['release_id', 'FK', '현재 release (신규)', 'release'], ['version', '', '데이터 버전 (현행 generation)'], ['last_build_id', 'FK', '현행 last_load_id', 'build'], ['rule_ver · as_of · updated_at', '', '']], d: {
  grain: '읽기 모드 × 규칙 서명 × 공개 범위의 현재 release = 1행.', pk: 'read_mode + rule_signature + scope', inputs: '데이터 분석팀 (검증 통과 release)',
  triggers: '골드에서는 검증 통과 뒤 짧은 트랜잭션으로 포인터 전환 (설계. 승인 없는 회차별 자동 생성은 20261015 논의 · A04 진행 중)', uses: 'BE 읽기 전용. 현행 generation 은 응답 meta.generation · 커서 stale 판정 · 결과 캐시 버전(g)', cur: 'rd.surface_generation (surface → scope, generation → version, last_load_id → last_build_id)',
  rules: ['골드에서는 기대한 이전 release 와 입력 버전을 확인한 뒤 전환해, 오래된 build 가 새 입력을 덮지 못하게 합니다.'] } });
