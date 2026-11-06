-- T9.7 (2026-11-07): the query tables and the reference rows a load starts from, so a new install has gold_db without a restore. Written from gold_db's schema; the tables in
-- teardown-t12.sql are left out. An install that already has them (a restored database) keeps them: this does nothing there. What a load cannot make stays out: the service's codes are here,
-- the rows it writes (answers, prompts, projects, brands) start empty, and the values the contract has no column for (query-tables-scope.md 2절) stay empty on a new install.
DO $install$
BEGIN
IF to_regclass('gold.answer_fact') IS NOT NULL THEN
    RETURN;
END IF;

COMMENT ON SCHEMA gold IS 'sha256:e7a62a45de6f9608c1f24872f68f489fefa62b2fcf8a3db794e5d8e10eb31a57';


CREATE TABLE gold.acr_cell_fact (
    build_id bigint NOT NULL,
    acr_cell_key integer NOT NULL,
    surface smallint,
    cyc_key integer,
    prompt_key integer,
    project_key smallint,
    engine_key smallint,
    geo_key smallint,
    lang_key smallint,
    bgrp integer,
    round_date date,
    measured_date date,
    cat_mask integer,
    planned integer,
    valid_turn1 integer,
    valid_acr integer,
    co_single integer,
    co_conditional integer,
    co_generic integer,
    co_off_shortlist integer,
    co_unresolved integer,
    co_none integer,
    is_rep boolean,
    acr_in boolean,
    rule_ver text
);


COMMENT ON TABLE gold.acr_cell_fact IS '[ACR] 빌드 × ACR 셀
빌드 × ACR 셀(Scope prompt-run 1개 = 프롬프트 × 엔진 × 지역의 반복 측정 묶음) = 1행.
입력: 데이터 분석팀 · dim_prompt (루트 카탈로그) · dim_country (global 숨김 시장)
갱신: Scope run 적재, 판정 입력 변경 시 재판정
쓰임: Global ACR 의 셀 선택 · 분모: Top1 · Top5 ACR 카드, 답변 수 카드, 측정 프롬프트 · 셀 · 반복 수 주석, 선택률 추이 분모. 검수 상세 ACR 롤업 블록. Website · Project ACR
규칙:
- Top1 ACR = 브랜드 Σchoice ÷ 셀 Σvalid_acr · Top5(후보군 포함율) = 등장 셀 수 ÷ 셀 수';


COMMENT ON COLUMN gold.acr_cell_fact.build_id IS '빌드';


COMMENT ON COLUMN gold.acr_cell_fact.acr_cell_key IS 'ACR 셀 = Scope prompt-run';


COMMENT ON COLUMN gold.acr_cell_fact.surface IS '1 global · 2 website · 3 project';


COMMENT ON COLUMN gold.acr_cell_fact.cyc_key IS '회차';


COMMENT ON COLUMN gold.acr_cell_fact.prompt_key IS '측정 프롬프트 키';


COMMENT ON COLUMN gold.acr_cell_fact.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.acr_cell_fact.engine_key IS 'AI 엔진 키';


COMMENT ON COLUMN gold.acr_cell_fact.geo_key IS '국가';


COMMENT ON COLUMN gold.acr_cell_fact.lang_key IS '언어 키';


COMMENT ON COLUMN gold.acr_cell_fact.bgrp IS '브랜드 비트 (카탈로그·사이트·프로젝트)';


COMMENT ON COLUMN gold.acr_cell_fact.round_date IS '회차일';


COMMENT ON COLUMN gold.acr_cell_fact.measured_date IS '측정일(KST)';


COMMENT ON COLUMN gold.acr_cell_fact.cat_mask IS 'ERD 설명 없음 · 열 묶음 「cat_mask」';


COMMENT ON COLUMN gold.acr_cell_fact.planned IS '반복 수: 계획';


COMMENT ON COLUMN gold.acr_cell_fact.valid_turn1 IS '1턴 유효';


COMMENT ON COLUMN gold.acr_cell_fact.valid_acr IS 'ACR 유효';


COMMENT ON COLUMN gold.acr_cell_fact.co_single IS '결과 유형별 수';


COMMENT ON COLUMN gold.acr_cell_fact.co_conditional IS '결과 유형별 수';


COMMENT ON COLUMN gold.acr_cell_fact.co_generic IS '결과 유형별 수';


COMMENT ON COLUMN gold.acr_cell_fact.co_off_shortlist IS 'ERD 설명 없음 · 열 묶음 「co_off_shortlist · co_unresolved · co_none」';


COMMENT ON COLUMN gold.acr_cell_fact.co_unresolved IS 'ERD 설명 없음 · 열 묶음 「co_off_shortlist · co_unresolved · co_none」';


COMMENT ON COLUMN gold.acr_cell_fact.co_none IS 'ERD 설명 없음 · 열 묶음 「co_off_shortlist · co_unresolved · co_none」';


COMMENT ON COLUMN gold.acr_cell_fact.is_rep IS '회차 대표 셀';


COMMENT ON COLUMN gold.acr_cell_fact.acr_in IS 'ACR 모수 게이트';


COMMENT ON COLUMN gold.acr_cell_fact.rule_ver IS '적재 규칙 버전';


CREATE TABLE gold.acr_cell_run (
    acr_cell_key integer NOT NULL,
    prompt_run_id uuid,
    run_id uuid
);


COMMENT ON TABLE gold.acr_cell_run IS '[답변 원문] ACR 셀 실행
ACR 셀 1개의 Scope 실행 id = 1행.
입력: 데이터 분석팀
쓰임: 검수 상세 ACR 블록 (노트 키 prompt_run_id)';


COMMENT ON COLUMN gold.acr_cell_run.acr_cell_key IS '셀 식별자 (build 무관)';


COMMENT ON COLUMN gold.acr_cell_run.prompt_run_id IS 'ERD 설명 없음 · 열 묶음 「prompt_run_id」';


COMMENT ON COLUMN gold.acr_cell_run.run_id IS 'ERD 설명 없음 · 열 묶음 「run_id」';


CREATE TABLE gold.acr_entity_fact (
    build_id bigint NOT NULL,
    acr_cell_key integer NOT NULL,
    level smallint NOT NULL,
    entity_key integer NOT NULL,
    brand_key integer,
    parent_brand_key integer,
    own_bit integer,
    name_own integer,
    appearance integer,
    choice integer,
    cond_choice integer,
    off_shortlist integer,
    unresolved integer,
    generic integer,
    keep boolean
);


COMMENT ON TABLE gold.acr_entity_fact IS '[ACR] 빌드 × ACR 셀 × 레벨 × 엔티티
빌드 × ACR 셀 × 레벨 × 엔티티 = 1행.
입력: 데이터 분석팀 · dim_entity · dim_brand
쓰임: Global ACR 브랜드별 ACR 표, Top1 · Top5 ACR · 1순위 횟수 카드, 선택률 추이 분자, 모델별 선택 구도 표, 차종별 선택 전환율 표, 모델별 점유 맵. 검수 상세 ACR 롤업 블록. Website · Project ACR
규칙:
- 모델별 선택 구도 표의 칸 승자(선택 수 최다 브랜드)는 저장하지 않습니다. 필터를 건 셀을 (프롬프트, 엔진)으로 합산한 뒤 조회 때 고릅니다.
- appearance 는 언급 기반이라 반복 수보다 클 수 있습니다. 후보군 등장 반복 수는 acr_iter_shortlist 로 셉니다.';


COMMENT ON COLUMN gold.acr_entity_fact.build_id IS '빌드';


COMMENT ON COLUMN gold.acr_entity_fact.acr_cell_key IS 'ACR 셀 = Scope prompt-run';


COMMENT ON COLUMN gold.acr_entity_fact.level IS '1 브랜드 · 2 차종 · 3 회사';


COMMENT ON COLUMN gold.acr_entity_fact.entity_key IS '엔티티 키';


COMMENT ON COLUMN gold.acr_entity_fact.brand_key IS '레벨1 표시 브랜드';


COMMENT ON COLUMN gold.acr_entity_fact.parent_brand_key IS '차종 소속 (그 밖 0)';


COMMENT ON COLUMN gold.acr_entity_fact.own_bit IS '당사 비트: 명부';


COMMENT ON COLUMN gold.acr_entity_fact.name_own IS '표시 이름';


COMMENT ON COLUMN gold.acr_entity_fact.appearance IS 'ERD 설명 없음 · 열 묶음 「appearance · choice · cond_choice」';


COMMENT ON COLUMN gold.acr_entity_fact.choice IS 'ERD 설명 없음 · 열 묶음 「appearance · choice · cond_choice」';


COMMENT ON COLUMN gold.acr_entity_fact.cond_choice IS 'ERD 설명 없음 · 열 묶음 「appearance · choice · cond_choice」';


COMMENT ON COLUMN gold.acr_entity_fact.off_shortlist IS 'ERD 설명 없음 · 열 묶음 「off_shortlist · unresolved · generic」';


COMMENT ON COLUMN gold.acr_entity_fact.unresolved IS 'ERD 설명 없음 · 열 묶음 「off_shortlist · unresolved · generic」';


COMMENT ON COLUMN gold.acr_entity_fact.generic IS 'ERD 설명 없음 · 열 묶음 「off_shortlist · unresolved · generic」';


COMMENT ON COLUMN gold.acr_entity_fact.keep IS 'false = 비경쟁 이름 (표시 제외)';


CREATE TABLE gold.acr_iter_fact (
    build_id bigint NOT NULL,
    acr_cell_key integer NOT NULL,
    iter_no integer NOT NULL,
    answer_key integer,
    result_type smallint,
    winner_brand_key integer,
    winner_entity_key integer,
    own_bit integer
);


COMMENT ON TABLE gold.acr_iter_fact IS '[ACR] 빌드 × ACR 셀 × 반복
빌드 × ACR 셀 × 반복 1회 = 1행.
입력: 데이터 분석팀 (출처 제안: Scope ACR 반복 job 별 최종 선택)
갱신: acr_cell_fact 와 같은 빌드
쓰임: Website · Project ACR 모델별 점유 맵의 반복 칸별 승자 · 최빈 브랜드
규칙:
- 셀의 반복 행을 result_type 별로 센 값이 acr_cell_fact.co_* 와 같아야 합니다.
- 반복 열 수 = acr_cell_fact.planned 입니다.';


COMMENT ON COLUMN gold.acr_iter_fact.build_id IS '빌드';


COMMENT ON COLUMN gold.acr_iter_fact.acr_cell_key IS 'ACR 셀 = Scope prompt-run';


COMMENT ON COLUMN gold.acr_iter_fact.iter_no IS '= answer_fact.acr_iter_rank (최신 = 1)';


COMMENT ON COLUMN gold.acr_iter_fact.answer_key IS '반복 job';


COMMENT ON COLUMN gold.acr_iter_fact.result_type IS '1 single · 2 conditional · 3 generic · 4 off_shortlist · 5 unresolved · 6 none';


COMMENT ON COLUMN gold.acr_iter_fact.winner_brand_key IS '0 = 선택 없음';


COMMENT ON COLUMN gold.acr_iter_fact.winner_entity_key IS '차종 · 없으면 0';


COMMENT ON COLUMN gold.acr_iter_fact.own_bit IS 'ERD 설명 없음 · 열 묶음 「own_bit」';


CREATE TABLE gold.acr_iter_shortlist (
    build_id bigint NOT NULL,
    acr_cell_key integer NOT NULL,
    iter_no integer NOT NULL,
    level smallint NOT NULL,
    entity_key integer NOT NULL,
    brand_key integer,
    parent_brand_key integer,
    is_choice boolean
);


COMMENT ON TABLE gold.acr_iter_shortlist IS '[ACR] 반복 × 레벨 × 후보 엔티티
빌드 × ACR 셀 × 반복 × 레벨 × 후보 엔티티 = 1행.
입력: 데이터 분석팀 (출처 제안: Scope ACR 반복 job 별 후보군 · 최종 선택)
쓰임: Website · Project ACR 차종별 선택 전환율 표의 후보군 등장 · 1위 선택 · 전환율 = 최종 선택 ÷ 후보로 등장한 회차(반복) (화면 정의)';


COMMENT ON COLUMN gold.acr_iter_shortlist.build_id IS '빌드';


COMMENT ON COLUMN gold.acr_iter_shortlist.acr_cell_key IS 'ACR 셀 = Scope prompt-run';


COMMENT ON COLUMN gold.acr_iter_shortlist.iter_no IS '= answer_fact.acr_iter_rank (최신 = 1)';


COMMENT ON COLUMN gold.acr_iter_shortlist.level IS '1 브랜드 · 2 차종 · 3 회사';


COMMENT ON COLUMN gold.acr_iter_shortlist.entity_key IS '엔티티 키';


COMMENT ON COLUMN gold.acr_iter_shortlist.brand_key IS '표시 브랜드 키';


COMMENT ON COLUMN gold.acr_iter_shortlist.parent_brand_key IS '표시 브랜드 키';


COMMENT ON COLUMN gold.acr_iter_shortlist.is_choice IS '그 반복의 최종 선택';


CREATE TABLE gold.active_release (
    read_mode text NOT NULL,
    rule_signature text NOT NULL,
    scope text NOT NULL,
    release_id bigint,
    version bigint,
    last_build_id bigint,
    rule_ver text,
    as_of date,
    updated_at timestamp with time zone
);


COMMENT ON TABLE gold.active_release IS '[빌드·릴리스] 공개 포인터
읽기 모드 × 규칙 서명 × 공개 범위의 현재 release = 1행.
입력: 데이터 분석팀 · release
갱신: 검증 통과 뒤 짧은 트랜잭션으로 포인터 전환 (승인 없는 회차별 자동 생성은 20261015 논의 · A04 진행 중)
규칙:
- 기대한 이전 release 와 입력 버전을 확인한 뒤 전환해, 오래된 build 가 새 입력을 덮지 못하게 합니다.
- version 이 오르면 공개 release 가 바뀐 것입니다. 읽는 쪽은 version 으로 앞서 읽은 값(목록을 이어 읽는 위치 포함)이 낡았는지 판단합니다.';


COMMENT ON COLUMN gold.active_release.read_mode IS '읽기 모드';


COMMENT ON COLUMN gold.active_release.rule_signature IS '규칙 서명';


COMMENT ON COLUMN gold.active_release.scope IS '공개 범위 (표면)';


COMMENT ON COLUMN gold.active_release.release_id IS '현재 release';


COMMENT ON COLUMN gold.active_release.version IS '공개 버전 (전환마다 +1)';


COMMENT ON COLUMN gold.active_release.last_build_id IS '마지막 반영 build';


COMMENT ON COLUMN gold.active_release.rule_ver IS 'ERD 설명 없음 · 열 묶음 「rule_ver · as_of · updated_at」';


COMMENT ON COLUMN gold.active_release.as_of IS 'ERD 설명 없음 · 열 묶음 「rule_ver · as_of · updated_at」';


COMMENT ON COLUMN gold.active_release.updated_at IS 'ERD 설명 없음 · 열 묶음 「rule_ver · as_of · updated_at」';


CREATE TABLE gold.answer_body (
    answer_key integer NOT NULL,
    job_id uuid,
    run_id uuid,
    prompt_run_id uuid,
    surface smallint,
    project_key smallint,
    geo_key smallint,
    bgrp integer,
    answer_text text,
    model_slug text,
    measured_at timestamp with time zone,
    status text,
    analysis_status text,
    region text
);


COMMENT ON TABLE gold.answer_body IS '[답변 원문] 답변 본문·메타
job 1건(모든 상태)의 본문과 측정 메타 = 1행.
입력: 데이터 분석팀
쓰임: 답변 모달 원문, 검수 상세, Entity catalog 언급 샘플
규칙:
- 접근 범위 열(surface · project_key · geo_key · bgrp)을 둡니다. 답변 모달은 answer_key 와 함께 surface · project_key 를 다시 걸어 읽습니다(fail-closed).';


COMMENT ON COLUMN gold.answer_body.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.answer_body.job_id IS 'ERD 설명 없음 · 열 묶음 「job_id · run_id · prompt_run_id」';


COMMENT ON COLUMN gold.answer_body.run_id IS 'ERD 설명 없음 · 열 묶음 「job_id · run_id · prompt_run_id」';


COMMENT ON COLUMN gold.answer_body.prompt_run_id IS 'ERD 설명 없음 · 열 묶음 「job_id · run_id · prompt_run_id」';


COMMENT ON COLUMN gold.answer_body.surface IS '접근 범위';


COMMENT ON COLUMN gold.answer_body.project_key IS '접근 범위';


COMMENT ON COLUMN gold.answer_body.geo_key IS '접근 범위';


COMMENT ON COLUMN gold.answer_body.bgrp IS '접근 범위';


COMMENT ON COLUMN gold.answer_body.answer_text IS '답변 본문';


COMMENT ON COLUMN gold.answer_body.model_slug IS 'ERD 설명 없음 · 열 묶음 「model_slug」';


COMMENT ON COLUMN gold.answer_body.measured_at IS 'ERD 설명 없음 · 열 묶음 「measured_at」';


COMMENT ON COLUMN gold.answer_body.status IS 'ERD 설명 없음 · 열 묶음 「status · analysis_status」';


COMMENT ON COLUMN gold.answer_body.analysis_status IS 'ERD 설명 없음 · 열 묶음 「status · analysis_status」';


COMMENT ON COLUMN gold.answer_body.region IS 'Scope 측정 지역';


CREATE TABLE gold.answer_brand_fact (
    build_id bigint NOT NULL,
    surface smallint NOT NULL,
    round_date date NOT NULL,
    answer_key integer NOT NULL,
    brand_key integer NOT NULL,
    competitive boolean NOT NULL,
    cyc_key integer,
    prompt_key integer,
    project_key smallint,
    engine_key smallint,
    geo_key smallint,
    lang_key smallint,
    bgrp integer,
    own_bit integer,
    entity_rows integer,
    rid_n integer,
    mention_count integer,
    rk integer,
    first_pos integer,
    s_pos integer,
    s_neu integer,
    s_neg integer,
    s_mix integer,
    t_mention integer,
    t_recommendation integer,
    t_comparison integer,
    t_definition integer,
    t_final_choice integer,
    std_in boolean,
    elig boolean,
    dflt boolean,
    is_rep boolean,
    std_in_nc boolean,
    rule_ver text
);


COMMENT ON TABLE gold.answer_brand_fact IS '[답변 사실] 빌드 × 답변 × 표시 브랜드 × 경쟁
빌드 × 답변 × 표시 브랜드 × 경쟁 여부 = 1행.
입력: 데이터 분석팀 · answer_fact
쓰임: 경쟁사 표·브랜드 순위·헤드투헤드, 국가별 GEO 경쟁사, 멘션 유형·유형 추이, 언급 프롬프트, 답변 모달 언급 브랜드, 인용 도메인의 언급 브랜드 조건·유형 × 카테고리, Project › Prompt 영향 언급 수, Entity catalog 언급 샘플
규칙:
- 게이트 열(std_in · elig · dflt · is_rep · std_in_nc)은 같은 답변 answer_fact 값의 사본입니다.
- first_pos 는 답변 텍스트상 그 브랜드의 첫 등장 순서입니다. 우선 노출도를 첫 등장 순서로 셀 때 씁니다.
- rid_n 은 이 행에 접힌 언급의 서로 다른 롤업 id 수입니다. 브랜드 노출 답변 수는 행 수로 세고, (답변, 롤업 id) 단위로 셀 때만 Σrid_n 입니다.';


COMMENT ON COLUMN gold.answer_brand_fact.build_id IS '빌드';


COMMENT ON COLUMN gold.answer_brand_fact.surface IS 'ERD 설명 없음 · 열 묶음 「surface · round_date · answer_key」';


COMMENT ON COLUMN gold.answer_brand_fact.round_date IS 'ERD 설명 없음 · 열 묶음 「surface · round_date · answer_key」';


COMMENT ON COLUMN gold.answer_brand_fact.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.answer_brand_fact.brand_key IS '표시 브랜드 키';


COMMENT ON COLUMN gold.answer_brand_fact.competitive IS '경쟁 여부 (비경쟁 명단 판정)';


COMMENT ON COLUMN gold.answer_brand_fact.cyc_key IS '회차';


COMMENT ON COLUMN gold.answer_brand_fact.prompt_key IS '측정 프롬프트 키';


COMMENT ON COLUMN gold.answer_brand_fact.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.answer_brand_fact.engine_key IS 'AI 엔진 키';


COMMENT ON COLUMN gold.answer_brand_fact.geo_key IS '국가';


COMMENT ON COLUMN gold.answer_brand_fact.lang_key IS '언어 키';


COMMENT ON COLUMN gold.answer_brand_fact.bgrp IS '브랜드 비트 (카탈로그·사이트·프로젝트)';


COMMENT ON COLUMN gold.answer_brand_fact.own_bit IS '당사 비트';


COMMENT ON COLUMN gold.answer_brand_fact.entity_rows IS '언급 행 수';


COMMENT ON COLUMN gold.answer_brand_fact.rid_n IS '롤업 id 수';


COMMENT ON COLUMN gold.answer_brand_fact.mention_count IS '언급 수';


COMMENT ON COLUMN gold.answer_brand_fact.rk IS '경쟁 순위';


COMMENT ON COLUMN gold.answer_brand_fact.first_pos IS '텍스트 첫 등장 순서';


COMMENT ON COLUMN gold.answer_brand_fact.s_pos IS 'ERD 설명 없음 · 열 묶음 「s_pos · s_neu · s_neg · s_mix」';


COMMENT ON COLUMN gold.answer_brand_fact.s_neu IS 'ERD 설명 없음 · 열 묶음 「s_pos · s_neu · s_neg · s_mix」';


COMMENT ON COLUMN gold.answer_brand_fact.s_neg IS 'ERD 설명 없음 · 열 묶음 「s_pos · s_neu · s_neg · s_mix」';


COMMENT ON COLUMN gold.answer_brand_fact.s_mix IS 'ERD 설명 없음 · 열 묶음 「s_pos · s_neu · s_neg · s_mix」';


COMMENT ON COLUMN gold.answer_brand_fact.t_mention IS '유형 5종 (mention)';


COMMENT ON COLUMN gold.answer_brand_fact.t_recommendation IS '유형 5종 (recommendation)';


COMMENT ON COLUMN gold.answer_brand_fact.t_comparison IS '유형 5종 (comparison)';


COMMENT ON COLUMN gold.answer_brand_fact.t_definition IS '유형 5종 (definition)';


COMMENT ON COLUMN gold.answer_brand_fact.t_final_choice IS '유형 5종 (final_choice)';


COMMENT ON COLUMN gold.answer_brand_fact.std_in IS '게이트 사본';


COMMENT ON COLUMN gold.answer_brand_fact.elig IS '게이트 사본';


COMMENT ON COLUMN gold.answer_brand_fact.dflt IS '게이트 사본';


COMMENT ON COLUMN gold.answer_brand_fact.is_rep IS '게이트 사본';


COMMENT ON COLUMN gold.answer_brand_fact.std_in_nc IS '게이트 사본';


COMMENT ON COLUMN gold.answer_brand_fact.rule_ver IS 'ERD 설명 없음 · 열 묶음 「rule_ver」';


CREATE TABLE gold.answer_fact (
    build_id bigint NOT NULL,
    surface smallint NOT NULL,
    round_date date NOT NULL,
    answer_key integer NOT NULL,
    cyc_key integer,
    run_key integer,
    prompt_key integer,
    project_key smallint,
    engine_key smallint,
    geo_key smallint,
    lang_key smallint,
    bgrp integer,
    anchor_date date,
    anchor_src text,
    region_geo_key smallint,
    cat_mask integer,
    acr_iter_rank integer,
    analysis_state smallint,
    elig boolean,
    dflt boolean,
    is_acr boolean,
    is_rep boolean,
    web_reg boolean,
    std_in boolean,
    cit_in boolean,
    gap boolean,
    acr_in boolean,
    elig_nc boolean,
    std_in_nc boolean,
    cit_in_nc boolean,
    own_mask integer,
    own_rk_h integer,
    own_rk_k integer,
    own_rk_g integer,
    t_own integer,
    own_fp_h integer,
    own_fp_k integer,
    own_fp_g integer,
    ment_total integer,
    ment_h integer,
    ment_k integer,
    ment_g integer,
    sent_pos_h integer,
    sent_pos_k integer,
    sent_pos_g integer,
    sent_neg_h integer,
    sent_neg_k integer,
    sent_neg_g integer,
    sent_all_h integer,
    sent_all_k integer,
    sent_all_g integer,
    cit_n integer,
    cit_n_all integer,
    cit_off integer,
    cit_own_h integer,
    cit_own_k integer,
    cit_own_g integer,
    cit_own_hc integer,
    cit_own_kc integer,
    cit_own_gc integer,
    cit_own_x integer,
    cit_loc integer,
    cit_tgt integer,
    cit_loc_tgt integer,
    cit_c1 integer,
    cit_c2 integer,
    cit_c3 integer,
    cit_c4 integer,
    cit_c5 integer,
    cit_c6 integer,
    cit_c7 integer,
    cit_c8 integer,
    cit_c9 integer,
    cit_c10 integer,
    cit_c11 integer,
    cit_c12 integer,
    cit_c13 integer,
    has_cit boolean,
    tgt_cited boolean,
    own_url_cited boolean,
    rep_cit_xor boolean,
    ecat_ver text,
    rule_ver text
);


COMMENT ON TABLE gold.answer_fact IS '[답변 사실] 빌드 × 정상 완료 답변 1건
빌드 × 정상 완료 답변 1건 = 1행 (ACR 반복 포함, 본문 제외).
입력: 데이터 분석팀 · job_index · answer_brand_fact · citation_fact
갱신: 적재마다, 회차 재평가의 run 귀속 이동, 재판정 · 앵커 고정 · 드롭 · 엔티티 버전 반영 때 새 build
쓰임: KPI 카드·엔진·비교·추이·국가별 GEO, 언급·인용 분석 전반, Website › Prompts 측정 메타, Project › Prompt 영향 답변 수
규칙:
- acr_in = NOT (is_acr ∧ acr_iter_rank > 1), gap = analysis_state ≥ 2, cit_in = elig ∧ acr_in, std_in = cit_in ∧ NOT gap 입니다. *_nc 는 같은 식에서 elig 대신 elig_nc(루트 카탈로그 소속 조건만 뺀 elig)를 씁니다.
- own_rk_{h,k,g} 는 브랜드별 당사 경쟁 순위(rk 최솟값, 0 = 없음), own_fp_{h,k,g} 는 답변 텍스트상 당사 첫 등장 순서입니다. 우선 노출도를 첫 등장 순서로 셀 때 own_fp 를 씁니다.
- 인용 계열 셀 대표(인용 숨김 회차를 후보에서 뺀 round_date 셀 대표) = is_rep XOR rep_cit_xor 입니다.';


COMMENT ON COLUMN gold.answer_fact.build_id IS '빌드';


COMMENT ON COLUMN gold.answer_fact.surface IS '파티션';


COMMENT ON COLUMN gold.answer_fact.round_date IS '파티션';


COMMENT ON COLUMN gold.answer_fact.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.answer_fact.cyc_key IS '회차';


COMMENT ON COLUMN gold.answer_fact.run_key IS 'cyc·run·prompt·project·engine·geo·lang·bgrp';


COMMENT ON COLUMN gold.answer_fact.prompt_key IS '측정 프롬프트 키';


COMMENT ON COLUMN gold.answer_fact.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.answer_fact.engine_key IS 'AI 엔진 키';


COMMENT ON COLUMN gold.answer_fact.geo_key IS '국가';


COMMENT ON COLUMN gold.answer_fact.lang_key IS '언어 키';


COMMENT ON COLUMN gold.answer_fact.bgrp IS '브랜드 비트 (카탈로그·사이트·프로젝트)';


COMMENT ON COLUMN gold.answer_fact.anchor_date IS 'ERD 설명 없음 · 열 묶음 「anchor_date · anchor_src · region_geo_key」';


COMMENT ON COLUMN gold.answer_fact.anchor_src IS 'ERD 설명 없음 · 열 묶음 「anchor_date · anchor_src · region_geo_key」';


COMMENT ON COLUMN gold.answer_fact.region_geo_key IS 'ERD 설명 없음 · 열 묶음 「anchor_date · anchor_src · region_geo_key」';


COMMENT ON COLUMN gold.answer_fact.cat_mask IS 'ERD 설명 없음 · 열 묶음 「cat_mask · acr_iter_rank · analysis_state」';


COMMENT ON COLUMN gold.answer_fact.acr_iter_rank IS 'ERD 설명 없음 · 열 묶음 「cat_mask · acr_iter_rank · analysis_state」';


COMMENT ON COLUMN gold.answer_fact.analysis_state IS 'ERD 설명 없음 · 열 묶음 「cat_mask · acr_iter_rank · analysis_state」';


COMMENT ON COLUMN gold.answer_fact.elig IS '게이트';


COMMENT ON COLUMN gold.answer_fact.dflt IS '게이트';


COMMENT ON COLUMN gold.answer_fact.is_acr IS '게이트';


COMMENT ON COLUMN gold.answer_fact.is_rep IS '게이트';


COMMENT ON COLUMN gold.answer_fact.web_reg IS '게이트';


COMMENT ON COLUMN gold.answer_fact.std_in IS '모수·갭 (계산 열)';


COMMENT ON COLUMN gold.answer_fact.cit_in IS '모수·갭 (계산 열)';


COMMENT ON COLUMN gold.answer_fact.gap IS '모수·갭 (계산 열)';


COMMENT ON COLUMN gold.answer_fact.acr_in IS '모수·갭 (계산 열)';


COMMENT ON COLUMN gold.answer_fact.elig_nc IS '루트 카탈로그 조건 뺀 게이트·모수';


COMMENT ON COLUMN gold.answer_fact.std_in_nc IS '루트 카탈로그 조건 뺀 게이트·모수';


COMMENT ON COLUMN gold.answer_fact.cit_in_nc IS '루트 카탈로그 조건 뺀 게이트·모수';


COMMENT ON COLUMN gold.answer_fact.own_mask IS '당사 비트';


COMMENT ON COLUMN gold.answer_fact.own_rk_h IS '경쟁 순위 (현대)';


COMMENT ON COLUMN gold.answer_fact.own_rk_k IS '경쟁 순위 (기아)';


COMMENT ON COLUMN gold.answer_fact.own_rk_g IS '경쟁 순위 (제네시스)';


COMMENT ON COLUMN gold.answer_fact.t_own IS '유형';


COMMENT ON COLUMN gold.answer_fact.own_fp_h IS '텍스트 첫 등장 순서 (현대)';


COMMENT ON COLUMN gold.answer_fact.own_fp_k IS '텍스트 첫 등장 순서 (기아)';


COMMENT ON COLUMN gold.answer_fact.own_fp_g IS '텍스트 첫 등장 순서 (제네시스)';


COMMENT ON COLUMN gold.answer_fact.ment_total IS 'ERD 설명 없음 · 열 묶음 「ment_total · ment_{h,k,g}」';


COMMENT ON COLUMN gold.answer_fact.ment_h IS 'ERD 설명 없음 · 열 묶음 「ment_total · ment_{h,k,g}」 (현대)';


COMMENT ON COLUMN gold.answer_fact.ment_k IS 'ERD 설명 없음 · 열 묶음 「ment_total · ment_{h,k,g}」 (기아)';


COMMENT ON COLUMN gold.answer_fact.ment_g IS 'ERD 설명 없음 · 열 묶음 「ment_total · ment_{h,k,g}」 (제네시스)';


COMMENT ON COLUMN gold.answer_fact.sent_pos_h IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (긍정 · 현대)';


COMMENT ON COLUMN gold.answer_fact.sent_pos_k IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (긍정 · 기아)';


COMMENT ON COLUMN gold.answer_fact.sent_pos_g IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (긍정 · 제네시스)';


COMMENT ON COLUMN gold.answer_fact.sent_neg_h IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (부정 · 현대)';


COMMENT ON COLUMN gold.answer_fact.sent_neg_k IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (부정 · 기아)';


COMMENT ON COLUMN gold.answer_fact.sent_neg_g IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (부정 · 제네시스)';


COMMENT ON COLUMN gold.answer_fact.sent_all_h IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (전체 · 현대)';


COMMENT ON COLUMN gold.answer_fact.sent_all_k IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (전체 · 기아)';


COMMENT ON COLUMN gold.answer_fact.sent_all_g IS 'ERD 설명 없음 · 열 묶음 「sent_{pos,neg,all}_{h,k,g}」 (전체 · 제네시스)';


COMMENT ON COLUMN gold.answer_fact.cit_n IS '호스트 인용';


COMMENT ON COLUMN gold.answer_fact.cit_n_all IS '전체';


COMMENT ON COLUMN gold.answer_fact.cit_off IS 'Official';


COMMENT ON COLUMN gold.answer_fact.cit_own_h IS '글로벌 자사 인용 수 (현대)';


COMMENT ON COLUMN gold.answer_fact.cit_own_k IS '글로벌 자사 인용 수 (기아)';


COMMENT ON COLUMN gold.answer_fact.cit_own_g IS '글로벌 자사 인용 수 (제네시스)';


COMMENT ON COLUMN gold.answer_fact.cit_own_hc IS '글로벌 자사 인용 수 (hc)';


COMMENT ON COLUMN gold.answer_fact.cit_own_kc IS '글로벌 자사 인용 수 (kc)';


COMMENT ON COLUMN gold.answer_fact.cit_own_gc IS '글로벌 자사 인용 수 (gc)';


COMMENT ON COLUMN gold.answer_fact.cit_own_x IS '글로벌 자사 인용 수 (x)';


COMMENT ON COLUMN gold.answer_fact.cit_loc IS '자사';


COMMENT ON COLUMN gold.answer_fact.cit_tgt IS '타겟';


COMMENT ON COLUMN gold.answer_fact.cit_loc_tgt IS '자사∨타겟 인용 수';


COMMENT ON COLUMN gold.answer_fact.cit_c1 IS '카테고리별 (1)';


COMMENT ON COLUMN gold.answer_fact.cit_c2 IS '카테고리별 (2)';


COMMENT ON COLUMN gold.answer_fact.cit_c3 IS '카테고리별 (3)';


COMMENT ON COLUMN gold.answer_fact.cit_c4 IS '카테고리별 (4)';


COMMENT ON COLUMN gold.answer_fact.cit_c5 IS '카테고리별 (5)';


COMMENT ON COLUMN gold.answer_fact.cit_c6 IS '카테고리별 (6)';


COMMENT ON COLUMN gold.answer_fact.cit_c7 IS '카테고리별 (7)';


COMMENT ON COLUMN gold.answer_fact.cit_c8 IS '카테고리별 (8)';


COMMENT ON COLUMN gold.answer_fact.cit_c9 IS '카테고리별 (9)';


COMMENT ON COLUMN gold.answer_fact.cit_c10 IS '카테고리별 (10)';


COMMENT ON COLUMN gold.answer_fact.cit_c11 IS '카테고리별 (11)';


COMMENT ON COLUMN gold.answer_fact.cit_c12 IS '카테고리별 (12)';


COMMENT ON COLUMN gold.answer_fact.cit_c13 IS '카테고리별 (13)';


COMMENT ON COLUMN gold.answer_fact.has_cit IS '인용 여부 · URL 인용률';


COMMENT ON COLUMN gold.answer_fact.tgt_cited IS '인용 여부 · URL 인용률';


COMMENT ON COLUMN gold.answer_fact.own_url_cited IS '인용 여부 · URL 인용률';


COMMENT ON COLUMN gold.answer_fact.rep_cit_xor IS '인용 계열 대표 보정 (is_rep XOR)';


COMMENT ON COLUMN gold.answer_fact.ecat_ver IS '판정 버전';


COMMENT ON COLUMN gold.answer_fact.rule_ver IS '판정 버전';


CREATE TABLE gold.answer_mention_raw (
    answer_key integer NOT NULL,
    ord integer NOT NULL,
    surface smallint,
    project_key smallint,
    geo_key smallint,
    bgrp integer,
    entity_id uuid,
    entity_key integer,
    registry_role text,
    entity_type text,
    display_name text,
    mention_count integer,
    avg_position numeric,
    brand_rollup_entity_id uuid,
    surfaces text[],
    sentiment_positive integer,
    sentiment_neutral integer,
    sentiment_negative integer,
    sentiment_mixed integer,
    type_mention integer,
    type_recommendation integer,
    type_comparison integer,
    type_definition integer,
    type_final_choice integer
);


COMMENT ON TABLE gold.answer_mention_raw IS '[답변 원문] 언급 원본
답변의 엔티티 언급 원본 1건 = 1행 (모든 엔티티, 브랜드 롤업 전).
입력: 데이터 분석팀
쓰임: 답변 모달 차종 언급·감성 귀속, 언급 프롬프트 하이라이트(terms), 검수 목록 언급 수·필터, 검수 상세, Entity catalog 언급 샘플';


COMMENT ON COLUMN gold.answer_mention_raw.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.answer_mention_raw.ord IS 'ERD 설명 없음 · 열 묶음 「answer_key · ord」';


COMMENT ON COLUMN gold.answer_mention_raw.surface IS '접근 범위';


COMMENT ON COLUMN gold.answer_mention_raw.project_key IS '접근 범위';


COMMENT ON COLUMN gold.answer_mention_raw.geo_key IS '접근 범위';


COMMENT ON COLUMN gold.answer_mention_raw.bgrp IS '접근 범위';


COMMENT ON COLUMN gold.answer_mention_raw.entity_id IS '엔티티 키';


COMMENT ON COLUMN gold.answer_mention_raw.entity_key IS '엔티티 키';


COMMENT ON COLUMN gold.answer_mention_raw.registry_role IS 'ERD 설명 없음 · 열 묶음 「registry_role · entity_type」';


COMMENT ON COLUMN gold.answer_mention_raw.entity_type IS 'ERD 설명 없음 · 열 묶음 「registry_role · entity_type」';


COMMENT ON COLUMN gold.answer_mention_raw.display_name IS 'ERD 설명 없음 · 열 묶음 「display_name」';


COMMENT ON COLUMN gold.answer_mention_raw.mention_count IS 'ERD 설명 없음 · 열 묶음 「mention_count · avg_position」';


COMMENT ON COLUMN gold.answer_mention_raw.avg_position IS 'ERD 설명 없음 · 열 묶음 「mention_count · avg_position」';


COMMENT ON COLUMN gold.answer_mention_raw.brand_rollup_entity_id IS 'ERD 설명 없음 · 열 묶음 「brand_rollup_entity_id · surfaces[]」';


COMMENT ON COLUMN gold.answer_mention_raw.surfaces IS 'ERD 설명 없음 · 열 묶음 「brand_rollup_entity_id · surfaces[]」';


COMMENT ON COLUMN gold.answer_mention_raw.sentiment_positive IS 'ERD 설명 없음 · 열 묶음 「sentiment_{positive,neutral,negative,mixed}」 (긍정)';


COMMENT ON COLUMN gold.answer_mention_raw.sentiment_neutral IS 'ERD 설명 없음 · 열 묶음 「sentiment_{positive,neutral,negative,mixed}」 (중립)';


COMMENT ON COLUMN gold.answer_mention_raw.sentiment_negative IS 'ERD 설명 없음 · 열 묶음 「sentiment_{positive,neutral,negative,mixed}」 (부정)';


COMMENT ON COLUMN gold.answer_mention_raw.sentiment_mixed IS 'ERD 설명 없음 · 열 묶음 「sentiment_{positive,neutral,negative,mixed}」 (혼합)';


COMMENT ON COLUMN gold.answer_mention_raw.type_mention IS '유형 5종 (mention)';


COMMENT ON COLUMN gold.answer_mention_raw.type_recommendation IS '유형 5종 (recommendation)';


COMMENT ON COLUMN gold.answer_mention_raw.type_comparison IS '유형 5종 (comparison)';


COMMENT ON COLUMN gold.answer_mention_raw.type_definition IS '유형 5종 (definition)';


COMMENT ON COLUMN gold.answer_mention_raw.type_final_choice IS '유형 5종 (final_choice)';


CREATE TABLE gold.answer_occurrence (
    answer_key integer NOT NULL,
    ord integer NOT NULL,
    surface smallint,
    project_key smallint,
    geo_key smallint,
    bgrp integer,
    entity_id uuid,
    turn_index integer,
    source_start integer,
    source_end integer,
    surface_text text,
    sentiment text,
    mention_role text,
    assertion text,
    context_snippet text,
    descriptors text[],
    criteria text[]
);


COMMENT ON TABLE gold.answer_occurrence IS '[답변 원문] 본문 안 등장 위치
답변 본문 안 언급 등장 1건 = 1행.
입력: 데이터 분석팀
쓰임: 답변 모달 감성 하이라이트, Entity catalog 언급 샘플';


COMMENT ON COLUMN gold.answer_occurrence.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.answer_occurrence.ord IS 'ERD 설명 없음 · 열 묶음 「answer_key · ord」';


COMMENT ON COLUMN gold.answer_occurrence.surface IS '접근 범위';


COMMENT ON COLUMN gold.answer_occurrence.project_key IS '접근 범위';


COMMENT ON COLUMN gold.answer_occurrence.geo_key IS '접근 범위';


COMMENT ON COLUMN gold.answer_occurrence.bgrp IS '접근 범위';


COMMENT ON COLUMN gold.answer_occurrence.entity_id IS 'ERD 설명 없음 · 열 묶음 「entity_id · turn_index」';


COMMENT ON COLUMN gold.answer_occurrence.turn_index IS 'ERD 설명 없음 · 열 묶음 「entity_id · turn_index」';


COMMENT ON COLUMN gold.answer_occurrence.source_start IS '본문 위치';


COMMENT ON COLUMN gold.answer_occurrence.source_end IS '본문 위치';


COMMENT ON COLUMN gold.answer_occurrence.surface_text IS 'ERD 설명 없음 · 열 묶음 「surface_text」';


COMMENT ON COLUMN gold.answer_occurrence.sentiment IS 'ERD 설명 없음 · 열 묶음 「sentiment · mention_role · assertion」';


COMMENT ON COLUMN gold.answer_occurrence.mention_role IS 'ERD 설명 없음 · 열 묶음 「sentiment · mention_role · assertion」';


COMMENT ON COLUMN gold.answer_occurrence.assertion IS 'ERD 설명 없음 · 열 묶음 「sentiment · mention_role · assertion」';


COMMENT ON COLUMN gold.answer_occurrence.context_snippet IS 'ERD 설명 없음 · 열 묶음 「context_snippet」';


COMMENT ON COLUMN gold.answer_occurrence.descriptors IS 'ERD 설명 없음 · 열 묶음 「descriptors[] · criteria[]」';


COMMENT ON COLUMN gold.answer_occurrence.criteria IS 'ERD 설명 없음 · 열 묶음 「descriptors[] · criteria[]」';


CREATE TABLE gold.answer_stance_fact (
    build_id bigint NOT NULL,
    surface smallint NOT NULL,
    round_date date NOT NULL,
    answer_key integer NOT NULL,
    turn_index integer NOT NULL,
    entity_key integer NOT NULL,
    brand_key integer,
    cyc_key integer,
    own_bit integer,
    stance smallint,
    first_turn boolean,
    std_in boolean,
    is_rep boolean,
    std_in_nc boolean
);


COMMENT ON TABLE gold.answer_stance_fact IS '[답변 사실] 빌드 × 답변 × 턴 × 엔티티
빌드 × 답변 × 턴 × 엔티티 = 1행.
입력: 데이터 분석팀 · answer_fact
쓰임: Global › Answer analysis › Mention 스탠스 카드의 당사 스탠스 4계열 (현재 꺼짐)
규칙:
- first_turn = (답변, 엔티티) 안 가장 이른 턴. 스탠스 집계는 first_turn 만 셉니다.
- 카드 경로는 스탠스를 읽지 않아 발행 세대에 넣지 않습니다.';


COMMENT ON COLUMN gold.answer_stance_fact.build_id IS '빌드';


COMMENT ON COLUMN gold.answer_stance_fact.surface IS 'ERD 설명 없음 · 열 묶음 「surface · round_date · answer_key」';


COMMENT ON COLUMN gold.answer_stance_fact.round_date IS 'ERD 설명 없음 · 열 묶음 「surface · round_date · answer_key」';


COMMENT ON COLUMN gold.answer_stance_fact.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.answer_stance_fact.turn_index IS 'ERD 설명 없음 · 열 묶음 「turn_index」';


COMMENT ON COLUMN gold.answer_stance_fact.entity_key IS '엔티티 키';


COMMENT ON COLUMN gold.answer_stance_fact.brand_key IS '표시 브랜드 키';


COMMENT ON COLUMN gold.answer_stance_fact.cyc_key IS 'ERD 설명 없음 · 열 묶음 「cyc_key」';


COMMENT ON COLUMN gold.answer_stance_fact.own_bit IS '1 긍정 2 중립 3 혼합 4 부정';


COMMENT ON COLUMN gold.answer_stance_fact.stance IS '1 긍정 2 중립 3 혼합 4 부정';


COMMENT ON COLUMN gold.answer_stance_fact.first_turn IS '대표 턴';


COMMENT ON COLUMN gold.answer_stance_fact.std_in IS '게이트 사본';


COMMENT ON COLUMN gold.answer_stance_fact.is_rep IS '게이트 사본';


COMMENT ON COLUMN gold.answer_stance_fact.std_in_nc IS '게이트 사본';


CREATE TABLE gold.answer_stance_raw (
    answer_key integer NOT NULL,
    turn_index integer NOT NULL,
    entity_id uuid NOT NULL,
    surface smallint,
    project_key smallint,
    geo_key smallint,
    bgrp integer,
    brand_label text,
    stance text,
    confidence numeric,
    evidence_text text,
    evidence_start integer,
    evidence_end integer,
    reason text
);


COMMENT ON TABLE gold.answer_stance_raw IS '[답변 원문] 스탠스 근거
답변 × 턴 × 엔티티의 스탠스 근거 = 1행.
입력: 데이터 분석팀
쓰임: 답변 모달 스탠스 태그(근거 대조)';


COMMENT ON COLUMN gold.answer_stance_raw.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.answer_stance_raw.turn_index IS 'ERD 설명 없음 · 열 묶음 「answer_key · turn_index · entity_id」';


COMMENT ON COLUMN gold.answer_stance_raw.entity_id IS 'ERD 설명 없음 · 열 묶음 「answer_key · turn_index · entity_id」';


COMMENT ON COLUMN gold.answer_stance_raw.surface IS '접근 범위';


COMMENT ON COLUMN gold.answer_stance_raw.project_key IS '접근 범위';


COMMENT ON COLUMN gold.answer_stance_raw.geo_key IS '접근 범위';


COMMENT ON COLUMN gold.answer_stance_raw.bgrp IS '접근 범위';


COMMENT ON COLUMN gold.answer_stance_raw.brand_label IS 'ERD 설명 없음 · 열 묶음 「brand_label」';


COMMENT ON COLUMN gold.answer_stance_raw.stance IS 'ERD 설명 없음 · 열 묶음 「stance · confidence」';


COMMENT ON COLUMN gold.answer_stance_raw.confidence IS 'ERD 설명 없음 · 열 묶음 「stance · confidence」';


COMMENT ON COLUMN gold.answer_stance_raw.evidence_text IS 'ERD 설명 없음 · 열 묶음 「evidence_text」';


COMMENT ON COLUMN gold.answer_stance_raw.evidence_start IS 'ERD 설명 없음 · 열 묶음 「evidence_start · evidence_end」';


COMMENT ON COLUMN gold.answer_stance_raw.evidence_end IS 'ERD 설명 없음 · 열 묶음 「evidence_start · evidence_end」';


COMMENT ON COLUMN gold.answer_stance_raw.reason IS 'ERD 설명 없음 · 열 묶음 「reason」';


CREATE TABLE gold.build (
    build_id bigint NOT NULL,
    family text,
    slice_key text,
    input_snapshot text,
    watermark text,
    profile_signature text,
    metric_version text,
    ecat_ver text,
    rule_ver text,
    status text,
    row_counts jsonb,
    verify jsonb,
    error text,
    attempt integer,
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);


COMMENT ON TABLE gold.build IS '[빌드·릴리스] 빌드 1회
패밀리 × 슬라이스 × 입력·규칙 버전의 빌드 1회 = 1행.
입력: 데이터 분석팀
갱신: 회차 마감, 재판정, ACR 수집 완료, 보고 유닛 발행값 발행(report_value), 일 배치(vis)
규칙:
- build 하나는 한 패밀리 · 슬라이스의 출력 행 묶음입니다. 사실 · 셀 행은 build_id 로 세대를 나누고, release_item · publication 이 build_id 로 공개할 build 를 가리킵니다.
- 재시도는 같은 build 출력을 교체·재개합니다. row_counts 를 누적하지 않습니다.
- 실패한 build 는 release 에 넣지 않고 status · error 만 남깁니다.';


COMMENT ON COLUMN gold.build.build_id IS '빌드 키';


COMMENT ON COLUMN gold.build.family IS 'fact · cell · report · acr · vis';


COMMENT ON COLUMN gold.build.slice_key IS '회차 · 발행 · 사이트×일';


COMMENT ON COLUMN gold.build.input_snapshot IS '입력 고정';


COMMENT ON COLUMN gold.build.watermark IS '입력 고정';


COMMENT ON COLUMN gold.build.profile_signature IS '규칙 서명';


COMMENT ON COLUMN gold.build.metric_version IS '규칙 서명';


COMMENT ON COLUMN gold.build.ecat_ver IS '판정 버전';


COMMENT ON COLUMN gold.build.rule_ver IS '판정 버전';


COMMENT ON COLUMN gold.build.status IS 'pending · running · validated · failed';


COMMENT ON COLUMN gold.build.row_counts IS 'ERD 설명 없음 · 열 묶음 「row_counts · verify」';


COMMENT ON COLUMN gold.build.verify IS 'ERD 설명 없음 · 열 묶음 「row_counts · verify」';


COMMENT ON COLUMN gold.build.error IS 'ERD 설명 없음 · 열 묶음 「error · attempt」';


COMMENT ON COLUMN gold.build.attempt IS 'ERD 설명 없음 · 열 묶음 「error · attempt」';


COMMENT ON COLUMN gold.build.started_at IS 'ERD 설명 없음 · 열 묶음 「started_at · finished_at」';


COMMENT ON COLUMN gold.build.finished_at IS 'ERD 설명 없음 · 열 묶음 「started_at · finished_at」';


CREATE TABLE gold.catalog_entry (
    catalog_row_id uuid NOT NULL,
    prompt_key integer,
    brand_bit integer,
    kind text,
    presence_key smallint,
    funnel_key smallint,
    list_type_key smallint,
    depth1_key smallint,
    depth2_key smallint,
    depth3_key smallint,
    depth4_key smallint,
    build_id bigint NOT NULL
);


COMMENT ON TABLE gold.catalog_entry IS '[프롬프트·웹 유닛] 빌드 × 루트 카탈로그 행 (비삭제)
빌드 × 표준 루트 카탈로그 행(비삭제) 1개 = 1행. 한 프롬프트에 여러 행이 붙을 수 있습니다.
입력: 데이터 분석팀
쓰임: global 택소노미 · depth4 필터의 프롬프트 키 해석(답변 목록 · 언급 · 인용 · ACR · 국가별 GEO · KPI), KPI 적용 프롬프트 수, 필터 옵션 카탈로그 택소노미, 답변 상세 택소노미
규칙:
- 한 프롬프트에 여러 카탈로그 행이 붙으므로 프롬프트 수는 DISTINCT prompt_key 로 셉니다.
- depth4 필터도 다른 택소노미 축처럼 관점 카탈로그 행(brand_bit)의 depth4_key 로 겁니다.';


COMMENT ON COLUMN gold.catalog_entry.catalog_row_id IS '카탈로그 행';


COMMENT ON COLUMN gold.catalog_entry.prompt_key IS '미발행 행 NULL';


COMMENT ON COLUMN gold.catalog_entry.brand_bit IS '행 브랜드 비트 (없음 = 엄브렐러)';


COMMENT ON COLUMN gold.catalog_entry.kind IS 'single · acr';


COMMENT ON COLUMN gold.catalog_entry.presence_key IS '택소노미 코드 키';


COMMENT ON COLUMN gold.catalog_entry.funnel_key IS '택소노미 코드 키';


COMMENT ON COLUMN gold.catalog_entry.list_type_key IS '택소노미 코드 키';


COMMENT ON COLUMN gold.catalog_entry.depth1_key IS '택소노미 코드 키 (1)';


COMMENT ON COLUMN gold.catalog_entry.depth2_key IS '택소노미 코드 키 (2)';


COMMENT ON COLUMN gold.catalog_entry.depth3_key IS '택소노미 코드 키 (3)';


COMMENT ON COLUMN gold.catalog_entry.depth4_key IS '카탈로그 depth4';


COMMENT ON COLUMN gold.catalog_entry.build_id IS '빌드(세대)';


CREATE TABLE gold.citation_fact (
    build_id bigint NOT NULL,
    surface smallint NOT NULL,
    round_date date NOT NULL,
    answer_key integer NOT NULL,
    ord integer NOT NULL,
    url_key integer,
    source_key integer,
    cyc_key integer,
    prompt_key integer,
    project_key smallint,
    engine_key smallint,
    geo_key smallint,
    lang_key smallint,
    bgrp integer,
    scope_key integer,
    owner_key smallint,
    cit_in boolean,
    gap boolean,
    dflt boolean,
    is_rep boolean,
    cit_in_nc boolean,
    loc_owned boolean,
    tgt_hit boolean,
    src_first boolean,
    rule_ver text
);


COMMENT ON TABLE gold.citation_fact IS '[답변 사실] 빌드 × 인용 원소 1건
빌드 × 인용 원소 1건 = 1행.
입력: 데이터 분석팀 · answer_fact · dim_url · web_unit
쓰임: 출처·도메인·톤·카테고리, 인용 프롬프트·도메인 상세, 추이 상위 도메인, 답변 모달 인용, 검수 상세 정규화 URL, Admin › 인용 출처 분류 도메인 인용 수, Project › Prompt 영향 인용 수
규칙:
- URL 문자열은 두지 않고 url_key 로 dim_url 을 참조합니다.
- 고유 URL 수는 기간 전체에서 count(DISTINCT url_key) 로 셉니다. 일별 값을 더하지 않습니다.';


COMMENT ON COLUMN gold.citation_fact.build_id IS '빌드';


COMMENT ON COLUMN gold.citation_fact.surface IS 'ERD 설명 없음 · 열 묶음 「surface · round_date · answer_key」';


COMMENT ON COLUMN gold.citation_fact.round_date IS 'ERD 설명 없음 · 열 묶음 「surface · round_date · answer_key」';


COMMENT ON COLUMN gold.citation_fact.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.citation_fact.ord IS '인용 순서';


COMMENT ON COLUMN gold.citation_fact.url_key IS '0 예약';


COMMENT ON COLUMN gold.citation_fact.source_key IS '0 = 호스트 없음';


COMMENT ON COLUMN gold.citation_fact.cyc_key IS '회차';


COMMENT ON COLUMN gold.citation_fact.prompt_key IS '측정 프롬프트 키';


COMMENT ON COLUMN gold.citation_fact.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.citation_fact.engine_key IS 'AI 엔진 키';


COMMENT ON COLUMN gold.citation_fact.geo_key IS '국가';


COMMENT ON COLUMN gold.citation_fact.lang_key IS '언어 키';


COMMENT ON COLUMN gold.citation_fact.bgrp IS '브랜드 비트 (카탈로그·사이트·프로젝트)';


COMMENT ON COLUMN gold.citation_fact.scope_key IS 'ERD 설명 없음 · 열 묶음 「scope_key · owner_key」';


COMMENT ON COLUMN gold.citation_fact.owner_key IS 'ERD 설명 없음 · 열 묶음 「scope_key · owner_key」';


COMMENT ON COLUMN gold.citation_fact.cit_in IS '게이트 사본';


COMMENT ON COLUMN gold.citation_fact.gap IS '게이트 사본';


COMMENT ON COLUMN gold.citation_fact.dflt IS '게이트 사본';


COMMENT ON COLUMN gold.citation_fact.is_rep IS '게이트 사본';


COMMENT ON COLUMN gold.citation_fact.cit_in_nc IS '게이트 사본';


COMMENT ON COLUMN gold.citation_fact.loc_owned IS 'ERD 설명 없음 · 열 묶음 「loc_owned · tgt_hit · src_first」';


COMMENT ON COLUMN gold.citation_fact.tgt_hit IS 'ERD 설명 없음 · 열 묶음 「loc_owned · tgt_hit · src_first」';


COMMENT ON COLUMN gold.citation_fact.src_first IS 'ERD 설명 없음 · 열 묶음 「loc_owned · tgt_hit · src_first」';


COMMENT ON COLUMN gold.citation_fact.rule_ver IS 'ERD 설명 없음 · 열 묶음 「rule_ver」';


CREATE TABLE gold.ctx_claim (
    snapshot_id smallint NOT NULL,
    entity_id uuid NOT NULL,
    claim text,
    supporting integer,
    contradicting integer,
    neutral integer,
    total_scanned integer,
    confidence text
);


COMMENT ON TABLE gold.ctx_claim IS '[소셜] 조건 × 심층 근거
스냅샷 × 심층 근거가 있는 조건 1개 = 1행.
입력: 데이터 분석팀 (출처 제안: 심층 근거 검증)
쓰임: Global > Customer interest > Social Scraping 그래프 조건 상세의 심층 근거 · 점선 링 · 심층 n 배지';


COMMENT ON COLUMN gold.ctx_claim.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_claim.entity_id IS '조건';


COMMENT ON COLUMN gold.ctx_claim.claim IS '주장문';


COMMENT ON COLUMN gold.ctx_claim.supporting IS '지지';


COMMENT ON COLUMN gold.ctx_claim.contradicting IS '반박';


COMMENT ON COLUMN gold.ctx_claim.neutral IS '중립 수';


COMMENT ON COLUMN gold.ctx_claim.total_scanned IS '검토 소스 수';


COMMENT ON COLUMN gold.ctx_claim.confidence IS 'high · medium · low';


CREATE TABLE gold.ctx_claim_quote (
    snapshot_id smallint NOT NULL,
    entity_id uuid NOT NULL,
    seq integer NOT NULL,
    quote text,
    source text,
    stance text
);


COMMENT ON TABLE gold.ctx_claim_quote IS '[소셜] 심층 근거 × 인용 표본
심층 근거 × 인용 표본 1개 = 1행.
입력: 데이터 분석팀 (출처 제안: 심층 근거 검증)
쓰임: Global > Customer interest > Social Scraping 그래프 심층 근거의 표본 인용 (앞 3개 표시)';


COMMENT ON COLUMN gold.ctx_claim_quote.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_claim_quote.entity_id IS 'ERD 설명 없음 · 열 묶음 「snapshot_id · entity_id」';


COMMENT ON COLUMN gold.ctx_claim_quote.seq IS 'ERD 설명 없음 · 열 묶음 「seq」';


COMMENT ON COLUMN gold.ctx_claim_quote.quote IS 'ERD 설명 없음 · 열 묶음 「quote」';


COMMENT ON COLUMN gold.ctx_claim_quote.source IS '출처 도메인';


COMMENT ON COLUMN gold.ctx_claim_quote.stance IS 'supporting · contradicting · neutral';


CREATE TABLE gold.ctx_combination (
    snapshot_id smallint NOT NULL,
    combo_id text NOT NULL,
    cond_a uuid,
    cond_b uuid,
    cond_more uuid[],
    co_count integer,
    description text,
    total_speakers integer,
    unique_source_count integer
);


COMMENT ON TABLE gold.ctx_combination IS '[소셜] 조건 조합 (2개 이상)
스냅샷 × 조건 조합 1개 (쌍 또는 3개 이상) = 1행.
입력: 데이터 분석팀
갱신: 스냅샷 적재 때 함께 (제안)
쓰임: Project > Intent > Social Scraping 관계 수 · 조합 패턴 표 · 내보내기 · 프롬프트 시드, Global · Admin 조합 표, Global 그래프 조합 목록 · 상세
규칙:
- 조합 1개 = 1행입니다. 첫째 · 둘째 조건은 cond_a · cond_b, 셋째부터는 cond_more 에 둡니다. combo_id 는 구성 조건 id 를 : 로 이은 값입니다. 쌍 기준인 Project 표 · 내보내기 · 프롬프트 시드는 cond_more 가 빈 행만 읽습니다.
- 그래프 중첩률 = co_count ÷ total_speakers, 근거 문구 = "{total_speakers}명 중 {co_count}명 ({반올림 %})" 이고, 저장하지 않고 조회 때 만듭니다.';


COMMENT ON COLUMN gold.ctx_combination.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_combination.combo_id IS '조건 id 를 : 로 이음';


COMMENT ON COLUMN gold.ctx_combination.cond_a IS '첫째';


COMMENT ON COLUMN gold.ctx_combination.cond_b IS '둘째 조건';


COMMENT ON COLUMN gold.ctx_combination.cond_more IS '셋째 이후 조건 id';


COMMENT ON COLUMN gold.ctx_combination.co_count IS '동시 출현';


COMMENT ON COLUMN gold.ctx_combination.description IS '조합 시나리오';


COMMENT ON COLUMN gold.ctx_combination.total_speakers IS '중첩률 분모';


COMMENT ON COLUMN gold.ctx_combination.unique_source_count IS '고유 출처 수';


CREATE TABLE gold.ctx_combination_evidence (
    snapshot_id smallint NOT NULL,
    combo_id text NOT NULL,
    seq integer NOT NULL,
    quote text,
    source_title text,
    source_url text,
    perspective text
);


COMMENT ON TABLE gold.ctx_combination_evidence IS '[소셜] 조합 × 근거 발화
스냅샷 × 조건 조합 × 근거 발화 1개 = 1행.
입력: 데이터 분석팀
갱신: 스냅샷 적재 때 함께 (제안)
쓰임: Global > Customer interest > Social Scraping 그래프 조합 상세의 근거 인용 · 출처 링크 (20개 + 외 n건)';


COMMENT ON COLUMN gold.ctx_combination_evidence.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_combination_evidence.combo_id IS '조건 id 를 : 로 이음';


COMMENT ON COLUMN gold.ctx_combination_evidence.seq IS 'ERD 설명 없음 · 열 묶음 「seq」';


COMMENT ON COLUMN gold.ctx_combination_evidence.quote IS 'ERD 설명 없음 · 열 묶음 「quote」';


COMMENT ON COLUMN gold.ctx_combination_evidence.source_title IS 'ERD 설명 없음 · 열 묶음 「source_title · source_url」';


COMMENT ON COLUMN gold.ctx_combination_evidence.source_url IS 'ERD 설명 없음 · 열 묶음 「source_title · source_url」';


COMMENT ON COLUMN gold.ctx_combination_evidence.perspective IS 'buyer · seller · neutral';


CREATE TABLE gold.ctx_domain (
    snapshot_id smallint NOT NULL,
    entity_id uuid NOT NULL,
    host text NOT NULL,
    n integer
);


COMMENT ON TABLE gold.ctx_domain IS '[소셜] 엔티티 × 출처 host
스냅샷 × 엔티티 × 출처 host = 1행.
입력: 데이터 분석팀
갱신: 스냅샷 적재 때 함께 (제안)
쓰임: Project > Intent > Social Scraping 출처 도메인 수 · 상세 소스 도메인, Global · Admin 상세 소스 도메인, Global 그래프 도메인별 출처';


COMMENT ON COLUMN gold.ctx_domain.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_domain.entity_id IS '스냅샷 × 맥락·조건 키';


COMMENT ON COLUMN gold.ctx_domain.host IS 'ERD 설명 없음 · 열 묶음 「host」';


COMMENT ON COLUMN gold.ctx_domain.n IS 'ERD 설명 없음 · 열 묶음 「n」';


CREATE TABLE gold.ctx_drive (
    snapshot_id smallint NOT NULL,
    context_id uuid NOT NULL,
    requirement_id uuid NOT NULL,
    co_count integer,
    strength_score numeric
);


COMMENT ON TABLE gold.ctx_drive IS '[소셜] 맥락 → 조건 연결
스냅샷 × 맥락 × 조건 = 1행.
입력: 데이터 분석팀
갱신: 스냅샷 적재 때 함께 (제안)
쓰임: Project > Intent > Social Scraping 관계 수 · 연결 수 · 상세 연결 항목 · 프롬프트 시드, Global 그래프 유발 링크';


COMMENT ON COLUMN gold.ctx_drive.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_drive.context_id IS '스냅샷 × 맥락·조건 키';


COMMENT ON COLUMN gold.ctx_drive.requirement_id IS '스냅샷 × 맥락·조건 키';


COMMENT ON COLUMN gold.ctx_drive.co_count IS '동시 출현';


COMMENT ON COLUMN gold.ctx_drive.strength_score IS '그래프 유발 강도';


CREATE TABLE gold.ctx_entity (
    snapshot_id smallint NOT NULL,
    id uuid NOT NULL,
    type text,
    canonical_name text,
    dimension text,
    mention_count integer,
    utterance_count integer,
    sentiment_positive integer,
    sentiment_negative integer,
    sentiment_neutral integer,
    group_id text,
    unique_source_count integer,
    perspective_buyer integer,
    perspective_seller integer,
    perspective_neutral integer,
    related_ids uuid[]
);


COMMENT ON TABLE gold.ctx_entity IS '[소셜] 스냅샷 × 맥락·조건
스냅샷 × 구매 맥락 또는 구매 조건 1개 = 1행.
입력: 데이터 분석팀
갱신: 스냅샷 적재 때 함께 (제안)
쓰임: Project > Intent > Social Scraping 맥락 · 조건 수 · 표 · 상세 · 내보내기 · 프롬프트 시드, Global · Admin 표 · 상세, Global 그래프 노드 · 연관 조건
규칙:
- 표의 감성(긍정 · 부정 · 중립)은 sentiment_*, 그래프의 관점(구매자 · 판매자 · 중립)은 perspective_* 입니다.
- 연관 조건은 조합에서 나오지 않는 별도 목록입니다.';


COMMENT ON COLUMN gold.ctx_entity.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_entity.id IS 'ERD 설명 없음 · 열 묶음 「id」';


COMMENT ON COLUMN gold.ctx_entity.type IS 'ConsumerContext · ConsumerRequirement';


COMMENT ON COLUMN gold.ctx_entity.canonical_name IS 'ERD 설명 없음 · 열 묶음 「canonical_name」';


COMMENT ON COLUMN gold.ctx_entity.dimension IS '맥락 테마 코드 (맥락만)';


COMMENT ON COLUMN gold.ctx_entity.mention_count IS 'ERD 설명 없음 · 열 묶음 「mention_count · utterance_count」';


COMMENT ON COLUMN gold.ctx_entity.utterance_count IS 'ERD 설명 없음 · 열 묶음 「mention_count · utterance_count」';


COMMENT ON COLUMN gold.ctx_entity.sentiment_positive IS '표의 감성 분포 (긍정)';


COMMENT ON COLUMN gold.ctx_entity.sentiment_negative IS '표의 감성 분포 (부정)';


COMMENT ON COLUMN gold.ctx_entity.sentiment_neutral IS '표의 감성 분포 (중립)';


COMMENT ON COLUMN gold.ctx_entity.group_id IS '테마 · 카테고리';


COMMENT ON COLUMN gold.ctx_entity.unique_source_count IS '고유 출처 수';


COMMENT ON COLUMN gold.ctx_entity.perspective_buyer IS '구매자 · 판매자 · 중립 관점 (구매자)';


COMMENT ON COLUMN gold.ctx_entity.perspective_seller IS '구매자 · 판매자 · 중립 관점 (판매자)';


COMMENT ON COLUMN gold.ctx_entity.perspective_neutral IS '구매자 · 판매자 · 중립 관점 (중립)';


COMMENT ON COLUMN gold.ctx_entity.related_ids IS '연관 조건 id · 조건만';


CREATE TABLE gold.ctx_evidence (
    snapshot_id smallint NOT NULL,
    id uuid NOT NULL,
    entity_id uuid,
    utterance_id text,
    quote text,
    source_host text,
    source_url text,
    sentiment text,
    source_title text,
    rank integer,
    perspective text
);


COMMENT ON TABLE gold.ctx_evidence IS '[소셜] 근거 발화 1개
스냅샷 × 근거 발화 1개 = 1행.
입력: 데이터 분석팀
갱신: 스냅샷 적재 때 함께 (제안)
쓰임: Project > Intent > Social Scraping 상세 근거 인용, Global · Admin 상세 근거 인용, Global 그래프 근거 인용
규칙:
- 엔티티 상세의 근거 인용은 rank 순으로 읽고, 출처 제목 자리에는 source_title 을 씁니다.';


COMMENT ON COLUMN gold.ctx_evidence.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_evidence.id IS 'ERD 설명 없음 · 열 묶음 「id」';


COMMENT ON COLUMN gold.ctx_evidence.entity_id IS '스냅샷 × 맥락·조건 키';


COMMENT ON COLUMN gold.ctx_evidence.utterance_id IS 'ERD 설명 없음 · 열 묶음 「utterance_id」';


COMMENT ON COLUMN gold.ctx_evidence.quote IS '근거 인용';


COMMENT ON COLUMN gold.ctx_evidence.source_host IS 'ERD 설명 없음 · 열 묶음 「source_host · source_url」';


COMMENT ON COLUMN gold.ctx_evidence.source_url IS 'ERD 설명 없음 · 열 묶음 「source_host · source_url」';


COMMENT ON COLUMN gold.ctx_evidence.sentiment IS 'ERD 설명 없음 · 열 묶음 「sentiment」';


COMMENT ON COLUMN gold.ctx_evidence.source_title IS '출처 제목';


COMMENT ON COLUMN gold.ctx_evidence.rank IS '표시 순서';


COMMENT ON COLUMN gold.ctx_evidence.perspective IS 'buyer · seller · neutral 관점';


CREATE TABLE gold.ctx_group (
    snapshot_id smallint NOT NULL,
    group_id text NOT NULL,
    side text,
    name text,
    description text,
    sort_order integer
);


COMMENT ON TABLE gold.ctx_group IS '[소셜] 스냅샷 × 테마·카테고리
스냅샷 × 테마 또는 카테고리 1개 = 1행.
입력: 데이터 분석팀
갱신: 스냅샷 적재 때 함께 (제안)
쓰임: Social Scraping (Project · Global) · Customer interest config 표의 주제 · 카테고리 열, Global 그래프 테마 · 카테고리 노드 이름 · 설명';


COMMENT ON COLUMN gold.ctx_group.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_group.group_id IS 'ERD 설명 없음 · 열 묶음 「group_id」';


COMMENT ON COLUMN gold.ctx_group.side IS 'context 테마 · condition 카테고리';


COMMENT ON COLUMN gold.ctx_group.name IS 'ERD 설명 없음 · 열 묶음 「name」';


COMMENT ON COLUMN gold.ctx_group.description IS '설명문';


COMMENT ON COLUMN gold.ctx_group.sort_order IS '표시 순서';


CREATE TABLE gold.ctx_research_log (
    run_id uuid NOT NULL,
    seq integer NOT NULL,
    kind text,
    title text,
    detail text
);


COMMENT ON TABLE gold.ctx_research_log IS '[소셜] 실행 × 활동 로그
실행 × 로그 1줄 = 1행.
입력: 데이터 분석팀
갱신: 리서치 진행 중 추가 (제안)
쓰임: Admin > Global config > Customer interest config 탐색 화면 활동 로그';


COMMENT ON COLUMN gold.ctx_research_log.run_id IS '리서치 실행 키';


COMMENT ON COLUMN gold.ctx_research_log.seq IS '표시 순서';


COMMENT ON COLUMN gold.ctx_research_log.kind IS 'wave · reasoning · search · discover · worker · confirmation · complete';


COMMENT ON COLUMN gold.ctx_research_log.title IS 'ERD 설명 없음 · 열 묶음 「title · detail」';


COMMENT ON COLUMN gold.ctx_research_log.detail IS 'ERD 설명 없음 · 열 묶음 「title · detail」';


CREATE TABLE gold.ctx_research_run (
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


COMMENT ON TABLE gold.ctx_research_run IS '[소셜] 리서치 실행 1회
리서치 실행 1회 = 1행.
입력: 데이터 분석팀
갱신: 요청 접수 · 진행 · 완료 때 갱신 (제안)
쓰임: Admin > Global config > Customer interest config 리서치 입력 폼 · 탐색 화면 상태 · 카운터 · 결과 지도';


COMMENT ON COLUMN gold.ctx_research_run.run_id IS '리서치 실행 키';


COMMENT ON COLUMN gold.ctx_research_run.keyword IS '키워드 / 토픽';


COMMENT ON COLUMN gold.ctx_research_run.geo_key IS '지역';


COMMENT ON COLUMN gold.ctx_research_run.lang_key IS '지역 프리셋 언어';


COMMENT ON COLUMN gold.ctx_research_run.purpose_preset IS '리서치 목적 프리셋';


COMMENT ON COLUMN gold.ctx_research_run.purpose_text IS '본문';


COMMENT ON COLUMN gold.ctx_research_run.status IS 'queued · exploring · confirm · done · failed';


COMMENT ON COLUMN gold.ctx_research_run.search_count IS '검색';


COMMENT ON COLUMN gold.ctx_research_run.source_count IS '소스';


COMMENT ON COLUMN gold.ctx_research_run.worker_count IS '완료 워커 수';


COMMENT ON COLUMN gold.ctx_research_run.snapshot_id IS '결과 지도';


CREATE TABLE gold.ctx_research_wave (
    run_id uuid NOT NULL,
    wave_no integer NOT NULL,
    strategy text
);


COMMENT ON TABLE gold.ctx_research_wave IS '[소셜] 실행 × 탐색 웨이브
실행 × 웨이브 1개 = 1행.
입력: 데이터 분석팀
갱신: 리서치 진행 중 추가 (제안)
쓰임: Admin > Global config > Customer interest config 탐색 화면 Wave 목록';


COMMENT ON COLUMN gold.ctx_research_wave.run_id IS '리서치 실행 키';


COMMENT ON COLUMN gold.ctx_research_wave.wave_no IS 'ERD 설명 없음 · 열 묶음 「wave_no」';


COMMENT ON COLUMN gold.ctx_research_wave.strategy IS '탐색 전략 문구';


CREATE TABLE gold.ctx_research_worker (
    run_id uuid NOT NULL,
    worker_id text NOT NULL,
    wave_no integer,
    label text,
    query text,
    status text,
    source_count integer
);


COMMENT ON TABLE gold.ctx_research_worker IS '[소셜] 실행 × 워커
실행 × 워커 1개 = 1행.
입력: 데이터 분석팀
갱신: 리서치 진행 중 추가 · 갱신 (제안)
쓰임: Admin > Global config > Customer interest config 탐색 화면 워커 칩 · 완료 워커 수';


COMMENT ON COLUMN gold.ctx_research_worker.run_id IS '리서치 실행 키';


COMMENT ON COLUMN gold.ctx_research_worker.worker_id IS 'ERD 설명 없음 · 열 묶음 「worker_id」';


COMMENT ON COLUMN gold.ctx_research_worker.wave_no IS '소속 Wave';


COMMENT ON COLUMN gold.ctx_research_worker.label IS '칩 이름';


COMMENT ON COLUMN gold.ctx_research_worker.query IS '검색어';


COMMENT ON COLUMN gold.ctx_research_worker.status IS 'searching · analyzing · completed';


COMMENT ON COLUMN gold.ctx_research_worker.source_count IS '수집 소스 수';


CREATE TABLE gold.ctx_snapshot (
    snapshot_id smallint NOT NULL,
    industry_entity_id uuid,
    source text,
    utterance_total integer,
    taken_at date,
    is_active boolean,
    keyword text,
    worker_total integer,
    source_total integer
);


COMMENT ON TABLE gold.ctx_snapshot IS '[소셜] 분석 스냅샷 1개
구매 맥락 분석 스냅샷 1개 = 1행.
입력: 데이터 분석팀 (출처 제안: 소셜 코퍼스 · 리서치 실행 결과)
갱신: 스냅샷 전체 적재 후 활성 전환 (제안)
쓰임: Project > Intent > Social Scraping 활성 스냅샷 · 기준일, Global > Customer interest > Social Scraping 지도 제목 · 그래프 통계, Admin > Global config > Customer interest config 지도 제목
규칙:
- Project > Intent > Social Scraping 은 활성(is_active) 스냅샷을 읽습니다. 활성 스냅샷은 산업(industry_entity_id)당 1개입니다. 리서치 결과 지도는 ctx_research_run.snapshot_id 의 스냅샷입니다.
- 그래프의 클러스터 표시는 ctx_entity.mention_count / worker_total, 비율은 mention_count ÷ worker_total 이고 조회 때 계산합니다.';


COMMENT ON COLUMN gold.ctx_snapshot.snapshot_id IS '분석 스냅샷 키';


COMMENT ON COLUMN gold.ctx_snapshot.industry_entity_id IS '산업 엔티티';


COMMENT ON COLUMN gold.ctx_snapshot.source IS 'ERD 설명 없음 · 열 묶음 「source」';


COMMENT ON COLUMN gold.ctx_snapshot.utterance_total IS 'ERD 설명 없음 · 열 묶음 「utterance_total」';


COMMENT ON COLUMN gold.ctx_snapshot.taken_at IS '기준일 (as_of)';


COMMENT ON COLUMN gold.ctx_snapshot.is_active IS '산업당 활성 1개';


COMMENT ON COLUMN gold.ctx_snapshot.keyword IS '지도 제목 키워드';


COMMENT ON COLUMN gold.ctx_snapshot.worker_total IS '분석 표본';


COMMENT ON COLUMN gold.ctx_snapshot.source_total IS '출처 수';


CREATE TABLE gold.dim_brand (
    brand_key integer NOT NULL,
    name text,
    bare text,
    kind smallint,
    own_bit integer,
    first_seen date
);


COMMENT ON TABLE gold.dim_brand IS '[KPI·언급 셀] 표시 브랜드 1개
표시 브랜드 1개 = 1행 (brand_key 0 = 이름 없음).
입력: 데이터 분석팀
쓰임: 브랜드 이름·자사 비트: 경쟁사 표·브랜드 순위·헤드투헤드, 국가별 GEO, 추이, 인용 도메인, ACR 브랜드 표, 답변 모달·언급 프롬프트, 검수 상세, Entity catalog
규칙:
- kind = 1 ⇔ own_bit ≠ 0 (당사 브랜드).';


COMMENT ON COLUMN gold.dim_brand.brand_key IS '표시 브랜드 키';


COMMENT ON COLUMN gold.dim_brand.name IS '표시명';


COMMENT ON COLUMN gold.dim_brand.bare IS '정본명 키 (기본 소문자·트림)';


COMMENT ON COLUMN gold.dim_brand.kind IS '0 이름 없음 · 1 자사 · 2 경쟁 · 3 비경쟁';


COMMENT ON COLUMN gold.dim_brand.own_bit IS '0 · 1 Hyundai · 2 Kia · 4 Genesis';


COMMENT ON COLUMN gold.dim_brand.first_seen IS '행 생성일';


CREATE TABLE gold.dim_category (
    category_key smallint NOT NULL,
    name text,
    slug text,
    ord integer
);


COMMENT ON TABLE gold.dim_category IS '[인용 셀] 출처 카테고리 1개
출처 카테고리 1개 = 1행.
입력: 데이터 분석팀 (출처 제안: GEO HUB 출처 카테고리 코드표의 투영)
쓰임: 출처 카테고리 분포 · 추이 · 필터 옵션, 공식(HMG) · 딜러·마켓 비중, 인용 출처 분류 카테고리 목록
규칙:
- category_key k 는 answer_fact.cit_c<k> 열의 번호입니다 (1~13).';


COMMENT ON COLUMN gold.dim_category.category_key IS '1~13';


COMMENT ON COLUMN gold.dim_category.name IS 'Official (HMG) … Other';


COMMENT ON COLUMN gold.dim_category.slug IS 'camelCase 코드';


COMMENT ON COLUMN gold.dim_category.ord IS '표시 순서';


CREATE TABLE gold.dim_country (
    geo_key smallint NOT NULL,
    code text,
    region_key smallint,
    kind text,
    virtual_brand_bit integer,
    hidden_standard boolean
);


COMMENT ON TABLE gold.dim_country IS '[공통 차원] 국가(시장) 1개
국가(시장) 1개 = 1행.
입력: 데이터 분석팀
쓰임: 국가 필터·권한(가상 브랜드 코드 포함), 국가 코드 표기(국가별 GEO 현황 · 답변 · 인용 · ACR), global 숨김 시장, AI Conversion 시장 ↔ GA4 속성 매핑, Website 자사 · 타겟 URL 인용률 카드의 발행값 국가 범위, Admin › User management 계정 국가 스코프 검증
규칙:
- kind unknown 은 geo_key 0 표식 행입니다.';


COMMENT ON COLUMN gold.dim_country.geo_key IS '국가(시장) 키';


COMMENT ON COLUMN gold.dim_country.code IS '국가 코드 (대소문자 무시 유일)';


COMMENT ON COLUMN gold.dim_country.region_key IS '대륙';


COMMENT ON COLUMN gold.dim_country.kind IS 'iso · pseudo · virtual_brand · unknown · 가상 브랜드 비트';


COMMENT ON COLUMN gold.dim_country.virtual_brand_bit IS 'iso · pseudo · virtual_brand · unknown · 가상 브랜드 비트';


COMMENT ON COLUMN gold.dim_country.hidden_standard IS 'global 숨김 시장';


CREATE TABLE gold.dim_crawl_bot (
    bot_key smallint NOT NULL,
    code text,
    engine_key smallint
);


COMMENT ON TABLE gold.dim_crawl_bot IS '[AI Visibility] AI 크롤러 1개
AI 크롤러 1개 = 1행.
입력: 데이터 분석팀 (출처 제안: 크롤러 UA 목록)
쓰임: AI Visibility AI 크롤 수의 봇 구성 · 엔진 필터
규칙:
- 엔진 필터는 AI 크롤 수만 좁힙니다 (engine_key 가 그 엔진인 봇의 hits). 검색 노출에는 엔진이 없습니다.';


COMMENT ON COLUMN gold.dim_crawl_bot.bot_key IS 'AI 크롤러 키';


COMMENT ON COLUMN gold.dim_crawl_bot.code IS 'UA 토큰 (예: ChatGPT-User)';


COMMENT ON COLUMN gold.dim_crawl_bot.engine_key IS '측정 엔진 · 없으면 0';


CREATE TABLE gold.dim_custom_field (
    field_id uuid NOT NULL,
    project_key smallint,
    label text,
    archived boolean,
    created_at timestamp with time zone
);


COMMENT ON TABLE gold.dim_custom_field IS '[프롬프트·웹 유닛] 프로젝트 커스텀 필드 1개
프로젝트 커스텀 필드(태그 열) 1개 = 1행.
입력: 데이터 분석팀 (출처 제안: GEO HUB 프로젝트 커스텀 필드 설정의 투영)
갱신: 커스텀 필드 설정이 바뀔 때
쓰임: Project › Dashboard · Analysis › Mention · Analysis › Citation 의 커스텀 태그 필터 (필드 이름 · 순서)
규칙:
- 보관(archived) 필드는 필터 옵션에서 뺍니다.
- 필드 순서는 created_at, field_id 순입니다.';


COMMENT ON COLUMN gold.dim_custom_field.field_id IS '프로젝트 커스텀 필드 키';


COMMENT ON COLUMN gold.dim_custom_field.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.dim_custom_field.label IS '필드 이름 · 프로젝트 안 유일';


COMMENT ON COLUMN gold.dim_custom_field.archived IS '보관';


COMMENT ON COLUMN gold.dim_custom_field.created_at IS '필드 순서 (생성 순)';


CREATE TABLE gold.dim_cycle (
    cyc_key integer NOT NULL,
    cycle_id uuid,
    surface smallint,
    ledger_backed boolean,
    project_key smallint,
    round_date date,
    anchor_date date,
    status smallint,
    servable boolean,
    view_date date,
    hidden_scope smallint,
    hidden_reason smallint,
    expected_units integer,
    completed_units integer,
    completed_answers integer,
    gap_answers integer,
    generation integer,
    ecat_ver text
);


COMMENT ON TABLE gold.dim_cycle IS '[공통 차원] 회차 1개
회차 1개 = 1행. 프로젝트 가상 회차도 같은 발급처에서 키를 받습니다.
입력: 데이터 분석팀
쓰임: 분석 화면의 기간·회차 창(servable ∧ view_date ≤ 오늘), 추이 · 기간 비교, 답변 상세 노출 게이트, Project › Prompt 영향 수, Project › Setting › General 분석 연결 진단, Entity catalog 버전 고정(ecat_ver)
규칙:
- servable · view_date · hidden_scope 는 조회 때 거는 게이트입니다(사실 행은 그대로). release 를 거치지 않고 바뀐 즉시 보이며, 바뀌면 data_version 을 올립니다.
- status 0 open · 1 closed · 2 published · 3 stale. servable = published ∧ 함대 가시 (project 표면은 항상 참).
- hidden_scope 0 없음 · 1 all · 2 citations · 3 mentions, hidden_reason 0 없음 · 1 collection_error · 2 operator. 둘은 함께 0 이거나 함께 0 이 아닙니다.
- 최종 KPI 는 중간 집계 없이 회차 분석이 끝난 뒤 계산합니다 (20261015/D07).';


COMMENT ON COLUMN gold.dim_cycle.cyc_key IS '회차 키';


COMMENT ON COLUMN gold.dim_cycle.cycle_id IS 'ERD 설명 없음 · 열 묶음 「cycle_id」';


COMMENT ON COLUMN gold.dim_cycle.surface IS '표면';


COMMENT ON COLUMN gold.dim_cycle.ledger_backed IS '원장 회차(파생 아님)';


COMMENT ON COLUMN gold.dim_cycle.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.dim_cycle.round_date IS 'ERD 설명 없음 · 열 묶음 「round_date · anchor_date」';


COMMENT ON COLUMN gold.dim_cycle.anchor_date IS 'ERD 설명 없음 · 열 묶음 「round_date · anchor_date」';


COMMENT ON COLUMN gold.dim_cycle.status IS '상태';


COMMENT ON COLUMN gold.dim_cycle.servable IS '서빙 가능';


COMMENT ON COLUMN gold.dim_cycle.view_date IS '노출일';


COMMENT ON COLUMN gold.dim_cycle.hidden_scope IS '숨김 범위';


COMMENT ON COLUMN gold.dim_cycle.hidden_reason IS '숨김 사유';


COMMENT ON COLUMN gold.dim_cycle.expected_units IS '진행률';


COMMENT ON COLUMN gold.dim_cycle.completed_units IS '진행률';


COMMENT ON COLUMN gold.dim_cycle.completed_answers IS 'ERD 설명 없음 · 열 묶음 「completed_answers · gap_answers」';


COMMENT ON COLUMN gold.dim_cycle.gap_answers IS 'ERD 설명 없음 · 열 묶음 「completed_answers · gap_answers」';


COMMENT ON COLUMN gold.dim_cycle.generation IS '표면 세대';


COMMENT ON COLUMN gold.dim_cycle.ecat_ver IS '고정 엔티티 버전';


CREATE TABLE gold.dim_engine (
    engine_key smallint NOT NULL,
    code text,
    is_default boolean
);


COMMENT ON TABLE gold.dim_engine IS '[공통 차원] AI 엔진 1개
AI 엔진 1개 = 1행.
입력: 데이터 분석팀
쓰임: 엔진 필터 · 기본 엔진, 엔진 코드 표기(답변 · 인용 · ACR), 필터 옵션 엔진 목록, 프로젝트 만들기 · 엔진 설정의 엔진 어휘, 검수 목록 엔진 필터';


COMMENT ON COLUMN gold.dim_engine.engine_key IS 'AI 엔진 키';


COMMENT ON COLUMN gold.dim_engine.code IS 'AI 엔진 코드';


COMMENT ON COLUMN gold.dim_engine.is_default IS '기본 엔진 (engine 미지정 시)';


CREATE TABLE gold.dim_entity (
    entity_key integer NOT NULL,
    entity_id uuid,
    entity_type text,
    registry_role text,
    rep_name text,
    brand_key integer,
    first_seen timestamp with time zone
);


COMMENT ON TABLE gold.dim_entity IS '[KPI·언급 셀] 엔티티 1개
Scope 엔티티 1개 = 1행 (언급·스탠스·ACR 에 나온 전부, entity_type Brand · Product 등).
입력: 데이터 분석팀
쓰임: ACR 차종 전환율 이름, 명부 제외 브랜드 판정(순위·목록), Entity catalog, 답변 모달·언급 프롬프트의 엔티티 → 브랜드, 검수 상세 이름·ACR';


COMMENT ON COLUMN gold.dim_entity.entity_key IS '엔티티 키';


COMMENT ON COLUMN gold.dim_entity.entity_id IS 'ERD 설명 없음 · 열 묶음 「entity_id」';


COMMENT ON COLUMN gold.dim_entity.entity_type IS 'ERD 설명 없음 · 열 묶음 「entity_type · registry_role」';


COMMENT ON COLUMN gold.dim_entity.registry_role IS 'ERD 설명 없음 · 열 묶음 「entity_type · registry_role」';


COMMENT ON COLUMN gold.dim_entity.rep_name IS '대표 표시명';


COMMENT ON COLUMN gold.dim_entity.brand_key IS '표시 브랜드 키';


COMMENT ON COLUMN gold.dim_entity.first_seen IS '행 생성 시각';


CREATE TABLE gold.dim_keyword (
    kw_key integer NOT NULL,
    term text,
    term_norm text
);


COMMENT ON TABLE gold.dim_keyword IS '[키워드] 검색어 1개
검색어 1개 = 1행.
입력: 데이터 분석팀 (출처: DataForSEO 수집 검색어. term_norm 으로 발급)
쓰임: Google keywords · Google Keyword · Keyword tools 의 검색어 조회';


COMMENT ON COLUMN gold.dim_keyword.kw_key IS '검색어 키';


COMMENT ON COLUMN gold.dim_keyword.term IS 'ERD 설명 없음 · 열 묶음 「term」';


COMMENT ON COLUMN gold.dim_keyword.term_norm IS '정규화 (NFC · 공백 trim · 소문자)';


CREATE TABLE gold.dim_lang (
    lang_key smallint NOT NULL,
    code text
);


COMMENT ON TABLE gold.dim_lang IS '[공통 차원] 언어 1개
언어 1개 = 1행.
입력: 데이터 분석팀
쓰임: 언어 필터, 언어 코드 표기(ACR · 검수)';


COMMENT ON COLUMN gold.dim_lang.lang_key IS '언어 키';


COMMENT ON COLUMN gold.dim_lang.code IS '소문자 언어 코드';


CREATE TABLE gold.dim_owned_base (
    owner_key smallint NOT NULL,
    kind text,
    prefix text,
    host text,
    brand_code text,
    brand_bit integer,
    geo_code text,
    language text
);


COMMENT ON TABLE gold.dim_owned_base IS '[인용 셀] 당사 소유 URL 베이스 1개
당사 소유 URL 베이스 1개 = 1행.
입력: 데이터 분석팀 (출처 제안: GEO HUB 자사 URL 베이스 설정의 투영)
갱신: 자사 URL 베이스 설정이 바뀔 때
쓰임: Global 자사 인용 판정(도메인 순위 · 인용 프롬프트 · 답변 모달 · 도메인 상세의 자사 표시와 수), Admin › Global config › 인용 출처 분류 자사 도메인 분류 경고, 도메인 상세 URL 국가
규칙:
- 허용 배열(Global 자사 판정의 베이스 목록): brand_bit 가 관점 own_bits 에 드는 행(kind 둘 다) → 요청 iso 국가의 geo_code 로 좁힘 → 요청 언어의 language 로 좁힘. 좁힌 결과가 비면 그 단계는 좁히지 않고, 관점 브랜드의 행이 없으면 전체 행입니다.
- dim_url.owner_key: URL 베이스 정규형이 root_home 접두와 같은 행(공유 글로벌 호스트 제외)이 먼저, 없으면 호스트가 같고 접두가 맞는 가장 긴 base 행입니다.
- Project 인용 자사 판정(loc_owned) 접두에는 프로젝트와 브랜드 · 국가가 같은 base 행의 접두를 더하고, 프로젝트 접두 아래의 더 깊은 base 접두(프로젝트 접두가 아닌 것)는 자사에서 뺍니다.
- Website 자사 판정은 이 표가 아니라 web_unit 의 base · sibs 를 씁니다.
- 베이스가 바뀌면 dim_url.owner_key 와 그 URL 을 인용한 답변의 글로벌 자사 인용 수(cit_own_*)를 다시 판정하고, 영향 회차를 새 build 로 만듭니다.
- owner_key 0 은 "자사 아님" 표식 행입니다(kind · prefix 비움). citation_cell.owner_key 0 이 이 행을 가리킵니다.';


COMMENT ON COLUMN gold.dim_owned_base.owner_key IS '0 = 자사 아님 표식';


COMMENT ON COLUMN gold.dim_owned_base.kind IS 'base · root_home';


COMMENT ON COLUMN gold.dim_owned_base.prefix IS '접두 · 호스트 · UNIQUE(kind, prefix)';


COMMENT ON COLUMN gold.dim_owned_base.host IS '접두 · 호스트 · UNIQUE(kind, prefix)';


COMMENT ON COLUMN gold.dim_owned_base.brand_code IS 'Hyundai 1 · Kia 2 · Genesis 4';


COMMENT ON COLUMN gold.dim_owned_base.brand_bit IS 'Hyundai 1 · Kia 2 · Genesis 4';


COMMENT ON COLUMN gold.dim_owned_base.geo_code IS '국가';


COMMENT ON COLUMN gold.dim_owned_base.language IS '언어 필터 좁힘';


CREATE TABLE gold.dim_perspective (
    perspective_key smallint NOT NULL,
    own_bits integer,
    label text
);


COMMENT ON TABLE gold.dim_perspective IS '[KPI·언급 셀] 당사 브랜드 조합 1개
당사 브랜드 비트 조합 1개 = 1행. 실제 쓰는 조합만 둡니다 (최대 7개).
입력: 데이터 분석팀 (출처 제안: own_bits 1~7 고정 코드표)
쓰임: KPI · 언급 · 인용 화면의 브랜드 관점(Global · Website = 계정 브랜드 범위 ∩ 브랜드 필터, Project = 프로젝트 브랜드, 없으면 3사)으로 kpi_cell · kpi_rollup · citation_cell 행을 고르는 축
규칙:
- 조회는 관점 1개를 명시해 중복 합산을 막습니다.
- 복수 관점의 노출 · 순위는 브랜드 행 합이 아니라 답변 단위 판정입니다 (노출 = 어느 한 브랜드 언급, 순위 = 0 을 뺀 최솟값). 그래서 조합마다 행을 둡니다.';


COMMENT ON COLUMN gold.dim_perspective.perspective_key IS '당사 브랜드 조합 키';


COMMENT ON COLUMN gold.dim_perspective.own_bits IS '1 현대 · 2 기아 · 4 제네시스 합';


COMMENT ON COLUMN gold.dim_perspective.label IS '단일 = brand_code · 복수 = 엄브렐러';


CREATE TABLE gold.dim_population (
    population_key smallint NOT NULL,
    code text,
    gate text,
    rep_mode text
);


COMMENT ON TABLE gold.dim_population IS '[공통 차원] 모수 규칙 1개
셀 집계(kpi_cell · brand_cell · citation_cell · url_prompt_cell)의 모수 규칙 1개 = 1행.
입력: 데이터 분석팀 (출처 제안: answer_fact 의 게이트 · 모수 열 정의)
규칙:
- 언급(std_in) · 인용(cit_in, 결손 포함) · URL(web_reg) · ACR(acr_in) 모수가 서로 달라 답변 수 하나로 모든 분모를 대신할 수 없습니다.
- 삭제 행 포함 카탈로그 모수(std_in_nc · cit_in_nc), 셀 대표 답변(is_rep), 보고 유닛 게이트처럼 모수를 바꾸는 조합은 모수 규칙 행 하나로 둡니다.';


COMMENT ON COLUMN gold.dim_population.population_key IS '모수 규칙 키';


COMMENT ON COLUMN gold.dim_population.code IS 'mentions · citations · gap · url · acr';


COMMENT ON COLUMN gold.dim_population.gate IS 'std_in · cit_in · gap · web_reg · acr_in · *_nc';


COMMENT ON COLUMN gold.dim_population.rep_mode IS '대표 답변 선택 규칙';


CREATE TABLE gold.dim_project (
    project_key smallint NOT NULL,
    scope_project_id uuid,
    surface smallint,
    is_root boolean,
    project_id uuid,
    site_id uuid,
    site_brand_bit integer,
    site_geo_key smallint,
    regions text[]
);


COMMENT ON TABLE gold.dim_project IS '[공통 차원] Scope 프로젝트 1개
Scope 프로젝트 1개 = 1행. global 루트, 웹사이트 사이트, 고객 프로젝트의 Scope 프로젝트가 모두 들어갑니다.
입력: 데이터 분석팀
쓰임: 표면·프로젝트 범위(global 루트 · 웹사이트 사이트 선택 · Project 화면의 프로젝트 키), 답변 상세 프로젝트 확인, Admin › Global config › Global prompts 시장 어휘(regions)';


COMMENT ON COLUMN gold.dim_project.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.dim_project.scope_project_id IS 'ERD 설명 없음 · 열 묶음 「scope_project_id」';


COMMENT ON COLUMN gold.dim_project.surface IS '1 global · 2 website · 3 project';


COMMENT ON COLUMN gold.dim_project.is_root IS '표준 루트 (global 1개)';


COMMENT ON COLUMN gold.dim_project.project_id IS '프로젝트 ID (루트 · 고객 프로젝트)';


COMMENT ON COLUMN gold.dim_project.site_id IS '웹사이트 사이트 ID';


COMMENT ON COLUMN gold.dim_project.site_brand_bit IS '사이트 브랜드 비트';


COMMENT ON COLUMN gold.dim_project.site_geo_key IS '국가';


COMMENT ON COLUMN gold.dim_project.regions IS 'Scope 시장 설정';


CREATE TABLE gold.dim_prompt (
    prompt_key integer NOT NULL,
    prompt_id uuid,
    surface smallint,
    kind text,
    project_key smallint,
    text text,
    lang_key smallint,
    funnel_key smallint,
    presence_key smallint,
    list_type_key smallint,
    depth1_key smallint,
    depth2_key smallint,
    depth3_key smallint,
    depth4_key smallint,
    in_project_catalog boolean,
    cat_mask integer,
    cat_mask_all integer,
    in_root_catalog boolean,
    in_root_catalog_all boolean,
    unit_key smallint,
    targets text[],
    web_reg boolean,
    regions text[],
    is_korean boolean,
    rule_ver text
);


COMMENT ON TABLE gold.dim_prompt IS '[프롬프트·웹 유닛] 측정 프롬프트 1개
측정 프롬프트 1개 = 1행 (single · acr).
입력: 데이터 분석팀
쓰임: 프롬프트 본문 · 퍼널 표시(답변 목록·상세 · 인용 프롬프트 · 톤 · 도메인 상세 · ACR · 검수), KPI 적용 프롬프트 수(website = web_reg), Global › Global prompts · Website › Prompts · Admin › Global config › Global prompts 카탈로그, Project › Prompt 영향 수, 검수 목록 · 노트, Project › (프로젝트) › Dashboard · Analysis › Mention · Citation 필터 바의 택소노미 필터
규칙:
- cat_mask_all · in_root_catalog_all 은 삭제 행 포함 카탈로그 기준입니다. Global 의 삭제 행 포함 모수(std_in_nc · cit_in_nc)에 카탈로그 게이트를 걸 때와 KPI 적용 프롬프트 수를 셀 때 씁니다.
- presence_key · list_type_key · depth1~4_key · in_project_catalog 는 project 프롬프트만 채웁니다(그 프로젝트의 삭제되지 않은 프롬프트 행 값, 없으면 NULL · 거짓). project 택소노미 필터(funnel · brand_presence · list_type · depth1~4)는 in_project_catalog ∧ 축 코드 일치로 겁니다. global 택소노미는 catalog_entry 로 겁니다.
- 프로젝트 안에서 Scope 프롬프트 하나에 살아 있는 프롬프트 행은 하나여야 합니다. 여럿이면 택소노미 값을 하나로 정할 수 없습니다.
- project 택소노미 필터 옵션은 dim_prompt(측정된 프롬프트)에 담긴 값입니다.';


COMMENT ON COLUMN gold.dim_prompt.prompt_key IS '측정 프롬프트 키';


COMMENT ON COLUMN gold.dim_prompt.prompt_id IS 'ERD 설명 없음 · 열 묶음 「prompt_id」';


COMMENT ON COLUMN gold.dim_prompt.surface IS '표면 · single · acr';


COMMENT ON COLUMN gold.dim_prompt.kind IS '표면 · single · acr';


COMMENT ON COLUMN gold.dim_prompt.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.dim_prompt.text IS '프롬프트 본문 (표시 · 검색)';


COMMENT ON COLUMN gold.dim_prompt.lang_key IS '언어 키';


COMMENT ON COLUMN gold.dim_prompt.funnel_key IS '택소노미 코드 키';


COMMENT ON COLUMN gold.dim_prompt.presence_key IS '택소노미 코드 키';


COMMENT ON COLUMN gold.dim_prompt.list_type_key IS '택소노미 코드 키';


COMMENT ON COLUMN gold.dim_prompt.depth1_key IS 'project 프롬프트 택소노미 (1)';


COMMENT ON COLUMN gold.dim_prompt.depth2_key IS 'project 프롬프트 택소노미 (2)';


COMMENT ON COLUMN gold.dim_prompt.depth3_key IS 'project 프롬프트 택소노미 (3)';


COMMENT ON COLUMN gold.dim_prompt.depth4_key IS 'project 프롬프트 택소노미 (4)';


COMMENT ON COLUMN gold.dim_prompt.in_project_catalog IS '프로젝트 프롬프트 행 있음 (삭제 아님)';


COMMENT ON COLUMN gold.dim_prompt.cat_mask IS '루트 카탈로그 브랜드 비트';


COMMENT ON COLUMN gold.dim_prompt.cat_mask_all IS '삭제 포함';


COMMENT ON COLUMN gold.dim_prompt.in_root_catalog IS '루트 카탈로그 소속';


COMMENT ON COLUMN gold.dim_prompt.in_root_catalog_all IS '삭제 포함';


COMMENT ON COLUMN gold.dim_prompt.unit_key IS '웹 유닛';


COMMENT ON COLUMN gold.dim_prompt.targets IS '웹 타겟 URL 정규형';


COMMENT ON COLUMN gold.dim_prompt.web_reg IS '웹 카탈로그 등록';


COMMENT ON COLUMN gold.dim_prompt.regions IS 'Scope 시장 태그';


COMMENT ON COLUMN gold.dim_prompt.is_korean IS '한글 본문';


COMMENT ON COLUMN gold.dim_prompt.rule_ver IS 'ERD 설명 없음 · 열 묶음 「rule_ver」';


CREATE TABLE gold.dim_region (
    region_key smallint NOT NULL,
    code text
);


COMMENT ON TABLE gold.dim_region IS '[공통 차원] 대륙 1개
대륙 1개 = 1행.
입력: 데이터 분석팀
규칙:
- code 는 Africa · Asia · Europe · Latin America · Middle East · North America · Oceania 와 key 0 빈 코드입니다. 계정 권역(RHQ)과는 다른 개념입니다.';


COMMENT ON COLUMN gold.dim_region.region_key IS '대륙 키';


COMMENT ON COLUMN gold.dim_region.code IS '대륙 (ISO 국가 → 대륙 매핑)';


CREATE TABLE gold.dim_source (
    source_key integer NOT NULL,
    skey text,
    domain text,
    is_social boolean,
    category_key smallint,
    category_src smallint,
    owned_brand_bit integer,
    competitor_brand_key integer,
    rule_ver text
);


COMMENT ON TABLE gold.dim_source IS '[인용 셀] 출처(도메인 · 소셜 계정) 1개
출처 그룹 키 1개 = 1행.
입력: 데이터 분석팀 · dim_category · dim_brand
쓰임: 도메인 순위 · 출처 카테고리 · 경쟁사 출처 · 추이 출처 구성 · 출처 필터 옵션 · 답변 도메인 필터 · 답변 인용 카테고리 · Admin › Global config › 인용 출처 분류';


COMMENT ON COLUMN gold.dim_source.source_key IS '0 = 호스트 없음';


COMMENT ON COLUMN gold.dim_source.skey IS '출처 그룹 키 (공식 소셜 계정은 계정 키)';


COMMENT ON COLUMN gold.dim_source.domain IS '대표 도메인';


COMMENT ON COLUMN gold.dim_source.is_social IS 'skey ≠ domain';


COMMENT ON COLUMN gold.dim_source.category_key IS '1~13';


COMMENT ON COLUMN gold.dim_source.category_src IS '1 교정 2 공식 소셜 3 당사 도메인 4 시드 5 규칙 6 Other';


COMMENT ON COLUMN gold.dim_source.owned_brand_bit IS '당사 공식 도메인 비트 · 0 = 아님';


COMMENT ON COLUMN gold.dim_source.competitor_brand_key IS '공식(경쟁사) 도메인 브랜드';


COMMENT ON COLUMN gold.dim_source.rule_ver IS '판정 규칙 버전';


CREATE TABLE gold.dim_taxon (
    taxon_key smallint NOT NULL,
    axis text,
    code text,
    parent_key smallint
);


COMMENT ON TABLE gold.dim_taxon IS '[프롬프트·웹 유닛] 택소노미 코드 1개
택소노미 코드 1개 = 1행.
입력: 데이터 분석팀
쓰임: 택소노미 필터 해석 · 필터 옵션, 퍼널 코드 표시(KPI 퍼널별 측정 수 · 인용 프롬프트 · 언급 프롬프트 · 도메인 상세 · 검수 상세), 답변 상세 택소노미
규칙:
- global 루트 카탈로그 행(catalog_entry)과 project 프롬프트(dim_prompt)의 택소노미 코드를 모두 담습니다.
- depth2 · depth3 은 상위 코드(parent_key) 아래 코드라 같은 코드가 여러 키일 수 있습니다. 필터는 코드를 그 코드의 키 전부로 풉니다.';


COMMENT ON COLUMN gold.dim_taxon.taxon_key IS '택소노미 코드 키';


COMMENT ON COLUMN gold.dim_taxon.axis IS 'funnel · presence · list_type · depth1~3 · depth4';


COMMENT ON COLUMN gold.dim_taxon.code IS '(axis, code, parent_key) 유일';


COMMENT ON COLUMN gold.dim_taxon.parent_key IS '상위 코드';


CREATE TABLE gold.dim_url (
    url_key integer NOT NULL,
    url_hash text,
    url text,
    title text,
    url_norm text,
    url_base_norm text,
    host text,
    domain text,
    source_key integer,
    owner_key smallint,
    rule_ver text
);


COMMENT ON TABLE gold.dim_url IS '[인용 셀] URL 1개 (인용 · 자사 페이지)
원문 URL 1개 = 1행. 인용 URL 과 자사 사이트 페이지를 담습니다.
입력: 데이터 분석팀 · dim_source · dim_owned_base (출처 제안: 인용 URL + 자사 사이트 페이지 목록)
쓰임: 인용 URL 목록(톤 · 도메인 상세), 답변 · 검수 상세 인용, Project ⑥ 단일 자사 베이스 판정(url_norm), AI Visibility 페이지 URL
규칙:
- url_key 는 원문 URL(url_hash = sha256(url)) 단위입니다. 인용되지 않은 자사 사이트 페이지도 행을 만들고, AI Visibility 페이지는 url_norm 으로 인용 URL 과 맞춥니다.';


COMMENT ON COLUMN gold.dim_url.url_key IS '0 예약';


COMMENT ON COLUMN gold.dim_url.url_hash IS 'sha256(원문 URL)';


COMMENT ON COLUMN gold.dim_url.url IS '원문';


COMMENT ON COLUMN gold.dim_url.title IS '최빈 제목';


COMMENT ON COLUMN gold.dim_url.url_norm IS '정규형';


COMMENT ON COLUMN gold.dim_url.url_base_norm IS '베이스 정규형';


COMMENT ON COLUMN gold.dim_url.host IS 'host (최빈, 없으면 URL)';


COMMENT ON COLUMN gold.dim_url.domain IS '최빈 도메인';


COMMENT ON COLUMN gold.dim_url.source_key IS '0 = 호스트 없음';


COMMENT ON COLUMN gold.dim_url.owner_key IS '글로벌 자사 베이스 · NULL = 아님';


COMMENT ON COLUMN gold.dim_url.rule_ver IS '판정 규칙 버전';


CREATE TABLE gold.entity_mention_surface (
    entity_id uuid,
    run_month date,
    surface text,
    brand_rollup_entity_id uuid,
    display_name text
);


COMMENT ON TABLE gold.entity_mention_surface IS '[답변 원문] 언급 × 관측 표면
언급 1건 × 관측 표면 = 1행. 표면 없는 언급은 surface NULL 1행.
입력: 데이터 분석팀
쓰임: Entity catalog 초안 린트(전역 차단 표면 대조) · 목록·버전 상세의 Scope 롤업 판정';


COMMENT ON COLUMN gold.entity_mention_surface.entity_id IS 'dim_entity.entity_id (UK)';


COMMENT ON COLUMN gold.entity_mention_surface.run_month IS 'ERD 설명 없음 · 열 묶음 「run_month」';


COMMENT ON COLUMN gold.entity_mention_surface.surface IS '표면 문자열 (없으면 NULL)';


COMMENT ON COLUMN gold.entity_mention_surface.brand_rollup_entity_id IS 'ERD 설명 없음 · 열 묶음 「brand_rollup_entity_id」';


COMMENT ON COLUMN gold.entity_mention_surface.display_name IS 'ERD 설명 없음 · 열 묶음 「display_name」';


CREATE TABLE gold.entity_mention_total (
    entity_id uuid NOT NULL,
    answers integer,
    mentions integer,
    updated_at timestamp with time zone
);


COMMENT ON TABLE gold.entity_mention_total IS '[KPI·언급 셀] 엔티티 전 기간 합계
엔티티 1개의 전 기간 합계 = 1행. Brand · 표시명 있는 언급만, 드롭 답변 제외, 기간·게이트 없음. 합계 0 이면 행이 없습니다.
입력: 데이터 분석팀
갱신: 적재 마무리마다 차분 반영
쓰임: Admin › Global config › Entity catalog 엔티티 표의 답변 · 언급 수와 답변 수 정렬';


COMMENT ON COLUMN gold.entity_mention_total.entity_id IS 'dim_entity.entity_id (UK)';


COMMENT ON COLUMN gold.entity_mention_total.answers IS '언급 답변 수 (고유 job)';


COMMENT ON COLUMN gold.entity_mention_total.mentions IS 'Σmention_count';


COMMENT ON COLUMN gold.entity_mention_total.updated_at IS '마지막 반영 시각';


CREATE TABLE gold.ga4_property (
    prop_key smallint NOT NULL,
    property_id text,
    brand_bit integer,
    geo_key smallint,
    status text,
    source text,
    conv_basis smallint
);


COMMENT ON TABLE gold.ga4_property IS '[GA4] GA4 속성 1개
GA4 속성 1개 = 1행.
입력: 데이터 분석팀
쓰임: AI Conversion(Global · Website · Project) 시장 · 속성 해석, 미연동 · 측정 대기 안내, 전환 분자(conv_basis), Global · Website 측정 커버리지 · 국가별 AI 전환율 표, Project Dashboard AI 유입 전환율 카드, GA4 이벤트 목록(Admin GA4 연동 · 전환 화면)';


COMMENT ON COLUMN gold.ga4_property.prop_key IS 'GA4 속성 키';


COMMENT ON COLUMN gold.ga4_property.property_id IS 'ERD 설명 없음 · 열 묶음 「property_id」';


COMMENT ON COLUMN gold.ga4_property.brand_bit IS 'ERD 설명 없음 · 열 묶음 「brand_bit」';


COMMENT ON COLUMN gold.ga4_property.geo_key IS '국가(시장) 키';


COMMENT ON COLUMN gold.ga4_property.status IS 'active · pending_grant · unmapped';


COMMENT ON COLUMN gold.ga4_property.source IS 'registry · project_override · env';


COMMENT ON COLUMN gold.ga4_property.conv_basis IS '전환 분자: 1 key_events 폴백 · 2 추적 이벤트 event_count';


CREATE TABLE gold.ga4_row (
    prop_key smallint NOT NULL,
    date date NOT NULL,
    report smallint NOT NULL,
    channel_key integer NOT NULL,
    source_key integer NOT NULL,
    device_key integer NOT NULL,
    nvr_key integer NOT NULL,
    page_key integer NOT NULL,
    event_key integer NOT NULL,
    is_ai boolean,
    engine_key smallint,
    is_conv boolean,
    sessions integer,
    users_day integer,
    page_views integer,
    key_events integer,
    event_count integer
);


COMMENT ON TABLE gold.ga4_row IS '[GA4] 속성 × 일 × report × 차원
속성 × 보고일 × report × 차원 조합 = 1행.
입력: 데이터 분석팀 (출처: GA4 보고서 5종의 일별 행)
갱신: GA4 일 적재. 추적 이벤트가 바뀌면 is_conv 를, 속성 매핑이 바뀌면 그 속성을 전 기간 다시 계산
쓰임: AI Conversion(Global · Website · Project) 전환율 카드 · 추이, 방문 수 추이, 엔진별 전환, 페이지별 전환 표, 방문 수 카드 · 입구 페이지별 방문 표 세션, Global · Website 측정 커버리지 · 국가별 AI 전환율 표, Project Dashboard AI 유입 전환율 카드, GA4 이벤트 목록(90일 eventCount)
규칙:
- sessions · page_views · key_events · event_count 는 날짜 · 차원끼리 더해도 됩니다. users_day 는 행끼리 더하지 않습니다 (기간 사용자 수는 ga4_users_window).';


COMMENT ON COLUMN gold.ga4_row.prop_key IS 'GA4 속성 키';


COMMENT ON COLUMN gold.ga4_row.date IS 'ERD 설명 없음 · 열 묶음 「date」';


COMMENT ON COLUMN gold.ga4_row.report IS '1 traffic_total · 2 traffic_ai · 3 events · 4 landing · 5 totals';


COMMENT ON COLUMN gold.ga4_row.channel_key IS 'GA4 값 사전 키 (kind = ''channel'')';


COMMENT ON COLUMN gold.ga4_row.source_key IS 'GA4 값 사전 키 (kind = ''source'')';


COMMENT ON COLUMN gold.ga4_row.device_key IS 'GA4 값 사전 키 (kind = ''device'')';


COMMENT ON COLUMN gold.ga4_row.nvr_key IS 'GA4 값 사전 키 (kind = ''nvr'')';


COMMENT ON COLUMN gold.ga4_row.page_key IS 'GA4 값 사전 키 (kind = ''page'')';


COMMENT ON COLUMN gold.ga4_row.event_key IS 'GA4 값 사전 키 (kind = ''event'')';


COMMENT ON COLUMN gold.ga4_row.is_ai IS 'AI Assistant 채널';


COMMENT ON COLUMN gold.ga4_row.engine_key IS 'AI 행 sessionSource · 그 밖 0';


COMMENT ON COLUMN gold.ga4_row.is_conv IS '추적 이벤트 · key event 폴백';


COMMENT ON COLUMN gold.ga4_row.sessions IS 'ERD 설명 없음 · 열 묶음 「sessions · users_day」';


COMMENT ON COLUMN gold.ga4_row.users_day IS 'ERD 설명 없음 · 열 묶음 「sessions · users_day」';


COMMENT ON COLUMN gold.ga4_row.page_views IS 'ERD 설명 없음 · 열 묶음 「page_views · key_events · event_count」';


COMMENT ON COLUMN gold.ga4_row.key_events IS 'ERD 설명 없음 · 열 묶음 「page_views · key_events · event_count」';


COMMENT ON COLUMN gold.ga4_row.event_count IS 'ERD 설명 없음 · 열 묶음 「page_views · key_events · event_count」';


CREATE TABLE gold.ga4_users_window (
    prop_key smallint NOT NULL,
    window_end date NOT NULL,
    window_days integer NOT NULL,
    cohort text NOT NULL,
    engine_mask integer NOT NULL,
    device_mask integer NOT NULL,
    nvr_mask integer NOT NULL,
    page_key integer NOT NULL,
    users integer
);


COMMENT ON TABLE gold.ga4_users_window IS '[GA4] 속성 × 기간 × 코호트 × 필터 조합 × 입구 페이지
속성 × 기간 × 코호트 × 엔진·기기·신규/재방문 필터 조합 × 입구 페이지 = 1행.
입력: 데이터 분석팀 (출처 제안: GA4 Data API activeUsers 기간 조회. AI 조건 = sessionDefaultChannelGroup "AI Assistant" ∧ sessionSource ∈ 선택 엔진 호스트)
갱신: ga4_row 와 같은 GA4 일 적재
쓰임: AI Conversion(Global · Website · Project) 사용자 기준 값: 전환율 카드 · 국가별 · 엔진별 분모 = 창 activeUsers, 전환율 추이 = 일별 activeUsers, 페이지별 전환 표 AI · 일반 사용자, 방문 블록 순 방문자 · 방문 빈도 카드, 입구 페이지별 방문 표 사용자 열. Project Dashboard AI 유입 전환율 카드 = 28일 창
규칙:
- 순 방문자는 더할 수 없어서 필터 조합마다 행을 둡니다. 화면의 모든 조합(엔진 · 기기 · 신규/재방문 다중 선택)을 비트 조합으로 미리 계산하고 근사하지 않습니다.
- cohort: ai = AI 유입, total = 엔진 조건 없이 기기·신규/재방문만 건 전체, general = 비AI 값. total − ai 도 이 행들로 구할 수 있습니다.
- 입구 페이지 행(page_key ≠ 0)은 창 · 필터 조합마다 AI 세션 상위 15(입구 페이지별 방문 표) ∪ AI 사용자 상위 12(페이지별 전환 표) 페이지에 둡니다. total · general 페이지 행은 engine_mask 0 으로, 같은 기기 · 신규/재방문 조합에서 뽑힌 페이지마다 둡니다.
- 7 · 28 · 90일 행의 window_end = 그 속성의 마지막 적재일, 일별 행(window_days 1)은 날짜마다입니다.';


COMMENT ON COLUMN gold.ga4_users_window.prop_key IS 'GA4 속성 키';


COMMENT ON COLUMN gold.ga4_users_window.window_end IS '창 끝일 · 7 · 28 · 90일(카드 · 표) · 1(일별 추이)';


COMMENT ON COLUMN gold.ga4_users_window.window_days IS '창 끝일 · 7 · 28 · 90일(카드 · 표) · 1(일별 추이)';


COMMENT ON COLUMN gold.ga4_users_window.cohort IS 'ai · total · general';


COMMENT ON COLUMN gold.ga4_users_window.engine_mask IS 'AI 엔진 비트 조합 · 0 = 필터 없음';


COMMENT ON COLUMN gold.ga4_users_window.device_mask IS '기기 · 신규/재방문 비트 조합 · 0 = 필터 없음';


COMMENT ON COLUMN gold.ga4_users_window.nvr_mask IS '기기 · 신규/재방문 비트 조합 · 0 = 필터 없음';


COMMENT ON COLUMN gold.ga4_users_window.page_key IS '0 = 전체 · 그 밖 = 입구 페이지';


COMMENT ON COLUMN gold.ga4_users_window.users IS '순 방문자 (기간 중복 제거)';


CREATE TABLE gold.ga4_value (
    kind text NOT NULL,
    value_key integer NOT NULL,
    value text,
    url_key integer
);


COMMENT ON TABLE gold.ga4_value IS '[GA4] GA4 값 사전
GA4 차원 값 1개 = 1행.
입력: 데이터 분석팀 (출처: GA4 보고서 차원 값)
쓰임: AI Conversion 기기 · 방문자 유형 필터, 페이지별 전환 · 입구 페이지별 방문 표 URL, GA4 이벤트 목록 이벤트 이름';


COMMENT ON COLUMN gold.ga4_value.kind IS 'channel · source · device · nvr · event · page';


COMMENT ON COLUMN gold.ga4_value.value_key IS 'channel · source · device · nvr · event · page';


COMMENT ON COLUMN gold.ga4_value.value IS '빈 문자열 = 0 · page = 입구 페이지';


COMMENT ON COLUMN gold.ga4_value.url_key IS 'kind=page 의 URL';


CREATE TABLE gold.job_index (
    answer_key integer NOT NULL,
    job_id uuid,
    run_key integer,
    cyc_key integer,
    prompt_key integer,
    project_key smallint,
    engine_key smallint,
    geo_key smallint,
    lang_key smallint,
    bgrp integer,
    surface smallint,
    round_date date,
    measured_at timestamp with time zone,
    status_code smallint,
    analysis_code text,
    dropped boolean,
    served boolean,
    last_build_id bigint
);


COMMENT ON TABLE gold.job_index IS '[답변 사실] Scope job 1건 (모든 상태)
Scope job 1건 = 1행. 대기·실행·실패·드롭까지 모든 상태를 담습니다.
입력: 데이터 분석팀
갱신: 적재마다, 회차 재평가의 run 귀속 이동, 재판정 · 앵커 고정 · 드롭 등
쓰임: 답변 모달 헤더, 언급·인용 프롬프트·도메인 상세의 답변 참조(job_id), 추이 측정 일수, 글로벌 필터 옵션, 원본 데이터 검수 목록·진행률·상세·노트, Project › Setting › General 분석 연결 진단
규칙:
- served = 완료 ∧ 드롭 아님. answer_fact 는 served job 만 가집니다.
- job_id ↔ answer_key 해석과 접근 범위 검사(fail-closed)가 이 테이블을 거칩니다.
- build 로 나누지 않는 현재 상태 원장입니다. 대기·실행·실패가 build 없이 바로 보여야 해서 release 밖에 두고, 바뀌면 data_version 을 올립니다.';


COMMENT ON COLUMN gold.job_index.answer_key IS 'Scope job 키';


COMMENT ON COLUMN gold.job_index.job_id IS 'ERD 설명 없음 · 열 묶음 「job_id」';


COMMENT ON COLUMN gold.job_index.run_key IS 'ERD 설명 없음 · 열 묶음 「run_key」';


COMMENT ON COLUMN gold.job_index.cyc_key IS '회차';


COMMENT ON COLUMN gold.job_index.prompt_key IS '측정 프롬프트 키';


COMMENT ON COLUMN gold.job_index.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.job_index.engine_key IS 'AI 엔진 키';


COMMENT ON COLUMN gold.job_index.geo_key IS '국가';


COMMENT ON COLUMN gold.job_index.lang_key IS '언어 키';


COMMENT ON COLUMN gold.job_index.bgrp IS '브랜드 비트 (카탈로그·사이트·프로젝트)';


COMMENT ON COLUMN gold.job_index.surface IS 'ERD 설명 없음 · 열 묶음 「surface · round_date」';


COMMENT ON COLUMN gold.job_index.round_date IS 'ERD 설명 없음 · 열 묶음 「surface · round_date」';


COMMENT ON COLUMN gold.job_index.measured_at IS '측정 시각';


COMMENT ON COLUMN gold.job_index.status_code IS '0 완료 · 1 대기·실행 · 2 실패 · 3 기타';


COMMENT ON COLUMN gold.job_index.analysis_code IS 'ERD 설명 없음 · 열 묶음 「analysis_code」';


COMMENT ON COLUMN gold.job_index.dropped IS 'ERD 설명 없음 · 열 묶음 「dropped · served」';


COMMENT ON COLUMN gold.job_index.served IS 'ERD 설명 없음 · 열 묶음 「dropped · served」';


COMMENT ON COLUMN gold.job_index.last_build_id IS '마지막 반영 build';


CREATE TABLE gold.kw_serp (
    call_id text NOT NULL,
    rank integer NOT NULL,
    kw_key integer,
    location_code integer,
    language_code text,
    url text,
    domain text,
    title text,
    snippet text,
    observed_at timestamp with time zone
);


COMMENT ON TABLE gold.kw_serp IS '[키워드] 호출 × 순위
수집 호출 × 순위 = 1행. 집계 없이 화면에 그대로 나갑니다.
입력: 데이터 분석팀 (출처: DataForSEO serp_organic, organic 행만)
갱신: 요청 시 수집 (관심도 인사이트). 관측 24시간이 지나면 다시 수집합니다.
쓰임: Google keywords · Google Keyword 검색 결과 표 (최신 호출) · 제안 프롬프트 초안';


COMMENT ON COLUMN gold.kw_serp.call_id IS 'ERD 설명 없음 · 열 묶음 「call_id」';


COMMENT ON COLUMN gold.kw_serp.rank IS 'ERD 설명 없음 · 열 묶음 「rank」';


COMMENT ON COLUMN gold.kw_serp.kw_key IS '검색어 키';


COMMENT ON COLUMN gold.kw_serp.location_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';


COMMENT ON COLUMN gold.kw_serp.language_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';


COMMENT ON COLUMN gold.kw_serp.url IS 'ERD 설명 없음 · 열 묶음 「url · domain」';


COMMENT ON COLUMN gold.kw_serp.domain IS 'ERD 설명 없음 · 열 묶음 「url · domain」';


COMMENT ON COLUMN gold.kw_serp.title IS 'ERD 설명 없음 · 열 묶음 「title · snippet」';


COMMENT ON COLUMN gold.kw_serp.snippet IS 'ERD 설명 없음 · 열 묶음 「title · snippet」';


COMMENT ON COLUMN gold.kw_serp.observed_at IS 'ERD 설명 없음 · 열 묶음 「observed_at」';


CREATE TABLE gold.kw_suggestion (
    call_id text NOT NULL,
    pos integer NOT NULL,
    seed_kw_key integer,
    kw_key integer,
    location_code integer,
    language_code text,
    search_volume integer,
    intent text,
    total_count integer,
    is_seed boolean,
    observed_at timestamp with time zone
);


COMMENT ON TABLE gold.kw_suggestion IS '[키워드] 호출 × 위치
수집 호출 × 위치 = 1행. 집계 없이 화면에 그대로 나갑니다.
입력: 데이터 분석팀 (출처: DataForSEO keyword_suggestions)
갱신: 요청 시 수집 (관련 검색어 · 키워드 검색). 관측 7일이 지나면 다시 수집합니다.
쓰임: Google keywords · Google Keyword 관련 검색어 표, Google Keyword 발견 검색어 수 · 키워드 검색 시작 (검색량 · 의도 · 관련어)';


COMMENT ON COLUMN gold.kw_suggestion.call_id IS 'ERD 설명 없음 · 열 묶음 「call_id」';


COMMENT ON COLUMN gold.kw_suggestion.pos IS 'ERD 설명 없음 · 열 묶음 「pos」';


COMMENT ON COLUMN gold.kw_suggestion.seed_kw_key IS '시드';


COMMENT ON COLUMN gold.kw_suggestion.kw_key IS '검색어 키';


COMMENT ON COLUMN gold.kw_suggestion.location_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';


COMMENT ON COLUMN gold.kw_suggestion.language_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';


COMMENT ON COLUMN gold.kw_suggestion.search_volume IS 'ERD 설명 없음 · 열 묶음 「search_volume · intent」';


COMMENT ON COLUMN gold.kw_suggestion.intent IS 'ERD 설명 없음 · 열 묶음 「search_volume · intent」';


COMMENT ON COLUMN gold.kw_suggestion.total_count IS '호출 단위 연관어 총수';


COMMENT ON COLUMN gold.kw_suggestion.is_seed IS 'seed 행';


COMMENT ON COLUMN gold.kw_suggestion.observed_at IS '7일 신선도';


CREATE TABLE gold.kw_volume_monthly (
    kw_key integer NOT NULL,
    location_code integer NOT NULL,
    language_code text NOT NULL,
    month date NOT NULL,
    search_volume integer,
    competition text,
    competition_index integer,
    cpc numeric,
    call_id text,
    observed_at timestamp with time zone
);


COMMENT ON TABLE gold.kw_volume_monthly IS '[키워드] 검색어 × 지역 × 언어 × 월
검색어 × 지역 × 언어 × 월 = 1행.
입력: 데이터 분석팀 (출처: DataForSEO google_ads search_volume)
갱신: 요청 시 수집 (관심도 인사이트 · Keyword tools 검색량). 관측 뒤 인사이트는 24시간, 검색량은 7일이 지나면 다시 수집합니다.
쓰임: Google keywords · Google Keyword 관심도 추이 차트 · 평균 관심도, Keyword tools 키워드 수 · 평균 · 총 검색량 · 고·중·저볼륨 카드 · 검색량 결과 표 · 생성 프롬프트 표 검색량
규칙:
- competition 은 키워드 단위 값이 월 행마다 반복됩니다. 경쟁도 · CPC 는 월 · 키워드끼리 더하지 않습니다.
- 월 행은 성공한 최신 수집이 덮어씁니다(upsert). 실패한 수집(HTTP ≥ 400 · task 오류)은 이전 값을 덮지 않습니다.';


COMMENT ON COLUMN gold.kw_volume_monthly.kw_key IS '검색어 키';


COMMENT ON COLUMN gold.kw_volume_monthly.location_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';


COMMENT ON COLUMN gold.kw_volume_monthly.language_code IS 'ERD 설명 없음 · 열 묶음 「location_code · language_code」';


COMMENT ON COLUMN gold.kw_volume_monthly.month IS '월 1일';


COMMENT ON COLUMN gold.kw_volume_monthly.search_volume IS 'ERD 설명 없음 · 열 묶음 「search_volume」';


COMMENT ON COLUMN gold.kw_volume_monthly.competition IS 'LOW·MEDIUM·HIGH 라벨';


COMMENT ON COLUMN gold.kw_volume_monthly.competition_index IS '지수';


COMMENT ON COLUMN gold.kw_volume_monthly.cpc IS 'CPC';


COMMENT ON COLUMN gold.kw_volume_monthly.call_id IS '수집 호출';


COMMENT ON COLUMN gold.kw_volume_monthly.observed_at IS 'ERD 설명 없음 · 열 묶음 「observed_at」';


CREATE TABLE gold.page_crawl_daily (
    build_id bigint NOT NULL,
    project_key smallint NOT NULL,
    url_key integer NOT NULL,
    date date NOT NULL,
    bot_key smallint NOT NULL,
    hits integer
);


COMMENT ON TABLE gold.page_crawl_daily IS '[AI Visibility] 페이지 × 일 × 크롤러
빌드 × 사이트 · 프로젝트 × 페이지 × 일 × AI 크롤러 = 1행.
입력: 데이터 분석팀 (출처 제안: 서버 크롤 로그 UA → dim_crawl_bot)
갱신: 일 배치 (제안)
쓰임: AI Visibility 엔진 필터를 건 AI 크롤 수
규칙:
- Σhits = page_visibility_daily.ai_crawls 입니다.';


COMMENT ON COLUMN gold.page_crawl_daily.build_id IS '빌드 키';


COMMENT ON COLUMN gold.page_crawl_daily.project_key IS '사이트 · 프로젝트';


COMMENT ON COLUMN gold.page_crawl_daily.url_key IS '페이지';


COMMENT ON COLUMN gold.page_crawl_daily.date IS '기간 축';


COMMENT ON COLUMN gold.page_crawl_daily.bot_key IS 'AI 크롤러 키';


COMMENT ON COLUMN gold.page_crawl_daily.hits IS '크롤 수';


CREATE TABLE gold.page_priority (
    build_id bigint NOT NULL,
    project_key smallint NOT NULL,
    url_key integer NOT NULL,
    priority smallint,
    rule_ver text
);


COMMENT ON TABLE gold.page_priority IS '[AI Visibility] 사이트 × 페이지 우선순위
빌드 × 사이트 · 프로젝트 × 페이지 = 1행.
입력: 데이터 분석팀
쓰임: AI Visibility 페이지 진단 표 우선 열 · 기본 정렬
규칙:
- 산정 규칙은 데이터 분석팀이 정하고(미정) rule_ver 로 남깁니다. 이 테이블이 우선순위 정의의 출처입니다. 기본 정렬은 priority 오름차순입니다.';


COMMENT ON COLUMN gold.page_priority.build_id IS '빌드 키';


COMMENT ON COLUMN gold.page_priority.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.page_priority.url_key IS '0 예약';


COMMENT ON COLUMN gold.page_priority.priority IS '1 높음 · 2 · 3 낮음';


COMMENT ON COLUMN gold.page_priority.rule_ver IS '산정 규칙 버전';


CREATE TABLE gold.page_seo_device_daily (
    build_id bigint NOT NULL,
    project_key smallint NOT NULL,
    url_key integer NOT NULL,
    date date NOT NULL,
    device_key integer NOT NULL,
    seo_impressions integer
);


COMMENT ON TABLE gold.page_seo_device_daily IS '[AI Visibility] 페이지 × 일 × 기기
빌드 × 사이트 · 프로젝트 × 페이지 × 일 × 기기 = 1행.
입력: 데이터 분석팀 (출처 제안: GSC device 차원)
갱신: 일 배치 (제안)
쓰임: AI Visibility 기기 필터를 건 검색 노출수
규칙:
- Σseo_impressions = page_visibility_daily.seo_impressions 입니다. 기기 값은 필터의 GA4 기기 코드(mobile · desktop · tablet)에 맞춥니다.';


COMMENT ON COLUMN gold.page_seo_device_daily.build_id IS '빌드 키';


COMMENT ON COLUMN gold.page_seo_device_daily.project_key IS '사이트 · 프로젝트';


COMMENT ON COLUMN gold.page_seo_device_daily.url_key IS '페이지';


COMMENT ON COLUMN gold.page_seo_device_daily.date IS '기간 축';


COMMENT ON COLUMN gold.page_seo_device_daily.device_key IS '기기 · ga4_value kind=device';


COMMENT ON COLUMN gold.page_seo_device_daily.seo_impressions IS '기기별 검색 노출수';


CREATE TABLE gold.page_visibility_daily (
    build_id bigint NOT NULL,
    project_key smallint NOT NULL,
    url_key integer NOT NULL,
    geo_key smallint,
    date date NOT NULL,
    seo_impressions integer,
    ai_crawls integer
);


COMMENT ON TABLE gold.page_visibility_daily IS '[AI Visibility] 사이트 × 페이지 × 일
빌드 × 사이트 · 프로젝트 × 페이지 × 일 = 1행.
입력: 데이터 분석팀 (출처 제안: GSC 페이지 노출 · 서버 크롤 로그 AI 봇 집계)
갱신: 일 배치 (제안)
쓰임: AI Visibility (Global · Project) 4분면 카드 · 산점도 · 페이지 진단 표
규칙:
- url_key 는 dim_url 에서 받습니다. 인용된 적 없는 자사 페이지도 dim_url 행을 만들고, 인용 URL 과는 url_norm 으로 맞춥니다.
- Global 화면은 웹사이트 사이트(dim_project surface 2) 행의 페이지 전체, Project 화면은 그 프로젝트 project_key 행을 읽습니다. 프로젝트 행의 페이지는 그 프로젝트 자사 기준 URL 아래 페이지입니다.
- 분면 · 카드 수 · 중앙값은 저장하지 않고, 필터 후 페이지 집합의 기간 합으로 조회 때 계산합니다. 중앙값은 정렬 후 floor(n/2) 번째 값이고, 그 이상이면 높음입니다.
- 프롬프트 축(프롬프트 퍼널 · 브랜드 포함 여부 · 리스트 타입 · Depth 1~4 · 브랜드) · 경쟁사 축은 그 페이지와 url_norm 이 같은 URL 을 인용한 답변의 프롬프트 · 언급 브랜드로 겁니다 (citation_fact ⋈ dim_url ⋈ answer_brand_fact). 택소노미 값은 Global = catalog_entry, Project = 그 프로젝트 프롬프트의 택소노미로 풉니다.
- 국가 축 = geo_key (Project 는 프로젝트 국가로 잠김), 출처 축 = dim_url.source_key → dim_source.category_key, 기기 축 = page_seo_device_daily (검색 노출만), 방문자 유형 축 = GA4 입구 페이지(ga4_row report 4, ga4_value.url_key) 중 그 유형 세션이 있는 페이지입니다.
- 화면 필터에 언어 축이 없어 언어 열은 두지 않습니다.';


COMMENT ON COLUMN gold.page_visibility_daily.build_id IS '빌드 키';


COMMENT ON COLUMN gold.page_visibility_daily.project_key IS '사이트 · 프로젝트';


COMMENT ON COLUMN gold.page_visibility_daily.url_key IS '페이지';


COMMENT ON COLUMN gold.page_visibility_daily.geo_key IS '페이지 시장 · 국가 축';


COMMENT ON COLUMN gold.page_visibility_daily.date IS '기간 축';


COMMENT ON COLUMN gold.page_visibility_daily.seo_impressions IS '검색 노출수 · 출처 제안 GSC';


COMMENT ON COLUMN gold.page_visibility_daily.ai_crawls IS 'AI 크롤 수 · 봇 합계';


CREATE TABLE gold.prompt_custom_value (
    prompt_key integer NOT NULL,
    field_id uuid NOT NULL,
    value text
);


COMMENT ON TABLE gold.prompt_custom_value IS '[프롬프트·웹 유닛] 프롬프트 × 커스텀 필드 값
프로젝트 프롬프트 × 커스텀 필드 = 1행 (값 1개).
입력: 데이터 분석팀 (출처 제안: GEO HUB 프롬프트 태그 값의 투영)
갱신: 프롬프트 태그 값이 바뀔 때
쓰임: Project › Dashboard · Analysis › Mention · Analysis › Citation 의 커스텀 태그 필터 (값 옵션 · 거르기)
규칙:
- 필터는 한 필드 안 값은 OR, 필드끼리 AND 로 겁니다. 빈 값만 준 필드는 결과가 0 입니다.
- 필터 옵션 값은 그 프로젝트에 살아 있는 프롬프트(dim_prompt.in_project_catalog)에 붙은 값입니다.';


COMMENT ON COLUMN gold.prompt_custom_value.prompt_key IS '측정 프롬프트 키';


COMMENT ON COLUMN gold.prompt_custom_value.field_id IS '프로젝트 커스텀 필드 키';


COMMENT ON COLUMN gold.prompt_custom_value.value IS '태그 값';


CREATE TABLE gold.release (
    release_id bigint NOT NULL,
    read_mode text,
    rule_signature text,
    base_release_id bigint,
    validated_at timestamp with time zone
);


COMMENT ON TABLE gold.release IS '[빌드·릴리스] 공개 manifest 1개
불변 공개 manifest 1개 = 1행.
입력: 데이터 분석팀 · build
규칙:
- validated build 만 묶습니다.
- 한 요청 안의 숫자는 release 하나로 같은 세대에 고정합니다.';


COMMENT ON COLUMN gold.release.release_id IS '공개 manifest 키';


COMMENT ON COLUMN gold.release.read_mode IS 'live · card · grid';


COMMENT ON COLUMN gold.release.rule_signature IS '규칙 서명';


COMMENT ON COLUMN gold.release.base_release_id IS '이전 release';


COMMENT ON COLUMN gold.release.validated_at IS 'ERD 설명 없음 · 열 묶음 「validated_at」';


CREATE TABLE gold.release_item (
    release_id bigint NOT NULL,
    family text NOT NULL,
    slice_key text NOT NULL,
    build_id bigint,
    state text
);


COMMENT ON TABLE gold.release_item IS '[빌드·릴리스] release × 패밀리 × 슬라이스
release × 패밀리 × 슬라이스 = 1행. 어느 회차·날짜에 어느 build 를 쓸지 정합니다.
입력: 데이터 분석팀 · build
규칙:
- 조회는 release_item 으로 build_id 를 정합니다. 카드 · 격자 읽기는 활성 publication.build_id 를 씁니다.
- 빈 슬라이스도 empty 로 매핑해 삭제를 표현합니다.';


COMMENT ON COLUMN gold.release_item.release_id IS '공개 manifest 키';


COMMENT ON COLUMN gold.release_item.family IS 'ERD 설명 없음 · 열 묶음 「family」';


COMMENT ON COLUMN gold.release_item.slice_key IS 'ERD 설명 없음 · 열 묶음 「slice_key」';


COMMENT ON COLUMN gold.release_item.build_id IS '빌드 키';


COMMENT ON COLUMN gold.release_item.state IS 'ready · empty';


CREATE TABLE gold.web_report_prompt (
    prompt_key integer NOT NULL,
    report_fs integer
);


COMMENT ON TABLE gold.web_report_prompt IS '[프롬프트·웹 유닛] 프롬프트의 보고 유닛 소속
보고 유닛에 속한 웹 프롬프트 1개 = 1행. 행이 없으면 유닛 밖입니다.
입력: 데이터 분석팀
쓰임: Website › Overview 의 KPI 카드(①~⑤) · 경쟁사 SOV 비교 · 증감 표시 · 기간 비교 칩 · 엔진 간 일관성 배지 · KPI 추이 · 시장별 GEO · 출처별 구성비(기간 없음) 모수 게이트: 보고 유닛 소속 ∧ 제외 유닛(web_unit.excluded) 아님
규칙:
- report_fs 는 web_unit.file_seq 와 같은 값입니다. web_unit 은 (project_key, file_seq) 로 유일해 report_fs 혼자로는 FK 를 걸지 않습니다.
- 발행 세대로 읽는 창은 이 테이블 대신 발행 시점 소속(pub_cell_web.report_fs)으로 거릅니다. 제외 유닛은 두 경우 모두 조회 때 web_unit.excluded 로 뺍니다.';


COMMENT ON COLUMN gold.web_report_prompt.prompt_key IS '측정 프롬프트 키';


COMMENT ON COLUMN gold.web_report_prompt.report_fs IS '소속 보고 유닛 file_seq (여럿이면 최소)';


CREATE TABLE gold.web_target_url (
    project_key smallint NOT NULL,
    lang_key smallint NOT NULL,
    url_key integer NOT NULL
);


COMMENT ON TABLE gold.web_target_url IS '[프롬프트·웹 유닛] 프로젝트 × 언어 × 타겟 URL
웹 프로젝트 × 언어 × 타겟 URL = 1행. 타겟 정규형을 dim_url 키로 미리 풀어 둡니다.
입력: 데이터 분석팀
쓰임: Website › Overview AI 타겟 출처 인용률(⑥) 카드 · KPI 추이 ⑥ 선의 타겟 URL 집합
규칙:
- ⑥ 은 발행 세대로 읽는 기간 없는 카드 · 카드 추이면 발행 시점 유닛 판정(pub_cell_web.unit_owned · unit_target)으로 세고, 기간을 고른 카드나 발행 세대로 읽지 않는 창이면 이 집합으로 셉니다. 타겟 = 인용 URL 중 하나라도 이 집합에 있는 답변입니다.';


COMMENT ON COLUMN gold.web_target_url.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.web_target_url.lang_key IS '언어 키';


COMMENT ON COLUMN gold.web_target_url.url_key IS '0 예약';


CREATE TABLE gold.web_unit (
    unit_key smallint NOT NULL,
    project_key smallint,
    file_seq integer,
    lang_codes text[],
    base text,
    base_src text,
    sibs text[],
    home_host text,
    turls text[],
    excluded boolean,
    rule_ver text
);


COMMENT ON TABLE gold.web_unit IS '[프롬프트·웹 유닛] 웹사이트 유닛 (프로젝트 × file_seq)
웹사이트 유닛(사이트 프로젝트 × file_seq) 1개 = 1행.
입력: 데이터 분석팀
쓰임: Website 자사 · 타겟 URL 인용률 카드의 발행값 범위(허용 프로젝트 유닛의 file_seq 만 합산), Website › Overview 카드 모수의 제외 유닛(excluded)
규칙:
- base · sibs · home_host · turls 로 웹사이트 인용의 자사 판정(loc_owned)을 합니다. 타겟 판정(tgt_hit)은 dim_prompt.targets 로 합니다.
- excluded 는 file_seq 단위 값입니다(같은 file_seq 의 유닛은 같은 값). 보고 유닛 file_seq 가 excluded 유닛의 file_seq 인 답변은 Website › Overview 카드 모수에서 뺍니다.';


COMMENT ON COLUMN gold.web_unit.unit_key IS '웹사이트 유닛 키';


COMMENT ON COLUMN gold.web_unit.project_key IS 'Scope 프로젝트 키';


COMMENT ON COLUMN gold.web_unit.file_seq IS 'project_key 와 복합 유일';


COMMENT ON COLUMN gold.web_unit.lang_codes IS '소문자 언어 코드';


COMMENT ON COLUMN gold.web_unit.base IS '자사 base · decl · heur';


COMMENT ON COLUMN gold.web_unit.base_src IS '자사 base · decl · heur';


COMMENT ON COLUMN gold.web_unit.sibs IS '하위 선언 base';


COMMENT ON COLUMN gold.web_unit.home_host IS 'base 호스트';


COMMENT ON COLUMN gold.web_unit.turls IS '타겟 URL 정규형';


COMMENT ON COLUMN gold.web_unit.excluded IS 'Website 모수에서 뺀 보고 유닛';


COMMENT ON COLUMN gold.web_unit.rule_ver IS 'ERD 설명 없음 · 열 묶음 「rule_ver」';


ALTER TABLE ONLY gold.acr_cell_fact
    ADD CONSTRAINT acr_cell_fact_pkey PRIMARY KEY (build_id, acr_cell_key);


ALTER TABLE ONLY gold.acr_cell_run
    ADD CONSTRAINT acr_cell_run_pkey PRIMARY KEY (acr_cell_key);


ALTER TABLE ONLY gold.acr_entity_fact
    ADD CONSTRAINT acr_entity_fact_pkey PRIMARY KEY (build_id, acr_cell_key, level, entity_key);


ALTER TABLE ONLY gold.acr_iter_fact
    ADD CONSTRAINT acr_iter_fact_pkey PRIMARY KEY (build_id, acr_cell_key, iter_no);


ALTER TABLE ONLY gold.acr_iter_shortlist
    ADD CONSTRAINT acr_iter_shortlist_pkey PRIMARY KEY (build_id, acr_cell_key, iter_no, level, entity_key);


ALTER TABLE ONLY gold.active_release
    ADD CONSTRAINT active_release_pkey PRIMARY KEY (read_mode, rule_signature, scope);


ALTER TABLE ONLY gold.answer_body
    ADD CONSTRAINT answer_body_pkey PRIMARY KEY (answer_key);


ALTER TABLE ONLY gold.answer_brand_fact
    ADD CONSTRAINT answer_brand_fact_pkey PRIMARY KEY (build_id, surface, round_date, answer_key, brand_key, competitive);


ALTER TABLE ONLY gold.answer_fact
    ADD CONSTRAINT answer_fact_pkey PRIMARY KEY (build_id, surface, round_date, answer_key);


ALTER TABLE ONLY gold.answer_mention_raw
    ADD CONSTRAINT answer_mention_raw_pkey PRIMARY KEY (answer_key, ord);


ALTER TABLE ONLY gold.answer_occurrence
    ADD CONSTRAINT answer_occurrence_pkey PRIMARY KEY (answer_key, ord);


ALTER TABLE ONLY gold.answer_stance_fact
    ADD CONSTRAINT answer_stance_fact_pkey PRIMARY KEY (build_id, surface, round_date, answer_key, turn_index, entity_key);


ALTER TABLE ONLY gold.answer_stance_raw
    ADD CONSTRAINT answer_stance_raw_pkey PRIMARY KEY (answer_key, turn_index, entity_id);


ALTER TABLE ONLY gold.build
    ADD CONSTRAINT build_pkey PRIMARY KEY (build_id);


ALTER TABLE ONLY gold.catalog_entry
    ADD CONSTRAINT catalog_entry_pkey PRIMARY KEY (build_id, catalog_row_id);


ALTER TABLE ONLY gold.citation_fact
    ADD CONSTRAINT citation_fact_pkey PRIMARY KEY (build_id, surface, round_date, answer_key, ord);


ALTER TABLE ONLY gold.ctx_claim
    ADD CONSTRAINT ctx_claim_pkey PRIMARY KEY (snapshot_id, entity_id);


ALTER TABLE ONLY gold.ctx_claim_quote
    ADD CONSTRAINT ctx_claim_quote_pkey PRIMARY KEY (snapshot_id, entity_id, seq);


ALTER TABLE ONLY gold.ctx_combination_evidence
    ADD CONSTRAINT ctx_combination_evidence_pkey PRIMARY KEY (snapshot_id, combo_id, seq);


ALTER TABLE ONLY gold.ctx_combination
    ADD CONSTRAINT ctx_combination_pkey PRIMARY KEY (snapshot_id, combo_id);


ALTER TABLE ONLY gold.ctx_domain
    ADD CONSTRAINT ctx_domain_pkey PRIMARY KEY (snapshot_id, entity_id, host);


ALTER TABLE ONLY gold.ctx_drive
    ADD CONSTRAINT ctx_drive_pkey PRIMARY KEY (snapshot_id, context_id, requirement_id);


ALTER TABLE ONLY gold.ctx_entity
    ADD CONSTRAINT ctx_entity_pkey PRIMARY KEY (snapshot_id, id);


ALTER TABLE ONLY gold.ctx_evidence
    ADD CONSTRAINT ctx_evidence_pkey PRIMARY KEY (snapshot_id, id);


ALTER TABLE ONLY gold.ctx_group
    ADD CONSTRAINT ctx_group_pkey PRIMARY KEY (snapshot_id, group_id);


ALTER TABLE ONLY gold.ctx_research_log
    ADD CONSTRAINT ctx_research_log_pkey PRIMARY KEY (run_id, seq);


ALTER TABLE ONLY gold.ctx_research_run
    ADD CONSTRAINT ctx_research_run_pkey PRIMARY KEY (run_id);


ALTER TABLE ONLY gold.ctx_research_wave
    ADD CONSTRAINT ctx_research_wave_pkey PRIMARY KEY (run_id, wave_no);


ALTER TABLE ONLY gold.ctx_research_worker
    ADD CONSTRAINT ctx_research_worker_pkey PRIMARY KEY (run_id, worker_id);


ALTER TABLE ONLY gold.ctx_snapshot
    ADD CONSTRAINT ctx_snapshot_pkey PRIMARY KEY (snapshot_id);


ALTER TABLE ONLY gold.dim_brand
    ADD CONSTRAINT dim_brand_bare_key UNIQUE (bare);


ALTER TABLE ONLY gold.dim_brand
    ADD CONSTRAINT dim_brand_name_key UNIQUE (name);


ALTER TABLE ONLY gold.dim_brand
    ADD CONSTRAINT dim_brand_pkey PRIMARY KEY (brand_key);


ALTER TABLE ONLY gold.dim_category
    ADD CONSTRAINT dim_category_name_key UNIQUE (name);


ALTER TABLE ONLY gold.dim_category
    ADD CONSTRAINT dim_category_pkey PRIMARY KEY (category_key);


ALTER TABLE ONLY gold.dim_country
    ADD CONSTRAINT dim_country_pkey PRIMARY KEY (geo_key);


ALTER TABLE ONLY gold.dim_crawl_bot
    ADD CONSTRAINT dim_crawl_bot_code_key UNIQUE (code);


ALTER TABLE ONLY gold.dim_crawl_bot
    ADD CONSTRAINT dim_crawl_bot_pkey PRIMARY KEY (bot_key);


ALTER TABLE ONLY gold.dim_custom_field
    ADD CONSTRAINT dim_custom_field_pkey PRIMARY KEY (field_id);


ALTER TABLE ONLY gold.dim_custom_field
    ADD CONSTRAINT dim_custom_field_project_key_label_key UNIQUE (project_key, label);


ALTER TABLE ONLY gold.dim_cycle
    ADD CONSTRAINT dim_cycle_cycle_id_key UNIQUE (cycle_id);


ALTER TABLE ONLY gold.dim_cycle
    ADD CONSTRAINT dim_cycle_pkey PRIMARY KEY (cyc_key);


ALTER TABLE ONLY gold.dim_engine
    ADD CONSTRAINT dim_engine_code_key UNIQUE (code);


ALTER TABLE ONLY gold.dim_engine
    ADD CONSTRAINT dim_engine_pkey PRIMARY KEY (engine_key);


ALTER TABLE ONLY gold.dim_entity
    ADD CONSTRAINT dim_entity_entity_id_key UNIQUE (entity_id);


ALTER TABLE ONLY gold.dim_entity
    ADD CONSTRAINT dim_entity_pkey PRIMARY KEY (entity_key);


ALTER TABLE ONLY gold.dim_keyword
    ADD CONSTRAINT dim_keyword_pkey PRIMARY KEY (kw_key);


ALTER TABLE ONLY gold.dim_keyword
    ADD CONSTRAINT dim_keyword_term_norm_key UNIQUE (term_norm);


ALTER TABLE ONLY gold.dim_lang
    ADD CONSTRAINT dim_lang_code_key UNIQUE (code);


ALTER TABLE ONLY gold.dim_lang
    ADD CONSTRAINT dim_lang_pkey PRIMARY KEY (lang_key);


ALTER TABLE ONLY gold.dim_owned_base
    ADD CONSTRAINT dim_owned_base_kind_prefix_key UNIQUE (kind, prefix);


ALTER TABLE ONLY gold.dim_owned_base
    ADD CONSTRAINT dim_owned_base_pkey PRIMARY KEY (owner_key);


ALTER TABLE ONLY gold.dim_perspective
    ADD CONSTRAINT dim_perspective_pkey PRIMARY KEY (perspective_key);


ALTER TABLE ONLY gold.dim_population
    ADD CONSTRAINT dim_population_pkey PRIMARY KEY (population_key);


ALTER TABLE ONLY gold.dim_project
    ADD CONSTRAINT dim_project_pkey PRIMARY KEY (project_key);


ALTER TABLE ONLY gold.dim_project
    ADD CONSTRAINT dim_project_scope_project_id_key UNIQUE (scope_project_id);


ALTER TABLE ONLY gold.dim_prompt
    ADD CONSTRAINT dim_prompt_pkey PRIMARY KEY (prompt_key);


ALTER TABLE ONLY gold.dim_prompt
    ADD CONSTRAINT dim_prompt_prompt_id_key UNIQUE (prompt_id);


ALTER TABLE ONLY gold.dim_region
    ADD CONSTRAINT dim_region_code_key UNIQUE (code);


ALTER TABLE ONLY gold.dim_region
    ADD CONSTRAINT dim_region_pkey PRIMARY KEY (region_key);


ALTER TABLE ONLY gold.dim_source
    ADD CONSTRAINT dim_source_pkey PRIMARY KEY (source_key);


ALTER TABLE ONLY gold.dim_source
    ADD CONSTRAINT dim_source_skey_key UNIQUE (skey);


ALTER TABLE ONLY gold.dim_taxon
    ADD CONSTRAINT dim_taxon_axis_code_parent_key_key UNIQUE NULLS NOT DISTINCT (axis, code, parent_key);


ALTER TABLE ONLY gold.dim_taxon
    ADD CONSTRAINT dim_taxon_pkey PRIMARY KEY (taxon_key);


ALTER TABLE ONLY gold.dim_url
    ADD CONSTRAINT dim_url_pkey PRIMARY KEY (url_key);


ALTER TABLE ONLY gold.dim_url
    ADD CONSTRAINT dim_url_url_hash_key UNIQUE (url_hash);


ALTER TABLE ONLY gold.entity_mention_total
    ADD CONSTRAINT entity_mention_total_pkey PRIMARY KEY (entity_id);


ALTER TABLE ONLY gold.ga4_property
    ADD CONSTRAINT ga4_property_pkey PRIMARY KEY (prop_key);


ALTER TABLE ONLY gold.ga4_property
    ADD CONSTRAINT ga4_property_property_id_key UNIQUE (property_id);


ALTER TABLE ONLY gold.ga4_row
    ADD CONSTRAINT ga4_row_pkey PRIMARY KEY (prop_key, report, date, channel_key, source_key, device_key, nvr_key, page_key, event_key);


ALTER TABLE ONLY gold.ga4_users_window
    ADD CONSTRAINT ga4_users_window_pkey PRIMARY KEY (prop_key, window_end, window_days, cohort, engine_mask, device_mask, nvr_mask, page_key);


ALTER TABLE ONLY gold.ga4_value
    ADD CONSTRAINT ga4_value_pkey PRIMARY KEY (kind, value_key);


ALTER TABLE ONLY gold.job_index
    ADD CONSTRAINT job_index_job_id_key UNIQUE (job_id);


ALTER TABLE ONLY gold.job_index
    ADD CONSTRAINT job_index_pkey PRIMARY KEY (answer_key);


ALTER TABLE ONLY gold.kw_serp
    ADD CONSTRAINT kw_serp_pkey PRIMARY KEY (call_id, rank);


ALTER TABLE ONLY gold.kw_suggestion
    ADD CONSTRAINT kw_suggestion_pkey PRIMARY KEY (call_id, pos);


ALTER TABLE ONLY gold.kw_volume_monthly
    ADD CONSTRAINT kw_volume_monthly_pkey PRIMARY KEY (kw_key, location_code, language_code, month);


ALTER TABLE ONLY gold.page_crawl_daily
    ADD CONSTRAINT page_crawl_daily_pkey PRIMARY KEY (build_id, project_key, url_key, date, bot_key);


ALTER TABLE ONLY gold.page_priority
    ADD CONSTRAINT page_priority_pkey PRIMARY KEY (build_id, project_key, url_key);


ALTER TABLE ONLY gold.page_seo_device_daily
    ADD CONSTRAINT page_seo_device_daily_pkey PRIMARY KEY (build_id, project_key, url_key, date, device_key);


ALTER TABLE ONLY gold.page_visibility_daily
    ADD CONSTRAINT page_visibility_daily_pkey PRIMARY KEY (build_id, project_key, url_key, date);


ALTER TABLE ONLY gold.prompt_custom_value
    ADD CONSTRAINT prompt_custom_value_pkey PRIMARY KEY (prompt_key, field_id);


ALTER TABLE ONLY gold.release_item
    ADD CONSTRAINT release_item_pkey PRIMARY KEY (release_id, family, slice_key);


ALTER TABLE ONLY gold.release
    ADD CONSTRAINT release_pkey PRIMARY KEY (release_id);


ALTER TABLE ONLY gold.web_report_prompt
    ADD CONSTRAINT web_report_prompt_pkey PRIMARY KEY (prompt_key);


ALTER TABLE ONLY gold.web_target_url
    ADD CONSTRAINT web_target_url_pkey PRIMARY KEY (project_key, lang_key, url_key);


ALTER TABLE ONLY gold.web_unit
    ADD CONSTRAINT web_unit_pkey PRIMARY KEY (unit_key);


ALTER TABLE ONLY gold.web_unit
    ADD CONSTRAINT web_unit_project_key_file_seq_key UNIQUE (project_key, file_seq);


CREATE UNIQUE INDEX ctx_combination_snapshot_id_cond_a_cond_b_key ON gold.ctx_combination USING btree (snapshot_id, cond_a, cond_b) WHERE (COALESCE(cardinality(cond_more), 0) = 0);


CREATE UNIQUE INDEX dim_country_code_key ON gold.dim_country USING btree (lower(code));

--

INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":1,"name":"Official (HMG)","slug":"officialHmg","ord":1}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":2,"name":"Official (Competitor)","slug":"officialCompetitor","ord":2}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":3,"name":"Dealer & Marketplace","slug":"dealerMarketplace","ord":3}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":4,"name":"Automotive Media","slug":"automotiveMedia","ord":4}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":5,"name":"News & Media","slug":"newsMedia","ord":5}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":6,"name":"Community & Forums","slug":"communityForums","ord":6}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":7,"name":"Social & Video","slug":"socialVideo","ord":7}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":8,"name":"Blogs & Reviews","slug":"blogsReviews","ord":8}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":9,"name":"Wiki & Reference","slug":"wikiReference","ord":9}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":10,"name":"Government & Public","slug":"governmentPublic","ord":10}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":11,"name":"Award & Certification","slug":"awardCertification","ord":11}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":12,"name":"Academic & Research","slug":"academicResearch","ord":12}');
INSERT INTO gold.dim_category SELECT * FROM json_populate_record(NULL::gold.dim_category,'{"category_key":13,"name":"Other","slug":"other","ord":13}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":0,"code":"","region_key":0,"kind":"unknown","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":1,"code":"AE","region_key":5,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":2,"code":"AF","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":3,"code":"AG","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":4,"code":"AL","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":5,"code":"AM","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":6,"code":"AO","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":7,"code":"AS","region_key":7,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":8,"code":"AT","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":9,"code":"AU","region_key":7,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":10,"code":"AW","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":11,"code":"AZ","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":12,"code":"BA","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":13,"code":"BB","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":14,"code":"BE","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":15,"code":"BF","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":16,"code":"BG","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":17,"code":"BH","region_key":5,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":18,"code":"BJ","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":19,"code":"BN","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":20,"code":"BR","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":21,"code":"BS","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":22,"code":"BY","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":23,"code":"CA","region_key":6,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":24,"code":"CF","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":25,"code":"CG","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":26,"code":"CH","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":27,"code":"CI","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":28,"code":"CL","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":29,"code":"CM","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":30,"code":"CN","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":31,"code":"CN-BJ","region_key":2,"kind":"pseudo","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":32,"code":"CO","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":33,"code":"CPO","region_key":0,"kind":"pseudo","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":34,"code":"CR","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":35,"code":"CU","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":36,"code":"CY","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":37,"code":"CZ","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":38,"code":"DE","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":39,"code":"DJ","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":40,"code":"DK","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":41,"code":"DM","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":42,"code":"EC","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":43,"code":"EE","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":44,"code":"EG","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":45,"code":"ES","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":46,"code":"ET","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":47,"code":"EU","region_key":0,"kind":"pseudo","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":48,"code":"FI","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":49,"code":"FJ","region_key":7,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":50,"code":"FR","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":51,"code":"GB","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":52,"code":"GD","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":53,"code":"GE","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":54,"code":"GF","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":55,"code":"GM","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":56,"code":"GN","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":57,"code":"GR","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":58,"code":"GW","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":59,"code":"HK","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":60,"code":"HN","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":61,"code":"HR","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":62,"code":"HU","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":63,"code":"HYUNDAI-N","region_key":0,"kind":"virtual_brand","virtual_brand_bit":16,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":64,"code":"ID","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":true}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":65,"code":"IE","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":66,"code":"IL","region_key":5,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":67,"code":"IN","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":68,"code":"IQ","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":69,"code":"IS","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":70,"code":"IT","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":71,"code":"JO","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":72,"code":"JP","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":73,"code":"KG","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":74,"code":"KN","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":75,"code":"KR","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":76,"code":"KW","region_key":5,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":77,"code":"KZ","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":78,"code":"LA","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":79,"code":"LB","region_key":5,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":80,"code":"LR","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":81,"code":"LT","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":82,"code":"LU","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":83,"code":"LV","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":84,"code":"MA","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":85,"code":"MD","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":86,"code":"MG","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":87,"code":"MH","region_key":7,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":88,"code":"MIDDLEEAST","region_key":0,"kind":"pseudo","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":89,"code":"MK","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":90,"code":"ML","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":91,"code":"MM","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":92,"code":"MN","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":93,"code":"MQ","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":94,"code":"MR","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":95,"code":"MT","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":96,"code":"MU","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":97,"code":"MX","region_key":6,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":98,"code":"MY","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":99,"code":"MZ","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":100,"code":"NE","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":101,"code":"NG","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":102,"code":"NL","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":103,"code":"NO","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":104,"code":"OM","region_key":5,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":105,"code":"PE","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":106,"code":"PH","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":107,"code":"PK","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":108,"code":"PL","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":109,"code":"PR","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":110,"code":"PS","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":111,"code":"PT","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":112,"code":"QA","region_key":5,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":113,"code":"RO","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":114,"code":"RS","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":115,"code":"RU","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":116,"code":"RW","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":117,"code":"SA","region_key":5,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":118,"code":"SA-Dammam","region_key":5,"kind":"pseudo","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":119,"code":"SA-Jeddah","region_key":5,"kind":"pseudo","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":120,"code":"SA-Riyadh","region_key":5,"kind":"pseudo","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":121,"code":"SB","region_key":7,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":122,"code":"SD","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":123,"code":"SE","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":124,"code":"SG","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":125,"code":"SI","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":126,"code":"SK","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":127,"code":"SL","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":128,"code":"SV","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":129,"code":"TD","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":130,"code":"TG","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":131,"code":"TH","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":132,"code":"TJ","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":133,"code":"TM","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":134,"code":"TO","region_key":7,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":135,"code":"TR","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":136,"code":"TW","region_key":2,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":137,"code":"UA","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":138,"code":"US","region_key":6,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":139,"code":"UZ","region_key":3,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":140,"code":"VC","region_key":4,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":141,"code":"VN","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":142,"code":"VU","region_key":7,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":143,"code":"worldwide","region_key":0,"kind":"pseudo","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":144,"code":"WS","region_key":7,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":145,"code":"YE","region_key":0,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":146,"code":"ZA","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":147,"code":"ZM","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_country SELECT * FROM json_populate_record(NULL::gold.dim_country,'{"geo_key":148,"code":"ZW","region_key":1,"kind":"iso","virtual_brand_bit":null,"hidden_standard":false}');
INSERT INTO gold.dim_engine SELECT * FROM json_populate_record(NULL::gold.dim_engine,'{"engine_key":1,"code":"chatgpt","is_default":true}');
INSERT INTO gold.dim_engine SELECT * FROM json_populate_record(NULL::gold.dim_engine,'{"engine_key":2,"code":"deepseek","is_default":false}');
INSERT INTO gold.dim_engine SELECT * FROM json_populate_record(NULL::gold.dim_engine,'{"engine_key":3,"code":"gemini","is_default":true}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":0,"code":""}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":1,"code":"ar"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":2,"code":"bg"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":3,"code":"bs"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":4,"code":"cs"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":5,"code":"da"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":6,"code":"de"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":7,"code":"el"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":8,"code":"en"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":9,"code":"es"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":10,"code":"et"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":11,"code":"fi"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":12,"code":"fr"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":13,"code":"he"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":14,"code":"hr"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":15,"code":"hu"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":16,"code":"hy"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":17,"code":"id"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":18,"code":"is"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":19,"code":"it"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":20,"code":"ja"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":21,"code":"ko"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":22,"code":"lt"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":23,"code":"lv"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":24,"code":"my"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":25,"code":"nl"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":26,"code":"no"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":27,"code":"pl"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":28,"code":"pt"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":29,"code":"ro"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":30,"code":"ru"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":31,"code":"sk"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":32,"code":"sl"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":33,"code":"sr"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":34,"code":"sv"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":35,"code":"th"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":36,"code":"tr"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":37,"code":"uk"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":38,"code":"uz"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":39,"code":"vi"}');
INSERT INTO gold.dim_lang SELECT * FROM json_populate_record(NULL::gold.dim_lang,'{"lang_key":40,"code":"zh"}');
INSERT INTO gold.dim_perspective SELECT * FROM json_populate_record(NULL::gold.dim_perspective,'{"perspective_key":1,"own_bits":1,"label":"Hyundai"}');
INSERT INTO gold.dim_perspective SELECT * FROM json_populate_record(NULL::gold.dim_perspective,'{"perspective_key":2,"own_bits":2,"label":"Kia"}');
INSERT INTO gold.dim_perspective SELECT * FROM json_populate_record(NULL::gold.dim_perspective,'{"perspective_key":3,"own_bits":3,"label":"HMG"}');
INSERT INTO gold.dim_perspective SELECT * FROM json_populate_record(NULL::gold.dim_perspective,'{"perspective_key":4,"own_bits":4,"label":"Genesis"}');
INSERT INTO gold.dim_perspective SELECT * FROM json_populate_record(NULL::gold.dim_perspective,'{"perspective_key":5,"own_bits":5,"label":"HMG"}');
INSERT INTO gold.dim_perspective SELECT * FROM json_populate_record(NULL::gold.dim_perspective,'{"perspective_key":6,"own_bits":6,"label":"HMG"}');
INSERT INTO gold.dim_perspective SELECT * FROM json_populate_record(NULL::gold.dim_perspective,'{"perspective_key":7,"own_bits":7,"label":"HMG"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":1,"code":"mentions","gate":"std_in","rep_mode":"all"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":2,"code":"citations","gate":"cit_in","rep_mode":"all"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":3,"code":"gap","gate":"gap","rep_mode":"all"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":4,"code":"url","gate":"web_reg","rep_mode":"all"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":5,"code":"acr","gate":"acr_in","rep_mode":"all"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":6,"code":"mentions","gate":"std_in_nc","rep_mode":"all"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":7,"code":"citations","gate":"cit_in_nc","rep_mode":"all"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":8,"code":"mentions","gate":"std_in","rep_mode":"is_rep"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":9,"code":"citations","gate":"cit_in","rep_mode":"is_rep_cit"}');
INSERT INTO gold.dim_population SELECT * FROM json_populate_record(NULL::gold.dim_population,'{"population_key":10,"code":"url","gate":"web_reg","rep_mode":"report_unit"}');
INSERT INTO gold.dim_region SELECT * FROM json_populate_record(NULL::gold.dim_region,'{"region_key":0,"code":""}');
INSERT INTO gold.dim_region SELECT * FROM json_populate_record(NULL::gold.dim_region,'{"region_key":1,"code":"Africa"}');
INSERT INTO gold.dim_region SELECT * FROM json_populate_record(NULL::gold.dim_region,'{"region_key":2,"code":"Asia"}');
INSERT INTO gold.dim_region SELECT * FROM json_populate_record(NULL::gold.dim_region,'{"region_key":3,"code":"Europe"}');
INSERT INTO gold.dim_region SELECT * FROM json_populate_record(NULL::gold.dim_region,'{"region_key":4,"code":"Latin America"}');
INSERT INTO gold.dim_region SELECT * FROM json_populate_record(NULL::gold.dim_region,'{"region_key":5,"code":"Middle East"}');
INSERT INTO gold.dim_region SELECT * FROM json_populate_record(NULL::gold.dim_region,'{"region_key":6,"code":"North America"}');
INSERT INTO gold.dim_region SELECT * FROM json_populate_record(NULL::gold.dim_region,'{"region_key":7,"code":"Oceania"}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":1,"axis":"depth1","code":"1. Brand Image/key value","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":2,"axis":"depth1","code":"1. Car+Features","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":3,"axis":"depth1","code":"2. Compare+Car/Features","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":4,"axis":"depth1","code":"2. Electrification & Innovation","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":5,"axis":"depth1","code":"2. Innovation & Technology","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":6,"axis":"depth1","code":"3. Review+Car/Features","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":7,"axis":"depth1","code":"3. Sustainability","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":8,"axis":"depth1","code":"4. Action+Car","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":9,"axis":"depth1","code":"4. Strategic Interest","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":10,"axis":"depth1","code":"5. Car Ownership","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":11,"axis":"depth1","code":"A. Economic","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":12,"axis":"depth1","code":"Athletic Elegance","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":13,"axis":"depth1","code":"Brand Essence Direct","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":14,"axis":"depth1","code":"Brand Momentum","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":15,"axis":"depth1","code":"Brand Owner Persona","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":16,"axis":"depth1","code":"Brand Prestige","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":17,"axis":"depth1","code":"B. Space & Dimension","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":18,"axis":"depth1","code":"Challenger Positioning","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":19,"axis":"depth1","code":"Comparison","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":20,"axis":"depth1","code":"Core","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":21,"axis":"depth1","code":"Craftsmanship","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":22,"axis":"depth1","code":"C. Tech & Performance","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":23,"axis":"depth1","code":"Distinctly Korean","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":24,"axis":"depth1","code":"D. Special & Utility","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":25,"axis":"depth1","code":"E. Design & Style","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":26,"axis":"depth1","code":"Effortless Comfort Driving","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":27,"axis":"depth1","code":"Effortless Technology","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":28,"axis":"depth1","code":"Fact","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":29,"axis":"depth1","code":"Immersive Experience","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":30,"axis":"depth1","code":"Next-Gen Luxury Appeal","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":31,"axis":"depth1","code":"Personalization / Exclusivity","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":32,"axis":"depth1","code":"Son-Nim Hospitality","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":33,"axis":"depth1","code":"Source","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":34,"axis":"depth1","code":"Technology Accessibility","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":35,"axis":"depth1","code":"Timeless Design","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":36,"axis":"depth1","code":"Understated Quiet Luxury","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":37,"axis":"depth2","code":"Brand Awareness","parent_key":1}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":38,"axis":"depth2","code":"Value Awareness","parent_key":1}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":39,"axis":"depth2","code":"CORE USP","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":40,"axis":"depth2","code":"Features_Accessories","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":41,"axis":"depth2","code":"Features_Design/Color","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":42,"axis":"depth2","code":"Features_driving Option","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":43,"axis":"depth2","code":"Features_Driving Options","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":44,"axis":"depth2","code":"Features_Engine Output/Oil","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":45,"axis":"depth2","code":"Features_Interior","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":46,"axis":"depth2","code":"Features_Mileage/Efficiency","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":47,"axis":"depth2","code":"Features_Size/Spec","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":48,"axis":"depth2","code":"Features_Software/Connectivity","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":49,"axis":"depth2","code":"Features_Technology","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":50,"axis":"depth2","code":"Features_Vehicle Parts","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":51,"axis":"depth2","code":"Features_Wheels/Tire","parent_key":2}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":52,"axis":"depth2","code":"Compare_Car/Brand","parent_key":3}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":53,"axis":"depth2","code":"Compare_Design/Color","parent_key":3}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":54,"axis":"depth2","code":"Compare_Engine Output/Oil","parent_key":3}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":55,"axis":"depth2","code":"Compare_Interior","parent_key":3}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":56,"axis":"depth2","code":"Compare_Mileage/Efficiency","parent_key":3}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":57,"axis":"depth2","code":"Compare_Size/Spec","parent_key":3}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":58,"axis":"depth2","code":"Compare_Software/Connectivity","parent_key":3}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":59,"axis":"depth2","code":"CORE USP","parent_key":3}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":60,"axis":"depth2","code":"Autonomous car","parent_key":4}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":61,"axis":"depth2","code":"Brand Awareness of Electrification","parent_key":4}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":62,"axis":"depth2","code":"Connected car with AI","parent_key":4}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":63,"axis":"depth2","code":"EV,Hybrid Brand Awareness","parent_key":4}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":64,"axis":"depth2","code":"Purpose Built Vehicle","parent_key":4}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":65,"axis":"depth2","code":"Software Defined Vehicle","parent_key":4}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":66,"axis":"depth2","code":"Autonomous car","parent_key":5}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":67,"axis":"depth2","code":"EV,Hybrid Brand Awareness","parent_key":5}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":68,"axis":"depth2","code":"Innovative Brand Awareness","parent_key":5}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":69,"axis":"depth2","code":"Relation with AI","parent_key":5}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":70,"axis":"depth2","code":"Software Technology","parent_key":5}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":71,"axis":"depth2","code":"Review_Car/Brand","parent_key":6}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":72,"axis":"depth2","code":"Review_Design/Color","parent_key":6}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":73,"axis":"depth2","code":"Review_Engine Output/Oil","parent_key":6}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":74,"axis":"depth2","code":"Review_Interior","parent_key":6}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":75,"axis":"depth2","code":"Review_Mileage/Efficiency","parent_key":6}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":76,"axis":"depth2","code":"Review_Size/Spec","parent_key":6}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":77,"axis":"depth2","code":"Review_Software/Connectivity","parent_key":6}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":78,"axis":"depth2","code":"Environmental Friendliness","parent_key":7}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":79,"axis":"depth2","code":"Environmental Sustainability","parent_key":7}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":80,"axis":"depth2","code":"Human Centered Innovation","parent_key":7}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":81,"axis":"depth2","code":"Social Responsibility","parent_key":7}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":82,"axis":"depth2","code":"Action_Insurance/Warranty","parent_key":8}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":83,"axis":"depth2","code":"Action_Pricing Plan","parent_key":8}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":84,"axis":"depth2","code":"CORE USP","parent_key":8}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":85,"axis":"depth2","code":"Brand Design Identity","parent_key":9}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":86,"axis":"depth2","code":"Chinese Brand Awareness / Value","parent_key":9}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":87,"axis":"depth2","code":"High Performance Brand","parent_key":9}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":88,"axis":"depth2","code":"Inspire Experience","parent_key":9}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":89,"axis":"depth2","code":"Ownership_Issue/Problem","parent_key":10}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":90,"axis":"depth2","code":"Ownership_Support","parent_key":10}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":91,"axis":"depth2","code":"Positioning + Facts","parent_key":19}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":92,"axis":"depth2","code":"Trim / Price / Color / Option / Configuration","parent_key":20}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":93,"axis":"depth2","code":"Color","parent_key":28}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":94,"axis":"depth2","code":"Configuration","parent_key":28}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":95,"axis":"depth2","code":"Freshness","parent_key":28}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":96,"axis":"depth2","code":"Option","parent_key":28}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":97,"axis":"depth2","code":"Price","parent_key":28}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":98,"axis":"depth2","code":"Trim","parent_key":28}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":99,"axis":"depth2","code":"Source selection","parent_key":33}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":100,"axis":"depth3","code":"-","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":101,"axis":"depth3","code":"-","parent_key":37}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":102,"axis":"depth3","code":"Customer Experience","parent_key":38}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":103,"axis":"depth3","code":"Design","parent_key":38}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":104,"axis":"depth3","code":"Durability","parent_key":38}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":105,"axis":"depth3","code":"Reliability","parent_key":38}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":106,"axis":"depth3","code":"Safety","parent_key":38}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":107,"axis":"depth3","code":"Value For Money","parent_key":38}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":108,"axis":"depth3","code":"Advanced technology","parent_key":39}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":109,"axis":"depth3","code":"EV Battery Capacity","parent_key":39}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":110,"axis":"depth3","code":"Futuristic Design","parent_key":39}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":111,"axis":"depth3","code":"Spacious Interior","parent_key":39}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":112,"axis":"depth3","code":"accessories","parent_key":40}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":113,"axis":"depth3","code":"Accessories","parent_key":40}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":114,"axis":"depth3","code":"towing/utility","parent_key":40}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":115,"axis":"depth3","code":"color","parent_key":41}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":116,"axis":"depth3","code":"Color","parent_key":41}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":117,"axis":"depth3","code":"design","parent_key":41}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":118,"axis":"depth3","code":"Design","parent_key":41}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":119,"axis":"depth3","code":"4wd/awd","parent_key":42}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":120,"axis":"depth3","code":"4wd/awd","parent_key":43}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":121,"axis":"depth3","code":"Engine/output","parent_key":44}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":122,"axis":"depth3","code":"oil","parent_key":44}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":123,"axis":"depth3","code":"interior","parent_key":45}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":124,"axis":"depth3","code":"Interior","parent_key":45}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":125,"axis":"depth3","code":"trunk space","parent_key":45}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":126,"axis":"depth3","code":"Trunk space","parent_key":45}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":127,"axis":"depth3","code":"distance/range","parent_key":46}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":128,"axis":"depth3","code":"Distance/Range","parent_key":46}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":129,"axis":"depth3","code":"Mileage/Efficiency","parent_key":46}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":130,"axis":"depth3","code":"interior","parent_key":47}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":131,"axis":"depth3","code":"seater","parent_key":47}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":132,"axis":"depth3","code":"Seater","parent_key":47}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":133,"axis":"depth3","code":"specs","parent_key":47}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":134,"axis":"depth3","code":"Specs","parent_key":47}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":135,"axis":"depth3","code":"trunk space","parent_key":47}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":136,"axis":"depth3","code":"Connectivity","parent_key":48}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":137,"axis":"depth3","code":"remote start","parent_key":48}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":138,"axis":"depth3","code":"Software","parent_key":48}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":139,"axis":"depth3","code":"update","parent_key":48}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":140,"axis":"depth3","code":"self driving/fsd","parent_key":49}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":141,"axis":"depth3","code":"Self driving/FSD","parent_key":49}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":142,"axis":"depth3","code":"OEM","parent_key":50}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":143,"axis":"depth3","code":"tire","parent_key":51}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":144,"axis":"depth3","code":"wheels","parent_key":51}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":145,"axis":"depth3","code":"Car/brand","parent_key":52}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":146,"axis":"depth3","code":"Car/Brand","parent_key":52}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":147,"axis":"depth3","code":"design","parent_key":53}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":148,"axis":"depth3","code":"Design","parent_key":53}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":149,"axis":"depth3","code":"distance/range","parent_key":54}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":150,"axis":"depth3","code":"Engine/output","parent_key":54}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":151,"axis":"depth3","code":"design","parent_key":55}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":152,"axis":"depth3","code":"distance/range","parent_key":56}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":153,"axis":"depth3","code":"Distance/Range","parent_key":56}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":154,"axis":"depth3","code":"Mileage/Efficiency","parent_key":56}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":155,"axis":"depth3","code":"exterior","parent_key":57}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":156,"axis":"depth3","code":"Seater","parent_key":57}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":157,"axis":"depth3","code":"specs","parent_key":57}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":158,"axis":"depth3","code":"Specs","parent_key":57}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":159,"axis":"depth3","code":"trunk space","parent_key":57}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":160,"axis":"depth3","code":"Connectivity","parent_key":58}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":161,"axis":"depth3","code":"myGENESIS","parent_key":58}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":162,"axis":"depth3","code":"Software","parent_key":58}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":163,"axis":"depth3","code":"Advanced technology","parent_key":59}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":164,"axis":"depth3","code":"EV Battery Capacity","parent_key":59}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":165,"axis":"depth3","code":"Futuristic Design","parent_key":59}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":166,"axis":"depth3","code":"Spacious Interior","parent_key":59}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":167,"axis":"depth3","code":"Autonomous Driving","parent_key":60}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":168,"axis":"depth3","code":"-","parent_key":61}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":169,"axis":"depth3","code":"-","parent_key":62}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":170,"axis":"depth3","code":"EV Battery","parent_key":63}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":171,"axis":"depth3","code":"EV Design","parent_key":63}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":172,"axis":"depth3","code":"EV Efficiency","parent_key":63}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":173,"axis":"depth3","code":"EV, Hybrid Awareness","parent_key":63}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":174,"axis":"depth3","code":"EV Value","parent_key":63}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":175,"axis":"depth3","code":"-","parent_key":64}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":176,"axis":"depth3","code":"-","parent_key":65}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":177,"axis":"depth3","code":"Autonomous Driving","parent_key":66}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":178,"axis":"depth3","code":"EV Battery","parent_key":67}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":179,"axis":"depth3","code":"EV Design","parent_key":67}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":180,"axis":"depth3","code":"EV Driving","parent_key":67}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":181,"axis":"depth3","code":"EV Efficiency","parent_key":67}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":182,"axis":"depth3","code":"EV, Hybrid Awareness","parent_key":67}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":183,"axis":"depth3","code":"EV Value","parent_key":67}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":184,"axis":"depth3","code":"-","parent_key":68}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":185,"axis":"depth3","code":"-","parent_key":69}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":186,"axis":"depth3","code":"-","parent_key":70}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":187,"axis":"depth3","code":"Car/brand","parent_key":71}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":188,"axis":"depth3","code":"Car/Brand","parent_key":71}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":189,"axis":"depth3","code":"design","parent_key":72}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":190,"axis":"depth3","code":"Design","parent_key":72}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":191,"axis":"depth3","code":"distance/range","parent_key":73}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":192,"axis":"depth3","code":"Engine/output","parent_key":73}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":193,"axis":"depth3","code":"design","parent_key":74}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":194,"axis":"depth3","code":"seater","parent_key":74}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":195,"axis":"depth3","code":"specs","parent_key":74}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":196,"axis":"depth3","code":"distance/range","parent_key":75}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":197,"axis":"depth3","code":"Distance/Range","parent_key":75}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":198,"axis":"depth3","code":"Mileage/Efficiency","parent_key":75}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":199,"axis":"depth3","code":"interior","parent_key":76}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":200,"axis":"depth3","code":"seater","parent_key":76}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":201,"axis":"depth3","code":"Seater","parent_key":76}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":202,"axis":"depth3","code":"specs","parent_key":76}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":203,"axis":"depth3","code":"Specs","parent_key":76}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":204,"axis":"depth3","code":"trunk space","parent_key":76}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":205,"axis":"depth3","code":"Connectivity","parent_key":77}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":206,"axis":"depth3","code":"Software","parent_key":77}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":207,"axis":"depth3","code":"update","parent_key":77}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":208,"axis":"depth3","code":"Green Mobility Innovation","parent_key":78}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":209,"axis":"depth3","code":"Sustainable Strategy","parent_key":78}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":210,"axis":"depth3","code":"Carbon Neutrality","parent_key":79}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":211,"axis":"depth3","code":"Circular Economy","parent_key":79}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":212,"axis":"depth3","code":"Eco Friendly Material","parent_key":79}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":213,"axis":"depth3","code":"EV Expansion","parent_key":79}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":214,"axis":"depth3","code":"Customer-Centricity","parent_key":80}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":215,"axis":"depth3","code":"Mobility & Accessibility","parent_key":80}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":216,"axis":"depth3","code":"Corporate Responsibility","parent_key":81}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":217,"axis":"depth3","code":"Ethical Management","parent_key":81}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":218,"axis":"depth3","code":"Future/Social Impact","parent_key":81}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":219,"axis":"depth3","code":"insurance","parent_key":82}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":220,"axis":"depth3","code":"Insurance","parent_key":82}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":221,"axis":"depth3","code":"warranty","parent_key":82}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":222,"axis":"depth3","code":"Warranty","parent_key":82}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":223,"axis":"depth3","code":"buy","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":224,"axis":"depth3","code":"Buy","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":225,"axis":"depth3","code":"configurator","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":226,"axis":"depth3","code":"dealership","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":227,"axis":"depth3","code":"Dealership","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":228,"axis":"depth3","code":"deal/sale","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":229,"axis":"depth3","code":"finance","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":230,"axis":"depth3","code":"lease","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":231,"axis":"depth3","code":"Price","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":232,"axis":"depth3","code":"Pricing Plan","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":233,"axis":"depth3","code":"used car","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":234,"axis":"depth3","code":"worth/value","parent_key":83}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":235,"axis":"depth3","code":"Advanced technology","parent_key":84}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":236,"axis":"depth3","code":"EV Battery Capacity","parent_key":84}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":237,"axis":"depth3","code":"Futuristic Design","parent_key":84}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":238,"axis":"depth3","code":"Spacious Interior","parent_key":84}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":239,"axis":"depth3","code":"Collaboration/Prize","parent_key":85}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":240,"axis":"depth3","code":"Creativity","parent_key":85}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":241,"axis":"depth3","code":"Design Leadership","parent_key":85}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":242,"axis":"depth3","code":"-","parent_key":86}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":243,"axis":"depth3","code":"Core Value","parent_key":86}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":244,"axis":"depth3","code":"Future Value","parent_key":86}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":245,"axis":"depth3","code":"Reliability","parent_key":86}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":246,"axis":"depth3","code":"High Performance Trend","parent_key":87}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":247,"axis":"depth3","code":"High Performance with Economic","parent_key":87}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":248,"axis":"depth3","code":"Brand Space","parent_key":88}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":249,"axis":"depth3","code":"Movement Inspire Leadership","parent_key":88}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":250,"axis":"depth3","code":"Sports/e-Sports","parent_key":88}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":251,"axis":"depth3","code":"issue/problem","parent_key":89}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":252,"axis":"depth3","code":"Issue/Problem","parent_key":89}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":253,"axis":"depth3","code":"recall","parent_key":89}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":254,"axis":"depth3","code":"myGENESIS","parent_key":90}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":255,"axis":"depth3","code":"myhyundai","parent_key":90}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":256,"axis":"depth3","code":"MyKia","parent_key":90}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":257,"axis":"depth3","code":"Support","parent_key":90}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":258,"axis":"depth3","code":"update","parent_key":90}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":259,"axis":"depth3","code":"CR-V","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":260,"axis":"depth3","code":"Explorer","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":261,"axis":"depth3","code":"Palisade","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":262,"axis":"depth3","code":"RAV4","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":263,"axis":"depth3","code":"Santa Fe","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":264,"axis":"depth3","code":"Sorento","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":265,"axis":"depth3","code":"Sportage","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":266,"axis":"depth3","code":"Telluride","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":267,"axis":"depth3","code":"Tucson","parent_key":91}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":268,"axis":"depth3","code":"CR-V","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":269,"axis":"depth3","code":"Elantra","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":270,"axis":"depth3","code":"Explorer","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":271,"axis":"depth3","code":"IONIQ 5","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":272,"axis":"depth3","code":"Palisade","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":273,"axis":"depth3","code":"RAV4","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":274,"axis":"depth3","code":"Santa Fe","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":275,"axis":"depth3","code":"Santa Fe Hybrid","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":276,"axis":"depth3","code":"Sorento","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":277,"axis":"depth3","code":"Sportage","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":278,"axis":"depth3","code":"Telluride","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":279,"axis":"depth3","code":"Tucson","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":280,"axis":"depth3","code":"Tucson Hybrid","parent_key":92}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":281,"axis":"depth3","code":"CR-V","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":282,"axis":"depth3","code":"Elantra","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":283,"axis":"depth3","code":"Explorer","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":284,"axis":"depth3","code":"IONIQ 5","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":285,"axis":"depth3","code":"Palisade","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":286,"axis":"depth3","code":"RAV4","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":287,"axis":"depth3","code":"Santa Fe","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":288,"axis":"depth3","code":"Santa Fe Hybrid","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":289,"axis":"depth3","code":"Sorento","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":290,"axis":"depth3","code":"Sportage","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":291,"axis":"depth3","code":"Telluride","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":292,"axis":"depth3","code":"Tucson","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":293,"axis":"depth3","code":"Tucson Hybrid","parent_key":93}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":294,"axis":"depth3","code":"CR-V","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":295,"axis":"depth3","code":"Elantra","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":296,"axis":"depth3","code":"Explorer","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":297,"axis":"depth3","code":"IONIQ 5","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":298,"axis":"depth3","code":"Palisade","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":299,"axis":"depth3","code":"RAV4","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":300,"axis":"depth3","code":"Santa Fe","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":301,"axis":"depth3","code":"Santa Fe Hybrid","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":302,"axis":"depth3","code":"Sorento","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":303,"axis":"depth3","code":"Sportage","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":304,"axis":"depth3","code":"Telluride","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":305,"axis":"depth3","code":"Tucson","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":306,"axis":"depth3","code":"Tucson Hybrid","parent_key":94}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":307,"axis":"depth3","code":"CR-V","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":308,"axis":"depth3","code":"Elantra","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":309,"axis":"depth3","code":"Explorer","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":310,"axis":"depth3","code":"IONIQ 5","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":311,"axis":"depth3","code":"Palisade","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":312,"axis":"depth3","code":"RAV4","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":313,"axis":"depth3","code":"Santa Fe","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":314,"axis":"depth3","code":"Santa Fe Hybrid","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":315,"axis":"depth3","code":"Sorento","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":316,"axis":"depth3","code":"Sportage","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":317,"axis":"depth3","code":"Telluride","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":318,"axis":"depth3","code":"Tucson","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":319,"axis":"depth3","code":"Tucson Hybrid","parent_key":95}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":320,"axis":"depth3","code":"CR-V","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":321,"axis":"depth3","code":"Explorer","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":322,"axis":"depth3","code":"Palisade","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":323,"axis":"depth3","code":"RAV4","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":324,"axis":"depth3","code":"Santa Fe","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":325,"axis":"depth3","code":"Sorento","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":326,"axis":"depth3","code":"Sportage","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":327,"axis":"depth3","code":"Telluride","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":328,"axis":"depth3","code":"Tucson","parent_key":96}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":329,"axis":"depth3","code":"CR-V","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":330,"axis":"depth3","code":"Elantra","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":331,"axis":"depth3","code":"Explorer","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":332,"axis":"depth3","code":"IONIQ 5","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":333,"axis":"depth3","code":"Palisade","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":334,"axis":"depth3","code":"RAV4","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":335,"axis":"depth3","code":"Santa Fe","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":336,"axis":"depth3","code":"Santa Fe Hybrid","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":337,"axis":"depth3","code":"Sorento","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":338,"axis":"depth3","code":"Sportage","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":339,"axis":"depth3","code":"Telluride","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":340,"axis":"depth3","code":"Tucson","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":341,"axis":"depth3","code":"Tucson Hybrid","parent_key":97}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":342,"axis":"depth3","code":"CR-V","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":343,"axis":"depth3","code":"Elantra","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":344,"axis":"depth3","code":"Explorer","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":345,"axis":"depth3","code":"IONIQ 5","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":346,"axis":"depth3","code":"Palisade","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":347,"axis":"depth3","code":"RAV4","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":348,"axis":"depth3","code":"Santa Fe","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":349,"axis":"depth3","code":"Santa Fe Hybrid","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":350,"axis":"depth3","code":"Sorento","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":351,"axis":"depth3","code":"Sportage","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":352,"axis":"depth3","code":"Telluride","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":353,"axis":"depth3","code":"Tucson","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":354,"axis":"depth3","code":"Tucson Hybrid","parent_key":98}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":355,"axis":"depth3","code":"CR-V","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":356,"axis":"depth3","code":"Elantra","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":357,"axis":"depth3","code":"Explorer","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":358,"axis":"depth3","code":"IONIQ 5","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":359,"axis":"depth3","code":"Palisade","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":360,"axis":"depth3","code":"RAV4","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":361,"axis":"depth3","code":"Santa Fe","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":362,"axis":"depth3","code":"Santa Fe Hybrid","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":363,"axis":"depth3","code":"Sorento","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":364,"axis":"depth3","code":"Sportage","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":365,"axis":"depth3","code":"Telluride","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":366,"axis":"depth3","code":"Tucson","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":367,"axis":"depth3","code":"Tucson Hybrid","parent_key":99}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":368,"axis":"funnel","code":"비교/검증","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":369,"axis":"funnel","code":"인지/탐색","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":370,"axis":"funnel","code":"구매/사후관리","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":371,"axis":"list_type","code":"3개국 비교 테스트","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":372,"axis":"list_type","code":"3개국 비교 테스트 2차","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":373,"axis":"list_type","code":"Brand Message","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":374,"axis":"list_type","code":"Consumer base Response","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":375,"axis":"list_type","code":"Keyword based","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":376,"axis":"list_type","code":"Strategic Model","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":377,"axis":"presence","code":"branded","parent_key":null}');
INSERT INTO gold.dim_taxon SELECT * FROM json_populate_record(NULL::gold.dim_taxon,'{"taxon_key":378,"axis":"presence","code":"unbranded","parent_key":null}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":0,"kind":null,"prefix":null,"host":null,"brand_code":null,"brand_bit":0,"geo_code":null,"language":null}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":1,"kind":"base","prefix":"hyundai.com.mx","host":"hyundai.com.mx","brand_code":"Hyundai","brand_bit":1,"geo_code":"MX","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":2,"kind":"base","prefix":"hyundaiusa.com/us/en","host":"hyundaiusa.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"US","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":3,"kind":"base","prefix":"hyundaicanada.com","host":"hyundaicanada.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"CA","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":4,"kind":"base","prefix":"hyundaicanada.com/fr","host":"hyundaicanada.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"CA","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":5,"kind":"base","prefix":"hyundai.com/kr/ko","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"KR","language":"ko"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":6,"kind":"base","prefix":"hyundai.com/in/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"IN","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":7,"kind":"base","prefix":"hyundai.com/jp","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"JP","language":"ja"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":8,"kind":"base","prefix":"hyundai.com.cn","host":"hyundai.com.cn","brand_code":"Hyundai","brand_bit":1,"geo_code":"CN","language":"zh"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":9,"kind":"base","prefix":"hyundai.com/au/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"AU","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":10,"kind":"base","prefix":"hyundai.gr","host":"hyundai.gr","brand_code":"Hyundai","brand_bit":1,"geo_code":"GR","language":"el"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":11,"kind":"base","prefix":"hyundai.com/nl/nl","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"NL","language":"nl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":12,"kind":"base","prefix":"hyundai.com/no/no","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"NO","language":"no"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":13,"kind":"base","prefix":"hyundai.dk","host":"hyundai.dk","brand_code":"Hyundai","brand_bit":1,"geo_code":"DK","language":"da"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":14,"kind":"base","prefix":"hyundai.com/eu/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"DE","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":15,"kind":"base","prefix":"hyundai.com/de/de","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"DE","language":"de"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":16,"kind":"base","prefix":"hyundai.lv","host":"hyundai.lv","brand_code":"Hyundai","brand_bit":1,"geo_code":"LV","language":"lv"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":17,"kind":"base","prefix":"hyundai.ru","host":"hyundai.ru","brand_code":"Hyundai","brand_bit":1,"geo_code":"RU","language":"ru"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":18,"kind":"base","prefix":"hyundai.lt","host":"hyundai.lt","brand_code":"Hyundai","brand_bit":1,"geo_code":"LT","language":"lt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":19,"kind":"base","prefix":"hyundai.ba","host":"hyundai.ba","brand_code":"Hyundai","brand_bit":1,"geo_code":"BA","language":"bs"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":20,"kind":"base","prefix":"hyundai.bg","host":"hyundai.bg","brand_code":"Hyundai","brand_bit":1,"geo_code":"BG","language":"bg"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":21,"kind":"base","prefix":"hyundai.rs","host":"hyundai.rs","brand_code":"Hyundai","brand_bit":1,"geo_code":"RS","language":"sr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":22,"kind":"base","prefix":"hyundai.com/se/sv","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"SE","language":"sv"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":23,"kind":"base","prefix":"hyundai.com/es/es","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"ES","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":24,"kind":"base","prefix":"hyundai.com/sk/sk","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"SK","language":"sk"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":25,"kind":"base","prefix":"hyundai.si","host":"hyundai.si","brand_code":"Hyundai","brand_bit":1,"geo_code":"SI","language":"sl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":26,"kind":"base","prefix":"hyundai.ee","host":"hyundai.ee","brand_code":"Hyundai","brand_bit":1,"geo_code":"EE","language":"et"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":27,"kind":"base","prefix":"hyundai.com/uk/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"GB","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":28,"kind":"base","prefix":"hyundai.com.ua","host":"hyundai.com.ua","brand_code":"Hyundai","brand_bit":1,"geo_code":"UA","language":"uk"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":29,"kind":"base","prefix":"hyundai.com/it/it","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"IT","language":"it"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":30,"kind":"base","prefix":"hyundai.com/cz","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"CZ","language":"cs"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":31,"kind":"base","prefix":"hyundai.hr","host":"hyundai.hr","brand_code":"Hyundai","brand_bit":1,"geo_code":"HR","language":"hr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":32,"kind":"base","prefix":"hyundai.com/tr/tr","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"TR","language":"tr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":33,"kind":"base","prefix":"hyundai.pt","host":"hyundai.pt","brand_code":"Hyundai","brand_bit":1,"geo_code":"PT","language":"pt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":34,"kind":"base","prefix":"hyundai.com/pl/pl","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"PL","language":"pl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":35,"kind":"base","prefix":"hyundai.com/fr/fr","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"FR","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":36,"kind":"base","prefix":"hyundai.fi","host":"hyundai.fi","brand_code":"Hyundai","brand_bit":1,"geo_code":"FI","language":"fi"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":37,"kind":"base","prefix":"hyundai.hu","host":"hyundai.hu","brand_code":"Hyundai","brand_bit":1,"geo_code":"HU","language":"hu"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":38,"kind":"base","prefix":"hyundai.cl","host":"hyundai.cl","brand_code":"Hyundai","brand_bit":1,"geo_code":"CL","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":39,"kind":"base","prefix":"hyundai.com.br","host":"hyundai.com.br","brand_code":"Hyundai","brand_bit":1,"geo_code":"BR","language":"pt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":40,"kind":"base","prefix":"hyundai-n.com/ko","host":"hyundai-n.com","brand_code":"Hyundai","brand_bit":1,"geo_code":null,"language":"ko"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":41,"kind":"base","prefix":"hyundai-n.com","host":"hyundai-n.com","brand_code":"Hyundai","brand_bit":1,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":42,"kind":"base","prefix":"hyundai.com/worldwide/ko","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":null,"language":"ko"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":43,"kind":"base","prefix":"hyundai.com/worldwide/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":44,"kind":"base","prefix":"genesis.com/us/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"US","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":45,"kind":"base","prefix":"genesis.com/ca/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"CA","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":46,"kind":"base","prefix":"genesis.com/ca/fr","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"CA","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":47,"kind":"base","prefix":"genesis.com/kr/ko","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"KR","language":"ko"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":48,"kind":"base","prefix":"genesis.com/middleeast/ar","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"AE","language":"ar"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":49,"kind":"base","prefix":"genesis.com.cn/zh","host":"genesis.com.cn","brand_code":"Genesis","brand_bit":4,"geo_code":"CN","language":"zh"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":50,"kind":"base","prefix":"genesis.com/au/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"AU","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":51,"kind":"base","prefix":"genesis.com/de/de","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"DE","language":"de"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":52,"kind":"base","prefix":"genesis.com/uk/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"GB","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":53,"kind":"base","prefix":"genesis.com/it/it","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"IT","language":"it"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":54,"kind":"base","prefix":"genesis.com/ch/fr","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"FR","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":55,"kind":"base","prefix":"genesis.com/ru/ru","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"RU","language":"ru"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":56,"kind":"base","prefix":"genesis.com/worldwide/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":57,"kind":"base","prefix":"kia.cl","host":"kia.cl","brand_code":"Kia","brand_bit":2,"geo_code":"CL","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":58,"kind":"base","prefix":"kia.com/mx","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"MX","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":59,"kind":"base","prefix":"kia.com/us/en","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"US","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":60,"kind":"base","prefix":"kia.com/us/es","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"US","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":61,"kind":"base","prefix":"kia.com/us/ko","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"US","language":"ko"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":62,"kind":"base","prefix":"kia.ca","host":"kia.ca","brand_code":"Kia","brand_bit":2,"geo_code":"CA","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":63,"kind":"base","prefix":"kia.ca/fr","host":"kia.ca","brand_code":"Kia","brand_bit":2,"geo_code":"CA","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":64,"kind":"base","prefix":"kia.com/tw","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"TW","language":"zh"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":65,"kind":"base","prefix":"kia.com/kr","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"KR","language":"ko"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":66,"kind":"base","prefix":"kia.com.mm","host":"kia.com.mm","brand_code":"Kia","brand_bit":2,"geo_code":"MM","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":67,"kind":"base","prefix":"kia.com/jp/ja","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"JP","language":"ja"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":68,"kind":"base","prefix":"kia.com/in","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"IN","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":69,"kind":"base","prefix":"kia.com/id/id","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"ID","language":"id"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":70,"kind":"base","prefix":"kia.com/th/th","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"TH","language":"th"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":71,"kind":"base","prefix":"kia.com/au","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"AU","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":72,"kind":"base","prefix":"kia.com/gr","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"GR","language":"el"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":73,"kind":"base","prefix":"kia.com/nl","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"NL","language":"nl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":74,"kind":"base","prefix":"kia.com/no","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"NO","language":"no"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":75,"kind":"base","prefix":"kia.com/dk","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"DK","language":"da"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":76,"kind":"base","prefix":"kia.com/de","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"DE","language":"de"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":77,"kind":"base","prefix":"kia.lv","host":"kia.lv","brand_code":"Kia","brand_bit":2,"geo_code":"LV","language":"lv"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":78,"kind":"base","prefix":"kia.ru","host":"kia.ru","brand_code":"Kia","brand_bit":2,"geo_code":"RU","language":"ru"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":79,"kind":"base","prefix":"kia.ro","host":"kia.ro","brand_code":"Kia","brand_bit":2,"geo_code":"RO","language":"ro"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":80,"kind":"base","prefix":"kia.lt","host":"kia.lt","brand_code":"Kia","brand_bit":2,"geo_code":"LT","language":"lt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":81,"kind":"base","prefix":"kia.ba","host":"kia.ba","brand_code":"Kia","brand_bit":2,"geo_code":"BA","language":"bs"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":82,"kind":"base","prefix":"kia.bg","host":"kia.bg","brand_code":"Kia","brand_bit":2,"geo_code":"BG","language":"bg"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":83,"kind":"base","prefix":"kia.rs","host":"kia.rs","brand_code":"Kia","brand_bit":2,"geo_code":"RS","language":"sr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":84,"kind":"base","prefix":"kia.com/se","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"SE","language":"sv"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":85,"kind":"base","prefix":"kia.com/es","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"ES","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":86,"kind":"base","prefix":"kia.com/sk","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"SK","language":"sk"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":87,"kind":"base","prefix":"kia.si","host":"kia.si","brand_code":"Kia","brand_bit":2,"geo_code":"SI","language":"sl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":88,"kind":"base","prefix":"kia.ee","host":"kia.ee","brand_code":"Kia","brand_bit":2,"geo_code":"EE","language":"et"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":89,"kind":"base","prefix":"kia.com/uk","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"GB","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":90,"kind":"base","prefix":"kia.com/ua","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"UA","language":"uk"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":91,"kind":"base","prefix":"kia.com/it","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"IT","language":"it"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":92,"kind":"base","prefix":"kia.com/cz","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"CZ","language":"cs"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":93,"kind":"base","prefix":"kia.com.kz","host":"kia.com.kz","brand_code":"Kia","brand_bit":2,"geo_code":"KZ","language":"ru"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":94,"kind":"base","prefix":"kia.hr","host":"kia.hr","brand_code":"Kia","brand_bit":2,"geo_code":"HR","language":"hr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":95,"kind":"base","prefix":"kia.com/tr","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"TR","language":"tr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":96,"kind":"base","prefix":"kia.pt","host":"kia.pt","brand_code":"Kia","brand_bit":2,"geo_code":"PT","language":"pt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":97,"kind":"base","prefix":"kia.com/pl","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"PL","language":"pl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":98,"kind":"base","prefix":"kia.com/fr","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"FR","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":99,"kind":"base","prefix":"kia.com/fi","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"FI","language":"fi"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":100,"kind":"base","prefix":"kia.com/hu","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"HU","language":"hu"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":101,"kind":"base","prefix":"kia-israel.co.il","host":"kia-israel.co.il","brand_code":"Kia","brand_bit":2,"geo_code":"IL","language":"he"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":102,"kind":"base","prefix":"worldwide.kia.com/ko","host":"worldwide.kia.com","brand_code":"Kia","brand_bit":2,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":103,"kind":"base","prefix":"worldwide.kia.com/en","host":"worldwide.kia.com","brand_code":"Kia","brand_bit":2,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":104,"kind":"base","prefix":"hyundai.com/pacific/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"AS","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":105,"kind":"base","prefix":"hyundai.com/hk/zh","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"HK","language":"zh"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":106,"kind":"base","prefix":"hyundai.com/id/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"ID","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":107,"kind":"base","prefix":"hyundai.com/la/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"LA","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":108,"kind":"base","prefix":"hyundai.com/my/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"MY","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":109,"kind":"base","prefix":"hyundai.com/ph/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"PH","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":110,"kind":"base","prefix":"hyundai.com/th/th","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"TH","language":"th"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":111,"kind":"base","prefix":"hyundai.com/be/nl","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"BE","language":"nl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":112,"kind":"base","prefix":"hyundai.com/lu","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"LU","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":113,"kind":"base","prefix":"hyundai.com/ch/de","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"CH","language":"de"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":114,"kind":"base","prefix":"hyundai.com/uz/uz","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"UZ","language":"uz"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":115,"kind":"base","prefix":"hyundai.com/bh/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"BH","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":116,"kind":"base","prefix":"hyundai.com/kw/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"KW","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":117,"kind":"base","prefix":"hyundai.com/lb/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"LB","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":118,"kind":"base","prefix":"hyundai.com/africa/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"AO","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":119,"kind":"base","prefix":"hyundai.com/canarias/es","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"ES","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":120,"kind":"base","prefix":"hyundai.com/et/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"ET","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":121,"kind":"base","prefix":"hyundai.com/ma/fr","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"MA","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":122,"kind":"base","prefix":"hyundai.com/ng/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"NG","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":123,"kind":"base","prefix":"hyundai.com/csa/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"AG","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":124,"kind":"base","prefix":"hyundai.com/gd/en","host":"hyundai.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"GD","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":125,"kind":"base","prefix":"kia.com/bn","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"BN","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":126,"kind":"base","prefix":"kia.com/fj","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"FJ","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":127,"kind":"base","prefix":"kia.com/hk/zh","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"HK","language":"zh"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":128,"kind":"base","prefix":"kia.com/la","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"LA","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":129,"kind":"base","prefix":"kia.com/my","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"MY","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":130,"kind":"base","prefix":"kia.com/mn","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"MN","language":"mn"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":131,"kind":"base","prefix":"kia.com/sg","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"SG","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":132,"kind":"base","prefix":"kia.com/at","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"AT","language":"de"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":133,"kind":"base","prefix":"kia.com/be/nl","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"BE","language":"nl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":134,"kind":"base","prefix":"kia.com/is","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"IS","language":"is"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":135,"kind":"base","prefix":"kia.com/ie","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"IE","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":136,"kind":"base","prefix":"kia.com/lu","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"LU","language":"fr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":137,"kind":"base","prefix":"kia.com/mt","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"MT","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":138,"kind":"base","prefix":"kia.com/az","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"AZ","language":"az"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":139,"kind":"base","prefix":"kia.com/eu","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":140,"kind":"base","prefix":"kia.com/ge","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"GE","language":"ka"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":141,"kind":"base","prefix":"kia.com/kw","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"KW","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":142,"kind":"base","prefix":"kia.com/lb","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"LB","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":143,"kind":"base","prefix":"kia.com/om/ar","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"OM","language":"ar"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":144,"kind":"base","prefix":"kia.com/aljabr/ar","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"SA","language":"ar"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":145,"kind":"base","prefix":"kia.com/nmc/ar","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"SA","language":"ar"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":146,"kind":"base","prefix":"kia.com/mu","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"MU","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":147,"kind":"base","prefix":"kia.com/sd/ar","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"SD","language":"ar"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":148,"kind":"base","prefix":"kia.com/aw","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"AW","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":149,"kind":"base","prefix":"kia.com/dm","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"DM","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":150,"kind":"base","prefix":"kia.com/cr","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"CR","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":151,"kind":"base","prefix":"kia.com/ec","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"EC","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":152,"kind":"base","prefix":"kia.com/hn","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"HN","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":153,"kind":"base","prefix":"kia.com/pe","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"PE","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":154,"kind":"base","prefix":"kia.com/pr","host":"kia.com","brand_code":"Kia","brand_bit":2,"geo_code":"PR","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":155,"kind":"base","prefix":"genesis.com/kz/ru","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"KZ","language":"ru"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":156,"kind":"base","prefix":"genesis.com/id/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"ID","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":157,"kind":"base","prefix":"genesis.com/middleeast/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":158,"kind":"base","prefix":"genesis.com/bh/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"BH","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":159,"kind":"base","prefix":"genesis.com/kw/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"KW","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":160,"kind":"base","prefix":"genesis.com/om/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"OM","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":161,"kind":"base","prefix":"genesis.com/qa/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"QA","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":162,"kind":"base","prefix":"genesis.com/sa-dammam/ar","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"SA","language":"ar"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":163,"kind":"base","prefix":"genesis.com/sa-jeddah/ar","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"SA","language":"ar"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":164,"kind":"base","prefix":"genesis.com/sa-riyadh/ar","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"SA","language":"ar"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":165,"kind":"base","prefix":"genesis.com/ae/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"AE","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":166,"kind":"base","prefix":"genesis.com/ch/de","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"CH","language":"de"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":167,"kind":"base","prefix":"genesis.com/nl/nl","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"NL","language":"nl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":168,"kind":"base","prefix":"genesis.com/es/es","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"ES","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":169,"kind":"base","prefix":"genesis.com/mu/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"MU","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":170,"kind":"base","prefix":"genesis.com/eg/en","host":"genesis.com","brand_code":"Genesis","brand_bit":4,"geo_code":"EG","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":171,"kind":"root_home","prefix":"genesis.com.cn","host":"genesis.com.cn","brand_code":"Genesis","brand_bit":4,"geo_code":"CN","language":"zh"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":172,"kind":"root_home","prefix":"hyundai-n.com","host":"hyundai-n.com","brand_code":"Hyundai","brand_bit":1,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":173,"kind":"root_home","prefix":"hyundai.ba","host":"hyundai.ba","brand_code":"Hyundai","brand_bit":1,"geo_code":"BA","language":"bs"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":174,"kind":"root_home","prefix":"hyundai.bg","host":"hyundai.bg","brand_code":"Hyundai","brand_bit":1,"geo_code":"BG","language":"bg"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":175,"kind":"root_home","prefix":"hyundai.cl","host":"hyundai.cl","brand_code":"Hyundai","brand_bit":1,"geo_code":"CL","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":176,"kind":"root_home","prefix":"hyundai.com.br","host":"hyundai.com.br","brand_code":"Hyundai","brand_bit":1,"geo_code":"BR","language":"pt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":177,"kind":"root_home","prefix":"hyundai.com.cn","host":"hyundai.com.cn","brand_code":"Hyundai","brand_bit":1,"geo_code":"CN","language":"zh"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":178,"kind":"root_home","prefix":"hyundai.com.mx","host":"hyundai.com.mx","brand_code":"Hyundai","brand_bit":1,"geo_code":"MX","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":179,"kind":"root_home","prefix":"hyundai.com.ua","host":"hyundai.com.ua","brand_code":"Hyundai","brand_bit":1,"geo_code":"UA","language":"uk"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":180,"kind":"root_home","prefix":"hyundai.dk","host":"hyundai.dk","brand_code":"Hyundai","brand_bit":1,"geo_code":"DK","language":"da"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":181,"kind":"root_home","prefix":"hyundai.ee","host":"hyundai.ee","brand_code":"Hyundai","brand_bit":1,"geo_code":"EE","language":"et"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":182,"kind":"root_home","prefix":"hyundai.fi","host":"hyundai.fi","brand_code":"Hyundai","brand_bit":1,"geo_code":"FI","language":"fi"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":183,"kind":"root_home","prefix":"hyundai.gr","host":"hyundai.gr","brand_code":"Hyundai","brand_bit":1,"geo_code":"GR","language":"el"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":184,"kind":"root_home","prefix":"hyundai.hr","host":"hyundai.hr","brand_code":"Hyundai","brand_bit":1,"geo_code":"HR","language":"hr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":185,"kind":"root_home","prefix":"hyundai.hu","host":"hyundai.hu","brand_code":"Hyundai","brand_bit":1,"geo_code":"HU","language":"hu"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":186,"kind":"root_home","prefix":"hyundai.lt","host":"hyundai.lt","brand_code":"Hyundai","brand_bit":1,"geo_code":"LT","language":"lt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":187,"kind":"root_home","prefix":"hyundai.lv","host":"hyundai.lv","brand_code":"Hyundai","brand_bit":1,"geo_code":"LV","language":"lv"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":188,"kind":"root_home","prefix":"hyundai.pt","host":"hyundai.pt","brand_code":"Hyundai","brand_bit":1,"geo_code":"PT","language":"pt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":189,"kind":"root_home","prefix":"hyundai.rs","host":"hyundai.rs","brand_code":"Hyundai","brand_bit":1,"geo_code":"RS","language":"sr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":190,"kind":"root_home","prefix":"hyundai.ru","host":"hyundai.ru","brand_code":"Hyundai","brand_bit":1,"geo_code":"RU","language":"ru"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":191,"kind":"root_home","prefix":"hyundai.si","host":"hyundai.si","brand_code":"Hyundai","brand_bit":1,"geo_code":"SI","language":"sl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":192,"kind":"root_home","prefix":"hyundaicanada.com","host":"hyundaicanada.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"CA","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":193,"kind":"root_home","prefix":"hyundaiusa.com","host":"hyundaiusa.com","brand_code":"Hyundai","brand_bit":1,"geo_code":"US","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":194,"kind":"root_home","prefix":"kia-israel.co.il","host":"kia-israel.co.il","brand_code":"Kia","brand_bit":2,"geo_code":"IL","language":"he"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":195,"kind":"root_home","prefix":"kia.ba","host":"kia.ba","brand_code":"Kia","brand_bit":2,"geo_code":"BA","language":"bs"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":196,"kind":"root_home","prefix":"kia.bg","host":"kia.bg","brand_code":"Kia","brand_bit":2,"geo_code":"BG","language":"bg"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":197,"kind":"root_home","prefix":"kia.ca","host":"kia.ca","brand_code":"Kia","brand_bit":2,"geo_code":"CA","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":198,"kind":"root_home","prefix":"kia.cl","host":"kia.cl","brand_code":"Kia","brand_bit":2,"geo_code":"CL","language":"es"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":199,"kind":"root_home","prefix":"kia.com.kz","host":"kia.com.kz","brand_code":"Kia","brand_bit":2,"geo_code":"KZ","language":"ru"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":200,"kind":"root_home","prefix":"kia.com.mm","host":"kia.com.mm","brand_code":"Kia","brand_bit":2,"geo_code":"MM","language":"en"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":201,"kind":"root_home","prefix":"kia.ee","host":"kia.ee","brand_code":"Kia","brand_bit":2,"geo_code":"EE","language":"et"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":202,"kind":"root_home","prefix":"kia.hr","host":"kia.hr","brand_code":"Kia","brand_bit":2,"geo_code":"HR","language":"hr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":203,"kind":"root_home","prefix":"kia.lt","host":"kia.lt","brand_code":"Kia","brand_bit":2,"geo_code":"LT","language":"lt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":204,"kind":"root_home","prefix":"kia.lv","host":"kia.lv","brand_code":"Kia","brand_bit":2,"geo_code":"LV","language":"lv"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":205,"kind":"root_home","prefix":"kia.pt","host":"kia.pt","brand_code":"Kia","brand_bit":2,"geo_code":"PT","language":"pt"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":206,"kind":"root_home","prefix":"kia.ro","host":"kia.ro","brand_code":"Kia","brand_bit":2,"geo_code":"RO","language":"ro"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":207,"kind":"root_home","prefix":"kia.rs","host":"kia.rs","brand_code":"Kia","brand_bit":2,"geo_code":"RS","language":"sr"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":208,"kind":"root_home","prefix":"kia.ru","host":"kia.ru","brand_code":"Kia","brand_bit":2,"geo_code":"RU","language":"ru"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":209,"kind":"root_home","prefix":"kia.si","host":"kia.si","brand_code":"Kia","brand_bit":2,"geo_code":"SI","language":"sl"}');
INSERT INTO gold.dim_owned_base SELECT * FROM json_populate_record(NULL::gold.dim_owned_base,'{"owner_key":210,"kind":"root_home","prefix":"worldwide.kia.com","host":"worldwide.kia.com","brand_code":"Kia","brand_bit":2,"geo_code":null,"language":"en"}');
INSERT INTO gold.dim_brand SELECT * FROM json_populate_record(NULL::gold.dim_brand,'{"brand_key":0,"name":"(이름 없음)","bare":"","kind":0,"own_bit":0,"first_seen":null}');
INSERT INTO gold.dim_source SELECT * FROM json_populate_record(NULL::gold.dim_source,'{"source_key":0,"skey":"","domain":"","is_social":false,"category_key":13,"category_src":6,"owned_brand_bit":0,"competitor_brand_key":null,"rule_ver":"2026-10-25.provisional.2"}');
INSERT INTO gold.dim_url SELECT * FROM json_populate_record(NULL::gold.dim_url,'{"url_key":0,"url_hash":"","url":null,"title":null,"url_norm":null,"url_base_norm":null,"host":null,"domain":null,"source_key":0,"owner_key":null,"rule_ver":"2026-10-25.provisional.2"}');

INSERT INTO gold.active_release(scope,read_mode,release_id,rule_signature,version,updated_at)
    SELECT s,'live',row_number() OVER (),'query-load',0,now() FROM unnest(ARRAY['global','website','project']) AS s;

GRANT USAGE ON SCHEMA gold TO hmg_metrics_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA gold TO hmg_metrics_reader;
END $install$;
