"""v8 표 정의 패치 목록. (old, new[, count]). 5번째 열 요소(c[4])는 검증용 열 펼침 목록이다."""
C8 = "['cyc_key', 'run_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']"
C7 = "['cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']"
T5 = "['t_mention', 't_recommendation', 't_comparison', 't_definition', 't_final_choice']"

TABLE_PATCHES = [
    # ── 셀 키 열 수 표기 (build_id · population · surface · project · cyc · round_date · bucket_date · prompt · engine · geo · lang · bgrp = 12) ──
    ("['C', 'PF', '셀 키 11개', 'cell_key']", "['C', 'PF', '셀 키 12열', 'cell_key']", 4),
    ("pk: 'C(11) + ", "pk: 'C(12) + ", 3),
    ("pk: 'C(11)',", "pk: 'C(12)',"),

    # ── 공통 차원: 판정 정책 + cycle_pick_basis 신설 ──
    ("rules: ['servable · view_date · hidden_scope 는 조회 게이트라 BE 가 즉시 반영합니다.', '골드 집계는 회차 분석이 끝난 뒤 계산합니다 (20261015/D07).'] } });",
     "rules: ['servable · view_date · hidden_scope 는 조회 게이트입니다. release 를 거치지 않고 바뀐 즉시 보이며, 바뀌면 data_version 을 올립니다.', '골드 집계는 회차 분석이 끝난 뒤 계산합니다 (20261015/D07).'] } });\n"
     "tbl('cycle_pick_basis', { s: 'gold', name: 'cycle_pick_basis', fam: 'dim', grain: '회차 1개의 창 판정 근거', cols: [\n"
     "  ['cyc_key', 'PF', '', 'dim_cycle'], ['fleet_visible', '', '웹 함대 가시'], ['gap_ratio', '', '판정 갭 비율 numeric(6,5)'], ['gap_src', '', 'ops · hub'], ['ops_status', '', '이관 회차 운영 상태 (generating …)'], ['updated_at', '', ''] ], d: {\n"
     "  grain: '회차 1개 = 1행.', pk: 'cyc_key', inputs: '답변 정제 (회차 진행률) · 이관 회차 운영 원값', triggers: '회차 진행률 변경, 이관',\n"
     "  uses: '기간 선택 시 카드 동결 판정의 생성 대기 구멍(pick_holes): 닫힘 ∧ 원장 회차 ∧ 숨김 아님 ∧ (웹이면 fleet_visible) ∧ gap_ratio ≤ 0.05 ∧ ops_status ≠ generating ∧ 활성 발행 없음', cur: 'rd.cycle_pick_basis (열 전부)',\n"
     "  rules: ['이관 회차의 gap_ratio 는 현행 운영 원값(gap_src ops), 허브 회차는 허브 재계산값(gap_src hub)입니다.', '바뀌면 data_version 을 올립니다 (현행은 rcache 트리거).'] } });"),

    # ── 답변 사실: 좌표 열 펼침 · 버전 정책 ──
    ("['answer_key', 'PK', 'int4'], ['job_id', 'UK', 'uuid'], ['run_key', '', ''], ['C 좌표', 'FK', 'cyc·prompt·project·engine·geo·lang·bgrp', 'cell_key'], ['surface · round_date', '', ''], ['measured_at', '', '측정 시각'],\n"
     "  ['status_code', '', '0 완료 · 1 대기·실행 · 2 실패'], ['analysis_code', '', ''], ['dropped · served', '', ''], ['build_id', 'FK', '', 'build'] ], d: {",
     "['answer_key', 'PK', 'int4'], ['job_id', 'UK', 'uuid'], ['run_key', '', ''], ['C 좌표', 'FK', 'cyc·prompt·project·engine·geo·lang·bgrp', 'cell_key', " + C7 + "], ['surface · round_date', '', ''], ['measured_at', '', '측정 시각'],\n"
     "  ['status_code', '', '0 완료 · 1 대기·실행 · 2 실패'], ['analysis_code', '', ''], ['dropped · served', '', ''], ['last_build_id', 'FK', '마지막 반영 build (현행 load_id)', 'build'] ], d: {"),
    ("rules: ['served = 완료 ∧ 드롭 아님. answer_fact 는 served job 만 가집니다.', 'job_id ↔ answer_key 해석과 접근 범위 검사(fail-closed)가 이 테이블을 거칩니다.'] } });",
     "rules: ['served = 완료 ∧ 드롭 아님. answer_fact 는 served job 만 가집니다.', 'job_id ↔ answer_key 해석과 접근 범위 검사(fail-closed)가 이 테이블을 거칩니다.', 'build 로 나누지 않는 현재 상태 원장입니다. 대기·실행·실패가 build 없이 바로 보여야 해서 release 밖에 두고, 바뀌면 data_version 을 올립니다.'] } });"),
    ("['C 좌표', 'FK', 'cyc·run·prompt·project·engine·geo·lang·bgrp', 'cell_key'],",
     "['C 좌표', 'FK', 'cyc·run·prompt·project·engine·geo·lang·bgrp', 'cell_key', " + C8 + "],"),
    ("['cit_own_{h,k,g}[c] · cit_own_x', '', '글로벌 자사'],",
     "['cit_own_{h,k,g}[c] · cit_own_x', '', '글로벌 자사', '', ['cit_own_h', 'cit_own_k', 'cit_own_g', 'cit_own_hc', 'cit_own_kc', 'cit_own_gc', 'cit_own_x']],"),
    ("['competitive', 'PK', '경쟁 행'], ['C 좌표 사본', 'FK', '', 'cell_key'],",
     "['competitive', 'PK', '경쟁 행'], ['C 좌표 사본', 'FK', '', 'cell_key', " + C7 + "],"),
    ("['first_pos', '', '텍스트 첫 등장 · 신규'], ['s_pos · s_neu · s_neg · s_mix', '', ''], ['t_mention … t_final_choice', '', '유형 5종'],",
     "['first_pos', '', '텍스트 첫 등장 · 신규'], ['s_pos · s_neu · s_neg · s_mix', '', ''], ['t_mention … t_final_choice', '', '유형 5종', '', " + T5 + "],"),
    ("['source_key', 'FK', '', 'dim_source'], ['C 좌표 사본', 'FK', '', 'cell_key'],",
     "['source_key', 'FK', '', 'dim_source'], ['C 좌표 사본', 'FK', '', 'cell_key', " + C7 + "],"),

    # ── 차원 열 보강 (현행 열 전부) ──
    ("['kind', '', '0 ~ 3'], ['own_bit', '', '0 · 1 · 2 · 4']], d: {", "['kind', '', '0 ~ 3'], ['own_bit', '', '0 · 1 · 2 · 4'], ['first_seen', '', '처음 관측']], d: {"),
    ("['rep_name', '', '대표 표시명'], ['brand_key', 'FK', '', 'dim_brand']], d: {", "['rep_name', '', '대표 표시명'], ['brand_key', 'FK', '', 'dim_brand'], ['first_seen', '', '처음 관측']], d: {"),
    ("['owned_brand_bit', '', '당사 공식 도메인'], ['competitor_brand_key', 'FK', '', 'dim_brand'] ], d: {",
     "['owned_brand_bit', '', '당사 공식 도메인'], ['competitor_brand_key', 'FK', '', 'dim_brand'], ['rule_ver', '', ''] ], d: {"),
    ("['source_key', 'FK', '', 'dim_source'], ['owner_key', 'FK', '', 'owned_base'] ], d: {",
     "['source_key', 'FK', '', 'dim_source'], ['owner_key', 'FK', '', 'owned_base'], ['rule_ver', '', ''] ], d: {"),

    # ── 카탈로그 행: build 버전 ──
    ("tbl('catalog_entry', { s: 'gold', name: 'catalog_entry', fam: 'prompt', grain: '카탈로그 행 1개 (삭제 포함)', cols: [\n  ['catalog_row_id', 'PK', 'uuid'],",
     "tbl('catalog_entry', { s: 'gold', name: 'catalog_entry', fam: 'prompt', grain: '빌드 × 카탈로그 행 (삭제 포함)', cols: [\n  ['catalog_row_id', 'PK', 'uuid'],"),
    ("['depth1~3_key', 'FK', '', 'dim_taxon'], ['build_id', 'FK', '현행 load_id', 'build'] ], d: {\n  grain: '카탈로그 행 1개 = 1행. 한 프롬프트에 여러 행이 붙을 수 있습니다.', pk: 'catalog_row_id',",
     "['depth1~3_key', 'FK', '', 'dim_taxon'], ['build_id', 'PF', '현행 load_id', 'build'] ], d: {\n  grain: '빌드 × 카탈로그 행 1개 = 1행. 한 프롬프트에 여러 행이 붙을 수 있습니다.', pk: 'build_id + catalog_row_id',"),

    # ── ACR 좌표 펼침 + rule_ver ──
    ("['build_id', 'PF', '', 'build'], ['acr_cell_key', 'PK', 'ACR 셀'], ['C 좌표', 'FK', '', 'cell_key'], ['round_date · measured_date', '', ''], ['cat_mask', '', ''], ['planned · valid_turn1 · valid_acr', '', '반복 모수'],\n"
     "  ['co_single · co_conditional · co_generic', '', '결과 유형'], ['co_off_shortlist · co_unresolved · co_none', '', ''], ['is_rep · acr_in', '', ''] ], d: {",
     "['build_id', 'PF', '', 'build'], ['acr_cell_key', 'PK', 'ACR 셀'], ['C 좌표', 'FK', 'surface 포함', 'cell_key', ['surface', 'cyc_key', 'prompt_key', 'project_key', 'engine_key', 'geo_key', 'lang_key', 'bgrp']], ['round_date · measured_date', '', ''], ['cat_mask', '', ''], ['planned · valid_turn1 · valid_acr', '', '반복 모수'],\n"
     "  ['co_single · co_conditional · co_generic', '', '결과 유형'], ['co_off_shortlist · co_unresolved · co_none', '', ''], ['is_rep · acr_in', '', ''], ['rule_ver', '', ''] ], d: {"),

    # ── GA4 · 키워드 열 보강 (현행 그대로) ──
    ("['status', '', 'active · pending_grant · unmapped'], ['source', '', 'registry · override · env']], d: {",
     "['status', '', 'active · pending_grant · unmapped'], ['source', '', 'registry · override · env'], ['conv_basis', '', '적재된 전환 기준: 1 key events 폴백 · 2 추적 이벤트']], d: {"),
    ("['search_volume', '', ''], ['competition_index · cpc', '', ''], ['call_id', '', '수집 호출'], ['observed_at', '', '']], d: {",
     "['search_volume', '', ''], ['competition · competition_index · cpc', '', 'LOW·MEDIUM·HIGH 라벨 · 지수 · CPC'], ['call_id', '', '수집 호출'], ['observed_at', '', '']], d: {"),
    ("['search_volume · intent', '', ''], ['is_seed · observed_at', '', '7일 신선도']], d: {",
     "['search_volume · intent', '', ''], ['total_count', '', '호출 단위 연관어 총수 (BG-39)'], ['is_seed · observed_at', '', '7일 신선도']], d: {"),

    # ── 현행 열 이름 그대로 (개명 금지) ──
    ("['type', '', 'Context · Requirement'], ['canonical_name', '', ''], ['dimension', '', '관점'], ['mention_count · utterance_count', '', ''], ['sentiment_pos · neg · neu', '', '']], d: {",
     "['type', '', 'ConsumerContext · ConsumerRequirement'], ['canonical_name', '', ''], ['dimension', '', '테마·카테고리 코드'], ['mention_count · utterance_count', '', ''], ['sentiment_positive · sentiment_negative · sentiment_neutral', '', '']], d: {"),
    ("['sentiment_pos · neu · neg · mixed', '', ''], ['type_mention … type_final_choice', '', '']], d: {",
     "['sentiment_positive · sentiment_neutral · sentiment_negative · sentiment_mixed', '', ''], ['type_mention … type_final_choice', '', '유형 5종', '', ['type_mention', 'type_recommendation', 'type_comparison', 'type_definition', 'type_final_choice']]], d: {"),
    ("['pin/drop_source_measured_at', '', '']", "['{pin,drop}_source_measured_at', '', '']"),
    ("tbl('entity_mention_total', { s: 'gold', name: 'entity_mention_total', fam: 'kpi', grain: '엔티티 전 기간 합계', cols: [['entity_key', 'PF', '', 'dim_entity'],",
     "tbl('entity_mention_total', { s: 'gold', name: 'entity_mention_total', fam: 'kpi', grain: '엔티티 전 기간 합계', cols: [['entity_id', 'PF', 'dim_entity.entity_id (UK)', 'dim_entity'],"),
    ("grain: '엔티티 1개의 전 기간 합계 = 1행. 기간·게이트 없이 드롭 답변만 뺍니다.', pk: 'entity_key',",
     "grain: '엔티티 1개의 전 기간 합계 = 1행. 기간·게이트 없이 드롭 답변만 뺍니다.', pk: 'entity_id',"),
    ("['prev_*', '', '전 회차 4종']", "['prev_*', '', '전 회차 4종', '', ['prev_target_hit_prompts', 'prev_measured_prompts', 'prev_owned_prompts', 'prev_owned_prompts_den']]"),

    # ── 발행 세대: 현행 frz 열 이름(gen_key) + ops 원값 열 ──
    ("pub_key", "gen_key", 13),
    ("['gen_key', 'PK', ''], ['cyc_key', 'FK', '', 'dim_cycle'], ['surface', '', 'global · website'], ['source', '', 'ops 이관 · hub 발행'], ['state', '', 'building · active · retired'], ['build_id', 'FK', '고정한 사실 build', 'build'],\n"
     "  ['judgment', '', '판정 입력 버전'], ['row_counts · verify', '', ''], ['created_at · activated_at · retired_at', '', ''] ], d: {",
     "['gen_key', 'PK', '현행 frz.generation.gen_key'], ['cyc_key', 'FK', '', 'dim_cycle'], ['surface', '', 'global · website'], ['source', '', 'ops 이관 · hub 발행'], ['state', '', 'building · active · retired'], ['build_id', 'FK', '고정한 사실 build', 'build'],\n"
     "  ['ops_cycle_id · ops_generation_id · ops_generator_version', '', 'ops 이관 세대 원값'], ['ops_started_at · ops_finished_at', '', ''], ['judgment', '', '판정 입력 버전'], ['row_counts · verify', '', ''], ['created_at · activated_at · retired_at · retired_reason', '', ''] ], d: {"),
    ("rules: ['build_id 로 발행 시점 사실 build 를 고정합니다. 발행 뒤 재판정은 새 build 로만 들어가 카드 값이 바뀌지 않습니다.', '활성 발행이 참조하는 build 는 지우지 않습니다.'] } });",
     "rules: ['build_id 로 발행 시점 사실 build 를 고정합니다. 발행 뒤 재판정은 새 build 로만 들어가 카드 값이 바뀌지 않습니다.', '활성 발행이 참조하는 build 는 지우지 않습니다.', 'ops 이관 세대(source ops)도 운영 원값을 담은 build 를 하나 만들어 build_id 로 가리킵니다 (현행 frz.keep_* · keep_fold 보관 행 대체).', '고정 build 는 발행 당시 규칙 서명(profile_signature)으로 만든 것이어야 합니다.'] } });"),
    ("['funnel · presence · list_type · depth1~3', '', '']", "['funnel_key · presence_key · list_type_key · depth1~3_key', '', '동결 택소노미']"),

    # ── 공개 포인터: 현행 surface_generation 열 보존 ──
    ("['scope', 'PK', '공개 범위'], ['release_id', 'FK', '', 'release'], ['version', '', '캐시 데이터 버전']], d: {",
     "['scope', 'PK', '공개 범위 (LIVE = surface)'], ['release_id', 'FK', '', 'release'], ['version', '', '데이터 버전 (현행 generation)'], ['last_build_id', 'FK', '현행 last_load_id', 'build'], ['rule_ver · as_of · updated_at', '', '']], d: {"),
    ("cur: 'rd.surface_generation (표면별 데이터 버전)',", "cur: 'rd.surface_generation (surface → scope, generation → version, last_load_id → last_build_id)',"),

    # ── 참조 플래그 · FK 대상 정정 ──
    ("cols: [['acr_cell_key', 'PK', '', 'acr_cell_fact'],", "cols: [['acr_cell_key', 'PF', '셀 식별자 (build 무관)', 'acr_cell_fact'],"),
    ("cols: [['entity_id', 'PK', '', 'dim_entity'], ['run_month', 'PK', ''],", "cols: [['entity_id', 'PF', 'dim_entity.entity_id (UK)', 'dim_entity'], ['run_month', 'PK', ''],"),

    # ── build 목록 정정 · data_version 신설 ──
    ("['build_id', 'FK', '모든 사실·셀 공통', 'build'], ['job_index · answer_fact', '', ''],", "['build_id', 'FK', '모든 사실·셀 공통', 'build'], ['answer_fact', '', ''],"),
    ("tbl('release', { s: 'gold', name: 'release',",
     "tbl('data_version', { s: 'gold', name: 'data_version', fam: 'build', grain: 'release 밖 데이터의 버전', cols: [['scope', 'PK', 'dim · cycle · job · catalog_raw · ga4 · kw · soc …'], ['version', '', 'bigint, 쓸 때마다 +1'], ['changed_at', '', '']], d: {\n"
     "  grain: '버전 범위 1개 = 1행.', pk: 'scope', inputs: '데이터 분석팀의 모든 gold 쓰기', triggers: 'release 를 거치지 않는 gold 테이블을 쓴 트랜잭션 안에서 함께 증가',\n"
     "  uses: 'BE 결과 캐시 키 = active_release.version + data_version. 현행 rcache 트리거(rd 차원·cycle·cycle_pick_basis·catalog_entry·web_*·entity_mention_total·report_unit_value) 대체', cur: '현행 rcache.tg_bump 트리거 (rd 쓰기 시 캐시 버전 증가)',\n"
     "  rules: ['차원·회차·job·답변 원문·GA4·키워드·소셜처럼 build 로 나누지 않는 테이블은 쓸 때 해당 scope 의 version 을 반드시 올립니다.', '올리지 않으면 BE 캐시가 낡은 값을 계속 냅니다.'] } });\n"
     "tbl('release', { s: 'gold', name: 'release',"),

    # ── 탭 메모 정정 ──
    ("SERP 와 연관 검색어는 집계 없이 serve 뷰로 나갑니다.", "SERP 와 연관 검색어는 집계 없이 그대로 화면에 나갑니다."),
    ("note: '셀 집계가 공유하는 키 묶음(C)과 공통 차원입니다. 정수 키는 현행 rd 처럼 발급 원장이고 재번호하지 않습니다.',",
     "note: '셀 집계가 공유하는 키 묶음(C)과 공통 차원입니다. 정수 키는 현행 rd 처럼 발급 원장이고 재번호하지 않습니다. 차원은 build 로 나누지 않는 현재값이고(현행 rd 와 같음), 바뀌면 data_version 을 올립니다.',"),
    ("dim_country: [620, 262, 220], dim_lang: [620, 442, 220], dim_region: [890, 290, 180] },",
     "dim_country: [620, 262, 220], dim_lang: [620, 442, 220], dim_region: [890, 290, 180], cycle_pick_basis: [320, 440, 240] },"),
    ("build: [370, 20, 260], release_item: [690, 20, 210], release: [960, 20, 190], active_release: [960, 190, 190] } },",
     "build: [370, 20, 260], release_item: [690, 20, 210], release: [960, 20, 190], active_release: [960, 190, 190], data_version: [690, 230, 210] } },"),
]

RENDER_PATCHES = [
    ("const PREFIX = { gold: 'gold.', app: 'app.', silver: 'serve.' };", "const PREFIX = { gold: 'gold.', app: 'app.' };"),
    ("'키 11개 · 공통 차원 탭'", "'키 12열 · 공통 차원 탭'"),
    ("silver: 'serve 뷰', key: '키 묶음'", "silver: '답변 원문 뷰', key: '키 묶음'"),
    ("'ecat_apply', 'ecat_review', 'ecat_audit_log'] },", "'ecat_apply', 'ecat_review', 'ecat_audit_log', 'ecat_alias_active', 'ecat_registry_active'] },"),
    ("캐시 키의 데이터 버전을 지금은 rd.surface_generation 에서, 골드에서는 gold.active_release.version 에서 받습니다.",
     "캐시 키의 데이터 버전을 지금은 rd.surface_generation 과 rcache 트리거에서, 골드에서는 gold.active_release.version 과 gold.data_version 에서 받습니다."),
    ("desc: '화면이 읽는 데이터 전부입니다. ERD 탭 11개(공통 차원 ~ 빌드·릴리스)가 모두 이 스키마에 들어가고,",
     "desc: `화면이 읽는 데이터 전부입니다. ERD 탭 ${VIEWS.filter(v => v.g !== 'app').length}개가 모두 이 스키마에 들어가고,"),
    ("계열 구분은 테이블 이름 접두어(dim_ · *_fact · *_cell · pub_ · ga4_ · kw_ · ctx_)로 합니다.',",
     "계열 구분은 테이블 이름 접두어(dim_ · *_fact · *_cell · pub_ · ga4_ · kw_ · ctx_ · page_ · vis_)로 합니다.`,"),
    ("rules: ['골드 전환 뒤 캐시 무효화는 active_release.version 변경을 기준으로 합니다.'] },",
     "rules: ['골드 전환 뒤 캐시 무효화는 active_release.version 과 data_version 변경을 기준으로 합니다.'] },"),
]
