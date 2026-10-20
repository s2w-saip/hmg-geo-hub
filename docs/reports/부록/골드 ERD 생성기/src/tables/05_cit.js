/* ── 인용 셀 ── */
tbl('citation_cell', { s: 'gold', name: 'citation_cell', fam: 'cit', grain: '셀 × 관점 × 출처 × 소유 · 가속', cols: [
  ['C', 'PF', '셀 키 12열', 'cell_key'], ['perspective_key', 'PF', '톤 · 유형 판정 관점', 'dim_perspective'], ['source_key', 'PF', '0 = 호스트 없음', 'dim_source'], ['owner_key', 'PF', '글로벌 자사 베이스 · 0 = 아님', 'dim_owned_base'], ['category_key', 'FK', '빌드 시점 유효 카테고리', 'dim_category'],
  ['loc_owned · tgt_hit', 'PK', '웹 · 프로젝트 자사 · 타겟 판정'], ['citations', '', '인용 원소 수'], ['source_first_count', '', 'Σsrc_first = 인용 답변 수'],
  ['cit_t_mention … cit_t_final_choice', '', '유형 신호 당사 답변의 인용', '', ['cit_t_mention', 'cit_t_recommendation', 'cit_t_comparison', 'cit_t_definition', 'cit_t_final_choice']], ['cit_pos · cit_neg', '', '긍정 · 부정 톤 답변의 인용'] ], d: {
  grain: '셀(C) × 관점 × 출처 × 소유 베이스 × 자사 · 타겟 판정 = 1행.', pk: 'C(12) + perspective_key + source_key + owner_key + loc_owned + tgt_hit',
  inputs: '데이터 분석팀 (출처 제안: 같은 build 의 citation_fact + answer_fact 톤 · 유형 비트)', triggers: '사실 build 와 같은 빌드',
  uses: 'Answer analysis › Citation 도메인 순위 · 출처 카테고리 · 유형 × 카테고리 · 톤 인용 수, Overview · Dashboard 도메인 카드, 글로벌 자사 인용 수(국가 2개 이상 · 언어 · 출처 축으로 좁힐 때)',
  rules: [ACCEL, '자사 판정은 표면별입니다: global = owner_key = ANY(허용 배열), website = loc_owned ∨ tgt_hit, project = loc_owned.', 'category_key 는 빌드 시점 값입니다. 화면의 유효 카테고리는 조회 때 source_key 로 dim_source.category_key 를 다시 읽어, 셀을 다시 만들기 전의 출처 카테고리 교정도 반영합니다.',
    '자사 미인용 = 인용(호스트 있는)은 1건 이상인데 자사 인용이 0 인 프롬프트입니다.', '셀로 내지 않는 값은 사실을 읽습니다: 톤 URL 수 · 답변 수와 URL 목록, 언급 브랜드 조건, 도메인 상세 · 답변 표본.'] } });
tbl('url_prompt_cell', { s: 'gold', name: 'url_prompt_cell', fam: 'cit', grain: '셀(C) · 가속', cols: [['C', 'PF', '셀 키 12열', 'cell_key'], ['eligible', '', 'URL 모수 답변 있음'], ['any_target · any_owned', '', '타겟 · 자사 인용 답변 있음'], ['url_den', '', 'URL 모수 답변 수 (website = web_reg)'], ['tgt_hits · own_url_hits', '', '타겟 · 자사 URL 인용 답변 수'], ['tgt_own_hits', '', '⑥ 분자 (타겟 ∧ 자사)']], d: {
  grain: '셀(C) 1개 = 1행.', pk: 'C(12)', inputs: '데이터 분석팀 (출처 제안: 같은 build 의 answer_fact tgt_cited · own_url_cited · web_reg)', triggers: '사실 build 와 같은 빌드',
  uses: 'Website 자사 · 타겟 URL 인용률 카드(라이브 값), ⑥ AI 타겟 출처 인용률 (Website · Project)',
  rules: [ACCEL, 'Website 프롬프트 단위(측정 · 타겟 · 자사 프롬프트 수)는 eligible · any_* 를 prompt_key 로 OR 해 셉니다. 율 · ⑥ 은 답변 수 합입니다.',
    '⑥ 의 다른 정의는 셀로 내지 않습니다: Website 보고 유닛 플래그 기준 · 사이트 타겟 URL 집합(web_target_url) 기준, Project 단일 자사 베이스 · 추적 URL 기준.'] } });
tbl('report_value', { s: 'gold', name: 'report_value', fam: 'cit', grain: '회차일 × 보고 유닛 발행값', cols: [
  ['build_id', 'PF', '빌드', 'build'], ['pub_id', '', '활성 발행 ID'], ['round_date · file_seq', 'PK', '회차일 · 보고 유닛'], ['cyc_key', 'FK', '웹 유닛 프로젝트 회차 · NULL 가능', 'dim_cycle'], ['brand · country_code · lang_code', '', '발행물 표기 (발행 선택 축)'], ['in_headline_pool', '', '헤드라인 풀'],
  ['target_hit_prompts · measured_prompts', '', '타겟 인용 · 측정 프롬프트'], ['owned_prompts · owned_prompts_den', '', '자사 인용 프롬프트 · 자사 분모'], ['prev_*', '', '전 회차 4종 · 화면 미사용', '', ['prev_target_hit_prompts', 'prev_measured_prompts', 'prev_owned_prompts', 'prev_owned_prompts_den']] ], d: {
  grain: '빌드 × 회차일 × 보고 유닛(file_seq) 1개 = 1행. 그 자리 활성 발행 중 최신 1건의 값입니다.', pk: 'build_id + round_date + file_seq', inputs: '데이터 분석팀 (출처 제안: 웹사이트 발행 리포트의 활성 발행본 사이트 값)',
  triggers: '발행 리포트가 바뀔 때 그 발행의 회차일 행 전부 교체', uses: 'Website › Overview · Website › Answer analysis › Citation 자사 · 타겟 URL 인용률 카드의 발행값',
  rules: ['발행값을 원문 재계산값으로 자동 교체하지 않습니다.', '발행 유닛을 답변 수로 가중하지 않습니다 (유닛 프롬프트 수 합).', '같은 (round_date, file_seq) 에 활성 발행이 여럿이면 발행일이 가장 늦은 1건(발행일 없음은 맨 뒤, 같으면 수집 시각이 늦은 것)만 둡니다.', '웹사이트 활성 발행만 담습니다. 발행값은 엔진 축이 없고 회차가 하나(스냅샷 또는 시작 = 끝)일 때만 쓰고, 그 밖에는 라이브 값입니다. 발행 리포트와 같은 라우팅을 고르면 출처 · 택소노미 · 커스텀 축이나 발행물 선택 거부(권한 · 브랜드 어휘 · 어휘 분기)도 라이브입니다.'] } });
tbl('dim_source', { s: 'gold', name: 'dim_source', fam: 'cit', grain: '출처(도메인 · 소셜 계정) 1개', cols: [
  ['source_key', 'PK', 'int4 · 0 = 호스트 없음'], ['skey', 'UK', '출처 그룹 키 (공식 소셜 계정은 계정 키)'], ['domain · is_social', '', '대표 도메인 · skey ≠ domain'], ['category_key', 'FK', '', 'dim_category'], ['category_src', '', '1 교정 2 공식 소셜 3 당사 도메인 4 시드 5 규칙 6 Other'], ['owned_brand_bit', '', '당사 공식 도메인 비트 · 0 = 아님'], ['competitor_brand_key', 'FK', '공식(경쟁사) 도메인 브랜드', 'dim_brand'], ['rule_ver', '', '판정 규칙 버전'] ], d: {
  grain: '출처 그룹 키 1개 = 1행.', pk: 'source_key', inputs: '데이터 분석팀 · dim_category · dim_brand',
  uses: '도메인 순위 · 출처 카테고리 · 경쟁사 출처 · 추이 출처 구성 · 출처 필터 옵션 · 답변 도메인 필터 · 답변 인용 카테고리 · Admin › Global config › 인용 출처 분류' } });
tbl('dim_url', { s: 'gold', name: 'dim_url', fam: 'cit', grain: 'URL 1개 (인용 · 자사 페이지)', cols: [
  ['url_key', 'PK', 'int4 · 0 예약'], ['url_hash', 'UK', 'sha256(원문 URL)'], ['url · title', '', '원문 · 최빈 제목'], ['url_norm · url_base_norm', '', '정규형 · 베이스 정규형'], ['host · domain', '', 'host (최빈, 없으면 URL) · 최빈 도메인'], ['source_key', 'FK', '', 'dim_source'], ['owner_key', 'FK', '글로벌 자사 베이스 · NULL = 아님', 'dim_owned_base'], ['rule_ver', '', '판정 규칙 버전'] ], d: {
  grain: '원문 URL 1개 = 1행. 인용 URL 과 자사 사이트 페이지를 담습니다.', pk: 'url_key', inputs: '데이터 분석팀 · dim_source · dim_owned_base (출처 제안: 인용 URL + 자사 사이트 페이지 목록)',
  uses: '인용 URL 목록(톤 · 도메인 상세), 답변 · 검수 상세 인용, Project ⑥ 단일 자사 베이스 판정(url_norm), AI Visibility 페이지 URL',
  rules: ['url_key 는 원문 URL(url_hash = sha256(url)) 단위입니다. 인용되지 않은 자사 사이트 페이지도 행을 만들고, AI Visibility 페이지는 url_norm 으로 인용 URL 과 맞춥니다.'] } });
tbl('dim_category', { s: 'gold', name: 'dim_category', fam: 'cit', grain: '출처 카테고리 1개', cols: [['category_key', 'PK', 'int2 · 1~13'], ['name', 'UK', 'Official (HMG) … Other'], ['slug', '', 'camelCase 코드'], ['ord', '', '표시 순서']], d: {
  grain: '출처 카테고리 1개 = 1행.', pk: 'category_key', inputs: '데이터 분석팀 (출처 제안: GEO HUB 출처 카테고리 코드표의 투영)', uses: '출처 카테고리 분포 · 추이 · 필터 옵션, 공식(HMG) · 딜러·마켓 비중, 인용 출처 분류 카테고리 목록',
  rules: ['category_key k 는 answer_fact.cit_c<k> 열의 번호입니다 (1~13).'] } });
tbl('dim_owned_base', { s: 'gold', name: 'dim_owned_base', fam: 'cit', grain: '당사 소유 URL 베이스 1개', cols: [['owner_key', 'PK', 'int2 · 0 = 자사 아님 표식'], ['kind', '', 'base · root_home'], ['prefix · host', '', '접두 · 호스트 · UNIQUE(kind, prefix)'], ['brand_code · brand_bit', '', 'Hyundai 1 · Kia 2 · Genesis 4'], ['geo_code · language', '', '국가 · 언어 필터 좁힘']], d: {
  grain: '당사 소유 URL 베이스 1개 = 1행.', pk: 'owner_key', inputs: '데이터 분석팀 (출처 제안: GEO HUB 자사 URL 베이스 설정의 투영)', triggers: '자사 URL 베이스 설정이 바뀔 때',
  uses: 'Global 자사 인용 판정(도메인 순위 · 인용 프롬프트 · 답변 모달 · 도메인 상세의 자사 표시와 수), Admin › Global config › 인용 출처 분류 자사 도메인 분류 경고, 도메인 상세 URL 국가',
  rules: ['허용 배열(Global 자사 판정의 베이스 목록): brand_bit 가 관점 own_bits 에 드는 행(kind 둘 다) → 요청 iso 국가의 geo_code 로 좁힘 → 요청 언어의 language 로 좁힘. 좁힌 결과가 비면 그 단계는 좁히지 않고, 관점 브랜드의 행이 없으면 전체 행입니다.',
    'dim_url.owner_key: URL 베이스 정규형이 root_home 접두와 같은 행(공유 글로벌 호스트 제외)이 먼저, 없으면 호스트가 같고 접두가 맞는 가장 긴 base 행입니다.',
    'Project 인용 자사 판정(loc_owned) 접두에는 프로젝트와 브랜드 · 국가가 같은 base 행의 접두를 더하고, 프로젝트 접두 아래의 더 깊은 base 접두(프로젝트 접두가 아닌 것)는 자사에서 뺍니다.',
    'Website 자사 판정은 이 표가 아니라 web_unit 의 base · sibs 를 씁니다.',
    '베이스가 바뀌면 dim_url.owner_key 와 그 URL 을 인용한 답변의 글로벌 자사 인용 수(cit_own_*)를 다시 판정하고, 영향 회차를 새 build 로 만듭니다.', 'owner_key 0 은 "자사 아님" 표식 행입니다(kind · prefix 비움). citation_cell.owner_key 0 이 이 행을 가리킵니다.'] } });
