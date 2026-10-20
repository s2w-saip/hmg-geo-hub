"""화면 항목 수동 매핑 (gen_data.py 가 읽음).

MANUAL[(route('/ko' 뺌), label)] · TECH[label](화면 밖). 값 필드:
  src  static · client · front · none (API 매칭 항목에 넣으면 src 를 주지 않아 'api' 로 남고 g 만 더해진다)
  g    골드 참조 'table' 또는 'table.col'      a  app 테이블      w  judgment_change kind
  ui   같은 라우트의 원 항목 label (화면 자료 내보내기 · 조작)      none  데이터가 필요 없는 사유      note  페이지 표시 메모
근거(front 파일:줄)는 검토/manual.json 원장에 있다.
"""

# ── 공통 묶음 ──────────────────────────────────────────────────────────────
VIS_XY = ['page_visibility_daily.url_key', 'page_visibility_daily.seo_impressions', 'page_visibility_daily.ai_crawls']
VIS_CARD = {'src': 'static', 'g': VIS_XY,
            'note': '현행 카드 수는 페이지 목록과 무관한 상수 · 골드는 필터 후 기간 합의 중앙값으로 BE 가 분면 판정'}
VIS_SCATTER = {'src': 'static', 'g': VIS_XY, 'note': '중앙값 선 = 정렬 후 floor(n/2) 번째 값'}
VIS_TABLE = {'src': 'static', 'g': ['dim_url.url'] + VIS_XY + ['page_priority.priority'],
             'note': '현행 분면 · 우선순위는 픽스처 값 (산정 규칙 없음) · 골드: 분면은 BE 계산, 우선순위는 page_priority'}

ACR_OWN = ['acr_entity_fact.own_bit']
ACR = {
    'top1': {'src': 'static', 'g': ['acr_entity_fact.choice', 'acr_cell_fact.valid_acr'] + ACR_OWN,
             'note': '당사 Σchoice ÷ Σvalid_acr (Global ACR 과 같은 식)'},
    'top5': {'src': 'static', 'g': ['acr_entity_fact.acr_cell_key', 'acr_cell_fact.acr_cell_key'] + ACR_OWN,
             'note': '후보군 포함율 = 당사 등장 셀 ÷ 전체 셀 (Global ACR 과 같은 식)'},
    'answers': {'src': 'static', 'g': ['acr_cell_fact.valid_acr'], 'note': '= Σvalid_acr (Global ACR 답변 수 카드와 같음)'},
    'rank1': {'src': 'static', 'g': ['acr_entity_fact.choice'] + ACR_OWN},
    'trend': {'src': 'static', 'g': ['acr_cell_fact.round_date', 'acr_cell_fact.valid_acr', 'acr_entity_fact.choice',
                                     'acr_entity_fact.brand_key', 'dim_brand.name'] + ACR_OWN},
    'battle': {'src': 'static', 'g': ['acr_cell_fact.prompt_key', 'acr_cell_fact.engine_key', 'dim_prompt.text', 'acr_entity_fact.choice',
                                      'acr_entity_fact.brand_key', 'dim_brand.name'] + ACR_OWN,
               'note': '칸 = (프롬프트 × 엔진) 선택 수 최다 브랜드'},
    'model': {'src': 'static', 'g': ['acr_iter_shortlist.entity_key', 'acr_iter_shortlist.parent_brand_key', 'acr_iter_shortlist.is_choice',
                                     'dim_entity.rep_name', 'dim_brand.name', 'dim_brand.own_bit'],
              'note': '후보군 등장 = 후보에 오른 반복 수 (픽스처 정의) · Global ACR 은 등장 셀 수'},
    'territory': {'src': 'static', 'g': ['acr_cell_fact.lang_key', 'acr_cell_fact.engine_key', 'acr_cell_fact.prompt_key', 'dim_prompt.text',
                                         'acr_iter_fact.iter_no', 'acr_iter_fact.winner_brand_key', 'dim_brand.name'],
                  'note': '시트 = 언어 × 엔진, 칸 = 반복별 1위 브랜드 (0 = 선택 없음)'},
}

# 소셜 표 뷰 (Global 표 탭 · Admin 리서치 카드가 같은 ContextMapView · 같은 픽스처)
SOC_SENT = ['ctx_entity.sentiment_positive', 'ctx_entity.sentiment_negative', 'ctx_entity.sentiment_neutral']
SOC_TABLE = {
    '구매 맥락 수': {'src': 'static', 'g': ['ctx_entity.type'], 'note': 'type = ConsumerContext 행 수'},
    '구매 조건 수': {'src': 'static', 'g': ['ctx_entity.type'], 'note': 'type = ConsumerRequirement 행 수'},
    '관계 수': {'src': 'static', 'g': ['ctx_drive', 'ctx_combination'], 'note': '맥락→조건 연결 수 + 조합 수'},
    '출처 도메인 수': {'src': 'static', 'g': ['ctx_domain.host'], 'note': '고유 host 수'},
    '구매 맥락 표': {'src': 'static', 'g': ['ctx_entity.canonical_name', 'ctx_entity.group_id', 'ctx_group.name'] + SOC_SENT
                    + ['ctx_drive.context_id', 'ctx_entity.mention_count'],
                    'note': "'감성' 열 = sentiment_* (Project 소셜 화면과 같음)"},
    '구매 조건 표': {'src': 'static', 'g': ['ctx_entity.canonical_name', 'ctx_entity.group_id', 'ctx_group.name'] + SOC_SENT
                    + ['ctx_drive.requirement_id', 'ctx_entity.mention_count'],
                    'note': "'감성' 열 = sentiment_* (Project 소셜 화면과 같음)"},
    '조합 패턴 표': {'src': 'static', 'g': ['ctx_combination.cond_a', 'ctx_combination.cond_b', 'ctx_entity.canonical_name', 'ctx_combination.co_count'],
                    'note': '빈도 강 · 중 · 약 = co_count ÷ 스냅샷 최대 구간 (Project 소셜 BE 와 같음)'},
}
SOC_EXPORT = {'src': 'client', 'ui': '구매 맥락 표', 'note': '구매 맥락 · 구매 조건 · 조합 패턴 3시트 = 세 표의 전체 행'}

# GA4 전환: 레거시 분모 = 활성 사용자, API 경로 = 세션 (DC-03)
U = ['ga4_users_window.users', 'ga4_users_window.cohort']
CONV_CARD = {'g': U, 'note': '레거시 분모 = 기간 활성 사용자 (API 경로는 세션, DC-03)'}
CONV_TREND = {'g': U + ['ga4_users_window.window_days'], 'note': '레거시 분모 = 일별 활성 사용자 (API 경로는 세션, DC-03)'}
CONV_ENGINE = {'g': U + ['ga4_users_window.engine_mask'], 'note': '레거시 분모 = 엔진별 활성 사용자 (API 경로는 세션, DC-03)'}
CONV_LOWSAMPLE = {'g': U + ['ga4_users_window.engine_mask'], 'note': '레거시 기준 = 엔진별 활성 사용자 50 미만 (API 경로는 세션, DC-03)'}
CONV_COUNTRY = {'g': U + ['ga4_users_window.prop_key'], 'note': '레거시 분모 = 시장(속성)별 활성 사용자 (API 경로는 세션, DC-03)'}
CONV_ROLLUP = {'g': U + ['ga4_users_window.prop_key'], 'note': '레거시 분모 = 시장별 활성 사용자 합 (API 경로는 세션, DC-03)'}
CONV_PAGES = {'g': U + ['ga4_users_window.page_key'],
              'note': '레거시 = AI 사용자 상위 12 페이지 · AI · 일반 사용자 열 (API 경로는 세션, DC-03)'}
VISIT_HIDDEN = 'API 경로는 users 가 없어 숨김 (U8-N4) — 골드로 채움'
VISITS = {
    'AI 유입 사이트 방문 수 · 순 방문자 카드': {'g': ['ga4_users_window.users'], 'note': VISIT_HIDDEN},
    'AI 유입 사이트 방문 수 · 방문 빈도 카드': {'g': ['ga4_users_window.users'], 'note': '방문 빈도 = 세션 ÷ 순 방문자 · ' + VISIT_HIDDEN},
    '입구 페이지별 방문 표': {'g': ['ga4_users_window.users', 'ga4_users_window.page_key'], 'note': '사용자 열 · ' + VISIT_HIDDEN},
}

MANUAL = {}

# ── AI Visibility (Global · Project 공통 VisibilityView, 정적 표본) ─────────
for r in ('/standard/ai-funnel/visibility', '/projects/[id]/ai-funnel/visibility'):
    for l in ('우수 페이지 카드', 'AI 노출 보강 카드', '검색 보강 카드', '우선순위 낮음 카드'):
        MANUAL[(r, l)] = VIS_CARD
    MANUAL[(r, '4분면 산점도 (분위수 기반)')] = VIS_SCATTER
MANUAL[('/standard/ai-funnel/visibility', '페이지 진단 표')] = VIS_TABLE
MANUAL[('/projects/[id]/ai-funnel/visibility', '페이지 진단 표 (정렬)')] = VIS_TABLE
MANUAL[('/projects/[id]/ai-funnel/visibility', '필터바 (정적 옵션)')] = {
    'src': 'static',
    'g': ['page_visibility_daily.date', 'page_crawl_daily.bot_key', 'dim_crawl_bot.engine_key', 'citation_fact.url_key', 'citation_fact.prompt_key',
          'dim_prompt.prompt_id', 'answer_brand_fact.brand_key', 'dim_url.source_key', 'dim_source.category_key', 'page_seo_device_daily.device_key',
          'ga4_value.url_key', 'ga4_row.nvr_key'],
    'a': ['prompt'],
    'note': '국가는 잠금 칩 · 프롬프트 택소노미 축 = 프로젝트 app.prompt 열 (인용 답변의 프롬프트)',
}

# ── ACR (Website · Project 공통 AcrView, 정적 표본) ──────────────────────────
MANUAL[('/website/ai-funnel/acr', '브랜드별 ACR 표')] = {
    'src': 'static', 'g': ['dim_brand.name', 'acr_entity_fact.choice', 'acr_cell_fact.valid_acr', 'acr_entity_fact.acr_cell_key', 'acr_cell_fact.acr_cell_key'] + ACR_OWN,
    'note': '화면은 브랜드 필 (Top1 · Top5) · 식은 Global ACR 과 같음'}
for r, labels in (('/website/ai-funnel/acr', ('Top1 ACR 카드', 'Top5 ACR 카드', '답변 수 카드', '1순위 횟수 카드', '선택률 추이 차트', '모델별 선택 구도 표',
                                              '차종별 선택 전환율 표', '모델별 점유 맵')),
                  ('/projects/[id]/ai-funnel/acr', ('Top1 ACR 카드', 'Top5 ACR 카드', '답변 수 카드', '1순위 횟수 카드', '선택률 추이 — 우리 브랜드 vs 주요 경쟁사',
                                                    '모델별 선택 구도 (시트 탭)', '차종별 선택 전환율 표', '모델별 점유 맵'))):
    for l, k in zip(labels, ('top1', 'top5', 'answers', 'rank1', 'trend', 'battle', 'model', 'territory')):
        MANUAL[(r, l)] = ACR[k]
MANUAL[('/projects/[id]/ai-funnel/acr', '필터바 (정적 옵션)')] = {
    'src': 'static', 'g': ['acr_cell_fact.round_date', 'acr_cell_fact.lang_key', 'acr_cell_fact.engine_key', 'acr_cell_fact.prompt_key', 'dim_prompt.prompt_id'],
    'a': ['prompt'],
    'note': '국가는 잠금 칩 · 택소노미 축 = 프로젝트 app.prompt 열 · 출처 · 경쟁사 · 기기 · 방문자 유형 축은 ACR 에 없음 (BE ACR 도 미지원)'}

# ── 화면 자료 내보내기 ──────────────────────────────────────────────────────
MANUAL[('/website/answer-analysis/mention', '브랜드 순위 엑셀 다운로드')] = {'src': 'client', 'ui': '브랜드 언급 순위표', 'note': '검색 · 정렬 후 표 행 그대로'}
MANUAL[('/projects/[id]/analysis/mention', '엑셀 내보내기')] = {'src': 'client', 'ui': '브랜드 언급 순위표', 'note': '검색 · 정렬 후 표 행 그대로'}
MANUAL[('/admin/keyword-tools', '검색량 CSV 내보내기')] = {'src': 'client', 'ui': '검색량 결과 표', 'note': '표 행 그대로 (추이 열 제외)'}
MANUAL[('/admin/keyword-tools', '프롬프트 CSV 내보내기')] = {'src': 'client', 'ui': '생성 프롬프트 표(원 입력·질문·검색 의도·검색량)', 'note': '표 행 그대로'}

# ── 소셜: Global > Customer interest > Social Scraping (표 탭 · 그래프 탭 픽스처) ──
for l, v in SOC_TABLE.items():
    MANUAL[('/customer-interest/social-scraping', l)] = v
    MANUAL[('/admin/standards/customer-interest', l)] = v
MANUAL[('/customer-interest/social-scraping', '표 페이지 이동')] = {'src': 'client', 'ui': '구매 맥락 표', 'note': '세 표 공통 페이저 · 픽스처는 메모리 페이징'}
MANUAL[('/customer-interest/social-scraping', '상세 근거 인용')] = {
    'src': 'static', 'g': ['ctx_evidence.quote', 'ctx_evidence.source_title', 'ctx_evidence.source_url', 'ctx_evidence.rank']}
MANUAL[('/customer-interest/social-scraping', '소스 도메인 · 상세')] = {'src': 'static', 'g': ['ctx_domain.host', 'ctx_domain.n']}
MANUAL[('/customer-interest/social-scraping', '컨텍스트 노드 그래프')] = {
    'src': 'static',
    'g': ['ctx_snapshot.keyword', 'ctx_snapshot.worker_total', 'ctx_snapshot.source_total',
          'ctx_group.side', 'ctx_group.name', 'ctx_group.description', 'ctx_group.sort_order',
          'ctx_entity.canonical_name', 'ctx_entity.group_id', 'ctx_entity.mention_count', 'ctx_entity.unique_source_count',
          'ctx_entity.perspective_buyer', 'ctx_entity.perspective_seller', 'ctx_entity.perspective_neutral', 'ctx_entity.related_ids',
          'ctx_drive.strength_score', 'ctx_combination.combo_id', 'ctx_combination.cond_a', 'ctx_combination.cond_b', 'ctx_combination.cond_more',
          'ctx_combination.co_count', 'ctx_combination.total_speakers', 'ctx_combination.description',
          'ctx_combination.unique_source_count', 'ctx_combination_evidence.quote', 'ctx_combination_evidence.source_url',
          'ctx_combination_evidence.perspective', 'ctx_evidence.quote', 'ctx_evidence.source_title', 'ctx_evidence.source_url',
          'ctx_evidence.perspective', 'ctx_domain.host', 'ctx_domain.n',
          'ctx_claim.claim', 'ctx_claim.supporting', 'ctx_claim.contradicting', 'ctx_claim.neutral', 'ctx_claim.total_scanned', 'ctx_claim.confidence',
          'ctx_claim_quote.quote', 'ctx_claim_quote.source', 'ctx_claim_quote.stance'],
    'note': '그래프 탭은 표 탭과 다른 픽스처 (수치 다름) · 링 · 막대 = 관점 perspective_* · m/w 클러스터 = mention_count / worker_total · '
            '중첩률 · 근거 문구 = co_count ÷ total_speakers (BE 생성)'}
MANUAL[('/customer-interest/social-scraping', '감성 필터')] = {
    'src': 'static', 'g': ['ctx_entity.perspective_buyer', 'ctx_entity.perspective_seller', 'ctx_entity.perspective_neutral'],
    'note': "화면 라벨은 '관점' (구매자 · 판매자 · 중립) · 사이드바 목록만 거름"}
MANUAL[('/customer-interest/social-scraping', '그래프 물리 설정')] = {'src': 'client', 'ui': '컨텍스트 노드 그래프', 'note': '배치 · 카메라만 바꿈'}
MANUAL[('/customer-interest/social-scraping', 'Excel 내보내기(픽스처를 브라우저에서 워크북 생성)')] = SOC_EXPORT

# ── 소셜: Admin > 고객 관심 기준 (소셜 리서치 카드) ──────────────────────────
MANUAL[('/admin/standards/customer-interest', '리서치 입력 폼')] = {
    'src': 'static', 'g': ['ctx_research_run.keyword', 'ctx_research_run.geo_key', 'ctx_research_run.lang_key',
                           'ctx_research_run.purpose_preset', 'ctx_research_run.purpose_text'],
    'a': ['judgment_change'], 'w': ['ctx_research'],
    'note': '현행은 keyword 만 넘기고 지역 · 목적은 버림, 저장 없음'}
MANUAL[('/admin/standards/customer-interest', '리서치 탐색 화면')] = {
    'src': 'static', 'g': ['ctx_research_run.search_count', 'ctx_research_wave.wave_no', 'ctx_research_wave.strategy',
                           'ctx_research_worker.label', 'ctx_research_worker.query', 'ctx_research_worker.status', 'ctx_research_worker.source_count',
                           'ctx_research_log.kind', 'ctx_research_log.title', 'ctx_research_log.detail'],
    'note': '현행은 스크립트 픽스처 재생'}
MANUAL[('/admin/standards/customer-interest', '컨텍스트 노드 그래프')] = {
    'src': 'none', 'none': '이 화면에는 그래프가 없음 (표 뷰만 렌더)'}
MANUAL[('/admin/standards/customer-interest', "후보 '전송'")] = {
    'src': 'static', 'a': ['prompt'],
    'note': '현행 데모 토스트 · 쓰기 없음 · 대상 = 글로벌 카탈로그 (app.prompt 표준 루트)'}
MANUAL[('/admin/standards/customer-interest', '맥락 지도 xlsx 내보내기(샘플, 브라우저 생성)')] = SOC_EXPORT

# ── 접근 불가 ───────────────────────────────────────────────────────────────
MANUAL[('/no-access', '접근 불가 안내')] = {'src': 'front', 'a': ['user_account'], 'note': '정적 안내 · 진입 = (dash) 레이아웃의 role · menu_groups 판정'}
MANUAL[('/no-access', '로그아웃 버튼')] = {'src': 'none', 'none': '인증 서비스(Supabase) 로그아웃 — 데이터 요구 없음'}

# ── API 매칭 항목의 골드 보강 ──────────────────────────────────────────────
for r in ('/standard/ai-funnel/conversion', '/website/ai-funnel/conversion', '/projects/[id]/ai-funnel/conversion'):
    for l, v in VISITS.items():
        MANUAL[(r, l)] = v
    for l in ('AI 유입 전환율 카드', '일반 유입 전환율 카드', '전환 격차 카드'):
        MANUAL[(r, l)] = CONV_CARD
    MANUAL[(r, '전환율 추이')] = CONV_TREND
MANUAL[('/standard/ai-funnel/conversion', 'ChatGPT 전환 카드')] = CONV_ENGINE
MANUAL[('/standard/ai-funnel/conversion', 'Gemini 전환 카드')] = CONV_ENGINE
MANUAL[('/standard/ai-funnel/conversion', '표본 적음 배지')] = CONV_LOWSAMPLE
MANUAL[('/standard/ai-funnel/conversion', '국가별 AI 전환율 표')] = CONV_COUNTRY
MANUAL[('/website/ai-funnel/conversion', 'AI 모델(엔진)별 전환')] = CONV_ENGINE
MANUAL[('/website/ai-funnel/conversion', '국가별 AI 전환율 표')] = CONV_COUNTRY
for l in ('권역·본사 · AI 유입 전환율 카드', '권역·본사 · 일반 유입 전환율 카드', '권역·본사 · 전환 격차 카드'):
    MANUAL[('/website/ai-funnel/conversion', l)] = CONV_ROLLUP
MANUAL[('/projects/[id]/ai-funnel/conversion', 'AI 모델(엔진)별 전환')] = CONV_ENGINE
MANUAL[('/projects/[id]/ai-funnel/conversion', '표본 적음 배지')] = CONV_LOWSAMPLE
MANUAL[('/standard/ai-funnel/conversion', '페이지별 전환 표')] = CONV_PAGES
MANUAL[('/website/ai-funnel/conversion', '입구 페이지별 전환 표')] = CONV_PAGES
MANUAL[('/projects/[id]/ai-funnel/conversion', '페이지별 전환 표 · 상위 12, 정렬')] = CONV_PAGES
MANUAL[('/projects/[id]', 'AI 유입 전환율 카드')] = {'g': U, 'note': '레거시 분모 = 28일 활성 사용자 (API 경로는 세션, DC-03)'}
MANUAL[('/dashboard', '국가별 GEO 현황')] = {
    'g': ['answer_fact.own_fp_h', 'answer_fact.own_fp_k', 'answer_fact.own_fp_g', 'answer_brand_fact.first_pos'],
    'note': '우선 노출도: 레거시 = 답변 텍스트상 첫 등장 순서, 현행 = 경쟁 순위 (rd 에 첫 등장 열 없음)'}

# ── 화면 밖 (TECH, label 로 키) ────────────────────────────────────────────
TECH = {
    '/api/cron/sync-mirror — 회차 관제 → 미러 동기화 → 전 캐시 무효화 → 감시 2종·앵커 따라잡기': {
        'src': 'front', 'g': ['dim_cycle', 'job_index', 'answer_fact.cyc_key', 'answer_fact.anchor_date', 'data_version.version'],
        'note': '회차 관제 · 미러 동기화 · 앵커 따라잡기는 데이터 분석팀 적재로 이동 · 변경 신호 = data_version'},
    '/api/cron/ga4-prebuild — GA4 KPI 28d·Live 90d 캐시 워밍 + 회차 사슬 교차 확인': {
        'src': 'front', 'g': ['ga4_property', 'ga4_row', 'ga4_users_window', 'dim_cycle.status', 'dim_cycle.view_date', 'publication.state'],
        'note': 'GA4 값은 골드에 적재 — 캐시 워밍 불필요 · 교차 확인 = 노출 지체 · 생성 적체'},
    '/api/cron/cycle-chain-watch — 노출 지체·생성 적체·URL 인용률 사실표 누락·앵커 공백 감시 → Slack/Issue': {
        'src': 'front', 'g': ['dim_cycle.status', 'dim_cycle.view_date', 'publication.state', 'pub_cell_web.url_owned_hit', 'pub_cell_web.url_target_hit',
                              'job_index.cyc_key'],
        'note': '감시 대상 = 회차 노출 · 발행 · 웹 URL 판정 · 답변 회차 귀속'},
    '/api/cron/mirror-status — 미러 누적·cadence 진단': {
        'src': 'front', 'g': ['job_index.measured_at', 'answer_mention_raw', 'answer_citation_raw'],
        'note': '운영자 수동 진단 (크론 미등록)'},
    '/api/internal/summary/published — 사실표 generation 스왑 후 캐시 무효화': {
        'src': 'front', 'g': ['active_release.version', 'data_version.version'],
        'note': '골드 공개 = active_release 전환 · 변경 신호 = active_release.version · data_version'},
    '미들웨어 — 크롤러 410·next-intl 로케일·Supabase 세션 갱신·로그인 게이트·x-pathname': {
        'src': 'none', 'none': 'Supabase 인증 세션 · 로케일 · 크롤러 차단 — 데이터 요구 없음'},
    '/api/scope/projects — scope 워크스페이스 프로젝트 목록 BFF': {'src': 'none', 'none': '호출 화면 없음 · 5a07a22 에서 삭제'},
    'app/api/citations/_lib/route.ts — 라우트 아님(_ 접두 비공개 폴더)': {'src': 'none', 'none': '라우트 아님 (인용 BFF 3개의 공용 게이트 모듈)'},
    'route.ts 31개 소유 맵(호출 화면)': {'src': 'none', 'none': '문서 항목 (라우트 소유 목록)'},
}
