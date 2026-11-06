-- The virtual Silver (2026-11-06): the pipeline's silver.answer_analysis (the OBT) and silver.acr_rollup, column by column, in the service's own
-- database, so the BFF can read and count from an OBT before the real one has mentions and sentiment. Only the data is virtual: it comes from
-- the copy of the old upstream database (back/hub_storage/silver-load.sql), nothing is estimated, and a value it does not hold stays NULL.
-- Tables, columns and their comments are read from the pipeline's schema (Medallion Explorer, db1.silver and db1.other). Values the old database
-- has and the contract does not go in ext, under the column's module prefix with v_gold in the name (K7): remove them when the real OBT arrives.
-- ops.snapshot_manifest is the manifest and pointer of the SSOT's snapshot states (shared/project-architecture.md): the explorer shows no such table yet.
CREATE SCHEMA ops;
CREATE SCHEMA silver;
CREATE SCHEMA silver_contract;
REVOKE ALL ON SCHEMA ops,silver,silver_contract FROM PUBLIC;

CREATE TABLE ops.cycle (
    cycle_id uuid NOT NULL,
    surface text NOT NULL,
    PRIMARY KEY (cycle_id)
);
COMMENT ON TABLE ops.cycle IS '회차 하나 = 1행. 회차 하나는 표면 하나에 속합니다. Project 파생 회차도 등록합니다.';
COMMENT ON COLUMN ops.cycle.cycle_id IS '회차 ID. 원천 회차 ID를 그대로 씁니다.';
COMMENT ON COLUMN ops.cycle.surface IS '서비스 범위(global, website, project). 공개 뷰가 이 값을 surface로 냅니다(S11).';
CREATE TABLE ops.run (
    run_key uuid NOT NULL,
    cycle_id uuid NOT NULL,
    input_run_key uuid,
    layer text NOT NULL,
    status text NOT NULL,
    contract_version text,
    git_commit text,
    config jsonb NOT NULL,
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    PRIMARY KEY (run_key),
    FOREIGN KEY (cycle_id) REFERENCES ops.cycle(cycle_id)
);
COMMENT ON TABLE ops.run IS '층 실행 하나 = 1행(bronze, silver, gold). 같은 회차를 다시 돌리면 cycle_id는 그대로이고 run_key를 새로 만듭니다.';
COMMENT ON COLUMN ops.run.run_key IS '실행 ID(UUIDv7). 이 실행이 쓴 bronze, stg, OBT 행의 run_key입니다.';
COMMENT ON COLUMN ops.run.cycle_id IS '실행의 회차. 모든 층에서 필수입니다.';
COMMENT ON COLUMN ops.run.input_run_key IS '직전 층의 입력 실행 하나. Bronze는 NULL입니다. 같은 회차인지는 복합 FK가 강제하고, 직전 층이며 성공했는지는 작성자가 확인합니다.';
COMMENT ON COLUMN ops.run.layer IS '층. silver_contract.current_run은 silver만 고릅니다.';
COMMENT ON COLUMN ops.run.status IS '실행 상태(running, succeeded, failed). 공개 뷰는 succeeded만 보입니다.';
COMMENT ON COLUMN ops.run.contract_version IS '계약 판(예: silver.v1). Silver 실행은 필수입니다. 공개 뷰는 호환되는 판만 보입니다.';
COMMENT ON COLUMN ops.run.git_commit IS '실행한 코드의 커밋';
COMMENT ON COLUMN ops.run.config IS '기준 데이터 판, 값의 출처 등 실행 설정. 입력 목록은 두지 않습니다(입력은 input_run_key 하나).';
COMMENT ON COLUMN ops.run.started_at IS '시작 시각. current_run이 최신 실행을 고를 때 씁니다.';
COMMENT ON COLUMN ops.run.finished_at IS '끝난 시각. running이면 NULL입니다.';
CREATE TABLE ops.snapshot_manifest (
    snapshot_id uuid PRIMARY KEY REFERENCES ops.run(run_key),
    cycle_id uuid NOT NULL REFERENCES ops.cycle(cycle_id),
    round_date date,
    row_count bigint NOT NULL,
    acr_row_count bigint NOT NULL,
    rule_version text,
    contract_version text NOT NULL,
    status text NOT NULL CHECK (status IN ('loading','ready','public','retired')),
    ext jsonb,
    recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX snapshot_manifest_one_public ON ops.snapshot_manifest(cycle_id) WHERE status='public';
COMMENT ON TABLE ops.snapshot_manifest IS '적재 기록(SSOT 매니페스트): 회차, 스냅샷 ID, 행 수, 추출 규칙 버전, 상태. 회차마다 public은 하나이고 이것이 운영 스냅샷 포인터입니다. 스냅샷 ID는 Silver 실행 run_key입니다.';
COMMENT ON COLUMN ops.snapshot_manifest.ext IS '계약 밖 값. v_gold 아래에 이전 DB의 회차 값(servable, view_date 등)을 둡니다.';

CREATE TABLE silver.answer_analysis (
    run_key uuid NOT NULL,
    answer_key uuid NOT NULL,
    project_id uuid,
    run_id uuid,
    prompt_id uuid,
    engine text,
    country text,
    lang text,
    measured_at timestamptz,
    model_slug text,
    answer_text text,
    s1_normalize_answer_status text,
    s1_normalize_run_status text,
    s1_normalize_is_dropped boolean,
    s1_normalize_measured_at_orig timestamptz,
    s1_normalize_anchor_date date,
    s1_normalize_round_date date,
    s1_normalize_view_anchor_date date,
    s1_normalize_is_default_engine boolean,
    s1_normalize_anchor_source text,
    s1_normalize_citations jsonb,
    s1_normalize_status text NOT NULL,
    s1_quality_state text,
    s1_quality_status text NOT NULL,
    s2_mention_rollups jsonb,
    s2_mention_occurrences jsonb,
    s2_mention_status text NOT NULL,
    s2_citation_judgments jsonb,
    s2_citation_status text NOT NULL,
    s3_semantics_rollups jsonb,
    s3_semantics_occurrences jsonb,
    s3_semantics_status text NOT NULL,
    s3_stance_stances jsonb,
    s3_stance_status text NOT NULL,
    ext jsonb,
    PRIMARY KEY (run_key, answer_key),
    FOREIGN KEY (run_key) REFERENCES ops.run(run_key)
);
COMMENT ON TABLE silver.answer_analysis IS 'Silver OBT. 실행 하나의 답변 하나 = 1행. 모듈마다 계약 열과 상태 열을 두고, 계약 밖 값은 ext에 둡니다.';
COMMENT ON COLUMN silver.answer_analysis.run_key IS '이 행을 조립한 Silver 실행. 회차와 표면은 ops.run → ops.cycle에서 찾습니다.';
COMMENT ON COLUMN silver.answer_analysis.answer_key IS '답변(job) ID. 수집에 실패한 답변도 행이 있습니다.';
COMMENT ON COLUMN silver.answer_analysis.project_id IS '프로젝트. Gold가 프로젝트와 접근 범위를 잇습니다.';
COMMENT ON COLUMN silver.answer_analysis.run_id IS '측정 묶음(scope_runs) ID. Gold가 수집 실행과 ACR 답변 묶음을 잇습니다.';
COMMENT ON COLUMN silver.answer_analysis.prompt_id IS '질문 ID';
COMMENT ON COLUMN silver.answer_analysis.engine IS '엔진(원천 target)';
COMMENT ON COLUMN silver.answer_analysis.country IS '국가(원천 region)';
COMMENT ON COLUMN silver.answer_analysis.lang IS '질문 언어';
COMMENT ON COLUMN silver.answer_analysis.measured_at IS '측정 시각';
COMMENT ON COLUMN silver.answer_analysis.model_slug IS '답변을 만든 모델';
COMMENT ON COLUMN silver.answer_analysis.answer_text IS '답변 원문';
COMMENT ON COLUMN silver.answer_analysis.s1_normalize_citations IS '인용 목록(jsonb 배열). 정상 빈 결과는 빈 배열, 결과가 없는 상태는 NULL입니다. 계약 필드: citation_seq, ref_index, url, url_norm, url_base_norm, host, domain, title, scope_category. 연결 키: citation_seq.';
COMMENT ON COLUMN silver.answer_analysis.s1_quality_state IS '품질 5값. LLM 언급 모듈의 입력 조건입니다. 공개 뷰에는 내지 않습니다.';
COMMENT ON COLUMN silver.answer_analysis.s2_mention_rollups IS '엔티티별 언급 집계(jsonb 배열). 계약 필드: entity_id, entity_type, brand, brand_rollup_entity_id, mention_count, avg_position, surfaces. 연결 키: entity_id.';
COMMENT ON COLUMN silver.answer_analysis.s2_mention_occurrences IS '위치가 있는 해소 언급(jsonb 배열). 계약 필드: occurrence_seq, analysis_index, analysis_position, turn_index, source_start, source_end, entity_id, entity_type, brand_rollup_entity_id, surface_text, mention_role, assertion, base_sentiment, context_snippet, descriptors, criteria. 연결 키: occurrence_seq.';
COMMENT ON COLUMN silver.answer_analysis.s2_citation_judgments IS '인용마다 판정 하나(jsonb 배열). citation_seq로 s1_normalize_citations와 잇습니다. 계약 필드: citation_seq, url_norm, domain, group_key, category, category_method, is_owned, matched_base_url, matched_brand, matched_base_country, loc_owned, tgt_hit. 연결 키: citation_seq.';
COMMENT ON COLUMN silver.answer_analysis.s3_semantics_rollups IS '엔티티별 감성·유형 수(jsonb 배열). 계약 필드: entity_id, sentiment_positive, sentiment_neutral, sentiment_negative, sentiment_mixed, type_mention, type_recommendation, type_comparison, type_definition, type_final_choice. 연결 키: entity_id.';
COMMENT ON COLUMN silver.answer_analysis.s3_semantics_occurrences IS '언급마다 감성(jsonb 배열). analysis_index로 s2_mention_occurrences와 잇습니다. 계약 필드: analysis_index, turn_index, entity_id, sentiment, sentiment_source, mention_type, evidence, reason. 연결 키: analysis_index.';
COMMENT ON COLUMN silver.answer_analysis.s3_stance_stances IS '브랜드별 태도와 근거(jsonb 배열). 계약 필드: turn_index, entity_id, brand_label, is_tracked, stance, confidence, evidence_text, evidence_start, evidence_end, reason, model_slug. 연결 키: turn_index, entity_id.';
COMMENT ON COLUMN silver.answer_analysis.ext IS '계약 밖 값. OBT에 없는 stg 열은 열 이름 그대로(S5), 목록의 계약 필드 밖 새 항목 필드는 <목록 열 이름> 키에 연결 키와 함께(ADR 0003) 담습니다. 최상위 키는 모듈 접두로 시작합니다(K7). Gold 실험 SQL이 읽고 키 아래 값의 안정성은 보장하지 않습니다.';
CREATE TABLE silver.acr_rollup (
    run_key uuid NOT NULL,
    prompt_run_id uuid NOT NULL,
    project_id uuid,
    run_id uuid,
    prompt_id uuid,
    engine text,
    country text,
    lang text,
    measured_at timestamptz,
    run_status text,
    s3_acr_planned_iterations integer,
    s3_acr_valid_turn1_iterations integer,
    s3_acr_valid_acr_iterations integer,
    s3_acr_co_single_entity integer,
    s3_acr_co_conditional_multiple integer,
    s3_acr_co_generic_category integer,
    s3_acr_co_resolved_off_shortlist integer,
    s3_acr_co_unresolved_choice integer,
    s3_acr_co_none integer,
    s3_acr_entities jsonb,
    s3_acr_status text NOT NULL,
    ext jsonb,
    PRIMARY KEY (run_key, prompt_run_id),
    FOREIGN KEY (run_key) REFERENCES ops.run(run_key)
);
COMMENT ON TABLE silver.acr_rollup IS 'Silver ACR 집계. 실행 하나의 ACR 반복 묶음 하나 = 1행. 앤서 scope_acr_rollups(묶음 × 엔티티)를 묶음 단위로 접었고 엔티티는 s3_acr_entities 배열에 둡니다.';
COMMENT ON COLUMN silver.acr_rollup.run_key IS '이 행을 조립한 Silver 실행';
COMMENT ON COLUMN silver.acr_rollup.prompt_run_id IS 'ACR 반복 묶음 ID. Gold가 ACR 셀을 식별합니다.';
COMMENT ON COLUMN silver.acr_rollup.run_status IS '측정 묶음 상태(completed, partial_failed, failed, running). 모듈 상태가 아니라 CHECK를 두지 않습니다(D6, K11).';
COMMENT ON COLUMN silver.acr_rollup.s3_acr_entities IS '엔티티별 등장·선택 수(jsonb 배열). 계약 필드: entity_id, rollup_level, brand, parent_brand, brand_rollup_entity_id, entity_type, appearance_count, choice_count, conditional_choice_count, off_shortlist_choice_count, unresolved_choice_count, generic_choice_count, co_single_entity, co_conditional_multiple, co_generic_category, co_resolved_off_shortlist, co_unresolved_choice, co_none. 연결 키: entity_id.';
COMMENT ON COLUMN silver.acr_rollup.ext IS '계약 밖 값(S5, ADR 0003). 최상위 키는 s3_acr_ 접두로 시작합니다(K7).';
CREATE VIEW silver_contract.current_run WITH (security_barrier=true) AS
    SELECT c.surface,m.cycle_id,m.snapshot_id AS run_key FROM ops.snapshot_manifest m JOIN ops.cycle c USING(cycle_id) WHERE m.status='public';
COMMENT ON VIEW silver_contract.current_run IS '회차마다 지금 쓰는 Silver 실행 하나. 여러 회차를 합치는 Gold SQL이 씁니다.';

CREATE VIEW silver_contract.answer_analysis WITH (security_barrier=true) AS
    SELECT r.surface,
        a.run_key,
        a.answer_key,
        r.cycle_id,
        a.project_id,
        a.run_id,
        a.prompt_id,
        a.engine,
        a.country,
        a.lang,
        a.measured_at,
        a.model_slug,
        a.answer_text,
        a.s1_normalize_answer_status,
        a.s1_normalize_run_status,
        a.s1_normalize_is_dropped,
        a.s1_normalize_measured_at_orig,
        a.s1_normalize_anchor_date,
        a.s1_normalize_round_date,
        a.s1_normalize_view_anchor_date,
        a.s1_normalize_is_default_engine,
        a.s1_normalize_anchor_source,
        a.s1_normalize_citations,
        a.s1_normalize_status,
        a.s2_mention_rollups,
        a.s2_mention_occurrences,
        a.s2_mention_status,
        a.s2_citation_judgments,
        a.s2_citation_status,
        a.s3_semantics_rollups,
        a.s3_semantics_occurrences,
        a.s3_semantics_status,
        a.s3_stance_stances,
        a.s3_stance_status,
        (a.ext->'s1_normalize_v_gold'->>'analysis_state')::smallint AS analysis_state,
        a.ext->'s1_normalize_v_gold'->>'analysis_label' AS analysis_label,
        a.ext
    FROM silver.answer_analysis a JOIN silver_contract.current_run r USING(run_key);
COMMENT ON VIEW silver_contract.answer_analysis IS 'Gold가 읽는 답변 계약. 성공한 silver.v1 실행의 silver.answer_analysis에 surface, cycle_id, analysis_state, analysis_label을 더합니다. s1_quality_*는 내지 않습니다.';
CREATE VIEW silver_contract.acr_rollup WITH (security_barrier=true) AS
    SELECT r.surface,
        a.run_key,
        a.prompt_run_id,
        r.cycle_id,
        a.project_id,
        a.run_id,
        a.prompt_id,
        a.engine,
        a.country,
        a.lang,
        a.measured_at,
        a.run_status,
        a.s3_acr_planned_iterations,
        a.s3_acr_valid_turn1_iterations,
        a.s3_acr_valid_acr_iterations,
        a.s3_acr_co_single_entity,
        a.s3_acr_co_conditional_multiple,
        a.s3_acr_co_generic_category,
        a.s3_acr_co_resolved_off_shortlist,
        a.s3_acr_co_unresolved_choice,
        a.s3_acr_co_none,
        a.s3_acr_entities,
        a.s3_acr_status,
        a.ext
    FROM silver.acr_rollup a JOIN silver_contract.current_run r USING(run_key);
COMMENT ON VIEW silver_contract.acr_rollup IS 'Gold가 읽는 ACR 계약. 성공한 silver.v1 실행의 silver.acr_rollup에 surface, cycle_id를 더합니다.';
GRANT USAGE ON SCHEMA ops,silver_contract TO hmg_silver_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA silver_contract TO hmg_silver_reader;
GRANT SELECT ON ops.snapshot_manifest,ops.cycle TO hmg_silver_reader;
