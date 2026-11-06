-- Keyword and social tables, empty (2026-11-06, user): dim_keyword, kw_* and ctx_* of the analytics schema. The Silver OBT holds none of these,
-- so they are platform data kept in this database like GA4 and SEO, not Gold. Nothing writes or reads them yet; the gold.* tables of the same names stay as they are.
-- Columns, types and comments are the definitions restored into gold.*, which hold every column of the legacy back/db/DB-v2.32.sql and its patches, plus tables that file
-- lacks (ctx_group, ctx_combination_evidence, ctx_claim, ctx_claim_quote, ctx_research_*). DB-v2.32's NOT NULL, DEFAULT, CHECK, identity, foreign keys and indexes are added;
-- all of them fit the rows in gold.*. Its call_id bigint is not used: the real values are text (kc:...). Table comments drop their 입력 and 갱신 lines: no process writes here yet.

CREATE TABLE analytics.dim_keyword (
    kw_key integer NOT NULL GENERATED ALWAYS AS IDENTITY,
    term text NOT NULL,
    term_norm text NOT NULL
);
COMMENT ON TABLE analytics.dim_keyword IS '[키워드] 검색어 1개
검색어 1개 = 1행.
쓰임: Google keywords · Google Keyword · Keyword tools 의 검색어 조회';
COMMENT ON COLUMN analytics.dim_keyword.kw_key IS '검색어 키';
COMMENT ON COLUMN analytics.dim_keyword.term IS 'ERD 설명 없음 · 열 묶음 「term」';
COMMENT ON COLUMN analytics.dim_keyword.term_norm IS '정규화 (NFC · 공백 trim · 소문자)';

CREATE TABLE analytics.kw_serp (
    call_id text NOT NULL,
    rank integer NOT NULL,
    kw_key integer NOT NULL,
    location_code integer NOT NULL,
    language_code text NOT NULL,
    url text NOT NULL,
    domain text,
    title text,
    snippet text,
    observed_at timestamp with time zone NOT NULL
);
COMMENT ON TABLE analytics.kw_serp IS '[키워드] 호출 × 순위
수집 호출 × 순위 = 1행. 집계 없이 화면에 그대로 나갑니다.
쓰임: Google keywords · Google Keyword 검색 결과 표 (최신 호출) · 제안 프롬프트 초안';
COMMENT ON COLUMN analytics.kw_serp.call_id IS 'ERD 설명 없음 · 열 묶음 「call_id」';
COMMENT ON COLUMN analytics.kw_serp.rank IS 'ERD 설명 없음 · 열 묶음 「rank」';
COMMENT ON COLUMN analytics.kw_serp.kw_key IS '검색어 키';
COMMENT ON COLUMN analytics.kw_serp.location_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';
COMMENT ON COLUMN analytics.kw_serp.language_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';
COMMENT ON COLUMN analytics.kw_serp.url IS 'ERD 설명 없음 · 열 묶음 「url · domain」';
COMMENT ON COLUMN analytics.kw_serp.domain IS 'ERD 설명 없음 · 열 묶음 「url · domain」';
COMMENT ON COLUMN analytics.kw_serp.title IS 'ERD 설명 없음 · 열 묶음 「title · snippet」';
COMMENT ON COLUMN analytics.kw_serp.snippet IS 'ERD 설명 없음 · 열 묶음 「title · snippet」';
COMMENT ON COLUMN analytics.kw_serp.observed_at IS 'ERD 설명 없음 · 열 묶음 「observed_at」';

CREATE TABLE analytics.kw_suggestion (
    call_id text NOT NULL,
    pos integer NOT NULL,
    seed_kw_key integer NOT NULL,
    kw_key integer NOT NULL,
    location_code integer NOT NULL,
    language_code text NOT NULL,
    search_volume integer,
    intent text,
    total_count integer CHECK (total_count >= 0),
    is_seed boolean NOT NULL DEFAULT false,
    observed_at timestamp with time zone NOT NULL
);
COMMENT ON TABLE analytics.kw_suggestion IS '[키워드] 호출 × 위치
수집 호출 × 위치 = 1행. 집계 없이 화면에 그대로 나갑니다.
쓰임: Google keywords · Google Keyword 관련 검색어 표, Google Keyword 발견 검색어 수 · 키워드 검색 시작 (검색량 · 의도 · 관련어)';
COMMENT ON COLUMN analytics.kw_suggestion.call_id IS 'ERD 설명 없음 · 열 묶음 「call_id」';
COMMENT ON COLUMN analytics.kw_suggestion.pos IS 'ERD 설명 없음 · 열 묶음 「pos」';
COMMENT ON COLUMN analytics.kw_suggestion.seed_kw_key IS '시드';
COMMENT ON COLUMN analytics.kw_suggestion.kw_key IS '검색어 키';
COMMENT ON COLUMN analytics.kw_suggestion.location_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';
COMMENT ON COLUMN analytics.kw_suggestion.language_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';
COMMENT ON COLUMN analytics.kw_suggestion.search_volume IS 'ERD 설명 없음 · 열 묶음 「search_volume · intent」';
COMMENT ON COLUMN analytics.kw_suggestion.intent IS 'ERD 설명 없음 · 열 묶음 「search_volume · intent」';
COMMENT ON COLUMN analytics.kw_suggestion.total_count IS '호출 단위 연관어 총수';
COMMENT ON COLUMN analytics.kw_suggestion.is_seed IS 'seed 행';
COMMENT ON COLUMN analytics.kw_suggestion.observed_at IS '7일 신선도';

CREATE TABLE analytics.kw_volume_monthly (
    kw_key integer NOT NULL,
    location_code integer NOT NULL,
    language_code text NOT NULL,
    month date NOT NULL CHECK (extract(day FROM month) = 1),
    search_volume integer,
    competition text CHECK (competition IN ('LOW', 'MEDIUM', 'HIGH')),
    competition_index integer,
    cpc numeric,
    call_id text NOT NULL,
    observed_at timestamp with time zone NOT NULL
);
COMMENT ON TABLE analytics.kw_volume_monthly IS '[키워드] 검색어 × 지역 × 언어 × 월
검색어 × 지역 × 언어 × 월 = 1행.
쓰임: Google keywords · Google Keyword 관심도 추이 차트 · 평균 관심도, Keyword tools 키워드 수 · 평균 · 총 검색량 · 고·중·저볼륨 카드 · 검색량 결과 표 · 생성 프롬프트 표 검색량
규칙:
- competition 은 키워드 단위 값이 월 행마다 반복됩니다. 경쟁도 · CPC 는 월 · 키워드끼리 더하지 않습니다.
- 월 행은 성공한 최신 수집이 덮어씁니다(upsert). 실패한 수집(HTTP ≥ 400 · task 오류)은 이전 값을 덮지 않습니다.';
COMMENT ON COLUMN analytics.kw_volume_monthly.kw_key IS '검색어 키';
COMMENT ON COLUMN analytics.kw_volume_monthly.location_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';
COMMENT ON COLUMN analytics.kw_volume_monthly.language_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';
COMMENT ON COLUMN analytics.kw_volume_monthly.month IS '월 1일';
COMMENT ON COLUMN analytics.kw_volume_monthly.search_volume IS 'ERD 설명 없음 · 열 묶음 「search_volume」';
COMMENT ON COLUMN analytics.kw_volume_monthly.competition IS 'LOW·MEDIUM·HIGH 라벨';
COMMENT ON COLUMN analytics.kw_volume_monthly.competition_index IS '지수';
COMMENT ON COLUMN analytics.kw_volume_monthly.cpc IS 'CPC';
COMMENT ON COLUMN analytics.kw_volume_monthly.call_id IS '수집 호출';
COMMENT ON COLUMN analytics.kw_volume_monthly.observed_at IS 'ERD 설명 없음 · 열 묶음 「observed_at」';

CREATE TABLE analytics.ctx_snapshot (
    snapshot_id smallint NOT NULL,
    industry_entity_id uuid NOT NULL,
    source text NOT NULL,
    utterance_total integer,
    taken_at date NOT NULL,
    is_active boolean NOT NULL DEFAULT false,
    keyword text,
    worker_total integer,
    source_total integer
);
COMMENT ON TABLE analytics.ctx_snapshot IS '[소셜] 분석 스냅샷 1개
구매 맥락 분석 스냅샷 1개 = 1행.
쓰임: Project > Intent > Social Scraping 활성 스냅샷 · 기준일, Global > Customer interest > Social Scraping 지도 제목 · 그래프 통계, Admin > Global config > Customer interest config 지도 제목
규칙:
- Project > Intent > Social Scraping 은 활성(is_active) 스냅샷을 읽습니다. 활성 스냅샷은 산업(industry_entity_id)당 1개입니다. 리서치 결과 지도는 ctx_research_run.snapshot_id 의 스냅샷입니다.
- 그래프의 클러스터 표시는 ctx_entity.mention_count / worker_total, 비율은 mention_count ÷ worker_total 이고 조회 때 계산합니다.';
COMMENT ON COLUMN analytics.ctx_snapshot.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_snapshot.industry_entity_id IS '산업 엔티티';
COMMENT ON COLUMN analytics.ctx_snapshot.source IS 'ERD 설명 없음 · 열 묶음 「source」';
COMMENT ON COLUMN analytics.ctx_snapshot.utterance_total IS 'ERD 설명 없음 · 열 묶음 「utterance_total」';
COMMENT ON COLUMN analytics.ctx_snapshot.taken_at IS '기준일 (as_of)';
COMMENT ON COLUMN analytics.ctx_snapshot.is_active IS '산업당 활성 1개';
COMMENT ON COLUMN analytics.ctx_snapshot.keyword IS '지도 제목 키워드';
COMMENT ON COLUMN analytics.ctx_snapshot.worker_total IS '분석 표본';
COMMENT ON COLUMN analytics.ctx_snapshot.source_total IS '출처 수';

CREATE TABLE analytics.ctx_group (
    snapshot_id smallint NOT NULL,
    group_id text NOT NULL,
    side text,
    name text,
    description text,
    sort_order integer
);
COMMENT ON TABLE analytics.ctx_group IS '[소셜] 스냅샷 × 테마·카테고리
스냅샷 × 테마 또는 카테고리 1개 = 1행.
쓰임: Social Scraping (Project · Global) · Customer interest config 표의 주제 · 카테고리 열, Global 그래프 테마 · 카테고리 노드 이름 · 설명';
COMMENT ON COLUMN analytics.ctx_group.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_group.group_id IS 'ERD 설명 없음 · 열 묶음 「group_id」';
COMMENT ON COLUMN analytics.ctx_group.side IS 'context 테마 · condition 카테고리';
COMMENT ON COLUMN analytics.ctx_group.name IS 'ERD 설명 없음 · 열 묶음 「name」';
COMMENT ON COLUMN analytics.ctx_group.description IS '설명문';
COMMENT ON COLUMN analytics.ctx_group.sort_order IS '표시 순서';

CREATE TABLE analytics.ctx_entity (
    snapshot_id smallint NOT NULL,
    id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('ConsumerContext', 'ConsumerRequirement')),
    canonical_name text NOT NULL,
    dimension text,
    mention_count integer NOT NULL DEFAULT 0,
    utterance_count integer NOT NULL DEFAULT 0,
    sentiment_positive integer NOT NULL DEFAULT 0,
    sentiment_negative integer NOT NULL DEFAULT 0,
    sentiment_neutral integer NOT NULL DEFAULT 0,
    group_id text,
    unique_source_count integer,
    perspective_buyer integer,
    perspective_seller integer,
    perspective_neutral integer,
    related_ids uuid[]
);
COMMENT ON TABLE analytics.ctx_entity IS '[소셜] 스냅샷 × 맥락·조건
스냅샷 × 구매 맥락 또는 구매 조건 1개 = 1행.
쓰임: Project > Intent > Social Scraping 맥락 · 조건 수 · 표 · 상세 · 내보내기 · 프롬프트 시드, Global · Admin 표 · 상세, Global 그래프 노드 · 연관 조건
규칙:
- 표의 감성(긍정 · 부정 · 중립)은 sentiment_*, 그래프의 관점(구매자 · 판매자 · 중립)은 perspective_* 입니다.
- 연관 조건은 조합에서 나오지 않는 별도 목록입니다.';
COMMENT ON COLUMN analytics.ctx_entity.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_entity.id IS 'ERD 설명 없음 · 열 묶음 「id」';
COMMENT ON COLUMN analytics.ctx_entity.type IS 'ConsumerContext · ConsumerRequirement';
COMMENT ON COLUMN analytics.ctx_entity.canonical_name IS 'ERD 설명 없음 · 열 묶음 「canonical_name」';
COMMENT ON COLUMN analytics.ctx_entity.dimension IS '맥락 테마 코드 (맥락만)';
COMMENT ON COLUMN analytics.ctx_entity.mention_count IS 'ERD 설명 없음 · 열 묶음 「mention_count · utterance_count」';
COMMENT ON COLUMN analytics.ctx_entity.utterance_count IS 'ERD 설명 없음 · 열 묶음 「mention_count · utterance_count」';
COMMENT ON COLUMN analytics.ctx_entity.sentiment_positive IS '표의 감성 분포 (긍정)';
COMMENT ON COLUMN analytics.ctx_entity.sentiment_negative IS '표의 감성 분포 (부정)';
COMMENT ON COLUMN analytics.ctx_entity.sentiment_neutral IS '표의 감성 분포 (중립)';
COMMENT ON COLUMN analytics.ctx_entity.group_id IS '테마 · 카테고리';
COMMENT ON COLUMN analytics.ctx_entity.unique_source_count IS '고유 출처 수';
COMMENT ON COLUMN analytics.ctx_entity.perspective_buyer IS '구매자 · 판매자 · 중립 관점 (구매자)';
COMMENT ON COLUMN analytics.ctx_entity.perspective_seller IS '구매자 · 판매자 · 중립 관점 (판매자)';
COMMENT ON COLUMN analytics.ctx_entity.perspective_neutral IS '구매자 · 판매자 · 중립 관점 (중립)';
COMMENT ON COLUMN analytics.ctx_entity.related_ids IS '연관 조건 id · 조건만';

CREATE TABLE analytics.ctx_drive (
    snapshot_id smallint NOT NULL,
    context_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    co_count integer NOT NULL DEFAULT 0,
    strength_score numeric
);
COMMENT ON TABLE analytics.ctx_drive IS '[소셜] 맥락 → 조건 연결
스냅샷 × 맥락 × 조건 = 1행.
쓰임: Project > Intent > Social Scraping 관계 수 · 연결 수 · 상세 연결 항목 · 프롬프트 시드, Global 그래프 유발 링크';
COMMENT ON COLUMN analytics.ctx_drive.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_drive.context_id IS '스냅샷 × 맥락·조건 키';
COMMENT ON COLUMN analytics.ctx_drive.requirement_id IS '스냅샷 × 맥락·조건 키';
COMMENT ON COLUMN analytics.ctx_drive.co_count IS '동시 출현';
COMMENT ON COLUMN analytics.ctx_drive.strength_score IS '그래프 유발 강도';

CREATE TABLE analytics.ctx_combination (
    snapshot_id smallint NOT NULL,
    combo_id text NOT NULL,
    cond_a uuid,
    cond_b uuid,
    cond_more uuid[],
    co_count integer NOT NULL DEFAULT 0,
    description text,
    total_speakers integer,
    unique_source_count integer
);
COMMENT ON TABLE analytics.ctx_combination IS '[소셜] 조건 조합 (2개 이상)
스냅샷 × 조건 조합 1개 (쌍 또는 3개 이상) = 1행.
쓰임: Project > Intent > Social Scraping 관계 수 · 조합 패턴 표 · 내보내기 · 프롬프트 시드, Global · Admin 조합 표, Global 그래프 조합 목록 · 상세
규칙:
- 조합 1개 = 1행입니다. 첫째 · 둘째 조건은 cond_a · cond_b, 셋째부터는 cond_more 에 둡니다. combo_id 는 구성 조건 id 를 : 로 이은 값입니다. 쌍 기준인 Project 표 · 내보내기 · 프롬프트 시드는 cond_more 가 빈 행만 읽습니다.
- 그래프 중첩률 = co_count ÷ total_speakers, 근거 문구 = "{total_speakers}명 중 {co_count}명 ({반올림 %})" 이고, 저장하지 않고 조회 때 만듭니다.';
COMMENT ON COLUMN analytics.ctx_combination.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_combination.combo_id IS '조건 id 를 : 로 이음';
COMMENT ON COLUMN analytics.ctx_combination.cond_a IS '첫째';
COMMENT ON COLUMN analytics.ctx_combination.cond_b IS '둘째 조건';
COMMENT ON COLUMN analytics.ctx_combination.cond_more IS '셋째 이후 조건 id';
COMMENT ON COLUMN analytics.ctx_combination.co_count IS '동시 출현';
COMMENT ON COLUMN analytics.ctx_combination.description IS '조합 시나리오';
COMMENT ON COLUMN analytics.ctx_combination.total_speakers IS '중첩률 분모';
COMMENT ON COLUMN analytics.ctx_combination.unique_source_count IS '고유 출처 수';

CREATE TABLE analytics.ctx_combination_evidence (
    snapshot_id smallint NOT NULL,
    combo_id text NOT NULL,
    seq integer NOT NULL,
    quote text,
    source_title text,
    source_url text,
    perspective text
);
COMMENT ON TABLE analytics.ctx_combination_evidence IS '[소셜] 조합 × 근거 발화
스냅샷 × 조건 조합 × 근거 발화 1개 = 1행.
쓰임: Global > Customer interest > Social Scraping 그래프 조합 상세의 근거 인용 · 출처 링크 (20개 + 외 n건)';
COMMENT ON COLUMN analytics.ctx_combination_evidence.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_combination_evidence.combo_id IS '조건 id 를 : 로 이음';
COMMENT ON COLUMN analytics.ctx_combination_evidence.seq IS 'ERD 설명 없음 · 열 묶음 「seq」';
COMMENT ON COLUMN analytics.ctx_combination_evidence.quote IS 'ERD 설명 없음 · 열 묶음 「quote」';
COMMENT ON COLUMN analytics.ctx_combination_evidence.source_title IS 'ERD 설명 없음 · 열 묶음 「source_title · source_url」';
COMMENT ON COLUMN analytics.ctx_combination_evidence.source_url IS 'ERD 설명 없음 · 열 묶음 「source_title · source_url」';
COMMENT ON COLUMN analytics.ctx_combination_evidence.perspective IS 'buyer · seller · neutral';

CREATE TABLE analytics.ctx_domain (
    snapshot_id smallint NOT NULL,
    entity_id uuid NOT NULL,
    host text NOT NULL,
    n integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE analytics.ctx_domain IS '[소셜] 엔티티 × 출처 host
스냅샷 × 엔티티 × 출처 host = 1행.
쓰임: Project > Intent > Social Scraping 출처 도메인 수 · 상세 소스 도메인, Global · Admin 상세 소스 도메인, Global 그래프 도메인별 출처';
COMMENT ON COLUMN analytics.ctx_domain.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_domain.entity_id IS '스냅샷 × 맥락·조건 키';
COMMENT ON COLUMN analytics.ctx_domain.host IS 'ERD 설명 없음 · 열 묶음 「host」';
COMMENT ON COLUMN analytics.ctx_domain.n IS 'ERD 설명 없음 · 열 묶음 「n」';

CREATE TABLE analytics.ctx_evidence (
    snapshot_id smallint NOT NULL,
    id uuid NOT NULL,
    entity_id uuid NOT NULL,
    utterance_id text NOT NULL,
    quote text NOT NULL,
    source_host text,
    source_url text,
    sentiment text,
    source_title text,
    rank integer,
    perspective text
);
COMMENT ON TABLE analytics.ctx_evidence IS '[소셜] 근거 발화 1개
스냅샷 × 근거 발화 1개 = 1행.
쓰임: Project > Intent > Social Scraping 상세 근거 인용, Global · Admin 상세 근거 인용, Global 그래프 근거 인용
규칙:
- 엔티티 상세의 근거 인용은 rank 순으로 읽고, 출처 제목 자리에는 source_title 을 씁니다.';
COMMENT ON COLUMN analytics.ctx_evidence.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_evidence.id IS 'ERD 설명 없음 · 열 묶음 「id」';
COMMENT ON COLUMN analytics.ctx_evidence.entity_id IS '스냅샷 × 맥락·조건 키';
COMMENT ON COLUMN analytics.ctx_evidence.utterance_id IS 'ERD 설명 없음 · 열 묶음 「utterance_id」';
COMMENT ON COLUMN analytics.ctx_evidence.quote IS '근거 인용';
COMMENT ON COLUMN analytics.ctx_evidence.source_host IS 'ERD 설명 없음 · 열 묶음 「source_host · source_url」';
COMMENT ON COLUMN analytics.ctx_evidence.source_url IS 'ERD 설명 없음 · 열 묶음 「source_host · source_url」';
COMMENT ON COLUMN analytics.ctx_evidence.sentiment IS 'ERD 설명 없음 · 열 묶음 「sentiment」';
COMMENT ON COLUMN analytics.ctx_evidence.source_title IS '출처 제목';
COMMENT ON COLUMN analytics.ctx_evidence.rank IS '표시 순서';
COMMENT ON COLUMN analytics.ctx_evidence.perspective IS 'buyer · seller · neutral 관점';

CREATE TABLE analytics.ctx_claim (
    snapshot_id smallint NOT NULL,
    entity_id uuid NOT NULL,
    claim text,
    supporting integer,
    contradicting integer,
    neutral integer,
    total_scanned integer,
    confidence text
);
COMMENT ON TABLE analytics.ctx_claim IS '[소셜] 조건 × 심층 근거
스냅샷 × 심층 근거가 있는 조건 1개 = 1행.
쓰임: Global > Customer interest > Social Scraping 그래프 조건 상세의 심층 근거 · 점선 링 · 심층 n 배지';
COMMENT ON COLUMN analytics.ctx_claim.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_claim.entity_id IS '조건';
COMMENT ON COLUMN analytics.ctx_claim.claim IS '주장문';
COMMENT ON COLUMN analytics.ctx_claim.supporting IS '지지';
COMMENT ON COLUMN analytics.ctx_claim.contradicting IS '반박';
COMMENT ON COLUMN analytics.ctx_claim.neutral IS '중립 수';
COMMENT ON COLUMN analytics.ctx_claim.total_scanned IS '검토 소스 수';
COMMENT ON COLUMN analytics.ctx_claim.confidence IS 'high · medium · low';

CREATE TABLE analytics.ctx_claim_quote (
    snapshot_id smallint NOT NULL,
    entity_id uuid NOT NULL,
    seq integer NOT NULL,
    quote text,
    source text,
    stance text
);
COMMENT ON TABLE analytics.ctx_claim_quote IS '[소셜] 심층 근거 × 인용 표본
심층 근거 × 인용 표본 1개 = 1행.
쓰임: Global > Customer interest > Social Scraping 그래프 심층 근거의 표본 인용 (앞 3개 표시)';
COMMENT ON COLUMN analytics.ctx_claim_quote.snapshot_id IS '분석 스냅샷 키';
COMMENT ON COLUMN analytics.ctx_claim_quote.entity_id IS 'ERD 설명 없음 · 열 묶음 「snapshot_id · entity_id」';
COMMENT ON COLUMN analytics.ctx_claim_quote.seq IS 'ERD 설명 없음 · 열 묶음 「seq」';
COMMENT ON COLUMN analytics.ctx_claim_quote.quote IS 'ERD 설명 없음 · 열 묶음 「quote」';
COMMENT ON COLUMN analytics.ctx_claim_quote.source IS '출처 도메인';
COMMENT ON COLUMN analytics.ctx_claim_quote.stance IS 'supporting · contradicting · neutral';

CREATE TABLE analytics.ctx_research_run (
    run_id uuid NOT NULL,
    keyword text,
    geo_key smallint,
    lang_key smallint,
    purpose_preset text,
    purpose_text text,
    status text,
    search_count integer,
    source_count integer,
    worker_count integer,
    snapshot_id smallint
);
COMMENT ON TABLE analytics.ctx_research_run IS '[소셜] 리서치 실행 1회
리서치 실행 1회 = 1행.
쓰임: Admin > Global config > Customer interest config 리서치 입력 폼 · 탐색 화면 상태 · 카운터 · 결과 지도';
COMMENT ON COLUMN analytics.ctx_research_run.run_id IS '리서치 실행 키';
COMMENT ON COLUMN analytics.ctx_research_run.keyword IS '키워드 / 토픽';
COMMENT ON COLUMN analytics.ctx_research_run.geo_key IS '지역';
COMMENT ON COLUMN analytics.ctx_research_run.lang_key IS '지역 프리셋 언어';
COMMENT ON COLUMN analytics.ctx_research_run.purpose_preset IS '리서치 목적 프리셋';
COMMENT ON COLUMN analytics.ctx_research_run.purpose_text IS '본문';
COMMENT ON COLUMN analytics.ctx_research_run.status IS 'queued · exploring · confirm · done · failed';
COMMENT ON COLUMN analytics.ctx_research_run.search_count IS '검색';
COMMENT ON COLUMN analytics.ctx_research_run.source_count IS '소스';
COMMENT ON COLUMN analytics.ctx_research_run.worker_count IS '완료 워커 수';
COMMENT ON COLUMN analytics.ctx_research_run.snapshot_id IS '결과 지도';

CREATE TABLE analytics.ctx_research_wave (
    run_id uuid NOT NULL,
    wave_no integer NOT NULL,
    strategy text
);
COMMENT ON TABLE analytics.ctx_research_wave IS '[소셜] 실행 × 탐색 웨이브
실행 × 웨이브 1개 = 1행.
쓰임: Admin > Global config > Customer interest config 탐색 화면 Wave 목록';
COMMENT ON COLUMN analytics.ctx_research_wave.run_id IS '리서치 실행 키';
COMMENT ON COLUMN analytics.ctx_research_wave.wave_no IS 'ERD 설명 없음 · 열 묶음 「wave_no」';
COMMENT ON COLUMN analytics.ctx_research_wave.strategy IS '탐색 전략 문구';

CREATE TABLE analytics.ctx_research_worker (
    run_id uuid NOT NULL,
    worker_id text NOT NULL,
    wave_no integer,
    label text,
    query text,
    status text,
    source_count integer
);
COMMENT ON TABLE analytics.ctx_research_worker IS '[소셜] 실행 × 워커
실행 × 워커 1개 = 1행.
쓰임: Admin > Global config > Customer interest config 탐색 화면 워커 칩 · 완료 워커 수';
COMMENT ON COLUMN analytics.ctx_research_worker.run_id IS '리서치 실행 키';
COMMENT ON COLUMN analytics.ctx_research_worker.worker_id IS 'ERD 설명 없음 · 열 묶음 「worker_id」';
COMMENT ON COLUMN analytics.ctx_research_worker.wave_no IS '소속 Wave';
COMMENT ON COLUMN analytics.ctx_research_worker.label IS '칩 이름';
COMMENT ON COLUMN analytics.ctx_research_worker.query IS '검색어';
COMMENT ON COLUMN analytics.ctx_research_worker.status IS 'searching · analyzing · completed';
COMMENT ON COLUMN analytics.ctx_research_worker.source_count IS '수집 소스 수';

CREATE TABLE analytics.ctx_research_log (
    run_id uuid NOT NULL,
    seq integer NOT NULL,
    kind text,
    title text,
    detail text
);
COMMENT ON TABLE analytics.ctx_research_log IS '[소셜] 실행 × 활동 로그
실행 × 로그 1줄 = 1행.
쓰임: Admin > Global config > Customer interest config 탐색 화면 활동 로그';
COMMENT ON COLUMN analytics.ctx_research_log.run_id IS '리서치 실행 키';
COMMENT ON COLUMN analytics.ctx_research_log.seq IS '표시 순서';
COMMENT ON COLUMN analytics.ctx_research_log.kind IS 'wave · reasoning · search · discover · worker · confirmation · complete';
COMMENT ON COLUMN analytics.ctx_research_log.title IS 'ERD 설명 없음 · 열 묶음 「title · detail」';
COMMENT ON COLUMN analytics.ctx_research_log.detail IS 'ERD 설명 없음 · 열 묶음 「title · detail」';

ALTER TABLE ONLY analytics.dim_keyword ADD CONSTRAINT dim_keyword_pkey PRIMARY KEY (kw_key);
ALTER TABLE ONLY analytics.dim_keyword ADD CONSTRAINT dim_keyword_term_norm_key UNIQUE (term_norm);
ALTER TABLE ONLY analytics.kw_serp ADD CONSTRAINT kw_serp_pkey PRIMARY KEY (call_id, rank);
ALTER TABLE ONLY analytics.kw_suggestion ADD CONSTRAINT kw_suggestion_pkey PRIMARY KEY (call_id, pos);
ALTER TABLE ONLY analytics.kw_volume_monthly ADD CONSTRAINT kw_volume_monthly_pkey PRIMARY KEY (kw_key, location_code, language_code, month);
ALTER TABLE ONLY analytics.ctx_snapshot ADD CONSTRAINT ctx_snapshot_pkey PRIMARY KEY (snapshot_id);
ALTER TABLE ONLY analytics.ctx_group ADD CONSTRAINT ctx_group_pkey PRIMARY KEY (snapshot_id, group_id);
ALTER TABLE ONLY analytics.ctx_entity ADD CONSTRAINT ctx_entity_pkey PRIMARY KEY (snapshot_id, id);
ALTER TABLE ONLY analytics.ctx_drive ADD CONSTRAINT ctx_drive_pkey PRIMARY KEY (snapshot_id, context_id, requirement_id);
ALTER TABLE ONLY analytics.ctx_combination ADD CONSTRAINT ctx_combination_pkey PRIMARY KEY (snapshot_id, combo_id);
ALTER TABLE ONLY analytics.ctx_combination_evidence ADD CONSTRAINT ctx_combination_evidence_pkey PRIMARY KEY (snapshot_id, combo_id, seq);
ALTER TABLE ONLY analytics.ctx_domain ADD CONSTRAINT ctx_domain_pkey PRIMARY KEY (snapshot_id, entity_id, host);
ALTER TABLE ONLY analytics.ctx_evidence ADD CONSTRAINT ctx_evidence_pkey PRIMARY KEY (snapshot_id, id);
ALTER TABLE ONLY analytics.ctx_claim ADD CONSTRAINT ctx_claim_pkey PRIMARY KEY (snapshot_id, entity_id);
ALTER TABLE ONLY analytics.ctx_claim_quote ADD CONSTRAINT ctx_claim_quote_pkey PRIMARY KEY (snapshot_id, entity_id, seq);
ALTER TABLE ONLY analytics.ctx_research_run ADD CONSTRAINT ctx_research_run_pkey PRIMARY KEY (run_id);
ALTER TABLE ONLY analytics.ctx_research_wave ADD CONSTRAINT ctx_research_wave_pkey PRIMARY KEY (run_id, wave_no);
ALTER TABLE ONLY analytics.ctx_research_worker ADD CONSTRAINT ctx_research_worker_pkey PRIMARY KEY (run_id, worker_id);
ALTER TABLE ONLY analytics.ctx_research_log ADD CONSTRAINT ctx_research_log_pkey PRIMARY KEY (run_id, seq);

ALTER TABLE ONLY analytics.kw_serp ADD CONSTRAINT kw_serp_kw_key_fkey FOREIGN KEY (kw_key) REFERENCES analytics.dim_keyword(kw_key);
ALTER TABLE ONLY analytics.kw_suggestion ADD CONSTRAINT kw_suggestion_seed_kw_key_fkey FOREIGN KEY (seed_kw_key) REFERENCES analytics.dim_keyword(kw_key);
ALTER TABLE ONLY analytics.kw_suggestion ADD CONSTRAINT kw_suggestion_kw_key_fkey FOREIGN KEY (kw_key) REFERENCES analytics.dim_keyword(kw_key);
ALTER TABLE ONLY analytics.kw_volume_monthly ADD CONSTRAINT kw_volume_monthly_kw_key_fkey FOREIGN KEY (kw_key) REFERENCES analytics.dim_keyword(kw_key);
ALTER TABLE ONLY analytics.ctx_entity ADD CONSTRAINT ctx_entity_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES analytics.ctx_snapshot(snapshot_id);

CREATE UNIQUE INDEX ctx_combination_snapshot_id_cond_a_cond_b_key ON analytics.ctx_combination USING btree (snapshot_id, cond_a, cond_b) WHERE (COALESCE(cardinality(cond_more), 0) = 0);
CREATE INDEX kw_serp_latest ON analytics.kw_serp (kw_key, location_code, language_code, call_id DESC);
CREATE INDEX kw_suggestion_latest ON analytics.kw_suggestion (seed_kw_key, location_code, language_code, call_id DESC);
CREATE UNIQUE INDEX ctx_snapshot_one_active ON analytics.ctx_snapshot (industry_entity_id) WHERE is_active;
CREATE INDEX ctx_entity_type_mentions ON analytics.ctx_entity (snapshot_id, type, mention_count DESC);
CREATE INDEX ctx_drive_requirement_idx ON analytics.ctx_drive (snapshot_id, requirement_id);
CREATE INDEX ctx_evidence_entity ON analytics.ctx_evidence (snapshot_id, entity_id);

GRANT SELECT ON TABLE analytics.dim_keyword TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.dim_keyword TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.kw_serp TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.kw_serp TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.kw_suggestion TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.kw_suggestion TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.kw_volume_monthly TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.kw_volume_monthly TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_snapshot TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_snapshot TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_group TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_group TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_entity TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_entity TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_drive TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_drive TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_combination TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_combination TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_combination_evidence TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_combination_evidence TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_domain TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_domain TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_evidence TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_evidence TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_claim TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_claim TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_claim_quote TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_claim_quote TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_research_run TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_research_run TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_research_wave TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_research_wave TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_research_worker TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_research_worker TO hmg_analytics_writer;
GRANT SELECT ON TABLE analytics.ctx_research_log TO hmg_analytics_reader;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE analytics.ctx_research_log TO hmg_analytics_writer;
