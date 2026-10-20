/* ── GA4 ── */
tbl('ga4_property', { s: 'gold', name: 'ga4_property', fam: 'ga4', grain: 'GA4 속성 1개', cols: [['prop_key', 'PK', 'int2'], ['property_id', 'UK', ''], ['brand_bit', '', ''], ['geo_key', 'FK', '', 'dim_country'], ['status', '', 'active · pending_grant · unmapped'], ['source', '', 'registry · project_override · env'], ['conv_basis', '', '전환 분자: 1 key_events 폴백 · 2 추적 이벤트 event_count']], d: {
  grain: 'GA4 속성 1개 = 1행.', pk: 'prop_key', inputs: '데이터 분석팀',
  uses: 'AI Conversion(Global · Website · Project) 시장 · 속성 해석, 미연동 · 측정 대기 안내, 전환 분자(conv_basis), Global · Website 측정 커버리지 · 국가별 AI 전환율 표, Project Dashboard AI 유입 전환율 카드, GA4 이벤트 목록(Admin GA4 연동 · 전환 화면)' } });
tbl('ga4_value', { s: 'gold', name: 'ga4_value', fam: 'ga4', grain: 'GA4 값 사전', cols: [['kind · value_key', 'PK', 'channel · source · device · nvr · event · page'], ['value', '', '빈 문자열 = 0 · page = 입구 페이지'], ['url_key', 'FK', 'kind=page 의 URL', 'dim_url']], d: {
  grain: 'GA4 차원 값 1개 = 1행.', pk: 'kind + value_key', inputs: '데이터 분석팀 (출처: GA4 보고서 차원 값)', uses: 'AI Conversion 기기 · 방문자 유형 필터, 페이지별 전환 · 입구 페이지별 방문 표 URL, GA4 이벤트 목록 이벤트 이름' } });
tbl('ga4_row', { s: 'gold', name: 'ga4_row', fam: 'ga4', grain: '속성 × 일 × report × 차원', cols: [
  ['prop_key', 'PF', '', 'ga4_property'], ['date', 'PK', ''], ['report', 'PK', '1 traffic_total · 2 traffic_ai · 3 events · 4 landing · 5 totals'], ['channel_key · source_key', 'PF', '', 'ga4_value'],
  ['device_key · nvr_key', 'PF', '', 'ga4_value'], ['page_key · event_key', 'PF', '', 'ga4_value'], ['is_ai', '', 'AI Assistant 채널'], ['engine_key', 'FK', 'AI 행 sessionSource · 그 밖 0', 'dim_engine'], ['is_conv', '', '추적 이벤트 · key event 폴백'],
  ['sessions · users_day', '', ''], ['page_views · key_events · event_count', '', ''] ], d: {
  grain: '속성 × 보고일 × report × 차원 조합 = 1행.', pk: 'prop_key + report + date + channel_key + source_key + device_key + nvr_key + page_key + event_key', inputs: '데이터 분석팀 (출처: GA4 보고서 5종의 일별 행)', triggers: 'GA4 일 적재. 추적 이벤트가 바뀌면 is_conv 를, 속성 매핑이 바뀌면 그 속성을 전 기간 다시 계산',
  uses: 'AI Conversion(Global · Website · Project) 전환율 카드 · 추이, 방문 수 추이, 엔진별 전환, 페이지별 전환 표, 방문 수 카드 · 입구 페이지별 방문 표 세션, Global · Website 측정 커버리지 · 국가별 AI 전환율 표, Project Dashboard AI 유입 전환율 카드, GA4 이벤트 목록(90일 eventCount)',
  rules: ['sessions · page_views · key_events · event_count 는 날짜 · 차원끼리 더해도 됩니다. users_day 는 행끼리 더하지 않습니다 (기간 사용자 수는 ga4_users_window).'] } });
tbl('ga4_users_window', { s: 'gold', name: 'ga4_users_window', fam: 'ga4', grain: '속성 × 기간 × 코호트 × 필터 조합 × 입구 페이지', cols: [
  ['prop_key', 'PF', '', 'ga4_property'], ['window_end · window_days', 'PK', '창 끝일 · 7 · 28 · 90일(카드 · 표) · 1(일별 추이)'], ['cohort', 'PK', 'ai · total · general'], ['engine_mask', 'PK', 'AI 엔진 비트 조합 · 0 = 필터 없음'],
  ['device_mask · nvr_mask', 'PK', '기기 · 신규/재방문 비트 조합 · 0 = 필터 없음'], ['page_key', 'PF', '0 = 전체 · 그 밖 = 입구 페이지', 'ga4_value'], ['users', '', '순 방문자 (기간 중복 제거)'] ], d: {
  grain: '속성 × 기간 × 코호트 × 엔진·기기·신규/재방문 필터 조합 × 입구 페이지 = 1행.', pk: 'prop_key + window_end + window_days + cohort + engine_mask + device_mask + nvr_mask + page_key',
  inputs: '데이터 분석팀 (출처 제안: GA4 Data API activeUsers 기간 조회. AI 조건 = sessionDefaultChannelGroup "AI Assistant" ∧ sessionSource ∈ 선택 엔진 호스트)', triggers: 'ga4_row 와 같은 GA4 일 적재',
  uses: 'AI Conversion(Global · Website · Project) 사용자 기준 값: 전환율 카드 · 국가별 · 엔진별 분모 = 창 activeUsers, 전환율 추이 = 일별 activeUsers, 페이지별 전환 표 AI · 일반 사용자, 방문 블록 순 방문자 · 방문 빈도 카드, 입구 페이지별 방문 표 사용자 열. Project Dashboard AI 유입 전환율 카드 = 28일 창',
  rules: ['순 방문자는 더할 수 없어서 필터 조합마다 행을 둡니다. 화면의 모든 조합(엔진 · 기기 · 신규/재방문 다중 선택)을 비트 조합으로 미리 계산하고 근사하지 않습니다.', 'cohort: ai = AI 유입, total = 엔진 조건 없이 기기·신규/재방문만 건 전체, general = 비AI 값. total − ai 도 이 행들로 구할 수 있습니다.', '입구 페이지 행(page_key ≠ 0)은 창 · 필터 조합마다 AI 세션 상위 15(입구 페이지별 방문 표) ∪ AI 사용자 상위 12(페이지별 전환 표) 페이지에 둡니다. total · general 페이지 행은 engine_mask 0 으로, 같은 기기 · 신규/재방문 조합에서 뽑힌 페이지마다 둡니다.', '7 · 28 · 90일 행의 window_end = 그 속성의 마지막 적재일, 일별 행(window_days 1)은 날짜마다입니다.'] } });
