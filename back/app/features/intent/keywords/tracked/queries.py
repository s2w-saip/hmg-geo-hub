"""intent.keywords.tracked SQL(SQLAlchemy Core text). 읽기는 app·rd(api_ro), 쓰기는 app 만(api_rw).

rd.kw_volume_monthly 는 파티션 표가 아니다: 키워드별 (kw_key, location_code, language_code) PK 선두로 최신 1행만 읽는다.
키워드마다 국가가 달라(NULL 이면 프로젝트 국가) 파이썬에서 (keyword_id, term_norm = DB 생성 열, loc, lang) 배열을 만들어 unnest 로 조인한다.
"""
from __future__ import annotations

LIST = """
SELECT keyword_id, term, term_norm, country_code, created_at FROM app.project_tracked_keyword
 WHERE project_id = :pid ORDER BY created_at, keyword_id
"""

LATEST_VOLUME = """
SELECT x.keyword_id, lv.month, lv.search_volume
  FROM unnest(CAST(:ids AS uuid[]), CAST(:norms AS text[]), CAST(:locs AS int4[]), CAST(:langs AS text[]))
       AS x(keyword_id, term_norm, loc, lang)
  JOIN rd.dim_keyword k ON k.term_norm = x.term_norm
  JOIN LATERAL (SELECT v.month, v.search_volume FROM rd.kw_volume_monthly v
                 WHERE v.kw_key = k.kw_key AND v.location_code = x.loc AND v.language_code = x.lang
                 ORDER BY v.month DESC LIMIT 1) lv ON true
"""

# 중복 판정 = DB 유니크 project_tracked_keyword_norm_uq(project_id, term_norm, coalesce(country_code, ''), DB-v2.6 P44). 충돌이면 0행 → 409
INSERT = """
INSERT INTO app.project_tracked_keyword (project_id, term, country_code) VALUES (:pid, :term, :country)
ON CONFLICT DO NOTHING
RETURNING keyword_id, term, country_code, created_at
"""

# 다건 추가(items[])의 행: 같은 규칙에 created_at 만 clock_timestamp(). 한 트랜잭션 안의 now() 는 모든 행이 같은 값이라 목록 순서
# (created_at, keyword_id)가 무작위 id 순이 되므로, 행마다 실행 시각으로 요청 순서를 지킨다(단건을 차례로 보낸 것과 같은 순서).
INSERT_IN_BATCH = """
INSERT INTO app.project_tracked_keyword (project_id, term, country_code, created_at) VALUES (:pid, :term, :country, clock_timestamp())
ON CONFLICT DO NOTHING
RETURNING keyword_id, term, country_code, created_at
"""

DELETE = """
DELETE FROM app.project_tracked_keyword WHERE project_id = :pid AND keyword_id = ANY(CAST(:ids AS uuid[]))
RETURNING keyword_id
"""
