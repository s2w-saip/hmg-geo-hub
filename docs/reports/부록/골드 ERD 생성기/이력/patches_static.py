"""v8 2단계 패치: 정적 표본 화면(AI Visibility · ACR · 소셜 · 리서치) · 사용자 수(GA4) · depth4.
근거: 정적 화면 데이터 형태 조사(조사 메모/정적 화면 데이터 형태.md). patch_tables.py 가 TABLE_PATCHES 뒤에 적용한다."""

STATIC_PATCHES = [
    # depth4
    ("['taxon_key', 'PK', 'int2'], ['axis', '', 'funnel · presence · list_type · depth1~3'],", "['taxon_key', 'PK', 'int2'], ['axis', '', 'funnel · presence · list_type · depth1~4'],"),
    ("['funnel_key · list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon'], ['build_id', 'PF', '현행 load_id', 'build'] ], d: {",
     "['funnel_key · list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon'], ['depth4_key', 'FK', '신규 · 현행은 app.prompt.depth4', 'dim_taxon'], ['build_id', 'PF', '현행 load_id', 'build'] ], d: {"),
    ("rules: ['여러 카탈로그 행이 붙어도 측정 수를 중복하지 않게 EXISTS 로만 거릅니다.'] } });",
     "rules: ['여러 카탈로그 행이 붙어도 측정 수를 중복하지 않게 EXISTS 로만 거릅니다.', 'depth4 필터(대시보드·언급·인용·Visibility·ACR·프롬프트 목록)는 depth4_key 로 겁니다. 현행 BE 는 app.prompt.depth4 를 catalog_row_id = prompt_id 로 붙여 읽습니다.'] } });"),

    # GA4 값 사전: 입구 페이지 → URL
    ("cols: [['kind · value_key', 'PK', 'channel · source · device · nvr · event · page'], ['value', '', '빈 문자열 = 0']], d: {",
     "cols: [['kind · value_key', 'PK', 'channel · source · device · nvr · event · page'], ['value', '', '빈 문자열 = 0 · page = landingPagePlusQueryString'], ['url_key', 'FK', 'kind=page 의 URL (신규)', 'dim_url']], d: {"),
    ("pk: 'prop_key + date + report + channel · source · device · nvr · page · event', cur: 'rd.ga4_row (그대로)' } });",
     "pk: 'prop_key + date + report + channel · source · device · nvr · page · event', inputs: 'GA4 Data API 일 리포트 (현행 rd.ga4_row 와 같은 5종)', triggers: 'GA4 날짜 배치',\n"
     "  uses: 'AI Conversion 전환율·방문 수·일별 방문·입구 페이지 세션·국가별 전환, 측정 커버리지, Admin GA4 적재 상태', cur: 'rd.ga4_row (그대로)',\n"
     "  rules: ['sessions · key_events · event_count 는 날짜·차원끼리 더해도 됩니다. users_day 는 행끼리 더하지 않습니다 (사용자 수는 ga4_users_window).'] } });"),
    # ga4_users_window 전면 교체
    ("tbl('ga4_users_window', { s: 'gold', name: 'ga4_users_window', fam: 'ga4', grain: '속성 × 기간 × 코호트 × 차원', cols: [\n"
     "  ['prop_key', 'PF', '', 'ga4_property'], ['window_end · window_days', 'PK', '7 · 28 · 90일'], ['cohort', 'PK', 'ai · general'], ['engine_key', 'PF', '', 'dim_engine'],\n"
     "  ['device_key · nvr_key', 'PF', '', 'ga4_value'], ['page_key', 'PF', '0 = 전체', 'ga4_value'], ['users', '', '순 방문자'] ], d: {\n"
     "  grain: '속성 × 기간 × 코호트 × 엔진 × 기기 × 신규/재방문 × 입구 페이지 = 1행.', pk: 'prop_key + window_end + window_days + cohort + engine_key + device_key + nvr_key + page_key',\n"
     "  cur: '없음 (신규 · 순 방문자 · 방문 빈도 · 사용자 기준 전환율용)' } });",
     "tbl('ga4_users_window', { s: 'gold', name: 'ga4_users_window', fam: 'ga4', grain: '속성 × 기간 × 코호트 × 필터 조합 × 입구 페이지', cols: [\n"
     "  ['prop_key', 'PF', '', 'ga4_property'], ['window_end · window_days', 'PK', '마지막 적재일 · 1 · 7 · 28 · 90일'], ['cohort', 'PK', 'ai · total · general'], ['engine_mask', 'PK', 'AI 엔진 비트 조합 · 0 = 필터 없음'],\n"
     "  ['device_mask · nvr_mask', 'PK', '기기 · 신규/재방문 비트 조합 · 0 = 필터 없음'], ['page_key', 'PF', '0 = 전체 · 그 밖 = 입구 페이지', 'ga4_value'], ['users', '', '순 방문자 (기간 중복 제거)'] ], d: {\n"
     "  grain: '속성 × 기간 × 코호트 × 엔진·기기·신규/재방문 필터 조합 × 입구 페이지 = 1행.', pk: 'prop_key + window_end + window_days + cohort + engine_mask + device_mask + nvr_mask + page_key',\n"
     "  inputs: 'GA4 Data API activeUsers (기간 합). AI 조건 = sessionDefaultChannelGroup AI Assistant ∧ sessionSource ∈ 선택 엔진 호스트', triggers: 'GA4 날짜 배치',\n"
     "  uses: '방문 블록의 순 방문자·방문 빈도 카드, 입구 페이지 표 사용자 열, 사용자 기준 전환율 (레거시 분모, 일별 = window_days 1)', cur: '없음 (신규. 레거시는 GA4 를 화면 요청마다 직접 호출, API 경로는 users null)',\n"
     "  rules: ['순 방문자는 더할 수 없어서 필터 조합마다 행을 둡니다. 화면의 모든 조합(엔진 · 기기 · 신규/재방문 다중 선택)을 비트 조합으로 미리 계산하고 근사하지 않습니다.', 'cohort: ai = AI 유입, total = 엔진 조건 없이 기기·신규/재방문만 건 전체, general = 비AI 값 (레거시 일반 = total − ai 도 재현 가능).', '입구 페이지 행(page_key ≠ 0)은 조합마다 AI 세션 상위 15 페이지와 그 total 값입니다.', 'window_end = 그 속성의 마지막 적재일 (현행 API 경로 U8-N5 와 같음).'] } });"),

    # AI Visibility
    ("tbl('dim_crawl_bot', { s: 'gold', name: 'dim_crawl_bot', fam: 'vis', grain: 'AI 크롤러 1개', cols: [['bot_key', 'PK', 'int2'], ['code', 'UK', 'ChatGPT-User · Claude-Web · PerplexityBot · Googlebot-Vertex'], ['engine_key', 'FK', '', 'dim_engine']], d: {\n"
     "  grain: 'AI 크롤러 1개 = 1행.', pk: 'bot_key', cur: '없음 (신규)' } });",
     "tbl('dim_crawl_bot', { s: 'gold', name: 'dim_crawl_bot', fam: 'vis', grain: 'AI 크롤러 1개', cols: [['bot_key', 'PK', 'int2'], ['code', 'UK', 'ChatGPT-User · Claude-Web · PerplexityBot · Googlebot-Vertex'], ['engine_key', 'FK', '', 'dim_engine']], d: {\n"
     "  grain: 'AI 크롤러 1개 = 1행.', pk: 'bot_key', inputs: '데이터 분석팀 UA 목록', uses: 'AI 크롤 수의 구성, 엔진 필터 옵션', cur: '없음 (신규)',\n"
     "  rules: ['엔진 필터는 AI 크롤 수만 좁힙니다. 검색 노출에는 엔진이 없습니다.'] } });"),
    ("['build_id', 'PF', '', 'build'], ['project_key', 'PF', '사이트 · 프로젝트', 'dim_project'], ['url_key', 'PF', '페이지', 'dim_url'], ['geo_key · lang_key', 'FK', '시장 · 언어', 'dim_country'], ['date', 'PK', ''], ['seo_impressions', '', '검색 노출'], ['ai_crawls', '', 'AI 크롤 합계'] ], d: {\n"
     "  grain: '사이트 × 페이지 × 일 = 1행.', pk: 'build_id + project_key + url_key + date', cur: '없음 (신규 · 현재 화면은 정적 표본)' } });",
     "['build_id', 'PF', '', 'build'], ['project_key', 'PF', '사이트 · 프로젝트', 'dim_project'], ['url_key', 'PF', '페이지', 'dim_url'], ['geo_key', 'FK', '시장', 'dim_country'], ['lang_key', 'FK', '언어', 'dim_lang'], ['date', 'PK', ''], ['seo_impressions', '', '검색 노출 (GSC)'], ['ai_crawls', '', 'AI 크롤 합계'] ], d: {\n"
     "  grain: '빌드 × 사이트 × 페이지 × 일 = 1행.', pk: 'build_id + project_key + url_key + date', inputs: 'Google Search Console 페이지 노출 + 서버 크롤 로그 AI 봇 집계', triggers: '일 배치',\n"
     "  uses: 'AI Visibility 4분면 카드 · 산점도 · 페이지 진단 표 (Global · Project)', cur: '없음 (신규 · 현재 화면은 정적 표본)',\n"
     "  rules: ['url_key 는 dim_url 에서 받습니다. 인용된 적 없는 자사 페이지도 dim_url 행을 만들어 인용 쪽과 같은 키를 씁니다.', 'Global 화면 = 웹사이트 사이트(dim_project surface 2) 페이지 전체, Project 화면 = 그 프로젝트 자사 기준 URL(app.project_owned_base) 아래 페이지.', '분면 · 카드 수 · 중앙값은 필터를 건 페이지 집합의 기간 합으로 BE 가 계산합니다 (중앙값 = 정렬 후 floor(n/2) 번째, x ≥ 중앙값이면 높음). 저장하지 않습니다.', '프롬프트 축(promptContext · brandPresence · listType · depth1~4 · brand) · 경쟁사 축 = 그 페이지(url_key)를 인용한 답변의 프롬프트 · 언급 브랜드 (citation_fact ⋈ catalog_entry · answer_brand_fact).', '출처 축 = dim_url.source_key → dim_source.category_key. 기기 축 = page_seo_device_daily (검색 노출만). 방문자 유형 축 = GA4 입구 페이지(ga4_row report 4, ga4_value.url_key) 중 그 유형 세션이 있는 페이지.'] } });"),
    ("['bot_key', 'PF', '', 'dim_crawl_bot'], ['hits', '', '크롤 수']], d: {\n  grain: '사이트 × 페이지 × 일 × AI 크롤러 = 1행.', pk: 'page_visibility_daily PK + bot_key', cur: '없음 (신규)' } });",
     "['bot_key', 'PF', '', 'dim_crawl_bot'], ['hits', '', '크롤 수']], d: {\n  grain: '빌드 × 사이트 × 페이지 × 일 × AI 크롤러 = 1행.', pk: 'page_visibility_daily PK + bot_key', inputs: '서버 크롤 로그 (UA → dim_crawl_bot)', triggers: '일 배치',\n"
     "  uses: '엔진 필터를 건 AI 크롤 수', cur: '없음 (신규)', rules: ['Σhits = page_visibility_daily.ai_crawls 이어야 합니다.'] } });\n"
     "tbl('page_seo_device_daily', { s: 'gold', name: 'page_seo_device_daily', fam: 'vis', grain: '페이지 × 일 × 기기', cols: [['build_id · project_key · url_key · date', 'PF', '', 'page_visibility_daily'], ['device_key', 'PF', 'ga4_value kind=device 코드', 'ga4_value'], ['seo_impressions', '', 'GSC 기기별 노출']], d: {\n"
     "  grain: '빌드 × 사이트 × 페이지 × 일 × 기기 = 1행.', pk: 'page_visibility_daily PK + device_key', inputs: 'Google Search Console device 차원', triggers: '일 배치', uses: 'AI Visibility 기기 필터 (검색 노출)', cur: '없음 (신규)',\n"
     "  rules: ['Σseo_impressions = page_visibility_daily.seo_impressions 이어야 합니다.'] } });\n"
     "tbl('page_priority', { s: 'gold', name: 'page_priority', fam: 'vis', grain: '사이트 × 페이지 우선순위', cols: [['build_id', 'PF', '', 'build'], ['project_key', 'PF', '', 'dim_project'], ['url_key', 'PF', '', 'dim_url'], ['priority', '', '1 높음 · 2 · 3 낮음'], ['reason', '', '산정 근거'], ['rule_ver', '', '산정 규칙 버전']], d: {\n"
     "  grain: '빌드 × 사이트 × 페이지 = 1행.', pk: 'build_id + project_key + url_key', inputs: '데이터 분석팀 산정 규칙', uses: 'AI Visibility 페이지 진단 표의 우선순위 열 · 기본 정렬', cur: '없음 (신규 · 현재는 픽스처 값, 산정 규칙 없음)',\n"
     "  rules: ['산정 규칙은 데이터 분석팀이 정하고 rule_ver 로 남깁니다. 현행 화면에는 규칙이 없어서 이 테이블이 정의의 출처가 됩니다.'] } });"),
    ("tbl('dim_url', { s: 'gold', name: 'dim_url', fam: 'cit', grain: 'URL 1개', cols: [", "tbl('dim_url', { s: 'gold', name: 'dim_url', fam: 'cit', grain: 'URL 1개 (인용 · 자사 페이지)', cols: ["),
    ("grain: '인용 URL 1개 = 1행.', pk: 'url_key', inputs: '인용 정규화 · 자사/타겟 URL 매칭', uses: '인용 URL 목록, 타겟 URL 매칭, 답변·검수 상세', cur: 'rd.dim_url' } });",
     "grain: '인용 URL 또는 자사 페이지 1개 = 1행.', pk: 'url_key', inputs: '인용 정규화 · 자사/타겟 URL 매칭 · 자사 사이트 페이지 목록', uses: '인용 URL 목록, 타겟 URL 매칭, 답변·검수 상세, AI Visibility 페이지 URL', cur: 'rd.dim_url',\n"
     "  rules: ['AI Visibility 페이지와 인용 URL 은 같은 url_norm → 같은 url_key 입니다. 인용되지 않은 자사 페이지도 행을 만듭니다 (신규).'] } });"),

    # ACR 반복 단위
    ("rules: ['배틀 승자는 국가 등 필터를 건 뒤 계산합니다. 국가별 승자만 저장하지 않습니다.', '차종 분모 = 차종 엔티티 행에 붙은 셀의 valid_acr 합. 표시명 병합 때 임의로 중복 제거하지 않습니다.'] } });",
     "rules: ['배틀 승자는 국가 등 필터를 건 뒤 계산합니다. 국가별 승자만 저장하지 않습니다.', '차종 분모 = 차종 엔티티 행에 붙은 셀의 valid_acr 합. 표시명 병합 때 임의로 중복 제거하지 않습니다.', 'appearance 는 언급 기반이라 반복 수보다 클 수 있습니다. 후보군 등장 run 수는 acr_iter_shortlist 로 셉니다.'] } });\n"
     "tbl('acr_iter_fact', { s: 'gold', name: 'acr_iter_fact', fam: 'acr', grain: '빌드 × ACR 셀 × 반복', cols: [\n"
     "  ['build_id · acr_cell_key', 'PF', '', 'acr_cell_fact'], ['iter_no', 'PK', '= answer_fact.acr_iter_rank'], ['answer_key', 'FK', '반복 job', 'job_index'], ['result_type', '', '1 single · 2 conditional · 3 generic · 4 off_shortlist · 5 unresolved · 6 none'],\n"
     "  ['winner_brand_key', 'FK', '0 = 선택 없음', 'dim_brand'], ['winner_entity_key', 'FK', '차종 · 없으면 0', 'dim_entity'], ['own_bit', '', ''] ], d: {\n"
     "  grain: '빌드 × ACR 셀 × 반복 1회 = 1행.', pk: 'build_id + acr_cell_key + iter_no', inputs: 'ACR 최종 선택 판정 (반복 단위)', triggers: 'ACR 수집 완료, 반복·셀 재판정',\n"
     "  uses: '모델별 점유 맵의 반복 1–N 칸별 승자 · 최빈 브랜드 (Global · Website · Project ACR)', cur: '없음 (신규. 현행 live 화면은 반복 순서가 API 에 없어 분포로 대신 그림)',\n"
     "  rules: ['셀의 반복 행 합이 acr_cell_fact.co_* 와 acr_entity_fact.choice 와 같아야 합니다.', '열 수는 고정 10 이 아니라 acr_cell_fact.planned 입니다.'] } });\n"
     "tbl('acr_iter_shortlist', { s: 'gold', name: 'acr_iter_shortlist', fam: 'acr', grain: '반복 × 레벨 × 후보 엔티티', cols: [\n"
     "  ['build_id · acr_cell_key · iter_no', 'PF', '', 'acr_iter_fact'], ['level', 'PK', '1 브랜드 · 2 차종 · 3 회사'], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key · parent_brand_key', 'FK', '', 'dim_brand'], ['is_choice', '', '그 반복의 최종 선택'] ], d: {\n"
     "  grain: '빌드 × ACR 셀 × 반복 × 레벨 × 후보 엔티티 = 1행.', pk: 'build_id + acr_cell_key + iter_no + level + entity_key', inputs: 'ACR 최종 선택 판정 (반복 단위 후보군)',\n"
     "  uses: '차종별 선택 전환율 표의 후보군 등장 run 수 · 1위 선택 수 · 전환율 = 1위 ÷ 등장', cur: '없음 (신규)' } });"),

    # 소셜: 노드맵 · 상세 · 리서치 결과 열
    ("tbl('ctx_snapshot', { s: 'gold', name: 'ctx_snapshot', fam: 'soc', grain: '분석 스냅샷 1개', cols: [['snapshot_id', 'PK', 'int2'], ['industry_entity_id', '', '산업 엔티티'], ['source', '', ''], ['utterance_total', '', ''], ['taken_at', '', ''], ['is_active', '', '산업당 활성 1개']], d: {",
     "tbl('ctx_snapshot', { s: 'gold', name: 'ctx_snapshot', fam: 'soc', grain: '분석 스냅샷 1개', cols: [['snapshot_id', 'PK', 'int2'], ['industry_entity_id', '', '산업 엔티티'], ['source', '', ''], ['utterance_total', '', ''], ['taken_at', '', ''], ['is_active', '', '산업당 활성 1개'],\n"
     "  ['keyword', '', '지도 제목 키워드 (신규)'], ['geo_key', 'FK', '리서치 지역 (신규)', 'dim_country'], ['lang_key', 'FK', '(신규)', 'dim_lang'], ['run_id', 'FK', '리서치 실행 (신규)', 'ctx_research_run'], ['worker_total · speaker_total · source_total', '', '분석 표본 · 발화자 · 출처 수 (신규)']], d: {"),
    ("uses: 'Project > Intent > Social Scraping', cur: 'ext.ctx_snapshot' } });",
     "uses: 'Project > Intent > Social Scraping, Global > Customer interest > Social Scraping, Admin 리서치 결과 지도', cur: 'ext.ctx_snapshot',\n"
     "  rules: ['그래프의 mention_rate = ctx_entity.worker_count ÷ worker_total, 조합 overlap = ctx_combination.speaker_count ÷ speaker_total.'] } });"),
    ("['sentiment_positive · sentiment_negative · sentiment_neutral', '', '']], d: {",
     "['sentiment_positive · sentiment_negative · sentiment_neutral', '', ''], ['group_id', 'FK', '테마 · 카테고리 (신규)', 'ctx_group'], ['worker_count · unique_source_count', '', '언급 표본 · 고유 출처 수 (신규)'], ['perspective_buyer · perspective_seller · perspective_neutral', '', '관점 분포 (신규)']], d: {"),
    ("['source_host · source_url', '', ''], ['sentiment', '', '']], d: {", "['source_host · source_url', '', ''], ['sentiment', '', ''], ['source_title · rank', '', '출처 제목 · 표시 순서 (신규)']], d: {"),
    ("['requirement_id', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현']], d: {", "['requirement_id', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현'], ['strength_score', '', '유발 강도 1~10 (신규)']], d: {"),
    ("['cond_b', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현']], d: {", "['cond_b', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현'], ['description', '', '조합 시나리오 (신규)'], ['speaker_count · unique_source_count', '', '(신규)']], d: {"),

    # 요청 종류: 리서치 실행 요청 신설
    ("['kind', 'FK', '요청 종류 22', 'judgment_kind']", "['kind', 'FK', '요청 종류 23', 'judgment_kind']"),
    ("tbl('judgment_kind', { s: 'key', name: '요청 종류 22',", "tbl('judgment_kind', { s: 'key', name: '요청 종류 23',"),
    ("['외부 수집 요청', '', 'dfs_fetch · ga4_property · ga4_tracked_event'] ], d: {", "['외부 수집 요청', '', 'dfs_fetch · ga4_property · ga4_tracked_event · ctx_research (신규)'] ], d: {"),
    ("grain: 'judgment_change.kind 에 들어갈 수 있는 값 22개를 7개 묶음으로 나눈 것입니다 (CHECK 제약).'", "grain: 'judgment_change.kind 값 23개(현행 22 + 리서치 실행 요청 ctx_research 1)를 7개 묶음으로 나눈 것입니다 (CHECK 제약).'"),

    # 고스트 · 빌드 목록 · 탭 배치
    ("ghost('publication', [['gen_key', 'PK', ''], ['build_id', 'FK', '', 'build']]);",
     "ghost('publication', [['gen_key', 'PK', ''], ['build_id', 'FK', '', 'build']]); ghost('ga4_value', [['kind · value_key', 'PK', '']]); ghost('ctx_snapshot', [['snapshot_id', 'PK', '']]);"),
    ("['page_visibility_daily · page_crawl_daily', '', ''],", "['page_visibility_daily · page_crawl_daily · page_seo_device_daily · page_priority', '', ''], ['acr_iter_fact · acr_iter_shortlist', '', ''],"),
    ("{ g: '기타 계열', id: 'acr', label: 'ACR', w: 1170, h: 400, main: 'acr_cell_fact',", "{ g: '기타 계열', id: 'acr', label: 'ACR', w: 1170, h: 610, main: 'acr_cell_fact',"),
    ("pos: { cell_key_c: [20, 20, 200], job_index_ref: [20, 200, 200], acr_cell_fact: [290, 20, 260], acr_cell_job: [290, 272, 260], acr_entity_fact: [620, 20, 260], dim_entity: [950, 20, 180], dim_brand: [950, 190, 180] } },",
     "pos: { cell_key_c: [20, 20, 200], job_index_ref: [20, 200, 200], acr_cell_fact: [290, 20, 260], acr_cell_job: [290, 300, 260], acr_iter_shortlist: [290, 440, 260], acr_entity_fact: [620, 20, 260], acr_iter_fact: [620, 250, 260], dim_entity: [950, 20, 190], dim_brand: [950, 210, 190] } },"),
    ("{ g: '기타 계열', id: 'soc', label: '소셜', w: 900, h: 680, main: 'ctx_entity',", "{ g: '기타 계열', id: 'soc', label: '소셜', w: 1150, h: 660, main: 'ctx_entity',"),
    ("pos: { ctx_snapshot: [20, 20, 220], ctx_entity: [310, 20, 250], ctx_drive: [640, 20, 230], ctx_combination: [640, 172, 230], ctx_domain: [640, 324, 230], ctx_evidence: [640, 476, 230] } },",
     "pos: { ctx_snapshot: [20, 20, 250], ctx_group: [20, 330, 250], ctx_entity: [320, 20, 260], ctx_claim: [320, 300, 260], ctx_claim_quote: [320, 490, 260], ctx_drive: [630, 20, 230], ctx_combination: [630, 180, 230], ctx_combination_evidence: [630, 370, 230], ctx_domain: [910, 20, 220], ctx_evidence: [910, 170, 220] } },\n"
     "  { g: '기타 계열', id: 'research', label: '소셜 리서치', w: 880, h: 480, main: 'ctx_research_run',\n"
     "    note: 'Admin > Customer interest config 의 리서치 입력 · 탐색 화면 · 결과 지도입니다. 실행 요청은 BE 가 judgment_change ctx_research 로 넘기고, 데이터 분석팀이 진행 기록과 결과 스냅샷을 씁니다. 실시간 진행 표시는 폴링으로 이 테이블을 읽습니다.',\n"
     "    pos: { ctx_research_run: [20, 20, 270], ctx_research_wave: [350, 20, 230], ctx_research_worker: [350, 190, 230], ctx_research_log: [640, 20, 220], ctx_snapshot_ref: [640, 220, 200], dim_country_ref: [640, 310, 200], dim_lang_ref: [640, 400, 200] } },"),
    ("{ g: '기타 계열', id: 'vis', label: 'AI Visibility', w: 830, h: 360, main: 'page_visibility_daily', note: '',",
     "{ g: '기타 계열', id: 'vis', label: 'AI Visibility', w: 800, h: 580, main: 'page_visibility_daily', note: '분면·카드 수·중앙값은 저장하지 않고 필터를 건 페이지 집합에서 BE 가 계산합니다. 프롬프트·브랜드·경쟁사 필터는 그 페이지를 인용한 답변으로 겁니다 (citation_fact).',"),
    ("pos: { page_visibility_daily: [20, 20, 260], page_crawl_daily: [20, 220, 260], dim_project_ref: [350, 20, 180], dim_url_ref: [350, 110, 180], dim_crawl_bot: [350, 220, 220], dim_engine_ref: [640, 220, 170] },",
     "pos: { page_visibility_daily: [20, 20, 260], page_crawl_daily: [20, 250, 260], page_seo_device_daily: [20, 390, 260], page_priority: [330, 390, 240], dim_project_ref: [330, 20, 180], dim_url_ref: [330, 110, 180], dim_country_ref: [560, 20, 180], dim_lang_ref: [560, 110, 180], dim_crawl_bot: [330, 250, 220], dim_engine_ref: [600, 250, 170], ga4_value_ref: [600, 390, 180] },"),
]

APPEND_TABLES = [r"""/* ── 소셜 노드맵 · 리서치 (신규) ── */
tbl('ctx_group', { s: 'gold', name: 'ctx_group', fam: 'soc', grain: '스냅샷 × 테마·카테고리', cols: [['snapshot_id', 'PF', '', 'ctx_snapshot'], ['group_id', 'PK', ''], ['side', '', 'context 테마 · condition 카테고리'], ['name', '', ''], ['description', '', '설명문'], ['dimension', '', '현행 dimension 코드'], ['sort_order', '', '']], d: {
  grain: '스냅샷 × 테마 또는 카테고리 1개 = 1행.', pk: 'snapshot_id + group_id', inputs: '구매 맥락 추출', uses: '맥락 표 주제 · 조건 표 카테고리 · 그래프의 테마/카테고리 노드 이름과 설명', cur: '없음 (신규. 현행은 코드의 DIMENSION_THEME 맵 · 이름 정규식 분류)' } });
tbl('ctx_combination_evidence', { s: 'gold', name: 'ctx_combination_evidence', fam: 'soc', grain: '조합 × 근거 발화', cols: [['snapshot_id · cond_a · cond_b', 'PF', '', 'ctx_combination'], ['seq', 'PK', ''], ['quote', '', ''], ['source_title · source_url · source_host', '', ''], ['perspective', '', 'buyer · seller · neutral']], d: {
  grain: '스냅샷 × 조건 쌍 × 근거 발화 1개 = 1행.', pk: 'snapshot_id + cond_a + cond_b + seq', inputs: '구매 맥락 추출', uses: '그래프 조합 패널의 근거 · 출처 URL 목록 (20개 + 외 n건)', cur: '없음 (신규)' } });
tbl('ctx_claim', { s: 'gold', name: 'ctx_claim', fam: 'soc', grain: '조건 × 심층 근거 주장', cols: [['snapshot_id · entity_id', 'PF', '조건', 'ctx_entity'], ['claim_id', 'PK', ''], ['claim', '', '주장문'], ['supporting · contradicting · neutral', '', '지지 · 반박 · 중립 수'], ['total_scanned', '', '검토 소스 수'], ['confidence', '', '신뢰도']], d: {
  grain: '스냅샷 × 조건 × 심층 근거 주장 1개 = 1행.', pk: 'snapshot_id + entity_id + claim_id', inputs: '심층 근거 검증', uses: '그래프 조건 패널의 심층 근거 · 점선 링 · 툴바의 deep_evidence_linked', cur: '없음 (신규)' } });
tbl('ctx_claim_quote', { s: 'gold', name: 'ctx_claim_quote', fam: 'soc', grain: '주장 × 인용 표본', cols: [['snapshot_id · entity_id · claim_id', 'PF', '', 'ctx_claim'], ['seq', 'PK', ''], ['quote', '', ''], ['source', '', ''], ['stance', '', 'supporting · contradicting · neutral']], d: {
  grain: '주장 × 인용 표본 1개 = 1행.', pk: 'snapshot_id + entity_id + claim_id + seq', inputs: '심층 근거 검증', uses: '심층 근거의 표본 인용', cur: '없음 (신규)' } });
tbl('ctx_research_run', { s: 'gold', name: 'ctx_research_run', fam: 'soc', grain: '리서치 실행 1회', cols: [['run_id', 'PK', 'uuid'], ['keyword', '', ''], ['geo_key', 'FK', '지역', 'dim_country'], ['lang_key', 'FK', '', 'dim_lang'], ['purpose_preset · purpose_text', '', '목적'], ['status', '', 'queued · exploring · done · failed'],
  ['requested_by', 'FK', '', 'app.user_account'], ['started_at · finished_at', '', ''], ['search_count · source_count · worker_count', '', '탐색 카운터'], ['cost_usd', '', ''], ['snapshot_id', 'FK', '결과 지도', 'ctx_snapshot']], d: {
  grain: '리서치 실행 1회 = 1행.', pk: 'run_id', inputs: 'judgment_change ctx_research (BE 요청) → 데이터 분석팀 리서치 실행', triggers: '요청 접수 · 진행 · 완료',
  uses: 'Admin 리서치 입력 폼 · 탐색 화면 카운터 · 결과 지도 연결', cur: '없음 (신규. 현행은 스크립트 픽스처, 입력 폼은 지역·목적을 버림)' } });
tbl('ctx_research_wave', { s: 'gold', name: 'ctx_research_wave', fam: 'soc', grain: '실행 × 탐색 웨이브', cols: [['run_id', 'PF', '', 'ctx_research_run'], ['wave_no', 'PK', ''], ['strategy', '', ''], ['task_count', '', ''], ['started_at', '', '']], d: {
  grain: '실행 × 웨이브 1개 = 1행.', pk: 'run_id + wave_no', inputs: '리서치 실행', uses: '탐색 화면 웨이브 목록', cur: '없음 (신규)' } });
tbl('ctx_research_worker', { s: 'gold', name: 'ctx_research_worker', fam: 'soc', grain: '실행 × 워커', cols: [['run_id', 'PF', '', 'ctx_research_run'], ['worker_id', 'PK', ''], ['wave_no', '', ''], ['label · query', '', ''], ['status', '', ''], ['source_count', '', ''], ['dispatched_at · completed_at', '', '']], d: {
  grain: '실행 × 워커 1개 = 1행.', pk: 'run_id + worker_id', inputs: '리서치 실행', uses: '탐색 화면 워커 목록 · 완료 수 · 출처 수', cur: '없음 (신규)' } });
tbl('ctx_research_log', { s: 'gold', name: 'ctx_research_log', fam: 'soc', grain: '실행 × 활동 로그', cols: [['run_id', 'PF', '', 'ctx_research_run'], ['seq', 'PK', ''], ['kind', '', ''], ['title · detail', '', ''], ['created_at', '', '']], d: {
  grain: '실행 × 로그 1줄 = 1행.', pk: 'run_id + seq', inputs: '리서치 실행', uses: '탐색 화면 활동 로그', cur: '없음 (신규)' } });

/* ── 데이터 분석팀 신규 · 변경 요청 (현행 rd 에 없는 것) ── */
const NEWREQ = [
  { t: 'answer_fact.own_fp_{h,k,g}', kind: '신규 열', f: '국가별 GEO 현황 · 시장별 경쟁 위치의 우선 노출도 (T001)', src: '답변 본문의 텍스트상 첫 등장 순서 (브랜드 언급 추출)' },
  { t: 'answer_brand_fact.first_pos', kind: '신규 열', f: 'GEO 경쟁사 우선 노출도 (T001)', src: '위와 같은 규칙, 브랜드별' },
  { t: 'answer_fact.rep_cit_xor', kind: '정의 변경', f: '답변 분석 인용 대표 (현행 rd.rep_cit_delta 행을 열로 접음)', src: '현행 rep_cit_delta 규칙' },
  { t: 'catalog_entry.depth4_key', kind: '신규 열', f: 'depth4 필터 (대시보드 · 언급 · 인용 · Visibility · ACR · 프롬프트 목록)', src: 'app.prompt.depth4 → dim_taxon axis depth4' },
  { t: 'catalog_entry', kind: '정의 변경', f: 'KPI 적용·측정 프롬프트 수가 같은 release 의 사실과 맞도록 build 로 버전 관리', src: 'build_id 를 PK 에 포함' },
  { t: 'publication.build_id', kind: '정의 변경', f: '카드 동결 7개 경로 (frz.keep_* 보관 행 대체)', src: '발행 시점 사실 build 고정 · ops 이관 세대도 build 로' },
  { t: 'build', kind: '신규 테이블', f: '모든 사실·셀의 세대 · 반영 큐 화면 applied_build_id', src: '데이터 분석팀 빌드 이력' },
  { t: 'release', kind: '신규 테이블', f: '한 응답 안의 숫자를 같은 세대로 고정 (release_item · active_release 포함)', src: '검증 통과 build 묶음' },
  { t: 'data_version', kind: '신규 테이블', f: 'BE 결과 캐시 무효화 (현행 rcache 트리거 대체)', src: 'release 밖 gold 쓰기마다 증가' },
  { t: 'cycle_pick_basis', kind: '누락 보강', f: '기간 선택 시 카드 동결 판정 (생성 대기 구멍)', src: '현행 rd.cycle_pick_basis 그대로' },
  { t: 'ga4_property.conv_basis', kind: '누락 보강', f: 'Admin > GA4 연동 전환 기준 열', src: '현행 rd.ga4_dim_property.conv_basis' },
  { t: 'kw_volume_monthly.competition', kind: '누락 보강', f: 'Admin > Keyword tools 경쟁도 라벨', src: 'DataForSEO competition (현행 열)' },
  { t: 'kw_suggestion.total_count', kind: '누락 보강', f: 'Google keywords 연관어 총수 (BG-39)', src: 'DataForSEO total_count (현행 열)' },
  { t: 'ga4_users_window', kind: '신규 테이블', f: '순 방문자 · 방문 빈도 · 입구 페이지 사용자 · 사용자 기준 전환율 (std · website · project)', src: 'GA4 Data API activeUsers, 필터 조합별' },
  { t: 'page_visibility_daily', kind: '신규 테이블', f: 'AI Visibility 4분면 카드 · 산점도 · 페이지 진단 표', src: 'GSC 페이지 노출 + 서버 크롤 로그' },
  { t: 'page_crawl_daily', kind: '신규 테이블', f: 'AI 크롤 수 엔진 필터', src: '서버 크롤 로그 (dim_crawl_bot 포함)' },
  { t: 'page_seo_device_daily', kind: '신규 테이블', f: 'AI Visibility 기기 필터', src: 'GSC device 차원' },
  { t: 'page_priority', kind: '신규 테이블', f: 'AI Visibility 페이지 진단 표 우선순위 (산정 규칙 정의 포함)', src: '데이터 분석팀 규칙 (rule_ver)' },
  { t: 'dim_url', kind: '정의 변경', f: 'Visibility 페이지와 인용 URL 을 같은 키로 (인용 안 된 자사 페이지 행 추가)', src: '자사 사이트 페이지 목록' },
  { t: 'ga4_value.url_key', kind: '신규 열', f: 'Visibility 방문자 유형 필터 (GA4 입구 페이지 ↔ URL)', src: 'landingPagePlusQueryString 정규화' },
  { t: 'acr_iter_fact', kind: '신규 테이블', f: '모델별 점유 맵의 반복별 승자 · 최빈 브랜드', src: 'ACR 반복 단위 최종 선택' },
  { t: 'acr_iter_shortlist', kind: '신규 테이블', f: '차종별 선택 전환율의 후보군 등장 run 수', src: 'ACR 반복 단위 후보군' },
  { t: 'ctx_snapshot.keyword', kind: '신규 열', f: '구매 맥락 지도 제목 · 지역별 스냅샷 · 그래프 툴바 (keyword · geo_key · lang_key · run_id · worker_total · speaker_total · source_total)', src: '구매 맥락 추출' },
  { t: 'ctx_entity.perspective_buyer', kind: '신규 열', f: '관점 분포 · 관점 필터 · mention_rate (group_id · worker_count · unique_source_count · perspective_*)', src: '구매 맥락 추출' },
  { t: 'ctx_evidence.source_title', kind: '신규 열', f: '근거 인용의 출처 제목 · 순서 (source_title · rank)', src: '구매 맥락 추출' },
  { t: 'ctx_drive.strength_score', kind: '신규 열', f: '그래프 유발 강도 (엣지 굵기 · 막대)', src: '구매 맥락 추출' },
  { t: 'ctx_combination.description', kind: '신규 열', f: '조합 시나리오 · 발화자 수 · 출처 수 · overlap', src: '구매 맥락 추출' },
  { t: 'ctx_group', kind: '신규 테이블', f: '테마 · 카테고리 이름과 설명', src: '구매 맥락 추출' },
  { t: 'ctx_combination_evidence', kind: '신규 테이블', f: '조합 근거 · 출처 URL', src: '구매 맥락 추출' },
  { t: 'ctx_claim', kind: '신규 테이블', f: '조건 심층 근거 (주장 · 지지/반박/중립 · 검토 수 · 신뢰도, ctx_claim_quote 포함)', src: '심층 근거 검증' },
  { t: 'ctx_research_run', kind: '신규 테이블', f: 'Admin 리서치 입력 · 탐색 화면 · 결과 지도 (wave · worker · log 포함)', src: 'judgment_change ctx_research 요청 처리' },
  { t: 'judgment_change', kind: '정의 변경', f: 'kind ctx_research 추가 (리서치 실행 요청, BE 쓰기)', src: 'app CHECK 제약에 값 추가' },
  { t: 'kpi_cell', kind: '신규 테이블', f: '선택 가속층 (kpi_cell · kpi_rollup · brand_cell · citation_cell · url_prompt_cell). 없으면 BE 가 사실에서 계산', src: '같은 build 의 사실 합계' },
];"""]
