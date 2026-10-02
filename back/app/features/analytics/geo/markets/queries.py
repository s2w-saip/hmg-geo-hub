"""analytics.geo.markets 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

사실 표(rd.answer·answer_brand) 집계는 app.core.measure 빌더(fetch_counts·brand_rows)가 Window.where 3술어와 함께 만든다.
이 파일에는 차원·참조 조회(사실 표 아님)만 둔다.
"""

# 경쟁 브랜드 표시 이름(HMG 브랜드 격리는 core brand_rows(hmg_siblings=False) 가 SQL 에서 한다)
BRAND_NAMES_SQL = """
SELECT b.brand_key, b.name
  FROM rd.dim_brand_name b
 WHERE b.brand_key = ANY(CAST(:keys AS int4[]))
"""

# 관점 브랜드의 RHQ 권역 라벨(국가 목록은 core.codes.Refs.rhq)
REGION_LABELS_SQL = """
SELECT r.region_id, r.label
  FROM app.rhq_region r
 WHERE r.brand_code = :brand
 ORDER BY r.region_id
"""
