"""admin.integrations.keyword_tools 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

rd.dim_keyword(term_norm 유니크) ⋈ rd.kw_volume_monthly(PK kw_key·location·language·month): 키워드 등치 + 최근 12개월.
수집(DataForSEO)은 적재기 소관: 앱은 app.judgment_change('dfs_fetch') 만 남긴다(Q13).
"""

VOLUMES_SQL = """
SELECT dk.term_norm, v.month, v.search_volume, v.competition_index, v.competition, v.cpc, v.observed_at
  FROM rd.dim_keyword dk
  JOIN rd.kw_volume_monthly v ON v.kw_key = dk.kw_key
 WHERE dk.term_norm = ANY(CAST(:terms AS text[])) AND v.location_code = CAST(:loc AS int4) AND v.language_code = CAST(:lang AS text)
   AND v.month >= CAST(date_trunc('month', now() - interval '12 months') AS date)
 ORDER BY dk.term_norm, v.month DESC
"""

NOW_SQL = "SELECT now() AS now"

# 대기·진행 중 dfs_fetch 가운데 검색량을 수집하는 것(fetch volume·insight: insight = search_volume + serp_organic)이고 같은 지역·언어이며
# 주체(term_norm)가 겹치는 것(term 단위 dedupe, 검증 D4). 주체 규칙은 core.contracts dfs_fetch(정렬된 term_norm, 고객 관심 IN-1 과 한 벌)라
# 두 생산자 사이에서도 잡힌다. 동시 요청 두 개가 같은 term 을 함께 넣는 경합은 enqueue_change dedupe 와 같은 수준으로 남는다.
PENDING_OVERLAP_SQL = """
SELECT j.change_id, j.subject_texts
  FROM app.judgment_change j
 WHERE j.kind = 'dfs_fetch' AND j.status IN ('pending', 'running')
   AND j.payload->>'fetch' IN ('volume', 'insight')
   AND j.payload->>'location_code' = CAST(:loc AS text) AND j.payload->>'language_code' = CAST(:lang AS text)
   AND j.subject_texts && CAST(:norms AS text[])
 ORDER BY j.change_id
"""
