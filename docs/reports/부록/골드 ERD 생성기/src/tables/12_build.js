/* ── 빌드 · 릴리스 ── */
tbl('gold_facts', { s: 'key', name: '골드 사실·셀 전체', fam: 'build', grain: 'build_id 를 가진 테이블', cols: [
  ['build_id', 'FK', '모든 사실·셀 공통', 'build'], ['answer_fact', '', ''], ['answer_brand_fact · answer_stance_fact', '', ''], ['citation_fact · catalog_entry', '', ''], ['acr_cell_fact · acr_entity_fact · acr_cell_job', '', ''],
  ['kpi_cell · kpi_rollup · brand_cell', '', 'C 키의 build_id'], ['citation_cell · url_prompt_cell · report_value', '', ''], ['page_visibility_daily · page_crawl_daily', '', ''], ['page_seo_device_daily · page_priority', '', ''], ['acr_iter_fact · acr_iter_shortlist', '', ''], ['GA4 · 키워드 · 소셜', '', 'build 없음: 날짜 · call_id · snapshot_id'] ], d: {
  grain: 'build_id 로 세대를 나누는 골드 테이블 목록입니다(셀 집계는 C 키의 build_id). GA4 는 날짜, 키워드는 call_id · observed_at, 소셜은 snapshot_id 로 나누고 build_id 가 없습니다.', pk: '—', inputs: '—',
  rules: ['조회는 요청 시작에 release 하나를 고정하고, 그 release 가 가리키는 build 의 행만 읽습니다. 카드 읽기는 publication.build_id 의 행을 읽습니다.'] } });
tbl('build', { s: 'gold', name: 'build', fam: 'build', grain: '빌드 1회', cols: [
  ['build_id', 'PK', ''], ['family', '', 'fact · cell · report · acr · vis'], ['slice_key', '', '회차 · 발행 · 사이트×일'], ['input_snapshot · watermark', '', '입력 고정'], ['profile_signature · metric_version', '', '규칙 서명'],
  ['ecat_ver · rule_ver', '', '판정 버전'], ['status', '', 'pending · running · validated · failed'], ['row_counts · verify', '', 'jsonb'], ['error · attempt', '', ''], ['started_at · finished_at', '', ''] ], d: {
  grain: '패밀리 × 슬라이스 × 입력·규칙 버전의 빌드 1회 = 1행.', pk: 'build_id (유일: family + slice_key + 입력·규칙 버전)', inputs: '데이터 분석팀',
  triggers: '회차 마감, 재판정, ACR 수집 완료, 보고 유닛 발행값 발행(report_value), 일 배치(vis)',
  rules: ['build 하나는 한 패밀리 · 슬라이스의 출력 행 묶음입니다. 사실 · 셀 행은 build_id 로 세대를 나누고, release_item · publication 이 build_id 로 공개할 build 를 가리킵니다.', '재시도는 같은 build 출력을 교체·재개합니다. row_counts 를 누적하지 않습니다.', '실패한 build 는 release 에 넣지 않고 status · error 만 남깁니다.'] } });
tbl('data_version', { s: 'gold', name: 'data_version', fam: 'build', grain: 'release 밖 데이터의 버전', cols: [['scope', 'PK', 'dim · cycle · job · raw …'], ['version', '', 'bigint, 쓸 때마다 +1'], ['updated_at', '', '']], d: {
  grain: '버전 범위 1개 = 1행.', pk: 'scope', inputs: '데이터 분석팀', triggers: 'release 를 거치지 않는 gold 테이블을 쓴 트랜잭션 안에서 함께 증가',
  rules: ['차원 · 회차 · job · 답변 원문 · GA4 · 키워드 · 소셜처럼 build 로 나누지 않는 테이블을 쓸 때 해당 scope 의 version 을 반드시 올립니다.', 'version 이 오르면 그 scope 의 골드 데이터가 바뀐 것입니다. 읽는 쪽은 scope 별 version 과 active_release.version 이 모두 그대로이면 읽을 골드 데이터도 그대로라고 봅니다.'] } });
tbl('release', { s: 'gold', name: 'release', fam: 'build', grain: '공개 manifest 1개', cols: [['release_id', 'PK', ''], ['read_mode', '', 'live · card · grid'], ['rule_signature', '', '규칙 서명'], ['base_release_id', 'FK', '이전 release', 'release'], ['validated_at', '', '']], d: {
  grain: '불변 공개 manifest 1개 = 1행.', pk: 'release_id', inputs: '데이터 분석팀 · build',
  rules: ['validated build 만 묶습니다.', '한 요청 안의 숫자는 release 하나로 같은 세대에 고정합니다.'] } });
tbl('release_item', { s: 'gold', name: 'release_item', fam: 'build', grain: 'release × 패밀리 × 슬라이스', cols: [['release_id', 'PF', '', 'release'], ['family', 'PK', ''], ['slice_key', 'PK', ''], ['build_id', 'FK', '', 'build'], ['state', '', 'ready · empty']], d: {
  grain: 'release × 패밀리 × 슬라이스 = 1행. 어느 회차·날짜에 어느 build 를 쓸지 정합니다.', pk: 'release_id + family + slice_key', inputs: '데이터 분석팀 · build',
  rules: ['조회는 release_item 으로 build_id 를 정합니다. 카드 · 격자 읽기는 활성 publication.build_id 를 씁니다.', '빈 슬라이스도 empty 로 매핑해 삭제를 표현합니다.'] } });
tbl('active_release', { s: 'gold', name: 'active_release', fam: 'build', grain: '공개 포인터', cols: [['read_mode', 'PK', '읽기 모드'], ['rule_signature', 'PK', '규칙 서명'], ['scope', 'PK', '공개 범위 (표면)'], ['release_id', 'FK', '현재 release', 'release'], ['version', '', '공개 버전 (전환마다 +1)'], ['last_build_id', 'FK', '마지막 반영 build', 'build'], ['rule_ver · as_of · updated_at', '', '']], d: {
  grain: '읽기 모드 × 규칙 서명 × 공개 범위의 현재 release = 1행.', pk: 'read_mode + rule_signature + scope', inputs: '데이터 분석팀 · release',
  triggers: '검증 통과 뒤 짧은 트랜잭션으로 포인터 전환 (승인 없는 회차별 자동 생성은 20261015 논의 · A04 진행 중)',
  rules: ['기대한 이전 release 와 입력 버전을 확인한 뒤 전환해, 오래된 build 가 새 입력을 덮지 못하게 합니다.', 'version 이 오르면 공개 release 가 바뀐 것입니다. 읽는 쪽은 version 으로 앞서 읽은 값(목록을 이어 읽는 위치 포함)이 낡았는지 판단합니다.'] } });
