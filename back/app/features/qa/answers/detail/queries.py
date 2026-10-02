"""qa.answers.detail 읽기 SQL(SQLAlchemy Core text). rd·app 만(ing 금지).

모든 조회가 answer_key·PK 등치다(문서형 뷰 rd.v_answer_* 는 answer_key 등치 조회 전용 규약). rd.answer·rd.citation 등 사실 표는 읽지 않는다
(비서빙 job 포함이라 원문 뷰가 정본, G-24).
"""
# run_id·region·prompt_run_id(DB-v2.9 P63, bg-qa-platform R1 BG-46): ing.answer 원값(qa_gate 는 ing 권한이 없어 뷰 끝 열로 받는다)
BODY_SQL = ("SELECT status, analysis_status, model_slug, answer_text, run_id, region, prompt_run_id FROM rd.v_answer_body "
            "WHERE answer_key = :k")

PROMPT_SQL = """
SELECT dp.prompt_id, dp.text, dp.kind, dl.code AS lang, dt.code AS funnel, dp.regions, dp.is_korean
  FROM rd.dim_prompt dp
  LEFT JOIN rd.dim_lang dl ON dl.lang_key = dp.lang_key
  LEFT JOIN rd.dim_taxon dt ON dt.taxon_key = dp.funnel_key AND dt.axis = 'funnel'
 WHERE dp.prompt_key = :pk"""

# 표준 루트 카탈로그 표시값: app.prompt(scope_prompt_id = dim_prompt.prompt_id, 루트 프로젝트, 삭제 안 됨).
# qa_gate 는 app.prompt 를 열 권한 16열로만 읽는다(DB-v2.6 P47): 이 문장이 쓰는 열을 그 밖으로 넓히지 않는다
CATALOG_SQL = """
SELECT p.brand_code AS brand, p.brand_presence, p.list_type, p.depth1, p.depth2, p.depth3, p.depth4, p.funnel_stage, p.kind,
       p.prompt_type, p.category
  FROM app.prompt p
 WHERE p.scope_prompt_id = :pid AND p.deleted_at IS NULL
   AND p.project_id IN (SELECT r.project_id FROM rd.dim_project r WHERE r.surface = 1 AND r.is_root AND r.project_id IS NOT NULL)
 ORDER BY p.created_at, p.prompt_id
 LIMIT 1"""

MENTIONS_SQL = """
SELECT m.ord, m.entity_id, m.display_name, m.entity_type, m.mention_count, m.avg_position, m.surfaces, m.brand_rollup_entity_id,
       m.registry_role, m.sentiment_positive, m.sentiment_neutral, m.sentiment_negative, m.sentiment_mixed, m.type_mention,
       m.type_recommendation, m.type_comparison, m.type_definition, m.type_final_choice
  FROM rd.v_answer_mention_raw m
 WHERE m.answer_key = :k
 ORDER BY m.mention_count DESC, m.display_name NULLS LAST, m.ord"""

ENTITY_NAMES_SQL = "SELECT entity_id, rep_name FROM rd.dim_entity WHERE entity_id = ANY(CAST(:ids AS uuid[]))"

# 원문 url 이 rd.dim_url 에 이미 있으면(url_hash = sha256(원문 url UTF-8), 적재기 키 규칙) 그 url_norm·url_base_norm 을 함께 싣는다.
# 비서빙(드롭·비완료) job 인용의 정규화 URL 1순위(검증 BG46-NONSERVED): 적재기가 만든 값 그대로라 R3(trim 차이)에도 글자 단위로 같다.
# url_hash 는 UNIQUE(색인)라 인용 행마다 색인 1회. qa_gate SELECT(rd.v_answer_citation_raw·rd.dim_url)
CITATIONS_SQL = """
SELECT c.ord, c.ref_index, c.url, c.title, c.host, c.domain_label, c.scope_category,
       du.url_norm AS hash_url_norm, du.url_base_norm AS hash_url_base_norm
  FROM rd.v_answer_citation_raw c
  LEFT JOIN rd.dim_url du ON du.url_hash = sha256(convert_to(c.url, 'UTF8'))
 WHERE c.answer_key = :k
 ORDER BY c.ref_index NULLS LAST, c.ord"""

# 인용 정규화 URL(BG-46): rd.citation(서빙 답변만 행이 있다) ⋈ rd.dim_url. 사실 표 3술어(surface·round_date·cyc_key)는 이 job 의 값이라
# 리프 1개로 가지치기되고 PK (surface, round_date, answer_key, ord) 로 찾는다. 비서빙(비완료·드롭) job 은 행이 없어 null 로 둔다.
# url_key 0(예약·URL 없음)은 dim_url 에 url_norm 이 없어 null 이다. qa_gate SELECT(DB-v2.7 P16: rd.citation·rd.dim_*)
JOB_CYCLE_SQL = "SELECT j.cyc_key FROM rd.job j WHERE j.answer_key = :k"

CITATION_URLS_SQL = """
SELECT c.ord, u.url_norm, u.url_base_norm
  FROM rd.citation c JOIN rd.dim_url u ON u.url_key = c.url_key
 WHERE c.surface = :s AND c.round_date = :rd AND c.cyc_key = ANY(CAST(:cyc AS int4[])) AND c.answer_key = :k"""

# 도메인 오버라이드(현행 qa-review.ts:717-738). qa_gate SELECT(DB-v2.6 P47)
OVERRIDES_SQL = """
SELECT o.domain, cc.slug FROM app.citation_domain_override o JOIN app.citation_category cc ON cc.category_key = o.category_key
 WHERE o.domain = ANY(CAST(:domains AS text[]))"""

# ACR: job → 셀(source_job_ids 정확 연결, rd.acr_cell_job) → 선택 원소(level 1·2·3). 현행 4축 근사 연결과 값이 다를 수 있다(의도된 차이)
# prompt_run_id(DB-v2.9 P63 rd.v_acr_cell_run, bg-qa-platform R2): 현행 ACR 노트 키 ${promptRunId}:${entityId}(granule-tables.tsx:316·372-378)
ACR_CELLS_SQL = """
SELECT c.acr_cell_key, c.round_date, c.planned, c.valid_turn1, c.valid_acr, c.co_single, c.co_conditional, c.co_generic,
       c.co_off_shortlist, c.co_unresolved, c.co_none, c.is_rep, r.prompt_run_id
  FROM rd.acr_cell_job cj JOIN rd.acr_cell c ON c.acr_cell_key = cj.acr_cell_key
  LEFT JOIN rd.v_acr_cell_run r ON r.acr_cell_key = c.acr_cell_key
 WHERE cj.answer_key = :k
 ORDER BY c.round_date, c.acr_cell_key"""

ACR_CHOICES_SQL = """
SELECT ch.acr_cell_key, ch.level, e.entity_id, e.rep_name, e.entity_type, bn.name AS brand, pb.name AS parent_brand,
       ch.appearance, ch.choice, ch.cond_choice, ch.off_shortlist, ch.unresolved, ch.generic
  FROM rd.acr_choice ch
  LEFT JOIN rd.dim_entity e ON e.entity_key = ch.entity_key
  LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = ch.brand_key AND ch.brand_key <> 0
  LEFT JOIN rd.dim_brand_name pb ON pb.brand_key = ch.parent_brand_key AND ch.parent_brand_key <> 0
 WHERE ch.level = ANY(CAST(:levels AS int2[])) AND ch.acr_cell_key = ANY(CAST(:cells AS int4[]))
 ORDER BY ch.acr_cell_key, ch.level, ch.choice DESC, ch.appearance DESC, e.rep_name NULLS LAST"""

REGISTRY_SQL = """
SELECT pin_anchor, pin_reason, pin_source_measured_at, drop_reason, dropped_at, drop_source_measured_at
  FROM rd.v_answer_registry WHERE answer_key = :k"""
